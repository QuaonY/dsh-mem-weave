/**
 * roadmap v0.4 §8：schema 4 → 5 只加列（七层表 boost INTEGER DEFAULT 0），迁移前强制备份，旧数据不丢。
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openWeaveDb } from "../src/store/db";
import { getMemory, insertMemory, listMemory } from "../src/store/dao";
import { ensureSchema } from "../src/store/migrate";
import { LAYER_TABLES, SCHEMA_VERSION } from "../src/store/schema";
import { entry } from "./link-health.test";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memweave-v5-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("schema v5 迁移", () => {
  it("v4 库升级：补 boost 列（默认 0）、先备份、数据不丢", () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(5);
    const env = openWeaveDb(dir, { readonly: false });
    ensureSchema(env);
    insertMemory(env, entry({ id: "old", content: "v4 时代的记忆" }));
    // 模拟 v4：删掉 boost 列，版本号改回 4
    for (const t of Object.values(LAYER_TABLES)) env.db.exec("ALTER TABLE " + t + " DROP COLUMN boost");
    env.db.prepare("UPDATE schema_version SET version = 4 WHERE id = 1").run();
    ensureSchema(env);

    for (const t of Object.values(LAYER_TABLES)) {
      const cols = (env.db.prepare("PRAGMA table_info(" + t + ")").all() as Array<{ name: string }>).map((c) => c.name);
      expect(cols).toContain("boost");
    }
    expect(getMemory(env, "old")).toMatchObject({ content: "v4 时代的记忆", boost: 0 });
    expect(listMemory(env, {})).toHaveLength(1);
    const v = env.db.prepare("SELECT version FROM schema_version WHERE id = 1").get() as { version: number };
    expect(v.version).toBe(SCHEMA_VERSION);
    const bdir = join(dir, "backups");
    expect(existsSync(bdir)).toBe(true);
    expect(readdirSync(bdir).some((f) => f.includes("v4-to-" + SCHEMA_VERSION))).toBe(true);
    env.close();
  });
});
