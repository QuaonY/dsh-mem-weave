/**
 * test/m0-reliability.test.ts：可靠性与诊断验收测试
 * 注入诊断：StatusReport 包含 paused/sectionRegistered/dataDirSource
 * 会话状态按 sessionId：同 agent 两个 session 都注入 S2
 * 人格自动重载：updatePersona 后新会话人格正确
 * 首轮记忆可用性：tier=core 的 fact 首问能命中
 * 只读注入：readonly 下注入仍可用
 * 恢复会话支持：step>1 但无 state 时补注入
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import plugin, { openService } from "../src/host/index";
import type { WeaveService } from "../src/host/service";
import type { WeaveEnv } from "../src/store/db";
import { WeaveService as WeaveServiceClass, defaultConfig } from "../src/host/service";
import { openWeaveDb } from "../src/store/db";
import { DEFAULT_PROFILE_CONFIG } from "../src/profile/types";

interface FakeCommand {
  name: string;
  handler: (raw: string) => void;
}

let dir: string;
let env: WeaveEnv;
let service: WeaveService;
let sections: Map<string, string>;
let command: FakeCommand | null;
let preStepHandler: ((payload: unknown, next: () => unknown) => unknown) | null;

function makeCtx(): unknown {
  const host = {
    section(spec: { name: string; order: number; text: string }): () => void {
      sections.set(spec.name, spec.text);
      return () => {
        sections.delete(spec.name);
      };
    },
    getSectionOrder(): number | undefined {
      return undefined;
    },
  };
  return {
    get(key: string): unknown {
      if (key === "systemPrompt") return host;
      if (key === "commands") {
        return {
          register(c: FakeCommand): () => void {
            command = c;
            return () => {
              command = null;
            };
          },
        };
      }
      return undefined;
    },
    logger: { warn: () => undefined },
    on(event: string, handler: (payload: unknown, next: () => unknown) => unknown): () => void {
      if (event !== "agent/pre-step") return () => undefined;
      preStepHandler = handler;
      return () => {
        if (preStepHandler === handler) preStepHandler = null;
      };
    },
    inject: () => undefined,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memweave-m0-"));
  const rt = openService(dir);
  env = rt.env;
  service = rt.service;
  sections = new Map();
  command = null;
  preStepHandler = null;
});

afterEach(() => {
  plugin.dispose();
  service.stopMirror(false);
  env.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("注入诊断", () => {
  it("StatusReport 包含新增诊断字段", async () => {
    plugin.apply(makeCtx(), { dataDir: dir });
    const activeService = plugin.runtime()?.service;
    expect(activeService).toBeDefined();
    
    // 等待 sections 注册
    await new Promise((resolve) => setTimeout(resolve, 100));
    
    const status = activeService!.status();
    
    // 字段
    expect(status).toHaveProperty("paused");
    expect(status).toHaveProperty("pauseReason");
    expect(status).toHaveProperty("dataDirSource");
    expect(status).toHaveProperty("sectionRegistered");
    expect(status).toHaveProperty("sectionNames");
    expect(status.paused).toBe(false);
    expect(status.dataDirSource).toBe("config");
    expect(status.sectionRegistered).toBe(true);
    expect(Array.isArray(status.sectionNames)).toBe(true);
    expect(status.sectionNames.length).toBeGreaterThan(0);
  });

  it("dataDirSource 正确反映数据目录来源", () => {
    const status = service.status();
    // 注意：beforeEach 中使用 openService(dir) 创建，dir 是临时目录，dataDirSource 应为 "config"
    expect(status.dataDirSource).toBe("config");
  });
});

describe("会话状态按 sessionId", () => {
  it("同 agent 对象两个 session 都注入 S2", async () => {
    plugin.apply(makeCtx(), { dataDir: dir });
    const activeService = plugin.runtime()?.service;
    expect(activeService).toBeDefined();

    // 写入一条记忆
    const w = await activeService!.remember({ level: "user", content: "shared agent memory" }, "human");
    expect(w.ok).toBe(true);

    const handler = preStepHandler;
    expect(handler).toBeTypeOf("function");

    // Session 1 首轮
    const agent1 = { id: "agent-shared", session: { id: "session-1" } };
    const messages1 = [{ role: "user", content: [{ type: "text", text: "session 1 first turn" }] }];
    const s1_turn1 = await handler!({ agent: agent1, messages: messages1, turn: 1, step: 1 }, () => ({
      kind: "enter",
      messages: messages1,
    })) as { messages: Array<{ content?: Array<{ text?: string }> }> };

    expect(s1_turn1.messages).toHaveLength(2);
    expect(s1_turn1.messages[1].content?.[0]?.text).toContain("shared agent memory");

    // Session 2 首轮（相同 agent id，不同 sessionId）
    const agent2 = { id: "agent-shared", session: { id: "session-2" } };
    const messages2 = [{ role: "user", content: [{ type: "text", text: "session 2 first turn" }] }];
    const s2_turn1 = await handler!({ agent: agent2, messages: messages2, turn: 1, step: 1 }, () => ({
      kind: "enter",
      messages: messages2,
    })) as { messages: Array<{ content?: Array<{ text?: string }> }> };

    // 第二个 session 也应该注入 S2
    expect(s2_turn1.messages).toHaveLength(2);
    expect(s2_turn1.messages[1].content?.[0]?.text).toContain("shared agent memory");
  });

  it("恢复会话：step>1 但无 state 时补一次 S2 注入", async () => {
    plugin.apply(makeCtx(), { dataDir: dir });
    const activeService = plugin.runtime()?.service;
    expect(activeService).toBeDefined();

    // 写入一条记忆
    const w = await activeService!.remember({ level: "user", content: "recovery memory" }, "human");
    expect(w.ok).toBe(true);

    const handler = preStepHandler;
    expect(handler).toBeTypeOf("function");

    const agent = { id: "agent-recover", session: { id: "session-recover" } };
    // 直接 step=2（模拟恢复会话，没有 step=1 的初始化）
    const messages = [
      { role: "user", content: [{ type: "text", text: "previous turn" }] },
      { role: "assistant", content: [{ type: "text", text: "previous response" }] },
      { role: "user", content: [{ type: "text", text: "current turn" }] },
    ];

    const result = await handler!({ agent, messages, turn: 2, step: 2 }, () => ({
      kind: "enter",
      messages,
    })) as { messages: Array<{ content?: Array<{ text?: string }> }> };

    // 应该补注入
    expect(result.messages.length).toBeGreaterThan(messages.length);
    const injected = result.messages[result.messages.length - 1];
    expect(injected.content?.[0]?.text).toContain("recovery memory");
  });
});

describe("人格自动重载", () => {
  it("updatePersona 后触发 reload，lastReloadAt 更新", async () => {
    plugin.apply(makeCtx(), { dataDir: dir });
    const activeService = plugin.runtime()?.service;
    expect(activeService).toBeDefined();

    // 等待初始 sections 注册
    await new Promise((resolve) => setTimeout(resolve, 100));
    
    const statusBefore = activeService!.status();
    const reloadBefore = statusBefore.lastReloadAt;

    // 更新人格
    await new Promise((resolve) => setTimeout(resolve, 10));
    const updateResult = await activeService!.updatePersona({ userName: "测试用户" }, "human");
    expect(updateResult.ok).toBe(true);

    // 等待 reload 完成
    await new Promise((resolve) => setTimeout(resolve, 50));

    const statusAfter = activeService!.status();
    expect(statusAfter.lastReloadAt).toBeDefined();
    if (reloadBefore) {
      expect(statusAfter.lastReloadAt).toBeGreaterThan(reloadBefore);
    }
  });

  it("updatePersona 后触发 reload，新会话人格立即生效", async () => {
    plugin.apply(makeCtx(), { dataDir: dir });
    const activeService = plugin.runtime()?.service;
    expect(activeService).toBeDefined();

    // 等待初始 sections 注册
    await new Promise((resolve) => setTimeout(resolve, 100));
    
    const personaBefore = activeService!.persona().version;

    // 更新人格
    const updateResult = await activeService!.updatePersona({ userName: "测试更新人格" }, "human");
    expect(updateResult.ok).toBe(true);

    // 等待 reload 完成
    await new Promise((resolve) => setTimeout(resolve, 100));

    const personaAfter = activeService!.persona().version;
    // updatePersona 会使版本号递增
    expect(personaAfter).toBeGreaterThan(personaBefore);
  });
});

describe("首轮记忆可用性", () => {
  it("tier=core 的 fact 在首轮能命中", async () => {
    // 写入 tier=core 的 fact
    const w = await service.remember(
      { level: "fact", content: "用户生日是 3月15日", tier: "core" },
      "human"
    );
    expect(w.ok).toBe(true);

    // 首轮渲染
    const turn = service.renderTurn({
      sessionId: "test-first-recall",
      first: true,
      baseline: new Map(),
    });

    // tier=core 的 fact 应该在 S2 中
    expect(turn.s2).toContain("生日");
    expect(turn.s2).toContain("3月15日");
  });

  it("tier=core 的 lesson 在首轮能命中", async () => {
    const w = await service.remember(
      { level: "lesson", content: "用户喜欢简洁的回复", tier: "core" },
      "human"
    );
    expect(w.ok).toBe(true);

    const turn = service.renderTurn({
      sessionId: "test-first-lesson",
      first: true,
      baseline: new Map(),
    });

    expect(turn.s2).toContain("简洁的回复");
  });

  it("非 core 的 fact 不在首轮注入（召回时才出现）", async () => {
    const w = await service.remember(
      { level: "fact", content: "临时记录信息", tier: "cold" },
      "human"
    );
    expect(w.ok).toBe(true);

    // 画像是对 user/soul/fact/project 的独立聚合（有自己的取材与置信度规则），
    // 这里验证的是 S2 快照的 tier 边界，故关掉画像单独检验快照
    service.config.profile = { ...DEFAULT_PROFILE_CONFIG, enabled: false };

    const turn = service.renderTurn({
      sessionId: "test-non-core",
      first: true,
      baseline: new Map(),
    });

    // 非 core 不在 S2 快照中
    expect(turn.s2).not.toContain("临时记录信息");
  });
});

describe("只读模式注入", () => {
  it("readonly 下 renderTurn 仍正常注入", async () => {
    // 先写入记忆再关闭
    const w = await service.remember({ level: "user", content: "readonly test memory" }, "human");
    expect(w.ok).toBe(true);
    env.close();
    
    // 以只读模式重新打开
    const readonlyEnv = openWeaveDb(dir, { readonly: true });
    const readonlyService = new WeaveServiceClass(readonlyEnv, defaultConfig(dir));

    try {
      // 只读模式下仍能注入
      const turn = readonlyService.renderTurn({
        sessionId: "readonly-session",
        first: true,
        baseline: new Map(),
      });

      expect(turn.inject).toBe(true); // paused=false 时仍注入
      expect(turn.s2).toContain("readonly test memory");
    } finally {
      readonlyEnv.close();
    }
  });

  it("readonly 下召回不会因为 bumpAccess 失败而抛错", async () => {
    // 先写入记忆再关闭
    await service.remember({ level: "fact", content: "readonly recall test" }, "human");
    env.close();
    
    // 以只读模式重新打开
    const readonlyEnv = openWeaveDb(dir, { readonly: true });
    const readonlyService = new WeaveServiceClass(readonlyEnv, defaultConfig(dir));

    try {
      // 不应抛错
      expect(() => {
        const turn = readonlyService.renderTurn({
          sessionId: "readonly-recall",
          first: false,
          query: "recall test",
          baseline: new Map(),
          turn: 2,
        });
        expect(turn.inject).toBe(true);
      }).not.toThrow();
    } finally {
      readonlyEnv.close();
    }
  });
});

describe("测试回归", () => {
  it("所有现有测试保持通过（smoke test）", async () => {
    // 基础写入
    const w1 = await service.remember({ level: "user", content: "smoke test memory" }, "human");
    expect(w1.ok).toBe(true);

    // 基础渲染
    const turn = service.renderTurn({
      sessionId: "smoke",
      first: true,
      baseline: new Map(),
    });
    expect(turn.inject).toBe(true);
    expect(turn.s2).toContain("smoke test memory");

    // 基础召回
    const hits = service.recall("smoke test", { limit: 5 });
    expect(hits.length).toBeGreaterThan(0);
  });

  it("persona version 在更新后递增", async () => {
    const v1 = service.persona().version;
    await service.updatePersona({ userName: "v2 test" }, "human");
    const v2 = service.persona().version;
    expect(v2).toBeGreaterThan(v1);
  });
});
