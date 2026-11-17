/**
 * 设置页的「向量检索」从只读状态改成可配置（开关 + 服务地址 / 模型 / 密钥 / 维度）。
 * 这些用例守的是 host 侧那条真实链路：
 *   embedding/configure → 验证（模型留空就挑、维度留空就量）→ 注入 provider
 *   → 写 vector_config + settings.json → 重启还能恢复
 * 不联网：fetch 换成桩，按 URL 回答 /models 与 /embeddings。
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openWeaveDb, type WeaveEnv } from "../src/store/db";
import { ensureSchema } from "../src/store/migrate";
import { WeaveService, defaultConfig } from "../src/host/service";
import { invokeRpc } from "../src/host/rpc";
import {
  ensureVectorTables,
  getEmbeddingProvider,
  getVectorBackend,
  getVectorConfig,
  resetBackendDetection,
  setEmbeddingProvider,
} from "../src/store/vector";
import { setOptionalDepResolver } from "../src/store/vector-loader";
import { probeEmbeddingConfig } from "../src/store/embedding";

interface StubOptions {
  models?: string[];
  dimensions?: number;
  /** /embeddings 返回 500 */
  failEmbeddings?: boolean;
}

interface Call {
  url: string;
  method: string;
}

/** 用一个桩顶替全局 fetch：/models 给模型列表，/embeddings 给固定维度的向量 */
function installFetch(opts: StubOptions = {}): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET" });
    if (url.endsWith("/models")) {
      return new Response(JSON.stringify({ data: (opts.models ?? []).map((id) => ({ id })) }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/embeddings")) {
      if (opts.failEmbeddings) return new Response("boom", { status: 500 });
      const dimensions = opts.dimensions ?? 8;
      return new Response(
        JSON.stringify({ data: [{ embedding: new Array(dimensions).fill(0.25) }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return calls;
}

function savedSettings(dir: string): { embedding?: Record<string, unknown> } {
  try {
    return JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")) as { embedding?: Record<string, unknown> };
  } catch {
    return {};
  }
}

describe("向量检索的配置入口", () => {
  let env: WeaveEnv;
  let tmpDir: string;
  let svc: WeaveService;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    tmpDir = mkdtempSync(join(tmpdir(), "weave-emb-ui-"));
    // 后端固定成 builtin，避免机器上有没有 sqlite-vec 影响结果
    delete process.env.MEMWEAVE_VECTOR_BACKEND;
    setOptionalDepResolver((id) => {
      const e = new Error(`Cannot find module '${id}'`);
      (e as { code?: string }).code = "MODULE_NOT_FOUND";
      throw e;
    });
    resetBackendDetection();
    env = openWeaveDb(tmpDir, { readonly: false });
    ensureSchema(env);
    ensureVectorTables(env);
    svc = new WeaveService(env, defaultConfig(tmpDir));
    expect(getVectorBackend(env)).toBe("builtin");
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.MEMWEAVE_EMBEDDING_DISCOVERY;
    setEmbeddingProvider(null);
    setOptionalDepResolver(null);
    resetBackendDetection();
    env.db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("只填服务地址：自动挑模型、自动量维度，配置落库并写入 settings.json", async () => {
    const calls = installFetch({ models: ["llama3.1", "nomic-embed-text"], dimensions: 768 });

    const r = await svc.applyEmbeddingConfig({ enabled: true, baseUrl: "http://127.0.0.1:11434/v1" });
    await svc.flushVectorWork();

    expect(r).toMatchObject({ ok: true, model: "nomic-embed-text", dimensions: 768 });
    expect(calls.some((c) => c.url.endsWith("/models"))).toBe(true);
    expect(calls.some((c) => c.url.endsWith("/embeddings"))).toBe(true);
    expect(getEmbeddingProvider()).toMatchObject({ model: "nomic-embed-text", dimensions: 768 });
    expect(getVectorConfig(env)?.enabled).toBe(true);
    expect(svc.status().vectorRoute).toEqual({ enabled: true, reason: "ready" });

    const saved = savedSettings(tmpDir);
    expect(saved.embedding).toMatchObject({
      enabled: true,
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "nomic-embed-text",
      dimensions: 768,
    });
  });

  it("填了模型与维度：仍打一次 /embeddings 校验，不一致就拒绝", async () => {
    const calls = installFetch({ dimensions: 4 });
    const r = await svc.applyEmbeddingConfig({
      enabled: true,
      baseUrl: "http://127.0.0.1:1234/v1",
      model: "m",
      dimensions: 4,
    });
    await svc.flushVectorWork();

    expect(r).toMatchObject({ ok: true, model: "m", dimensions: 4 });
    expect(calls.every((c) => c.url.endsWith("/embeddings"))).toBe(true);
    expect(getEmbeddingProvider()?.dimensions).toBe(4);

    // 填错维度不该被默默接受：服务返回 4 维，却写 99
    const mismatch = await svc.applyEmbeddingConfig({
      enabled: true,
      baseUrl: "http://127.0.0.1:1234/v1",
      model: "m",
      dimensions: 99,
    });
    expect(mismatch.ok).toBe(false);
    expect(mismatch.message).toContain("不一致");
  });

  it("关闭开关：解除 provider、落库 enabled=0，理由显示「已关闭」而不是「未配置」", async () => {
    installFetch({ models: ["nomic-embed-text"], dimensions: 8 });
    await svc.applyEmbeddingConfig({ enabled: true, baseUrl: "http://127.0.0.1:11434/v1" });
    await svc.flushVectorWork();
    expect(svc.status().vectorRoute).toEqual({ enabled: true, reason: "ready" });

    const off = await svc.applyEmbeddingConfig({ enabled: false });
    expect(off.ok).toBe(true);
    expect(getEmbeddingProvider()).toBeNull();
    expect(getVectorConfig(env)?.enabled).toBe(false);
    expect(svc.status().vectorRoute).toEqual({ enabled: false, reason: "disabled" });
    // 地址与模型要保留：重新打开时不用再填一遍
    expect(savedSettings(tmpDir).embedding).toMatchObject({
      enabled: false,
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "nomic-embed-text",
    });
  });

  it("服务不可用时只回原因，不动现有 provider", async () => {
    installFetch({ models: ["nomic-embed-text"], dimensions: 8 });
    await svc.applyEmbeddingConfig({ enabled: true, baseUrl: "http://127.0.0.1:11434/v1" });
    await svc.flushVectorWork();
    const before = getEmbeddingProvider()?.model;

    installFetch({ models: ["nomic-embed-text"], failEmbeddings: true });
    const bad = await svc.applyEmbeddingConfig({ enabled: true, baseUrl: "http://127.0.0.1:9/v1" });

    expect(bad.ok).toBe(false);
    expect(bad.message).toContain("维度");
    expect(getEmbeddingProvider()?.model).toBe(before);

    // 连不上（models 也失败）时要说清楚是「连不上」，不是「没模型」
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const probe = await probeEmbeddingConfig({ baseUrl: "http://127.0.0.1:9/v1" });
    expect(probe.ok).toBe(false);
    expect(probe.ok === false ? probe.message : "").toContain("连不上这个服务");
  });

  it("空白地址被明确拒绝，不会写坏配置", async () => {
    installFetch();
    const r = await svc.applyEmbeddingConfig({ enabled: true, baseUrl: "   " });
    expect(r.ok).toBe(false);
    expect(r.message).toContain("服务地址");
    expect(getEmbeddingProvider()).toBeNull();
    expect(savedSettings(tmpDir).embedding).toBeUndefined();
  });

  it("重新探测：本机服务可达时装上，并记录来源", async () => {
    process.env.MEMWEAVE_EMBEDDING_DISCOVERY = "1";
    installFetch({ models: ["nomic-embed-text"], dimensions: 8 });

    const r = await svc.rediscoverEmbedding();
    await svc.flushVectorWork();

    expect(r.ok).toBe(true);
    expect(getEmbeddingProvider()).not.toBeNull();
    expect(svc.status().embeddingDiscovery).toMatchObject({ status: "found" });
  });

  it("内置本地向量：不联网、立刻可用，维度默认 256", async () => {
    const calls = installFetch();
    const r = await svc.applyEmbeddingConfig({ enabled: true, provider: "local-hash" });
    await svc.flushVectorWork();

    expect(r).toMatchObject({ ok: true, model: "local-hash-v1", dimensions: 256 });
    expect(calls).toEqual([]);
    expect(getEmbeddingProvider()).toMatchObject({ provider: "local-hash", dimensions: 256 });
    expect(svc.status().vectorRoute).toEqual({ enabled: true, reason: "ready" });
    expect(savedSettings(tmpDir).embedding).toMatchObject({ enabled: true, provider: "local-hash", dimensions: 256 });
  });

  it("内置本地向量认字面相近：中文二字组重叠越多，余弦越高", async () => {
    const { createLocalHashEmbeddingProvider } = await import("../src/store/embedding");
    const p = createLocalHashEmbeddingProvider();
    const cos = (a: Float32Array, b: Float32Array): number => {
      let dot = 0;
      for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i];
      return dot;
    };
    const base = await p.generate("用户养了两只猫，一只叫团子");
    const near = await p.generate("团子是我养的猫");
    const far = await p.generate("发布前必须跑完 tsc 与 vitest");
    expect(cos(base, near)).toBeGreaterThan(cos(base, far));
    expect(cos(base, base)).toBeCloseTo(1, 5);
    // 同文本同向量（确定性，不掺随机数）
    const again = await p.generate("用户养了两只猫，一只叫团子");
    expect(Array.from(again)).toEqual(Array.from(base));
  });

  it("刚启用时把积压一次消化完：60 条不会卡在 50 条等下一分钟", async () => {
    const { insertMemory, newId } = await import("../src/store/dao");
    const ts = Date.now();
    for (let i = 0; i < 60; i += 1) {
      insertMemory(env, {
        id: newId(),
        level: "fact",
        project: null,
        section: null,
        content: "第 " + i + " 条测试记忆：用户喜欢记录日常细节",
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
      });
    }

    await svc.applyEmbeddingConfig({ enabled: true, provider: "local-hash" });
    await svc.flushVectorWork();

    const stats = svc.status().vectorStats;
    expect(stats).toMatchObject({ indexed: 60, pending: 0, failed: 0, totalActive: 60 });
  });

  it("换维度：旧向量会被判为 stale，重建后清零", async () => {
    const { insertMemory, newId } = await import("../src/store/dao");
    const ts = Date.now();
    for (let i = 0; i < 3; i += 1) {
      insertMemory(env, {
        id: newId(),
        level: "fact",
        project: null,
        section: null,
        content: "第 " + i + " 条：用户喜欢记录日常细节",
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
      });
    }
    await svc.applyEmbeddingConfig({ enabled: true, provider: "local-hash", dimensions: 256 });
    await svc.flushVectorWork();
    expect(svc.status().vectorStats).toMatchObject({ indexed: 3, stale: 0 });

    // 换成 128 维：旧向量维度不符，切换时立即清掉并重新入队（不会留着旧维度占位）
    await svc.applyEmbeddingConfig({ enabled: true, provider: "local-hash", dimensions: 128 });
    const mid = svc.status().vectorStats;
    expect(mid?.stale).toBe(0);
    // 旧 256 维向量已被清掉：此刻不可能还是「3 条都可查」
    expect(mid?.indexed ?? 0).toBeLessThan(3);
    await svc.flushVectorWork();
    expect(svc.status().vectorStats).toMatchObject({ indexed: 3, pending: 0, stale: 0 });
    expect(svc.status().embeddingProvider?.dimensions).toBe(128);
  });

  it("开关与探测是 humanOnly：AI 不能改向量配置", async () => {
    const human = (await invokeRpc(svc, "embedding/configure", { enabled: false }, "human")) as { ok?: boolean };
    expect(human.ok).not.toBe(false);
    const agent = (await invokeRpc(svc, "embedding/configure", { enabled: true, baseUrl: "http://x/v1" }, "agent")) as {
      ok?: boolean;
    };
    expect(agent.ok).toBe(false);
    const agentDiscover = (await invokeRpc(svc, "embedding/discover", {}, "agent")) as { ok?: boolean };
    expect(agentDiscover.ok).toBe(false);
  });
});
