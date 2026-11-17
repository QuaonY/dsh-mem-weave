/**
 * 时间衰减下限
 * 验收标准（台账原文）：2023 年的正确事实在 2026 年仍能被召回。
 * 这里同时钉住两件事：衰减系数不再塌到 0；边界值（0 / 1 / 非法值）行为明确。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openWeaveDb, type WeaveEnv } from "../src/store/db";
import { ensureSchema } from "../src/store/migrate";
import { insertMemory, newId } from "../src/store/dao";
import { recallEntries, defaultConfig } from "../src/host/service";
import { DEFAULT_DECAY_FLOOR, DEFAULT_HALF_LIFE_DAYS, decayFactor } from "../src/core/score";
import type { MemoryEntry } from "../src/core/types";

const DAY = 86400000;
const NOW = Date.UTC(2026, 10, 11); // 2026-11-11
const IN_2023 = Date.UTC(2023, 0, 1);

function entry(p: Partial<MemoryEntry> & { content: string }): MemoryEntry {
  const ts = p.updatedAt ?? p.createdAt ?? NOW;
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

describe("decayFactor 下限", () => {
  it("2023 年的事实：默认下限让衰减停在 0.1，而不是塌到 0", () => {
    const e = entry({ id: "old", content: "主人的生日是 3 月 5 日", updatedAt: IN_2023 });
    const d = decayFactor(e, NOW, DEFAULT_HALF_LIFE_DAYS);
    expect(d).toBe(DEFAULT_DECAY_FLOOR);
    // 没有下限时它只有 ~1e-7，与噪声无异
    expect(decayFactor(e, NOW, DEFAULT_HALF_LIFE_DAYS, 0)).toBeLessThan(1e-4);
  });

  it("下限只抬高低值，不影响比下限高的衰减", () => {
    const e = entry({ id: "f", content: "x", updatedAt: NOW - 90 * DAY });
    // fact τ=90，正好一个半衰期 → exp(-1) ≈ 0.3679 > 0.1，下限不生效
    expect(decayFactor(e, NOW, DEFAULT_HALF_LIFE_DAYS, 0.1)).toBeCloseTo(Math.exp(-1), 6);
    expect(decayFactor({ ...e, updatedAt: NOW - 2000 * DAY }, NOW, DEFAULT_HALF_LIFE_DAYS, 0.1)).toBe(0.1);
  });

  it("floor=1 让所有层都不衰减；rules 层无论如何都是 1", () => {
    const e = entry({ id: "o", content: "x", updatedAt: IN_2023 });
    expect(decayFactor(e, NOW, DEFAULT_HALF_LIFE_DAYS, 1)).toBe(1);
    expect(decayFactor({ ...e, level: "rules" }, NOW, DEFAULT_HALF_LIFE_DAYS)).toBe(1);
  });

  it("非法下限回落默认值，越界值夹到 [0,1]", () => {
    const e = entry({ id: "o", content: "x", updatedAt: IN_2023 });
    const raw = decayFactor(e, NOW, DEFAULT_HALF_LIFE_DAYS, 0);
    // 非法值回落默认 0.1，不再静默当作「不设下限」
    expect(decayFactor(e, NOW, DEFAULT_HALF_LIFE_DAYS, Number.NaN)).toBe(DEFAULT_DECAY_FLOOR);
    expect(decayFactor(e, NOW, DEFAULT_HALF_LIFE_DAYS, Number.POSITIVE_INFINITY)).toBe(DEFAULT_DECAY_FLOOR);
    expect(decayFactor(e, NOW, DEFAULT_HALF_LIFE_DAYS, -5)).toBe(raw);
    expect(decayFactor(e, NOW, DEFAULT_HALF_LIFE_DAYS, 7)).toBe(1);
  });

  it("默认配置带上下限（0.1），旧 settings.json 缺键时由 defaultConfig 补上", () => {
    const cfg = defaultConfig(join(tmpdir(), "mw-decay-floor-cfg"));
    expect(cfg.lifecycle.decayFloor).toBe(DEFAULT_DECAY_FLOOR);
    expect(cfg.lifecycle.decayFloor).toBe(0.1);
  });
});

describe("召回：2023 年的事实仍能被召回", () => {
  let dir: string;
  let env: WeaveEnv;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "memweave-decay-floor-"));
    env = openWeaveDb(dir);
    ensureSchema(env);
  });

  afterEach(() => {
    env.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("只有它能命中时排在首位，且 explain 写明 decay=0.10", () => {
    insertMemory(
      env,
      entry({ id: "old", content: "主人的生日是 3 月 5 日", keywords: ["生日"], updatedAt: IN_2023 }),
    );
    insertMemory(env, entry({ id: "new", content: "今晚要部署服务", updatedAt: NOW - DAY }));

    const hits = recallEntries(env, "生日", { limit: 5, now: NOW });
    expect(hits.map((h) => h.id)).toEqual(["old"]);
    expect(hits[0].explain).toContain("decay=0.10");
  });

  it("下限关掉后分数被压到噪声级，开着的版本保留 10% 权重", () => {
    insertMemory(env, entry({ id: "old", content: "主人的生日是 3 月 5 日", updatedAt: IN_2023 }));
    const on = recallEntries(env, "生日", { limit: 5, now: NOW, decayFloor: 0.1 })[0];
    const off = recallEntries(env, "生日", { limit: 5, now: NOW, decayFloor: 0 })[0];
    expect(on.id).toBe("old");
    expect(off.id).toBe("old");
    // 同一 RRF 主分数，差别全在衰减：开着比关着大五个数量级以上（~10^5–10^7）
    expect(on.score / off.score).toBeGreaterThan(1e5);
    expect(on.score / off.score).toBeLessThan(1e7);
  });

  it("召回入口透传配置的下限（0 = 恢复旧行为）", () => {
    insertMemory(env, entry({ id: "old", content: "主人的生日是 3 月 5 日", updatedAt: IN_2023 }));
    const dflt = recallEntries(env, "生日", { limit: 5, now: NOW })[0];
    const zero = recallEntries(env, "生日", { limit: 5, now: NOW, decayFloor: 0 })[0];
    expect(dflt.explain).toContain("decay=0.10");
    expect(zero.explain).not.toContain("decay=0.10");
  });
});
