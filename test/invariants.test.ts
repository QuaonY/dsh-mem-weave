/**
 * roadmap v0.6 M3：检索不改重要度（不变量测试）。
 * - 连续召回同一批条目 50 次，importance / content / level / updated_at 都不变；
 * - 召回路径只写 recall_log（renderTurn 另有历史行为：access_count +1，仅展示用、不进排序，C6）；
 * - 同一查询、同一库状态，两次召回的结果和 explain 完全一致。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openService } from "../src/host/index";
import { recallEntries, type WeaveService } from "../src/host/service";
import type { WeaveEnv } from "../src/store/db";
import { insertMemory } from "../src/store/dao";
import { LAYER_TABLES } from "../src/store/schema";
import { entry } from "./link-health.test";

const DAY = 86400000;
let dir: string;
let env: WeaveEnv;
let service: WeaveService;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memweave-inv-"));
  const rt = openService(dir);
  env = rt.env;
  service = rt.service;
  const now = Date.now();
  for (let i = 0; i < 12; i += 1) {
    insertMemory(
      env,
      entry({
        id: "m" + i,
        level: (["fact", "project", "user", "lesson"] as const)[i % 4],
        content: "部署脚本 发布流程 第" + i + "条 " + (i % 3 === 0 ? "回滚" : "灰度"),
        importance: 1 + (i % 5),
        updatedAt: now - i * 15 * DAY,
        ...(i === 2 ? { dueAt: now + 3 * DAY, promiseState: "pending" as const } : {}),
        ...(i === 5 ? { calendarAnchor: { kind: "weekly" as const, weekday: new Date().getDay() } } : {}),
      }),
    );
  }
  // 打开所有会改排序的开关，确认它们也不写库
  service.config.emotion.enabled = true;
  service.config.recall.intent.enabled = true;
});

afterEach(() => {
  service.stopMirror(false);
  env.close();
  rmSync(dir, { recursive: true, force: true });
});

/** 所有表的全量快照（按主键排序后的 JSON）；可排除表 / 列 */
function snapshot(skipTables: string[] = [], skipCols: string[] = []): Record<string, string> {
  const tables = (env.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>)
    .map((t) => t.name)
    .filter((t) => !skipTables.includes(t))
    .sort();
  const out: Record<string, string> = {};
  for (const t of tables) {
    const rows = (env.db.prepare("SELECT * FROM " + t).all() as Array<Record<string, unknown>>).map((r) => {
      const c = { ...r };
      for (const k of skipCols) delete c[k];
      return JSON.stringify(c);
    });
    out[t] = rows.sort().join("\n");
  }
  return out;
}

const QUERIES = ["部署脚本", "发布流程 回滚", "灰度", "我之前说过什么偏好", "规则"];

describe("M3 检索不改库", () => {
  it("service.recall 连续 50 次：整库逐字节不变", () => {
    const before = snapshot();
    for (let i = 0; i < 50; i += 1) service.recall(QUERIES[i % QUERIES.length]);
    expect(snapshot()).toEqual(before);
  });

  it("renderTurn 连续 50 次：除 recall_log 与 access_count 外整库不变；importance/content/level/updated_at 不变", () => {
    const fields = (): string =>
      Object.entries(LAYER_TABLES)
        // level 由所在表决定：表名一并记下，条目换表即视为 level 变了
        .flatMap(([level, t]) =>
          (env.db.prepare("SELECT id, importance, content, updated_at, boost FROM " + t + " ORDER BY id").all() as object[]).map((r) => ({ level, ...r })),
        )
        .map((r) => JSON.stringify(r))
        .join("\n");
    const f0 = fields();
    // budget_ledger / inject_state 是注入记账（每轮写了多少字、注入了什么），不属于检索路径
    const SKIP = ["recall_log", "audit_log", "budget_ledger", "inject_state"];
    const before = snapshot(SKIP, ["access_count"]);
    const auditBefore = env.db.prepare("SELECT COUNT(*) AS n FROM audit_log").get() as { n: number };
    const baseline = new Map(service.listMemory({}).map((e) => [e.id, e.updatedAt]));
    for (let i = 0; i < 50; i += 1) {
      service.renderTurn({ sessionId: "inv", first: false, query: QUERIES[i % QUERIES.length], baseline, turn: i + 1 });
    }
    expect(fields()).toBe(f0);
    expect(snapshot(SKIP, ["access_count"])).toEqual(before);
    // 审计：召回路径不写任何 memory.* / dream.* 动作
    const newAudit = env.db
      .prepare("SELECT action FROM audit_log ORDER BY rowid LIMIT -1 OFFSET ?")
      .all(auditBefore.n) as Array<{ action: string }>;
    expect(newAudit.filter((a) => /^(memory|dream|promise|candidate)\./.test(a.action))).toEqual([]);
    const logged = env.db.prepare("SELECT COUNT(*) AS n FROM recall_log").get() as { n: number };
    expect(logged.n).toBeGreaterThan(0);
  });
});

describe("M3 召回路径只写 recall_log", () => {
  it("recall + logRecall（renderTurn 里的检索步骤）：除 recall_log 外整库不变", async () => {
    const { logRecall } = await import("../src/store/link");
    const before = snapshot(["recall_log"]);
    for (let i = 0; i < 50; i += 1) {
      const hits = service.recall(QUERIES[i % QUERIES.length]);
      logRecall(env, hits.map((h) => h.id), "inv", i + 1);
    }
    expect(snapshot(["recall_log"])).toEqual(before);
    expect((env.db.prepare("SELECT COUNT(*) AS n FROM recall_log").get() as { n: number }).n).toBeGreaterThan(0);
  });
});

describe("M3 可复现", () => {
  it("同一查询、同一库状态：结果与 explain 完全一致", () => {
    const now = Date.now();
    const opts = {
      now,
      emotion: service.config.emotion,
      intent: service.config.recall.intent,
      promise: service.config.promise,
      calendar: service.config.calendar,
    };
    for (const q of QUERIES) {
      const a = recallEntries(env, q, opts);
      const b = recallEntries(env, q, opts);
      expect(b.map((h) => [h.id, h.score, h.explain, h.routes])).toEqual(a.map((h) => [h.id, h.score, h.explain, h.routes]));
    }
  });
});
