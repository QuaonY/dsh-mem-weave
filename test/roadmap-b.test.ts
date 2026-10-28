/**
 * roadmap v0.3：G14 注入页召回解释 + 新设置键校验。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openService } from "../src/host/index";
import { invokeRpc } from "../src/host/rpc";
import type { WeaveService } from "../src/host/service";
import type { WeaveEnv } from "../src/store/db";

let dir: string;
let env: WeaveEnv;
let service: WeaveService;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memweave-b-"));
  const rt = openService(dir);
  env = rt.env;
  service = rt.service;
});

afterEach(() => {
  service.stopMirror(false);
  env.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("G14 注入页命中解释", () => {
  it("s3-recall 段的 detail 逐条带层、重要度、路由、衰减、反刍、关联类型", async () => {
    await service.remember({ level: "fact", content: "老大常去的咖啡店在街角" }, "human", { sessionId: "g14", turn: 1 });
    await service.remember({ level: "fact", content: "咖啡店周一不开门" }, "human", { sessionId: "g14", turn: 1 });
    service.renderTurn({ sessionId: "g14", first: true, baseline: new Map() });
    service.renderTurn({ sessionId: "g14", first: false, query: "咖啡店", baseline: new Map(), turn: 2 });
    const out = (await invokeRpc(service, "memweave.inject/trace", { sessionId: "g14" }, "human")) as { trace: Array<{ segment: string; detail: string | null }> };
    const rec = out.trace.find((r) => r.segment === "s3-recall" && r.detail);
    expect(rec).toBeDefined();
    const d = rec!.detail!;
    expect(d).toMatch(/\[fact·imp\d\]/);
    expect(d).toContain("routes=");
    expect(d).toContain("decay=");
    expect(d).toContain("rum=");
    expect(d).toContain("score=");
  });
});

describe("新设置键校验（§9）", () => {
  it("越界数值被夹住、布尔被规整、日志目录与 legacyAccessBonus 不能从界面改", async () => {
    const out = (await invokeRpc(service, "memweave.settings/update", {
      patch: {
        recall: { logKeepDays: 1, legacyAccessBonus: true, rumination: { factor: 9, enabled: "yes" } },
        links: { autoLink: { maxPerWrite: 999 } },
        reflect: { afterToolSteps: 0 },
        log: { keepDays: -3, dir: "C:\\Windows" },
      },
    }, "human")) as { ok: boolean };
    expect(out.ok).toBe(true);
    const c = service.config;
    expect(c.recall.logKeepDays).toBe(7);
    expect(c.recall.legacyAccessBonus).toBe(false);
    expect(c.recall.rumination.factor).toBe(1);
    expect(c.recall.rumination.enabled).toBe(false);
    expect(c.links.autoLink.maxPerWrite).toBe(32);
    expect(c.reflect.afterToolSteps).toBe(2);
    expect(c.log.keepDays).toBe(1);
    expect(c.log.dir).toBe("");
  });

  it("阶段 C 设置键：越界夹住、布尔规整", async () => {
    const out = (await invokeRpc(service, "memweave.settings/update", {
      patch: {
        links: { coRecall: { cap: 99, step: 0, enabled: 1 } },
        lifecycle: { boost: { minHits: 0 }, staleAskDays: 9999, distill: { crossProjects: 1 }, maxCandidatesPerDream: 500 },
      },
    }, "human")) as { ok: boolean };
    expect(out.ok).toBe(true);
    const c = service.config;
    expect(c.links.coRecall.cap).toBe(10);
    expect(c.links.coRecall.step).toBe(0.01);
    expect(c.links.coRecall.enabled).toBe(false);
    expect(c.lifecycle.boost.minHits).toBe(1);
    expect(c.lifecycle.boost.minSessions).toBe(2);
    expect(c.lifecycle.staleAskDays).toBe(365);
    expect(c.lifecycle.distill.crossProjects).toBe(2);
    expect(c.lifecycle.distill.topicsPerProject).toBe(5);
    expect(c.lifecycle.maxCandidatesPerDream).toBe(50);
  });
});
