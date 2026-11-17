/**
 * 忆织 MemWeave —— 单条记忆白盒详情
 * 回答「这条记忆从哪来、改过什么、被召回过几次、和谁相连」。只读。
 */

import type { WeaveEnv } from "./db";
import { getLinks, getMemory } from "./dao";
import { LAYER_TABLES } from "./schema";
import { tableExists } from "./health";
import type { Link, MemoryEntry } from "../core/types";

export interface MemoryOrigin {
  /** 条目自带的 source 字段 */
  source: string;
  /** 最早的落库审计；老库或导入条目可能没有 */
  action: string | null;
  actor: string | null;
  ts: number | null;
  reason: string | null;
  candidateId: string | null;
  distillGroupId: string | null;
  distillMembers: string[];
}

export interface EvidenceTrace {
  sessionId: string;
  seq: number;
  quote: string;
  /** 证据对应的 L0 原文仍在保留期内时给出 */
  l0: { id: string; role: string; ts: number } | null;
}

export interface MemoryDetail {
  entry: MemoryEntry;
  origin: MemoryOrigin;
  evidence: EvidenceTrace[];
  history: Array<{ ts: number; actor: string; action: string; reason: string | null; before: string | null; after: string | null }>;
  recall: {
    total: number;
    last7d: number;
    lastTs: number | null;
    sessions: number;
    /** 最近一次命中原因（旧记录为 null） */
    lastReason: string | null;
    /** 按命中原因聚合的次数（最多 10 类） */
    reasons: Array<{ reason: string; count: number }>;
  };
  links: Link[];
  sameKey: Array<{ id: string; status: string; preview: string }>;
  embedding: { indexed: boolean; job: { status: string; error: string | null; retries: number } | null };
}

const DAY = 86400000;
const HISTORY_LIMIT = 50;
const CREATE_ACTIONS = ["memory.write", "distill.land", "memory.merge"];

type Row = Record<string, unknown>;

const sn = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

function getOrigin(env: WeaveEnv, entry: MemoryEntry): MemoryOrigin {
  const out: MemoryOrigin = {
    source: entry.source,
    action: null,
    actor: null,
    ts: null,
    reason: null,
    candidateId: null,
    distillGroupId: null,
    distillMembers: [],
  };
  const r = env.db
    .prepare(
      "SELECT ts, actor, action, reason, after FROM audit_log WHERE target = ? AND action IN (" +
        CREATE_ACTIONS.map(() => "?").join(", ") +
        ") ORDER BY ts ASC, id ASC LIMIT 1",
    )
    .get(entry.id, ...CREATE_ACTIONS) as Row | undefined;
  if (!r) return out;
  out.action = sn(r.action);
  out.actor = sn(r.actor);
  out.ts = Number(r.ts);
  out.reason = sn(r.reason);
  const m = /candidate-accepted:(\S+)/.exec(out.reason ?? "");
  // 候选可能已被保留期清理，历史里仍记录 id 便于溯源
  if (m) out.candidateId = m[1];
  if (out.action === "distill.land" && r.after) {
    try {
      const a = JSON.parse(String(r.after)) as { group?: unknown; members?: unknown };
      if (typeof a.group === "string") out.distillGroupId = a.group;
      if (Array.isArray(a.members)) out.distillMembers = a.members.map(String);
    } catch {
      // after 不是 JSON（旧格式），只保留 action
    }
  }
  return out;
}

function traceEvidence(env: WeaveEnv, entry: MemoryEntry): EvidenceTrace[] {
  const q = env.db.prepare("SELECT id, role, ts FROM l0_messages WHERE session_id = ? AND seq = ?");
  return (entry.evidence ?? []).map((e) => {
    const r = e.sessionId ? (q.get(e.sessionId, e.seq) as Row | undefined) : undefined;
    return {
      sessionId: e.sessionId,
      seq: e.seq,
      quote: e.quote,
      l0: r ? { id: String(r.id), role: String(r.role), ts: Number(r.ts) } : null,
    };
  });
}

function recallStats(env: WeaveEnv, id: string, now: number): MemoryDetail["recall"] {
  const r = env.db
    .prepare(
      "SELECT COUNT(*) AS total, MAX(ts) AS last, COUNT(DISTINCT session_id) AS sessions," +
        " SUM(CASE WHEN ts >= ? THEN 1 ELSE 0 END) AS recent FROM recall_log WHERE memory_id = ?",
    )
    .get(now - 7 * DAY, id) as Row;
  // 命中原因。旧记录没有 reason，归到 unknown，不臆造路由
  const reasons = (
    env.db
      .prepare(
        "SELECT COALESCE(NULLIF(reason, ''), 'unknown') AS reason, COUNT(*) AS n" +
          " FROM recall_log WHERE memory_id = ? GROUP BY reason ORDER BY n DESC, reason ASC LIMIT 10",
      )
      .all(id) as Row[]
  ).map((x) => ({ reason: String(x.reason), count: Number(x.n ?? 0) }));
  const last = env.db
    .prepare("SELECT reason FROM recall_log WHERE memory_id = ? ORDER BY ts DESC LIMIT 1")
    .get(id) as Row | undefined;
  return {
    total: Number(r.total ?? 0),
    last7d: Number(r.recent ?? 0),
    lastTs: r.last === null || r.last === undefined ? null : Number(r.last),
    sessions: Number(r.sessions ?? 0),
    lastReason: last && last.reason !== null && last.reason !== undefined && String(last.reason) !== "" ? String(last.reason) : null,
    reasons,
  };
}

function sameKey(env: WeaveEnv, entry: MemoryEntry): MemoryDetail["sameKey"] {
  if (!entry.semanticKey) return [];
  const rows = env.db
    .prepare(
      "SELECT id, status, content FROM " + LAYER_TABLES[entry.level] +
        " WHERE semantic_key = ? AND id != ? ORDER BY updated_at DESC LIMIT 10",
    )
    .all(entry.semanticKey, entry.id) as Row[];
  return rows.map((r) => {
    const c = String(r.content ?? "");
    return { id: String(r.id), status: String(r.status ?? ""), preview: c.length > 80 ? c.slice(0, 80) + "…" : c };
  });
}

function embeddingState(env: WeaveEnv, id: string): MemoryDetail["embedding"] {
  const indexed = tableExists(env, "memory_embeddings")
    ? !!env.db.prepare("SELECT 1 FROM memory_embeddings WHERE memory_id = ?").get(id)
    : false;
  let job: MemoryDetail["embedding"]["job"] = null;
  if (tableExists(env, "embedding_jobs")) {
    const r = env.db
      .prepare("SELECT status, error, retries FROM embedding_jobs WHERE memory_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(id) as Row | undefined;
    if (r) job = { status: String(r.status), error: sn(r.error), retries: Number(r.retries ?? 0) };
  }
  return { indexed, job };
}

export function getMemoryDetail(env: WeaveEnv, id: string, now = Date.now()): MemoryDetail | null {
  const entry = getMemory(env, id);
  if (!entry) return null;
  const history = (
    env.db
      .prepare("SELECT ts, actor, action, reason, before, after FROM audit_log WHERE target = ? ORDER BY ts DESC, id DESC LIMIT ?")
      .all(id, HISTORY_LIMIT) as Row[]
  ).map((r) => ({
    ts: Number(r.ts),
    actor: String(r.actor ?? ""),
    action: String(r.action ?? ""),
    reason: sn(r.reason),
    before: sn(r.before),
    after: sn(r.after),
  }));
  return {
    entry,
    origin: getOrigin(env, entry),
    evidence: traceEvidence(env, entry),
    history,
    recall: recallStats(env, id, now),
    links: getLinks(env, id),
    sameKey: sameKey(env, entry),
    embedding: embeddingState(env, id),
  };
}
