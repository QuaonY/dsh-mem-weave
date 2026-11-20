/**
 * test/bench/longmemeval.mjs（LongMemEval 跑分器）回归测试。
 * 覆盖两层：
 * 1. 纯函数：日期解析、官方指标的 JS 实现（dcg / ndcg / turn→session 的 k 扩展）；
 * 2. 文档切分：session 粒度按发言边界切块、turn 粒度保留官方 turn 序号与 has_answer 标记；
 * 3. 端到端：用 2 条合成实例跑完整流程，检查报告结构。
 * 指标实现对齐官方 src/retrieval/eval_utils.py，不联网、不依赖真实数据集。
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const root = join(__dirname, "..");
const script = join(root, "test", "bench", "longmemeval.mjs");

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "memweave-lme-test-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

let mod: Record<string, any> | null = null;
async function lme(): Promise<Record<string, any>> {
  if (!mod) mod = (await import(pathToFileURL(script).href)) as Record<string, any>;
  return mod;
}

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: "utf8", timeout: 180_000 });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

describe("longmemeval 指标", () => {
  it("dcg 与官方公式一致：首位不打折，其后按 log2 折扣", async () => {
    const { dcg } = await lme();
    expect(dcg([1, 0, 0], 10)).toBeCloseTo(1);
    expect(dcg([1, 1, 1], 10)).toBeCloseTo(1 + 1 / Math.log2(2) + 1 / Math.log2(3));
    // 只算前 k 位
    expect(dcg([0, 0, 1], 2)).toBe(0);
    expect(dcg([], 10)).toBe(0);
  });

  it("ndcg：按文档相关性与理想排序的 DCG 比值", async () => {
    const { ndcgAt } = await lme();
    // 两个 gold，排在 1、2 位 → 满分
    expect(ndcgAt([1, 1, 0, 0], [1, 1, 0, 0], 10)).toBeCloseTo(1);
    // 两个 gold，排在 1、3 位 → 有折扣损失
    const partial = ndcgAt([1, 0, 1, 0], [1, 1, 0, 0], 10);
    expect(partial).toBeGreaterThan(0.5);
    expect(partial).toBeLessThan(1);
    // 没有 gold 时返回 0（官方同样给 0）
    expect(ndcgAt([0, 0], [0, 0], 10)).toBe(0);
  });

  it("turn 粒度转 session：先去重再补足 k 个会话", async () => {
    const { effectiveSessionK } = await lme();
    // 5 个文档来自 3 个会话，k=3 → 去重后只有 3 个唯一会话，仍需全部取完
    const sids = ["s1", "s1", "s2", "s2", "s3"];
    expect(effectiveSessionK(sids, 2)).toBe(3); // 前 2 只够 1 个会话，补到 3
    expect(effectiveSessionK(sids, 3)).toBe(5); // 前 3 只够 2 个会话，补到 5
    expect(effectiveSessionK(sids, 1)).toBe(1);
    expect(effectiveSessionK([], 5)).toBe(0);
  });

  it("会话日期解析：支持 YYYY/MM/DD 与时:分", async () => {
    const { parseSessionDate } = await lme();
    const withTime = parseSessionDate("2023/04/10 (Mon) 17:50");
    expect(withTime).toBe(new Date(2023, 3, 10, 17, 50).getTime());
    const dateOnly = parseSessionDate("2022/12/01");
    expect(dateOnly).toBe(new Date(2022, 11, 1, 0, 0).getTime());
    expect(parseSessionDate("")).toBeUndefined();
    expect(parseSessionDate("not a date")).toBeUndefined();
  });
});

describe("longmemeval 文档切分", () => {
  const instance = {
    question_id: "q1",
    question_type: "single-session-user",
    question: "Where did I move?",
    answer: "Berlin",
    haystack_session_ids: ["s1", "s2"],
    haystack_dates: ["2023/01/01 (Sun) 10:00", "2023/02/02 (Thu) 11:00"],
    answer_session_ids: ["s1"],
    haystack_sessions: [
      [
        { role: "user", content: "I moved to Berlin.", has_answer: true },
        { role: "assistant", content: "Nice, how is it?" },
        { role: "user", content: "Cold in winter." },
      ],
      [
        { role: "assistant", content: "Any other question?" },
        { role: "user", content: "I like the parks." },
      ],
    ],
  };

  it("session 粒度：只写 user 发言、保留会话 id 与时间戳", async () => {
    const { buildDocs } = await lme();
    const docs = buildDocs(instance, { granularity: "session", roles: "user" });
    expect(docs).toHaveLength(2);
    expect(docs[0]).toMatchObject({ sid: "s1", docId: "s1", turn: 0, gold: false });
    expect(docs[0].content).toContain("I moved to Berlin.");
    expect(docs[0].content).toContain("Cold in winter.");
    expect(docs[0].content).not.toContain("Nice, how is it?");
    expect(docs[0].ts).toBe(new Date(2023, 0, 1, 10, 0).getTime());
    // 第二个会话只有一条 user 发言，assistant 不写
    expect(docs[1].content).toBe("I like the parks.");
  });

  it("roles=both 时把 assistant 发言也写进去", async () => {
    const { buildDocs } = await lme();
    const docs = buildDocs(instance, { granularity: "session", roles: "both" });
    expect(docs[0].content).toContain("Nice, how is it?");
  });

  it("turn 粒度：turn 序号从 1 起，has_answer 标记成 gold", async () => {
    const { buildDocs } = await lme();
    const docs = buildDocs(instance, { granularity: "turn", roles: "both" });
    expect(docs.map((d: any) => d.docId)).toEqual(["s1_1", "s1_2", "s1_3", "s2_1", "s2_2"]);
    expect(docs.map((d: any) => d.turn)).toEqual([1, 2, 3, 1, 2]);
    expect(docs.filter((d: any) => d.gold).map((d: any) => d.docId)).toEqual(["s1_1"]);
  });

  it("超长会话按 1900 字切块，块 id 带 # 后缀", async () => {
    const { buildDocs } = await lme();
    const long = {
      ...instance,
      haystack_session_ids: ["s1"],
      haystack_dates: ["2023/01/01"],
      haystack_sessions: [[
        { role: "user", content: "a".repeat(1500) },
        { role: "user", content: "b".repeat(1500) },
      ]],
    };
    const docs = buildDocs(long, { granularity: "session", roles: "user" });
    expect(docs).toHaveLength(2);
    expect(docs[0].docId).toBe("s1");
    expect(docs[1].docId).toBe("s1#2");
    for (const d of docs) expect(d.content.length).toBeLessThanOrEqual(1900);
  });
});

describe("longmemeval 端到端", () => {
  it("跑合成数据集：输出报告、跳过 abstention、指标落在 [0,1]", async () => {
    const dir = tmp();
    const dataFile = join(dir, "data.json");
    const reportFile = join(dir, "report.json");
    const outFile = join(dir, "rows.jsonl");
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

    const r = runCli([
      "run",
      "--data", dataFile,
      "--report", reportFile,
      "--out", outFile,
      "--quiet",
    ]);
    expect(r.status).toBe(0);

    const report = JSON.parse(readFileSync(reportFile, "utf8")) as Record<string, any>;
    expect(report.evaluated).toBe(1);
    expect(report.skippedAbstention).toBe(1);
    expect(report.granularity).toBe("session");
    expect(report.roles).toBe("user");
    expect(report.docs).toBe(2);
    expect(report.rejectedDocs).toBe(0);

    const session = report.overall?.session?.byK?.k10;
    expect(session).toBeTruthy();
    for (const key of ["recallAny", "recallAll", "ndcgAny"]) {
      expect(session[key]).toBeGreaterThanOrEqual(0);
      expect(session[key]).toBeLessThanOrEqual(1);
    }
    // 只有一个 gold 会话，召回后 recall_any 与 recall_all 应相等
    expect(session.recallAny).toBe(session.recallAll);

    const rows = readFileSync(outFile, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, any>);
    expect(rows).toHaveLength(1);
    expect(rows[0].questionId).toBe("q1");
    expect(rows[0].goldSessionIds).toEqual(["s1"]);
    expect(rows[0].metrics.session.k10.effectiveK).toBeGreaterThanOrEqual(1);
  });

  it("缺 --data / 未知命令时以非零码退出并给出用法", () => {
    const missing = runCli(["run"]);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("--data");

    const unknown = runCli(["nope"]);
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain("未知命令");

    const help = runCli(["--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("--granularity");
  });
});
