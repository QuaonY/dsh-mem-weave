/**
 * 忆织 MemWeave —— 服务门面：聚合 dao / govern / render，供 host/tools/rpc 共用
 * （三个写面同源：AI 工具 / CLI / UI 全走这里，§13.0）
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import {
  clearPointer,
  defaultDataDir,
  normalizeDataDir,
  readPointer,
  readSettings,
  samePath,
  writePointer,
  writeSettings,
} from "./location";
import { dirname, join, resolve } from "node:path";
import { contentHash } from "../core/hash";
import { FileLogger, normalizeLevel } from "./logger";
import { renderAll, renderS1, type RenderInput } from "../core/render";
import {
  DEFAULT_DIVERSITY,
  DEFAULT_HALF_LIFE_DAYS,
  DEFAULT_RUMINATION,
  bm25Scores,
  diversify,
  finalizeRanking,
  rrfFuse,
  type DiversityConfig,
  type RankedHit,
  type RouteRank,
  type RuminationConfig,
} from "../core/score";
import {
  checkDue,
  DEFAULT_PROMISE,
  isPending,
  looksFulfilled,
  PROMISE_LABEL_MAX,
  promiseLabelOf,
  promiseLine,
  PROMISE_DUE_REASON,
  promiseScore,
  surfacePromises,
  type PromiseConfig,
} from "../core/promise";
import { parseDue, safeZone } from "../core/localdate";
import {
  anchorTrace,
  DEFAULT_CALENDAR,
  matchAnchor,
  normalizeAnchor,
  resolveTimeZone,
  type CalendarConfig,
  type CalendarMatch,
} from "../core/calendar";
import { DEFAULT_SEARCH_TERMS, normalizeTerms, termsWarn, unionTerms, type SearchTermsConfig } from "../core/terms";
import {
  coverage as distillCoverage,
  DEFAULT_GROUP_DISTILL,
  DISTILL_CAND_REASON,
  groupMembers,
  landDistill,
  termsBacklog,
  termsBacklogCount,
  undoDistill,
  type DistillUndo,
  type GroupDistillConfig,
} from "../store/distill-queue";
import { getDistillGroup, listDistillGroups, setDistillStatus } from "../store/dao";
import { baseCandidate, hasCandidate } from "../store/dream-c";
import { matchSensitive } from "../core/sensitive";
import { localYmd } from "../core/promise";

/** roadmap v0.7 §8：待整理队列。默认只提示、不自己开始（F1） */
export interface CurateConfig {
  enabled: boolean;
  autoProcess: boolean;
  promptOncePerDay: boolean;
}
export const DEFAULT_CURATE: CurateConfig = { enabled: true, autoProcess: false, promptOncePerDay: true };
import type { CalendarAnchor, PromiseState } from "../core/types";
import { setAnchor as setAnchorRow, setPromise as setPromiseRow, setSearchTerms as setSearchTermsRow } from "../store/dao";
import {
  DEFAULT_AUTOLINK,
  RECALL_LOG_KEEP_DAYS,
  autoLink,
  jaccard,
  logRecall,
  pruneRecallLog,
  recentRecallCounts,
  sessionTag,
  type AutoLinkConfig,
} from "../store/link";
import { DEFAULT_ALIAS_GROUPS, mergeAliasGroups, normalizeAliases, tokenize } from "../core/tokenize";
import {
  DEFAULT_BUDGET,
  LEVEL_ORDER,
  type Actor,
  type BudgetConfig,
  type DeltaChange,
  type EntryStatus,
  type ErrCode,
  type Level,
  type MemoryEntry,
  type PersonaConfig,
  type PersonaRow,
  type RenderResult,
  type Verdict,
} from "../core/types";
import type { WeaveEnv } from "../store/db";
import { ensureSchema } from "../store/migrate";
import {
  addAudit,
  addLedger,
  appendUndo,
  archiveMemory,
  bumpAccess,
  computeDelta,
  countByLevel,
  decideCandidate,
  defaultPersona,
  findActiveByHash,
  findConflictingSemanticKey,
  forgetMemory,
  getCandidate,
  reopenConflict,
  setCandidateVerdict,
  getLedger,
  listLedgerSessions,
  getLinks,
  getMemory,
  getPersona,
  getUndo,
  insertCandidate as insertCandidateRow,
  insertMemory,
  listCandidates,
  listConflicts,
  listMemory,
  listPersonaHistory,
  listUndo,
  markUndoDone,
  newId,
  queryAudit,
  resolveConflict,
  restoreMemory,
  reviseMemory,
  countFlashSince,
  setFlash as setFlashRow,
  updatePersona,
  type AuditRow,
  type CandidateRow,
  type ConflictRow,
  type LedgerRow,
  type PersonaHistoryRow,
  type UndoRow,
} from "../store/dao";
import { similar, writeMemory, scanSensitiveContent, MAX_CONTENT, type WriteInput, type WriteOutcome } from "../store/govern";
import {
  clearMirror,
  rebuildMirror,
  type MirrorConfigLike,
  type MirrorReport,
} from "../store/mirror";
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
} from "../store/dream";
import {
  queryQuotes,
  syncSessionIndex,
  zstdAvailable,
  type QuoteHit,
  type QuoteSyncReport,
} from "../store/quote";
import { CONTRACT_ID_PREFIX, CONTRACT_TEXT_MAX, PROMOTION_REASON } from "../store/promote";
import { REVIEW_REASON, recordViolation } from "../store/review";
import { DEFAULT_EMOTION, DEFAULT_INTENT, detectIntent, residueFloor, type EmotionConfig, type IntentConfig } from "../core/intent";
import {
  ARCHIVE_REASON,
  CORE_REASON,
  DEFAULT_BOOST,
  DEFAULT_CORECALL,
  DEFAULT_DISTILL,
  DEFAULT_MAX_CANDIDATES,
  DEFAULT_STALE_ASK_DAYS,
  linkHealth,
  undoDreamC,
  type BoostConfig,
  type CoRecallConfig,
  type DistillConfig,
} from "../store/dream-c";

/** 接受后要真正写进记忆的 L2 写入候选（把关分流过来的） */
const WRITE_REASONS = new Set(["strict-mode-need-human", "level-need-confirm", "delete-nature", "auto-accept-off", "distill-rules"]);
import { bumpRelation as bumpRelationStore, type RelationPatch, type RelationResult } from "../store/relation";
import { LAYER_TABLES, SCHEMA_VERSION } from "../store/schema";
import { BUILTIN_PREFIX, BUILTIN_PRESETS } from "../presets";

export interface WeaveConfig {
  dataDir: string;
  promptLang: "zh" | "en";
  strict: boolean;
  quote: { enabled: boolean; indexDays: number; sessionsDir?: string };
  mirror: { enabled: boolean; rebuildDebounceMs: number; maxFileKb: number; maxLines: number; dir?: string };
  dream: DreamConfigLike;
  budget: BudgetConfig;
  /** 附录 A memory.hitTopK：每消息注入的召回命中条数（§6.1 S3） */
  memory: { hitTopK: number };
  /** 附录 A recall：路由与融合参数（routes/rrfK/weights/synonymsFile） */
  recall: {
    routes: string[];
    rrfK: number;
    weights: { keyword: number; semantic: number; link: number };
    synonymsFile?: string;
    /** roadmap R4 */
    diversity: DiversityConfig;
    /** roadmap R5 */
    rumination: RuminationConfig;
    /** roadmap C5：recall_log 保留天数 */
    logKeepDays: number;
    /** roadmap C6：仅等价测试用，界面不展示 */
    legacyAccessBonus: boolean;
    /** roadmap R11 */
    intent: IntentConfig;
  };
  /** roadmap R10 */
  emotion: EmotionConfig;
  /** roadmap v0.6 M1 */
  promise: PromiseConfig;
  /** roadmap v0.6 M2 */
  calendar: CalendarConfig;
  /** roadmap v0.7 S1 */
  searchTerms: SearchTermsConfig;
  /** roadmap v0.7 S2：会话内归纳（与 lifecycle.distill 的 G3 项目摘要是两件事） */
  distill: GroupDistillConfig;
  /** roadmap v0.7 §8：待整理队列 */
  curate: CurateConfig;
  /** roadmap R1 */
  links: { autoLink: AutoLinkConfig; coRecall: CoRecallConfig };
  /** roadmap G8：文件日志；dir 留空为 <dataDir>/logs */
  log: { dir: string; maxFileMb: number; keepDays: number };
  /** 设置页「日志级别」 */
  logLevel?: string;
  /** roadmap G5：连续工具调用后提示反思 */
  reflect: { enabled: boolean; afterToolSteps: number };
  /** roadmap G7：压缩后重放 */
  replay: { enabled: boolean };
  /** roadmap R2 / R3 / R9 */
  write: {
    surprise: { enabled: boolean };
    sourceWeight: { enabled: boolean };
    containment: { enabled: boolean; jaccard: number; containment: number };
  };
  /** 附录 A lifecycle：衰减与冷合并策略 */
  lifecycle: {
    halfLifeDays: Record<Level, number>;
    coldMemoryMonths: number;
    mergeOnDream: boolean;
    autoDream: boolean;
    /** roadmap R6 */
    boost: BoostConfig;
    /** roadmap G4：stale 持续天数达到后询问归档 */
    staleAskDays: number;
    /** roadmap G3 */
    distill: DistillConfig;
    /** roadmap D5：每次 dream 最多新增候选 */
    maxCandidatesPerDream: number;
  };
  /** 附录 A governance：写入治理与撤销窗口 */
  governance: {
    autoAcceptLowRisk: boolean;
    undoWindowHours: number;
    requireConfirmFor: string[];
    sensitivePatterns?: string[] | "default";
    /** 用户关闭的内置敏感规则 id（凭据类锁定规则不可关闭） */
    disabledSensitive?: string[];
    /** 轮后通知：每轮结束后在对话里显示本轮写入/整理概况 */
    turnNotice?: { enabled: boolean };
  };
  [k: string]: unknown;
}

export function defaultConfig(dataDir: string): WeaveConfig {
  return {
    dataDir,
    promptLang: "zh",
    strict: false,
    quote: { enabled: false, indexDays: 90 },
    mirror: {
      enabled: true,
      rebuildDebounceMs: 60000,
      maxFileKb: 25,
      maxLines: 400,
      dir: join(dataDir, "mirror"),
    },
    dream: {
      enabled: true,
      idleMinutes: 180,
      timezone: "Asia/Shanghai",
      peakHours: [[9, 12], [14, 18]],
      leaseHours: 6,
      maxFailures: 3,
    },
    budget: { ...DEFAULT_BUDGET },
    memory: { hitTopK: 5 },
    recall: {
      routes: ["keyword", "link"],
      rrfK: 60,
      weights: { keyword: 1.0, semantic: 0.8, link: 0.5 },
      diversity: { ...DEFAULT_DIVERSITY, factors: [...DEFAULT_DIVERSITY.factors] },
      rumination: { ...DEFAULT_RUMINATION },
      logKeepDays: RECALL_LOG_KEEP_DAYS,
      legacyAccessBonus: false,
      intent: { ...DEFAULT_INTENT, rules: DEFAULT_INTENT.rules.map((r) => ({ ...r, words: [...r.words] })) },
    },
    emotion: { ...DEFAULT_EMOTION, residue: { ...DEFAULT_EMOTION.residue! } },
    promise: { ...DEFAULT_PROMISE },
    calendar: { ...DEFAULT_CALENDAR },
    searchTerms: { ...DEFAULT_SEARCH_TERMS },
    distill: { ...DEFAULT_GROUP_DISTILL },
    curate: { ...DEFAULT_CURATE },
    links: { autoLink: { ...DEFAULT_AUTOLINK }, coRecall: { ...DEFAULT_CORECALL } },
    log: { dir: "", maxFileMb: 5, keepDays: 7 },
    logLevel: "info",
    reflect: { enabled: true, afterToolSteps: 7 },
    replay: { enabled: true },
    write: {
      surprise: { enabled: true },
      sourceWeight: { enabled: true },
      containment: { enabled: true, jaccard: 0.6, containment: 0.78 },
    },
    lifecycle: {
      // 附录 A：rules 0 = 不衰减（∞）
      halfLifeDays: { ...DEFAULT_HALF_LIFE_DAYS },
      coldMemoryMonths: 6,
      mergeOnDream: true,
      autoDream: true,
      boost: { ...DEFAULT_BOOST },
      staleAskDays: DEFAULT_STALE_ASK_DAYS,
      distill: { ...DEFAULT_DISTILL },
      maxCandidatesPerDream: DEFAULT_MAX_CANDIDATES,
    },
    governance: {
      autoAcceptLowRisk: true,
      undoWindowHours: 24,
      requireConfirmFor: ["rules", "soul", "persona", "delete"],
      sensitivePatterns: "default",
      turnNotice: { enabled: true },
    },
  };
}

/** P4 硬规则（§9-P4）：预设卡导出永远不含记忆类数据 */
const PRESET_FORBIDDEN_KEYS = ["memory", "memories", "candidates", "conflicts", "entries", "audit", "ledger"];

export function sanitizePresetPayload(payload: PersonaConfig): PersonaConfig {
  const out: Record<string, unknown> = { ...(payload as Record<string, unknown>) };
  for (const k of PRESET_FORBIDDEN_KEYS) delete out[k];
  return out as PersonaConfig;
}

const VALID_LEVELS = new Set<string>(LEVEL_ORDER);

/** §8.4：open 冲突的 contester id 集合 —— 双方便都不注入（S2 / delta / 召回都过滤） */
function openConflictIds(env: WeaveEnv): Set<string> {
  const out = new Set<string>();
  for (const c of listConflicts(env, "open")) {
    for (const t of c.contenders) out.add(t.id);
  }
  return out;
}

/** 导入条目分类：可入库 / 重复跳过 / 语义键冲突不并入 / 非法跳过 */
function classifyImportEntry(
  env: WeaveEnv,
  e: MemoryEntry | null | undefined,
): "ok" | "dup" | "conflict" | "invalid" {
  if (!e || typeof e.content !== "string" || e.content.trim().length === 0 || e.content.trim().length > MAX_CONTENT) return "invalid";
  if (!VALID_LEVELS.has(e.level) || scanSensitiveContent(e.content)) return "invalid";
  const hash = contentHash(e.content);
  if (findActiveByHash(env, hash)) return "dup";
  if (
    e.semanticKey &&
    findConflictingSemanticKey(env, e.semanticKey).some((c) => c.content !== e.content)
  ) {
    return "conflict";
  }
  return "ok";
}

export interface StatusReport {
  plugin: string;
  dataDir: string;
  dbFile: string;
  readonly: boolean;
  schemaVersion: number;
  personaVersion: number;
  counts: Record<Level, number>;
  total: number;
  candidatesPending: number;
  conflictsOpen: number;
  strict: boolean;
}

export class WeaveService {
  readonly env: WeaveEnv;
  config: WeaveConfig;
  /** 记忆库目录来自哪里：插件配置 / 设置页指定 / 默认 */
  dataDirSource: "config" | "pointer" | "default" = "default";
  /** 设置页「恢复默认」用的出厂值（openService 填入；直接 new 时退回内置默认） */
  defaults: WeaveConfig | null = null;
  /** 互斥暂停（§11.2）：只写库不注入 */
  paused = false;

  /** §13.2.2「立即 reload 并生效」：宿主装配时注册的段位重装配回调 */
  reloadHook: (() => void) | null = null;
  /** recall.synonymsFile 缓存（按 mtime 失效） */
  private aliasFileCache = new Map<string, { mtime: number; groups: string[][] }>();
  pauseReason = "";
  /** weave_* 工具注册结果（宿主装配时填写；自检与总览用） */
  toolStatus: { registered: string[]; failed: string[]; lastError: string } = { registered: [], failed: [], lastError: "" };
  /** 宿主装配时注入的 warn（写入附加步骤失败等，不阻塞） */
  warn: ((m: string) => void) | null = null;
  /** roadmap G8：文件日志 */
  logger: FileLogger | null = null;

  attachLogger(now?: () => number): FileLogger {
    const lc = this.config.log ?? { dir: "", maxFileMb: 5, keepDays: 7 };
    this.logger = new FileLogger({
      dir: lc.dir && lc.dir.trim() ? lc.dir : join(this.env.dataDir, "logs"),
      level: normalizeLevel(this.config.logLevel),
      maxFileMb: lc.maxFileMb,
      keepDays: lc.keepDays,
      now,
    });
    return this.logger;
  }
  /** roadmap R1/R5：每会话轮次计数（进程内；co-session 相邻轮与 recall_log 分组用） */
  private turnBySession = new Map<string, number>();

  beginTurn(sessionId: string): number {
    const n = (this.turnBySession.get(sessionId) ?? 0) + 1;
    this.turnBySession.set(sessionId, n);
    if (this.turnBySession.size > 500) {
      const first = this.turnBySession.keys().next().value;
      if (first !== undefined && first !== sessionId) this.turnBySession.delete(first);
    }
    return n;
  }

  currentTurn(sessionId: string): number | undefined {
    return this.turnBySession.get(sessionId);
  }

  constructor(env: WeaveEnv, config: WeaveConfig) {
    this.env = env;
    this.config = config;
  }

  /** roadmap R13：插件启动时体检一次关联网（只读库跳过；失败不阻塞） */
  startupLinkHealth(): void {
    if (this.env.readonly) return;
    try {
      linkHealth(this.env, "dream");
    } catch {
      // I8
    }
  }

  // ---------- 状态 ----------

  status(): StatusReport {
    const counts = countByLevel(this.env);
    const total = LEVEL_ORDER.reduce((s, l) => s + counts[l], 0);
    return {
      plugin: "dsh-mem-weave",
      dataDir: this.env.dataDir,
      dbFile: this.env.dataDir + "/memweave.db",
      readonly: this.env.readonly,
      schemaVersion: SCHEMA_VERSION,
      personaVersion: getPersona(this.env).version,
      counts,
      total,
      candidatesPending: listCandidates(this.env, "pending").length,
      conflictsOpen: listConflicts(this.env, "open").length,
      strict: getPersona(this.env).config.strict === true,
    };
  }

  // ---------- 人格 ----------

  persona(): PersonaRow {
    return getPersona(this.env);
  }

  /** persona 版本历史（§13.2.2 版本页：列表 + 前端 diff + 回滚） */
  personaHistory(limit = 50): PersonaHistoryRow[] {
    return listPersonaHistory(this.env, limit);
  }

  updatePersona(
    patch: Partial<PersonaConfig>,
    actor: string,
    expectedVersion?: number,
  ): { ok: boolean; version?: number; code?: ErrCode; current?: number } {
    const r = updatePersona(this.env, patch, actor, expectedVersion);
    this.scheduleMirror();
    return r;
  }

  renderPersona(modelHint?: string): { prefix: string; thinking: string; suffix: string; blocks: string[]; warn: string[] } {
    return renderS1(this.persona().config, modelHint, this.config.budget);
  }

  preview(modelHint?: string): RenderResult {
    const snapshot = this.snapshotItems();
    const input: RenderInput = {
      persona: this.persona().config,
      modelHint,
      budget: this.config.budget,
      snapshotItems: snapshot,
      delta: [],
      recallHits: [],
      quotes: [],
    };
    return renderAll(input);
  }

  /** S2 快照取材：soul / user / rules / project 的 active 条目（§8.4：open 冲突双方便都不注入） */
  snapshotItems(): MemoryEntry[] {
    const frozen = openConflictIds(this.env);
    const levels: Level[] = ["soul", "user", "rules", "project"];
    const out: MemoryEntry[] = [];
    for (const level of levels) {
      out.push(...listMemory(this.env, { level, status: "active" }).filter((e) => !frozen.has(e.id)));
    }
    return out;
  }

  // ---------- 记忆 ----------

  async remember(
    input: WriteInput,
    actor: Actor,
    meta?: {
      sessionId?: string;
      turn?: number;
      /** roadmap G6 */ violatesContract?: string;
      /** roadmap R10：写入方给的情绪值 */ valence?: number;
      arousal?: number;
      /** roadmap v0.6 M1：约定到期（绝对时间：UTC 毫秒或 ISO 字符串） */ dueAt?: number | string;
      promiseLabel?: string;
      /** roadmap v0.6 M2：日历锚点 */ anchor?: unknown;
      /** roadmap v0.7 S1：检索词 */ searchTerms?: unknown;
    },
  ): Promise<WriteOutcome> {
    // 附录 A governance/recall 配置注入：autoAcceptLowRisk / requireConfirmFor / sensitivePatterns / synonymsFile
    const g = this.config.governance;
    const w = this.config.write;
    const tag = input.sessionTag ?? (meta?.sessionId ? sessionTag(meta.sessionId, meta.turn) : null);
    const extraSensitive = Array.isArray(g.sensitivePatterns) ? g.sensitivePatterns : undefined;
    const out = await writeMemory(
      this.env,
      {
        ...input,
        autoAccept: input.autoAccept ?? g.autoAcceptLowRisk,
        requireConfirmFor: input.requireConfirmFor ?? g.requireConfirmFor,
        extraSensitive: input.extraSensitive ?? extraSensitive,
        disabledSensitive: input.disabledSensitive ?? g.disabledSensitive,
        extraAliasGroups: mergeAliasGroups(input.extraAliasGroups, this.fileAliasGroups()),
        containment: input.containment ?? w?.containment,
        surprise: input.surprise ?? w?.surprise?.enabled,
        sourceWeight: input.sourceWeight ?? w?.sourceWeight?.enabled,
        sessionTag: tag,
        autoLink: input.autoLink ?? this.config.links?.autoLink,
      },
      actor,
    );
    if (out.warn) this.warn?.(out.warn);
    if (meta?.sessionId && out.ok && out.id && out.verdict !== "pending") this.noteSessionWrite(meta.sessionId, out.id);
    // roadmap R10：照常过完四级把关之后才写情绪值（C1：闪光灯不豁免任何一步）；失败不回滚写入
    if (out.ok && out.id && out.verdict === "accepted" && (meta?.valence !== undefined || meta?.arousal !== undefined)) {
      try {
        this.applyEmotion(out.id, meta?.valence, meta?.arousal, actor);
      } catch (e) {
        this.warn?.("emotion write failed: " + String(e));
      }
    }
    // roadmap v0.6 M1 / M2：过完四级把关后才附加约定与锚点（C1）；字段非法只拒字段、记忆照常写入
    const fieldWarn: string[] = [];
    if (out.ok && out.id && (meta?.dueAt !== undefined || meta?.anchor !== undefined)) {
      if (out.verdict === "pending") {
        fieldWarn.push("dueAt/anchor not applied: memory is waiting for review");
      } else if (out.verdict === "accepted" || out.verdict === "merged") {
        try {
          if (meta?.dueAt !== undefined) {
            const w2 = this.applyDue(out.id, meta.dueAt, meta.promiseLabel, actor, out.verdict === "merged");
            if (w2) fieldWarn.push(w2);
          }
          if (meta?.anchor !== undefined) {
            const w3 = this.applyAnchorField(out.id, meta.anchor, actor);
            if (w3) fieldWarn.push(w3);
          }
        } catch (e) {
          fieldWarn.push("promise/anchor write failed: " + String(e));
        }
      }
    }
    // roadmap v0.7 S1：检索词同样在把关之后附加；不参与去重 / 合并 / semanticKey 判断
    if (out.ok && out.id && meta?.searchTerms !== undefined && this.config.searchTerms.enabled) {
      if (out.verdict === "pending") {
        fieldWarn.push("searchTerms not applied: memory is waiting for review");
      } else if (out.verdict === "accepted" || out.verdict === "merged") {
        try {
          const w4 = this.applyTerms(out.id, meta.searchTerms, actor, out.verdict === "merged");
          if (w4) fieldWarn.push(w4);
        } catch (e) {
          fieldWarn.push("searchTerms write failed: " + String(e));
        }
      }
    }
    // roadmap v0.6 M1：本轮写入像是「已经做了某个约定」→ 轮后通知提示，不自动结算
    if (out.ok && out.id && out.verdict !== "pending" && this.config.promise.enabled && meta?.dueAt === undefined) {
      try {
        this.hintFulfilled(input.content, out.id, actor);
      } catch {
        // 提示失败不影响写入
      }
    }
    if (fieldWarn.length > 0) {
      for (const m of fieldWarn) this.warn?.(m);
      (out as WriteOutcome & { warn?: string }).warn = [out.warn, ...fieldWarn].filter(Boolean).join("; ");
    }
    // roadmap G6：lesson 标注违反的契约 → 记一次违反（契约须存在；pending 也算，纠正事实已发生）
    if (meta?.violatesContract && out.ok && out.id && input.level === "lesson") {
      try {
        const all = (this.persona().config.contracts ?? []).filter((c) => c);
        // 提示词里契约按启用顺序编号（1. 2. …）：接受序号或 id
        const shown = all.filter((c) => c.on !== false && typeof c.text === "string" && c.text.trim() !== "");
        const ref = meta.violatesContract.trim();
        const hit = /^\d+$/.test(ref) ? shown[Number(ref) - 1] : all.find((c) => c.id === ref);
        if (hit) recordViolation(this.env, hit.id, out.id, actor, meta.sessionId);
        else this.warn?.("violatesContract: unknown contract " + ref);
      } catch (e) {
        this.warn?.("violation record failed: " + String(e));
      }
    }
    this.scheduleMirror();
    return out;
  }

  /**
   * roadmap R10：记下情绪值；arousal ≥ flashArousal 且今天的闪光灯没到上限 → flash=1。
   * 超出上限按 0 处理并记审计。emotion 关着时什么都不写。
   */
  private applyEmotion(id: string, valence: number | undefined, arousal: number | undefined, actor: string): void {
    const cfg = this.config.emotion;
    if (!cfg?.enabled) return;
    const e = getMemory(this.env, id);
    if (!e) return;
    const v = typeof valence === "number" && Number.isFinite(valence) ? Math.max(-1, Math.min(1, valence)) : null;
    const a = typeof arousal === "number" && Number.isFinite(arousal) ? Math.max(0, Math.min(1, arousal)) : null;
    let flash = a !== null && a >= cfg.flashArousal;
    if (flash) {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      if (countFlashSince(this.env, d.getTime()) >= cfg.dailyFlashCap) {
        flash = false;
        addAudit(this.env, { actor, action: "memory.flash-capped", target: id, reason: "daily cap " + cfg.dailyFlashCap });
      }
    }
    this.env.db
      .prepare("UPDATE " + LAYER_TABLES[e.level] + " SET valence = ?, arousal = ?, flash = ? WHERE id = ?")
      .run(v, a, flash ? 1 : 0, id);
    if (flash) addAudit(this.env, { actor, action: "memory.flash", target: id });
  }

  /** roadmap v0.6 M1：写约定字段；返回 warn（字段被拒）或 null */
  private applyDue(id: string, raw: number | string, label: string | undefined, actor: string, merged: boolean): string | null {
    const cfg = this.config.promise;
    if (!cfg.enabled) return "dueAt ignored: promise disabled";
    const e = getMemory(this.env, id);
    if (!e) return "dueAt ignored: memory not found";
    const now = Date.now();
    const due = parseDue(raw, this.timeZone());
    if (due === null) return "dueAt rejected: must be an absolute date (YYYY-MM-DD or YYYY-MM-DDTHH:mm)";
    const bad = checkDue(due, now, cfg);
    if (bad) return "dueAt rejected: " + bad;
    // 近似合并：两者都有约定时取较早的那个
    const next = merged && isPending(e) ? Math.min(e.dueAt!, due) : due;
    const lbl = typeof label === "string" && label.trim() ? label.trim().slice(0, PROMISE_LABEL_MAX) : e.promiseLabel ?? null;
    this.writePromise(e, { dueAt: next, state: "pending", label: lbl }, actor, "memory.promise");
    return null;
  }

  private writePromise(e: MemoryEntry, p: { dueAt: number | null; state: PromiseState; label: string | null }, actor: string, action: string): void {
    setPromiseRow(this.env, e.level, e.id, p);
    addAudit(this.env, { actor, action, target: e.id, before: e.promiseState ?? "none", after: p.state + (p.dueAt ? "@" + new Date(p.dueAt).toISOString() : "") });
    appendUndo(this.env, {
      actor,
      action: "memory.promise",
      target: e.id,
      payload: { before: { dueAt: e.dueAt ?? null, state: e.promiseState ?? "none", label: e.promiseLabel ?? null } },
    });
  }

  /** roadmap v0.6 M2：写锚点字段；返回 warn 或 null */
  private applyAnchorField(id: string, raw: unknown, actor: string): string | null {
    const e = getMemory(this.env, id);
    if (!e) return "anchor ignored: memory not found";
    if (raw === null) {
      this.setAnchor(id, null, actor);
      return null;
    }
    const n = normalizeAnchor(raw);
    if ("error" in n) return "anchor rejected: " + n.error;
    this.setAnchor(id, n.anchor, actor);
    return null;
  }

  /**
   * roadmap v0.7 S1：写入后附加检索词（过完四级把关之后，C1）。
   * merged = 合并命中：与目标已有检索词取并集截到上限。返回 warn 文本（丢词原因）。
   */
  private applyTerms(id: string, raw: unknown, actor: string, merged: boolean): string | null {
    const e = getMemory(this.env, id);
    if (!e) return "searchTerms ignored: memory not found";
    const cfg = this.config.searchTerms;
    const n = normalizeTerms(raw, e.content, cfg, this.termsSensitive());
    const next = merged ? unionTerms(e.searchTerms, n.terms, cfg.maxTerms) : n.terms;
    const before = e.searchTerms ?? null;
    if (JSON.stringify(next) !== JSON.stringify(before ?? [])) {
      setSearchTermsRow(this.env, e.level, id, next);
      addAudit(this.env, { actor, action: "memory.terms", target: id, after: JSON.stringify(next) });
      appendUndo(this.env, { actor, action: "memory.terms", target: id, payload: { before } });
    }
    return termsWarn(n.dropped);
  }

  /** 检索词敏感词检查沿用写入把关的配置（"default" = 只用内置规则） */
  private termsSensitive(): { custom?: string[]; disabled?: string[] } {
    const g = this.config.governance;
    return {
      custom: Array.isArray(g.sensitivePatterns) ? g.sensitivePatterns : undefined,
      disabled: g.disabledSensitive,
    };
  }

  /** roadmap v0.7 S1：设置页编辑检索词（整体替换；空数组 = 清空）；可撤销 */
  setTerms(id: string, raw: unknown, actor: string): { ok: boolean; code?: ErrCode; message?: string; searchTerms?: string[]; warn?: string } {
    const e = getMemory(this.env, id);
    if (!e) return { ok: false, code: "E_VALID", message: "memory not found" };
    const w = this.applyTerms(id, raw ?? [], actor, false);
    this.scheduleMirror();
    return { ok: true, searchTerms: getMemory(this.env, id)?.searchTerms ?? [], ...(w ? { warn: w } : {}) };
  }

  /**
   * roadmap v0.7 §6.4：weave_annotate 批量补词。只补 / 替换检索词，不改正文；
   * 整批写一条撤销台账（24 小时内可撤销）。
   */
  annotate(
    items: unknown,
    actor: string,
  ): { ok: boolean; code?: ErrCode; message?: string; updated: string[]; skipped: Array<{ id: string; reason: string }>; warn?: string; undoId?: string } {
    const list = Array.isArray(items) ? items.slice(0, 50) : [];
    if (list.length === 0) return { ok: false, code: "E_VALID", message: "items must be a non-empty array", updated: [], skipped: [] };
    const cfg = this.config.searchTerms;
    const sens = this.termsSensitive();
    const updated: string[] = [];
    const skipped: Array<{ id: string; reason: string }> = [];
    const undoItems: Array<{ id: string; before: string[] | null }> = [];
    const warns: string[] = [];
    for (const it of list) {
      const o = it && typeof it === "object" ? (it as Record<string, unknown>) : {};
      const id = typeof o.id === "string" ? o.id : "";
      const e = id ? getMemory(this.env, id) : null;
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
      setSearchTermsRow(this.env, e.level, id, n.terms);
      updated.push(id);
    }
    let undoId: string | undefined;
    if (updated.length > 0) {
      addAudit(this.env, { actor, action: "memory.annotate", target: updated[0], after: JSON.stringify({ count: updated.length, ids: updated }) });
      undoId = appendUndo(this.env, { actor, action: "memory.terms", target: updated[0], payload: { items: undoItems } });
      this.scheduleMirror();
    }
    return { ok: true, updated, skipped, ...(warns.length > 0 ? { warn: warns.join("; ") } : {}), ...(undoId ? { undoId } : {}) };
  }

  // ---------- roadmap v0.7 §8：待整理队列（S1 待补检索词 + S2 待归纳） ----------

  /** 待归纳组：open 且成员仍可用、且没有挂着待审的低覆盖率候选 */
  private openGroups(): Array<{ id: string; reason: string | null; members: MemoryEntry[] }> {
    const out: Array<{ id: string; reason: string | null; members: MemoryEntry[] }> = [];
    for (const g of listDistillGroups(this.env, "open")) {
      if (hasCandidate(this.env, DISTILL_CAND_REASON + ":" + g.id, "pending")) continue;
      const members = groupMembers(this.env, g);
      const single = members.length === 1 && g.reason === "consolidated";
      if (!single && members.length < this.config.distill.groupMin) continue;
      out.push({ id: g.id, reason: g.reason, members });
    }
    return out;
  }

  /** 两类待整理的数量（S3 提示与设置页用） */
  backlogCounts(): { terms: number; groups: number } {
    return {
      terms: this.config.searchTerms.enabled ? termsBacklogCount(this.env) : 0,
      groups: this.config.distill.enabled ? this.openGroups().length : 0,
    };
  }

  /** weave_backlog：最多 20 条待补检索词 + 3 组待归纳（正文按数据给出） */
  backlog(): {
    terms: Array<{ id: string; level: Level; content: string }>;
    groups: Array<{ groupId: string; reason: string | null; members: Array<{ id: string; level: Level; content: string }> }>;
    counts: { terms: number; groups: number };
  } {
    const terms = this.config.searchTerms.enabled
      ? termsBacklog(this.env, Math.min(20, this.config.searchTerms.backfillPerDream || 20)).map((e) => ({ id: e.id, level: e.level, content: e.content }))
      : [];
    const groups = this.config.distill.enabled
      ? this.openGroups()
          .slice(0, 3)
          .map((g) => ({ groupId: g.id, reason: g.reason, members: g.members.map((e) => ({ id: e.id, level: e.level, content: e.content })) }))
      : [];
    return { terms, groups, counts: this.backlogCounts() };
  }

  /**
   * roadmap v0.7 S2 weave_distill：提交归纳或跳过。
   * 敏感词直接拒；覆盖率 < coverage 转 L2 候选交主人审；否则照常过四级把关写 topic（section=distilled），
   * 成员建 merged 边并归档，写撤销台账。
   */
  async submitDistill(
    a: { groupId: string; summary?: string; keywords?: string[]; searchTerms?: unknown; skip?: boolean },
    actor: string,
  ): Promise<{ ok: boolean; code?: ErrCode; message?: string; id?: string; verdict?: string; candidateId?: string; coverage?: number; undoId?: string; warn?: string }> {
    const cfg = this.config.distill;
    if (!cfg.enabled) return { ok: false, code: "E_PERM", message: "distill disabled" };
    const g = getDistillGroup(this.env, a.groupId);
    if (!g) return { ok: false, code: "E_VALID", message: "group not found" };
    if (g.status !== "open") return { ok: false, code: "E_VALID", message: "group is " + g.status };
    if (a.skip) {
      await this.env.withWrite(() => {
        setDistillStatus(this.env, g.id, "skipped");
        addAudit(this.env, { actor, action: "distill.skip", target: g.id });
      });
      return { ok: true, verdict: "skipped" };
    }
    const summary = (a.summary ?? "").trim();
    if (summary.length === 0) return { ok: false, code: "E_VALID", message: "summary required (or skip: true)" };
    if ([...summary].length > cfg.maxChars) return { ok: false, code: "E_VALID", message: "summary exceeds " + cfg.maxChars + " chars" };
    const sens = this.termsSensitive();
    if (matchSensitive(summary, sens.custom, sens.disabled)) return { ok: false, code: "E_SENSITIVE", message: "summary contains sensitive content" };
    const members = groupMembers(this.env, g);
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
      await this.env.withWrite(() => {
        insertCandidateRow(this.env, c);
        addAudit(this.env, { actor, action: "distill.review", target: g.id, after: c.id, reason: "coverage " + cov.toFixed(2) });
      });
      return { ok: true, verdict: "pending", candidateId: c.id, coverage: cov };
    }
    const r = await this.landSummary(g.id, summary, keywords, a.searchTerms, project, importance, actor);
    return r.ok ? { ...r, coverage: cov } : r;
  }

  /** 归纳正文照常过四级把关写入；通过（accepted / merged）后落地成员归档与边 */
  private async landSummary(
    groupId: string,
    summary: string,
    keywords: string[] | undefined,
    searchTerms: unknown,
    project: string | null,
    importance: number,
    actor: string,
  ): Promise<{ ok: boolean; code?: ErrCode; message?: string; id?: string; verdict?: string; undoId?: string; warn?: string }> {
    const out = await this.remember(
      { level: "topic", project, section: "distilled", content: summary, keywords, importance },
      actor === "human" ? "human" : "agent",
      searchTerms !== undefined ? { searchTerms } : undefined,
    );
    if (!out.ok || !out.id) return { ok: false, code: out.code ?? "E_VALID", message: out.message ?? "distill write rejected" };
    if (out.verdict !== "accepted" && out.verdict !== "merged") {
      return { ok: true, id: out.id, verdict: out.verdict, ...(out.warn ? { warn: out.warn } : {}) };
    }
    const summaryId = out.id;
    const undoId = await this.env.withWrite(() => {
      const g = getDistillGroup(this.env, groupId)!;
      const members = groupMembers(this.env, g).filter((m) => m.id !== summaryId);
      const u: DistillUndo = { ...landDistill(this.env, summaryId, g, members, actor, Date.now()), created: out.verdict === "accepted" };
      addAudit(this.env, { actor, action: "distill.land", target: summaryId, after: JSON.stringify({ group: groupId, members: u.memberIds }) });
      return appendUndo(this.env, { actor, action: "distill.land", target: summaryId, payload: u });
    });
    this.scheduleMirror();
    return { ok: true, id: summaryId, verdict: out.verdict, undoId, ...(out.warn ? { warn: out.warn } : {}) };
  }

  /** 每会话每天最多提示一次；数量没变不再提示（无变化零注入，F1） */
  private curateShown = new Map<string, { day: string; key: string }>();
  /**
   * 待整理数量快照：只在 dream 跑完时更新（§6.4 / §8 都是 dream 轮产出）。
   * 不用实时数量，否则每写一条新记忆「缺检索词」就 +1，下一轮立刻出提示，破坏无变化零注入。
   */
  private curateSnapshot: { terms: number; groups: number } | null = null;

  private snapshotCurate(): void {
    try {
      this.curateSnapshot = this.backlogCounts();
    } catch {
      this.curateSnapshot = null;
    }
  }

  /** S3 末尾的【待整理】一行；不该出现时返回空串 */
  curateLine(sessionId: string, now: number = Date.now()): string {
    const cu = this.config.curate;
    if (!cu.enabled) return "";
    const n = this.curateSnapshot;
    if (!n || (n.terms === 0 && n.groups === 0)) return "";
    const key = n.terms + "/" + n.groups;
    const day = localYmd(now, this.timeZone());
    const prev = this.curateShown.get(sessionId);
    if (prev && prev.key === key) return "";
    if (prev && cu.promptOncePerDay && prev.day === day) return "";
    this.curateShown.set(sessionId, { day, key });
    if (this.curateShown.size > 500) {
      const first = this.curateShown.keys().next().value;
      if (first !== undefined && first !== sessionId) this.curateShown.delete(first);
    }
    const tail = cu.autoProcess ? "主人空闲或聊完时可顺手用 weave_backlog 处理" : "主人说「整理一下」后再用 weave_backlog 处理";
    return "【待整理】" + n.terms + " 条缺检索词、" + n.groups + " 组可归纳；" + tail;
  }

  /** roadmap v0.6 M2：设置页加 / 删锚点；可撤销 */
  setAnchor(id: string, anchor: unknown, actor: string): { ok: boolean; code?: ErrCode; message?: string } {
    const e = getMemory(this.env, id);
    if (!e) return { ok: false, code: "E_VALID", message: "memory not found" };
    let next: CalendarAnchor | null = null;
    if (anchor !== null && anchor !== undefined) {
      const n = normalizeAnchor(anchor);
      if ("error" in n) return { ok: false, code: "E_VALID", message: n.error };
      next = n.anchor;
    }
    setAnchorRow(this.env, e.level, id, next);
    addAudit(this.env, { actor, action: next ? "memory.anchor" : "memory.unanchor", target: id, after: next ? JSON.stringify(next) : undefined });
    appendUndo(this.env, { actor, action: "memory.anchor", target: id, payload: { before: e.calendarAnchor ?? null } });
    this.scheduleMirror();
    return { ok: true };
  }

  /**
   * roadmap v0.6 M1：结算约定（weave_promise / 设置页 / 候选裁决）。
   * kept / broken：改状态；extend：换新的到期日（照常校验）。AI 调用写审计，可撤销。
   */
  settlePromise(
    id: string,
    outcome: "kept" | "broken" | "extend",
    actor: string,
    dueAt?: number | string,
  ): { ok: boolean; code?: ErrCode; message?: string; state?: PromiseState; dueAt?: number | null } {
    const e = getMemory(this.env, id);
    if (!e) return { ok: false, code: "E_VALID", message: "memory not found" };
    if (outcome !== "kept" && outcome !== "broken" && outcome !== "extend") {
      return { ok: false, code: "E_VALID", message: "outcome must be kept|broken|extend" };
    }
    if (outcome === "extend") {
      if (dueAt === undefined) return { ok: false, code: "E_VALID", message: "extend requires dueAt" };
      const due = parseDue(dueAt, this.timeZone());
      if (due === null) return { ok: false, code: "E_VALID", message: "dueAt must be an absolute date (YYYY-MM-DD or YYYY-MM-DDTHH:mm)" };
      const bad = checkDue(due, Date.now(), this.config.promise);
      if (bad) return { ok: false, code: "E_VALID", message: bad };
      this.writePromise(e, { dueAt: due, state: "pending", label: e.promiseLabel ?? null }, actor, "promise.extend");
      this.closePromiseCandidates(e.id, actor);
      this.scheduleMirror();
      return { ok: true, state: "pending", dueAt: due };
    }
    if (!isPending(e)) return { ok: false, code: "E_VALID", message: "memory has no pending promise" };
    this.writePromise(e, { dueAt: e.dueAt ?? null, state: outcome, label: e.promiseLabel ?? null }, actor, "promise." + outcome);
    this.closePromiseCandidates(e.id, actor);
    if (this.config.promise.affectRelation) {
      try {
        bumpRelationStore(this.env, { trustDelta: outcome === "kept" ? 0.05 : -0.05 }, actor);
      } catch {
        // 关系联动失败不影响结算
      }
    }
    this.scheduleMirror();
    return { ok: true, state: outcome, dueAt: e.dueAt ?? null };
  }

  /** 结算后，还挂着的「确认约定结果」候选一并关掉（不再重复问） */
  private closePromiseCandidates(memoryId: string, actor: string): void {
    for (const c of listCandidates(this.env, "pending")) {
      if (c.reason === PROMISE_DUE_REASON && c.mergedInto === memoryId) decideCandidate(this.env, c.id, "rejected", actor);
    }
  }

  /** 关键词重叠 + 「已经做了」语气 → 记一条 promise.hint 审计，轮后通知展示 */
  private hintFulfilled(text: string, writtenId: string, actor: string): void {
    const pend = this.listMemory({ status: "active" }).filter((e) => isPending(e) && e.id !== writtenId);
    if (pend.length === 0) return;
    const toks = new Set(tokenize(text));
    for (const p of pend) {
      const ptoks = new Set(tokenize(promiseLabelOf(p) + " " + p.keywords.join(" ")));
      if (looksFulfilled(text, ptoks, toks)) {
        addAudit(this.env, { actor, action: "promise.hint", target: p.id, after: promiseLabelOf(p), reason: "from " + writtenId });
      }
    }
  }

  /** roadmap R10：设置页取消 / 恢复闪光灯 */
  setFlash(id: string, flash: boolean, actor: string): { ok: boolean; code?: ErrCode; message?: string } {
    const e = getMemory(this.env, id);
    if (!e) return { ok: false, code: "E_VALID", message: "memory not found" };
    setFlashRow(this.env, e.level, id, flash);
    addAudit(this.env, { actor, action: flash ? "memory.flash" : "memory.unflash", target: id });
    appendUndo(this.env, { actor, action: "memory.flash", target: id, payload: { before: e.flash === true } });
    this.scheduleMirror();
    return { ok: true };
  }

  listMemory(f: Parameters<typeof listMemory>[1]): MemoryEntry[] {
    return listMemory(this.env, f);
  }

  getMemory(id: string): MemoryEntry | null {
    return getMemory(this.env, id);
  }

  revise(id: string, patch: Partial<MemoryEntry>, actor: string, expectedUpdatedAt?: number) {
    const current = getMemory(this.env, id);
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
      const extra = Array.isArray(this.config.governance.sensitivePatterns) ? this.config.governance.sensitivePatterns : undefined;
      const sensitive = scanSensitiveContent(content, extra, this.config.governance.disabledSensitive);
      if (sensitive) return { ok: false, code: "E_SENSITIVE" as const, message: "sensitive pattern matched: " + sensitive };
      const duplicate = findActiveByHash(this.env, contentHash(content));
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
    if (patch.confidence !== undefined && patch.confidence !== null && (!Number.isFinite(patch.confidence) || patch.confidence < 0 || patch.confidence > 1)) {
      return { ok: false, code: "E_VALID" as const, message: "confidence must be between 0 and 1" };
    }
    if (patch.keywords !== undefined && (!Array.isArray(patch.keywords) || patch.keywords.some((word) => typeof word !== "string"))) {
      return { ok: false, code: "E_VALID" as const, message: "keywords must be an array of strings" };
    }
    if (patch.semanticKey !== undefined && patch.semanticKey !== null) {
      if (typeof patch.semanticKey !== "string") return { ok: false, code: "E_VALID" as const, message: "semanticKey must be a string or null" };
      if (findConflictingSemanticKey(this.env, patch.semanticKey).some((entry) => entry.id !== id && entry.content !== (patch.content ?? current.content))) {
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
    // 撤销台账记下这次真正改动的每个字段的原值（不只 content/keywords），撤销时整组还原
    const UNDO_FIELDS = ["content", "keywords", "project", "section", "semanticKey", "tier", "importance", "status", "validTo"] as const;
    const beforeFields: Record<string, unknown> = {};
    for (const k of UNDO_FIELDS) {
      if (patch[k] !== undefined && JSON.stringify(patch[k]) !== JSON.stringify(current[k])) beforeFields[k] = current[k];
    }
    const r = reviseMemory(this.env, id, patch, actor, expectedUpdatedAt);
    if (r.ok && Object.keys(beforeFields).length > 0) {
      appendUndo(this.env, {
        actor,
        action: "memory.update",
        target: id,
        payload: { before: beforeFields },
      });
    }

    // P3 事件驱动（§9-P3）：主人纠正正文 → 关系小步下调（单次 ±0.05、每日 ±0.15 封顶）；只改分层、项目等整理动作不算纠正
    if (r.ok && actor === "human" && "content" in beforeFields) {
      try {
        bumpRelationStore(this.env, { trustDelta: -0.05 }, actor);
      } catch {
        // 状态更新失败不影响主流程
      }
    }
    this.scheduleMirror();
    return r;
  }

  archive(id: string, actor: string): void {
    const before = getMemory(this.env, id);
    archiveMemory(this.env, id, actor);
    appendUndo(this.env, {
      actor,
      action: "memory.archive",
      target: id,
      payload: { beforeStatus: before?.status ?? "active" },
    });
    this.scheduleMirror();
  }

  restore(id: string, actor: string): void {
    restoreMemory(this.env, id, actor);
    appendUndo(this.env, { actor, action: "memory.restore", target: id, payload: {} });
    this.scheduleMirror();
  }

  forget(id: string, actor: string): void {
    // forget 是唯一真删除：台账存整条原文，撤销时按原 id 重插（M4：自动动作 100% 可撤销）
    const before = getMemory(this.env, id);
    forgetMemory(this.env, id, actor);
    appendUndo(this.env, { actor, action: "memory.forget", target: id, payload: { before } });
    this.scheduleMirror();
  }

  // ---------- 撤销（§13.2.6：近 N 小时自动动作一键回滚；M4：自动动作 100% 可撤销） ----------

  /** 可撤销动作列表（窗口 = governance.undoWindowHours，默认 24h） */
  undoList(hours?: number): UndoRow[] {
    const win = Math.max(1, hours ?? this.config.governance.undoWindowHours);
    return listUndo(this.env, Date.now() - win * 3600000);
  }

  /** 执行一条撤销（只回滚台账里的逆操作；同一条只生效一次） */
  async undo(
    id: string,
    actor: string = "human",
  ): Promise<{ ok: boolean; code?: ErrCode; message?: string; action?: string }> {
    const result = await this.env.withWrite(() => {
      const row = getUndo(this.env, id);
      if (!row) return { ok: false as const, code: "E_VALID" as const, message: "undo record not found" };
      if (row.undone) return { ok: false as const, code: "E_VALID" as const, message: "already undone" };
      const win = Math.max(1, this.config.governance.undoWindowHours) * 3600000;
      if (Date.now() - row.ts > win) {
        return {
          ok: false as const,
          code: "E_PERM" as const,
          message: "undo window (" + this.config.governance.undoWindowHours + "h) expired",
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
          archiveMemory(this.env, row.target, actor);
          break;
        case "dream.links":
        case "dream.co-recall":
        case "dream.boost":
          undoDreamC(this.env, row.action, payload);
          break;
        case "memory.flash": {
          const e = getMemory(this.env, row.target);
          if (e) setFlashRow(this.env, e.level, e.id, payload.before === true);
          break;
        }
        case "memory.promise": {
          const e = getMemory(this.env, row.target);
          const b = payload.before as { dueAt?: number | null; state?: PromiseState; label?: string | null } | undefined;
          if (e && b) setPromiseRow(this.env, e.level, e.id, { dueAt: b.dueAt ?? null, state: b.state ?? "none", label: b.label ?? null });
          break;
        }
        case "memory.anchor": {
          const e = getMemory(this.env, row.target);
          if (e) setAnchorRow(this.env, e.level, e.id, (payload.before as CalendarAnchor | null | undefined) ?? null);
          break;
        }
        case "memory.terms": {
          // roadmap v0.7 S1：单条或整批（weave_annotate）检索词回到原值
          const list = Array.isArray(payload.items)
            ? (payload.items as Array<{ id: string; before: string[] | null }>)
            : [{ id: row.target, before: (payload.before as string[] | null | undefined) ?? null }];
          for (const it of list) {
            const e = getMemory(this.env, it.id);
            if (e) setSearchTermsRow(this.env, e.level, e.id, it.before ?? null);
          }
          break;
        }
        case "distill.land":
          // roadmap v0.7 S2：成员恢复 active、删新条目和边、组回到 open
          undoDistill(this.env, payload as unknown as DistillUndo, actor);
          break;
        case "memory.update":
        case "dream.status": {
          const before = payload.before as Partial<MemoryEntry> | undefined;
          if (before) reviseMemory(this.env, row.target, before, actor);
          break;
        }
        case "memory.archive": {
          // 归档前是 stale 的回到 stale，不一律变 active
          const before = payload.beforeStatus;
          if (before === "stale") reviseMemory(this.env, row.target, { status: "stale" }, actor);
          else restoreMemory(this.env, row.target, actor);
          break;
        }
        case "conflict.resolve": {
          // 败者回到原状态、裁决时落成的新记忆撤掉、冻结候选回到 frozen、冲突回到 open
          const p = payload as { conflictId?: string; archived?: Array<{ id: string; before: EntryStatus }>; candidates?: string[]; created?: string | null };
          for (const a of p.archived ?? []) {
            if (a.before === "active") restoreMemory(this.env, a.id, actor);
            else reviseMemory(this.env, a.id, { status: a.before }, actor);
          }
          if (p.created) archiveMemory(this.env, p.created, actor);
          for (const cid of p.candidates ?? []) setCandidateVerdict(this.env, cid, "frozen");
          reopenConflict(this.env, p.conflictId ?? row.target);
          break;
        }
        case "memory.forget": {
          // 真删除已无行可 restore：按台账原文重插（保留原 id/层级/时间戳）
          const before = payload.before as MemoryEntry | undefined;
          if (before && before.id === row.target) {
            insertMemory(this.env, { ...before, id: row.target });
          }
          break;
        }
        case "memory.restore":
          archiveMemory(this.env, row.target, actor);
          break;
        case "dream.merge": {
          // 逆冷合并：撤摘要 + 还原被归档的成员
          archiveMemory(this.env, String(payload.summaryId ?? row.target), actor);
          for (const mid of (payload.memberIds as string[] | undefined) ?? []) {
            restoreMemory(this.env, mid, actor);
          }
          break;
        }
        case "govern.resurrect": {
          // 被近似合并吞掉的原文复活为新条目（§12 weave_restore「找回被吞原文」）
          const content = String(payload.content ?? "");
          if (content.length > 0) {
            const ts = Date.now();
            insertMemory(this.env, {
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
      markUndoDone(this.env, id, Date.now());
      addAudit(this.env, {
        actor,
        action: "undo.run",
        target: row.action + ":" + row.target,
        after: "undone",
        reason: row.id,
      });
      return { ok: true as const, action: row.action };
    });
    if (result.ok) this.scheduleMirror();
    return result;
  }

  // ---------- 人格段位重装配（§13.2.2「立即 reload 并生效」） ----------

  reload(): { ok: boolean; code?: ErrCode; message?: string } {
    if (!this.reloadHook) return { ok: false, code: "E_UNAVAILABLE", message: "no section host bound" };
    try {
      this.reloadHook();
      return { ok: true };
    } catch (e) {
      return { ok: false, code: "E_UNAVAILABLE", message: String(e).slice(0, 200) };
    }
  }

  /** 附录 A recall.synonymsFile：外部同义词表（JSON 二维数组或 {groups:[]}）；坏文件降级为空 */
  fileAliasGroups(): string[][] {
    const path = this.config.recall.synonymsFile;
    if (!path || typeof path !== "string") return [];
    try {
      const st = statSync(path);
      const cached = this.aliasFileCache.get(path);
      if (cached && cached.mtime === st.mtimeMs) return cached.groups;
      const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
      const arr = Array.isArray(raw) ? raw : ((raw as { groups?: unknown }).groups ?? []);
      const groups = mergeAliasGroups(Array.isArray(arr) ? (arr as string[][]) : []);
      this.aliasFileCache.set(path, { mtime: st.mtimeMs, groups });
      return groups;
    } catch {
      return [];
    }
  }

  similar(content: string, threshold?: number): { id: string; sim: number }[] {
    return similar(this.env, content, threshold);
  }

  linksOf(id: string): ReturnType<typeof getLinks> {
    return getLinks(this.env, id);
  }

  /** rules/soul 修正提案：只入候选池，不生效（§7.6 / §8.3 L2） */
  proposeRevise(entry: MemoryEntry, patch: Partial<MemoryEntry>, actor: string): string {
    const id = newId();
    const proposed = { ...entry, ...patch, id: entry.id, level: entry.level };
    insertCandidateRow(this.env, {
      id,
      level: entry.level,
      project: proposed.project,
      content: proposed.content,
      keywords: proposed.keywords,
      importance: proposed.importance,
      semanticKey: proposed.semanticKey,
      evidence: proposed.evidence,
      tier: proposed.tier,
      verdict: "pending",
      risk: "L2",
      reason: "revise-need-human",
      mergedInto: entry.id,
      createdAt: Date.now(),
      decidedAt: null,
      decidedBy: null,
      patch,
    });
    addAudit(this.env, {
      actor,
      action: "memory.revise.propose",
      target: entry.id,
      after: JSON.stringify(patch).slice(0, 200),
      reason: "L2",
    });
    return id;
  }

  conflictsOf(id: string): string[] {
    return findConflictingSemanticKey(this.env, id).map((e) => e.id);
  }

  // ---------- 召回（§8.2 三路之关键词 + 关联图，语义默认关） ----------

  recall(
    query: string,
    opts?: {
      limit?: number;
      project?: string | null;
      halfLife?: Record<Level, number>;
      rrfK?: number;
    },
  ): RankedHit[] {
    // 附录 A recall/lifecycle/memory 配置生效：routes/rrfK/weights/halfLife/hitTopK/synonymsFile
    return recallEntries(this.env, query, {
      limit: opts?.limit ?? this.config.memory.hitTopK,
      project: opts?.project,
      halfLife: opts?.halfLife ?? this.config.lifecycle.halfLifeDays,
      rrfK: opts?.rrfK ?? this.config.recall.rrfK,
      routes: this.config.recall.routes,
      weights: this.config.recall.weights,
      aliasGroups: this.fileAliasGroups(),
      rumination: this.config.recall.rumination,
      diversity: this.config.recall.diversity,
      legacyAccessBonus: this.config.recall.legacyAccessBonus === true,
      intent: this.config.recall.intent,
      emotion: this.config.emotion,
      promise: this.config.promise,
      calendar: this.config.calendar,
      searchTerms: this.config.searchTerms,
    });
  }

  // ---------- 治理 ----------

  listCandidates(verdict?: Verdict): CandidateRow[] {
    return listCandidates(this.env, verdict);
  }

  /**
   * 候选裁决。P1 晋升候选（reason=contract-promotion）被接受时：
   * 只有人可以写 persona.contracts（§7.6），版本 +1，记审计。
   */
  decideCandidate(
    id: string,
    verdict: Verdict,
    actor: string,
    targetId?: string,
  ): { ok: boolean; code?: ErrCode; message?: string; promoted?: boolean; version?: number } {
    if (verdict === "accepted") {
      const revision = getCandidate(this.env, id);
      if (revision?.reason === "revise-need-human") {
        if (revision.verdict !== "pending") return { ok: false, code: "E_VALID", message: "revision proposal is no longer pending" };
        if (actor !== "human") return { ok: false, code: "E_PERM", message: "memory revision requires human approval" };
        if (!revision.patch || !revision.mergedInto) {
          return { ok: false, code: "E_VALID", message: "revision proposal is incomplete; create a new proposal" };
        }
        const target = getMemory(this.env, revision.mergedInto);
        if (!target || target.level !== revision.level) {
          return { ok: false, code: "E_VALID", message: "revision target no longer exists" };
        }
        const applied = this.revise(target.id, revision.patch, actor, target.updatedAt);
        if (!applied.ok) return { ok: false, code: applied.code ?? "E_VALID", message: "message" in applied ? applied.message : "revision could not be applied" };
      }
      const cand = getCandidate(this.env, id);
      // roadmap G6：接受契约复核 = 停用这条契约（只有人能做；修改文字走人格页）
      if (cand && cand.reason === REVIEW_REASON) {
        if (actor !== "human") return { ok: false, code: "E_PERM", message: "persona contract change requires actor=human" };
        if (cand.verdict !== "pending") return { ok: false, code: "E_VALID", message: "review is no longer pending" };
        const contracts = (this.persona().config.contracts ?? []).filter((c) => c);
        const hit = contracts.find((c) => c.id === cand.mergedInto);
        if (hit && hit.on) {
          const r = this.updatePersona({ contracts: contracts.map((c) => (c.id === hit.id ? { ...c, on: false } : c)) }, actor);
          if (!r.ok) return { ok: false, code: r.code ?? "E_DB", message: "contract update failed" };
        }
        const r2 = decideCandidate(this.env, id, verdict, actor, targetId);
        this.scheduleMirror();
        return { ok: r2.ok, code: r2.code };
      }
      if (cand && cand.reason === PROMOTION_REASON) {
        if (actor !== "human") {
          return { ok: false, code: "E_PERM", message: "persona contract write requires actor=human" };
        }
        const lessonId = cand.mergedInto ?? id;
        const text = cand.content.trim().slice(0, CONTRACT_TEXT_MAX);
        const cfg = this.persona().config;
        const contracts = (cfg.contracts ?? []).filter((c) => c);
        const cid = CONTRACT_ID_PREFIX + lessonId;
        if (!contracts.some((c) => c.id === cid)) {
          if (contracts.length >= 40) {
            return { ok: false, code: "E_VALID", message: "contracts full (max 40)" };
          }
          contracts.push({ id: cid, text, on: true });
          const r = this.updatePersona({ contracts }, actor);
          if (!r.ok) return { ok: false, code: r.code ?? "E_DB", message: "contract write failed" };
          const r2 = decideCandidate(this.env, id, verdict, actor, targetId);
          try {
            bumpRelationStore(this.env, { trustDelta: 0.05 }, actor);
          } catch {
            // 同上
          }
          this.scheduleMirror();
          return { ok: r2.ok, code: r2.code, promoted: true, version: r.version };
        }
      }
    }
    const pre = getCandidate(this.env, id);
    if (pre && pre.verdict === "pending" && (verdict === "accepted" || verdict === "rejected")) {
      const applied = this.applyCandidate(pre, verdict, actor);
      if (!applied.ok) return applied;
    }
    const r = decideCandidate(this.env, id, verdict, actor, targetId);
    // P3 事件驱动：主人接受确认 → 关系小步上调
    if (r.ok && verdict === "accepted" && actor === "human") {
      try {
        bumpRelationStore(this.env, { trustDelta: 0.05 }, actor);
      } catch {
        // 同上
      }
    }
    this.scheduleMirror();
    return r;
  }

  /**
   * 候选裁决的落地动作（decideCandidate 改 verdict 之前执行；失败则不改 verdict）。
   * - 把关分流来的写入候选 + G3 设为准则：接受 = 真正写入记忆（同正文已在库则跳过）；
   * - G4 建议归档：接受 = 归档；拒绝 = 改回 active 并清过期时间（不然下次 dream 又标 stale）；
   * - R6 建议常驻：接受 = tier 改 core。
   * 以上都只认 actor=human（rules / 常驻影响每个会话）。
   */
  private applyCandidate(
    cand: ReturnType<typeof getCandidate> & object,
    verdict: "accepted" | "rejected",
    actor: string,
  ): { ok: boolean; code?: ErrCode; message?: string } {
    // roadmap v0.6 M1：确认约定结果。接受 = 兑现，拒绝 = 落空；只认人（不自动判落空）
    if (cand.reason === PROMISE_DUE_REASON) {
      if (actor !== "human") return { ok: false, code: "E_PERM", message: cand.reason + " requires actor=human" };
      const target = cand.mergedInto ? getMemory(this.env, cand.mergedInto) : null;
      if (!target || !isPending(target)) return { ok: true }; // 已经结算过（或已延期另问）：只关掉候选
      const r = this.settlePromise(target.id, verdict === "accepted" ? "kept" : "broken", actor);
      return r.ok ? { ok: true } : { ok: false, code: r.code, message: r.message };
    }
    // roadmap v0.7 S2：覆盖率不足的归纳。接受 = 写 topic（distilled）并落地成员；拒绝 = 这组跳过。只认人
    if (cand.reason === DISTILL_CAND_REASON) {
      if (actor !== "human") return { ok: false, code: "E_PERM", message: cand.reason + " requires actor=human" };
      const gid = cand.semanticKey?.slice(DISTILL_CAND_REASON.length + 1) ?? "";
      const g = getDistillGroup(this.env, gid);
      if (!g || g.status !== "open") return { ok: true };
      if (verdict === "rejected") {
        setDistillStatus(this.env, g.id, "skipped");
        return { ok: true };
      }
      const members = groupMembers(this.env, g);
      if (members.length === 0) return { ok: true };
      const ts = Date.now();
      const mid = newId();
      const hash = contentHash(cand.content);
      const taken = !!this.env.db.prepare("SELECT 1 FROM " + LAYER_TABLES.topic + " WHERE hash = ?").get(hash);
      insertMemory(this.env, {
        id: mid,
        level: "topic",
        project: cand.project,
        section: "distilled",
        content: cand.content,
        keywords: cand.keywords,
        importance: cand.importance,
        status: "active",
        semanticKey: null,
        confidence: null,
        validFrom: ts,
        validTo: null,
        evidence: [],
        hash: taken ? null : hash,
        source: actor,
        accessCount: 0,
        tier: "hot",
        createdAt: ts,
        updatedAt: ts,
      });
      const u: DistillUndo = { ...landDistill(this.env, mid, g, members, actor, ts), created: true };
      addAudit(this.env, { actor, action: "distill.land", target: mid, reason: "candidate-accepted:" + cand.id });
      appendUndo(this.env, { actor, action: "distill.land", target: mid, payload: u });
      return { ok: true };
    }
    const kind =
      cand.reason === ARCHIVE_REASON ? "archive" : cand.reason === CORE_REASON ? "core" : WRITE_REASONS.has(cand.reason ?? "") ? "write" : null;
    if (!kind) return { ok: true };
    if (actor !== "human") return { ok: false, code: "E_PERM", message: cand.reason + " requires actor=human" };
    if (kind === "write") {
      if (verdict !== "accepted" || cand.level === "persona") return { ok: true };
      const level = cand.level as Level;
      const hash = contentHash(cand.content);
      if (findActiveByHash(this.env, hash)) return { ok: true };
      const ts = Date.now();
      const mid = newId();
      // 同正文的已归档行占着唯一索引 → 不带 hash 写入（与旧行区分靠 id）
      const taken = !!this.env.db.prepare("SELECT 1 FROM " + LAYER_TABLES[level] + " WHERE hash = ?").get(hash);
      insertMemory(this.env, {
        id: mid,
        level,
        project: cand.project,
        section: null,
        content: cand.content,
        keywords: cand.keywords,
        importance: cand.importance,
        status: "active",
        semanticKey: cand.reason === "distill-rules" ? null : cand.semanticKey,
        confidence: null,
        validFrom: ts,
        validTo: null,
        evidence: cand.evidence,
        hash: taken ? null : hash,
        source: actor,
        accessCount: 0,
        tier: cand.tier,
        createdAt: ts,
        updatedAt: ts,
      });
      appendUndo(this.env, { actor, action: "memory.write", target: mid, payload: { id: mid } });
      addAudit(this.env, { actor, action: "memory.write", target: mid, reason: "candidate-accepted:" + cand.id });
      return { ok: true };
    }
    const target = cand.mergedInto ? getMemory(this.env, cand.mergedInto) : null;
    if (!target) return { ok: true };
    if (kind === "archive") {
      if (verdict === "accepted") {
        if (target.status !== "archived") this.archive(target.id, actor);
      } else if (target.status === "stale") {
        reviseMemory(this.env, target.id, { status: "active", validTo: null }, actor);
        appendUndo(this.env, { actor, action: "dream.status", target: target.id, payload: { before: { status: "stale", validTo: target.validTo } } });
      }
      return { ok: true };
    }
    if (verdict === "accepted" && target.tier !== "core") {
      reviseMemory(this.env, target.id, { tier: "core" }, actor);
      appendUndo(this.env, { actor, action: "memory.update", target: target.id, payload: { before: { tier: target.tier } } });
    }
    return { ok: true };
  }

  /**
   * P3 关系/情绪小步（§9-P3 / §7.6）：单次 ±0.05、每日 ±0.15 封顶；
   * 只改 meta 措辞提示，不改契约、不改记忆内容。
   */
  bumpRelation(patch: RelationPatch, actor: string = "agent"): RelationResult {
    const r = bumpRelationStore(this.env, patch, actor);
    if (r.ok) this.scheduleMirror();
    return r;
  }

  listConflicts(status?: string): ConflictRow[] {
    return listConflicts(this.env, status);
  }

  /**
   * 冲突裁决（§8.4）：只裁决 open 的冲突。
   * 语义键冲突里新写入的一方是冻结候选（不是记忆）：选它时把候选落成记忆，败者归档；
   * 不选它时候选记为 rejected。整次裁决写一条 undo，可在治理页撤销。
   */
  resolveConflict(id: string, winnerId: string | null, actor: string): { ok: boolean; code?: ErrCode; message?: string; memoryId?: string } {
    const conflict = listConflicts(this.env).find((c) => c.id === id);
    if (!conflict) return { ok: false, code: "E_VALID", message: "conflict not found" };
    if (conflict.status !== "open") return { ok: false, code: "E_VALID", message: "conflict already resolved" };
    if (winnerId !== null && !conflict.contenders.some((t) => t.id === winnerId)) {
      return { ok: false, code: "E_VALID", message: "winner is not a contender" };
    }
    const r = resolveConflict(this.env, id, winnerId, actor);
    if (!r.ok) return r;
    const undo: { conflictId: string; archived: Array<{ id: string; before: EntryStatus }>; candidates: string[]; created: string | null } = {
      conflictId: id,
      archived: r.archived ?? [],
      candidates: [],
      created: null,
    };
    let memoryId: string | undefined;
    for (const t of conflict.contenders) {
      const cand = getMemory(this.env, t.id) ? null : getCandidate(this.env, t.id);
      if (!cand || cand.verdict !== "frozen") continue;
      undo.candidates.push(cand.id);
      if (t.id === winnerId && cand.level !== "persona") {
        const level = cand.level as Level;
        const ts = Date.now();
        const mid = newId();
        const hash = contentHash(cand.content);
        const taken = !!this.env.db.prepare("SELECT 1 FROM " + LAYER_TABLES[level] + " WHERE hash = ?").get(hash);
        insertMemory(this.env, {
          id: mid,
          level,
          project: cand.project,
          section: null,
          content: cand.content,
          keywords: cand.keywords,
          importance: cand.importance,
          status: "active",
          semanticKey: cand.semanticKey,
          confidence: null,
          validFrom: ts,
          validTo: null,
          evidence: cand.evidence,
          hash: taken ? null : hash,
          source: actor,
          accessCount: 0,
          tier: cand.tier,
          createdAt: ts,
          updatedAt: ts,
        });
        addAudit(this.env, { actor, action: "memory.write", target: mid, reason: "conflict-resolved:" + id });
        undo.created = mid;
        memoryId = mid;
        decideCandidate(this.env, cand.id, "accepted", actor, mid);
      } else {
        decideCandidate(this.env, cand.id, "rejected", actor);
      }
    }
    appendUndo(this.env, { actor, action: "conflict.resolve", target: id, payload: undo });
    this.scheduleMirror();
    return { ok: true, memoryId };
  }

  audit(f: { actor?: string; action?: string; since?: number; limit?: number }): AuditRow[] {
    return queryAudit(this.env, f);
  }

  ledger(sessionId: string): LedgerRow[] {
    return getLedger(this.env, sessionId);
  }

  ledgerSessions(limit = 20): Array<{ sessionId: string; lastTs: number; turns: number; chars: number }> {
    return listLedgerSessions(this.env, limit);
  }

  // ---------- 记忆库位置（设置页「备份」→ 存储位置） ----------

  /** 当前库位置、来源与下次启动将使用的位置 */
  dataLocation(): {
    current: string;
    source: string;
    defaultDir: string;
    pending: string;
    restartRequired: boolean;
    locked: boolean;
  } {
    const pointed = readPointer();
    const pending = this.dataDirSource === "config" ? this.env.dataDir : pointed || defaultDataDir();
    return {
      current: this.env.dataDir,
      source: this.dataDirSource,
      defaultDir: defaultDataDir(),
      pending,
      restartRequired: !samePath(pending, this.env.dataDir),
      locked: this.dataDirSource === "config",
    };
  }

  /**
   * 改记忆库目录（下次启动 DSH 生效）。
   * mode=copy：把当前库完整复制过去（目标已有库时拒绝，避免覆盖）；
   * mode=use：直接使用目标目录里已有的库（没有就新建空库）。
   * 原目录的数据原样保留，不做删除。
   */
  relocate(target: string, mode: "copy" | "use", actor: string): Record<string, unknown> {
    if (this.dataDirSource === "config") {
      return { ok: false, code: "E_LOCKED", message: "记忆库目录由插件配置文件里的 dataDir 指定，请在那里修改" };
    }
    const checked = normalizeDataDir(target);
    if (!checked.ok) return { ok: false, code: "E_VALID", message: checked.message };
    const dir = checked.dir;
    const isDefault = samePath(dir, defaultDataDir());
    if (samePath(dir, this.env.dataDir)) {
      if (isDefault) clearPointer();
      else writePointer(dir);
      return { ok: true, dir, restartRequired: false, copied: false };
    }
    const targetDb = join(dir, "memweave.db");
    let copied = false;
    try {
      mkdirSync(dir, { recursive: true });
      if (mode === "copy") {
        if (existsSync(targetDb)) {
          return { ok: false, code: "E_EXISTS", message: "目标目录里已经有一个记忆库；如要直接使用它，请选择“使用目标目录里的库”" };
        }
        if (targetDb.includes("'")) return { ok: false, code: "E_VALID", message: "路径里不能包含单引号" };
        this.env.db.exec("VACUUM INTO '" + targetDb + "'");
        const settings = readSettings(this.env.dataDir);
        if (Object.keys(settings).length > 0) writeSettings(dir, settings);
        copied = true;
      }
      if (isDefault) clearPointer();
      else writePointer(dir);
    } catch (e) {
      return { ok: false, code: "E_IO", message: "无法写入目标目录：" + String(e) };
    }
    try {
      if (!this.env.readonly) {
        addAudit(this.env, { actor, action: "data.relocate", target: dir, after: copied ? "copied" : "use-existing" });
      }
    } catch {
      // 审计失败不影响切换
    }
    return { ok: true, dir, copied, restartRequired: true };
  }

  /** 把这次在设置页改的项并入 settings.json（只存改过的项），重启后仍保留 */
  persistSettings(patch: Record<string, unknown>): boolean {
    try {
      const isRec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
      const merge = (a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> => {
        const out: Record<string, unknown> = { ...a };
        for (const [k, v] of Object.entries(b)) out[k] = isRec(out[k]) && isRec(v) ? merge(out[k] as Record<string, unknown>, v) : v;
        return out;
      };
      const { dataDir: _ignored, ...clean } = patch;
      writeSettings(this.env.dataDir, merge(readSettings(this.env.dataDir), clean));
      return true;
    } catch {
      return false;
    }
  }

  backupNow(label: string): string {
    return this.env.backup(label);
  }

  // ---------- 注入装配（会话级） ----------

  /**
   * 装配一轮注入：S2 首轮 / S3 后续（delta+召回+原文旁路）。
   * 互斥暂停（paused）时只算不注入，返回空串。
   */
  renderTurn(input: {
    sessionId: string;
    first: boolean;
    modelHint?: string;
    query?: string;
    baseline: Map<string, number>;
    /** roadmap R5/R8：本会话第几轮（recall_log 分组用） */
    turn?: number;
    /** roadmap G7：压缩后重放（S2 + 本会话写过的 + 查过的项目） */
    replay?: boolean;
  }): { result: RenderResult; inject: boolean; s2: string; s3: string } {
    const personaCfg = this.persona().config;
    const frozenIds = openConflictIds(this.env);
    const delta: DeltaChange[] = input.first
      ? []
      : computeDelta(this.env, input.sessionId, input.baseline).filter((d) => !frozenIds.has(d.entry.id));
    let hits: RankedHit[] = [];
    if (!input.first && input.query) {
      hits = this.recall(input.query, {
        limit: Math.min(this.config.memory.hitTopK, this.config.budget.recallMaxItems),
      });
      bumpAccess(this.env, hits.map((h) => h.id));
      try {
        logRecall(this.env, hits.map((h) => h.id), input.sessionId, input.turn ?? 0);
      } catch (e) {
        this.warn?.("recall_log write failed: " + String(e));
      }
    }
    // §8.5：仅关键词与语义两路都空时才走原文旁路（语义路默认关，视为常空）
    const quotes = !input.first && hits.length === 0 ? this.quoteLookup(input.query ?? "") : [];
    // roadmap v0.6 M1：约定小节；内容和本会话上次注入的一样就不再注入（同 delta 无变化零注入）
    let promises: string[] = [];
    if (this.config.promise.enabled) {
      if (input.first) this.promiseShown.delete(input.sessionId); // 新会话 / 压缩重放：之前注入的已不在上下文里
      const lines = this.promiseLines();
      const key = lines.join("\n");
      if (key !== (this.promiseShown.get(input.sessionId) ?? "")) {
        promises = lines;
        this.promiseShown.set(input.sessionId, key);
        if (this.promiseShown.size > 500) {
          const first = this.promiseShown.keys().next().value;
          if (first !== undefined && first !== input.sessionId) this.promiseShown.delete(first);
        }
      }
    }
    const result = renderAll({
      persona: personaCfg,
      modelHint: input.modelHint,
      budget: this.config.budget,
      snapshotItems: input.first ? this.snapshotItems() : [],
      delta,
      recallHits: hits,
      quotes,
      promises,
    });
    for (const seg of result.segments) {
      addLedger(this.env, {
        sessionId: input.sessionId,
        segment: seg.name,
        chars: seg.chars,
        items: seg.items,
        trimmed: seg.trimmed,
        // roadmap G14：召回段逐条记命中解释（层、重要度、路由、关联类型、衰减、去同质、反刍），注入页展示
        detail: seg.name === "s3-recall" && hits.length > 0 && seg.items > 0 ? recallDetail(hits.slice(0, seg.items)) : undefined,
      });
    }
    const inject = !this.paused;
    let s2 = input.first ? result.s2 : "";
    // 首轮（含压缩重放）没有 S3：约定小节跟在快照后面
    const promiseText = result.segments.find((s) => s.name === "s3-promise")?.text ?? "";
    if (input.first && promiseText) s2 = s2 ? s2 + "\n\n" + promiseText : promiseText;
    if (input.first && input.replay) {
      const extra = this.replayBlock(input.sessionId);
      if (extra) s2 = s2 ? s2 + "\n\n" + extra : extra;
      try {
        addLedger(this.env, { sessionId: input.sessionId, segment: "s2-replay", chars: s2.length, items: 0, trimmed: 0 });
      } catch {
        // 审计失败不影响注入
      }
    }
    // roadmap v0.7 §8：S3 末尾的【待整理】一行（数量变化才出现，每会话每天最多一次）
    let s3 = input.first ? "" : result.s3;
    if (!input.first) {
      let line = "";
      try {
        line = this.curateLine(input.sessionId);
      } catch {
        line = "";
      }
      if (line) {
        s3 = s3 ? s3 + "\n\n" + line : line;
        try {
          addLedger(this.env, { sessionId: input.sessionId, segment: "s3-curate", chars: line.length, items: 1, trimmed: 0 });
        } catch {
          // 审计失败不影响注入
        }
      }
    }
    return {
      result,
      inject,
      s2,
      s3,
    };
  }

  // ---------- roadmap v0.6 M1：约定 ----------
  /** 每会话上次注入的约定小节（进程内） */
  private promiseShown = new Map<string, string>();

  /** 本地时区：日历配置的 timeZone 优先，留空取宿主进程时区 */
  timeZone(): string {
    return safeZone(resolveTimeZone(this.config.calendar));
  }

  /** S3 约定小节的行（绝对日期） */
  promiseLines(now: number = Date.now()): string[] {
    const tz = this.timeZone();
    const frozen = openConflictIds(this.env);
    const list = surfacePromises(
      this.listMemory({ status: "active" }).filter((e) => !frozen.has(e.id)),
      now,
      tz,
      this.config.promise,
    );
    return list.map((e) => promiseLine(e, now, tz, this.config.promptLang === "en" ? "en" : "zh"));
  }

  // ---------- roadmap G7：会话轨迹（写过的 ≤ 20、查过的项目 ≤ 8） ----------
  private sessionWrites = new Map<string, string[]>();
  private sessionProjects = new Map<string, string[]>();

  noteSessionWrite(sessionId: string, id: string): void {
    const list = (this.sessionWrites.get(sessionId) ?? []).filter((x) => x !== id);
    list.push(id);
    this.sessionWrites.set(sessionId, list.slice(-20));
  }

  noteSessionProject(sessionId: string, project: string): void {
    if (!project) return;
    const list = (this.sessionProjects.get(sessionId) ?? []).filter((x) => x !== project);
    list.push(project);
    this.sessionProjects.set(sessionId, list.slice(-8));
  }

  /** 重放附加块：受 S2 预算约束（snapshotMaxChars 的一半） */
  replayBlock(sessionId: string): string {
    const en = this.config.promptLang === "en";
    const max = Math.max(200, Math.floor((this.config.budget.snapshotMaxChars ?? 2000) / 2));
    const lines: string[] = [];
    const writes = (this.sessionWrites.get(sessionId) ?? [])
      .map((id) => this.getMemory(id))
      .filter((e): e is MemoryEntry => !!e && e.status === "active");
    if (writes.length > 0) {
      lines.push(en ? "## Memories written in this session" : "## 本会话写过的记忆");
      for (const e of writes) lines.push("- [" + e.level + "] " + e.content);
    }
    const projects = this.sessionProjects.get(sessionId) ?? [];
    if (projects.length > 0) {
      lines.push(en ? "## Projects looked up in this session" : "## 本会话查过的项目");
      for (const p of projects) {
        const n = this.listMemory({ project: p, status: "active", limit: 200 }).length;
        lines.push("- " + p + (en ? " (" + n + " entries)" : "（" + n + " 条）"));
      }
    }
    let out = lines.join("\n");
    if (out.length > max) out = out.slice(0, max - 1) + "…";
    return out;
  }

  /** 会话原文旁路（§8.5）：默认关闭；FTS 索引未建时返回空 */
  quoteLookup(query: string): QuoteHit[] {
    if (this.config.quote.enabled !== true || !query) return [];
    return queryQuotes(this.env, query, 3);
  }

  /** 原文旁路数据源：$DSH_HOME/sessions（config.quote.sessionsDir 可覆盖） */
  quoteSessionsDir(): string {
    if (typeof this.config.quote.sessionsDir === "string" && this.config.quote.sessionsDir.length > 0) {
      return this.config.quote.sessionsDir;
    }
    const home = process.env.DSH_HOME;
    if (typeof home === "string" && home.length > 0) return join(home, "sessions");
    return join(dirname(this.env.dataDir), "sessions");
  }

  /**
   * 按文件 mtime 增量同步会话原文索引（§8.5）。
   * zstd 不可用时强制 quote.enabled=false（降级分支），返回 available:false。
   */
  async refreshQuoteIndex(opts?: { now?: number }): Promise<QuoteSyncReport> {
    if (!zstdAvailable()) {
      this.config.quote.enabled = false;
      return { available: false, files: 0, indexed: 0, skipped: 0, pruned: 0, rows: 0 };
    }
    if (this.config.quote.enabled !== true) {
      return { available: true, files: 0, indexed: 0, skipped: 0, pruned: 0, rows: 0 };
    }
    return syncSessionIndex(this.env, {
      sessionsDir: this.quoteSessionsDir(),
      indexDays: this.config.quote.indexDays,
      now: opts?.now,
    });
  }

  // ---------- Markdown 镜像（§8.6：只读派生视图，SQLite 为准） ----------

  private mirrorTimer: ReturnType<typeof setTimeout> | null = null;

  /** 立即重建（一键重建；手动改镜像产生的冲突以 SQLite 为准覆盖） */
  rebuildMirrorNow(): MirrorReport {
    return rebuildMirror(this.env, this.config.mirror);
  }

  /** 节流合并写（默认 60s）：窗口内多次写只落盘一次 */
  scheduleMirror(): void {
    if (this.config.mirror.enabled !== true || this.env.readonly) return;
    if (this.mirrorTimer !== null) return;
    const ms = this.config.mirror.rebuildDebounceMs;
    this.mirrorTimer = setTimeout(() => {
      this.mirrorTimer = null;
      try {
        rebuildMirror(this.env, this.config.mirror);
      } catch {
        // 镜像失败绝不阻塞会话
      }
    }, ms > 0 ? ms : 1);
    (this.mirrorTimer as unknown as { unref?: () => void }).unref?.();
  }

  /** 停表；flush=true 时把挂起的重建立刻落盘（dispose 用） */
  stopMirror(flush = true): void {
    if (this.mirrorTimer !== null) {
      clearTimeout(this.mirrorTimer);
      this.mirrorTimer = null;
    }
    if (!flush || this.env.readonly) return;
    try {
      rebuildMirror(this.env, this.config.mirror);
    } catch {
      // 同上
    }
  }

  // ---------- dream 收梭管线（§8.7 生命周期：过期 stale / 冷记忆合并 / 租约） ----------

  /** 手动触发（weave_consolidate / /weave dream）：与自动 dream 同一管线；resetFailures 解除失败上限 */
  consolidate(actor: string = "dream", opts?: { resetFailures?: boolean }): DreamReport {
    if (opts?.resetFailures === true) {
      try {
        resetDreamFailures(this.env);
      } catch {
        // 只读库等异常：继续尝试跑，结果里会带原因
      }
    }
    const r = consolidateNow(this.env, this.dreamCfg(), actor);
    if (r.ran) {
      this.pruneRecallLog();
      this.snapshotCurate();
    }
    this.scheduleMirror();
    return r;
  }

  /** 自动 dream 入口：空闲 ≥idleMinutes 且非峰时才跑（定时器调用） */
  maybeDream(): DreamReport {
    const r = runDream(this.env, this.dreamCfg(), "dream");
    if (r.ran) {
      this.pruneRecallLog();
      this.snapshotCurate();
      this.scheduleMirror();
    }
    return r;
  }

  /** roadmap C5：recall_log 只保留 logKeepDays（默认 90）天 */
  pruneRecallLog(now: number = Date.now()): number {
    try {
      return pruneRecallLog(this.env, this.config.recall?.logKeepDays ?? RECALL_LOG_KEEP_DAYS, now);
    } catch (e) {
      this.warn?.("recall_log prune failed: " + String(e));
      return 0;
    }
  }

  /** dream 运行配置：dream 段 + lifecycle（冷合并窗口月数/合并开关）合并 */
  private dreamCfg(): DreamConfigLike {
    return {
      ...this.config.dream,
      coldMemoryMonths: this.config.lifecycle.coldMemoryMonths,
      mergeOnDream: this.config.lifecycle.mergeOnDream,
      coRecall: this.config.links?.coRecall,
      boost: this.config.lifecycle.boost,
      staleAskDays: this.config.lifecycle.staleAskDays,
      distill: this.config.lifecycle.distill,
      maxCandidatesPerDream: this.config.lifecycle.maxCandidatesPerDream,
      promise: this.config.promise,
      groupDistill: this.config.distill,
      searchTerms: this.config.searchTerms,
      localTimeZone: this.timeZone(),
      contracts: (() => {
        try {
          return this.persona().config.contracts ?? [];
        } catch {
          return [];
        }
      })(),
    };
  }

  dreamStatus(): DreamStateRow & { due: boolean; peak: boolean } {
    const st = dreamState(this.env);
    const idleMs = this.config.dream.idleMinutes * 60000;
    const now = Date.now();
    return {
      ...st,
      peak: isPeakHour(now, this.config.dream.timezone, this.config.dream.peakHours),
      due: this.config.dream.enabled === true && now - lastActivityAt(this.env) >= idleMs,
    };
  }

  // ---------- 预设卡（§7.5：spec memweave-preset/1，不含记忆） ----------

  listPresets(): Array<{ id: string; spec: string; label: string | null; description: string | null; importedAt: number; builtin: boolean }> {
    const rows = this.env.db
      .prepare(
        "SELECT id, spec, label, description, source, imported_at FROM persona_presets" +
          " ORDER BY CASE WHEN source = 'builtin' THEN 0 ELSE 1 END, imported_at DESC, id",
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      spec: String(r.spec),
      label: r.label == null ? null : String(r.label),
      description: r.description == null ? null : String(r.description),
      importedAt: Number(r.imported_at ?? 0),
      builtin: r.source === "builtin",
    }));
  }

  /**
   * 内置预设写进 persona_presets（启动 / 彻底重置后调用）。
   * 只覆盖 source = 'builtin' 的同 id 行，插件升级时内置内容跟着更新；
   * 不改当前人格。只读模式下写不了就跳过。
   */
  seedBuiltinPresets(): number {
    let n = 0;
    try {
      const upsert = this.env.db.prepare(
        "INSERT INTO persona_presets (id, spec, label, description, author, tags, payload, source, imported_at)" +
          " VALUES (?, ?, ?, ?, NULL, NULL, ?, 'builtin', 0)" +
          " ON CONFLICT(id) DO UPDATE SET spec = excluded.spec, label = excluded.label," +
          " description = excluded.description, payload = excluded.payload" +
          " WHERE persona_presets.source = 'builtin'",
      );
      for (const p of BUILTIN_PRESETS) {
        const payload = JSON.stringify(sanitizePresetPayload(p.payload));
        const cur = this.env.db
          .prepare("SELECT payload, label, description, source FROM persona_presets WHERE id = ?")
          .get(p.id) as Record<string, unknown> | undefined;
        if (cur && (cur.source !== "builtin" || (cur.payload === payload && cur.label === p.label && cur.description === p.description))) continue;
        upsert.run(p.id, p.spec, p.label, p.description, payload);
        n += 1;
      }
      // 插件已下架的内置卡（旧版本写进库、新版本不再提供的 builtin- 行）：只删 source='builtin' 的行，用户自己的卡不动；
      // 已经应用到当前人格的内容不受影响（人格表与预设表分开存）
      const keep = BUILTIN_PRESETS.map((p) => p.id);
      const stale = this.env.db
        .prepare("DELETE FROM persona_presets WHERE source = 'builtin' AND id NOT IN (" + keep.map(() => "?").join(", ") + ")")
        .run(...keep) as { changes?: number };
      n += Number(stale.changes ?? 0);
    } catch {
      // 只读库 / 表不存在：内置预设不可用，不影响其它功能
    }
    return n;
  }

  getPreset(id: string): { id: string; payload: PersonaConfig } | null {
    const r = this.env.db.prepare("SELECT id, payload FROM persona_presets WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!r) return null;
    try {
      return {
        id: String(r.id),
        payload: sanitizePresetPayload(JSON.parse(String(r.payload)) as PersonaConfig),
      };
    } catch {
      return null;
    }
  }

  /** 应用 = 只覆盖卡里出现的白名单键；切卡前自动存 autosave（§7.5） */
  applyPreset(id: string, actor: string = "human"): { ok: boolean; message?: string; code?: ErrCode } {
    const preset = this.getPreset(id);
    if (!preset) return { ok: false, code: "E_VALID", message: "preset not found: " + id };
    const cur = this.persona().config;
    this.savePreset("autosave", cur, "auto save before applying " + id);
    const patch: Partial<PersonaConfig> = {};
    for (const key of PERSONA_KEYS) {
      if (Object.prototype.hasOwnProperty.call(preset.payload, key)) {
        (patch as Record<string, unknown>)[key] = (preset.payload as Record<string, unknown>)[key];
      }
    }
    const r = this.updatePersona(patch, actor);
    return r.ok ? { ok: true } : { ok: false, code: r.code, message: "apply failed" };
  }

  /**
   * 删除用户自己的预设卡（含 autosave）。内置卡不能删：删了下次启动也会被重新写回。
   * 不进撤销台账：删除就是为了让内容彻底不在库里，台账里存一份就白删了；审计只记 id 和标题。
   */
  deletePreset(id: string, actor: string): { ok: boolean; code?: ErrCode; message?: string } {
    if (id.startsWith(BUILTIN_PREFIX)) return { ok: false, code: "E_VALID", message: "内置预设不能删除" };
    const r = this.env.db.prepare("SELECT label, source FROM persona_presets WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!r) return { ok: false, code: "E_VALID", message: "preset not found: " + id };
    if (r.source === "builtin") return { ok: false, code: "E_VALID", message: "内置预设不能删除" };
    this.env.db.prepare("DELETE FROM persona_presets WHERE id = ?").run(id);
    addAudit(this.env, { actor, action: "preset.delete", target: id, before: r.label == null ? undefined : String(r.label) });
    this.scheduleMirror();
    return { ok: true };
  }

  savePreset(id: string, payload: PersonaConfig, label?: string): void {
    const ts = Date.now();
    this.env.db
      .prepare(
        "INSERT INTO persona_presets (id, spec, label, description, author, tags, payload, source, imported_at)" +
          " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)" +
          " ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, label = excluded.label," +
          " imported_at = excluded.imported_at",
      )
      .run(
        id,
        "memweave-preset/1",
        label ?? null,
        null,
        null,
        null,
        JSON.stringify(sanitizePresetPayload(payload)),
        "local",
        ts,
      );
  }

  // ---------- 备份 / 导入导出 / 彻底重置（§10.4 / §11.3） ----------

  listBackups(): Array<{ name: string; path: string; size: number; mtime: number }> {
    const dir = join(this.env.dataDir, "backups");
    try {
      return readdirSync(dir)
        .filter((n) => n.startsWith("memweave.db.bak."))
        .map((n) => {
          const p = join(dir, n);
          const st = statSync(p);
          return { name: n, path: p, size: st.size, mtime: st.mtimeMs };
        })
        .sort((x, y) => y.mtime - x.mtime);
    } catch {
      return [];
    }
  }

  async restoreBackup(path: string, actor: string): Promise<Record<string, unknown>> {
    const selected = this.listBackups().find((backup) => resolve(backup.path) === resolve(path));
    if (!selected) return { ok: false, code: "E_PERM", message: "backup path is not in the MemWeave backup directory" };
    try {
      const safetyBackup = await this.env.withExclusive(() => this.env.backup("before-restore"));
      await this.env.withExclusive(() => this.env.restoreFromBackup(selected.path));
      ensureSchema(this.env);
      await this.env.withWrite(() => addAudit(this.env, {
        actor,
        action: "backup.restore",
        target: selected.name,
        after: "restored; safety backup: " + safetyBackup,
      }));
      this.scheduleMirror();
      const reload = this.reload();
      return { ok: true, restored: selected.name, safetyBackup, reloadOk: reload.ok, reloadMessage: reload.message };
    } catch (e) {
      return { ok: false, code: "E_DB", message: "backup restore failed: " + String(e) };
    }
  }

  listImportRollbacks(): Array<{ rollbackId: string; at: number; actor: string; rolledBackAt: number | null }> {
    const rows = this.env.db.prepare("SELECT id, created_at, actor, rolled_back_at FROM import_undo ORDER BY created_at DESC").all() as Array<Record<string, unknown>>;
    const out = rows.map((row) => ({
      rollbackId: String(row.id),
      at: Number(row.created_at),
      actor: String(row.actor),
      rolledBackAt: row.rolled_back_at == null ? null : Number(row.rolled_back_at),
    }));
    const seen = new Set(out.map((row) => row.rollbackId));
    try {
      for (const name of readdirSync(join(this.env.dataDir, "import-undo"))) {
        if (!/^[A-Za-z0-9_-]{1,64}\.json$/.test(name)) continue;
        const item = JSON.parse(readFileSync(join(this.env.dataDir, "import-undo", name), "utf8")) as Record<string, unknown>;
        const rollbackId = String(item.rollbackId ?? name.slice(0, -5));
        if (!seen.has(rollbackId)) out.push({ rollbackId, at: Number(item.at ?? 0), actor: String(item.actor ?? "unknown"), rolledBackAt: null });
      }
    } catch {
      // No legacy rollback directory.
    }
    return out.sort((a, b) => b.at - a.at);
  }

  /** 导出（§11.3）：记忆 JSON（七层 + 元数据）+ 人格预设卡 + Markdown 镜像目录 */
  exportAll(): Record<string, unknown> {
    const memories = LEVEL_ORDER.flatMap((l) => listMemory(this.env, { level: l }));
    // 内置预设随插件自带，不进导出包（导到别处会变成普通预设，之后插件更新就跟不上了）
    const presets = this.listPresets()
      .filter((p) => !p.builtin)
      .map(({ builtin: _builtin, ...p }) => ({
        ...p,
        payload: this.getPreset(p.id)?.payload ?? null,
      }));
    return {
      spec: "memweave-export/1",
      exportedAt: Date.now(),
      persona: this.persona().config,
      presets,
      memories,
      mirror: this.exportMirror(),
    };
  }

  /** 镜像目录 → 文件名到文本（派生视图随导出附带；导入侧不回写，可随时重建） */
  exportMirror(): Record<string, string> {
    const dir = this.config.mirror?.dir ?? join(this.env.dataDir, "mirror");
    const out: Record<string, string> = {};
    try {
      const names = readdirSync(dir)
        .filter((n) => n.toLowerCase().endsWith(".md"))
        .sort()
        .slice(0, 50);
      for (const name of names) out[name] = readFileSync(join(dir, name), "utf8");
    } catch {
      // 无镜像目录：导出里给空对象
    }
    return out;
  }

  /** 导入预检（§11.3）：只认 memweave-export/1，报告 新增/跳过/冲突 */
  importScan(payload: Record<string, unknown>): Record<string, unknown> {
    if (payload.spec !== "memweave-export/1") {
      return { ok: false, code: "E_VALID", message: "只认 spec: memweave-export/1，其它格式拒绝导入" };
    }
    const memories = Array.isArray(payload.memories) ? (payload.memories as MemoryEntry[]) : [];
    let adds = 0;
    let skips = 0;
    let conflicts = 0;
    const seenHashes = new Set<string>();
    const seenSemantic = new Map<string, string>();
    for (const e of memories) {
      let kind = classifyImportEntry(this.env, e);
      if (kind === "ok") {
        const hash = contentHash(e.content);
        if (seenHashes.has(hash)) kind = "dup";
        else if (e.semanticKey && seenSemantic.has(e.semanticKey) && seenSemantic.get(e.semanticKey) !== e.content) kind = "conflict";
        else {
          seenHashes.add(hash);
          if (e.semanticKey) seenSemantic.set(e.semanticKey, e.content);
        }
      }
      if (kind === "ok") adds += 1;
      else if (kind === "conflict") conflicts += 1;
      else skips += 1;
    }
    const presets = Array.isArray(payload.presets) ? payload.presets : [];
    return {
      ok: true,
      adds,
      skips,
      conflicts,
      total: memories.length,
      presets: presets.length,
      mirror: payload.mirror && typeof payload.mirror === "object" ? Object.keys(payload.mirror).length : 0,
    };
  }

  /**
   * 导入（§11.3）：强制备份 → 分类落库（去重跳过 / 语义冲突不并入）→ 报告 + 回滚句柄。
   * 预设卡只收自家 id 白名单且不覆盖已有卡；镜像是派生视图，不回写（导入后自动重建）。
   */
  async importRun(payload: Record<string, unknown>, actor: string): Promise<Record<string, unknown>> {
    const scan = this.importScan(payload);
    if (scan.ok !== true) return scan;

    let backup = "";
    let added = 0;
    let skipped = 0;
    let conflicts = 0;
    let newPresetIds: string[] = [];
    let rollbackId = "";
    try {
      backup = this.env.backup("before-import");
      const memories = Array.isArray(payload.memories) ? (payload.memories as MemoryEntry[]) : [];
      const seenHashes = new Set<string>();
      const seenSemantic = new Map<string, string>();
      const reservedIds = new Set<string>();
      const additions: MemoryEntry[] = [];
      for (const e of memories) {
        let kind = classifyImportEntry(this.env, e);
        if (kind === "ok") {
          const hash = contentHash(e.content);
          if (seenHashes.has(hash)) kind = "dup";
          else if (e.semanticKey && seenSemantic.has(e.semanticKey) && seenSemantic.get(e.semanticKey) !== e.content) kind = "conflict";
          else {
            seenHashes.add(hash);
            if (e.semanticKey) seenSemantic.set(e.semanticKey, e.content);
          }
        }
        if (kind === "conflict") {
          conflicts += 1;
          continue;
        }
        if (kind !== "ok") {
          skipped += 1;
          continue;
        }
        const ts = Date.now();
        const id = e.id && !this.getMemory(e.id) && !reservedIds.has(e.id) ? e.id : newId();
        reservedIds.add(id);
        additions.push({
          ...e,
          id,
          hash: contentHash(e.content),
          createdAt: e.createdAt || ts,
          updatedAt: e.updatedAt || ts,
        });
        added += 1;
      }

      const presets = Array.isArray(payload.presets) ? (payload.presets as Array<Record<string, unknown>>) : [];
      const plannedPresets: Array<{ id: string; payload: PersonaConfig; label?: string }> = [];
      const seenPresetIds = new Set<string>();
      newPresetIds = [];
      for (const p of presets) {
        const id = typeof p?.id === "string" ? p.id : "";
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || id.startsWith(BUILTIN_PREFIX) || seenPresetIds.has(id) || this.getPreset(id)) continue;
        const card = (p.payload ?? null) as PersonaConfig | null;
        if (!card || typeof card !== "object") continue;
        seenPresetIds.add(id);
        newPresetIds.push(id);
        plannedPresets.push({ id, payload: sanitizePresetPayload(card), label: typeof p.label === "string" ? p.label : undefined });
      }

      const personaBefore = this.persona().config;
      const personaAfter = payload.persona && typeof payload.persona === "object"
        ? payload.persona as Partial<PersonaConfig>
        : null;
      rollbackId = "imp-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
      const undo = {
        rollbackId,
        at: Date.now(),
        actor,
        addedIds: additions.map((e) => e.id),
        addedItems: additions.map((e) => ({ id: e.id, hash: e.hash ?? undefined })),
        newPresetIds,
        personaBefore: personaAfter ? personaBefore : null,
      };

      await this.env.withWrite(() => {
        for (const entry of additions) insertMemory(this.env, entry);
        for (const preset of plannedPresets) this.savePreset(preset.id, preset.payload, preset.label);
        if (personaAfter) {
          const updated = updatePersona(this.env, personaAfter, actor);
          if (!updated.ok) throw new Error("persona import failed: " + String(updated.code));
        }
        this.env.db.prepare(
          "INSERT INTO import_undo (id, created_at, actor, payload, rolled_back_at) VALUES (?, ?, ?, ?, NULL)",
        ).run(rollbackId, undo.at, actor, JSON.stringify(undo));
        addAudit(this.env, {
          actor,
          action: "import.run",
          target: "memweave-export/1",
          after: JSON.stringify({ added, skipped, conflicts, rollbackId }),
        });
      });
    } catch (e) {
      return { ok: false, code: "E_DB", message: "import failed: " + String(e) };
    }
    this.scheduleMirror();
    return { ok: true, added, skipped, conflicts, backup, rollbackId, presets: newPresetIds.length };
  }

  /** 可回滚（§11.3）：按回滚句柄撤销本次导入（新增条目 / 新预设卡 / 人格还原） */
  async rollbackImport(rollbackId: string, actor: string = "human"): Promise<Record<string, unknown>> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(rollbackId)) {
      return { ok: false, code: "E_VALID", message: "bad rollback id" };
    }
    const file = join(this.env.dataDir, "import-undo", rollbackId + ".json");
    let undo: {
      addedIds?: string[];
      addedItems?: Array<{ id: string; hash?: string }>;
      newPresetIds?: string[];
      personaBefore?: PersonaConfig | null;
    };
    const stored = this.env.db.prepare("SELECT payload, rolled_back_at FROM import_undo WHERE id = ?").get(rollbackId) as
      | { payload: string; rolled_back_at: number | null }
      | undefined;
    const durable = Boolean(stored);
    if (stored?.rolled_back_at != null) {
      return { ok: true, removed: 0, skipped: 0, personaRestored: false, alreadyRolledBack: true };
    }
    try {
      undo = stored ? JSON.parse(stored.payload) as typeof undo : JSON.parse(readFileSync(file, "utf8")) as typeof undo;
    } catch {
      return { ok: false, code: "E_VALID", message: "rollback id not found: " + rollbackId };
    }
    let removed = 0;
    let skipped = 0;
    try {
      const didRollback = await this.env.withWrite(() => {
        if (durable) {
          const handle = this.env.db.prepare("SELECT rolled_back_at FROM import_undo WHERE id = ?").get(rollbackId) as { rolled_back_at: number | null } | undefined;
          if (!handle || handle.rolled_back_at != null) return false;
        }
        const items: Array<{ id: string; hash?: string }> = undo.addedItems ?? (undo.addedIds ?? []).map((id) => ({ id }));
        for (const item of items) {
          const current = getMemory(this.env, item.id);
          if (!current) continue;
          if (item.hash && current.hash !== item.hash) {
            skipped += 1;
            continue;
          }
          forgetMemory(this.env, item.id, actor);
          removed += 1;
        }
        for (const pid of undo.newPresetIds ?? []) {
          this.env.db.prepare("DELETE FROM persona_presets WHERE id = ?").run(pid);
        }
        if (undo.personaBefore) {
          const restored = updatePersona(this.env, undo.personaBefore, actor);
          if (!restored.ok) throw new Error("persona rollback failed: " + String(restored.code));
        }
        addAudit(this.env, {
          actor,
          action: "import.rollback",
          target: rollbackId,
          after: JSON.stringify({ removed, skipped }),
        });
        if (durable) {
          this.env.db.prepare("UPDATE import_undo SET rolled_back_at = ? WHERE id = ? AND rolled_back_at IS NULL").run(Date.now(), rollbackId);
        }
        return true;
      });
      if (!didRollback) {
        return { ok: true, removed: 0, skipped: 0, personaRestored: false, alreadyRolledBack: true };
      }
    } catch (e) {
      return { ok: false, code: "E_DB", message: "import rollback failed: " + String(e) };
    }
    this.scheduleMirror();
    return { ok: true, removed, skipped, personaRestored: undo.personaBefore != null };
  }

  /** 彻底重置（D15）：强制备份 → 清库 → 人格恢复出厂 → 审计 */
  async resetAll(actor: string): Promise<Record<string, unknown>> {
    const backup = this.env.backup("before-reset");
    const result = await this.env.withWrite(() => {
      const legacyHandles = this.listImportRollbacks();
      const tables = [
        ...LEVEL_ORDER.map((l) => LAYER_TABLES[l]),
        "candidates",
        "conflicts",
        "links",
        "audit_log",
        "inject_state",
        "budget_ledger",
        "undo_log",
        "persona_history",
        "persona_presets",
        "session_fts",
        "session_files",
      ];
      for (const t of tables) {
        try {
          this.env.db.exec("DELETE FROM " + t);
        } catch {
          // 表不存在（如 session_fts）时忽略
        }
      }
      const invalidatedAt = Date.now();
      this.env.db.prepare("UPDATE import_undo SET rolled_back_at = COALESCE(rolled_back_at, ?)").run(invalidatedAt);
      for (const handle of legacyHandles) {
        this.env.db.prepare(
          "INSERT OR IGNORE INTO import_undo (id, created_at, actor, payload, rolled_back_at) VALUES (?, ?, ?, '{}', ?)",
        ).run(handle.rollbackId, handle.at, handle.actor, invalidatedAt);
      }
      this.env.db.exec("DELETE FROM persona");
      this.seedBuiltinPresets();
      clearMirror(this.config.mirror);
      addAudit(this.env, { actor, action: "reset", target: "all", after: "factory-defaults" });
      return true;
    });
    const reload = result ? this.reload() : { ok: false, message: "reset failed" };
    return { ok: result, backup, reloadOk: reload.ok, reloadMessage: reload.message };
  }
}

/** 预设卡白名单键（P4：MUST NOT 携带记忆） */
const PERSONA_KEYS: Array<keyof PersonaConfig> = [
  "enabled",
  "selfNameByModel",
  "selfNamePro",
  "selfNameFlash",
  "userName",
  "stance",
  "character",
  "suffix",
  "appearance",
  "tone",
  "contracts",
  "thinkingLanguage",
  "meta",
  "applyNextSession",
];

/** 三路之二：关键词（BM25）+ 关联图（links 一跳），RRF 融合；硬过滤 status/valid_to/conflicts */
/** roadmap G14：注入页用的召回解释（每条一行，正文截 40 字） */
export function recallDetail(hits: RankedHit[]): string {
  return hits
    .map((h, i) => {
      const brief = h.entry.content.replace(/\s+/g, " ");
      return (i + 1) + ". [" + h.entry.level + "·imp" + h.entry.importance + "] " +
        (brief.length > 40 ? brief.slice(0, 40) + "…" : brief) +
        "\n   score=" + h.score.toFixed(5) + "; " + h.explain;
    })
    .join("\n");
}

export function recallEntries(
  env: WeaveEnv,
  query: string,
  opts?: {
    limit?: number;
    project?: string | null;
    halfLife?: Record<Level, number>;
    rrfK?: number;
    /** 附录 A recall.routes：启用的路由（缺省 keyword+link；semantic 由向量路占位，未开即空） */
    routes?: string[];
    /** 附录 A recall.weights：路由权重（缺省 keyword 1.0 / link 0.5） */
    weights?: { keyword?: number; semantic?: number; link?: number };
    /** 附录 A recall.synonymsFile：附加同义词组 */
    aliasGroups?: string[][];
    /** roadmap R5：反刍抑制（缺省开） */
    rumination?: RuminationConfig;
    /** roadmap R4：去同质（缺省开） */
    diversity?: DiversityConfig;
    /** roadmap C6：恢复旧访问加成（仅等价测试） */
    legacyAccessBonus?: boolean;
    /** roadmap R11 / R10（缺省关） */
    intent?: IntentConfig;
    emotion?: EmotionConfig;
    /** roadmap v0.6 M1 / M2 */
    promise?: PromiseConfig;
    calendar?: CalendarConfig;
    /** roadmap v0.7 S1 */
    searchTerms?: SearchTermsConfig;
    now?: number;
  },
): RankedHit[] {
  const now = opts?.now ?? Date.now();
  const useKeyword = opts?.routes === undefined || opts.routes.includes("keyword");
  const useLink = opts?.routes === undefined || opts.routes.includes("link");
  const groups = mergeAliasGroups(DEFAULT_ALIAS_GROUPS, opts?.aliasGroups);
  const frozen = new Set<string>();
  for (const c of listConflicts(env, "open")) {
    for (const t of c.contenders) frozen.add(t.id);
  }
  const entries: MemoryEntry[] = [];
  for (const e of listMemory(env, { status: "active" })) {
    if (frozen.has(e.id)) continue;
    if (e.validTo !== null && e.validTo !== undefined && e.validTo <= now) continue;
    if (opts?.project !== undefined && opts.project !== null && e.project !== opts.project) continue;
    entries.push(e);
  }
  const entryMap = new Map(entries.map((e) => [e.id, e]));
  const qTokens = normalizeAliases(tokenize(query), groups);
  const docs = entries.map((e) => ({
    id: e.id,
    tokens: normalizeAliases(tokenize(e.content + " " + e.keywords.join(" ")), groups),
  }));
  const bm = bm25Scores(qTokens, docs);
  const ranked = [...bm.entries()]
    .filter(([, s]) => s > 0)
    .sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1));
  const keywordHit = new Set(useKeyword ? ranked.map(([id]) => id) : []);

  const routes: RouteRank[] = [];
  if (useKeyword) {
    const kw = opts?.weights?.keyword ?? 1.0;
    ranked.forEach(([id], i) => routes.push({ id, rank: i + 1, weight: kw, route: "keyword" }));
  }

  const linkKinds = new Map<string, Set<string>>();
  if (useLink) {
    const linkScore = new Map<string, number>();
    for (const [id] of ranked.slice(0, 3)) {
      for (const l of getLinks(env, id)) {
        const other = l.src === id ? l.dst : l.src;
        // 关联路只负责「带进关键词没找到的」：已是关键词命中的不再叠加，避免同簇互相抬分
        if (!entryMap.has(other) || other === id || keywordHit.has(other)) continue;
        linkScore.set(other, (linkScore.get(other) ?? 0) + l.weight);
        const kinds = linkKinds.get(other) ?? new Set<string>();
        kinds.add(l.kind);
        linkKinds.set(other, kinds);
      }
    }
    const lw = opts?.weights?.link ?? 0.5;
    [...linkScore.entries()]
      .sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))
      .forEach(([id], i) => routes.push({ id, rank: i + 1, weight: lw, route: "link" }));
  }

  // roadmap v0.6 M2：窗口内的锚点条目强制进候选池（RRF 记一路 calendar，权重同关联路）
  const calCfg = opts?.calendar;
  const tz = calCfg ? resolveTimeZone(calCfg) : "UTC";
  const calHits = new Map<string, CalendarMatch>();
  if (calCfg?.enabled) {
    for (const e of entries) {
      const m = matchAnchor(e.calendarAnchor, now, tz, calCfg);
      if (m) calHits.set(e.id, m);
    }
    const lw = opts?.weights?.link ?? 0.5;
    [...calHits.entries()]
      .sort((x, y) => y[1].boost - x[1].boost || x[1].days - y[1].days || (x[0] < y[0] ? -1 : 1))
      .forEach(([id], i) => routes.push({ id, rank: i + 1, weight: lw, route: "calendar" }));
  }
  const promCfg = opts?.promise;

  // roadmap v0.7 S1：检索词路。只对 search_terms 做 BM25，权重 0.4、只取前 routeTop 名（§6.6 实测定参）
  const termsCfg = opts?.searchTerms;
  const termsHit = new Map<string, string[]>();
  // 和 calendar 路一样由自己的开关控制，不受 recall.routes 白名单（旧配置只有 keyword/link）限制
  if (termsCfg?.enabled) {
    const tdocs = entries
      .filter((e) => e.searchTerms && e.searchTerms.length > 0)
      .map((e) => ({ id: e.id, tokens: normalizeAliases(tokenize(e.searchTerms!.join(" ")), groups) }));
    if (tdocs.length > 0) {
      const qset = new Set(qTokens);
      const tw = termsCfg.routeWeight;
      [...bm25Scores(qTokens, tdocs).entries()]
        .filter(([, s]) => s > 0)
        .sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))
        .slice(0, Math.max(1, termsCfg.routeTop))
        .forEach(([id], i) => {
          routes.push({ id, rank: i + 1, weight: tw, route: "terms" });
          // trace：哪几个检索词（别名归一后）和查询有共同分词
          const terms = entryMap.get(id)!.searchTerms!;
          termsHit.set(id, terms.filter((t) => normalizeAliases(tokenize(t), groups).some((k) => qset.has(k))));
        });
    }
  }

  const fused = rrfFuse(routes, opts?.rrfK ?? 60);
  const rum = opts?.rumination ?? DEFAULT_RUMINATION;
  const recent = rum.enabled
    ? recentRecallCounts(env, [...fused.keys()], rum.windowHours * 3600000, now)
    : new Map<string, number>();
  const scored = finalizeRanking(fused, entryMap, now, opts?.halfLife ?? DEFAULT_HALF_LIFE_DAYS, {
    recentRecalls: recent,
    rumination: rum,
    legacyAccessBonus: opts?.legacyAccessBonus === true,
    intent: opts?.intent?.enabled ? detectIntent(query, opts.intent) : undefined,
    intentFactor: opts?.intent?.factor,
    flashFactor: opts?.emotion?.enabled ? opts.emotion.factor : undefined,
    extra:
      promCfg?.enabled || calHits.size > 0 || (opts?.emotion?.enabled && opts.emotion.residue?.enabled)
        ? (e) => {
            const p = promCfg?.enabled ? promiseScore(e, now, promCfg) : null;
            const c = calHits.get(e.id);
            const floor = residueFloor(e, opts?.emotion);
            if (!p && !c && floor === null) return null;
            if (!p && !c) return { decayFloor: floor! };
            const traces: string[] = [];
            let factor = 1;
            if (p) {
              factor *= p.factor;
              traces.push(p.trace);
            }
            if (c && calCfg) {
              factor *= 1 + calCfg.factor * c.boost;
              traces.push(anchorTrace(c));
            }
            return { ...(p ? { decay: 1 } : {}), ...(floor !== null ? { decayFloor: floor } : {}), factor, trace: traces.join("; ") };
          }
        : undefined,
  }).map((h) => {
    const kinds = linkKinds.get(h.id);
    let explain = kinds && h.routes.includes("link") ? h.explain + "; link=" + [...kinds].sort().join("|") : h.explain;
    const tm = termsHit.get(h.id);
    if (tm && h.routes.includes("terms")) explain += "; terms=" + (tm.length > 0 ? tm.join("|") : "?");
    return explain === h.explain ? h : { ...h, explain };
  });
  // 去同质相似度：关键词集合 Jaccard 与正文二元组 Jaccard 取大（两条都有显式关键词时前者才参与）
  const cache = new Map<string, { kw: Set<string>; body: Set<string> }>();
  const setsOf = (h: RankedHit) => {
    let s = cache.get(h.id);
    if (!s) {
      s = { kw: new Set(h.entry.keywords.map((k) => k.toLowerCase())), body: new Set(tokenize(h.entry.content)) };
      cache.set(h.id, s);
    }
    return s;
  };
  const sim = (a: RankedHit, b: RankedHit): number => {
    const x = setsOf(a);
    const y = setsOf(b);
    return Math.max(jaccard(x.kw, y.kw), jaccard(x.body, y.body));
  };
  return diversify(scored, opts?.limit ?? 5, sim, opts?.diversity ?? DEFAULT_DIVERSITY);
}

export function serviceStatus(s: WeaveService): StatusReport {
  return s.status();
}

export function defaultPersonaConfig(): PersonaConfig {
  return defaultPersona();
}
