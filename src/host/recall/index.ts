/**
 * 召回模块 —— 从 host/service.ts 纯搬迁（行为不变）。
 * 关键词（BM25）+ 关联图 + 日历锚点 + 检索词四路，RRF 融合后接衰减、反刍抑制与去同质。
 */

import { DEFAULT_ALIAS_GROUPS, mergeAliasGroups, normalizeAliases, tokenize } from "../../core/tokenize";
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
} from "../../core/score";
import { promiseScore, type PromiseConfig } from "../../core/promise";
import { anchorTrace, matchAnchor, resolveTimeZone, type CalendarConfig, type CalendarMatch } from "../../core/calendar";
import type { SearchTermsConfig } from "../../core/terms";
import { detectIntent, residueFloor, type EmotionConfig, type IntentConfig } from "../../core/intent";
import type { Level, MemoryEntry } from "../../core/types";
import type { WeaveEnv } from "../../store/db";
import { getLinks, listConflicts, listMemory } from "../../store/dao";
import { jaccard, recentRecallCounts } from "../../store/link";
import { searchMemoryIds } from "../../store/fts";
import { DEFAULT_VECTOR_ROUTE, vectorRoute } from "../../store/recall-vector";
/**
 * 条目正文分词结果缓存。召回每次都会对全库分词，规模变大后成为主要开销；
 * 条目不可变标识是 (id, updatedAt, 内容/关键词长度)，改写会刷新 updatedAt。
 */
const docTokenCache = new Map<string, { stamp: string; tokens: string[] }>();

function cachedDocTokens(key: string, stamp: string, text: () => string): string[] {
  const hit = docTokenCache.get(key);
  if (hit && hit.stamp === stamp) return hit.tokens;
  const tokens = tokenize(text());
  if (docTokenCache.size >= 50000) docTokenCache.clear();
  docTokenCache.set(key, { stamp, tokens });
  return tokens;
}

/** 仅供测试：清空分词缓存 */
export function clearDocTokenCache(): void {
  docTokenCache.clear();
}

/** 注入页用的召回解释（每条一行，正文截 40 字） */
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

/**
 * FTS 前置候选上限。
 * 最终只注入 hitTopK（默认 5）条，200 条足够覆盖融合、去同质与关联路补全。
 */
export const RECALL_PREFILTER_LIMIT = 200;

interface RecallCandidateOpts {
  project?: string | null;
  aliasGroups?: string[][];
  calendar?: CalendarConfig;
  now: number;
  frozen: Set<string>;
  /** 仅供等价测试：false 时走 之前的全量扫描 */
  prefilter?: boolean;
}

/**
 * 召回候选集。
 * 先由 memory_fts 取 top N（中文二元组口径，同义组已展开），再用全量查询补上日历锚点条目；
 * FTS 没命中（索引缺失 / 查询全是标点）时回退全量扫描，保证不因索引不可用而召回为空。
 */
function loadRecallCandidates(env: WeaveEnv, query: string, o: RecallCandidateOpts): MemoryEntry[] {
  const ids =
    o.prefilter === false
      ? []
      : searchMemoryIds(env, query, { limit: RECALL_PREFILTER_LIMIT, expand: o.aliasGroups });
  const base =
    ids.length > 0
      ? listMemory(env, { status: "active", ids })
      : listMemory(env, { status: "active" });

  const out: MemoryEntry[] = [];
  const seen = new Set<string>();
  const accept = (e: MemoryEntry): void => {
    if (seen.has(e.id)) return;
    if (o.frozen.has(e.id)) return;
    if (e.validTo !== null && e.validTo !== undefined && e.validTo <= o.now) return;
    if (o.project !== undefined && o.project !== null && e.project !== o.project) return;
    seen.add(e.id);
    out.push(e);
  };
  for (const e of base) accept(e);
  // 日历锚点条目与文本是否命中无关，必须进候选池（否则前置过滤会把它们挡掉）
  if (o.calendar?.enabled) {
    for (const e of listMemory(env, { status: "active", anchored: true })) accept(e);
  }
  return out;
}

/**
 * 关键词前 3 的一跳邻居可能不在前置候选里（文本没命中，靠关联路带进来）
 * 这里按需补进 entryMap，让关联路看到它们。
 */
function addLinkNeighbors(
  env: WeaveEnv,
  ranked: Array<[string, number]>,
  entryMap: Map<string, MemoryEntry>,
  accept: (e: MemoryEntry) => boolean,
): void {
  const wanted = new Set<string>();
  for (const [id] of ranked.slice(0, 3)) {
    for (const l of getLinks(env, id)) {
      const other = l.src === id ? l.dst : l.src;
      if (other !== id && !entryMap.has(other)) wanted.add(other);
    }
  }
  if (wanted.size === 0) return;
  for (const e of listMemory(env, { status: "active", ids: [...wanted] })) {
    if (accept(e)) entryMap.set(e.id, e);
  }
}

/** 三路之二：关键词（BM25）+ 关联图（links 一跳），RRF 融合；硬过滤 status/valid_to/conflicts */
export function recallEntries(
  env: WeaveEnv,
  query: string,
  opts?: {
    limit?: number;
    project?: string | null;
    halfLife?: Record<Level, number>;
    /** 衰减下限（未给 = `DEFAULT_DECAY_FLOOR`，0 = 不设下限） */
    decayFloor?: number;
    rrfK?: number;
    /** 附录 A recall.routes：启用的路由（缺省 keyword+link；semantic 由向量路占位，未开即空） */
    routes?: string[];
    /** 附录 A recall.weights：路由权重（缺省 keyword 1.0 / link 0.5） */
    weights?: { keyword?: number; semantic?: number; link?: number };
    /** 附录 A recall.synonymsFile：附加同义词组 */
    aliasGroups?: string[][];
    /** 反刍抑制（缺省开） */
    rumination?: RuminationConfig;
    /** 去同质（缺省开） */
    diversity?: DiversityConfig;
    /** 恢复旧访问加成（仅等价测试） */
    legacyAccessBonus?: boolean;
    /** 情绪残响，缺省关闭 */
    intent?: IntentConfig;
    emotion?: EmotionConfig;
    promise?: PromiseConfig;
    calendar?: CalendarConfig;
    /** S1 */
    searchTerms?: SearchTermsConfig;
    /** 仅供等价测试关闭前置候选（默认开） */
    prefilter?: boolean;
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
  const acceptCandidate = (e: MemoryEntry): boolean =>
    !frozen.has(e.id) &&
    !(e.validTo !== null && e.validTo !== undefined && e.validTo <= now) &&
    !(opts?.project !== undefined && opts.project !== null && e.project !== opts.project);
  const entries = loadRecallCandidates(env, query, {
    project: opts?.project,
    aliasGroups: opts?.aliasGroups,
    calendar: opts?.calendar,
    now,
    frozen,
    prefilter: opts?.prefilter,
  });
  const entryMap = new Map(entries.map((e) => [e.id, e]));
  const qTokens = normalizeAliases(tokenize(query), groups);
  const docs = entries.map((e) => ({
    id: e.id,
    tokens: normalizeAliases(
      cachedDocTokens("c:" + e.id, `${e.updatedAt}|${e.content.length}|${e.keywords.length}`, () =>
        e.content + " " + e.keywords.join(" "),
      ),
      groups,
    ),
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
    addLinkNeighbors(env, ranked, entryMap, acceptCandidate);
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

  // 窗口内的锚点条目强制进候选池（RRF 记一路 calendar，权重同关联路）
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

  // 检索词路。只对 search_terms 做 BM25，权重 0.4、只取前 routeTop 名（实测定参）
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
    decayFloor: opts?.decayFloor,
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

/**
 * 异步召回（支持向量路由）
 * 与 recallEntries 相同，但支持：
 * - queryEmbedding: 查询的 embedding 向量（用于 semantic 路由）
 * - vector: 向量路由配置
 * - 异步执行以支持向量搜索
 */
export async function recallEntriesAsync(
  env: WeaveEnv,
  query: string,
  opts?: {
    limit?: number;
    project?: string | null;
    halfLife?: Record<Level, number>;
    /** 衰减下限（未给 = `DEFAULT_DECAY_FLOOR`，0 = 不设下限） */
    decayFloor?: number;
    rrfK?: number;
    /** 附录 A recall.routes：启用的路由（缺省 keyword+link；semantic 需显式启用） */
    routes?: string[];
    /** 附录 A recall.weights：路由权重（缺省 keyword 1.0 / link 0.5 / semantic 0.8） */
    weights?: { keyword?: number; semantic?: number; link?: number };
    /** 附录 A recall.synonymsFile：附加同义词组 */
    aliasGroups?: string[][];
    /** 反刍抑制（缺省开） */
    rumination?: RuminationConfig;
    /** 去同质（缺省开） */
    diversity?: DiversityConfig;
    /** 恢复旧访问加成（仅等价测试） */
    legacyAccessBonus?: boolean;
    /** 情绪残响，缺省关闭 */
    intent?: IntentConfig;
    emotion?: EmotionConfig;
    promise?: PromiseConfig;
    calendar?: CalendarConfig;
    /** S1 */
    searchTerms?: SearchTermsConfig;
    /** 向量路由 */
    vector?: {
      enabled: boolean;
      weight?: number;
      topK?: number;
      minScore?: number;
      timeoutMs?: number;
    };
    /** 查询的 embedding 向量（用于 semantic 路由） */
    queryEmbedding?: Float32Array | null;
    /** 仅供等价测试关闭前置候选（默认开） */
    prefilter?: boolean;
    now?: number;
  },
): Promise<RankedHit[]> {
  const now = opts?.now ?? Date.now();
  const useKeyword = opts?.routes === undefined || opts.routes.includes("keyword");
  const useLink = opts?.routes === undefined || opts.routes.includes("link");
  const useSemantic = opts?.routes?.includes("semantic") ?? false;
  const groups = mergeAliasGroups(DEFAULT_ALIAS_GROUPS, opts?.aliasGroups);
  const frozen = new Set<string>();
  for (const c of listConflicts(env, "open")) {
    for (const t of c.contenders) frozen.add(t.id);
  }
  const acceptCandidate = (e: MemoryEntry): boolean =>
    !frozen.has(e.id) &&
    !(e.validTo !== null && e.validTo !== undefined && e.validTo <= now) &&
    !(opts?.project !== undefined && opts.project !== null && e.project !== opts.project);
  const entries = loadRecallCandidates(env, query, {
    project: opts?.project,
    aliasGroups: opts?.aliasGroups,
    calendar: opts?.calendar,
    now,
    frozen,
    prefilter: opts?.prefilter,
  });
  const entryMap = new Map(entries.map((e) => [e.id, e]));
  const qTokens = normalizeAliases(tokenize(query), groups);
  const docs = entries.map((e) => ({
    id: e.id,
    tokens: normalizeAliases(
      cachedDocTokens("c:" + e.id, `${e.updatedAt}|${e.content.length}|${e.keywords.length}`, () =>
        e.content + " " + e.keywords.join(" "),
      ),
      groups,
    ),
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
    addLinkNeighbors(env, ranked, entryMap, acceptCandidate);
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

  // 向量路由（semantic route）
  if (useSemantic && opts?.vector?.enabled && opts?.queryEmbedding) {
    try {
      const vectorConfig = {
        ...DEFAULT_VECTOR_ROUTE,
        ...opts.vector,
        weight: opts.weights?.semantic ?? opts.vector.weight ?? 0.8,
      };
      
      const vectorResults = await vectorRoute(env, opts.queryEmbedding, vectorConfig, {
        project: opts.project ?? undefined,
        excludeIds: keywordHit, // 避免与 keyword 路由重复
      });
      
      routes.push(...vectorResults);
    } catch {
      // 向量路由失败不阻塞（原则）
    }
  }

  // 窗口内的锚点条目强制进候选池（RRF 记一路 calendar，权重同关联路）
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

  // 检索词路。只对 search_terms 做 BM25，权重 0.4、只取前 routeTop 名（实测定参）
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
    decayFloor: opts?.decayFloor,
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
