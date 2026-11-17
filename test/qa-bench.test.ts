/**
 * bench/qa.mjs（QA 评测管线）回归测试。
 * 覆盖四层：
 * 1. 文本口径：答案归一、token F1、EM、heuristic judge、LLM 裁决解析；
 * 2. reader / judge：确定性抽取式 reader、chat 请求形状（假 fetch）、本地 HTTP 端到端；
 * 3. 执行与汇总：并发窗口、顺序、失败不计作答错、分桶聚合、配置解析；
 * 4. 跑分器接线：LoCoMo `--qa extractive` 的报告段与 console 口径。
 * 不联网；HTTP 层用假 fetch 与 127.0.0.1 上的临时服务。
 */
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const root = join(__dirname, "..");
const qaScript = join(root, "bench", "qa.mjs");
const locomoScript = join(root, "bench", "locomo.mjs");

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "memweave-qa-test-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

let mod: Record<string, any> | null = null;
async function qa(): Promise<Record<string, any>> {
  if (!mod) mod = (await import(pathToFileURL(qaScript).href)) as Record<string, any>;
  return mod;
}

function runCli(script: string, args: string[]) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 180_000,
  });
}

/* ------------------------------------------------------------------ */
/* 1. 文本口径                                                          */
/* ------------------------------------------------------------------ */

describe("qa 文本归一与判分", () => {
  it("答案归一：小写、去标点、去冠词、压空白", async () => {
    const { normalizeAnswer } = await qa();
    expect(normalizeAnswer("The  Pixel!")).toBe("pixel");
    expect(normalizeAnswer("A cat, an apple.")).toBe("cat apple");
    expect(normalizeAnswer("  Berlin  ")).toBe("berlin");
    expect(normalizeAnswer(null)).toBe("");
    // 中文不做分词，只去标点
    expect(normalizeAnswer("柏林，2023 年")).toBe("柏林 2023 年");
  });

  it("token F1：完全一致 1、部分重叠、空串、多 gold 取最大", async () => {
    const { tokenF1, bestF1, exactMatch } = await qa();
    expect(tokenF1("Berlin", "Berlin")).toBe(1);
    expect(tokenF1("the Pixel", "Pixel")).toBe(1);
    expect(tokenF1("26 May", "May 26, 2023")).toBeCloseTo(0.8, 6);
    expect(tokenF1("", "Berlin")).toBe(0);
    expect(tokenF1("", "")).toBe(1);
    expect(tokenF1("Berlin", "")).toBe(0);

    expect(bestF1("May 26, 2023", ["May 25, 2023", "May 26, 2023"])).toBe(1);
    expect(bestF1("anything", [])).toBeNull();

    expect(exactMatch("The Pixel!", "pixel")).toBe(1);
    expect(exactMatch("Pixel", "the pixel")).toBe(1);
    expect(exactMatch("Pixels", "pixel")).toBe(0);
    expect(exactMatch("x", [])).toBeNull();
  });

  it("heuristic judge：EM / F1 阈值 / 完整 token 包含，空答案与无 gold 判错", async () => {
    const { heuristicVerdict } = await qa();
    expect(heuristicVerdict({ prediction: "The Pixel", golds: ["pixel"] }).correct).toBe(true);
    expect(heuristicVerdict({ prediction: "in Berlin", golds: ["Berlin"] }).correct).toBe(true);
    // 长度差太多时 F1 低于阈值，但完整 token 包含仍然算对
    expect(
      heuristicVerdict({
        prediction: "I moved to Berlin last spring with my sister",
        golds: ["Berlin"],
      }).correct,
    ).toBe(true);
    // 子串不按字符匹配："concatenate" 不含 token "cat"
    expect(heuristicVerdict({ prediction: "concatenate", golds: ["cat"] }).correct).toBe(false);
    expect(heuristicVerdict({ prediction: "", golds: ["Berlin"] }).correct).toBe(false);
    expect(heuristicVerdict({ prediction: "Berlin", golds: [] }).correct).toBe(false);
    // 阈值可调：部分重叠默认不算对，调低后算对
    const partial = { prediction: "May 26", golds: ["May 26, 2023"] };
    expect(heuristicVerdict(partial).correct).toBe(true); // 包含 token 序列
    expect(heuristicVerdict({ prediction: "Paris Rome London", golds: ["Paris Texas"] }).correct).toBe(false);
    expect(
      heuristicVerdict({ prediction: "Paris Rome London", golds: ["Paris Texas"] }, { f1Threshold: 0.1 }).correct,
    ).toBe(true);
  });

  it("LLM 裁决解析：CORRECT / INCORRECT / YES / NO，否定句不被误判，含糊返回 null", async () => {
    const { parseJudgeVerdict } = await qa();
    expect(parseJudgeVerdict("CORRECT\nsame fact")).toBe(true);
    expect(parseJudgeVerdict("**CORRECT**")).toBe(true);
    expect(parseJudgeVerdict("Incorrect\ndate differs")).toBe(false);
    expect(parseJudgeVerdict("YES")).toBe(true);
    expect(parseJudgeVerdict("No.")).toBe(false);
    expect(parseJudgeVerdict("The answer is not correct")).toBe(false);
    expect(parseJudgeVerdict("The answer is correct.")).toBe(true);
    expect(parseJudgeVerdict("maybe")).toBeNull();
    expect(parseJudgeVerdict("")).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* 2. reader / judge                                                    */
/* ------------------------------------------------------------------ */

describe("qa reader 与 chat 客户端", () => {
  it("抽取式 reader 选与问题重叠最高的一句；无重叠返回 UNKNOWN", async () => {
    const { createExtractiveReader } = await qa();
    const reader = createExtractiveReader();
    const context = [
      "Caroline: I went to a pottery class in Berlin.",
      "Melanie: That sounds fun, I love ceramics.",
    ].join("\n");
    const answer = await reader({ question: "Where did Caroline go?", context });
    expect(answer).toContain("pottery class in Berlin");
    expect(await reader({ question: "What is the weather?", context: "" })).toBe("UNKNOWN");
    // 上下文与问题毫无重叠时也不硬编答案
    expect(await reader({ question: "quantum chromodynamics", context: "zzz qqq" })).toBe("UNKNOWN");
  });

  it("提示词：reader 带未知兜底，judge 带全部 gold", async () => {
    const { buildReaderMessages, buildJudgeMessages } = await qa();
    const readerMsgs = buildReaderMessages({ question: "Where?", context: "Berlin", maxContextChars: 6000 });
    expect(readerMsgs[0].content).toContain("UNKNOWN");
    expect(readerMsgs[1].content).toContain("Berlin");
    expect(readerMsgs[1].content).toContain("Where?");

    const judgeMsgs = buildJudgeMessages({ question: "Where?", golds: ["Berlin", "Paris"], prediction: "Berlin" });
    expect(judgeMsgs[1].content).toContain("1. Berlin");
    expect(judgeMsgs[1].content).toContain("2. Paris");
    expect(buildJudgeMessages({ question: "q", golds: [], prediction: "x" })[1].content).toContain(
      "no gold answer",
    );
  });

  it("chat 请求：端点归一、Bearer、消息原样、三种返回体", async () => {
    const { createChatClient, chatEndpoint } = await qa();
    expect(chatEndpoint("https://api.openai.com/v1")).toBe("https://api.openai.com/v1/chat/completions");
    expect(chatEndpoint("https://api.openai.com/v1/")).toBe("https://api.openai.com/v1/chat/completions");
    expect(chatEndpoint("https://gw.example.com/chat/completions")).toBe(
      "https://gw.example.com/chat/completions",
    );
    expect(chatEndpoint("http://127.0.0.1:1234")).toBe("http://127.0.0.1:1234/v1/chat/completions");

    const calls: Array<{ url: string; init: any }> = [];
    const makeFetch = (payload: unknown) =>
      (async (url: string, init: any) => {
        calls.push({ url, init });
        return {
          ok: true,
          status: 200,
          json: async () => payload,
          text: async () => JSON.stringify(payload),
        };
      }) as unknown as typeof fetch;

    const chat = createChatClient({
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-test",
      apiKey: "sk-test",
      fetchImpl: makeFetch({ choices: [{ message: { content: "  Berlin  " } }] }),
    });
    expect(await chat([{ role: "user", content: "hi" }])).toBe("  Berlin  ");
    expect(calls[0].url).toBe("https://api.openai.com/v1/chat/completions");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers.authorization).toBe("Bearer sk-test");
    const body = JSON.parse(calls[0].init.body);
    expect(body.model).toBe("gpt-test");
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(body.temperature).toBe(0);

    // content 数组（新网关）与旧式 choices[0].text
    const arrayChat = createChatClient({
      baseUrl: "https://x/v1",
      model: "m",
      fetchImpl: makeFetch({ choices: [{ message: { content: [{ type: "text", text: "Pi" }, { text: "xel" }] } }] }),
    });
    expect(await arrayChat([])).toBe("Pixel");
    const legacyChat = createChatClient({
      baseUrl: "https://x/v1",
      model: "m",
      fetchImpl: makeFetch({ choices: [{ text: "legacy" }] }),
    });
    expect(await legacyChat([])).toBe("legacy");
  });

  it("chat 失败：非 2xx 带状态码、缺文本报错、超时走 AbortController、无 fetch 直接拒绝", async () => {
    const { createChatClient, QaHttpError } = await qa();
    const errorChat = createChatClient({
      baseUrl: "https://x/v1",
      model: "m",
      fetchImpl: (async () => ({
        ok: false,
        status: 429,
        text: async () => '{"error":"rate limited"}',
      })) as unknown as typeof fetch,
    });
    const err = await errorChat([]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QaHttpError);
    expect((err as any).status).toBe(429);
    expect(String((err as any).message)).toContain("rate limited");
    expect(String((err as any).message)).not.toContain("Bearer");

    const emptyChat = createChatClient({
      baseUrl: "https://x/v1",
      model: "m",
      fetchImpl: (async () => ({ ok: true, status: 200, json: async () => ({ choices: [] }) })) as unknown as typeof fetch,
    });
    await expect(emptyChat([])).rejects.toThrow(/no completion text/);

    const slowChat = createChatClient({
      baseUrl: "https://x/v1",
      model: "m",
      timeoutMs: 20,
      fetchImpl: ((_url: string, init: any) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => {
            const e = new Error("aborted");
            e.name = "AbortError";
            reject(e);
          });
        })) as unknown as typeof fetch,
    });
    await expect(slowChat([])).rejects.toThrow(/timed out after 20ms/);

    const saved = globalThis.fetch;
    (globalThis as any).fetch = undefined;
    try {
      expect(() => createChatClient({ baseUrl: "https://x/v1", model: "m" })).toThrow(/fetch is unavailable/);
    } finally {
      (globalThis as any).fetch = saved;
    }
  });

  it("本地 HTTP 服务：http reader 真走 fetch，LLM judge 解析裁决", async () => {
    const { createHttpReader, createLlmJudge } = await qa();
    const requests: Array<Record<string, any>> = [];
    let reply = "CORRECT\nsame fact";
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        const parsed = JSON.parse(body);
        requests.push({ url: req.url, auth: req.headers.authorization, body: parsed });
        const content = parsed.messages[1].content.includes("Verdict:") ? reply : "Berlin";
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content } }] }));
      });
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    try {
      const baseUrl = `http://127.0.0.1:${port}/v1`;
      const reader = createHttpReader({ baseUrl, model: "gpt-test", apiKey: "sk-local" });
      expect(await reader({ question: "Where?", context: "Berlin", maxContextChars: 100 })).toBe("Berlin");
      expect(requests[0].url).toBe("/v1/chat/completions");
      expect(requests[0].auth).toBe("Bearer sk-local");

      const judge = createLlmJudge({ baseUrl, model: "gpt-judge", apiKey: "sk-local" });
      expect(await judge({ question: "Where?", golds: ["Berlin"], prediction: "Berlin" })).toEqual({
        correct: true,
        reason: "CORRECT\nsame fact",
      });
      reply = "maybe later";
      const unsure = await judge({ question: "Where?", golds: ["Berlin"], prediction: "Berlin" });
      expect(unsure.correct).toBeNull();
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  });
});

/* ------------------------------------------------------------------ */
/* 3. 执行与汇总                                                        */
/* ------------------------------------------------------------------ */

describe("qa 执行与汇总", () => {
  it("并发窗口内保序；reader 失败记 error 且不进分母；judge 失败不拖累 F1", async () => {
    const { runQa } = await qa();
    let active = 0;
    let peak = 0;
    const order: string[] = [];
    const pipeline = {
      config: { maxContextChars: 100, concurrency: 2 },
      reader: async ({ question }: any) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active -= 1;
        order.push(question);
        if (question === "boom") throw new Error("reader exploded");
        return question === "wrong" ? "Paris" : "Berlin";
      },
      judges: [
        [
          "heuristic",
          async ({ prediction }: any) => {
            if (prediction === "Paris") throw new Error("judge exploded");
            return { correct: true, reason: "ok" };
          },
        ],
      ],
    };
    const items = [
      { id: "a", question: "one", answer: "Berlin", context: "Berlin" },
      { id: "b", question: "boom", answer: "Berlin", context: "Berlin" },
      { id: "c", question: "wrong", answer: "Berlin", context: "Berlin" },
      { id: "d", question: "two", answer: "Berlin", context: "Berlin" },
    ];
    const { records, summary } = await runQa(items, pipeline);

    expect(records.map((r: any) => r.id)).toEqual(["a", "b", "c", "d"]);
    expect(peak).toBeLessThanOrEqual(2);
    expect(summary.overall.n).toBe(4);
    expect(summary.overall.evaluated).toBe(3);
    expect(summary.overall.errors).toBe(1);
    expect(summary.overall.f1).toBeCloseTo(2 / 3, 6);
    expect(summary.overall.em).toBeCloseTo(2 / 3, 6);
    expect(summary.overall.judges.heuristic.n).toBe(2);
    expect(summary.overall.judges.heuristic.accuracy).toBe(1);
    expect(summary.overall.judges.heuristic.errors).toBe(1);
    // 失败样本不参与判分，也不被算作答错
    expect(records.find((r: any) => r.id === "b").error).toContain("reader exploded");
    expect(records.find((r: any) => r.id === "c").judgeErrors.heuristic).toContain("judge exploded");
  });

  it("分桶聚合：按 bucket 分组，空组不会凭空出现", async () => {
    const { summarizeQa, goldAnswers } = await qa();
    const records = [
      { bucket: "4", em: 1, f1: 1, judges: { heuristic: { correct: true } }, judgeErrors: {} },
      { bucket: "4", em: 0, f1: 0.5, judges: { heuristic: { correct: false } }, judgeErrors: {} },
      { bucket: "2", em: 0, f1: 0, judges: { heuristic: { correct: false } }, judgeErrors: {} },
    ];
    const summary = summarizeQa(records);
    expect(summary.overall.n).toBe(3);
    expect(summary.byBucket["4"].n).toBe(2);
    expect(summary.byBucket["4"].judges.heuristic.accuracy).toBe(0.5);
    expect(summary.byBucket["2"].judges.heuristic.accuracy).toBe(0);
    expect(goldAnswers(" Berlin ")).toEqual([" Berlin "]);
    expect(goldAnswers(["a", "", "b"])).toEqual(["a", "b"]);
    expect(goldAnswers(null)).toEqual([]);
  });

  it("配置解析：默认关闭；http 缺 key 报错；key 从指定环境变量取；非法并发/limit 报错", async () => {
    const { resolveQaConfig } = await qa();
    expect(resolveQaConfig({}, {})).toBeNull();
    expect(resolveQaConfig({ qa: "off" }, {})).toBeNull();
    expect(resolveQaConfig({ qa: "extractive" }, {})).toMatchObject({
      mode: "extractive",
      judgeMode: "heuristic",
      concurrency: 4,
      timeoutMs: 60000,
      maxContextChars: 6000,
      limit: null,
      apiKey: null,
    });
    expect(() => resolveQaConfig({ qa: "http" }, {})).toThrow(/API key/);
    expect(() => resolveQaConfig({ qa: "extractive", "qa-judge": "llm" }, {})).toThrow(/API key/);
    const cfg = resolveQaConfig(
      { qa: "http", "qa-judge": "both", "qa-api-key-env": "MY_KEY", "qa-limit": "5", "qa-concurrency": "2" },
      { MY_KEY: "sk-x" },
    );
    expect(cfg).toMatchObject({
      mode: "http",
      judgeMode: "both",
      apiKey: "sk-x",
      apiKeyEnv: "MY_KEY",
      limit: 5,
      concurrency: 2,
    });
    expect(() => resolveQaConfig({ qa: "nope" }, {})).toThrow(/--qa 只支持/);
    expect(() => resolveQaConfig({ qa: "extractive", "qa-limit": "0" }, {})).toThrow(/正整数/);
    expect(() => resolveQaConfig({ qa: "extractive", "qa-concurrency": "x" }, {})).toThrow(/需要整数/);
    // 越界不静默截断：999 并发要是被悄悄改成 32，报告里的 concurrency 就撒谎了
    expect(() => resolveQaConfig({ qa: "extractive", "qa-concurrency": "99" }, {})).toThrow(/1\.\.32/);
    expect(() => resolveQaConfig({ qa: "extractive", "qa-concurrency": "2.5" }, {})).toThrow(/需要整数/);
    expect(() => resolveQaConfig({ qa: "extractive", "qa-timeout-ms": "10" }, {})).toThrow(/1000\.\.600000/);
  });

  it("报告段：记录口径；extractive / heuristic 明确标注不可与已发表 QA 数字比较", async () => {
    const { buildQaReport, createQaPipeline } = await qa();
    expect(createQaPipeline(null)).toBeNull();
    const summary = { overall: { n: 4, evaluated: 3, errors: 1, em: 0.3, f1: 0.4, judges: {} }, byBucket: {} };
    const extractive = buildQaReport({
      config: { mode: "extractive", judgeMode: "heuristic", model: "m", judgeModel: "m", limit: null, maxContextChars: 6000, concurrency: 4 },
      summary,
      items: { bucketBy: "category", requested: 3 },
      elapsedSec: 1,
    });
    expect(extractive).toMatchObject({
      reader: "extractive",
      readerModel: null,
      judgeMode: "heuristic",
      judgeModel: null,
      bucketBy: "category",
      requested: 3,
      elapsedSec: 1,
    });
    expect(extractive.comparability).toContain("NOT comparable");

    const http = buildQaReport({
      config: { mode: "http", judgeMode: "llm", model: "gpt-4o", judgeModel: "gpt-4o", limit: 10, maxContextChars: 6000, concurrency: 4 },
      summary,
      items: { bucketBy: "question_type", requested: 20 },
      elapsedSec: 2,
    });
    expect(http.comparability).toContain("only when reader and judge models also match");
    expect(http.readerModel).toBe("gpt-4o");
    expect(http.judgeModel).toBe("gpt-4o");
    expect(http.requested).toBe(20);
    // n 是「进入 QA 段的题数」，evaluated 是「reader 真的跑完的题数」，失败样本只进前者
    expect(http.overall.n).toBe(4);
    expect(http.evaluated).toBe(3);
    expect(http.overall.errors).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* 4. 跑分器接线                                                        */
/* ------------------------------------------------------------------ */

const SAMPLE = {
  sample_id: "conv-qa",
  conversation: {
    session_1_date_time: "1:56 pm on 8 May, 2023",
    session_1: [
      { speaker: "Caroline", dia_id: "D1:1", text: "I went to a pottery class in Berlin." },
      { speaker: "Melanie", dia_id: "D1:2", text: "That sounds fun, I love ceramics." },
    ],
    session_2_date_time: "1:14 pm on 25 May, 2023",
    session_2: [{ speaker: "Caroline", dia_id: "D2:1", text: "My sister adopted a greyhound named Pixel." }],
  },
  qa: [
    { question: "Where did Caroline go?", answer: "Berlin", evidence: ["D1:1"], category: 4 },
    { question: "What is the name of the greyhound?", answer: "The Pixel", evidence: ["D2:1"], category: 4 },
    {
      question: "What did Caroline paint recently?",
      adversarial_answer: "a mural",
      evidence: ["D1:2"],
      category: 5,
    },
  ],
};

describe("QA 接入跑分器", () => {
  it("LoCoMo --qa extractive：报告含 QA 段、跳过 adversarial、EM 与 judge 分开记", async () => {
    const dir = tmp();
    const dataFile = join(dir, "locomo.json");
    const reportFile = join(dir, "report.json");
    const qaOut = join(dir, "qa.jsonl");
    writeFileSync(dataFile, JSON.stringify([SAMPLE]));

    const r = runCli(locomoScript, [
      "run",
      "--data", dataFile,
      "--report", reportFile,
      "--db", join(dir, "db"),
      "--qa", "extractive",
      "--qa-out", qaOut,
      "--quiet",
    ]);
    expect(r.status).toBe(0);

    const report = JSON.parse(readFileSync(reportFile, "utf8")) as Record<string, any>;
    expect(report.qa).toBeTruthy();
    expect(report.qa.reader).toBe("extractive");
    expect(report.qa.judgeMode).toBe("heuristic");
    expect(report.qa.bucketBy).toBe("category");
    expect(report.qa.requested).toBe(2);
    expect(report.qa.overall.n).toBe(2);
    expect(report.qa.overall.evaluated).toBe(2);
    expect(report.qa.overall.errors).toBe(0);
    // adversarial 题没有可判分的 gold，从 QA 分母里排除
    expect(report.qa.skipped).toBe(1);
    expect(report.qa.byBucket["4"].n).toBe(2);
    // 抽取式 reader 给的是整句，EM 为 0；heuristic 判分按包含关系算对
    expect(report.qa.overall.em).toBe(0);
    expect(report.qa.overall.judges.heuristic.accuracy).toBe(1);
    expect(report.qa.comparability).toContain("NOT comparable");

    const rows = readFileSync(qaOut, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, any>);
    expect(rows).toHaveLength(2);
    expect(rows[0].golds).toEqual(["Berlin"]);
    expect(rows[0].prediction).toContain("Berlin");
    expect(rows[0].judges.heuristic.correct).toBe(true);

    // 检索指标仍然照旧，QA 只多一个段
    expect(report.overall.byK.k10).toBeTruthy();
  });

  it("QA 关闭时不产生 qa 段，也不发请求", async () => {
    const dir = tmp();
    const dataFile = join(dir, "locomo.json");
    const reportFile = join(dir, "report.json");
    writeFileSync(dataFile, JSON.stringify([SAMPLE]));
    const r = runCli(locomoScript, [
      "run",
      "--data", dataFile,
      "--report", reportFile,
      "--db", join(dir, "db"),
      "--quiet",
    ]);
    expect(r.status).toBe(0);
    const report = JSON.parse(readFileSync(reportFile, "utf8")) as Record<string, any>;
    expect(report.qa).toBeUndefined();
  });

  it("LongMemEval --qa extractive：按 question_type 分桶，abstention 不进 QA", async () => {
    const dir = tmp();
    const dataFile = join(dir, "lme.json");
    const reportFile = join(dir, "report.json");
    const data = [
      {
        question_id: "q1",
        question_type: "single-session-user",
        question: "Where did I move?",
        answer: "Berlin",
        question_date: "2023/04/10 (Mon) 23:07",
        haystack_session_ids: ["s1", "s2"],
        haystack_dates: ["2023/01/01 (Sun) 10:00", "2023/02/02 (Thu) 11:00"],
        answer_session_ids: ["s1"],
        haystack_sessions: [
          [{ role: "user", content: "I moved to Berlin last spring.", has_answer: true }],
          [{ role: "user", content: "I like the parks in the city." }],
        ],
      },
      {
        question_id: "q2_abs",
        question_type: "single-session-user",
        question: "What is my dog's name?",
        answer: "unanswerable",
        question_date: "2023/04/10 (Mon) 23:07",
        haystack_session_ids: ["s1"],
        haystack_dates: ["2023/01/01 (Sun) 10:00"],
        answer_session_ids: [],
        haystack_sessions: [[{ role: "user", content: "I went hiking." }]],
      },
    ];
    writeFileSync(dataFile, JSON.stringify(data));

    const r = spawnSync(
      process.execPath,
      [join(root, "bench", "longmemeval.mjs"), "run", "--data", dataFile, "--report", reportFile, "--qa", "extractive", "--quiet"],
      { cwd: root, encoding: "utf8", timeout: 180_000 },
    );
    expect(r.status).toBe(0);

    const report = JSON.parse(readFileSync(reportFile, "utf8")) as Record<string, any>;
    expect(report.qa.bucketBy).toBe("question_type");
    expect(report.qa.requested).toBe(1);
    expect(report.qa.overall.n).toBe(1);
    expect(report.qa.byBucket["single-session-user"].n).toBe(1);
    expect(report.qa.overall.judges.heuristic.accuracy).toBe(1);
    expect(report.skippedAbstention).toBe(1);
  });

  it("--qa http 缺 key 时以非零码退出并说明用 extractive", () => {
    const dir = tmp();
    const dataFile = join(dir, "locomo.json");
    writeFileSync(dataFile, JSON.stringify([SAMPLE]));
    const r = spawnSync(
      process.execPath,
      [locomoScript, "run", "--data", dataFile, "--db", join(dir, "db"), "--qa", "http", "--quiet"],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 180_000,
        // 刻意不给 OPENAI_API_KEY：父进程可能带 key，这里清掉
        env: { ...process.env, OPENAI_API_KEY: "", MEMWEAVE_QA_MODEL: "" },
      },
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("API key");
    expect(r.stderr).toContain("extractive");
  });
});
