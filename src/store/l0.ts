/**
 * L0 消息捕获
 * L0 层：原始会话消息（可选、短保留）
 * - 用于自动抽取的输入
 * - 支持按 session 记录 user/assistant 消息
 * - 可配置保留期（默认 7 天）
 * - 用户可查看/删除/关闭
 */

import type { SQLInputValue } from "node:sqlite";
import type { WeaveEnv } from "./db";
import { newId } from "./dao";

/** L0 消息 */
export interface L0Message {
  id: string;
  sessionId: string;
  seq: number;
  role: "user" | "assistant";
  content: string;
  ts: number;
  source: string | null;
  retainedUntil: number | null;
}

/** L0 捕获配置 */
export interface L0CaptureConfig {
  /** 是否启用 L0 捕获 */
  enabled: boolean;
  /** 保留天数（默认 7 天） */
  retentionDays: number;
  /** 是否捕获 user 消息 */
  captureUser: boolean;
  /** 是否捕获 assistant 消息 */
  captureAssistant: boolean;
}

/** 默认 L0 配置 */
export const DEFAULT_L0_CONFIG: L0CaptureConfig = {
  enabled: false, // 默认关闭，opt-in
  retentionDays: 7,
  captureUser: true,
  captureAssistant: true,
};

/**
 * 记录 L0 消息
 */
export function captureL0Message(
  env: WeaveEnv,
  sessionId: string,
  role: "user" | "assistant",
  content: string,
  config?: L0CaptureConfig
): string | null {
  const cfg = config ?? DEFAULT_L0_CONFIG;
  
  // 检查是否启用
  if (!cfg.enabled) return null;
  
  // 检查角色是否需要捕获
  if (role === "user" && !cfg.captureUser) return null;
  if (role === "assistant" && !cfg.captureAssistant) return null;
  
  const now = Date.now();
  const retainedUntil = now + cfg.retentionDays * 24 * 60 * 60 * 1000;
  const id = newId();
  
  // 获取下一个序号
  const maxSeq = env.db.prepare(
    "SELECT COALESCE(MAX(seq), 0) as max_seq FROM l0_messages WHERE session_id = ?"
  ).get(sessionId) as { max_seq: number };
  const seq = maxSeq.max_seq + 1;
  
  env.db.prepare(`
    INSERT INTO l0_messages (id, session_id, seq, role, content, ts, source, retained_until)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, sessionId, seq, role, content, now, null, retainedUntil);
  
  return id;
}

/**
 * 获取 session 的 L0 消息
 */
export function getL0Messages(
  env: WeaveEnv,
  sessionId: string,
  options?: {
    role?: "user" | "assistant";
    limit?: number;
    since?: number;
  }
): L0Message[] {
  let sql = "SELECT * FROM l0_messages WHERE session_id = ?";
  const params: SQLInputValue[] = [sessionId];
  
  if (options?.role) {
    sql += " AND role = ?";
    params.push(options.role);
  }
  
  if (options?.since) {
    sql += " AND ts >= ?";
    params.push(options.since);
  }
  
  sql += " ORDER BY seq DESC";
  
  if (options?.limit) {
    sql += " LIMIT ?";
    params.push(options.limit);
  }
  
  const rows = env.db.prepare(sql).all(...params) as Array<{
    id: string;
    session_id: string;
    seq: number;
    role: string;
    content: string;
    ts: number;
    source: string | null;
    retained_until: number | null;
  }>;
  
  return rows.map(r => ({
    id: r.id,
    sessionId: r.session_id,
    seq: r.seq,
    role: r.role as "user" | "assistant",
    content: r.content,
    ts: r.ts,
    source: r.source,
    retainedUntil: r.retained_until,
  }));
}

/**
 * 获取最近的 N 条 L0 消息（用于抽取）
 */
export function getRecentL0Messages(
  env: WeaveEnv,
  sessionId: string,
  limit: number = 10
): L0Message[] {
  return getL0Messages(env, sessionId, { limit });
}

/**
 * 删除单条 L0 消息
 */
export function deleteL0Message(env: WeaveEnv, id: string): void {
  env.db.prepare("DELETE FROM l0_messages WHERE id = ?").run(id);
}

/**
 * 删除 session 的所有 L0 消息
 */
export function deleteL0Session(env: WeaveEnv, sessionId: string): void {
  env.db.prepare("DELETE FROM l0_messages WHERE session_id = ?").run(sessionId);
}

/**
 * 清理过期的 L0 消息
 */
export function pruneExpiredL0Messages(env: WeaveEnv): number {
  const now = Date.now();
  const result = env.db.prepare(
    "DELETE FROM l0_messages WHERE retained_until IS NOT NULL AND retained_until < ?"
  ).run(now);
  
  return Number(result.changes);
}

/**
 * 获取 L0 统计信息
 */
export function getL0Stats(env: WeaveEnv): {
  total: number;
  bySess: number;
  expired: number;
} {
  const total = (env.db.prepare("SELECT COUNT(*) as c FROM l0_messages").get() as { c: number }).c;
  const bySess = (env.db.prepare("SELECT COUNT(DISTINCT session_id) as c FROM l0_messages").get() as { c: number }).c;
  const now = Date.now();
  const expired = (env.db.prepare(
    "SELECT COUNT(*) as c FROM l0_messages WHERE retained_until IS NOT NULL AND retained_until < ?"
  ).get(now) as { c: number }).c;
  
  return { total, bySess, expired };
}
