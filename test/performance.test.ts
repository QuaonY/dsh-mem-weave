/**
 * 性能优化：召回分词缓存、去同质剪枝、以及 a24 类查询的隐私误判修复。
 * 性能断言按本机实测留 5 倍余量，避免 CI 抖动。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { diversify, type RankedHit } from "../src/core/score";
import type { MemoryEntry } from "../src/core/types";
import { openService } from "../src/host/index";
import { clearDocTokenCache } from "../src/host/service";
import { insertMemory, newId } from "../src/store/dao";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  clearDocTokenCache();
});

function open() {
  const dir = mkdtempSync(join(tmpdir(), "memweave-m84-"));
  dirs.push(dir);
  return openService(dir);
}

describe("a24：局域网地址不再误判为敏感", () => {
  it("含路由器管理地址的记忆可以被召回", async () => {
    const rt = open();
    try {
      const out = await rt.service.remember(
        { level: "fact", project: null, content: "家里路由器管理地址是 192.168.31.1" },
        "human",
        { sessionId: "s1", turn: 1 },
      );
      expect(out.ok).toBe(true);
      const hits = rt.service.recall("路由器 管理地址", { limit: 5 });
      expect(hits.map((h) => h.id)).toContain(out.id);
    } finally {
      rt.env.close();
    }
  });

  it("公网 IP 在召回时脱敏但保留条目（起默认脱敏）", async () => {
    const rt = open();
    try {
      const out = await rt.service.remember(
        { level: "fact", project: null, content: "服务器公网地址是 8.8.8.8" },
        "human",
        { sessionId: "s1", turn: 1 },
      );
      expect(out.ok).toBe(true);
      expect(rt.service.getSensitiveMemories("fact").map((m) => m.id)).toContain(out.id);

      const hits = rt.service.recall("服务器 公网地址", { limit: 5 });
      const hit = hits.find((h) => h.id === out.id);
      expect(hit).toBeTruthy();
      expect(hit!.entry.content).toContain("8.8.*.*");
      expect(hit!.entry.content).not.toContain("8.8.8.8");
    } finally {
      rt.env.close();
    }
  });

  it("privacy.recallPolicy=filter 时仍整条过滤（旧行为可切回）", async () => {
    const rt = open();
    try {
      rt.service.config.privacy = {
        enabled: true,
        strictMode: false,
        detectPII: true,
        filterOnRecall: true,
        recallPolicy: "filter",
        whitelist: [],
      };
      const out = await rt.service.remember(
        { level: "fact", project: null, content: "服务器公网地址是 8.8.8.8" },
        "human",
        { sessionId: "s1", turn: 1 },
      );
      expect(out.ok).toBe(true);
      expect(rt.service.recall("服务器 公网地址", { limit: 5 })).toHaveLength(0);
    } finally {
      rt.env.close();
    }
  });
});

describe("召回分词缓存", () => {
  it("改写条目后缓存失效，旧词不再命中", async () => {
    const rt = open();
    try {
      const out = await rt.service.remember(
        { level: "fact", project: null, content: "旧内容：项目使用 PostgreSQL 数据库" },
        "human",
        { sessionId: "s1", turn: 1 },
      );
      expect(rt.service.recall("PostgreSQL", { limit: 5 }).map((h) => h.id)).toContain(out.id);

      const revised = await rt.service.revise(out.id!, { content: "新内容：项目改用 MySQL 数据库", keywords: [] }, "human");
      expect(revised.ok).toBe(true);

      expect(rt.service.recall("PostgreSQL", { limit: 5 }).map((h) => h.id)).not.toContain(out.id);
      expect(rt.service.recall("MySQL", { limit: 5 }).map((h) => h.id)).toContain(out.id);
    } finally {
      rt.env.close();
    }
  });

  it("1k 条记忆：热缓存明显快于首次召回，且单次不超过数量级护栏", () => {
    const rt = open();
    try {
      // 直接走 dao 批量写入，避免治理层合并掉相似样本
      const ts = Date.now();
      for (let i = 0; i < 1000; i++) {
        insertMemory(rt.env, {
          id: newId(),
          level: "fact",
          project: null,
          section: null,
          content: `记忆 ${i}：主题 ${i % 20} 的测试内容，包含检索样本`,
          keywords: [`主题${i % 20}`, `样本${i}`],
          importance: 3,
          status: "active",
          semanticKey: null,
          confidence: null,
          validFrom: ts,
          validTo: null,
          evidence: [],
          hash: null,
          source: "test",
          accessCount: 0,
          tier: "hot",
          createdAt: ts,
          updatedAt: ts,
        } satisfies MemoryEntry);
      }
      const timeOnce = () => {
        const t = performance.now();
        rt.service.recall("检索 样本", { limit: 5 });
        return performance.now() - t;
      };
      const cold = timeOnce(); // 首次：对全库分词
      const times = Array.from({ length: 40 }, timeOnce);
      times.sort((a, b) => a - b);
      const median = times[Math.floor(times.length / 2)];
      const p95 = times[Math.floor(times.length * 0.95)];
      // 缓存是否生效用「同一台机器、同一负载下热缓存快于首次」判断，
      // 不拿绝对毫秒数卡阈值：CI 机器快慢与并行负载都会让绝对值抖动。
      expect(median).toBeLessThan(cold);
      // 只挡数量级回退（秒级），真实性能门槛由 test/scale-bench.test.ts 负责
      expect(p95).toBeLessThan(600);
    } finally {
      rt.env.close();
    }
  });
});

describe("去同质剪枝与全量贪心等价", () => {
  const cfg = { enabled: true, threshold: 0.5, factors: [1, 0.86, 0.72, 0.6] };

  /** 参考实现：不做提前停止的全量贪心 */
  function reference(hits: RankedHit[], limit: number, sim: (a: RankedHit, b: RankedHit) => number) {
    const remaining = [...hits];
    const selected: RankedHit[] = [];
    while (selected.length < limit && remaining.length > 0) {
      let bestIdx = 0;
      let bestScore = -Infinity;
      let bestFactor = 1;
      for (let i = 0; i < remaining.length; i += 1) {
        const h = remaining[i];
        const k = selected.filter((s) => sim(h, s) >= cfg.threshold).length;
        const fac = cfg.factors[Math.min(k, cfg.factors.length - 1)];
        const sc = h.score * fac;
        if (sc > bestScore || (sc === bestScore && h.id < remaining[bestIdx].id)) {
          bestIdx = i;
          bestScore = sc;
          bestFactor = fac;
        }
      }
      const [pick] = remaining.splice(bestIdx, 1);
      selected.push(bestFactor === 1 ? pick : { ...pick, score: bestScore, explain: `${pick.explain}; div=${bestFactor.toFixed(2)}` });
    }
    return selected;
  }

  it("200 条候选、含并列分数时结果一致", () => {
    let seed = 20261110;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const hits: RankedHit[] = Array.from({ length: 200 }, (_, i) => ({
      id: `h${String(i).padStart(3, "0")}`,
      // 只保留 20 档分数，制造大量并列
      score: Math.round(rnd() * 20),
      routes: ["keyword"],
      explain: "",
      entry: { id: `h${i}` } as MemoryEntry,
    }));
    const sets = new Map(hits.map((h) => [h.id, new Set(Array.from({ length: 6 }, () => `t${Math.floor(rnd() * 5)}`))]));
    const sim = (a: RankedHit, b: RankedHit): number => {
      const x = sets.get(a.id)!;
      const y = sets.get(b.id)!;
      let inter = 0;
      for (const t of x) if (y.has(t)) inter += 1;
      return inter / (x.size + y.size - inter);
    };

    const fast = diversify(hits, 12, sim, cfg);
    const slow = reference(hits, 12, sim);
    expect(fast.map((h) => h.id)).toEqual(slow.map((h) => h.id));
    expect(fast.map((h) => h.score)).toEqual(slow.map((h) => h.score));
  });
});
