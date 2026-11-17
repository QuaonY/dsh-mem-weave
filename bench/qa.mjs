#!/usr/bin/env node
/**
 * QA 评测管线（零依赖）：reader + judge
 * 为什么单独一层：`bench/locomo.mjs` 与 `bench/longmemeval.mjs` 量的是**检索指标**
 * （recall_any / nDCG / answer_in_context），不是答题准确率。外部系统（Mem0 / Zep）
 * 报的是 LoCoMo 官方 QA 准确率，两套口径不能直接比。这一层把「召回上下文 → 答案」
 * 补上，让 QA 数字单独记账。
 * 设计约束：
 * - **零运行时依赖**：HTTP 只走全局 `fetch` + `AbortController`，与 `src/store/embedding.ts` 同风格；
 * - **reader 与 judge 可替换**：确定性 reader（extractive）用于离线自测与下限基线
 *   HTTP reader 走 OpenAI 兼容 `/chat/completions`；
 * - **失败不当作答错**：请求失败记 `error`，从准确率分母里排除，绝不静默补 0；
 * - **数字可复现**：报告里记录 reader / judge 的模型名与判分方式，换模型就不是同一套数字。
 * 明确边界（写进报告与文档）：
 * - `extractive` reader 的准确率**不能**与 Mem0 / Zep 的官方数字比较；
 *   只有 `--qa http --qa-judge llm` 且 reader / judge 模型与对方一致时，才具备可比性；
 * - heuristic judge 是 F1 / 包含关系的代理判分，不等于人工或 LLM 判分。
 */

import { normalizeEn } from "./eval-adapter.mjs";

/* ------------------------------------------------------------------ */
/* 文本归一与判分                                                       */
/* ------------------------------------------------------------------ */

/** SQuAD / LoCoMo 官方口径的答案归一：小写、去标点、去冠词、压空白 */
export function normalizeAnswer(input) {
  return String(input ?? "")
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .replace(/\b(a|an|the)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 归一后的 token 序列；空串 → [] */
export function answerTokens(input) {
  const text = normalizeAnswer(input);
  return text ? text.split(" ") : [];
}

/** gold 统一成字符串数组：兼容 string / string[] / null */
export function goldAnswers(answer) {
  if (Array.isArray(answer)) return answer.map((x) => String(x)).filter((x) => x.trim() !== "");
  if (answer === null || answer === undefined) return [];
  const text = String(answer);
  return text.trim() === "" ? [] : [text];
}

/** token 级 F1（官方口径）；两侧都为空算 1，一侧为空算 0 */
export function tokenF1(predicted, gold) {
  const p = answerTokens(predicted);
  const g = answerTokens(gold);
  if (p.length === 0 && g.length === 0) return 1;
  if (p.length === 0 || g.length === 0) return 0;
  const remaining = new Map();
  for (const t of g) remaining.set(t, (remaining.get(t) ?? 0) + 1);
  let common = 0;
  for (const t of p) {
    const n = remaining.get(t) ?? 0;
    if (n > 0) {
      common += 1;
      remaining.set(t, n - 1);
    }
  }
  if (common === 0) return 0;
  const precision = common / p.length;
  const recall = common / g.length;
  return (2 * precision * recall) / (precision + recall);
}

/** 对多 gold 取最大 F1（LoCoMo 官方对多答案就是这么算的） */
export function bestF1(predicted, golds) {
  const list = goldAnswers(golds);
  if (list.length === 0) return null;
  let best = 0;
  for (const g of list) best = Math.max(best, tokenF1(predicted, g));
  return best;
}

/** 归一化后完全相等（多 gold 任一命中即 1） */
export function exactMatch(predicted, golds) {
  const list = goldAnswers(golds);
  if (list.length === 0) return null;
  const p = normalizeAnswer(predicted);
  return list.some((g) => normalizeAnswer(g) === p) ? 1 : 0;
}

/**
 * heuristic judge：F1 或包含关系达标即判对。
 * 只在没有 LLM judge 时用，报告里会标明 `judge=heuristic`。
 */
export function heuristicVerdict({ prediction, golds }, opts = {}) {
  const threshold = Number(opts.f1Threshold ?? 0.5);
  const list = goldAnswers(golds);
  if (list.length === 0) {
    return { correct: false, reason: "no gold answer" };
  }
  const norm = normalizeAnswer(prediction);
  if (norm === "") return { correct: false, reason: "empty prediction" };
  const pTokens = answerTokens(prediction);
  for (const g of list) {
    const gNorm = normalizeAnswer(g);
    if (gNorm === "") continue;
    if (norm === gNorm) return { correct: true, reason: "exact match" };
    const f1 = tokenF1(prediction, g);
    if (f1 >= threshold) return { correct: true, reason: `token F1 ${f1.toFixed(3)} >= ${threshold}` };
    // 包含关系要求 token 边界，避免 "cat" 命中 "concatenate"
    const gTokens = answerTokens(g);
    if (gTokens.length > 0 && containsRun(pTokens, gTokens)) {
      return { correct: true, reason: "gold tokens appear in answer" };
    }
  }
  return { correct: false, reason: "no gold answer matched" };
}

/** tokens 里是否连续出现 needle（按完整 token 比） */
function containsRun(tokens, needle) {
  if (needle.length === 0 || needle.length > tokens.length) return false;
  for (let i = 0; i + needle.length <= tokens.length; i += 1) {
    let ok = true;
    for (let j = 0; j < needle.length; j += 1) {
      if (tokens[i + j] !== needle[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

/**
 * 解析 LLM judge 的第一行裁决。
 * 认 CORRECT / INCORRECT / YES / NO / TRUE / FALSE；拿不准返回 null（记为判分失败，不算答错）。
 */
export function parseJudgeVerdict(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return null;
  const firstLine = raw.split(/\r?\n/)[0].toUpperCase();
  const head = firstLine.replace(/^[*_`#\s]+/, "");
  if (/^INCORRECT|^WRONG|^NO\b/.test(head)) return false;
  if (/^CORRECT|^YES\b|^TRUE\b/.test(head)) return true;
  // 第一行没有明确裁决时，容忍「The answer is correct」这类句式；
  // 但先匹配否定词，避免 "not correct" 被判对
  const lower = raw.toLowerCase();
  if (/\b(not|isn't|is not)\s+(correct|right|equivalent)\b/.test(lower)) return false;
  if (/\b(incorrect|wrong)\b/.test(lower)) return false;
  if (/\bcorrect\b/.test(lower)) return true;
  return null;
}

/* ------------------------------------------------------------------ */
/* 上下文与提示词                                                       */
/* ------------------------------------------------------------------ */

/** 按字符上限裁剪上下文（与跑分器的 `--max-context-chars` 同一个量纲） */
export function trimContext(context, maxChars) {
  const text = String(context ?? "");
  const cap = Number(maxChars);
  if (!Number.isFinite(cap) || cap <= 0 || text.length <= cap) return text;
  return text.slice(0, Math.max(0, Math.floor(cap)));
}

export const READER_SYSTEM_PROMPT =
  "You are a memory question-answering reader. Answer the question using ONLY the retrieved " +
  "memory context. Reply with the answer only: no explanation, no citations, no markdown. " +
  "If the context does not contain the answer, reply exactly with UNKNOWN.";

export const JUDGE_SYSTEM_PROMPT =
  "You grade a predicted answer against the gold answer for a memory benchmark question. " +
  "The predicted answer is CORRECT when it conveys the same fact as a gold answer, even with " +
  "different wording, extra units or a different date format. Partial answers that omit a " +
  "required element are INCORRECT. Reply with CORRECT or INCORRECT on the first line, then a " +
  "one-sentence reason on the second line.";

/** reader 的 chat messages */
export function buildReaderMessages({ question, context, questionDate, maxContextChars = 6000 }) {
  const trimmed = trimContext(context, maxContextChars);
  const dateLine = questionDate ? `\nThe question was asked on ${String(questionDate)}.` : "";
  return [
    { role: "system", content: READER_SYSTEM_PROMPT },
    {
      role: "user",
      content: `Retrieved memory:\n${trimmed || "(empty)"}\n\nQuestion: ${String(question ?? "")}${dateLine}\nAnswer:`,
    },
  ];
}

/** judge 的 chat messages；golds 已归一成字符串数组 */
export function buildJudgeMessages({ question, golds, prediction }) {
  const list = goldAnswers(golds);
  const goldBlock =
    list.length === 0
      ? "(no gold answer)"
      : list.length === 1
        ? list[0]
        : list.map((g, i) => `${i + 1}. ${g}`).join("\n");
  return [
    { role: "system", content: JUDGE_SYSTEM_PROMPT },
    {
      role: "user",
      content:
        `Question: ${String(question ?? "")}\n\n` +
        `Gold answer:\n${goldBlock}\n\n` +
        `Predicted answer: ${String(prediction ?? "")}\n\n` +
        `Verdict:`,
    },
  ];
}

/* ------------------------------------------------------------------ */
/* Reader / Judge 实现                                                  */
/* ------------------------------------------------------------------ */

/**
 * 抽取式 reader 的分词：英文用适配层的词干 + 去停用词（move / moved 归一）
 * 含中文时退回 `answerTokens` —— 适配层只切 `[a-z0-9]`，中文会被切没。
 */
function readerTokens(text) {
  const s = String(text ?? "");
  if (/[\u3400-\u9fff]/.test(s)) return answerTokens(s);
  return normalizeEn(s);
}

/**
 * 确定性抽取式 reader（不联网）：
 * 把上下文按行与句末标点切开，按「问题词的逆文档频率加权命中」选一句作为答案。
 * 一个词在越多句子里出现（比如人名），区分度越低；只在一句里出现的词（比如 greyhound）
 * 权重最高。同分时保留先出现的一句 —— 上下文是按召回排名拼的，越靠前越可信。
 * 用途：离线自测、CI 下限基线，以及没有 LLM 时也能产出一个 QA 数字。
 */
export function createExtractiveReader(opts = {}) {
  const maxAnswerChars = Number(opts.maxAnswerChars ?? 240);
  return async function extractiveReader({ question, context, maxContextChars = 6000 }) {
    const text = trimContext(context, maxContextChars);
    const questionTokens = new Set(readerTokens(question).filter((t) => t.length > 1));
    const candidates = splitSentences(text);
    if (candidates.length === 0) return "UNKNOWN";
    const tokenized = candidates.map((s) => new Set(readerTokens(s)));
    const docFreq = new Map();
    for (const t of questionTokens) {
      docFreq.set(t, tokenized.filter((set) => set.has(t)).length);
    }
    let best = "";
    let bestScore = 0;
    for (let i = 0; i < candidates.length; i += 1) {
      let score = 0;
      for (const t of questionTokens) {
        const df = docFreq.get(t) ?? 0;
        if (df > 0 && tokenized[i].has(t)) score += 1 / df;
      }
      // 严格大于：同分保留更靠前的一句
      if (score > bestScore) {
        bestScore = score;
        best = candidates[i];
      }
    }
    if (!best) return "UNKNOWN";
    return best.slice(0, Math.max(1, maxAnswerChars)).trim();
  };
}

/** 行 + 句末标点切句；保留中文句号 */
function splitSentences(text) {
  const out = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    for (const part of trimmed.split(/(?<=[.!?。！？])\s+/)) {
      const s = part.trim();
      if (s) out.push(s);
    }
  }
  return out;
}

/** HTTP 层错误：带状态码，不回显请求头与密钥 */
export class QaHttpError extends Error {
  constructor(status, detail) {
    super(`chat request failed: HTTP ${status}${detail ? " - " + detail : ""}`);
    this.name = "QaHttpError";
    this.status = status;
  }
}

/** baseUrl → chat completions 端点：已带路径就不再拼 */
export function chatEndpoint(baseUrl) {
  const base = String(baseUrl ?? "").trim().replace(/\/+$/, "");
  if (/\/chat\/completions$/.test(base)) return base;
  if (/\/v\d+$/.test(base)) return base + "/chat/completions";
  return base + "/v1/chat/completions";
}

/** 取 choices[0] 的文本，兼容 message.content 字符串 / 数组与旧式 text */
function pickCompletionText(payload) {
  if (!payload || typeof payload !== "object") return null;
  const choices = payload.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (!first || typeof first !== "object") return null;
  const message = first.message;
  if (message && typeof message === "object") {
    const content = message.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      const text = content
        .map((part) => (part && typeof part === "object" && typeof part.text === "string" ? part.text : ""))
        .join("")
        .trim();
      if (text) return text;
    }
  }
  if (typeof first.text === "string") return first.text;
  return null;
}

/**
 * OpenAI 兼容的 chat 客户端。零依赖，只认全局 fetch。
 * 失败一律抛错，由 `runQa` 记成 `error`（不当作答错）。
 */
export function createChatClient(cfg) {
  const endpoint = chatEndpoint(cfg.baseUrl);
  const doFetch = cfg.fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== "function") {
    throw new Error("fetch is unavailable in this runtime; cannot create QA chat client");
  }
  const timeoutMs = Number(cfg.timeoutMs ?? 60000);
  const model = cfg.model;
  return async function chat(messages, opts = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = { "content-type": "application/json" };
      if (cfg.apiKey) headers.authorization = "Bearer " + cfg.apiKey;
      let res;
      try {
        res = await doFetch(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify({
            model,
            messages,
            temperature: opts.temperature ?? 0,
            max_tokens: opts.maxTokens ?? 256,
          }),
          signal: controller.signal,
        });
      } catch (e) {
        if (e && e.name === "AbortError") throw new Error(`chat request timed out after ${timeoutMs}ms`);
        throw e;
      }
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new QaHttpError(res.status, body.slice(0, 200));
      }
      const payload = await res.json();
      const text = pickCompletionText(payload);
      if (text === null) throw new Error("chat response has no completion text");
      return text;
    } finally {
      clearTimeout(timer);
    }
  };
}

/** HTTP reader：问题 + 召回上下文 → 短答案 */
export function createHttpReader(cfg) {
  const chat = createChatClient(cfg);
  return async function httpReader({ question, context, questionDate, maxContextChars }) {
    return chat(buildReaderMessages({ question, context, questionDate, maxContextChars }), { maxTokens: 256 });
  };
}

/** heuristic judge（同步计算，包成 async 以便与 LLM judge 统一接口） */
export function createHeuristicJudge(opts = {}) {
  return async function heuristicJudge(input) {
    return heuristicVerdict(input, opts);
  };
}

/** LLM judge：返回 { correct, reason }；裁决解析不出时 correct = null */
export function createLlmJudge(cfg) {
  const chat = createChatClient(cfg);
  return async function llmJudge({ question, golds, prediction }) {
    const text = await chat(buildJudgeMessages({ question, golds, prediction }), { maxTokens: 128 });
    return { correct: parseJudgeVerdict(text), reason: text.trim().slice(0, 300) };
  };
}

/* ------------------------------------------------------------------ */
/* 配置与执行                                                           */
/* ------------------------------------------------------------------ */

/** CLI 参数 → QA 配置；未启用返回 null */
export function resolveQaConfig(opts = {}, env = process.env) {
  const mode = String(opts.qa ?? "off").toLowerCase();
  if (mode === "off" || mode === "none" || mode === "") return null;
  if (mode !== "extractive" && mode !== "http") {
    throw new Error(`--qa 只支持 off | extractive | http，收到 ${JSON.stringify(opts.qa)}`);
  }
  const judgeMode = String(opts["qa-judge"] ?? "heuristic").toLowerCase();
  if (!["heuristic", "llm", "both"].includes(judgeMode)) {
    throw new Error(`--qa-judge 只支持 heuristic | llm | both，收到 ${JSON.stringify(opts["qa-judge"])}`);
  }
  const needsHttp = mode === "http" || judgeMode !== "heuristic";
  const baseUrl = String(opts["qa-base-url"] ?? env.MEMWEAVE_QA_BASE_URL ?? "https://api.openai.com/v1");
  const model = String(opts["qa-model"] ?? env.MEMWEAVE_QA_MODEL ?? "gpt-4o-mini");
  const judgeModel = String(opts["qa-judge-model"] ?? env.MEMWEAVE_QA_JUDGE_MODEL ?? model);
  const apiKeyEnv = String(opts["qa-api-key-env"] ?? "OPENAI_API_KEY");
  const apiKey = env[apiKeyEnv] ?? "";
  if (needsHttp && !apiKey) {
    throw new Error(
      `QA 需要 API key：设置环境变量 ${apiKeyEnv}，或用 --qa-api-key-env 指定变量名；` +
        "离线场景请用 --qa extractive --qa-judge heuristic",
    );
  }
  const concurrency = clampInt(opts["qa-concurrency"], 4, 1, 32);
  const timeoutMs = clampInt(opts["qa-timeout-ms"], 60000, 1000, 600000);
  const maxContextChars = clampInt(opts["qa-max-context-chars"], 6000, 200, 200000);
  const limitRaw = opts["qa-limit"];
  let limit = null;
  if (limitRaw !== undefined && limitRaw !== null && limitRaw !== "") {
    const n = Number(limitRaw);
    if (!Number.isFinite(n) || n < 1) {
      throw new Error(`--qa-limit 需要正整数，收到 ${JSON.stringify(limitRaw)}`);
    }
    limit = Math.floor(n);
  }
  return {
    mode,
    judgeMode,
    baseUrl,
    model,
    judgeModel,
    apiKey: apiKey || null,
    apiKeyEnv,
    concurrency,
    timeoutMs,
    maxContextChars,
    limit,
  };
}

/**
 * 有默认值的整数参数：没给就用默认，给了就必须是区间内的整数。
 * 不静默截断 —— `--qa-concurrency 999` 悄悄变成 32 会让人以为并发真的开了 999。
 */
function clampInt(raw, fallback, min, max) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new Error(`需要整数，收到 ${JSON.stringify(raw)}`);
  }
  if (n < min || n > max) {
    throw new Error(`需要 ${min}..${max} 之间的整数，收到 ${JSON.stringify(raw)}`);
  }
  return n;
}

/** 从配置建 reader + judges；返回 null 表示没启用 */
export function createQaPipeline(config) {
  if (!config) return null;
  const reader =
    config.mode === "extractive"
      ? createExtractiveReader()
      : createHttpReader({
          baseUrl: config.baseUrl,
          model: config.model,
          apiKey: config.apiKey,
          timeoutMs: config.timeoutMs,
        });
  const judges = [];
  if (config.judgeMode === "heuristic" || config.judgeMode === "both") {
    judges.push(["heuristic", createHeuristicJudge()]);
  }
  if (config.judgeMode === "llm" || config.judgeMode === "both") {
    judges.push([
      "llm",
      createLlmJudge({
        baseUrl: config.baseUrl,
        model: config.judgeModel,
        apiKey: config.apiKey,
        timeoutMs: config.timeoutMs,
      }),
    ]);
  }
  return { reader, judges, config };
}

/**
 * 跑 QA：items = [{ id, question, answer, context, bucket?, questionDate? }]
 * - 顺序由并发窗口控制，结果按输入顺序返回；
 * - reader 抛错 → `error`，`em` / `f1` / 判分全为 null；
 * - judge 抛错 → 该 judge 记 `error`，不影响其它 judge 与 F1；
 * - 任何失败都不参与准确率分母。
 */
export async function runQa(items, pipeline) {
  if (!pipeline) throw new Error("runQa needs a pipeline from createQaPipeline()");
  const { reader, judges, config } = pipeline;
  const records = new Array(items.length);
  let cursor = 0;

  async function worker() {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      const item = items[index];
      const record = {
        id: item.id,
        bucket: item.bucket ?? "all",
        question: item.question,
        golds: goldAnswers(item.answer),
        contextChars: trimContext(item.context, config.maxContextChars).length,
        prediction: null,
        em: null,
        f1: null,
        judges: {},
        judgeErrors: {},
        error: null,
      };
      try {
        record.prediction = await reader({
          question: item.question,
          context: item.context,
          questionDate: item.questionDate,
          maxContextChars: config.maxContextChars,
        });
        record.em = exactMatch(record.prediction, record.golds);
        record.f1 = bestF1(record.prediction, record.golds);
        for (const [name, judge] of judges) {
          try {
            const verdict = await judge({
              question: item.question,
              golds: record.golds,
              prediction: record.prediction,
            });
            record.judges[name] = {
              correct: typeof verdict === "boolean" ? verdict : (verdict?.correct ?? null),
              reason: verdict?.reason ?? null,
            };
          } catch (e) {
            record.judgeErrors[name] = e?.message ?? String(e);
            record.judges[name] = { correct: null, reason: null };
          }
        }
      } catch (e) {
        record.error = e?.message ?? String(e);
      }
      records[index] = record;
    }
  }

  const width = Math.max(1, Math.min(config.concurrency, items.length || 1));
  await Promise.all(Array.from({ length: width }, () => worker()));
  const present = records.filter(Boolean);
  return { records: present, summary: summarizeQa(present, judges.map(([name]) => name)) };
}

/** 单组聚合：失败样本只计入 n / errors，不进 em / f1 / accuracy 的分母 */
function summarizeBlock(records, judgeNames) {
  const scored = records.filter((r) => typeof r.f1 === "number");
  const judges = {};
  for (const name of judgeNames) {
    const graded = records.filter((r) => r.judges?.[name]?.correct === true || r.judges?.[name]?.correct === false);
    const errors = records.filter((r) => r.judgeErrors?.[name]).length;
    judges[name] = {
      n: graded.length,
      accuracy: graded.length === 0 ? null : graded.filter((r) => r.judges[name].correct).length / graded.length,
      errors,
    };
  }
  return {
    n: records.length,
    evaluated: scored.length,
    errors: records.filter((r) => r.error).length,
    em: mean(scored.map((r) => r.em)),
    f1: mean(scored.map((r) => r.f1)),
    judges,
  };
}

function mean(values) {
  const nums = values.filter((v) => typeof v === "number" && Number.isFinite(v));
  return nums.length === 0 ? null : nums.reduce((a, b) => a + b, 0) / nums.length;
}

/** 汇总：overall + byBucket；`judgeNames` 省略时从记录里推导 */
export function summarizeQa(records, judgeNames) {
  const names = judgeNames ?? [...new Set(records.flatMap((r) => Object.keys(r.judges ?? {})))];
  const buckets = new Map();
  for (const r of records) {
    const key = r.bucket ?? "all";
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(r);
  }
  const byBucket = {};
  for (const [key, list] of buckets) byBucket[key] = summarizeBlock(list, names);
  return { overall: summarizeBlock(records, names), byBucket };
}

/**
 * 报告里的 QA 段。`bucketBy` 由调用方给（LoCoMo = category，LongMemEval = question_type）
 * 其余字段记录口径，保证数字可复现、也保证读者不会把它和检索指标混着看。
 */
export function buildQaReport({ config, summary, items, elapsedSec }) {
  return {
    reader: config.mode,
    readerModel: config.mode === "http" ? config.model : null,
    judgeMode: config.judgeMode,
    judgeModel: config.judgeMode === "heuristic" ? null : config.judgeModel,
    bucketBy: items.bucketBy ?? null,
    requested: items.requested,
    evaluated: summary.overall.evaluated,
    limit: config.limit,
    maxContextChars: config.maxContextChars,
    concurrency: config.concurrency,
    elapsedSec,
    comparability:
      config.mode === "http" && config.judgeMode !== "heuristic"
        ? "comparable to published QA numbers only when reader and judge models also match"
        : "NOT comparable to published QA numbers (extractive reader and/or heuristic judge)",
    ...summary,
  };
}

/** 控制台输出：与检索指标分开打印，明确标注 QA */
export function formatQaLine(prefix, block, label = "QA") {
  const pct = (v) => (v === null || v === undefined ? "-" : (v * 100).toFixed(1) + "%");
  const judgeText = Object.entries(block.judges ?? {})
    .map(([name, j]) => `${name}=${pct(j.accuracy)} (n=${j.n}${j.errors ? ` err=${j.errors}` : ""})`)
    .join(" ");
  return (
    `[${prefix}] ${label} n=${block.n} evaluated=${block.evaluated}` +
    (block.errors ? ` errors=${block.errors}` : "") +
    ` em=${pct(block.em)} f1=${pct(block.f1)}` +
    (judgeText ? ` judge: ${judgeText}` : "")
  );
}
