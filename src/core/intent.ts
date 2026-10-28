/**
 * 忆织 MemWeave —— roadmap v0.5 R11：按问题类型给层加权（规则表，零依赖）。
 * R10 闪光灯参数也放这里（同属 §7 第一步的乘法因子）。
 */

import type { Level } from "./types";

export interface IntentRule {
  /** 显示名，trace 里写 intent=<name> */
  name: string;
  words: string[];
  level: Level;
}

export interface IntentConfig {
  enabled: boolean;
  factor: number;
  rules: IntentRule[];
}

export const DEFAULT_INTENT_RULES: IntentRule[] = [
  { name: "偏好", words: ["喜欢", "偏好", "习惯", "讨厌", "口味"], level: "user" },
  { name: "做法", words: ["怎么", "上次", "之前", "踩坑", "注意"], level: "lesson" },
  { name: "项目", words: ["项目", "代码", "仓库", "版本", "发布"], level: "project" },
  { name: "规则", words: ["必须", "不能", "规定", "红线"], level: "rules" },
];

export const DEFAULT_INTENT: IntentConfig = {
  enabled: false,
  factor: 1.35,
  rules: DEFAULT_INTENT_RULES.map((r) => ({ ...r, words: [...r.words] })),
};

export interface EmotionConfig {
  enabled: boolean;
  flashArousal: number;
  dailyFlashCap: number;
  factor: number;
  /** roadmap v0.6.1 M4：情绪残响地板（默认关；依赖 R10 emotion.enabled） */
  residue?: ResidueConfig;
}

export interface ResidueConfig {
  enabled: boolean;
  /** 时间衰减下限 */
  floor: number;
  /** |valence| 达到多少算强情绪 */
  minValence: number;
}

export const DEFAULT_RESIDUE: ResidueConfig = { enabled: false, floor: 0.55, minValence: 0.5 };

export const DEFAULT_EMOTION: EmotionConfig = { enabled: false, flashArousal: 0.7, dailyFlashCap: 5, factor: 1.45, residue: { ...DEFAULT_RESIDUE } };

/**
 * M4：强情绪条目（|valence| ≥ minValence 或 flash）的时间衰减地板。
 * 只有 R10 与残响都打开、条目符合条件时返回地板值，否则 null（条目打分与关闭时逐字节一致）。
 */
export function residueFloor(
  e: { valence?: number | null; flash?: boolean | null },
  cfg: EmotionConfig | undefined,
): number | null {
  const r = cfg?.residue;
  if (!cfg?.enabled || !r?.enabled) return null;
  const strong = e.flash === true || (typeof e.valence === "number" && Math.abs(e.valence) >= r.minValence);
  return strong ? r.floor : null;
}

const LEVELS: Level[] = ["soul", "rules", "user", "project", "lesson", "fact", "topic"];

/** 查询命中的意图：层 → 意图名列表（同一层被多条命中只算一次加权） */
export function detectIntent(query: string, cfg: IntentConfig): Map<Level, string[]> {
  const out = new Map<Level, string[]>();
  if (!cfg.enabled || !query) return out;
  const q = query.toLowerCase();
  for (const r of cfg.rules ?? []) {
    if (!r || !LEVELS.includes(r.level) || !Array.isArray(r.words)) continue;
    if (!r.words.some((w) => typeof w === "string" && w.trim() !== "" && q.includes(w.trim().toLowerCase()))) continue;
    const list = out.get(r.level) ?? [];
    if (!list.includes(r.name)) list.push(r.name);
    out.set(r.level, list);
  }
  return out;
}

/** 设置页传来的规则表清洗：最多 20 条，每条最多 30 个词 */
export function sanitizeIntentRules(v: unknown): IntentRule[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: IntentRule[] = [];
  for (const r of v.slice(0, 20)) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const level = String(o.level ?? "") as Level;
    if (!LEVELS.includes(level)) continue;
    const words = (Array.isArray(o.words) ? o.words : String(o.words ?? "").split(/[,，\s]+/))
      .map((w) => String(w).trim())
      .filter((w) => w.length > 0 && w.length <= 20)
      .slice(0, 30);
    if (words.length === 0) continue;
    out.push({ name: String(o.name ?? level).trim().slice(0, 12) || level, words, level });
  }
  return out;
}
