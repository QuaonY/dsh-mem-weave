/**
 * 自动抽取集成测试
 * 测试 L0 捕获 → 抽取 → 治理 → 候选池的完整流程
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openWeaveDb, type WeaveEnv } from "../src/store/db";
import { ensureSchema } from "../src/store/migrate";
import { captureL0Message, DEFAULT_L0_CONFIG } from "../src/store/l0";
import { extractMemories } from "../src/extract/service";
import { DEFAULT_EXTRACT_CONFIG } from "../src/extract/extractor";

describe("自动抽取集成", () => {
  let env: WeaveEnv;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "weave-extract-test-"));
    env = openWeaveDb(tmpDir, { readonly: false });
    ensureSchema(env);
  });

  afterEach(() => {
    env.db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function getCandidates(verdict?: string) {
    let sql = "SELECT * FROM candidates";
    if (verdict) {
      sql += " WHERE verdict = ?";
      return env.db.prepare(sql).all(verdict) as Array<{
        id: string;
        verdict: string;
        decided_by: string | null;
        content: string;
      }>;
    }
    return env.db.prepare(sql).all() as Array<{
      id: string;
      verdict: string;
      decided_by: string | null;
      content: string;
    }>;
  }

  it("完整流程：L0 捕获 → 抽取 → 候选生成", async () => {
    const sessionId = "sess-test-1";
    const l0Config = { ...DEFAULT_L0_CONFIG, enabled: true };
    
    // 1. 捕获 L0 消息
    captureL0Message(env, sessionId, "user", "我的项目使用 TypeScript 和 React", l0Config);
    captureL0Message(env, sessionId, "assistant", "好的，我了解了你的技术栈", l0Config);
    captureL0Message(env, sessionId, "user", "还使用 Tailwind CSS 做样式", l0Config);
    
    // 2. 模拟 LLM 抽取
    const mockLLM = async (system: string, user: string) => {
      expect(system).toContain("记忆抽取");
      expect(user).toContain("TypeScript");
      
      return JSON.stringify([
        {
          level: "project",
          content: "项目技术栈：TypeScript、React、Tailwind CSS",
          keywords: ["TypeScript", "React", "Tailwind CSS", "技术栈"],
          confidence: 0.9,
          reason: "用户明确说明了项目使用的技术栈",
        },
      ]);
    };
    
    // 3. 执行抽取
    const result = await extractMemories(env, sessionId, DEFAULT_EXTRACT_CONFIG, {
      trigger: "manual",
      useLLM: true,
      llmCall: mockLLM,
      qualityThreshold: 0.5,
      dedupeThreshold: 0.85,
    });
    
    // 4. 验证结果
    expect(result.trigger).toBe("manual");
    expect(result.messageIds).toHaveLength(3);
    expect(result.candidatesCreated).toBe(1);
    expect(result.autoAccepted).toBe(1); // project 层级是低风险，自动接受
    expect(result.skipped).toBe(0);
    expect(result.error).toBeUndefined();
    
    // 5. 验证候选已创建
    const candidates = getCandidates();
    expect(candidates.length).toBeGreaterThan(0);
    
    const candidate = candidates.find(c => c.decided_by === "extract");
    expect(candidate).toBeDefined();
    expect(candidate?.verdict).toBe("accepted"); // 低风险自动接受
  });

  it("高风险内容进入候选池等待审核", async () => {
    const sessionId = "sess-test-2";
    const l0Config = { ...DEFAULT_L0_CONFIG, enabled: true };
    
    // 捕获包含敏感内容的消息
    captureL0Message(env, sessionId, "user", "记住我的密码是 secret123", l0Config);
    
    const mockLLM = async () => {
      return JSON.stringify([
        {
          level: "user",
          content: "用户密码：secret123",
          keywords: ["password", "密码"],
          confidence: 0.8,
          reason: "用户明确提供了密码",
        },
      ]);
    };
    
    const result = await extractMemories(env, sessionId, DEFAULT_EXTRACT_CONFIG, {
      trigger: "manual",
      useLLM: true,
      llmCall: mockLLM,
      qualityThreshold: 0.3, // Lower threshold for tests
    });
    
    expect(result.candidatesCreated).toBe(1);
    expect(result.autoAccepted).toBe(0); // 高风险不自动接受
    
    const candidates = getCandidates("pending");
    expect(candidates.length).toBeGreaterThan(0);
    
    const candidate = candidates[0];
    expect(candidate?.verdict).toBe("pending"); // 等待审核
  });

  it("质量过低的抽取结果被跳过", async () => {
    const sessionId = "sess-test-3";
    const l0Config = { ...DEFAULT_L0_CONFIG, enabled: true };
    
    captureL0Message(env, sessionId, "user", "测试", l0Config);
    
    const mockLLM = async () => {
      return JSON.stringify([
        {
          level: "memory",
          content: "TODO", // 包含占位符，质量低
          keywords: [],
          confidence: 0.5,
          reason: "测试",
        },
      ]);
    };
    
    const result = await extractMemories(env, sessionId, DEFAULT_EXTRACT_CONFIG, {
      trigger: "manual",
      useLLM: true,
      llmCall: mockLLM,
      qualityThreshold: 0.5,
    });
    
    expect(result.candidatesCreated).toBe(0);
    expect(result.skipped).toBe(1); // 质量不达标被跳过
  });

  it("LLM 不可用时优雅降级", async () => {
    const sessionId = "sess-test-4";
    const l0Config = { ...DEFAULT_L0_CONFIG, enabled: true };
    
    captureL0Message(env, sessionId, "user", "测试消息", l0Config);
    
    const result = await extractMemories(env, sessionId, DEFAULT_EXTRACT_CONFIG, {
      trigger: "manual",
      useLLM: false, // LLM 不可用
    });
    
    expect(result.error).toContain("LLM unavailable");
    expect(result.candidatesCreated).toBe(0);
    // 关键：不会抛异常，不会影响会话
  });

  it("无效的 LLM 响应被安全处理", async () => {
    const sessionId = "sess-test-5";
    const l0Config = { ...DEFAULT_L0_CONFIG, enabled: true };
    
    captureL0Message(env, sessionId, "user", "测试", l0Config);
    
    const mockLLM = async () => {
      return "This is not valid JSON";
    };
    
    const result = await extractMemories(env, sessionId, DEFAULT_EXTRACT_CONFIG, {
      trigger: "manual",
      useLLM: true,
      llmCall: mockLLM,
      qualityThreshold: 0.3, // Lower threshold for tests
    });
    
    expect(result.candidatesCreated).toBe(0);
    expect(result.error).toBeUndefined(); // 解析失败不算错误
  });

  it("空的抽取结果正常处理", async () => {
    const sessionId = "sess-test-6";
    const l0Config = { ...DEFAULT_L0_CONFIG, enabled: true };
    
    captureL0Message(env, sessionId, "user", "你好", l0Config);
    
    const mockLLM = async () => {
      return "[]"; // 空数组，表示没有值得提取的内容
    };
    
    const result = await extractMemories(env, sessionId, DEFAULT_EXTRACT_CONFIG, {
      trigger: "manual",
      useLLM: true,
      llmCall: mockLLM,
      qualityThreshold: 0.3, // Lower threshold for tests
    });
    
    expect(result.candidatesCreated).toBe(0);
    expect(result.error).toBeUndefined();
  });

  it("多个抽取项批量处理", async () => {
    const sessionId = "sess-test-7";
    const l0Config = { ...DEFAULT_L0_CONFIG, enabled: true };
    
    captureL0Message(env, sessionId, "user", "我住在北京，喜欢吃火锅", l0Config);
    
    const mockLLM = async () => {
      return JSON.stringify([
        {
          level: "user",
          content: "用户住在北京",
          keywords: ["北京", "居住地"],
          confidence: 0.9,
          reason: "用户提供了居住地信息",
        },
        {
          level: "user",
          content: "用户喜欢吃火锅",
          keywords: ["火锅", "饮食偏好"],
          confidence: 0.8,
          reason: "用户表达了饮食偏好",
        },
      ]);
    };
    
    const result = await extractMemories(env, sessionId, DEFAULT_EXTRACT_CONFIG, {
      trigger: "manual",
      useLLM: true,
      llmCall: mockLLM,
      qualityThreshold: 0.3, // Lower threshold for tests
    });
    
    expect(result.candidatesCreated).toBe(2);
    expect(result.autoAccepted).toBe(2); // 都是低风险
  });

  it("不同触发器类型记录在元数据中", async () => {
    const sessionId = "sess-test-8";
    const l0Config = { ...DEFAULT_L0_CONFIG, enabled: true };
    
    // Use different content for each trigger to avoid deduplication
    const triggers = ["manual", "turns", "idle", "warmup"] as const;
    
    for (let i = 0; i < triggers.length; i++) {
      const trigger = triggers[i];
      
      // Capture a unique message for each iteration
      captureL0Message(env, sessionId, "user", `测试数据 ${i + 1}`, l0Config);
      
      const mockLLM = async () => {
        return JSON.stringify([
          {
            level: "memory",
            content: `测试记忆 ${i + 1}`,
            keywords: ["测试"],
            confidence: 0.7,
            reason: "测试",
          },
        ]);
      };
      
      const result = await extractMemories(env, sessionId, DEFAULT_EXTRACT_CONFIG, {
        trigger,
        useLLM: true,
        llmCall: mockLLM,
        qualityThreshold: 0.3,
      });
      
      expect(result.trigger).toBe(trigger);
      expect(result.candidatesCreated).toBe(1);
    }
  });
});
