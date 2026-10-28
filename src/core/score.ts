/**
 * 召回打分（roadmap v0.2 §7，取代原规划 §8.2）：
 * score₁ = Σ w/(rrfK+rank) × importanceFactor × exp(-Δ天/τ) × rumination
 * score  = score₁ × 去同质系数（贪心重排）
 * 访问加成已取消（C6）；legacyAccessBonus 仅供等价测试。
 */

import { tokenize, normalizeAliases } from "./tokenize";
import type { Level, MemoryEntry } from "./types";

export const DEFAULT_HALF_LIFE_DAYS: Record<Level, number> = {
  topic: 30,
  fact: 90,
  project: 180,
  user: 365,
  soul: 365,
  lesson: 365,
  rules: 0, // 0 = 不衰减（∞）
};

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

export function decayFactor(entry: MemoryEntry, now: number, halfLife: Record<Level, number>): number {
  const hl = halfLife[entry.level] ?? 0;
  if (!hl || hl <= 0) return 1;
  const days = Math.max(0, (now - entry.updatedAt) / 86400000);
  // roadmap R6 / §7：τ × 2^boost
  const boost = Math.max(0, Math.min(3, Math.round(entry.boost ?? 0)));
  return Math.exp(-days / (hl * Math.pow(2, boost)));
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

/** R5 反刍抑制参数（roadmap v0.2 §3） */
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
  /** 过去 windowHours 内的召回注入次数（R5） */
  recentRecalls?: Map<string, number>;
  rumination?: RuminationConfig;
  /** C6：取消访问加成；仅「总开关等价测试」打开 */
  legacyAccessBonus?: boolean;
  /** roadmap R11：查询意图命中的层 → 意图名；空 = 不加权 */
  intent?: Map<Level, string[]>;
  intentFactor?: number;
  /** roadmap R10：闪光灯加权；未给 = 关 */
  flashFactor?: number;
  /**
   * roadmap v0.6 M1 / M2 / M4：逐条附加项。
   * decay：覆盖时间衰减（M1 pending = 1）；decayFloor：衰减下限（M4 残响）；factor：乘子；trace：附加解释。
   * 返回 null = 不影响（老条目逐字节一致）。
   */
  extra?: (entry: MemoryEntry) => { decay?: number; decayFloor?: number; factor?: number; trace?: string } | null;
}

/**
 * roadmap v0.2 §7 第一步：score₁ = RRF × imp × decay × rumination（× intent × flash，阶段 D）。
 * 访问加成已取消（C6），legacyAccessBonus=true 时恢复旧公式供等价测试。
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
  for (const [id, f] of fused) {
    const entry = entries.get(id);
    if (!entry) continue;
    const imp = importanceFactor(entry.importance);
    const ex = factors.extra?.(entry) ?? null;
    let dec = ex?.decay ?? decayFactor(entry, now, halfLife);
    // M4 残响：只在地板真的抬高了衰减时生效并写 trace
    let floored = false;
    if (ex?.decayFloor !== undefined && dec < ex.decayFloor) {
      dec = ex.decayFloor;
      floored = true;
    }
    const rum = ruminationFactor(entry.level, factors.recentRecalls?.get(id) ?? 0, rumCfg);
    let score = f.score * imp * dec * rum;
    let explain = `routes=${f.routes.join("+")}; rrf=${f.score.toFixed(5)}; imp=${imp.toFixed(2)}; decay=${dec.toFixed(2)}`;
    if (floored) explain += `; residue=${dec.toFixed(2)}`;
    if (ex) {
      if (ex.factor !== undefined) score *= ex.factor;
      if (ex.trace) explain += "; " + ex.trace;
    }
    // roadmap G14：反刍开着就始终展示系数（1.00 也展示），关着则不出现
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
  return hits.sort((x, y) => y.score - x.score || (x.id < y.id ? -1 : 1));
}

/** R4 检索去同质参数 */
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
 * roadmap v0.2 §7 第二步：贪心去同质重排。
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
  const remaining = [...hits];
  const selected: RankedHit[] = [];
  while (selected.length < limit && remaining.length > 0) {
    let bestIdx = 0;
    let bestScore = -Infinity;
    let bestFactor = 1;
    for (let i = 0; i < remaining.length; i += 1) {
      const h = remaining[i];
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
