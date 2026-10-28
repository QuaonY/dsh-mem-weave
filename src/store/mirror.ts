/**
 * 忆织 MemWeave —— Markdown 镜像（规划文档 §8.6）
 * <mirrorDir>/{persona,project,fact,lesson}.md 是只读派生视图：
 * 可 git 管理、可逆解析（行尾 <!-- id: xxx -->），冲突以 SQLite 为准，一键重建。
 * 硬上限守卫：单文件 ≤maxFileKb 且 ≤maxLines，超限拆 fact.2.md 而不是膨胀。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Level, MemoryEntry, PersonaConfig } from "../core/types";
import type { WeaveEnv } from "./db";
import { getPersona, listMemory } from "./dao";

export const MIRROR_KINDS = ["persona", "project", "fact", "lesson"] as const;
export type MirrorKind = (typeof MIRROR_KINDS)[number];

const KIND_LEVELS: Partial<Record<MirrorKind, Level>> = {
  project: "project",
  fact: "fact",
  lesson: "lesson",
};

export interface MirrorConfigLike {
  enabled: boolean;
  rebuildDebounceMs: number;
  maxFileKb: number;
  maxLines: number;
  dir?: string;
}

export interface MirrorLine {
  id: string;
  text: string;
}

export interface MirrorReport {
  ok: boolean;
  dir: string;
  files: string[];
  entries: number;
  bytes: number;
  changed: string[];
  removed: string[];
}

/** 行内容压成单行并截断（镜像是索引视图，全文在 SQLite） */
function oneLine(text: string, max = 500): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

export function renderLine(id: string, text: string): string {
  return "- " + oneLine(text) + " <!-- id: " + id + " -->";
}

const LINE_RE = /^- (.*?) <!-- id: ([^\s]+) -->$/;

/** 逆解析：id + 行文本；坏行忽略 */
export function parseMirrorFile(content: string): MirrorLine[] {
  const out: MirrorLine[] = [];
  for (const raw of content.split("\n")) {
    const m = LINE_RE.exec(raw.trimEnd());
    if (m) out.push({ id: m[2], text: m[1] });
  }
  return out;
}

/** persona 镜像行 ↔ 配置键（文本形如 key: <json>） */
export function renderPersonaLines(cfg: PersonaConfig): MirrorLine[] {
  const out: MirrorLine[] = [];
  for (const key of Object.keys(cfg).sort()) {
    const v = (cfg as Record<string, unknown>)[key];
    out.push({ id: "persona." + key, text: key + ": " + JSON.stringify(v ?? null) });
  }
  return out;
}

export function parsePersonaLines(lines: MirrorLine[]): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const l of lines) {
    if (!l.id.startsWith("persona.")) continue;
    const idx = l.text.indexOf(": ");
    if (idx <= 0) continue;
    try {
      patch[l.text.slice(0, idx)] = JSON.parse(l.text.slice(idx + 2));
    } catch {
      // 值不是 JSON：跳过（SQLite 为准）
    }
  }
  return patch;
}

function memoryLines(entries: MemoryEntry[]): MirrorLine[] {
  return [...entries]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((e) => ({
      id: e.id,
      text: (e.status !== "active" ? "[" + e.status + "] " : "") + e.content,
    }));
}

/** 单文件上限拆分：≤capBytes 且 ≤capLines，超出开 fact.2.md */
export function splitFiles(header: string, lines: MirrorLine[], capBytes: number, capLines: number): string[] {
  const files: string[] = [];
  let buf: string[] = [];
  let bytes = header.length;
  const flush = (): void => {
    if (buf.length === 0) return;
    files.push([header, ...buf].join("\n") + "\n");
    buf = [];
    bytes = header.length;
  };
  for (const l of lines) {
    const row = renderLine(l.id, l.text);
    if (buf.length >= capLines || (buf.length > 0 && bytes + row.length + 1 > capBytes)) flush();
    buf.push(row);
    bytes += row.length + 1;
  }
  flush();
  return files;
}

const kindFileRe = (kind: string): RegExp => new RegExp("^" + kind + "(\\.[0-9]+)?\\.md$");

function header(kind: MirrorKind): string {
  return (
    "# 忆织镜像 · " +
    kind +
    "\n\n<!-- 只读派生视图：SQLite 为准，可整目录 git 管理；每行尾部 id 标记可逆解析。手动修改会在下次重建时被覆盖。 -->\n"
  );
}

function collectLines(env: WeaveEnv, kind: MirrorKind): MirrorLine[] {
  if (kind === "persona") return renderPersonaLines(getPersona(env).config);
  const level = KIND_LEVELS[kind] as Level;
  return memoryLines(listMemory(env, { level }).filter((e) => e.status !== "archived"));
}

/** 一键重建：整目录按 SQLite 重写（内容没变的文件不动，减少 git 噪音） */
export function rebuildMirror(env: WeaveEnv, cfg: MirrorConfigLike): MirrorReport {
  const dir = cfg.dir ?? join(process.cwd(), "mirror");
  const report: MirrorReport = { ok: true, dir, files: [], entries: 0, bytes: 0, changed: [], removed: [] };
  if (cfg.enabled !== true) return report;
  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    return { ...report, ok: false };
  }
  const capBytes = Math.max(2048, cfg.maxFileKb * 1024);
  const capLines = Math.max(20, cfg.maxLines);

  for (const kind of MIRROR_KINDS) {
    const lines = collectLines(env, kind);
    const parts = splitFiles(header(kind), lines, capBytes, capLines);
    const names = parts.map((_, i) => (i === 0 ? kind + ".md" : kind + "." + (i + 1) + ".md"));
    report.entries += lines.length;

    for (let i = 0; i < parts.length; i += 1) {
      const path = join(dir, names[i]);
      report.files.push(names[i]);
      report.bytes += parts[i].length;
      let prev: string | null = null;
      try {
        prev = existsSync(path) ? readFileSync(path, "utf8") : null;
      } catch {
        prev = null;
      }
      if (prev !== parts[i]) {
        try {
          writeFileSync(path, parts[i], "utf8");
          report.changed.push(names[i]);
        } catch {
          report.ok = false;
        }
      }
    }
    // 超限拆分收缩后，清掉多余的 kind.N.md
    try {
      for (const n of readdirSync(dir)) {
        if (!kindFileRe(kind).test(n)) continue;
        if (names.includes(n)) continue;
        rmSync(join(dir, n), { force: true });
        report.removed.push(n);
      }
    } catch {
      // 目录读失败：不阻塞
    }
  }
  return report;
}

/** 清空镜像目录里的派生文件（D15 彻底重置步骤之一；备份/日志不动） */
export function clearMirror(cfg: MirrorConfigLike): string[] {
  const dir = cfg.dir ?? join(process.cwd(), "mirror");
  const removed: string[] = [];
  if (!existsSync(dir)) return removed;
  try {
    for (const n of readdirSync(dir)) {
      if (!MIRROR_KINDS.some((k) => kindFileRe(k).test(n))) continue;
      rmSync(join(dir, n), { force: true });
      removed.push(n);
    }
  } catch {
    // 清理失败不阻塞
  }
  return removed;
}

/** 读回镜像（逆解析入口，UI 冲突对比用） */
export function readMirrorLines(cfg: MirrorConfigLike, kind: MirrorKind): MirrorLine[] {
  const dir = cfg.dir ?? join(process.cwd(), "mirror");
  const out: MirrorLine[] = [];
  for (let i = 1; i <= 50; i += 1) {
    const name = i === 1 ? kind + ".md" : kind + "." + i + ".md";
    const path = join(dir, name);
    if (!existsSync(path)) break;
    try {
      out.push(...parseMirrorFile(readFileSync(path, "utf8")));
    } catch {
      break;
    }
  }
  return out;
}
