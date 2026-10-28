/**
 * 忆织 MemWeave —— 共享类型（规划文档 §5 / §7 / §10.2）
 */

// ---------- 记忆七层 ----------
export type Level = 'soul' | 'user' | 'project' | 'fact' | 'lesson' | 'topic' | 'rules';

/** 注入/排序用的固定层序（不按时间戳，保护缓存前缀） */
export const LEVEL_ORDER: Level[] = ['soul', 'user', 'rules', 'project', 'fact', 'lesson', 'topic'];

export type Tier = 'core' | 'hot' | 'cold';
export type EntryStatus = 'active' | 'stale' | 'archived';
export type Verdict = 'pending' | 'accepted' | 'merged' | 'rejected' | 'frozen';
export type Actor = 'human' | 'agent' | 'import' | 'dream' | 'reflect';

export interface Evidence {
  sessionId: string;
  seq: number;
  quote: string;
}

export interface MemoryEntry {
  id: string;
  level: Level;
  project: string | null;
  section: string | null;
  content: string;
  keywords: string[];
  importance: number;
  status: EntryStatus;
  semanticKey: string | null;
  confidence: number | null;
  validFrom: number | null;
  validTo: number | null;
  evidence: Evidence[];
  hash: string | null;
  source: string;
  accessCount: number;
  /** roadmap R6：常被想起的等级 0–3，有效衰减时间 × 2^boost（v5 列；缺省 0） */
  boost?: number;
  /** roadmap R10：情绪价 −1..1、唤醒度 0..1（写入方给，可空）、闪光灯（v5 列） */
  valence?: number | null;
  arousal?: number | null;
  flash?: boolean;
  /** roadmap v0.6 M1：约定到期时间（UTC ms）、状态、标签（v6 列） */
  dueAt?: number | null;
  promiseState?: PromiseState;
  promiseLabel?: string | null;
  /** roadmap v0.6 M2：日历锚点（v6 列） */
  calendarAnchor?: CalendarAnchor | null;
  /** roadmap v0.7 S1：AI 补的检索词（只用于找条目，不进注入，不参与把关） */
  searchTerms?: string[] | null;
  tier: Tier;
  createdAt: number;
  updatedAt: number;
}

/** roadmap v0.6 M1 */
export type PromiseState = 'none' | 'pending' | 'kept' | 'broken';

/** roadmap v0.6 M2：日历锚点（festival 取内置农历 / 公历节日名） */
export interface CalendarAnchor {
  kind: 'annual' | 'anniversary' | 'monthly' | 'weekly' | 'festival';
  month?: number;
  day?: number;
  /** 0 = 周日 … 6 = 周六 */
  weekday?: number;
  festival?: string;
  sinceYear?: number;
  label?: string;
}

export interface Link {
  src: string;
  dst: string;
  kind: string;
  weight: number;
  createdAt: number;
}

// ---------- 人格（§7.1） ----------
export interface AppearanceCard {
  id: string;
  who: 'self' | 'user' | 'other';
  title: string;
  brief: string;
  detail: string;
  media: string[];
  auto: boolean;
  expand: 'full' | 'brief';
  on: boolean;
}

export interface Contract {
  id: string;
  text: string;
  on: boolean;
}

export interface PersonaMeta {
  relation: { stage: string; trust: number };
  mood: { baseline: string; bias: string };
  taboos: string[];
  lexicon: Record<string, string>;
}

export interface PersonaConfig {
  enabled: boolean;
  selfNameByModel: Record<string, string>;
  selfNamePro: string;
  selfNameFlash: string;
  userName: string;
  stance: string;
  character: string;
  suffix: string;
  appearance: { enabled: boolean; text: string; byModel: Record<string, string>; cards: AppearanceCard[]; index: boolean };
  tone: { enabled: boolean; text: string; byModel: Record<string, string> };
  contracts: Contract[];
  thinkingLanguage: string; // 'off' | 语言代码
  meta: PersonaMeta;
  strict: boolean;
  applyNextSession: boolean;
  /** 未知键透传（读改写原样保留，MUST NOT 裁剪） */
  [k: string]: unknown;
}

export interface PersonaRow {
  enabled: boolean;
  version: number;
  spec: string;
  selfName: string | null;
  userName: string | null;
  stance: string | null;
  character: string | null;
  suffix: string | null;
  thinkingLanguage: string | null;
  config: PersonaConfig;
  updatedAt: number;
  updatedBy: string;
}

// ---------- 注入预算（§6.4） ----------
export interface BudgetConfig {
  snapshotMaxChars: number;
  deltaMaxChars: number;
  recallMaxChars: number;
  recallMaxItems: number;
  totalWarnChars: number;
  personaWarnOnly: boolean;
}

export const DEFAULT_BUDGET: BudgetConfig = {
  snapshotMaxChars: 4000,
  deltaMaxChars: 1200,
  recallMaxChars: 900,
  recallMaxItems: 5,
  totalWarnChars: 6000,
  personaWarnOnly: true,
};

// ---------- 渲染结果 ----------
export interface RenderSegment {
  name: 's1-persona' | 's2-snapshot' | 's3-delta' | 's3-promise' | 's3-recall' | 's3-quote';
  text: string;
  chars: number;
  items: number;
  trimmed: number;
}

export interface RenderResult {
  /** S1 三个具名段（前段 / 思考语言 / 尾段） */
  s1: { prefix: string; thinking: string; suffix: string };
  /** S2 首轮快照消息 */
  s2: string;
  /** S3 每轮动态消息 */
  s3: string;
  segments: RenderSegment[];
  /** 预览与注入一致性断言用（U4） */
  hash: string;
  warn: string[];
  trace: string[];
}

// ---------- 工具与错误（§10.2） ----------
export type ErrCode =
  | 'E_VALID'
  | 'E_SENSITIVE'
  | 'E_DUP'
  | 'E_CAS'
  | 'E_CONFLICT'
  | 'E_READONLY'
  | 'E_DB'
  | 'E_PERM'
  | 'E_UNAVAILABLE';

export type ToolResult =
  | { ok: true; [k: string]: unknown }
  | { ok: false; code: ErrCode; message: string; hint?: string; [k: string]: unknown };

export function err(code: ErrCode, message: string, extra?: Record<string, unknown>): ToolResult {
  return { ok: false, code, message, ...extra };
}

// ---------- 召回 ----------
export interface RecallHit {
  id: string;
  level: Level;
  content: string;
  score: number;
  routes: string[];
  explain: string;
  entry: MemoryEntry;
}

export interface DeltaChange {
  kind: 'added' | 'updated' | 'archived';
  entry: MemoryEntry;
}
