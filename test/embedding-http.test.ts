/**
 * 宿主 embedding provider（OpenAI 兼容 HTTP）用例。
 * 不联网：用假 fetch 断言请求形状、返回体兼容性、错误与超时行为。
 * 真正要证明的是「失败时能说清楚，且不会把错维向量写进索引」。
 */
import { describe, expect, it } from "vitest";
import {
  createHttpEmbeddingProvider,
  embeddingEndpoint,
  EmbeddingHttpError,
  resolveEmbeddingConfig,
  type HttpEmbeddingConfig,
} from "../src/store/embedding";

const DIMENSIONS = 3;

function cfg(overrides: Partial<HttpEmbeddingConfig> = {}): HttpEmbeddingConfig {
  return {
    baseUrl: "https://api.example.com/v1",
    model: "test-embed",
    dimensions: DIMENSIONS,
    apiKey: "sk-test-secret",
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("embedding HTTP provider", () => {
  it("解析配置：缺 baseUrl / model / dimensions 任一即不可用", () => {
    expect(resolveEmbeddingConfig(undefined)).toBeNull();
    expect(resolveEmbeddingConfig({ enabled: false, baseUrl: "x", model: "m", dimensions: 3 })).toBeNull();
    expect(resolveEmbeddingConfig({ baseUrl: "", model: "m", dimensions: 3 })).toBeNull();
    expect(resolveEmbeddingConfig({ baseUrl: "http://x", model: "", dimensions: 3 })).toBeNull();
    expect(resolveEmbeddingConfig({ baseUrl: "http://x", model: "m", dimensions: 0 })).toBeNull();

    const ok = resolveEmbeddingConfig({ baseUrl: "http://x/v1", model: "m", dimensions: 8 });
    expect(ok).toMatchObject({ baseUrl: "http://x/v1", model: "m", dimensions: 8, provider: "openai-compatible" });
  });

  it("API key 优先取配置，其次环境变量", () => {
    const fromCfg = resolveEmbeddingConfig({ baseUrl: "http://x", model: "m", dimensions: 3, apiKey: "cfg-key" }, {});
    expect(fromCfg?.apiKey).toBe("cfg-key");

    const fromEnv = resolveEmbeddingConfig({ baseUrl: "http://x", model: "m", dimensions: 3 }, {
      MEMWEAVE_EMBEDDING_API_KEY: "env-key",
      OPENAI_API_KEY: "openai-key",
    });
    expect(fromEnv?.apiKey).toBe("env-key");

    const fromOpenAI = resolveEmbeddingConfig({ baseUrl: "http://x", model: "m", dimensions: 3 }, {
      OPENAI_API_KEY: "openai-key",
    });
    expect(fromOpenAI?.apiKey).toBe("openai-key");
  });

  it("端点归一：不重复拼 /embeddings，容忍尾斜杠", () => {
    expect(embeddingEndpoint("https://api.example.com/v1")).toBe("https://api.example.com/v1/embeddings");
    expect(embeddingEndpoint("https://api.example.com/v1/")).toBe("https://api.example.com/v1/embeddings");
    expect(embeddingEndpoint("https://api.example.com/v1/embeddings")).toBe("https://api.example.com/v1/embeddings");
    expect(embeddingEndpoint(" http://127.0.0.1:11434/api/ ")).toBe("http://127.0.0.1:11434/api/embeddings");
  });

  it("请求形状：POST + Bearer + model/input；返回 OpenAI 形状", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const provider = createHttpEmbeddingProvider(
      cfg({
        fetchImpl: async (url, init) => {
          calls.push({ url: String(url), init: init ?? {} });
          return jsonResponse({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
        },
      }),
    );

    const vec = await provider.generate("你好");
    // Float32Array 存不了十进制 0.1 的精确值，这里按 float32 精度比较
    expect(vec.length).toBe(3);
    expect(vec[0]).toBeCloseTo(0.1, 6);
    expect(vec[1]).toBeCloseTo(0.2, 6);
    expect(vec[2]).toBeCloseTo(0.3, 6);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.example.com/v1/embeddings");
    expect(calls[0].init.method).toBe("POST");
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer sk-test-secret");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ model: "test-embed", input: "你好" });
  });

  it("兼容 embeddings / embedding 两种返回体", async () => {
    const a = createHttpEmbeddingProvider(
      cfg({ fetchImpl: async () => jsonResponse({ embeddings: [[1, 2, 3]] }) }),
    );
    expect(Array.from(await a.generate("x"))).toEqual([1, 2, 3]);

    const b = createHttpEmbeddingProvider(cfg({ fetchImpl: async () => jsonResponse({ embedding: [4, 5, 6] }) }));
    expect(Array.from(await b.generate("x"))).toEqual([4, 5, 6]);
  });

  it("维度不一致直接失败，不把错维向量交给索引", async () => {
    const provider = createHttpEmbeddingProvider(
      cfg({ fetchImpl: async () => jsonResponse({ data: [{ embedding: [1, 2] }] }) }),
    );
    await expect(provider.generate("x")).rejects.toThrow(/dimension mismatch: expected 3, got 2/);
  });

  it("非 2xx 抛 EmbeddingHttpError，带状态码与截断原因，且不泄露 API key", async () => {
    const provider = createHttpEmbeddingProvider(
      cfg({ fetchImpl: async () => new Response("bad request: model not found", { status: 400 }) }),
    );
    let caught: unknown;
    try {
      await provider.generate("x");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(EmbeddingHttpError);
    const err = caught as EmbeddingHttpError;
    expect(err.status).toBe(400);
    expect(err.message).toContain("HTTP 400");
    expect(err.message).toContain("model not found");
    expect(err.message).not.toContain("sk-test-secret");
  });

  it("没有向量字段时失败，不返回空向量", async () => {
    const provider = createHttpEmbeddingProvider(cfg({ fetchImpl: async () => jsonResponse({ ok: true }) }));
    await expect(provider.generate("x")).rejects.toThrow(/no vector/);
  });

  it("超时：需要真的中止请求，而不是一直等", async () => {
    const provider = createHttpEmbeddingProvider(
      cfg({
        timeoutMs: 10,
        fetchImpl: (_url, init) =>
          new Promise<Response>((_, reject) => {
            init?.signal?.addEventListener("abort", () => {
              const err = new Error("aborted");
              err.name = "AbortError";
              reject(err);
            });
          }),
      }),
    );
    await expect(provider.generate("x")).rejects.toThrow(/timed out after 10ms/);
  });

  it("运行时没有 fetch 时创建即失败，而不是等到调用才炸", () => {
    const original = globalThis.fetch;
    try {
      // @ts-expect-error 故意移除全局 fetch
      globalThis.fetch = undefined;
      expect(() => createHttpEmbeddingProvider(cfg())).toThrow(/fetch is unavailable/);
    } finally {
      globalThis.fetch = original;
    }
  });
});
