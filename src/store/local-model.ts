/**
 * 可选的真语义模型（本地 ONNX），由设置页「一键下载」安装到数据目录。
 * 模型权重（20+ MB 起）不随包：首次联网下载到数据目录，之后完全离线。
 * 推理内核（@huggingface/transformers + onnxruntime 五平台原生库）随包放在 lib/vendor/；
 * 包内没有或加载失败时退回 node_modules，再不行就退回内置 local-hash。
 * 目录结构（与 transformers.js 的 localModelPath 约定一致）：
 *   <dataDir>/models/<modelId>
 *     config.json  tokenizer.json  tokenizer_config.json  special_tokens_map.json
 *     onnx/model_quantized.onnx
 *     manifest.json   ← 安装完成才写；记录每个文件的大小与 sha256，之后用来校验
 */
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { EmbeddingProvider } from "./vector";
import { bundledVendorDir } from "./vendor-path";

/** 设置页「向量来源」里的第三项 */
export const LOCAL_MODEL_PROVIDER = "local-model";
/** 默认模型（中文小模型，512 维，int8 量化后约 23 MB） */
export const LOCAL_MODEL_ID = "bge-small-zh-v1.5";

export interface LocalModelSpec {
  id: string;
  /** Hugging Face 上的 ONNX 转换仓库 */
  repo: string;
  dimensions: number;
  /** 参考体积（下载前估算进度用；实际以 Content-Length 为准） */
  approxBytes: number;
  /** 语言倾向：给界面排序与提示用 */
  langs: "zh" | "en" | "multi";
  /**
   * 建议的最低内存（GB）。不是模型文件大小：
   * 跑起来还要算上 onnxruntime 本身、反量化后的浮点权重与词表，实测峰值约为文件体积的 6–10 倍。
   * 设置页在下载前就把这个数字摆出来，免得 4 GB 机器下完 560 MB 的模型才发现跑不动。
   */
  ramGb: number;
  /** 一句话说明（英文技术描述；中文文案在 i18n 里按 id 映射） */
  note: string;
}

/** 可下载的模型清单。加到这里的模型会直接出现在设置页下拉里。 */
export const LOCAL_MODELS: LocalModelSpec[] = [
  {
    id: "bge-small-zh-v1.5",
    repo: "Xenova/bge-small-zh-v1.5",
    dimensions: 512,
    approxBytes: 24451175,
    langs: "zh",
    ramGb: 4,
    note: "BAAI BGE small (Chinese), 512d, ~0.4 GB RAM at runtime",
  },
  {
    id: "all-MiniLM-L6-v2",
    repo: "Xenova/all-MiniLM-L6-v2",
    dimensions: 384,
    approxBytes: 23685172,
    langs: "en",
    ramGb: 4,
    note: "SentenceTransformers MiniLM, 384d, English, ~0.4 GB RAM",
  },
  {
    id: "multilingual-e5-small",
    repo: "Xenova/multilingual-e5-small",
    dimensions: 384,
    approxBytes: 135380000,
    langs: "multi",
    ramGb: 6,
    note: "Microsoft E5 small, 384d, 100+ languages, ~0.8 GB RAM",
  },
  {
    id: "bge-m3",
    repo: "Xenova/bge-m3",
    dimensions: 1024,
    approxBytes: 586800000,
    langs: "multi",
    ramGb: 8,
    note: "BAAI BGE-M3, 1024d, strong zh/en, large, ~2 GB RAM",
  },
];

export const LOCAL_MODEL_DIMENSIONS = LOCAL_MODELS[0].dimensions;

export function getLocalModel(id?: string): LocalModelSpec {
  return LOCAL_MODELS.find((m) => m.id === id) ?? LOCAL_MODELS[0];
}

export const LOCAL_MODEL_REVISION = "main";

/** 国内网络常需要镜像；可用 MEMWEAVE_MODEL_ENDPOINT 覆盖 */
export const DEFAULT_MODEL_ENDPOINT = "https://huggingface.co";
/** 直连不通时自动尝试的镜像（国内网络常见） */
export const MIRROR_MODEL_ENDPOINT = "https://hf-mirror.com";
export const MODEL_ENDPOINT_ENV = "MEMWEAVE_MODEL_ENDPOINT";

/**
 * 连接超时：只等响应头，8 秒没动静就放弃这个源。
 * 多个源是并发的（谁先给响应头就用谁），所以正常情况下第一个源卡住不会拖慢界面。
 */
const CONNECT_TIMEOUT_MS = 8000;

class ConnectTimeout extends Error {
  constructor(urls: string[]) {
    super("连接超时：" + urls.join(" / "));
    this.name = "ConnectTimeout";
  }
}

/** 需要下载的文件（相对模型目录） */
export const LOCAL_MODEL_FILES = [
  "config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "special_tokens_map.json",
  "onnx/model_quantized.onnx",
] as const;

export interface LocalModelStatus {
  provider: typeof LOCAL_MODEL_PROVIDER;
  id: string;
  dimensions: number;
  approxBytes: number;
  langs: LocalModelSpec["langs"];
  /** 建议最低内存（GB，含推理运行时与词表常驻） */
  ramGb: number;
  /** 目录（给用户看，也方便手动放文件） */
  dir: string;
  installed: boolean;
  /** 已下载字节数与文件数 */
  bytes: number;
  files: number;
  totalFiles: number;
  /** 正在下载：当前文件名 + 已完成文件数 */
  downloading: boolean;
  /** 本进程里正在装（与 downloading 的区别：下载中断后 .download.json 还在，但没人在跑） */
  installing: boolean;
  currentFile?: string;
  doneFiles?: number;
  /** 进度：已完成字节 / 预估总字节（0–1 用在进度条上） */
  bytesDone?: number;
  bytesTotal?: number;
  error?: string;
}

export function localModelRoot(dataDir: string): string {
  return join(dataDir, "models");
}

export function localModelDir(dataDir: string, id = LOCAL_MODEL_ID): string {
  return join(localModelRoot(dataDir), getLocalModel(id).id);
}

interface Manifest {
  id: string;
  provider: string;
  dimensions: number;
  installedAt: number;
  files: Record<string, { size: number; sha256: string }>;
}

interface Progress {
  model: string;
  file?: string;
  doneFiles?: number;
  bytesDone?: number;
  bytesTotal?: number;
  at?: number;
}

/**
 * 后台安装任务：RPC 立即返回，下载在后台跑；状态通过 .download.json 反映。
 * 放在文件靠前的位置，好让 localModelStatus 也能读到「本进程是否在装」——
 * 只靠 .download.json 会有一个盲区：点了下载、第一个文件还没开始写的几百毫秒里
 * 界面上什么都看不到，用户就以为按钮没反应。
 */
const installJobs = new Map<string, Promise<unknown>>();
const installErrors = new Map<string, string>();

function jobKey(dataDir: string, id: string): string {
  return dataDir + "|" + id;
}

/** 某个模型是否正在下载（进程内判断；跨进程以 .download.json 为准） */
export function localModelInstalling(dataDir: string, id?: string): boolean {
  return installJobs.has(jobKey(dataDir, getLocalModel(id).id));
}

/** 最近一次安装失败的原因（重新下载时清空） */
export function localModelLastError(dataDir: string, id?: string): string | undefined {
  return installErrors.get(jobKey(dataDir, getLocalModel(id).id));
}

function readManifest(dir: string): Manifest | null {
  try {
    return JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Manifest;
  } catch {
    return null;
  }
}

function readProgress(dir: string): Progress | null {
  try {
    return JSON.parse(readFileSync(join(dir, ".download.json"), "utf8")) as Progress;
  } catch {
    return null;
  }
}

/** 进度文件多久没更新就算过期（下载中断 / 进程被杀，别一直显示「下载中」） */
const PROGRESS_TTL_MS = 3 * 60 * 1000;

/** 模型是否装好：有 manifest，且清单里的文件都在、大小对得上 */
export function localModelStatus(dataDir: string, id = LOCAL_MODEL_ID): LocalModelStatus {
  const spec = getLocalModel(id);
  const dir = localModelDir(dataDir, spec.id);
  const manifest = readManifest(dir);
  const rawProgress = readProgress(dir);
  const installing = localModelInstalling(dataDir, spec.id);
  // 只有本进程在装，或进度文件是新鲜的，才算「下载中」；
  // 否则昨天中断留下的 .download.json 会让设置页永远停在某个百分比。
  const progress =
    rawProgress && (installing || Date.now() - (rawProgress.at ?? 0) < PROGRESS_TTL_MS) ? rawProgress : null;
  const base: LocalModelStatus = {
    provider: LOCAL_MODEL_PROVIDER,
    id: spec.id,
    dimensions: spec.dimensions,
    approxBytes: spec.approxBytes,
    langs: spec.langs,
    ramGb: spec.ramGb,
    dir,
    installed: false,
    bytes: 0,
    files: 0,
    totalFiles: LOCAL_MODEL_FILES.length,
    downloading: Boolean(progress),
    installing,
    currentFile: progress?.file,
    doneFiles: progress?.doneFiles,
    bytesDone: progress?.bytesDone,
    bytesTotal: progress?.bytesTotal ?? spec.approxBytes,
  };
  if (!manifest) {
    let bytes = 0;
    for (const rel of LOCAL_MODEL_FILES) {
      try {
        bytes += statSync(join(dir, rel)).size;
      } catch {
        // 还没下到
      }
    }
    return { ...base, bytes };
  }
  let bytes = 0;
  let files = 0;
  for (const [rel, meta] of Object.entries(manifest.files)) {
    try {
      const st = statSync(join(dir, rel));
      if (st.size !== meta.size) return { ...base, bytes, files, error: "文件大小与安装清单不一致：" + rel };
      bytes += st.size;
      files += 1;
    } catch {
      return { ...base, bytes, files, error: "缺少文件：" + rel };
    }
  }
  return { ...base, installed: true, bytes, files, downloading: false };
}

function sha256(buf: Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}

function modelEndpoint(env: Record<string, string | undefined> = process.env): string {
  return (env[MODEL_ENDPOINT_ENV] ?? "").trim().replace(/\/+$/, "") || DEFAULT_MODEL_ENDPOINT;
}

/** HF 直链：<endpoint>/<repo>/resolve/<rev>/<file> */
export function modelFileUrl(
  file: string,
  opts: { endpoint?: string; repo?: string; revision?: string } = {},
): string {
  const endpoint = (opts.endpoint ?? DEFAULT_MODEL_ENDPOINT).replace(/\/+$/, "");
  const repo = opts.repo ?? LOCAL_MODELS[0].repo;
  const revision = opts.revision ?? LOCAL_MODEL_REVISION;
  return endpoint + "/" + repo + "/resolve/" + revision + "/" + file;
}

export interface InstallLocalModelOptions {
  dataDir: string;
  /** 模型 id（来自 LOCAL_MODELS）；缺省用默认模型 */
  modelId?: string;
  /** 覆盖下载源（镜像、内网缓存） */
  endpoint?: string;
  fetchImpl?: typeof fetch;
  /** 连接超时毫秒数（测试用；默认 8 秒） */
  connectTimeoutMs?: number;
  /** 每完成一个文件回调一次，便于界面刷新进度 */
  onProgress?: (info: { file: string; index: number; total: number; bytes: number }) => void;
}

function writeProgress(dir: string, p: Progress): void {
  try {
    writeFileSync(join(dir, ".download.json"), JSON.stringify({ ...p, at: Date.now() }), "utf8");
  } catch {
    // 进度写不进去不影响下载
  }
}

/**
 * 下载并安装本地模型。
 * 只写 `<dataDir>/models/<id>/`，失败不会留下「半装好」的 manifest；
 * 中途失败保留已下载文件，重试会跳过大小已对上的那些（断点续传的简化版）。
 * 下载过程把字节数写进 `.download.json`，设置页据此画进度条。
 */
export async function installLocalModel(
  opts: InstallLocalModelOptions,
): Promise<{ ok: boolean; message: string; status?: LocalModelStatus }> {
  const spec = getLocalModel(opts.modelId);
  const dir = localModelDir(opts.dataDir, spec.id);
  const doFetch =
    opts.fetchImpl ??
    (typeof globalThis.fetch === "function" ? (globalThis.fetch.bind(globalThis) as typeof fetch) : undefined);
  if (!doFetch) return { ok: false, message: "当前运行时没有 fetch，无法下载模型" };

  try {
    mkdirSync(join(dir, "onnx"), { recursive: true });
  } catch (e) {
    return { ok: false, message: "无法创建模型目录：" + String(e) };
  }

  // 总量用清单里的实测体积：不再逐个 HEAD（慢网络下 HEAD 能拖十几秒
  // 用户会盯着 0% 以为卡死）。误差几个百分点，进度条上无所谓。
  const bytesTotal = Math.max(1, spec.approxBytes);
  let completedBytes = 0;

  const files: Record<string, { size: number; sha256: string }> = {};
  let index = 0;
  try {
    for (const rel of LOCAL_MODEL_FILES) {
      index += 1;
      const dest = join(dir, rel);
      writeProgress(dir, { model: spec.id, file: rel, doneFiles: index - 1, bytesDone: completedBytes, bytesTotal });

      let buf: Uint8Array | null = null;
      try {
        const st = statSync(dest);
        if (st.size > 0) buf = new Uint8Array(readFileSync(dest));
      } catch {
        buf = null;
      }
      if (!buf) {
        const endpoints = Array.from(
          new Set([
            (opts.endpoint ?? modelEndpoint()).replace(/\/+$/, ""),
            DEFAULT_MODEL_ENDPOINT,
            MIRROR_MODEL_ENDPOINT,
          ]),
        );
        let lastError = "";
        let fileBytes = 0;
        try {
          const got = await downloadFile(
            doFetch,
            endpoints.map((endpoint) => modelFileUrl(rel, { repo: spec.repo, endpoint })),
            dest,
            (delta) => {
              fileBytes += delta;
              writeProgress(dir, {
                model: spec.id,
                file: rel,
                doneFiles: index - 1,
                bytesDone: completedBytes + fileBytes,
                bytesTotal,
              });
            },
            opts.connectTimeoutMs,
          );
          buf = got.data;
        } catch (e) {
          lastError = e instanceof Error ? e.message : String(e);
        }
        if (!buf) throw new Error("下载 " + rel + " 失败：" + lastError);
      }
      completedBytes += buf.byteLength;
      writeProgress(dir, { model: spec.id, file: rel, doneFiles: index, bytesDone: completedBytes, bytesTotal });
      files[rel] = { size: buf.byteLength, sha256: sha256(buf) };
      opts.onProgress?.({ file: rel, index, total: LOCAL_MODEL_FILES.length, bytes: buf.byteLength });
    }
    const manifest: Manifest = {
      id: spec.id,
      provider: LOCAL_MODEL_PROVIDER,
      dimensions: spec.dimensions,
      installedAt: Date.now(),
      files,
    };
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
    rmSync(join(dir, ".download.json"), { force: true });
    return { ok: true, message: "已安装 " + spec.id, status: localModelStatus(opts.dataDir, spec.id) };
  } catch (e) {
    rmSync(join(dir, ".download.json"), { force: true });
    return {
      ok: false,
      message: e instanceof Error ? e.message : String(e),
      status: localModelStatus(opts.dataDir, spec.id),
    };
  }
}

/**
 * 流式下载一个文件：多源并发取「第一个给出响应头」的，另一个立刻掐掉。
 * 边写边报进度；返回完整字节（用于算 sha256）与真正用上的源。
 * 并发而不是依次重试，是因为国内直连 huggingface.co 常见「连上了但几十秒不给响应」
 * 依次试会把进度条按在 0% 一分钟；并发时镜像通常 1–2 秒就能把第一个字节送上来。
 * 超时只约束「等响应头」这一段，一旦开始传数据就不再计时，慢速大文件不会被误杀。
 */
async function downloadFile(
  doFetch: typeof fetch,
  urls: string[],
  dest: string,
  onChunk: (bytes: number) => void,
  connectTimeoutMs = CONNECT_TIMEOUT_MS,
): Promise<{ data: Uint8Array; url: string }> {
  const ctrls = urls.map(() => new AbortController());
  const timers = ctrls.map((c) => setTimeout(() => c.abort(), connectTimeoutMs));
  const errors: string[] = [];
  const attempts = urls.map((url, i) =>
    doFetch(url, { signal: ctrls[i].signal }).then((res) => {
      if (!res || !res.ok) throw new Error("HTTP " + (res ? res.status : "无响应") + "（" + url + "）");
      return { res, i };
    }),
  );
  let picked: { res: Response; i: number } | null = null;
  try {
    picked = await Promise.any(
      attempts.map((p) =>
        p.catch((e: unknown) => {
          errors.push(e instanceof Error ? e.message : String(e));
          throw e;
        }),
      ),
    );
  } catch {
    const timedOut = ctrls.every((c) => c.signal.aborted);
    throw timedOut ? new ConnectTimeout(urls) : new Error(errors.join("；") || "下载失败");
  } finally {
    timers.forEach((t) => clearTimeout(t));
    // 只保留获胜的那条连接，其余立即断开
    ctrls.forEach((c, i) => {
      if (!picked || picked.i !== i) c.abort();
    });
  }
  const res = picked.res;
  const ctype = (res.headers.get("content-type") ?? "").toLowerCase();
  if (ctype.includes("text/html")) throw new Error("返回的是网页而不是文件（检查下载源）");

  const part = dest + ".part";
  const fd = openSync(part, "w");
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    if (res.body && typeof res.body.getReader === "function") {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          writeSync(fd, value);
          chunks.push(value);
          total += value.byteLength;
          onChunk(value.byteLength);
        }
      }
    } else {
      const buf = new Uint8Array(await res.arrayBuffer());
      writeSync(fd, buf);
      chunks.push(buf);
      total += buf.byteLength;
      onChunk(buf.byteLength);
    }
  } finally {
    closeSync(fd);
  }
  if (total === 0) {
    rmSync(part, { force: true });
    throw new Error("内容为空");
  }
  renameSync(part, dest);

  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return { data: out, url: urls[picked.i] };
}

/**
 * 启动下载并立即返回。
 * 设置页要用它：如果 RPC 一直等到下载完才 resolve，界面在几十秒里拿不到任何
 * 反馈（有的宿主还会把同命名空间的请求排队，连进度查询都一起卡住）
 * 用户看到的就是「点了没反应」。所以下载放后台，进度走 .download.json。
 */
export function startLocalModelInstall(opts: InstallLocalModelOptions): {
  ok: boolean;
  started: boolean;
  message: string;
} {
  const spec = getLocalModel(opts.modelId);
  const key = jobKey(opts.dataDir, spec.id);
  if (installJobs.has(key)) return { ok: true, started: false, message: "这个模型正在下载中" };
  // 先落一次进度：第一次轮询就能看到「downloading」，不用等下第一个文件
  try {
    const dir = localModelDir(opts.dataDir, spec.id);
    mkdirSync(join(dir, "onnx"), { recursive: true });
    writeProgress(dir, {
      model: spec.id,
      file: LOCAL_MODEL_FILES[0],
      bytesDone: 0,
      bytesTotal: spec.approxBytes,
    });
  } catch {
    // 目录建不出来下面 installLocalModel 会返回明确错误
  }
  installErrors.delete(key);
  const job = installLocalModel(opts)
    .then((r) => {
      if (!r.ok) installErrors.set(key, r.message);
      return r;
    })
    .finally(() => {
      installJobs.delete(key);
    });
  installJobs.set(key, job);
  return { ok: true, started: true, message: "已开始下载 " + spec.id };
}

/** 删除本地模型（设置页「删除模型」） */
export function removeLocalModel(dataDir: string, id?: string): { ok: boolean; message: string } {
  const dir = localModelDir(dataDir, id);
  try {
    rmSync(dir, { recursive: true, force: true });
    return { ok: true, message: "已删除本地模型文件" };
  } catch (e) {
    return { ok: false, message: "删除失败：" + String(e) };
  }
}

/** 包内没带时退回 node_modules 用的包名，单独存一个变量：避免打包器把它当成静态依赖 */
const TRANSFORMERS_PACKAGE = "@huggingface/transformers";

type TransformersModule = {
  env: { allowRemoteModels: boolean; allowLocalModels: boolean; localModelPath: string; version?: string };
  pipeline: (task: string, model: string, options: Record<string, unknown>) => Promise<unknown>;
};

async function loadTransformers(): Promise<TransformersModule> {
  // 随包自带（lib/vendor/）优先；没有或加载失败再走 node_modules（用户自行安装的）
  const vendorDir = bundledVendorDir();
  if (vendorDir) {
    const entry = join(vendorDir, "node_modules", "@huggingface", "transformers", "dist", "transformers.node.mjs");
    try {
      return (await import(pathToFileURL(entry).href)) as TransformersModule;
    } catch {
      // 退回 node_modules
    }
  }
  return (await import(TRANSFORMERS_PACKAGE)) as TransformersModule;
}

/** 推理组件是否可用；加载失败时给一句能照做的提示，而不是一个栈 */
export async function transformersAvailable(): Promise<{ ok: boolean; version?: string; message?: string }> {
  try {
    const mod = await loadTransformers();
    return { ok: true, version: mod?.env?.version };
  } catch (e) {
    return {
      ok: false,
      message:
        "本地模型推理组件加载失败（插件包内的 lib/vendor/ 可能不完整，重新安装插件即可），也可以改用外部 embedding 服务。" +
        (e instanceof Error ? " " + e.message : ""),
    };
  }
}

/**
 * 本地模型 provider。
 * 加载很慢（首次要初始化 onnxruntime + 读几十 MB 权重），所以做成「第一次 generate 时
 * 惰性加载」：配置本身是同步的，设置页保存不会被模型加载卡住。
 */
export function createLocalModelEmbeddingProvider(opts: {
  dataDir: string;
  modelId?: string;
  dimensions?: number;
}): EmbeddingProvider {
  const spec = getLocalModel(opts.modelId);
  const dimensions = opts.dimensions && opts.dimensions > 0 ? Math.floor(opts.dimensions) : spec.dimensions;
  const dir = localModelDir(opts.dataDir, spec.id);
  let pipePromise: Promise<(text: string, options: Record<string, unknown>) => Promise<{ data: Float32Array }>> | null =
    null;

  const load = async (): Promise<
    (text: string, options: Record<string, unknown>) => Promise<{ data: Float32Array }>
  > => {
    if (pipePromise) return pipePromise;
    pipePromise = (async () => {
      const mod = await loadTransformers();
      mod.env.allowRemoteModels = false;
      mod.env.allowLocalModels = true;
      mod.env.localModelPath = localModelRoot(opts.dataDir);
      const pipe = (await mod.pipeline("feature-extraction", spec.id, { dtype: "q8" })) as (
        text: string,
        options: Record<string, unknown>,
      ) => Promise<{ data: Float32Array }>;
      return pipe;
    })();
    try {
      return await pipePromise;
    } catch (e) {
      pipePromise = null; // 失败不缓存，下次还能重试
      throw new Error("本地模型加载失败（" + dir + "）：" + (e instanceof Error ? e.message : String(e)));
    }
  };

  return {
    dimensions,
    provider: LOCAL_MODEL_PROVIDER,
    model: spec.id,
    async generate(text: string): Promise<Float32Array> {
      const pipe = await load();
      const out = await pipe(text, { pooling: "mean", normalize: true });
      const data = out?.data;
      if (!data || data.length === 0) throw new Error("本地模型没有返回向量");
      return data instanceof Float32Array ? data : Float32Array.from(data as ArrayLike<number>);
    },
  };
}

/** 模型文件是否齐（provider 创建前先查一次，省得跑到第一次写入才报错） */
export function localModelReady(dataDir: string, id?: string): boolean {
  const spec = getLocalModel(id);
  return (
    localModelStatus(dataDir, spec.id).installed &&
    existsSync(join(localModelDir(dataDir, spec.id), "onnx/model_quantized.onnx"))
  );
}

/** 列出所有可下载模型的状态（设置页下拉用） */
export function listLocalModels(dataDir: string): LocalModelStatus[] {
  return LOCAL_MODELS.map((m) => localModelStatus(dataDir, m.id));
}
