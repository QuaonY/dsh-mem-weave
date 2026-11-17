/**
 * 抽取质量指标测试
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

describe("抽取质量指标", () => {
  let env: WeaveEnv;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "weave-quality-"));
    env = openWeaveDb(tmpDir, { readonly: false });
    ensureSchema(env);
  });

  afterEach(() => {
    env.db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("质量指标：包含平均分数和置信度", async () => {
    const sessionId = "sess-quality-1";
    const l0Config = { ...DEFAULT_L0_CONFIG, enabled: true };
    
    captureL0Message(env, sessionId, "user", "测试消息", l0Config);
    
    const mockLLM = async () => {
      return JSON.stringify([
        {
          level: "fact",
          content: "这是一条高质量的记忆",
          keywords: ["高质量", "记忆"],
          confidence: 0.9,
          reason: "测试",
        },
        {
          level: "fact",
          content: "这是一条中等质量的记忆，稍长一些但仍然合理",
          keywords: ["中等"],
          confidence: 0.6,
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
    
    expect(result.quality).toBeDefined();
    expect(result.quality!.avgScore).toBeGreaterThan(0);
    expect(result.quality!.avgScore).toBeLessThanOrEqual(1);
    expect(result.quality!.avgConfidence).toBe(0.75); // (0.9 + 0.6) / 2
  });

  it("质量分布：正确统计低/中/高质量", async () => {
    const sessionId = "sess-quality-2";
    const l0Config = { ...DEFAULT_L0_CONFIG, enabled: true };
    
    captureL0Message(env, sessionId, "user", "测试消息", l0Config);
    
    const mockLLM = async () => {
      return JSON.stringify([
        {
          level: "fact",
          content: "这是一条包含TODO占位符的低质量记忆内容",  // 包含占位符，质量会很低
          keywords: ["低"],
          confidence: 0.5,
          reason: "低质量",
        },
        {
          level: "fact",
          content: "这是一条中等质量的记忆内容，长度适中而且有意义",
          keywords: ["中"],
          confidence: 0.6,
          reason: "中等",
        },
        {
          level: "fact",
          content: "这是一条高质量的记忆内容，详细而准确，包含完整信息",
          keywords: ["高", "质量"],
          confidence: 0.95,
          reason: "高质量",
        },
      ]);
    };
    
    const result = await extractMemories(env, sessionId, DEFAULT_EXTRACT_CONFIG, {
      trigger: "manual",
      useLLM: true,
      llmCall: mockLLM,
      qualityThreshold: 0.1, // 很低的阈值，让所有项都通过质量检查
    });
    
    expect(result.quality).toBeDefined();
    expect(result.quality!.distribution.low).toBeGreaterThan(0); // TODO 项
    expect(result.quality!.distribution.medium).toBeGreaterThan(0);
    expect(result.quality!.distribution.high).toBeGreaterThan(0);
    expect(
      result.quality!.distribution.low +
      result.quality!.distribution.medium +
      result.quality!.distribution.high
    ).toBe(3); // 总共3项
  });

  it("高风险统计：soul 层级触发高风险", async () => {
    const sessionId = "sess-quality-3";
    const l0Config = { ...DEFAULT_L0_CONFIG, enabled: true };
    
    captureL0Message(env, sessionId, "user", "测试消息", l0Config);
    
    const mockLLM = async () => {
      return JSON.stringify([
        {
          level: "soul",  // 灵魂层级 = 高风险
          content: "我的核心价值观是诚实",
          keywords: ["价值观", "诚实"],
          confidence: 0.9,
          reason: "核心信念",
        },
        {
          level: "fact",
          content: "普通事实记忆",
          keywords: ["事实"],
          confidence: 0.8,
          reason: "事实",
        },
      ]);
    };
    
    const result = await extractMemories(env, sessionId, DEFAULT_EXTRACT_CONFIG, {
      trigger: "manual",
      useLLM: true,
      llmCall: mockLLM,
      qualityThreshold: 0.3,
    });
    
    expect(result.quality).toBeDefined();
    expect(result.quality!.highRiskCount).toBe(1); // soul 层级
  });

  it("质量指标：低质量项被跳过后仍被统计", async () => {
    const sessionId = "sess-quality-4";
    const l0Config = { ...DEFAULT_L0_CONFIG, enabled: true };
    
    captureL0Message(env, sessionId, "user", "测试消息", l0Config);
    
    const mockLLM = async () => {
      return JSON.stringify([
        {
          level: "fact",
          content: "这是一个非常短的内容",  // 太短，会被跳过
          keywords: [],
          confidence: 0.3,
          reason: "太短",
        },
        {
          level: "fact",
          content: "这是正常长度的记忆内容，满足质量要求",
          keywords: ["正常"],
          confidence: 0.8,
          reason: "正常",
        },
      ]);
    };
    
    const result = await extractMemories(env, sessionId, DEFAULT_EXTRACT_CONFIG, {
      trigger: "manual",
      useLLM: true,
      llmCall: mockLLM,
      qualityThreshold: 0.2, // 较高阈值，短内容会被拒绝
    });
    
    // 虽然低质量项被跳过，但仍在统计中
    expect(result.quality).toBeDefined();
    expect(result.quality!.distribution.low + 
           result.quality!.distribution.medium + 
           result.quality!.distribution.high).toBe(2); // 2个项都被统计
    // 短内容 + 无关键词 + 低 confidence = 质量极低，会被跳过
    expect(result.skipped).toBeGreaterThanOrEqual(1); // 至少1个被跳过
    expect(result.candidatesCreated).toBeLessThanOrEqual(1); // 至多1个创建成功
  });

  it("质量指标：空抽取结果没有质量统计", async () => {
    const sessionId = "sess-quality-5";
    const l0Config = { ...DEFAULT_L0_CONFIG, enabled: true };
    
    captureL0Message(env, sessionId, "user", "测试消息", l0Config);
    
    const mockLLM = async () => {
      return JSON.stringify([]); // 没有抽取结果
    };
    
    const result = await extractMemories(env, sessionId, DEFAULT_EXTRACT_CONFIG, {
      trigger: "manual",
      useLLM: true,
      llmCall: mockLLM,
    });
    
    expect(result.quality).toBeUndefined(); // 没有抽取项，质量指标为空
  });

  it("质量指标：只有高质量项时分布正确", async () => {
    const sessionId = "sess-quality-6";
    const l0Config = { ...DEFAULT_L0_CONFIG, enabled: true };
    
    captureL0Message(env, sessionId, "user", "测试消息", l0Config);
    
    const mockLLM = async () => {
      return JSON.stringify([
        {
          level: "fact",
          content: "这是一条优秀的记忆内容，详细准确且有价值，值得长期保留",
          keywords: ["优秀", "准确", "价值"],
          confidence: 0.95,
          reason: "高质量内容",
        },
        {
          level: "fact",
          content: "这是另一条高质量记忆，同样详细准确，内容充实",
          keywords: ["高质量", "准确"],
          confidence: 0.9,
          reason: "高质量",
        },
      ]);
    };
    
    const result = await extractMemories(env, sessionId, DEFAULT_EXTRACT_CONFIG, {
      trigger: "manual",
      useLLM: true,
      llmCall: mockLLM,
      qualityThreshold: 0.3,
    });
    
    expect(result.quality).toBeDefined();
    expect(result.quality!.distribution.low).toBe(0);
    expect(result.quality!.distribution.medium).toBe(0);
    expect(result.quality!.distribution.high).toBe(2);
    expect(result.quality!.avgScore).toBeGreaterThan(0.7);
  });
});
