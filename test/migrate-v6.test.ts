/**
 * roadmap v0.6 §9：schema 5 → 6 只加列（due_at / promise_state / promise_label / calendar_anchor）与索引，
 * 迁移前强制备份，旧数据不丢，新列默认值正确。
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

const V6_COLS = ["due_at", "promise_state", "promise_label", "calendar_anchor"];

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memweave-v6-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("schema v6 迁移", () => {
  it("v5 库升级：补四列与索引、先备份、旧数据不丢、默认值正确", () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(6);
    const env = openWeaveDb(dir, { readonly: false });
    ensureSchema(env);
    insertMemory(env, entry({ id: "old", content: "v5 时代的记忆" }));
    // 模拟 v5：先删 v6 索引再删列，版本号改回 5
    for (const t of Object.values(LAYER_TABLES)) {
      env.db.exec("DROP INDEX IF EXISTS ix_" + t + "_promise");
      env.db.exec("DROP INDEX IF EXISTS ix_" + t + "_anchor");
      for (const c of V6_COLS) env.db.exec("ALTER TABLE " + t + " DROP COLUMN " + c);
    }
    env.db.prepare("UPDATE schema_version SET version = 5 WHERE id = 1").run();
    ensureSchema(env);

    for (const t of Object.values(LAYER_TABLES)) {
      const cols = (env.db.prepare("PRAGMA table_info(" + t + ")").all() as Array<{ name: string }>).map((c) => c.name);
      for (const c of V6_COLS) expect(cols).toContain(c);
      const idx = (env.db.prepare("PRAGMA index_list(" + t + ")").all() as Array<{ name: string }>).map((i) => i.name);
      expect(idx).toContain("ix_" + t + "_promise");
      expect(idx).toContain("ix_" + t + "_anchor");
    }
    expect(getMemory(env, "old")).toMatchObject({
      content: "v5 时代的记忆",
      dueAt: null,
      promiseState: "none",
      promiseLabel: null,
      calendarAnchor: null,
    });
    expect(listMemory(env, {})).toHaveLength(1);
    const v = env.db.prepare("SELECT version FROM schema_version WHERE id = 1").get() as { version: number };
    expect(v.version).toBe(SCHEMA_VERSION);
    const bdir = join(dir, "backups");
    expect(existsSync(bdir)).toBe(true);
    expect(readdirSync(bdir).some((f) => f.includes("v5-to-" + SCHEMA_VERSION))).toBe(true);
    env.close();
  });

  it("新字段往返：写入后读回一致；坏 JSON 锚点读成 null 不抛错", () => {
    const env = openWeaveDb(dir, { readonly: false });
    ensureSchema(env);
    insertMemory(
      env,
      entry({
        id: "p",
        content: "周五前把报告发给主人",
        dueAt: Date.UTC(2026, 10, 3, 15, 59),
        promiseState: "pending",
        promiseLabel: "发报告",
        calendarAnchor: { kind: "annual", month: 3, day: 12, label: "生日" },
      }),
    );
    expect(getMemory(env, "p")).toMatchObject({
      dueAt: Date.UTC(2026, 10, 3, 15, 59),
      promiseState: "pending",
      promiseLabel: "发报告",
      calendarAnchor: { kind: "annual", month: 3, day: 12, label: "生日" },
    });
    env.db.prepare("UPDATE " + LAYER_TABLES.fact + " SET calendar_anchor = '{bad' WHERE id = 'p'").run();
    expect(getMemory(env, "p")!.calendarAnchor).toBeNull();
    env.close();
  });
});
