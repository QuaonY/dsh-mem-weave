/**
 * 冲突候选对生成。
 * 背景：detector.detectConflicts 原本对全部记忆两两比较（O(n²)）
 * 7 层各取 500 条时约有 600 万对。实际冲突必然要求内容相似度 ≥ 0.5
 * （time / fact / opinion 三个子检测器都会先算 contentSimilarity）
 * 因此可以在精确打分前先把「不可能达到阈值」的对剪掉。
 * 算法：Jaccard 前缀过滤（prefix filtering）。
 * - 按 token 的全局文档频率升序给所有 token 排序（稀有 token 在前）；
 * - 文档集合大小 |S|、阈值 t 时，只把前 p = |S| - ceil(t·|S|) + 1 个 token 入倒排；
 * - 若 Jaccard(A,B) ≥ t 且 |A| ≤ |B|，则 A、B 的前缀必有交集（经典引理）
 *   所以候选对与暴力两两比较的**结果完全一致**，不是近似召回。
 * 与近似做法的差异：默认走**精确模式**（不做 top-k 截断）
 * 因为前缀过滤本身已经把候选压到远低于 n²，且可证明不丢对；
 * 只有调用方显式给出 `maxCandidatesPerDoc` 时，才对候选过多的文档做
 * 按「共享前缀 token 数」截断，用来给超大库兜底。真正病态的重复数据
 * （大量完全相同的条目）仍会退化为 O(n²)，那类数据本来就两两都是冲突。
 */

import { jaccard, tokenSet } from "./tokens";

/**
 * 候选对的最小相似度。
 * detector 的三个子检测器都以 `similarity < 0.5` 提前返回，因此低于 0.5 的对
 * 不可能产生冲突（事实冲突允许恰好等于 0.5）。
 */
export const CANDIDATE_MIN_SIMILARITY = 0.5;

/** 生成候选对所需的最小输入。 */
export interface CandidateDoc {
  /** 仅用于调用方回填；候选对本身只给下标。 */
  id: string;
  content: string;
}

/** 候选对生成的可观测指标（用于测试与日志，不参与判定）。 */
export interface CandidateStats {
  /** 参与比较的文档数。 */
  documents: number;
  /** 进入倒排索引的 (文档, token) 数量。 */
  indexedTokens: number;
  /** 实际做了精确 Jaccard 计算的对数。 */
  pairsCompared: number;
  /** 未做精确计算的对数（前缀过滤 + top-k 截断）。 */
  pairsSkipped: number;
  /** 候选数超过上限、被 top-k 截断的文档数；精确模式下恒为 0。 */
  truncatedDocs: number;
}

export interface CandidateOptions {
  /** 判定冲突所需的最小相似度，默认 0.5。 */
  minSimilarity?: number;
  /**
   * 每篇文档最多保留的候选邻居数（按共享前缀 token 数从高到低取）。
   * 0 / 不传 = 不截断（精确模式）。
   * 为什么可以截断：真冲突要求 Jaccard ≥ 0.5，此时较小集合的前缀里
   * 至少有 `p - (a - s)` 个 token 与对方共享（a 为集合大小、p 为前缀长度
   * s 为交集大小）。按共享前缀 token 数排序，真冲突会稳定排在前面。
   */
  maxCandidatesPerDoc?: number;
}

export interface CandidateResult {
  /** 下标对 [i, j]，i < j，按 i 升序、再按 j 升序排列。 */
  pairs: Array<[number, number]>;
  stats: CandidateStats;
}

/**
 * 生成疑似冲突的候选对。
 * 返回的下标可直接索引传入的 docs 数组；排序保证与暴力两两比较的遍历顺序一致
 * 从而让 detectConflicts 的输出顺序保持稳定。
 */
export function buildCandidatePairs(
  docs: readonly CandidateDoc[],
  options: CandidateOptions = {},
): CandidateResult {
  const n = docs.length;
  const emptyStats: CandidateStats = {
    documents: n,
    indexedTokens: 0,
    pairsCompared: 0,
    pairsSkipped: 0,
    truncatedDocs: 0,
  };
  if (n < 2) return { pairs: [], stats: emptyStats };

  const maxPerDoc = Math.max(0, Math.floor(options.maxCandidatesPerDoc ?? 0));
  const t = Math.min(Math.max(options.minSimilarity ?? CANDIDATE_MIN_SIMILARITY, Number.EPSILON), 1);

  const sets = docs.map((doc) => tokenSet(doc.content));

  // 全局 token 排序：文档频率升序，其次按字典序（保证跨机器确定性）。
  const documentFrequency = new Map<string, number>();
  for (const set of sets) {
    for (const token of set) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
  }
  const rank = new Map<string, number>();
  const orderedTokens = [...documentFrequency.entries()]
    .sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([token]) => token);
  orderedTokens.forEach((token, i) => rank.set(token, i));

  // 小集合先处理：前缀更短，倒排更省，且满足前缀引理的前提（|A| ≤ |B|）。
  const bySize = docs
    .map((_, i) => i)
    .filter((i) => sets[i].size > 0)
    .sort((a, b) => sets[a].size - sets[b].size || a - b);

  const postings = new Map<string, number[]>();
  const pairs: Array<[number, number]> = [];
  let indexedTokens = 0;
  let pairsCompared = 0;
  let truncatedDocs = 0;

  for (const i of bySize) {
    const tokens = [...sets[i]].sort((a, b) => rank.get(a)! - rank.get(b)!);
    const size = tokens.length;
    const prefixLength = Math.max(1, Math.min(size, size - Math.ceil(t * size) + 1));
    const prefix = tokens.slice(0, prefixLength);

    // 探测：与已入索引文档的前缀求交，并统计共享前缀 token 数。
    let candidates = new Map<number, number>();
    for (const token of prefix) {
      const bucket = postings.get(token);
      if (!bucket) continue;
      for (const j of bucket) {
        candidates.set(j, (candidates.get(j) ?? 0) + 1);
      }
    }

    // top-k 截断：候选过多时只保留共享 token 最多的邻居，避免病态数据退化为 n²。
    if (maxPerDoc > 0 && candidates.size > maxPerDoc) {
      truncatedDocs++;
      const buckets: Array<number[] | undefined> = [];
      for (const [j, count] of candidates) {
        (buckets[count] ??= []).push(j);
      }
      const kept = new Map<number, number>();
      for (let count = buckets.length - 1; count >= 1 && kept.size < maxPerDoc; count--) {
        const bucket = buckets[count];
        if (!bucket) continue;
        for (const j of bucket) {
          kept.set(j, count);
          if (kept.size >= maxPerDoc) break;
        }
      }
      candidates = kept;
    }

    for (const j of candidates.keys()) {
      pairsCompared++;
      const low = i < j ? i : j;
      const high = i < j ? j : i;
      if (jaccard(sets[i], sets[j]) < t) continue;
      pairs.push([low, high]);
    }

    // 入索引：只索引前缀（引理只保证前缀有交集）。
    for (const token of prefix) {
      let bucket = postings.get(token);
      if (!bucket) {
        bucket = [];
        postings.set(token, bucket);
      }
      bucket.push(i);
      indexedTokens++;
    }
  }

  pairs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  const totalPairs = (n * (n - 1)) / 2;
  return {
    pairs,
    stats: {
      documents: n,
      indexedTokens,
      pairsCompared,
      pairsSkipped: Math.max(0, totalPairs - pairsCompared),
      truncatedDocs,
    },
  };
}
