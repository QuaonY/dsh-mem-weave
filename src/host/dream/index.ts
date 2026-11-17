/**
 * dream 模块 —— 从 host/service.ts 纯搬迁（行为不变）。
 * 收梭管线（consolidate / maybeDream）、运行配置与状态、日志清理
 * 以及 的待整理队列（缺检索词 / 待归纳）与 S3 提示。
 */
import type { Actor, ErrCode, MemoryEntry, PersonaRow } from "../../core/types";
import type { Level } from "../../core/types";
import { localYmd } from "../../core/promise";
import { matchSensitive } from "../../core/sensitive";
import type { WriteInput } from "../../store/govern";
import { addAudit, appendUndo, getDistillGroup, insertCandidate as insertCandidateRow, listDistillGroups, setDistillStatus } from "../../store/dao";
import {
  DISTILL_CAND_REASON,
  coverage as distillCoverage,
  groupMembers,
  landDistill,
  termsBacklog,
  termsBacklogCount,
  type DistillUndo,
} from "../../store/distill-queue";
import { baseCandidate, hasCandidate } from "../../store/dream-rounds";
import {
  consolidateNow,
  dreamState,
  isPeakHour,
  lastActivityAt,
  resetDreamFailures,
  runDream,
  type DreamConfigLike,
  type DreamReport,
  type DreamStateRow,
} from "../../store/dream";
import { pruneRecallLog as pruneRecallLogRows } from "../../store/link";
import { RECALL_LOG_KEEP_DAYS } from "../../store/link";
import type { WeaveEnv } from "../../store/db";

export interface DreamHost {
  env: WeaveEnv;
  config: import("../service").WeaveConfig;
  warn: ((m: string) => void) | null;
  timeZone(): string;
  persona(): PersonaRow;
}

/** 待整理队列的依赖：写入口与敏感词判断留在 service，这里只收闭包 */
export interface DistillDeps {
  env: WeaveEnv;
  config: import("../service").WeaveConfig;
  remember(
    input: WriteInput,
    actor: Actor,
    meta?: { searchTerms?: unknown },
  ): Promise<{ ok: boolean; code?: ErrCode; message?: string; id?: string; verdict?: string; warn?: string }>;
  termsSensitive(): { custom?: string[]; disabled?: string[] };
  scheduleMirror(): void;
}

export function openGroups(
  env: WeaveEnv,
  groupMin: number,
): Array<{ id: string; reason: string | null; members: MemoryEntry[] }> {
  const out: Array<{ id: string; reason: string | null; members: MemoryEntry[] }> = [];
  for (const g of listDistillGroups(env, "open")) {
    if (hasCandidate(env, DISTILL_CAND_REASON + ":" + g.id, "pending")) continue;
    const members = groupMembers(env, g);
    const single = members.length === 1 && g.reason === "consolidated";
    if (!single && members.length < groupMin) continue;
    out.push({ id: g.id, reason: g.reason, members });
  }
  return out;
}

export function backlogCounts(host: Pick<DreamHost, "env" | "config">): { terms: number; groups: number } {
  return {
    terms: host.config.searchTerms.enabled ? termsBacklogCount(host.env) : 0,
    groups: host.config.distill.enabled ? openGroups(host.env, host.config.distill.groupMin).length : 0,
  };
}

/** weave_backlog：最多 20 条待补检索词 + 3 组待归纳（正文按数据给出） */
export function backlog(host: Pick<DreamHost, "env" | "config">): {
  terms: Array<{ id: string; level: Level; content: string }>;
  groups: Array<{ groupId: string; reason: string | null; members: Array<{ id: string; level: Level; content: string }> }>;
  counts: { terms: number; groups: number };
} {
  const { env, config } = host;
  const terms = config.searchTerms.enabled
    ? termsBacklog(env, Math.min(20, config.searchTerms.backfillPerDream || 20)).map((e) => ({ id: e.id, level: e.level, content: e.content }))
    : [];
  const groups = config.distill.enabled
    ? openGroups(env, config.distill.groupMin)
        .slice(0, 3)
        .map((g) => ({ groupId: g.id, reason: g.reason, members: g.members.map((e) => ({ id: e.id, level: e.level, content: e.content })) }))
    : [];
  return { terms, groups, counts: backlogCounts(host) };
}

/**
 * S2 weave_distill：提交归纳或跳过。
 * 敏感词直接拒；覆盖率 < coverage 转 L2 候选交主人审；否则照常过四级把关写 topic（section=distilled）
 * 成员建 merged 边并归档，写撤销台账。
 */
export async function submitDistill(
  deps: DistillDeps,
  a: { groupId: string; summary?: string; keywords?: string[]; searchTerms?: unknown; skip?: boolean },
  actor: string,
): Promise<{ ok: boolean; code?: ErrCode; message?: string; id?: string; verdict?: string; candidateId?: string; coverage?: number; undoId?: string; warn?: string }> {
  const { env, config } = deps;
  const cfg = config.distill;
  if (!cfg.enabled) return { ok: false, code: "E_PERM", message: "distill disabled" };
  const g = getDistillGroup(env, a.groupId);
  if (!g) return { ok: false, code: "E_VALID", message: "group not found" };
  if (g.status !== "open") return { ok: false, code: "E_VALID", message: "group is " + g.status };
  if (a.skip) {
    await env.withWrite(() => {
      setDistillStatus(env, g.id, "skipped");
      addAudit(env, { actor, action: "distill.skip", target: g.id });
    });
    return { ok: true, verdict: "skipped" };
  }
  const summary = (a.summary ?? "").trim();
  if (summary.length === 0) return { ok: false, code: "E_VALID", message: "summary required (or skip: true)" };
  if ([...summary].length > cfg.maxChars) return { ok: false, code: "E_VALID", message: "summary exceeds " + cfg.maxChars + " chars" };
  const sens = deps.termsSensitive();
  if (matchSensitive(summary, sens.custom, sens.disabled)) return { ok: false, code: "E_SENSITIVE", message: "summary contains sensitive content" };
  const members = groupMembers(env, g);
  if (members.length === 0) return { ok: false, code: "E_VALID", message: "group members no longer active" };
  const cov = distillCoverage(summary, members);
  const project = members[0].project;
  const importance = Math.max(...members.map((m) => m.importance));
  const keywords = Array.isArray(a.keywords) ? a.keywords.map(String).slice(0, 10) : undefined;
  if (cov < cfg.coverage) {
    // 「不许编新事实」：零依赖启发式只挡明显的编造 → 交主人审，接受后再落地
    const key = DISTILL_CAND_REASON + ":" + g.id;
    const c = baseCandidate(
      {
        level: "topic",
        project,
        content: summary,
        keywords: keywords ?? [],
        importance,
        semanticKey: key,
        reason: DISTILL_CAND_REASON,
        evidence: [{ kind: "distill", groupId: g.id, coverage: Math.round(cov * 100) / 100, members: g.memberIds } as unknown as MemoryEntry["evidence"][number]],
      },
      Date.now(),
    );
    await env.withWrite(() => {
      insertCandidateRow(env, c);
      addAudit(env, { actor, action: "distill.review", target: g.id, after: c.id, reason: "coverage " + cov.toFixed(2) });
    });
    return { ok: true, verdict: "pending", candidateId: c.id, coverage: cov };
  }
  const r = await landSummary(deps, g.id, summary, keywords, a.searchTerms, project, importance, actor);
  return r.ok ? { ...r, coverage: cov } : r;
}

/** 归纳正文照常过四级把关写入；通过（accepted / merged）后落地成员归档与边 */
async function landSummary(
  deps: DistillDeps,
  groupId: string,
  summary: string,
  keywords: string[] | undefined,
  searchTerms: unknown,
  project: string | null,
  importance: number,
  actor: string,
): Promise<{ ok: boolean; code?: ErrCode; message?: string; id?: string; verdict?: string; undoId?: string; warn?: string }> {
  const { env } = deps;
  const out = await deps.remember(
    { level: "topic", project, section: "distilled", content: summary, keywords, importance },
    actor === "human" ? "human" : "agent",
    searchTerms !== undefined ? { searchTerms } : undefined,
  );
  if (!out.ok || !out.id) return { ok: false, code: out.code ?? "E_VALID", message: out.message ?? "distill write rejected" };
  if (out.verdict !== "accepted" && out.verdict !== "merged") {
    return { ok: true, id: out.id, verdict: out.verdict, ...(out.warn ? { warn: out.warn } : {}) };
  }
  const summaryId = out.id;
  const undoId = await env.withWrite(() => {
    const g = getDistillGroup(env, groupId)!;
    const members = groupMembers(env, g).filter((m) => m.id !== summaryId);
    const u: DistillUndo = { ...landDistill(env, summaryId, g, members, actor, Date.now()), created: out.verdict === "accepted" };
    addAudit(env, { actor, action: "distill.land", target: summaryId, after: JSON.stringify({ group: groupId, members: u.memberIds }) });
    return appendUndo(env, { actor, action: "distill.land", target: summaryId, payload: u });
  });
  deps.scheduleMirror();
  return { ok: true, id: summaryId, verdict: out.verdict, undoId, ...(out.warn ? { warn: out.warn } : {}) };
}

/** S3 的【待整理】提示：每会话每天最多一次，数量没变不再提示（无变化零注入，F1） */
export class CuratePrompter {
  private shown = new Map<string, { day: string; key: string }>();
  /**
   * 待整理数量快照：只在 dream 跑完时更新（都是 dream 轮产出）。
   * 不用实时数量，否则每写一条新记忆「缺检索词」就 +1，下一轮立刻出提示，破坏无变化零注入。
   */
  private snapshot: { terms: number; groups: number } | null = null;

  refresh(host: Pick<DreamHost, "env" | "config">): void {
    try {
      this.snapshot = backlogCounts(host);
    } catch {
      this.snapshot = null;
    }
  }

  /** S3 末尾的【待整理】一行；不该出现时返回空串 */
  line(
    host: Pick<DreamHost, "config" | "timeZone">,
    sessionId: string,
    now: number = Date.now(),
  ): string {
    const cu = host.config.curate;
    if (!cu.enabled) return "";
    const n = this.snapshot;
    if (!n || (n.terms === 0 && n.groups === 0)) return "";
    const key = n.terms + "/" + n.groups;
    const day = localYmd(now, host.timeZone());
    const prev = this.shown.get(sessionId);
    if (prev && prev.key === key) return "";
    if (prev && cu.promptOncePerDay && prev.day === day) return "";
    this.shown.set(sessionId, { day, key });
    if (this.shown.size > 500) {
      const first = this.shown.keys().next().value;
      if (first !== undefined && first !== sessionId) this.shown.delete(first);
    }
    const tail = cu.autoProcess ? "主人空闲或聊完时可顺手用 weave_backlog 处理" : "主人说「整理一下」后再用 weave_backlog 处理";
    return "【待整理】" + n.terms + " 条缺检索词、" + n.groups + " 组可归纳；" + tail;
  }
}

/** dream 运行配置：dream 段 + lifecycle（冷合并窗口月数/合并开关）合并 */
export function dreamCfg(host: DreamHost): DreamConfigLike {
  const { config } = host;
  return {
    ...config.dream,
    coldMemoryMonths: config.lifecycle.coldMemoryMonths,
    mergeOnDream: config.lifecycle.mergeOnDream,
    coRecall: config.links?.coRecall,
    boost: config.lifecycle.boost,
    staleAskDays: config.lifecycle.staleAskDays,
    distill: config.lifecycle.distill,
    maxCandidatesPerDream: config.lifecycle.maxCandidatesPerDream,
    promise: config.promise,
    groupDistill: config.distill,
    searchTerms: config.searchTerms,
    localTimeZone: host.timeZone(),
    contracts: (() => {
      try {
        return host.persona().config.contracts ?? [];
      } catch {
        return [];
      }
    })(),
  };
}

/** recall_log 只保留 logKeepDays（默认 90）天 */
export function pruneRecallLog(host: DreamHost, now: number = Date.now()): number {
  try {
    return pruneRecallLogRows(host.env, host.config.recall?.logKeepDays ?? RECALL_LOG_KEEP_DAYS, now);
  } catch (e) {
    host.warn?.("recall_log prune failed: " + String(e));
    return 0;
  }
}

/** 清理过期的审计日志、预算账本、撤销记录、候选、冲突 */
export function pruneGovernanceLogs(
  host: DreamHost,
  now: number = Date.now(),
): { audit: number; budget: number; undo: number; candidates: number; conflicts: number } {
  const { env, config } = host;
  const result = { audit: 0, budget: 0, undo: 0, candidates: 0, conflicts: 0 };
  const cfg = config.governance;

  try {
    if (cfg.auditKeepDays) {
      const cutoff = now - cfg.auditKeepDays * 86400000;
      const r = env.db.prepare("DELETE FROM audit_log WHERE ts < ?").run(cutoff);
      result.audit = Number(r.changes ?? 0);
    }
  } catch (e) {
    host.warn?.("audit_log prune failed: " + String(e));
  }

  try {
    if (cfg.budgetKeepDays) {
      const cutoff = now - cfg.budgetKeepDays * 86400000;
      const r = env.db.prepare("DELETE FROM budget_ledger WHERE ts < ?").run(cutoff);
      result.budget = Number(r.changes ?? 0);
    }
  } catch (e) {
    host.warn?.("budget_ledger prune failed: " + String(e));
  }

  try {
    if (cfg.undoKeepDays) {
      const cutoff = now - cfg.undoKeepDays * 86400000;
      const r = env.db.prepare("DELETE FROM undo_log WHERE ts < ?").run(cutoff);
      result.undo = Number(r.changes ?? 0);
    }
  } catch (e) {
    host.warn?.("undo_log prune failed: " + String(e));
  }

  try {
    if (cfg.candidateKeepDays) {
      const cutoff = now - cfg.candidateKeepDays * 86400000;
      const r = env.db.prepare("DELETE FROM candidates WHERE verdict != 'pending' AND created_at < ?").run(cutoff);
      result.candidates = Number(r.changes ?? 0);
    }
  } catch (e) {
    host.warn?.("candidates prune failed: " + String(e));
  }

  try {
    if (cfg.conflictKeepDays) {
      const cutoff = now - cfg.conflictKeepDays * 86400000;
      const r = env.db.prepare("DELETE FROM conflicts WHERE status != 'open' AND created_at < ?").run(cutoff);
      result.conflicts = Number(r.changes ?? 0);
    }
  } catch (e) {
    host.warn?.("conflicts prune failed: " + String(e));
  }

  return result;
}

/** forget 窗口结束后清除 undo 原文（保留 id/actor/action 用于审计） */
export function pruneUndoContent(host: DreamHost, now: number = Date.now()): number {
  try {
    const windowMs = host.config.governance.undoWindowHours * 3600000;
    const cutoff = now - windowMs;
    const r = host.env.db.prepare("UPDATE undo_log SET payload = '{}' WHERE ts < ? AND payload != '{}'").run(cutoff);
    return Number(r.changes ?? 0);
  } catch (e) {
    host.warn?.("undo content prune failed: " + String(e));
    return 0;
  }
}

/** 手动触发（weave_consolidate / /weave dream）：与自动 dream 同一管线；resetFailures 解除失败上限 */
export function consolidate(
  host: DreamHost,
  actor: string = "dream",
  opts?: { resetFailures?: boolean },
): DreamReport {
  if (opts?.resetFailures === true) {
    try {
      resetDreamFailures(host.env);
    } catch {
      // 只读库等异常：继续尝试跑，结果里会带原因
    }
  }
  const r = consolidateNow(host.env, dreamCfg(host), actor);
  if (r.ran) pruneRecallLog(host);
  return r;
}

/** 自动 dream 入口：空闲 ≥idleMinutes 且非峰时才跑（定时器调用） */
export function maybeDream(host: DreamHost): DreamReport {
  const r = runDream(host.env, dreamCfg(host), "dream");
  if (r.ran) {
    pruneRecallLog(host);
    pruneGovernanceLogs(host);
    pruneUndoContent(host);
  }
  return r;
}

export function dreamStatus(host: DreamHost): DreamStateRow & { due: boolean; peak: boolean } {
  const st = dreamState(host.env);
  const idleMs = host.config.dream.idleMinutes * 60000;
  const now = Date.now();
  return {
    ...st,
    peak: isPeakHour(now, host.config.dream.timezone, host.config.dream.peakHours),
    due: host.config.dream.enabled === true && now - lastActivityAt(host.env) >= idleMs,
  };
}
