/**
 * 忆织 MemWeave —— 队列监控
 * 只读汇总 L0 暂存、候选池、待归纳组、向量任务四个队列。
 */

import type { WeaveEnv } from "./db";
import { tableExists } from "./health";

export interface QueueStats {
  ts: number;
  l0: { total: number; sessions: number; last24h: number; expired: number; oldestTs: number | null };
  candidates: { pending: number; byLevel: Record<string, number>; oldestTs: number | null };
  distill: { open: number; done: number; skipped: number; expired: number };
  embedding: {
    enabled: boolean;
    pending: number;
    processing: number;
    done: number;
    failed: number;
    oldestPendingTs: number | null;
  };
}

export interface QueueDetail {
  candidates: Array<{ id: string; level: string; preview: string; risk: string | null; createdAt: number }>;
  distill: Array<{ id: string; members: number; reason: string | null; createdAt: number }>;
  failedJobs: Array<{ id: string; memoryId: string; level: string; error: string | null; retries: number; createdAt: number }>;
}

const DAY = 86400000;
const PREVIEW_CHARS = 80;

type Row = Record<string, unknown>;

function n(v: unknown): number {
  return Number(v ?? 0);
}

function nn(v: unknown): number | null {
  return v === null || v === undefined ? null : Number(v);
}

function preview(text: unknown): string {
  const s = String(text ?? "");
  return s.length > PREVIEW_CHARS ? s.slice(0, PREVIEW_CHARS) + "…" : s;
}

function l0Stats(env: WeaveEnv, now: number): QueueStats["l0"] {
  const r = env.db
    .prepare(
      "SELECT COUNT(*) AS total, COUNT(DISTINCT session_id) AS sessions, MIN(ts) AS oldest," +
        " SUM(CASE WHEN ts >= ? THEN 1 ELSE 0 END) AS recent," +
        " SUM(CASE WHEN retained_until IS NOT NULL AND retained_until < ? THEN 1 ELSE 0 END) AS expired" +
        " FROM l0_messages",
    )
    .get(now - DAY, now) as Row;
  return { total: n(r.total), sessions: n(r.sessions), last24h: n(r.recent), expired: n(r.expired), oldestTs: nn(r.oldest) };
}

function candidateStats(env: WeaveEnv): QueueStats["candidates"] {
  const rows = env.db
    .prepare("SELECT level, COUNT(*) AS c, MIN(created_at) AS oldest FROM candidates WHERE verdict = 'pending' GROUP BY level")
    .all() as Row[];
  const byLevel: Record<string, number> = {};
  let pending = 0;
  let oldestTs: number | null = null;
  for (const r of rows) {
    const c = n(r.c);
    byLevel[String(r.level ?? "unknown")] = c;
    pending += c;
    const o = nn(r.oldest);
    if (o !== null && (oldestTs === null || o < oldestTs)) oldestTs = o;
  }
  return { pending, byLevel, oldestTs };
}

function distillStats(env: WeaveEnv): QueueStats["distill"] {
  const out = { open: 0, done: 0, skipped: 0, expired: 0 };
  const rows = env.db.prepare("SELECT status, COUNT(*) AS c FROM distill_queue GROUP BY status").all() as Row[];
  for (const r of rows) {
    const s = String(r.status) as keyof typeof out;
    if (s in out) out[s] = n(r.c);
  }
  return out;
}

function embeddingStats(env: WeaveEnv): QueueStats["embedding"] {
  const out = { enabled: false, pending: 0, processing: 0, done: 0, failed: 0, oldestPendingTs: null as number | null };
  if (!tableExists(env, "embedding_jobs")) return out;
  out.enabled = true;
  const rows = env.db.prepare("SELECT status, COUNT(*) AS c FROM embedding_jobs GROUP BY status").all() as Row[];
  for (const r of rows) {
    const s = String(r.status);
    if (s === "pending" || s === "processing" || s === "done" || s === "failed") out[s] = n(r.c);
  }
  const o = env.db.prepare("SELECT MIN(created_at) AS o FROM embedding_jobs WHERE status = 'pending'").get() as Row;
  out.oldestPendingTs = nn(o.o);
  return out;
}

export function getQueueStats(env: WeaveEnv, now = Date.now()): QueueStats {
  return {
    ts: now,
    l0: l0Stats(env, now),
    candidates: candidateStats(env),
    distill: distillStats(env),
    embedding: embeddingStats(env),
  };
}

export function getQueueDetail(env: WeaveEnv, limit = 20): QueueDetail {
  const lim = Math.max(1, Math.min(100, Math.floor(limit)));
  const candidates = (
    env.db
      .prepare(
        "SELECT id, level, content, risk, created_at FROM candidates WHERE verdict = 'pending'" +
          " ORDER BY created_at ASC, id ASC LIMIT ?",
      )
      .all(lim) as Row[]
  ).map((r) => ({
    id: String(r.id),
    level: String(r.level ?? ""),
    preview: preview(r.content),
    risk: r.risk === null || r.risk === undefined ? null : String(r.risk),
    createdAt: n(r.created_at),
  }));

  const distill = (
    env.db
      .prepare("SELECT id, member_ids, reason, created_at FROM distill_queue WHERE status = 'open' ORDER BY created_at ASC, id ASC LIMIT ?")
      .all(lim) as Row[]
  ).map((r) => {
    let members = 0;
    try {
      const v = JSON.parse(String(r.member_ids ?? "[]"));
      members = Array.isArray(v) ? v.length : 0;
    } catch {
      members = 0;
    }
    return {
      id: String(r.id),
      members,
      reason: r.reason === null || r.reason === undefined ? null : String(r.reason),
      createdAt: n(r.created_at),
    };
  });

  const failedJobs = tableExists(env, "embedding_jobs")
    ? (
        env.db
          .prepare(
            "SELECT id, memory_id, level, error, retries, created_at FROM embedding_jobs WHERE status = 'failed'" +
              " ORDER BY created_at DESC, id ASC LIMIT ?",
          )
          .all(lim) as Row[]
      ).map((r) => ({
        id: String(r.id),
        memoryId: String(r.memory_id),
        level: String(r.level),
        error: r.error === null || r.error === undefined ? null : String(r.error),
        retries: n(r.retries),
        createdAt: n(r.created_at),
      }))
    : [];

  return { candidates, distill, failedJobs };
}
