/**
 * 忆织 MemWeave —— 服务门面：聚合 dao / govern / render，供 host/tools/rpc 共用
 * （三个写面同源：AI 工具 / CLI / UI 全走这里）
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { contentHash } from "../core/hash";
import { FileLogger, normalizeLevel } from "./logger";
// 画像生成
import {
  DEFAULT_DECAY_FLOOR,
  DEFAULT_DIVERSITY,
  DEFAULT_HALF_LIFE_DAYS,
  DEFAULT_RUMINATION,
  normalizeDecayFloor,
  normalizeHalfLife,
  type DiversityConfig,
  type RankedHit,
  type RuminationConfig,
} from "../core/score";
import {
  DEFAULT_PROMISE,
  isPending,
  PROMISE_DUE_REASON,
  type PromiseConfig,
} from "../core/promise";
import { safeZone } from "../core/localdate";
import {
  DEFAULT_CALENDAR,
  resolveTimeZone,
  type CalendarConfig,
} from "../core/calendar";
import { DEFAULT_SEARCH_TERMS, type SearchTermsConfig } from "../core/terms";
import {
  DEFAULT_GROUP_DISTILL,
  DISTILL_CAND_REASON,
  groupMembers,
  landDistill,
  undoDistill,
  type DistillUndo,
  type GroupDistillConfig,
} from "../store/distill-queue";
import { getDistillGroup, setDistillStatus } from "../store/dao";
import type { ProfileConfig } from "../profile/types";
// 隐私保护
import type { PrivacyConfig } from "../privacy/types";
import { DEFAULT_PRIVACY_CONFIG } from "../privacy/types";
import { SensitivityDetector } from "../privacy/detector";
import { redactMemoryEntry, redactText } from "../privacy/redact";
// 冲突解决
import type { ConflictConfig, MemoryConflict, ConflictResolveOptions, ConflictDetectionResult } from "../conflict/types";
import { DEFAULT_CONFLICT_CONFIG } from "../conflict/types";
import { ConflictDetector } from "../conflict/detector";

import type { BackupConfig, BackupOptions, BackupResult, BackupInfo, RestoreOptions, RestoreResult, VerificationResult } from "../backup/types";
import { DEFAULT_BACKUP_CONFIG } from "../backup/types";
import { BackupManager } from "../backup/manager";

/** 待整理队列。默认只提示、不自己开始（F1） */
export interface CurateConfig {
  enabled: boolean;
  autoProcess: boolean;
  promptOncePerDay: boolean;
}
export const DEFAULT_CURATE: CurateConfig = { enabled: true, autoProcess: false, promptOncePerDay: true };
import type { PromiseState } from "../core/types";
import {
  DEFAULT_AUTOLINK,
  RECALL_LOG_KEEP_DAYS,
  autoLink,
  jaccard,
  pruneRecallLog,
  type AutoLinkConfig,
} from "../store/link";
import { mergeAliasGroups, tokenize } from "../core/tokenize";
import {
  DEFAULT_BUDGET,
  LEVEL_ORDER,
  type Actor,
  type BudgetConfig,
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
import { type LeaseGuard } from "../store/lease";
import {
  addAudit,
  appendUndo,
  countByLevel,
  decideCandidate,
  defaultPersona,
  findActiveByHash,
  findConflictingSemanticKey,
  forgetMemory,
  getCandidate,
  getInjectState,
  getLedger,
  listLedgerSessions,
  getLinks,
  getMemory,
  getPersona,
  insertCandidate as insertCandidateRow,
  insertMemory,
  listCandidates,
  listConflicts,
  listMemory,
  listPersonaHistory,
  newId,
  queryAudit,
  resolveConflict,
  reviseMemory,
  updatePersona,
  type AuditRow,
  type CandidateRow,
  type ConflictRow,
  type InjectState,
  type LedgerRow,
  type PersonaHistoryRow,
  type UndoRow,
} from "../store/dao";
import { similar, scanSensitiveContent, MAX_CONTENT, type WriteInput, type WriteOutcome } from "../store/govern";
import {
  clearMirror,
  rebuildMirror,
  type MirrorConfigLike,
  type MirrorReport,
} from "../store/mirror";
import {
  type DreamConfigLike,
  type DreamReport,
  type DreamStateRow,
} from "../store/dream";
import {
  type QuoteHit,
  type QuoteSyncReport,
} from "../store/quote";
import { CONTRACT_ID_PREFIX, CONTRACT_TEXT_MAX, PROMOTION_REASON } from "../store/promote";
import { REVIEW_REASON } from "../store/review";
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
} from "../store/dream-rounds";
// 短期上下文 Offload
import { OffloadManager, DEFAULT_OFFLOAD_CONFIG, type OffloadConfig } from "../offload";
// L2 场景块
import { SceneManager, DEFAULT_SCENE_CONFIG, type SceneAggregationConfig } from "../scene";
// 多模型 Persona
import {
  PersonaManager,
  DEFAULT_MULTI_PERSONA_CONFIG,
  clearSessionPersona as clearSessionPersonaStorage,
  getSessionPersona as getSessionPersonaStorage,
  setSessionPersona as setSessionPersonaStorage,
  type MultiPersonaConfig,
  type SessionPersona,
  type SessionPersonaOverrides,
} from "../persona";
// 向量后端与可选依赖改为静态导入 / 统一加载器
import {
  clearAllVectors,
  clearAllVectorsAsync,
  detectBestBackend,
  enqueueEmbedding,
  getEmbeddingConfig as getEmbeddingConfigStore,
  getEmbeddingProvider as getEmbeddingProviderStore,
  getSqliteVecSource,
  getVectorBackend,
  getVectorConfig as getVectorConfigStore,
  getVectorStats,
  resetBackendDetection,
  searchSimilar as searchSimilarStore,
  setEmbeddingProvider as setEmbeddingProviderStore,
  setVectorConfig,
  updateEmbeddingConfig as updateEmbeddingConfigStore,
  type EmbeddingProvider,
} from "../store/vector";
import {
  getQueueStatus,
  pruneCompletedJobs,
  retryFailedJobs,
  runVectorWorker as runVectorWorkerStore,
} from "../store/vector-worker";
import { optionalDepStatus } from "../store/vector-loader";
import {
  createHttpEmbeddingProvider,
  createLocalHashEmbeddingProvider,
  discoverEmbeddingConfig,
  embeddingDiscoveryEnabled,
  LOCAL_HASH_DIMENSIONS,
  LOCAL_HASH_MODEL,
  LOCAL_HASH_PROVIDER,
  probeEmbeddingConfig,
  resolveEmbeddingConfig,
  type DiscoveredEmbeddingConfig,
  type EmbeddingDiscoveryOptions,
  type HttpEmbeddingConfig,
} from "../store/embedding";
import {
  createLocalModelEmbeddingProvider,
  getLocalModel,
  localModelReady,
  LOCAL_MODEL_DIMENSIONS,
  LOCAL_MODEL_ID,
  LOCAL_MODEL_PROVIDER,
} from "../store/local-model";

/** 接受后要真正写进记忆的 L2 写入候选（把关分流过来的） */
const WRITE_REASONS = new Set(["strict-mode-need-human", "level-need-confirm", "delete-nature", "auto-accept-off", "distill-rules"]);
import { bumpRelation as bumpRelationStore, type RelationPatch, type RelationResult } from "../store/relation";
import { LAYER_TABLES, SCHEMA_VERSION } from "../store/schema";
import { runHealthCheck, type HealthReport } from "../store/health";
import { getQueueDetail, getQueueStats, type QueueDetail, type QueueStats } from "../store/queue-monitor";
import { getMemoryDetail, type MemoryDetail } from "../store/evidence-tracker";
// 召回实现搬到 ./recall（纯搬迁，行为不变），这里继续对外导出同一组符号
import {
  RECALL_PREFILTER_LIMIT,
  clearDocTokenCache,
  recallDetail,
  recallEntries,
  recallEntriesAsync,
} from "./recall";
export { RECALL_PREFILTER_LIMIT, clearDocTokenCache, recallDetail, recallEntries, recallEntriesAsync };

// 隐私查询与冲突治理搬到 ./govern（纯搬迁，行为不变）
import {
  detectConflicts as governDetectConflicts,
  detectSensitiveInfo as governDetectSensitive,
  getSensitiveTypes as governSensitiveTypes,
  hasSensitiveInfo as governHasSensitive,
  listConflicts as listConflictRows,
  listSensitiveMemories,
  markMemorySensitive,
  resolveMemoryConflict as governResolveConflict,
  setMemorySensitive,
} from "./govern";

// dream 管线与待整理队列搬到 ./dream（纯搬迁，行为不变）
import {
  CuratePrompter,
  backlog as dreamBacklog,
  backlogCounts as dreamBacklogCounts,
  consolidate as dreamConsolidate,
  dreamCfg as dreamCfgOf,
  dreamStatus as dreamStatusOf,
  maybeDream as dreamMaybeDream,
  pruneGovernanceLogs as dreamPruneGovernanceLogs,
  pruneRecallLog as dreamPruneRecallLog,
  pruneUndoContent as dreamPruneUndoContent,
  submitDistill as dreamSubmitDistill,
} from "./dream";

// 库位置与备份恢复搬到 ./backup（纯搬迁，行为不变）
import {
  backupNow as backupNowOf,
  createBackup as createBackupOf,
  dataLocation as dataLocationOf,
  deleteBackup as deleteBackupOf,
  listBackupsEnhanced as listBackupsEnhancedOf,
  persistSettings as persistSettingsOf,
  relocate as relocateData,
  restoreBackupEnhanced as restoreBackupEnhancedOf,
  verifyBackup as verifyBackupOf,
} from "./backup";

// 注入装配与原文索引搬到 ./render（纯搬迁，行为不变）
import {
  SessionRenderState,
  preview as previewOf,
  previewWithContext as previewWithContextOf,
  promiseLines as promiseLinesOf,
  quoteLookup as quoteLookupOf,
  quoteSessionsDir as quoteSessionsDirOf,
  refreshQuoteIndex as refreshQuoteIndexOf,
  renderPersona as renderPersonaOf,
  renderTurn as renderTurnOf,
  renderTurnAsync as renderTurnAsyncOf,
  snapshotItems as snapshotItemsOf,
} from "./render";

// 写入主链、修订归档与撤销搬到 ./write（纯搬迁，行为不变）
import {
  annotate as writeAnnotate,
  archive as writeArchive,
  forget as writeForget,
  remember as writeRemember,
  restore as writeRestore,
  revise as writeRevise,
  setAnchor as writeSetAnchor,
  setFlash as writeSetFlash,
  setTerms as writeSetTerms,
  settlePromise as writeSettlePromise,
  termsSensitive as writeTermsSensitive,
  undo as writeUndo,
  undoList as writeUndoList,
  type WriteHost,
} from "./write";
import { BUILTIN_PREFIX, BUILTIN_PRESETS } from "../presets";

export interface WeaveConfig {
  dataDir: string;
  promptLang: "zh" | "en";
  strict: boolean;
  quote: { enabled: boolean; indexDays: number; sessionsDir?: string };
  mirror: { enabled: boolean; rebuildDebounceMs: number; maxFileKb: number; maxLines: number; dir?: string };
  dream: DreamConfigLike;
  budget: BudgetConfig;
  /** 附录 A memory.hitTopK：每消息注入的召回命中条数（S3） */
  memory: { hitTopK: number };
  /** 附录 A recall：路由与融合参数（routes/rrfK/weights/synonymsFile） */
  recall: {
    routes: string[];
    rrfK: number;
    weights: { keyword: number; semantic: number; link: number };
    synonymsFile?: string;
    /** 语义路的最小余弦：本地小模型的相关度普遍落在 0.45–0.6，0.5 会整段被丢掉 */
    semanticMinScore?: number;
    diversity: DiversityConfig;
    rumination: RuminationConfig;
    /** recall_log 保留天数 */
    logKeepDays: number;
    /** 仅等价测试用，界面不展示 */
    legacyAccessBonus: boolean;
    intent: IntentConfig;
  };
  emotion: EmotionConfig;
  promise: PromiseConfig;
  calendar: CalendarConfig;
  /** S1 */
  searchTerms: SearchTermsConfig;
  /** 会话内归纳（与 lifecycle.distill 的 项目摘要是两件事） */
  distill: GroupDistillConfig;
  /** 待整理队列 */
  curate: CurateConfig;
  links: { autoLink: AutoLinkConfig; coRecall: CoRecallConfig };
  /** 文件日志；dir 留空为 <dataDir>/logs */
  log: { dir: string; maxFileMb: number; keepDays: number };
  /** 设置页「日志级别」 */
  logLevel?: string;
  /** 连续工具调用后提示反思 */
  reflect: { enabled: boolean; afterToolSteps: number };
  /** 压缩后重放 */
  replay: { enabled: boolean };
  write: {
    surprise: { enabled: boolean };
    sourceWeight: { enabled: boolean };
    containment: { enabled: boolean; jaccard: number; containment: number };
  };
  /** 附录 A lifecycle：衰减与冷合并策略 */
  lifecycle: {
    halfLifeDays: Record<Level, number>;
    /** 衰减下限（0 = 不设下限，恢复 之前的纯指数衰减） */
    decayFloor: number;
    coldMemoryMonths: number;
    mergeOnDream: boolean;
    autoDream: boolean;
    boost: BoostConfig;
    /** stale 持续天数达到后询问归档 */
    staleAskDays: number;
    distill: DistillConfig;
    /** 每次 dream 最多新增候选 */
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
    /** 审计日志保留天数 */
    auditKeepDays?: number;
    /** 预算账本保留天数 */
    budgetKeepDays?: number;
    /** 撤销日志保留天数（超出 undoWindowHours 后可删除） */
    undoKeepDays?: number;
    /** 候选池保留天数（已决裁或已合并的候选） */
    candidateKeepDays?: number;
    /** 冲突记录保留天数 */
    conflictKeepDays?: number;
  };
  /** 用户画像 */
  profile?: ProfileConfig;
  /** 短期上下文 offload */
  offload?: OffloadConfig;
  /** L2 场景块 */
  scene?: SceneAggregationConfig;
  /** 多模型 persona */
  multiPersona?: MultiPersonaConfig;
  /** 隐私与敏感信息保护 */
  privacy?: PrivacyConfig;
  /** 记忆冲突解决 */
  conflict?: ConflictConfig;
  /** 备份恢复完整性 */
  backup?: BackupConfig;
  /**
   * 宿主 embedding 能力（OpenAI 兼容 HTTP）。
   * 不配置 = 向量主路径保持停用；配置后语义路参与融合，并在状态/健康检查里显式呈现。
   */
  embedding?: Partial<HttpEmbeddingConfig>;
  [k: string]: unknown;
}

/** 默认时区跟随运行环境；拿不到就用 UTC（面向全球用户，不写死 Asia/Shanghai） */
function systemTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
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
      timezone: systemTimeZone(),
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
      // 0.5 是给 OpenAI 这类大模型的；bge-small-zh 这类 512 维小模型相关度普遍低一截
      // 实测 107 条真实记忆里相关条目在 0.45–0.62，卡 0.5 会只剩一两条。
      semanticMinScore: 0.42,
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
      // 老条目保留 10% 权重，不被指数衰减抹成噪声
      decayFloor: DEFAULT_DECAY_FLOOR,
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
      auditKeepDays: 90,
      budgetKeepDays: 30,
      undoKeepDays: 30,
      candidateKeepDays: 90,
      conflictKeepDays: 90,
    },
    offload: { ...DEFAULT_OFFLOAD_CONFIG },
    scene: { ...DEFAULT_SCENE_CONFIG },
    multiPersona: { ...DEFAULT_MULTI_PERSONA_CONFIG },
    privacy: { ...DEFAULT_PRIVACY_CONFIG },
    conflict: { ...DEFAULT_CONFLICT_CONFIG },
    backup: { ...DEFAULT_BACKUP_CONFIG },
  };
}

/** 硬规则：预设卡导出永远不含记忆类数据 */
const PRESET_FORBIDDEN_KEYS = ["memory", "memories", "candidates", "conflicts", "entries", "audit", "ledger"];

export function sanitizePresetPayload(payload: PersonaConfig): PersonaConfig {
  const out: Record<string, unknown> = { ...(payload as Record<string, unknown>) };
  for (const k of PRESET_FORBIDDEN_KEYS) delete out[k];
  return out as PersonaConfig;
}

const VALID_LEVELS = new Set<string>(LEVEL_ORDER);


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

// 扩展诊断信息
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
  paused: boolean;
  pauseReason: string;
  dataDirSource: "config" | "pointer" | "default";
  sectionRegistered: boolean;
  sectionNames: string[];
  lastReloadAt?: number;
  // 向量后端状态
  vectorBackend: "sqlite-vec" | "vectra" | "builtin" | "disabled";
  /** sqlite-vec 来自包内二进制还是 npm 可选依赖；没生效时为 null */
  sqliteVecSource?: "bundled" | "npm" | null;
  vectorStats?: {
    indexed: number;
    pending: number;
    failed: number;
    totalActive: number;
    /** 维度与当前模型不符的旧向量（切模型后需要重建） */
    stale?: number;
  };
  // embedding 配置
  embeddingConfig?: {
    provider: string | null;
    model: string | null;
    dimensions: number;
    updatedAt: number | null;
  } | null;
  /** 注入的 provider（与 DB 配置分开：配置 ≠ 真的注入成功） */
  embeddingProvider?: { provider: string; model: string; dimensions: number } | null;
  /** 语义路当前是否真的会参与召回，以及不参与的原因 */
  vectorRoute?: { enabled: boolean; reason: "ready" | "no-provider" | "no-backend" | "not-configured" | "disabled" };
  /** 自动发现（本机 → 云）进行到哪一步；失败时带原因 */
  embeddingDiscovery?: {
    status: "pending" | "found" | "none" | "failed";
    message?: string;
    source?: string;
  } | null;
  /**
   * 设置页「保存并测试」表单的预填值。
   * apiKey 只报有无，绝不回显 —— 状态接口对 agent 可读。
   */
  embeddingSettings?: {
    enabled: boolean;
    provider: string | null;
    baseUrl: string;
    model: string;
    dimensions: number | null;
    hasApiKey: boolean;
    timeoutMs: number;
  } | null;
}

export class WeaveService {
  readonly env: WeaveEnv;
  config: WeaveConfig;
  /** 记忆库目录来自哪里：插件配置 / 设置页指定 / 默认 */
  dataDirSource: "config" | "pointer" | "default" = "default";
  /** 设置页「恢复默认」用的出厂值（openService 填入；直接 new 时退回内置默认） */
  defaults: WeaveConfig | null = null;
  /** 互斥暂停：只写库不注入 */
  paused = false;
  /**
   * 跨进程后台租约（`openService` 装配；直接 new WeaveService 时为 null）。
   * 为 null 表示「没有多进程概念」，后台任务照常跑（CLI / 单测场景）。
   */
  backgroundLease: LeaseGuard | null = null;

  /** 「立即 reload 并生效」：宿主装配时注册的段位重装配回调 */
  reloadHook: (() => void) | null = null;
  /** recall.synonymsFile 缓存（按 mtime 失效） */
  private aliasFileCache = new Map<string, { mtime: number; groups: string[][] }>();
  pauseReason = "";
  /** weave_* 工具注册结果（宿主装配时填写；自检与总览用） */
  toolStatus: { registered: string[]; failed: string[]; lastError: string } = { registered: [], failed: [], lastError: "" };
  /** 宿主装配时注入的 warn（写入附加步骤失败等，不阻塞） */
  warn: ((m: string) => void) | null = null;
  /**
   * 宿主注入的 LLM 调用（system, user => 文本）。
   * 当前没有默认 provider；为 null 时 weave_extract 显式返回 E_UNAVAILABLE，而不是假装「没有新记忆」。
   */
  llmCall: ((system: string, user: string) => Promise<string>) | null = null;
  /** 文件日志 */
  logger: FileLogger | null = null;
  /** systemPrompt 段位注册状态 */
  sectionNames: string[] = [];
  /** 工具调用预算（每轮每工具的调用次数限制） */
  private toolCallBudget = new Map<string, { limit: number; used: Map<string, number> }>();
  /** 当前轮次标识（用于重置预算） */
  private currentTurnId: string | null = null;
  lastReloadAt: number = 0;
  /** Offload 管理器 */
  private offloadManager: OffloadManager | null = null;
  /** 场景块管理器 */
  private sceneManager: SceneManager | null = null;
  /** Persona 管理器 */
  private personaManager: PersonaManager | null = null;
  /** 敏感信息检测器 */
  private sensitivityDetector: SensitivityDetector | null = null;
  /** 冲突检测器 */
  private conflictDetector: ConflictDetector | null = null;
  /** 备份管理器 */
  /** 备份引擎：host/backup 的模块函数需要它（起公开只读用途） */
  backupManager: BackupManager | null = null;

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
  /** 每会话轮次计数（进程内；co-session 相邻轮与 recall_log 分组用） */
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
    // 衰减参数只有一份口径。settings.json 可手改，旧版本也可能缺键或写坏值
    // 在入口归一化一次，之后所有召回路径都读 this.config，不再各自兜底。
    this.config = {
      ...config,
      lifecycle: {
        ...config.lifecycle,
        halfLifeDays: normalizeHalfLife(config.lifecycle?.halfLifeDays),
        decayFloor: normalizeDecayFloor(config.lifecycle?.decayFloor),
      },
    };
    // 初始化 offload 管理器
    if (config.offload?.enabled) {
      this.offloadManager = new OffloadManager(env.dataDir, config.offload);
    }
    // 初始化场景块管理器
    if (config.scene?.enabled) {
      this.sceneManager = new SceneManager(env.dataDir, config.scene);
    }
    // 初始化 persona 管理器（改配置后由 syncMultiPersona 同步，不必重启）
    this.syncMultiPersona();
    // 初始化敏感信息检测器
    if (config.privacy?.enabled) {
      this.sensitivityDetector = new SensitivityDetector();
    }
    // 初始化冲突检测器
    if (config.conflict?.enabled) {
      this.conflictDetector = new ConflictDetector();
    }
    // 初始化备份管理器
    if (config.backup?.enabled) {
      this.backupManager = new BackupManager(env, SCHEMA_VERSION);
    }
  }

  /** 插件启动时体检一次关联网（只读库跳过；失败不阻塞） */
  startupLinkHealth(): void {
    if (this.env.readonly) return;
    try {
      linkHealth(this.env, "dream");
    } catch {

    }
  }

  // ---------- 状态 ----------

  status(): StatusReport {
    const counts = countByLevel(this.env);
    const total = LEVEL_ORDER.reduce((s, l) => s + counts[l], 0);
    
    // 获取向量后端状态
    let vectorBackend: "sqlite-vec" | "vectra" | "builtin" | "disabled" = "disabled";
    let vectorStats: {
      indexed: number;
      pending: number;
      failed: number;
      totalActive: number;
      stale?: number;
    } | undefined;
    try {
      vectorBackend = getVectorBackend(this.env);
      const stats = getVectorStats(this.env);
      vectorStats = {
        indexed: stats.indexed,
        pending: stats.pending,
        failed: stats.failed,
        totalActive: stats.totalActive,
        stale: stats.stale,
      };
    } catch {
      // 向量表尚未创建（旧库 / 只读库）时按 disabled 展示
    }
    
    // 获取 embedding 配置
    let embeddingConfig: { provider: string | null; model: string | null; dimensions: number; updatedAt: number | null } | null = null;
    try {
      embeddingConfig = getEmbeddingConfigStore(this.env);
    } catch {
      // 配置表不存在时为 null
    }

    // 注入的 provider 与语义路状态
    const injected = getEmbeddingProviderStore();
    const route = this.vectorRouteState();
    // 设置页要预填「保存并测试」的表单；密钥只报有没有，不回显值
    const embCfg = this.config.embedding;
    
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
      // 诊断信息
      paused: this.paused,
      pauseReason: this.pauseReason,
      dataDirSource: this.dataDirSource,
      sectionRegistered: this.sectionNames.length > 0,
      sectionNames: this.sectionNames,
      lastReloadAt: this.lastReloadAt || undefined,
      // 向量后端
      vectorBackend,
      // 包内自带的 sqlite-vec 生效时，设置页要能区分「自带的」和「自己装的」
      sqliteVecSource: getSqliteVecSource(),
      vectorStats,
      // embedding 配置
      embeddingConfig,
      embeddingProvider: injected
        ? { provider: injected.provider, model: injected.model, dimensions: injected.dimensions }
        : null,
      vectorRoute: route,
      // 自动发现（本机 → 云）进行到哪一步；设置页据此解释「为什么现在是关键词」
      embeddingDiscovery: this.embeddingDiscoveryStatus,
      // 设置页「保存并测试」表单的预填值（apiKey 只报有无，不回显）
      embeddingSettings: embCfg
        ? {
            enabled: embCfg.enabled !== false,
            provider: embCfg.provider ?? null,
            baseUrl: String(embCfg.baseUrl ?? ""),
            model: String(embCfg.model ?? ""),
            dimensions: Number.isFinite(Number(embCfg.dimensions)) ? Number(embCfg.dimensions) : null,
            hasApiKey: Boolean(embCfg.apiKey),
            timeoutMs: embCfg.timeoutMs ?? 10000,
          }
        : null,
    };
  }

  /**
   * 语义路是否真的可用。
   * 四个条件缺一不可，顺序按「用户能不能修」排：
   * - 配置了 embedding（provider 已注入）；
   * - 向量后端可用（不是 `disabled`：内置 sqlite-vec / builtin 默认就有）；
   * - vector_config.enabled（可用 ≠ 开启）；
   * - recall.routes 含 semantic，或 embedding 配置显式开启。
   */
  private vectorRouteState(): { enabled: boolean; reason: "ready" | "no-provider" | "no-backend" | "not-configured" | "disabled" } {
    // 用户明确关掉开关：理由要写「已关闭」，不能和「从来没配过」混为一谈
    if (this.config.embedding?.enabled === false) return { enabled: false, reason: "disabled" };
    if (!this.config.embedding) return { enabled: false, reason: "not-configured" };
    if (!getEmbeddingProviderStore()) return { enabled: false, reason: "no-provider" };
    let backend: string = "disabled";
    try {
      backend = getVectorBackend(this.env);
    } catch {
      backend = "disabled";
    }
    if (backend === "disabled") return { enabled: false, reason: "no-backend" };
    let enabled = false;
    try {
      enabled = getVectorConfigStore(this.env)?.enabled === true;
    } catch {
      enabled = false;
    }
    if (!enabled) return { enabled: false, reason: "disabled" };
    return { enabled: true, reason: "ready" };
  }

  // ---------- 人格 ----------

  persona(): PersonaRow {
    return getPersona(this.env);
  }

  /**
   * 获取带会话覆盖的 persona 配置
   */
  getPersonaForSession(sessionId?: string): PersonaConfig {
    const global = this.persona().config;
    
    if (!sessionId || !this.personaManager) {
      return global;
    }

    return this.personaManager.mergePersona(this.env, sessionId, global);
  }

  /** persona 版本历史（版本页：列表 + 前端 diff + 回滚） */
  personaHistory(limit = 50): PersonaHistoryRow[] {
    return listPersonaHistory(this.env, limit);
  }

  async updatePersona(
    patch: Partial<PersonaConfig>,
    actor: string,
    expectedVersion?: number,
  ): Promise<{ ok: boolean; version?: number; code?: ErrCode; current?: number }> {
    // updatePersona 使用 withWrite 包装事务
    const r = await this.env.withWrite(() => updatePersona(this.env, patch, actor, expectedVersion));
    this.scheduleMirror();
    // persona 更新后自动 reload S1
    if (r.ok && this.reloadHook) {
      try {
        this.reloadHook();
      } catch (e) {
        this.warn?.("persona reload failed: " + String(e));
      }
    }
    return r;
  }

  renderPersona(modelHint?: string): { prefix: string; thinking: string; suffix: string; blocks: string[]; warn: string[] } {
    return renderPersonaOf(this, modelHint);
  }

  preview(modelHint?: string): RenderResult {
    return previewOf(this, modelHint);
  }

  /** 真实预览 - 模拟实际注入场景（包括 delta、召回、S3） */
  previewWithContext(params?: {
    modelHint?: string;
    sessionId?: string;
    query?: string;
    first?: boolean;
  }): RenderResult {
    return previewWithContextOf(this, params);
  }

  /** S2 快照取材：soul / user / rules / project 的 active 条目 + tier=core 的 fact/lesson/topic（open 冲突双方便都不注入） */
  snapshotItems(): MemoryEntry[] {
    return snapshotItemsOf(this);
  }

  // ---------- 隐私与敏感信息----------

  /**
   * 检测文本中的敏感信息
   */
  detectSensitiveInfo(text: string): import("../privacy/types").SensitiveInfo[] {
    return governDetectSensitive(this.sensitivityDetector, this.config.privacy, text);
  }

  /**
   * 检查文本是否包含敏感信息
   */
  hasSensitiveInfo(text: string): boolean {
    return governHasSensitive(this.sensitivityDetector, this.config.privacy, text);
  }

  /**
   * 获取敏感信息类型列表
   */
  getSensitiveTypes(text: string): string[] {
    return governSensitiveTypes(this.sensitivityDetector, this.config.privacy, text);
  }

  /**
   * 标记记忆为敏感（内部方法）
   */
  private markMemoryAsSensitiveInternal(id: string, level: Level): void {
    markMemorySensitive(this.env, id, level);
  }

  /**
   * 标记或取消标记记忆为敏感（公开方法，设置页手动操作）。
   * 校验层名与条目实际所在层。此前 `level` 被直接拿去索引 `LAYER_TABLES`
   * 传错层名会拼出 `UPDATE undefined ...`（报错含糊），层名合法但条目在别的层
   * 则静默更新 0 行 —— 界面显示成功，实际没有任何变化。
   */
  markMemoryAsSensitive(
    id: string,
    level: Level,
    sensitive = true,
  ): { ok: boolean; code?: ErrCode; message?: string } {
    if (!LAYER_TABLES[level]) {
      return { ok: false, code: "E_VALID", message: "unknown level: " + String(level) };
    }
    const entry = this.getMemory(id);
    if (!entry) return { ok: false, code: "E_VALID", message: "memory not found: " + id };
    if (entry.level !== level) {
      return { ok: false, code: "E_VALID", message: `memory ${id} is in ${entry.level}, not ${level}` };
    }
    setMemorySensitive(this.env, id, level, sensitive);
    return { ok: true };
  }

  /**
   * 获取所有敏感记忆
   */
  getSensitiveMemories(level?: Level, limit = 100): MemoryEntry[] {
    return listSensitiveMemories(this.env, level, limit);
  }

  // ---------- 冲突解决----------

  /**
   * 检测记忆冲突
   */
  detectConflicts(): ConflictDetectionResult {
    return governDetectConflicts(
      this.env,
      this.conflictDetector,
      this.config.conflict,
      this.logger,
    );
  }

  /**
   * 获取冲突列表
   */
  getConflicts(status?: "pending" | "resolved" | "ignored"): MemoryConflict[] {
    return listConflictRows(this.env, status);
  }

  /**
   * 解决冲突
   * @returns The merged memory ID if resolution is "merge", otherwise undefined
   */
  resolveMemoryConflict(conflictId: number, options: ConflictResolveOptions): string | undefined {
    return governResolveConflict(this.env, conflictId, options);
  }

  /**
   * 合并冲突记忆（便捷方法）
   * @returns The merged memory ID
   */
  mergeConflictingMemories(conflictId: number, mergedContent: string): string | undefined {
    return this.resolveMemoryConflict(conflictId, {
      resolution: "merge",
      merged_content: mergedContent,
      reason: "manual merge",
    });
  }

  /** 写入口的宿主角（模块函数不直接持有 WeaveService） */
  private writeDeps(): WriteHost {
    return {
      env: this.env,
      config: this.config,
      warn: this.warn,
      logger: this.logger,
      sensitivityDetector: this.sensitivityDetector,
      timeZone: () => this.timeZone(),
      persona: () => this.persona(),
      listMemory: (f) => this.listMemory(f),
      fileAliasGroups: () => this.fileAliasGroups(),
      noteSessionWrite: (sessionId, id) => this.noteSessionWrite(sessionId, id),
      markSensitiveOnWrite: (id, level) => this.markMemoryAsSensitiveInternal(id, level),
      scheduleMirror: () => this.scheduleMirror(),
    };
  }

  // ---------- 记忆 ----------

  async remember(
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
    return writeRemember(this.writeDeps(), input, actor, meta);
  }

  /**
   * 记下情绪值；arousal ≥ flashArousal 且今天的闪光灯没到上限 → flash=1。
   * 超出上限按 0 处理并记审计。emotion 关着时什么都不写。
   */


  /** 写约定字段；返回 warn（字段被拒）或 null */




  /** 写锚点字段；返回 warn 或 null */


  /**
   * 写入后附加检索词（过完四级把关之后）。
   * merged = 合并命中：与目标已有检索词取并集截到上限。返回 warn 文本（丢词原因）。
   */


  /** 检索词敏感词检查沿用写入把关的配置（"default" = 只用内置规则） */
  private termsSensitive(): { custom?: string[]; disabled?: string[] } {
    return writeTermsSensitive(this.config);
  }

  /** 设置页编辑检索词（整体替换；空数组 = 清空）；可撤销 */
  setTerms(id: string, raw: unknown, actor: string): { ok: boolean; code?: ErrCode; message?: string; searchTerms?: string[]; warn?: string } {
    return writeSetTerms(this.writeDeps(), id, raw, actor);
  }

  /**
   * weave_annotate 批量补词。只补 / 替换检索词，不改正文；
   * 整批写一条撤销台账（24 小时内可撤销）。
   */
  annotate(
    items: unknown,
    actor: string,
  ): { ok: boolean; code?: ErrCode; message?: string; updated: string[]; skipped: Array<{ id: string; reason: string }>; warn?: string; undoId?: string } {
    return writeAnnotate(this.writeDeps(), items, actor);
  }

  // ---------- 待整理队列（S1 待补检索词 + S2 待归纳） ----------

  /** 待归纳组：open 且成员仍可用、且没有挂着待审的低覆盖率候选 */


  /** 两类待整理的数量（S3 提示与设置页用） */
  backlogCounts(): { terms: number; groups: number } {
    return dreamBacklogCounts(this);
  }

  /** weave_backlog：最多 20 条待补检索词 + 3 组待归纳（正文按数据给出） */
  backlog(): {
    terms: Array<{ id: string; level: Level; content: string }>;
    groups: Array<{ groupId: string; reason: string | null; members: Array<{ id: string; level: Level; content: string }> }>;
    counts: { terms: number; groups: number };
  } {
    return dreamBacklog(this);
  }

  /**
   * S2 weave_distill：提交归纳或跳过。
   * 敏感词直接拒；覆盖率 < coverage 转 L2 候选交主人审；否则照常过四级把关写 topic（section=distilled）
   * 成员建 merged 边并归档，写撤销台账。
   */
  async submitDistill(
    a: { groupId: string; summary?: string; keywords?: string[]; searchTerms?: unknown; skip?: boolean },
    actor: string,
  ): Promise<{ ok: boolean; code?: ErrCode; message?: string; id?: string; verdict?: string; candidateId?: string; coverage?: number; undoId?: string; warn?: string }> {
    return dreamSubmitDistill(
      {
        env: this.env,
        config: this.config,
        remember: (input, actor2, meta) => this.remember(input, actor2, meta),
        termsSensitive: () => this.termsSensitive(),
        scheduleMirror: () => this.scheduleMirror(),
      },
      a,
      actor,
    );
  }

  /** 归纳正文照常过四级把关写入；通过（accepted / merged）后落地成员归档与边 */


  private curateSnap = new CuratePrompter();

  /** S3 末尾的【待整理】一行；不该出现时返回空串 */
  curateLine(sessionId: string, now: number = Date.now()): string {
    return this.curateSnap.line(this, sessionId, now);
  }

  /** 设置页加 / 删锚点；可撤销 */
  setAnchor(id: string, anchor: unknown, actor: string): { ok: boolean; code?: ErrCode; message?: string } {
    return writeSetAnchor(this.writeDeps(), id, anchor, actor);
  }

  /**
   * 结算约定（weave_promise / 设置页 / 候选裁决）。
   * kept / broken：改状态；extend：换新的到期日（照常校验）。AI 调用写审计，可撤销。
   */
  settlePromise(
    id: string,
    outcome: "kept" | "broken" | "extend",
    actor: string,
    dueAt?: number | string,
  ): { ok: boolean; code?: ErrCode; message?: string; state?: PromiseState; dueAt?: number | null } {
    return writeSettlePromise(this.writeDeps(), id, outcome, actor, dueAt);
  }

  /** 结算后，还挂着的「确认约定结果」候选一并关掉（不再重复问） */


  /** 关键词重叠 + 「已经做了」语气 → 记一条 promise.hint 审计，轮后通知展示 */


  /** 设置页取消 / 恢复闪光灯 */
  setFlash(id: string, flash: boolean, actor: string): { ok: boolean; code?: ErrCode; message?: string } {
    return writeSetFlash(this.writeDeps(), id, flash, actor);
  }

  listMemory(f: Parameters<typeof listMemory>[1]): MemoryEntry[] {
    return listMemory(this.env, f);
  }

  getMemory(id: string): MemoryEntry | null {
    return getMemory(this.env, id);
  }

  async revise(id: string, patch: Partial<MemoryEntry>, actor: string, expectedUpdatedAt?: number): Promise<{ ok: boolean; code?: ErrCode; message?: string }> {
    return writeRevise(this.writeDeps(), id, patch, actor, expectedUpdatedAt);
  }

  async archive(id: string, actor: string): Promise<void> {
    return writeArchive(this.writeDeps(), id, actor);
  }

  async restore(id: string, actor: string): Promise<void> {
    return writeRestore(this.writeDeps(), id, actor);
  }

  async forget(id: string, actor: string): Promise<void> {
    return writeForget(this.writeDeps(), id, actor);
  }

  // ---------- 撤销（近 N 小时自动动作一键回滚；自动动作 100% 可撤销） ----------

  /** 可撤销动作列表（窗口 = governance.undoWindowHours，默认 24h） */
  undoList(hours?: number): UndoRow[] {
    return writeUndoList(this.writeDeps(), hours);
  }

  /** 执行一条撤销（只回滚台账里的逆操作；同一条只生效一次） */
  async undo(
    id: string,
    actor: string = "human",
  ): Promise<{ ok: boolean; code?: ErrCode; message?: string; action?: string }> {
    return writeUndo(this.writeDeps(), id, actor);
  }

  // ---------- 人格段位重装配（「立即 reload 并生效」） ----------

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

  /** rules/soul 修正提案：只入候选池，不生效（L2） */
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

  // ---------- 召回（三路：关键词 + 关联图；起语义路由可用时并入） ----------

  /** 两个 recall 入口共用的一组配置映射（同步/异步只差向量那一段） */
  private recallConfig(
    opts?: { limit?: number; project?: string | null; halfLife?: Record<Level, number>; rrfK?: number },
  ) {
    return {
      limit: opts?.limit ?? this.config.memory.hitTopK,
      project: opts?.project,
      halfLife: normalizeHalfLife(opts?.halfLife ?? this.config.lifecycle.halfLifeDays),
      decayFloor: normalizeDecayFloor(this.config.lifecycle.decayFloor),
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
    };
  }

  /**
   * 召回命中敏感条目时的处理策略。
   * - `off`：隐私关或 `filterOnRecall=false`，原样返回（兼容旧配置）；
   * - `filter`：整条丢弃（旧行为）；
   * - `redact`：字段级脱敏后保留（默认）。
   */
  private privacyPolicy(): "off" | "filter" | "redact" {
    const cfg = this.config.privacy ?? DEFAULT_PRIVACY_CONFIG;
    if (!cfg.enabled || !cfg.filterOnRecall) return "off";
    return cfg.recallPolicy === "filter" ? "filter" : "redact";
  }

  /**
   * 召回结果的隐私处理（同步/异步两个入口共用）。
   * 默认脱敏而不是整条删除：a24 的教训是「删掉整条」会让
   * 正确但带一个公网 IP 的记忆彻底不可用；字段级掩码既守住隐私，也保住语义。
   */
  private sanitizeHits(hits: RankedHit[]): RankedHit[] {
    const policy = this.privacyPolicy();
    if (policy === "off" || hits.length === 0) return hits;

    if (policy === "filter") {
      const kept = hits.filter((hit) => !(hit.entry as { is_sensitive?: number }).is_sensitive);
      if (kept.length < hits.length) {
        this.logger?.info("[Privacy] Filtered sensitive memories from recall", {
          filtered: hits.length - kept.length,
          remaining: kept.length,
        });
      }
      return kept;
    }

    const cfg = this.config.privacy ?? DEFAULT_PRIVACY_CONFIG;
    let redacted = 0;
    const out = hits.map((hit) => {
      const entry = redactMemoryEntry(hit.entry, this.sensitivityDetector, cfg);
      if (entry === hit.entry) return hit;
      redacted += 1;
      return { ...hit, entry };
    });
    if (redacted > 0) {
      this.logger?.info("[Privacy] Redacted sensitive memories in recall", {
        redacted,
        remaining: out.length,
      });
    }
    return out;
  }

  /**
   * 注入前的隐私处理。
   * S2 快照、delta、约定、重放都直接从库里读条目，不经过 `recall`；
   * 单独给一个入口，让这些路径与召回用同一套策略（默认脱敏，`filter` 时丢弃）。
   */
  redactForInject(entries: MemoryEntry[]): MemoryEntry[] {
    const policy = this.privacyPolicy();
    if (policy === "off" || entries.length === 0) return entries;
    if (policy === "filter") {
      return entries.filter((e) => !(e as { is_sensitive?: number }).is_sensitive);
    }
    const cfg = this.config.privacy ?? DEFAULT_PRIVACY_CONFIG;
    return entries.map((e) => redactMemoryEntry(e, this.sensitivityDetector, cfg));
  }

  /** 注入文本（画像摘要等非条目来源）的脱敏入口 */
  redactInjectText(text: string): string {
    if (this.privacyPolicy() === "off") return text;
    return redactText(text, this.sensitivityDetector, this.config.privacy ?? DEFAULT_PRIVACY_CONFIG);
  }

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
    return this.sanitizeHits(recallEntries(this.env, query, this.recallConfig(opts)));
  }

  /**
   * 异步召回（语义路由的入口）。
   * 语义路可用时，先向宿主 provider 要查询向量，再把 `recallEntriesAsync` 的
   * keyword/link/terms/calendar/semantic 一起交给 RRF。任一环节失败都退回同步召回
   * 不让「向量挂了」变成「记忆检索挂了」。
   * 语义路不可用（未配置 / 后端 disabled / 开关关闭 / 注入失败）时**不产生任何额外开销**
   * 直接走同步实现，行为与 完全一致。
   */
  async recallAsync(
    query: string,
    opts?: {
      limit?: number;
      project?: string | null;
      halfLife?: Record<Level, number>;
      rrfK?: number;
    },
  ): Promise<RankedHit[]> {
    const state = this.vectorRouteState();
    const provider = getEmbeddingProviderStore();
    const routes = this.config.recall.routes ?? [];
    // 配置成功即默认开启（configureEmbedding 会补 `enabled: true`）；只有显式 false 才关。
    // 这里不再要求用户额外写 `enabled: true` —— 那正是「配了却不生效」的来源。
    const wantSemantic = routes.includes("semantic") || this.config.embedding?.enabled !== false;
    if (!state.enabled || !provider || !wantSemantic) {
      return this.recall(query, opts);
    }

    let queryEmbedding: Float32Array | null = null;
    try {
      queryEmbedding = await provider.generate(query);
      if (queryEmbedding.length !== provider.dimensions) queryEmbedding = null;
    } catch (e) {
      this.logger?.warn?.("[Recall] query embedding failed, falling back to keyword routes: " + String(e));
      queryEmbedding = null;
    }
    if (!queryEmbedding) return this.recall(query, opts);

    try {
      const hits = await recallEntriesAsync(this.env, query, {
        ...this.recallConfig(opts),
        routes: routes.includes("semantic") ? routes : [...routes, "semantic"],
        queryEmbedding,
        vector: { enabled: true, minScore: this.config.recall.semanticMinScore ?? 0.42 },
      });
      return this.sanitizeHits(hits);
    } catch (e) {
      this.logger?.warn?.("[Recall] semantic route failed, falling back: " + String(e));
      return this.recall(query, opts);
    }
  }

  // ---------- 治理 ----------

  listCandidates(verdict?: Verdict): CandidateRow[] {
    return listCandidates(this.env, verdict);
  }

  /**
   * 候选裁决。晋升候选（reason=contract-promotion）被接受时
   * 只有人可以写 persona.contracts，版本 +1，记审计。
   */
  async decideCandidate(
    id: string,
    verdict: Verdict,
    actor: string,
    targetId?: string,
  ): Promise<{ ok: boolean; code?: ErrCode; message?: string; promoted?: boolean; version?: number }> {
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
        const applied = await this.revise(target.id, revision.patch, actor, target.updatedAt);
        if (!applied.ok) return { ok: false, code: applied.code ?? "E_VALID", message: "message" in applied ? applied.message : "revision could not be applied" };
      }
      const cand = getCandidate(this.env, id);
      // 接受契约复核 = 停用这条契约（只有人能做；修改文字走人格页）
      if (cand && cand.reason === REVIEW_REASON) {
        if (actor !== "human") return { ok: false, code: "E_PERM", message: "persona contract change requires actor=human" };
        if (cand.verdict !== "pending") return { ok: false, code: "E_VALID", message: "review is no longer pending" };
        const contracts = (this.persona().config.contracts ?? []).filter((c) => c);
        const hit = contracts.find((c) => c.id === cand.mergedInto);
        if (hit && hit.on) {
          const r = await this.updatePersona({ contracts: contracts.map((c) => (c.id === hit.id ? { ...c, on: false } : c)) }, actor);
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
          const r = await this.updatePersona({ contracts }, actor);
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
    // 事件驱动：主人接受确认 → 关系小步上调
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
   * - 把关分流来的写入候选 + 设为准则：接受 = 真正写入记忆（同正文已在库则跳过）；
   * - 建议归档：接受 = 归档；拒绝 = 改回 active 并清过期时间（不然下次 dream 又标 stale）；
   * - 建议常驻：接受 = tier 改 core。
   * 以上都只认 actor=human（rules / 常驻影响每个会话）。
   */
  private applyCandidate(
    cand: ReturnType<typeof getCandidate> & object,
    verdict: "accepted" | "rejected",
    actor: string,
  ): { ok: boolean; code?: ErrCode; message?: string } {
    // 确认约定结果。接受 = 兑现，拒绝 = 落空；只认人（不自动判落空）
    if (cand.reason === PROMISE_DUE_REASON) {
      if (actor !== "human") return { ok: false, code: "E_PERM", message: cand.reason + " requires actor=human" };
      const target = cand.mergedInto ? getMemory(this.env, cand.mergedInto) : null;
      if (!target || !isPending(target)) return { ok: true }; // 已经结算过（或已延期另问）：只关掉候选
      const r = this.settlePromise(target.id, verdict === "accepted" ? "kept" : "broken", actor);
      return r.ok ? { ok: true } : { ok: false, code: r.code, message: r.message };
    }
    // 覆盖率不足的归纳。接受 = 写 topic（distilled）并落地成员；拒绝 = 这组跳过。只认人
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
   * 关系/情绪小步：单次 ±0.05、每日 ±0.15 封顶；
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
   * 冲突裁决：只裁决 open 的冲突。
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

  /** 最近一次注入的延迟与规模（只读） */
  injectState(sessionId: string): InjectState | null {
    return getInjectState(this.env, sessionId);
  }

  /**
   * 本进程是否负责后台任务（dream / 向量索引）。
   * - 没有租约句柄（单进程、直接 new、单测）→ true；
   * - 有句柄 → 续期或抢占；持续拿不到就说明别的进程在负责。
   * 调用即续期，所以定时器每轮调用一次即可保活；只读库恒为 false。
   */
  canRunBackground(now: number = Date.now()): boolean {
    return this.backgroundLease === null || this.backgroundLease.hold(now);
  }

  /**
   * 后台租约状态（只读，不续期）。
   * `shared=false` 表示没有租约（单进程/只读/直接 new），后台任务照常跑。
   */
  backgroundLeaseStatus(): {
    shared: boolean;
    owned: boolean;
    holder: { pid: number | null; host: string | null; heartbeatAt: number; expiresAt: number } | null;
  } {
    const guard = this.backgroundLease;
    if (!guard) return { shared: false, owned: true, holder: null };
    const info = guard.info();
    return {
      shared: true,
      owned: info?.owner === guard.owner,
      holder: info ? { pid: info.pid, host: info.host, heartbeatAt: info.heartbeatAt, expiresAt: info.expiresAt } : null,
    };
  }

  // ---------- 白盒监控（只读） ----------

  health(): HealthReport {
    const provider = getEmbeddingProviderStore();
    let backend: "sqlite-vec" | "vectra" | "builtin" | "disabled" = "disabled";
    try {
      backend = getVectorBackend(this.env);
    } catch {
      backend = "disabled";
    }
    const route = this.vectorRouteState();
    return runHealthCheck(this.env, {
      budget: this.config.budget,
      auditKeepDays: this.config.governance.auditKeepDays,
      vector: {
        provider: provider?.provider ?? null,
        model: provider?.model ?? null,
        dimensions: provider?.dimensions ?? null,
        backend,
        enabled: route.enabled,
        reason: route.reason,
      },
    });
  }

  queues(detailLimit?: number): QueueStats & { detail?: QueueDetail } {
    const stats = getQueueStats(this.env);
    return detailLimit === undefined ? stats : { ...stats, detail: getQueueDetail(this.env, detailLimit) };
  }

  memoryDetail(id: string): MemoryDetail | null {
    return getMemoryDetail(this.env, id);
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
    return dataLocationOf(this);
  }

  /**
   * 改记忆库目录（下次启动 DSH 生效）。
   * mode=copy：把当前库完整复制过去（目标已有库时拒绝，避免覆盖）；
   * mode=use：直接使用目标目录里已有的库（没有就新建空库）。
   * 原目录的数据原样保留，不做删除。
   */
  relocate(target: string, mode: "copy" | "use", actor: string): Record<string, unknown> {
    return relocateData(this, target, mode, actor);
  }

  /** 把这次在设置页改的项并入 settings.json（只存改过的项），重启后仍保留 */
  persistSettings(patch: Record<string, unknown>): boolean {
    return persistSettingsOf(this, patch);
  }

  backupNow(label: string): string {
    return backupNowOf(this, label);
  }

  // ---------- 备份恢复完整性 ----------

  /**
   * 创建备份（增强版，带完整性校验和可选加密）
   */
  async createBackup(options: BackupOptions = {}): Promise<BackupResult> {
    return createBackupOf(this, options);
  }

  /**
   * 列出所有备份
   */
  listBackupsEnhanced(): BackupInfo[] {
    return listBackupsEnhancedOf(this);
  }

  /**
   * 验证备份完整性
   */
  verifyBackup(backupId: number): VerificationResult {
    return verifyBackupOf(this, backupId);
  }

  /**
   * 删除备份
   */
  async deleteBackup(backupId: number): Promise<boolean> {
    return deleteBackupOf(this, backupId);
  }

  /**
   * 恢复备份（增强版，带完整性验证）
   */
  async restoreBackupEnhanced(backupId: number, options: RestoreOptions = {}): Promise<RestoreResult> {
    return restoreBackupEnhancedOf(this, backupId, options);
  }

  // ---------- Offload 相关方法 ----------

  /**
   * 记录一次工具调用（用于 offload）
   */
  /**
   * 记录工具调用到 offload 系统
   */
  recordToolCallToOffload(params: {
    sessionId: string;
    step: number;
    toolName: string;
    input: string;
    output: string;
    success: boolean;
    error?: string;
  }): void {
    if (!this.offloadManager) return;
    try {
      this.offloadManager.recordToolCall(params);
    } catch (err) {
      // 静默失败，不影响主流程
      this.logger?.warn("[Offload] recordToolCall failed:", { error: String(err) });
    }
  }

  /**
   * 获取 offload 注入内容
   */
  getOffloadInjection(sessionId: string): string {
    if (!this.offloadManager) return "";
    try {
      const injection = this.offloadManager.generateInjection(sessionId);
      return injection.offloaded ? injection.text : "";
    } catch (err) {
      this.logger?.warn("[Offload] generateInjection failed:", { error: String(err) });
      return "";
    }
  }

  /**
   * 获取 offload 指标
   */
  getOffloadMetrics(sessionId: string): {
    enabled: boolean;
    active: boolean;
    totalCalls: number;
    savedChars: number;
    savedTokensEstimate: number;
  } {
    if (!this.offloadManager) {
      return {
        enabled: false,
        active: false,
        totalCalls: 0,
        savedChars: 0,
        savedTokensEstimate: 0,
      };
    }
    try {
      return this.offloadManager.getMetrics(sessionId);
    } catch (err) {
      this.logger?.warn("[Offload] getMetrics failed:", { error: String(err) });
      return {
        enabled: true,
        active: false,
        totalCalls: 0,
        savedChars: 0,
        savedTokensEstimate: 0,
      };
    }
  }

  /**
   * 清除会话的 offload 数据
   */
  clearOffloadSession(sessionId: string): void {
    if (!this.offloadManager) return;
    try {
      this.offloadManager.clearSession(sessionId);
    } catch (err) {
      this.logger?.warn("[Offload] clearSession failed:", { error: String(err) });
    }
  }

  // ---------- 场景块相关方法 ----------

  /**
   * 聚合生成场景块
   */
  aggregateScenes(): { created: number; updated: number; archived: number; sceneIds: string[] } {
    if (!this.sceneManager) {
      return { created: 0, updated: 0, archived: 0, sceneIds: [] };
    }

    try {
      const entries = listMemory(this.env, { status: "active" });
      return this.sceneManager.aggregateScenes(entries);
    } catch (err) {
      this.logger?.warn("[Scene] aggregateScenes failed:", { error: String(err) });
      return { created: 0, updated: 0, archived: 0, sceneIds: [] };
    }
  }

  /**
   * 召回相关场景
   */
  recallScenes(query: string, limit: number = 5): Array<{
    scene: any;
    score: number;
    matchedKeywords: string[];
  }> {
    if (!this.sceneManager) return [];
    try {
      return this.sceneManager.recallScenes(query, limit);
    } catch (err) {
      this.logger?.warn("[Scene] recallScenes failed:", { error: String(err) });
      return [];
    }
  }

  /**
   * 获取场景块统计
   */
  getSceneStatistics(): {
    total: number;
    active: number;
    inactive: number;
    archived: number;
  } {
    if (!this.sceneManager) {
      return { total: 0, active: 0, inactive: 0, archived: 0 };
    }
    try {
      return this.sceneManager.getStatistics();
    } catch (err) {
      this.logger?.warn("[Scene] getStatistics failed:", { error: String(err) });
      return { total: 0, active: 0, inactive: 0, archived: 0 };
    }
  }

  // ---------- 会话级 Persona 相关方法 ----------

  /**
   * 按当前配置同步多人格管理器。
   * 旧实现只在构造时创建 `personaManager`，设置页把 `multiPersona.enabled` 改开之后
   * 仍要重启 DSH 才生效，而界面上没有任何提示 —— 用户会以为开关坏了。
   * 现在设置页保存后立即调用这里，启用/停用都在当轮生效。
   */
  syncMultiPersona(): void {
    const cfg = this.config.multiPersona;
    this.personaManager = cfg?.enabled ? new PersonaManager(cfg) : null;
  }

  /**
   * 设置会话级 persona 覆盖
   */
  setSessionPersona(sessionId: string, overrides: SessionPersonaOverrides): void {
    if (!this.personaManager) {
      this.logger?.warn("[Persona] multiPersona not enabled");
      return;
    }
    try {
      setSessionPersonaStorage(this.env, sessionId, overrides);
    } catch (err) {
      this.logger?.warn("[Persona] setSessionPersona failed:", { error: String(err) });
    }
  }

  /**
   * 清除会话级 persona
   */
  clearSessionPersona(sessionId: string): void {
    if (!this.personaManager) return;
    try {
      clearSessionPersonaStorage(this.env, sessionId);
    } catch (err) {
      this.logger?.warn("[Persona] clearSessionPersona failed:", { error: String(err) });
    }
  }

  /**
   * 获取会话级 persona（如果有）
   */
  getSessionPersona(sessionId: string): SessionPersona | null {
    if (!this.personaManager) return null;
    try {
      return getSessionPersonaStorage(this.env, sessionId);
    } catch (err) {
      this.logger?.warn("[Persona] getSessionPersona failed:", { error: String(err) });
      return null;
    }
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
    /** 本会话第几轮（recall_log 分组用） */
    turn?: number;
    /** 压缩后重放（S2 + 本会话写过的 + 查过的项目） */
    replay?: boolean;
  }): { result: RenderResult; inject: boolean; s2: string; s3: string } {
    return renderTurnOf(this, this.renderState, input);
  }

  /** 异步装配一轮注入（召回可走语义路，失败退回同步） */
  async renderTurnAsync(input: {
    sessionId: string;
    first: boolean;
    modelHint?: string;
    query?: string;
    baseline: Map<string, number>;
    turn?: number;
    replay?: boolean;
  }): Promise<{ result: RenderResult; inject: boolean; s2: string; s3: string }> {
    return renderTurnAsyncOf(this, this.renderState, input);
  }

  // ---------- 约定 ----------
  /** 会话级注入状态（约定去同质 + 重放轨迹） */
  private renderState = new SessionRenderState();

  /** 本地时区：日历配置的 timeZone 优先，留空取宿主进程时区 */
  timeZone(): string {
    return safeZone(resolveTimeZone(this.config.calendar));
  }

  /** S3 约定小节的行（绝对日期） */
  promiseLines(now: number = Date.now()): string[] {
    return promiseLinesOf(this, now);
  }

  // ---------- 会话轨迹（写过的 ≤ 20、查过的项目 ≤ 8） ----------
  noteSessionWrite(sessionId: string, id: string): void {
    this.renderState.noteWrite(sessionId, id);
  }

  noteSessionProject(sessionId: string, project: string): void {
    this.renderState.noteProject(sessionId, project);
  }

  /** 重放附加块：受 S2 预算约束（snapshotMaxChars 的一半） */
  replayBlock(sessionId: string): string {
    return this.renderState.replayBlock(this, sessionId);
  }

  /** 会话原文旁路：默认关闭；FTS 索引未建时返回空 */
  quoteLookup(query: string): QuoteHit[] {
    return quoteLookupOf(this, query);
  }

  /** 原文旁路数据源：$DSH_HOME/sessions（config.quote.sessionsDir 可覆盖） */
  quoteSessionsDir(): string {
    return quoteSessionsDirOf(this);
  }

  /**
   * 按文件 mtime 增量同步会话原文索引。
   * zstd 不可用时强制 quote.enabled=false（降级分支），返回 available:false。
   */
  async refreshQuoteIndex(opts?: { now?: number }): Promise<QuoteSyncReport> {
    return refreshQuoteIndexOf(this, opts);
  }

  // ---------- Markdown 镜像（只读派生视图，SQLite 为准） ----------

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

  // ---------- dream 收梭管线（生命周期：过期 stale / 冷记忆合并 / 租约） ----------

  /** 测试可直接读运行配置（与 dreamCfg 同源，见 host/dream） */
  private dreamCfg(): DreamConfigLike {
    return dreamCfgOf(this);
  }

  /** 手动触发（weave_consolidate / /weave dream）：与自动 dream 同一管线；resetFailures 解除失败上限 */
  consolidate(actor: string = "dream", opts?: { resetFailures?: boolean }): DreamReport {
    const r = dreamConsolidate(this, actor, opts);
    if (r.ran) this.curateSnap.refresh(this);
    this.scheduleMirror();
    return r;
  }

  /** 自动 dream 入口：空闲 ≥idleMinutes 且非峰时才跑（定时器调用） */
  maybeDream(): DreamReport {
    const r = dreamMaybeDream(this);
    if (r.ran) {
      this.curateSnap.refresh(this);
      this.scheduleMirror();
    }
    return r;
  }

  /** recall_log 只保留 logKeepDays（默认 90）天 */
  pruneRecallLog(now: number = Date.now()): number {
    return dreamPruneRecallLog(this, now);
  }

  /** 清理过期的审计日志、预算账本、撤销记录、候选、冲突 */
  pruneGovernanceLogs(now: number = Date.now()): { audit: number; budget: number; undo: number; candidates: number; conflicts: number } {
    return dreamPruneGovernanceLogs(this, now);
  }

  /** forget 窗口结束后清除 undo 原文（保留 id/actor/action 用于审计） */
  pruneUndoContent(now: number = Date.now()): number {
    return dreamPruneUndoContent(this, now);
  }

  /** dream 运行配置：dream 段 + lifecycle（冷合并窗口月数/合并开关）合并 */


  dreamStatus(): DreamStateRow & { due: boolean; peak: boolean } {
    return dreamStatusOf(this);
  }

  // ---------- 预设卡（spec memweave-preset/1，不含记忆） ----------

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

  /** 应用 = 只覆盖卡里出现的白名单键；切卡前自动存 autosave */
  async applyPreset(id: string, actor: string = "human"): Promise<{ ok: boolean; message?: string; code?: ErrCode }> {
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
    const r = await this.updatePersona(patch, actor);
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

  // ---------- 备份 / 导入导出 / 彻底重置 ----------

  listBackups(): Array<{ name: string; path: string; size: number; mtime: number }> {
    const dir = join(this.env.dataDir, "backups");
    try {
      return readdirSync(dir)
        .filter((n) => n.startsWith("memweave.db.bak.") || n.startsWith("memweave.db.backup."))
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

  /** 导出：记忆 JSON（七层 + 元数据）+ 人格预设卡 + Markdown 镜像目录 */
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

  /** 导入预检：只认 memweave-export/1，报告 新增/跳过/冲突 */
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
   * 导入：强制备份 → 分类落库（去重跳过 / 语义冲突不并入）→ 报告 + 回滚句柄。
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

  /** 可回滚：按回滚句柄撤销本次导入（新增条目 / 新预设卡 / 人格还原） */
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

  // ---------- 向量后端管理----------

  /** 获取向量后端详细状态 */
  getVectorBackendStatus(): {
    backend: "sqlite-vec" | "vectra" | "builtin" | "disabled";
    available: { sqliteVec: boolean; vectra: boolean };
    /** sqlite-vec 实际来自包内二进制还是 npm 可选依赖 */
    sqliteVecSource: "bundled" | "npm" | null;
    /** 可选依赖的解析结果，把「没装」和「装了但加载失败」分开 */
    detail: {
      sqliteVec: { available: boolean; reason: "not-installed" | "load-failed" | null; error: string | null };
      vectra: { available: boolean; reason: "not-installed" | "load-failed" | null; error: string | null };
    };
    canRetry: boolean;
    stats: { indexed: number; pending: number; failed: number; totalActive: number };
  } {
    const sqliteVec = optionalDepStatus("sqlite-vec");
    const vectra = optionalDepStatus("vectra");
    const source = getSqliteVecSource();
    // 包内二进制生效时 optionalDepStatus 会说「没装」，别让设置页/重试逻辑误判
    const sqliteVecDetail =
      source === "bundled" ? { available: true, reason: null, error: null } : sqliteVec;
    const broken = [sqliteVec, vectra].filter((d) => d.reason === "load-failed");
    if (broken.length > 0) {
      // 装了但坏掉不是常态：留一条 warn，别和「没装」一样悄悄降级
      this.logger?.warn("[Vector] optional backend failed to load", {
        errors: broken.map((d) => d.error).filter(Boolean).join(" | "),
      });
    }
    const available = { sqliteVec: sqliteVecDetail.available, vectra: vectra.available };
    const detail = { sqliteVec: sqliteVecDetail, vectra };
    try {
      const backend = getVectorBackend(this.env);
      const stats = getVectorStats(this.env);
      
      // 如果当前是降级状态且有更好的后端可用，可以重试
      const canRetry =
        (backend === "vectra" && available.sqliteVec) ||
        (backend === "builtin" && (available.sqliteVec || available.vectra));
      
      return {
        backend,
        available,
        sqliteVecSource: source,
        detail,
        canRetry,
        stats: {
          indexed: stats.indexed,
          pending: stats.pending,
          failed: stats.failed,
          totalActive: stats.totalActive,
        },
      };
    } catch {
      return {
        backend: "disabled",
        available,
        sqliteVecSource: source,
        detail,
        canRetry: false,
        stats: { indexed: 0, pending: 0, failed: 0, totalActive: 0 },
      };
    }
  }

  /** 重试安装向量后端（用于设置页"重试安装"按钮） */
  retryVectorBackend(): {
    ok: boolean;
    before: "sqlite-vec" | "vectra" | "builtin" | "disabled";
    after: "sqlite-vec" | "vectra" | "builtin" | "disabled";
    message: string;
  } {
    try {
      const before = getVectorBackend(this.env);
      
      // 重置检测缓存（连同可选依赖的解析结果一起清掉，才能重新探测）
      resetBackendDetection();
      
      // 重新检测
      const after = detectBestBackend(this.env);
      
      if (after === before) {
        return {
          ok: false,
          before,
          after,
          message: `No better backend available. Current: ${before}`,
        };
      }
      
      return {
        ok: true,
        before,
        after,
        message: `Successfully upgraded from ${before} to ${after}`,
      };
    } catch (e) {
      return {
        ok: false,
        before: "disabled",
        after: "disabled",
        message: "Vector module not available: " + String(e),
      };
    }
  }

  /** 清空向量索引（用于切换后端或重建） */
  async clearVectorIndex(actor: string): Promise<{ ok: boolean; message: string }> {
    try {
      const backend = getVectorBackend(this.env);
      
      if (backend === "disabled") {
        return { ok: false, message: "Vector backend is disabled" };
      }
      
      await clearAllVectorsAsync(this.env);
      
      addAudit(this.env, {
        actor,
        action: "vector.clear",
        target: backend,
        after: "cleared",
      });
      
      return { ok: true, message: `Cleared vector index (backend: ${backend})` };
    } catch (e) {
      return { ok: false, message: "Failed to clear vector index: " + String(e) };
    }
  }

  /** 运行向量索引 Worker（处理一批 embedding 任务） */
  async runVectorWorker(
    provider: any | null,
    config?: { batchSize?: number; timeoutMs?: number; maxRetries?: number; retryDelayMs?: number },
  ): Promise<{
    ok: boolean;
    stats: {
      processed: number;
      succeeded: number;
      failed: number;
      retried: number;
      skipped: number;
    };
    message: string;
  }> {
    try {
      const backend = getVectorBackend(this.env);
      if (backend === "disabled") {
        return {
          ok: false,
          stats: { processed: 0, succeeded: 0, failed: 0, retried: 0, skipped: 0 },
          message: "Vector backend is disabled",
        };
      }
      
      if (!provider) {
        const queueStatus = getQueueStatus(this.env);
        return {
          ok: false,
          stats: { processed: 0, succeeded: 0, failed: 0, retried: 0, skipped: 0 },
          message: `No embedding provider (${queueStatus.pending} pending)`,
        };
      }
      
      const stats = await runVectorWorkerStore(this.env, provider, config);
      
      return {
        ok: true,
        stats,
        message: `Processed ${stats.processed} jobs: ${stats.succeeded} ok, ${stats.failed} failed, ${stats.retried} retried, ${stats.skipped} skipped`,
      };
    } catch (e) {
      return {
        ok: false,
        stats: { processed: 0, succeeded: 0, failed: 0, retried: 0, skipped: 0 },
        message: "Worker failed: " + String(e),
      };
    }
  }

  /**
   * 注入宿主 embedding 能力（null = 解除）。
   * 注入后 `searchSimilar` 与省略 provider 的 Worker 才会真正工作；
   * 不注入时向量主路径保持停用，不会假装有检索结果。
   */
  setEmbeddingProvider(provider: EmbeddingProvider | null): void {
    setEmbeddingProviderStore(provider);
  }

  /** 当前注入的 embedding provider（宿主用于确认是否已接上） */
  getEmbeddingProvider(): EmbeddingProvider | null {
    return getEmbeddingProviderStore();
  }

  /** configureEmbedding 派生的后台任务（重建索引 / 消费队列）；可等待，便于观测与测试 */
  private vectorWork: Promise<void> = Promise.resolve();

  /** 自动发现（本机 → 云）只跑一次；进程内复用同一个 promise */
  private embeddingDiscovery: Promise<{ ok: boolean; message: string; source?: string }> | null = null;

  /** 自动发现的最后状态，用于设置页说明「为什么现在是关键词」 */
  private embeddingDiscoveryStatus: {
    status: "pending" | "found" | "none" | "failed";
    message?: string;
    source?: string;
  } | null = null;

  /**
   * 把一段后台工作接到向量任务链上，而不是覆盖。
   * 自动发现本身就是链上的一环：发现成功后 `configureEmbedding` 会再挂上重建索引。
   * 直接赋值会让 `flushVectorWork` 只等到其中一段（甚至漏掉重建）。
   */
  private trackVectorWork(job: Promise<unknown>): void {
    this.vectorWork = this.vectorWork
      .then(() => job)
      .then(
        () => undefined,
        () => undefined,
      );
  }

  /**
   * 等待后台向量任务跑完。
   * 正常运行时宿主不必调用（索引慢一点不影响召回）；它存在的意义是让
   * 「配置完成后立刻断言索引状态」成为可能，避免用例靠 sleep 猜时间。
   */
  async flushVectorWork(): Promise<void> {
    await this.vectorWork;
  }

  /**
   * 按配置装配 embedding provider（`openService` 启动时调用）。
   * 做四件事，任何一步失败都只影响语义路，不影响关键词召回：
   * 1. 建 provider（OpenAI 兼容 HTTP）；
   * 2. 注入全局 provider；
   * 3. 写 `embedding_config` 与 `vector_config.enabled`；
   * 4. 首次配置 / 换模型时后台重建索引并开始消费队列。
   * @returns 是否装配成功；失败原因写日志，不抛给宿主。
   */
  configureEmbedding(cfg: Partial<HttpEmbeddingConfig> | undefined): { ok: boolean; message: string } {
    if (!cfg) {
      // 没有任何配置：解除注入，语义路退回关键词
      setEmbeddingProviderStore(null);
      this.config.embedding = undefined;
      return { ok: false, message: "embedding is not enabled" };
    }
    if (cfg.enabled === false) {
      // 显式关闭是**用户意图**，不是失败。保留配置（开关要能记住地址与模型）
      // 只解除注入并把 enabled 落库为 0。
      setEmbeddingProviderStore(null);
      this.config.embedding = { ...cfg, enabled: false };
      if (!this.env.readonly) {
        try {
          const cur = getVectorConfigStore(this.env);
          setVectorConfig(this.env, {
            enabled: false,
            dimensions: cur?.dimensions,
            provider: cur?.provider,
            model: cur?.model,
          });
        } catch {
          // 落库失败不影响关键词召回
        }
      }
      return { ok: true, message: "embedding is disabled" };
    }
    // 先记账再解析：配置写错时状态里应显示「有配置但 provider 不可用」
    // 而不是含糊的「未配置」，否则用户不知道该去改什么。
    this.config.embedding = { ...cfg };
    const resolved = resolveEmbeddingConfig(cfg);
    if (!resolved) {
      setEmbeddingProviderStore(null);
      return { ok: false, message: "embedding config is incomplete (need baseUrl, model, dimensions)" };
    }
    if (this.env.readonly) {
      return { ok: false, message: "database is readonly; embedding config not applied" };
    }

    let provider: EmbeddingProvider;
    if (resolved.provider === LOCAL_MODEL_PROVIDER && !localModelReady(this.env.dataDir, resolved.model)) {
      setEmbeddingProviderStore(null);
      return { ok: false, message: "本地模型还没装好：去设置页的「向量检索」里点「下载模型」" };
    }
    try {
      provider =
        resolved.provider === LOCAL_HASH_PROVIDER
          ? createLocalHashEmbeddingProvider(resolved.dimensions)
          : resolved.provider === LOCAL_MODEL_PROVIDER
            ? createLocalModelEmbeddingProvider({
                dataDir: this.env.dataDir,
                modelId: resolved.model,
                dimensions: resolved.dimensions,
              })
            : createHttpEmbeddingProvider(resolved);
    } catch (e) {
      setEmbeddingProviderStore(null);
      return { ok: false, message: "failed to create embedding provider: " + String(e) };
    }

    setEmbeddingProviderStore(provider);
    // 修正：配置成功就等于开启。`HttpEmbeddingConfig.enabled` 缺省视为开启
    // 这里把它显式补成 true，`recallAsync` 才不会因为用户没写 enabled 而跳过语义路。
    this.config.embedding = { ...cfg, enabled: true };

    // 用户把后端显式关了（MEMWEAVE_VECTOR_BACKEND=off）：provider 照常注入
    // 状态里要能看出「backend 被关」而不是「没配置」；但不写开启标记、不入队
    // 否则队列只进不出，而且下次开后端还会因为 enabled 已是 true 而跳过重建。
    try {
      if (getVectorBackend(this.env) === "disabled") {
        return { ok: false, message: "vector backend is disabled (MEMWEAVE_VECTOR_BACKEND=off)" };
      }
    } catch {
      return { ok: false, message: "vector backend is unavailable" };
    }

    try {
      const previous = getVectorConfigStore(this.env);
      const needs = updateEmbeddingConfigStore(this.env, {
        provider: provider.provider,
        model: provider.model,
        dimensions: provider.dimensions,
      });
      // 配置了 provider 就等于「要用语义路」
      setVectorConfig(this.env, {
        enabled: true,
        provider: provider.provider,
        model: provider.model,
        dimensions: provider.dimensions,
      });
      // setVectorConfig 用「当前配置」重算 needs_reindex，会把上面刚判出的 true 抹掉；
      // 换模型/维度后这句话是这个状态的唯一真相，显式写回去。
      if (needs) {
        try {
          this.env.db.prepare("UPDATE vector_config SET needs_reindex = 1 WHERE id = 1").run();
        } catch {
          // 标记写不进去不影响下面的重建
        }
      }
      // 换模型后旧向量维度不同：清掉并重新入队是纯 SQL，不需要调 embedding
      // 所以即使后台租约在别的进程手里也立刻做 —— 那边会在下一分钟消费队列。
      // 首次开启（之前 enabled=false）同样走这条：把现有记忆全部入队，否则只有新写入才有向量。
      if (!previous?.enabled || needs) this.rebuildVectorIndexNow();
      // 多进程时只让后台租约持有者真正跑 embedding / 消费队列
      if (!this.canRunBackground()) {
        return {
          ok: true,
          message: "embedding provider ready; background indexing is owned by another process",
        };
      }
      this.trackVectorWork(
        !previous?.enabled || needs
          ? this.pumpVectorQueue(20).then(() => undefined)
          : this.pumpVectorQueue().then(() => undefined),
      );
      return { ok: true, message: `embedding provider ready (${provider.provider}/${provider.model}, ${provider.dimensions}d)` };
    } catch (e) {
      return { ok: false, message: "failed to persist embedding config: " + String(e) };
    }
  }

  /**
   * 设置页「保存并测试」/ 开关的唯一入口。
   * 与 `configureEmbedding` 的区别：这里负责把配置验证好再落库 ——
   * 模型留空就从 `/models` 里挑，维度留空就真打一次 `/embeddings` 量出来
   * 用户不必知道 nomic-embed-text 是 768 维。验证失败只回原因，不改现有 provider。
   */
  async applyEmbeddingConfig(input: {
    enabled?: boolean;
    provider?: string;
    baseUrl?: string;
    model?: string;
    apiKey?: string;
    dimensions?: number;
  }): Promise<{ ok: boolean; message: string; model?: string; dimensions?: number }> {
    if (this.env.readonly) return { ok: false, message: "记忆库处于只读模式，无法修改向量配置" };
    const prev = this.config.embedding ?? {};
    const baseUrl = (input.baseUrl ?? "").trim() || String(prev.baseUrl ?? "");
    const model = (input.model ?? "").trim() || String(prev.model ?? "");
    const apiKey = (input.apiKey ?? "").trim() || prev.apiKey;
    const declaredInput = Number(input.dimensions);
    const providerName =
      (input.provider ?? "").trim() ||
      (prev.provider === LOCAL_HASH_PROVIDER || prev.provider === LOCAL_MODEL_PROVIDER ? String(prev.provider) : "");

    if (input.enabled === false) {
      const next: Partial<HttpEmbeddingConfig> = {
        enabled: false,
        provider: providerName || prev.provider,
        baseUrl,
        model,
        apiKey,
        dimensions: Number.isFinite(declaredInput) && declaredInput > 0
          ? Math.floor(declaredInput)
          : prev.dimensions,
      };
      const r = this.configureEmbedding(next);
      this.persistSettings({ embedding: next });
      return { ok: r.ok, message: "语义检索已关闭，召回走关键词 + 关联图" };
    }

    if (providerName === LOCAL_HASH_PROVIDER) {
      // 内置本地向量：不联网、不需要地址；维度沿用上次或默认 256
      const dims = Number.isFinite(declaredInput) && declaredInput > 0
        ? Math.floor(declaredInput)
        : prev.provider === LOCAL_HASH_PROVIDER && prev.dimensions
          ? Math.floor(prev.dimensions)
          : LOCAL_HASH_DIMENSIONS;
      const next: Partial<HttpEmbeddingConfig> = {
        enabled: true,
        provider: LOCAL_HASH_PROVIDER,
        model: LOCAL_HASH_MODEL,
        dimensions: dims,
      };
      const r = this.configureEmbedding(next);
      this.persistSettings({ embedding: next });
      return { ...r, model: LOCAL_HASH_MODEL, dimensions: dims };
    }

    if (providerName === LOCAL_MODEL_PROVIDER) {
      // 下载式本地模型：要求先把权重装好；之后完全离线
      const spec = getLocalModel(model || (prev.provider === LOCAL_MODEL_PROVIDER ? prev.model : undefined));
      if (!localModelReady(this.env.dataDir, spec.id)) {
        return {
          ok: false,
          message: "本地模型「" + spec.id + "」还没下载：先在这一栏点「下载模型」，之后完全离线",
        };
      }
      // 维度跟着模型走：用户填的只在同模型下有意义，换模型一律以清单为准
      const dims = spec.dimensions;
      const next: Partial<HttpEmbeddingConfig> = {
        enabled: true,
        provider: LOCAL_MODEL_PROVIDER,
        model: spec.id,
        dimensions: dims,
        timeoutMs: 20000,
      };
      const r = this.configureEmbedding(next);
      this.persistSettings({ embedding: next });
      return { ...r, model: spec.id, dimensions: dims };
    }

    if (!baseUrl) {
      return { ok: false, message: "请填写服务地址，例如 http://127.0.0.1:11434/v1" };
    }

    const probe = await probeEmbeddingConfig({
      baseUrl,
      model: model || undefined,
      apiKey,
      dimensions: Number.isFinite(declaredInput) && declaredInput > 0 ? Math.floor(declaredInput) : undefined,
    });
    if (!probe.ok) return { ok: false, message: probe.message };

    const next: Partial<HttpEmbeddingConfig> = {
      enabled: true,
      baseUrl,
      model: probe.model,
      dimensions: probe.dimensions,
      apiKey,
      timeoutMs: 15000,
    };
    const r = this.configureEmbedding(next);
    this.persistSettings({ embedding: next });
    return { ...r, model: probe.model, dimensions: probe.dimensions };
  }

  /**
   * 设置页「重新探测」——绕过「探测只跑一次」的限制，立即重扫本机/云端。
   * 与启动时一样，显式配置优先：只有在没有可用 provider 时才值得点。
   * 探测失败不清掉现有 provider（宁可保持现状，也不要让用户点一下把语义路弄没）。
   */
  async rediscoverEmbedding(): Promise<{ ok: boolean; message: string; status?: string }> {
    if (this.env.readonly) return { ok: false, message: "记忆库处于只读模式，无法探测 embedding 服务" };
    this.embeddingDiscoveryStatus = { status: "pending" };
    let found: DiscoveredEmbeddingConfig | null = null;
    try {
      found = await discoverEmbeddingConfig({});
    } catch (e) {
      const message = String(e);
      this.embeddingDiscoveryStatus = { status: "failed", message };
      return { ok: false, message };
    }
    if (!found) {
      this.embeddingDiscoveryStatus = { status: "none", message: "no embedding endpoint found" };
      return { ok: false, message: "未发现本机 embedding 服务；装好 Ollama / LM Studio 或设置 OPENAI_API_KEY 后重试", status: "none" };
    }
    const applied = this.configureEmbedding(found);
    this.embeddingDiscoveryStatus = applied.ok
      ? { status: "found", source: found.source }
      : { status: "failed", message: applied.message };
    if (applied.ok) this.persistSettings({ embedding: found });
    return { ok: applied.ok, message: applied.message, status: found.source };
  }

  /**
   * 自动装配 embedding —— 本机优先（Ollama / LM Studio），云兜底（OpenAI 兼容）。
   * 只在「用户没有显式配置」时由 `openService` 触发；显式配置（包括显式关闭）
   * 一律优先。发现失败不抛错，语义路退回关键词，用户仍可手动配置。
   */
  async autoConfigureEmbedding(
    opts: EmbeddingDiscoveryOptions = {},
  ): Promise<{ ok: boolean; message: string; source?: string }> {
    if (getEmbeddingProviderStore()) return { ok: true, message: "embedding provider already configured" };
    if (this.env.readonly) return { ok: false, message: "database is readonly; embedding discovery skipped" };

    this.embeddingDiscoveryStatus = { status: "pending" };
    let found: DiscoveredEmbeddingConfig | null = null;
    try {
      found = await discoverEmbeddingConfig(opts);
    } catch (e) {
      const message = "embedding discovery failed: " + String(e);
      this.embeddingDiscoveryStatus = { status: "failed", message };
      return { ok: false, message };
    }
    if (!found) {
      const message = "no embedding endpoint found (local Ollama/LM Studio, or OPENAI_API_KEY)";
      this.embeddingDiscoveryStatus = { status: "none", message };
      return { ok: false, message };
    }
    // 发现期间用户可能已经手动配置：以用户配置为准，不覆盖
    if (getEmbeddingProviderStore()) {
      this.embeddingDiscoveryStatus = { status: "found", message: "configured while discovering" };
      return { ok: true, message: "embedding provider was configured while discovery was running" };
    }

    const applied = this.configureEmbedding(found);
    this.embeddingDiscoveryStatus = {
      status: applied.ok ? "found" : "failed",
      message: applied.message,
      source: found.source,
    };
    if (applied.ok) {
      this.logger?.info?.(
        "[Vector] embedding discovered: " + found.label + " / " + found.model + " (" + found.dimensions + "d)",
      );
    }
    return { ...applied, source: found.source };
  }

  /**
   * 触发一次自动发现并纳入 `vectorWork`；重复调用返回同一个 promise。
   * `openService` 用它把「默认打开」做在启动路径上：不阻塞启动（探测在后台）
   * 但 `flushVectorWork` 能等到「发现 + 首次建索引」全部结束。
   * vitest 下默认不探测（见 `embeddingDiscoveryEnabled`），避免用例联网。
   */
  scheduleEmbeddingDiscovery(
    opts: EmbeddingDiscoveryOptions = {},
  ): Promise<{ ok: boolean; message: string; source?: string }> | null {
    if (this.embeddingDiscovery) return this.embeddingDiscovery;
    if (getEmbeddingProviderStore()) return null;
    if (!embeddingDiscoveryEnabled(opts.env ?? process.env)) return null;

    const run = this.autoConfigureEmbedding(opts);
    this.embeddingDiscovery = run;
    this.trackVectorWork(run);
    return run;
  }

  /**
   * 消费向量索引队列（宿主定时器调用）。
   * 每批默认 10 条，一次最多跑 `maxBatches` 批，避免网络慢时长时间占住定时器。
   * 没有 provider / 后端 disabled / 队列空都直接返回，不做无意义调用。
   * `retryDelayMs` 默认 0：这是周期性任务，60 秒后还会再来一轮
   * 没必要在计时器里再睡 5 秒；真正的退避交给显式调用的 `runVectorWorker`。
   */
  async pumpVectorQueue(
    maxBatches = 5,
    opts: { retryDelayMs?: number; maxRetries?: number } = {},
  ): Promise<{ processed: number; succeeded: number; failed: number }> {
    const total = { processed: 0, succeeded: 0, failed: 0 };
    const provider = getEmbeddingProviderStore();
    if (!provider) return total;
    try {
      if (getVectorBackend(this.env) === "disabled") return total;
      if (!getVectorConfigStore(this.env)?.enabled) return total;
    } catch {
      return total;
    }
    for (let i = 0; i < Math.max(1, maxBatches); i++) {
      const stats = await runVectorWorkerStore(this.env, provider, {
        retryDelayMs: opts.retryDelayMs ?? 0,
        maxRetries: opts.maxRetries,
      });
      total.processed += stats.processed;
      total.succeeded += stats.succeeded;
      total.failed += stats.failed;
      if (stats.processed === 0 || stats.retried > 0) break;
    }
    return total;
  }

  /**
   * 语义相似搜索（宿主接口）。
   * 只有「后端可用 + `vector_config.enabled` + 已注入 provider」三者同时满足才会有结果
   * 否则返回空数组，不抛错。
   */
  async searchSimilar(
    content: string,
    options: { limit?: number; minScore?: number; provider?: EmbeddingProvider } = {},
  ): Promise<Array<{ score: number; content: string; memoryId: string }>> {
    return searchSimilarStore(this.env, content, options);
  }

  /** 获取向量索引队列状态*/
  getVectorQueueStatus(): {
    backend: "sqlite-vec" | "vectra" | "builtin" | "disabled";
    pending: number;
    processing: number;
    done: number;
    failed: number;
  } {
    try {
      const backend = getVectorBackend(this.env);
      const status = getQueueStatus(this.env);
      
      return { backend, ...status };
    } catch {
      return { backend: "disabled", pending: 0, processing: 0, done: 0, failed: 0 };
    }
  }

  /** 重试失败的向量索引任务（用于宿主重新配置 embedding API 后） */
  retryFailedVectorJobs(actor: string): { ok: boolean; retried: number; message: string } {
    try {
      const retried = retryFailedJobs(this.env);
      
      if (retried > 0) {
        addAudit(this.env, {
          actor,
          action: "vector.retry",
          target: "failed-jobs",
          after: `${retried} reset`,
        });
      }
      
      return { ok: true, retried, message: `Reset ${retried} failed jobs to pending` };
    } catch (e) {
      return { ok: false, retried: 0, message: "Failed to retry jobs: " + String(e) };
    }
  }

  /** 清理已完成的向量索引任务（定期维护） */
  pruneVectorJobs(keepRecent: number = 1000): { ok: boolean; pruned: number; message: string } {
    try {
      const pruned = pruneCompletedJobs(this.env, keepRecent);
      
      return { ok: true, pruned, message: `Pruned ${pruned} completed jobs (kept ${keepRecent} recent)` };
    } catch (e) {
      return { ok: false, pruned: 0, message: "Failed to prune jobs: " + String(e) };
    }
  }

  /** 获取 embedding 配置 */
  getEmbeddingConfig(): {
    provider: string | null;
    model: string | null;
    dimensions: number;
    updatedAt: number | null;
  } | null {
    try {
      const config = getEmbeddingConfigStore(this.env);
      
      if (!config) {
        return null;
      }
      
      return {
        provider: config.provider,
        model: config.model,
        dimensions: config.dimensions,
        updatedAt: config.updatedAt,
      };
    } catch {
      return null;
    }
  }

  /** 更新 embedding 配置（检测是否需要重建） */
  updateEmbeddingConfig(config: {
    provider: string;
    model: string;
    dimensions: number;
  }): {
    ok: boolean;
    needsReindex: boolean;
    message: string;
  } {
    try {
      const needsReindex = updateEmbeddingConfigStore(this.env, config);
      
      return {
        ok: true,
        needsReindex,
        message: needsReindex
          ? `Config updated. Reindex required (model/provider/dimensions changed)`
          : `Config updated. No reindex needed`,
      };
    } catch (e) {
      return {
        ok: false,
        needsReindex: false,
        message: "Failed to update config: " + String(e),
      };
    }
  }

  /**
   * 同步版重建：清空向量表 + 全部重新入队 + 清 needs_reindex。
   * `configureEmbedding` 是同步入口，不能等 async 的 `rebuildVectorIndex`；
   * 而「换模型后清掉错维旧向量」本身不需要调 embedding，纯 SQL 就够。
   * 消费队列仍是后台的事（下一个定时器或 flushVectorWork）。
   * @returns 入队的条数；后端不可用 / 功能未开启时返回 0，不清任何东西
   */
  rebuildVectorIndexNow(): number {
    try {
      if (getVectorBackend(this.env) === "disabled") return 0;
      if (!getVectorConfigStore(this.env)?.enabled) return 0;
      clearAllVectors(this.env);
      let enqueued = 0;
      for (const entry of listMemory(this.env, { status: "active" })) {
        enqueueEmbedding(this.env, entry);
        if (entry.status === "active") enqueued += 1;
      }
      try {
        this.env.db.prepare("UPDATE vector_config SET needs_reindex = 0 WHERE id = 1").run();
      } catch {
        // 标记清理失败不影响重建
      }
      return enqueued;
    } catch (e) {
      this.logger?.warn?.("[Vector] sync reindex failed: " + String(e));
      return 0;
    }
  }

  /** 重建向量索引（清空并重新入队所有记忆） */
  async rebuildVectorIndex(): Promise<{
    ok: boolean;
    enqueued: number;
    message: string;
  }> {
    try {
      const backend = getVectorBackend(this.env);
      if (backend === "disabled") {
        return {
          ok: false,
          enqueued: 0,
          message: "Vector backend is disabled",
        };
      }

      // 先确认功能确实开着，再清空：否则会「清完却入不了队」（enqueueEmbedding 有同样的闸门）
      if (!getVectorConfigStore(this.env)?.enabled) {
        return {
          ok: false,
          enqueued: 0,
          message: "Vector index is not enabled (vector_config.enabled = false)",
        };
      }

      // 清空现有索引
      await clearAllVectorsAsync(this.env);
      
      // 重新入队所有活跃记忆
      let enqueued = 0;
      for (const entry of listMemory(this.env, { status: "active" })) {
        enqueueEmbedding(this.env, entry);
        enqueued++;
      }
      // 重建已开始：清掉「需要重建」标记，否则状态页会一直提示重建
      try {
        this.env.db.prepare("UPDATE vector_config SET needs_reindex = 0 WHERE id = 1").run();
      } catch {
        // 标记清理失败不影响重建本身
      }
      
      return {
        ok: true,
        enqueued,
        message: `Cleared index and enqueued ${enqueued} memories for reindexing`,
      };
    } catch (e) {
      return {
        ok: false,
        enqueued: 0,
        message: "Failed to rebuild index: " + String(e),
      };
    }
  }

  /**
   * 重置后按当前注入的 provider 重建 embedding / vector 配置行。
   * `resetAll` 把 `embedding_config` 与 `vector_config` 也清了（配置属于「彻底重置」的
   * 一部分），但当前进程里 provider 仍然注入着。如果不同步写回，状态页与 `status`
   * 会说「未配置」，实际语义路又随时可用，直到重启才重新落库 —— 两套状态。
   * 向量数据已随重置清空，所以 `needs_reindex` 保持 0：没有旧向量需要作废。
   * 后端被显式关闭（`MEMWEAVE_VECTOR_BACKEND=off`）时不写开启标记
   * 与 `configureEmbedding` 保持一致，免得下次开后端又跳过重建。
   */
  private restoreLiveEmbeddingConfig(): void {
    const provider = getEmbeddingProviderStore();
    if (!provider || this.env.readonly) return;
    try {
      updateEmbeddingConfigStore(this.env, {
        provider: provider.provider,
        model: provider.model,
        dimensions: provider.dimensions,
      });
      if (getVectorBackend(this.env) === "disabled") return;
      setVectorConfig(this.env, {
        enabled: true,
        provider: provider.provider,
        model: provider.model,
        dimensions: provider.dimensions,
      });
    } catch {
      // 写回失败不影响重置本身；下次启动 configureEmbedding 会重新落库
    }
  }

  /** 彻底重置：强制备份 → 清库 → 人格恢复出厂 → 审计 */
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
        "persona_cards",
        "session_fts",
        "session_files",
        "distill_queue",
        "dream_state",
        "recall_log",
        "memory_fts",
        "memory_embeddings",
        "embedding_jobs",
        "embedding_config",
        // 修正：这三张表此前被漏掉，重置后留下指向已删记忆的悬空数据。
        // l0_messages 同时是隐私面：用户点了「彻底重置」，原始对话必须真的消失
        // 而不是留在库里继续被 reader 读到。
        "l0_messages",
        "memory_conflicts", // 冲突对指向已删的两条记忆，治理页会显示无法解析的冲突
        "session_persona", // 会话级人格覆盖，属于「人格恢复出厂」的一部分
        // 语义路开关也是配置，一并回到「未配置」；下面按当前注入的
        // provider 重建配置行，避免「库里说没配、内存里还在用」的两套状态。
        "vector_config",
      ];
      for (const t of tables) {
        try {
          this.env.db.exec("DELETE FROM " + t);
        } catch {
          // 表不存在（如 session_fts）时忽略
        }
      }
      this.restoreLiveEmbeddingConfig();
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
    // vectra 的向量不在 SQLite 里，删表删不掉；索引目录要异步清。
    // sqlite-vec / builtin 走同一分支（表已清空，再清一次是幂等的）。
    if (result) {
      try {
        await clearAllVectorsAsync(this.env);
      } catch {
        // 清索引失败不影响重置：下次重建会覆盖
      }
    }
    const reload = result ? this.reload() : { ok: false, message: "reset failed" };
    return { ok: result, backup, reloadOk: reload.ok, reloadMessage: reload.message };
  }

  // ==================== 工具调用预算管理 ====================

  /**
   * 初始化新轮次的工具预算
   * @param turnId 轮次标识（如 sessionId:turnNumber）
   * @param limits 各工具的调用次数限制（默认：recall=3, read=10, quote=3）
   */
  initToolBudget(turnId: string, limits?: { recall?: number; read?: number; quote?: number }): void {
    this.currentTurnId = turnId;
    this.toolCallBudget.clear();
    
    const defaults = {
      recall: limits?.recall ?? 3,
      read: limits?.read ?? 10,
      quote: limits?.quote ?? 3,
    };
    
    this.toolCallBudget.set("weave_recall", { limit: defaults.recall, used: new Map() });
    this.toolCallBudget.set("weave_read", { limit: defaults.read, used: new Map() });
    this.toolCallBudget.set("weave_quote", { limit: defaults.quote, used: new Map() });
  }

  /**
   * 检查工具调用是否超出预算
   * @param toolName 工具名称
   * @param turnId 当前轮次标识
   * @returns { allowed: boolean, used: number, limit: number, message?: string }
   */
  checkToolBudget(toolName: string, turnId: string): {
    allowed: boolean;
    used: number;
    limit: number;
    message?: string;
  } {
    // 如果轮次变化，自动初始化新预算
    if (this.currentTurnId !== turnId) {
      this.initToolBudget(turnId);
    }
    
    const budget = this.toolCallBudget.get(toolName);
    if (!budget) {
      // 未设置预算的工具不限制
      return { allowed: true, used: 0, limit: -1 };
    }
    
    const used = budget.used.get(turnId) ?? 0;
    const allowed = used < budget.limit;
    
    return {
      allowed,
      used,
      limit: budget.limit,
      message: allowed ? undefined : `Tool ${toolName} exceeded budget: ${used}/${budget.limit} calls in this turn`,
    };
  }

  /**
   * 记录工具调用
   * @param toolName 工具名称
   * @param turnId 当前轮次标识
   */
  recordToolCallBudget(toolName: string, turnId: string): void {
    if (this.currentTurnId !== turnId) {
      this.initToolBudget(turnId);
    }
    
    const budget = this.toolCallBudget.get(toolName);
    if (!budget) return;
    
    const used = budget.used.get(turnId) ?? 0;
    budget.used.set(turnId, used + 1);
  }

  /**
   * 获取当前轮次的工具使用统计
   */
  getToolUsageStats(turnId?: string): Record<string, { used: number; limit: number }> {
    const tid = turnId ?? this.currentTurnId;
    if (!tid) return {};
    
    const stats: Record<string, { used: number; limit: number }> = {};
    
    for (const [toolName, budget] of this.toolCallBudget.entries()) {
      stats[toolName] = {
        used: budget.used.get(tid) ?? 0,
        limit: budget.limit,
      };
    }
    
    return stats;
  }
}

/** 预设卡白名单键（MUST NOT 携带记忆） */
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

export function serviceStatus(s: WeaveService): StatusReport {
  return s.status();
}

export function defaultPersonaConfig(): PersonaConfig {
  return defaultPersona();
}
