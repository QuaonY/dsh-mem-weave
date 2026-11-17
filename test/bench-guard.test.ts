/**
 * 基准护栏 bench/guard.mjs 的回归测试。
 * 覆盖：
 * 1. 抽指标：LME / LoCoMo 报告 → 护栏指标键，缺字段自动跳过；
 * 2. 比对：下降正好 1 点通过、超过 1 点失败、提升通过、指标缺失算失败；
 * 3. 题数校验：子集跑分不能与全量基线比较；
 * 4. CLI：--help、数据集缺失跳过、--require-all、复用报告通过 / 回归退出码 1。
 * 不联网、不读真实数据集，全部用合成报告。
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const root = join(__dirname, "..");
const script = join(root, "bench", "guard.mjs");
const baselineFile = join(root, "bench", "guard-baseline.json");

type Metrics = Record<string, number>;
let mod: Record<string, any> | null = null;
async function guard(): Promise<Record<string, any>> {
  if (!mod) mod = (await import(pathToFileURL(script).href)) as Record<string, any>;
  return mod;
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "memweave-guard-test-"));
  dirs.push(d);
  return d;
}

const BASELINE = JSON.parse(readFileSync(baselineFile, "utf8")) as { metrics: Metrics; counts: Record<string, number> };

/**
 * 纯函数与回归用固定夹具，刻意不读 `bench/guard-baseline.json`：
 * 基线会随真实跑分更新（起已是实测未舍入值），断言不应随之漂移。
 * 这里的数字是 的舍入值，只为让 -1.60 这类期望值可读。
 */
const FIXTURE: Metrics = {
  "lme.session.k5.recall_any": 0.962,
  "lme.session.k5.recall_all": 0.845,
  "lme.session.k5.ndcg": 0.856,
  "lme.session.k10.recall_any": 0.972,
  "lme.session.k10.recall_all": 0.904,
  "lme.session.k10.ndcg": 0.872,
  "locomo.turn.k5.recall_any": 0.589,
  "locomo.turn.k5.recall_all": 0.506,
  "locomo.turn.k5.recall_mean": 0.542,
  "locomo.turn.k5.ndcg": 0.493,
  "locomo.turn.k5.ans_in_ctx": 0.223,
  "locomo.turn.k10.recall_any": 0.672,
  "locomo.turn.k10.recall_all": 0.578,
  "locomo.turn.k10.recall_mean": 0.621,
  "locomo.turn.k10.ndcg": 0.52,
  "locomo.turn.k10.ans_in_ctx": 0.255,
};
const FIXTURE_COUNTS = { lme: 470, locomo: 1982 };

/** 写一份固定夹具基线，供需要已知数值的 CLI 用例使用 */
function fixtureBaseline(dir: string): string {
  const file = join(dir, "baseline.json");
  writeFileSync(
    file,
    JSON.stringify(
      { version: "test", commit: "test", recordedAt: "2026-01-01", tolerance: 0.01, counts: FIXTURE_COUNTS, metrics: FIXTURE },
      null,
      2,
    ),
  );
  return file;
}

/** 用基线数值反向造一份等价的 LME 报告 */
function lmeReport(metrics: Metrics, evaluated = FIXTURE_COUNTS.lme): Record<string, any> {
  const byK: Record<string, any> = {};
  for (const k of [5, 10]) {
    byK[`k${k}`] = {
      recallAny: metrics[`lme.session.k${k}.recall_any`],
      recallAll: metrics[`lme.session.k${k}.recall_all`],
      ndcgAny: metrics[`lme.session.k${k}.ndcg`],
    };
  }
  return { ks: [5, 10], evaluated, overall: { session: { byK } } };
}

/** 用基线数值反向造一份等价的 LoCoMo 报告 */
function locomoReport(metrics: Metrics, questions = FIXTURE_COUNTS.locomo): Record<string, any> {
  const byK: Record<string, any> = {};
  for (const k of [5, 10]) {
    byK[`k${k}`] = {
      recallAny: metrics[`locomo.turn.k${k}.recall_any`],
      recallAll: metrics[`locomo.turn.k${k}.recall_all`],
      recallMean: metrics[`locomo.turn.k${k}.recall_mean`],
      ndcgAny: metrics[`locomo.turn.k${k}.ndcg`],
      answerInContext: metrics[`locomo.turn.k${k}.ans_in_ctx`],
    };
  }
  return { ks: [5, 10], questions, overall: { byK } };
}

function writeReport(dir: string, name: string, report: unknown): string {
  const file = join(dir, name);
  writeFileSync(file, JSON.stringify(report, null, 2));
  return file;
}

function cli(args: string[]): { status: number; out: string; err: string } {
  const r = spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, MEMWEAVE_LME_DATA: "", MEMWEAVE_LOCOMO_DATA: "" },
  });
  return { status: r.status ?? -1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

describe("bench:guard 纯函数", () => {
  it("从 LME 报告抽出 6 项指标，缺 k 或缺字段时自动跳过", async () => {
    const g = await guard();
    const full = g.extractMetrics(lmeReport(FIXTURE), "lme");
    expect(Object.keys(full)).toHaveLength(6);
    expect(full["lme.session.k5.recall_any"]).toBeCloseTo(0.962, 6);
    expect(full["lme.session.k10.ndcg"]).toBeCloseTo(0.872, 6);

    const partial = g.extractMetrics(
      { ks: [5], overall: { session: { byK: { k5: { recallAny: 0.9, recallAll: null, ndcgAny: 0.8 } } } } },
      "lme",
    );
    expect(Object.keys(partial)).toEqual(["lme.session.k5.recall_any", "lme.session.k5.ndcg"]);
  });

  it("从 LoCoMo 报告抽出 10 项指标", async () => {
    const g = await guard();
    const m = g.extractMetrics(locomoReport(FIXTURE), "locomo");
    expect(Object.keys(m)).toHaveLength(10);
    expect(m["locomo.turn.k5.ans_in_ctx"]).toBeCloseTo(0.223, 6);
    expect(m["locomo.turn.k10.recall_mean"]).toBeCloseTo(0.621, 6);
  });

  it("下降正好 1 点通过，超过 1 点失败，提升通过", async () => {
    const g = await guard();
    const base = { "lme.session.k5.recall_any": 0.962 };

    const exact = g.compareMetrics(base, { "lme.session.k5.recall_any": 0.952 });
    expect(exact.failures).toHaveLength(0);

    const over = g.compareMetrics(base, { "lme.session.k5.recall_any": 0.9519 });
    expect(over.failures).toHaveLength(1);
    expect(over.failures[0].reason).toBe("regression");
    // 1.01 点不能因为浮点误差漏判
    expect(over.failures[0].drop).toBeGreaterThan(0.01);

    const better = g.compareMetrics(base, { "lme.session.k5.recall_any": 0.99 });
    expect(better.failures).toHaveLength(0);
  });

  it("基线有、本次报告缺失的指标算失败", async () => {
    const g = await guard();
    const { failures } = g.compareMetrics({ "locomo.turn.k5.ndcg": 0.493 }, {});
    expect(failures).toEqual([
      { name: "locomo.turn.k5.ndcg", baseline: 0.493, current: null, drop: null, reason: "missing" },
    ]);
  });

  it("题数不一致直接判为错误（子集跑分）", async () => {
    const g = await guard();
    expect(g.checkCounts({ lme: 470, locomo: 1982 }, { lme: 470, locomo: 1982 })).toEqual([]);
    const errors = g.checkCounts({ lme: 470, locomo: 1982 }, { lme: 50, locomo: 1982 });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("子集");
    expect(g.checkCounts({ lme: 470 }, {})).toHaveLength(1);
  });
});

describe("bench:guard 基线文件", () => {
  it("仓库基线是 16 项指标 + 题数，数值落在 [0,1]", () => {
    expect(Object.keys(BASELINE.metrics)).toHaveLength(16);
    expect(BASELINE.counts).toEqual({ lme: 470, locomo: 1982 });
    for (const [name, v] of Object.entries(BASELINE.metrics)) {
      expect(typeof v, name).toBe("number");
      expect(v, name).toBeGreaterThanOrEqual(0);
      expect(v, name).toBeLessThanOrEqual(1);
    }
  });
});

describe("bench:guard CLI", () => {
  it("--help 打印用法并返回 0", () => {
    const r = cli(["--help"]);
    expect(r.status).toBe(0);
    expect(r.out).toContain("--update");
    expect(r.out).toContain("--note");
  });

  it("数据集缺失时跳过并返回 0；--require-all 返回 2", () => {
    const skip = cli(["--lme-data", join(tmpDir(), "nope.json"), "--locomo-data", join(tmpDir(), "nope.json")]);
    expect(skip.status).toBe(0);
    expect(skip.out).toContain("跳过");

    const strict = cli([
      "--require-all",
      "--lme-data",
      join(tmpDir(), "nope.json"),
      "--locomo-data",
      join(tmpDir(), "nope.json"),
    ]);
    expect(strict.status).toBe(2);
  });

  it("复用与基线一致的两份报告：逐项比对通过", () => {
    const dir = tmpDir();
    const baseline = fixtureBaseline(dir);
    const lme = writeReport(dir, "lme.json", lmeReport(FIXTURE, FIXTURE_COUNTS.lme));
    const locomo = writeReport(dir, "locomo.json", locomoReport(FIXTURE, FIXTURE_COUNTS.locomo));
    const r = cli(["--baseline", baseline, "--lme-report", lme, "--locomo-report", locomo]);
    expect(r.status).toBe(0);
    expect(r.out).toContain("16 项指标");
    expect(r.out).toContain("通过");
  });

  it("任一指标下降超过 1 点：退出码 1 并指出指标", () => {
    const dir = tmpDir();
    const baseline = fixtureBaseline(dir);
    const metrics = { ...FIXTURE, "locomo.turn.k5.recall_all": 0.49 };
    const lme = writeReport(dir, "lme.json", lmeReport(metrics, FIXTURE_COUNTS.lme));
    const locomo = writeReport(dir, "locomo.json", locomoReport(metrics, FIXTURE_COUNTS.locomo));
    const r = cli(["--baseline", baseline, "--lme-report", lme, "--locomo-report", locomo]);
    expect(r.status).toBe(1);
    expect(r.err).toContain("locomo.turn.k5.recall_all");
    expect(r.err).toContain("-1.60");
  });

  it("报告缺指标同样退出 1", () => {
    const dir = tmpDir();
    const baseline = fixtureBaseline(dir);
    const metrics = { ...FIXTURE };
    delete metrics["lme.session.k10.ndcg"];
    const lme = writeReport(dir, "lme.json", lmeReport(metrics, FIXTURE_COUNTS.lme));
    const r = cli(["--baseline", baseline, "--lme-report", lme, "--skip-locomo"]);
    expect(r.status).toBe(1);
    expect(r.err).toContain("缺少该指标");
  });

  it("题目数是子集时退出 2，不与全量基线比较", () => {
    const dir = tmpDir();
    const baseline = fixtureBaseline(dir);
    const lme = writeReport(dir, "lme.json", lmeReport(FIXTURE, 50));
    const r = cli(["--baseline", baseline, "--lme-report", lme, "--skip-locomo"]);
    expect(r.status).toBe(2);
    expect(r.err).toContain("子集");
  });

  it("--update 只覆盖跑过的基准，未跑的指标保留", () => {
    const dir = tmpDir();
    const target = join(dir, "baseline.json");
    writeFileSync(target, JSON.stringify({ metrics: FIXTURE, counts: FIXTURE_COUNTS }, null, 2));
    const better = { ...FIXTURE, "lme.session.k5.recall_any": 0.98 };
    const lme = writeReport(dir, "lme.json", lmeReport(better, FIXTURE_COUNTS.lme));
    const r = cli(["--lme-report", lme, "--skip-locomo", "--baseline", target, "--update", "--note", "测试口径"]);
    expect(r.status).toBe(0);
    const saved = JSON.parse(readFileSync(target, "utf8")) as {
      metrics: Metrics;
      counts: Record<string, number>;
      recordedAt: string;
      note: string;
    };
    expect(saved.metrics["lme.session.k5.recall_any"]).toBeCloseTo(0.98, 6);
    expect(saved.metrics["locomo.turn.k5.recall_any"]).toBeCloseTo(0.589, 6);
    expect(saved.counts).toEqual(FIXTURE_COUNTS);
    expect(saved.recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(saved.note).toBe("测试口径");
  });
});
