/**
 * 会话原文旁路测试（§8.5）：多帧 zstd 解压 / 行提取 / mtime 增量索引 / 查询兜底 / 降级
 * 索引在临时目录建库 + 伪造 sessions 目录，不碰真实 $DSH_HOME。
 */
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openWeaveDb, type WeaveEnv } from "../src/store/db";
import { ensureSchema } from "../src/store/migrate";
import {
  decodeZstdConcat,
  extractSessionRows,
  queryQuotes,
  setZstdProbeForTest,
  syncSessionIndex,
  zstdAvailable,
} from "../src/store/quote";
import { WeaveService, defaultConfig } from "../src/host/service";

const nodeRequire = createRequire(import.meta.url);
const zlib = nodeRequire("node:zlib") as {
  zstdCompressSync?: (buf: Uint8Array) => Uint8Array;
  zstdDecompressSync?: (buf: Uint8Array) => Uint8Array;
};

/** 多帧 zstd：宿主就是逐次 flush 追加成多帧文件 */
function compressFrames(chunks: string[]): Buffer {
  if (typeof zlib.zstdCompressSync !== "function") {
    throw new Error("zstdCompressSync unavailable in this Node");
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(zlib.zstdCompressSync!(Buffer.from(c, "utf8")))));
}

function jsonlLine(obj: Record<string, unknown>): string {
  return JSON.stringify(obj);
}

function userLine(seq: number, text: string): string {
  return jsonlLine({ type: "user/message", seq, time: 1, data: { content: [{ type: "text", text }] } });
}

function assistantLine(seq: number, text: string): string {
  return jsonlLine({
    type: "assistant/message",
    seq,
    time: 1,
    data: { message: { role: "assistant", content: [{ type: "text", text }] } },
  });
}

let dir: string;
let sessionsDir: string;
let env: WeaveEnv;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memweave-quote-"));
  sessionsDir = join(dir, "sessions");
  env = openWeaveDb(join(dir, "memweave"));
  ensureSchema(env);
});

afterEach(() => {
  setZstdProbeForTest(undefined);
  env.close();
  rmSync(dir, { recursive: true, force: true });
});

function writeSession(ws: string, sid: string, chunks: string[], mtimeMs?: number): string {
  const sdir = join(sessionsDir, ws, sid);
  mkdirSync(sdir, { recursive: true });
  const file = join(sdir, "session.v4.jsonl.zstd");
  writeFileSync(file, compressFrames(chunks));
  if (mtimeMs !== undefined) {
    const t = new Date(mtimeMs);
    utimesSync(file, t, t);
  }
  return file;
}

describe("多帧 zstd 解压", () => {
  it("拼接帧全部解出（单帧解压只出首帧的对照）", () => {
    const buf = compressFrames(['{"type":"session","id":"s1"}\n', '{"seq":1}\n', '{"seq":2}\n']);
    const out = decodeZstdConcat(buf);
    expect(out).toContain("s1");
    expect(out).toContain('"seq":1');
    expect(out).toContain('"seq":2');
  });

  it("每帧只解一次：不因 libzstd 连带解出后续帧而重复（Linux CI 曾重复成 2 行）", () => {
    const buf = compressFrames(["A1\n", "B2\n", "C3\n"]);
    expect(decodeZstdConcat(buf)).toBe("A1\nB2\nC3\n");
  });

  it("中间帧损坏只丢这一帧，前后帧都在且不重复", () => {
    const a = compressFrames(["A1\n"]);
    const c = compressFrames(["C3\n"]);
    const bad = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0xff, 0xff]);
    expect(decodeZstdConcat(Buffer.concat([a, bad, c]))).toBe("A1\nC3\n");
  });

  it("尾帧损坏只丢尾帧", () => {
    const good = compressFrames(['{"type":"session","id":"s1"}\n']);
    const bad = Buffer.concat([good, Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0xff, 0xff])]);
    const out = decodeZstdConcat(bad);
    expect(out).toBe('{"type":"session","id":"s1"}\n');
  });

  it("zstd 不可用时返回空串", () => {
    setZstdProbeForTest(null);
    expect(zstdAvailable()).toBe(false);
    expect(decodeZstdConcat(compressFrames(["x"]))).toBe("");
  });
});

describe("jsonl 行提取", () => {
  it("只收 user / assistant 正文，seq 保留", () => {
    const jsonl = [
      jsonlLine({ type: "session", id: "s1" }),
      userLine(8, "视频导出要求 1080p"),
      jsonlLine({ type: "system/message", seq: 9, data: { message: { content: [{ type: "text", text: "system noise" }] } } }),
      jsonlLine({ type: "tool/result", seq: 10, data: { message: { content: [{ type: "text", text: "tool noise" }] } } }),
      assistantLine(11, "已记录视频导出要求"),
    ].join("\n");
    const rows = extractSessionRows(jsonl);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ seq: 8, role: "user", text: "视频导出要求 1080p" });
    expect(rows[1]).toMatchObject({ seq: 11, role: "assistant" });
  });

  it("坏行跳过、超长截断", () => {
    const jsonl = ["not-json", userLine(1, "x".repeat(5000))].join("\n");
    const rows = extractSessionRows(jsonl);
    expect(rows).toHaveLength(1);
    expect(rows[0].text.length).toBeLessThanOrEqual(2000);
  });
});

describe("mtime 增量索引", () => {
  it("索引 → 未变跳过 → 变更重索", async () => {
    writeSession("--D-DSH--", "sess-a", [
      jsonlLine({ type: "session", id: "sess-a" }) + "\n",
      userLine(1, "中转站价格核实任务") + "\n",
    ]);
    const r1 = await syncSessionIndex(env, { sessionsDir, indexDays: 90 });
    expect(r1.available).toBe(true);
    expect(r1.indexed).toBe(1);
    expect(r1.rows).toBe(1);

    const r2 = await syncSessionIndex(env, { sessionsDir, indexDays: 90 });
    expect(r2.indexed).toBe(0);
    expect(r2.skipped).toBe(1);

    writeSession("--D-DSH--", "sess-a", [
      jsonlLine({ type: "session", id: "sess-a" }) + "\n",
      userLine(1, "中转站价格核实任务") + "\n",
      assistantLine(2, "已抓取各平台价格页") + "\n",
    ]);
    const r3 = await syncSessionIndex(env, { sessionsDir, indexDays: 90 });
    expect(r3.indexed).toBe(1);
    const count = env.db.prepare("SELECT COUNT(*) AS n FROM session_fts").get() as { n: number };
    expect(Number(count.n)).toBe(2);
  });

  it("超出窗口的旧文件出清索引", async () => {
    const old = Date.now() - 200 * 86400000;
    writeSession("--D-DSH--", "sess-old", [userLine(1, "旧会话内容") + "\n"], old);
    const r1 = await syncSessionIndex(env, { sessionsDir, indexDays: 90 });
    expect(r1.indexed).toBe(0);
    expect(r1.pruned).toBe(0);

    // 先落索引（宽窗口），再收窄窗口 → prune
    await syncSessionIndex(env, { sessionsDir, indexDays: 400, now: old + 86400000 });
    const r3 = await syncSessionIndex(env, { sessionsDir, indexDays: 90 });
    expect(r3.pruned).toBe(1);
    const count = env.db.prepare("SELECT COUNT(*) AS n FROM session_fts").get() as { n: number };
    expect(Number(count.n)).toBe(0);
  });

  it("zstd 不可用或只读库时不动索引", async () => {
    writeSession("--D-DSH--", "sess-b", [userLine(1, "内容") + "\n"]);
    setZstdProbeForTest(null);
    const r = await syncSessionIndex(env, { sessionsDir, indexDays: 90 });
    expect(r.available).toBe(false);
    expect(r.indexed).toBe(0);
  });
});

describe("查询：FTS 前缀 + LIKE 子串兜底", () => {
  it("中文前缀词走 FTS，后缀词走 LIKE 兜底", async () => {
    writeSession("--D-DSH--", "sess-q", [
      userLine(1, "中转站与聚合平台价格核实") + "\n",
      assistantLine(2, "OpenRouter 报价已抓取") + "\n",
    ]);
    await syncSessionIndex(env, { sessionsDir, indexDays: 90 });

    const byPrefix = queryQuotes(env, "中转站");
    expect(byPrefix.length).toBeGreaterThan(0);
    expect(byPrefix[0].text).toContain("中转站");

    const bySuffix = queryQuotes(env, "价格核实");
    expect(bySuffix.length).toBeGreaterThan(0);
    expect(bySuffix[0].sessionId).toBe("sess-q");
  });

  it("FTS 特殊字符不炸、空词返回空", () => {
    expect(queryQuotes(env, ' " OR NOT * ')).toEqual([]);
    expect(queryQuotes(env, "")).toEqual([]);
  });
});

describe("服务接线（§8.5 降级分支）", () => {
  it("enabled=false 时 quoteLookup 恒空，refresh 不建索引", async () => {
    writeSession("--D-DSH--", "sess-s", [userLine(1, "内容") + "\n"]);
    const cfg = defaultConfig(join(dir, "memweave"));
    cfg.quote.sessionsDir = sessionsDir;
    const svc = new WeaveService(env, cfg);
    expect(svc.quoteLookup("内容")).toEqual([]);
    const r = await svc.refreshQuoteIndex();
    expect(r.indexed).toBe(0);
  });

  it("enabled=true 走通：同步后可查；zstd 不可用强制关", async () => {
    writeSession("--D-DSH--", "sess-s2", [userLine(1, "像素风偏好记录") + "\n"]);
    const cfg = defaultConfig(join(dir, "memweave"));
    cfg.quote.enabled = true;
    cfg.quote.sessionsDir = sessionsDir;
    const svc = new WeaveService(env, cfg);
    const r = await svc.refreshQuoteIndex();
    expect(r.indexed).toBe(1);
    expect(svc.quoteLookup("像素风").length).toBeGreaterThan(0);

    setZstdProbeForTest(null);
    const r2 = await svc.refreshQuoteIndex();
    expect(r2.available).toBe(false);
    expect(svc.config.quote.enabled).toBe(false);
    expect(svc.quoteLookup("像素风")).toEqual([]);
  });

  it("renderTurn：关键词有命中不掺原文，两路全空才兜底原文", async () => {
    writeSession("--D-DSH--", "sess-r", [userLine(1, "记忆条目甲 与 ZebraQuote 都在原文里") + "\n"]);
    const cfg = defaultConfig(join(dir, "memweave"));
    cfg.quote.enabled = true;
    cfg.quote.sessionsDir = sessionsDir;
    const svc = new WeaveService(env, cfg);
    await svc.refreshQuoteIndex();
    await svc.remember(
      {
        level: "fact",
        content: "记忆条目甲的结论",
        project: null,
        section: null,
        keywords: [],
        importance: 3,
        semanticKey: null,
        evidence: [],
        tier: "hot",
        validTo: null,
      },
      "human",
    );

    // 关键词有命中 → 即便原文里也有该词，也不掺原文
    const withHits = svc.renderTurn({ sessionId: "s-x", first: false, query: "记忆条目甲", baseline: new Map() });
    expect(withHits.result.segments.some((s) => s.name === "s3-quote" && s.items > 0)).toBe(false);

    // 两路全空 → 兜底原文（ZebraQuote 只在会话原文里出现）
    const noHits = svc.renderTurn({ sessionId: "s-y", first: false, query: "ZebraQuote", baseline: new Map() });
    expect(noHits.result.segments.some((s) => s.name === "s3-quote" && s.items > 0)).toBe(true);
  });
});
