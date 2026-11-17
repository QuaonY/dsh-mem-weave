/**
 * 敏感条目的字段级脱敏（替代整条过滤）。
 * a24 之后，局域网地址不再被当成 PII；但只要条目里还有一处公网 IP
 * 手机号 / 邮箱，旧行为就会把整条记忆从召回结果里删掉。信息没泄漏，但也没用上。
 * 现在默认改为「把敏感值替换成掩码，其余内容照常召回」，并保留
 * `privacy.recallPolicy = "filter"` 让需要严格过滤的部署切回旧行为。
 * 掩码规则是确定性的（不含随机数），这样同一段内容在日志、快照与测试里一致。
 */

import type { MemoryEntry } from "../core/types";
import type { SensitivityDetector } from "./detector";
import type { PrivacyConfig, SensitiveInfo, SensitiveType } from "./types";

/** 保留首尾若干位，中间同长度替换为 `*` */
function maskKeep(value: string, head: number, tail: number): string {
  if (value.length <= head + tail) return "***";
  return value.slice(0, head) + "*".repeat(value.length - head - tail) + value.slice(value.length - tail);
}

/**
 * 单个敏感值的掩码：
 * | 类型 | 示例输入 | 掩码结果 |
 * | --- | --- | --- |
 * | phone | `13800138000` | `138****8000` |
 * | email | `alice@example.com` | `a***@example.com` |
 * | id_card | `110101199001011234` | `11**************34` |
 * | credit_card | `4111 1111 1111 1111` | `**** **** **** 1111` |
 * | password | `token=abc123` | `token=***` |
 * | ip_address | `8.8.8.8` | `8.8.*.*` |
 * | address | `西湖区文三路 100 号` | `[地址已脱敏]` |
 */
export function maskSensitiveValue(type: SensitiveType, value: string): string {
  switch (type) {
    case "phone":
      return maskKeep(value, 3, 4);
    case "email": {
      const at = value.lastIndexOf("@");
      if (at <= 0) return "***";
      return value.slice(0, 1) + "***@" + value.slice(at + 1);
    }
    case "id_card":
      return maskKeep(value, 2, 2);
    case "credit_card": {
      const digits = value.replace(/\D/g, "");
      return digits.length > 4 ? "**** **** **** " + digits.slice(-4) : "***";
    }
    case "password": {
      // 保留 `password=` / `token:` 这类键名，只抹掉值
      const sep = value.search(/[=:]/);
      return sep < 0 ? "***" : value.slice(0, sep + 1) + "***";
    }
    case "ip_address": {
      const parts = value.split(".");
      return parts.length === 4 ? parts[0] + "." + parts[1] + ".*.*" : "***";
    }
    case "address":
      return "[地址已脱敏]";
    default:
      return "***";
  }
}

/**
 * 选择互不重叠的命中区间。
 * 身份证号里可能同时命中手机号、信用卡里可能同时命中手机号：按「更长的优先」
 * 选，长度相同取靠前的，避免把一条 18 位号码切成两段掩码、留下半截明文。
 */
export function selectSpans(infos: SensitiveInfo[]): SensitiveInfo[] {
  const sorted = [...infos]
    .filter((i) => Number.isInteger(i.start) && Number.isInteger(i.end) && i.start >= 0 && i.end > i.start)
    .sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start);
  const picked: SensitiveInfo[] = [];
  for (const info of sorted) {
    if (picked.some((p) => info.start < p.end && info.end > p.start)) continue;
    picked.push(info);
  }
  return picked.sort((a, b) => a.start - b.start);
}

/** 按命中区间替换；区间来自同一段原文 */
export function applyRedactions(text: string, infos: SensitiveInfo[]): string {
  const picked = selectSpans(infos);
  if (picked.length === 0) return text;
  let out = "";
  let cursor = 0;
  for (const info of picked) {
    out += text.slice(cursor, info.start);
    out += maskSensitiveValue(info.type, info.value);
    cursor = info.end;
  }
  return out + text.slice(cursor);
}

/** 检测 + 脱敏一段文本；检测器缺席或隐私关闭时原样返回 */
export function redactText(
  text: string,
  detector: SensitivityDetector | null | undefined,
  config: PrivacyConfig | undefined,
): string {
  if (!detector || !config?.enabled || !config.detectPII || text.length === 0) return text;
  return applyRedactions(text, detector.detect(text, config));
}

/**
 * 条目级脱敏：内容、关键词、检索词与证据引用都过一遍。
 * 返回新对象而不是就地改：`recall` 的 entry 可能仍被调用方持有
 * 原地改会把「仅注入时脱敏」变成「改掉内存里的记忆」。
 * 无变化时返回原对象，调用方可据此判断是否发生了脱敏。
 */
export function redactMemoryEntry(
  entry: MemoryEntry,
  detector: SensitivityDetector | null | undefined,
  config: PrivacyConfig | undefined,
): MemoryEntry {
  const content = redactText(entry.content, detector, config);
  const keywords = entry.keywords.map((k) => redactText(k, detector, config));
  const searchTerms = entry.searchTerms ? entry.searchTerms.map((t) => redactText(t, detector, config)) : entry.searchTerms;
  const evidence = entry.evidence.map((ev) => {
    const quote = redactText(ev.quote, detector, config);
    return quote === ev.quote ? ev : { ...ev, quote };
  });

  const changed =
    content !== entry.content ||
    keywords.some((k, i) => k !== entry.keywords[i]) ||
    (searchTerms ?? []).some((t, i) => t !== (entry.searchTerms ?? [])[i]) ||
    evidence.some((ev, i) => ev !== entry.evidence[i]);
  if (!changed) return entry;
  return { ...entry, content, keywords, searchTerms, evidence };
}
