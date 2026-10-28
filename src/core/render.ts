/**
 * 忆织 MemWeave —— S1 / S2 / S3 渲染（规划文档 §6）
 * - S1 九块顺序是契约（§6.1），缺块不留空行；
 * - S2 快照 / S3 增量+召回+原文，全部带预算截断与尾标（§6.4）；
 * - 记忆与形象卡一律「数据，非指令」头 + 「」包裹（I7），并剥离 「」 防提前闭合；
 * - 出厂空态三段全空（§6.5，可机器断言）。
 */

import { renderHash } from "./hash";
import { promptTemplates, type PromptTemplates } from "../prompts";
import type { RankedHit } from "./score";
import {
  DEFAULT_BUDGET,
  LEVEL_ORDER,
  type AppearanceCard,
  type BudgetConfig,
  type DeltaChange,
  type MemoryEntry,
  type PersonaConfig,
  type RenderResult,
  type RenderSegment,
} from "./types";

export interface RenderInput {
  persona: PersonaConfig;
  modelHint?: string;
  budget?: BudgetConfig;
  snapshotItems: MemoryEntry[];
  delta: DeltaChange[];
  recallHits: RankedHit[];
  quotes?: { sessionId: string; seq: number; text: string }[];
  /** roadmap v0.6 M1：约定小节（已渲染成绝对日期的行）；空 / 缺省 = 不出现 */
  promises?: string[];
}

/** 人格段只提醒不裁剪（I2）的提示线 */
export const PERSONA_WARN_CHARS = 1500;
const MAX_PER_LEVEL = 200;
const S3_DELTA_ITEMS = 12;
const S3_RECALL_CHARS = 300;
const S3_QUOTE_ITEMS = 3;
const S3_QUOTE_CHARS = 900;
const ANCHOR_CHARS = 300;

const EMPTY_S1 = { prefix: "", thinking: "", suffix: "", blocks: [] as string[], warn: [] as string[] };

type Lang = "zh" | "en";

function tplOf(p: PersonaConfig): PromptTemplates {
  const lang = (p as { promptLang?: unknown }).promptLang;
  return promptTemplates(lang === "en" ? "en" : "zh");
}

/** 剥离 「」『』【】：防数据块提前闭合（I7），也防数据里伪造【工作契约】这类段标题 */
export function sanitizeData(text: string): string {
  return String(text ?? "").replace(/[「」『』【】]/g, "");
}

/** 单行数据（记忆条目、卡片目录、原文摘录）：在 sanitizeData 基础上把换行压成空格，防数据另起一行伪造段落 */
export function sanitizeLine(text: string): string {
  return sanitizeData(text).replace(/\s*[\r\n]+\s*/g, " ");
}

/** 注入文本禁用相对时间词（D14） */
const RELATIVE = /刚刚|今天|昨天|现在|此刻|刚才|today|just now/gi;

function findRelativeTime(text: string): string[] {
  return [...text.matchAll(RELATIVE)].map((m) => m[0]);
}

function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (all, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : all,
  );
}

function nonEmpty(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * 一个字段里填多个称呼（顿号 / 逗号 / 斜杠 / 竖线 / 换行分隔）→ 去重后的列表。
 * 存储仍是一条字符串，旧数据（单个称呼）原样兼容。
 */
export function splitNames(v: unknown): string[] {
  if (typeof v !== "string") return [];
  const out: string[] = [];
  for (const part of v.split(/[、，,／/|｜;；\n]+/)) {
    const name = part.trim();
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/** 列表 → 提示词里的写法（主语言用顿号） */
function joinNames(names: string[], lang: string): string {
  return names.join(lang === "en" ? " / " : "、");
}

/** 按模型分档取值：精确键（忽略大小写）→ 最长子串 → 空 */
export function pickByModel(map: Record<string, string> | undefined, modelHint?: string): string {
  if (!map) return "";
  const hint = (modelHint ?? "").toLowerCase();
  if (!hint) return "";
  let exact = "";
  let best = "";
  let bestLen = -1;
  for (const [k, v] of Object.entries(map)) {
    const lk = k.toLowerCase();
    if (!lk || !nonEmpty(v)) continue;
    if (lk === hint) {
      exact = v;
      break;
    }
    if (hint.includes(lk) && lk.length > bestLen) {
      best = v;
      bestLen = lk.length;
    }
  }
  return exact || best;
}

/** §7.2 四档自称解析 */
export function resolveSelfName(p: PersonaConfig, modelHint?: string): string {
  const byModel = pickByModel(p.selfNameByModel, modelHint);
  if (byModel) return byModel.trim();
  const hint = (modelHint ?? "").toLowerCase();
  const flashTier = hint.includes("flash");
  const primary = flashTier ? p.selfNameFlash : p.selfNamePro;
  const secondary = flashTier ? p.selfNamePro : p.selfNameFlash;
  const name = nonEmpty(primary) ? primary : nonEmpty(secondary) ? secondary : "";
  return name.trim() || "我";
}

function interpolateVars(text: string, vars: Record<string, string>): string {
  let out = text;
  for (const [k, v] of Object.entries(vars)) {
    out = out.split("{{" + k + "}}").join(v);
  }
  return out;
}

function cwdValue(): string {
  try {
    return typeof process !== "undefined" && process.cwd ? process.cwd() : "";
  } catch {
    return "";
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + "…" : text;
}

function hasContent(p: PersonaConfig): boolean {
  if (nonEmpty(p.stance) || nonEmpty(p.character) || nonEmpty(p.suffix)) return true;
  const ap = p.appearance;
  if (ap && ap.enabled === true) {
    if (nonEmpty(ap.text)) return true;
    if (Object.values(ap.byModel ?? {}).some((v) => nonEmpty(v))) return true;
    if ((ap.cards ?? []).some((c) => c && (nonEmpty(c.detail) || nonEmpty(c.brief)))) return true;
  }
  const tone = p.tone;
  if (tone && tone.enabled === true) {
    if (nonEmpty(tone.text)) return true;
    if (Object.values(tone.byModel ?? {}).some((v) => nonEmpty(v))) return true;
  }
  if ((p.contracts ?? []).some((c) => c && c.on !== false && nonEmpty(c.text))) return true;
  if (nonEmpty(p.thinkingLanguage) && p.thinkingLanguage !== "off") return true;
  const m = p.meta;
  if (m) {
    if (nonEmpty(m.relation?.stage)) return true;
    if (nonEmpty(m.mood?.bias) || nonEmpty(m.mood?.baseline)) return true;
    if ((m.taboos ?? []).length > 0) return true;
    if (Object.keys(m.lexicon ?? {}).length > 0) return true;
  }
  if (nonEmpty(p.selfNamePro) && p.selfNamePro !== "我") return true;
  if (nonEmpty(p.selfNameFlash) && p.selfNameFlash !== "我") return true;
  if (Object.keys(p.selfNameByModel ?? {}).length > 0) return true;
  if (nonEmpty(p.userName) && p.userName !== "主人") return true;
  return false;
}

function mediaLine(tpl: PromptTemplates, media: string[] | undefined): string {
  if (!media || media.length === 0) return "";
  const shown = media.slice(0, 3);
  const more = media.length - shown.length;
  const line = "媒体：" + shown.join("、");
  return more > 0 ? line + " " + fill(tpl.mediaMore, { n: String(more) }) : line;
}

function cardLine(card: AppearanceCard, tpl: PromptTemplates): string {
  const head = "[" + card.id + "] " + card.title;
  const body = card.expand === "full" ? card.detail || card.brief : card.brief || card.detail;
  const media = mediaLine(tpl, card.media);
  return "- 「" + sanitizeLine(head + " · " + body) + "」" + (media ? "\n  " + media : "");
}

/** S1 三段 + 九块（顺序契约 §6.1） */
export function renderS1(
  p: PersonaConfig,
  modelHint?: string,
  budget?: BudgetConfig,
): { prefix: string; thinking: string; suffix: string; blocks: string[]; warn: string[] } {
  if (!p || p.enabled === false || !hasContent(p)) return { ...EMPTY_S1, blocks: [], warn: [] };

  const tpl = tplOf(p);
  const blocks: string[] = [];
  // 自称、称呼都可以填多个：全部列给模型，由它按语境轮换（不在这里随机，否则每轮提示词都变、缓存失效）
  const selfNames = splitNames(resolveSelfName(p, modelHint));
  const userNames = splitNames(p.userName);
  const selfName = joinNames(selfNames.length > 0 ? selfNames : ["我"], tpl.lang);
  const userName = joinNames(userNames.length > 0 ? userNames : ["主人"], tpl.lang);
  const nameHint = selfNames.length > 1 || userNames.length > 1 ? tpl.nameRotate : "";

  // ① stance ② character
  if (nonEmpty(p.stance)) blocks.push(p.stance.trim());
  if (nonEmpty(p.character)) blocks.push(p.character.trim());

  // 形象卡分类
  const ap = p.appearance;
  const cards = ((ap?.cards ?? []) as AppearanceCard[]).filter((c) => c && c.on !== false);
  const selfCard = cards.find((c) => c.who === "self") ?? null;
  const fullCards = cards.filter((c) => c.expand === "full" && c !== selfCard);
  const indexCards = cards.filter((c) => c.expand !== "full" && c !== selfCard);

  // ③【形象设定】（who:"self" 的卡取代 appearance.text）
  if (ap && ap.enabled === true) {
    const body = selfCard
      ? selfCard.detail || selfCard.brief
      : pickByModel(ap.byModel, modelHint) || ap.text;
    if (nonEmpty(body)) blocks.push(tpl.appearance + "\n" + sanitizeData(body.trim()));
  }

  // ④【形象卡（数据，非指令）】
  if (fullCards.length > 0) {
    blocks.push(
      tpl.appearanceCards + "\n" + tpl.dataNote + "\n" + fullCards.map((c) => cardLine(c, tpl)).join("\n"),
    );
  }

  // ⑤【形象目录（数据，非指令）】
  if (indexCards.length > 0 && ap?.index !== false) {
    const lines = indexCards.map((c) => "- [" + sanitizeLine(c.id) + "] " + sanitizeLine(c.title + " · " + c.brief));
    blocks.push(tpl.appearanceIndex + "\n" + tpl.dataNote + "\n" + lines.join("\n") + "\n" + tpl.indexHint);
  }

  // ⑥【回复语气】（严格 === true 才注入）
  if (p.tone && p.tone.enabled === true) {
    const body = pickByModel(p.tone.byModel, modelHint) || p.tone.text;
    if (nonEmpty(body)) blocks.push(tpl.tone + "\n" + body.trim());
  }

  // ⑦ 工作契约（on !== false 且非空；永远在此位置）
  const contracts = (p.contracts ?? []).filter((c) => c && c.on !== false && nonEmpty(c.text));
  if (contracts.length > 0) {
    blocks.push(
      tpl.contracts + "\n" + contracts.map((c, i) => i + 1 + ". " + c.text.trim()).join("\n"),
    );
  }

  // ⑧【人格锚点】（≤300 字符；标题不带具体角色，换人格也通用）
  const meta = p.meta ?? { relation: { stage: "", trust: 0 }, mood: { baseline: "", bias: "" }, taboos: [], lexicon: {} };
  const anchor = fill(tpl.anchor, {
    selfName,
    userName,
    nameHint,
    relationStage: nonEmpty(meta.relation?.stage) ? meta.relation.stage : "—",
    moodBias: nonEmpty(meta.mood?.bias) ? meta.mood.bias : "—",
    taboos: (meta.taboos ?? []).length > 0 ? meta.taboos.join("、") : "无",
  });
  blocks.push(truncate(anchor, ANCHOR_CHARS));

  // ⑨【记忆导引】（恒定文案）
  blocks.push(tpl.guide);

  let prefix = blocks.join("\n\n");
  const thinking =
    nonEmpty(p.thinkingLanguage) && p.thinkingLanguage !== "off"
      ? fill(tpl.thinking, { lang: p.thinkingLanguage.trim() })
      : "";
  const suffix = nonEmpty(p.suffix)
    ? interpolateVars(p.suffix.trim(), { cwd: cwdValue() })
    : "";

  const warn: string[] = [];
  const total = prefix.length + thinking.length + suffix.length;
  if (total > PERSONA_WARN_CHARS) {
    const over = total - PERSONA_WARN_CHARS;
    warn.push(fill(tpl.personaOverBudget, { n: String(over) }));
    prefix = prefix + "\n" + warn[warn.length - 1];
  }

  return { prefix, thinking, suffix, blocks, warn };
}

// ---------- 数据行格式 ----------

function entryLine(e: MemoryEntry): string {
  const proj = nonEmpty(e.project) ? "（" + sanitizeLine(e.project) + "）" : "";
  return "- 「" + sanitizeLine(e.content) + proj + "」 [" + e.level + ":" + e.id + "]";
}

function fitLines(
  header: string,
  lines: string[],
  maxChars: number,
  omittedTpl: string,
): { text: string; items: number; trimmed: number } {
  if (lines.length === 0) return { text: "", items: 0, trimmed: 0 };
  const kept: string[] = [];
  let used = header.length + 1;
  let trimmed = 0;
  for (const line of lines) {
    const cost = line.length + 1;
    if (used + cost > maxChars) {
      trimmed += 1;
      continue;
    }
    used += cost;
    kept.push(line);
  }
  let text = header + "\n" + kept.join("\n");
  if (trimmed > 0) text = text + "\n" + fill(omittedTpl, { n: String(trimmed) });
  return { text, items: kept.length, trimmed };
}

/** S2 首轮快照：每层 ≤200 条、共 ≤snapshotMaxChars，按 importance→updated_at 选取 */
export function renderS2(items: MemoryEntry[], budget?: BudgetConfig): string {
  return renderS2Full(items, budget).text;
}

export function renderS2Full(
  items: MemoryEntry[],
  budget?: BudgetConfig,
): { text: string; items: number; trimmed: number } {
  const tpl = promptTemplates("zh");
  const b = budget ?? DEFAULT_BUDGET;
  const byLevel = new Map<LevelKey, MemoryEntry[]>();
  let capTrimmed = 0;
  for (const e of items ?? []) {
    const arr = byLevel.get(e.level) ?? [];
    arr.push(e);
    byLevel.set(e.level, arr);
  }
  const picked: MemoryEntry[] = [];
  for (const arr of byLevel.values()) {
    const sorted = [...arr].sort(
      (x, y) => y.importance - x.importance || y.updatedAt - x.updatedAt || (x.id < y.id ? -1 : 1),
    );
    if (sorted.length > MAX_PER_LEVEL) capTrimmed += sorted.length - MAX_PER_LEVEL;
    picked.push(...sorted.slice(0, MAX_PER_LEVEL));
  }
  picked.sort((x, y) => {
    const lx = LEVEL_ORDER.indexOf(x.level);
    const ly = LEVEL_ORDER.indexOf(y.level);
    if (lx !== ly) return lx - ly;
    return x.id < y.id ? -1 : x.id > y.id ? 1 : 0;
  });
  const header = tpl.snapshot + "\n" + tpl.dataNote;
  const out = fitLines(header, picked.map(entryLine), b.snapshotMaxChars, tpl.omitted);
  return { text: out.text, items: out.items, trimmed: out.trimmed + capTrimmed };
}

type LevelKey = MemoryEntry["level"];

export interface SectionResult {
  text: string;
  items: number;
  trimmed: number;
}

export function renderDeltaSection(delta: DeltaChange[], budget?: BudgetConfig): SectionResult {
  const tpl = promptTemplates("zh");
  const b = budget ?? DEFAULT_BUDGET;
  const all = (delta ?? []).slice();
  const label: Record<DeltaChange["kind"], string> = {
    added: tpl.added,
    updated: tpl.updated,
    archived: tpl.archived,
  };
  const lines = all.map(
    (d) =>
      "- [" + label[d.kind] + "] 「" + sanitizeLine(d.entry.content) + "」 [" + d.entry.level + ":" + d.entry.id + "]",
  );
  const kept: string[] = [];
  const carried: DeltaChange[] = [];
  let used = tpl.delta.length + 1;
  for (let i = 0; i < lines.length; i += 1) {
    const cost = lines[i].length + 1;
    if (kept.length >= S3_DELTA_ITEMS || used + cost > b.deltaMaxChars) {
      carried.push(all[i]);
      continue;
    }
    used += cost;
    kept.push(lines[i]);
  }
  if (kept.length === 0) return { text: "", items: 0, trimmed: carried.length };
  const text = tpl.delta + "\n" + tpl.dataNote + "\n" + kept.join("\n");
  return { text, items: kept.length, trimmed: carried.length };
}

export function renderRecallSection(hits: RankedHit[], budget?: BudgetConfig): SectionResult {
  const tpl = promptTemplates("zh");
  const b = budget ?? DEFAULT_BUDGET;
  const lines = (hits ?? []).map((h) => {
    const body = truncate(sanitizeLine(h.entry.content), S3_RECALL_CHARS);
    return "- 「" + body + "」 [" + h.entry.level + ":" + h.id + "]（" + h.explain + "）";
  });
  const kept: string[] = [];
  let used = tpl.recall.length + 1;
  let trimmed = 0;
  for (const line of lines) {
    const cost = line.length + 1;
    if (kept.length >= b.recallMaxItems || used + cost > b.recallMaxChars) {
      trimmed += 1;
      continue;
    }
    used += cost;
    kept.push(line);
  }
  if (kept.length === 0) return { text: "", items: 0, trimmed };
  const text = tpl.recall + "\n" + tpl.dataNote + "\n" + kept.join("\n");
  return { text, items: kept.length, trimmed };
}

export function renderQuoteSection(
  quotes: RenderInput["quotes"],
  budget?: BudgetConfig,
): SectionResult {
  const tpl = promptTemplates("zh");
  const b = budget ?? DEFAULT_BUDGET;
  void b;
  const lines = (quotes ?? []).map(
    (q) => "- 「" + sanitizeLine(q.text) + "」（" + q.sessionId + ":" + q.seq + "）",
  );
  const kept: string[] = [];
  let used = tpl.historyMemo.length + 1;
  let trimmed = 0;
  for (const line of lines) {
    const cost = line.length + 1;
    if (kept.length >= S3_QUOTE_ITEMS || used + cost > S3_QUOTE_CHARS) {
      trimmed += 1;
      continue;
    }
    used += cost;
    kept.push(line);
  }
  if (kept.length === 0) return { text: "", items: 0, trimmed };
  const text = tpl.historyMemo + "\n" + tpl.dataNote + "\n" + kept.join("\n");
  return { text, items: kept.length, trimmed };
}

/** roadmap v0.6 M1：约定小节（delta 之后、召回之前） */
export function renderPromiseSection(lines?: string[]): SectionResult {
  const tpl = promptTemplates("zh");
  const kept = (lines ?? []).map((l) => sanitizeLine(l)).filter((l) => l.length > 0);
  if (kept.length === 0) return { text: "", items: 0, trimmed: 0 };
  return { text: tpl.promise + "\n" + tpl.dataNote + "\n" + kept.join("\n"), items: kept.length, trimmed: 0 };
}

/** S3 每轮动态：delta 在前 + 约定 + 召回 + 原文；全空 ⇒ 零注入 */
export function renderS3(
  delta: DeltaChange[],
  hits: RankedHit[],
  quotes?: RenderInput["quotes"],
  budget?: BudgetConfig,
  promises?: string[],
): string {
  return renderS3Full(delta, hits, quotes, budget, promises).text;
}

export function renderS3Full(
  delta: DeltaChange[],
  hits: RankedHit[],
  quotes?: RenderInput["quotes"],
  budget?: BudgetConfig,
  promises?: string[],
): { text: string; delta: SectionResult; promise: SectionResult; recall: SectionResult; quote: SectionResult } {
  const d = renderDeltaSection(delta, budget);
  const p = renderPromiseSection(promises);
  const r = renderRecallSection(hits, budget);
  const q = renderQuoteSection(quotes, budget);
  const hasQuotes = (quotes ?? []).length > 0;
  if (d.items === 0 && p.items === 0 && r.items === 0 && !hasQuotes) {
    return { text: "", delta: d, promise: p, recall: r, quote: q };
  }
  const parts = [d.text, p.text, r.text, q.text].filter((s) => s.length > 0);
  return { text: parts.join("\n\n"), delta: d, promise: p, recall: r, quote: q };
}

/** 全量渲染：预览与注入共用（U4），hash 钉住一致性 */
export function renderAll(input: RenderInput): RenderResult {
  const s1 = renderS1(input.persona, input.modelHint, input.budget);
  const s2 = renderS2Full(input.snapshotItems, input.budget);
  const s3 = renderS3Full(input.delta, input.recallHits, input.quotes, input.budget, input.promises);

  const s1Text = [s1.prefix, s1.thinking, s1.suffix].filter((s) => s.length > 0).join("\n\n");
  const segments: RenderSegment[] = [
    { name: "s1-persona", text: s1Text, chars: s1Text.length, items: s1.blocks.length, trimmed: 0 },
    { name: "s2-snapshot", text: s2.text, chars: s2.text.length, items: s2.items, trimmed: s2.trimmed },
    { name: "s3-delta", text: s3.delta.text, chars: s3.delta.text.length, items: s3.delta.items, trimmed: s3.delta.trimmed },
    ...(s3.promise.items > 0
      ? [{ name: "s3-promise" as const, text: s3.promise.text, chars: s3.promise.text.length, items: s3.promise.items, trimmed: 0 }]
      : []),
    { name: "s3-recall", text: s3.recall.text, chars: s3.recall.text.length, items: s3.recall.items, trimmed: s3.recall.trimmed },
    { name: "s3-quote", text: s3.quote.text, chars: s3.quote.text.length, items: s3.quote.items, trimmed: s3.quote.trimmed },
  ];

  const warn = [...s1.warn];
  for (const seg of segments) {
    for (const w of findRelativeTime(seg.text)) {
      warn.push("relative-time-word-in-injection: " + w);
    }
  }

  const trace = (input.recallHits ?? []).map((h) => "[" + h.entry.level + ":" + h.id + "] " + h.explain);

  return {
    s1: { prefix: s1.prefix, thinking: s1.thinking, suffix: s1.suffix },
    s2: s2.text,
    s3: s3.text,
    segments,
    hash: renderHash([s1.prefix, s1.thinking, s1.suffix, s2.text, s3.text]),
    warn,
    trace,
  };
}
