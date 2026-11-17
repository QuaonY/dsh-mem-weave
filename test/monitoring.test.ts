/**
 * 白盒监控：status/health、status/queues、memory/detail 三个只读接口。
 * 重点覆盖：各检查项的 pass/warn/fail 判据、队列计数来源、审计里 before/after 的脱敏。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openWeaveDb, type WeaveEnv } from "../src/store/db";
import { ensureSchema } from "../src/store/migrate";
import { addAudit, insertCandidate, insertDistillGroup, insertLink, insertMemory, newId } from "../src/store/dao";
import { WeaveService, defaultConfig, type WeaveConfig } from "../src/host/service";
import { invokeRpc } from "../src/host/rpc";
import type { MemoryEntry } from "../src/core/types";

let dir: string;
let env: WeaveEnv;
let service: WeaveService;
let config: WeaveConfig;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memweave-m82-"));
  env = openWeaveDb(join(dir, "memweave"));
  ensureSchema(env);
  config = defaultConfig(dir);
  service = new WeaveService(env, config);
});

afterEach(() => {
  service.stopMirror(true);
  env.close();
  rmSync(dir, { recursive: true, force: true });
});

const TS = Date.now();

function mem(over: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: newId(),
    level: "fact",
    project: "proj-m82",
    section: null,
    content: "监控样本：项目使用 SQLite",
    keywords: ["监控"],
    importance: 3,
    status: "active",
    semanticKey: null,
    confidence: null,
    validFrom: TS,
    validTo: null,
    evidence: [],
    hash: null,
    source: "human",
    accessCount: 0,
    tier: "hot",
    createdAt: TS,
    updatedAt: TS,
    ...over,
  };
}

function l0(over: {
  id?: string;
  sessionId?: string;
  seq?: number;
  content?: string;
  ts?: number;
  retainedUntil?: number | null;
}): string {
  const id = over.id ?? newId();
  env.db
    .prepare(
      "INSERT INTO l0_messages (id, session_id, seq, role, content, ts, source, retained_until) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      id,
      over.sessionId ?? "s1",
      over.seq ?? 1,
      "user",
      over.content ?? "原始消息",
      over.ts ?? TS,
      "test",
      over.retainedUntil === undefined ? TS + 86400000 : over.retainedUntil,
    );
  return id;
}

type HealthOut = {
  ok: boolean;
  checks: Array<{ name: string; status: "pass" | "warn" | "fail"; detail: string; data?: Record<string, unknown> }>;
  summary: { pass: number; warn: number; fail: number };
};

async function health(): Promise<HealthOut> {
  return (await invokeRpc(service, "memweave.status/health", {}, "human")) as HealthOut;
}

const pick = (h: HealthOut, name: string) => h.checks.find((c) => c.name === name)!;

describe("status/health", () => {
  it("新库九项检查全过，顺序稳定", async () => {
    const h = await health();
    expect(h.ok).toBe(true);
    expect(h.checks.map((c) => c.name)).toEqual([
      "schema",
      "indexes",
      "status-values",
      "orphans",
      "retention",
      "embedding-jobs",
      "vector",
      "budget",
      "storage",
    ]);
    expect(h.summary).toEqual({ pass: 9, warn: 0, fail: 0 });
  });

  it("结构版本不符时 fail，且整体 ok=false", async () => {
    env.db.prepare("UPDATE schema_version SET version = 0 WHERE id = 1").run();
    const h = await health();
    expect(pick(h, "schema").status).toBe("fail");
    expect(h.ok).toBe(false);
    expect(h.summary.fail).toBe(1);
  });

  it("缺索引时 warn 并列出名字", async () => {
    env.db.exec("DROP INDEX ix_audit_ts");
    const h = await health();
    expect(pick(h, "indexes").status).toBe("warn");
    expect(pick(h, "indexes").data?.missing).toContain("ix_audit_ts");
    expect(h.ok).toBe(true); // warn 不影响 ok
  });

  it("条目状态取值异常时 warn", async () => {
    const e = mem();
    insertMemory(env, e);
    env.db.prepare("UPDATE fact SET status = 'weird' WHERE id = ?").run(e.id);
    const h = await health();
    expect(pick(h, "status-values").status).toBe("warn");
    expect(pick(h, "status-values").data?.bad).toEqual({ fact: 1 });
  });

  it("recall_log 指向已删条目时报孤儿", async () => {
    env.db.prepare("INSERT INTO recall_log (ts, memory_id, session_id, turn) VALUES (?, ?, ?, ?)").run(TS, "gone", "s1", 1);
    const h = await health();
    expect(pick(h, "orphans").status).toBe("warn");
    expect(pick(h, "orphans").data?.recall_log).toBe(1);
  });

  it("L0 有超过保留期的残留时 warn", async () => {
    l0({ retainedUntil: TS - 1000 });
    const h = await health();
    expect(pick(h, "retention").status).toBe("warn");
    expect(pick(h, "retention").data?.l0Expired).toBe(1);
  });

  it("审计日志超过 auditKeepDays 未清理时 warn", async () => {
    addAudit(env, { actor: "human", action: "memory.write", target: "x" });
    env.db.prepare("UPDATE audit_log SET ts = ?").run(TS - 40 * 86400000);
    config.governance.auditKeepDays = 30;
    const h = await health();
    expect(pick(h, "retention").status).toBe("warn");
    expect(pick(h, "retention").data?.auditOverdue).toBe(1);
  });

  it("向量任务失败或长期滞留时 warn", async () => {
    // 可选向量后端装了就会建这张表（之后后端能真正加载），用 IF NOT EXISTS 保持用例与机器无关
    env.db.exec(
      "CREATE TABLE IF NOT EXISTS embedding_jobs (id TEXT PRIMARY KEY, memory_id TEXT NOT NULL, level TEXT NOT NULL, content TEXT NOT NULL," +
        " status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL, processed_at INTEGER, error TEXT," +
        " retries INTEGER NOT NULL DEFAULT 0)",
    );
    env.db
      .prepare("INSERT INTO embedding_jobs (id, memory_id, level, content, status, created_at, error, retries) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run("j1", "m1", "fact", "c", "failed", TS, "boom", 3);
    env.db
      .prepare("INSERT INTO embedding_jobs (id, memory_id, level, content, status, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("j2", "m2", "fact", "c", "pending", TS - 2 * 3600000);
    const h = await health();
    expect(pick(h, "embedding-jobs").status).toBe("warn");
    expect(pick(h, "embedding-jobs").data).toMatchObject({ failed: 1, stalePending: 1 });
  });

  it("预算取值无效时 warn", async () => {
    config.budget.recallMaxItems = 0;
    const h = await health();
    expect(pick(h, "budget").status).toBe("warn");
    expect(pick(h, "budget").data?.bad).toContain("recallMaxItems");
  });

  it("agent 也可以读健康报告（只读接口）", async () => {
    const out = (await invokeRpc(service, "memweave.status/health", {}, "agent")) as HealthOut;
    expect(out.checks.length).toBe(9);
  });
});

describe("status/queues", () => {
  it("汇总 L0 / 候选 / 待归纳 / 向量四个队列", async () => {
    l0({ sessionId: "s1", seq: 1 });
    l0({ sessionId: "s1", seq: 2, ts: TS - 2 * 86400000 });
    l0({ sessionId: "s2", seq: 1 });
    l0({ sessionId: "s2", seq: 2, retainedUntil: TS - 1 });

    insertCandidate(env, {
      id: "c1",
      level: "fact",
      project: null,
      content: "候选一",
      keywords: [],
      importance: 3,
      semanticKey: null,
      evidence: [],
      tier: "hot",
      verdict: "pending",
      risk: "low",
      reason: null,
      mergedInto: null,
      createdAt: TS - 5000,
      decidedAt: null,
      decidedBy: null,
    });
    insertCandidate(env, {
      id: "c2",
      level: "user",
      project: null,
      content: "候选二",
      keywords: [],
      importance: 3,
      semanticKey: null,
      evidence: [],
      tier: "hot",
      verdict: "accepted",
      risk: null,
      reason: null,
      mergedInto: null,
      createdAt: TS,
      decidedAt: TS,
      decidedBy: "human",
    });
    insertDistillGroup(env, { id: "g1", memberIds: ["a", "b"], reason: "相似", createdAt: TS, status: "open" });
    insertDistillGroup(env, { id: "g2", memberIds: ["c"], reason: null, createdAt: TS, status: "done" });

    const q = (await invokeRpc(service, "memweave.status/queues", {}, "human")) as {
      l0: { total: number; sessions: number; last24h: number; expired: number };
      candidates: { pending: number; byLevel: Record<string, number>; oldestTs: number | null };
      distill: Record<string, number>;
      embedding: { enabled: boolean; pending: number };
    };

    expect(q.l0).toMatchObject({ total: 4, sessions: 2, last24h: 3, expired: 1 });
    expect(q.candidates.pending).toBe(1);
    expect(q.candidates.byLevel).toEqual({ fact: 1 });
    expect(q.candidates.oldestTs).toBe(TS - 5000);
    expect(q.distill).toMatchObject({ open: 1, done: 1 });
    // enabled 只表示队列表是否已建：装了可选向量后端就会建表，所以与机器无关地比对真实 schema 状态
    const jobsTable = env.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'embedding_jobs'")
      .get();
    expect(q.embedding.enabled).toBe(!!jobsTable);
    expect(q.embedding).toMatchObject({ pending: 0, processing: 0, done: 0, failed: 0 });
  });

  it("带 detailLimit 时返回候选预览、归纳成员数与失败任务", async () => {
    insertCandidate(env, {
      id: "c1",
      level: "fact",
      project: null,
      content: "甲".repeat(120),
      keywords: [],
      importance: 3,
      semanticKey: null,
      evidence: [],
      tier: "hot",
      verdict: "pending",
      risk: "high",
      reason: null,
      mergedInto: null,
      createdAt: TS,
      decidedAt: null,
      decidedBy: null,
    });
    insertDistillGroup(env, { id: "g1", memberIds: ["a", "b", "c"], reason: "r", createdAt: TS, status: "open" });

    const q = (await invokeRpc(service, "memweave.status/queues", { detailLimit: 5 }, "human")) as {
      detail: {
        candidates: Array<{ id: string; preview: string; risk: string | null }>;
        distill: Array<{ id: string; members: number }>;
        failedJobs: unknown[];
      };
    };
    expect(q.detail.candidates[0].preview).toHaveLength(81); // 80 字 + 省略号
    expect(q.detail.candidates[0].preview.endsWith("…")).toBe(true);
    expect(q.detail.candidates[0].risk).toBe("high");
    expect(q.detail.distill[0].members).toBe(3);
    expect(q.detail.failedJobs).toEqual([]);
  });

  it("没有 detailLimit 时不返回 detail", async () => {
    const q = (await invokeRpc(service, "memweave.status/queues", {}, "human")) as { detail?: unknown };
    expect(q.detail).toBeUndefined();
  });
});

describe("memory/detail", () => {
  it("串起来源、证据原文、审计、召回、关联与相关条目", async () => {
    const l0id = l0({ sessionId: "s9", seq: 3, content: "原始消息：我们用 SQLite" });
    const e = mem({
      semanticKey: "tech:db",
      evidence: [{ sessionId: "s9", seq: 3, quote: "我们用 SQLite" }],
    });
    insertMemory(env, e);
    addAudit(env, { actor: "agent", action: "memory.write", target: e.id, reason: "candidate-accepted:c9" });

    // 同 semanticKey 的另一条
    const sibling = mem({ semanticKey: "tech:db", content: "数据库是 SQLite" });
    insertMemory(env, sibling);
    // 关联边
    insertLink(env, { src: e.id, dst: sibling.id, kind: "same-key", weight: 1, createdAt: TS });
    // 召回记录：2 条近 7 天，1 条更早
    const ins = env.db.prepare("INSERT INTO recall_log (ts, memory_id, session_id, turn) VALUES (?, ?, ?, ?)");
    ins.run(TS, e.id, "s9", 1);
    ins.run(TS - 1000, e.id, "s9", 2);
    ins.run(TS - 10 * 86400000, e.id, "s8", 1);

    const d = (await invokeRpc(service, "memweave.memory/detail", { id: e.id }, "human")) as {
      ok: boolean;
      entry: MemoryEntry;
      origin: { action: string | null; actor: string | null; candidateId: string | null };
      evidence: Array<{ l0: { id: string; role: string } | null; quote: string }>;
      recall: { total: number; last7d: number; sessions: number };
      links: Array<{ dst: string }>;
      sameKey: Array<{ id: string }>;
    };

    expect(d.ok).toBe(true);
    expect(d.entry.id).toBe(e.id);
    expect(d.origin).toMatchObject({ action: "memory.write", actor: "agent", candidateId: "c9" });
    expect(d.evidence[0].quote).toBe("我们用 SQLite");
    expect(d.evidence[0].l0?.id).toBe(l0id);
    expect(d.recall).toMatchObject({ total: 3, last7d: 2, sessions: 2 });
    expect(d.links.map((l) => l.dst)).toEqual([sibling.id]);
    expect(d.sameKey.map((s) => s.id)).toEqual([sibling.id]);
  });

  it("归纳落地的条目能追到组与成员", async () => {
    const e = mem({ level: "project", project: "p", content: "项目摘要" });
    insertMemory(env, e);
    addAudit(env, {
      actor: "agent",
      action: "distill.land",
      target: e.id,
      after: JSON.stringify({ group: "g7", members: ["a", "b"] }),
    });
    const d = (await invokeRpc(service, "memweave.memory/detail", { id: e.id }, "human")) as {
      origin: { action: string | null; distillGroupId: string | null; distillMembers: string[] };
    };
    expect(d.origin.action).toBe("distill.land");
    expect(d.origin.distillGroupId).toBe("g7");
    expect(d.origin.distillMembers).toEqual(["a", "b"]);
  });

  it("审计历史里的长数字串被脱敏", async () => {
    const e = mem();
    insertMemory(env, e);
    addAudit(env, { actor: "human", action: "memory.revise", target: e.id, before: "13800138000", after: "13800138001" });
    const d = (await invokeRpc(service, "memweave.memory/detail", { id: e.id }, "human")) as {
      history: Array<{ before: string | null; after: string | null }>;
    };
    expect(d.history[0].before).toBe("13**00");
    expect(d.history[0].after).toBe("13**01");
  });

  it("条目不存在时返回 E_VALID", async () => {
    const d = await invokeRpc(service, "memweave.memory/detail", { id: "nope" }, "human");
    expect(d).toMatchObject({ ok: false, code: "E_VALID" });
  });

  it("按命中原因聚合召回记录，旧记录归 unknown", async () => {
    const e = mem();
    insertMemory(env, e);
    const ins = env.db.prepare("INSERT INTO recall_log (ts, memory_id, session_id, turn, reason) VALUES (?, ?, ?, ?, ?)");
    ins.run(TS - 3000, e.id, "s1", 1, "keyword+link");
    ins.run(TS - 2000, e.id, "s1", 2, "keyword");
    ins.run(TS - 1000, e.id, "s2", 1, "keyword+link");
    // v14 之前写入的记录没有 reason
    env.db.prepare("INSERT INTO recall_log (ts, memory_id, session_id, turn) VALUES (?, ?, ?, ?)").run(TS - 4000, e.id, "s3", 1);

    const d = (await invokeRpc(service, "memweave.memory/detail", { id: e.id }, "human")) as {
      recall: { reasons: Array<{ reason: string; count: number }>; lastReason: string | null };
    };
    expect(d.recall.lastReason).toBe("keyword+link");
    expect(d.recall.reasons).toEqual([
      { reason: "keyword+link", count: 2 },
      { reason: "keyword", count: 1 },
      { reason: "unknown", count: 1 },
    ]);
  });
});

describe("inject/state", () => {
  it("renderTurn 写命中原因与注入延迟，接口可读回", async () => {
    await service.remember({ level: "fact", content: "注入延迟样本：橙色雨伞" }, "human");
    service.renderTurn({ sessionId: "lat", first: false, query: "橙色雨伞", baseline: new Map(), turn: 3 });

    const out = (await invokeRpc(service, "memweave.inject/state", { sessionId: "lat" }, "human")) as {
      state: {
        sessionId: string;
        injectMs: number;
        recallMs: number;
        injectAt: number | null;
        injectTurn: number;
        injectChars: number;
        injectItems: number;
        injected: boolean;
      } | null;
    };
    expect(out.state).not.toBeNull();
    expect(out.state).toMatchObject({ sessionId: "lat", injectTurn: 3, injected: true });
    expect(out.state!.injectAt).toBeGreaterThan(0);
    expect(out.state!.injectMs).toBeGreaterThanOrEqual(0);
    expect(out.state!.recallMs).toBeGreaterThanOrEqual(0);
    expect(out.state!.injectChars).toBeGreaterThan(0);
    expect(out.state!.injectItems).toBeGreaterThan(0);

    const rows = env.db.prepare("SELECT reason FROM recall_log WHERE session_id = 'lat'").all() as Array<{ reason: string | null }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => typeof r.reason === "string" && r.reason.length > 0)).toBe(true);
    expect(rows.map((r) => String(r.reason)).join(",")).toContain("keyword");
  });

  it("暂停时仍记延迟，但 injected=false", async () => {
    await service.remember({ level: "fact", content: "暂停注入样本：灰色背包" }, "human");
    service.paused = true;
    try {
      service.renderTurn({ sessionId: "paused", first: false, query: "灰色背包", baseline: new Map(), turn: 1 });
    } finally {
      service.paused = false;
    }
    const out = (await invokeRpc(service, "memweave.inject/state", { sessionId: "paused" }, "human")) as {
      state: { injected: boolean; injectMs: number } | null;
    };
    expect(out.state).toMatchObject({ injected: false });
    expect(out.state!.injectMs).toBeGreaterThanOrEqual(0);
  });

  it("没有注入记录的会话返回 state=null", async () => {
    const out = (await invokeRpc(service, "memweave.inject/state", { sessionId: "nope" }, "human")) as { state: unknown };
    expect(out.state).toBeNull();
  });

  it("agent 可读（只读接口不要求 human）", async () => {
    const e = mem();
    insertMemory(env, e);
    const d = (await invokeRpc(service, "memweave.memory/detail", { id: e.id }, "agent")) as { ok: boolean };
    expect(d.ok).toBe(true);
  });
});
