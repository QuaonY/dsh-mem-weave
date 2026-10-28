import { createHash } from "node:crypto";

/** 归一化后取 sha1，用于精确去重（§8.3） */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[「」『』【】\[\]（）(){}"'`~!@#$%^&*_+=\\|;:,.<>/?\s]/g, "")
    .trim();
}

export function sha1(text: string): string {
  return createHash("sha1").update(text, "utf8").digest("hex");
}

/** 归一化内容 hash —— 记忆精确去重键 */
export function contentHash(text: string): string {
  return sha1(normalizeText(text));
}

/** 渲染结果 hash 的拼接分隔符（ASCII 32） */
const RENDER_SEP = String.fromCharCode(32);

/** 渲染结果 hash —— 预览与注入一致性断言（U4） */
export function renderHash(parts: string[]): string {
  return sha1(parts.join(RENDER_SEP));
}
