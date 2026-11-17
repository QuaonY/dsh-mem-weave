/**
 * 召回打分（取代原规划）
 * score₁ = Σ w/(rrfK+rank) × exp(-Δ天/τ) × rumination
 * score  = score₁ × 去同质系数（贪心重排）
 * 访问加成已取消；legacyAccessBonus 仅供等价测试。
 * importance 不再进入乘性分数，只在主分数数值相等时作为 tie-breaker：
 * 外部基准（LongMemEval / LoCoMo）上它把「新鲜 / 有来源」的条目往前推
 * 与 gold 无关，使 nDCG 低于同数据纯 BM25。
 */

import { tokenize, normalizeAliases } from "./tokenize";
import { LEVEL_ORDER, type Level, type MemoryEntry } from "./types";

export const DEFAULT_HALF_LIFE_DAYS: Record<Level, number> = {
  topic: 30,
  fact: 90,
  project: 180,
  user: 365,
  soul: 365,
  lesson: 365,
  rules: 0, // 0 = 不衰减（∞）
};

/**
 * 衰减下限。
 * 没有下限时，两年前的事实 decay ≈ 0，RRF 分数再高也被乘成噪声——「正确但陈旧」的知识
 * 在召回里等同不存在。0.1 表示无论多旧，仍保留 10% 的权重：排序上仍会输给新鲜条目
 * 但不会被彻底抹掉。设为 0 即恢复旧行为。
 */
export const DEFAULT_DECAY_FLOOR = 0.1;

/**
 * 半衰期的**唯一**归一化口径。
 * 之前 `DEFAULT_HALF_LIFE_DAYS`（内核兜底）与 `lifecycle.halfLifeDays`（配置）
 * 是两张各写一遍的表，settings.json 手改出负数 / 字符串 / 缺键时没有任何一处校验：
 * `decayFactor` 里 `hl <= 0` 与 `NaN` 都走「不衰减」分支，等于静默关掉时间衰减。
 * 规则：
 * - 缺键、非数值、`NaN`、`Infinity`、负值 → 回落到该层默认（`fallback`）
 * - `0` 是合法值（= 不衰减，与 `rules` 一致），只有显式写 0 才会关掉衰减
 * - 数字字符串 → 接受（手写 settings.json 常见）
 * - 不设上限：基准用 `half-life-days 100000` 近似关闭衰减，需要保留这种写法
 */
export function parseHalfLifeValue(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN;
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

export function normalizeHalfLifeValue(
  v: unknown,
  level: Level,
  fallback: Record<Level, number> = DEFAULT_HALF_LIFE_DAYS,
): number {
  return parseHalfLifeValue(v) ?? fallback[level] ?? 0;
}

/** 整张半衰期表的归一化：逐层走 `normalizeHalfLifeValue`；返回新对象，不改入参 */
export function normalizeHalfLife(
  input: unknown,
  fallback: Record<Level, number> = DEFAULT_HALF_LIFE_DAYS,
): Record<Level, number> {
  const rec = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const out = {} as Record<Level, number>;
  for (const lv of LEVEL_ORDER) out[lv] = normalizeHalfLifeValue(rec[lv], lv, fallback);
  return out;
}

/**
 * 衰减下限的归一化，与半衰期同一口径。
 * 缺键 / 非数值 → `DEFAULT_DECAY_FLOOR`；负值夹 0；> 1 夹 1。
 */
export function normalizeDecayFloor(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN;
  if (!Number.isFinite(n)) return DEFAULT_DECAY_FLOOR;
  return Math.max(0, Math.min(1, n));
}

export interface ScoredDoc {
  id: string;
  tokens: string[];
}

export function bm25Scores(queryTokens: string[], docs: ScoredDoc[], k1 = 1.2, b = 0.75): Map<string, number> {
  const scores = new Map<string, number>();
  if (queryTokens.length === 0 || docs.length === 0) return scores;
  const df = new Map<string, number>();
  let totalLen = 0;
  for (const d of docs) {
    totalLen += d.tokens.length;
    const seen = new Set(d.tokens);
    for (const t of seen) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const avgLen = totalLen / docs.length || 1;
  const n = docs.length;
  for (const d of docs) {
    const tfMap = new Map<string, number>();
    for (const t of d.tokens) tfMap.set(t, (tfMap.get(t) ?? 0) + 1);
    let s = 0;
    for (const q of queryTokens) {
      const f = tfMap.get(q) ?? 0;
      if (f === 0) continue;
      const idf = Math.log(1 + (n - (df.get(q) ?? 0) + 0.5) / ((df.get(q) ?? 0) + 0.5));
      s += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.tokens.length) / avgLen)));
    }
    scores.set(d.id, s);
  }
  return scores;
}

export interface RouteRank {
  id: string;
  rank: number;
  weight: number;
  route: string;
}

export function rrfFuse(
  routes: RouteRank[],
  rrfK: number,
): Map<string, { score: number; routes: string[] }> {
  const fused = new Map<string, { score: number; routes: string[] }>();
  for (const r of routes) {
    const cur = fused.get(r.id) ?? { score: 0, routes: [] };
    cur.score += r.weight / (rrfK + r.rank);
    if (!cur.routes.includes(r.route)) cur.routes.push(r.route);
    fused.set(r.id, cur);
  }
  return fused;
}

export function importanceFactor(importance: number): number {
  return 0.7 + 0.1 * Math.max(1, Math.min(5, importance));
}

export function decayFactor(
  entry: MemoryEntry,
  now: number,
  halfLife: Record<Level, number>,
  floor: number = DEFAULT_DECAY_FLOOR,
): number {
  const hl = halfLife[entry.level] ?? 0;
  if (!hl || hl <= 0) return 1;
  const days = Math.max(0, (now - entry.updatedAt) / 86400000);
  // τ × 2^boost
  const boost = Math.max(0, Math.min(3, Math.round(entry.boost ?? 0)));
  const raw = Math.exp(-days / (hl * Math.pow(2, boost)));
  // max(floor, …)；非法值走归一化，回落默认而不是静默当作 0
  return Math.max(normalizeDecayFloor(floor), raw);
}

export function accessFactor(accessCount: number): number {
  return 1 + 0.05 * Math.log(1 + Math.max(0, accessCount));
}

export interface RankedHit {
  id: string;
  score: number;
  routes: string[];
  explain: string;
  entry: MemoryEntry;
}

/** 反刍抑制参数 */
export interface RuminationConfig {
  enabled: boolean;
  windowHours: number;
  freeHits: number;
  factor: number;
  floor: number;
}

export const DEFAULT_RUMINATION: RuminationConfig = {
  enabled: true,
  windowHours: 24,
  freeHits: 2,
  factor: 0.85,
  floor: 0.5,
};

/** rumination = max(floor, factor ^ max(0, recent − freeHits))；rules/soul 恒为 1 */
export function ruminationFactor(level: Level, recent: number, cfg: RuminationConfig = DEFAULT_RUMINATION): number {
  if (!cfg.enabled || level === "rules" || level === "soul") return 1;
  const over = Math.max(0, recent - cfg.freeHits);
  if (over === 0) return 1;
  return Math.max(cfg.floor, Math.pow(cfg.factor, over));
}

export interface RankingFactors {
  /** 过去 windowHours 内的召回注入次数*/
  recentRecalls?: Map<string, number>;
  rumination?: RuminationConfig;
  /** 取消访问加成；仅「总开关等价测试」打开 */
  legacyAccessBonus?: boolean;
  /** 查询意图命中的层 → 意图名；空 = 不加权 */
  intent?: Map<Level, string[]>;
  intentFactor?: number;
  /** 闪光灯加权；未给 = 关 */
  flashFactor?: number;
  /**
   * 全局衰减下限（默认 `DEFAULT_DECAY_FLOOR`）。
   * 与 `extra.decayFloor` 不同——后者是逐条残响（情绪强记忆 / 闪光灯），只抬个别条目。
   */
  decayFloor?: number;
  /**
   * 逐条附加项。
   * decay：覆盖时间衰减（pending = 1）；decayFloor：衰减下限（残响）；factor：乘子；trace：附加解释。
   * 返回 null = 不影响（老条目逐字节一致）。
   */
  extra?: (entry: MemoryEntry) => { decay?: number; decayFloor?: number; factor?: number; trace?: string } | null;
}

/**
 * 第一步：score₁ = RRF × decay × rumination（另乘意图与闪光灯的增益）。
 * 访问加成已取消，legacyAccessBonus=true 时恢复旧公式供等价测试。
 * importance 只做 tie-breaker（主分数数值相等时），不参与乘性打分。
 */
export function finalizeRanking(
  fused: Map<string, { score: number; routes: string[] }>,
  entries: Map<string, MemoryEntry>,
  now: number,
  halfLife: Record<Level, number> = DEFAULT_HALF_LIFE_DAYS,
  factors: RankingFactors = {},
): RankedHit[] {
  const hits: RankedHit[] = [];
  const rumCfg = factors.rumination ?? DEFAULT_RUMINATION;
  // 半衰期表只有一份口径，直接调用者也走同一套归一化
  const hl = normalizeHalfLife(halfLife);
  for (const [id, f] of fused) {
    const entry = entries.get(id);
    if (!entry) continue;
    const imp = importanceFactor(entry.importance);
    const ex = factors.extra?.(entry) ?? null;
    let dec = ex?.decay ?? decayFactor(entry, now, hl, factors.decayFloor);
    // 残响：只在地板真的抬高了衰减时生效并写 trace
    let floored = false;
    if (ex?.decayFloor !== undefined && dec < ex.decayFloor) {
      dec = ex.decayFloor;
      floored = true;
    }
    const rum = ruminationFactor(entry.level, factors.recentRecalls?.get(id) ?? 0, rumCfg);
    let score = f.score * dec * rum;
    let explain = `routes=${f.routes.join("+")}; rrf=${f.score.toFixed(5)}; imp=${imp.toFixed(2)}; decay=${dec.toFixed(2)}`;
    if (floored) explain += `; residue=${dec.toFixed(2)}`;
    if (ex) {
      if (ex.factor !== undefined) score *= ex.factor;
      if (ex.trace) explain += "; " + ex.trace;
    }
    // 反刍开着就始终展示系数（1.00 也展示），关着则不出现
    if (rumCfg.enabled) explain += `; rum=${rum.toFixed(2)}`;
    const hitIntent = factors.intent?.get(entry.level);
    if (hitIntent && hitIntent.length > 0) {
      const k = factors.intentFactor ?? 1.35;
      score *= k;
      explain += `; intent=${hitIntent.join("+")}×${k.toFixed(2)}`;
    }
    if (factors.flashFactor !== undefined && entry.flash === true) {
      score *= factors.flashFactor;
      explain += `; flash=${factors.flashFactor.toFixed(2)}`;
    }
    if (factors.legacyAccessBonus) {
      const acc = accessFactor(entry.accessCount);
      score *= acc;
      explain += `; access=${acc.toFixed(2)}`;
    }
    hits.push({ id, score, routes: f.routes, entry, explain });
  }
  return hits.sort(compareHits);
}

/** 主分数相等（数值误差内）时才用 importance 裁决，最后按 id 保证稳定排序。 */
function compareHits(x: RankedHit, y: RankedHit): number {
  const scale = Math.max(1, Math.abs(x.score), Math.abs(y.score));
  if (Math.abs(x.score - y.score) > 1e-9 * scale) return y.score - x.score;
  const ix = importanceFactor(x.entry.importance);
  const iy = importanceFactor(y.entry.importance);
  if (ix !== iy) return iy - ix;
  return x.id < y.id ? -1 : 1;
}

/** 检索去同质参数 */
export interface DiversityConfig {
  enabled: boolean;
  threshold: number;
  factors: number[];
}

export const DEFAULT_DIVERSITY: DiversityConfig = {
  enabled: true,
  threshold: 0.5,
  factors: [1, 0.86, 0.72, 0.6],
};

/**
 * 第二步：贪心去同质重排。
 * 每次从剩余里取（当前已选集合下）折后分最高的；k = 已选中与它相似度 ≥ threshold 的条数。
 */
export function diversify(
  hits: RankedHit[],
  limit: number,
  sim: (a: RankedHit, b: RankedHit) => number,
  cfg: DiversityConfig = DEFAULT_DIVERSITY,
): RankedHit[] {
  if (!cfg.enabled || hits.length <= 1) return hits.slice(0, limit);
  const factors = cfg.factors.length > 0 ? cfg.factors : [1];
  // 分数只会被系数压低（系数默认 ≤1）；按分数降序后，低于当前最优即可提前停
  const maxFactor = Math.max(1, ...factors);
  const remaining = [...hits].sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
  const selected: RankedHit[] = [];
  while (selected.length < limit && remaining.length > 0) {
    let bestIdx = 0;
    let bestScore = -Infinity;
    let bestFactor = 1;
    for (let i = 0; i < remaining.length; i += 1) {
      const h = remaining[i];
      if (h.score * maxFactor < bestScore) break;
      const k = selected.filter((s) => sim(h, s) >= cfg.threshold).length;
      const fac = factors[Math.min(k, factors.length - 1)];
      const sc = h.score * fac;
      if (sc > bestScore || (sc === bestScore && h.id < remaining[bestIdx].id)) {
        bestIdx = i;
        bestScore = sc;
        bestFactor = fac;
      }
    }
    const [pick] = remaining.splice(bestIdx, 1);
    selected.push(
      bestFactor === 1 ? pick : { ...pick, score: bestScore, explain: pick.explain + `; div=${bestFactor.toFixed(2)}` },
    );
  }
  return selected;
}

/** 便捷入口：对一组条目做关键词路排序（语义路由默认关闭，D4） */
export function keywordRank(query: string, entries: MemoryEntry[]): RankedHit[] {
  const qTokens = normalizeAliases(tokenize(query));
  const docs = entries.map((e) => ({
    id: e.id,
    tokens: normalizeAliases(tokenize(e.content + " " + e.keywords.join(" "))),
  }));
  const bm = bm25Scores(qTokens, docs);
  const routes: RouteRank[] = [];
  for (const [id, s] of bm) {
    if (s <= 0) continue;
    routes.push({ id, rank: routes.length, weight: 1.0, route: "keyword" });
  }
  routes.sort((x, y) => (bm.get(y.id) ?? 0) - (bm.get(x.id) ?? 0));
  routes.forEach((r, i) => {
    r.rank = i + 1;
  });
  const fused = rrfFuse(routes, 60);
  return finalizeRanking(fused, new Map(entries.map((e) => [e.id, e])), Date.now());
}
