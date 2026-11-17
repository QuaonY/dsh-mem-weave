/**
 * 宿主层 embedding 接线用例。
 * 上一版只证明了「模块能跑」，生产路径上 `vector_config` 从未被写入
 * 也就是说语义路在真实宿主里一次都没开过。这个文件专门证明接线本身：
 *   config.embedding → configureEmbedding → 注入 provider + 建索引
 *   → WeaveService.recallAsync 走 semantic 路由 → 命中只可能来自向量
 * 仍然不联网：HTTP provider 通过注入的假 fetch 出向量，后端用假 vectra。
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
  ensureVectorTables,
  getEmbeddingProvider,
  getVectorBackend,
  getVectorConfig,
  resetBackendDetection,
  setEmbeddingProvider,
  setVectorConfig,
} from "../src/store/vector";
import { setOptionalDepResolver } from "../src/store/vector-loader";
import { getQueueStatus } from "../src/store/vector-worker";
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

/** 只让 vectra 可解析 → 后端稳定为 vectra */
function useFakeVectra(): void {
  delete process.env.MEMWEAVE_VECTOR_BACKEND;
  setOptionalDepResolver((id) => {
    if (id === "vectra") return { LocalIndex: FakeLocalIndex };
    throw notFound(id);
  });
  resetBackendDetection();
}

/** 用户显式关掉向量后端（MEMWEAVE_VECTOR_BACKEND=off） */
function useNoBackend(): void {
  process.env.MEMWEAVE_VECTOR_BACKEND = "off";
  resetBackendDetection();
}

const DIMENSIONS = 4;

/** 与向量主路径用例同一套语义类别：4 维 one-hot */
function categoryVector(text: string): number[] {
  const v = [0, 0, 0, 0];
  if (/猫|feline|cat/i.test(text)) v[0] = 1;
  else if (/狗|canine|dog/i.test(text)) v[1] = 1;
  else if (/部署|deploy|脚本/i.test(text)) v[2] = 1;
  else v[3] = 1;
  return v;
}

/** 假 fetch：只认 /embeddings，按 input 出语义向量 */
function fakeFetch(): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string };
    return new Response(JSON.stringify({ data: [{ embedding: categoryVector(body.input ?? "") }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

/** 完整的 embedding 配置（指向假 fetch） */
function embeddingConfig(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    baseUrl: "https://api.example.com/v1",
    model: "fake-1",
    dimensions: DIMENSIONS,
    apiKey: "sk-test-secret",
    fetchImpl: fakeFetch(),
    ...overrides,
  };
}

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

describe("宿主 embedding 接线", () => {
  let env: WeaveEnv;
  let tmpDir: string;
  let svc: WeaveService;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "weave-emb-svc-"));
    useFakeVectra();
    env = openWeaveDb(tmpDir, { readonly: false });
    ensureSchema(env);
    ensureVectorTables(env);
    svc = new WeaveService(env, defaultConfig(tmpDir));
  });

  afterEach(() => {
    delete process.env.MEMWEAVE_VECTOR_BACKEND;
    setEmbeddingProvider(null);
    setOptionalDepResolver(null);
    resetBackendDetection();
    env.db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("没配置 embedding 时语义路如实报告 not-configured，召回行为不变", () => {
    insertMemory(env, createEntry("部署脚本放在 scripts/ 下，构建用 node"));
    expect(getEmbeddingProvider()).toBeNull();

    expect(svc.status().vectorRoute).toEqual({ enabled: false, reason: "not-configured" });
    expect(svc.status().embeddingProvider).toBeNull();
    // 关键词路照常工作
    expect(svc.recall("scripts").length).toBe(1);
  });

  it("配置不完整时不注入 provider（不会拿半个配置去发请求）", () => {
    const r = svc.configureEmbedding({ baseUrl: "", model: "m", dimensions: DIMENSIONS });
    expect(r.ok).toBe(false);
    expect(r.message).toContain("incomplete");
    expect(getEmbeddingProvider()).toBeNull();
  });

  it("配置完整后：注入 provider、写库、建索引，并在状态里报 ready", async () => {
    const cat = createEntry("用户喜欢猫");
    const dog = createEntry("用户养了两只狗");
    insertMemory(env, cat);
    insertMemory(env, dog);

    const r = svc.configureEmbedding(embeddingConfig());
    expect(r.ok).toBe(true);
    expect(getEmbeddingProvider()).toMatchObject({
      provider: "openai-compatible",
      model: "fake-1",
      dimensions: DIMENSIONS,
    });

    // 配置落库：以前 vector_config 在生产里从未被写，语义路等于永久关闭
    expect(getVectorConfig(env)).toMatchObject({ enabled: true, model: "fake-1", dimensions: DIMENSIONS });
    expect(svc.status().embeddingConfig).toMatchObject({ provider: "openai-compatible", model: "fake-1" });
    expect(svc.status().embeddingProvider).toMatchObject({ model: "fake-1", dimensions: DIMENSIONS });
    expect(svc.status().vectorRoute).toEqual({ enabled: true, reason: "ready" });

    // 后台重建 + 消费队列（不靠 sleep 猜时间）
    await svc.flushVectorWork();
    // 假 vectra 把向量放在内存里、不写 index.json，所以 indexed 统计看不到它；
    // 这里改看队列与 totalActive（真实后端下 indexed 由 countVectraItems 读文件得到）
    expect(getQueueStatus(env)).toMatchObject({ pending: 0, done: 2, failed: 0 });
    expect(svc.status().vectorStats).toMatchObject({ pending: 0, failed: 0, totalActive: 2 });
  });

  it("recallAsync 走语义路：查询词不在任何正文里，命中只能来自向量", async () => {
    const cat = createEntry("用户喜欢猫，家里有一只橘猫");
    const dog = createEntry("用户养了两只狗，每天遛狗");
    const deploy = createEntry("部署脚本放在 scripts/ 下");
    for (const e of [cat, dog, deploy]) insertMemory(env, e);

    svc.configureEmbedding(embeddingConfig());
    await svc.flushVectorWork();

    for (const e of [cat, dog, deploy]) expect(e.content).not.toContain("feline");
    // 同步召回（关键词）查不到
    expect(svc.recall("feline")).toEqual([]);

    const hits = await svc.recallAsync("feline");
    expect(hits.map((h) => h.id)).toEqual([cat.id]);
  });

  it("省略 enabled 也按默认开启：配置成功即参与语义召回", async () => {
    const cat = createEntry("用户喜欢猫，家里有一只橘猫");
    insertMemory(env, cat);

    // 用户只写 baseUrl / model / dimensions，不写 enabled
    const cfg = embeddingConfig();
    const noFlag = {
      baseUrl: cfg.baseUrl,
      model: cfg.model,
      dimensions: cfg.dimensions,
      apiKey: cfg.apiKey,
      fetchImpl: cfg.fetchImpl,
    };
    expect(svc.configureEmbedding(noFlag).ok).toBe(true);
    await svc.flushVectorWork();

    expect(getVectorConfig(env)).toMatchObject({ enabled: true, model: "fake-1" });
    expect(svc.status().vectorRoute).toEqual({ enabled: true, reason: "ready" });
    expect(ids(await svc.recallAsync("feline"))).toEqual([cat.id]);
  });

  it("显式关闭会落库：后续写入不再入队，召回退回关键词", async () => {
    const cat = createEntry("用户喜欢猫");
    insertMemory(env, cat);
    svc.configureEmbedding(embeddingConfig());
    await svc.flushVectorWork();
    expect(getQueueStatus(env)).toMatchObject({ pending: 0, done: 1 });

    const off = svc.configureEmbedding({ ...embeddingConfig(), enabled: false });
    // 显式关闭是用户意图，不是失败 —— 设置页的开关据此反馈「已关闭」
    expect(off.ok).toBe(true);
    expect(off.message).toContain("disabled");
    expect(getEmbeddingProvider()).toBeNull();
    expect(getVectorConfig(env)?.enabled).toBe(false);
    // 理由要区分「用户关了」和「从来没配过」
    expect(svc.status().vectorRoute).toEqual({ enabled: false, reason: "disabled" });

    // 关闭后写入不应再堆 pending（否则队列只进不出）
    insertMemory(env, createEntry("临时的启动记录"));
    expect(getQueueStatus(env)).toMatchObject({ pending: 0, done: 1 });
    expect(ids(await svc.recallAsync("feline"))).toEqual([]);
  });

  it("语义路不可用时 recallAsync 与同步 recall 结果完全一致", async () => {
    insertMemory(env, createEntry("部署脚本放在 scripts/ 下，构建用 node"));
    insertMemory(env, createEntry("用户喜欢猫"));

    // 未配置 provider
    expect(ids(await svc.recallAsync("部署"))).toEqual(ids(svc.recall("部署")));

    // 配置了 provider 但后端没装
    useNoBackend();
    svc.configureEmbedding(embeddingConfig());
    await svc.flushVectorWork();
    expect(svc.status().vectorRoute).toEqual({ enabled: false, reason: "no-backend" });
    expect(ids(await svc.recallAsync("部署"))).toEqual(ids(svc.recall("部署")));

    // 后端就绪但开关被关掉
    useFakeVectra();
    setVectorConfig(env, { enabled: false, dimensions: DIMENSIONS, provider: "openai-compatible", model: "fake-1" });
    expect(svc.status().vectorRoute).toEqual({ enabled: false, reason: "disabled" });
    expect(ids(await svc.recallAsync("部署"))).toEqual(ids(svc.recall("部署")));
  });

  it("provider 出错时降级到关键词，不把检索整个弄挂", async () => {
    insertMemory(env, createEntry("部署脚本放在 scripts/ 下，构建用 node"));

    const failing = embeddingConfig({
      fetchImpl: (async () => new Response("gateway down", { status: 503 })) as unknown as typeof fetch,
    });
    expect(svc.configureEmbedding(failing).ok).toBe(true);
    await svc.flushVectorWork();

    // 索引建不出来是预期内的（provider 一直 503），但召回必须退到关键词
    const asyncHits = await svc.recallAsync("部署");
    const syncHits = svc.recall("部署");
    expect(ids(asyncHits)).toEqual(ids(syncHits));
    expect(asyncHits.length).toBeGreaterThan(0);
  });

  it("pumpVectorQueue：新写入的记忆由 Worker 补索引，随后可被语义召回", async () => {
    svc.configureEmbedding(embeddingConfig());
    await svc.flushVectorWork();
    expect(svc.status().vectorStats).toMatchObject({ pending: 0, failed: 0, totalActive: 0 });

    const cat = createEntry("用户喜欢猫");
    insertMemory(env, cat);

    const stats = await svc.pumpVectorQueue();
    expect(stats.succeeded).toBe(1);
    expect(getQueueStatus(env)).toMatchObject({ pending: 0, done: 1, failed: 0 });
    expect(svc.status().vectorStats).toMatchObject({ pending: 0, failed: 0, totalActive: 1 });

    expect(ids(await svc.recallAsync("feline"))).toEqual([cat.id]);
  });

  it("没有 provider 时 pumpVectorQueue 不做无意义调用", async () => {
    insertMemory(env, createEntry("用户喜欢猫"));
    expect(await svc.pumpVectorQueue()).toEqual({ processed: 0, succeeded: 0, failed: 0 });
  });

  it("健康检查把语义路状态分开报告：未配置=pass，配了但后端被关=warn", async () => {
    const before = svc.health().checks.find((c) => c.name === "vector");
    expect(before?.status).toBe("pass");
    expect(before?.detail).toContain("未配置 embedding provider");

    useNoBackend();
    svc.configureEmbedding(embeddingConfig());
    await svc.flushVectorWork();

    const after = svc.health().checks.find((c) => c.name === "vector");
    expect(after?.status).toBe("warn");
    expect(after?.detail).toContain("向量后端被显式关闭");
  });
});

function ids(hits: Array<{ id: string }>): string[] {
  return hits.map((h) => h.id);
}
