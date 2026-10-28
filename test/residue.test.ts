/**
 * roadmap v0.6.1 M4：情绪残响地板（默认关）。
 * 验收：强情绪条目一年后 time_decay ≥ 0.55；普通条目不受影响；开关关闭时与 0.6.0 一致；R10 关时不生效。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { recallEntries } from "../src/host/service";
import { openWeaveDb } from "../src/store/db";
import { insertMemory } from "../src/store/dao";
import { ensureSchema } from "../src/store/migrate";

import { DEFAULT_EMOTION, residueFloor, type EmotionConfig } from "../src/core/intent";
import { finalizeRanking } from "../src/core/score";
import type { MemoryEntry } from "../src/core/types";
import { entry } from "./link-health.test";

const DAY = 86400000;
const NOW = Date.UTC(2027, 5, 1);
const on = (over: Partial<EmotionConfig> = {}): EmotionConfig => ({
  ...DEFAULT_EMOTION,
  enabled: true,
  residue: { enabled: true, floor: 0.55, minValence: 0.5 },
  ...over,
});

function rank(list: MemoryEntry[], emo: EmotionConfig | undefined) {
  const fused = new Map(list.map((e, i) => [e.id, { score: 1 / (60 + i + 1), routes: ["keyword"] }]));
  const map = new Map(list.map((e) => [e.id, e]));
  return finalizeRanking(fused as never, map, NOW, undefined, {
    extra: emo?.enabled && emo.residue?.enabled ? (e) => {
      const f = residueFloor(e, emo);
      return f === null ? null : { decayFloor: f };
    } : undefined,
  });
}

const old = NOW - 365 * DAY;
const strong = entry({ id: "s", level: "topic", content: "那天下雨，和主人吵了一架", updatedAt: old, valence: -0.8 });
const flash = entry({ id: "f", level: "topic", content: "主人第一次夸我", updatedAt: old, flash: true });
const mild = entry({ id: "m", level: "topic", content: "随口聊了天气", updatedAt: old, valence: 0.2 });
const plain = entry({ id: "p", level: "topic", content: "部署脚本的位置", updatedAt: old });

describe("M4 残响地板", () => {
  it("residueFloor 条件：|valence| ≥ 0.5 或 flash；R10 或残响任一关 → null", () => {
    expect(residueFloor(strong, on())).toBe(0.55);
    expect(residueFloor(flash, on())).toBe(0.55);
    expect(residueFloor(mild, on())).toBeNull();
    expect(residueFloor(plain, on())).toBeNull();
    expect(residueFloor(strong, on({ enabled: false }))).toBeNull();
    expect(residueFloor(strong, { ...DEFAULT_EMOTION, enabled: true })).toBeNull(); // 残响默认关
    expect(residueFloor(strong, undefined)).toBeNull();
  });

  it("强情绪条目一年后 time_decay ≥ 0.55，trace 带 residue=0.55；普通条目不变", () => {
    const hits = rank([strong, flash, mild, plain], on());
    const by = (id: string) => hits.find((h) => h.id === id)!;
    expect(by("s").explain).toMatch(/decay=0\.55; residue=0\.55/);
    expect(by("f").explain).toContain("residue=0.55");
    expect(by("m").explain).not.toContain("residue");
    expect(by("p").explain).not.toContain("residue");
    const base = rank([strong, flash, mild, plain], undefined);
    expect(by("m").score).toBe(base.find((h) => h.id === "m")!.score);
    expect(by("p").score).toBe(base.find((h) => h.id === "p")!.score);
    expect(by("s").score).toBeGreaterThan(base.find((h) => h.id === "s")!.score);
  });

  it("新条目衰减本来就高于地板：不抬、不写 trace", () => {
    const fresh = entry({ id: "n", level: "topic", content: "刚才很开心", updatedAt: NOW - DAY, valence: 0.9 });
    const h = rank([fresh], on())[0];
    expect(h.explain).not.toContain("residue");
    expect(h.explain).toBe(rank([fresh], undefined)[0].explain);
  });

  it("recallEntries 接线：打开后强情绪旧条目带 residue；关闭时与 0.6.0 逐字节一致", () => {
    const dir = mkdtempSync(join(tmpdir(), "memweave-res-"));
    const env = openWeaveDb(dir, { readonly: false });
    try {
      ensureSchema(env);
      for (const e of [strong, flash, mild, plain]) insertMemory(env, { ...e, content: "回忆 " + e.content });
      const offA = recallEntries(env, "回忆", { now: NOW, emotion: { ...DEFAULT_EMOTION, enabled: true } });
      const offB = recallEntries(env, "回忆", { now: NOW, emotion: { ...DEFAULT_EMOTION, enabled: true, residue: { enabled: false, floor: 0.55, minValence: 0.5 } } });
      expect(offB.map((h) => [h.id, h.score, h.explain])).toEqual(offA.map((h) => [h.id, h.score, h.explain]));
      const hits = recallEntries(env, "回忆", { now: NOW, emotion: on() });
      expect(hits.find((h) => h.id === "s")!.explain).toContain("residue=0.55");
      expect(hits.find((h) => h.id === "p")!.explain).not.toContain("residue");
    } finally {
      env.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("开关关闭：与不传 extra 时逐字节一致", () => {
    const a = rank([strong, flash, mild, plain], on({ residue: { enabled: false, floor: 0.55, minValence: 0.5 } }));
    const b = rank([strong, flash, mild, plain], undefined);
    expect(a.map((h) => [h.id, h.score, h.explain])).toEqual(b.map((h) => [h.id, h.score, h.explain]));
  });
});
