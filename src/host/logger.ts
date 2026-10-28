/**
 * roadmap v0.3 G8（原规划 §10.3）：文件日志。
 * - 位置：log.dir，留空为 <dataDir>/logs；文件名 memweave-YYYYMMDD.log，超过 maxFileMb 时同日开 -1、-2…
 * - 保留 keepDays 天：启动时与每天第一次写入时清理；
 * - 不记记忆正文：参数里 content / text / quote / body 一律只记长度；
 * - 任何失败都吞掉（I8：日志绝不阻塞会话）。
 */
import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const REDACT_KEYS = new Set(["content", "text", "quote", "body", "after", "before"]);

export interface FileLoggerOptions {
  dir: string;
  level?: LogLevel;
  maxFileMb?: number;
  keepDays?: number;
  now?: () => number;
}

const pad = (n: number): string => String(n).padStart(2, "0");
export function dayStamp(ts: number): string {
  const d = new Date(ts);
  return "" + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate());
}

function fmtValue(key: string, v: unknown): string {
  if (REDACT_KEYS.has(key)) {
    const len = typeof v === "string" ? v.length : JSON.stringify(v ?? "").length;
    return "<" + len + " chars>";
  }
  if (typeof v === "string") return /[\s"=]/.test(v) ? JSON.stringify(v.slice(0, 200)) : v.slice(0, 200);
  if (typeof v === "number" || typeof v === "boolean" || v === null || v === undefined) return String(v);
  try {
    return JSON.stringify(v).slice(0, 200);
  } catch {
    return "[unserializable]";
  }
}

export class FileLogger {
  readonly dir: string;
  level: LogLevel;
  maxBytes: number;
  keepDays: number;
  private now: () => number;
  private lastDay = "";
  private part = 0;

  constructor(opts: FileLoggerOptions) {
    this.dir = opts.dir;
    this.level = opts.level ?? "info";
    this.maxBytes = Math.max(0.01, opts.maxFileMb ?? 5) * 1024 * 1024;
    this.keepDays = Math.max(1, opts.keepDays ?? 7);
    this.now = opts.now ?? Date.now;
    this.prune();
  }

  /** 当前应写入的文件（必要时按大小切分） */
  currentFile(): string {
    const day = dayStamp(this.now());
    if (day !== this.lastDay) {
      this.lastDay = day;
      this.part = this.highestPart(day);
      this.prune();
    }
    for (;;) {
      const f = join(this.dir, "memweave-" + day + (this.part > 0 ? "-" + this.part : "") + ".log");
      let size = 0;
      try {
        size = statSync(f).size;
      } catch {
        size = 0;
      }
      if (size < this.maxBytes) return f;
      this.part += 1;
    }
  }

  private highestPart(day: string): number {
    let max = 0;
    try {
      for (const n of readdirSync(this.dir)) {
        const m = new RegExp("^memweave-" + day + "-(\\d+)\\.log$").exec(n);
        if (m) max = Math.max(max, Number(m[1]));
      }
    } catch {
      // 目录不存在
    }
    return max;
  }

  /** 删除 keepDays 天前的日志文件，返回删除数 */
  prune(): number {
    let removed = 0;
    try {
      const cutoff = dayStamp(this.now() - this.keepDays * 86400000);
      for (const n of readdirSync(this.dir)) {
        const m = /^memweave-(\d{8})(?:-\d+)?\.log$/.exec(n);
        if (m && m[1] < cutoff) {
          try {
            unlinkSync(join(this.dir, n));
            removed += 1;
          } catch {
            // 被占用就下次再删
          }
        }
      }
    } catch {
      // 目录不存在
    }
    return removed;
  }

  log(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
    if (ORDER[level] < ORDER[this.level]) return;
    try {
      mkdirSync(this.dir, { recursive: true });
      const kv = fields
        ? Object.entries(fields)
            .map(([k, v]) => " " + k + "=" + fmtValue(k, v))
            .join("")
        : "";
      const line = new Date(this.now()).toISOString() + " [memweave][" + level + "] " + msg.replace(/[\r\n]+/g, " ") + kv + "\n";
      appendFileSync(this.currentFile(), line, "utf8");
    } catch {
      // I8
    }
  }

  debug(msg: string, f?: Record<string, unknown>): void {
    this.log("debug", msg, f);
  }
  info(msg: string, f?: Record<string, unknown>): void {
    this.log("info", msg, f);
  }
  warn(msg: string, f?: Record<string, unknown>): void {
    this.log("warn", msg, f);
  }
  error(msg: string, f?: Record<string, unknown>): void {
    this.log("error", msg, f);
  }
}

export function normalizeLevel(v: unknown): LogLevel {
  return v === "debug" || v === "info" || v === "warn" || v === "error" ? v : "info";
}
