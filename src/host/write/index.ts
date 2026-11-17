/**
 * write 模块 —— 从 host/service.ts 纯搬迁（行为不变）。
 * 写入主链（remember 四级把关 → 情绪/约定/锚点/检索词附加）
 * 设置页编辑（setTerms / annotate / setAnchor / settlePromise / setFlash）
 * 修订与归档、撤销台账执行。
 */
import { addAudit, appendUndo, archiveMemory, countFlashSince, decideCandidate, findActiveByHash, findConflictingSemanticKey, forgetMemory, getMemory, getUndo, insertMemory, listCandidates, listMemory, listUndo, markUndoDone, newId, reopenConflict, restoreMemory, reviseMemory, setAnchor as setAnchorRow, setCandidateVerdict, setFlash as setFlashRow, setPromise as setPromiseRow, setSearchTerms as setSearchTermsRow } from "../../store/dao";
import { LAYER_TABLES } from "../../store/schema";
import { writeMemory, scanSensitiveContent, MAX_CONTENT, type WriteInput, type WriteOutcome } from "../../store/govern";
import { sessionTag } from "../../store/link";
import { recordViolation } from "../../store/review";
import { bumpRelation as bumpRelationStore } from "../../store/relation";
import { undoDreamC } from "../../store/dream-rounds";
import { undoDistill, type DistillUndo } from "../../store/distill-queue";
import { PROMISE_DUE_REASON } from "../../core/promise";
import { checkDue, isPending, looksFulfilled, promiseLabelOf, PROMISE_LABEL_MAX } from "../../core/promise";
import { parseDue } from "../../core/localdate";
import { normalizeAnchor } from "../../core/calendar";import { normalizeTerms, termsWarn, unionTerms } from "../../core/terms";
import { mergeAliasGroups, tokenize } from "../../core/tokenize";
import { contentHash } from "../../core/hash";
import { DEFAULT_PRIVACY_CONFIG } from "../../privacy/types";
import type { SensitivityDetector } from "../../privacy/detector";
import type { FileLogger } from "../logger";
import type { WeaveEnv } from "../../store/db";
import type {
  Actor,
  CalendarAnchor,
  EntryStatus,
  ErrCode,
  Level,
  MemoryEntry,
  PersonaRow,
  PromiseState,
} from "../../core/types";

export interface WriteHost {
  env: WeaveEnv;
  config: import("../service").WeaveConfig;
  warn: ((m: string) => void) | null;
  logger: FileLogger | null;
  sensitivityDetector: SensitivityDetector | null;
  timeZone(): string;
  persona(): PersonaRow;
  listMemory(f: Parameters<typeof listMemory>[1]): MemoryEntry[];
  fileAliasGroups(): string[][];
  noteSessionWrite(sessionId: string, id: string): void;
  markSensitiveOnWrite(id: string, level: Level): void;
  scheduleMirror(): void;
}

/** 检索词敏感词检查沿用写入把关的配置（"default" = 只用内置规则） */
export function termsSensitive(config: WriteHost["config"]): { custom?: string[]; disabled?: string[] } {
  const g = config.governance;
  return {
    custom: Array.isArray(g.sensitivePatterns) ? g.sensitivePatterns : undefined,
    disabled: g.disabledSensitive,
  };
}

export async function remember(
  host: WriteHost,
  input: WriteInput,
  actor: Actor,
  meta?: {
    sessionId?: string;
    turn?: number;
    violatesContract?: string;
    /** 写入方给的情绪值 */ valence?: number;
    arousal?: number;
    /** 约定到期（绝对时间：UTC 毫秒或 ISO 字符串） */ dueAt?: number | string;
    promiseLabel?: string;
    /** 日历锚点 */ anchor?: unknown;
    /** 检索词 */ searchTerms?: unknown;
  },
): Promise<WriteOutcome> {
  // 隐私保护 - 检测敏感信息
  const privacyConfig = host.config.privacy ?? DEFAULT_PRIVACY_CONFIG;
  let isSensitive = false;
  let sensitiveInfo: import("../../privacy/types").SensitiveInfo[] = [];

  if (privacyConfig.enabled && privacyConfig.detectPII && host.sensitivityDetector) {
    sensitiveInfo = host.sensitivityDetector.detect(input.content, privacyConfig);
    isSensitive = sensitiveInfo.length > 0;

    if (isSensitive) {
      // 记录审计日志
      host.logger?.info("[Privacy] Sensitive info detected in write", {
        types: sensitiveInfo.map((s) => s.type).join(","),
        count: sensitiveInfo.length,
        level: input.level,
      });

      // 严格模式：拒绝写入
      if (privacyConfig.strictMode) {
        return {
          ok: false,
          code: "E_SENSITIVE" as ErrCode,
          message: `Sensitive information detected: ${sensitiveInfo.map((s) => s.type).join(", ")}. Blocked by privacy strict mode.`,
        };
      }
    }
  }

  // 附录 A governance/recall 配置注入：autoAcceptLowRisk / requireConfirmFor / sensitivePatterns / synonymsFile
  const g = host.config.governance;
  const w = host.config.write;
  const tag = input.sessionTag ?? (meta?.sessionId ? sessionTag(meta.sessionId, meta.turn) : null);
  const extraSensitive = Array.isArray(g.sensitivePatterns) ? g.sensitivePatterns : undefined;
  const out = await writeMemory(
    host.env,
    {
      ...input,
      autoAccept: input.autoAccept ?? g.autoAcceptLowRisk,
      requireConfirmFor: input.requireConfirmFor ?? g.requireConfirmFor,
      extraSensitive: input.extraSensitive ?? extraSensitive,
      disabledSensitive: input.disabledSensitive ?? g.disabledSensitive,
      extraAliasGroups: mergeAliasGroups(input.extraAliasGroups, host.fileAliasGroups()),
      containment: input.containment ?? w?.containment,
      surprise: input.surprise ?? w?.surprise?.enabled,
      sourceWeight: input.sourceWeight ?? w?.sourceWeight?.enabled,
      sessionTag: tag,
      autoLink: input.autoLink ?? host.config.links?.autoLink,
    },
    actor,
  );
  if (out.warn) host.warn?.(out.warn);
  if (meta?.sessionId && out.ok && out.id && out.verdict !== "pending") host.noteSessionWrite(meta.sessionId, out.id);

  // 标记敏感记忆
  if (out.ok && out.id && isSensitive && (out.verdict === "accepted" || out.verdict === "merged")) {
    try {
      host.markSensitiveOnWrite(out.id, input.level);
      host.logger?.info("[Privacy] Memory marked as sensitive", { id: out.id, level: input.level });
    } catch (e) {
      host.warn?.("Failed to mark memory as sensitive: " + String(e));
    }
  }

  // 照常过完四级把关之后才写情绪值（闪光灯不豁免任何一步）；失败不回滚写入
  if (out.ok && out.id && out.verdict === "accepted" && (meta?.valence !== undefined || meta?.arousal !== undefined)) {
    try {
      applyEmotion(host, out.id, meta?.valence, meta?.arousal, actor);
    } catch (e) {
      host.warn?.("emotion write failed: " + String(e));
    }
  }
  // 过完四级把关后才附加约定与锚点；字段非法只拒字段、记忆照常写入
  const fieldWarn: string[] = [];
  if (out.ok && out.id && (meta?.dueAt !== undefined || meta?.anchor !== undefined)) {
    if (out.verdict === "pending") {
      fieldWarn.push("dueAt/anchor not applied: memory is waiting for review");
    } else if (out.verdict === "accepted" || out.verdict === "merged") {
      try {
        if (meta?.dueAt !== undefined) {
          const w2 = applyDue(host, out.id, meta.dueAt, meta.promiseLabel, actor, out.verdict === "merged");
          if (w2) fieldWarn.push(w2);
        }
        if (meta?.anchor !== undefined) {
          const w3 = applyAnchorField(host, out.id, meta.anchor, actor);
          if (w3) fieldWarn.push(w3);
        }
      } catch (e) {
        fieldWarn.push("promise/anchor write failed: " + String(e));
      }
    }
  }
  // 检索词同样在把关之后附加；不参与去重 / 合并 / semanticKey 判断
  if (out.ok && out.id && meta?.searchTerms !== undefined && host.config.searchTerms.enabled) {
    if (out.verdict === "pending") {
      fieldWarn.push("searchTerms not applied: memory is waiting for review");
    } else if (out.verdict === "accepted" || out.verdict === "merged") {
      try {
        const w4 = applyTerms(host, out.id, meta.searchTerms, actor, out.verdict === "merged");
        if (w4) fieldWarn.push(w4);
      } catch (e) {
        fieldWarn.push("searchTerms write failed: " + String(e));
      }
    }
  }
  // 本轮写入像是「已经做了某个约定」→ 轮后通知提示，不自动结算
  if (out.ok && out.id && out.verdict !== "pending" && host.config.promise.enabled && meta?.dueAt === undefined) {
    try {
      hintFulfilled(host, input.content, out.id, actor);
    } catch {
      // 提示失败不影响写入
    }
  }
  if (fieldWarn.length > 0) {
    for (const m of fieldWarn) host.warn?.(m);
    (out as WriteOutcome & { warn?: string }).warn = [out.warn, ...fieldWarn].filter(Boolean).join("; ");
  }
  // lesson 标注违反的契约 → 记一次违反（契约须存在；pending 也算，纠正事实已发生）
  if (meta?.violatesContract && out.ok && out.id && input.level === "lesson") {
    try {
      const all = (host.persona().config.contracts ?? []).filter((c) => c);
      // 提示词里契约按启用顺序编号（1. 2. …）：接受序号或 id
      const shown = all.filter((c) => c.on !== false && typeof c.text === "string" && c.text.trim() !== "");
      const ref = meta.violatesContract.trim();
      const hit = /^\d+$/.test(ref) ? shown[Number(ref) - 1] : all.find((c) => c.id === ref);
      if (hit) recordViolation(host.env, hit.id, out.id, actor, meta.sessionId);
      else host.warn?.("violatesContract: unknown contract " + ref);
    } catch (e) {
      host.warn?.("violation record failed: " + String(e));
    }
  }
  host.scheduleMirror();
  return out;
}

/**
 * 记下情绪值；arousal ≥ flashArousal 且今天的闪光灯没到上限 → flash=1。
 * 超出上限按 0 处理并记审计。emotion 关着时什么都不写。
 */
export function applyEmotion(host: WriteHost, id: string, valence: number | undefined, arousal: number | undefined, actor: string): void {
  const cfg = host.config.emotion;
  if (!cfg?.enabled) return;
  const e = getMemory(host.env, id);
  if (!e) return;
  const v = typeof valence === "number" && Number.isFinite(valence) ? Math.max(-1, Math.min(1, valence)) : null;
  const a = typeof arousal === "number" && Number.isFinite(arousal) ? Math.max(0, Math.min(1, arousal)) : null;
  let flash = a !== null && a >= cfg.flashArousal;
  if (flash) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    if (countFlashSince(host.env, d.getTime()) >= cfg.dailyFlashCap) {
      flash = false;
      addAudit(host.env, { actor, action: "memory.flash-capped", target: id, reason: "daily cap " + cfg.dailyFlashCap });
    }
  }
  host.env.db
    .prepare("UPDATE " + LAYER_TABLES[e.level] + " SET valence = ?, arousal = ?, flash = ? WHERE id = ?")
    .run(v, a, flash ? 1 : 0, id);
  if (flash) addAudit(host.env, { actor, action: "memory.flash", target: id });
}

/** 写约定字段；返回 warn（字段被拒）或 null */
export function applyDue(host: WriteHost, id: string, raw: number | string, label: string | undefined, actor: string, merged: boolean): string | null {
  const cfg = host.config.promise;
  if (!cfg.enabled) return "dueAt ignored: promise disabled";
  const e = getMemory(host.env, id);
  if (!e) return "dueAt ignored: memory not found";
  const now = Date.now();
  const due = parseDue(raw, host.timeZone());
  if (due === null) return "dueAt rejected: must be an absolute date (YYYY-MM-DD or YYYY-MM-DDTHH:mm)";
  const bad = checkDue(due, now, cfg);
  if (bad) return "dueAt rejected: " + bad;
  // 近似合并：两者都有约定时取较早的那个
  const next = merged && isPending(e) ? Math.min(e.dueAt!, due) : due;
  const lbl = typeof label === "string" && label.trim() ? label.trim().slice(0, PROMISE_LABEL_MAX) : e.promiseLabel ?? null;
  writePromise(host, e, { dueAt: next, state: "pending", label: lbl }, actor, "memory.promise");
  return null;
}

export function writePromise(host: WriteHost, e: MemoryEntry, p: { dueAt: number | null; state: PromiseState; label: string | null }, actor: string, action: string): void {
  setPromiseRow(host.env, e.level, e.id, p);
  addAudit(host.env, { actor, action, target: e.id, before: e.promiseState ?? "none", after: p.state + (p.dueAt ? "@" + new Date(p.dueAt).toISOString() : "") });
  appendUndo(host.env, {
    actor,
    action: "memory.promise",
    target: e.id,
    payload: { before: { dueAt: e.dueAt ?? null, state: e.promiseState ?? "none", label: e.promiseLabel ?? null } },
  });
}

/** 写锚点字段；返回 warn 或 null */
export function applyAnchorField(host: WriteHost, id: string, raw: unknown, actor: string): string | null {
  const e = getMemory(host.env, id);
  if (!e) return "anchor ignored: memory not found";
  if (raw === null) {
    setAnchor(host, id, null, actor);
    return null;
  }
  const n = normalizeAnchor(raw);
  if ("error" in n) return "anchor rejected: " + n.error;
  setAnchor(host, id, n.anchor, actor);
  return null;
}

/**
 * 写入后附加检索词（过完四级把关之后）。
 * merged = 合并命中：与目标已有检索词取并集截到上限。返回 warn 文本（丢词原因）。
 */
export function applyTerms(host: WriteHost, id: string, raw: unknown, actor: string, merged: boolean): string | null {
  const e = getMemory(host.env, id);
  if (!e) return "searchTerms ignored: memory not found";
  const cfg = host.config.searchTerms;
  const n = normalizeTerms(raw, e.content, cfg, termsSensitive(host.config));
  const next = merged ? unionTerms(e.searchTerms, n.terms, cfg.maxTerms) : n.terms;
  const before = e.searchTerms ?? null;
  if (JSON.stringify(next) !== JSON.stringify(before ?? [])) {
    setSearchTermsRow(host.env, e.level, id, next);
    addAudit(host.env, { actor, action: "memory.terms", target: id, after: JSON.stringify(next) });
    appendUndo(host.env, { actor, action: "memory.terms", target: id, payload: { before } });
  }
  return termsWarn(n.dropped);
}

/** 设置页编辑检索词（整体替换；空数组 = 清空）；可撤销 */
export function setTerms(host: WriteHost, id: string, raw: unknown, actor: string): { ok: boolean; code?: ErrCode; message?: string; searchTerms?: string[]; warn?: string } {
  const e = getMemory(host.env, id);
  if (!e) return { ok: false, code: "E_VALID", message: "memory not found" };
  const w = applyTerms(host, id, raw ?? [], actor, false);
  host.scheduleMirror();
  return { ok: true, searchTerms: getMemory(host.env, id)?.searchTerms ?? [], ...(w ? { warn: w } : {}) };
}

/**
 * weave_annotate 批量补词。只补 / 替换检索词，不改正文；
 * 整批写一条撤销台账（24 小时内可撤销）。
 */
export function annotate(
  host: WriteHost,
  items: unknown,
  actor: string,
): { ok: boolean; code?: ErrCode; message?: string; updated: string[]; skipped: Array<{ id: string; reason: string }>; warn?: string; undoId?: string } {
  const list = Array.isArray(items) ? items.slice(0, 50) : [];
  if (list.length === 0) return { ok: false, code: "E_VALID", message: "items must be a non-empty array", updated: [], skipped: [] };
  const cfg = host.config.searchTerms;
  const sens = termsSensitive(host.config);
  const updated: string[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  const undoItems: Array<{ id: string; before: string[] | null }> = [];
  const warns: string[] = [];
  for (const it of list) {
    const o = it && typeof it === "object" ? (it as Record<string, unknown>) : {};
    const id = typeof o.id === "string" ? o.id : "";
    const e = id ? getMemory(host.env, id) : null;
    if (!e) {
      skipped.push({ id, reason: "not found" });
      continue;
    }
    if (e.status !== "active") {
      skipped.push({ id, reason: "not active" });
      continue;
    }
    const n = normalizeTerms(o.searchTerms, e.content, cfg, sens);
    const w = termsWarn(n.dropped);
    if (w) warns.push(id + ": " + w);
    if (n.terms.length === 0) {
      skipped.push({ id, reason: "no valid terms" });
      continue;
    }
    undoItems.push({ id, before: e.searchTerms ?? null });
    setSearchTermsRow(host.env, e.level, id, n.terms);
    updated.push(id);
  }
  let undoId: string | undefined;
  if (updated.length > 0) {
    addAudit(host.env, { actor, action: "memory.annotate", target: updated[0], after: JSON.stringify({ count: updated.length, ids: updated }) });
    undoId = appendUndo(host.env, { actor, action: "memory.terms", target: updated[0], payload: { items: undoItems } });
    host.scheduleMirror();
  }
  return { ok: true, updated, skipped, ...(warns.length > 0 ? { warn: warns.join("; ") } : {}), ...(undoId ? { undoId } : {}) };
}

/** 设置页加 / 删锚点；可撤销 */
export function setAnchor(host: WriteHost, id: string, anchor: unknown, actor: string): { ok: boolean; code?: ErrCode; message?: string } {
  const e = getMemory(host.env, id);
  if (!e) return { ok: false, code: "E_VALID", message: "memory not found" };
  let next: CalendarAnchor | null = null;
  if (anchor !== null && anchor !== undefined) {
    const n = normalizeAnchor(anchor);
    if ("error" in n) return { ok: false, code: "E_VALID", message: n.error };
    next = n.anchor;
  }
  setAnchorRow(host.env, e.level, id, next);
  addAudit(host.env, { actor, action: next ? "memory.anchor" : "memory.unanchor", target: id, after: next ? JSON.stringify(next) : undefined });
  appendUndo(host.env, { actor, action: "memory.anchor", target: id, payload: { before: e.calendarAnchor ?? null } });
  host.scheduleMirror();
  return { ok: true };
}

/**
 * 结算约定（weave_promise / 设置页 / 候选裁决）。
 * kept / broken：改状态；extend：换新的到期日（照常校验）。AI 调用写审计，可撤销。
 */
export function settlePromise(
  host: WriteHost,
  id: string,
  outcome: "kept" | "broken" | "extend",
  actor: string,
  dueAt?: number | string,
): { ok: boolean; code?: ErrCode; message?: string; state?: PromiseState; dueAt?: number | null } {
  const e = getMemory(host.env, id);
  if (!e) return { ok: false, code: "E_VALID", message: "memory not found" };
  if (outcome !== "kept" && outcome !== "broken" && outcome !== "extend") {
    return { ok: false, code: "E_VALID", message: "outcome must be kept|broken|extend" };
  }
  if (outcome === "extend") {
    if (dueAt === undefined) return { ok: false, code: "E_VALID", message: "extend requires dueAt" };
    const due = parseDue(dueAt, host.timeZone());
    if (due === null) return { ok: false, code: "E_VALID", message: "dueAt must be an absolute date (YYYY-MM-DD or YYYY-MM-DDTHH:mm)" };
    const bad = checkDue(due, Date.now(), host.config.promise);
    if (bad) return { ok: false, code: "E_VALID", message: bad };
    writePromise(host, e, { dueAt: due, state: "pending", label: e.promiseLabel ?? null }, actor, "promise.extend");
    closePromiseCandidates(host, e.id, actor);
    host.scheduleMirror();
    return { ok: true, state: "pending", dueAt: due };
  }
  if (!isPending(e)) return { ok: false, code: "E_VALID", message: "memory has no pending promise" };
  writePromise(host, e, { dueAt: e.dueAt ?? null, state: outcome, label: e.promiseLabel ?? null }, actor, "promise." + outcome);
  closePromiseCandidates(host, e.id, actor);
  if (host.config.promise.affectRelation) {
    try {
      bumpRelationStore(host.env, { trustDelta: outcome === "kept" ? 0.05 : -0.05 }, actor);
    } catch {
      // 关系联动失败不影响结算
    }
  }
  host.scheduleMirror();
  return { ok: true, state: outcome, dueAt: e.dueAt ?? null };
}

/** 结算后，还挂着的「确认约定结果」候选一并关掉（不再重复问） */
export function closePromiseCandidates(host: Pick<WriteHost, "env">, memoryId: string, actor: string): void {
  for (const c of listCandidates(host.env, "pending")) {
    if (c.reason === PROMISE_DUE_REASON && c.mergedInto === memoryId) decideCandidate(host.env, c.id, "rejected", actor);
  }
}

/** 关键词重叠 + 「已经做了」语气 → 记一条 promise.hint 审计，轮后通知展示 */
export function hintFulfilled(host: Pick<WriteHost, "env" | "listMemory">, text: string, writtenId: string, actor: string): void {
  const pend = host.listMemory({ status: "active" }).filter((e) => isPending(e) && e.id !== writtenId);
  if (pend.length === 0) return;
  const toks = new Set(tokenize(text));
  for (const p of pend) {
    const ptoks = new Set(tokenize(promiseLabelOf(p) + " " + p.keywords.join(" ")));
    if (looksFulfilled(text, ptoks, toks)) {
      addAudit(host.env, { actor, action: "promise.hint", target: p.id, after: promiseLabelOf(p), reason: "from " + writtenId });
    }
  }
}

/** 设置页取消 / 恢复闪光灯 */
export function setFlash(host: WriteHost, id: string, flash: boolean, actor: string): { ok: boolean; code?: ErrCode; message?: string } {
  const e = getMemory(host.env, id);
  if (!e) return { ok: false, code: "E_VALID", message: "memory not found" };
  setFlashRow(host.env, e.level, id, flash);
  addAudit(host.env, { actor, action: flash ? "memory.flash" : "memory.unflash", target: id });
  appendUndo(host.env, { actor, action: "memory.flash", target: id, payload: { before: e.flash === true } });
  host.scheduleMirror();
  return { ok: true };
}

export async function revise(
  host: WriteHost,
  id: string,
  patch: Partial<MemoryEntry>,
  actor: string,
  expectedUpdatedAt?: number,
): Promise<{ ok: boolean; code?: ErrCode; message?: string }> {
  const current = getMemory(host.env, id);
  if (!current) return { ok: false, code: "E_VALID" as const, message: "memory not found" };
  if (actor === "agent" && (current.level === "rules" || current.level === "soul")) {
    return { ok: false, code: "E_PERM" as const, message: "rules/soul revisions require human review" };
  }
  const allowed = new Set(["project", "section", "content", "keywords", "importance", "status", "semanticKey", "confidence", "validFrom", "validTo", "evidence", "tier"]);
  if (Object.keys(patch as Record<string, unknown>).some((key) => !allowed.has(key))) {
    return { ok: false, code: "E_VALID" as const, message: "revision contains unsupported fields" };
  }
  if (patch.content !== undefined) {
    if (typeof patch.content !== "string" || patch.content.trim().length === 0 || patch.content.trim().length > MAX_CONTENT) {
      return { ok: false, code: "E_VALID" as const, message: "content length invalid (1.." + MAX_CONTENT + ")" };
    }
    const content = patch.content.trim();
    patch = { ...patch, content };

    // revise 也走治理流程
    const g = host.config.governance;

    // 敏感词检查
    const extra = Array.isArray(g.sensitivePatterns) ? g.sensitivePatterns : undefined;
    const sensitive = scanSensitiveContent(content, extra, g.disabledSensitive);
    if (sensitive) return { ok: false, code: "E_SENSITIVE" as const, message: "sensitive pattern matched: " + sensitive };

    // 删除性质检查 (L2 须人确认)
    if (actor === "agent" && /删除|遗忘|作废|废止|不再有效|撤销|清空/.test(content)) {
      return { ok: false, code: "E_DELETE_NATURE" as const, message: "deletion-nature expressions require human review" };
    }

    // 纯推测检查 (L3 拒绝)
    if (/可能|大概|猜测|好像|也许|估计|应该吧/.test(content)) {
      return { ok: false, code: "E_SPECULATION" as const, message: "pure speculation rejected" };
    }

    // strict 模式检查
    const strictMode = host.persona().config.strict === true;
    if (strictMode && actor === "agent") {
      return { ok: false, code: "E_STRICT" as const, message: "strict mode: all agent revisions require human review" };
    }

    // 去重检查
    const duplicate = findActiveByHash(host.env, contentHash(content));
    if (duplicate && duplicate.id !== id) return { ok: false, code: "E_DUP" as const, message: "content duplicates active memory " + duplicate.id };
  }
  if (patch.project !== undefined && patch.project !== null && typeof patch.project !== "string") {
    return { ok: false, code: "E_VALID" as const, message: "project must be a string or null" };
  }
  if (patch.section !== undefined && patch.section !== null && typeof patch.section !== "string") {
    return { ok: false, code: "E_VALID" as const, message: "section must be a string or null" };
  }
  for (const field of ["validFrom", "validTo"] as const) {
    const value = patch[field];
    if (value !== undefined && value !== null && (typeof value !== "number" || !Number.isFinite(value))) {
      return { ok: false, code: "E_VALID" as const, message: field + " must be a finite timestamp or null" };
    }
  }
  const nextValidFrom = patch.validFrom === undefined ? current.validFrom : patch.validFrom;
  const nextValidTo = patch.validTo === undefined ? current.validTo : patch.validTo;
  if (nextValidFrom != null && nextValidTo != null && nextValidTo < nextValidFrom) {
    return { ok: false, code: "E_VALID" as const, message: "validTo must not precede validFrom" };
  }
  if (patch.evidence !== undefined && (!Array.isArray(patch.evidence) || patch.evidence.some((item) =>
    !item || typeof item !== "object" || typeof item.sessionId !== "string" || !Number.isInteger(item.seq) || item.seq < 0 || typeof item.quote !== "string",
  ))) {
    return { ok: false, code: "E_VALID" as const, message: "evidence must contain sessionId, nonnegative seq, and quote" };
  }
  if (patch.importance !== undefined && (!Number.isFinite(patch.importance) || patch.importance < 0 || patch.importance > 5)) {
    return { ok: false, code: "E_VALID" as const, message: "importance must be between 0 and 5" };
  }
  // agent 修改 importance 需要权限检查（防止提升优先级）
  if (patch.importance !== undefined && actor === "agent" && patch.importance > (current.importance ?? 3)) {
    return { ok: false, code: "E_PERM" as const, message: "agent cannot increase importance; human only or at least L2" };
  }

  if (patch.confidence !== undefined && patch.confidence !== null && (!Number.isFinite(patch.confidence) || patch.confidence < 0 || patch.confidence > 1)) {
    return { ok: false, code: "E_VALID" as const, message: "confidence must be between 0 and 1" };
  }
  if (patch.keywords !== undefined && (!Array.isArray(patch.keywords) || patch.keywords.some((word) => typeof word !== "string"))) {
    return { ok: false, code: "E_VALID" as const, message: "keywords must be an array of strings" };
  }
  if (patch.semanticKey !== undefined && patch.semanticKey !== null) {
    if (typeof patch.semanticKey !== "string") return { ok: false, code: "E_VALID" as const, message: "semanticKey must be a string or null" };
    if (findConflictingSemanticKey(host.env, patch.semanticKey).some((entry) => entry.id !== id && entry.content !== (patch.content ?? current.content))) {
      return { ok: false, code: "E_CONFLICT" as const, message: "semantic key conflicts with another memory" };
    }
  }
  if (patch.status !== undefined && actor !== "human") {
    return { ok: false, code: "E_PERM" as const, message: "status changes require the dedicated human or archive workflow" };
  }
  if (patch.status !== undefined && !["active", "stale", "archived"].includes(patch.status)) {
    return { ok: false, code: "E_VALID" as const, message: "invalid memory status" };
  }
  if (patch.tier !== undefined && !["core", "hot", "cold"].includes(patch.tier)) {
    return { ok: false, code: "E_VALID" as const, message: "invalid memory tier" };
  }
  // agent 修改 tier 需要权限检查（防止提升到 core）
  if (patch.tier !== undefined && actor === "agent") {
    const tierRank = { "cold": 0, "hot": 1, "core": 2 };
    const currentRank = tierRank[current.tier ?? "hot"];
    const newRank = tierRank[patch.tier];
    if (newRank > currentRank) {
      return { ok: false, code: "E_PERM" as const, message: "agent cannot promote tier; human only or at least L2" };
    }
  }
  // agent 修改 validTo 需要权限检查（防止延长有效期）
  if (patch.validTo !== undefined && actor === "agent") {
    const currentValidTo = current.validTo ?? Number.MAX_SAFE_INTEGER;
    const newValidTo = patch.validTo ?? Number.MAX_SAFE_INTEGER;
    if (newValidTo > currentValidTo) {
      return { ok: false, code: "E_PERM" as const, message: "agent cannot extend validTo; human only or at least L2" };
    }
  }
  // 撤销台账记下这次真正改动的每个字段的原值（不只 content/keywords），撤销时整组还原
  const UNDO_FIELDS = ["content", "keywords", "project", "section", "semanticKey", "tier", "importance", "status", "validTo"] as const;
  const beforeFields: Record<string, unknown> = {};
  for (const k of UNDO_FIELDS) {
    if (patch[k] !== undefined && JSON.stringify(patch[k]) !== JSON.stringify(current[k])) beforeFields[k] = current[k];
  }

  // revise 使用 withWrite 包装事务
  const r = await host.env.withWrite(() => {
    const result = reviseMemory(host.env, id, patch, actor, expectedUpdatedAt);
    if (result.ok && Object.keys(beforeFields).length > 0) {
      appendUndo(host.env, {
        actor,
        action: "memory.update",
        target: id,
        payload: { before: beforeFields },
      });
    }
    return result;
  });

  // 事件驱动：主人纠正正文 → 关系小步下调（单次 ±0.05、每日 ±0.15 封顶）；只改分层、项目等整理动作不算纠正
  if (r.ok && actor === "human" && "content" in beforeFields) {
    try {
      bumpRelationStore(host.env, { trustDelta: -0.05 }, actor);
    } catch {
      // 状态更新失败不影响主流程
    }
  }
  host.scheduleMirror();
  return r;
}

export async function archive(host: WriteHost, id: string, actor: string): Promise<void> {
  // archive 使用 withWrite 包装事务
  await host.env.withWrite(() => {
    const before = getMemory(host.env, id);
    archiveMemory(host.env, id, actor);
    appendUndo(host.env, {
      actor,
      action: "memory.archive",
      target: id,
      payload: { beforeStatus: before?.status ?? "active" },
    });
  });
  host.scheduleMirror();
}

export async function restore(host: WriteHost, id: string, actor: string): Promise<void> {
  // restore 使用 withWrite 包装事务
  await host.env.withWrite(() => {
    restoreMemory(host.env, id, actor);
    appendUndo(host.env, { actor, action: "memory.restore", target: id, payload: {} });
  });
  host.scheduleMirror();
}

export async function forget(host: WriteHost, id: string, actor: string): Promise<void> {
  // forget 是唯一真删除：台账存整条原文，撤销时按原 id 重插（自动动作 100% 可撤销）
  // forget 使用 withWrite 包装事务
  await host.env.withWrite(() => {
    const before = getMemory(host.env, id);
    forgetMemory(host.env, id, actor);
    appendUndo(host.env, { actor, action: "memory.forget", target: id, payload: { before } });
  });
  host.scheduleMirror();
}

/** 可撤销动作列表（窗口 = governance.undoWindowHours，默认 24h） */
export function undoList(host: WriteHost, hours?: number): ReturnType<typeof listUndo> {
  const win = Math.max(1, hours ?? host.config.governance.undoWindowHours);
  return listUndo(host.env, Date.now() - win * 3600000);
}

/** 执行一条撤销（只回滚台账里的逆操作；同一条只生效一次） */
export async function undo(
  host: WriteHost,
  id: string,
  actor: string = "human",
): Promise<{ ok: boolean; code?: ErrCode; message?: string; action?: string }> {
  const result = await host.env.withWrite(() => {
    const row = getUndo(host.env, id);
    if (!row) return { ok: false as const, code: "E_VALID" as const, message: "undo record not found" };
    if (row.undone) return { ok: false as const, code: "E_VALID" as const, message: "already undone" };
    const win = Math.max(1, host.config.governance.undoWindowHours) * 3600000;
    if (Date.now() - row.ts > win) {
      return {
        ok: false as const,
        code: "E_PERM" as const,
        message: "undo window (" + host.config.governance.undoWindowHours + "h) expired",
      };
    }
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(row.payload) as Record<string, unknown>;
    } catch {
      payload = {};
    }
    switch (row.action) {
      case "memory.write":
        archiveMemory(host.env, row.target, actor);
        break;
      case "dream.links":
      case "dream.co-recall":
      case "dream.boost":
        undoDreamC(host.env, row.action, payload);
        break;
      case "memory.flash": {
        const e = getMemory(host.env, row.target);
        if (e) setFlashRow(host.env, e.level, e.id, payload.before === true);
        break;
      }
      case "memory.promise": {
        const e = getMemory(host.env, row.target);
        const b = payload.before as { dueAt?: number | null; state?: PromiseState; label?: string | null } | undefined;
        if (e && b) setPromiseRow(host.env, e.level, e.id, { dueAt: b.dueAt ?? null, state: b.state ?? "none", label: b.label ?? null });
        break;
      }
      case "memory.anchor": {
        const e = getMemory(host.env, row.target);
        if (e) setAnchorRow(host.env, e.level, e.id, (payload.before as CalendarAnchor | null | undefined) ?? null);
        break;
      }
      case "memory.terms": {
        // 单条或整批（weave_annotate）检索词回到原值
        const list = Array.isArray(payload.items)
          ? (payload.items as Array<{ id: string; before: string[] | null }>)
          : [{ id: row.target, before: (payload.before as string[] | null | undefined) ?? null }];
        for (const it of list) {
          const e = getMemory(host.env, it.id);
          if (e) setSearchTermsRow(host.env, e.level, e.id, it.before ?? null);
        }
        break;
      }
      case "distill.land":
        // 成员恢复 active、删新条目和边、组回到 open
        undoDistill(host.env, payload as unknown as DistillUndo, actor);
        break;
      case "memory.update":
      case "dream.status": {
        const before = payload.before as Partial<MemoryEntry> | undefined;
        if (before) reviseMemory(host.env, row.target, before, actor);
        break;
      }
      case "memory.archive": {
        // 归档前是 stale 的回到 stale，不一律变 active
        const before = payload.beforeStatus;
        if (before === "stale") reviseMemory(host.env, row.target, { status: "stale" }, actor);
        else restoreMemory(host.env, row.target, actor);
        break;
      }
      case "conflict.resolve": {
        // 败者回到原状态、裁决时落成的新记忆撤掉、冻结候选回到 frozen、冲突回到 open
        const p = payload as { conflictId?: string; archived?: Array<{ id: string; before: EntryStatus }>; candidates?: string[]; created?: string | null };
        for (const a of p.archived ?? []) {
          if (a.before === "active") restoreMemory(host.env, a.id, actor);
          else reviseMemory(host.env, a.id, { status: a.before }, actor);
        }
        if (p.created) archiveMemory(host.env, p.created, actor);
        for (const cid of p.candidates ?? []) setCandidateVerdict(host.env, cid, "frozen");
        reopenConflict(host.env, p.conflictId ?? row.target);
        break;
      }
      case "memory.forget": {
        // 真删除已无行可 restore：按台账原文重插（保留原 id/层级/时间戳）
        const before = payload.before as MemoryEntry | undefined;
        if (before && before.id === row.target) {
          insertMemory(host.env, { ...before, id: row.target });
        }
        break;
      }
      case "memory.restore":
        archiveMemory(host.env, row.target, actor);
        break;
      case "dream.merge": {
        // 逆冷合并：撤摘要 + 还原被归档的成员
        archiveMemory(host.env, String(payload.summaryId ?? row.target), actor);
        for (const mid of (payload.memberIds as string[] | undefined) ?? []) {
          restoreMemory(host.env, mid, actor);
        }
        break;
      }
      case "govern.resurrect": {
        // 被近似合并吞掉的原文复活为新条目（weave_restore「找回被吞原文」）
        const content = String(payload.content ?? "");
        if (content.length > 0) {
          const ts = Date.now();
          insertMemory(host.env, {
            id: newId(),
            level: (payload.level as Level) ?? "fact",
            project: (payload.project as string | null) ?? null,
            section: (payload.section as string | null) ?? null,
            content,
            keywords: (payload.keywords as string[] | null) ?? [],
            importance: Number(payload.importance ?? 3),
            status: "active",
            semanticKey: (payload.semanticKey as string | null) ?? null,
            confidence: null,
            validFrom: ts,
            validTo: (payload.validTo as number | null) ?? null,
            evidence: (payload.evidence as MemoryEntry["evidence"]) ?? [],
            hash: contentHash(content),
            source: actor,
            accessCount: 0,
            tier: (payload.tier as MemoryEntry["tier"]) ?? "hot",
            createdAt: ts,
            updatedAt: ts,
          });
        }
        break;
      }
      default:
        return {
          ok: false as const,
          code: "E_UNAVAILABLE" as const,
          message: "unknown undo action: " + row.action,
        };
    }
    markUndoDone(host.env, id, Date.now());
    addAudit(host.env, {
      actor,
      action: "undo.run",
      target: row.action + ":" + row.target,
      after: "undone",
      reason: row.id,
    });
    return { ok: true as const, action: row.action };
  });
  if (result.ok) host.scheduleMirror();
  return result;
}
