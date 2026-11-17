/**
 * 证据回溯测试
 * L1 候选应该能追溯到产生它的 L0 消息
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openWeaveDb, type WeaveEnv } from "../src/store/db";
import { ensureSchema } from "../src/store/migrate";
import { captureL0Message, DEFAULT_L0_CONFIG, getL0Messages } from "../src/store/l0";
import { extractMemories } from "../src/extract/service";
import { DEFAULT_EXTRACT_CONFIG } from "../src/extract/extractor";
import { listCandidates } from "../src/store/dao";

describe("证据回溯", () => {
  let env: WeaveEnv;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "weave-evidence-"));
    env = openWeaveDb(tmpDir, { readonly: false });
    ensureSchema(env);
  });

  afterEach(() => {
    env.db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("候选包含 L0 消息证据", async () => {
    const sessionId = "sess-evidence-1";
    const l0Config = { ...DEFAULT_L0_CONFIG, enabled: true };
    
    // 捕获几条消息
    captureL0Message(env, sessionId, "user", "项目使用 React", l0Config);
    captureL0Message(env, sessionId, "assistant", "了解", l0Config);
    captureL0Message(env, sessionId, "user", "还用了 TypeScript", l0Config);
    
    const mockLLM = async () => {
      return JSON.stringify([
        {
          level: "project",
          content: "项目技术栈：React + TypeScript",
          keywords: ["React", "TypeScript"],
          confidence: 0.9,
          reason: "技术栈信息",
        },
      ]);
    };
    
    const result = await extractMemories(env, sessionId, DEFAULT_EXTRACT_CONFIG, {
      trigger: "manual",
      useLLM: true,
      llmCall: mockLLM,
      qualityThreshold: 0.3,
    });
    
    expect(result.candidatesCreated).toBe(1);
    
    // 检查候选中的证据
    const candidates = listCandidates(env);
    expect(candidates).toHaveLength(1);
    
    const candidate = candidates[0];
    expect(candidate.evidence).toBeDefined();
    expect(candidate.evidence.length).toBeGreaterThan(0);
    
    // 证据应该是 L0 消息，包含 sessionId, seq, quote
    for (const ev of candidate.evidence) {
      expect(ev.sessionId).toBeDefined();
      expect(ev.seq).toBeGreaterThanOrEqual(0);
      expect(ev.quote).toBeDefined();
    }
  });

  it("证据可以回溯到具体的 L0 消息", async () => {
    const sessionId = "sess-evidence-2";
    const l0Config = { ...DEFAULT_L0_CONFIG, enabled: true };
    
    captureL0Message(env, sessionId, "user", "我喜欢编程", l0Config);
    captureL0Message(env, sessionId, "assistant", "很好", l0Config);
    
    const l0Messages = getL0Messages(env, sessionId);
    expect(l0Messages.length).toBe(2);
    
    const mockLLM = async () => {
      return JSON.stringify([
        {
          level: "user",
          content: "用户喜欢编程",
          keywords: ["编程"],
          confidence: 0.8,
          reason: "用户偏好",
        },
      ]);
    };
    
    await extractMemories(env, sessionId, DEFAULT_EXTRACT_CONFIG, {
      trigger: "manual",
      useLLM: true,
      llmCall: mockLLM,
      qualityThreshold: 0.3,
    });
    
    const candidates = listCandidates(env);
    expect(candidates).toHaveLength(1);
    
    // 证据 sessionId 应该匹配
    const evidenceSessions = candidates[0].evidence.map(ev => ev.sessionId);
    
    for (const sessId of evidenceSessions) {
      expect(sessId).toBe(sessionId);
    }
  });

  it("多个候选共享相同的 L0 消息证据", async () => {
    const sessionId = "sess-evidence-3";
    const l0Config = { ...DEFAULT_L0_CONFIG, enabled: true };
    
    captureL0Message(env, sessionId, "user", "我们用 React 和 Node.js", l0Config);
    
    const mockLLM = async () => {
      return JSON.stringify([
        {
          level: "project",
          content: "前端使用 React",
          keywords: ["React", "前端"],
          confidence: 0.9,
          reason: "前端技术",
        },
        {
          level: "project",
          content: "后端使用 Node.js",
          keywords: ["Node.js", "后端"],
          confidence: 0.85,
          reason: "后端技术",
        },
      ]);
    };
    
    await extractMemories(env, sessionId, DEFAULT_EXTRACT_CONFIG, {
      trigger: "manual",
      useLLM: true,
      llmCall: mockLLM,
      qualityThreshold: 0.3,
    });
    
    const candidates = listCandidates(env);
    expect(candidates).toHaveLength(2);
    
    // 两个候选应该引用相同的 session
    const evidence1Sessions = candidates[0].evidence.map(ev => ev.sessionId);
    const evidence2Sessions = candidates[1].evidence.map(ev => ev.sessionId);
    
    expect(evidence1Sessions).toEqual(evidence2Sessions); // 共享相同的源消息
  });

  it("无 L0 消息时不创建候选（没有源材料）", async () => {
    const sessionId = "sess-evidence-4";
    const l0Config = { ...DEFAULT_L0_CONFIG, enabled: false }; // L0 捕获关闭
    
    // 不捕获 L0 消息
    
    const mockLLM = async () => {
      return JSON.stringify([
        {
          level: "fact",
          content: "这是一条测试记忆",
          keywords: ["测试"],
          confidence: 0.8,
          reason: "测试",
        },
      ]);
    };
    
    const result = await extractMemories(env, sessionId, DEFAULT_EXTRACT_CONFIG, {
      trigger: "manual",
      useLLM: true,
      llmCall: mockLLM,
      qualityThreshold: 0.3,
    });
    
    // 没有 L0 消息，无法抽取
    expect(result.candidatesCreated).toBe(0);
    
    const candidates = listCandidates(env);
    expect(candidates).toHaveLength(0);
  });

  it("证据回溯：触发器信息在 reason 字段", async () => {
    const sessionId = "sess-evidence-5";
    const l0Config = { ...DEFAULT_L0_CONFIG, enabled: true };
    
    captureL0Message(env, sessionId, "user", "测试消息", l0Config);
    
    const mockLLM = async () => {
      return JSON.stringify([
        {
          level: "fact",
          content: "这是一条从空闲触发的抽取记忆",
          keywords: ["空闲"],
          confidence: 0.7,
          reason: "空闲时自动抽取",
        },
      ]);
    };
    
    await extractMemories(env, sessionId, DEFAULT_EXTRACT_CONFIG, {
      trigger: "idle",
      useLLM: true,
      llmCall: mockLLM,
      qualityThreshold: 0.3,
    });
    
    const candidates = listCandidates(env);
    expect(candidates).toHaveLength(1);
    
    // reason 字段应包含触发器类型
    expect(candidates[0].reason).toContain("idle");
    expect(candidates[0].reason).toContain("空闲时自动抽取");
  });
});
