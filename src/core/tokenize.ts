/**
 * 分词（零依赖兜底）：拉丁词 + CJK 二元组 + 数字。
 * 不引词向量也能救一半的同义扩展。
 * 支持数字归一化（中文数字、阿拉伯数字、量词统一）
 */

const LATIN = /[a-z0-9]+(?:[-_][a-z0-9]+)*/g;
const CJK_RUN = /[一-龥々]+/g;

// 中文数字映射（简单版本：只处理单个字符）
const CN_DIGITS: Record<string, string> = {
  "零": "0", "〇": "0",
  "一": "1", "壹": "1",
  "二": "2", "贰": "2", "两": "2", "俩": "2",
  "三": "3", "叁": "3",
  "四": "4", "肆": "4",
  "五": "5", "伍": "5",
  "六": "6", "陆": "6",
  "七": "7", "柒": "7",
  "八": "8", "捌": "8",
  "九": "9", "玖": "9",
};

// 特殊数字词（保持整体）
const CN_NUMBER_WORDS: Record<string, string> = {
  "十": "10", "拾": "10",
  "百": "100", "佰": "100",
  "千": "1000", "仟": "1000",
  "万": "10000",
};

// 量词归一化（保留数字，去掉量词）
const MEASURE_WORDS = new Set([
  "个", "只", "条", "张", "块", "片", "本", "支", "根", "把",
  "台", "辆", "架", "座", "栋", "层", "楼", "间", "户", "套",
  "位", "名", "人", "口", "头", "匹", "尾", "斤", "两", "克",
  "米", "厘米", "公里", "升", "毫升", "元", "角", "分", "次",
  "遍", "趟", "回", "场", "局", "节", "幕", "章", "段", "句",
]);

/**
 * 数字归一化
 * 例子：
 * - "住四楼" / "住4楼" → "住", "4"
 * - "买了三个苹果" / "买了3个苹果" → "买了", "3", "苹果"
 * - "第二次" / "第2次" → "第", "2"
 */
function normalizeNumber(text: string): string {
  let normalized = text;
  
  // 先处理特殊数字词（十、百、千、万）
  for (const [cn, num] of Object.entries(CN_NUMBER_WORDS)) {
    normalized = normalized.replace(new RegExp(cn, "g"), num);
  }
  
  // 再替换单个中文数字为阿拉伯数字
  for (const [cn, num] of Object.entries(CN_DIGITS)) {
    normalized = normalized.replace(new RegExp(cn, "g"), num);
  }
  
  // 去掉量词（保留前面的数字）
  for (const measure of MEASURE_WORDS) {
    // 匹配：数字+量词，保留数字
    normalized = normalized.replace(new RegExp("(\\d+)" + measure, "g"), "$1");
  }
  
  return normalized;
}

export function tokenize(text: string): string[] {
  const out: string[] = [];
  const lower = text.toLowerCase();
  
  // 先做数字归一化
  const normalized = normalizeNumber(lower);
  
  for (const m of normalized.matchAll(LATIN)) out.push(m[0]);
  for (const m of normalized.matchAll(CJK_RUN)) {
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

/** 内置别名表（词表归一化的零依赖兜底） */
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

/** 同义合并：同组词归一到组首词，检索一致 */
export function normalizeAliases(tokens: string[], groups: string[][] = DEFAULT_ALIAS_GROUPS): string[] {
  return tokens.map((t) => aliasCanon(t, groups));
}

/** 人格词表 → 身份组（userName / 自称 / meta.lexicon） */
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
