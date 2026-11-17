/**
 * 忆织 MemWeave —— 多模型 Persona 测试
 */

import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import { PersonaManager, DEFAULT_MULTI_PERSONA_CONFIG, type MultiPersonaConfig } from "../src/persona";
import type { PersonaConfig } from "../src/core/types";

describe("多模型 Persona", () => {
  it("配置关闭时不合并会话 persona", () => {
    const config: MultiPersonaConfig = {
      ...DEFAULT_MULTI_PERSONA_CONFIG,
      enabled: false,
    };
    const manager = new PersonaManager(config);

    const globalPersona = createTestPersona();
    const merged = manager.mergePersona(
      {} as any, // mock env
      "session-1",
      globalPersona
    );

    // 配置关闭时应该返回原始 persona
    assert.equal(merged.selfNamePro, globalPersona.selfNamePro);
    assert.equal(merged.stance, globalPersona.stance);
  });

  it("默认配置是关闭的", () => {
    assert.equal(DEFAULT_MULTI_PERSONA_CONFIG.enabled, false);
    assert.ok(DEFAULT_MULTI_PERSONA_CONFIG.defaultTTL > 0);
  });

  it("PersonaManager 正确初始化", () => {
    const config: MultiPersonaConfig = {
      enabled: true,
      defaultTTL: 3600,
    };

    const manager = new PersonaManager(config);
    assert.ok(manager);
  });

  it("合并逻辑正确处理部分覆盖", () => {
    const config: MultiPersonaConfig = {
      enabled: true,
      defaultTTL: 86400,
    };
    const manager = new PersonaManager(config);

    const globalPersona = createTestPersona();

    // 模拟会话 persona（只覆盖部分字段）
    const mockEnv = {
      db: {
        prepare: (sql: string) => ({
          get: () => ({
            session_id: "test",
            enabled: 1,
            overrides: JSON.stringify({
              selfName: "CustomBot",
              stance: "自定义立场",
            }),
            created_at: Date.now(),
            updated_at: Date.now(),
          }),
        }),
      },
    } as any;

    const merged = manager.mergePersona(mockEnv, "test", globalPersona);

    // 覆盖的字段
    assert.equal(merged.selfNamePro, "CustomBot");
    assert.equal(merged.stance, "自定义立场");

    // 未覆盖的字段保持原样
    assert.equal(merged.character, globalPersona.character);
    assert.equal(merged.suffix, globalPersona.suffix);
    assert.equal(merged.userName, globalPersona.userName);
  });

  it("无会话 persona 时返回全局 persona", () => {
    const config: MultiPersonaConfig = {
      enabled: true,
      defaultTTL: 86400,
    };
    const manager = new PersonaManager(config);

    const globalPersona = createTestPersona();

    // 模拟没有会话 persona 的情况
    const mockEnv = {
      db: {
        prepare: () => ({
          get: () => undefined,
        }),
      },
    } as any;

    const merged = manager.mergePersona(mockEnv, "test", globalPersona);

    // 应该返回完整的全局 persona
    assert.deepEqual(merged, globalPersona);
  });

  it("覆盖 appearance 和 tone 字段", () => {
    const config: MultiPersonaConfig = {
      enabled: true,
      defaultTTL: 86400,
    };
    const manager = new PersonaManager(config);

    const globalPersona = createTestPersona();
    globalPersona.appearance.enabled = true;
    globalPersona.tone.enabled = true;

    const mockEnv = {
      db: {
        prepare: () => ({
          get: () => ({
            session_id: "test",
            enabled: 1,
            overrides: JSON.stringify({
              appearance: "新的外观描述",
              tone: "新的语气",
            }),
            created_at: Date.now(),
            updated_at: Date.now(),
          }),
        }),
      },
    } as any;

    const merged = manager.mergePersona(mockEnv, "test", globalPersona);

    assert.equal(merged.appearance.text, "新的外观描述");
    assert.equal(merged.tone.text, "新的语气");
  });

  it("禁用的会话 persona 不生效", () => {
    const config: MultiPersonaConfig = {
      enabled: true,
      defaultTTL: 86400,
    };
    const manager = new PersonaManager(config);

    const globalPersona = createTestPersona();

    // 模拟禁用的会话 persona
    const mockEnv = {
      db: {
        prepare: () => ({
          get: () => ({
            session_id: "test",
            enabled: 0, // 已禁用
            overrides: JSON.stringify({
              selfName: "ShouldNotApply",
            }),
            created_at: Date.now(),
            updated_at: Date.now(),
          }),
        }),
      },
    } as any;

    const merged = manager.mergePersona(mockEnv, "test", globalPersona);

    // 应该使用全局值
    assert.equal(merged.selfNamePro, globalPersona.selfNamePro);
  });
});

// ---------- 辅助函数 ----------

function createTestPersona(): PersonaConfig {
  return {
    enabled: true,
    selfNameByModel: {},
    selfNamePro: "默认AI",
    selfNameFlash: "小AI",
    userName: "用户",
    stance: "默认立场",
    character: "默认性格",
    suffix: "默认后缀",
    appearance: {
      enabled: true,
      text: "默认外观",
      byModel: {},
      cards: [],
      index: false,
    },
    tone: {
      enabled: true,
      text: "默认语气",
      byModel: {},
    },
    contracts: [],
    thinkingLanguage: "off",
    meta: {
      relation: { stage: "", trust: 0 },
      mood: { baseline: "", bias: "" },
      taboos: [],
      lexicon: {},
    },
    strict: false,
    applyNextSession: false,
  };
}
