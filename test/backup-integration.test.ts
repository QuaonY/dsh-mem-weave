/**
 * 备份恢复完整性集成测试
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { openWeaveDb } from "../src/store/db";
import { ensureSchema } from "../src/store/migrate";
import { SCHEMA_VERSION } from "../src/store/schema";
import { WeaveService, defaultConfig } from "../src/host/service";
import type { WriteInput } from "../src/store/govern";

const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire("node:sqlite") as typeof import("node:sqlite");

describe("Backup Integration", () => {
  const testDir = join(process.cwd(), "test-data", "backup-integration");
  let service: WeaveService;

  beforeEach(() => {
    // 清理并创建测试目录
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    mkdirSync(testDir, { recursive: true });
    mkdirSync(join(testDir, "backups"), { recursive: true });

    // 创建服务
    const env = openWeaveDb(testDir, { readonly: false });
    ensureSchema(env);
    const config = defaultConfig(testDir);
    config.backup = {
      enabled: true,
      autoBackup: false,
      maxBackups: 5,
      encrypt: false,
    };
    service = new WeaveService(env, config);
  });

  afterEach(() => {
    service.env.close();
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe("Service Integration", () => {
    it("应该通过WeaveService创建备份", async () => {
      // 写入一些数据
      await service.remember({ content: "Integration test memory", level: "fact" }, "human");

      const result = await service.createBackup({ label: "service-test" });

      expect(result).toBeDefined();
      expect(result.id).toBeGreaterThan(0);
      expect(result.filename).toContain("service-test");
      expect(result.size).toBeGreaterThan(0);
      expect(existsSync(result.filepath)).toBe(true);
    });

    it("应该列出所有备份", async () => {
      await service.createBackup({ label: "backup1" });
      await service.createBackup({ label: "backup2" });

      const backups = service.listBackupsEnhanced();

      expect(backups).toHaveLength(2);
      expect(backups[0].filename).toContain("backup");
    });

    it("应该验证备份完整性", async () => {
      const backup = await service.createBackup({ label: "verify-test" });
      const verification = service.verifyBackup(backup.id);

      expect(verification.valid).toBe(true);
      expect(verification.filename).toBe(backup.filename);
    });

    it("应该删除备份", async () => {
      const backup = await service.createBackup({ label: "delete-test" });

      const deleted = await service.deleteBackup(backup.id);

      expect(deleted).toBe(true);
      expect(service.listBackupsEnhanced()).toHaveLength(0);
    });

    it("应该自动清理旧备份", async () => {
      // 创建6个备份（maxBackups = 5）
      for (let i = 1; i <= 6; i++) {
        await service.createBackup({ label: `auto-cleanup-${i}` });
      }

      // 应该只保留5个
      const backups = service.listBackupsEnhanced();
      expect(backups.length).toBeLessThanOrEqual(5);
    });
  });

  describe("Backup Content Verification", () => {
    it("备份应该包含所有记忆数据", async () => {
      // 写入多条记忆
      const memories = [
        "用户喜欢喝咖啡",
        "项目使用 TypeScript",
        "团队规模为 10 人",
      ];

      for (const content of memories) {
        await service.remember({ content, level: "fact" }, "human");
      }

      // 创建备份
      const backup = await service.createBackup({ label: "content-test" });

      // 验证备份可以打开
      const backupDB = new DatabaseSync(backup.filepath, { readOnly: true });
      
      try {
        const rows = backupDB.prepare("SELECT content FROM fact").all() as Array<{ content: string }>;
        expect(rows).toHaveLength(memories.length);
        
        const contents = rows.map(r => r.content);
        for (const memory of memories) {
          expect(contents).toContain(memory);
        }
      } finally {
        backupDB.close();
      }
    });

    it("备份应该包含schema版本信息", async () => {
      const backup = await service.createBackup({ label: "schema-test" });

      const backupDB = new DatabaseSync(backup.filepath, { readOnly: true });
      
      try {
        const row = backupDB.prepare("SELECT version FROM schema_version WHERE id = 1").get() as { version: number } | undefined;
        expect(row).toBeDefined();
        expect(row!.version).toBe(SCHEMA_VERSION);
      } finally {
        backupDB.close();
      }
    });
  });

  describe("Backup Restore", () => {
    it("应该成功恢复备份", async () => {
      // 写入原始数据
      await service.remember({ content: "原始记忆", level: "fact" }, "human");

      // 创建备份
      const backup = await service.createBackup({ label: "restore-original" });

      // 修改数据
      await service.remember({ content: "新的记忆", level: "fact" }, "human");

      const beforeRestore = service.env.db.prepare("SELECT COUNT(*) as count FROM fact").get() as { count: number };
      expect(beforeRestore.count).toBe(2);

      // 恢复备份
      const result = await service.restoreBackupEnhanced(backup.id);

      expect(result.ok).toBe(true);
      expect(result.restored).toBe(backup.filename);
      expect(result.safetyBackup).toBeDefined();

      // 验证数据已恢复
      const afterRestore = service.env.db.prepare("SELECT COUNT(*) as count FROM fact").get() as { count: number };
      expect(afterRestore.count).toBe(1);

      const memory = service.env.db.prepare("SELECT content FROM fact LIMIT 1").get() as { content: string };
      expect(memory.content).toBe("原始记忆");
    });

    it("恢复前应该创建安全备份", async () => {
      const backup = await service.createBackup({ label: "safety-test" });

      const result = await service.restoreBackupEnhanced(backup.id, { createSafetyBackup: true });

      // 应该成功并返回安全备份文件名
      expect(result.ok).toBe(true);
      expect(result.safetyBackup).toBeDefined();
      expect(result.safetyBackup).toContain("before-restore");
    });

    it("应该在恢复前验证完整性", async () => {
      const backup = await service.createBackup({ label: "integrity-check" });

      // 损坏备份文件
      const fs = require("node:fs");
      fs.writeFileSync(backup.filepath, "corrupted");

      const result = await service.restoreBackupEnhanced(backup.id, { verifyIntegrity: true });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("Integrity verification failed");
    });

    it("可以跳过完整性验证", async () => {
      const backup = await service.createBackup({ label: "skip-verify" });

      const result = await service.restoreBackupEnhanced(backup.id, { verifyIntegrity: false });

      expect(result.ok).toBe(true);
    });
  });

  describe("Encrypted Backup", () => {
    it("应该创建和恢复加密备份", async () => {
      const encryptionKey = "my-secret-key-12345";

      // 写入数据
      await service.remember({ content: "敏感信息", level: "fact" }, "human");

      // 创建加密备份
      const backup = await service.createBackup({
        label: "encrypted",
        encrypt: true,
        encryptionKey,
      });

      expect(backup.encrypted).toBe(true);

      // 清空数据
      service.env.db.exec("DELETE FROM fact");

      // 恢复加密备份
      const result = await service.restoreBackupEnhanced(backup.id, {
        decryptionKey: encryptionKey,
      });

      expect(result.ok).toBe(true);

      // 验证数据已恢复
      const memory = service.env.db.prepare("SELECT content FROM fact LIMIT 1").get() as { content: string };
      expect(memory.content).toBe("敏感信息");
    });

    it("错误的解密密钥应该失败", async () => {
      const backup = await service.createBackup({
        label: "wrong-key",
        encrypt: true,
        encryptionKey: "correct-key",
      });

      const result = await service.restoreBackupEnhanced(backup.id, {
        decryptionKey: "wrong-key",
      });

      expect(result.ok).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe("Audit Log", () => {
    it("创建备份应该记录审计日志", async () => {
      await service.createBackup({ label: "audit-test" });

      const logs = service.env.db.prepare(`
        SELECT * FROM audit_log WHERE action = 'backup.create' ORDER BY ts DESC LIMIT 1
      `).get() as any;

      expect(logs).toBeDefined();
      expect(logs.actor).toBe("system");
      expect(logs.target).toContain("audit-test");
    });

    it("删除备份应该记录审计日志", async () => {
      const backup = await service.createBackup({ label: "delete-audit" });
      await service.deleteBackup(backup.id);

      const logs = service.env.db.prepare(`
        SELECT * FROM audit_log WHERE action = 'backup.delete' ORDER BY ts DESC LIMIT 1
      `).get() as any;

      expect(logs).toBeDefined();
      expect(logs.actor).toBe("system");
      expect(logs.target).toBe(String(backup.id));
    });

    it("恢复备份应该记录审计日志", async () => {
      const backup = await service.createBackup({ label: "restore-audit" });
      await service.restoreBackupEnhanced(backup.id);

      const logs = service.env.db.prepare(`
        SELECT * FROM audit_log WHERE action = 'backup.restore' ORDER BY ts DESC LIMIT 1
      `).get() as any;

      expect(logs).toBeDefined();
      expect(logs.actor).toBe("system");
      expect(logs.target).toContain("restore-audit");
    });
  });

  describe("Configuration", () => {
    it("禁用备份功能时应该抛出错误", async () => {
      const env = openWeaveDb(testDir + "-disabled", { readonly: false });
      ensureSchema(env);
      const config = defaultConfig(testDir + "-disabled");
      config.backup = { enabled: false, autoBackup: false, maxBackups: 5, encrypt: false };
      const disabledService = new WeaveService(env, config);

      try {
        await expect(disabledService.createBackup()).rejects.toThrow("not initialized");
      } finally {
        disabledService.env.close();
        if (existsSync(testDir + "-disabled")) {
          rmSync(testDir + "-disabled", { recursive: true, force: true });
        }
      }
    });

    it("应该使用配置的maxBackups", async () => {
      // 创建超过限制的备份
      for (let i = 1; i <= 7; i++) {
        await service.createBackup({ label: `max-test-${i}` });
      }

      const backups = service.listBackupsEnhanced();
      expect(backups.length).toBeLessThanOrEqual(5);
    });
  });

  describe("Edge Cases", () => {
    it("空数据库应该可以备份和恢复", async () => {
      const backup = await service.createBackup({ label: "empty" });
      expect(backup.size).toBeGreaterThan(0); // SQLite 空数据库也有大小

      const result = await service.restoreBackupEnhanced(backup.id);
      expect(result.ok).toBe(true);
    });

    it("大量数据应该可以正常备份", async () => {
      // 插入1000条记忆
      for (let i = 1; i <= 1000; i++) {
        await service.remember({ content: `Memory ${i}`, level: "fact" }, "human");
      }

      const backup = await service.createBackup({ label: "large" });
      expect(backup.size).toBeGreaterThan(10000); // 至少10KB

      const verification = service.verifyBackup(backup.id);
      expect(verification.valid).toBe(true);
    });

    it("特殊字符标签应该正确处理", async () => {
      const backup = await service.createBackup({ label: "备份@2024-01-01 #特殊" });

      expect(backup.filename).toBeDefined();
      expect(backup.filename).not.toContain("@");
      expect(backup.filename).not.toContain("#");
      expect(existsSync(backup.filepath)).toBe(true);
    });
  });
});
