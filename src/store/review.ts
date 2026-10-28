/**
 * roadmap v0.3 G6（原规划 §9 P1 反向）：契约被反复违反 → dream 提议复核。
 * - AI 被主人纠正、且纠正和某条契约有关时，写 lesson 带 violatesContract=<契约 id>；
 *   写入成功后记一条 audit（action=contract.violation, target=契约 id）。
 * - 同一契约 windowDays 天内 ≥ threshold 次 → dream 生成 L2 候选（reason=contract-review），附相关 lesson 原文。
 * - 人在候选页：接受 = 停用这条契约；拒绝 = 保留；修改文字去人格页。AI 永远不能直接改契约（§7.6）。
 */
import type { Contract } from "../core/types";
import type { WeaveEnv } from "./db";
import { addAudit, getMemory, insertCandidate, newId, type CandidateRow } from "./dao";

export const REVIEW_REASON = "contract-review";
export const REVIEW_KEY_PREFIX = "contract-review:";
export const DEFAULT_REVIEW = { windowDays: 30, threshold: 2 };

/** 记一次违反（只记 id 与 lesson id，不记正文） */
export function recordViolation(env: WeaveEnv, contractId: string, lessonId: string, actor: string, sessionId?: string): void {
  addAudit(env, { actor, action: "contract.violation", target: contractId, after: lessonId, sessionId });
}

/** 窗口内各契约的违反次数与相关 lesson id */
export function violationCounts(env: WeaveEnv, now: number, windowDays = DEFAULT_REVIEW.windowDays): Map<string, string[]> {
  const rows = env.db
    .prepare("SELECT target, after FROM audit_log WHERE action = 'contract.violation' AND ts >= ? ORDER BY ts")
    .all(now - windowDays * 86400000) as Array<{ target: string; after: string | null }>;
  const out = new Map<string, string[]>();
  for (const r of rows) {
    const list = out.get(r.target) ?? [];
    if (r.after) list.push(r.after);
    out.set(r.target, list);
  }
  return out;
}

function hasPendingReview(env: WeaveEnv, contractId: string): boolean {
  const r = env.db
    .prepare("SELECT COUNT(*) AS n FROM candidates WHERE semantic_key = ? AND verdict = 'pending'")
    .get(REVIEW_KEY_PREFIX + contractId) as { n?: number } | undefined;
  return Number(r?.n ?? 0) > 0;
}

/** dream 轮：为达到阈值的启用契约生成复核候选，返回候选 id 列表 */
export function proposeContractReviews(
  env: WeaveEnv,
  contracts: Contract[],
  actor: string,
  now: number,
  opts: { windowDays?: number; threshold?: number; limit?: number } = {},
): string[] {
  const windowDays = opts.windowDays ?? DEFAULT_REVIEW.windowDays;
  const threshold = opts.threshold ?? DEFAULT_REVIEW.threshold;
  const limit = opts.limit ?? Infinity;
  const counts = violationCounts(env, now, windowDays);
  const out: string[] = [];
  for (const c of contracts) {
    if (out.length >= limit) break;
    if (!c || !c.on) continue;
    const lessons = counts.get(c.id) ?? [];
    if (lessons.length < threshold || hasPendingReview(env, c.id)) continue;
    const quotes = [...new Set(lessons)]
      .map((id) => getMemory(env, id))
      .filter((e) => !!e)
      .map((e) => "- " + e!.content.slice(0, 160));
    const id = newId();
    const cand: CandidateRow = {
      id,
      level: "persona",
      project: null,
      content:
        "复核契约「" + c.text.slice(0, 80) + "」：近 " + windowDays + " 天被指出违反 " + lessons.length + " 次。" +
        (quotes.length ? "\n相关教训：\n" + quotes.join("\n") : ""),
      keywords: ["contract-review"],
      importance: 4,
      semanticKey: REVIEW_KEY_PREFIX + c.id,
      evidence: [],
      tier: "hot",
      verdict: "pending",
      risk: "L2",
      reason: REVIEW_REASON,
      mergedInto: c.id,
      createdAt: now,
      decidedAt: null,
      decidedBy: null,
    };
    insertCandidate(env, cand);
    addAudit(env, { actor, action: "dream.contract-review", target: c.id, after: id, reason: "violations=" + lessons.length });
    out.push(id);
  }
  return out;
}
