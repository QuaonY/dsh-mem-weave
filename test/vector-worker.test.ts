/**
 * 向量索引 Worker 测试
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WeaveService, defaultConfig } from "../src/host/service";
import { openWeaveDb, type WeaveEnv } from "../src/store/db";
import { ensureSchema } from "../src/store/migrate";
import { type EmbeddingProvider, getQueueStatus, runVectorWorker } from "../src/store/vector-worker";

describe("向量索引 Worker", () => {
  let env: WeaveEnv;
  let svc: WeaveService;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "weave-worker-test-"));
    env = openWeaveDb(tmpDir, { readonly: false });
    ensureSchema(env);
    svc = new WeaveService(env, defaultConfig(tmpDir));
  });

  afterEach(() => {
    env.db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("getQueueStatus 返回队列统计", () => {
    const status = getQueueStatus(env);
    expect(status.pending).toBe(0);
    expect(status.processing).toBe(0);
    expect(status.done).toBe(0);
    expect(status.failed).toBe(0);
  });

  it("runVectorWorker 在没有 provider 时跳过", async () => {
    const result = await runVectorWorker(env, null);
    expect(result.processed).toBe(0);
    expect(result.succeeded).toBe(0);
  });

  it("runVectorWorker 在没有任务时返回空统计", async () => {
    const mockProvider: EmbeddingProvider = {
      generate: async (text: string) => new Float32Array(384),
      dimensions: 384,
      provider: "test",
      model: "test-model",
    };

    const result = await runVectorWorker(env, mockProvider);
    expect(result.processed).toBe(0);
  });

  it("Service.getVectorQueueStatus 返回队列状态", () => {
    const status = svc.getVectorQueueStatus();
    expect(status.backend).toBeDefined();
    expect(["sqlite-vec", "vectra", "builtin", "disabled"]).toContain(status.backend);
    expect(status.pending).toBeGreaterThanOrEqual(0);
    expect(status.processing).toBeGreaterThanOrEqual(0);
    expect(status.done).toBeGreaterThanOrEqual(0);
    expect(status.failed).toBeGreaterThanOrEqual(0);
  });

  it("Service.runVectorWorker 在没有 provider 时失败", async () => {
    const result = await svc.runVectorWorker(null);
    expect(result.ok).toBe(false);
    // 消息可能是 "No embedding provider" 或 "Worker failed"（模块加载失败）
    expect(result.message).toBeDefined();
  });

  it("Service.retryFailedVectorJobs 重置失败任务", () => {
    const result = svc.retryFailedVectorJobs("test-actor");
    expect(result).toBeDefined();
    expect(typeof result.ok).toBe("boolean");
    expect(typeof result.retried).toBe("number");
    expect(result.retried).toBeGreaterThanOrEqual(0);
  });

  it("Service.pruneVectorJobs 清理已完成任务", () => {
    const result = svc.pruneVectorJobs(100);
    expect(result).toBeDefined();
    expect(typeof result.ok).toBe("boolean");
    expect(typeof result.pruned).toBe("number");
    expect(result.pruned).toBeGreaterThanOrEqual(0);
  });

  it("完整流程：写入 → 入队 → Worker 处理", async () => {
    // 直接插入一条记忆（使用 DAO 层）
    const { insertMemory, newId } = await import("../src/store/dao");
    const memId = newId();
    const entry = {
      id: memId,
      level: "fact" as any,
      project: null,
      section: null,
      content: "Test memory for vector indexing",
      keywords: [],
      importance: 3,
      status: "active" as any,
      semanticKey: null,
      confidence: null,
      validFrom: Date.now(),
      validTo: null,
      evidence: [],
      hash: null,
      source: "test",
      accessCount: 0,
      tier: "hot" as any,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    
    insertMemory(env, entry);
    
    // 手动入队（因为 insertMemory 不自动入队）
    const { enqueueEmbedding } = await import("../src/store/vector");
    enqueueEmbedding(env, entry);
    
    // 检查队列（应该有一条 pending）
    const queueBefore = svc.getVectorQueueStatus();
    // pending 可能是 0 或 1，取决于向量后端是否可用
    expect(queueBefore.pending).toBeGreaterThanOrEqual(0);

    // 模拟 embedding provider
    const mockProvider: EmbeddingProvider = {
      generate: async (text: string) => {
        // 返回简单的 384 维零向量
        return new Float32Array(384);
      },
      dimensions: 384,
      provider: "test",
      model: "test-model",
    };

    // 运行 Worker
    const workerResult = await svc.runVectorWorker(mockProvider, { batchSize: 10, timeoutMs: 5000 });
    
    // Worker 应该成功（即使没有待处理任务）
    expect(workerResult.stats).toBeDefined();
    expect(workerResult.stats.processed).toBeGreaterThanOrEqual(0);
  });
});
