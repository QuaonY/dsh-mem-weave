/**
 * roadmap v0.4 R6：常被想起的升级 / 降级；boost 拉长衰减时间；boost=3 的 user/fact 建议设为常驻。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_HALF_LIFE_DAYS, decayFactor } from "../src/core/score";
import { openService } from "../src/host/index";
import type { WeaveService } from "../src/host/service";
import type { WeaveEnv } from "../src/store/db";
import { getMemory, insertMemory, setBoost } from "../src/store/dao";
import { CORE_REASON, CandidateBudget, DEFAULT_BOOST, adjustBoost, proposeCore } from "../src/store/dream-c";
import { logRecall } from "../src/store/link";
import { entry } from "./link-health.test";

const DAY = 86400000;
let dir: string;
let env: WeaveEnv;
let service: WeaveService;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memweave-boost-"));
  const rt = openService(dir);
  env = rt.env;
  service = rt.service;
});

afterEach(() => {
  service.stopMirror(false);
  env.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("R6 升级 / 降级", () => {
  it("decay = exp(−Δ/(τ·2^boost))", () => {
    const now = Date.now();
    const e = entry({ content: "x", level: "fact", updatedAt: now - 90 * DAY });
    expect(decayFactor(e, now, DEFAULT_HALF_LIFE_DAYS)).toBeCloseTo(Math.exp(-1), 6);
    expect(decayFactor({ ...e, boost: 2 }, now, DEFAULT_HALF_LIFE_DAYS)).toBeCloseTo(Math.exp(-0.25), 6);
    expect(decayFactor({ ...e, level: "rules", boost: 3 }, now, DEFAULT_HALF_LIFE_DAYS)).toBe(1);
  });

  it("30 天召回 ≥3 次且 ≥2 个会话 → 升 1 级（每次 dream 最多 1 级）；只 1 个会话不升", () => {
    const now = Date.now();
    insertMemory(env, entry({ id: "hot", content: "常被想起的事实" }));
    insertMemory(env, entry({ id: "one", content: "只在一个会话里被想起" }));
    logRecall(env, ["hot", "one"], "s1", 1, now - 3 * DAY);
    logRecall(env, ["hot", "one"], "s1", 2, now - 2 * DAY);
    logRecall(env, ["hot", "one"], "s1", 3, now - 2 * DAY);
    logRecall(env, ["hot"], "s2", 1, now - DAY);
    const r = adjustBoost(env, DEFAULT_BOOST, "dream", now);
    expect(r.up).toEqual(["hot"]);
    expect(getMemory(env, "hot")!.boost).toBe(1);
    expect(getMemory(env, "one")!.boost).toBe(0);
    adjustBoost(env, DEFAULT_BOOST, "dream", now);
    adjustBoost(env, DEFAULT_BOOST, "dream", now);
    adjustBoost(env, DEFAULT_BOOST, "dream", now);
    expect(getMemory(env, "hot")!.boost).toBe(3);
  });

  it("命中主人身份词且被召回过 1 次 → 升级；rules 不参与", () => {
    const now = Date.now();
    insertMemory(env, entry({ id: "u", level: "user", content: "主人喜欢简洁的回答" }));
    insertMemory(env, entry({ id: "f", content: "某个普通事实" }));
    insertMemory(env, entry({ id: "r", level: "rules", content: "主人定的规矩" }));
    logRecall(env, ["u", "f", "r"], "s1", 1, now - DAY);
    expect(adjustBoost(env, DEFAULT_BOOST, "dream", now).up).toEqual(["u"]);
  });

  it("90 天没被召回 → 降 1 级；可撤销", async () => {
    const now = Date.now();
    insertMemory(env, entry({ id: "old", content: "很久没想起", createdAt: now - 200 * DAY, updatedAt: now - 200 * DAY, boost: 2 }));
    const r = adjustBoost(env, DEFAULT_BOOST, "dream", now);
    expect(r.down).toEqual(["old"]);
    expect(getMemory(env, "old")!.boost).toBe(1);
    const u = service.undoList().find((x) => x.action === "dream.boost")!;
    expect((await service.undo(u.id, "human")).ok).toBe(true);
    expect(getMemory(env, "old")!.boost).toBe(2);
  });

  it("boost=3 的 user/fact → 候选「建议设为常驻」，只问一次；人接受才改 core，AI 不行", () => {
    insertMemory(env, entry({ id: "f3", content: "老被想起的事实" }));
    insertMemory(env, entry({ id: "p3", level: "project", content: "项目层不建议常驻" }));
    setBoost(env, "fact", "f3", 3);
    setBoost(env, "project", "p3", 3);
    const ids = proposeCore(env, new CandidateBudget(5), "dream", Date.now());
    expect(ids).toHaveLength(1);
    expect(proposeCore(env, new CandidateBudget(5), "dream", Date.now())).toHaveLength(0);
    const c = service.listCandidates("pending").find((x) => x.reason === CORE_REASON)!;
    expect(c.mergedInto).toBe("f3");
    expect(service.decideCandidate(c.id, "accepted", "agent").code).toBe("E_PERM");
    expect(getMemory(env, "f3")!.tier).toBe("hot");
    expect(service.decideCandidate(c.id, "accepted", "human").ok).toBe(true);
    expect(getMemory(env, "f3")!.tier).toBe("core");
  });

  it("关闭开关 → 不升不降", () => {
    const now = Date.now();
    insertMemory(env, entry({ id: "u", level: "user", content: "主人喜欢简洁的回答" }));
    logRecall(env, ["u"], "s1", 1, now - DAY);
    expect(adjustBoost(env, { ...DEFAULT_BOOST, enabled: false }, "dream", now).up).toHaveLength(0);
  });
});
