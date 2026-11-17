/**
 * 冲突检测共用的分词与相似度。
 * 候选对生成（candidates.ts）与精确打分（detector.ts）必须使用同一套 token
 * 否则预筛会以「相似度看起来低」为由漏掉真冲突。这里保留 detector.ts 原有的
 * 中英文混合分词行为，仅做纯搬迁，不改语义。
 */

/**
 * 简单分词（中英文混合）。
 * 中文按字切分，同时保留连续的汉字串；英文/数字按词切分并统一小写。
 */
export function tokenizeContent(text: string): string[] {
  const tokens: string[] = [];

  // 中文：按字符分割
  const chineseChars = text.match(/[\u4e00-\u9fa5]/g) || [];
  tokens.push(...chineseChars);

  // 英文和数字：按词分割
  const words = text
    .toLowerCase()
    .replace(/[^\w\s\u4e00-\u9fa5]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0 && !/^[\u4e00-\u9fa5]$/.test(t)); // 排除单个中文字
  tokens.push(...words);

  return tokens;
}

/** 分词后的集合（相似度按集合计算，重复 token 不影响结果）。 */
export function tokenSet(text: string): Set<string> {
  return new Set(tokenizeContent(text));
}

/** Jaccard 相似度：交集 / 并集；并集为空时记 0。 */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
