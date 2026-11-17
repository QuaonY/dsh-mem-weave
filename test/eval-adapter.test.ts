/**
 * bench/eval-adapter.mjs（外部记忆基准适配器）回归测试。
 * 覆盖两层：
 * 1. 纯函数：词形归一、gold 名次、上下文裁剪、指标汇总；
 * 2. 命令行端到端：run（一次跑完）与 ingest + retrieve（分两次跑，靠 .eval-ids.json 对齐 gold）。
 * 只跑 fixture（bench/fixtures），不依赖真实 DSH 环境，也不需要联网。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const root = join(__dirname, "..");
const script = join(root, "bench", "eval-adapter.mjs");
const fixtures = join(root, "bench", "fixtures");
const memoriesFile = join(fixtures, "eval-memories.jsonl");
const queriesFile = join(fixtures, "eval-queries.jsonl");

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "memweave-eval-test-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function runAdapter(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: "utf8", timeout: 120_000 });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function readJson(file: string): Record<string, any> {
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, any>;
}

function readJsonl(file: string): Array<Record<string, any>> {
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, any>);
}

let mod: Record<string, any> | null = null;
async function adapter(): Promise<Record<string, any>> {
  if (!mod) mod = (await import(pathToFileURL(script).href)) as Record<string, any>;
  return mod;
}

describe("eval-adapter 纯函数", () => {
  it("英文归一：词干把时态/复数归到一起，并去掉停用词", async () => {
    const { normalizeEn, stem } = await adapter();
    expect(stem("adopted")).toBe(stem("adopt"));
    expect(stem("moved")).toBe(stem("move"));
    expect(stem("lives")).toBe(stem("live"));
    expect(stem("cities")).toBe(stem("city"));
    const words: string[] = normalizeEn("The cats were adopted by Alice in Berlin");
    expect(words).toContain("cat");
    expect(words).toContain("adopt");
    expect(words).toContain("berlin");
    expect(words).not.toContain("the");
    expect(words).not.toContain("by");
    expect(normalizeEn("a adopted b")).toEqual(normalizeEn("a adopt b"));
  });

  it("gold 名次：走 idMap 把数据集 id 翻成库内 id，找不到记 0", async () => {
    const { goldRank } = await adapter();
    const hits = [{ entry: { id: "lib-1" } }, { entry: { id: "lib-2" } }];
    expect(goldRank(hits, ["m2"], { m2: "lib-2" })).toBe(2);
    expect(goldRank(hits, ["lib-1"], {})).toBe(1);
    expect(goldRank(hits, ["m9"], { m9: "lib-9" })).toBe(0);
    expect(goldRank(hits, [], {})).toBeNull();
    expect(goldRank(hits, undefined, {})).toBeNull();
  });

  it("上下文：按字符上限截断，不塞半行", async () => {
    const { buildContext } = await adapter();
    const hits = [
      { entry: { level: "fact", content: "aaaa" } },
      { entry: { level: "fact", content: "bbbb" } },
      { entry: { level: "topic", content: "cccc" } },
    ];
    const all = buildContext(hits, 1000);
    expect(all.split("\n")).toHaveLength(3);
    expect(all).toContain("1. [fact] aaaa");
    const clipped = buildContext(hits, 24);
    expect(clipped.split("\n")).toHaveLength(1);
    expect(clipped).not.toContain("bbbb");
  });

  it("指标汇总：hit@k 与 MRR 按带 gold 的条目计算", async () => {
    const { summarize } = await adapter();
    const rows = [
      { rank: 1, context: "x" },
      { rank: 3, context: "yy" },
      { rank: 0, context: "" },
      { rank: null, context: "zzz" },
    ];
    const s = summarize(rows);
    expect(s.queries).toBe(4);
    expect(s.graded).toBe(3);
    expect(s.hitAt1).toBeCloseTo(1 / 3);
    expect(s.hitAt3).toBeCloseTo(2 / 3);
    expect(s.hitAt5).toBeCloseTo(2 / 3);
    expect(s.mrr).toBeCloseTo((1 + 1 / 3) / 3);
    expect(s.withContext).toBe(3);
  });

  it("基准配置：prior 默认开，off 时关掉 surprise / sourceWeight", async () => {
    const { benchConfig } = await adapter();
    const on = benchConfig({});
    expect(on.write.surprise.enabled).toBe(true);
    expect(on.write.sourceWeight.enabled).toBe(true);
    expect(on.write.containment.enabled).toBe(false);
    expect(on.privacy.filterOnRecall).toBe(false);

    const off = benchConfig({ prior: "off" });
    expect(off.write.surprise.enabled).toBe(false);
    expect(off.write.sourceWeight.enabled).toBe(false);
    // 先验关闭不影响其它基准设置
    expect(off.write.containment.enabled).toBe(false);
    expect(off.lifecycle.halfLifeDays.fact).toBe(100000);
  });
});

describe("eval-adapter 命令行", () => {
  it("run：写入不合并、回填时间、手机号条目可召回，英文归一后 hit@3 满分", () => {
    const outDir = tmp();
    const out = join(outDir, "results.jsonl");
    const summaryFile = join(outDir, "summary.json");
    const r = runAdapter([
      "run",
      "--memories", memoriesFile,
      "--queries", queriesFile,
      "--normalize", "en",
      "--out", out,
      "--summary", summaryFile,
      "--quiet",
    ]);
    expect(r.status).toBe(0);

    const summary = readJson(summaryFile);
    expect(summary.queries).toBe(8);
    expect(summary.graded).toBe(8);
    expect(summary.hitAt3).toBe(1);
    expect(summary.mrr).toBeGreaterThanOrEqual(0.9);
    expect(summary.write.total).toBe(12);
    expect(summary.write.accepted).toBe(12);
    expect(summary.write.merged).toBe(0);
    expect(summary.write.skipped).toBe(0);
    expect(summary.write.backdated).toBe(12);
    expect(summary.write.idMapSize).toBe(12);

    const rows = readJsonl(out);
    expect(rows).toHaveLength(8);
    // 基准配置必须关掉 privacy 召回过滤：数据集里的手机号条目不能凭空消失
    const phone = rows.find((row) => row.id === "q2");
    expect(phone?.rank).toBe(1);
    expect(phone?.hits?.[0]?.ref).toBe("m4");
    for (const row of rows) expect(row.context.length).toBeGreaterThan(0);
  });

  it("默认 normalize=none 也不崩，hit@3 不低于回归下限", () => {
    const outDir = tmp();
    const summaryFile = join(outDir, "summary.json");
    const r = runAdapter([
      "run",
      "--memories", memoriesFile,
      "--queries", queriesFile,
      "--summary", summaryFile,
      "--quiet",
    ]);
    expect(r.status).toBe(0);
    const summary = readJson(summaryFile);
    expect(summary.write.accepted).toBe(12);
    expect(summary.hitAt3).toBeGreaterThanOrEqual(0.75);
    expect(summary.mrr).toBeGreaterThanOrEqual(0.6);
  });

  it("ingest + retrieve 分两步：id 映射落盘，gold 仍能对上", () => {
    const db = join(tmp(), "db");
    const out = join(tmp(), "retrieve.jsonl");

    const ingest = runAdapter([
      "ingest",
      "--memories", memoriesFile,
      "--db", db,
      "--normalize", "en",
      "--quiet",
    ]);
    expect(ingest.status).toBe(0);
    expect(existsSync(join(db, ".eval-ids.json"))).toBe(true);

    const retrieve = runAdapter([
      "retrieve",
      "--queries", queriesFile,
      "--db", db,
      "--normalize", "en",
      "--out", out,
      "--quiet",
    ]);
    expect(retrieve.status).toBe(0);
    const rows = readJsonl(out);
    expect(rows).toHaveLength(8);
    expect(rows.filter((row) => row.rank === 1).length).toBeGreaterThanOrEqual(7);
  });

  it("缺参数 / 未知参数时给出用法并以非零码退出", () => {
    const missing = runAdapter(["retrieve"]);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("--db");

    const unknown = runAdapter(["run", "--nope"]);
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain("未知参数");

    const badPrior = runAdapter(["run", "--prior", "maybe"]);
    expect(badPrior.status).toBe(1);
    expect(badPrior.stderr).toContain("--prior");

    const help = runAdapter(["--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("--normalize");
  });
});
