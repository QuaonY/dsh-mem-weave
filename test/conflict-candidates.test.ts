/**
 * 冲突候选对生成（前缀过滤）回归测试。
 * 核心约定：候选对必须与暴力两两比较**结果一致**（不丢真冲突、不多出不达标对）
 * 且 detectConflicts 的输出顺序保持稳定。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCandidatePairs, CANDIDATE_MIN_SIMILARITY } from "../src/conflict/candidates";
import { jaccard, tokenSet } from "../src/conflict/tokens";
import { ConflictDetector } from "../src/conflict/detector";
import { WeaveService, defaultConfig } from "../src/host/service";
import { openWeaveDb } from "../src/store/db";
import { ensureSchema } from "../src/store/migrate";
import { insertMemory } from "../src/store/dao";
import type { Level, MemoryEntry } from "../src/core/types";

/** 线性同余伪随机，保证用例可复现。 */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function makeEntry(
  id: string,
  level: Level,
  content: string,
  patch: Partial<MemoryEntry> = {},
): MemoryEntry {
  const now = Date.now();
  return {
    id,
    level,
    project: null,
    section: null,
    content,
    keywords: [],
    importance: 3,
    status: "active",
    semanticKey: null,
    confidence: null,
    validFrom: null,
    validTo: null,
    evidence: [],
    hash: null,
    source: "test",
    accessCount: 0,
    tier: "hot",
    createdAt: now,
    updatedAt: now,
    ...patch,
  };
}

/** 暴力解：所有 Jaccard ≥ 阈值、按下标升序的下标对。 */
function brutePairs(docs: Array<{ content: string }>, t = CANDIDATE_MIN_SIMILARITY): Array<[number, number]> {
  const sets = docs.map((d) => tokenSet(d.content));
  const out: Array<[number, number]> = [];
  for (let i = 0; i < docs.length; i++) {
    for (let j = i + 1; j < docs.length; j++) {
      if (jaccard(sets[i], sets[j]) >= t) out.push([i, j]);
    }
  }
  return out;
}

describe("Conflict Candidates", () => {
  describe("候选对生成", () => {
    it("应与暴力 Jaccard 过滤完全一致（确定性混合语料）", () => {
      const vocab = [
        "alpha", "beta", "gamma", "delta", "epsilon", "zeta",
        "项目", "进度", "会议", "用户", "喜欢", "导出", "数据", "系统", "版本", "认证",
      ];
      const rng = makeRng(42);
      const docs: Array<{ id: string; content: string }> = [];
      for (let i = 0; i < 400; i++) {
        const len = 3 + Math.floor(rng() * 5);
        const words = new Set<string>();
        while (words.size < len) words.add(vocab[Math.floor(rng() * vocab.length)]);
        docs.push({ id: `d${i}`, content: [...words].join(" ") });
      }

      const { pairs } = buildCandidatePairs(docs);
      expect(pairs).toEqual(brutePairs(docs));
    });

    it("应包含相似度恰好为 0.5 的边界对", () => {
      // tokens: {alpha,beta,gamma} vs {alpha,beta,delta} → 2/4 = 0.5
      const docs = [
        { id: "a", content: "alpha beta gamma" },
        { id: "b", content: "alpha beta delta" },
        { id: "c", content: "gamma delta epsilon" },
      ];
      const { pairs } = buildCandidatePairs(docs);
      expect(pairs).toEqual([[0, 1]]);
    });

    it("空内容 / 纯标点 / 空白不应产生候选对或抛错", () => {
      const docs = [
        { id: "a", content: "" },
        { id: "b", content: "   " },
        { id: "c", content: "！！！，。；" },
        { id: "d", content: "alpha beta" },
      ];
      const result = buildCandidatePairs(docs);
      expect(result.pairs).toEqual([]);
      expect(result.stats.documents).toBe(4);
      expect(result.stats.pairsCompared).toBe(0);
    });

    it("少于两条记忆时直接返回空结果", () => {
      expect(buildCandidatePairs([]).pairs).toEqual([]);
      expect(buildCandidatePairs([{ id: "a", content: "alpha" }]).pairs).toEqual([]);
    });

    it("相同内容的多条记忆应两两成为候选（并集规模退化时仍正确）", () => {
      const docs = Array.from({ length: 6 }, (_, i) => ({ id: `d${i}`, content: "用户喜欢蓝色" }));
      const { pairs } = buildCandidatePairs(docs);
      expect(pairs).toEqual(brutePairs(docs));
      expect(pairs.length).toBe(15);
    });

    it("2000 条中文语料：候选对显著少于 n² 且每对都真的达到阈值", () => {
      const subjects = ["用户", "系统", "项目", "服务", "接口", "页面", "数据库", "缓存", "任务", "日志"];
      const verbs = ["喜欢", "不支持", "完成了", "回滚了", "优化了", "删除了", "迁移到", "依赖", "替换为", "校验"];
      const objects = ["蓝色主题", "导出功能", "认证流程", "检索性能", "部署脚本", "监控告警", "权限模型", "备份策略", "分页逻辑", "索引结构"];
      const tails = ["", "，需要在周五前确认", "，目前状态正常", "，已经上线", "，等待评审", "，有已知问题", "，影响面较小", "，下个版本处理"];
      const extra = Array.from({ length: 600 }, (_, i) => `词${i}`);
      const rng = makeRng(20261112);
      const pick = (arr: string[]) => arr[Math.floor(rng() * arr.length)];

      const docs = Array.from({ length: 2000 }, (_, i) => ({
        id: `m${i}`,
        content: `${pick(subjects)}${pick(verbs)}${pick(objects)}${pick(tails)}，${pick(extra)} ${pick(extra)} 编号${i}`,
      }));

      const started = performance.now();
      const { pairs, stats } = buildCandidatePairs(docs);
      const elapsed = performance.now() - started;

      const totalPairs = (2000 * 1999) / 2;
      expect(stats.documents).toBe(2000);
      expect(stats.truncatedDocs).toBe(0);
      expect(pairs.length).toBeGreaterThan(0);
      expect(stats.pairsCompared).toBeLessThan(totalPairs * 0.5);
      expect(elapsed).toBeLessThan(5000);

      // 候选对必须全部达到阈值：不允许前缀过滤把明显不同的对塞进来
      const sets = docs.map((d) => tokenSet(d.content));
      for (const [i, j] of pairs) {
        expect(jaccard(sets[i], sets[j])).toBeGreaterThanOrEqual(CANDIDATE_MIN_SIMILARITY);
      }
    });

    it("top-k 模式：候选数有硬上限，被截断时仍只返回达标对", () => {
      // 每 20 条共享同一组主题 token，且公共汉字覆盖所有文档 → 未截断时是 n²
      const docs = Array.from({ length: 600 }, (_, i) => {
        const cluster = i % 20;
        return {
          id: `m${i}`,
          content: `主题${cluster} 记录${i} 项目进度 milestone${cluster} item${i}`,
        };
      });
      const k = 50;
      const { pairs, stats } = buildCandidatePairs(docs, { maxCandidatesPerDoc: k });

      expect(stats.truncatedDocs).toBeGreaterThan(0);
      expect(stats.pairsCompared).toBeLessThanOrEqual(docs.length * k);
      expect(pairs.length).toBeGreaterThan(0);

      const sets = docs.map((d) => tokenSet(d.content));
      for (const [i, j] of pairs) {
        expect(jaccard(sets[i], sets[j])).toBeGreaterThanOrEqual(CANDIDATE_MIN_SIMILARITY);
      }
    });

    it("top-k 上限大于候选数时与精确模式完全一致", () => {
      const docs = [
        { id: "a", content: "项目进度是50%" },
        { id: "b", content: "项目进度不是50%" },
        { id: "c", content: "alpha beta gamma" },
        { id: "d", content: "alpha beta delta" },
      ];
      const exact = buildCandidatePairs(docs);
      const capped = buildCandidatePairs(docs, { maxCandidatesPerDoc: 100 });
      expect(capped.pairs).toEqual(exact.pairs);
      expect(capped.stats.truncatedDocs).toBe(0);
    });
  });

  describe("批量检测结果与暴力两两比较一致", () => {
    it("detectConflicts 的冲突集合与顺序都不变", () => {
      const pairs: Array<[string, string]> = [
        ["项目进度是50%", "项目进度不是50%"],
        ["用户喜欢蓝色", "用户不喜欢蓝色"],
        ["系统可以导出数据", "系统不能导出数据"],
        ["这个界面设计很好", "这个界面设计不好"],
        ["用户通过了认证", "用户不通过认证"],
        ["A是真的", "A不是真的"],
        ["今天天气很好", "今天天气不好"],
        ["项目启动会议在上午", "项目启动会议在下午"],
      ];
      const noise = [
        "系统支持深色模式",
        "用户偏好暗色主题",
        "alpha beta gamma",
        "delta epsilon zeta",
        "本周回顾已完成",
        "下月计划待确认",
      ];

      const memories: MemoryEntry[] = [];
      let n = 0;
      for (const [a, b] of pairs) {
        memories.push(makeEntry(`p${n++}`, "fact", a));
        memories.push(makeEntry(`p${n++}`, "lesson", b));
      }
      noise.forEach((content, i) => memories.push(makeEntry(`n${i}`, "topic", content)));

      // 情绪价反转（应走 opinion 分支）
      memories.push(makeEntry("v1", "fact", "这个界面设计很好", { valence: 0.8 }));
      memories.push(makeEntry("v2", "fact", "这个界面设计不错", { valence: -0.8 }));

      const detector = new ConflictDetector();

      const brute: string[] = [];
      for (let i = 0; i < memories.length; i++) {
        for (let j = i + 1; j < memories.length; j++) {
          const c = detector.detectConflict(memories[i], memories[j], 0.7);
          if (c) brute.push(`${c.memory_id_a}|${c.memory_id_b}`);
        }
      }

      const fast = detector.detectConflicts(memories, 0.7).map(
        (c) => `${c.memory_id_a}|${c.memory_id_b}`,
      );
      expect(fast).toEqual(brute);
      expect(brute.length).toBeGreaterThanOrEqual(pairs.length);
    });

    it("阈值变化不会因预筛而漏掉冲突", () => {
      const memories: MemoryEntry[] = [];
      const pairs: Array<[string, string]> = [
        ["项目进度是50%", "项目进度不是50%"],
        ["用户喜欢蓝色", "用户不喜欢蓝色"],
        ["今天天气很好", "今天天气不好"],
      ];
      let n = 0;
      for (const [a, b] of pairs) {
        memories.push(makeEntry(`q${n++}`, "fact", a));
        memories.push(makeEntry(`q${n++}`, "lesson", b));
      }

      const detector = new ConflictDetector();
      for (const threshold of [0.5, 0.7, 0.85]) {
        const brute: string[] = [];
        for (let i = 0; i < memories.length; i++) {
          for (let j = i + 1; j < memories.length; j++) {
            const c = detector.detectConflict(memories[i], memories[j], threshold);
            if (c) brute.push(`${c.memory_id_a}|${c.memory_id_b}`);
          }
        }
        const fast = detector.detectConflicts(memories, threshold).map(
          (c) => `${c.memory_id_a}|${c.memory_id_b}`,
        );
        expect(fast).toEqual(brute);
      }
    });
  });

  describe("治理入口：分页扫描且不受 90 天截断限制", () => {
    let service: WeaveService;
    let tmpDir: string;
    let env: any;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), "d13-conflict-"));
      env = openWeaveDb(tmpDir, { readonly: false });
      ensureSchema(env);
      service = new WeaveService(env, defaultConfig(tmpDir));
    });

    afterEach(() => {
      env.db.close();
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("单层超过 500 条时仍能扫描到最旧的一条，且旧记忆不因 90 天被跳过", async () => {
      const old = Date.now() - 200 * 24 * 60 * 60 * 1000;
      // 505 条填充记忆，updated_at 从新到旧；待测对故意排在最旧端（第 506、507 条）
      for (let i = 0; i < 505; i++) {
        const ts = Date.now() - i * 10;
        insertMemory(env, makeEntry(`f${i}`, "fact", `填充记忆编号 ${i} 的内容`, {
          createdAt: ts,
          updatedAt: ts,
        }));
      }
      insertMemory(env, makeEntry("old-a", "fact", "项目进度是50%", { createdAt: old, updatedAt: old }));
      insertMemory(env, makeEntry("old-b", "lesson", "项目进度不是50%", { createdAt: old, updatedAt: old }));

      const result = await service.detectConflicts();

      const hit = result.conflicts.find(
        (c) =>
          (c.memory_id_a === "old-a" && c.memory_id_b === "old-b") ||
          (c.memory_id_a === "old-b" && c.memory_id_b === "old-a"),
      );
      expect(hit).toBeDefined();
      expect(hit?.conflict_type).toBe("fact");
    });
  });
});
