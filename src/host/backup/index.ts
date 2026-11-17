/**
 * backup 模块 —— 从 host/service.ts 纯搬迁（行为不变）。
 * 记忆库位置（读/迁移/设置持久化）与 备份恢复完整性。
 */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  clearPointer,
  defaultDataDir,
  normalizeDataDir,
  readPointer,
  readSettings,
  samePath,
  writePointer,
  writeSettings,
} from "../location";
import { addAudit } from "../../store/dao";
import { ensureSchema } from "../../store/migrate";
import type { WeaveEnv } from "../../store/db";
import type { BackupManager } from "../../backup/manager";
import {
  DEFAULT_BACKUP_CONFIG,
  type BackupInfo,
  type BackupOptions,
  type BackupResult,
  type RestoreOptions,
  type RestoreResult,
  type VerificationResult,
} from "../../backup/types";

export interface BackupHost {
  env: WeaveEnv;
  config: import("../service").WeaveConfig;
  dataDirSource: "config" | "pointer" | "default";
  backupManager: BackupManager | null;
  scheduleMirror(): void;
  reload(): { ok: boolean; code?: string; message?: string };
}

export function dataLocation(host: BackupHost): {
  current: string;
  source: string;
  defaultDir: string;
  pending: string;
  restartRequired: boolean;
  locked: boolean;
} {
  const pointed = readPointer();
  const pending = host.dataDirSource === "config" ? host.env.dataDir : pointed || defaultDataDir();
  return {
    current: host.env.dataDir,
    source: host.dataDirSource,
    defaultDir: defaultDataDir(),
    pending,
    restartRequired: !samePath(pending, host.env.dataDir),
    locked: host.dataDirSource === "config",
  };
}

/**
 * 改记忆库目录（下次启动 DSH 生效）。
 * mode=copy：把当前库完整复制过去（目标已有库时拒绝，避免覆盖）；
 * mode=use：直接使用目标目录里已有的库（没有就新建空库）。
 * 原目录的数据原样保留，不做删除。
 */
export function relocate(host: BackupHost, target: string, mode: "copy" | "use", actor: string): Record<string, unknown> {
  if (host.dataDirSource === "config") {
    return { ok: false, code: "E_LOCKED", message: "记忆库目录由插件配置文件里的 dataDir 指定，请在那里修改" };
  }
  const checked = normalizeDataDir(target);
  if (!checked.ok) return { ok: false, code: "E_VALID", message: checked.message };
  const dir = checked.dir;
  const isDefault = samePath(dir, defaultDataDir());
  if (samePath(dir, host.env.dataDir)) {
    if (isDefault) clearPointer();
    else writePointer(dir);
    return { ok: true, dir, restartRequired: false, copied: false };
  }
  const targetDb = join(dir, "memweave.db");
  let copied = false;
  try {
    mkdirSync(dir, { recursive: true });
    if (mode === "copy") {
      if (existsSync(targetDb)) {
        return { ok: false, code: "E_EXISTS", message: "目标目录里已经有一个记忆库；如要直接使用它，请选择“使用目标目录里的库”" };
      }
      if (targetDb.includes("'")) return { ok: false, code: "E_VALID", message: "路径里不能包含单引号" };
      host.env.db.exec("VACUUM INTO '" + targetDb + "'");
      const settings = readSettings(host.env.dataDir);
      if (Object.keys(settings).length > 0) writeSettings(dir, settings);
      copied = true;
    }
    if (isDefault) clearPointer();
    else writePointer(dir);
  } catch (e) {
    return { ok: false, code: "E_IO", message: "无法写入目标目录：" + String(e) };
  }
  try {
    if (!host.env.readonly) {
      addAudit(host.env, { actor, action: "data.relocate", target: dir, after: copied ? "copied" : "use-existing" });
    }
  } catch {
    // 审计失败不影响切换
  }
  return { ok: true, dir, copied, restartRequired: true };
}

/** 把这次在设置页改的项并入 settings.json（只存改过的项），重启后仍保留 */
export function persistSettings(host: BackupHost, patch: Record<string, unknown>): boolean {
  try {
    const isRec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
    const merge = (a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> => {
      const out: Record<string, unknown> = { ...a };
      for (const [k, v] of Object.entries(b)) out[k] = isRec(out[k]) && isRec(v) ? merge(out[k] as Record<string, unknown>, v) : v;
      return out;
    };
    const { dataDir: _ignored, ...clean } = patch;
    writeSettings(host.env.dataDir, merge(readSettings(host.env.dataDir), clean));
    return true;
  } catch {
    return false;
  }
}

export function backupNow(host: BackupHost, label: string): string {
  // Use the new BackupManager if available
  if (host.backupManager) {
    const result = host.backupManager.createBackup({ label });
    return result.filepath;
  }
  // Fallback to old method
  return host.env.backup(label);
}

/**
 * 创建备份（增强版，带完整性校验和可选加密）
 */
export async function createBackup(host: BackupHost, options: BackupOptions = {}): Promise<BackupResult> {
  if (!host.backupManager) {
    throw new Error("Backup manager not initialized. Enable backup in config.");
  }

  const result = host.backupManager.createBackup(options);

  // 记录审计日志
  await host.env.withWrite(() => {
    addAudit(host.env, {
      actor: "system",
      action: "backup.create",
      target: result.filename,
      after: `size: ${result.size}, sha256: ${result.sha256.substring(0, 16)}...`,
    });
  });

  // 清理旧备份
  const maxBackups = host.config.backup?.maxBackups ?? DEFAULT_BACKUP_CONFIG.maxBackups;
  host.backupManager.cleanupOldBackups(maxBackups);

  return result;
}

/**
 * 列出所有备份
 */
export function listBackupsEnhanced(host: BackupHost): BackupInfo[] {
  if (!host.backupManager) {
    return [];
  }
  return host.backupManager.listBackups();
}

/**
 * 验证备份完整性
 */
export function verifyBackup(host: BackupHost, backupId: number): VerificationResult {
  if (!host.backupManager) {
    throw new Error("Backup manager not initialized");
  }
  return host.backupManager.verifyBackup(backupId);
}

/**
 * 删除备份
 */
export async function deleteBackup(host: BackupHost, backupId: number): Promise<boolean> {
  if (!host.backupManager) {
    return false;
  }

  const deleted = host.backupManager.deleteBackup(backupId);

  if (deleted) {
    await host.env.withWrite(() => {
      addAudit(host.env, {
        actor: "system",
        action: "backup.delete",
        target: String(backupId),
        after: "deleted",
      });
    });
  }

  return deleted;
}

/**
 * 恢复备份（增强版，带完整性验证）
 */
export async function restoreBackupEnhanced(
  host: BackupHost,
  backupId: number,
  options: RestoreOptions = {},
): Promise<RestoreResult> {
  if (!host.backupManager) {
    return { ok: false, error: "Backup manager not initialized" };
  }

  const { verifyIntegrity = true, createSafetyBackup = true, decryptionKey } = options;

  try {
    // 0. 获取备份信息（在恢复前）
    const backupInfo = host.backupManager.listBackups().find((b) => b.id === backupId);
    if (!backupInfo) {
      return { ok: false, error: `Backup ${backupId} not found` };
    }

    // 1. 验证完整性
    if (verifyIntegrity) {
      const verification = host.backupManager.verifyBackup(backupId);
      if (!verification.valid) {
        return { ok: false, error: verification.error || "Integrity verification failed" };
      }
    }

    // 2. 创建安全备份
    let safetyBackupName: string | undefined;
    if (createSafetyBackup) {
      const safetyResult = await host.env.withExclusive(() => host.backupManager!.createBackup({ label: "before-restore" }));
      safetyBackupName = safetyResult.filename;
    }

    // 3. 准备恢复（解密如果需要）
    const { tempPath, schemaVersion } = host.backupManager.prepareRestore(backupId, decryptionKey);

    // 4. 执行恢复
    await host.env.withExclusive(() => host.env.restoreFromBackup(tempPath));

    // 5. 清理临时文件
    host.backupManager.cleanupTempFile(tempPath);

    // 6. 确保 schema 最新
    ensureSchema(host.env);

    // 7. 记录审计
    await host.env.withWrite(() => addAudit(host.env, {
      actor: "system",
      action: "backup.restore",
      target: backupInfo.filename,
      after: `restored; schema v${schemaVersion}; safety: ${safetyBackupName || "none"}`,
    }));

    // 8. 触发重新加载
    host.scheduleMirror();
    host.reload();

    return {
      ok: true,
      restored: backupInfo.filename,
      safetyBackup: safetyBackupName,
      schemaVersion,
    };
  } catch (e) {
    return {
      ok: false,
      error: `Backup restore failed: ${String(e)}`,
    };
  }
}
