/**
 * 忆织 MemWeave —— 敏感内容规则（写入治理与设置页共用同一份实现）
 * 内置规则 + 用户自定义正则；命中即拒绝写入（E_SENSITIVE）。
 * 凭据类内置规则（api-key / token / private-key / password）锁定不可关闭。
 */

export interface BuiltinRule {
  id: string;
  label: { zh: string; en: string };
  /** 锁定：不允许用户关闭 */
  locked: boolean;
  re: RegExp;
}

export const BUILTIN_RULES: BuiltinRule[] = [
  {
    id: "api-key",
    label: { zh: "API Key / 密钥", en: "API key / secret key" },
    locked: true,
    // 字面写法 + 常见密钥格式：sk-（OpenAI/DeepSeek 等）、GitHub ghp_/github_pat_、AWS AKIA、Google AIza、Slack xox?-、JWT，
    // 以及「key/secret: 长串」这种键值写法
    re: new RegExp(
      [
        "api[_\\-\\s]?key",
        "密钥|秘钥",
        "\\bsk-(?:proj-|ant-)?[A-Za-z0-9_\\-]{16,}",
        "\\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\\bgithub_pat_[A-Za-z0-9_]{20,}",
        "\\bAKIA[0-9A-Z]{16}\\b",
        "\\bAIza[0-9A-Za-z_\\-]{30,}",
        "\\bxox[abprs]-[A-Za-z0-9\\-]{10,}",
        "\\beyJ[A-Za-z0-9_\\-]{10,}\\.[A-Za-z0-9_\\-]{10,}\\.[A-Za-z0-9_\\-]{5,}",
        "\\b(?:secret|key|ak|sk)\\s*[:=：]\\s*['\"]?[A-Za-z0-9_\\-]{16,}",
      ].join("|"),
      "i",
    ),
  },
  { id: "token", label: { zh: "访问令牌 / Bearer Token", en: "Access token / bearer" }, locked: true, re: /token\s*[:=：]|\bbearer\s+[a-z0-9._-]{10,}|访问令牌|秘钥对/i },
  { id: "private-key", label: { zh: "私钥", en: "Private key" }, locked: true, re: /私钥|private[_\-\s]?key|BEGIN [A-Z ]*PRIVATE KEY/i },
  { id: "password", label: { zh: "密码", en: "Password" }, locked: true, re: /密码|passwd|password\s*[:=：]/i },
  { id: "id-card", label: { zh: "身份证号", en: "ID card number" }, locked: false, re: /身份证|id[_\-\s]?card|\b\d{17}[\dXx]\b/i },
  { id: "bank-card", label: { zh: "银行卡号", en: "Bank card number" }, locked: false, re: /银行卡|bank[_\-\s]?card|\b\d{16,19}\b/ },
  { id: "phone", label: { zh: "手机号", en: "Phone number" }, locked: false, re: /手机号|phone\s*[:=：]|(?<!\d)1[3-9]\d{9}(?!\d)/ },
];

/** 自定义规则上限（数量 / 单条长度），防止误配置拖慢每次写入 */
export const CUSTOM_RULE_MAX = 50;
export const CUSTOM_RULE_LEN_MAX = 200;

export type PatternCheck = { ok: true } | { ok: false; reason: "empty" | "too-long" | "invalid" };

/** 自定义规则按忽略大小写的正则编译 */
export function compileCustom(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, "i");
  } catch {
    return null;
  }
}

export function checkCustomPattern(pattern: string): PatternCheck {
  const p = pattern.trim();
  if (p.length === 0) return { ok: false, reason: "empty" };
  if (p.length > CUSTOM_RULE_LEN_MAX) return { ok: false, reason: "too-long" };
  if (!compileCustom(p)) return { ok: false, reason: "invalid" };
  return { ok: true };
}

/** 清洗设置里的自定义规则：去空、去重、去坏正则、限量 */
export function sanitizeCustomPatterns(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const raw of list) {
    if (typeof raw !== "string") continue;
    const p = raw.trim();
    if (p === "default" || out.includes(p) || !checkCustomPattern(p).ok) continue;
    out.push(p);
    if (out.length >= CUSTOM_RULE_MAX) break;
  }
  return out;
}

/** 只保留真实存在且未锁定的内置规则 id */
export function sanitizeDisabledBuiltins(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const allowed = new Set(BUILTIN_RULES.filter((r) => !r.locked).map((r) => r.id));
  return [...new Set(list.filter((x): x is string => typeof x === "string" && allowed.has(x)))];
}

/**
 * 扫描文本；返回命中的规则（内置返回 id，自定义返回 "custom:<pattern>"），未命中返回 null。
 * disabled 里的内置规则跳过（锁定规则不受影响）。
 */
export function matchSensitive(text: string, custom?: string[], disabled?: string[]): string | null {
  const off = new Set(disabled ?? []);
  for (const rule of BUILTIN_RULES) {
    if (!rule.locked && off.has(rule.id)) continue;
    if (rule.re.test(text)) return rule.id;
  }
  for (const p of custom ?? []) {
    if (typeof p !== "string" || p.length === 0 || p === "default") continue;
    const re = compileCustom(p);
    if (re && re.test(text)) return "custom:" + p;
  }
  return null;
}
