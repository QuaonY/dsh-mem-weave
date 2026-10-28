/**
 * 忆织 MemWeave —— 前瞻记忆（roadmap v0.6 M1）：约定越临近越清晰，过期后由主人结算。
 * 清晰度曲线沿用 MMTR promise.ts / decay.ts 默认值（MIT）。
 */

import type { MemoryEntry } from "./types";
import { formatLocalDate, localDayNumber, localParts } from "./localdate";

export interface PromiseConfig {
  enabled: boolean;
  horizonDays: number;
  clarityFloor: number;
  clarityCurve: number;
  /** score × (1 + boost × clarity) */
  boost: number;
  /** S3 约定小节：距到期 ≤ N 天 */
  surfaceLookaheadDays: number;
  /** 过期 ≤ N 天仍在小节里；超过 N 天 dream 出结算候选 */
  graceDays: number;
  /** dueAt 最远多少天 */
  maxHorizonDays: number;
  /** 小节最多几条 */
  maxSurface: number;
  /** kept → 信任 +0.05 / broken → −0.05 */
  affectRelation: boolean;
}

export const DEFAULT_PROMISE: PromiseConfig = {
  enabled: true,
  horizonDays: 45,
  clarityFloor: 0.42,
  clarityCurve: 1.25,
  boost: 0.5,
  surfaceLookaheadDays: 7,
  graceDays: 3,
  maxHorizonDays: 400,
  maxSurface: 5,
  affectRelation: false,
};

export const PROMISE_LABEL_MAX = 40;
export const PROMISE_DUE_REASON = "promise-due";

/** d = 距到期天数（可为小数；≤ 0 = 已到期） */
export function clarity(d: number, cfg: PromiseConfig = DEFAULT_PROMISE): number {
  if (d <= 0) return 1;
  const h = Math.max(1, cfg.horizonDays);
  if (d >= h) return cfg.clarityFloor;
  return cfg.clarityFloor + (1 - cfg.clarityFloor) * Math.pow(1 - d / h, cfg.clarityCurve);
}

export function isPending(e: Pick<MemoryEntry, "promiseState" | "dueAt">): boolean {
  return e.promiseState === "pending" && typeof e.dueAt === "number" && e.dueAt > 0;
}

/** 本地日差：到期日 − 今天（0 = 今天到期，负数 = 已过期几天） */
export function daysToDue(dueAt: number, now: number, timeZone: string): number {
  return localDayNumber(dueAt, timeZone) - localDayNumber(now, timeZone);
}

export interface PromiseScore {
  factor: number;
  trace: string;
}

/** 召回打分：pending 的乘子与 trace；非 pending 返回 null（走普通衰减） */
export function promiseScore(e: MemoryEntry, now: number, cfg: PromiseConfig): PromiseScore | null {
  if (!cfg.enabled || !isPending(e)) return null;
  const d = (e.dueAt! - now) / 86400000;
  const c = clarity(d, cfg);
  return {
    factor: 1 + cfg.boost * c,
    trace: "promise=pending,d=" + Math.max(0, Math.ceil(d)) + ",clarity=" + c.toFixed(2),
  };
}

/** S3 约定小节的取材：pending 且 −grace ≤ 日差 ≤ lookahead，按到期时间，最多 maxSurface 条 */
export function surfacePromises(entries: MemoryEntry[], now: number, timeZone: string, cfg: PromiseConfig): MemoryEntry[] {
  if (!cfg.enabled) return [];
  return entries
    .filter((e) => e.status === "active" && isPending(e))
    .filter((e) => {
      const d = daysToDue(e.dueAt!, now, timeZone);
      return d <= cfg.surfaceLookaheadDays && d >= -cfg.graceDays;
    })
    .sort((a, b) => a.dueAt! - b.dueAt! || (a.id < b.id ? -1 : 1))
    .slice(0, Math.max(0, cfg.maxSurface));
}

/** dream 结算：过期超过 graceDays 还是 pending */
export function overduePromises(entries: MemoryEntry[], now: number, timeZone: string, cfg: PromiseConfig): MemoryEntry[] {
  if (!cfg.enabled) return [];
  return entries
    .filter((e) => e.status === "active" && isPending(e) && daysToDue(e.dueAt!, now, timeZone) < -cfg.graceDays)
    .sort((a, b) => a.dueAt! - b.dueAt! || (a.id < b.id ? -1 : 1));
}

export function promiseLabelOf(e: Pick<MemoryEntry, "promiseLabel" | "content">): string {
  const s = (e.promiseLabel ?? e.content).replace(/\s+/g, " ").trim();
  return s.length > PROMISE_LABEL_MAX ? s.slice(0, PROMISE_LABEL_MAX - 1) + "…" : s;
}

/** 一行：· 约定日 2026-11-03（周二）：…；已过期：· 约定日 2026-10-30（周五，已过期，尚未确认）：… */
export function promiseLine(e: MemoryEntry, now: number, timeZone: string, lang: "zh" | "en" = "zh"): string {
  const overdue = e.dueAt! < now && daysToDue(e.dueAt!, now, timeZone) < 0;
  let date = formatLocalDate(e.dueAt!, timeZone, lang, true);
  if (overdue) {
    date = lang === "en" ? date.replace(/\)/, ", overdue, unconfirmed)") : date.replace(/）/, "，已过期，尚未确认）");
  }
  return (lang === "en" ? "· Due " : "· 约定日 ") + date + (lang === "en" ? ": " : "：") + promiseLabelOf(e);
}

/** 校验 dueAt：早于现在或晚于 maxHorizonDays 都拒绝（返回原因） */
export function checkDue(dueAt: number, now: number, cfg: PromiseConfig): string | null {
  if (dueAt <= now) return "dueAt is in the past";
  if (dueAt > now + cfg.maxHorizonDays * 86400000) return "dueAt beyond maxHorizonDays (" + cfg.maxHorizonDays + ")";
  return null;
}

/** 「已经做了」语气 + 关键词重叠（MMTR promiseMentionsPromise 同款思路） */
const DONE_TONE = /已经|做完|做好|弄好|搞定|完成了|发了|发出去|交了|交上|提交了|办好|修好|写完|done|finished|sent|submitted|completed/i;

export function looksFulfilled(text: string, promiseTokens: Set<string>, textTokens: Set<string>, minOverlap = 0.3): boolean {
  if (!DONE_TONE.test(text) || promiseTokens.size === 0) return false;
  let inter = 0;
  for (const t of promiseTokens) if (textTokens.has(t)) inter += 1;
  return inter / promiseTokens.size >= minOverlap;
}

/** 测试与渲染共用：本地日期字符串（YYYY-MM-DD） */
export function localYmd(ms: number, timeZone: string): string {
  const p = localParts(ms, timeZone);
  return p.year + "-" + String(p.month).padStart(2, "0") + "-" + String(p.day).padStart(2, "0");
}
