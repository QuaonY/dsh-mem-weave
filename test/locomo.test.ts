/**
 * bench/locomo.mjs（LoCoMo 跑分器）回归测试。
 * 覆盖四层：
 * 1. 纯函数：会话日期解析、evidence 清洗、dia_id → 检索单元；
 * 2. 文档切分：turn 粒度按 dia_id 落库、session 粒度按发言边界切块、孤儿日期键不炸；
 * 3. 指标与汇总：recall_any / recall_all / recall_mean / nDCG、答案串命中、adversarial 分桶；
 * 4. 端到端：合成数据集跑完 CLI，检查报告结构、类别过滤与 JSONL 输出。
 * 不联网、不依赖真实数据集。
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const root = join(__dirname, "..");
const script = join(root, "bench", "locomo.mjs");

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "memweave-locomo-test-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

let mod: Record<string, any> | null = null;
async function locomo(): Promise<Record<string, any>> {
  if (!mod) mod = (await import(pathToFileURL(script).href)) as Record<string, any>;
  return mod;
}

function runCli(args: string[]) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 180_000,
  });
}

const SAMPLE = {
  sample_id: "conv-test",
  conversation: {
    session_1_date_time: "1:56 pm on 8 May, 2023",
    session_1: [
      { speaker: "Caroline", dia_id: "D1:1", text: "I went to a pottery class in Berlin." },
      { speaker: "Melanie", dia_id: "D1:2", text: "That sounds fun, I love ceramics.", blip_caption: "a clay bowl" },
    ],
    // 真实数据里存在孤儿日期键：有 session_20_date_time 却没有 session_20 数组
    session_2_date_time: "1:14 pm on 25 May, 2023",
    session_2: [{ speaker: "Caroline", dia_id: "D2:1", text: "My sister adopted a greyhound named Pixel." }],
    session_3_date_time: "9:05 am on 30 June, 2023",
  },
  qa: [
    { question: "Where did Caroline go?", answer: "Berlin", evidence: ["D1:1"], category: 4 },
    { question: "What is the name of the greyhound?", answer: "The Pixel", evidence: ["D2:1"], category: 4 },
    {
      question: "What did Caroline paint recently?",
      adversarialAnswer: undefined,
      adversarial_answer: "a mural",
      evidence: ["D1:2"],
      category: 5,
    },
    // evidence 清空：应计入 skippedNoEvidence，而不是当作 0 分
    { question: "What is the capital of France?", answer: "Paris", evidence: [], category: 3 },
  ],
};

describe("locomo 解析", () => {
  it("会话日期：\"1:56 pm on 8 May, 2023\" → 本地时间", async () => {
    const { parseLocomoDate } = await locomo();
    expect(parseLocomoDate("1:56 pm on 8 May, 2023")).toBe(new Date(2023, 4, 8, 13, 56).getTime());
    expect(parseLocomoDate("10:37 am on 27 June, 2023")).toBe(new Date(2023, 5, 27, 10, 37).getTime());
    // 12 点边界：12 am = 0 点，12 pm = 12 点
    expect(parseLocomoDate("12:00 am on 1 January, 2023")).toBe(new Date(2023, 0, 1, 0, 0).getTime());
    expect(parseLocomoDate("12:30 pm on 1 January, 2023")).toBe(new Date(2023, 0, 1, 12, 30).getTime());
    expect(parseLocomoDate("")).toBeUndefined();
    expect(parseLocomoDate("not a date")).toBeUndefined();
    expect(parseLocomoDate("1:56 pm on 8 Foo, 2023")).toBeUndefined();
  });

  it("evidence 清洗：拆多值、丢脏值、去重、统一大写", async () => {
    const { parseEvidence } = await locomo();
    expect(parseEvidence(["D1:3"])).toEqual(["D1:3"]);
    // 实测数据里存在一条塞多个的形态
    expect(parseEvidence(["D8:6; D9:17"])).toEqual(["D8:6", "D9:17"]);
    expect(parseEvidence(["D1:3 D2:7 D9:1"])).toEqual(["D1:3", "D2:7", "D9:1"]);
    expect(parseEvidence(["d1:3", "D1:3"])).toEqual(["D1:3"]);
    // 前导零归一：conv-50 有一题写 "D30:05"，对话里是 "D30:5"
    expect(parseEvidence(["D30:05"])).toEqual(["D30:5"]);
    expect(parseEvidence(["D01:002"])).toEqual(["D1:2"]);
    // 脏值：单独的 "D" 和 "D:2:3" 都不是合法 dia_id
    expect(parseEvidence(["D", "D:2:3"])).toEqual([]);
    expect(parseEvidence(undefined)).toEqual([]);
  });

  it("dia_id → 检索单元：turn 用 dia_id，session 用 D<n>", async () => {
    const { unitKey } = await locomo();
    expect(unitKey("d1:3", "turn")).toBe("D1:3");
    expect(unitKey("D1:3", "session")).toBe("D1");
    expect(unitKey("D12:40", "session")).toBe("D12");
    // 与 parseEvidence 同一套数字归一
    expect(unitKey("D30:05", "turn")).toBe("D30:5");
    expect(unitKey("D01", "session")).toBe("D1");
    // 分块 id 不是合法 dia_id，原样返回（调用方会再剥 #n）
    expect(unitKey("D1#2", "session")).toBe("D1#2");
  });
});

describe("locomo 文档切分", () => {
  it("turn 粒度：一条发言一条记忆，docId 就是 dia_id", async () => {
    const { buildDocs } = await locomo();
    const docs = buildDocs(SAMPLE, { granularity: "turn" });
    // 孤儿日期键不应产生空文档
    expect(docs.map((d: any) => d.docId)).toEqual(["D1:1", "D1:2", "D2:1"]);
    expect(docs.map((d: any) => d.turn)).toEqual([1, 2, 1]);
    expect(docs[0].content).toBe("Caroline: I went to a pottery class in Berlin.");
    // 图片描述拼在发言后面
    expect(docs[1].content).toContain("Melanie: That sounds fun, I love ceramics.");
    expect(docs[1].content).toContain("shared image: a clay bowl");
    expect(docs[0].ts).toBe(new Date(2023, 4, 8, 13, 56).getTime());
    expect(docs[2].ts).toBe(new Date(2023, 4, 25, 13, 14).getTime());
  });

  it("session 粒度：一个会话一条，超 1900 字按发言边界切块", async () => {
    const { buildDocs } = await locomo();
    const docs = buildDocs(SAMPLE, { granularity: "session" });
    expect(docs.map((d: any) => d.docId)).toEqual(["D1", "D2"]);
    expect(docs[0].content).toContain("Caroline: I went to a pottery class in Berlin.");
    expect(docs[0].content).toContain("Melanie: That sounds fun");

    const long = {
      conversation: {
        session_1_date_time: "1:56 pm on 8 May, 2023",
        session_1: [
          { speaker: "A", dia_id: "D1:1", text: "a".repeat(1500) },
          { speaker: "A", dia_id: "D1:2", text: "b".repeat(1500) },
        ],
      },
      qa: [],
    };
    const chunked = buildDocs(long, { granularity: "session" });
    expect(chunked.map((d: any) => d.docId)).toEqual(["D1", "D1#2"]);
    for (const d of chunked) expect(d.content.length).toBeLessThanOrEqual(1900);
  });
});

describe("locomo 指标", () => {
  it("answer 命中：按词序匹配，忽略大小写与 a/an/the/and", async () => {
    const { containsAnswer } = await locomo();
    expect(containsAnswer("Berlin", "Caroline: I went to a pottery class in Berlin.")).toBe(true);
    expect(containsAnswer("The Pixel", "My sister adopted a greyhound named Pixel.")).toBe(true);
    expect(containsAnswer("Paris", "I went to a pottery class in Berlin.")).toBe(false);
    // 不做词形还原：复数形式不算命中（与官方单词面包含判断的已知差异）
    expect(containsAnswer("park", "I like parks.")).toBe(false);
    expect(containsAnswer("", "anything")).toBe(false);
  });

  it("单题指标：recall_any / recall_all / recall_mean / nDCG", async () => {
    const { evaluateQuestion } = await locomo();
    const doc = (docId: string, sid: string) => ({ sid, docId, content: docId, turn: 1, ts: 0, truncated: false });
    const corpus = [doc("D1:1", "D1"), doc("D3:1", "D3"), doc("D2:1", "D2")];
    const hits = corpus.map((d) => ({ doc: d, score: 1 }));
    const gold = new Set(["D1:1", "D2:1"]);

    const m = evaluateQuestion(gold, hits, corpus, [2, 10], { granularity: "turn" });
    // 前 2 条只命中 D1:1
    expect(m.k2.recallAny).toBe(1);
    expect(m.k2.recallAll).toBe(0);
    expect(m.k2.recallMean).toBe(0.5);
    // 前 10 条（只有 3 条）全部命中
    expect(m.k10.recallAll).toBe(1);
    expect(m.k10.recallMean).toBe(1);
    // 官方 dcg 的第 2 位折扣是 log2(2)=1（等于不打折），所以「gold 排在 1、3 位」
    // 拿不到 10 分：(1 + 1/log2(3)) / (1 + 1/log2(2))
    expect(m.k10.ndcgAny).toBeCloseTo((1 + 1 / Math.log2(3)) / (1 + 1 / Math.log2(2)), 6);
    // 没有 answer 时该列留空，不按 0 计入均值
    expect(m.k10.answerInContext).toBeNull();

    const noGold = evaluateQuestion(new Set(), hits, corpus, [5], { granularity: "turn" });
    expect(noGold.k5.recallAny).toBeNull();
    expect(noGold.k5.ndcgAny).toBeNull();
  });

  it("汇总：adversarial（category 5）单独分桶，另算不含 5 的一份", async () => {
    const { summarize } = await locomo();
    const mk = (category: number, recall: number) => ({
      category,
      metrics: {
        k5: { recallAny: recall, recallAll: recall, recallMean: recall, ndcgAny: recall, answerInContext: null },
      },
    });
    const rows = [mk(1, 1), mk(1, 0), mk(5, 1)];
    const s = summarize(rows, [5]);
    expect(s.overall.n).toBe(3);
    expect(s.nonAdversarial.n).toBe(2);
    expect(s.nonAdversarial.byK.k5.recallAny).toBe(0.5);
    expect(s.overall.byK.k5.recallAny).toBeCloseTo(2 / 3, 6);
    expect(Object.keys(s.byCategory).sort()).toEqual(["1:multi-hop", "5:adversarial"]);
    expect(s.byCategory["5:adversarial"].n).toBe(1);
  });
});

describe("locomo 端到端", () => {
  it("合成数据集：报告结构、类别分桶、跳过无 evidence、JSONL 输出", async () => {
    const dir = tmp();
    const dataFile = join(dir, "locomo.json");
    const reportFile = join(dir, "report.json");
    const outFile = join(dir, "rows.jsonl");
    const dbDir = join(dir, "db");
    writeFileSync(dataFile, JSON.stringify([SAMPLE]));

    const r = runCli([
      "run",
      "--data", dataFile,
      "--report", reportFile,
      "--out", outFile,
      "--db", dbDir,
      "--quiet",
    ]);
    expect(r.status).toBe(0);

    const report = JSON.parse(readFileSync(reportFile, "utf8")) as Record<string, any>;
    expect(report.granularity).toBe("turn");
    expect(report.normalize).toBe("en");
    expect(report.prior).toBe("on");
    expect(report.conversations).toBe(1);
    expect(report.questions).toBe(3);
    expect(report.skippedNoEvidence).toBe(1);
    expect(report.docs).toBe(3);
    expect(report.rejectedDocs).toBe(0);
    expect(report.dedupedDocs).toBe(0);

    // 3 道有 gold 的题按类别分桶：single-hop 2、adversarial 1
    expect(report.byCategory["4:single-hop"].n).toBe(2);
    expect(report.byCategory["5:adversarial"].n).toBe(1);
    expect(report.nonAdversarial.n).toBe(2);

    const k10 = report.overall.byK.k10;
    for (const key of ["recallAny", "recallAll", "recallMean", "ndcgAny"]) {
      expect(k10[key]).toBeGreaterThanOrEqual(0);
      expect(k10[key]).toBeLessThanOrEqual(1);
    }
    // 所有文档都在召回范围内，两条 single-hop 的答案串应当出现在上下文里
    expect(report.nonAdversarial.byK.k10.answerInContext).toBe(1);

    const rows = readFileSync(outFile, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, any>);
    expect(rows).toHaveLength(3);
    expect(rows[0].goldKeys).toEqual(["D1:1"]);
    expect(rows[0].hits[0].docId).toBe("D1:1");
    // adversarial 题只有 adversarial_answer，没有 answer
    const adv = rows.find((x) => x.category === 5);
    expect(adv?.answer).toBeNull();
    expect(adv?.adversarialAnswer).toBe("a mural");
    // adversarial 题不参与「答案是否在上下文里」统计
    expect(adv?.metrics.k10.answerInContext).toBeNull();
  });

  it("--category 过滤只影响问答，不减少写入文档", async () => {
    const dir = tmp();
    const dataFile = join(dir, "locomo.json");
    const reportFile = join(dir, "report.json");
    writeFileSync(dataFile, JSON.stringify([SAMPLE]));

    const r = runCli([
      "run",
      "--data", dataFile,
      "--category", "4",
      "--report", reportFile,
      "--db", join(dir, "db"),
      "--quiet",
    ]);
    expect(r.status).toBe(0);
    const report = JSON.parse(readFileSync(reportFile, "utf8")) as Record<string, any>;
    expect(report.questions).toBe(2);
    expect(report.docs).toBe(3);
    expect(Object.keys(report.byCategory)).toEqual(["4:single-hop"]);
    expect(report.overall.n).toBe(2);
  });

  it("--granularity session 时 gold 落在会话 id 上", async () => {
    const dir = tmp();
    const dataFile = join(dir, "locomo.json");
    const outFile = join(dir, "rows.jsonl");
    writeFileSync(dataFile, JSON.stringify([SAMPLE]));

    const r = runCli([
      "run",
      "--data", dataFile,
      "--granularity", "session",
      "--out", outFile,
      "--db", join(dir, "db"),
      "--quiet",
    ]);
    expect(r.status).toBe(0);
    const rows = readFileSync(outFile, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, any>);
    expect(rows[0].goldKeys).toEqual(["D1"]);
    expect(rows[0].hits[0].docId).toBe("D1");
  });

  it("参数错误以非零码退出并给出用法", () => {
    const missing = runCli(["run"]);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("--data");

    const unknown = runCli(["nope"]);
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain("未知命令");

    const badGranularity = runCli(["run", "--data", "x.json", "--granularity", "doc"]);
    expect(badGranularity.status).toBe(1);
    expect(badGranularity.stderr).toContain("--granularity");

    const help = runCli(["--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("--granularity");
  });
});
