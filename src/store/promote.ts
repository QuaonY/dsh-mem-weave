/**
 * 忆织 MemWeave —— lesson → 人格契约晋升通径（规划文档 §9-P1 / §7.6）
 * 同一条教训被验证 ≥2 次、或主人明确纠正过 → dream 提名「拟晋升为人格契约」候选；
 * 人确认后才写 persona.contracts（版本 +1，记审计）。
 */

import type { MemoryEntry } from "../core/types";
import type { WeaveEnv } from "./db";
import { addAudit, insertCandidate, listMemory, newId, type CandidateRow } from "./dao";

export const PROMOTION_REASON = "contract-promotion";
export const PROMOTION_KEY_PREFIX = "contract-promotion:";
export const CONTRACT_ID_PREFIX = "cp-";
export const CONTRACT_TEXT_MAX = 300;

/** 同一条教训的验证次数：同内容再写被去重并入 / 近似并入 都算一次验证 */
export function lessonValidations(env: WeaveEnv, lessonId: string): number {
  const r = env.db
    .prepare(
      "SELECT COUNT(*) AS n FROM audit_log WHERE target = ? AND" +
        " (action = 'memory.merge' OR (action = 'memory.write' AND reason LIKE '%dedupe%'))",
    )
    .get(lessonId) as { n?: number } | undefined;
  return Number(r?.n ?? 0);
}

/** 主人明确纠正过（human 的 memory.revise） */
export function humanCorrected(env: WeaveEnv, lessonId: string): boolean {
  const r = env.db
    .prepare(
      "SELECT COUNT(*) AS n FROM audit_log WHERE target = ? AND actor = 'human' AND action = 'memory.revise'",
    )
    .get(lessonId) as { n?: number } | undefined;
  return Number(r?.n ?? 0) > 0;
}

/** 已有未决晋升候选则不重复提名 */
function hasPendingPromotion(env: WeaveEnv, lessonId: string): boolean {
  const r = env.db
    .prepare("SELECT COUNT(*) AS n FROM candidates WHERE semantic_key = ? AND verdict = 'pending'")
    .get(PROMOTION_KEY_PREFIX + lessonId) as { n?: number } | undefined;
  return Number(r?.n ?? 0) > 0;
}

/** 满足晋升前提的 lesson（active） */
export function promotableLessons(env: WeaveEnv, minValidations = 2): MemoryEntry[] {
  const out: MemoryEntry[] = [];
  for (const e of listMemory(env, { level: "lesson", status: "active" })) {
    if (hasPendingPromotion(env, e.id)) continue;
    if (lessonValidations(env, e.id) >= minValidations || humanCorrected(env, e.id)) out.push(e);
  }
  return out;
}

/** dream 提名候选（level=persona，不生效；人确认走 decideCandidate） */
export function proposeContractPromotion(
  env: WeaveEnv,
  lesson: MemoryEntry,
  actor = "dream",
  now = Date.now(),
): string {
  const id = newId();
  const cand: CandidateRow = {
    id,
    level: "persona",
    project: lesson.project,
    content: lesson.content.slice(0, CONTRACT_TEXT_MAX),
    keywords: lesson.keywords,
    importance: lesson.importance,
    semanticKey: PROMOTION_KEY_PREFIX + lesson.id,
    evidence: lesson.evidence,
    tier: lesson.tier,
    verdict: "pending",
    risk: "L2",
    reason: PROMOTION_REASON,
    mergedInto: lesson.id,
    createdAt: now,
    decidedAt: null,
    decidedBy: null,
  };
  insertCandidate(env, cand);
  addAudit(env, {
    actor,
    action: "dream.promote",
    target: lesson.id,
    after: id,
    reason: PROMOTION_REASON,
  });
  return id;
}
