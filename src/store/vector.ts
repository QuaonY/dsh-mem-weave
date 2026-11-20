/**
 * 向量检索（多后端支持）
 * 分层策略：
 * 1. sqlite-vec - 原生扩展，最高性能；**二进制随包分发**（`lib/native/<platform>-<arch>/`）
 *    没带上的平台或加载失败时退回本机自装的 `sqlite-vec`
 * 2. vectra - 纯 JS HNSW，零编译；**本体随包放在 `lib/vendor/`**
 * 3. builtin - 包内自带：SQLite BLOB 存向量 + JS 余弦暴力检索，**零额外安装**
 * 4. disabled - 只有显式关掉时才走到这里（`MEMWEAVE_VECTOR_BACKEND=off`）
 * 之前两个后端都要自己装，没装就等于「向量检索不存在」。
 * 现在内置后端兜底 + 原生扩展与 vectra 随包分发，安装包本身就是一个可用的向量库。
 * 设计原则：
 * - 后端始终可用；是否参与召回由 `vector_config.enabled` 与 provider 决定
 * - 失败/超时自动降级，不阻塞会话
 * - 动态加载，支持后端切换
 */

import type { Level, MemoryEntry } from "../core/types";
import type { WeaveEnv } from "./db";
import { LEVEL_ORDER } from "../core/types";
import { LAYER_TABLES } from "./schema";
import { join } from "node:path";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadOptionalDep, markOptionalDepFailure, resetOptionalDepCache } from "./vector-loader";

const LEVELS = LEVEL_ORDER;
const tableOf = (level: Level): string => LAYER_TABLES[level];

/** 向量后端类型（`builtin` = 包内自带，无需任何可选依赖） */
export type VectorBackend = "sqlite-vec" | "vectra" | "builtin" | "disabled";

/** 当前使用的后端（全局缓存） */
let currentBackend: VectorBackend | null = null;

/** 向量配置 */
export interface VectorConfig {
  /** 是否启用向量检索 */
  enabled: boolean;
  /** 向量维度 */
  dimensions: number;
  /** embedding 提供者/模型（用于重建检测） */
  provider?: string;
  model?: string;
  /** 查询超时（毫秒） */
  timeoutMs: number;
  /** 索引批次大小 */
  batchSize: number;
}

/** 向量索引任务 */
export interface EmbeddingJob {
  id: string;
  memoryId: string;
  level: Level;
  content: string;
  status: "pending" | "processing" | "done" | "failed";
  createdAt: number;
  processedAt: number | null;
  error: string | null;
  retries: number;
}

/** 向量检索结果 */
export interface VectorSearchResult {
  id: string;
  distance: number;
}

/**
 * Embedding 生成器接口（由宿主实现）。
 * 从 `vector-worker` 移到 `vector`，因为 `searchSimilar` 也要用它；
 * `vector-worker` 保持再导出，旧的导入路径不变。
 */
export interface EmbeddingProvider {
  /** 生成 embedding 向量 */
  generate(text: string): Promise<Float32Array>;
  /** 向量维度 */
  dimensions: number;
  /** 提供者标识（用于重建检测） */
  provider: string;
  model: string;
}

/** 宿主注入的 embedding provider（全局，单一宿主） */
let embeddingProvider: EmbeddingProvider | null = null;

/** 注入 / 解除 embedding provider；不注入时向量主路径保持停用 */
export function setEmbeddingProvider(provider: EmbeddingProvider | null): void {
  embeddingProvider = provider;
}

/** 当前注入的 embedding provider */
export function getEmbeddingProvider(): EmbeddingProvider | null {
  return embeddingProvider;
}

/** vectra 索引实例（按 env.dataDir 缓存） */
const vectraIndexCache = new Map<string, any>();

/** 当前 sqlite-vec 是从哪里加载的（状态展示用） */
let sqliteVecSource: "bundled" | "npm" | null = null;

/** `sqlite-vec` 实际来源：包内二进制 / npm 可选依赖 / 未生效 */
export function getSqliteVecSource(): "bundled" | "npm" | null {
  return sqliteVecSource;
}

/**
 * 包内自带的 sqlite-vec 二进制目录名，与 `vendor/sqlite-vec/` 一致。
 * 只支持 sqlite-vec 官方预编译的五个组合，其余返回 null（退回 builtin）。
 */
const BUNDLED_DIRS = new Set(["win32-x64", "linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"]);

export function bundledVecDir(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | null {
  const dir = platform + "-" + arch;
  return BUNDLED_DIRS.has(dir) ? dir : null;
}

function vecExt(platform: NodeJS.Platform): string {
  if (platform === "win32") return ".dll";
  if (platform === "darwin") return ".dylib";
  return ".so";
}

/**
 * 解析包内自带的 sqlite-vec 扩展路径。
 * - 构建后：`lib/index.js` 旁边的 `lib/native/<platform>-<arch>/vec0.*`
 * - 源码/测试：`src/store/native/...`（不存在 → null，走 npm 可选依赖）
 * - `MEMWEAVE_SQLITE_VEC_PATH` 可显式指定（测试与特殊部署用）。
 *   **只指向可信路径**：这里加载的是本地共享库，等价于执行其中的本地代码；
 *   环境变量被第三方控制时先改环境再启动，等于把执行权交出去。
 */
export function bundledVecPath(opts?: {
  platform?: NodeJS.Platform;
  arch?: string;
  baseDir?: string;
}): string | null {
  const explicit = process.env.MEMWEAVE_SQLITE_VEC_PATH;
  if (explicit && existsSync(explicit)) return explicit;

  const platform = opts?.platform ?? process.platform;
  const dir = bundledVecDir(platform, opts?.arch ?? process.arch);
  if (!dir) return null;
  const base = opts?.baseDir ?? fileURLToPath(new URL("./native/", import.meta.url));
  const file = join(base, dir, "vec0" + vecExt(platform));
  return existsSync(file) ? file : null;
}

/** 检测 sqlite-vec 是否可用 */
function checkSqliteVec(env: WeaveEnv): boolean {
  // node:sqlite 只有创建时 allowExtension 才允许加载扩展（见 store/db.ts）
  const db = env.db as { loadExtension?: (path: string) => void };
  const canLoad = typeof db.loadExtension === "function";

  // 1) 包内自带（lib/native/<platform>-<arch>/vec0.*）：装好即用，不依赖 npm 可选包
  const bundled = bundledVecPath();
  let bundledError: unknown = null;
  if (canLoad && bundled) {
    try {
      db.loadExtension!(bundled);
      sqliteVecSource = "bundled";
      return true;
    } catch (e) {
      bundledError = e;
    }
  }

  // 2) 退回 npm 可选依赖（版本更新、或自带二进制在该平台加载失败时）
  const dep = loadOptionalDep<{ load?: (db: unknown) => void }>("sqlite-vec");
  if (dep.available && dep.mod && typeof dep.mod.load === "function") {
    try {
      dep.mod.load(env.db);
      sqliteVecSource = "npm";
      return true;
    } catch (e) {
      // 模块装了但扩展加载失败（ABI 不匹配、SQLite 版本不符等）：记录原因，不假装「没装」
      markOptionalDepFailure("sqlite-vec", e);
      return false;
    }
  }
  // 自带二进制尝试过但失败：把原因记下来，设置页能看出「装了但坏」
  if (bundledError) {
    markOptionalDepFailure("sqlite-vec", bundledError);
  } else if (bundled && !canLoad) {
    // 宿主 Node 太老（<22.13）：内置二进制在，但连接不允许加载扩展
    markOptionalDepFailure(
      "sqlite-vec",
      new Error("host SQLite does not allow extension loading (需要 Node >= 22.13)"),
    );
  }
  return false;
}

/** 检测 vectra 是否可用 */
function checkVectra(): boolean {
  const dep = loadOptionalDep<{ LocalIndex?: unknown }>("vectra");
  return dep.available && !!dep.mod && typeof dep.mod.LocalIndex === "function";
}

/** 检测最佳可用后端 */
export function detectBestBackend(env: WeaveEnv): VectorBackend {
  if (currentBackend) return currentBackend;

  // 显式总开关：用户主动要「完全不要向量」时才走 disabled
  if (process.env.MEMWEAVE_VECTOR_BACKEND === "off") {
    currentBackend = "disabled";
    return "disabled";
  }

  // 优先 sqlite-vec
  if (checkSqliteVec(env)) {
    currentBackend = "sqlite-vec";
    return "sqlite-vec";
  }

  // 降级 vectra
  if (checkVectra()) {
    currentBackend = "vectra";
    return "vectra";
  }

  // 最终兜底：包内自带的 SQLite BLOB + JS 余弦
  currentBackend = "builtin";
  return "builtin";
}

/** 获取当前后端 */
export function getVectorBackend(env: WeaveEnv): VectorBackend {
  if (!currentBackend) {
    return detectBestBackend(env);
  }
  return currentBackend;
}

/** 重置后端检测（用于重试安装） */
export function resetBackendDetection(): void {
  currentBackend = null;
  sqliteVecSource = null;
  vectraIndexCache.clear();
  resetOptionalDepCache();
}

/** 初始化向量表（schema v8 的一部分） */
export function ensureVectorTables(env: WeaveEnv): void {
  const backend = getVectorBackend(env);
  // 三种可用后端共用同一套表：builtin 也把向量存进 memory_embeddings（BLOB）
  // 只是检索改为 JS 余弦。表不存在才是真正的「向量功能不存在」。
  if (backend !== "disabled") {
    try {
      // memory_embeddings: 存储向量
      env.db.exec(`
        CREATE TABLE IF NOT EXISTS memory_embeddings (
          memory_id TEXT PRIMARY KEY,
          level TEXT NOT NULL,
          embedding BLOB NOT NULL,
          dimensions INTEGER NOT NULL,
          provider TEXT,
          model TEXT,
          created_at INTEGER NOT NULL
        )
      `);
      
      // embedding_jobs: 索引队列
      env.db.exec(`
        CREATE TABLE IF NOT EXISTS embedding_jobs (
          id TEXT PRIMARY KEY,
          memory_id TEXT NOT NULL,
          level TEXT NOT NULL,
          content TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          created_at INTEGER NOT NULL,
          processed_at INTEGER,
          error TEXT,
          retries INTEGER NOT NULL DEFAULT 0
        )
      `);
      
      env.db.exec(`
        CREATE INDEX IF NOT EXISTS ix_emb_job_status ON embedding_jobs(status, created_at)
      `);
      
      // 向量索引配置（单行）
      env.db.exec(`
        CREATE TABLE IF NOT EXISTS vector_config (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          enabled INTEGER NOT NULL DEFAULT 0,
          dimensions INTEGER NOT NULL,
          provider TEXT,
          model TEXT,
          backend TEXT NOT NULL DEFAULT '${backend}',
          needs_reindex INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL
        )
      `);
    } catch {
      // 建表失败不阻塞
    }
    scrubEmbeddingResidue(env);
  }
}

/**
 * 安全修复：清理历史残留，打开库时跑一次，幂等。
 * 修复前留下的两类数据：
 * 1. 已完成任务的 content 仍是整段原文 —— 向量早已生成，原文只是多一份敏感数据落盘；
 * 2. 已标敏感的记忆仍有向量 / 待处理任务 —— 旧版入队不看 is_sensitive
 *    外部服务模式下这些原文会被发出去，召回时也会经语义路被找回来。
 * 都是纯 SQL，没有残留时只是几条空 UPDATE / DELETE。
 */
export function scrubEmbeddingResidue(env: WeaveEnv): { clearedContent: number; withdrawn: number } {
  let clearedContent = 0;
  let withdrawn = 0;
  try {
    clearedContent = Number(
      env.db.prepare("UPDATE embedding_jobs SET content = '' WHERE status = 'done' AND content <> ''").run().changes,
    );
  } catch {
    // 表不存在：向量从未启用
  }
  for (const level of LEVELS) {
    const table = tableOf(level);
    try {
      const jobs = env.db
        .prepare("DELETE FROM embedding_jobs WHERE memory_id IN (SELECT id FROM " + table + " WHERE is_sensitive = 1)")
        .run().changes;
      const vecs = env.db
        .prepare("DELETE FROM memory_embeddings WHERE memory_id IN (SELECT id FROM " + table + " WHERE is_sensitive = 1)")
        .run().changes;
      withdrawn += Number(jobs) + Number(vecs);
    } catch {
      // 旧库没有 is_sensitive 列或向量表：没有可撤的
    }
  }
  // vectra 的向量在 index.json 里，不在 memory_embeddings：按敏感 id 逐条从文件里删
  if (currentBackend === "vectra") {
    for (const level of LEVELS) {
      try {
        const rows = env.db.prepare("SELECT id FROM " + tableOf(level) + " WHERE is_sensitive = 1").all() as Array<{
          id: string;
        }>;
        for (const r of rows) withdrawn += deleteVectraItemSync(env, r.id) ? 1 : 0;
      } catch {
        // 同上
      }
    }
  }
  return { clearedContent, withdrawn };
}

/** 获取或创建 vectra 索引实例 */
async function getVectraIndex(env: WeaveEnv): Promise<any> {
  const cacheKey = env.dataDir;
  if (vectraIndexCache.has(cacheKey)) {
    return vectraIndexCache.get(cacheKey);
  }
  
  try {
    const dep = loadOptionalDep<{ LocalIndex: new (path: string) => any }>("vectra");
    if (!dep.available || !dep.mod) throw new Error("vectra not installed");
    const { LocalIndex } = dep.mod;
    const indexPath = join(env.dataDir, "vector-index");
    
    const index = new LocalIndex(indexPath);
    
    // 确保索引已初始化
    if (!await index.isIndexCreated()) {
      await index.createIndex({ version: 1 });
    }
    
    vectraIndexCache.set(cacheKey, index);
    return index;
  } catch (e) {
    throw new Error("vectra initialization failed: " + (e instanceof Error ? e.message : String(e)));
  }
}

/** 获取向量配置 */
export function getVectorConfig(env: WeaveEnv): VectorConfig | null {
  try {
    const row = env.db
      .prepare("SELECT enabled, dimensions, provider, model FROM vector_config WHERE id = 1")
      .get() as { enabled: number; dimensions: number; provider: string | null; model: string | null } | undefined;
    
    if (!row) return null;
    
    return {
      enabled: row.enabled === 1,
      dimensions: row.dimensions,
      provider: row.provider ?? undefined,
      model: row.model ?? undefined,
      timeoutMs: 5000, // 默认 5秒超时
      batchSize: 100,
    };
  } catch {
    return null;
  }
}

/** 设置向量配置（部分更新：未传的字段沿用现值，不清空） */
export function setVectorConfig(env: WeaveEnv, cfg: Partial<VectorConfig>): void {
  const now = Date.now();
  try {
    const cur = getVectorConfig(env);
    const enabled = cfg.enabled ?? cur?.enabled ?? false;
    const dimensions = cfg.dimensions ?? cur?.dimensions ?? 384;
    const provider = cfg.provider ?? cur?.provider ?? null;
    const model = cfg.model ?? cur?.model ?? null;
    const changed =
      cur != null &&
      (dimensions !== cur.dimensions ||
        provider !== (cur.provider ?? null) ||
        model !== (cur.model ?? null));
    // 无关更新（如只开关 enabled）不应清掉已挂起的重建索引标记
    const prev = env.db
      .prepare("SELECT needs_reindex FROM vector_config WHERE id = 1")
      .get() as { needs_reindex: number } | undefined;
    const needsReindex = changed ? 1 : (prev?.needs_reindex ?? 0);

    env.db
      .prepare(
        "INSERT INTO vector_config (id, enabled, dimensions, provider, model, needs_reindex, updated_at) " +
          "VALUES (1, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled, dimensions=excluded.dimensions, " +
          "provider=excluded.provider, model=excluded.model, needs_reindex=excluded.needs_reindex, updated_at=excluded.updated_at",
      )
      .run(enabled ? 1 : 0, dimensions, provider, model, needsReindex, now);
  } catch {
    // 配置失败不阻塞
  }
}

/** 添加 embedding 任务到队列 */
export function enqueueEmbedding(env: WeaveEnv, entry: MemoryEntry): void {
  if (entry.status !== "active") return; // 只索引 active
  // 后端可用 ≠ 功能开启。旧实现依赖「表不存在」隐式关闭
  // 修好加载器后表会真的建出来，若不加这道闸，每条写入都会堆一条永远不会被消费的 pending 任务。
  if (!getVectorConfig(env)?.enabled) return;
  
  // 安全修复：敏感记忆不进向量队列。
  // 外部服务模式下，原文会发往 Ollama / LM Studio / OpenAI 兼容端点
  // 敏感信息（身份证、手机号、API key 等）一旦入队就可能泄露。
  // 读（recall/inject）已经有 filter/redact 守住，写（enqueue）这一条路径补上。
  if ((entry as { is_sensitive?: number }).is_sensitive === 1) return;
  
  try {
    const id = "emb-" + entry.id + "-" + Date.now();
    env.db
      .prepare(
        "INSERT OR IGNORE INTO embedding_jobs (id, memory_id, level, content, status, created_at) " +
          "VALUES (?, ?, ?, ?, 'pending', ?)",
      )
      .run(id, entry.id, entry.level, entry.content, Date.now());
  } catch {
    // 入队失败不阻塞写入
  }
}

/**
 * 从 vectra 索引文件里同步删掉一条向量。
 * vectra 的 `deleteItem` 是异步的，而 `forgetMemory` 跑在写事务里（同步）
 * 等不了 Promise —— 旧实现因此在 vectra 后端上只留了一句「实际删除在后台 worker
 * 中执行」的注释，实际上**什么都没删**，`index.json` 里会一直留着已删除记忆的向量。
 * 这里直接改 `index.json`（与 `countVectraItems` 同源），并丢掉实例缓存
 * vectra 的 `LocalIndex` 会把 `_data` 缓存在内存里，不丢缓存的话下一次查询仍能
 * 看到已删条目，下一次 upsert 还会把它写回去。
 * 失败静默：删不掉只是留下一条陈旧向量，读回时会被 `status='active'` 过滤掉。
 * @returns 是否真的删掉了一条（历史残留清理用来计数）
 */
export function deleteVectraItemSync(env: WeaveEnv, memoryId: string): boolean {
  const file = join(env.dataDir, "vector-index", "index.json");
  if (!existsSync(file)) return false;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as {
      items?: Array<{ id?: string }>;
      [key: string]: unknown;
    };
    if (!Array.isArray(raw.items)) return false;
    const before = raw.items.length;
    raw.items = raw.items.filter((it) => it?.id !== memoryId);
    if (raw.items.length === before) return false;
    const tmp = file + ".tmp";
    writeFileSync(tmp, JSON.stringify(raw), "utf8");
    renameSync(tmp, file);
    vectraIndexCache.delete(env.dataDir);
    return true;
  } catch {
    // 索引文件坏掉 / 被占用：下次重建会覆盖
    return false;
  }
}

/** 删除记忆的 embedding */
export function deleteEmbedding(env: WeaveEnv, memoryId: string): void {
  const backend = getVectorBackend(env);
  
  try {
    if (backend === "sqlite-vec" || backend === "builtin") {
      env.db.prepare("DELETE FROM memory_embeddings WHERE memory_id = ?").run(memoryId);
    } else if (backend === "vectra") {
      deleteVectraItemSync(env, memoryId);
    }
    
    // 清除任务队列（各后端都需要）
    env.db.prepare("DELETE FROM embedding_jobs WHERE memory_id = ?").run(memoryId);
  } catch {
    // 删除失败不阻塞
  }
}

/**
 * 安全修复：记忆被标为敏感时撤出向量索引。
 * 写入路径的顺序是「insertMemory（已入队）→ 检测 → markMemorySensitive」
 * 所以 `enqueueEmbedding` 里的 is_sensitive 闸门拦不住新写入的敏感记忆：
 * 入队那一刻它还没被标记。标记之后调这里同步撤掉：
 * 还没处理的任务删掉（原文不再发往 embedding 服务），已生成的向量也删掉（不再参与语义召回）。
 */
export function withdrawSensitiveEmbedding(env: WeaveEnv, memoryId: string): void {
  deleteEmbedding(env, memoryId);
}

/** 存储 embedding 向量（同步版本，sqlite-vec 与 builtin 共用 BLOB 表） */
export function storeEmbedding(
  env: WeaveEnv,
  memoryId: string,
  level: Level,
  embedding: Float32Array,
  provider?: string,
  model?: string,
): void {
  const backend = getVectorBackend(env);
  
  try {
    if (backend === "sqlite-vec" || backend === "builtin") {
      // 以 BLOB 存储向量；按 byteOffset/byteLength 切片，避免 subarray 把整块内存写进去
      const buffer = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
      env.db
        .prepare(
          "INSERT OR REPLACE INTO memory_embeddings (memory_id, level, embedding, dimensions, provider, model, created_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(memoryId, level, buffer, embedding.length, provider ?? null, model ?? null, Date.now());
    } else if (backend === "vectra") {
      // vectra 存储是异步的，这里不实现同步版本
      // 实际存储在 storeEmbeddingAsync 中
      throw new Error("vectra requires async storage, use storeEmbeddingAsync");
    }
  } catch {
    // 存储失败不阻塞
  }
}

/** 存储 embedding 向量（异步版本，支持两种后端） */
export async function storeEmbeddingAsync(
  env: WeaveEnv,
  memoryId: string,
  level: Level,
  embedding: Float32Array,
  provider?: string,
  model?: string,
): Promise<void> {
  const backend = getVectorBackend(env);
  
  try {
    if (backend === "sqlite-vec" || backend === "builtin") {
      // 同步存储
      storeEmbedding(env, memoryId, level, embedding, provider, model);
    } else if (backend === "vectra") {
      // vectra 异步存储，使用 upsertItem
      const index = await getVectraIndex(env);
      await index.upsertItem({
        id: memoryId,
        vector: Array.from(embedding),
        metadata: { level, provider, model, createdAt: Date.now() },
      });
    }
  } catch {
    // 存储失败不阻塞
  }
}

/** 余弦相似度（Float32Array 版本） */
function cosineSim(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i];
    const y = b[i];
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** BLOB → Float32Array；复制一份保证 4 字节对齐 */
function blobToVector(blob: Uint8Array): Float32Array {
  const bytes = blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength);
  return new Float32Array(bytes);
}

/**
 * 内置后端检索：从 `memory_embeddings` 读全部向量，JS 算余弦后取 topK。
 * 复杂度 O(N·D)，1 万条 × 768 维约 10–30ms，对本插件规模足够；
 * 装上 sqlite-vec / vectra 会自动升级到索引后端，行为不变。
 */
function searchBuiltinVectors(
  env: WeaveEnv,
  query: Float32Array,
  opts: { level?: Level; project?: string; topK?: number; minScore?: number },
): VectorSearchResult[] {
  const topK = Math.max(1, opts.topK ?? 50);
  const minScore = opts.minScore ?? 0.5;

  // 活跃条目 + project 过滤（只认 active，与其它后端口径一致）
  const allowed = new Map<string, string | null>();
  for (const lv of opts.level ? [opts.level] : LEVELS) {
    const rows = env.db
      .prepare("SELECT id, project FROM " + tableOf(lv) + " WHERE status = 'active'")
      .all() as Array<{ id: string; project: string | null }>;
    for (const r of rows) allowed.set(r.id, r.project ?? null);
  }
  if (allowed.size === 0) return [];

  const rows = env.db
    .prepare("SELECT memory_id, embedding, dimensions FROM memory_embeddings")
    .all() as Array<{ memory_id: string; embedding: Uint8Array; dimensions: number }>;

  const scored: Array<{ id: string; score: number }> = [];
  for (const row of rows) {
    if (!allowed.has(row.memory_id)) continue;
    if (row.dimensions !== query.length) continue; // 换了模型但没重建：跳过，不拿随机数当相似度
    if (opts.project !== undefined) {
      const p = allowed.get(row.memory_id) ?? null;
      if (opts.project === "") {
        if (p !== null && p !== "") continue;
      } else if (p !== opts.project) continue;
    }
    const sim = cosineSim(query, blobToVector(row.embedding));
    if (sim < minScore) continue;
    scored.push({ id: row.memory_id, score: sim });
  }

  scored.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
  return scored.slice(0, topK).map((r) => ({ id: r.id, distance: 1 - r.score }));
}

/** 向量检索（余弦相似度，返回最相似的 topK）- 同步版本（sqlite-vec / builtin） */
export function searchVectors(
  env: WeaveEnv,
  query: Float32Array,
  opts: {
    level?: Level;
    project?: string;
    topK?: number;
    minScore?: number;
  } = {},
): VectorSearchResult[] {
  const backend = getVectorBackend(env);

  if (backend === "disabled") return [];
  if (backend === "builtin") {
    try {
      return searchBuiltinVectors(env, query, opts);
    } catch {
      return [];
    }
  }
  if (backend !== "sqlite-vec") {
    // vectra 需要异步查询
    return [];
  }
  
  try {
    const topK = opts.topK ?? 50;
    // 用 byteOffset/byteLength 切片：subarray 的 buffer 可能比向量本身大
    const buffer = Buffer.from(query.buffer, query.byteOffset, query.byteLength);
    
    // sqlite-vec 的余弦相似度查询
    let sql =
      "SELECT m.memory_id as id, " +
      "vec_distance_cosine(e.embedding, ?) as distance " +
      "FROM memory_embeddings e " +
      "JOIN (";

    // 根据 level 筛选（status 放在每个子查询里：写成外层派生表条件会报 no such column）
    const activeFrom = (lv: Level): string =>
      "SELECT id as memory_id, project FROM " + tableOf(lv) + " WHERE status = 'active'";
    if (opts.level) {
      sql += activeFrom(opts.level);
    } else {
      sql += LEVELS.map(activeFrom).join(" UNION ALL ");
    }

    sql += ") m ON e.memory_id = m.memory_id " +
      // 维度不匹配（换了 embedding 模型但没重建索引）直接跳过
      // 否则 vec_distance_cosine 会整条查询报错、把所有结果吞掉
      "WHERE e.dimensions = ? ";

    // 根据 project 筛选
    if (opts.project !== undefined) {
      sql += opts.project === "" ? "AND (m.project IS NULL OR m.project = '') " : "AND m.project = ? ";
    }

    sql += "ORDER BY distance ASC LIMIT ?";
    
    const params: any[] = [buffer, query.length];
    if (opts.project !== undefined && opts.project !== "") {
      params.push(opts.project);
    }
    params.push(topK);
    
    const rows = env.db.prepare(sql).all(...params) as Array<{ id: string; distance: number }>;
    
    // 过滤低分结果
    const minScore = opts.minScore ?? 0.5;
    return rows
      .map((r) => ({
        id: r.id,
        distance: r.distance,
        score: 1 - r.distance, // 距离转相似度
      }))
      .filter((r) => r.score >= minScore)
      .map((r) => ({ id: r.id, distance: r.distance }));
  } catch {
    // 查询失败降级为空
    return [];
  }
}

/** 向量检索（异步版本，支持两种后端） */
export async function searchVectorsAsync(
  env: WeaveEnv,
  query: Float32Array,
  opts: {
    level?: Level;
    project?: string;
    topK?: number;
    minScore?: number;
  } = {},
): Promise<VectorSearchResult[]> {
  const backend = getVectorBackend(env);
  
  if (backend === "disabled") return [];
  
  try {
    const topK = opts.topK ?? 50;
    const minScore = opts.minScore ?? 0.5;
    
    if (backend === "sqlite-vec" || backend === "builtin") {
      // 使用同步版本
      return searchVectors(env, query, opts);
    } else if (backend === "vectra") {
      // vectra 异步查询: queryItems(vector, query, topK, filter?, isBm25?)
      const index = await getVectraIndex(env);
      const results = await index.queryItems(Array.from(query), "", topK);
      
      // 需要过滤 level/project/status
      const activeIds = new Set<string>();
      for (const lv of opts.level ? [opts.level] : LEVELS) {
        const table = tableOf(lv);
        let sql = "SELECT id FROM " + table + " WHERE status = 'active'";
        if (opts.project !== undefined) {
          sql += opts.project === "" ? " AND (project IS NULL OR project = '')" : " AND project = ?";
        }
        const params = opts.project !== undefined && opts.project !== "" ? [opts.project] : [];
        const rows = env.db.prepare(sql).all(...params) as Array<{ id: string }>;
        rows.forEach((r) => activeIds.add(r.id));
      }
      
      // 过滤并转换结果
      // vectra 的 QueryResult: { item: IndexItem, score: number }
      return results
        .filter((r: any) => activeIds.has(r.item.id) && r.score >= minScore)
        .map((r: any) => ({
          id: r.item.id,
          distance: 1 - r.score, // vectra 返回的是相似度 [0,1]，转为距离
        }));
    }
    
    return [];
  } catch {
    // 查询失败降级为空
    return [];
  }
}

/** 获取待索引任务 */
export function getPendingJobs(env: WeaveEnv, limit: number = 100): EmbeddingJob[] {
  try {
    const rows = env.db
      .prepare("SELECT * FROM embedding_jobs WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?")
      .all(limit) as Array<{
      id: string;
      memory_id: string;
      level: Level;
      content: string;
      status: string;
      created_at: number;
      processed_at: number | null;
      error: string | null;
      retries: number;
    }>;
    
    return rows.map((r) => ({
      id: r.id,
      memoryId: r.memory_id,
      level: r.level as Level,
      content: r.content,
      status: r.status as "pending" | "processing" | "done" | "failed",
      createdAt: r.created_at,
      processedAt: r.processed_at,
      error: r.error,
      retries: r.retries,
    }));
  } catch {
    return [];
  }
}

/** 更新任务状态；完成（done）时清空 content，与 vector-worker 同口径 */
export function updateJobStatus(
  env: WeaveEnv,
  jobId: string,
  status: "processing" | "done" | "failed",
  error?: string,
): void {
  try {
    if (status === "done") {
      env.db
        .prepare("UPDATE embedding_jobs SET status = ?, processed_at = ?, error = NULL, content = '' WHERE id = ?")
        .run(status, Date.now(), jobId);
      return;
    }
    env.db
      .prepare("UPDATE embedding_jobs SET status = ?, processed_at = ?, error = ? WHERE id = ?")
      .run(status, Date.now(), error ?? null, jobId);
  } catch {
    // 状态更新失败不影响主流程
  }
}

/**
 * vectra 的索引是单个 JSON 文件（`<dataDir>/vector-index/index.json`）
 * `items` 数组长度即已索引条目数。
 * 后端本身是异步的，但统计要同步给 `status` / 设置页用，所以直接读文件；
 * 文件不存在、JSON 坏掉都返回 0。`resetVectraIndex` / `resetBackendDetection`
 * 会清缓存，文件即事实来源，不存在「缓存里还有旧条目」的问题。
 */
export function countVectraItems(dataDir: string): number {
  try {
    const raw = JSON.parse(readFileSync(join(dataDir, "vector-index", "index.json"), "utf8")) as {
      items?: unknown;
    };
    return Array.isArray(raw.items) ? raw.items.length : 0;
  } catch {
    return 0;
  }
}

/** 向量统计 */
export function getVectorStats(env: WeaveEnv): {
  backend: VectorBackend;
  indexed: number;
  pending: number;
  failed: number;
  totalActive: number;
  /** 维度与当前配置不一致的旧向量：切模型后它们既查不到也会占位，必须重建 */
  stale: number;
} {
  const backend = getVectorBackend(env);
  
  try {
    let indexed = 0;
    
    // sqlite-vec / builtin: 从表统计
    if (backend === "sqlite-vec" || backend === "builtin") {
      try {
        indexed = (env.db.prepare("SELECT COUNT(*) as c FROM memory_embeddings").get() as { c: number }).c;
      } catch {
        indexed = 0;
      }
    }
    // vectra: 向量在索引文件里，不在 SQLite；读 index.json 的 items 长度
    else if (backend === "vectra") {
      indexed = countVectraItems(env.dataDir);
    }
    
    const pending = (env.db.prepare("SELECT COUNT(*) as c FROM embedding_jobs WHERE status = 'pending'").get() as { c: number }).c;
    const failed = (env.db.prepare("SELECT COUNT(*) as c FROM embedding_jobs WHERE status = 'failed'").get() as { c: number }).c;
    
    let totalActive = 0;
    for (const level of LEVELS) {
      const table = tableOf(level);
      const row = env.db.prepare("SELECT COUNT(*) as c FROM " + table + " WHERE status = 'active'").get() as { c: number };
      totalActive += row.c;
    }

    // 切模型后旧维度的向量还在表里：检索时被维度闸门跳过，但会让「已索引 N」虚高
    // 用户看到 107/107 却召回不到东西。这里单独数出来，界面提示需要重建。
    let stale = 0;
    if (backend === "sqlite-vec" || backend === "builtin") {
      try {
        const dims = getVectorConfig(env)?.dimensions;
        if (typeof dims === "number" && dims > 0) {
          stale = (
            env.db.prepare("SELECT COUNT(*) as c FROM memory_embeddings WHERE dimensions <> ?").get(dims) as { c: number }
          ).c;
        }
      } catch {
        stale = 0;
      }
    }
    
    return { backend, indexed, pending, failed, totalActive, stale };
  } catch {
    return { backend, indexed: 0, pending: 0, failed: 0, totalActive: 0, stale: 0 };
  }
}

/** 清空所有向量索引（重建前） */
export function clearAllVectors(env: WeaveEnv): void {
  const backend = getVectorBackend(env);
  
  try {
    if (backend === "sqlite-vec" || backend === "builtin") {
      env.db.exec("DELETE FROM memory_embeddings");
    } else if (backend === "vectra") {
      // vectra: 清空索引目录（需要异步）
      // 这里只清除任务队列，索引在 clearAllVectorsAsync 中清除
    }
    
    env.db.exec("DELETE FROM embedding_jobs");
  } catch {
    // 清空失败不阻塞
  }
}

/** 清空所有向量索引（异步版本，支持 vectra） */
export async function clearAllVectorsAsync(env: WeaveEnv): Promise<void> {
  const backend = getVectorBackend(env);
  
  try {
    if (backend === "sqlite-vec" || backend === "builtin") {
      clearAllVectors(env);
    } else if (backend === "vectra") {
      const index = await getVectraIndex(env);
      // 获取所有项目 ID 并批量删除
      const items = await index.listItems();
      const ids = items.map((item: any) => item.id);
      if (ids.length > 0) {
        await index.deleteItems(ids);
      }
      
      env.db.exec("DELETE FROM embedding_jobs");
    }
  } catch {
    // 清空失败不阻塞
  }
}

// ==================== Embedding 配置管理 ====================

/** Embedding 配置 */
export interface EmbeddingConfigInfo {
  provider: string | null;
  model: string | null;
  dimensions: number;
  updatedAt: number;
}

/** 获取当前 embedding 配置 */
export function getEmbeddingConfig(env: WeaveEnv): EmbeddingConfigInfo | null {
  try {
    const row = env.db.prepare("SELECT provider, model, dimensions, updated_at FROM embedding_config WHERE id = 1").get() as 
      { provider: string | null; model: string | null; dimensions: number; updated_at: number } | undefined;
    
    if (!row) {
      return null;
    }
    
    return {
      provider: row.provider,
      model: row.model,
      dimensions: row.dimensions,
      updatedAt: row.updated_at,
    };
  } catch {
    return null;
  }
}

/** 设置 embedding 配置 */
export function setEmbeddingConfig(
  env: WeaveEnv,
  config: {
    provider: string;
    model: string;
    dimensions: number;
  }
): void {
  const now = Date.now();
  
  env.db.prepare(`
    INSERT INTO embedding_config (id, provider, model, dimensions, updated_at)
    VALUES (1, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      provider = excluded.provider,
      model = excluded.model,
      dimensions = excluded.dimensions,
      updated_at = excluded.updated_at
  `).run(config.provider, config.model, config.dimensions, now);
}

/** 检查是否需要重建索引（配置变化） */
export function needsReindex(env: WeaveEnv, newConfig: {
  provider: string;
  model: string;
  dimensions: number;
}): boolean {
  const current = getEmbeddingConfig(env);
  
  // 第一次配置，不需要重建
  if (!current) {
    return false;
  }
  
  // 任何配置变化都需要重建
  return (
    current.provider !== newConfig.provider ||
    current.model !== newConfig.model ||
    current.dimensions !== newConfig.dimensions
  );
}

/**
 * 更新 embedding 配置并标记是否需要重建
 * @returns true 如果需要重建索引
 */
export function updateEmbeddingConfig(
  env: WeaveEnv,
  config: {
    provider: string;
    model: string;
    dimensions: number;
  }
): boolean {
  const needsRebuild = needsReindex(env, config);
  setEmbeddingConfig(env, config);
  return needsRebuild;
}

/** 读取指定记忆的正文（只认 active）；找不到返回 null */
function readActiveContent(env: WeaveEnv, memoryId: string): string | null {
  for (const level of LEVELS) {
    const row = env.db
      .prepare("SELECT content FROM " + tableOf(level) + " WHERE id = ? AND status = 'active'")
      .get(memoryId) as { content: string } | undefined;
    if (row) return row.content;
  }
  return null;
}

/**
 * 语义相似搜索（真实实现）
 * 路径是「正文 → embedding → 向量检索 → 回读正文」，不是关键词匹配：
 * 查询词可以完全不出现在任何记忆正文里，只要 embedding 相近就能命中。
 * 两道闸门缺一不可：
 * - 后端可用：`disabled` 时直接返回空，不假装有结果；
 * - `vector_config.enabled` 为真：可用 ≠ 开启，与 `enqueueEmbedding` 同一口径。
 * 任一环节失败都返回空（不阻塞会话）。
 */
export async function searchSimilar(
  env: WeaveEnv,
  content: string,
  options: {
    limit?: number;
    minScore?: number;
    /** 显式 provider 优先于注入的全局 provider（测试与多宿主场景用） */
    provider?: EmbeddingProvider;
  } = {},
): Promise<Array<{ score: number; content: string; memoryId: string }>> {
  if (getVectorBackend(env) === "disabled") return [];
  if (!getVectorConfig(env)?.enabled) return [];

  const provider = options.provider ?? embeddingProvider;
  if (!provider) return [];

  try {
    const query = await provider.generate(content);
    const limit = Math.max(1, Math.floor(options.limit ?? 5));
    const hits = await searchVectorsAsync(env, query, {
      topK: limit,
      minScore: options.minScore ?? 0.5,
    });

    const out: Array<{ score: number; content: string; memoryId: string }> = [];
    for (const hit of hits) {
      const text = readActiveContent(env, hit.id);
      if (text === null) continue;
      out.push({ score: 1 - hit.distance, content: text, memoryId: hit.id });
    }
    return out;
  } catch {
    // 查询失败降级为空
    return [];
  }
}
