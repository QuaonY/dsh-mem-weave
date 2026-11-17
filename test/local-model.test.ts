/**
 * 下载式本地模型（bge-small-zh-→ 数据目录）。
 * 不联网：fetch 用桩，按 URL 返回文件字节；这里证明的是安装器本身 ——
 * 进度、失败不写 manifest、断点复用、状态与删除，以及「没装好时不要假装能用」。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  installLocalModel,
  listLocalModels,
  localModelDir,
  localModelStatus,
  modelFileUrl,
  removeLocalModel,
  startLocalModelInstall,
  transformersAvailable,
  LOCAL_MODEL_DIMENSIONS,
  LOCAL_MODEL_FILES,
} from "../src/store/local-model";
import { resolveEmbeddingConfig } from "../src/store/embedding";
import { openWeaveDb, type WeaveEnv } from "../src/store/db";
import { ensureSchema } from "../src/store/migrate";
import { WeaveService, defaultConfig } from "../src/host/service";
import { ensureVectorTables, resetBackendDetection, setEmbeddingProvider } from "../src/store/vector";
import { setOptionalDepResolver } from "../src/store/vector-loader";

interface Call {
  url: string;
}

function installFetch(opts: { failOn?: string } = {}): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push({ url });
    if (opts.failOn && url.endsWith(opts.failOn)) {
      return new Response("nope", { status: 404 });
    }
    if (url.endsWith(".onnx")) {
      return new Response(new Uint8Array(2048).fill(7), { status: 200, headers: { "content-type": "application/octet-stream" } });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return calls;
}

describe("本地模型安装器", () => {
  let dir: string;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    dir = mkdtempSync(join(tmpdir(), "weave-local-model-"));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
  });

  it("下载全部文件后写 manifest，状态显示已安装", async () => {
    const calls = installFetch();
    const progress: string[] = [];
    const r = await installLocalModel({ dataDir: dir, onProgress: (p) => progress.push(p.file) });

    expect(r.ok).toBe(true);
    expect(progress).toEqual([...LOCAL_MODEL_FILES]);
    // HEAD 探体积 + GET 下载；这里只要求每个文件都被请求过
    expect(calls.length).toBeGreaterThanOrEqual(LOCAL_MODEL_FILES.length);
    expect(calls.every((c) => c.url.includes("/resolve/main/"))).toBe(true);
    const st = localModelStatus(dir);
    expect(st).toMatchObject({ installed: true, files: LOCAL_MODEL_FILES.length, totalFiles: LOCAL_MODEL_FILES.length });
    expect(st.bytes).toBeGreaterThan(2048);
    expect(existsSync(join(localModelDir(dir), "manifest.json"))).toBe(true);
  });

  it("支持镜像源：URL 跟着 endpoint 走", async () => {
    const calls = installFetch();
    const r = await installLocalModel({ dataDir: dir, endpoint: "https://hf-mirror.example" });
    expect(r.ok).toBe(true);
    expect(calls[0].url.startsWith("https://hf-mirror.example/Xenova/bge-small-zh-v1.5/resolve/main/")).toBe(true);
    expect(modelFileUrl("config.json", { endpoint: "https://mirror.test/" })).toBe(
      "https://mirror.test/Xenova/bge-small-zh-v1.5/resolve/main/config.json",
    );
  });

  it("某个文件 404 时整体失败，不写 manifest", async () => {
    installFetch({ failOn: "onnx/model_quantized.onnx" });
    const r = await installLocalModel({ dataDir: dir });
    expect(r.ok).toBe(false);
    expect(r.message).toContain("404");
    expect(localModelStatus(dir).installed).toBe(false);
    expect(existsSync(join(localModelDir(dir), "manifest.json"))).toBe(false);
  });

  it("已下好的文件在重试时复用，不再重复请求", async () => {
    installFetch();
    await installLocalModel({ dataDir: dir });
    const calls = installFetch();
    const again = await installLocalModel({ dataDir: dir });
    expect(again.ok).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("删除后回到未安装，目录也不在", async () => {
    installFetch();
    await installLocalModel({ dataDir: dir });
    expect(removeLocalModel(dir).ok).toBe(true);
    expect(localModelStatus(dir).installed).toBe(false);
    expect(existsSync(localModelDir(dir))).toBe(false);
  });

  it("manifest 与文件大小不一致时判定为损坏", async () => {
    installFetch();
    await installLocalModel({ dataDir: dir });
    // 手动截断一个文件，模拟下载被截断 / 用户误删内容
    const file = join(localModelDir(dir), "config.json");
    const raw = readFileSync(file, "utf8");
    writeFileSync(file, raw.slice(0, 2), "utf8");
    const st = localModelStatus(dir);
    expect(st.installed).toBe(false);
    expect(st.error).toContain("大小");
  });

  it("推理组件不可用时给出可照做的提示", async () => {
    const rt = await transformersAvailable();
    if (rt.ok) return; // 构建过（lib/vendor 在）就能加载
    expect(rt.message).toContain("重新安装插件");
  });

  it("startLocalModelInstall 立即返回，下载在后台跑（界面当场就能看到进度）", async () => {
    installFetch();
    const r = startLocalModelInstall({ dataDir: dir });
    expect(r).toMatchObject({ ok: true, started: true });
    // 返回时就已是「下载中」，不用等第一个文件落地
    const mid = localModelStatus(dir);
    expect(mid.installing).toBe(true);
    expect(mid.downloading).toBe(true);
    // 连点两次不会起两个任务
    expect(startLocalModelInstall({ dataDir: dir }).started).toBe(false);
    for (let i = 0; i < 100 && !localModelStatus(dir).installed; i += 1) {
      await new Promise((res) => setTimeout(res, 10));
    }
    const after = localModelStatus(dir);
    expect(after.installed).toBe(true);
    expect(after.installing).toBe(false);
    expect(after.downloading).toBe(false);
  });

  it("中断留下的进度文件过期后不再显示「下载中」", () => {
    const modelDir = localModelDir(dir);
    mkdirSync(modelDir, { recursive: true });
    const progress = join(modelDir, ".download.json");
    writeFileSync(
      progress,
      JSON.stringify({ model: "bge-small-zh-v1.5", bytesDone: 100, bytesTotal: 1000, at: Date.now() - 3600_000 }),
      "utf8",
    );
    expect(localModelStatus(dir).downloading).toBe(false);
    writeFileSync(
      progress,
      JSON.stringify({ model: "bge-small-zh-v1.5", bytesDone: 100, bytesTotal: 1000, at: Date.now() }),
      "utf8",
    );
    expect(localModelStatus(dir).downloading).toBe(true);
  });

  it("清单里每个模型都带内存要求，用户下载前就能判断跑不跑得动", () => {
    const all = listLocalModels(dir);
    expect(all.map((m) => m.id)).toEqual([
      "bge-small-zh-v1.5",
      "all-MiniLM-L6-v2",
      "multilingual-e5-small",
      "bge-m3",
    ]);
    expect(all.every((m) => m.ramGb >= 4)).toBe(true);
    expect(all.find((m) => m.id === "bge-m3")?.ramGb).toBeGreaterThan(4);
    expect(localModelStatus(dir).ramGb).toBe(4);
  });

  it("直连卡住时按连接超时换下一个源（不把用户晾在 0%）", async () => {
    const calls: string[] = [];
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      if (url.startsWith("https://blocked.example/")) {
        // 模拟「连上了但一直不回响应头」：只有 abort 才结束
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      }
      if (url.endsWith(".onnx")) {
        return Promise.resolve(
          new Response(new Uint8Array(2048).fill(7), {
            status: 200,
            headers: { "content-type": "application/octet-stream" },
          }),
        );
      }
      return Promise.resolve(new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
    }) as unknown as typeof fetch;

    const r = await installLocalModel({ dataDir: dir, endpoint: "https://blocked.example", connectTimeoutMs: 25 });
    expect(r.ok).toBe(true);
    expect(calls.some((u) => u.startsWith("https://blocked.example/"))).toBe(true);
    // 超时后落到第二个源（官方站），而不是一直等
    expect(calls.some((u) => u.startsWith("https://huggingface.co/"))).toBe(true);
    expect(localModelStatus(dir).installed).toBe(true);
  });

  it("所有源都连不上时给出「连接超时」，不是一句空泛的失败", async () => {
    globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    }) as unknown as typeof fetch;
    const r = await installLocalModel({ dataDir: dir, connectTimeoutMs: 15 });
    expect(r.ok).toBe(false);
    expect(r.message).toContain("连接超时");
    expect(localModelStatus(dir).installed).toBe(false);
  });
});

describe("本地模型接进向量配置", () => {
  let dir: string;
  let env: WeaveEnv;
  let svc: WeaveService;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    dir = mkdtempSync(join(tmpdir(), "weave-local-model-svc-"));
    delete process.env.MEMWEAVE_VECTOR_BACKEND;
    setOptionalDepResolver((id) => {
      const e = new Error(`Cannot find module '${id}'`);
      (e as { code?: string }).code = "MODULE_NOT_FOUND";
      throw e;
    });
    resetBackendDetection();
    env = openWeaveDb(dir, { readonly: false });
    ensureSchema(env);
    ensureVectorTables(env);
    svc = new WeaveService(env, defaultConfig(dir));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    setEmbeddingProvider(null);
    setOptionalDepResolver(null);
    resetBackendDetection();
    env.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("resolveEmbeddingConfig 认本地模型：不需要地址，默认 512 维", () => {
    const cfg = resolveEmbeddingConfig({ provider: "local-model" });
    expect(cfg).toMatchObject({ provider: "local-model", model: "bge-small-zh-v1.5", dimensions: LOCAL_MODEL_DIMENSIONS });
    expect(cfg?.baseUrl).toBe("");
  });

  it("模型没下完就打开开关：明确说要先下载，不假装就绪", async () => {
    const r = await svc.applyEmbeddingConfig({ enabled: true, provider: "local-model" });
    expect(r.ok).toBe(false);
    expect(r.message).toContain("下载");
    expect(svc.status().vectorRoute).toEqual({ enabled: false, reason: "not-configured" });
  });

  it("模型装好后可以启用：provider 就是本地模型，语义路 ready", async () => {
    installFetch();
    expect((await installLocalModel({ dataDir: dir })).ok).toBe(true);

    const r = await svc.applyEmbeddingConfig({ enabled: true, provider: "local-model" });
    expect(r.ok).toBe(true);
    expect(r.model).toBe("bge-small-zh-v1.5");
    expect(r.dimensions).toBe(LOCAL_MODEL_DIMENSIONS);
    expect(svc.status().embeddingProvider).toMatchObject({ provider: "local-model", dimensions: LOCAL_MODEL_DIMENSIONS });
    expect(svc.status().vectorRoute).toEqual({ enabled: true, reason: "ready" });
  });
});
