/**
 * 混合检索（Hybrid RRF）测试
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openWeaveDb, type WeaveEnv } from "../src/store/db";
import { ensureSchema } from "../src/store/migrate";
import { insertMemory, newId } from "../src/store/dao";
import { recallEntriesAsync } from "../src/host/service";
import type { MemoryEntry } from "../src/core/types";

describe("混合检索", () => {
  let env: WeaveEnv;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "weave-hybrid-test-"));
    env = openWeaveDb(tmpDir, { readonly: false });
    ensureSchema(env);
  });

  afterEach(() => {
    env.db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function createEntry(content: string, keywords: string[] = []): MemoryEntry {
    const ts = Date.now();
    return {
      id: newId(),
      level: "fact",
      project: null,
      section: null,
      content,
      keywords,
      importance: 3,
      status: "active",
      semanticKey: null,
      confidence: null,
      validFrom: ts,
      validTo: null,
      evidence: [],
      hash: null,
      source: "test",
      accessCount: 0,
      tier: "hot",
      createdAt: ts,
      updatedAt: ts,
    };
  }

  it("recallEntriesAsync 支持 keyword 路由", async () => {
    // 插入测试数据
    const entry1 = createEntry("JavaScript is a programming language");
    const entry2 = createEntry("Python is also a programming language");
    const entry3 = createEntry("The weather is nice today");
    
    insertMemory(env, entry1);
    insertMemory(env, entry2);
    insertMemory(env, entry3);

    // 查询
    const results = await recallEntriesAsync(env, "programming language", {
      routes: ["keyword"],
      limit: 10,
    });

    // 应该召回包含 "programming language" 的记忆
    expect(results.length).toBeGreaterThan(0);
    expect(results.some(r => r.id === entry1.id)).toBe(true);
    expect(results.some(r => r.id === entry2.id)).toBe(true);
  });

  it("recallEntriesAsync 支持向量路由（无 embedding 时降级）", async () => {
    // 插入测试数据
    const entry1 = createEntry("Machine learning and AI");
    insertMemory(env, entry1);

    // 没有 queryEmbedding，向量路由应该降级
    const results = await recallEntriesAsync(env, "artificial intelligence", {
      routes: ["keyword", "semantic"],
      vector: { enabled: true },
      queryEmbedding: null,
      limit: 10,
    });

    // 应该至少有 keyword 路由结果
    expect(results).toBeDefined();
    expect(Array.isArray(results)).toBe(true);
  });

  it("recallEntriesAsync 支持向量路由（有 embedding）", async () => {
    // 插入测试数据
    const entry1 = createEntry("Deep learning neural networks");
    insertMemory(env, entry1);

    // 模拟 embedding（384 维零向量）
    const queryEmbedding = new Float32Array(384);
    
    // 查询（向量路由可能因为后端不可用而降级，这是正常的）
    const results = await recallEntriesAsync(env, "AI and machine learning", {
      routes: ["keyword", "semantic"],
      vector: { enabled: true, weight: 0.8, topK: 30, minScore: 0.3 },
      queryEmbedding,
      limit: 10,
    });

    // 应该有结果（至少来自 keyword 路由）
    expect(results).toBeDefined();
    expect(Array.isArray(results)).toBe(true);
  });

  it("向量路由超时不阻塞", async () => {
    // 插入数据
    const entry1 = createEntry("Test memory");
    insertMemory(env, entry1);

    // 使用很短的超时（1ms）来触发超时
    const queryEmbedding = new Float32Array(384);
    
    const start = Date.now();
    const results = await recallEntriesAsync(env, "test", {
      routes: ["keyword", "semantic"],
      vector: { enabled: true, timeoutMs: 1 },
      queryEmbedding,
      limit: 10,
    });
    const elapsed = Date.now() - start;

    // 应该快速返回（不阻塞）
    expect(elapsed).toBeLessThan(1000);
    expect(results).toBeDefined();
  });

  it("多路由融合（keyword + link + calendar + terms）", async () => {
    // 这个测试验证多路由可以共存
    const entry1 = createEntry("Primary entry with keywords", ["test", "important"]);
    insertMemory(env, entry1);

    const results = await recallEntriesAsync(env, "keywords important", {
      routes: ["keyword", "link"],
      weights: { keyword: 1.0, link: 0.5 },
      limit: 10,
    });

    // 应该有结果
    expect(results.length).toBeGreaterThan(0);
    
    // 每个结果应该有 routes 字段
    results.forEach(r => {
      expect(r.routes).toBeDefined();
      expect(Array.isArray(r.routes)).toBe(true);
    });
  });

  it("向量路由配置可选参数", async () => {
    const entry1 = createEntry("Test entry");
    insertMemory(env, entry1);

    const queryEmbedding = new Float32Array(384);

    // 测试不同的配置组合
    const configs = [
      { enabled: true, weight: 0.5 },
      { enabled: true, topK: 50 },
      { enabled: true, minScore: 0.7 },
      { enabled: true, timeoutMs: 2000 },
    ];

    for (const config of configs) {
      const results = await recallEntriesAsync(env, "test", {
        routes: ["keyword", "semantic"],
        vector: config,
        queryEmbedding,
        limit: 10,
      });

      expect(results).toBeDefined();
      expect(Array.isArray(results)).toBe(true);
    }
  });
});
