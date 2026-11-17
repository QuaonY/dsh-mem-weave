#!/usr/bin/env node
/**
 * 外部记忆基准适配器（零依赖）
 * 把「会话/事实 → 记忆 → 召回 → 上下文」这一段跑通，输出可直接交给作答模型的内容。
 * 不改内核，也不需要向量后端；所有评分/判定仍由外部基准脚本负责。
 * 用法：
 *   node bench/eval-adapter.mjs run --memories bench/fixtures/eval-memories.jsonl \
 *     --queries bench/fixtures/eval-queries.jsonl --normalize en --out out.jsonl
 *   node bench/eval-adapter.mjs ingest --memories ... --db .eval/locomo
 *   node bench/eval-adapter.mjs retrieve --queries ... --db .eval/locomo --out out.jsonl
 * 数据格式（JSONL 每行一条，或 JSON 数组）：
 *   memories: {"id":"m1","content":"...","level":"fact","project":"p1","ts":"2023-05-07","keywords":["..."]}
 *   queries : {"id":"q1","query":"...","gold":["m1"],"limit":10,"answer":"...","category":"..."}
 * 输出：{"id","query","hits":[{"id","level","content","score"}],"context","rank","answer","category"}
 *   rank = gold 中最早出现的名次（1 起），没有 gold 时为 null。
 * 基准安全配置（默认值，可用参数覆盖）：
 *   privacy.enabled=false / filterOnRecall=false  —— 含邮箱、手机号的条目默认不进召回
 *   write.containment.enabled=false               —— 关闭近似合并，避免会话被吞
 *   lifecycle.halfLifeDays=100000                 —— 数据集大多是一两年前的日期
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const LEVELS = ["soul", "user", "project", "fact", "lesson", "topic", "rules"];

/* ------------------------------------------------------------------ */
/* 命令行                                                              */
/* ------------------------------------------------------------------ */

const USAGE = `MemWeave 外部基准适配器（零依赖）

命令：
  run       建库 → 写入 → 召回，一步跑完（--db 省略时用临时库）
  ingest    只写入（必须给 --db）
  retrieve  只召回（必须给 --db）

参数：
  --memories <file>          记忆 JSONL/JSON 路径（run/ingest 必需）
  --queries <file>           查询 JSONL/JSON 路径（run/retrieve 必需）
  --db <dir>                 数据库目录（ingest/retrieve 必需）
  --out <file>               结果输出；省略时写 stdout
  --summary <file>           汇总指标 JSON 输出
  --limit <n>                每次召回条数，默认 10
  --half-life-days <n>       时间衰减半衰期，默认 100000（相当于关掉衰减）
  --normalize <none|en>      英文词形归一（词干 + 去停用词），默认 none；英文基准建议 en
  --prior <on|off>           写入侧重要性先验，默认 on；off 时 surprise/sourceWeight 关闭、importance 退化为 1.0
  --max-context-chars <n>    拼给作答模型的上下文字符上限，默认 6000
  --format <jsonl|json>      结果格式，默认 jsonl
  --fresh                    先清空 --db 目录
  --keep-db                  run 结束时保留临时库
  --quiet                    不打印进度
  --help                     显示本说明

示例（英文基准）：
  node bench/eval-adapter.mjs run \\
    --memories locomo_memories.jsonl --queries locomo_queries.jsonl \\
    --normalize en --out locomo_results.jsonl --summary locomo_summary.json
`;

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      out._.push(a);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    const takesValue = next !== undefined && !next.startsWith("--");
    switch (key) {
      case "help":
      case "fresh":
      case "keep-db":
      case "quiet":
        out[key] = true;
        break;
      case "normalize":
      case "format":
      case "limit":
      case "half-life-days":
      case "prior":
      case "max-context-chars":
      case "memories":
      case "queries":
      case "db":
      case "out":
      case "summary":
        if (!takesValue) usageFail(`参数 --${key} 缺少值`);
        out[key] = next;
        i += 1;
        break;
      default:
        usageFail(`未知参数 --${key}`);
    }
  }
  return out;
}

function usageFail(message) {
  console.error(`[eval] ${message}\n`);
  console.error(USAGE);
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/* 英文词形归一（README 里说明的适配层做法；不改内核分词）              */
/* ------------------------------------------------------------------ */

const STOP = new Set(
  (
    "a an the and or but if then than that this these those of in on at to for from by with without about as " +
    "is are was were be been being am do does did doing have has had having i you he she it we they me him her " +
    "them my your his its our their what which who whom whose when where why how not no yes s t"
  ).split(" "),
);

const IRREGULAR = {
  went: "go", gone: "go", did: "do", done: "do", was: "be", were: "be", been: "be", has: "have", had: "have",
  lives: "live", lived: "live", moving: "move", moved: "move", married: "marry", children: "child",
  men: "man", women: "woman", people: "people", better: "good", best: "good", worse: "bad", worst: "bad",
};

const SUFFIXES = [
  "ational", "ization", "iveness", "fulness", "ousness", "ities", "ements", "ingly", "edly",
  "ings", "ies", "ied", "ing", "ed", "es", "s", "ly", "ment",
];

/** 轻量词干：只处理常见屈折后缀，够覆盖会话里的时态/复数差异 */
export function stem(word) {
  if (IRREGULAR[word]) return IRREGULAR[word];
  if (word.length <= 3) return word;
  let s = word;
  for (const suf of SUFFIXES) {
    if (s.endsWith(suf) && s.length - suf.length >= 3) {
      s = s.slice(0, -suf.length);
      if (suf === "ies" || suf === "ied") s += "y";
      break;
    }
  }
  if (/([bdfgmnprt])\1$/.test(s)) s = s.slice(0, -1);
  if (s.endsWith("e") && s.length > 4) s = s.slice(0, -1);
  return s;
}

/** 英文归一：小写 → 词干 → 去停用词 */
export function normalizeEn(text) {
  const words = String(text).toLowerCase().match(/[a-z0-9]+(?:[-_][a-z0-9]+)*/g) ?? [];
  return words.map(stem).filter((t) => !STOP.has(t));
}

function normalizeQuery(query, mode) {
  return mode === "en" ? normalizeEn(query).join(" ") : query;
}

function keywordsFor(content, mode, explicit) {
  if (Array.isArray(explicit) && explicit.length > 0) return explicit.map(String);
  if (mode === "en") return normalizeEn(content);
  return undefined;
}

/* ------------------------------------------------------------------ */
/* 读写                                                                */
/* ------------------------------------------------------------------ */

function readRecords(file, kind) {
  const abs = resolve(file);
  if (!existsSync(abs)) usageFail(`${kind} 文件不存在：${abs}`);
  const raw = readFileSync(abs, "utf8").replace(/^\uFEFF/, "");
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    const arr = JSON.parse(trimmed);
    if (!Array.isArray(arr)) usageFail(`${kind} 文件不是数组：${abs}`);
    return arr;
  }
  const out = [];
  const lines = trimmed.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line || line.startsWith("//")) continue;
    try {
      out.push(JSON.parse(line));
    } catch (e) {
      usageFail(`${kind} 第 ${i + 1} 行不是合法 JSON：${e.message}`);
    }
  }
  return out;
}

function writeRecords(file, rows, format) {
  const body = format === "json" ? JSON.stringify(rows, null, 2) + "\n" : rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
  if (!file) {
    process.stdout.write(body);
    return;
  }
  const abs = resolve(file);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body);
}

function toMs(ts) {
  if (ts === undefined || ts === null || ts === "") return undefined;
  if (typeof ts === "number") return ts < 1e11 ? ts * 1000 : ts;
  const n = Date.parse(String(ts));
  return Number.isFinite(n) ? n : undefined;
}

/**
 * 数据集条目 id → 库内 id。ingest 时写入库目录，retrieve 时读回
 * 这样「建库」和「召回」可以分两次跑，gold 仍能对上。
 */
function loadIdMap(dbDir) {
  const file = join(dbDir, ".eval-ids.json");
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveIdMap(dbDir, map) {
  try {
    writeFileSync(join(dbDir, ".eval-ids.json"), JSON.stringify(map, null, 2) + "\n");
  } catch {
    // 只影响 retrieve 阶段的 gold 对齐，不阻断写入
  }
}

/* ------------------------------------------------------------------ */
/* 服务                                                                */
/* ------------------------------------------------------------------ */

const libEntry = join(root, "lib", "index.js");

async function loadService() {
  if (!existsSync(libEntry)) {
    process.stderr.write("[eval] lib/index.js 不存在，先 build ...\n");
    const r = spawnSync(process.execPath, [join(root, "scripts", "build.mjs")], { stdio: "inherit" });
    if (r.status !== 0) process.exit(r.status ?? 1);
  }
  return import(pathToFileURL(libEntry).href);
}

function benchConfig(opts) {
  const halfLifeDays = Number(opts["half-life-days"] ?? 100000);
  const halfLife = {};
  for (const level of LEVELS) halfLife[level] = halfLifeDays;
  // prior=off：关掉写入侧的惊讶度 / 来源先验，importance 全部落回 3（因子 = 1.0）。
  // 用来把「检索模型本身」和「重要性先验对排序的扰动」分开看。
  const prior = opts.prior !== "off";
  return {
    privacy: { enabled: false, strictMode: false, detectPII: false, filterOnRecall: false },
    // 写入治理里另有一套敏感规则（core/sensitive.ts），与 privacy 开关无关：
    // 基准数据里的手机号 / 长数字串会直接 E_SENSITIVE 拒写，这里只关掉可关闭的三条。
    // 凭据类（api-key / token / private-key / password）锁定，基准数据不应包含它们。
    governance: { disabledSensitive: ["phone", "bank-card", "id-card"] },
    write: {
      surprise: { enabled: prior },
      sourceWeight: { enabled: prior },
      containment: { enabled: false, jaccard: 0.6, containment: 0.78 },
    },
    lifecycle: { halfLifeDays: halfLife },
  };
}

/* ------------------------------------------------------------------ */
/* 写入                                                                */
/* ------------------------------------------------------------------ */

function backdate(env, entry) {
  if (!LEVELS.includes(entry.level)) return;
  env.db.prepare(`UPDATE ${entry.level} SET created_at = ?, updated_at = ? WHERE id = ?`).run(entry.ts, entry.ts, entry.id);
}

async function ingest(service, env, records, opts, log) {
  const mode = opts.normalize ?? "none";
  const stats = { total: records.length, accepted: 0, merged: 0, skipped: 0, backdated: 0, errors: [], ids: {} };
  for (let i = 0; i < records.length; i += 1) {
    const rec = records[i];
    const content = typeof rec?.content === "string" ? rec.content.trim() : "";
    const level = rec?.level ?? "fact";
    if (!content) {
      stats.skipped += 1;
      stats.errors.push(`#${i + 1} 缺少 content`);
      continue;
    }
    if (!LEVELS.includes(level)) {
      stats.skipped += 1;
      stats.errors.push(`#${i + 1} 未知 level：${level}`);
      continue;
    }
    const input = { level, content };
    if (rec.project !== undefined) input.project = rec.project;
    if (rec.section !== undefined) input.section = rec.section;
    if (rec.importance !== undefined) input.importance = Number(rec.importance);
    const kw = keywordsFor(content, mode, rec.keywords);
    if (kw && kw.length > 0) input.keywords = kw;

    let out;
    try {
      out = await service.remember(input, "human", {
        sessionId: String(rec.session ?? rec.sessionId ?? "eval"),
        turn: i + 1,
        searchTerms: Array.isArray(rec.searchTerms) ? rec.searchTerms : undefined,
      });
    } catch (e) {
      stats.skipped += 1;
      stats.errors.push(`#${i + 1} 写入异常：${e.message ?? e}`);
      continue;
    }
    if (!out?.ok) {
      stats.skipped += 1;
      stats.errors.push(`#${i + 1} 写入被拒：${out?.verdict ?? out?.message ?? "unknown"}`);
      continue;
    }
    if (out.verdict === "merged") stats.merged += 1;
    if (!out.deduped) stats.accepted += 1;
    const extId = rec.id !== undefined && rec.id !== null ? String(rec.id) : `#${i + 1}`;
    if (out.id) stats.ids[extId] = String(out.id);
    const ts = toMs(rec.ts ?? rec.timestamp ?? rec.createdAt);
    if (ts !== undefined && out.id) {
      backdate(env, { level, id: out.id, ts });
      stats.backdated += 1;
    }
    if (!opts.quiet && (i + 1) % 200 === 0) log(`[eval] 已写入 ${i + 1}/${records.length}`);
  }
  return stats;
}

/* ------------------------------------------------------------------ */
/* 召回                                                                */
/* ------------------------------------------------------------------ */

function buildContext(hits, maxChars) {
  const parts = [];
  let used = 0;
  let added = 0;
  for (const h of hits) {
    const line = `${added + 1}. [${h.entry.level}] ${h.entry.content}`;
    if (used + line.length + 1 > maxChars) break;
    parts.push(line);
    used += line.length + 1;
    added += 1;
  }
  return parts.join("\n");
}

function goldRank(hits, gold, idMap) {
  if (!Array.isArray(gold) || gold.length === 0) return null;
  const want = new Set(gold.map((g) => String((idMap && idMap[String(g)]) ?? g)));
  for (let i = 0; i < hits.length; i += 1) {
    if (want.has(hits[i].entry.id)) return i + 1;
  }
  return 0;
}

function reverseMap(idMap) {
  const out = {};
  for (const [ext, id] of Object.entries(idMap ?? {})) out[id] = ext;
  return out;
}

function retrieve(service, queries, opts, idMap) {
  const mode = opts.normalize ?? "none";
  const limit = Math.max(1, Number(opts.limit ?? 10));
  const maxChars = Math.max(200, Number(opts["max-context-chars"] ?? 6000));
  const rev = reverseMap(idMap);
  const rows = [];
  for (const q of queries) {
    const text = typeof q?.query === "string" ? q.query.trim() : "";
    if (!text) continue;
    const k = Math.max(1, Number(q.limit ?? limit));
    const hits = service.recall(normalizeQuery(text, mode), { limit: k });
    const row = {
      id: q.id ?? null,
      query: text,
      hits: hits.map((h) => {
        const hit = { id: h.entry.id, level: h.entry.level, content: h.entry.content, score: Number(h.score.toFixed(6)) };
        if (rev[h.entry.id]) hit.ref = rev[h.entry.id];
        return hit;
      }),
      context: buildContext(hits, maxChars),
      rank: goldRank(hits, q.gold, idMap),
    };
    if (q.answer !== undefined) row.answer = q.answer;
    if (q.category !== undefined) row.category = q.category;
    if (q.gold !== undefined) row.gold = q.gold;
    rows.push(row);
  }
  return rows;
}

function summarize(rows) {
  const graded = rows.filter((r) => r.rank !== null);
  const at = (k) => (graded.length ? graded.filter((r) => r.rank > 0 && r.rank <= k).length / graded.length : null);
  const mrr = graded.length
    ? graded.reduce((acc, r) => acc + (r.rank > 0 ? 1 / r.rank : 0), 0) / graded.length
    : null;
  return {
    queries: rows.length,
    graded: graded.length,
    hitAt1: at(1),
    hitAt3: at(3),
    hitAt5: at(5),
    mrr,
    avgContextChars: rows.length ? Math.round(rows.reduce((a, r) => a + r.context.length, 0) / rows.length) : 0,
    withContext: rows.filter((r) => r.context.length > 0).length,
  };
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || opts._.length === 0) {
    process.stdout.write(USAGE);
    return;
  }
  const cmd = opts._[0];
  if (!["run", "ingest", "retrieve"].includes(cmd)) usageFail(`未知命令：${cmd}`);
  const log = opts.quiet ? () => {} : (m) => process.stderr.write(m + "\n");

  const mode = opts.normalize ?? "none";
  if (!["none", "en"].includes(mode)) usageFail(`--normalize 只支持 none | en`);
  const format = opts.format ?? "jsonl";
  if (!["jsonl", "json"].includes(format)) usageFail(`--format 只支持 jsonl | json`);
  const prior = opts.prior ?? "on";
  if (!["on", "off"].includes(prior)) usageFail(`--prior 只支持 on | off`);

  let dbDir = opts.db ? resolve(opts.db) : null;
  let tempDb = false;
  if (!dbDir) {
    if (cmd !== "run") usageFail(`${cmd} 需要 --db <dir>`);
    dbDir = mkdtempSync(join(tmpdir(), "memweave-eval-"));
    tempDb = true;
  }
  if (cmd === "run" && !opts.db) {
    // 临时库本来就是空的
  } else if (cmd === "run" || (opts.fresh && cmd !== "retrieve")) {
    rmSync(dbDir, { recursive: true, force: true });
  }
  if (cmd !== "retrieve") mkdirSync(dbDir, { recursive: true });

  const memories = cmd === "retrieve" ? null : readRecords(opts.memories ?? usageFail("缺少 --memories <file>"), "memories");
  const queries = cmd === "ingest" ? null : readRecords(opts.queries ?? usageFail("缺少 --queries <file>"), "queries");
  if (mode === "en" && cmd !== "retrieve") log("[eval] 英文归一已开启：写入用词干 keywords，查询用同一套归一化");

  const { openService } = await loadService();
  const rt = openService(dbDir, benchConfig(opts));
  const started = Date.now();
  let idMap = cmd === "retrieve" ? loadIdMap(dbDir) : {};
  try {
    let stats = null;
    if (memories) {
      log(`[eval] 写入 ${memories.length} 条 → ${dbDir}`);
      stats = await ingest(rt.service, rt.env, memories, { ...opts, normalize: mode }, log);
      idMap = stats.ids;
      saveIdMap(dbDir, idMap);
      log(
        `[eval] 写入完成：accepted=${stats.accepted} merged=${stats.merged} skipped=${stats.skipped}` +
          ` 回填时间=${stats.backdated} 用时=${((Date.now() - started) / 1000).toFixed(1)}s`,
      );
      if (stats.errors.length > 0) {
        log(`[eval] 有 ${stats.errors.length} 条未写入，前 5 条：`);
        for (const e of stats.errors.slice(0, 5)) log("  " + e);
      }
    }

    if (queries) {
      log(`[eval] 召回 ${queries.length} 个查询（limit=${opts.limit ?? 10}, normalize=${mode}）`);
      const rows = retrieve(rt.service, queries, opts, idMap);
      const summary = summarize(rows);
      if (stats) {
        const { ids, ...rest } = stats;
        summary.write = { ...rest, idMapSize: Object.keys(ids).length };
      }
      writeRecords(opts.out, rows, format);
      if (opts.out) log(`[eval] 结果已写入 ${resolve(opts.out)}`);
      if (opts.summary) {
        const abs = resolve(opts.summary);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, JSON.stringify(summary, null, 2) + "\n");
        log(`[eval] 汇总已写入 ${abs}`);
      }
      if (summary.graded > 0) {
        const pct = (v) => (v === null ? "-" : (v * 100).toFixed(1) + "%");
        log(
          `[eval] 召回指标（${summary.graded} 条带 gold）：hit@1=${pct(summary.hitAt1)} hit@3=${pct(summary.hitAt3)}` +
            ` hit@5=${pct(summary.hitAt5)} MRR=${summary.mrr === null ? "-" : summary.mrr.toFixed(3)}`,
        );
      }
      if (!opts.out && !opts.quiet) log("[eval] 提示：结果已写 stdout，进度日志在 stderr");
    }
  } finally {
    try {
      rt.env.close();
    } catch {
      // 关库失败不影响已写出的结果
    }
    if (tempDb && !opts["keep-db"]) rmSync(dbDir, { recursive: true, force: true });
    else if (tempDb) log(`[eval] 临时库保留在 ${dbDir}`);
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((e) => {
    console.error("[eval] 失败：", e?.stack ?? e);
    process.exit(2);
  });
}

export { benchConfig, buildContext, goldRank, keywordsFor, normalizeQuery, summarize };
