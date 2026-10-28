/**
 * roadmap v0.2 G15：检索基准。用 vitest 跑（test/bench.test.ts），也可单独 import。
 * 指标：auto+改述 60 条前 3 名命中率 / MRR@5 / 平均注入字符；关联查询前 5 名命中率；去同质前 3 名命中率。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { WeaveService } from "../src/host/service";
import type { Level } from "../src/core/types";

interface SeedItem { key: string; level: Level; project?: string; content: string; q: string }
interface Seed {
  auto: SeedItem[];
  paraphrase: Array<{ target: string; q: string }>;
  link: Array<{ session: string; anchor: { level: Level; project?: string; content: string }; target: { level: Level; project?: string; content: string }; q: string }>;
  diversity: Array<{ q: string; keywords: string[]; cluster: string[]; different: { content: string; keywords: string[] } }>;
}

export interface BenchResult {
  queries: number;
  top3: number;
  mrr: number;
  avgChars: number;
  linkTop5: number;
  diversityTop3: number;
  misses: string[];
}

export function loadSeed(): Seed {
  return JSON.parse(readFileSync(join(__dirname, "seed.json"), "utf8")) as Seed;
}

/** roadmap v0.7 §6.6：全新子代理只看正文生成的检索词（key → 词表） */
export function loadTerms(): Record<string, string[]> {
  return JSON.parse(readFileSync(join(__dirname, "terms.json"), "utf8")) as Record<string, string[]>;
}

export type BenchMode = "legacy" | "new" | "phaseD" | "phaseE" | "terms";

/** legacy = 关掉 roadmap 全部新开关 + 恢复访问加成（≈ 0.1.27 行为） */
export function applyMode(service: WeaveService, mode: BenchMode): void {
  const on = mode !== "legacy";
  // phaseD = new + 阶段 D 两个默认关的开关（R11 意图加权、R10 闪光灯）都打开
  // phaseE（v0.6 §10）= phaseD + M1–M4 全开（M4 残响默认关，这里打开）
  const d = mode === "phaseD" || mode === "phaseE";
  service.config.recall.intent.enabled = d;
  service.config.emotion.enabled = d;
  service.config.emotion.residue = { enabled: mode === "phaseE", floor: 0.55, minValence: 0.5 };
  service.config.promise.enabled = on;
  service.config.calendar.enabled = on;
  // terms（v0.7 §6.6）= new + 写入时带 bench/terms.json 的检索词；其它模式不写检索词
  service.config.searchTerms.enabled = mode === "terms";
  const c = service.config;
  c.governance.requireConfirmFor = [];
  c.links.autoLink.enabled = on;
  c.write.surprise.enabled = on;
  c.write.sourceWeight.enabled = on;
  c.write.containment.enabled = on;
  c.recall.diversity.enabled = on;
  c.recall.rumination.enabled = on;
  c.recall.legacyAccessBonus = !on;
}

export async function runBench(service: WeaveService, seed: Seed = loadSeed(), terms?: Record<string, string[]>): Promise<BenchResult> {
  const ids = new Map<string, string>();
  let turn = 0;
  for (const s of seed.auto) {
    turn += 1;
    const st = terms?.[s.key];
    const out = await service.remember({ level: s.level, project: s.project ?? null, content: s.content }, "human", {
      sessionId: "bench-auto",
      turn: turn * 10,
      ...(st ? { searchTerms: st } : {}),
    });
    const id = out.mergedInto ?? out.id;
    if (id) ids.set(s.key, id);
  }
  const linkTargets: string[] = [];
  for (const l of seed.link) {
    await service.remember({ ...l.anchor, project: l.anchor.project ?? null }, "agent", { sessionId: l.session, turn: 1 });
    const t = await service.remember({ ...l.target, project: l.target.project ?? null }, "agent", { sessionId: l.session, turn: 1 });
    linkTargets.push(t.mergedInto ?? t.id ?? "");
  }
  const divTargets: string[] = [];
  for (const [i, d] of seed.diversity.entries()) {
    for (const [j, c] of d.cluster.entries()) {
      await service.remember({ level: "fact", content: c, keywords: d.keywords, importance: 3 }, "agent", { sessionId: "bench-div-" + i + "-" + j, turn: 1 });
    }
    const t = await service.remember({ level: "fact", content: d.different.content, keywords: d.different.keywords, importance: 3 }, "agent", { sessionId: "bench-div-" + i + "-x", turn: 1 });
    divTargets.push(t.mergedInto ?? t.id ?? "");
  }

  const misses: string[] = [];
  const main: Array<{ q: string; target: string; label: string }> = [
    ...seed.auto.map((s) => ({ q: s.q, target: ids.get(s.key) ?? "", label: s.key })),
    ...seed.paraphrase.map((p) => ({ q: p.q, target: ids.get(p.target) ?? "", label: "p:" + p.target })),
  ];
  let top3 = 0;
  let rr = 0;
  let chars = 0;
  for (const m of main) {
    const hits = service.recall(m.q, { limit: 5 });
    chars += hits.reduce((n, h) => n + h.entry.content.length, 0);
    const rank = hits.findIndex((h) => h.id === m.target);
    if (rank >= 0 && rank < 3) top3 += 1;
    else misses.push(m.label + "「" + m.q + "」");
    if (rank >= 0) rr += 1 / (rank + 1);
  }
  let linkHit = 0;
  seed.link.forEach((l, i) => {
    if (service.recall(l.q, { limit: 5 }).some((h) => h.id === linkTargets[i])) linkHit += 1;
    else misses.push("link:" + l.session);
  });
  let divHit = 0;
  seed.diversity.forEach((d, i) => {
    if (service.recall(d.q, { limit: 3 }).some((h) => h.id === divTargets[i])) divHit += 1;
    else misses.push("div:" + d.q);
  });
  return {
    queries: main.length,
    top3: top3 / main.length,
    mrr: rr / main.length,
    avgChars: Math.round(chars / main.length),
    linkTop5: linkHit / seed.link.length,
    diversityTop3: divHit / seed.diversity.length,
    misses,
  };
}
