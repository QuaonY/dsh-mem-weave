/**
 * 分词（零依赖兜底，§8.2）：拉丁词 + CJK 二元组 + 数字。
 * 不引词向量也能救一半的同义扩展。
 */

const LATIN = /[a-z0-9]+(?:[-_][a-z0-9]+)*/g;
const CJK_RUN = /[一-龥々]+/g;

export function tokenize(text: string): string[] {
  const out: string[] = [];
  const lower = text.toLowerCase();
  for (const m of lower.matchAll(LATIN)) out.push(m[0]);
  for (const m of lower.matchAll(CJK_RUN)) {
    const run = m[0];
    if (run.length === 1) {
      out.push(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i += 1) out.push(run.slice(i, i + 2));
  }
  return out;
}

export function tf(tokens: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of tokens) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

export function cosine(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const v of a.values()) na += v * v;
  for (const v of b.values()) nb += v * v;
  if (na === 0 || nb === 0) return 0;
  const small = a.size <= b.size ? a : b;
  const large = small === a ? b : a;
  for (const [k, v] of small) {
    const w = large.get(k);
    if (w !== undefined) dot += v * w;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** 词频 top-N 作为条目 keywords（写入时补 2-gram） */
export function extractKeywords(text: string, limit = 10): string[] {
  const counts = tf(tokenize(text));
  return [...counts.entries()]
    .sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))
    .slice(0, limit)
    .map(([t]) => t);
}

/** 内置别名表（P2 词表归一化的零依赖兜底） */
export const DEFAULT_ALIAS_GROUPS: string[][] = [
  ["像素风", "像素", "16bit", "16-bit", "复古"],
  ["主人", "用户", "你"],
  ["鲸鱼娘", "小满", "本小姐"],
  ["遗忘", "归档", "删除"],
];

export function aliasCanon(token: string, groups: string[][] = DEFAULT_ALIAS_GROUPS): string {
  for (const g of groups) {
    if (g.includes(token)) return g[0];
  }
  return token;
}

/** 同义合并：同组词归一到组首词，检索一致（§9-P2） */
export function normalizeAliases(tokens: string[], groups: string[][] = DEFAULT_ALIAS_GROUPS): string[] {
  return tokens.map((t) => aliasCanon(t, groups));
}

/** 人格词表 → 身份组（P2：userName / 自称 / meta.lexicon） */
export function identityAliasGroups(p: {
  userName?: string;
  selfNamePro?: string;
  selfNameFlash?: string;
  selfNameByModel?: Record<string, string>;
  meta?: { lexicon?: Record<string, string> };
}): string[][] {
  const groups: string[][] = [];
  const lex = p.meta?.lexicon ?? {};

  // 称呼 / 自称可以一次填多个（如「老大、Boss」），每个都并进同一身份组
  const split = (v: unknown): string[] =>
    typeof v === "string" ? v.split(/[、，,／/|｜;；\n]+/).map((s) => s.trim()).filter(Boolean) : [];
  const userNames = split(p.userName);
  const userCanon = userNames[0] || (lex.user ?? "").trim() || "主人";
  const userTerms = [userCanon, ...userNames, lex.user ?? "", "主人", "用户", "你"].map((s) => s.trim()).filter(Boolean);
  groups.push([...new Set(userTerms)]);

  const selfRaw = [lex.self ?? "", p.selfNamePro ?? "", p.selfNameFlash ?? "", ...Object.values(p.selfNameByModel ?? {})]
    .flatMap((s) => split(s))
    .filter((s) => s.length > 0 && s !== "我");
  const selfCanon = selfRaw[0] ?? "";
  if (selfCanon) {
    const selfTerms = [selfCanon, "本鲸鱼娘", "我自己", ...selfRaw].map((s) => s.trim()).filter(Boolean);
    if (selfTerms.length >= 2) groups.push([...new Set(selfTerms)]);
  }

  return groups.filter((g) => g.length >= 2);
}

/** 关键词归一用全量组：身份组 + 内置别名组 */
export function personaAliasGroups(p: Parameters<typeof identityAliasGroups>[0]): string[][] {
  return [...identityAliasGroups(p), ...DEFAULT_ALIAS_GROUPS];
}

/** 合并多组同义词（附录 A recall.synonymsFile 等外部词表接入点）；首词为归一目标 */
export function mergeAliasGroups(...groupSets: Array<string[][] | undefined | null>): string[][] {
  const out: string[][] = [];
  for (const set of groupSets) {
    for (const g of set ?? []) {
      if (Array.isArray(g) && g.length >= 2 && typeof g[0] === "string" && g[0].length > 0) {
        out.push(g.map((s) => String(s)).filter((s) => s.length > 0));
      }
    }
  }
  return out;
}
