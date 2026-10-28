/**
 * roadmap v0.2 R1 / R5：写入时自动建关联边 + 召回注入记录（recall_log）。
 * 纯 SQLite，零依赖；所有函数失败都不抛到写入主流程（调用方 try/catch）。
 */

import { tokenize } from "../core/tokenize";
import type { Level, MemoryEntry } from "../core/types";
import { LAYER_TABLES } from "./schema";
import type { WeaveEnv } from "./db";
import { insertLink, listMemory } from "./dao";

export interface AutoLinkConfig {
  enabled: boolean;
  maxPerWrite: number;
  topicJaccard: number;
  timeWindowMin: number;
}

export const DEFAULT_AUTOLINK: AutoLinkConfig = {
  enabled: true,
  maxPerWrite: 8,
  topicJaccard: 0.3,
  timeWindowMin: 30,
};

/** 写入会话标记：`<sessionId>#<turn>`；turn 未知时只有 sessionId */
export function sessionTag(sessionId: string, turn?: number): string {
  return typeof turn === "number" && Number.isFinite(turn) ? sessionId + "#" + turn : sessionId;
}

function parseTag(tag: string | null): { sid: string; turn: number | null } | null {
  if (!tag) return null;
  const i = tag.lastIndexOf("#");
  if (i < 0) return { sid: tag, turn: null };
  const turn = Number(tag.slice(i + 1));
  return { sid: tag.slice(0, i), turn: Number.isFinite(turn) ? turn : null };
}

export function setSessionTag(env: WeaveEnv, level: Level, id: string, tag: string): void {
  env.db.prepare("UPDATE " + LAYER_TABLES[level] + " SET session_id = ? WHERE id = ?").run(tag, id);
}

function sessionTagsOf(env: WeaveEnv, ids: string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const marks = ids.map(() => "?").join(", ");
  for (const table of Object.values(LAYER_TABLES)) {
    const rows = env.db
      .prepare("SELECT id, session_id FROM " + table + " WHERE session_id IS NOT NULL AND id IN (" + marks + ")")
      .all(...ids) as Array<{ id: string; session_id: string }>;
    for (const r of rows) out.set(String(r.id), String(r.session_id));
  }
  return out;
}

/** 关键词集合（中文二元组 + 拉丁词），用于 topic 边与去同质 */
export function termSet(e: Pick<MemoryEntry, "content" | "keywords">): Set<string> {
  return new Set([...tokenize(e.content), ...e.keywords.map((k) => k.toLowerCase())]);
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const t of small) if (large.has(t)) inter += 1;
  return inter / (a.size + b.size - inter);
}

export interface AutoLinkResult {
  created: Array<{ dst: string; kind: string; weight: number }>;
}

/**
 * R1：新条目落库后建 co-session / topic / time 三种边，每次最多 maxPerWrite 条。
 * 无向边：存 (min, max) 字典序一条，getLinks 两向都查。
 */
export function autoLink(
  env: WeaveEnv,
  entry: MemoryEntry,
  tag: string | null,
  cfg: AutoLinkConfig = DEFAULT_AUTOLINK,
  now: number = Date.now(),
): AutoLinkResult {
  if (!cfg.enabled || cfg.maxPerWrite <= 0) return { created: [] };
  const pool = new Map<string, MemoryEntry>();
  const active = listMemory(env, { status: "active" }).filter((e) => e.id !== entry.id);
  // 候选：同 project 近 200 条 + 全局近 100 条
  const byRecent = [...active].sort((x, y) => y.updatedAt - x.updatedAt || (x.id < y.id ? -1 : 1));
  if (entry.project) {
    for (const e of byRecent.filter((x) => x.project === entry.project).slice(0, 200)) pool.set(e.id, e);
  }
  for (const e of byRecent.slice(0, 100)) pool.set(e.id, e);
  if (pool.size === 0) return { created: [] };

  const mine = parseTag(tag);
  const tags = mine ? sessionTagsOf(env, [...pool.keys()]) : new Map<string, string>();
  const myTerms = termSet(entry);
  const windowMs = cfg.timeWindowMin * 60000;

  type Cand = { dst: string; kind: string; weight: number };
  const cands: Cand[] = [];
  for (const other of pool.values()) {
    if (mine) {
      const t = parseTag(tags.get(other.id) ?? null);
      if (t && t.sid === mine.sid) {
        const adjacent = mine.turn === null || t.turn === null || Math.abs(mine.turn - t.turn) <= 1;
        if (adjacent) cands.push({ dst: other.id, kind: "co-session", weight: 0.6 });
      }
    }
    const j = jaccard(myTerms, termSet(other));
    const sameSection = !!entry.project && !!entry.section && entry.project === other.project && entry.section === other.section;
    if (j >= cfg.topicJaccard || sameSection) {
      cands.push({ dst: other.id, kind: "topic", weight: Math.min(1, 0.4 + 0.6 * j) });
    }
    if (entry.project && entry.project === other.project && Math.abs(now - other.createdAt) <= windowMs) {
      cands.push({ dst: other.id, kind: "time", weight: 0.3 });
    }
  }
  cands.sort((x, y) => y.weight - x.weight || (x.dst < y.dst ? -1 : x.dst > y.dst ? 1 : x.kind < y.kind ? -1 : 1));
  const created = cands.slice(0, cfg.maxPerWrite);
  for (const c of created) {
    const [src, dst] = entry.id < c.dst ? [entry.id, c.dst] : [c.dst, entry.id];
    insertLink(env, { src, dst, kind: c.kind, weight: c.weight, createdAt: now });
  }
  return { created };
}

// ---------- R5：召回注入记录 ----------

export const RECALL_LOG_KEEP_DAYS = 90;

export function logRecall(env: WeaveEnv, ids: string[], sessionId: string, turn: number, now: number = Date.now()): void {
  if (ids.length === 0) return;
  const stmt = env.db.prepare("INSERT INTO recall_log (ts, memory_id, session_id, turn) VALUES (?, ?, ?, ?)");
  for (const id of new Set(ids)) stmt.run(now, id, sessionId, turn);
}

/** 过去 windowMs 内每条记忆被召回注入的次数（跨会话） */
export function recentRecallCounts(env: WeaveEnv, ids: string[], windowMs: number, now: number = Date.now()): Map<string, number> {
  const out = new Map<string, number>();
  if (ids.length === 0) return out;
  const marks = ids.map(() => "?").join(", ");
  const rows = env.db
    .prepare(
      "SELECT memory_id, COUNT(*) AS c FROM recall_log WHERE ts > ? AND memory_id IN (" + marks + ") GROUP BY memory_id",
    )
    .all(now - windowMs, ...ids) as Array<{ memory_id: string; c: number }>;
  for (const r of rows) out.set(String(r.memory_id), Number(r.c));
  return out;
}

/** dream 时清理：只保留 keepDays 天内的记录 */
export function pruneRecallLog(env: WeaveEnv, keepDays: number = RECALL_LOG_KEEP_DAYS, now: number = Date.now()): number {
  const r = env.db.prepare("DELETE FROM recall_log WHERE ts < ?").run(now - keepDays * 86400000);
  return Number(r.changes ?? 0);
}
