/**
 * 忆织 MemWeave —— 七层 / 人格 / 治理 DAO（规划文档 §5、§7.1、§10.1）
 * 时间一律 UTC 毫秒整数（D14）。
 */

import { randomUUID } from "node:crypto";
import type { SQLInputValue } from "node:sqlite";
import { contentHash } from "../core/hash";
import {
  LEVEL_ORDER,
  type CalendarAnchor,
  type PromiseState,
  type DeltaChange,
  type EntryStatus,
  type ErrCode,
  type Evidence,
  type Level,
  type Link,
  type MemoryEntry,
  type PersonaConfig,
  type PersonaRow,
  type Tier,
  type Verdict,
} from "../core/types";
import type { WeaveEnv } from "./db";
import { LAYER_TABLES } from "./schema";

// ---------- 行类型（§5.3） ----------

export interface CandidateRow {
  id: string;
  /** persona：拟晋升人格契约的候选（§9-P1 / §7.6），不落七层表 */
  level: Level | "persona";
  project: string | null;
  content: string;
  keywords: string[];
  importance: number;
  semanticKey: string | null;
  evidence: Evidence[];
  tier: Tier;
  verdict: Verdict;
  risk: string | null;
  reason: string | null;
  mergedInto: string | null;
  createdAt: number;
  decidedAt: number | null;
  decidedBy: string | null;
  patch?: Partial<MemoryEntry>;
}

export interface ConflictContender {
  id: string;
  level: Level;
  content: string;
  createdAt: number;
}

export interface ConflictRow {
  id: string;
  semanticKey: string;
  contenders: ConflictContender[];
  winnerId: string | null;
  status: string;
  note: string | null;
  createdAt: number;
  resolvedAt: number | null;
}

export interface AuditRow {
  id: number;
  ts: number;
  actor: string;
  action: string;
  target: string;
  before: string | null;
  after: string | null;
  reason: string | null;
  sessionId: string | null;
}

export interface InjectState {
  sessionId: string;
  snapshotAt: number;
  snapshotHash: string | null;
  pushed: string[];
  frozen: boolean;
  charsUsed: number;
}

export interface LedgerRow {
  id: number;
  ts: number;
  sessionId: string;
  segment: string;
  chars: number;
  items: number;
  trimmed: number;
  detail: string | null;
}

// ---------- 小工具 ----------

type Row = Record<string, unknown>;

const S = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
const SN = (v: unknown): string | null => (v == null ? null : String(v));
const N = (v: unknown): number => (typeof v === "number" ? v : Number(v) || 0);
const NN = (v: unknown): number | null => (v == null ? null : Number(v));
const B = (v: unknown): boolean => v === 1 || v === true || v === "1";

function jget(text: unknown, fallback: unknown): unknown {
  if (typeof text !== "string" || text.length === 0) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

const jarr = (text: unknown): unknown[] => {
  const v = jget(text, []);
  return Array.isArray(v) ? v : [];
};

export function newId(): string {
  return Date.now().toString(36) + "-" + randomUUID().slice(0, 8);
}

const LEVELS = LEVEL_ORDER;

function tableOf(level: Level): string {
  return LAYER_TABLES[level];
}

function rowToEntry(level: Level, r: Row): MemoryEntry {
  return {
    id: S(r.id),
    level,
    project: SN(r.project),
    section: SN(r.section),
    content: S(r.content),
    keywords: jarr(r.keywords).map((x) => String(x)),
    importance: N(r.importance) || 3,
    status: (SN(r.status) ?? "active") as EntryStatus,
    semanticKey: SN(r.semantic_key),
    confidence: NN(r.confidence),
    validFrom: NN(r.valid_from),
    validTo: NN(r.valid_to),
    evidence: jarr(r.evidence) as Evidence[],
    hash: SN(r.hash),
    source: S(r.source),
    accessCount: N(r.access_count),
    tier: (SN(r.tier) ?? "hot") as Tier,
    createdAt: N(r.created_at),
    updatedAt: N(r.updated_at),
    boost: N(r.boost),
    valence: NN(r.valence),
    arousal: NN(r.arousal),
    flash: N(r.flash) === 1,
    dueAt: NN(r.due_at),
    promiseState: (SN(r.promise_state) ?? "none") as PromiseState,
    promiseLabel: SN(r.promise_label),
    calendarAnchor: parseAnchor(r.calendar_anchor),
    searchTerms: parseTerms(r.search_terms),
  };
}

function parseTerms(v: unknown): string[] | null {
  if (typeof v !== "string" || v.length === 0) return null;
  const a = jarr(v).filter((x): x is string => typeof x === "string" && x.length > 0);
  return a.length > 0 ? a : null;
}

function parseAnchor(v: unknown): CalendarAnchor | null {
  if (typeof v !== "string" || v.length === 0) return null;
  try {
    const o = JSON.parse(v) as unknown;
    return o && typeof o === "object" && !Array.isArray(o) && typeof (o as { kind?: unknown }).kind === "string" ? (o as CalendarAnchor) : null;
  } catch {
    return null;
  }
}

function entryParams(e: MemoryEntry): SQLInputValue[] {
  return [
    e.id,
    e.project,
    e.section,
    e.content,
    JSON.stringify(e.keywords ?? []),
    e.importance,
    e.status,
    e.semanticKey,
    e.confidence,
    e.validFrom,
    e.validTo,
    JSON.stringify(e.evidence ?? []),
    e.hash,
    e.source,
    e.accessCount,
    e.tier,
    e.createdAt,
    e.updatedAt,
    e.boost ?? 0,
    e.valence ?? null,
    e.arousal ?? null,
    e.flash ? 1 : 0,
    e.dueAt ?? null,
    e.promiseState ?? "none",
    e.promiseLabel ?? null,
    e.calendarAnchor ? JSON.stringify(e.calendarAnchor) : null,
    e.searchTerms && e.searchTerms.length > 0 ? JSON.stringify(e.searchTerms) : null,
  ];
}

const ENTRY_COLS =
  "id, project, section, content, keywords, importance, status, semantic_key, confidence," +
  " valid_from, valid_to, evidence, hash, source, access_count, tier, created_at, updated_at, boost," +
  " valence, arousal, flash, due_at, promise_state, promise_label, calendar_anchor, search_terms";

/** roadmap v0.7 S1：写 / 清检索词（不改 updated_at：检索词不算内容修改） */
export function setSearchTerms(env: WeaveEnv, level: Level, id: string, terms: string[] | null): void {
  env.db
    .prepare("UPDATE " + tableOf(level) + " SET search_terms = ? WHERE id = ?")
    .run(terms && terms.length > 0 ? JSON.stringify(terms) : null, id);
}

// ---------- roadmap v0.7 S2：待归纳队列 ----------

export type DistillStatus = "open" | "done" | "skipped" | "expired";

export interface DistillGroup {
  id: string;
  memberIds: string[];
  reason: string | null;
  createdAt: number;
  status: DistillStatus;
}

function rowToGroup(r: Row): DistillGroup {
  return {
    id: S(r.id),
    memberIds: jarr(r.member_ids).map((x) => String(x)),
    reason: SN(r.reason),
    createdAt: N(r.created_at),
    status: (SN(r.status) ?? "open") as DistillStatus,
  };
}

export function insertDistillGroup(env: WeaveEnv, g: DistillGroup): void {
  env.db
    .prepare("INSERT INTO distill_queue (id, member_ids, reason, created_at, status) VALUES (?, ?, ?, ?, ?)")
    .run(g.id, JSON.stringify(g.memberIds), g.reason, g.createdAt, g.status);
}

export function listDistillGroups(env: WeaveEnv, status?: DistillStatus): DistillGroup[] {
  const rows = (status
    ? env.db.prepare("SELECT * FROM distill_queue WHERE status = ? ORDER BY created_at ASC, id ASC").all(status)
    : env.db.prepare("SELECT * FROM distill_queue ORDER BY created_at ASC, id ASC").all()) as Row[];
  return rows.map(rowToGroup);
}

export function getDistillGroup(env: WeaveEnv, id: string): DistillGroup | null {
  const r = env.db.prepare("SELECT * FROM distill_queue WHERE id = ?").get(id) as Row | undefined;
  return r ? rowToGroup(r) : null;
}

export function setDistillStatus(env: WeaveEnv, id: string, status: DistillStatus): void {
  env.db.prepare("UPDATE distill_queue SET status = ? WHERE id = ?").run(status, id);
}

const ENTRY_PLACEHOLDERS = ENTRY_COLS.split(",").map(() => "?").join(", ");

/** roadmap v0.6 M1：写 / 改约定字段（不改 updated_at：结算不算内容修改） */
export function setPromise(
  env: WeaveEnv,
  level: Level,
  id: string,
  p: { dueAt: number | null; state: PromiseState; label: string | null },
): void {
  env.db
    .prepare("UPDATE " + tableOf(level) + " SET due_at = ?, promise_state = ?, promise_label = ? WHERE id = ?")
    .run(p.dueAt, p.state, p.label, id);
}

/** roadmap v0.6 M2：写 / 清日历锚点（不改 updated_at） */
export function setAnchor(env: WeaveEnv, level: Level, id: string, anchor: CalendarAnchor | null): void {
  env.db
    .prepare("UPDATE " + tableOf(level) + " SET calendar_anchor = ? WHERE id = ?")
    .run(anchor ? JSON.stringify(anchor) : null, id);
}

/** roadmap R10：设置 / 取消闪光灯（设置页能取消；不改 updated_at） */
export function setFlash(env: WeaveEnv, level: Level, id: string, flash: boolean): void {
  env.db.prepare("UPDATE " + tableOf(level) + " SET flash = ? WHERE id = ?").run(flash ? 1 : 0, id);
}

/** roadmap R10：今天（本地 0 点起）新增的闪光灯条数 */
export function countFlashSince(env: WeaveEnv, since: number): number {
  let n = 0;
  for (const level of LEVEL_ORDER) {
    const r = env.db.prepare("SELECT COUNT(*) AS n FROM " + tableOf(level) + " WHERE flash = 1 AND created_at >= ?").get(since) as { n?: number } | undefined;
    n += Number(r?.n ?? 0);
  }
  return n;
}

/** roadmap R6：设置等级（0–3）；不改 updated_at（升级不算内容修改） */
export function setBoost(env: WeaveEnv, level: Level, id: string, boost: number): void {
  env.db.prepare("UPDATE " + tableOf(level) + " SET boost = ? WHERE id = ?").run(Math.max(0, Math.min(3, Math.round(boost))), id);
}

function allEntries(env: WeaveEnv): MemoryEntry[] {
  const out: MemoryEntry[] = [];
  for (const level of LEVELS) {
    const rows = env.db
      .prepare("SELECT " + ENTRY_COLS + " FROM " + tableOf(level) + " ORDER BY updated_at DESC, id ASC")
      .all() as Row[];
    for (const r of rows) out.push(rowToEntry(level, r));
  }
  return out;
}

// ---------- 人格（§7） ----------

export function defaultPersona(): PersonaConfig {
  return {
    enabled: true,
    selfNameByModel: {},
    selfNamePro: "我",
    selfNameFlash: "我",
    userName: "主人",
    stance: "",
    character: "",
    suffix: "",
    appearance: { enabled: false, text: "", byModel: {}, cards: [], index: true },
    tone: { enabled: false, text: "", byModel: {} },
    contracts: [],
    thinkingLanguage: "off",
    meta: {
      relation: { stage: "", trust: 0 },
      mood: { baseline: "", bias: "" },
      taboos: [],
      lexicon: {},
    },
    strict: false,
    applyNextSession: true,
  };
}

function factoryPersonaRow(): PersonaRow {
  return {
    enabled: true,
    version: 0,
    spec: "memweave-persona/1",
    selfName: null,
    userName: null,
    stance: null,
    character: null,
    suffix: null,
    thinkingLanguage: null,
    config: defaultPersona(),
    updatedAt: 0,
    updatedBy: "factory",
  };
}

export function getPersona(env: WeaveEnv): PersonaRow {
  const r = env.db.prepare("SELECT * FROM persona WHERE id = 1").get() as Row | undefined;
  if (!r) return factoryPersonaRow();
  const cfg = jget(r.config, null) as PersonaConfig | null;
  return {
    enabled: B(r.enabled),
    version: N(r.version),
    spec: S(r.spec),
    selfName: SN(r.self_name),
    userName: SN(r.user_name),
    stance: SN(r.stance),
    character: SN(r.character),
    suffix: SN(r.suffix),
    thinkingLanguage: SN(r.thinking_language),
    config: cfg && typeof cfg === "object" ? cfg : defaultPersona(),
    updatedAt: N(r.updated_at),
    updatedBy: S(r.updated_by),
  };
}

export function updatePersona(
  env: WeaveEnv,
  patch: Partial<PersonaConfig>,
  actor: string,
  expectedVersion?: number,
): { ok: boolean; version?: number; code?: ErrCode; current?: number } {
  const cur = getPersona(env);
  if (expectedVersion !== undefined && expectedVersion !== cur.version) {
    return { ok: false, code: "E_CAS", current: cur.version };
  }
  // 未知键透传：浅合并，原有不认识的键原样保留
  const merged: PersonaConfig = { ...cur.config, ...patch } as PersonaConfig;
  const version = cur.version + 1;
  const ts = Date.now();
  const cfgText = JSON.stringify(merged);
  env.db.prepare(
    "INSERT INTO persona (id, enabled, version, spec, self_name, user_name, stance, character," +
      " suffix, thinking_language, config, updated_at, updated_by)" +
      " VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)" +
      " ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, version = excluded.version," +
      " spec = excluded.spec, self_name = excluded.self_name, user_name = excluded.user_name," +
      " stance = excluded.stance, character = excluded.character, suffix = excluded.suffix," +
      " thinking_language = excluded.thinking_language, config = excluded.config," +
      " updated_at = excluded.updated_at, updated_by = excluded.updated_by",
  ).run(
    merged.enabled === false ? 0 : 1,
    version,
    "memweave-persona/1",
    SN(merged.selfNamePro) ?? SN(merged.selfNameFlash),
    SN(merged.userName),
    SN(merged.stance),
    SN(merged.character),
    SN(merged.suffix),
    SN(merged.thinkingLanguage),
    cfgText,
    ts,
    actor,
  );
  env.db.prepare(
    "INSERT INTO persona_history (version, config, note, created_at, created_by) VALUES (?, ?, ?, ?, ?)",
  ).run(version, cfgText, null, ts, actor);
  addAudit(env, {
    actor,
    action: "persona.update",
    target: "persona",
    before: JSON.stringify({ version: cur.version }),
    after: JSON.stringify({ version }),
  });
  return { ok: true, version };
}

/** persona 版本历史（§13.2.2 版本页：列表 + diff + 回滚用） */
export interface PersonaHistoryRow {
  version: number;
  note: string | null;
  createdAt: number;
  createdBy: string;
  config: PersonaConfig;
}

export function listPersonaHistory(env: WeaveEnv, limit = 50): PersonaHistoryRow[] {
  const rows = env.db
    .prepare("SELECT version, config, note, created_at, created_by FROM persona_history ORDER BY version DESC LIMIT ?")
    .all(limit) as Row[];
  return rows.map((r) => ({
    version: N(r.version),
    note: SN(r.note),
    createdAt: N(r.created_at),
    createdBy: S(r.created_by),
    config: (jget(r.config, null) as PersonaConfig | null) ?? defaultPersona(),
  }));
}

// ---------- 七层记忆 ----------

export function insertMemory(env: WeaveEnv, e: MemoryEntry): void {
  env.db
    .prepare(
      "INSERT INTO " + tableOf(e.level) + " (" + ENTRY_COLS + ") VALUES (" + ENTRY_PLACEHOLDERS + ")",
    )
    .run(...entryParams(e));
}

export function getMemory(env: WeaveEnv, id: string): MemoryEntry | null {
  for (const level of LEVELS) {
    const r = env.db
      .prepare("SELECT " + ENTRY_COLS + " FROM " + tableOf(level) + " WHERE id = ?")
      .get(id) as Row | undefined;
    if (r) return rowToEntry(level, r);
  }
  return null;
}

export function listMemory(
  env: WeaveEnv,
  f: {
    level?: Level;
    status?: EntryStatus;
    project?: string;
    limit?: number;
    offset?: number;
    ids?: string[];
  },
): MemoryEntry[] {
  const levels: Level[] = f.level ? [f.level] : LEVELS;
  const idSet = f.ids ? new Set(f.ids) : null;
  let out: MemoryEntry[] = [];
  for (const level of levels) {
    const rows = env.db
      .prepare("SELECT " + ENTRY_COLS + " FROM " + tableOf(level) + " ORDER BY updated_at DESC, id ASC")
      .all() as Row[];
    for (const r of rows) {
      const e = rowToEntry(level, r);
      if (f.status && e.status !== f.status) continue;
      if (f.project !== undefined && (e.project ?? "") !== f.project) continue;
      if (idSet && !idSet.has(e.id)) continue;
      out.push(e);
    }
  }
  out.sort((a, b) => {
    const la = LEVELS.indexOf(a.level);
    const lb = LEVELS.indexOf(b.level);
    if (la !== lb) return la - lb;
    if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const offset = Math.max(0, f.offset ?? 0);
  if (offset > 0) out = out.slice(offset);
  if (f.limit !== undefined && f.limit >= 0) out = out.slice(0, f.limit);
  return out;
}

export function reviseMemory(
  env: WeaveEnv,
  id: string,
  patch: Partial<MemoryEntry>,
  actor: string,
  expectedUpdatedAt?: number,
): { ok: boolean; code?: ErrCode } {
  const cur = getMemory(env, id);
  if (!cur) return { ok: false, code: "E_VALID" };
  if (expectedUpdatedAt !== undefined && expectedUpdatedAt !== cur.updatedAt) {
    return { ok: false, code: "E_CAS" };
  }
  const next: MemoryEntry = { ...cur, ...patch, id: cur.id, level: cur.level };
  if (patch.content !== undefined && patch.content !== cur.content) {
    next.hash = contentHash(next.content);
  }
  next.updatedAt = Date.now();
  env.db
    .prepare(
      "UPDATE " + tableOf(cur.level) +
        " SET project = ?, section = ?, content = ?, keywords = ?, importance = ?, status = ?," +
        " semantic_key = ?, confidence = ?, valid_from = ?, valid_to = ?, evidence = ?, hash = ?," +
        " source = ?, access_count = ?, tier = ?, updated_at = ? WHERE id = ?",
    )
    .run(
      next.project,
      next.section,
      next.content,
      JSON.stringify(next.keywords ?? []),
      next.importance,
      next.status,
      next.semanticKey,
      next.confidence,
      next.validFrom,
      next.validTo,
      JSON.stringify(next.evidence ?? []),
      next.hash,
      next.source,
      next.accessCount,
      next.tier,
      next.updatedAt,
      id,
    );
  addAudit(env, {
    actor,
    action: "memory.revise",
    target: id,
    before: JSON.stringify({ status: cur.status, content: cur.content.slice(0, 200) }),
    after: JSON.stringify({ status: next.status, content: next.content.slice(0, 200) }),
  });
  return { ok: true };
}

function setStatus(env: WeaveEnv, id: string, status: EntryStatus, action: string, actor: string): void {
  const cur = getMemory(env, id);
  if (!cur) return;
  env.db
    .prepare("UPDATE " + tableOf(cur.level) + " SET status = ?, updated_at = ? WHERE id = ?")
    .run(status, Date.now(), id);
  addAudit(env, { actor, action, target: id, before: cur.status, after: status });
}

export function archiveMemory(env: WeaveEnv, id: string, actor: string): void {
  setStatus(env, id, "archived", "memory.archive", actor);
}

export function restoreMemory(env: WeaveEnv, id: string, actor: string): void {
  setStatus(env, id, "active", "memory.restore", actor);
}

/** 唯一真删除（§8.7），写审计 */
export function forgetMemory(env: WeaveEnv, id: string, actor: string): void {
  const cur = getMemory(env, id);
  if (!cur) return;
  env.db.prepare("DELETE FROM " + tableOf(cur.level) + " WHERE id = ?").run(id);
  addAudit(env, {
    actor,
    action: "memory.forget",
    target: id,
    before: JSON.stringify({ level: cur.level, content: cur.content.slice(0, 200) }),
  });
}

export function bumpAccess(env: WeaveEnv, ids: string[]): void {
  if (ids.length === 0) return;
  const uniq = [...new Set(ids)];
  for (const level of LEVELS) {
    const marks = uniq.map(() => "?").join(", ");
    env.db
      .prepare(
        "UPDATE " + tableOf(level) + " SET access_count = access_count + 1 WHERE id IN (" + marks + ")",
      )
      .run(...uniq);
  }
}

export function findActiveByHash(env: WeaveEnv, hash: string): MemoryEntry | null {
  for (const level of LEVELS) {
    const r = env.db
      .prepare(
        "SELECT " + ENTRY_COLS + " FROM " + tableOf(level) + " WHERE hash = ? AND status = 'active'",
      )
      .get(hash) as Row | undefined;
    if (r) return rowToEntry(level, r);
  }
  return null;
}

export function listRecentByLevel(env: WeaveEnv, level: Level, limit: number): MemoryEntry[] {
  const rows = env.db
    .prepare(
      "SELECT " + ENTRY_COLS + " FROM " + tableOf(level) + " ORDER BY updated_at DESC, id ASC LIMIT ?",
    )
    .all(limit) as Row[];
  return rows.map((r) => rowToEntry(level, r));
}

export function findConflictingSemanticKey(env: WeaveEnv, semanticKey: string): MemoryEntry[] {
  const out: MemoryEntry[] = [];
  for (const level of LEVELS) {
    const rows = env.db
      .prepare(
        "SELECT " + ENTRY_COLS + " FROM " + tableOf(level) +
          " WHERE semantic_key = ? AND status != 'archived'",
      )
      .all(semanticKey) as Row[];
    for (const r of rows) out.push(rowToEntry(level, r));
  }
  return out;
}

// ---------- 候选池 / 冲突 ----------

function rowToCandidate(r: Row): CandidateRow {
  return {
    id: S(r.id),
    level: (SN(r.level) ?? "fact") as Level | "persona",
    project: SN(r.project),
    content: S(r.content),
    keywords: jarr(r.keywords).map((x) => String(x)),
    importance: N(r.importance),
    semanticKey: SN(r.semantic_key),
    evidence: jarr(r.evidence) as Evidence[],
    tier: (SN(r.tier) ?? "hot") as Tier,
    verdict: (SN(r.verdict) ?? "pending") as Verdict,
    risk: SN(r.risk),
    reason: SN(r.reason),
    mergedInto: SN(r.merged_into),
    createdAt: N(r.created_at),
    decidedAt: NN(r.decided_at),
    decidedBy: SN(r.decided_by),
    patch: (jget(r.patch, null) as Partial<MemoryEntry> | null) ?? undefined,
  };
}

export function listCandidates(env: WeaveEnv, verdict?: Verdict): CandidateRow[] {
  const rows = (
    verdict
      ? env.db
          .prepare("SELECT * FROM candidates WHERE verdict = ? ORDER BY created_at DESC, id ASC")
          .all(verdict)
      : env.db.prepare("SELECT * FROM candidates ORDER BY created_at DESC, id ASC").all()
  ) as Row[];
  return rows.map(rowToCandidate);
}

export function getCandidate(env: WeaveEnv, id: string): CandidateRow | null {
  const r = env.db.prepare("SELECT * FROM candidates WHERE id = ?").get(id) as Row | undefined;
  return r ? rowToCandidate(r) : null;
}

export function insertCandidate(env: WeaveEnv, c: CandidateRow): void {
  env.db
    .prepare(
      "INSERT INTO candidates (id, level, project, content, keywords, importance, semantic_key," +
        " evidence, tier, verdict, risk, reason, merged_into, created_at, decided_at, decided_by, patch)" +
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      c.id,
      c.level,
      c.project,
      c.content,
      JSON.stringify(c.keywords ?? []),
      c.importance,
      c.semanticKey,
      JSON.stringify(c.evidence ?? []),
      c.tier,
      c.verdict,
      c.risk,
      c.reason,
      c.mergedInto,
      c.createdAt,
      c.decidedAt,
      c.decidedBy,
      c.patch ? JSON.stringify(c.patch) : null,
    );
}

export function decideCandidate(
  env: WeaveEnv,
  id: string,
  verdict: Verdict,
  actor: string,
  targetId?: string,
): { ok: boolean; code?: ErrCode } {
  const row = env.db.prepare("SELECT * FROM candidates WHERE id = ?").get(id) as Row | undefined;
  if (!row) return { ok: false, code: "E_VALID" };
  env.db
    .prepare(
      "UPDATE candidates SET verdict = ?, decided_at = ?, decided_by = ?, merged_into = ? WHERE id = ?",
    )
    .run(verdict, Date.now(), actor, targetId ?? SN(row.merged_into), id);
  addAudit(env, {
    actor,
    action: "candidate.decide",
    target: id,
    before: S(row.verdict),
    after: verdict + (targetId ? " -> " + targetId : ""),
  });
  return { ok: true };
}

function rowToConflict(r: Row): ConflictRow {
  return {
    id: S(r.id),
    semanticKey: S(r.semantic_key),
    contenders: jarr(r.contenders) as ConflictContender[],
    winnerId: SN(r.winner_id),
    status: SN(r.status) ?? "open",
    note: SN(r.note),
    createdAt: N(r.created_at),
    resolvedAt: NN(r.resolved_at),
  };
}

export function listConflicts(env: WeaveEnv, status?: string): ConflictRow[] {
  const rows = (
    status
      ? env.db
          .prepare("SELECT * FROM conflicts WHERE status = ? ORDER BY created_at DESC, id ASC")
          .all(status)
      : env.db.prepare("SELECT * FROM conflicts ORDER BY created_at DESC, id ASC").all()
  ) as Row[];
  return rows.map(rowToConflict);
}

export function insertConflict(env: WeaveEnv, c: ConflictRow): void {
  env.db
    .prepare(
      "INSERT INTO conflicts (id, semantic_key, contenders, winner_id, status, note, created_at, resolved_at)" +
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      c.id,
      c.semanticKey,
      JSON.stringify(c.contenders ?? []),
      c.winnerId,
      c.status,
      c.note,
      c.createdAt,
      c.resolvedAt,
    );
}

/** 裁决：胜者留下，败者 archived 并留 superseded_by（§8.4） */
export function resolveConflict(
  env: WeaveEnv,
  id: string,
  winnerId: string | null,
  actor: string,
): { ok: boolean; code?: ErrCode; archived?: Array<{ id: string; before: EntryStatus }> } {
  const row = env.db.prepare("SELECT * FROM conflicts WHERE id = ?").get(id) as Row | undefined;
  if (!row) return { ok: false, code: "E_VALID" };
  const c = rowToConflict(row);
  // 只裁决 open 的冲突：重复裁决会把上一次的胜者也归档
  if (c.status !== "open") return { ok: false, code: "E_VALID" };
  if (winnerId !== null && !c.contenders.some((t) => t.id === winnerId)) return { ok: false, code: "E_VALID" };
  env.db
    .prepare("UPDATE conflicts SET winner_id = ?, status = 'resolved', resolved_at = ? WHERE id = ?")
    .run(winnerId, Date.now(), id);
  const archived: Array<{ id: string; before: EntryStatus }> = [];
  for (const t of c.contenders) {
    if (winnerId !== null && t.id === winnerId) continue;
    const entry = getMemory(env, t.id);
    if (!entry || entry.status === "archived") continue;
    env.db
      .prepare(
        "UPDATE " + tableOf(entry.level) + " SET status = 'archived', updated_at = ? WHERE id = ?",
      )
      .run(Date.now(), t.id);
    archived.push({ id: t.id, before: entry.status });
  }
  addAudit(env, {
    actor,
    action: "conflict.resolve",
    target: id,
    before: JSON.stringify({ semanticKey: c.semanticKey }),
    after: JSON.stringify({ winnerId }),
  });
  return { ok: true, archived };
}

/** 撤销裁决：冲突回到 open（供 undo 用） */
export function reopenConflict(env: WeaveEnv, id: string): void {
  env.db.prepare("UPDATE conflicts SET winner_id = NULL, status = 'open', resolved_at = NULL WHERE id = ?").run(id);
}

/** 把候选的 verdict 原样设回（供撤销裁决用，不记 candidate.decide 审计） */
export function setCandidateVerdict(env: WeaveEnv, id: string, verdict: Verdict): void {
  env.db.prepare("UPDATE candidates SET verdict = ?, decided_at = NULL, decided_by = NULL WHERE id = ?").run(verdict, id);
}

// ---------- 审计 ----------

export function addAudit(
  env: WeaveEnv,
  row: {
    actor: string;
    action: string;
    target: string;
    before?: string;
    after?: string;
    reason?: string;
    sessionId?: string;
  },
): void {
  env.db
    .prepare(
      "INSERT INTO audit_log (ts, actor, action, target, before, after, reason, session_id)" +
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      Date.now(),
      row.actor,
      row.action,
      row.target,
      row.before ?? null,
      row.after ?? null,
      row.reason ?? null,
      row.sessionId ?? null,
    );
}

export function queryAudit(
  env: WeaveEnv,
  f: { actor?: string; action?: string; since?: number; limit?: number },
): AuditRow[] {
  const where: string[] = [];
  const params: SQLInputValue[] = [];
  if (f.actor) {
    where.push("actor = ?");
    params.push(f.actor);
  }
  if (f.action) {
    where.push("action = ?");
    params.push(f.action);
  }
  if (f.since !== undefined) {
    where.push("ts >= ?");
    params.push(f.since);
  }
  const sql =
    "SELECT * FROM audit_log" +
    (where.length ? " WHERE " + where.join(" AND ") : "") +
    " ORDER BY ts DESC, id DESC LIMIT ?";
  params.push(Math.max(1, Math.min(1000, f.limit ?? 100)));
  const rows = env.db.prepare(sql).all(...params) as Row[];
  return rows.map((r) => ({
    id: N(r.id),
    ts: N(r.ts),
    actor: S(r.actor),
    action: S(r.action),
    target: S(r.target),
    before: SN(r.before),
    after: SN(r.after),
    reason: SN(r.reason),
    sessionId: SN(r.session_id),
  }));
}

// ---------- 注入状态 / 账本 ----------

export function getInjectState(env: WeaveEnv, sessionId: string): InjectState | null {
  const r = env.db.prepare("SELECT * FROM inject_state WHERE session_id = ?").get(sessionId) as
    | Row
    | undefined;
  if (!r) return null;
  return {
    sessionId: S(r.session_id),
    snapshotAt: N(r.snapshot_at),
    snapshotHash: SN(r.snapshot_hash),
    pushed: jarr(r.pushed).map((x) => String(x)),
    frozen: B(r.frozen),
    charsUsed: N(r.chars_used),
  };
}

export function upsertInjectState(env: WeaveEnv, s: InjectState): void {
  env.db
    .prepare(
      "INSERT INTO inject_state (session_id, snapshot_at, snapshot_hash, pushed, frozen, chars_used)" +
        " VALUES (?, ?, ?, ?, ?, ?)" +
        " ON CONFLICT(session_id) DO UPDATE SET snapshot_at = excluded.snapshot_at," +
        " snapshot_hash = excluded.snapshot_hash, pushed = excluded.pushed," +
        " frozen = excluded.frozen, chars_used = excluded.chars_used",
    )
    .run(
      s.sessionId,
      s.snapshotAt,
      s.snapshotHash,
      JSON.stringify(s.pushed ?? []),
      s.frozen ? 1 : 0,
      s.charsUsed,
    );
}

export function addLedger(
  env: WeaveEnv,
  row: {
    sessionId: string;
    segment: string;
    chars: number;
    items: number;
    trimmed: number;
    detail?: string;
  },
): void {
  env.db
    .prepare(
      "INSERT INTO budget_ledger (ts, session_id, segment, chars, items, trimmed, detail)" +
        " VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(Date.now(), row.sessionId, row.segment, row.chars, row.items, row.trimmed, row.detail ?? null);
}

/** 最近有注入记录的会话（按最后一次注入时间倒序），供界面下拉选择 */
export function listLedgerSessions(env: WeaveEnv, limit = 20): Array<{ sessionId: string; lastTs: number; turns: number; chars: number }> {
  const rows = env.db
    .prepare(
      "SELECT session_id, MAX(ts) AS last_ts, COUNT(*) AS turns, SUM(chars) AS chars FROM budget_ledger" +
        " GROUP BY session_id ORDER BY last_ts DESC LIMIT ?",
    )
    .all(Math.max(1, Math.min(100, Math.floor(limit)))) as Row[];
  return rows.map((r) => ({ sessionId: S(r.session_id), lastTs: N(r.last_ts), turns: N(r.turns), chars: N(r.chars) }));
}

export function getLedger(env: WeaveEnv, sessionId: string): LedgerRow[] {
  const rows = env.db
    .prepare("SELECT * FROM budget_ledger WHERE session_id = ? ORDER BY ts DESC, id DESC")
    .all(sessionId) as Row[];
  return rows.map((r) => ({
    id: N(r.id),
    ts: N(r.ts),
    sessionId: S(r.session_id),
    segment: S(r.segment),
    chars: N(r.chars),
    items: N(r.items),
    trimmed: N(r.trimmed),
    detail: SN(r.detail),
  }));
}

// ---------- 关联边 ----------

export function insertLink(env: WeaveEnv, l: Link): void {
  env.db
    .prepare(
      "INSERT INTO links (src, dst, kind, weight, created_at) VALUES (?, ?, ?, ?, ?)" +
        " ON CONFLICT(src, dst, kind) DO UPDATE SET weight = excluded.weight",
    )
    .run(l.src, l.dst, l.kind, l.weight, l.createdAt);
}

/** roadmap v0.7 S2：删一条边（归纳撤销 / 冷合并边转移用） */
export function deleteLink(env: WeaveEnv, src: string, dst: string, kind: string): void {
  env.db.prepare("DELETE FROM links WHERE src = ? AND dst = ? AND kind = ?").run(src, dst, kind);
}

export function getLinks(env: WeaveEnv, id: string): Link[] {
  const rows = env.db
    .prepare("SELECT * FROM links WHERE src = ? OR dst = ? ORDER BY created_at DESC, kind ASC")
    .all(id, id) as Row[];
  return rows.map((r) => ({
    src: S(r.src),
    dst: S(r.dst),
    kind: S(r.kind),
    weight: Number(r.weight ?? 1),
    createdAt: N(r.created_at),
  }));
}

// ---------- 统计与增量 ----------

export function countByLevel(env: WeaveEnv): Record<Level, number> {
  const out = {} as Record<Level, number>;
  for (const level of LEVELS) {
    const r = env.db.prepare("SELECT COUNT(*) AS c FROM " + tableOf(level)).get() as Row | undefined;
    out[level] = N(r?.c);
  }
  return out;
}

/** added / updated / archived，按 (LEVEL_ORDER, id) 固定排序（§6.3） */
export function computeDelta(
  env: WeaveEnv,
  _sessionId: string,
  baseline: Map<string, number>,
): DeltaChange[] {
  const out: DeltaChange[] = [];
  for (const e of allEntries(env)) {
    const b = baseline.get(e.id);
    if (b === undefined) {
      if (e.status === "archived") continue;
      out.push({ kind: "added", entry: e });
    } else if (e.updatedAt > b) {
      out.push({ kind: e.status === "archived" ? "archived" : "updated", entry: e });
    }
  }
  out.sort((x, y) => {
    const lx = LEVELS.indexOf(x.entry.level);
    const ly = LEVELS.indexOf(y.entry.level);
    if (lx !== ly) return lx - ly;
    return x.entry.id < y.entry.id ? -1 : x.entry.id > y.entry.id ? 1 : 0;
  });
  return out;
}

// ---------- 撤销台账（§13.2.6 / M4：自动动作 100% 可撤销） ----------

export interface UndoRow {
  id: string;
  ts: number;
  actor: string;
  action: string;
  target: string;
  payload: string;
  undone: boolean;
  undoneTs: number | null;
}

/** 记一条可撤销动作（payload 里放执行逆操作所需的全部现场） */
export function appendUndo(
  env: WeaveEnv,
  u: { action: string; target: string; payload: unknown; actor: string; now?: number },
): string {
  const id = newId();
  env.db
    .prepare(
      "INSERT INTO undo_log (id, ts, actor, action, target, payload, undone) VALUES (?, ?, ?, ?, ?, ?, 0)",
    )
    .run(id, u.now ?? Date.now(), u.actor, u.action, u.target, JSON.stringify(u.payload ?? {}));
  return id;
}

function rowToUndo(r: Record<string, unknown>): UndoRow {
  return {
    id: String(r.id),
    ts: Number(r.ts),
    actor: String(r.actor),
    action: String(r.action),
    target: String(r.target),
    payload: String(r.payload ?? "{}"),
    undone: Number(r.undone ?? 0) !== 0,
    undoneTs: r.undone_ts == null ? null : Number(r.undone_ts),
  };
}

export function listUndo(env: WeaveEnv, sinceTs: number): UndoRow[] {
  const rows = env.db
    .prepare("SELECT * FROM undo_log WHERE ts >= ? AND undone = 0 ORDER BY ts DESC")
    .all(sinceTs) as Array<Record<string, unknown>>;
  return rows.map(rowToUndo);
}

export function getUndo(env: WeaveEnv, id: string): UndoRow | null {
  const r = env.db.prepare("SELECT * FROM undo_log WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return r ? rowToUndo(r) : null;
}

export function markUndoDone(env: WeaveEnv, id: string, now: number): void {
  env.db.prepare("UPDATE undo_log SET undone = 1, undone_ts = ? WHERE id = ?").run(now, id);
}


