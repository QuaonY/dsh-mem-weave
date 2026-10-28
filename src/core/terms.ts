/**
 * roadmap v0.7 S1：AI 写入时补的检索词。
 * 只用于召回的 `terms` 路（BM25），不进注入文本，不参与哈希去重 / 近似合并 / semanticKey 判断（C1）。
 */
import { matchSensitive } from "./sensitive";
import { tokenize } from "./tokenize";

export interface SearchTermsConfig {
  enabled: boolean;
  maxTerms: number;
  maxTermChars: number;
  routeWeight: number;
  /** 只取 terms 路前 N 名进融合（§6.6 实测：1） */
  routeTop: number;
  backfillPerDream: number;
}

export const DEFAULT_SEARCH_TERMS: SearchTermsConfig = {
  enabled: true,
  maxTerms: 8,
  maxTermChars: 12,
  routeWeight: 0.4,
  routeTop: 1,
  backfillPerDream: 20,
};

export interface TermsResult {
  terms: string[];
  /** 被丢掉的词与原因（敏感 / 过长 / 与正文重复 / 超出数量），供返回 warn */
  dropped: Array<{ term: string; reason: "sensitive" | "too-long" | "in-content" | "over-limit" | "empty" }>;
}

/**
 * §6.2 校验：去首尾空白与重复；每个 ≤ maxTermChars 字；去掉和正文分词完全重复的词
 * （词的全部分词都已出现在正文里）；逐个过敏感词；最多 maxTerms 个。
 */
export function normalizeTerms(
  raw: unknown,
  content: string,
  cfg: Pick<SearchTermsConfig, "maxTerms" | "maxTermChars"> = DEFAULT_SEARCH_TERMS,
  sensitive?: { custom?: string[]; disabled?: string[] },
): TermsResult {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[\s,，、;；]+/) : [];
  const body = new Set(tokenize(content));
  const seen = new Set<string>();
  const terms: string[] = [];
  const dropped: TermsResult["dropped"] = [];
  for (const x of list) {
    if (typeof x !== "string") continue;
    const t = x.trim().replace(/\s+/g, " ");
    if (t.length === 0) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if ([...t].length > cfg.maxTermChars) {
      dropped.push({ term: t, reason: "too-long" });
      continue;
    }
    const toks = tokenize(t);
    if (toks.length === 0) {
      dropped.push({ term: t, reason: "empty" });
      continue;
    }
    if (toks.every((k) => body.has(k))) {
      dropped.push({ term: t, reason: "in-content" });
      continue;
    }
    if (matchSensitive(t, sensitive?.custom, sensitive?.disabled)) {
      // 敏感词本身不回显
      dropped.push({ term: "***", reason: "sensitive" });
      continue;
    }
    if (terms.length >= cfg.maxTerms) {
      dropped.push({ term: t, reason: "over-limit" });
      continue;
    }
    terms.push(t);
  }
  return { terms, dropped };
}

/** 丢词原因汇总成一条 warn；没丢词返回 null */
export function termsWarn(dropped: TermsResult["dropped"]): string | null {
  if (dropped.length === 0) return null;
  const by = new Map<string, string[]>();
  for (const d of dropped) by.set(d.reason, [...(by.get(d.reason) ?? []), d.term]);
  return "searchTerms dropped: " + [...by.entries()].map(([r, ts]) => r + "(" + (r === "sensitive" ? ts.length : ts.join("、")) + ")").join(", ");
}

/** 合并时两条的检索词取并集（保持先后顺序），截到 max 个 */
export function unionTerms(a: string[] | null | undefined, b: string[] | null | undefined, max = DEFAULT_SEARCH_TERMS.maxTerms): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of [...(a ?? []), ...(b ?? [])]) {
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
}
