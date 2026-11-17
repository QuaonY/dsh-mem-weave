/**
 * 宿主可注入的 embedding provider 实现。
 * 目标：让向量主路径真正可跑，而不是「接口在、没人实现」。
 * 约束：零运行时依赖 —— 只用 Node 内置 `fetch` 与 `node:crypto` 之外的东西一概不引。
 * 形状按 OpenAI `/embeddings` 兼容协议实现：
 *   POST <baseUrl>/embeddings
 *   { "model": "...", "input": "..." }
 *   → { "data": [{ "embedding": [ ... ] }] }
 * 兼容几种常见返回体（OpenAI / 部分网关 / Ollama `/api/embeddings` 风格）：
 *   { data: [{ embedding: number[] }] } | { embeddings: number[][] } | { embedding: number[] }
 * 这里不做重试、不缓存：Worker 已有重试计数与退避，重复实现只会让两套策略打架。
 */

import type { EmbeddingProvider } from "./vector";
import { getLocalModel } from "./local-model";

/** 配置项；`openService` 从插件配置读出后传进来 */
export interface HttpEmbeddingConfig {
  /** 显式开关；`false` 时不建 provider（缺省视为开启，只要 baseUrl/model/dimensions 齐全） */
  enabled?: boolean;
  /** 例如 `https://api.openai.com/v1`、`http://127.0.0.1:11434/api` */
  baseUrl: string;
  model: string;
  dimensions: number;
  /** 可以直接放在配置里，也建议用环境变量（见 `resolveEmbeddingConfig`） */
  apiKey?: string;
  /** 提供者标识，参与「换模型要重建索引」的判断；默认 openai-compatible */
  provider?: string;
  /** 单次请求超时（毫秒），默认 10000 */
  timeoutMs?: number;
  /** 测试注入用；生产走全局 fetch */
  fetchImpl?: typeof fetch;
}

/** 从配置 / 环境变量里解析出可用的 provider 配置；缺关键项返回 null */
export function resolveEmbeddingConfig(
  cfg: Partial<HttpEmbeddingConfig> | undefined,
  env: Record<string, string | undefined> = process.env,
): HttpEmbeddingConfig | null {
  if (!cfg) return null;
  if (cfg.enabled === false) return null;
  // 内置本地向量不需要地址与模型，维度有默认值
  if (cfg.provider === LOCAL_HASH_PROVIDER) {
    const dims = Number(cfg.dimensions);
    return {
      baseUrl: "",
      model: cfg.model || LOCAL_HASH_MODEL,
      dimensions: Number.isFinite(dims) && dims > 0 ? Math.floor(dims) : LOCAL_HASH_DIMENSIONS,
      provider: LOCAL_HASH_PROVIDER,
      timeoutMs: cfg.timeoutMs ?? 10000,
    };
  }
  // 下载式本地 ONNX 模型同样不需要地址
  if (cfg.provider === "local-model") {
    const dims = Number(cfg.dimensions);
    const spec = getLocalModel(cfg.model);
    return {
      baseUrl: "",
      model: spec.id,
      dimensions: Number.isFinite(dims) && dims > 0 ? Math.floor(dims) : spec.dimensions,
      provider: "local-model",
      timeoutMs: cfg.timeoutMs ?? 20000,
    };
  }
  const baseUrl = typeof cfg.baseUrl === "string" ? cfg.baseUrl.trim() : "";
  const model = typeof cfg.model === "string" ? cfg.model.trim() : "";
  const dimensions = Number(cfg.dimensions);
  if (!baseUrl || !model || !Number.isFinite(dimensions) || dimensions <= 0) return null;
  return {
    baseUrl,
    model,
    dimensions: Math.floor(dimensions),
    apiKey: cfg.apiKey || env.MEMWEAVE_EMBEDDING_API_KEY || env.OPENAI_API_KEY || undefined,
    provider: cfg.provider || "openai-compatible",
    timeoutMs: cfg.timeoutMs ?? 10000,
    fetchImpl: cfg.fetchImpl,
  };
}

/** 把 baseUrl 收敛成 embeddings 端点：已带路径就不再拼 */
export function embeddingEndpoint(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, "");
  return /\/embeddings$/.test(base) ? base : base + "/embeddings";
}

/** 把 baseUrl 收敛成 OpenAI 兼容的 models 端点 */
function modelsEndpoint(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, "");
  return /\/models$/.test(base) ? base : base + "/models";
}

/** 认三种返回体，取第一个向量 */
function pickVector(payload: unknown): number[] | null {
  if (!payload || typeof payload !== "object") return null;
  const rec = payload as Record<string, unknown>;
  const first = Array.isArray(rec.data) ? rec.data[0] : undefined;
  const candidates = [
    first && typeof first === "object" ? (first as Record<string, unknown>).embedding : undefined,
    Array.isArray(rec.embeddings) ? rec.embeddings[0] : undefined,
    rec.embedding,
  ];
  for (const c of candidates) {
    if (Array.isArray(c)) return c.map((n) => Number(n));
  }
  return null;
}

/** HTTP 层错误：带上状态码，不回显请求头与密钥 */
export class EmbeddingHttpError extends Error {
  constructor(
    readonly status: number,
    detail: string,
  ) {
    super(`embedding request failed: HTTP ${status}${detail ? " - " + detail : ""}`);
    this.name = "EmbeddingHttpError";
  }
}

/** 内置本地向量的 provider 名（不联网、不需要任何服务） */
export const LOCAL_HASH_PROVIDER = "local-hash";
export const LOCAL_HASH_MODEL = "local-hash-v1";
export const LOCAL_HASH_DIMENSIONS = 256;

/**
 * 内置本地 embedding —— 字符 n-gram 哈希，零依赖、零网络、确定性。
 * 为什么需要它：设置页写着「后端 sqlite-vec · 包内自带」，用户自然以为点一下就能
 * 用向量检索。但打包的 sqlite-vec 只是**向量存储与相似度计算**，把一段文字变成
 * 768 维向量需要 embedding 模型。没有模型时，这个哈希向量至少能把「字面相近」
 * （中文二字组 / 英文词）的记忆排到一起，让自带后端真的能跑起来。
 * 它不是语义模型：同义改写、跨语言映射都做不到。设置页里要把它标成「内置（效果有限）」
 * 真正要语义质量时仍应配 Ollama / LM Studio / OpenAI 兼容服务。
 */
export function createLocalHashEmbeddingProvider(dimensions = LOCAL_HASH_DIMENSIONS): EmbeddingProvider {
  const dims = Number.isFinite(dimensions) && dimensions > 0 ? Math.floor(dimensions) : LOCAL_HASH_DIMENSIONS;
  const fnv1a = (s: string): number => {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i += 1) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  };
  return {
    dimensions: dims,
    provider: LOCAL_HASH_PROVIDER,
    model: LOCAL_HASH_MODEL,
    async generate(text: string): Promise<Float32Array> {
      const vec = new Float32Array(dims);
      const raw = String(text ?? "").toLowerCase();
      const features: string[] = [];
      // 拉丁词
      for (const m of raw.matchAll(/[a-z0-9]+(?:[-_][a-z0-9]+)*/g)) features.push("w:" + m[0]);
      // CJK：单字 + 相邻二字组（中文检索里二字组已经能抓住大部分字面相似）
      for (const run of raw.match(/[\u4e00-\u9fff]+/g) ?? []) {
        for (let i = 0; i < run.length; i += 1) {
          features.push("c:" + run[i]);
          if (i + 1 < run.length) features.push("b:" + run.slice(i, i + 2));
        }
      }
      for (const f of features) {
        const h = fnv1a(f);
        const idx = h % dims;
        const sign = (h >>> 31) & 1 ? -1 : 1;
        vec[idx] += sign;
      }
      let norm = 0;
      for (let i = 0; i < dims; i += 1) norm += vec[i] * vec[i];
      norm = Math.sqrt(norm);
      if (norm > 0) for (let i = 0; i < dims; i += 1) vec[i] /= norm;
      return vec;
    },
  };
}

/**
 * 创建 OpenAI 兼容的 embedding provider。
 * 抛出条件（交给 Worker 记 retries / failed）：
 * - 非 2xx；
 * - 返回体没有向量；
 * - 维度与配置不一致（宁可失败，也不把错维向量写进索引）；
 * - 超时 / 网络错误。
 */
export function createHttpEmbeddingProvider(cfg: HttpEmbeddingConfig): EmbeddingProvider {
  const endpoint = embeddingEndpoint(cfg.baseUrl);
  const doFetch = cfg.fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== "function") {
    throw new Error("fetch is unavailable in this runtime; cannot create embedding provider");
  }
  const dimensions = cfg.dimensions;
  const timeoutMs = cfg.timeoutMs ?? 10000;

  return {
    dimensions,
    provider: cfg.provider || "openai-compatible",
    model: cfg.model,
    async generate(text: string): Promise<Float32Array> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (cfg.apiKey) headers.authorization = "Bearer " + cfg.apiKey;

        let res: Response;
        try {
          res = await doFetch(endpoint, {
            method: "POST",
            headers,
            body: JSON.stringify({ model: cfg.model, input: text }),
            signal: controller.signal,
          });
        } catch (err) {
          // AbortController 触发的是 AbortError；不区分平台文案
          if ((err as { name?: string })?.name === "AbortError") {
            throw new Error(`embedding request timed out after ${timeoutMs}ms`);
          }
          throw err;
        }

        if (!res.ok) {
          let detail = "";
          try {
            detail = (await res.text()).slice(0, 200).trim();
          } catch {
            // 读不到 body 就只报状态码
          }
          throw new EmbeddingHttpError(res.status, detail);
        }

        const payload = (await res.json()) as unknown;
        const vec = pickVector(payload);
        if (!vec) throw new Error("embedding response has no vector");
        if (vec.length !== dimensions) {
          throw new Error(`embedding dimension mismatch: expected ${dimensions}, got ${vec.length}`);
        }
        const out = new Float32Array(vec.length);
        for (let i = 0; i < vec.length; i++) {
          const n = vec[i];
          if (!Number.isFinite(n)) throw new Error("embedding contains non-finite values");
          out[i] = n;
        }
        return out;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 自动发现（本机优先 → 云兜底）
// ---------------------------------------------------------------------------

/** 自动发现的输入 */
export interface EmbeddingDiscoveryOptions {
  /** 默认 process.env；测试注入用 */
  env?: Record<string, string | undefined>;
  /** 默认全局 fetch；测试注入用 */
  fetchImpl?: typeof fetch;
  /** 单次探测超时（毫秒），默认 1500；本机服务不该让人等太久 */
  timeoutMs?: number;
  /** 探测维度用的文本，默认一句英文短句 */
  probeText?: string;
}

/** 自动发现的结果：在普通配置上补出来源，便于状态展示与日志 */
export interface DiscoveredEmbeddingConfig extends HttpEmbeddingConfig {
  /** local = 本机 Ollama / LM Studio；cloud = OpenAI 兼容云；explicit = 显式 baseUrl */
  source: "local" | "cloud" | "explicit";
  /** 展示用：ollama / lmstudio / openai-compatible 等 */
  label: string;
}

/**
 * 是否允许联网探测。
 * 默认在 vitest 下关闭：约 80 个用例文件走 `openService`，不该因为探测本机端口
 * 变慢或变不稳定。`MEMWEAVE_EMBEDDING_DISCOVERY=1` 可显式打开（用例里需要时用）
 * `=0` 则用户主动关闭自动发现，只认显式配置。
 */
export function embeddingDiscoveryEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = (env.MEMWEAVE_EMBEDDING_DISCOVERY ?? "").trim().toLowerCase();
  if (v === "0" || v === "off" || v === "false" || v === "no") return false;
  if (v === "1" || v === "on" || v === "true" || v === "yes") return true;
  return !env.VITEST;
}

function positiveInt(value: string | undefined): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

/** 带超时的一次 fetch；超时与网络错误都折算成 null，探测失败不是异常 */
async function fetchWithTimeout(
  doFetch: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await doFetch(url, { ...init, signal: controller.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 列出服务上的模型名；拿不到返回 null */
async function listModelIds(
  doFetch: typeof fetch,
  baseUrl: string,
  apiKey: string | undefined,
  timeoutMs: number,
): Promise<string[] | null> {
  const headers: Record<string, string> = {};
  if (apiKey) headers.authorization = "Bearer " + apiKey;
  const res = await fetchWithTimeout(doFetch, modelsEndpoint(baseUrl), { method: "GET", headers }, timeoutMs);
  if (!res || !res.ok) return null;
  try {
    const payload = (await res.json()) as unknown;
    const rec = payload as { data?: unknown; models?: unknown };
    const list = Array.isArray(rec.data) ? rec.data : Array.isArray(rec.models) ? rec.models : null;
    if (!list) return null;
    const ids: string[] = [];
    for (const item of list) {
      if (typeof item === "string") ids.push(item);
      else if (item && typeof item === "object") {
        const id = (item as { id?: unknown; name?: unknown }).id ?? (item as { name?: unknown }).name;
        if (typeof id === "string") ids.push(id);
      }
    }
    return ids;
  } catch {
    return null;
  }
}

/** 已知的 embedding 模型家族；按优先级排列，先命中先用 */
const EMBEDDING_MODEL_HINTS = [
  "nomic-embed",
  "bge-m3",
  "bge-",
  "mxbai-embed",
  "all-minilm",
  "text-embedding",
  "embeddinggemma",
  "e5-",
  "gte-",
  "jina-embed",
];

/** 从模型列表里挑一个 embedding 模型；聊天模型不能拿来做向量，宁可不选 */
export function pickEmbeddingModel(ids: string[]): string | null {
  const lower = ids.map((id) => ({ id, l: id.toLowerCase() }));
  for (const hint of EMBEDDING_MODEL_HINTS) {
    const hit = lower.find((m) => m.l.includes(hint));
    if (hit) return hit.id;
  }
  const anyEmbed = lower.find((m) => m.l.includes("embed"));
  return anyEmbed ? anyEmbed.id : null;
}

/** 真的打一次 /embeddings，用返回向量长度认定维度；失败返回 null */
async function probeDimensions(
  doFetch: typeof fetch,
  baseUrl: string,
  model: string,
  apiKey: string | undefined,
  probeText: string,
  timeoutMs: number,
): Promise<number | null> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) headers.authorization = "Bearer " + apiKey;
  const res = await fetchWithTimeout(
    doFetch,
    embeddingEndpoint(baseUrl),
    { method: "POST", headers, body: JSON.stringify({ model, input: probeText }) },
    timeoutMs,
  );
  if (!res || !res.ok) return null;
  try {
    const vec = pickVector((await res.json()) as unknown);
    return vec && vec.length > 0 ? vec.length : null;
  } catch {
    return null;
  }
}

interface LocalCandidate {
  label: string;
  baseUrl: string;
}

function localCandidates(env: Record<string, string | undefined>): LocalCandidate[] {
  const custom = (env.MEMWEAVE_EMBEDDING_LOCAL_URLS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (custom.length > 0) return custom.map((baseUrl) => ({ label: "local", baseUrl }));
  return [
    { label: "ollama", baseUrl: env.MEMWEAVE_OLLAMA_URL?.trim() || "http://127.0.0.1:11434/v1" },
    { label: "lmstudio", baseUrl: env.MEMWEAVE_LMSTUDIO_URL?.trim() || "http://127.0.0.1:1234/v1" },
  ];
}

/**
 * 自动发现可用的 embedding 服务。
 * 顺序（用户选定）：
 * 1. 显式 `MEMWEAVE_EMBEDDING_BASE_URL` + `MEMWEAVE_EMBEDDING_MODEL`；
 * 2. 本机 Ollama (11434) / LM Studio (1234)，要求列表里存在 embedding 模型；
 * 3. 云兜底：`OPENAI_BASE_URL`（默认 api.openai.com）+ `OPENAI_API_KEY`；
 * 4. 都没有 → null，调用方退回关键词召回。
 * 维度来源：`MEMWEAVE_EMBEDDING_DIMENSIONS`，否则真打一次 /embeddings 量出来。
 * 探测永远不发聊天请求、不重试、不抛错；超时即视为「这个服务不在」。
 */
export async function discoverEmbeddingConfig(
  opts: EmbeddingDiscoveryOptions = {},
): Promise<DiscoveredEmbeddingConfig | null> {
  const env = opts.env ?? process.env;
  if (!embeddingDiscoveryEnabled(env)) return null;

  const doFetch =
    opts.fetchImpl ??
    (typeof globalThis.fetch === "function" ? (globalThis.fetch.bind(globalThis) as typeof fetch) : undefined);
  if (!doFetch) return null;

  const timeoutMs = opts.timeoutMs ?? 1500;
  const probeText = opts.probeText ?? "MemWeave embedding probe";
  const modelOverride = env.MEMWEAVE_EMBEDDING_MODEL?.trim() || undefined;
  const dimsOverride = positiveInt(env.MEMWEAVE_EMBEDDING_DIMENSIONS);

  const build = (
    source: DiscoveredEmbeddingConfig["source"],
    label: string,
    baseUrl: string,
    model: string,
    dimensions: number,
    apiKey: string | undefined,
  ): DiscoveredEmbeddingConfig => ({
    enabled: true,
    baseUrl,
    model,
    dimensions,
    apiKey,
    provider: label,
    timeoutMs: 10000,
    fetchImpl: opts.fetchImpl,
    source,
    label,
  });

  // 1. 显式 baseUrl：用户已经指明服务，只补模型/维度
  const explicitBase = env.MEMWEAVE_EMBEDDING_BASE_URL?.trim();
  if (explicitBase) {
    const apiKey = env.MEMWEAVE_EMBEDDING_API_KEY || env.OPENAI_API_KEY || undefined;
    const model =
      modelOverride ??
      pickEmbeddingModel((await listModelIds(doFetch, explicitBase, apiKey, timeoutMs)) ?? []) ??
      undefined;
    if (model) {
      const dims = dimsOverride ?? (await probeDimensions(doFetch, explicitBase, model, apiKey, probeText, timeoutMs));
      if (dims) return build("explicit", "openai-compatible", explicitBase, model, dims, apiKey);
    }
    return null; // 指明了地址却不可用：不悄悄换成别的服务
  }

  // 2. 本机优先
  for (const cand of localCandidates(env)) {
    const ids = await listModelIds(doFetch, cand.baseUrl, undefined, timeoutMs);
    if (!ids || ids.length === 0) continue;
    const model = modelOverride ?? pickEmbeddingModel(ids);
    if (!model) continue; // 只有聊天模型，不做 embedding
    const dims = dimsOverride ?? (await probeDimensions(doFetch, cand.baseUrl, model, undefined, probeText, timeoutMs));
    if (dims) return build("local", cand.label, cand.baseUrl, model, dims, undefined);
  }

  // 3. 云兜底
  const cloudKey = env.OPENAI_API_KEY?.trim() || env.MEMWEAVE_EMBEDDING_API_KEY?.trim();
  if (cloudKey) {
    const baseUrl = env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1";
    const model = modelOverride ?? "text-embedding-3-small";
    const dims = dimsOverride ?? (await probeDimensions(doFetch, baseUrl, model, cloudKey, probeText, timeoutMs));
    if (dims) return build("cloud", "openai-compatible", baseUrl, model, dims, cloudKey);
  }

  // 4. 都没有：调用方退回关键词，不把「探测失败」当异常
  return null;
}

/** 「保存并测试」的入参：设置页手填的服务地址 / 模型 / 密钥 / 维度 */
export interface EmbeddingProbeInput {
  baseUrl: string;
  /** 留空则从 /models 里自动挑一个 embedding 模型 */
  model?: string;
  apiKey?: string;
  /** 可选的维度校验：填了就要求与服务实际返回一致，防止把错维向量写进索引 */
  dimensions?: number;
  fetchImpl?: typeof fetch;
  /** 单次探测超时，手动填表时给足时间，默认 5000 */
  timeoutMs?: number;
  probeText?: string;
}

/**
 * 验证一份手写的 embedding 配置。
 * 设置页拿来「保存并测试」：模型可以留空（从 `/models` 里挑），维度永远以服务实际
 * 返回为准 —— 这样用户不用去查 nomic-embed-text 是多少维；手填维度只用来做一致性校验。
 * 失败只回一句能照做的原因，不回显密钥。
 */
export async function probeEmbeddingConfig(
  input: EmbeddingProbeInput,
): Promise<{ ok: true; model: string; dimensions: number } | { ok: false; message: string }> {
  const baseUrl = (input.baseUrl ?? "").trim();
  if (!baseUrl) return { ok: false, message: "请填写服务地址，例如 http://127.0.0.1:11434/v1" };
  const doFetch =
    input.fetchImpl ??
    (typeof globalThis.fetch === "function" ? (globalThis.fetch.bind(globalThis) as typeof fetch) : undefined);
  if (!doFetch) return { ok: false, message: "当前运行时没有 fetch，无法验证 embedding 服务" };

  const timeoutMs = input.timeoutMs ?? 5000;
  const probeText = input.probeText ?? "MemWeave embedding probe";
  const apiKey = input.apiKey?.trim() || undefined;

  let model = (input.model ?? "").trim();
  if (!model) {
    const ids = await listModelIds(doFetch, baseUrl, apiKey, timeoutMs);
    if (!ids) return { ok: false, message: "连不上这个服务：检查地址、端口与服务是否在运行" };
    model = pickEmbeddingModel(ids) || "";
    if (!model) return { ok: false, message: "这个服务上没有 embedding 模型，请手动填写模型名" };
  }

  const declared = Number(input.dimensions);
  const dims = await probeDimensions(doFetch, baseUrl, model, apiKey, probeText, timeoutMs);
  if (!dims) {
    return { ok: false, message: "拿不到向量维度：请检查服务地址、模型名与 API Key（服务需支持 /embeddings）" };
  }
  if (Number.isFinite(declared) && declared > 0 && Math.floor(declared) !== dims) {
    return { ok: false, message: `服务实际返回 ${dims} 维，与填写的 ${Math.floor(declared)} 维不一致` };
  }
  return { ok: true, model, dimensions: dims };
}

