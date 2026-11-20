#!/usr/bin/env node
/**
 * LoCoMo 跑分器（零依赖）
 * 数据集来自 https://github.com/snap-research/locomo → data/locomo10.json（ACL 2024）。
 *   10 段超长对话（272 会话 / 5,882 轮），每段带 105–260 道 QA
 *   每题的 gold 是一串 dia_id（如 "D1:3"），category 1–5。
 * 与 LongMemEval 跑分器的关键差异：
 *   - 一段对话只建**一个**库，所有题共享同一份记忆（LongMemEval 是每题一个库）；
 *   - gold 是轮次 id 而不是会话 id，所以默认粒度是 turn（一个 dia_id 一条记忆）；
 *   - 题目没有日期，会话日期格式是 "1:56 pm on 8 May, 2023"。
 * 指标：recall_any / recall_all / recall_mean / ndcg_any（对齐本仓库 LongMemEval 口径）
 *       外加 answer_in_context（官方 RAG 评测的 has_answer 简化版，只看答案串在不在召回上下文里）。
 *       category 5 是 adversarial（前提为假），单独分桶，另算一份不含 5 的汇总。
 * 用法：
 *   node test/bench/locomo.mjs run --data data/locomo10.json
 *   node test/bench/locomo.mjs run --data ... --convs 2 --out rows.jsonl --report report.json
 *   node test/bench/locomo.mjs run --data ... --granularity session --baseline bm25
 * 参数：
 *   --data <file>              locomo10.json（必需）
 *   --granularity turn|session 默认 turn（一个 dia_id 一条记忆）
 *   --convs <n>                只跑前 n 段对话
 *   --ids conv-26,conv-30      只跑指定对话
 *   --category 1,2,3,4         只跑指定类别（默认全部 1–5）
 *   --max-questions <n>        每段对话只跑前 n 题
 *   --limit <n>                召回条数，默认 10
 *   --ks 5,10                  评估的 k，默认 5,10
 *   --normalize en|none        英文词形归一，默认 en
 *   --half-life-days <n>       衰减半衰期，默认 100000
 *   --prior on|off             写入侧重要性先验（惊讶度/来源权重），默认 on；off 时因子恒 1.0
 *   --baseline <none|bm25>     额外跑一份同数据 BM25 基线，默认 none
 *   --max-context-chars <n>    每题导出的上下文字符上限，默认 6000
 *   --db <dir>                 指定库目录（默认临时目录，跑完删除）
 *   --keep-db                  保留最后一次的库
 *   --out <file>               每题结果 JSONL
 *   --report <file>            汇总指标 JSON
 *   --qa <off|extractive|http> QA 评测的 reader，默认 off
 *   --qa-judge <heuristic|llm|both> QA 判分方式，默认 heuristic
 *   --qa-model <name>          QA reader 模型，默认 gpt-4o-mini
 *   --qa-judge-model <name>    QA judge 模型，默认同 reader
 *   --qa-base-url <url>        OpenAI 兼容端点，默认 https://api.openai.com/v1
 *   --qa-api-key-env <name>    API key 所在环境变量，默认 OPENAI_API_KEY
 *   --qa-concurrency <n>       QA 并发，默认 4
 *   --qa-timeout-ms <n>        单次请求超时，默认 60000
 *   --qa-max-context-chars <n> QA 上下文上限，默认 6000
 *   --qa-limit <n>             只对前 n 题做 QA（成本控制）
 *   --qa-out <file>            QA 逐题 JSONL
 *   --quiet                    不打印进度
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { benchConfig, normalizeEn } from "./eval-adapter.mjs";
import { effectiveSessionK, ndcgAt } from "./longmemeval.mjs";
import { buildQaReport, createQaPipeline, formatQaLine, resolveQaConfig, runQa } from "./qa.mjs";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const CHUNK = 1900;
const LEVEL = "topic";

/** LoCoMo 的 category 含义（论文） */
export const CATEGORY_LABEL = {
  1: "multi-hop",
  2: "temporal",
  3: "open-domain",
  4: "single-hop",
  5: "adversarial",
};

/* ------------------------------------------------------------------ */
/* 参数                                                                */
/* ------------------------------------------------------------------ */

const USAGE = `LoCoMo 跑分器（零依赖）

  node test/bench/locomo.mjs run --data <locomo10.json> [选项]

  --granularity turn|session   默认 turn
  --convs <n>                  只跑前 n 段对话
  --ids <id,id>                只跑指定对话
  --category 1,2,3,4           只跑指定类别
  --max-questions <n>          每段对话只跑前 n 题
  --limit <n>                  召回条数，默认 10
  --ks 5,10                    评估 k，默认 5,10
  --normalize en|none          默认 en
  --half-life-days <n>         默认 100000
  --prior on|off               默认 on（off = 关掉重要性先验）
  --baseline none|bm25         默认 none
  --max-context-chars <n>      默认 6000
  --db <dir> / --keep-db       库目录
  --out <file> / --report <file>
  --quiet
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
      case "quiet":
      case "keep-db":
        out[key] = true;
        break;
      case "data":
      case "granularity":
      case "convs":
      case "ids":
      case "category":
      case "max-questions":
      case "limit":
      case "ks":
      case "normalize":
      case "half-life-days":
      case "prior":
      case "baseline":
      case "max-context-chars":
      case "db":
      case "out":
      case "report":
      case "qa":
      case "qa-judge":
      case "qa-model":
      case "qa-judge-model":
      case "qa-base-url":
      case "qa-api-key-env":
      case "qa-concurrency":
      case "qa-timeout-ms":
      case "qa-max-context-chars":
      case "qa-limit":
      case "qa-out":
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
  console.error(`[locomo] ${message}\n`);
  console.error(USAGE);
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/* 解析                                                                */
/* ------------------------------------------------------------------ */

const MONTHS = new Map(
  ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"]
    .map((m, i) => [m, i]),
);

/** 会话日期："1:56 pm on 8 May, 2023" → 本地时间毫秒；解析失败返回 undefined */
export function parseLocomoDate(input) {
  const m = /(\d{1,2}):(\d{2})\s*(am|pm)\s+on\s+(\d{1,2})\s+([A-Za-z]+),?\s*(\d{4})/i.exec(String(input ?? ""));
  if (!m) return undefined;
  const month = MONTHS.get(m[5].toLowerCase());
  if (month === undefined) return undefined;
  let hour = Number(m[1]) % 12;
  if (m[3].toLowerCase() === "pm") hour += 12;
  const t = new Date(Number(m[6]), month, Number(m[4]), hour, Number(m[2])).getTime();
  return Number.isFinite(t) ? t : undefined;
}

/**
 * evidence 清洗：官方数据里绝大多数是单个 "D1:3"，但实测有
 * "D8:6; D9:17"、"D1:3 D2:7 D9:1" 这种一条塞多个的，也有 "D" / "D:2:3" 脏值。
 * 这里统一按分隔符拆开、只留形如 D<n>:<n> 的 id，并去重、大写。
 * 数字位还要去前导零：conv-50 有一题写 "D30:05"，而对话里的 dia_id 是 "D30:5"
 * 不归一的话这条 gold 会对不上任何文档，题目会被当成「无 gold」丢掉。
 */
export function parseEvidence(list) {
  const out = [];
  for (const raw of list ?? []) {
    for (const part of String(raw).split(/[;,\s]+/)) {
      const m = /^d(\d+):(\d+)$/i.exec(part.trim());
      if (!m) continue;
      const id = `D${Number(m[1])}:${Number(m[2])}`;
      if (!out.includes(id)) out.push(id);
    }
  }
  return out;
}

/** dia_id → 检索单元 key（turn 粒度用 dia_id 本身，session 粒度用 "D<n>"） */
export function unitKey(diaId, granularity) {
  const m = /^d(\d+)(?::(\d+))?$/i.exec(String(diaId ?? "").trim());
  if (!m) return String(diaId ?? "").toUpperCase();
  const sid = `D${Number(m[1])}`;
  if (granularity === "session" || m[2] === undefined) return sid;
  return `${sid}:${Number(m[2])}`;
}

function renderTurn(turn) {
  const text = String(turn?.text ?? "").trim();
  const caption = String(turn?.blip_caption ?? "").trim();
  if (!text && !caption) return "";
  const who = String(turn?.speaker ?? "").trim();
  const body = text || "[image]";
  const tail = text && caption ? ` (shared image: ${caption})` : !text ? ` ${caption}` : "";
  return who ? `${who}: ${body}${tail}` : `${body}${tail}`;
}

/* ------------------------------------------------------------------ */
/* 文档切分                                                            */
/* ------------------------------------------------------------------ */

/**
 * 把一段对话拆成记忆文档。
 * turn：一条发言一条记忆，docId 就是官方 dia_id（gold 直接对齐）。
 * session：一个会话一条，超 1900 字按发言边界切块，块 id 带 # 后缀。
 * 注意：数据里有孤儿日期键（session_20_date_time 存在但没有 session_20 数组）
 * 所以只遍历真实存在的会话数组，日期按 session_<n>_date_time 查。
 */
export function buildDocs(sample, opts = {}) {
  const granularity = opts.granularity ?? "turn";
  const conv = sample?.conversation ?? {};
  const nums = Object.keys(conv)
    .filter((k) => /^session_\d+$/.test(k))
    .map((k) => Number(k.slice("session_".length)))
    .sort((a, b) => a - b);
  const docs = [];

  for (const n of nums) {
    const sid = `D${n}`;
    const ts = parseLocomoDate(conv[`session_${n}_date_time`]);
    const turns = Array.isArray(conv[`session_${n}`]) ? conv[`session_${n}`] : [];

    if (granularity === "turn") {
      for (let i = 0; i < turns.length; i += 1) {
        const content = renderTurn(turns[i]);
        if (!content) continue;
        const docId = String(turns[i]?.dia_id ?? `${sid}:${i + 1}`).toUpperCase();
        docs.push({
          sid,
          docId,
          turn: i + 1,
          ts,
          content: content.slice(0, CHUNK),
          truncated: content.length > CHUNK,
        });
      }
      continue;
    }

    let buf = "";
    let part = 0;
    const flush = () => {
      const content = buf.trim();
      if (!content) return;
      part += 1;
      docs.push({ sid, docId: part === 1 ? sid : `${sid}#${part}`, turn: 0, ts, content, truncated: false });
      buf = "";
    };
    for (const t of turns) {
      const text = renderTurn(t);
      if (!text) continue;
      if (text.length > CHUNK) {
        flush();
        part += 1;
        docs.push({ sid, docId: `${sid}#${part}`, turn: 0, ts, content: text.slice(0, CHUNK), truncated: true });
        continue;
      }
      if (buf.length + 1 + text.length > CHUNK) flush();
      buf = buf ? `${buf} ${text}` : text;
    }
    flush();
  }
  return docs;
}

/* ------------------------------------------------------------------ */
/* 指标                                                                */
/* ------------------------------------------------------------------ */

/** 官方 evaluation.py 的 normalize_answer 简化版：小写、去标点、去 a/an/the/and */
export function normalizeForMatch(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !["a", "an", "the", "and"].includes(w));
}

/** 答案串是否（按词序列）出现在文本里——对应官方 RAG 评测的 has_answer */
export function containsAnswer(answer, text) {
  const a = normalizeForMatch(answer);
  if (a.length === 0) return false;
  const t = normalizeForMatch(text);
  if (t.length < a.length) return false;
  for (let i = 0; i + a.length <= t.length; i += 1) {
    let hit = true;
    for (let j = 0; j < a.length; j += 1) {
      if (t[i + j] !== a[j]) {
        hit = false;
        break;
      }
    }
    if (hit) return true;
  }
  return false;
}

/**
 * 单题指标。gold 是检索单元 key 的集合（turn 粒度是 dia_id，session 粒度是 "D<n>"）。
 * hits 里每个 item 形如 { doc, score }，doc 可带 keys（精确去重合并后的别名）。
 */
export function evaluateQuestion(gold, hits, corpus, ks, opts = {}) {
  const granularity = opts.granularity ?? "turn";
  const answer = opts.answer;
  const ranked = hits.map((h) => h.doc);
  const dedupeKey = (d) => (granularity === "session" ? d.sid : d.docId);
  const keysOf = (d) => d.keys ?? [dedupeKey(d)];
  const out = {};

  for (const k of ks) {
    const eff = effectiveSessionK(ranked.map(dedupeKey), k);
    const prefix = ranked.slice(0, eff);
    const seen = new Set();
    const got = new Set();
    for (const d of prefix) {
      const dk = dedupeKey(d);
      if (seen.has(dk)) continue;
      seen.add(dk);
      for (const key of keysOf(d)) if (gold.has(key)) got.add(key);
    }

    // 相关性序列：与官方一致，会话去重后再算 nDCG
    const relRanked = [];
    const seenRel = new Set();
    for (const d of prefix) {
      const dk = dedupeKey(d);
      if (seenRel.has(dk)) continue;
      seenRel.add(dk);
      relRanked.push(keysOf(d).some((key) => gold.has(key)) ? 1 : 0);
    }
    const relAll = [];
    const seenAll = new Set();
    for (const d of corpus) {
      const dk = dedupeKey(d);
      if (seenAll.has(dk)) continue;
      seenAll.add(dk);
      relAll.push(keysOf(d).some((key) => gold.has(key)) ? 1 : 0);
    }

    out[`k${k}`] = {
      recallAny: gold.size === 0 ? null : got.size > 0 ? 1 : 0,
      recallAll: gold.size === 0 ? null : got.size === gold.size ? 1 : 0,
      recallMean: gold.size === 0 ? null : got.size / gold.size,
      ndcgAny: gold.size === 0 ? null : ndcgAt(relRanked, relAll, granularity === "session" ? eff : k),
      answerInContext:
        !answer || answer.length === 0
          ? null
          : prefix.some((d) => answer.some((a) => containsAnswer(a, d.content)))
            ? 1
            : 0,
    };
  }
  return out;
}

function mean(values) {
  const nums = values.filter((v) => typeof v === "number");
  return nums.length === 0 ? null : nums.reduce((a, b) => a + b, 0) / nums.length;
}

/** 汇总：overall（含 adversarial）/ nonAdversarial（category 1–4）/ byCategory */
export function summarize(rows, ks) {
  const agg = (rs) => {
    const block = { n: rs.length, byK: {} };
    for (const k of ks) {
      const key = `k${k}`;
      block.byK[key] = {
        recallAny: mean(rs.map((r) => r.metrics[key].recallAny)),
        recallAll: mean(rs.map((r) => r.metrics[key].recallAll)),
        recallMean: mean(rs.map((r) => r.metrics[key].recallMean)),
        ndcgAny: mean(rs.map((r) => r.metrics[key].ndcgAny)),
        answerInContext: mean(rs.map((r) => r.metrics[key].answerInContext)),
      };
    }
    return block;
  };
  const byCategory = {};
  for (const c of [...new Set(rows.map((r) => r.category))].sort((a, b) => a - b)) {
    const label = CATEGORY_LABEL[c] ?? "unknown";
    byCategory[`${c}:${label}`] = agg(rows.filter((r) => r.category === c));
  }
  return {
    overall: agg(rows),
    nonAdversarial: agg(rows.filter((r) => r.category !== 5)),
    byCategory,
  };
}

/* ------------------------------------------------------------------ */
/* BM25 基线（同数据、同口径）                                          */
/* ------------------------------------------------------------------ */

/** 一段对话建一次索引：df / tf / avgdl 只跟文档集合有关，题目之间共享 */
export function buildBm25Index(docs) {
  const tokenized = docs.map((d) => normalizeEn(d.content));
  const df = new Map();
  const tfs = tokenized.map((toks) => {
    const tf = new Map();
    for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    return tf;
  });
  const avgdl = tokenized.reduce((a, t) => a + t.length, 0) / (tokenized.length || 1);
  return { docs, tokenized, df, tfs, avgdl: avgdl || 1, n: docs.length };
}

/** BM25 排序（k1=1.2, b=0.75，与 src/core/score.ts 的默认值一致） */
export function bm25Rank(index, queryTokens, topN, k1 = 1.2, b = 0.75) {
  const q = [...new Set(queryTokens)];
  const idf = (t) => {
    const n = index.df.get(t) ?? 0;
    return Math.log(1 + (index.n - n + 0.5) / (n + 0.5));
  };
  const scored = index.docs.map((doc, i) => {
    const tf = index.tfs[i];
    const dl = index.tokenized[i].length || 1;
    let s = 0;
    for (const t of q) {
      const f = tf.get(t) ?? 0;
      if (f === 0) continue;
      s += idf(t) * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * dl) / index.avgdl)));
    }
    return { doc, score: s, i };
  });
  scored.sort((x, y) => y.score - x.score || x.i - y.i);
  return scored.slice(0, topN).filter((x) => x.score > 0);
}

/* ------------------------------------------------------------------ */
/* 数据与库                                                            */
/* ------------------------------------------------------------------ */

function loadDataset(file) {
  const abs = resolve(file);
  if (!existsSync(abs)) usageFail(`数据集不存在：${abs}`);
  const parsed = JSON.parse(readFileSync(abs, "utf8").replace(/^\uFEFF/, ""));
  if (!Array.isArray(parsed)) usageFail("数据集不是 JSON 数组");
  return parsed;
}

function selectSamples(data, opts) {
  let list = data;
  if (opts.ids) {
    const want = new Set(String(opts.ids).split(",").map((x) => x.trim()).filter(Boolean));
    list = list.filter((x) => want.has(String(x.sample_id)));
  }
  if (opts.convs !== undefined) list = list.slice(0, Math.max(0, Number(opts.convs)));
  return list;
}

const libEntry = join(root, "lib", "index.js");

async function loadService() {
  if (!existsSync(libEntry)) {
    process.stderr.write("[locomo] lib/index.js 不存在，先 build ...\n");
    const r = spawnSync(process.execPath, [join(root, "scripts", "build.mjs")], { stdio: "inherit" });
    if (r.status !== 0) process.exit(r.status ?? 1);
  }
  return import(pathToFileURL(libEntry).href);
}

/**
 * 写库。returned { idMap, aliases, rejected, deduped }：
 * 精确去重会让两条相同文本落到同一个记忆 id，这里把被合并掉的 dia_id 记进 aliases
 * 让评测时那条记忆同时算作两个轮次命中（否则 gold 会无故变成不可达）。
 */
async function ingestDocs(service, env, docs, opts) {
  const idMap = new Map();
  const aliases = new Map();
  const rejected = [];
  let deduped = 0;
  const normalize = opts.normalize !== "none";
  for (let i = 0; i < docs.length; i += 1) {
    const doc = docs[i];
    const input = { level: LEVEL, project: opts.project, content: doc.content };
    if (normalize) input.keywords = normalizeEn(doc.content);
    let out;
    try {
      out = await service.remember(input, "human", { sessionId: opts.sessionId, turn: i + 1 });
    } catch (e) {
      rejected.push({ docId: doc.docId, reason: String(e?.message ?? e).slice(0, 160), snippet: doc.content.slice(0, 80) });
      continue;
    }
    if (!out?.ok) {
      rejected.push({
        docId: doc.docId,
        reason: String(out?.code ?? out?.verdict ?? out?.message ?? "unknown").slice(0, 160),
        snippet: doc.content.slice(0, 80),
      });
      continue;
    }
    if (!out.id) continue;
    if (out.deduped) {
      deduped += 1;
      const key = opts.granularity === "session" ? doc.sid : doc.docId;
      const list = aliases.get(out.id) ?? [];
      if (!list.includes(key)) list.push(key);
      aliases.set(out.id, list);
      continue;
    }
    idMap.set(out.id, doc);
    if (doc.ts !== undefined) {
      env.db.prepare(`UPDATE ${LEVEL} SET created_at = ?, updated_at = ? WHERE id = ?`).run(doc.ts, doc.ts, out.id);
    }
  }
  return { idMap, aliases, rejected, deduped };
}

function buildContext(hits, maxChars) {
  const parts = [];
  let used = 0;
  for (const h of hits) {
    const tag = h.doc.docId;
    const line = `[${tag}] ${h.doc.content}`;
    if (used + line.length + 1 > maxChars) break;
    parts.push(line);
    used += line.length + 1;
  }
  return parts.join("\n");
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
  if (cmd !== "run") usageFail(`未知命令：${cmd}`);

  const granularity = opts.granularity ?? "turn";
  if (!["turn", "session"].includes(granularity)) usageFail("--granularity 只支持 turn | session");
  const normalize = opts.normalize ?? "en";
  if (!["en", "none"].includes(normalize)) usageFail("--normalize 只支持 en | none");
  const baseline = opts.baseline ?? "none";
  if (!["none", "bm25"].includes(baseline)) usageFail("--baseline 只支持 none | bm25");
  const prior = opts.prior ?? "on";
  if (!["on", "off"].includes(prior)) usageFail("--prior 只支持 on | off");
  const ks = String(opts.ks ?? "5,10")
    .split(",")
    .map((x) => Math.max(1, Number(x.trim())))
    .filter((x) => Number.isFinite(x));
  const maxK = Math.max(...ks);
  const limit = Math.max(maxK, Number(opts.limit ?? maxK));
  const categories = opts.category
    ? new Set(String(opts.category).split(",").map((x) => Number(x.trim())).filter((x) => Number.isFinite(x)))
    : null;
  const maxQuestions = opts["max-questions"] !== undefined ? Math.max(0, Number(opts["max-questions"])) : null;
  const maxContext = Math.max(200, Number(opts["max-context-chars"] ?? 6000));
  const log = opts.quiet ? () => {} : (m) => process.stderr.write(m + "\n");

  const data = loadDataset(opts.data ?? usageFail("缺少 --data <file>"));
  const samples = selectSamples(data, opts);
  if (samples.length === 0) usageFail("筛选后没有对话");

  const dbRoot = opts.db ? resolve(opts.db) : join(tmpdir(), "memweave-locomo");
  if (opts.db) rmSync(dbRoot, { recursive: true, force: true });
  mkdirSync(dbRoot, { recursive: true });
  if (opts.out) writeFileSync(resolve(opts.out), "");
  const started = Date.now();
  const startedIso = new Date().toISOString();
  const qaConfig = resolveQaConfig(opts);
  const qaPipeline = createQaPipeline(qaConfig);
  if (qaPipeline) {
    log(`[locomo] QA 已启用：reader=${qaConfig.mode} judge=${qaConfig.judgeMode} model=${qaConfig.model}`);
  }

  const { openService } = await loadService();
  const rows = [];
  const baseRows = [];
  let docsTotal = 0;
  let truncatedTotal = 0;
  let rejectedTotal = 0;
  let dedupedTotal = 0;
  let questioned = 0;
  let skippedNoEvidence = 0;
  const rejectedReasons = {};
  const rejectedSamples = [];

  for (let si = 0; si < samples.length; si += 1) {
    const sample = samples[si];
    const sampleId = String(sample.sample_id);
    const docs = buildDocs(sample, { granularity });
    docsTotal += docs.length;
    truncatedTotal += docs.filter((d) => d.truncated).length;
    if (docs.length === 0) {
      log(`[locomo] ${sampleId} 没有可写入的发言，跳过`);
      continue;
    }

    const dbDir = join(dbRoot, "c" + si);
    rmSync(dbDir, { recursive: true, force: true });
    mkdirSync(dbDir, { recursive: true });
    const rt = openService(dbDir, benchConfig({ "half-life-days": opts["half-life-days"] ?? 100000, prior }));
    try {
      const { idMap, aliases, rejected, deduped } = await ingestDocs(rt.service, rt.env, docs, {
        normalize,
        project: sampleId,
        sessionId: sampleId,
        granularity,
      });
      rejectedTotal += rejected.length;
      dedupedTotal += deduped;
      for (const r of rejected) {
        rejectedReasons[r.reason] = (rejectedReasons[r.reason] ?? 0) + 1;
        if (rejectedSamples.length < 10) rejectedSamples.push({ sampleId, ...r });
      }
      if (rejected.length > 0) log(`[locomo] ${sampleId} 拒写 ${rejected.length} 条：${rejected[0].reason}`);

      // 基线索引只用真正写进去的文档，保证与 MemWeave 的候选池一致
      const ingestedDocs = [...idMap.values()];
      const bm25 = baseline === "bm25" ? buildBm25Index(ingestedDocs) : null;
      const extraByDocId = new Map();
      for (const [id, extra] of aliases) {
        const primary = idMap.get(id);
        if (primary) extraByDocId.set(primary.docId, extra);
      }

      // gold 的合法键空间取「切分后的全部文档」，含被拒写的条目：
      // 被拒写的 gold 天然不可达，应当算漏，而不是从分母里消失
      const validKeys = new Set(docs.map((d) => unitKey(d.docId, granularity).replace(/#\d+$/, "")));

      let asked = 0;
      const sampleRows = [];
      for (const q of sample.qa ?? []) {
        if (categories && !categories.has(Number(q.category))) continue;
        if (maxQuestions !== null && asked >= maxQuestions) break;

        const gold = new Set(
          parseEvidence(q.evidence)
            .map((id) => unitKey(id, granularity))
            .filter((key) => validKeys.has(key)),
        );
        if (gold.size === 0) {
          skippedNoEvidence += 1;
          continue;
        }
        asked += 1;
        questioned += 1;

        const query = normalize === "en" ? normalizeEn(q.question).join(" ") : String(q.question);
        const hits = rt.service
          .recall(query, { limit, project: sampleId })
          .map((h) => {
            const doc = idMap.get(h.entry.id);
            if (!doc) return null;
            const keys =
              granularity === "session"
                ? [doc.sid]
                : [doc.docId, ...((aliases.get(h.entry.id) ?? []).filter((x) => x !== doc.docId))];
            return { doc: { ...doc, keys }, score: h.score };
          })
          .filter(Boolean);

        // category 5 是 adversarial（提问前提为假）：官方只给 adversarial_answer
        // 445/446 没有 answer，剩下 2 条属于标注残留，一律不参与 answer_in_context。
        const category = Number(q.category);
        const answerText =
          category === 5 ? null : Array.isArray(q.answer) ? q.answer : q.answer ? [String(q.answer)] : null;
        const metrics = evaluateQuestion(gold, hits, docs, ks, { granularity, answer: answerText });

        const row = {
          sampleId,
          question: q.question,
          answer: q.answer ?? null,
          adversarialAnswer: q.adversarial_answer ?? null,
          category: Number(q.category),
          goldKeys: [...gold],
          docs: docs.length,
          hits: hits.map((h) => ({ docId: h.doc.docId, score: Number(h.score.toFixed(6)) })),
          context: buildContext(hits, maxContext),
          metrics,
        };
        rows.push(row);
        sampleRows.push(row);

        if (bm25) {
          const bmHits = bm25Rank(bm25, normalizeEn(q.question), limit).map((x) => ({
            doc: {
              ...x.doc,
              keys:
                granularity === "session"
                  ? [x.doc.sid]
                  : [x.doc.docId, ...(extraByDocId.get(x.doc.docId) ?? [])],
            },
            score: x.score,
          }));
          baseRows.push({
            sampleId,
            category: Number(q.category),
            metrics: evaluateQuestion(gold, bmHits, ingestedDocs, ks, { granularity, answer: answerText }),
          });
        }
      }
      if (opts.out) {
        for (const r of sampleRows) appendFileSync(resolve(opts.out), JSON.stringify(r) + "\n");
      }
    } finally {
      try {
        rt.env.close();
      } catch {
        // 忽略关库失败
      }
      if (!(opts["keep-db"] && si === samples.length - 1)) rmSync(dbDir, { recursive: true, force: true });
    }
    log(`[locomo] ${si + 1}/${samples.length} ${sampleId} 文档=${docs.length} 题=${sample.qa?.length ?? 0}`);
  }

  const elapsedSec = Math.round((Date.now() - started) / 1000);
  let qaBlock = null;
  if (qaPipeline) {
    // category 5 是 adversarial（前提为假），没有可判分的 gold：与 answer_in_context 一样排除
    const eligible = rows.filter((r) => {
      if (Number(r.category) === 5) return false;
      return Array.isArray(r.answer) ? r.answer.length > 0 : Boolean(r.answer);
    });
    const selected = qaConfig.limit ? eligible.slice(0, qaConfig.limit) : eligible;
    const items = selected.map((r, i) => ({
      id: `${r.sampleId}#${i}`,
      question: r.question,
      answer: r.answer,
      context: r.context,
      bucket: String(r.category),
    }));
    items.bucketBy = "category";
    items.requested = eligible.length;
    const qaStarted = Date.now();
    const { records, summary: qaSummary } = await runQa(items, qaPipeline);
    qaBlock = buildQaReport({
      config: qaConfig,
      summary: qaSummary,
      items,
      elapsedSec: Math.round((Date.now() - qaStarted) / 1000),
    });
    qaBlock.skipped = rows.length - eligible.length;
    if (opts["qa-out"]) {
      const abs = resolve(opts["qa-out"]);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, records.map((r) => JSON.stringify(r) + "\n").join(""));
    }
    log(`[locomo] QA 完成：${records.length} 题，用时 ${qaBlock.elapsedSec}s`);
  }
  const summary = summarize(rows, ks);
  const report = {
    dataset: resolve(opts.data),
    startedAt: startedIso,
    granularity,
    normalize,
    prior,
    limit,
    ks,
    conversations: samples.length,
    questions: questioned,
    skippedNoEvidence,
    docs: docsTotal,
    truncatedDocs: truncatedTotal,
    rejectedDocs: rejectedTotal,
    rejectedReasons,
    rejectedSamples,
    dedupedDocs: dedupedTotal,
    elapsedSec,
    ...(qaBlock ? { qa: qaBlock } : {}),
    ...summary,
  };
  if (baseline === "bm25") {
    report.baseline = { kind: "bm25", ...summarize(baseRows, ks) };
  }
  if (opts.report) {
    const abs = resolve(opts.report);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, JSON.stringify(report, null, 2) + "\n");
    log(`[locomo] 汇总已写入 ${abs}`);
  }
  if (!opts.db) rmSync(dbRoot, { recursive: true, force: true });

  const pct = (v) => (v === null || v === undefined ? "-" : (v * 100).toFixed(1) + "%");
  console.log(
    `[locomo] ${granularity}/norm=${normalize} 对话=${samples.length} 题数=${report.questions}` +
      ` 文档=${report.docs} 截断=${report.truncatedDocs} 拒写=${report.rejectedDocs} 去重=${report.dedupedDocs} 用时=${elapsedSec}s`,
  );
  const blocks = [
    ["all", report.overall],
    ["cat1-4", report.nonAdversarial],
    ...Object.entries(report.byCategory).map(([name, block]) => [name, block]),
  ];
  for (const [name, block] of blocks) {
    if (!block || block.n === 0) continue;
    for (const k of ks) {
      const m = block.byK[`k${k}`];
      console.log(
        `[locomo] ${name}@${k} n=${block.n}: recall_any=${pct(m.recallAny)} recall_all=${pct(m.recallAll)}` +
          ` recall_mean=${pct(m.recallMean)} ndcg=${pct(m.ndcgAny)} ans_in_ctx=${pct(m.answerInContext)}`,
      );
    }
  }
  if (report.baseline) {
    for (const k of ks) {
      const m = report.baseline.overall.byK[`k${k}`];
      console.log(
        `[locomo] bm25@${k}: recall_any=${pct(m.recallAny)} recall_all=${pct(m.recallAll)}` +
          ` recall_mean=${pct(m.recallMean)} ndcg=${pct(m.ndcgAny)} ans_in_ctx=${pct(m.answerInContext)}`,
      );
    }
  }
  if (report.skippedNoEvidence > 0) console.log(`[locomo] 跳过无 evidence / evidence 全脏：${report.skippedNoEvidence} 题`);
  if (report.qa) {
    console.log(formatQaLine("locomo", report.qa.overall));
    for (const [name, block] of Object.entries(report.qa.byBucket ?? {})) {
      if (name === "all") continue;
      console.log(formatQaLine("locomo", block, `QA cat${name}`));
    }
    if (report.qa.limit) {
      console.log(`[locomo] QA 仅覆盖前 ${report.qa.limit} 题（--qa-limit），与检索指标的分母不同`);
    }
  }
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((e) => {
    console.error("[locomo] 失败：", e?.stack ?? e);
    process.exit(2);
  });
}
