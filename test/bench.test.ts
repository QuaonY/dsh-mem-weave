/**
 * roadmap v0.2 G15：检索基准回归。
 * 新基线（D10）记录在 bench/baseline.json；之后每次改动 top3 不低于基线 −0.01、MRR 不低于基线 −0.02。
 * v0.6 §10 phaseE：M1–M4 全开不低于 new 的容差。
 * v0.7 §6.6 terms：写入带检索词后，改述多救回 ≥ 2 条，top3 / MRR 在容差内，关联不降，注入增量 ≤ 20%。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { openService } from "../src/host/index";
import { applyMode, loadTerms, runBench, type BenchMode, type BenchResult } from "../bench/run";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function bench(mode: BenchMode): Promise<BenchResult> {
  const dir = mkdtempSync(join(tmpdir(), "memweave-bench-"));
  dirs.push(dir);
  const rt = openService(dir);
  try {
    applyMode(rt.service, mode);
    return await runBench(rt.service, undefined, mode === "terms" ? loadTerms() : undefined);
  } finally {
    rt.env.close();
  }
}

const BASELINE = join(__dirname, "..", "bench", "baseline.json");
const paraMiss = (r: BenchResult): number => r.misses.filter((m) => m.startsWith("p:")).length;

describe("G15 检索基准", () => {
  it("新公式不低于基线；关联查询前 5 名 ≥ 60%；phaseE / terms 过通过线", async () => {
    const legacy = await bench("legacy");
    const now = await bench("new");
    // roadmap §6 R11/R10：默认关；打开后基准不降才建议默认开
    const phaseD = await bench("phaseD");
    const phaseE = await bench("phaseE");
    const terms = await bench("terms");
    writeFileSync(join(__dirname, "..", "bench", "last.json"), JSON.stringify({ legacy, new: now, phaseD, phaseE, terms }, null, 2) + "\n");
    expect(phaseD.top3).toBeGreaterThanOrEqual(now.top3 - 0.01);
    expect(phaseD.mrr).toBeGreaterThanOrEqual(now.mrr - 0.02);
    expect(phaseD.linkTop5).toBeGreaterThanOrEqual(0.6);
    expect(phaseE.top3).toBeGreaterThanOrEqual(now.top3 - 0.01);
    expect(phaseE.mrr).toBeGreaterThanOrEqual(now.mrr - 0.02);
    expect(phaseE.linkTop5).toBeGreaterThanOrEqual(0.6);
    // §6.6 通过线
    expect(paraMiss(now) - paraMiss(terms)).toBeGreaterThanOrEqual(2);
    expect(terms.top3).toBeGreaterThanOrEqual(now.top3 - 0.01);
    expect(terms.mrr).toBeGreaterThanOrEqual(now.mrr - 0.02);
    expect(terms.linkTop5).toBeGreaterThanOrEqual(now.linkTop5);
    expect(terms.avgChars).toBeLessThanOrEqual(now.avgChars * 1.2);
    expect(now.queries).toBe(60);
    expect(now.linkTop5).toBeGreaterThanOrEqual(0.6);
    expect(now.top3).toBeGreaterThanOrEqual(0.85);
    if (existsSync(BASELINE)) {
      const base = JSON.parse(readFileSync(BASELINE, "utf8")) as { new: BenchResult };
      expect(now.top3).toBeGreaterThanOrEqual(base.new.top3 - 0.01);
      expect(now.mrr).toBeGreaterThanOrEqual(base.new.mrr - 0.02);
      expect(now.linkTop5).toBeGreaterThanOrEqual(base.new.linkTop5);
    }
  }, 120000);
});
