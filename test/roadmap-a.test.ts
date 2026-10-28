/**
 * roadmap v0.2 阶段 A：R1 自动建边 / G2 关联路 trace / R9 包含度 / R2+R3 初始重要度 /
 * R4 去同质 / R5 反刍抑制 + 取消访问加成（C6）/ recall_log 保留 90 天（C5）
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openService } from "../src/host/index";
import { recallEntries, type WeaveService } from "../src/host/service";
import type { WeaveEnv } from "../src/store/db";
import { getLinks, insertMemory, listCandidates, newId } from "../src/store/dao";
import { initialImportance, sourceFactor } from "../src/store/govern";
import { logRecall, recentRecallCounts } from "../src/store/link";
import {
  DEFAULT_HALF_LIFE_DAYS,
  accessFactor,
  decayFactor,
  diversify,
  importanceFactor,
  ruminationFactor,
  type RankedHit,
} from "../src/core/score";
import type { MemoryEntry } from "../src/core/types";

const DAY = 86400000;
let dir: string;
let env: WeaveEnv;
let service: WeaveService;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memweave-roadmap-a-"));
  const rt = openService(dir);
  env = rt.env;
  service = rt.service;
});

afterEach(() => {
  env.close();
  rmSync(dir, { recursive: true, force: true });
});

function entry(p: Partial<MemoryEntry> & { content: string }): MemoryEntry {
  const ts = p.createdAt ?? Date.now();
  return {
    id: p.id ?? newId(),
    level: p.level ?? "fact",
    project: p.project ?? null,
    section: p.section ?? null,
    content: p.content,
    keywords: p.keywords ?? [],
    importance: p.importance ?? 3,
    status: p.status ?? "active",
    semanticKey: null,
    confidence: null,
    validFrom: ts,
    validTo: null,
    evidence: [],
    hash: null,
    source: "test",
    accessCount: p.accessCount ?? 0,
    tier: "hot",
    createdAt: ts,
    updatedAt: p.updatedAt ?? ts,
  };
}

describe("R1 写入时自动建关联边", () => {
  it("同一会话相邻轮写入 → co-session 边；跨会话无 co-session", async () => {
    const a = await service.remember({ level: "fact", content: "老大的猫叫团子，是橘猫" }, "agent", { sessionId: "s1", turn: 1 });
    const b = await service.remember({ level: "project", content: "忆织插件下周发布 0.2 版本" }, "agent", { sessionId: "s1", turn: 2 });
    const c = await service.remember({ level: "lesson", content: "Windows 下 PowerShell 写文件要注意编码" }, "agent", { sessionId: "s2", turn: 1 });
    expect(a.ok && b.ok && c.ok).toBe(true);
    const kindsAB = getLinks(env, a.id!).filter((l) => l.src === b.id || l.dst === b.id).map((l) => l.kind);
    expect(kindsAB).toContain("co-session");
    const kindsAC = getLinks(env, a.id!).filter((l) => l.src === c.id || l.dst === c.id).map((l) => l.kind);
    expect(kindsAC).not.toContain("co-session");
    // 无向边存一条：src < dst
    for (const l of getLinks(env, b.id!)) expect(l.src < l.dst).toBe(true);
  });

  it("同 project 同 section → topic 边；同 project 30 分钟内 → time 边", async () => {
    const a = await service.remember({ level: "project", project: "mw", section: "发布", content: "发布前要跑完全量测试" }, "agent");
    const b = await service.remember({ level: "project", project: "mw", section: "发布", content: "打包后核对安装目录哈希" }, "agent");
    const kinds = getLinks(env, b.id!).filter((l) => l.src === a.id || l.dst === a.id).map((l) => l.kind).sort();
    expect(kinds).toEqual(["time", "topic"]);
  });

  it("每次写入最多建 8 条边", async () => {
    for (let i = 0; i < 12; i += 1) {
      await service.remember({ level: "project", project: "big", section: "s", content: "第" + i + "号任务：" + "甲乙丙丁戊己庚辛壬癸".slice(0, (i % 9) + 1) + "子丑寅卯" + i }, "agent", { sessionId: "s", turn: 1 });
    }
    const last = await service.remember({ level: "project", project: "big", section: "s", content: "收尾总结写在最后" }, "agent", { sessionId: "s", turn: 1 });
    expect(last.links).toBeLessThanOrEqual(8);
    const own = getLinks(env, last.id!).length;
    expect(own).toBeLessThanOrEqual(8);
  });

  it("关闭开关后不建边", async () => {
    service.config.links.autoLink.enabled = false;
    const a = await service.remember({ level: "project", project: "mw", section: "x", content: "关闭开关条目一号" }, "agent", { sessionId: "s1", turn: 1 });
    const b = await service.remember({ level: "project", project: "mw", section: "x", content: "另外完全不同的第二条" }, "agent", { sessionId: "s1", turn: 1 });
    expect(getLinks(env, a.id!)).toHaveLength(0);
    expect(getLinks(env, b.id!)).toHaveLength(0);
  });
});

describe("G2 关联路生效 + trace 标边类型", () => {
  it("只通过 co-session 关联才能找到的条目被带进召回，explain 写明 link=co-session", async () => {
    await service.remember({ level: "user", content: "老大喜欢像素风格的游戏" }, "agent", { sessionId: "s9", turn: 3 });
    const other = await service.remember({ level: "fact", content: "那天顺便推荐了《星露谷物语》" }, "agent", { sessionId: "s9", turn: 3 });
    const hits = service.recall("像素风格", { limit: 5 });
    const linked = hits.find((h) => h.id === other.id);
    expect(linked).toBeTruthy();
    expect(linked!.routes).toContain("link");
    expect(linked!.explain).toContain("link=co-session");
  });
});

describe("R9 包含度判据（把关第 ③ 步调标准，不加门）", () => {
  it("近似重复（Jaccard ≥ 0.6 且包含度 ≥ 0.78）→ 合并，审计写 jaccard/containment", async () => {
    const a = await service.remember({ level: "user", content: "主人喜欢像素风格的游戏画面" }, "agent");
    const b = await service.remember({ level: "user", content: "主人很喜欢像素风格的游戏画面" }, "agent");
    expect(b.verdict).toBe("merged");
    expect(b.mergedInto).toBe(a.id);
    const audit = service.audit({ action: "memory.merge" });
    expect(audit[0].reason).toMatch(/jaccard=.* containment=/);
  });

  it("反例：意思相反的短句不合并", async () => {
    await service.remember({ level: "user", content: "主人喜欢像素风" }, "agent");
    const b = await service.remember({ level: "user", content: "主人讨厌像素风" }, "agent");
    expect(b.verdict).toBe("accepted");
  });

  it("新版更全（完整包含旧条目且长 1.3 倍）→ 进 L2 候选，不吞新内容", async () => {
    const a = await service.remember({ level: "fact", content: "团子是橘猫" }, "agent");
    const b = await service.remember({ level: "fact", content: "团子是橘猫，三岁，最爱吃冻干和猫条" }, "agent");
    expect(b.verdict).toBe("pending");
    const cand = listCandidates(env, "pending").find((c) => c.id === b.id);
    expect(cand?.reason).toBe("revise-need-human");
    expect(cand?.mergedInto).toBe(a.id);
    // 人接受 → 旧条目正文被替换
    const r = service.decideCandidate(b.id!, "accepted", "human");
    expect(r.ok).toBe(true);
    expect(service.getMemory(a.id!)?.content).toBe("团子是橘猫，三岁，最爱吃冻干和猫条");
  });

  it("关闭包含度判据 → 回到只有 cosine", async () => {
    service.config.write.containment.enabled = false;
    await service.remember({ level: "user", content: "主人喜欢像素风格的游戏画面" }, "agent");
    const b = await service.remember({ level: "user", content: "主人很喜欢像素风格的游戏画面" }, "agent");
    expect(b.verdict).toBe("accepted");
  });
});

describe("R2 惊讶度 + R3 来源加权", () => {
  it("映射表：s=0 → 2，s=1 → 4；主人全新 → 5", () => {
    expect(initialImportance(0, 1)).toBe(2);
    expect(initialImportance(1, 1)).toBe(4);
    expect(initialImportance(1, 1.33)).toBe(5);
    expect(initialImportance(0.5, 1)).toBe(3);
  });

  it("来源因子：human 1.33 / agent 转述主人 1.2 / 其他 1.0", () => {
    expect(sourceFactor({ level: "fact" }, "human")).toBe(1.33);
    expect(sourceFactor({ level: "user" }, "agent")).toBe(1.2);
    expect(sourceFactor({ level: "fact", evidence: [{ sessionId: "s", seq: 1, quote: "我喜欢猫" }] }, "agent")).toBe(1.2);
    expect(sourceFactor({ level: "fact" }, "agent")).toBe(1.0);
    expect(sourceFactor({ level: "fact" }, "dream")).toBe(1.0);
  });

  it("全新话题 ≥ 4；相似话题再写重要度不升", async () => {
    const a = await service.remember({ level: "fact", content: "量子计算用超导比特实现" }, "agent");
    expect(service.getMemory(a.id!)?.importance).toBeGreaterThanOrEqual(4);
    const b = await service.remember({ level: "fact", content: "量子计算还可以用离子阱比特实现" }, "agent");
    expect(service.getMemory(b.id!)!.importance).toBeLessThanOrEqual(service.getMemory(a.id!)!.importance);
  });

  it("显式 importance 不被覆盖", async () => {
    const a = await service.remember({ level: "fact", content: "显式重要度条目", importance: 1 }, "human");
    expect(service.getMemory(a.id!)?.importance).toBe(1);
  });

  it("两个开关都关 → 默认 3", async () => {
    service.config.write.surprise.enabled = false;
    service.config.write.sourceWeight.enabled = false;
    const a = await service.remember({ level: "fact", content: "关掉开关后的条目" }, "human");
    expect(service.getMemory(a.id!)?.importance).toBe(3);
  });
});

describe("R4 检索去同质", () => {
  it("5 条几乎相同 + 1 条相关但不同 → 前 3 名出现不同的那条", () => {
    const now = Date.now();
    for (let i = 0; i < 5; i += 1) {
      insertMemory(env, entry({ id: "dup" + i, content: "像素风游戏推荐清单第" + i + "版", keywords: ["像素风", "游戏", "推荐"], createdAt: now - i * 1000 }));
    }
    insertMemory(env, entry({ id: "diff", content: "像素风美术需要注意调色板限制", keywords: ["像素风", "美术"], importance: 2 }));
    const hits = recallEntries(env, "像素风", { limit: 3 });
    expect(hits.map((h) => h.id)).toContain("diff");
    expect(hits.some((h) => h.explain.includes("div="))).toBe(true);
  });

  it("关闭后严格按分数", () => {
    const mk = (id: string, score: number): RankedHit => ({ id, score, routes: [], explain: "", entry: entry({ id, content: id }) });
    const hits = [mk("a", 3), mk("b", 2), mk("c", 1)];
    const out = diversify(hits, 3, () => 1, { enabled: false, threshold: 0.5, factors: [1, 0.5] });
    expect(out.map((h) => h.id)).toEqual(["a", "b", "c"]);
    const on = diversify(hits, 3, (x, y) => (x.id !== "c" && y.id !== "c" ? 1 : 0), { enabled: true, threshold: 0.5, factors: [1, 0.4] });
    expect(on.map((h) => h.id)).toEqual(["a", "c", "b"]);
  });
});

describe("R5 反刍抑制 + C6 取消访问加成", () => {
  it("系数表：前 2 次不罚、之后 ×0.85、底线 0.5、rules/soul 豁免", () => {
    expect(ruminationFactor("fact", 2)).toBe(1);
    expect(ruminationFactor("fact", 3)).toBeCloseTo(0.85);
    expect(ruminationFactor("fact", 4)).toBeCloseTo(0.7225);
    expect(ruminationFactor("fact", 30)).toBe(0.5);
    expect(ruminationFactor("rules", 30)).toBe(1);
    expect(ruminationFactor("soul", 30)).toBe(1);
  });

  it("同一查询连续 6 轮注入，第 6 轮分数 ≤ 第 1 轮 × 0.65；rules 不变", async () => {
    const f = await service.remember({ level: "fact", content: "老大的生日是十月二十七日" }, "human");
    insertMemory(env, entry({ id: "rule1", level: "rules", content: "生日当天要先说生日快乐" }));
    const score = (id: string): number => service.recall("生日", { limit: 5 }).find((h) => h.id === id)!.score;
    const first = score(f.id!);
    const firstRule = score("rule1");
    for (let t = 1; t <= 5; t += 1) logRecall(env, [f.id!, "rule1"], "s", t);
    expect(score(f.id!)).toBeLessThanOrEqual(first * 0.65);
    expect(score("rule1")).toBeCloseTo(firstRule, 10);
  });

  it("24 小时前的召回不计入", () => {
    const now = Date.now();
    logRecall(env, ["m1"], "s", 1, now - 25 * 3600000);
    logRecall(env, ["m1"], "s", 2, now - 1000);
    expect(recentRecallCounts(env, ["m1"], 24 * 3600000, now).get("m1")).toBe(1);
  });

  it("访问加成已取消；legacyAccessBonus 打开时恢复", () => {
    insertMemory(env, entry({ id: "hot", content: "访问很多次的条目", accessCount: 20 }));
    insertMemory(env, entry({ id: "cold", content: "访问很少次的条目", accessCount: 0 }));
    const s = (legacy: boolean) => {
      const hits = recallEntries(env, "访问 条目", { limit: 5, legacyAccessBonus: legacy, diversity: { enabled: false, threshold: 0.5, factors: [1] } });
      return hits.find((h) => h.id === "hot")!.score / hits.find((h) => h.id === "cold")!.score;
    };
    expect(s(false)).toBeCloseTo(1, 1);
    expect(s(true)).toBeGreaterThan(1.1);
  });

  it("C5：recall_log 保留 90 天（dream 清理）", () => {
    const now = Date.now();
    logRecall(env, ["old"], "s", 1, now - 91 * DAY);
    logRecall(env, ["keep"], "s", 1, now - 89 * DAY);
    const removed = service.pruneRecallLog(now);
    expect(removed).toBe(1);
    expect(recentRecallCounts(env, ["old", "keep"], 100 * DAY, now).get("keep")).toBe(1);
    expect(recentRecallCounts(env, ["old", "keep"], 100 * DAY, now).has("old")).toBe(false);
  });

  it("总开关等价：新机制全关 + legacyAccessBonus → 分数严格等于 0.1.27 公式，写入不建边、重要度 3", async () => {
    const c = service.config;
    c.links.autoLink.enabled = false;
    c.write.surprise.enabled = false;
    c.write.sourceWeight.enabled = false;
    c.write.containment.enabled = false;
    c.recall.diversity.enabled = false;
    c.recall.rumination.enabled = false;
    c.recall.legacyAccessBonus = true;
    const ids: string[] = [];
    for (const s of ["咖啡店推荐一", "咖啡店推荐二号", "咖啡因摄入"]) {
      const o = await service.remember({ level: "fact", content: s }, "human", { sessionId: "eq", turn: 1 });
      ids.push(o.id!);
      expect(service.getMemory(o.id!)?.importance).toBe(3);
      expect(getLinks(env, o.id!)).toHaveLength(0);
    }
    for (let t = 0; t < 10; t += 1) logRecall(env, ids, "eq", t);
    env.db.prepare("UPDATE fact SET access_count = 7").run();
    const hits = service.recall("咖啡", { limit: 5 });
    for (const h of hits) {
      expect(h.explain).not.toMatch(/rum=|div=/);
      expect(h.explain).toContain("access=");
      const rrf = Number(/rrf=([\d.]+)/.exec(h.explain)![1]);
      const imp = importanceFactor(h.entry.importance);
      const dec = decayFactor(h.entry, Date.now(), DEFAULT_HALF_LIFE_DAYS);
      const acc = accessFactor(7);
      expect(h.score / (rrf * imp * dec * acc)).toBeCloseTo(1, 3);
    }
  });

  it("renderTurn 写 recall_log", async () => {
    await service.remember({ level: "fact", content: "注入记录测试条目：蓝色杯子" }, "human");
    service.renderTurn({ sessionId: "sx", first: false, query: "蓝色杯子", baseline: new Map(), turn: 2 });
    const rows = env.db.prepare("SELECT * FROM recall_log WHERE session_id = 'sx'").all() as Array<{ turn: number }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].turn).toBe(2);
  });
});
