/**
 * 忆织 MemWeave —— Markdown 预设卡解析
 *
 * 把一份 Markdown 人设文档转成 memweave-preset/1 结构，之后与 JSON 预设卡走同一条导入路径。
 *
 * 支持的写法（都可选）：
 *   ---                      ← 可选的 front matter（简单 key: value）
 *   id: night-owl
 *   name: 夜猫子
 *   ---
 *   # 夜猫子                  ← 一级标题当作名称（front matter 没写 name 时）
 *   ## 自称 / 用户称呼 / 立场 / 人格描述 / 契约 / 附加提示词   ← 二级标题对应字段
 *
 * 契约分节里的每个列表项（- / * / 1.）是一条契约；认不出的分节并入人格描述，不丢内容。
 * 一个可识别的分节都没有时，整篇正文作为人格描述。
 */

export interface MarkdownPreset {
  spec: "memweave-preset/1";
  id?: string;
  label?: string;
  payload: Record<string, unknown>;
}

type Field = "selfName" | "selfNamePro" | "selfNameFlash" | "userName" | "stance" | "character" | "contracts" | "suffix";

/** 分节标题 → 字段（小写、去空格后匹配） */
const HEADINGS: Array<[Field, string[]]> = [
  ["selfNamePro", ["深度对话自称", "pro自称", "selfnamepro"]],
  ["selfNameFlash", ["闪聊自称", "flash自称", "selfnameflash"]],
  ["selfName", ["自称", "名字", "名称", "称呼自己", "name", "selfname"]],
  ["userName", ["用户称呼", "对用户的称呼", "称呼用户", "username"]],
  ["stance", ["立场", "立场设定", "身份", "关系", "stance", "personality", "性格"]],
  ["character", ["人格描述", "人格", "人设", "描述", "角色描述", "简介", "character", "description", "persona"]],
  ["contracts", ["契约", "规则", "约定", "守则", "红线", "contracts", "rules"]],
  ["suffix", ["附加提示词", "附加说明", "补充", "后缀", "suffix", "instructions", "post_history_instructions"]],
];

function fieldOf(heading: string): Field | null {
  const key = heading.toLowerCase().replace(/[\s:：（）()]/g, "");
  for (const [field, names] of HEADINGS) if (names.some((n) => key === n)) return field;
  return null;
}

/** 看起来像 Markdown 预设卡（而不是 JSON）吗 */
export function looksLikeMarkdown(text: string): boolean {
  const s = text.trimStart();
  if (s.startsWith("{") || s.startsWith("[")) return false;
  return s.length > 0;
}

export function parseMarkdownPreset(text: string): MarkdownPreset | { error: string } {
  let body = text.replace(/\r\n?/g, "\n");
  const meta: Record<string, string> = {};

  // front matter
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(body);
  if (fm) {
    for (const line of fm[1].split("\n")) {
      const m = /^\s*([A-Za-z_][\w-]*)\s*:\s*(.*?)\s*$/.exec(line);
      if (m) meta[m[1].toLowerCase()] = m[2].replace(/^["']|["']$/g, "");
    }
    body = body.slice(fm[0].length);
  }

  let title = "";
  const sections: Array<{ field: Field | null; heading: string; lines: string[] }> = [];
  let cur: { field: Field | null; heading: string; lines: string[] } = { field: null, heading: "", lines: [] };
  for (const line of body.split("\n")) {
    const h1 = /^#\s+(.+?)\s*#*\s*$/.exec(line);
    if (h1 && !title && sections.length === 0 && cur.lines.every((l) => !l.trim())) {
      title = h1[1].trim();
      continue;
    }
    const h = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      sections.push(cur);
      cur = { field: fieldOf(h[1]), heading: h[1].trim(), lines: [] };
      continue;
    }
    cur.lines.push(line);
  }
  sections.push(cur);

  const textOf = (lines: string[]): string => lines.join("\n").replace(/^\n+|\n+$/g, "").trim();
  const payload: Record<string, unknown> = { enabled: true };
  const extra: string[] = [];
  const contracts: Array<{ id: string; text: string; on: boolean }> = [];
  let recognized = 0;

  for (const s of sections) {
    const content = textOf(s.lines);
    if (!content) continue;
    if (s.field === null) {
      // 开头没有标题的引言，或认不出的分节：并入人格描述
      extra.push(s.heading ? "## " + s.heading + "\n" + content : content);
      continue;
    }
    recognized += 1;
    if (s.field === "contracts") {
      const items = s.lines
        .map((l) => /^\s*(?:[-*+]|\d+[.)、])\s+(.+)$/.exec(l)?.[1]?.trim() ?? "")
        .filter((l) => l.length > 0);
      const list = items.length > 0 ? items : content.split("\n").map((l) => l.trim()).filter(Boolean);
      for (const item of list) contracts.push({ id: "c" + String(contracts.length + 1), text: item.slice(0, 300), on: true });
      continue;
    }
    const oneLine = content.split("\n")[0].trim();
    if (s.field === "selfName") {
      payload.selfNamePro ??= oneLine;
      payload.selfNameFlash ??= oneLine;
    } else if (s.field === "selfNamePro" || s.field === "selfNameFlash" || s.field === "userName") {
      payload[s.field] = oneLine;
    } else if (s.field === "character") {
      payload.character = payload.character ? String(payload.character) + "\n\n" + content : content;
    } else {
      payload[s.field] = content;
    }
  }

  if (extra.length > 0) {
    const joined = extra.join("\n\n");
    payload.character = payload.character ? String(payload.character) + "\n\n" + joined : joined;
  }
  if (contracts.length > 0) payload.contracts = contracts;

  const name = meta.name || meta.label || title;
  if (name) {
    payload.selfNamePro ??= name;
    payload.selfNameFlash ??= name;
  }
  if (recognized === 0 && !payload.character && !name) return { error: "Markdown 里没有可导入的内容" };

  return {
    spec: "memweave-preset/1",
    ...(meta.id ? { id: meta.id } : {}),
    ...(name ? { label: name } : {}),
    payload,
  };
}
