/**
 * 忆织 MemWeave —— roadmap v0.4 阶段 C：dream 新增各轮（§5）。
 * R13 关联网体检 / R8 重播强化 / R6 升级降级 / G4 询问归档 / G3 蒸馏阶梯 / D5 候选上限。
 * 每个函数：写审计、写撤销台账、不抛给调用方以外的轮次（dream.ts 逐轮 try/catch）。
 * 纯 SQLite、零依赖；同样输入同样结果（排序全部带 id 兜底）。
 */

import { extractKeywords, identityAliasGroups } from "../core/tokenize";
import type { Level, MemoryEntry } from "../core/types";
import type { WeaveEnv } from "./db";
import {
  addAudit,
  appendUndo,
  getMemory,
  getPersona,
  insertCandidate,
  insertMemory,
  listMemory,
  newId,
  reviseMemory,
  setBoost,
  type CandidateRow,
} from "./dao";
import { jaccard, termSet } from "./link";
import { LAYER_TABLES } from "./schema";
import { contentHash } from "../core/hash";
import { overduePromises, PROMISE_DUE_REASON, promiseLabelOf, type PromiseConfig } from "../core/promise";
import { formatLocalDate } from "../core/localdate";

const DAY_MS = 86400000;

// ---------- 配置 ----------

export interface CoRecallConfig {
  enabled: boolean;
  step: number;
  cap: number;
  initial: number;
  windowDays: number;
  maxPairs: number;
  decayDays: number;
  decayFactor: number;
  minWeight: number;
}
export const DEFAULT_CORECALL: CoRecallConfig = {
  enabled: true,
  step: 0.1,
  cap: 2.0,
  initial: 0.3,
  windowDays: 7,
  maxPairs: 200,
  decayDays: 90,
  decayFactor: 0.8,
  minWeight: 0.1,
};

export interface BoostConfig {
  enabled: boolean;
  minHits: number;
  minSessions: number;
  windowDays: number;
  decayDays: number;
}
export const DEFAULT_BOOST: BoostConfig = { enabled: true, minHits: 3, minSessions: 2, windowDays: 30, decayDays: 90 };

export interface DistillConfig {
  enabled: boolean;
  topicsPerProject: number;
  crossProjects: number;
  similarity: number;
}
export const DEFAULT_DISTILL: DistillConfig = { enabled: true, topicsPerProject: 5, crossProjects: 3, similarity: 0.5 };

export const DEFAULT_STALE_ASK_DAYS = 7;
export const DEFAULT_MAX_CANDIDATES = 5;

/** 候选 reason（候选页 / decideCandidate 分派用） */
export const ARCHIVE_REASON = "archive-suggest";
export const CORE_REASON = "core-suggest";
export const RULES_REASON = "distill-rules";
export const DISTILLED_SECTION = "distilled";

// ---------- D5 候选名额 ----------

/** 一次 dream 的候选名额；按优先级顺序调用 take() */
export class CandidateBudget {
  used = 0;
  skipped = 0;
  constructor(public readonly max: number) {}
  get left(): number {
    return Math.max(0, this.max - this.used);
  }
  take(): boolean {
    if (this.used >= this.max) {
      this.skipped += 1;
      return false;
    }
    this.used += 1;
    return true;
  }
}

export function hasCandidate(env: WeaveEnv, key: string, verdict?: string, since?: number): boolean {
  const r = env.db
    .prepare(
      "SELECT COUNT(*) AS n FROM candidates WHERE semantic_key = ?" +
        (verdict ? " AND verdict = ?" : "") +
        (since !== undefined ? " AND created_at >= ?" : ""),
    )
    .get(key, ...(verdict ? [verdict] : []), ...(since !== undefined ? [since] : [])) as { n?: number } | undefined;
  return Number(r?.n ?? 0) > 0;
}

export function baseCandidate(p: Partial<CandidateRow> & Pick<CandidateRow, "level" | "content" | "semanticKey" | "reason">, now: number): CandidateRow {
  return {
    id: newId(),
    project: null,
    keywords: [],
    importance: 3,
    evidence: [],
    tier: "hot",
    verdict: "pending",
    risk: "L2",
    mergedInto: null,
    createdAt: now,
    decidedAt: null,
    decidedBy: null,
    ...p,
  };
}

// ---------- R13 关联网体检 ----------

export interface LinkHealthReport {
  selfLoop: number;
  dangling: number;
  dup: number;
  keywords: number;
}

function allIds(env: WeaveEnv): Set<string> {
  const out = new Set<string>();
  for (const table of Object.values(LAYER_TABLES)) {
    for (const r of env.db.prepare("SELECT id FROM " + table).all() as Array<{ id: string }>) out.add(String(r.id));
  }
  return out;
}

type LinkRow = { src: string; dst: string; kind: string; weight: number; created_at: number };

/**
 * 删自环、删悬空（一端已不存在；已归档的保留）、无向重复边去重（保留权重大的）、活跃条目补关键词。
 * 删掉的边与补的关键词都进撤销台账。
 */
export function linkHealth(env: WeaveEnv, actor: string, now: number = Date.now()): LinkHealthReport {
  const rows = env.db.prepare("SELECT src, dst, kind, weight, created_at FROM links").all() as LinkRow[];
  const ids = allIds(env);
  const removed: LinkRow[] = [];
  const rep: LinkHealthReport = { selfLoop: 0, dangling: 0, dup: 0, keywords: 0 };
  const best = new Map<string, LinkRow>();
  for (const r of rows) {
    if (r.src === r.dst) {
      rep.selfLoop += 1;
      removed.push(r);
      continue;
    }
    if (!ids.has(r.src) || !ids.has(r.dst)) {
      rep.dangling += 1;
      removed.push(r);
      continue;
    }
    // 无向：同一对 + 同 kind 只留一条（(a,b) 与 (b,a) 视为重复）
    const [a, b] = r.src < r.dst ? [r.src, r.dst] : [r.dst, r.src];
    const key = a + "\u0000" + b + "\u0000" + r.kind;
    const cur = best.get(key);
    if (!cur) {
      best.set(key, r);
      continue;
    }
    rep.dup += 1;
    const loser = Number(r.weight) > Number(cur.weight) ? cur : r;
    if (loser === cur) best.set(key, r);
    removed.push(loser);
  }
  const del = env.db.prepare("DELETE FROM links WHERE src = ? AND dst = ? AND kind = ?");
  for (const r of removed) del.run(r.src, r.dst, r.kind);

  const fixedKw: Array<{ id: string; before: string[] }> = [];
  for (const e of listMemory(env, { status: "active" })) {
    if (e.keywords.length > 0) continue;
    const kw = extractKeywords(e.content);
    if (kw.length === 0) continue;
    env.db.prepare("UPDATE " + LAYER_TABLES[e.level] + " SET keywords = ? WHERE id = ?").run(JSON.stringify(kw), e.id);
    fixedKw.push({ id: e.id, before: [] });
    rep.keywords += 1;
  }
  if (removed.length > 0 || fixedKw.length > 0) {
    appendUndo(env, { actor, action: "dream.links", target: "links", payload: { removed, keywords: fixedKw }, now });
    addAudit(env, { actor, action: "dream.links", target: "links", after: JSON.stringify(rep) });
  }
  return rep;
}

// ---------- R8 重播强化 ----------

export interface CoRecallReport {
  pairs: number;
  reinforced: number;
  created: number;
  decayed: number;
  removed: number;
}

/** 上次 R8 处理到的 recall_log 时间（记在 audit 里，避免同一批共激活被重复加权） */
function coRecallWatermark(env: WeaveEnv): number {
  const r = env.db
    .prepare("SELECT after FROM audit_log WHERE action = 'dream.co-recall' ORDER BY ts DESC, id DESC LIMIT 1")
    .get() as { after?: string } | undefined;
  try {
    return Number((JSON.parse(r?.after ?? "{}") as { until?: number }).until ?? 0);
  } catch {
    return 0;
  }
}

export function reinforceCoRecall(env: WeaveEnv, cfg: CoRecallConfig, actor: string, now: number = Date.now()): CoRecallReport {
  const rep: CoRecallReport = { pairs: 0, reinforced: 0, created: 0, decayed: 0, removed: 0 };
  if (!cfg.enabled) return rep;
  const since = Math.max(coRecallWatermark(env), now - cfg.windowDays * DAY_MS);
  const rows = env.db
    .prepare("SELECT session_id, turn, memory_id FROM recall_log WHERE ts > ? AND ts <= ? ORDER BY session_id, turn, memory_id")
    .all(since, now) as Array<{ session_id: string; turn: number; memory_id: string }>;
  const groups = new Map<string, string[]>();
  for (const r of rows) {
    const k = String(r.session_id) + "#" + String(r.turn);
    const list = groups.get(k) ?? [];
    if (!list.includes(String(r.memory_id))) list.push(String(r.memory_id));
    groups.set(k, list);
  }
  const pairCount = new Map<string, number>();
  for (const ids of groups.values()) {
    const s = [...ids].sort();
    for (let i = 0; i < s.length; i += 1) {
      for (let j = i + 1; j < s.length; j += 1) {
        const k = s[i] + "\u0000" + s[j];
        pairCount.set(k, (pairCount.get(k) ?? 0) + 1);
      }
    }
  }
  const active = new Map(listMemory(env, { status: "active" }).map((e) => [e.id, e]));
  const weightOf = (e: MemoryEntry): number => e.importance * (1 + (e.boost ?? 0));
  const pairs = [...pairCount.entries()]
    .map(([k, n]) => {
      const [a, b] = k.split("\u0000");
      return { a, b, n };
    })
    .filter((p) => active.has(p.a) && active.has(p.b))
    .map((p) => ({ ...p, w: weightOf(active.get(p.a)!) * weightOf(active.get(p.b)!) }))
    .sort((x, y) => y.w - x.w || y.n - x.n || (x.a + x.b < y.a + y.b ? -1 : 1))
    .slice(0, cfg.maxPairs);
  rep.pairs = pairs.length;

  const before: Array<{ src: string; dst: string; weight: number | null; createdAt: number | null }> = [];
  const get = env.db.prepare("SELECT weight, created_at FROM links WHERE src = ? AND dst = ? AND kind = 'co-recall'");
  const upsert = env.db.prepare(
    "INSERT INTO links (src, dst, kind, weight, created_at) VALUES (?, ?, 'co-recall', ?, ?)" +
      " ON CONFLICT(src, dst, kind) DO UPDATE SET weight = excluded.weight, created_at = excluded.created_at",
  );
  for (const p of pairs) {
    const cur = get.get(p.a, p.b) as { weight?: number; created_at?: number } | undefined;
    const w0 = cur ? Number(cur.weight ?? cfg.initial) : null;
    const next = Math.min(cfg.cap, (w0 ?? cfg.initial - cfg.step) + cfg.step * p.n);
    before.push({ src: p.a, dst: p.b, weight: w0, createdAt: cur ? Number(cur.created_at ?? 0) : null });
    upsert.run(p.a, p.b, Math.round(next * 1000) / 1000, now);
    if (cur) rep.reinforced += 1;
    else rep.created += 1;
  }

  // 长期没被强化的 co-recall 边衰减；衰减后刷新时间，同一条每 decayDays 最多衰减一次
  const stale = env.db
    .prepare("SELECT src, dst, weight, created_at FROM links WHERE kind = 'co-recall' AND created_at < ?")
    .all(now - cfg.decayDays * DAY_MS) as Array<{ src: string; dst: string; weight: number; created_at: number }>;
  const decayed: typeof before = [];
  for (const l of stale) {
    const w = Number(l.weight) * cfg.decayFactor;
    decayed.push({ src: l.src, dst: l.dst, weight: Number(l.weight), createdAt: Number(l.created_at) });
    if (w < cfg.minWeight) {
      env.db.prepare("DELETE FROM links WHERE src = ? AND dst = ? AND kind = 'co-recall'").run(l.src, l.dst);
      rep.removed += 1;
    } else {
      env.db.prepare("UPDATE links SET weight = ?, created_at = ? WHERE src = ? AND dst = ? AND kind = 'co-recall'").run(Math.round(w * 1000) / 1000, now, l.src, l.dst);
      rep.decayed += 1;
    }
  }
  if (before.length > 0 || decayed.length > 0) {
    appendUndo(env, { actor, action: "dream.co-recall", target: "links", payload: { before: [...before, ...decayed] }, now });
  }
  // 水位总是推进（即使本次没有共激活），下次只看新记录
  addAudit(env, { actor, action: "dream.co-recall", target: "links", after: JSON.stringify({ ...rep, until: now }) });
  return rep;
}

// ---------- R6 升级 / 降级 ----------

export interface BoostReport {
  up: string[];
  down: string[];
}

function identityTerms(env: WeaveEnv): string[] {
  try {
    const p = getPersona(env).config as unknown as Parameters<typeof identityAliasGroups>[0];
    const g = identityAliasGroups(p)[0] ?? [];
    // 「你」「用户」太泛，不当身份词
    return g.filter((t) => t.length >= 2 && t !== "用户");
  } catch {
    return [];
  }
}

export function adjustBoost(env: WeaveEnv, cfg: BoostConfig, actor: string, now: number = Date.now()): BoostReport {
  const rep: BoostReport = { up: [], down: [] };
  if (!cfg.enabled) return rep;
  const hits = new Map<string, { n: number; sessions: number }>();
  for (const r of env.db
    .prepare("SELECT memory_id, COUNT(*) AS n, COUNT(DISTINCT session_id) AS s FROM recall_log WHERE ts >= ? GROUP BY memory_id")
    .all(now - cfg.windowDays * DAY_MS) as Array<{ memory_id: string; n: number; s: number }>) {
    hits.set(String(r.memory_id), { n: Number(r.n), sessions: Number(r.s) });
  }
  const recent = new Set(
    (env.db.prepare("SELECT DISTINCT memory_id FROM recall_log WHERE ts >= ?").all(now - cfg.decayDays * DAY_MS) as Array<{ memory_id: string }>).map((r) =>
      String(r.memory_id),
    ),
  );
  const idTerms = identityTerms(env);
  const changes: Array<{ id: string; level: Level; before: number }> = [];
  for (const e of listMemory(env, { status: "active" })) {
    if (e.level === "rules") continue;
    const b = e.boost ?? 0;
    const h = hits.get(e.id);
    const byUse = !!h && h.n >= cfg.minHits && h.sessions >= cfg.minSessions;
    const byIdentity = !!h && h.n >= 1 && idTerms.some((t) => e.content.includes(t));
    if ((byUse || byIdentity) && b < 3) {
      setBoost(env, e.level, e.id, b + 1);
      changes.push({ id: e.id, level: e.level, before: b });
      rep.up.push(e.id);
    } else if (b > 0 && !recent.has(e.id) && now - e.createdAt >= cfg.decayDays * DAY_MS) {
      setBoost(env, e.level, e.id, b - 1);
      changes.push({ id: e.id, level: e.level, before: b });
      rep.down.push(e.id);
    }
  }
  if (changes.length > 0) {
    appendUndo(env, { actor, action: "dream.boost", target: "boost", payload: { changes }, now });
    addAudit(env, { actor, action: "dream.boost", target: "boost", after: JSON.stringify({ up: rep.up.length, down: rep.down.length }) });
  }
  return rep;
}

/** boost 到 3 的 user/fact、还不是常驻 → 建议设为常驻（每条只问一次） */
export function proposeCore(env: WeaveEnv, budget: CandidateBudget, actor: string, now: number): string[] {
  const out: string[] = [];
  const pool = listMemory(env, { status: "active" })
    .filter((e) => (e.level === "user" || e.level === "fact") && (e.boost ?? 0) >= 3 && e.tier !== "core")
    .sort((a, b) => b.importance - a.importance || (a.id < b.id ? -1 : 1));
  for (const e of pool) {
    const key = CORE_REASON + ":" + e.id;
    if (hasCandidate(env, key)) continue;
    if (!budget.take()) break;
    const c = baseCandidate(
      {
        level: e.level,
        project: e.project,
        content: "建议设为常驻（进每个会话的快照）：" + e.content.slice(0, 160),
        keywords: e.keywords,
        importance: e.importance,
        semanticKey: key,
        reason: CORE_REASON,
        mergedInto: e.id,
      },
      now,
    );
    insertCandidate(env, c);
    addAudit(env, { actor, action: "dream.suggest", target: e.id, after: c.id, reason: CORE_REASON });
    out.push(c.id);
  }
  return out;
}

// ---------- roadmap v0.6 M1 约定到期 ----------

/**
 * 过期超过 graceDays 还是 pending 的约定 → L2 候选「确认约定结果」。
 * 同一条约定、同一个到期日只问一次（延期后到期日变了会再问）。不自动判落空。
 */
export function proposePromiseDue(
  env: WeaveEnv,
  cfg: PromiseConfig,
  timeZone: string,
  budget: CandidateBudget,
  actor: string,
  now: number,
): string[] {
  const out: string[] = [];
  if (!cfg.enabled) return out;
  for (const e of overduePromises(listMemory(env, { status: "active" }), now, timeZone, cfg)) {
    const key = PROMISE_DUE_REASON + ":" + e.id + ":" + e.dueAt;
    if (hasCandidate(env, key)) continue;
    if (!budget.take()) break;
    const c = baseCandidate(
      {
        level: e.level,
        project: e.project,
        content:
          "确认约定结果：" + promiseLabelOf(e) + "（约定日 " + formatLocalDate(e.dueAt!, timeZone, "zh", true) + "）" +
          "\n接受 = 已兑现；拒绝 = 落空；要延期请在记忆里改约定日或让 AI 调 weave_promise extend。",
        keywords: e.keywords,
        importance: e.importance,
        semanticKey: key,
        reason: PROMISE_DUE_REASON,
        mergedInto: e.id,
      },
      now,
    );
    insertCandidate(env, c);
    addAudit(env, { actor, action: "dream.suggest", target: e.id, after: c.id, reason: PROMISE_DUE_REASON });
    out.push(c.id);
  }
  return out;
}

// ---------- G4 询问归档 ----------

export function proposeArchive(env: WeaveEnv, staleDays: number, budget: CandidateBudget, actor: string, now: number): string[] {
  const out: string[] = [];
  const pool = listMemory(env, { status: "stale" })
    .filter((e) => now - e.updatedAt >= staleDays * DAY_MS)
    .sort((a, b) => a.updatedAt - b.updatedAt || (a.id < b.id ? -1 : 1));
  const lastRecall = env.db.prepare("SELECT MAX(ts) AS t FROM recall_log WHERE memory_id = ?");
  for (const e of pool) {
    const key = ARCHIVE_REASON + ":" + e.id;
    // 同一条只问一次；内容改过（updatedAt 晚于上次候选）才再问
    if (hasCandidate(env, key, undefined, e.updatedAt)) continue;
    if (!budget.take()) break;
    const t = (lastRecall.get(e.id) as { t?: number | null } | undefined)?.t ?? null;
    const fmt = (ms: number | null | undefined): string => (ms ? new Date(ms).toISOString().slice(0, 10) : "无");
    const c = baseCandidate(
      {
        level: e.level,
        project: e.project,
        content:
          "建议归档（已过期 " + Math.floor((now - e.updatedAt) / DAY_MS) + " 天）：" + e.content.slice(0, 160) +
          "\n过期时间 " + fmt(e.validTo) + "；最后一次被召回 " + fmt(t),
        keywords: e.keywords,
        importance: e.importance,
        semanticKey: key,
        reason: ARCHIVE_REASON,
        mergedInto: e.id,
      },
      now,
    );
    insertCandidate(env, c);
    addAudit(env, { actor, action: "dream.suggest", target: e.id, after: c.id, reason: ARCHIVE_REASON });
    out.push(c.id);
  }
  return out;
}

// ---------- G3 蒸馏阶梯 ----------

export interface DistillReport {
  summaries: string[];
}

/** 同一 project 下活跃 topic ≥ N → project 层摘要（section=distilled）；topic 不归档 */
export function distillProjects(env: WeaveEnv, cfg: DistillConfig, actor: string, now: number = Date.now()): DistillReport {
  const rep: DistillReport = { summaries: [] };
  if (!cfg.enabled) return rep;
  const byProject = new Map<string, MemoryEntry[]>();
  for (const t of listMemory(env, { level: "topic", status: "active" })) {
    if (!t.project) continue;
    const list = byProject.get(t.project) ?? [];
    list.push(t);
    byProject.set(t.project, list);
  }
  const existing = listMemory(env, { level: "project", status: "active" }).filter((e) => e.section === DISTILLED_SECTION);
  for (const [project, topics] of [...byProject.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (topics.length < cfg.topicsPerProject) continue;
    const sorted = [...topics].sort((a, b) => (a.id < b.id ? -1 : 1));
    const firstLine = (s: string): string => {
      const line = s.split(/\n|。|！|？/)[0].trim();
      return line.length > 60 ? line.slice(0, 60) + "…" : line;
    };
    const content = (
      "项目「" + project + "」主题索引（" + sorted.length + " 条）：\n" + sorted.map((t) => "- [" + t.id + "] " + firstLine(t.content)).join("\n")
    ).slice(0, 1900);
    const prev = existing.find((e) => e.project === project);
    if (prev && prev.content === content) continue;
    let id: string;
    if (prev) {
      reviseMemory(env, prev.id, { content, keywords: extractKeywords(content) }, actor);
      appendUndo(env, { actor, action: "dream.status", target: prev.id, payload: { before: { content: prev.content, keywords: prev.keywords } }, now });
      id = prev.id;
    } else {
      id = newId();
      insertMemory(env, {
        id,
        level: "project",
        project,
        section: DISTILLED_SECTION,
        content,
        keywords: extractKeywords(content),
        importance: 3,
        status: "active",
        semanticKey: null,
        confidence: null,
        validFrom: now,
        validTo: null,
        evidence: [],
        hash: contentHash("distilled:" + project + ":" + id),
        source: actor,
        accessCount: 0,
        tier: "hot",
        createdAt: now,
        updatedAt: now,
      });
      appendUndo(env, { actor, action: "memory.write", target: id, payload: { id }, now });
    }
    const link = env.db.prepare(
      "INSERT INTO links (src, dst, kind, weight, created_at) VALUES (?, ?, 'merged', 1, ?) ON CONFLICT(src, dst, kind) DO NOTHING",
    );
    for (const t of sorted) link.run(id, t.id, now);
    addAudit(env, { actor, action: "dream.distill", target: id, after: JSON.stringify({ project, topics: sorted.length }) });
    rep.summaries.push(id);
  }
  return rep;
}

/** 同一条 lesson/fact 的近似内容出现在 ≥ N 个 project → 候选「设为全局准则」 */
export function proposeRules(env: WeaveEnv, cfg: DistillConfig, budget: CandidateBudget, actor: string, now: number): string[] {
  const out: string[] = [];
  if (!cfg.enabled) return out;
  const pool = listMemory(env, { status: "active" })
    .filter((e) => (e.level === "lesson" || e.level === "fact") && !!e.project)
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .slice(0, 600);
  const terms = pool.map((e) => termSet(e));
  const parent = pool.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < pool.length; i += 1) {
    for (let j = i + 1; j < pool.length; j += 1) {
      if (pool[i].project === pool[j].project) continue;
      if (jaccard(terms[i], terms[j]) >= cfg.similarity) parent[find(j)] = find(i);
    }
  }
  const groups = new Map<number, MemoryEntry[]>();
  pool.forEach((e, i) => {
    const r = find(i);
    groups.set(r, [...(groups.get(r) ?? []), e]);
  });
  const rules = listMemory(env, { level: "rules", status: "active" }).map((r) => termSet(r));
  const clusters = [...groups.values()]
    .filter((g) => new Set(g.map((e) => e.project)).size >= cfg.crossProjects)
    .map((g) => [...g].sort((a, b) => b.importance - a.importance || (a.id < b.id ? -1 : 1)))
    .sort((a, b) => b.length - a.length || (a[0].id < b[0].id ? -1 : 1));
  for (const g of clusters) {
    const head = g[0];
    const ids = g.map((e) => e.id).sort();
    const key = RULES_REASON + ":" + ids[0];
    if (hasCandidate(env, key)) continue;
    if (rules.some((r) => jaccard(r, termSet(head)) >= cfg.similarity)) continue;
    if (!budget.take()) break;
    const projects = [...new Set(g.map((e) => e.project))].sort();
    const c = baseCandidate(
      {
        level: "rules",
        // 候选正文 = 将来写进 rules 的文字；来源项目与条目 id 记在审计里
        content: head.content,
        keywords: head.keywords,
        importance: Math.max(...g.map((e) => e.importance)),
        semanticKey: key,
        reason: RULES_REASON,
        tier: "core",
      },
      now,
    );
    insertCandidate(env, c);
    addAudit(env, {
      actor,
      action: "dream.suggest",
      target: ids[0],
      after: c.id,
      reason: RULES_REASON + " projects=" + projects.join(",") + " ids=" + ids.slice(0, 20).join(","),
    });
    out.push(c.id);
  }
  return out;
}

// ---------- 撤销 ----------

/** dream.links / dream.co-recall / dream.boost 的逆操作 */
export function undoDreamC(env: WeaveEnv, action: string, payload: Record<string, unknown>): boolean {
  if (action === "dream.links") {
    const ins = env.db.prepare(
      "INSERT INTO links (src, dst, kind, weight, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(src, dst, kind) DO NOTHING",
    );
    for (const r of (payload.removed as LinkRow[] | undefined) ?? []) ins.run(r.src, r.dst, r.kind, r.weight, r.created_at);
    for (const k of (payload.keywords as Array<{ id: string; before: string[] }> | undefined) ?? []) {
      const e = getMemory(env, k.id);
      if (e) env.db.prepare("UPDATE " + LAYER_TABLES[e.level] + " SET keywords = ? WHERE id = ?").run(JSON.stringify(k.before), e.id);
    }
    return true;
  }
  if (action === "dream.co-recall") {
    const list = (payload.before as Array<{ src: string; dst: string; weight: number | null; createdAt: number | null }> | undefined) ?? [];
    // 逆序还原：同一条边先衰减后强化时，最早的现场最后写回
    for (const b of [...list].reverse()) {
      if (b.weight === null) {
        env.db.prepare("DELETE FROM links WHERE src = ? AND dst = ? AND kind = 'co-recall'").run(b.src, b.dst);
      } else {
        env.db
          .prepare(
            "INSERT INTO links (src, dst, kind, weight, created_at) VALUES (?, ?, 'co-recall', ?, ?)" +
              " ON CONFLICT(src, dst, kind) DO UPDATE SET weight = excluded.weight, created_at = excluded.created_at",
          )
          .run(b.src, b.dst, b.weight, b.createdAt ?? 0);
      }
    }
    return true;
  }
  if (action === "dream.boost") {
    for (const c of (payload.changes as Array<{ id: string; level: Level; before: number }> | undefined) ?? []) {
      setBoost(env, c.level, c.id, c.before);
    }
    return true;
  }
  return false;
}
