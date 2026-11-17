/**
 * 向量主路径用例（台账 的用例部分）。
 * 旧用例（`vector-worker.test.ts:39/67`）只断言「没有 provider 时跳过」
 * 等于把「功能不可用」当成期望结果，主路径从未被真正跑过。
 * 这里用假的 `vectra` 模块 + 假 EmbeddingProvider 走完整条路：
 *   写入记忆 → 入队 → Worker 生成向量并落索引 → 语义召回 → 回读正文。
 * 用假模块而不是真 sqlite-vec / vectra，是为了与机器无关：
 * 两个后端都是 optionalDependency，能不能装上是环境问题，不该决定用例结果。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertMemory, newId } from "../src/store/dao";
import { openWeaveDb, type WeaveEnv } from "../src/store/db";
import { ensureSchema } from "../src/store/migrate";
import { WeaveService, defaultConfig } from "../src/host/service";
import {
  getEmbeddingProvider,
  getVectorBackend,
  ensureVectorTables,
  getVectorStats,
  resetBackendDetection,
  searchSimilar,
  setEmbeddingProvider,
  setVectorConfig,
} from "../src/store/vector";
import { setOptionalDepResolver } from "../src/store/vector-loader";
import { runVectorWorker, getQueueStatus, type EmbeddingProvider } from "../src/store/vector-worker";
import { vectorRoute, DEFAULT_VECTOR_ROUTE } from "../src/store/recall-vector";
import type { MemoryEntry } from "../src/core/types";

/** 假的 vectra 索引：内存 map + 余弦相似度，接口形状与 LocalIndex 一致 */
class FakeLocalIndex {
  readonly items = new Map<string, { id: string; vector: number[]; metadata: Record<string, unknown> }>();
  private created = false;

  constructor(readonly path: string) {}

  async isIndexCreated(): Promise<boolean> {
    return this.created;
  }

  async createIndex(): Promise<void> {
    this.created = true;
  }

  async upsertItem(item: { id: string; vector: number[]; metadata: Record<string, unknown> }): Promise<void> {
    this.items.set(item.id, item);
  }

  async deleteItem(id: string): Promise<void> {
    this.items.delete(id);
  }

  async deleteItems(ids: string[]): Promise<void> {
    for (const id of ids) this.items.delete(id);
  }

  async listItems(): Promise<Array<{ id: string; vector: number[] }>> {
    return [...this.items.values()];
  }

  async queryItems(vector: number[], _query: string, topK: number): Promise<Array<{ item: unknown; score: number }>> {
    return [...this.items.values()]
      .map((item) => ({ item, score: cosine(vector, item.vector) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function notFound(id: string): Error {
  const e = new Error(`Cannot find module '${id}'`);
  (e as { code?: string }).code = "MODULE_NOT_FOUND";
  return e;
}

/** 只让 vectra 可解析，sqlite-vec 记为没装 → 后端稳定为 vectra */
function useFakeVectra(): void {
  setOptionalDepResolver((id) => {
    if (id === "vectra") return { LocalIndex: FakeLocalIndex };
    throw notFound(id);
  });
  resetBackendDetection();
}

/**
 * 确定性的假 embedding：语义类别固定在 4 维空间里。
 * 注意「feline」不在任何记忆正文里，用它查询能证明结果只能来自向量路。
 */
const DIMENSIONS = 4;
const provider: EmbeddingProvider = {
  dimensions: DIMENSIONS,
  provider: "fake",
  model: "fake-1",
  async generate(text: string): Promise<Float32Array> {
    const v = new Float32Array(DIMENSIONS);
    if (/猫|feline|cat/i.test(text)) v[0] = 1;
    else if (/狗|canine|dog/i.test(text)) v[1] = 1;
    else if (/部署|deploy|脚本/i.test(text)) v[2] = 1;
    else v[3] = 1;
    return v;
  },
};

function createEntry(content: string): MemoryEntry {
  const ts = Date.now();
  return {
    id: newId(),
    level: "fact",
    project: null,
    section: null,
    content,
    keywords: [],
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

describe("向量主路径", () => {
  let env: WeaveEnv;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "weave-vec-main-"));
    useFakeVectra();
    env = openWeaveDb(tmpDir, { readonly: false });
    ensureSchema(env);
    ensureVectorTables(env);
    setVectorConfig(env, {
      enabled: true,
      dimensions: DIMENSIONS,
      provider: provider.provider,
      model: provider.model,
    });
    // 宿主注入全局 provider，召回才走得到 embedding
    setEmbeddingProvider(provider);
  });

  afterEach(() => {
    setEmbeddingProvider(null);
    setOptionalDepResolver(null);
    resetBackendDetection();
    env.db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("主路径：写入 → 入队 → Worker 索引 → 语义召回 → 回读正文", async () => {
    const cat = createEntry("用户喜欢猫，家里有一只橘猫");
    const dog = createEntry("用户养了两只狗，每天遛狗");
    const deploy = createEntry("部署脚本放在 scripts/ 下，构建用 node");
    for (const e of [cat, dog, deploy]) insertMemory(env, e);

    // 入队：写入即入队（vector_config.enabled 为真）
    expect(getVectorBackend(env)).toBe("vectra");
    expect(getQueueStatus(env).pending).toBe(3);

    // 索引：Worker 生成向量并写进后端
    const stats = await runVectorWorker(env, provider);
    expect(stats).toEqual({ processed: 3, succeeded: 3, failed: 0, retried: 0, skipped: 0 });
    const after = getQueueStatus(env);
    expect(after.pending).toBe(0);
    expect(after.done).toBe(3);
    expect(after.failed).toBe(0);

    // 召回：查询词不在任何正文里，命中只能来自向量
    const hits = await searchSimilar(env, "feline", { limit: 3 });
    expect(hits).toHaveLength(1);
    expect(hits[0].memoryId).toBe(cat.id);
    expect(hits[0].content).toBe(cat.content);
    expect(hits[0].score).toBeGreaterThan(0.99);
  });

  it("召回不是关键词匹配：查询词查遍全部正文都不存在", async () => {
    const memories = [createEntry("用户喜欢猫"), createEntry("用户养了两只狗"), createEntry("部署脚本在 scripts/")];
    for (const e of memories) insertMemory(env, e);
    await runVectorWorker(env, provider);

    for (const m of memories) expect(m.content.includes("feline")).toBe(false);

    const hits = await searchSimilar(env, "feline", { limit: 5 });
    expect(hits.map((h) => h.memoryId)).toEqual([memories[0].id]);
  });

  it("后端可用但功能未开启时召回为空（可用 ≠ 开启）", async () => {
    const cat = createEntry("用户喜欢猫");
    insertMemory(env, cat);
    await runVectorWorker(env, provider);

    // 未开启前能召回
    expect(await searchSimilar(env, "feline", { limit: 3 })).toHaveLength(1);

    // 关掉开关：后端仍然可用，但召回必须返回空
    setVectorConfig(env, {
      enabled: false,
      dimensions: DIMENSIONS,
      provider: provider.provider,
      model: provider.model,
    });
    expect(getVectorBackend(env)).toBe("vectra");
    expect(await searchSimilar(env, "feline", { limit: 3 })).toEqual([]);
  });

  it("没有 provider 时召回为空；注入后 Worker 与召回都用它", async () => {
    const cat = createEntry("用户喜欢猫");
    insertMemory(env, cat);

    setEmbeddingProvider(null);
    expect(getEmbeddingProvider()).toBeNull();
    expect(await searchSimilar(env, "feline", { limit: 3 })).toEqual([]);

    // Worker 省略 provider 参数时会用注入的全局 provider
    setEmbeddingProvider(provider);
    const stats = await runVectorWorker(env);
    expect(stats.succeeded).toBe(1);

    // 召回同样走注入的 provider
    const hits = await searchSimilar(env, "feline", { limit: 3 });
    expect(hits.map((h) => h.memoryId)).toEqual([cat.id]);
  });

  it("没有任何可选依赖时内置后端兜底：写入 → 索引 → 语义召回", async () => {
    // 两个可选依赖都解析不到 → builtin（包内自带），不是 disabled
    setOptionalDepResolver((id) => {
      throw notFound(id);
    });
    resetBackendDetection();
    expect(getVectorBackend(env)).toBe("builtin");

    const cat = createEntry("用户喜欢猫，家里有一只橘猫");
    insertMemory(env, cat);
    expect(getQueueStatus(env).pending).toBe(1);

    const stats = await runVectorWorker(env, provider);
    expect(stats.succeeded).toBe(1);

    // 查询词不在正文里，命中只能来自向量；后端是 SQLite BLOB + JS 余弦
    const hits = await searchSimilar(env, "feline", { limit: 3 });
    expect(hits.map((h) => h.memoryId)).toEqual([cat.id]);
    expect(hits[0].content).toBe(cat.content);
    expect(hits[0].score).toBeGreaterThan(0.99);
    expect(getVectorStats(env).backend).toBe("builtin");
    expect(getVectorStats(env).indexed).toBe(1);
  });

  it("显式 MEMWEAVE_VECTOR_BACKEND=off 时才 disabled，召回为空且不抛错", async () => {
    insertMemory(env, createEntry("用户喜欢猫"));

    const prev = process.env.MEMWEAVE_VECTOR_BACKEND;
    process.env.MEMWEAVE_VECTOR_BACKEND = "off";
    try {
      resetBackendDetection();
      expect(getVectorBackend(env)).toBe("disabled");
      expect(await searchSimilar(env, "feline", { limit: 3 })).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env.MEMWEAVE_VECTOR_BACKEND;
      else process.env.MEMWEAVE_VECTOR_BACKEND = prev;
      resetBackendDetection();
    }
  });

  it("Worker 失败：先按重试计数回到 pending，用尽后标记 failed 并记录原因", async () => {
    const cat = createEntry("用户喜欢猫");
    insertMemory(env, cat);

    const broken: EmbeddingProvider = {
      ...provider,
      async generate(): Promise<Float32Array> {
        throw new Error("provider exploded");
      },
    };

    const first = await runVectorWorker(env, broken, { maxRetries: 2, retryDelayMs: 0 });
    expect(first.processed).toBe(1);
    expect(first.retried).toBe(1);
    expect(first.failed).toBe(0);
    expect(getQueueStatus(env).pending).toBe(1);

    const second = await runVectorWorker(env, broken, { maxRetries: 2, retryDelayMs: 0 });
    expect(second.failed).toBe(1);
    expect(getQueueStatus(env).failed).toBe(1);

    const row = env.db
      .prepare("SELECT status, error FROM embedding_jobs WHERE memory_id = ?")
      .get(cat.id) as { status: string; error: string };
    expect(row.status).toBe("failed");
    expect(row.error).toContain("provider exploded");
  });

  it("宿主接口：WeaveService 委派注入、Worker 与召回", async () => {
    const cat = createEntry("用户喜欢猫");
    insertMemory(env, cat);

    const svc = new WeaveService(env, defaultConfig(tmpDir));
    svc.setEmbeddingProvider(null);
    expect(svc.getEmbeddingProvider()).toBeNull();
    expect(await svc.searchSimilar("feline")).toEqual([]);

    svc.setEmbeddingProvider(provider);
    expect(svc.getEmbeddingProvider()).toBe(provider);

    const stats = await svc.runVectorWorker(provider);
    expect(stats.stats.succeeded).toBe(1);

    const hits = await svc.searchSimilar("feline", { limit: 3 });
    expect(hits.map((h) => h.memoryId)).toEqual([cat.id]);
  });

  it("Semantic route：向量命中以 route=semantic 参与融合，未启用/超时降级为空", async () => {
    const cat = createEntry("用户喜欢猫");
    insertMemory(env, cat);
    await runVectorWorker(env, provider);

    const query = await provider.generate("feline");
    const ranks = await vectorRoute(env, query, { ...DEFAULT_VECTOR_ROUTE, enabled: true });
    expect(ranks).toHaveLength(1);
    expect(ranks[0]).toMatchObject({ id: cat.id, rank: 1, route: "semantic", weight: DEFAULT_VECTOR_ROUTE.weight });

    // 未启用直接返回空
    expect(await vectorRoute(env, query, { ...DEFAULT_VECTOR_ROUTE, enabled: false })).toEqual([]);

    // 超时降级为空，不抛错：让查询真的慢于超时
    class SlowLocalIndex extends FakeLocalIndex {
      override async queryItems(): Promise<Array<{ item: unknown; score: number }>> {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return [];
      }
    }
    setOptionalDepResolver((id) => {
      if (id === "vectra") return { LocalIndex: SlowLocalIndex };
      throw notFound(id);
    });
    resetBackendDetection();

    const started = Date.now();
    expect(
      await vectorRoute(env, query, { ...DEFAULT_VECTOR_ROUTE, enabled: true, timeoutMs: 5 }),
    ).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
