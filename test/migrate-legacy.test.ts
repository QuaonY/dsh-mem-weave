/**
 * 旧版库的 schema_version 没有 id 列（只有 version, applied_at）。
 * 以前 readVersion 按 `WHERE id = 1` 读取会抛 "no such column: id"，
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
