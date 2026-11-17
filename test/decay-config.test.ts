/**
 * 衰减参数单一来源
 * 验收标准（台账原文）：`DEFAULT_HALF_LIFE_DAYS`（score.ts 硬编码）与
 * `lifecycle.halfLifeDays` 配置合并对齐，消除两处漂移；补配置边界测试。
 * 这里钉住三件事：
 * 1. 默认表与配置没有第二份字面量（defaultConfig 直接来自 score.ts）
 * 2. 非法配置（负数 / 字符串 / 缺键 / NaN）有明确、统一的边界行为：
 *    回落到该层默认，而不是让 `decayFactor` 静默走「不衰减」分支
 * 3. 配置真的流进了召回（end-to-end），而不只是在一个纯函数里成立
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openWeaveDb, type WeaveEnv } from "../src/store/db";
import { ensureSchema } from "../src/store/migrate";
import { insertMemory, newId } from "../src/store/dao";
import { defaultConfig, WeaveService } from "../src/host/service";
import { clampSettingsPatch } from "../src/host/rpc";
import {
  DEFAULT_DECAY_FLOOR,
  DEFAULT_HALF_LIFE_DAYS,
  normalizeDecayFloor,
  normalizeHalfLife,
  normalizeHalfLifeValue,
} from "../src/core/score";
import { LEVEL_ORDER } from "../src/core/types";
import type { MemoryEntry } from "../src/core/types";

const IN_2023 = Date.UTC(2023, 0, 1);

function entry(p: Partial<MemoryEntry> & { content: string }): MemoryEntry {
  const ts = p.updatedAt ?? p.createdAt ?? Date.now();
  return {
    id: p.id ?? newId(),
    level: p.level ?? "fact",
    project: null,
    section: null,
    content: p.content,
    keywords: p.keywords ?? [],
    importance: p.importance ?? 3,
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
    createdAt: p.createdAt ?? ts,
    updatedAt: ts,
    searchTerms: null,
  };
}

const decayOf = (explain: string): number => Number(/decay=([\d.]+)/.exec(explain)![1]);

describe("默认值只有一个来源", () => {
  it("defaultConfig 的半衰期表与内核默认值全等，下限同样来自常量", () => {
    const cfg = defaultConfig(join(tmpdir(), "mw-decay-config"));
    expect(cfg.lifecycle.halfLifeDays).toEqual(DEFAULT_HALF_LIFE_DAYS);
    expect(cfg.lifecycle.decayFloor).toBe(DEFAULT_DECAY_FLOOR);
    // 深拷贝：改配置不能反过来污染内核默认值（rules 0 = 不衰减）
    expect(cfg.lifecycle.halfLifeDays).not.toBe(DEFAULT_HALF_LIFE_DAYS);
    expect(DEFAULT_HALF_LIFE_DAYS.rules).toBe(0);
  });

  it("normalizeHalfLifeValue：缺键 / 非数值 / 负值回落默认，0 与数字字符串合法", () => {
    const fact = DEFAULT_HALF_LIFE_DAYS.fact;
    for (const bad of [undefined, null, "", "  ", true, false, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, -90, "abc"]) {
      expect(normalizeHalfLifeValue(bad, "fact")).toBe(fact);
    }
    // 显式 0 是合法语义（不衰减），不能被当成非法值
    expect(normalizeHalfLifeValue(0, "fact")).toBe(0);
    expect(normalizeHalfLifeValue("0", "fact")).toBe(0);
    expect(normalizeHalfLifeValue("120", "fact")).toBe(120);
    // 基准用 100000 天近似关闭衰减，不设上限
    expect(normalizeHalfLifeValue(100000, "fact")).toBe(100000);
  });

  it("normalizeHalfLife：缺层补默认、未知键忽略、返回新对象且不改入参", () => {
    const input = { fact: 60, rules: 0, nope: 1 };
    const out = normalizeHalfLife(input);
    expect(out).toEqual({ ...DEFAULT_HALF_LIFE_DAYS, fact: 60, rules: 0 });
    expect(Object.keys(out).sort()).toEqual([...LEVEL_ORDER].sort());
    expect(input).toEqual({ fact: 60, rules: 0, nope: 1 });
    // 非对象整表回落到默认
    expect(normalizeHalfLife("garbage")).toEqual(DEFAULT_HALF_LIFE_DAYS);
    expect(normalizeHalfLife(null)).toEqual(DEFAULT_HALF_LIFE_DAYS);
  });

  it("normalizeDecayFloor：非法回落 0.1，负数夹 0，>1 夹 1，字符串接受", () => {
    for (const bad of [undefined, null, "", true, Number.NaN, Number.POSITIVE_INFINITY, "abc"]) {
      expect(normalizeDecayFloor(bad)).toBe(DEFAULT_DECAY_FLOOR);
    }
    expect(normalizeDecayFloor(-0.5)).toBe(0);
    expect(normalizeDecayFloor(0)).toBe(0);
    expect(normalizeDecayFloor(3)).toBe(1);
    expect(normalizeDecayFloor("0.35")).toBe(0.35);
  });
});

describe("settings/update 边界", () => {
  it("非法半衰期删键（保留原值），合法值转成数字", () => {
    const patch = {
      lifecycle: { halfLifeDays: { fact: -1, topic: "45", project: 0, user: "abc" }, decayFloor: 9 },
    };
    clampSettingsPatch(patch as unknown as Record<string, unknown>);
    expect(patch.lifecycle.halfLifeDays).toEqual({ topic: 45, project: 0 });
    expect(patch.lifecycle.decayFloor).toBe(1);
  });

  it("decayFloor 负数夹 0、非数值回落默认；未出现的键不动", () => {
    const neg = { lifecycle: { decayFloor: -2 } };
    clampSettingsPatch(neg);
    expect(neg.lifecycle.decayFloor).toBe(0);

    const bad = { lifecycle: { decayFloor: "abc" } };
    clampSettingsPatch(bad);
    expect(bad.lifecycle.decayFloor).toBe(DEFAULT_DECAY_FLOOR);

    const empty = { lifecycle: {} };
    clampSettingsPatch(empty);
    expect(empty.lifecycle).toEqual({});
  });
});

describe("服务入口：坏配置不会静默关掉衰减", () => {
  let dir: string;
  let env: WeaveEnv;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "memweave-decay-config-"));
    env = openWeaveDb(dir);
    ensureSchema(env);
  });

  afterEach(() => {
    env.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("构造时归一化坏值，且不改调用方传进来的配置对象", () => {
    const cfg = defaultConfig(dir);
    cfg.lifecycle.halfLifeDays.fact = -1;
    cfg.lifecycle.halfLifeDays.topic = Number.NaN;
    cfg.lifecycle.decayFloor = 9;

    const svc = new WeaveService(env, cfg);
    expect(svc.config.lifecycle.halfLifeDays.fact).toBe(DEFAULT_HALF_LIFE_DAYS.fact);
    expect(svc.config.lifecycle.halfLifeDays.topic).toBe(DEFAULT_HALF_LIFE_DAYS.topic);
    expect(svc.config.lifecycle.decayFloor).toBe(1);
    // 入参保持原样（服务持有一份归一化后的副本）
    expect(cfg.lifecycle.halfLifeDays.fact).toBe(-1);
    expect(cfg.lifecycle.decayFloor).toBe(9);
  });

  it("配置的半衰期真的进了召回：fact 设 100000 天后，2023 年的事实几乎不衰减", () => {
    const cfg = defaultConfig(dir);
    cfg.lifecycle.halfLifeDays.fact = 100000;
    const svc = new WeaveService(env, cfg);
    insertMemory(env, entry({ id: "old", content: "主人的生日是 3 月 5 日", keywords: ["生日"], updatedAt: IN_2023 }));

    const hits = svc.recall("生日", { limit: 5 });
    expect(hits.map((h) => h.id)).toEqual(["old"]);
    expect(decayOf(hits[0].explain)).toBeGreaterThan(0.98);
  });

  it("半衰期写成字符串 \"abc\" 时回落 90 天，衰减到下限 0.1 而不是恒 1", () => {
    const cfg = defaultConfig(dir);
    (cfg.lifecycle.halfLifeDays as unknown as Record<string, unknown>).fact = "abc";
    const svc = new WeaveService(env, cfg);
    insertMemory(env, entry({ id: "old", content: "主人的生日是 3 月 5 日", keywords: ["生日"], updatedAt: IN_2023 }));

    const hits = svc.recall("生日", { limit: 5 });
    expect(decayOf(hits[0].explain)).toBeCloseTo(DEFAULT_DECAY_FLOOR, 2);
  });

  it("显式写 0 仍然是「不衰减」——这是配置意图，不是坏值", () => {
    const cfg = defaultConfig(dir);
    cfg.lifecycle.halfLifeDays.fact = 0;
    const svc = new WeaveService(env, cfg);
    insertMemory(env, entry({ id: "old", content: "主人的生日是 3 月 5 日", keywords: ["生日"], updatedAt: IN_2023 }));

    const hits = svc.recall("生日", { limit: 5 });
    expect(decayOf(hits[0].explain)).toBe(1);
  });
});
