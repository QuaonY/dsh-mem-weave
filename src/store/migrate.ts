/**
 * 忆织 MemWeave —— 结构升级（规划文档 §5.4）：
 * CREATE IF NOT EXISTS + PRAGMA table_info 比对【只加列】+ schema_version + 升级前自动备份。
 */

import type { Level } from "../core/types";
import type { WeaveEnv } from "./db";
import { LAYER_COLUMNS, LAYER_TABLES, SCHEMA_SQL, SCHEMA_VERSION } from "./schema";

function tableExists(env: WeaveEnv, name: string): boolean {
  const row = env.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as { name?: string } | undefined;
  return row?.name === name;
}

/**
 * 旧版库的 schema_version 只有 (version, applied_at)、没有 id 列，
 * 按 `WHERE id = 1` 读取会抛 "no such column: id"，整库因此被降级为只读。
 * 这里把旧表原地重建为单行 (id = 1) 新结构，保留其中最大的版本号。
 */
function upgradeLegacyVersionTable(env: WeaveEnv): void {
  if (!tableExists(env, "schema_version")) return;
  if (columnNames(env, "schema_version").has("id")) return;
  const row = env.db
    .prepare("SELECT MAX(version) AS version, MAX(applied_at) AS applied_at FROM schema_version")
    .get() as { version?: number | null; applied_at?: number | null } | undefined;
  const version = typeof row?.version === "number" ? row.version : 0;
  const appliedAt = typeof row?.applied_at === "number" ? row.applied_at : Date.now();
  try {
    env.backup("legacy-schema-version");
  } catch {
    // 备份失败不阻塞迁移（I8：绝不阻塞会话）
  }
  env.db.exec("BEGIN IMMEDIATE");
  try {
    env.db.exec("ALTER TABLE schema_version RENAME TO schema_version_legacy");
    env.db.exec(
      "CREATE TABLE schema_version (" +
        "id INTEGER PRIMARY KEY CHECK (id = 1)," +
        "version INTEGER NOT NULL," +
        "applied_at INTEGER NOT NULL" +
        ")",
    );
    if (version > 0) {
      env.db.prepare("INSERT INTO schema_version (id, version, applied_at) VALUES (1, ?, ?)").run(version, appliedAt);
    }
    env.db.exec("DROP TABLE schema_version_legacy");
    env.db.exec("COMMIT");
  } catch (e) {
    try {
      env.db.exec("ROLLBACK");
    } catch {
      // 事务可能已回滚
    }
    throw e;
  }
}

function readVersion(env: WeaveEnv): number {
  if (!tableExists(env, "schema_version")) return 0;
  const sql = columnNames(env, "schema_version").has("id")
    ? "SELECT version FROM schema_version WHERE id = 1"
    : "SELECT MAX(version) AS version FROM schema_version";
  const row = env.db.prepare(sql).get() as
    | { version?: number }
    | undefined;
  return typeof row?.version === "number" ? row.version : 0;
}

function columnNames(env: WeaveEnv, table: string): Set<string> {
  const rows = env.db.prepare("PRAGMA table_info(" + table + ")").all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

export function ensureSchema(env: WeaveEnv): void {
  // 只读连接不能改表：保持原样，由 readVersion 的容错路径处理
  if (!env.readonly) upgradeLegacyVersionTable(env);
  const current = readVersion(env);

  // 升级前自动备份：memweave.db.bak.<version>.<ts>
  if (current > 0 && current < SCHEMA_VERSION) {
    try {
      env.backup("v" + current + "-to-" + SCHEMA_VERSION);
    } catch {
      // 备份失败不阻塞迁移（I8：绝不阻塞会话）
    }
  }

  // 建表 → 只加列 → 建索引：旧库缺列时先补列再建索引，顺序不能反
  const isIndex = (sql: string): boolean => /^CREATE\s+(UNIQUE\s+)?INDEX/i.test(sql.trim());
  for (const sql of SCHEMA_SQL) {
    if (!isIndex(sql)) env.db.exec(sql);
  }

  // 七层表：只加列，不删不改
  const levels = Object.keys(LAYER_TABLES) as Level[];
  for (const level of levels) {
    const table = LAYER_TABLES[level];
    const existing = columnNames(env, table);
    for (const [name, ddl] of LAYER_COLUMNS) {
      if (existing.has(name)) continue;
      const addable = ddl.replace("PRIMARY KEY", "");
      env.db.exec("ALTER TABLE " + table + " ADD COLUMN " + addable);
    }
  }

  // Candidate revisions gained a persisted patch in schema v2.
  if (!columnNames(env, "candidates").has("patch")) {
    env.db.exec("ALTER TABLE candidates ADD COLUMN patch TEXT");
  }

  for (const sql of SCHEMA_SQL) {
    if (!isIndex(sql)) continue;
    try {
      env.db.exec(sql);
    } catch {
      // 索引创建失败不阻塞迁移（I8：绝不阻塞会话）
    }
  }

  env.db.prepare(
    "INSERT INTO schema_version (id, version, applied_at) VALUES (1, ?, ?)" +
      " ON CONFLICT(id) DO UPDATE SET version = excluded.version, applied_at = excluded.applied_at",
  ).run(SCHEMA_VERSION, Date.now());
}
