/**
 * roadmap v0.7 §9：schema 6 → 7 只加不删：七层表加 search_terms，新表 distill_queue + 索引；
 * 迁移前强制备份，旧数据不丢，新列默认 null。
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openWeaveDb } from "../src/store/db";
import {
  getDistillGroup,
  getMemory,
  insertDistillGroup,
  insertMemory,
  listDistillGroups,
  setDistillStatus,
  setSearchTerms,
} from "../src/store/dao";
import { ensureSchema } from "../src/store/migrate";
import { LAYER_TABLES, SCHEMA_VERSION } from "../src/store/schema";
import { entry } from "./link-health.test";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memweave-v7-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("schema v7 迁移", () => {
  it("v6 库升级：补 search_terms 列与 distill_queue 表、先备份、旧数据不丢", () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(7);
    const env = openWeaveDb(dir, { readonly: false });
    ensureSchema(env);
    insertMemory(env, entry({ id: "old", content: "v6 时代的记忆", promiseState: "pending", dueAt: Date.UTC(2026, 11, 1) }));
    // 模拟 v6：删 v7 的列、表、索引，版本号改回 6
    for (const t of Object.values(LAYER_TABLES)) env.db.exec("ALTER TABLE " + t + " DROP COLUMN search_terms");
    env.db.exec("DROP INDEX IF EXISTS ix_distill_status");
    env.db.exec("DROP TABLE distill_queue");
    env.db.prepare("UPDATE schema_version SET version = 6 WHERE id = 1").run();
    ensureSchema(env);

    for (const t of Object.values(LAYER_TABLES)) {
      const cols = (env.db.prepare("PRAGMA table_info(" + t + ")").all() as Array<{ name: string }>).map((c) => c.name);
      expect(cols).toContain("search_terms");
    }
    const qcols = (env.db.prepare("PRAGMA table_info(distill_queue)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(qcols).toEqual(["id", "member_ids", "reason", "created_at", "status"]);
    const idx = (env.db.prepare("PRAGMA index_list(distill_queue)").all() as Array<{ name: string }>).map((i) => i.name);
    expect(idx).toContain("ix_distill_status");

    expect(getMemory(env, "old")).toMatchObject({ content: "v6 时代的记忆", promiseState: "pending", searchTerms: null });
    const v = env.db.prepare("SELECT version FROM schema_version WHERE id = 1").get() as { version: number };
    expect(v.version).toBe(SCHEMA_VERSION);
    expect(existsSync(join(dir, "backups"))).toBe(true);
    expect(readdirSync(join(dir, "backups")).some((f) => f.includes("v6-to-" + SCHEMA_VERSION))).toBe(true);
    env.close();
  });

  it("检索词往返：写入 / setSearchTerms 不改 updated_at；空数组存成 null；坏 JSON 读成 null", () => {
    const env = openWeaveDb(dir, { readonly: false });
    ensureSchema(env);
    insertMemory(env, entry({ id: "t", content: "不吃香菜，点外卖要备注", searchTerms: ["忌口", "点餐"] }));
    const before = getMemory(env, "t")!;
    expect(before.searchTerms).toEqual(["忌口", "点餐"]);
    setSearchTerms(env, "fact", "t", ["忌口", "饮食", "口味"]);
    const after = getMemory(env, "t")!;
    expect(after.searchTerms).toEqual(["忌口", "饮食", "口味"]);
    expect(after.updatedAt).toBe(before.updatedAt);
    setSearchTerms(env, "fact", "t", []);
    expect(getMemory(env, "t")!.searchTerms).toBeNull();
    env.db.prepare("UPDATE " + LAYER_TABLES.fact + " SET search_terms = '[bad' WHERE id = 't'").run();
    expect(getMemory(env, "t")!.searchTerms).toBeNull();
    env.close();
  });

  it("distill_queue：增、查、改状态", () => {
    const env = openWeaveDb(dir, { readonly: false });
    ensureSchema(env);
    insertDistillGroup(env, { id: "g1", memberIds: ["a", "b", "c"], reason: "links", createdAt: 1, status: "open" });
    insertDistillGroup(env, { id: "g2", memberIds: ["d", "e", "f"], reason: "jaccard", createdAt: 2, status: "open" });
    expect(listDistillGroups(env, "open").map((g) => g.id)).toEqual(["g1", "g2"]);
    setDistillStatus(env, "g1", "done");
    expect(getDistillGroup(env, "g1")).toMatchObject({ memberIds: ["a", "b", "c"], status: "done" });
    expect(listDistillGroups(env, "open").map((g) => g.id)).toEqual(["g2"]);
    expect(getDistillGroup(env, "nope")).toBeNull();
    env.close();
  });
});
