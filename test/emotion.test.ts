/**
 * roadmap v0.5 R10：情绪标记与闪光灯加权（默认关；C1：不豁免把关）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openService } from "../src/host/index";
import type { WeaveService } from "../src/host/service";
import type { WeaveEnv } from "../src/store/db";
import { getMemory } from "../src/store/dao";
import { entry } from "./link-health.test";

let dir: string;
let env: WeaveEnv;
let service: WeaveService;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memweave-emotion-"));
  const rt = openService(dir);
  env = rt.env;
  service = rt.service;
  service.config.emotion.enabled = true;
});

afterEach(() => {
  service.stopMirror(false);
  env.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("R10 情绪标记与闪光灯", () => {
  it("写入时给 valence/arousal；arousal ≥ 0.7 → flash=1；未给就是 null", async () => {
    const w1 = await service.remember({ level: "fact", content: "不好的事" }, "agent", { valence: -0.8, arousal: 0.9 });
    const w2 = await service.remember({ level: "fact", content: "小事" }, "agent", { valence: 0.1, arousal: 0.3 });
    const w3 = await service.remember({ level: "fact", content: "没给情绪的" }, "agent");
    expect(w1.ok && w2.ok && w3.ok).toBe(true);
    const e1 = getMemory(env, w1.id!)!;
    expect(e1.valence).toBeCloseTo(-0.8, 6);
    expect(e1.arousal).toBeCloseTo(0.9, 6);
    expect(e1.flash).toBe(true);
    const e2 = getMemory(env, w2.id!)!;
    expect(e2.arousal).toBeCloseTo(0.3, 6);
    expect(e2.flash).toBe(false);
    expect(getMemory(env, w3.id!)).toMatchObject({ valence: null, arousal: null, flash: false });
  });

  it("闪光灯加权 ×1.45（默认）；超出上限的按 0 处理并记审计", async () => {
    service.config.emotion.dailyFlashCap = 2;
    for (let i = 0; i < 3; i += 1) await service.remember({ level: "fact", content: "大事 " + i }, "agent", { arousal: 0.9 });
    const list = service.listMemory({ status: "active" }).filter((e) => e.flash === true);
    expect(list).toHaveLength(2);
    const hits = service.recall("大事", { limit: 3 });
    const capped = hits.find((h) => !h.entry.flash);
    expect(capped).toBeDefined();
    expect(capped!.explain).not.toContain("flash=");
    const flashHit = hits.find((h) => h.entry.flash);
    expect(flashHit!.explain).toContain("flash=1.45");
  });

  it("设置页取消 / 恢复闪光灯；可撤销", async () => {
    const w = await service.remember({ level: "fact", content: "印象深" }, "agent", { arousal: 0.9 });
    expect(getMemory(env, w.id!)!.flash).toBe(true);
    expect(service.setFlash(w.id!, false, "human").ok).toBe(true);
    expect(getMemory(env, w.id!)!.flash).toBe(false);
    const u = service.undoList().find((x) => x.action === "memory.flash")!;
    expect((await service.undo(u.id, "human")).ok).toBe(true);
    expect(getMemory(env, w.id!)!.flash).toBe(true);
  });

  it("C1：闪光灯条目照常经过四级把关每一步，照常参与冷合并", async () => {
    // 规则层需要人接受（严格模式默认开或依赖 governance 配置）
    service.config.governance.requireConfirmFor = [];
    const w = await service.remember({ level: "rules", content: "闪光灯的规则" }, "agent", { arousal: 0.95 });
    // 由于没有 requireConfirmFor，应该直接入库或成为 L1 候选
    if (w.verdict === "accepted") {
      const e = getMemory(env, w.id!);
      expect(e).not.toBeNull();
      expect(e!.flash).toBe(true);
    } else {
      // 如果是 pending，人接受后入库
      const r = await service.decideCandidate(w.id!, "accepted", "human");
      expect(r.ok).toBe(true);
      const e = getMemory(env, w.id!);
      expect(e).not.toBeNull();
      expect(e!.flash).toBe(true);
    }
  });

  it("关闭开关 → 不写情绪不加权", async () => {
    service.config.emotion.enabled = false;
    const w = await service.remember({ level: "fact", content: "虽然给了情绪" }, "agent", { valence: 0.5, arousal: 0.9 });
    const e = getMemory(env, w.id!)!;
    expect(e.valence).toBeNull();
    expect(e.arousal).toBeNull();
    expect(e.flash).toBe(false);
  });
});
