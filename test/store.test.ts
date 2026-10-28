/**
 * store 层测试：schema / 迁移只加列 / DAO / CAS（临时目录建库）
 */
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openWeaveDb, type WeaveEnv } from "../src/store/db";
import { ensureSchema } from "../src/store/migrate";
import { LAYER_TABLES, SCHEMA_VERSION } from "../src/store/schema";
import {
  addAudit,
  addLedger,
  archiveMemory,
  bumpAccess,
  countByLevel,
  decideCandidate,
  defaultPersona,
  findActiveByHash,
  findConflictingSemanticKey,
  forgetMemory,
  getInjectState,
  getLedger,
  getMemory,
  getPersona,
  getLinks,
  insertCandidate,
  insertConflict,
  insertLink,
  insertMemory,
  listCandidates,
  listConflicts,
  listMemory,
  listRecentByLevel,
  newId,
  queryAudit,
  resolveConflict,
  restoreMemory,
  reviseMemory,
  updatePersona,
  upsertInjectState,
  computeDelta,
  type CandidateRow,
  type ConflictRow,
} from "../src/store/dao";
import { contentHash } from "../src/core/hash";
import type { DeltaChange, MemoryEntry } from "../src/core/types";

let dir: string;
let env: WeaveEnv;

function entry(p: Partial<MemoryEntry> & { level: MemoryEntry["level"]; content: string }): MemoryEntry {
  const ts = Date.now();
  return {
    id: p.id ?? newId(),
    level: p.level,
    project: p.project ?? null,
    section: p.section ?? null,
    content: p.content,
    keywords: p.keywords ?? [],
    importance: p.importance ?? 3,
    status: p.status ?? "active",
    semanticKey: p.semanticKey ?? null,
    confidence: p.confidence ?? null,
    validFrom: p.validFrom ?? ts,
    validTo: p.validTo ?? null,
    evidence: p.evidence ?? [],
    hash: p.hash ?? contentHash(p.content),
    source: p.source ?? "test",
    accessCount: p.accessCount ?? 0,
    tier: p.tier ?? "hot",
    createdAt: p.createdAt ?? ts,
    updatedAt: p.updatedAt ?? ts,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memweave-store-"));
  env = openWeaveDb(dir);
  ensureSchema(env);
});

afterEach(() => {
  env.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("schema / openWeaveDb", () => {
  it("建库落在 <dataDir>/memweave.db 且 WAL 生效", () => {
    expect(existsSync(join(dir, "memweave.db"))).toBe(true);
    const mode = env.db.prepare("PRAGMA journal_mode").get() as { journal_mode?: string };
    expect(String(mode.journal_mode).toLowerCase()).toBe("wal");
  });

  it("SCHEMA_SQL 建齐全部表 + 索引，schema_version = SCHEMA_VERSION", () => {
    const names = new Set(
      (env.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
        .map((r) => r.name),
    );
    for (const t of ["persona", "persona_history", "persona_presets", "persona_cards"]) {
      expect(names.has(t)).toBe(true);
    }
    for (const t of Object.values(LAYER_TABLES)) expect(names.has(t)).toBe(true);
    for (const t of ["candidates", "conflicts", "links", "audit_log", "inject_state", "budget_ledger", "session_fts", "schema_version"]) {
      expect(names.has(t)).toBe(true);
    }
    const v = env.db.prepare("SELECT version FROM schema_version WHERE id = 1").get() as { version: number };
    expect(v.version).toBe(SCHEMA_VERSION);
    const ix = (env.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>).map(
      (r) => r.name,
    );
    expect(ix.some((n) => n.startsWith("ix_fact_"))).toBe(true);
  });

  it("迁移 v1 candidates 表只加 patch 列并保留旧候选", () => {
    insertCandidate(env, {
      id: "legacy-candidate",
      level: "fact",
      project: null,
      content: "旧候选内容",
      keywords: [],
      importance: 3,
      semanticKey: null,
      evidence: [],
      tier: "hot",
      verdict: "pending",
      risk: null,
      reason: null,
      mergedInto: null,
      createdAt: Date.now(),
      decidedAt: null,
      decidedBy: null,
    });
    env.db.exec("ALTER TABLE candidates DROP COLUMN patch");
    env.db.prepare("UPDATE schema_version SET version = 1 WHERE id = 1").run();
    ensureSchema(env);
    const cols = (env.db.prepare("PRAGMA table_info(candidates)").all() as Array<{ name: string }>).map((r) => r.name);
    expect(cols).toContain("patch");
    expect(listCandidates(env)[0].content).toBe("旧候选内容");
  });
  it("ensureSchema 幂等：重复执行不报错", () => {
    expect(() => ensureSchema(env)).not.toThrow();
    expect(() => ensureSchema(env)).not.toThrow();
  });

  it("迁移只加列：删列后重跑 ensureSchema 补回列且不丢数据", () => {
    insertMemory(env, entry({ level: "fact", content: "主人偏好像素风" }));
    env.db.exec("DROP INDEX ix_fact_semkey");
    env.db.exec("ALTER TABLE fact DROP COLUMN semantic_key");
    ensureSchema(env);
    const cols = (env.db.prepare("PRAGMA table_info(fact)").all() as Array<{ name: string }>).map((r) => r.name);
    expect(cols).toContain("semantic_key");
    const rows = listMemory(env, { level: "fact" });
    expect(rows.length).toBe(1);
    expect(rows[0].content).toBe("主人偏好像素风");
  });
});

describe("persona DAO", () => {
  it("defaultPersona 出厂值", () => {
    const p = defaultPersona();
    expect(p.enabled).toBe(true);
    expect(p.userName).toBe("主人");
    expect(p.selfNamePro).toBe("我");
    expect(p.selfNameFlash).toBe("我");
    expect(p.strict).toBe(false);
    expect(p.applyNextSession).toBe(true);
  });

  it("updatePersona 浅合并保留未知键 + 写 history + 审计 + 版本递增", () => {
    const r1 = updatePersona(env, { stance: "沉稳", customKey: "keep-me" }, "human");
    expect(r1.ok).toBe(true);
    const row = getPersona(env);
    expect(row.version).toBe(r1.version);
    expect(row.config.stance).toBe("沉稳");
    expect((row.config as Record<string, unknown>).customKey).toBe("keep-me");
    const r2 = updatePersona(env, { character: "鲸鱼娘" }, "human");
    const row2 = getPersona(env);
    expect(row2.config.stance).toBe("沉稳");
    expect((row2.config as Record<string, unknown>).customKey).toBe("keep-me");
    expect(row2.config.character).toBe("鲸鱼娘");
    const hist = env.db.prepare("SELECT COUNT(*) AS c FROM persona_history").get() as { c: number };
    expect(Number(hist.c)).toBe(2);
    expect(queryAudit(env, { action: "persona.update" }).length).toBe(2);
    expect(r2.version).toBe((r1.version ?? 0) + 1);
  });

  it("CAS：expectedVersion 不匹配返回 E_CAS 且不落库", () => {
    updatePersona(env, { stance: "a" }, "human");
    const cur = getPersona(env).version;
    const bad = updatePersona(env, { stance: "b" }, "human", cur + 5);
    expect(bad.ok).toBe(false);
    expect(bad.code).toBe("E_CAS");
    expect(getPersona(env).config.stance).toBe("a");
  });
});

describe("七层记忆 DAO", () => {
  it("insert/get/list 按层过滤，排序按层序", () => {
    const a = entry({ level: "fact", content: "A", project: "p1" });
    const b = entry({ level: "soul", content: "B" });
    insertMemory(env, a);
    insertMemory(env, b);
    expect(getMemory(env, a.id)?.content).toBe("A");
    const all = listMemory(env, {});
    expect(all.map((e) => e.level)).toEqual(["soul", "fact"]);
    expect(listMemory(env, { level: "fact" }).length).toBe(1);
    expect(listMemory(env, { project: "p1" }).map((e) => e.id)).toEqual([a.id]);
    expect(listMemory(env, { ids: [b.id] }).map((e) => e.id)).toEqual([b.id]);
  });

  it("revise/archive/restore/forget + CAS", () => {
    const e = entry({ level: "lesson", content: "旧内容" });
    insertMemory(env, e);
    const bad = reviseMemory(env, e.id, { content: "新内容" }, "human", e.updatedAt + 999);
    expect(bad.code).toBe("E_CAS");
    expect(getMemory(env, e.id)?.content).toBe("旧内容");
    const ok = reviseMemory(env, e.id, { content: "新内容" }, "human", e.updatedAt);
    expect(ok.ok).toBe(true);
    expect(getMemory(env, e.id)?.content).toBe("新内容");
    expect(getMemory(env, e.id)?.hash).toBe(contentHash("新内容"));
    expect(findActiveByHash(env, contentHash("新内容"))?.id).toBe(e.id);
    archiveMemory(env, e.id, "human");
    expect(getMemory(env, e.id)?.status).toBe("archived");
    restoreMemory(env, e.id, "human");
    expect(getMemory(env, e.id)?.status).toBe("active");
    forgetMemory(env, e.id, "human");
    expect(getMemory(env, e.id)).toBeNull();
    expect(queryAudit(env, { action: "memory.forget" }).length).toBe(1);
  });

  it("findActiveByHash / listRecentByLevel / bumpAccess / findConflictingSemanticKey", () => {
    const e = entry({ level: "fact", content: "像素风偏好", semanticKey: "pref.style" });
    insertMemory(env, e);
    expect(findActiveByHash(env, contentHash("像素风偏好"))?.id).toBe(e.id);
    expect(listRecentByLevel(env, "fact", 10).length).toBe(1);
    bumpAccess(env, [e.id]);
    expect(getMemory(env, e.id)?.accessCount).toBe(1);
    expect(findConflictingSemanticKey(env, "pref.style").map((x) => x.id)).toEqual([e.id]);
  });

  it("countByLevel / computeDelta 排序与增改档", () => {
    const base = new Map<string, number>();
    const a = entry({ level: "topic", content: "T" });
    insertMemory(env, a);
    const d1 = computeDelta(env, "s", base);
    expect(d1).toHaveLength(1);
    expect(d1[0].kind).toBe("added");
    base.set(a.id, a.updatedAt);
    const d2 = computeDelta(env, "s", base);
    expect(d2).toHaveLength(0);
    reviseMemory(env, a.id, { content: "T2" }, "human");
    const d3 = computeDelta(env, "s", base) as DeltaChange[];
    expect(d3[0].kind).toBe("updated");
    archiveMemory(env, a.id, "human");
    const d4 = computeDelta(env, "s", base);
    expect(d4[0].kind).toBe("archived");
    const counts = countByLevel(env);
    expect(counts.topic).toBe(1);
  });
});

describe("候选 / 冲突 / 审计 / 注入状态 / 账本 / 关联", () => {
  it("insertCandidate + decideCandidate 写审计", () => {
    const c: CandidateRow = {
      id: newId(),
      level: "fact",
      project: null,
      content: "待裁决",
      keywords: [],
      importance: 3,
      semanticKey: null,
      evidence: [],
      tier: "hot",
      verdict: "pending",
      risk: "L2",
      reason: "test",
      mergedInto: null,
      createdAt: Date.now(),
      decidedAt: null,
      decidedBy: null,
    };
    insertCandidate(env, c);
    expect(listCandidates(env, "pending").length).toBe(1);
    const r = decideCandidate(env, c.id, "accepted", "human");
    expect(r.ok).toBe(true);
    expect(listCandidates(env, "accepted").length).toBe(1);
    expect(queryAudit(env, { action: "candidate.decide" }).length).toBe(1);
  });

  it("insertConflict + resolveConflict 归档败者", () => {
    const winner = entry({ level: "fact", content: "winner" });
    const loser = entry({ level: "fact", content: "loser" });
    insertMemory(env, winner);
    insertMemory(env, loser);
    const cf: ConflictRow = {
      id: newId(),
      semanticKey: "pref.style",
      contenders: [
        { id: winner.id, level: "fact", content: winner.content, createdAt: winner.createdAt },
        { id: loser.id, level: "fact", content: loser.content, createdAt: loser.createdAt },
      ],
      winnerId: null,
      status: "open",
      note: null,
      createdAt: Date.now(),
      resolvedAt: null,
    };
    insertConflict(env, cf);
    expect(listConflicts(env, "open").length).toBe(1);
    const r = resolveConflict(env, cf.id, winner.id, "human");
    expect(r.ok).toBe(true);
    expect(getMemory(env, winner.id)?.status).toBe("active");
    expect(getMemory(env, loser.id)?.status).toBe("archived");
    expect(listConflicts(env, "resolved").length).toBe(1);
  });

  it("audit / inject_state / ledger / links 往返", () => {
    addAudit(env, { actor: "human", action: "test.action", target: "x", reason: "r" });
    expect(queryAudit(env, { actor: "human" }).length).toBe(1);
    upsertInjectState(env, { sessionId: "s1", snapshotAt: 1, snapshotHash: "h", pushed: ["a"], frozen: false, charsUsed: 10 });
    upsertInjectState(env, { sessionId: "s1", snapshotAt: 2, snapshotHash: "h2", pushed: ["a", "b"], frozen: true, charsUsed: 20 });
    const st = getInjectState(env, "s1");
    expect(st?.frozen).toBe(true);
    expect(st?.pushed).toEqual(["a", "b"]);
    addLedger(env, { sessionId: "s1", segment: "s2-snapshot", chars: 100, items: 2, trimmed: 0 });
    expect(getLedger(env, "s1").length).toBe(1);
    const a = entry({ level: "fact", content: "a" });
    const b = entry({ level: "fact", content: "b" });
    insertMemory(env, a);
    insertMemory(env, b);
    insertLink(env, { src: a.id, dst: b.id, kind: "relate", weight: 0.5, createdAt: Date.now() });
    expect(getLinks(env, a.id).length).toBe(1);
  });
});
