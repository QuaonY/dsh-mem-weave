/**
 * embedding 自动发现（本机优先 → 云兜底）。
 * 用户要的是「向量检索默认打开」：装了 Ollama / LM Studio 就直接用
 * 有 OPENAI_API_KEY 就云兜底，都没有才退回关键词。
 * 这里全部用假 fetch：不联网、不需要 API key，断言的是「探测顺序、模型挑选
 * 维度来源、失败时的行为」这些真正会出错的接线。
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
  discoverEmbeddingConfig,
  embeddingDiscoveryEnabled,
  pickEmbeddingModel,
} from "../src/store/embedding";
import {
  getEmbeddingProvider,
  getVectorBackend,
  getVectorConfig,
  resetBackendDetection,
  setEmbeddingProvider,
} from "../src/store/vector";
import { setOptionalDepResolver } from "../src/store/vector-loader";
import type { MemoryEntry } from "../src/core/types";

const OLLAMA = "http://127.0.0.1:11434/v1";
const LMSTUDIO = "http://127.0.0.1:1234/v1";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): typeof fetch {
  return (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String((input as { url?: string })?.url ?? input);
    return handler(url, init ?? {});
  }) as unknown as typeof fetch;
}

/** 本机服务：/models 列模型，/embeddings 回一个定长向量 */
function localFetch(opts: {
  models: Record<string, string[]>;
  dimensions?: number;
  log?: string[];
  embeddingsCalls?: { headers: Record<string, string>; body: string }[];
}): typeof fetch {
  return fakeFetch(async (url, init) => {
    opts.log?.push(url);
    if (url.endsWith("/models")) {
      const base = url.slice(0, -"/models".length);
      const ids = opts.models[base];
      if (!ids) throw new Error("connect ECONNREFUSED " + base);
      return json({ data: ids.map((id) => ({ id })) });
    }
    if (url.endsWith("/embeddings")) {
      opts.embeddingsCalls?.push({
        headers: (init.headers ?? {}) as Record<string, string>,
        body: String(init.body ?? ""),
      });
      const n = opts.dimensions ?? 4;
      return json({ data: [{ embedding: Array.from({ length: n }, (_, i) => (i === 0 ? 1 : 0.1)) }] });
    }
    throw new Error("unexpected url " + url);
  });
}

const DIMENSIONS = 4;

/** 与向量主路径同一套语义类别：4 维 one-hot */
function categoryVector(text: string): number[] {
  const v = [0, 0, 0, 0];
  if (/猫|feline|cat/i.test(text)) v[0] = 1;
  else if (/部署|deploy/i.test(text)) v[1] = 1;
  else v[2] = 1;
  v[3] = 0.05;
  return v;
}

function localSemanticFetch(log?: string[]): typeof fetch {
  return fakeFetch(async (url, init) => {
    log?.push(url);
    if (url.endsWith("/models")) {
      return json({ data: [{ id: "llama3.2" }, { id: "nomic-embed-text:latest" }] });
    }
    if (url.endsWith("/embeddings")) {
      const body = JSON.parse(String(init.body ?? "{}")) as { input?: string };
      return json({ data: [{ embedding: categoryVector(String(body.input ?? "")) }] });
    }
    throw new Error("unexpected url " + url);
  });
}

describe("embedding 自动发现", () => {
  it("本机 Ollama 优先：挑 embedding 模型并用返回向量量出维度", async () => {
    const log: string[] = [];
    const found = await discoverEmbeddingConfig({
      env: {},
      fetchImpl: localFetch({ models: { [OLLAMA]: ["llama3.2", "nomic-embed-text:latest"] }, dimensions: 8, log }),
      timeoutMs: 200,
    });

    expect(found).not.toBeNull();
    expect(found!.source).toBe("local");
    expect(found!.label).toBe("ollama");
    expect(found!.baseUrl).toBe(OLLAMA);
    expect(found!.model).toBe("nomic-embed-text:latest");
    expect(found!.dimensions).toBe(8);
    expect(found!.enabled).toBe(true);
    // 命中本机后不再探测 LM Studio
    expect(log.some((u) => u.includes("1234"))).toBe(false);
  });

  it("Ollama 不在时退到 LM Studio", async () => {
    const found = await discoverEmbeddingConfig({
      env: { OPENAI_API_KEY: "sk-should-not-be-used" },
      fetchImpl: localFetch({ models: { [LMSTUDIO]: ["text-embedding-nomic-embed-text-v1.5"] }, dimensions: 768 }),
      timeoutMs: 200,
    });
    expect(found?.label).toBe("lmstudio");
    expect(found?.model).toBe("text-embedding-nomic-embed-text-v1.5");
    expect(found?.dimensions).toBe(768);
    expect(found?.source).toBe("local");
  });

  it("本机只有聊天模型时不算命中，继续走云兜底（带 Bearer）", async () => {
    const calls: Array<{ headers: Record<string, string>; body: string }> = [];
    const found = await discoverEmbeddingConfig({
      env: { OPENAI_API_KEY: "sk-test" },
      fetchImpl: fakeFetch(async (url, init) => {
        if (url === OLLAMA + "/models") return json({ data: [{ id: "llama3.2" }, { id: "qwen2.5" }] });
        if (url === LMSTUDIO + "/models") throw new Error("connect ECONNREFUSED");
        if (url === "https://api.openai.com/v1/embeddings") {
          calls.push({ headers: (init.headers ?? {}) as Record<string, string>, body: String(init.body ?? "") });
          return json({ data: [{ embedding: Array.from({ length: 1536 }, () => 0.01) }] });
        }
        throw new Error("unexpected url " + url);
      }),
      timeoutMs: 200,
    });

    expect(found?.source).toBe("cloud");
    expect(found?.baseUrl).toBe("https://api.openai.com/v1");
    expect(found?.model).toBe("text-embedding-3-small");
    expect(found?.dimensions).toBe(1536);
    expect(calls[0].headers.authorization).toBe("Bearer sk-test");
    expect(JSON.parse(calls[0].body)).toMatchObject({ model: "text-embedding-3-small" });
  });

  it("本机与云都没有 → null（调用方退回关键词，不抛错）", async () => {
    const found = await discoverEmbeddingConfig({
      env: {},
      fetchImpl: fakeFetch(async () => {
        throw new Error("connect ECONNREFUSED");
      }),
      timeoutMs: 50,
    });
    expect(found).toBeNull();
  });

  it("MEMWEAVE_EMBEDDING_DISCOVERY=0 时一次请求都不发", async () => {
    let calls = 0;
    const found = await discoverEmbeddingConfig({
      env: { MEMWEAVE_EMBEDDING_DISCOVERY: "0", OPENAI_API_KEY: "sk-test" },
      fetchImpl: fakeFetch(async () => {
        calls++;
        return json({});
      }),
    });
    expect(found).toBeNull();
    expect(calls).toBe(0);
  });

  it("显式维度时不再打 /embeddings，只用 /models 找模型", async () => {
    const log: string[] = [];
    const found = await discoverEmbeddingConfig({
      env: { MEMWEAVE_EMBEDDING_DIMENSIONS: "16" },
      fetchImpl: localFetch({ models: { [OLLAMA]: ["bge-m3:latest"] }, log }),
      timeoutMs: 200,
    });
    expect(found?.dimensions).toBe(16);
    expect(found?.model).toBe("bge-m3:latest");
    expect(log.filter((u) => u.endsWith("/embeddings")).length).toBe(0);
  });

  it("显式 baseUrl + model 直接生效，source=explicit 且不探测本机", async () => {
    const log: string[] = [];
    const found = await discoverEmbeddingConfig({
      env: {
        MEMWEAVE_EMBEDDING_BASE_URL: "http://127.0.0.1:9000/v1",
        MEMWEAVE_EMBEDDING_MODEL: "my-embed",
      },
      fetchImpl: fakeFetch(async (url) => {
        log.push(url);
        if (url === "http://127.0.0.1:9000/v1/embeddings") {
          return json({ data: [{ embedding: [0.5, 0.5, 0.5] }] });
        }
        throw new Error("unexpected url " + url);
      }),
      timeoutMs: 200,
    });
    expect(found?.source).toBe("explicit");
    expect(found?.model).toBe("my-embed");
    expect(found?.dimensions).toBe(3);
    expect(log.every((u) => u.includes("9000"))).toBe(true);
  });

  it("显式 baseUrl 不可用时返回 null，不偷偷换成本机别的服务", async () => {
    const found = await discoverEmbeddingConfig({
      env: { MEMWEAVE_EMBEDDING_BASE_URL: "http://127.0.0.1:9000/v1", MEMWEAVE_EMBEDDING_MODEL: "my-embed" },
      fetchImpl: fakeFetch(async (url) => {
        if (url.includes(":9000")) throw new Error("connect ECONNREFUSED");
        // 本机 Ollama 明明可用，但用户指名了 9000：不应回落到 ollama
        if (url === OLLAMA + "/models") return json({ data: [{ id: "nomic-embed-text" }] });
        throw new Error("unexpected url " + url);
      }),
      timeoutMs: 100,
    });
    expect(found).toBeNull();
  });

  it("测试环境默认关闭探测，显式 =1 才打开", () => {
    expect(embeddingDiscoveryEnabled({ VITEST: "true" })).toBe(false);
    expect(embeddingDiscoveryEnabled({ VITEST: "true", MEMWEAVE_EMBEDDING_DISCOVERY: "1" })).toBe(true);
    expect(embeddingDiscoveryEnabled({})).toBe(true);
    expect(embeddingDiscoveryEnabled({ MEMWEAVE_EMBEDDING_DISCOVERY: "off" })).toBe(false);
  });

  it("模型挑选优先已知 embedding 家族，其次名字里带 embed", () => {
    expect(pickEmbeddingModel(["llama3.2", "nomic-embed-text"])).toBe("nomic-embed-text");
    expect(pickEmbeddingModel(["text-embedding-3-small", "bge-m3"])).toBe("bge-m3");
    expect(pickEmbeddingModel(["llama3.2", "some-custom-embedder"])).toBe("some-custom-embedder");
    expect(pickEmbeddingModel(["llama3.2", "qwen2.5"])).toBeNull();
  });
});

describe("自动发现接到宿主（内置后端 + 本机 Ollama）", () => {
  let env: WeaveEnv;
  let tmpDir: string;
  let svc: WeaveService;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "weave-emb-discovery-"));
    delete process.env.MEMWEAVE_VECTOR_BACKEND;
    // 强制没有可选依赖：证明包内自带的 builtin 也能承担语义路
    setOptionalDepResolver((id) => {
      const e = new Error(`Cannot find module '${id}'`);
      (e as { code?: string }).code = "MODULE_NOT_FOUND";
      throw e;
    });
    resetBackendDetection();
    env = openWeaveDb(tmpDir, { readonly: false });
    ensureSchema(env);
    svc = new WeaveService(env, defaultConfig(tmpDir));
  });

  afterEach(() => {
    setEmbeddingProvider(null);
    setOptionalDepResolver(null);
    resetBackendDetection();
    env.db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

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

  it("没配置时启动探测 → 注入 provider、写入 vector_config、语义召回命中", async () => {
    insertMemory(env, createEntry("用户喜欢猫，家里有一只橘猫"));
    insertMemory(env, createEntry("部署脚本放在 scripts/ 下"));

    const found = await svc.scheduleEmbeddingDiscovery({
      env: {},
      fetchImpl: localSemanticFetch(),
      timeoutMs: 200,
    });
    expect(found?.ok).toBe(true);
    expect(found?.source).toBe("local");
    await svc.flushVectorWork();

    expect(getEmbeddingProvider()).not.toBeNull();
    expect(getVectorBackend(env)).toBe("builtin");
    expect(getVectorConfig(env)).toMatchObject({ enabled: true, provider: "ollama", dimensions: DIMENSIONS });
    expect(svc.status().vectorRoute).toMatchObject({ enabled: true, reason: "ready" });
    expect(svc.status().vectorBackend).toBe("builtin");

    // 查询词不在正文里，命中只能来自向量
    const hits = await svc.recallAsync("feline");
    expect(hits.map((h) => h.entry.content).join("|")).toContain("橘猫");
  });

  it("用户显式配置了 provider → 不再探测", async () => {
    svc.configureEmbedding({
      baseUrl: "https://api.example.com/v1",
      model: "fake-1",
      dimensions: DIMENSIONS,
      fetchImpl: localSemanticFetch(),
      apiKey: "sk-test",
    });
    expect(svc.scheduleEmbeddingDiscovery({ env: {}, fetchImpl: localSemanticFetch() })).toBeNull();
  });

  it("测试环境默认不触发探测（schedule 返回 null，不发请求）", async () => {
    let calls = 0;
    const run = svc.scheduleEmbeddingDiscovery({
      env: { VITEST: "true" },
      fetchImpl: fakeFetch(async () => {
        calls++;
        return json({});
      }),
    });
    expect(run).toBeNull();
    expect(calls).toBe(0);
    await svc.flushVectorWork();
    expect(getEmbeddingProvider()).toBeNull();
  });

  it("探测失败不写坏配置，召回仍走关键词", async () => {
    insertMemory(env, createEntry("部署脚本放在 scripts/ 下"));

    const found = await svc.scheduleEmbeddingDiscovery({
      env: {},
      fetchImpl: fakeFetch(async () => {
        throw new Error("connect ECONNREFUSED");
      }),
      timeoutMs: 50,
    });
    expect(found?.ok).toBe(false);
    expect(found?.message).toContain("no embedding endpoint");
    await svc.flushVectorWork();

    expect(getEmbeddingProvider()).toBeNull();
    expect(getVectorConfig(env)).toBeNull();
    expect(svc.status().vectorRoute).toEqual({ enabled: false, reason: "not-configured" });
    expect(svc.recall("scripts").length).toBe(1);
  });
});
