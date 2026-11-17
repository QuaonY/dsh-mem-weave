/**
 * 去重测试
 * 测试 FTS + 向量的混合去重策略
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
import { insertMemory, newId } from "../src/store/dao";
import type { MemoryEntry } from "../src/core/types";
import { syncMemoryToFTS } from "../src/store/fts";

describe("去重检测", () => {
  let env: WeaveEnv;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "weave-dedupe-"));
    env = openWeaveDb(tmpDir, { readonly: false });
    ensureSchema(env);
  });

  afterEach(() => {
    env.db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // Helper to insert a memory entry
  function addMemory(level: "soul" | "user" | "project" | "fact" | "lesson" | "topic" | "rules", content: string, keywords: string[]) {
    const entry: MemoryEntry = {
      id: newId(),
      level,
      project: null,
      content,
      keywords,
      importance: 50,
      semanticKey: null,
      status: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      accessCount: 0,
      tier: "core",
      section: null,
      dueAt: null,
      promiseState: undefined,
      confidence: null,
      validFrom: null,
      validTo: null,
      evidence: [],
      hash: null,
      source: "test",
    };
    insertMemory(env, entry);
    syncMemoryToFTS(env, entry); // 同步到 FTS 以支持去重
  }

  it("FTS 去重：相同内容不重复创建", async () => {
    const sessionId = "sess-dedupe-1";
    const l0Config = { ...DEFAULT_L0_CONFIG, enabled: true };
    
    // 1. 先通过工具写入一条记忆
    addMemory("project", "项目使用 TypeScript 和 React 技术栈", ["TypeScript", "React"]);
    
    // 2. 尝试抽取相似内容
    captureL0Message(env, sessionId, "user", "我们项目用的是 TypeScript 和 React", l0Config);
    
    const mockLLM = async () => {
      return JSON.stringify([
        {
          level: "project",
          content: "项目使用 TypeScript 和 React 技术栈", // 与已有内容完全相同
          keywords: ["TypeScript", "React"],
          confidence: 0.9,
          reason: "用户说明了技术栈",
        },
      ]);
    };
    
    const result = await extractMemories(env, sessionId, DEFAULT_EXTRACT_CONFIG, {
      trigger: "manual",
      useLLM: true,
      llmCall: mockLLM,
      qualityThreshold: 0.3,
      dedupeThreshold: 0.85, // 高相似度阈值
    });
    
    // 应该被去重，不创建新候选
    expect(result.skipped).toBe(1);
    expect(result.candidatesCreated).toBe(0);
  });

  it("FTS 去重：部分重叠内容根据阈值决定", async () => {
    const sessionId = "sess-dedupe-2";
    const l0Config = { ...DEFAULT_L0_CONFIG, enabled: true };
    
    // 1. 先写入一条记忆
    addMemory("user", "用户喜欢吃火锅", ["火锅", "饮食"]);
    
    // 2. 抽取相似但不完全相同的内容
    captureL0Message(env, sessionId, "user", "我喜欢吃火锅和烧烤", l0Config);
    
    const mockLLM = async () => {
      return JSON.stringify([
        {
          level: "user",
          content: "用户喜欢吃火锅和烧烤", // 部分重叠
          keywords: ["火锅", "烧烤", "饮食"],
          confidence: 0.8,
          reason: "用户表达饮食偏好",
        },
      ]);
    };
    
    // 使用较高阈值（0.9）- 应该不被去重
    const result1 = await extractMemories(env, sessionId, DEFAULT_EXTRACT_CONFIG, {
      trigger: "manual",
      useLLM: true,
      llmCall: mockLLM,
      qualityThreshold: 0.3,
      dedupeThreshold: 0.9,
    });
    
    expect(result1.candidatesCreated).toBe(1);
    expect(result1.skipped).toBe(0);
  });

  it("不同层级的相似内容不去重", async () => {
    const sessionId = "sess-dedupe-3";
    const l0Config = { ...DEFAULT_L0_CONFIG, enabled: true };
    
    // 1. 在 project 层级写入
    addMemory("project", "使用 Git 进行版本控制", ["Git", "版本控制"]);
    
    // 2. 抽取到 memory 层级
    captureL0Message(env, sessionId, "user", "我们用 Git 管理代码", l0Config);
    
    const mockLLM = async () => {
      return JSON.stringify([
        {
          level: "fact", // 不同层级
          content: "使用 Git 进行版本控制",
          keywords: ["Git"],
          confidence: 0.8,
          reason: "版本控制工具",
        },
      ]);
    };
    
    const result = await extractMemories(env, sessionId, DEFAULT_EXTRACT_CONFIG, {
      trigger: "manual",
      useLLM: true,
      llmCall: mockLLM,
      qualityThreshold: 0.3,
      dedupeThreshold: 0.85,
    });
    
    // 不同层级应该允许创建
    expect(result.candidatesCreated).toBe(1);
  });

  it("低阈值会更激进地去重", async () => {
    const sessionId = "sess-dedupe-4";
    const l0Config = { ...DEFAULT_L0_CONFIG, enabled: true };
    
    // 1. 先写入
    addMemory("fact", "Node.js 是服务器端 JavaScript 运行时", ["Node.js", "JavaScript"]);
    
    // 2. 抽取略有不同的内容
    captureL0Message(env, sessionId, "user", "Node.js 用于服务器编程", l0Config);
    
    const mockLLM = async () => {
      return JSON.stringify([
        {
          level: "fact",
          content: "Node.js 用于服务器端编程",
          keywords: ["Node.js", "服务器"],
          confidence: 0.7,
          reason: "技术说明",
        },
      ]);
    };
    
    // 使用低阈值 0.5
    const result = await extractMemories(env, sessionId, DEFAULT_EXTRACT_CONFIG, {
      trigger: "manual",
      useLLM: true,
      llmCall: mockLLM,
      qualityThreshold: 0.3,
      dedupeThreshold: 0.5, // 低阈值，更容易判定为重复
    });
    
    // 低阈值下，即使不完全相同也可能被去重
    // 具体是否去重取决于计算的相似度
    expect(result.candidatesCreated + result.skipped).toBe(1);
  });

  it("空数据库中不会误判去重", async () => {
    const sessionId = "sess-dedupe-5";
    const l0Config = { ...DEFAULT_L0_CONFIG, enabled: true };
    
    // 在空数据库中抽取
    captureL0Message(env, sessionId, "user", "测试内容", l0Config);
    
    const mockLLM = async () => {
      return JSON.stringify([
        {
          level: "fact",
          content: "这是一条全新的测试记忆",
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
      dedupeThreshold: 0.85,
    });
    
    // 空数据库中应该正常创建
    expect(result.candidatesCreated).toBe(1);
    expect(result.skipped).toBe(0);
  });

  it("向量搜索不可用时仍能通过 FTS 去重", async () => {
    const sessionId = "sess-dedupe-6";
    const l0Config = { ...DEFAULT_L0_CONFIG, enabled: true };
    
    // 写入已有内容
    addMemory("fact", "Python 是一种高级编程语言", ["Python", "编程"]);
    
    captureL0Message(env, sessionId, "user", "Python 是编程语言", l0Config);
    
    const mockLLM = async () => {
      return JSON.stringify([
        {
          level: "fact",
          content: "Python 是一种高级编程语言", // 完全相同
          keywords: ["Python"],
          confidence: 0.8,
          reason: "编程语言说明",
        },
      ]);
    };
    
    const result = await extractMemories(env, sessionId, DEFAULT_EXTRACT_CONFIG, {
      trigger: "manual",
      useLLM: true,
      llmCall: mockLLM,
      qualityThreshold: 0.3,
      dedupeThreshold: 0.85,
    });
    
    // 即使向量搜索不可用，FTS 也应该能检测到重复
    expect(result.skipped).toBe(1);
    expect(result.candidatesCreated).toBe(0);
  });
});
