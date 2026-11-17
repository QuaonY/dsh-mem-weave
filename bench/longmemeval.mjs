#!/usr/bin/env node
/**
 * LongMemEval 跑分器（零依赖）
 * 数据集来自 https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned
 *   longmemeval_oracle.json  —— 只含证据会话（冒烟用，检索几乎白送）
 *   longmemeval_s_cleaned.json —— 每个问题约 40 个会话（真实检索基准）
 * 做法：每个问题独立建一个临时库（会话即记忆），写入后按官方方式算
 * session-level recall_all / ndcg_any，turn 粒度时另算 turn-level 与 turn→session 指标。
 * 指标实现对齐官方 src/retrieval/eval_utils.py。
 * 用法：
 *   node bench/longmemeval.mjs run --data data/longmemeval_oracle.json
 *   node bench/longmemeval.mjs run --data data/longmemeval_s_cleaned.json --samples 50 --out rows.jsonl
 *   node bench/longmemeval.mjs run --data ... --granularity turn --samples 10
 * 参数：
 *   --data <file>              数据集 JSON（必需）
 *   --granularity session|turn 记忆粒度，默认 session（一个会话一条记忆，过长按 1900 字切块）
 *   --roles both|user          写入哪些角色的发言，默认 user（与官方语料一致）
 *   --samples <n>              只跑前 n 个问题
 *   --ids q1,q2                只跑指定 question_id
 *   --type <type>              只跑指定 question_type
 *   --limit <n>                召回条数，默认 10（至少要到 max(ks)）
 *   --ks 5,10                  评估的 k 列表，默认 5,10
 *   --normalize en|none        英文词形归一，默认 en
 *   --half-life-days <n>       衰减半衰期，默认 100000
 *   --max-context-chars <n>    每条结果导出的上下文字符上限，默认 6000
 *   --db <dir>                 指定库目录（默认临时目录，跑完删除）
 *   --keep-db                  保留最后一次的库
 *   --out <file>               每题结果 JSONL
 *   --report <file>            汇总指标 JSON
 *   --qa <off|extractive|http> QA 评测的 reader，默认 off
 *   --qa-judge <heuristic|llm|both>  QA 判分方式，默认 heuristic
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
import { buildQaReport, createQaPipeline, formatQaLine, resolveQaConfig, runQa } from "./qa.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const CHUNK = 1900;
const LEVEL = "topic";

/* ------------------------------------------------------------------ */
/* 参数                                                                */
/* ------------------------------------------------------------------ */

const USAGE = `LongMemEval 跑分器（零依赖）

  node bench/longmemeval.mjs run --data <longmemeval_*.json> [选项]

  --granularity session|turn   默认 session
  --roles both|user            默认 user（官方语料只用用户发言）
  --samples <n>                只跑前 n 题
  --ids <id,id>                只跑指定题目
  --type <question_type>       只跑某类题目
  --limit <n>                  召回条数，默认 10
  --ks 5,10                    评估 k，默认 5,10
  --normalize en|none          默认 en
  --half-life-days <n>         默认 100000
  --max-context-chars <n>      默认 6000
  --db <dir> / --keep-db       库目录
  --out <file> / --report <file>
  --qa <off|extractive|http>   QA reader，默认 off
  --qa-judge <heuristic|llm|both>  默认 heuristic
  --qa-model / --qa-judge-model / --qa-base-url / --qa-api-key-env
  --qa-concurrency / --qa-timeout-ms / --qa-max-context-chars / --qa-limit
  --qa-out <file>
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
      case "roles":
      case "samples":
      case "ids":
      case "type":
      case "limit":
      case "ks":
      case "normalize":
      case "half-life-days":
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
  console.error(`[lme] ${message}\n`);
  console.error(USAGE);
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/* 指标（对齐官方 eval_utils.py）                                      */
/* ------------------------------------------------------------------ */

export function dcg(relevances, k) {
  const rel = relevances.slice(0, k);
  if (rel.length === 0) return 0;
  let sum = rel[0];
  for (let i = 1; i < rel.length; i += 1) sum += rel[i] / Math.log2(i + 1);
  return sum;
}

/** ndcg：relevance 按「文档是否属于 gold 会话」算，排名取前 k（可用 effectiveK 扩展） */
export function ndcgAt(rankedRelevance, allRelevance, k) {
  const ideal = [...allRelevance].sort((a, b) => b - a);
  const idealDcg = dcg(ideal, k);
  if (idealDcg === 0) return 0;
  return dcg(rankedRelevance, k) / idealDcg;
}

/**
 * turn 粒度 → session 粒度：官方做法是先把排名里的会话去重
 * 若前 k 个文档去重后不足 k 个会话，就继续往后取，直到凑够 k 个会话或取完。
 * 返回实际参与评估的前缀长度。
 */
export function effectiveSessionK(sessionIdsInRankOrder, k) {
  let effectiveK = Math.min(k, sessionIdsInRankOrder.length);
  const unique = new Set(sessionIdsInRankOrder.slice(0, effectiveK));
  while (effectiveK < sessionIdsInRankOrder.length && unique.size < k) {
    unique.add(sessionIdsInRankOrder[effectiveK]);
    effectiveK += 1;
  }
  return effectiveK;
}

/* ------------------------------------------------------------------ */
/* 数据                                                                */
/* ------------------------------------------------------------------ */

function loadDataset(file) {
  const abs = resolve(file);
  if (!existsSync(abs)) usageFail(`数据集不存在：${abs}`);
  const parsed = JSON.parse(readFileSync(abs, "utf8").replace(/^\uFEFF/, ""));
  if (!Array.isArray(parsed)) usageFail("数据集不是 JSON 数组");
  return parsed;
}

function parseSessionDate(s) {
  const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})(?:.*?(\d{1,2}):(\d{2}))?/.exec(String(s ?? ""));
  if (!m) return undefined;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0));
  const t = d.getTime();
  return Number.isFinite(t) ? t : undefined;
}

function selectInstances(data, opts) {
  let list = data;
  if (opts.ids) {
    const want = new Set(String(opts.ids).split(",").map((x) => x.trim()).filter(Boolean));
    list = list.filter((x) => want.has(x.question_id));
  }
  if (opts.type) list = list.filter((x) => x.question_type === opts.type);
  if (opts.samples !== undefined) list = list.slice(0, Math.max(0, Number(opts.samples)));
  return list;
}

function isAbstention(inst) {
  return String(inst.question_id).includes("_abs");
}

/* ------------------------------------------------------------------ */
/* 写入文档                                                            */
/* ------------------------------------------------------------------ */

/**
 * 把一道题的历史会话拆成记忆文档。
 * session：一个会话一条；超过 MAX_CONTENT 时按会话内发言边界切块，仍超长则硬截断。
 * turn：一条发言一条（turn 序号与官方一致，从 1 开始）。
 */
export function buildDocs(inst, opts) {
  const roles = opts.roles === "both" ? new Set(["user", "assistant"]) : new Set(["user"]);
  const docs = [];
  const sessions = Array.isArray(inst.haystack_sessions) ? inst.haystack_sessions : [];
  const ids = Array.isArray(inst.haystack_session_ids) ? inst.haystack_session_ids : [];
  const dates = Array.isArray(inst.haystack_dates) ? inst.haystack_dates : [];
  for (let si = 0; si < sessions.length; si += 1) {
    const sid = String(ids[si] ?? `session_${si + 1}`);
    const ts = parseSessionDate(dates[si]);
    const turns = Array.isArray(sessions[si]) ? sessions[si] : [];
    if (opts.granularity === "turn") {
      for (let ti = 0; ti < turns.length; ti += 1) {
        const t = turns[ti];
        if (!t || !roles.has(t.role)) continue;
        const content = String(t.content ?? "").trim();
        if (!content) continue;
        docs.push({
          sid,
          ts,
          turn: ti + 1,
          docId: `${sid}_${ti + 1}`,
          gold: t.has_answer === true,
          content: content.length > CHUNK ? content.slice(0, CHUNK) : content,
          truncated: content.length > CHUNK,
        });
      }
      continue;
    }
    // session：保留发言边界，按 1900 字切块
    let buf = "";
    let part = 0;
    const flush = () => {
      const content = buf.trim();
      if (!content) return;
      part += 1;
      docs.push({ sid, ts, turn: 0, docId: part === 1 ? sid : `${sid}#${part}`, gold: false, content, truncated: false });
      buf = "";
    };
    for (const t of turns) {
      if (!t || !roles.has(t.role)) continue;
      const text = String(t.content ?? "").trim();
      if (!text) continue;
      if (text.length > CHUNK) {
        flush();
        const hard = text.slice(0, CHUNK);
        part += 1;
        docs.push({ sid, ts, turn: 0, docId: `${sid}#${part}`, gold: false, content: hard, truncated: true });
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
/* 对外流程                                                            */
/* ------------------------------------------------------------------ */

const libEntry = join(root, "lib", "index.js");

async function loadService() {
  if (!existsSync(libEntry)) {
    process.stderr.write("[lme] lib/index.js 不存在，先 build ...\n");
    const r = spawnSync(process.execPath, [join(root, "scripts", "build.mjs")], { stdio: "inherit" });
    if (r.status !== 0) process.exit(r.status ?? 1);
  }
  return import(pathToFileURL(libEntry).href);
}

async function ingestDocs(service, env, docs, opts) {
  const idMap = new Map();
  const rejected = [];
  let deduped = 0;
  const normalize = opts.normalize !== "none";
  for (let i = 0; i < docs.length; i += 1) {
    const doc = docs[i];
    const input = { level: LEVEL, project: doc.projectId, content: doc.content };
    if (normalize) input.keywords = normalizeEn(doc.content);
    let out;
    try {
      out = await service.remember(input, "human", { sessionId: "lme", turn: i + 1 });
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
    if (out.deduped) deduped += 1;
    if (!out.id) continue;
    idMap.set(out.id, doc);
    if (doc.ts !== undefined) {
      env.db.prepare(`UPDATE ${LEVEL} SET created_at = ?, updated_at = ? WHERE id = ?`).run(doc.ts, doc.ts, out.id);
    }
  }
  return { idMap, rejected, deduped };
}

function buildContext(hits, maxChars) {
  const parts = [];
  let used = 0;
  for (const h of hits) {
    const line = `[${h.doc.sid}] ${h.doc.content}`;
    if (used + line.length + 1 > maxChars) break;
    parts.push(line);
    used += line.length + 1;
  }
  return parts.join("\n");
}

function evaluateInstance(inst, hits, corpus, ks) {
  const rankedDocs = hits.map((h) => h.doc);
  const goldSids = new Set((inst.answer_session_ids ?? []).map(String));
  const allSids = [...new Set(corpus.map((d) => d.sid))];
  const rankedSids = rankedDocs.map((d) => d.sid);
  const out = { session: {}, turn: null };

  for (const k of ks) {
    // session-level：rank 里的文档按会话去重；不足 k 个会话时按官方做法扩展
    const eff = effectiveSessionK(rankedSids, k);
    const prefix = rankedDocs.slice(0, eff);
    const seen = new Set();
    const recalled = new Set();
    for (const d of prefix) {
      if (seen.has(d.sid)) continue;
      seen.add(d.sid);
      if (goldSids.has(d.sid)) recalled.add(d.sid);
    }
    const recallAny = goldSids.size === 0 ? null : recalled.size > 0 ? 1 : 0;
    const recallAll = goldSids.size === 0 ? null : recalled.size === goldSids.size ? 1 : 0;
    const relRanked = prefix.map((d) => (goldSids.has(d.sid) ? 1 : 0));
    const relAll = corpus.map((d) => (goldSids.has(d.sid) ? 1 : 0));
    out.session[`k${k}`] = {
      recallAny,
      recallAll,
      ndcgAny: goldSids.size === 0 ? null : ndcgAt(relRanked, relAll, eff),
      effectiveK: eff,
    };
  }

  if (corpus.some((d) => d.turn > 0)) {
    const goldTurns = new Set(corpus.filter((d) => d.gold).map((d) => d.docId));
    out.turn = {};
    for (const k of ks) {
      const prefix = rankedDocs.slice(0, k);
      const recalled = new Set(prefix.map((d) => d.docId).filter((id) => goldTurns.has(id)));
      const relRanked = prefix.map((d) => (goldTurns.has(d.docId) ? 1 : 0));
      const relAll = corpus.map((d) => (goldTurns.has(d.docId) ? 1 : 0));
      out.turn[`k${k}`] = {
        recallAny: goldTurns.size === 0 ? null : recalled.size > 0 ? 1 : 0,
        recallAll: goldTurns.size === 0 ? null : recalled.size === goldTurns.size ? 1 : 0,
        ndcgAny: goldTurns.size === 0 ? null : ndcgAt(relRanked, relAll, k),
      };
    }
  }
  return out;
}

function mean(values) {
  const nums = values.filter((v) => typeof v === "number");
  return nums.length === 0 ? null : nums.reduce((a, b) => a + b, 0) / nums.length;
}

function summarize(rows, ks) {
  const stats = {};
  for (const scope of ["session", "turn"]) {
    const graded = rows.filter((r) => r.metrics[scope]);
    if (graded.length === 0) continue;
    stats[scope] = { n: graded.length, byK: {} };
    for (const k of ks) {
      stats[scope].byK[`k${k}`] = {
        recallAny: mean(graded.map((r) => r.metrics[scope][`k${k}`].recallAny)),
        recallAll: mean(graded.map((r) => r.metrics[scope][`k${k}`].recallAll)),
        ndcgAny: mean(graded.map((r) => r.metrics[scope][`k${k}`].ndcgAny)),
      };
    }
  }
  const byType = {};
  for (const r of rows) {
    const t = r.questionType ?? "unknown";
    byType[t] ??= { n: 0, session: {}, turn: {} };
    const bucket = byType[t];
    bucket.n += 1;
    for (const scope of ["session", "turn"]) {
      if (!r.metrics[scope]) continue;
      for (const k of ks) {
        const key = `k${k}`;
        bucket[scope][key] ??= { recallAny: [], recallAll: [], ndcgAny: [] };
        bucket[scope][key].recallAny.push(r.metrics[scope][key].recallAny);
        bucket[scope][key].recallAll.push(r.metrics[scope][key].recallAll);
        bucket[scope][key].ndcgAny.push(r.metrics[scope][key].ndcgAny);
      }
    }
  }
  const flatByType = {};
  for (const [t, b] of Object.entries(byType)) {
    const item = { n: b.n, session: {}, turn: {} };
    for (const scope of ["session", "turn"]) {
      for (const [k, acc] of Object.entries(b[scope])) {
        item[scope][k] = {
          recallAny: mean(acc.recallAny),
          recallAll: mean(acc.recallAll),
          ndcgAny: mean(acc.ndcgAny),
        };
      }
    }
    flatByType[t] = item;
  }
  return { overall: stats, byType: flatByType };
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
  const granularity = opts.granularity ?? "session";
  if (!["session", "turn"].includes(granularity)) usageFail("--granularity 只支持 session | turn");
  const roles = opts.roles ?? "user";
  if (!["both", "user"].includes(roles)) usageFail("--roles 只支持 both | user");
  const normalize = opts.normalize ?? "en";
  if (!["en", "none"].includes(normalize)) usageFail("--normalize 只支持 en | none");
  const ks = String(opts.ks ?? "5,10")
    .split(",")
    .map((x) => Math.max(1, Number(x.trim())))
    .filter((x) => Number.isFinite(x));
  const maxK = Math.max(...ks);
  const limit = Math.max(maxK, Number(opts.limit ?? maxK));
  const log = opts.quiet ? () => {} : (m) => process.stderr.write(m + "\n");

  const data = loadDataset(opts.data ?? usageFail("缺少 --data <file>"));
  const instances = selectInstances(data, opts);
  if (instances.length === 0) usageFail("筛选后没有题目");

  const dbRoot = opts.db ? resolve(opts.db) : join(tmpdir(), "memweave-lme");
  if (opts.db) rmSync(dbRoot, { recursive: true, force: true });
  mkdirSync(dbRoot, { recursive: true });
  if (opts.out) writeFileSync(resolve(opts.out), "");
  const started = Date.now();

  const { openService } = await loadService();
  const rows = [];
  let docsTotal = 0;
  let truncatedTotal = 0;
  let rejectedTotal = 0;
  let dedupedTotal = 0;
  let skippedAbstention = 0;
  const rejectedReasons = {};
  const rejectedSamples = [];
  const startedIso = new Date().toISOString();
  const qaConfig = resolveQaConfig(opts);
  const qaPipeline = createQaPipeline(qaConfig);
  if (qaPipeline) {
    log(`[lme] QA 已启用：reader=${qaConfig.mode} judge=${qaConfig.judgeMode} model=${qaConfig.model}`);
  }

  for (let i = 0; i < instances.length; i += 1) {
    const inst = instances[i];
    if (isAbstention(inst) || (inst.answer_session_ids ?? []).length === 0) {
      skippedAbstention += 1;
      continue;
    }
    const dbDir = join(dbRoot, "q" + i);
    rmSync(dbDir, { recursive: true, force: true });
    mkdirSync(dbDir, { recursive: true });
    const docs = buildDocs(inst, { ...opts, granularity, roles }).map((d) => ({ ...d, projectId: String(inst.question_id) }));
    docsTotal += docs.length;
    truncatedTotal += docs.filter((d) => d.truncated).length;
    if (granularity === "session" && docs.length === 0 && (inst.haystack_sessions ?? []).length > 0) {
      // 只有 assistant 发言却被 --roles user 过滤掉时不会发生；这里只防呆
    }

    const rt = openService(dbDir, benchConfig({ "half-life-days": opts["half-life-days"] ?? 100000 }));
    let result;
    try {
      const { idMap, rejected, deduped } = await ingestDocs(rt.service, rt.env, docs, { normalize });
      rejectedTotal += rejected.length;
      dedupedTotal += deduped;
      for (const r of rejected) {
        rejectedReasons[r.reason] = (rejectedReasons[r.reason] ?? 0) + 1;
        if (rejectedSamples.length < 10) rejectedSamples.push({ questionId: inst.question_id, ...r });
      }
      if (rejected.length > 0 && i < 5) {
        for (const r of rejected.slice(0, 3)) log(`[lme] 拒写 ${inst.question_id} ${r.docId}: ${r.reason}`);
      }
      const query = normalize === "en" ? normalizeEn(inst.question).join(" ") : String(inst.question);
      const hits = rt.service.recall(query, { limit, project: String(inst.question_id) }).map((h) => {
        const doc = idMap.get(h.entry.id);
        return doc ? { doc, score: h.score } : null;
      }).filter(Boolean);
      const metrics = evaluateInstance(inst, hits, docs, ks);
      result = {
        questionId: inst.question_id,
        questionType: inst.question_type,
        question: inst.question,
        answer: inst.answer,
        questionDate: inst.question_date,
        goldSessionIds: inst.answer_session_ids ?? [],
        docs: docs.length,
        hits: hits.map((h) => ({ docId: h.doc.docId, sid: h.doc.sid, turn: h.doc.turn, score: Number(h.score.toFixed(6)) })),
        context: buildContext(hits, Math.max(200, Number(opts["max-context-chars"] ?? 6000))),
        metrics,
      };
    } finally {
      try {
        rt.env.close();
      } catch {
        // 忽略关库失败
      }
      if (!(opts["keep-db"] && i === instances.length - 1)) rmSync(dbDir, { recursive: true, force: true });
    }
    rows.push(result);
    if (opts.out) appendFileSync(resolve(opts.out), JSON.stringify(result) + "\n");
    if (!opts.quiet && (i + 1) % 20 === 0) {
      const s = rows[rows.length - 1].metrics.session?.[`k${maxK}`] ?? {};
      log(`[lme] ${i + 1}/${instances.length} 已跑，最近 recall_any@${maxK}=${s.recallAny}`);
    }
  }

  const summary = summarize(rows, ks);
  const elapsedSec = Math.round((Date.now() - started) / 1000);
  let qaBlock = null;
  if (qaPipeline) {
    const eligible = rows.filter((r) => {
      const golds = Array.isArray(r.answer) ? r.answer : r.answer === null || r.answer === undefined ? [] : [r.answer];
      return golds.some((g) => String(g).trim() !== "");
    });
    const selected = qaConfig.limit ? eligible.slice(0, qaConfig.limit) : eligible;
    const items = selected.map((r) => ({
      id: r.questionId,
      question: r.question,
      answer: r.answer,
      context: r.context,
      bucket: r.questionType ?? "unknown",
      questionDate: r.questionDate,
    }));
    items.bucketBy = "question_type";
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
    log(`[lme] QA 完成：${records.length} 题，用时 ${qaBlock.elapsedSec}s`);
  }
  const report = {
    dataset: resolve(opts.data),
    startedAt: startedIso,
    granularity,
    roles,
    normalize,
    limit,
    ks,
    instances: instances.length,
    evaluated: rows.length,
    skippedAbstention,
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
  if (opts.report) {
    const abs = resolve(opts.report);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, JSON.stringify(report, null, 2) + "\n");
    log(`[lme] 汇总已写入 ${abs}`);
  }
  if (!opts.db) rmSync(dbRoot, { recursive: true, force: true });

  const pct = (v) => (v === null || v === undefined ? "-" : (v * 100).toFixed(1) + "%");
  console.log(
    `[lme] ${granularity}/${roles}/norm=${normalize} 题数=${report.evaluated} 文档=${report.docs}` +
      ` 截断=${report.truncatedDocs} 拒写=${report.rejectedDocs} 去重=${report.dedupedDocs} 用时=${elapsedSec}s`,
  );
  for (const scope of ["session", "turn"]) {
    const s = report.overall?.[scope];
    if (!s) continue;
    for (const k of ks) {
      const m = s.byK[`k${k}`];
      console.log(
        `[lme] ${scope}@${k}: recall_any=${pct(m.recallAny)} recall_all=${pct(m.recallAll)} ndcg_any=${pct(m.ndcgAny)}`,
      );
    }
  }
  if (report.skippedAbstention > 0) console.log(`[lme] 跳过 abstention / 无 gold：${report.skippedAbstention} 题`);
  if (report.qa) {
    console.log(formatQaLine("lme", report.qa.overall));
    for (const [name, block] of Object.entries(report.qa.byBucket ?? {})) {
      if (name === "all") continue;
      console.log(formatQaLine("lme", block, `QA ${name}`));
    }
    if (report.qa.limit) {
      console.log(`[lme] QA 仅覆盖前 ${report.qa.limit} 题（--qa-limit），与检索指标的分母不同`);
    }
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((e) => {
    console.error("[lme] 失败：", e?.stack ?? e);
    process.exit(2);
  });
}

export { buildContext, evaluateInstance, parseSessionDate, summarize };
