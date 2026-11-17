/**
 * 忆织 MemWeave —— 多模型 Persona 存储层
 */

import type { WeaveEnv } from "../store/db";
import type { SessionPersona, SessionPersonaOverrides } from "./types";

export function getSessionPersona(env: WeaveEnv, sessionId: string): SessionPersona | null {
  const row = env.db
    .prepare("SELECT * FROM session_persona WHERE session_id = ?")
    .get(sessionId) as any;

  if (!row) return null;

  return {
    sessionId: row.session_id,
    enabled: row.enabled === 1,
    overrides: JSON.parse(row.overrides || "{}"),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function setSessionPersona(
  env: WeaveEnv,
  sessionId: string,
  overrides: Partial<SessionPersonaOverrides>
): void {
  const now = Date.now();
  
  env.db
    .prepare(
      `INSERT INTO session_persona (session_id, enabled, overrides, created_at, updated_at)
       VALUES (?, 1, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         enabled = 1,
         overrides = excluded.overrides,
         updated_at = excluded.updated_at`
    )
    .run(sessionId, JSON.stringify(overrides), now, now);
}

export function clearSessionPersona(env: WeaveEnv, sessionId: string): void {
  env.db.prepare("DELETE FROM session_persona WHERE session_id = ?").run(sessionId);
}

export function listSessionPersonas(env: WeaveEnv, limit = 50): SessionPersona[] {
  const rows = env.db
    .prepare("SELECT * FROM session_persona ORDER BY updated_at DESC LIMIT ?")
    .all(limit) as any[];

  return rows.map((row) => ({
    sessionId: row.session_id,
    enabled: row.enabled === 1,
    overrides: JSON.parse(row.overrides || "{}"),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export function disableSessionPersona(env: WeaveEnv, sessionId: string): void {
  env.db
    .prepare("UPDATE session_persona SET enabled = 0, updated_at = ? WHERE session_id = ?")
    .run(Date.now(), sessionId);
}

export function enableSessionPersona(env: WeaveEnv, sessionId: string): void {
  env.db
    .prepare("UPDATE session_persona SET enabled = 1, updated_at = ? WHERE session_id = ?")
    .run(Date.now(), sessionId);
}
