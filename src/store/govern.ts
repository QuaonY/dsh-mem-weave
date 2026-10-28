/**
 * 忆织 MemWeave —— 写入治理（规划文档 §8.3 四级写权 / §8.4 冲突冻结）
 * 管线：硬规则 → 精确去重 → 近似合并 → 语义键冲突 → 风险分级 → 落库 + 审计
 */

import { contentHash } from "../core/hash";
import { matchSensitive } from "../core/sensitive";
import {
  cosine,
  extractKeywords,
  mergeAliasGroups,
  normalizeAliases,
  personaAliasGroups,
  tf,
  tokenize,
} from "../core/tokenize";
import type { Actor, ErrCode, Evidence, Level, MemoryEntry, Tier, Verdict } from "../core/types";
import type { WeaveEnv } from "./db";
import { DEFAULT_AUTOLINK, autoLink, setSessionTag, type AutoLinkConfig } from "./link";
import {
  addAudit,
  appendUndo,
  findActiveByHash,
  findConflictingSemanticKey,
  getPersona,
  insertCandidate,
  insertConflict,
  insertMemory,
  listRecentByLevel,
  newId,
  type CandidateRow,
  type ConflictRow,
} from "./dao";
import { LEVEL_ORDER } from "../core/types";

export interface WriteInput {
  level: Level;
  content: string;
  project?: string | null;
  section?: string | null;
  keywords?: string[];
  importance?: number;
  semanticKey?: string | null;
  evidence?: Evidence[];
  source?: string;
  tier?: Tier;
  validTo?: number | null;
  /** 附录 A governance.autoAcceptLowRisk：AI 低风险写入是否直接入库（缺省 true） */
  autoAccept?: boolean;
  /** 附录 A governance.requireConfirmFor：需二次确认的写入类型（rules/soul/delete…） */
  requireConfirmFor?: string[];
  /** 附录 A governance.sensitivePatterns：附加敏感词正则（"default" 或省略 = 仅内置） */
  extraSensitive?: string[];
  /** governance.disabledSensitive：用户关闭的内置规则 id（凭据类锁定规则不受影响） */
  disabledSensitive?: string[];
  /** 附录 A recall.synonymsFile：附加同义词组（P2 词表归一扩展） */
  extraAliasGroups?: string[][];
  /** roadmap R9：包含度判据（缺省开） */
  containment?: { enabled: boolean; jaccard: number; containment: number };
  /** roadmap R2：惊讶度定初始重要度（缺省开；只在未显式传 importance 时生效） */
  surprise?: boolean;
  /** roadmap R3：来源加权（缺省开） */
  sourceWeight?: boolean;
  /** roadmap R1：写入会话标记 `<sessionId>#<turn>` */
  sessionTag?: string | null;
  /** roadmap R1：自动建边参数 */
  autoLink?: AutoLinkConfig;
}

/** R9 判据默认值 */
export const DEFAULT_CONTAINMENT = { enabled: true, jaccard: 0.6, containment: 0.78 };

/** 中文二元组 + 拉丁词集合（R2 / R9） */
export function bigramSet(text: string): Set<string> {
  return new Set(tokenize(text));
}

export function setOverlap(a: Set<string>, b: Set<string>): { inter: number; jaccard: number; containment: number } {
  if (a.size === 0 || b.size === 0) return { inter: 0, jaccard: 0, containment: 0 };
  let inter = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const t of small) if (large.has(t)) inter += 1;
  return { inter, jaccard: inter / (a.size + b.size - inter), containment: inter / Math.min(a.size, b.size) };
}

/** R3 来源因子：主人 1.33 / AI 转述主人原话 1.2 / 其他 1.0 */
export function sourceFactor(input: Pick<WriteInput, "level" | "evidence">, actor: Actor): number {
  if (actor === "human") return 1.33;
  if (actor === "agent" && (input.level === "user" || (input.evidence ?? []).some((e) => e && typeof e.quote === "string" && e.quote.trim().length > 0))) {
    return 1.2;
  }
  return 1.0;
}

/** R2：imp = clamp(round(3 × (0.8 + 0.4 × s) × sourceFactor), 1, 5)，s = 1 − max Jaccard */
export function initialImportance(surprise: number, factor: number): number {
  const s = Math.max(0, Math.min(1, surprise));
  return Math.max(1, Math.min(5, Math.round(3 * (0.8 + 0.4 * s) * factor)));
}

export interface WriteOutcome {
  ok: boolean;
  code?: ErrCode;
  id?: string;
  deduped?: boolean;
  mergedInto?: string;
  conflictId?: string;
  verdict?: Verdict;
  message?: string;
  /** roadmap R1：本次自动建的边数 */
  links?: number;
  /** 附加步骤（⑦）失败说明；不影响写入结果 */
  warn?: string;
}

export const MAX_CONTENT = 2000;
export const MERGE_THRESHOLD = 0.92;

/** 敏感拦截（§8.3）：只回类别，不回显原文 */
/** 删除性质的表述（L2 须人确认） */
const DELETE_NATURE = /删除|遗忘|作废|废止|不再有效|撤销|清空|作废/;

/** 纯推测（L3 拒绝） */
const SPECULATION = /可能|大概|猜测|好像|也许|估计|应该吧/;

/** 只用内置规则扫描（全部开启） */
export function scanSensitive(text: string): string | null {
  return matchSensitive(text);
}

function tfOf(text: string): Map<string, number> {
  return tf(tokenize(text));
}

function specToCandidate(id: string, input: WriteInput, risk: string, reason: string): CandidateRow {
  return {
    id,
    level: input.level,
    project: input.project ?? null,
    content: input.content,
    keywords: input.keywords ?? [],
    importance: input.importance ?? 3,
    semanticKey: input.semanticKey ?? null,
    evidence: input.evidence ?? [],
    tier: input.tier ?? "hot",
    verdict: "pending",
    risk,
    reason,
    mergedInto: null,
    createdAt: Date.now(),
    decidedAt: null,
    decidedBy: null,
  };
}

/** 内置规则（可关闭部分）+ 附录 A governance.sensitivePatterns 自定义正则；坏正则跳过（I8 不阻塞） */
export function scanSensitiveContent(text: string, extra?: string[], disabled?: string[]): string | null {
  const hit = matchSensitive(text, extra, disabled);
  // 自定义规则只报类别，不把规则原文写进错误信息 / 审计
  return hit && hit.startsWith("custom:") ? "custom" : hit;
}


export async function writeMemory(
  env: WeaveEnv,
  input: WriteInput,
  actor: Actor,
): Promise<WriteOutcome> {
  try {
    return await env.withWrite(() => writeMemorySync(env, input, actor));
  } catch (e) {
    return { ok: false, code: "E_DB", message: "memory write failed: " + String(e) };
  }
}

function writeMemorySync(env: WeaveEnv, input: WriteInput, actor: Actor): WriteOutcome {
  // Preserve the source wording; identity aliases are normalized only in retrieval metadata, not in stored content.
  const personaCfg = getPersona(env).config;
  const content = (input.content ?? "").trim();
  const audit = (o: WriteOutcome, extra: { reason?: string; target?: string }): void => {
    addAudit(env, {
      actor,
      action: "memory.write",
      target: extra.target ?? "-",
      after: content.slice(0, 200),
      reason: (o.code ?? "ok") + (extra.reason ? " / " + extra.reason : ""),
    });
  };

  // ① 硬规则
  if (content.length === 0 || content.length > MAX_CONTENT) {
    const o: WriteOutcome = {
      ok: false,
      code: "E_VALID",
      verdict: "rejected",
      message: "content length invalid (1.." + MAX_CONTENT + ")",
    };
    audit(o, { reason: "length" });
    return o;
  }
  const sensitive = scanSensitiveContent(content, input.extraSensitive, input.disabledSensitive);
  if (sensitive) {
    const o: WriteOutcome = {
      ok: false,
      code: "E_SENSITIVE",
      verdict: "rejected",
      message: "sensitive pattern matched: " + sensitive,
    };
    audit(o, { reason: "sensitive:" + sensitive });
    return o;
  }

  const hash = contentHash(content);

  // ② 精确去重
  const dup = findActiveByHash(env, hash);
  if (dup) {
    const o: WriteOutcome = { ok: true, deduped: true, id: dup.id, verdict: "accepted" };
    audit(o, { reason: "dedupe", target: dup.id });
    return o;
  }

  // ③ 近似合并（同层近期条目 cosine > 0.92；roadmap R9：或 Jaccard ≥ 0.60 且包含度 ≥ 0.78）
  const vec = tfOf(content);
  const cont = input.containment ?? DEFAULT_CONTAINMENT;
  const mySet = bigramSet(content);
  for (const e of listRecentByLevel(env, input.level, 100)) {
    if (e.status === "archived") continue;
    const sim = cosine(vec, tfOf(e.content));
    let reason = "cosine=" + sim.toFixed(3);
    let near = sim > MERGE_THRESHOLD;
    if (!near && cont.enabled) {
      const oldSet = bigramSet(e.content);
      const ov = setOverlap(mySet, oldSet);
      // 新版更全：完整包含旧条目且明显更长 → 不吞新的，进 L2 让人决定是否替换
      const oldCovered = oldSet.size > 0 ? ov.inter / oldSet.size : 0;
      if (oldCovered >= 0.9 && content.length >= e.content.length * 1.3 && e.status === "active") {
        const candId = newId();
        const keywordsNew = input.keywords && input.keywords.length > 0 ? input.keywords : extractKeywords(content);
        insertCandidate(env, {
          ...specToCandidate(candId, { ...input, content, keywords: keywordsNew }, "L2", "revise-need-human"),
          mergedInto: e.id,
          patch: { content, keywords: keywordsNew },
        });
        const o: WriteOutcome = {
          ok: true,
          id: candId,
          verdict: "pending",
          message: "newer version covers " + e.id + "; routed to candidates for human confirm",
        };
        audit(o, {
          reason: "supersede jaccard=" + ov.jaccard.toFixed(2) + " covered=" + oldCovered.toFixed(2),
          target: e.id,
        });
        return o;
      }
      if (ov.jaccard >= cont.jaccard && ov.containment >= cont.containment) {
        near = true;
        reason = "jaccard=" + ov.jaccard.toFixed(2) + " containment=" + ov.containment.toFixed(2);
      }
    }
    if (near) {
      const o: WriteOutcome = {
        ok: true,
        mergedInto: e.id,
        id: e.id,
        verdict: "merged",
        message: "merged into " + e.id,
      };
      addAudit(env, {
        actor,
        action: "memory.merge",
        target: e.id,
        after: content.slice(0, 200),
        reason,
      });
      // 撤销留痕（§12 weave_restore「找回被吞原文」/ §13.2.6）：被并掉的原文整体存 undo 台账
      appendUndo(env, {
        actor,
        action: "govern.resurrect",
        target: e.id,
        payload: {
          level: input.level,
          project: input.project ?? null,
          section: input.section ?? null,
          content,
          keywords: input.keywords ?? null,
          importance: input.importance ?? 3,
          semanticKey: input.semanticKey ?? null,
          evidence: input.evidence ?? [],
          tier: input.tier ?? "hot",
          validTo: input.validTo ?? null,
        },
      });
      return o;
    }
  }

  const semKey = input.semanticKey ?? null;

  // ④ 语义键冲突 → 冻结双条，永不静默覆写（§8.4）
  if (semKey) {
    const contenders = findConflictingSemanticKey(env, semKey);
    if (contenders.length > 0) {
      const candId = newId();
      const conflictId = newId();
      insertCandidate(env, {
        ...specToCandidate(candId, input, "L2", "semantic-key-conflict"),
        verdict: "frozen",
      });
      const conflict: ConflictRow = {
        id: conflictId,
        semanticKey: semKey,
        contenders: [
          ...contenders.map((c) => ({
            id: c.id,
            level: c.level,
            content: c.content,
            createdAt: c.createdAt,
          })),
          { id: candId, level: input.level, content, createdAt: Date.now() },
        ],
        winnerId: null,
        status: "open",
        note: null,
        createdAt: Date.now(),
        resolvedAt: null,
      };
      insertConflict(env, conflict);
      const o: WriteOutcome = {
        ok: false,
        code: "E_CONFLICT",
        conflictId,
        verdict: "frozen",
        message: "semantic key conflict frozen",
      };
      audit(o, { reason: "conflict:" + semKey, target: conflictId });
      return o;
    }
  }

  const keywords = normalizeAliases(
    input.keywords && input.keywords.length > 0 ? input.keywords : extractKeywords(content),
    mergeAliasGroups(personaAliasGroups(personaCfg), input.extraAliasGroups),
  );

  // ⑤ 风险分级
  const strictMode = personaCfg.strict === true;
  const human = actor === "human";
  const dangerousLevel = input.level === "rules" || input.level === "soul";
  const deleteNature = DELETE_NATURE.test(content);
  const speculation = (input.evidence ?? []).length === 0 && SPECULATION.test(content);

  if (speculation && !human) {
    const o: WriteOutcome = {
      ok: false,
      code: "E_VALID",
      verdict: "rejected",
      message: "L3 rejected: speculation without evidence",
    };
    audit(o, { reason: "L3" });
    return o;
  }

  // 附录 A governance.requireConfirmFor：缺省 rules/soul/delete 三类需二次确认
  const confirmCats = new Set(input.requireConfirmFor ?? ["rules", "soul", "delete"]);
  const needConfirm =
    (strictMode && !human) ||
    confirmCats.has(input.level) ||
    (confirmCats.has("delete") && deleteNature);
  if (needConfirm) {
    const candId = newId();
    insertCandidate(
      env,
      specToCandidate(
        candId,
        { ...input, content, keywords },
        "L2",
        strictMode && !human
          ? "strict-mode-need-human"
          : dangerousLevel
            ? "level-need-confirm"
            : "delete-nature",
      ),
    );
    const o: WriteOutcome = {
      ok: true,
      id: candId,
      verdict: "pending",
      message: "routed to candidates for human confirm",
    };
    audit(o, { reason: "L2", target: candId });
    return o;
  }

  // 附录 A governance.autoAcceptLowRisk=false：AI 低风险写入也进候选（缺省 true = 直接入库）
  if (!human && input.autoAccept === false) {
    const candId = newId();
    insertCandidate(env, specToCandidate(candId, { ...input, content, keywords }, "L2", "auto-accept-off"));
    const o: WriteOutcome = {
      ok: true,
      id: candId,
      verdict: "pending",
      message: "autoAcceptLowRisk off: routed to candidates",
    };
    audit(o, { reason: "L2", target: candId });
    return o;
  }

  // ⑥ 落库 + 审计
  // roadmap R2/R3：只在调用方没显式传 importance 时，按惊讶度 × 来源定初始重要度（不影响把关）
  let importance = input.importance ?? 3;
  if (input.importance === undefined && (input.surprise !== false || input.sourceWeight !== false)) {
    let s = 1;
    if (input.surprise !== false) {
      let maxJ = 0;
      for (const e of listRecentByLevel(env, input.level, 200)) {
        if (e.status !== "active") continue;
        const j = setOverlap(mySet, bigramSet(e.content)).jaccard;
        if (j > maxJ) maxJ = j;
      }
      s = 1 - maxJ;
    }
    const fac = input.sourceWeight !== false ? sourceFactor(input, actor) : 1;
    importance = input.surprise !== false ? initialImportance(s, fac) : Math.max(1, Math.min(5, Math.round(3 * fac)));
  }
  const id = newId();
  const ts = Date.now();
  const entry: MemoryEntry = {
    id,
    level: input.level,
    project: input.project ?? null,
    section: input.section ?? null,
    content,
    keywords,
    importance,
    status: "active",
    semanticKey: semKey,
    confidence: null,
    validFrom: ts,
    validTo: input.validTo ?? null,
    evidence: input.evidence ?? [],
    hash,
    source: input.source ?? actor,
    accessCount: 0,
    tier: input.tier ?? "hot",
    createdAt: ts,
    updatedAt: ts,
  };
  insertMemory(env, entry);
  // 撤销留痕：新写条目窗口内可一键回滚（归档）
  appendUndo(env, { actor, action: "memory.write", target: id, payload: { id } });
  const o: WriteOutcome = { ok: true, id, verdict: "accepted" };
  audit(o, { reason: "L0", target: id });
  // ⑦ roadmap R1：落库之后建边；失败不回滚 ⑥，只记 warn
  try {
    if (input.sessionTag) setSessionTag(env, entry.level, id, input.sessionTag);
    const r = autoLink(env, entry, input.sessionTag ?? null, input.autoLink ?? DEFAULT_AUTOLINK, ts);
    if (r.created.length > 0) o.links = r.created.length;
  } catch (e) {
    o.warn = "autolink failed: " + String(e);
  }
  return o;
}

/** 查重与冲突检测（默认阈值 0.5，工具可传 threshold） */
export function similar(
  env: WeaveEnv,
  content: string,
  threshold = 0.5,
): { id: string; sim: number }[] {
  const vec = tfOf(content);
  const out: { id: string; sim: number }[] = [];
  for (const level of LEVEL_ORDER) {
    for (const e of listRecentByLevel(env, level, 500)) {
      if (e.status === "archived") continue;
      const sim = cosine(vec, tfOf(e.content));
      if (sim >= threshold) out.push({ id: e.id, sim });
    }
  }
  out.sort((x, y) => y.sim - x.sim || (x.id < y.id ? -1 : 1));
  return out;
}
