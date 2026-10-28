/**
 * 忆织 MemWeave —— 开库 / PRAGMA / 进程内单写者（规划文档 §5.6）
 */

import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { createRequire } from "node:module";
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

// node:sqlite 用 createRequire 运行时加载：避开打包器/测试器对新内置模块的静态解析（仍零运行时依赖）
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire("node:sqlite") as typeof import("node:sqlite");

export interface WeaveEnv {
  db: DatabaseSyncType;
  dataDir: string;
  readonly: boolean;
  /** 进程内单写者串行队列（fn 内不得再调 withWrite，会死锁） */
  withWrite<T>(fn: () => T): Promise<T>;
  /** Serialized non-transactional operation for operations that must replace the SQLite connection. */
  withExclusive<T>(fn: () => T): Promise<T>;
  /** Replace the active database file from a closed, validated backup path and reopen the connection. */
  restoreFromBackup(source: string): void;
  /** VACUUM INTO 备份，返回备份路径 */
  backup(label: string): string;
  close(): void;
}

export const DB_FILE = "memweave.db";

const SAFE_LABEL = /[^A-Za-z0-9_.-]/g;

export function openWeaveDb(
  dataDir: string,
  opts?: { readonly?: boolean; /** roadmap G11：库文件损坏时用空内存库兜底（只读语义，读路径返回空） */ memory?: boolean },
): WeaveEnv {
  const readonly = opts?.readonly === true;
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, DB_FILE);
  // memory 兜底：连接本身可写（便于建表），但 env.readonly=true，所有写入口照样拒绝
  let db = opts?.memory ? new DatabaseSync(":memory:") : new DatabaseSync(file, { readOnly: readonly });

  const configure = (): void => {
    if (!readonly) {
      try {
        db.exec("PRAGMA journal_mode = WAL");
      } catch {
        // 只读文件系统等极端情况：降级继续，不阻塞会话（I8）
      }
      db.exec("PRAGMA synchronous = NORMAL");
    }
    db.exec("PRAGMA busy_timeout = 5000");
  };
  try {
    configure();
  } catch (e) {
    // 打开失败时释放文件句柄（Windows 上不关会锁住目录）
    try {
      db.close();
    } catch {
      // 同上
    }
    throw e;
  }

  let queue: Promise<unknown> = Promise.resolve();
  function enqueue<T>(fn: () => T): Promise<T> {
    const run = queue.then(fn);
    queue = run.then(() => undefined, () => undefined);
    return run;
  }

  function withWrite<T>(fn: () => T): Promise<T> {
    return enqueue(() => {
      if (readonly) throw new Error("E_READONLY: database is opened readonly");
      db.exec("BEGIN IMMEDIATE");
      try {
        const out = fn();
        db.exec("COMMIT");
        return out;
      } catch (e) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // 事务可能已回滚
        }
        throw e;
      }
    });
  }

  function withExclusive<T>(fn: () => T): Promise<T> {
    return enqueue(() => {
      if (readonly) throw new Error("E_READONLY: database is opened readonly");
      return fn();
    });
  }

  function restoreFromBackup(source: string): void {
    if (readonly) throw new Error("E_READONLY: database is opened readonly");
    if (!existsSync(source)) throw new Error("backup file not found");
    const staging = file + ".restore-" + Date.now().toString(36);
    copyFileSync(source, staging);
    try {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      db.close();
      rmSync(file + "-wal", { force: true });
      rmSync(file + "-shm", { force: true });
      try {
        renameSync(staging, file);
      } catch (error) {
        db = new DatabaseSync(file, { readOnly: false });
        configure();
        throw error;
      }
      db = new DatabaseSync(file, { readOnly: false });
      configure();
    } finally {
      rmSync(staging, { force: true });
    }
  }

  function backup(label: string): string {
    const dir = join(dataDir, "backups");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const safe = String(label).replace(SAFE_LABEL, "_");
    const target = join(dir, "memweave.db.bak." + safe + "." + Date.now().toString(36));
    if (target.includes("'")) throw new Error("invalid backup path");
    db.exec("VACUUM INTO '" + target + "'");
    return target;
  }

  function close(): void {
    try {
      db.close();
    } catch {
      // 已关闭
    }
  }

  return { get db() { return db; }, dataDir, readonly, withWrite, withExclusive, restoreFromBackup, backup, close };
}
