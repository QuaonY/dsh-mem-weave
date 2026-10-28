/**
 * M6 四条通径测试（§9）：P1 lesson→契约晋升 / P2 词表归一化 / P3 关系情绪小步 / P4 预设卡零记忆
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openWeaveDb, type WeaveEnv } from "../src/store/db";
import { ensureSchema } from "../src/store/migrate";
import { defaultPersona, getPersona, listMemory } from "../src/store/dao";
import { writeMemory } from "../src/store/govern";
import {
  humanCorrected,
  lessonValidations,
  promotableLessons,
  PROMOTION_REASON,
  proposeContractPromotion,
} from "../src/store/promote";
import { RELATION_STATE_KEY, trustSpentToday, bumpRelation } from "../src/store/relation";
import { runDream, type DreamConfigLike } from "../src/store/dream";
import { WeaveService, defaultConfig, sanitizePresetPayload } from "../src/host/service";
import { invokeRpc } from "../src/host/rpc";
import type { PersonaConfig } from "../src/core/types";

let dir: string;
let env: WeaveEnv;
let service: WeaveService;
let dreamCfg: DreamConfigLike;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memweave-m6-"));
  env = openWeaveDb(join(dir, "memweave"));
  ensureSchema(env);
  service = new WeaveService(env, defaultConfig(dir));
  dreamCfg = {
    enabled: true,
    idleMinutes: 0,
    timezone: "UTC",
    peakHours: [],
    leaseHours: 6,
    maxFailures: 3,
  };
});

afterEach(() => {
  service.stopMirror(true);
  env.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("P1 lesson → 人格契约晋升", () => {
  it("验证 ≥2 次 → dream 提名；人确认才写 persona.contracts（版本 +1）", async () => {
    const w1 = await writeMemory(env, { level: "lesson", content: "教训：交付前先跑测试" }, "human");
    expect(w1.ok).toBe(true);
    const lessonId = w1.id as string;

    // 同内容再写两次 → 两次去重并入 = 两次验证
    await writeMemory(env, { level: "lesson", content: "教训：交付前先跑测试" }, "agent");
    await writeMemory(env, { level: "lesson", content: "教训：交付前先跑测试" }, "agent");
    expect(lessonValidations(env, lessonId)).toBe(2);
    expect(humanCorrected(env, lessonId)).toBe(false);

    const r = runDream(env, dreamCfg, "dream", { force: true });
    expect(r.promoted.length).toBe(1);
    const cand = service.listCandidates("pending").find((c) => c.reason === PROMOTION_REASON);
    expect(cand).toBeDefined();
    expect(cand?.level).toBe("persona");
    expect(cand?.mergedInto).toBe(lessonId);

    // 未决期间不重复提名
    expect(runDream(env, dreamCfg, "dream", { force: true }).promoted.length).toBe(0);

    // AI 不能写人格契约
    const denied = service.decideCandidate(cand!.id, "accepted", "agent");
    expect(denied.ok).toBe(false);
    expect(denied.code).toBe("E_PERM");
    expect(getPersona(env).config.contracts.length).toBe(0);

    const v0 = getPersona(env).version;
    const ok = service.decideCandidate(cand!.id, "accepted", "human");
    expect(ok.ok).toBe(true);
    expect(ok.promoted).toBe(true);
    const contracts = getPersona(env).config.contracts;
    expect(contracts.length).toBe(1);
    expect(contracts[0].id).toBe("cp-" + lessonId);
    expect(contracts[0].text).toContain("交付前先跑测试");
    expect(getPersona(env).version).toBeGreaterThan(v0);
  });

  it("UI 通径：RPC memweave.candidates/decide 接受晋升候选 → promoted + 契约落库", async () => {
    const w = await writeMemory(env, { level: "lesson", content: "教训：提交前自查一遍" }, "human");
    const lessonId = w.id as string;
    await writeMemory(env, { level: "lesson", content: "教训：提交前自查一遍" }, "agent");
    await writeMemory(env, { level: "lesson", content: "教训：提交前自查一遍" }, "agent");
    runDream(env, dreamCfg, "dream", { force: true });
    const cand = service.listCandidates("pending").find((c) => c.reason === PROMOTION_REASON);
    expect(cand).toBeDefined();

    // 设置界面候选页走的就是这条 RPC；返回体带 promoted/version 供界面反馈
    const out = (await invokeRpc(service, "memweave.candidates/decide", { id: cand!.id, verdict: "accepted" }, "human")) as {
      ok: boolean;
      promoted?: boolean;
      version?: number;
    };
    expect(out.ok).toBe(true);
    expect(out.promoted).toBe(true);
    expect(typeof out.version).toBe("number");
    expect(getPersona(env).config.contracts.some((c) => c.id === "cp-" + lessonId)).toBe(true);
  });

  it("主人明确纠正过 → 1 次也可提名", async () => {
    const w = await writeMemory(env, { level: "lesson", content: "教训：先写方案再动手" }, "agent");
    const lessonId = w.id as string;
    expect(promotableLessons(env).length).toBe(0);

    service.revise(lessonId, { content: "教训：先写方案再评审再动手" }, "human");
    expect(humanCorrected(env, lessonId)).toBe(true);

    const cand = proposeContractPromotion(env, service.getMemory(lessonId)!, "dream");
    expect(cand).toBeTruthy();
    expect(service.listCandidates("pending").some((c) => c.id === cand)).toBe(true);
  });
});

describe("revision proposal", () => {
  it("persists the proposed patch and applies it only after human acceptance", async () => {
    const written = await writeMemory(env, { level: "fact", content: "原始记忆内容需要保留" }, "human");
    const entry = service.getMemory(written.id as string);
    expect(entry).toBeTruthy();
    const candidateId = service.proposeRevise(entry!, { content: "人工确认后的修订内容" }, "agent");
    const candidate = service.listCandidates("pending").find((item) => item.id === candidateId);
    expect(candidate?.patch?.content).toBe("人工确认后的修订内容");
    expect(candidate?.content).toBe("人工确认后的修订内容");
    expect(service.getMemory(entry!.id)?.content).toBe("原始记忆内容需要保留");

    const denied = service.decideCandidate(candidateId, "accepted", "agent");
    expect(denied.ok).toBe(false);
    expect(denied.code).toBe("E_PERM");
    const accepted = service.decideCandidate(candidateId, "accepted", "human");
    expect(accepted.ok).toBe(true);
    expect(service.getMemory(entry!.id)?.content).toBe("人工确认后的修订内容");
  });
});


describe("P2 词表归一化", () => {
  it("保留记忆原文，只对检索关键词做身份词归一", async () => {
    const w = await writeMemory(
      env,
      { level: "fact", content: "用户说你可以继续做用户体验测试", keywords: ["用户", "偏好"] },
      "human",
    );
    const e = service.getMemory(w.id as string);
    expect(e?.content).toBe("用户说你可以继续做用户体验测试");
    expect(e?.keywords).not.toContain("用户");
    expect(e?.keywords).toContain("主人");
  });

  it("自称归一到人格自称", async () => {
    service.updatePersona({ selfNamePro: "小满", selfNameFlash: "小满" } as Partial<PersonaConfig>, "human");
    const w = await writeMemory(env, { level: "fact", content: "本鲸鱼娘答应过用户会测试" }, "human");
    const e = service.getMemory(w.id as string);
    expect(e?.content).toBe("本鲸鱼娘答应过用户会测试");
  });
});

describe("修订元数据验证", () => {
  it("rejects out-of-range importance, inverted dates, and malformed evidence", async () => {
    const written = await writeMemory(env, { level: "fact", content: "revision metadata validation target" }, "human");
    const id = String(written.id);
    const originalImportance = service.getMemory(id)?.importance;
    expect(service.revise(id, { importance: 6 }, "human").ok).toBe(false);
    expect(service.revise(id, { validFrom: 20, validTo: 10 }, "human").ok).toBe(false);
    expect(service.revise(id, { evidence: [{ sessionId: "s1", seq: -1, quote: "bad" }] as never }, "human").ok).toBe(false);
    expect(service.getMemory(id)?.importance).toBe(originalImportance);
  });
});
describe("P3 关系与情绪小步", () => {
  it("单次 ±0.05、每日 ±0.15 封顶", () => {
    const r1 = bumpRelation(env, { trustDelta: 0.5 }, "agent");
    expect(r1.ok).toBe(true);
    expect(r1.applied).toBeCloseTo(0.05);
    expect(r1.trust).toBeCloseTo(0.05);

    bumpRelation(env, { trustDelta: 0.05 }, "agent");
    bumpRelation(env, { trustDelta: 0.05 }, "agent");
    const r4 = bumpRelation(env, { trustDelta: 0.05 }, "agent");
    expect(r4.applied).toBeCloseTo(0); // 日额度 0.15 用完
    expect(r4.trust).toBeCloseTo(0.15);
    expect(trustSpentToday(env, Date.now())).toBeCloseTo(0.15);
  });

  it("trust 不跌出 [0,1]", () => {
    const floor = bumpRelation(env, { trustDelta: -0.05 }, "agent");
    expect(floor.trust).toBeCloseTo(0); // 0 - 0.05 夹回 0
  });

  it("状态写进 soul 层可召回，只影响锚点措辞", () => {
    bumpRelation(env, { trustDelta: 0.05, stage: "熟悉", moodBias: "嘴硬" }, "agent");
    const soul = listMemory(env, { level: "soul" }).find((e) => e.semanticKey === RELATION_STATE_KEY);
    expect(soul).toBeDefined();
    expect(soul?.content).toContain("trust=0.05");
    expect(soul?.content).toContain("熟悉");
    // S1 ⑧ 锚点读 meta（≤300 字符），契约不被改动
    const anchor = service.renderPersona().blocks.join("\n");
    expect(getPersona(env).config.contracts.length).toBe(0);
    expect(anchor.length).toBeGreaterThan(0);
  });
});

describe("P4 预设卡零记忆", () => {
  it("预设卡导出永远不含 memory/candidates/conflicts", () => {
    const dirty = {
      ...defaultPersona(),
      memory: [{ id: "x", content: "秘密" }],
      candidates: [{ id: "y" }],
      conflicts: [{ id: "z" }],
    } as unknown as PersonaConfig;
    const clean = sanitizePresetPayload(dirty);
    expect((clean as Record<string, unknown>).memory).toBeUndefined();
    expect((clean as Record<string, unknown>).candidates).toBeUndefined();
    expect((clean as Record<string, unknown>).conflicts).toBeUndefined();

    service.savePreset("card1", dirty);
    const preset = service.getPreset("card1");
    expect(preset).not.toBeNull();
    const payload = preset!.payload as Record<string, unknown>;
    expect(payload.memory).toBeUndefined();
    expect(payload.candidates).toBeUndefined();
    expect(payload.conflicts).toBeUndefined();
    expect(typeof payload.userName).toBe("string");
    expect(preset!.id).toBe("card1");
  });
});
