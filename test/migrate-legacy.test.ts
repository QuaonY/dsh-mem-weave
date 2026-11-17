/**
 * 旧版库的 schema_version 没有 id 列（只有 version, applied_at）。
 * 以前 readVersion 按 `WHERE id = 1` 读取会抛 "no such column: id"
 * openService 因此把整个记忆库降级为只读，设置页所有写操作被禁用。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openWeaveDb } from "../src/store/db";
import { SCHEMA_VERSION } from "../src/store/schema";
import { openService } from "../src/host/index";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memweave-legacy-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function seedLegacyVersionTable(version: number): void {
  const env = openWeaveDb(dir, { readonly: false });
  env.db.exec("CREATE TABLE schema_version (version INTEGER NOT NULL, applied_at INTEGER NOT NULL)");
  env.db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)").run(version, 1000);
  env.close();
}

describe("旧版 schema_version 迁移", () => {
  it("没有 id 列的旧库以可写模式打开，不再降级为只读", async () => {
    seedLegacyVersionTable(1);
    const rt = openService(dir);
    try {
      expect(rt.warnings).toEqual([]);
      expect(rt.env.readonly).toBe(false);
      const cols = (rt.env.db.prepare("PRAGMA table_info(schema_version)").all() as Array<{ name: string }>).map((c) => c.name);
      expect(cols).toContain("id");
      const row = rt.env.db.prepare("SELECT id, version FROM schema_version").all();
      expect(row).toEqual([{ id: 1, version: SCHEMA_VERSION }]);
      const write = await rt.service.remember({ level: "user", content: "legacy db writable" }, "human");
      expect(write.ok).toBe(true);
    } finally {
      rt.env.close();
    }
  });

  it("v14 旧库补 recall_log.reason 与 inject_state 延迟列，旧数据保留", () => {
    const env = openWeaveDb(dir, { readonly: false });
    env.db.exec("CREATE TABLE schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL, applied_at INTEGER NOT NULL)");
    env.db.prepare("INSERT INTO schema_version (id, version, applied_at) VALUES (1, 14, 1000)").run();
    env.db.exec("CREATE TABLE recall_log (ts INTEGER NOT NULL, memory_id TEXT NOT NULL, session_id TEXT, turn INTEGER)");
    env.db.prepare("INSERT INTO recall_log (ts, memory_id, session_id, turn) VALUES (?, ?, ?, ?)").run(1, "m1", "s1", 1);
    env.db.exec(
      "CREATE TABLE inject_state (session_id TEXT PRIMARY KEY, snapshot_at INTEGER, snapshot_hash TEXT," +
        " pushed TEXT, frozen INTEGER DEFAULT 1, chars_used INTEGER DEFAULT 0)",
    );
    env.db.prepare("INSERT INTO inject_state (session_id, snapshot_at, pushed, chars_used) VALUES ('s1', 5, '[]', 12)").run();
    env.close();

    const rt = openService(dir);
    try {
      const recallCols = (rt.env.db.prepare("PRAGMA table_info(recall_log)").all() as Array<{ name: string }>).map((c) => c.name);
      expect(recallCols).toContain("reason");
      expect(rt.env.db.prepare("SELECT memory_id, reason FROM recall_log").all()).toEqual([{ memory_id: "m1", reason: null }]);

      const injectCols = (rt.env.db.prepare("PRAGMA table_info(inject_state)").all() as Array<{ name: string }>).map((c) => c.name);
      expect(injectCols).toEqual(
        expect.arrayContaining([
          "inject_ms",
          "recall_ms",
          "inject_at",
          "inject_turn",
          "inject_chars",
          "inject_items",
          "injected",
        ]),
      );
      expect(rt.env.db.prepare("SELECT snapshot_at, chars_used, inject_ms, injected FROM inject_state").get()).toEqual({
        snapshot_at: 5,
        chars_used: 12,
        inject_ms: 0,
        injected: 0,
      });
      expect(rt.env.db.prepare("SELECT version FROM schema_version WHERE id = 1").get()).toEqual({ version: SCHEMA_VERSION });
      // 旧库也要有后台租约表（CREATE IF NOT EXISTS）
      const leaseTable = rt.env.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'process_lease'")
        .get();
      expect(leaseTable).toEqual({ name: "process_lease" });
    } finally {
      rt.env.close();
    }
  });

  it("旧表的多行版本记录取最大值，迁移只运行一次", () => {
    const env = openWeaveDb(dir, { readonly: false });
    env.db.exec("CREATE TABLE schema_version (version INTEGER NOT NULL, applied_at INTEGER NOT NULL)");
    env.db.exec("INSERT INTO schema_version (version, applied_at) VALUES (1, 1000), (2, 2000)");
    env.close();

    const first = openService(dir);
    first.env.close();
    const second = openService(dir);
    try {
      expect(second.warnings).toEqual([]);
      expect(second.env.readonly).toBe(false);
      expect(second.env.db.prepare("SELECT COUNT(*) AS n FROM schema_version").get()).toEqual({ n: 1 });
    } finally {
      second.env.close();
    }
  });
});
