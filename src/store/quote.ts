/**
 * 忆织 MemWeave —— 会话原文旁路（规划文档 §8.5）
 * 数据源：$DSH_HOME/sessions/<ws>/<sid>/session*.jsonl.zst(d)，一律只读。
 * 宿主写的是多帧 zstd 拼接流，标准解压只出首帧，这里逐帧解出全部 jsonl。
 * 红线：不改写会话日志；zstd 不可用时 quote.enabled 强制关闭；索引只进 session_fts。
 */

import { createRequire } from "node:module";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { WeaveEnv } from "./db";

const nodeRequire = createRequire(import.meta.url);

interface ZstdApi {
  zstdDecompressSync?: (buf: Uint8Array) => Uint8Array;
}

type ZstdFn = (buf: Uint8Array) => Uint8Array;

let zstdFn: ZstdFn | null | undefined;

/** zstd 运行时探测：zlib.zstdDecompressSync 是否存在（探测一次缓存） */
export function zstdAvailable(): boolean {
  if (zstdFn === undefined) {
    try {
      const zlib = nodeRequire("node:zlib") as ZstdApi;
      zstdFn = typeof zlib.zstdDecompressSync === "function" ? (zlib.zstdDecompressSync as ZstdFn) : null;
    } catch {
      zstdFn = null;
    }
  }
  return zstdFn !== null;
}

/** 仅测试用：覆写探测结果（null = 不可用） */
export function setZstdProbeForTest(fn: ZstdFn | null | undefined): void {
  zstdFn = fn;
}

// ---------- 多帧 zstd 解压 ----------

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/**
 * 解压「多帧 zstd 拼接」文件内容：按帧魔数切分，逐帧独立解压拼接。
 * 单帧解压失败跳过该帧，不整体失败（宿主正写入的尾帧可能不完整）。
 */
export function decodeZstdConcat(buf: Buffer, maxBytes = 8 * 1024 * 1024): string {
  if (!zstdAvailable()) return "";
  const fn = zstdFn as ZstdFn;
  const offsets: number[] = [];
  let i = buf.indexOf(ZSTD_MAGIC);
  while (i !== -1 && offsets.length < 20000) {
    offsets.push(i);
    i = buf.indexOf(ZSTD_MAGIC, i + 4);
  }
  if (offsets.length === 0) {
    try {
      return Buffer.from(fn(buf)).toString("utf8").slice(0, maxBytes);
    } catch {
      return "";
    }
  }
  const parts: string[] = [];
  let size = 0;
  for (const off of offsets) {
    if (size >= maxBytes) break;
    try {
      const out = Buffer.from(fn(buf.subarray(off))).toString("utf8");
      parts.push(out);
      size += out.length;
    } catch {
      // 尾帧未写完 / 假魔数命中：跳过
    }
  }
  return parts.join("").slice(0, maxBytes);
}

// ---------- jsonl 行解析 ----------

export interface SessionRow {
  seq: number;
  role: string;
  text: string;
}

/** 每行文本上限：原文旁路只做定位引用，不搬全文 */
const ROW_TEXT_MAX = 2000;

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && (block as Record<string, unknown>).type === "text") {
      const t = (block as Record<string, unknown>).text;
      if (typeof t === "string" && t.length > 0) parts.push(t);
    }
  }
  return parts.join("\n");
}

/**
 * 从会话 jsonl 文本提取可索引行：只收 user/assistant 正文。
 * system / tool 结果 / 事件行不入索引（防灌入噪音，§8.5 不自动全量灌入）。
 */
export function extractSessionRows(jsonl: string): SessionRow[] {
  const rows: SessionRow[] = [];
  const lines = jsonl.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line.length === 0) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = String(obj.type ?? "");
    let role = "";
    let text = "";
    if (type === "user/message") {
      role = "user";
      const data = (obj.data ?? {}) as Record<string, unknown>;
      text = textOf(data.content);
    } else if (type === "assistant/message") {
      role = "assistant";
      const data = (obj.data ?? {}) as Record<string, unknown>;
      const msg = (data.message ?? {}) as Record<string, unknown>;
      text = textOf(msg.content);
    } else {
      continue;
    }
    text = text.trim().slice(0, ROW_TEXT_MAX);
    if (text.length === 0) continue;
    const seq = typeof obj.seq === "number" ? obj.seq : i;
    rows.push({ seq, role, text });
  }
  return rows;
}

// ---------- 增量索引（session_fts + session_files） ----------

export interface QuoteSyncReport {
  available: boolean;
  files: number;
  indexed: number;
  skipped: number;
  pruned: number;
  rows: number;
}

const SESSION_FILE_RE = /^session[^/\\]*\.jsonl\.zst(d)?$/i;
const DAY_MS = 86400000;

function listSessionFiles(sessionsDir: string): Array<{ ws: string; sid: string; path: string; mtime: number; size: number }> {
  const out: Array<{ ws: string; sid: string; path: string; mtime: number; size: number }> = [];
  let workspaces: string[];
  try {
    workspaces = readdirSync(sessionsDir);
  } catch {
    return out;
  }
  for (const ws of workspaces) {
    let sids: string[];
    try {
      sids = readdirSync(join(sessionsDir, ws));
    } catch {
      continue;
    }
    for (const sid of sids) {
      const dir = join(sessionsDir, ws, sid);
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!SESSION_FILE_RE.test(name)) continue;
        const path = join(dir, name);
        try {
          const st = statSync(path);
          if (!st.isFile()) continue;
          // 窗口外的文件也返回：已索引的走 prune 分支出清，未索引的直接忽略
          out.push({ ws, sid, path, mtime: st.mtimeMs, size: st.size });
        } catch {
          // 文件消失等竞态：跳过
        }
      }
    }
  }
  return out;
}

/**
 * 按文件 mtime 增量同步 session_fts（§8.5）。
 * mtime+size 未变 → 跳过；超出窗口 → 删行出索引；其余 → 重解重索（单文件全量替换）。
 */
export async function syncSessionIndex(
  env: WeaveEnv,
  opts: { sessionsDir: string; indexDays?: number; now?: number },
): Promise<QuoteSyncReport> {
  const report: QuoteSyncReport = { available: zstdAvailable(), files: 0, indexed: 0, skipped: 0, pruned: 0, rows: 0 };
  if (!report.available || env.readonly) return report;

  const now = opts.now ?? Date.now();
  const cutoff = now - (opts.indexDays ?? 90) * DAY_MS;
  const files = listSessionFiles(opts.sessionsDir);
  report.files = files.length;

  for (const f of files) {
    const tracked = env.db.prepare("SELECT mtime, size FROM session_files WHERE path = ?").get(f.path) as
      | { mtime?: number; size?: number }
      | undefined;

    if (f.mtime < cutoff) {
      if (tracked) {
        await env.withWrite(() => {
          env.db.prepare("DELETE FROM session_fts WHERE session_id = ?").run(f.sid);
          env.db.prepare("DELETE FROM session_files WHERE path = ?").run(f.path);
        });
        report.pruned += 1;
      }
      continue;
    }
    if (tracked && tracked.mtime === f.mtime && tracked.size === f.size) {
      report.skipped += 1;
      continue;
    }

    let jsonl = "";
    try {
      jsonl = decodeZstdConcat(readFileSync(f.path));
    } catch {
      continue;
    }
    const rows = extractSessionRows(jsonl);
    // 头行里的 session id 优先，目录名兜底
    let sid = f.sid;
    const head = jsonl.split("\n", 1)[0] ?? "";
    try {
      const h = JSON.parse(head) as Record<string, unknown>;
      if (h && typeof h.id === "string" && h.id.length > 0) sid = h.id;
    } catch {
      // 无头行：用目录名
    }

    await env.withWrite(() => {
      env.db.prepare("DELETE FROM session_fts WHERE session_id = ?").run(sid);
      const ins = env.db.prepare(
        "INSERT INTO session_fts (workspace, session_id, seq, role, text) VALUES (?, ?, ?, ?, ?)",
      );
      for (const r of rows) ins.run(f.ws, sid, r.seq, r.role, r.text);
      env.db
        .prepare(
          "INSERT INTO session_files (path, workspace, session_id, mtime, size, rows, indexed_at)" +
            " VALUES (?, ?, ?, ?, ?, ?, ?)" +
            " ON CONFLICT(path) DO UPDATE SET mtime = excluded.mtime, size = excluded.size," +
            " rows = excluded.rows, session_id = excluded.session_id, indexed_at = excluded.indexed_at",
        )
        .run(f.path, f.ws, sid, f.mtime, f.size, rows.length, Date.now());
    });
    report.indexed += 1;
    report.rows += rows.length;
  }
  return report;
}

// ---------- 查询 ----------

export interface QuoteHit {
  sessionId: string;
  seq: number;
  text: string;
}

const WORD_RE = /[\p{L}\p{N}_]+/gu;

function termsOf(query: string): string[] {
  const m = query.match(WORD_RE);
  return m ? [...new Set(m)].slice(0, 8) : [];
}

/**
 * FTS 前缀查 + LIKE 子串兜底（unicode61 对中文整段切一词，"价格" 这类后缀词只能靠 LIKE）。
 * 参数全部走绑定，天然免注入。
 */
export function queryQuotes(env: WeaveEnv, query: string, limit = 3): QuoteHit[] {
  const terms = termsOf(query);
  if (terms.length === 0) return [];
  const toHit = (r: Record<string, unknown>): QuoteHit => ({
    sessionId: String(r.session_id ?? ""),
    seq: Number(r.seq ?? 0),
    text: String(r.text ?? ""),
  });

  try {
    const expr = terms.map((t) => " \"" + t + "\"*").join(" OR");
    const rows = env.db
      .prepare("SELECT session_id, seq, text FROM session_fts WHERE session_fts MATCH ? ORDER BY seq LIMIT " + limit)
      .all(expr.trim()) as Array<Record<string, unknown>>;
    if (rows.length > 0) return rows.map(toHit);
  } catch {
    // 表不存在 / 表达式问题：落 LIKE 兜底
  }

  const likes = terms.filter((t) => t.length >= 2).slice(0, 4);
  if (likes.length === 0) return [];
  const where = likes.map(() => "text LIKE ?").join(" OR ");
  try {
    const rows = env.db
      .prepare("SELECT session_id, seq, text FROM session_fts WHERE " + where + " LIMIT " + limit)
      .all(...likes.map((t) => "%" + t + "%")) as Array<Record<string, unknown>>;
    return rows.map(toHit);
  } catch {
    return [];
  }
}
