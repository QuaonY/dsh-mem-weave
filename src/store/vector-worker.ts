/**
 * 向量索引 Worker
 * 后台任务：
 * - 从 embedding_jobs 队列读取待处理任务
 * - 调用宿主 embedding API 生成向量
 * - 存储到向量后端（sqlite-vec 或 vectra）
 * - 失败重试，遵循 原则（不阻塞主流程）
 */

import type { WeaveEnv } from "./db";
import type { EmbeddingJob, EmbeddingProvider } from "./vector";
import { getEmbeddingProvider, getVectorBackend, storeEmbeddingAsync } from "./vector";

/** Embedding 生成器接口由 `./vector` 定义，这里保持再导出以免旧导入路径失效 */
export type { EmbeddingProvider };

/** Worker 配置 */
export interface WorkerConfig {
  /** 批次大小 */
  batchSize: number;
  /** 单个任务超时（毫秒） */
  timeoutMs: number;
  /** 最大重试次数 */
  maxRetries: number;
  /** 重试延迟（毫秒） */
  retryDelayMs: number;
}

const DEFAULT_WORKER_CONFIG: WorkerConfig = {
  batchSize: 10,
  timeoutMs: 30000, // 30 秒
  maxRetries: 3,
  retryDelayMs: 5000, // 5 秒
};

/** 获取待处理任务 */
function getPendingJobs(env: WeaveEnv, limit: number): EmbeddingJob[] {
  try {
    const rows = env.db
      .prepare(
        `SELECT id, memory_id, level, content, status, created_at, processed_at, error, retries
         FROM embedding_jobs
         WHERE status = 'pending'
         ORDER BY created_at ASC
         LIMIT ?`,
      )
      .all(limit) as Array<{
      id: string;
      memory_id: string;
      level: string;
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
      level: r.level as any,
      content: r.content,
      status: r.status as any,
      createdAt: r.created_at,
      processedAt: r.processed_at,
      error: r.error,
      retries: r.retries,
    }));
  } catch {
    return [];
  }
}

/** 更新任务状态 */
function updateJobStatus(
  env: WeaveEnv,
  jobId: string,
  status: "processing" | "done" | "failed",
  error?: string,
): void {
  try {
    const now = Date.now();
    if (status === "processing") {
      env.db.prepare("UPDATE embedding_jobs SET status = ? WHERE id = ?").run(status, jobId);
    } else if (status === "done") {
      // 安全修复：完成后清空 content，减少敏感数据落盘面。
      // 原文已经生成向量存到 memory_embeddings，队列里留着占空间且无用。
      env.db
        .prepare("UPDATE embedding_jobs SET status = ?, processed_at = ?, error = NULL, content = '' WHERE id = ?")
        .run(status, now, jobId);
    } else {
      // failed: 保留 content 供重试或人工排查
      env.db
        .prepare("UPDATE embedding_jobs SET status = ?, processed_at = ?, error = ? WHERE id = ?")
        .run(status, now, error ?? null, jobId);
    }
  } catch {
    // 状态更新失败不阻塞
  }
}

/** 增加重试次数 */
function incrementRetries(env: WeaveEnv, jobId: string): void {
  try {
    env.db.prepare("UPDATE embedding_jobs SET retries = retries + 1, status = 'pending' WHERE id = ?").run(jobId);
  } catch {
    // 重试失败不阻塞
  }
}

/** 处理单个任务（带超时） */
async function processJob(
  env: WeaveEnv,
  job: EmbeddingJob,
  provider: EmbeddingProvider,
  timeoutMs: number,
): Promise<{ ok: boolean; error?: string }> {
  try {
    // 标记为处理中
    updateJobStatus(env, job.id, "processing");

    // 生成 embedding（带超时）
    const embedding = await Promise.race([
      provider.generate(job.content),
      new Promise<Float32Array>((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), timeoutMs),
      ),
    ]);

    // 存储到向量后端
    await storeEmbeddingAsync(env, job.memoryId, job.level, embedding, provider.provider, provider.model);

    // 标记完成
    updateJobStatus(env, job.id, "done");

    return { ok: true };
  } catch (err: any) {
    const error = err?.message ?? String(err);
    return { ok: false, error };
  }
}

/** Worker 统计 */
export interface WorkerStats {
  processed: number;
  succeeded: number;
  failed: number;
  retried: number;
  skipped: number;
}

/**
 * 运行向量索引 Worker（处理一批任务）
 * @param env 数据环境
 * @param provider Embedding 生成器；省略时用宿主注入的全局 provider
 * @param config Worker 配置
 * @returns 处理统计
 */
export async function runVectorWorker(
  env: WeaveEnv,
  provider: EmbeddingProvider | null = getEmbeddingProvider(),
  config: Partial<WorkerConfig> = {},
): Promise<WorkerStats> {
  const cfg = { ...DEFAULT_WORKER_CONFIG, ...config };
  const stats: WorkerStats = {
    processed: 0,
    succeeded: 0,
    failed: 0,
    retried: 0,
    skipped: 0,
  };

  // 检查向量后端
  const backend = getVectorBackend(env);
  if (backend === "disabled") {
    return stats; // 向量功能禁用，跳过
  }

  // 检查 provider
  if (!provider) {
    return stats; // 无 provider，跳过（宿主未实现）
  }

  // 获取待处理任务
  const jobs = getPendingJobs(env, cfg.batchSize);
  if (jobs.length === 0) {
    return stats; // 没有待处理任务
  }

  // 逐个处理（顺序执行以避免 API rate limit）
  for (const job of jobs) {
    stats.processed++;

    // 检查重试次数
    if (job.retries >= cfg.maxRetries) {
      updateJobStatus(env, job.id, "failed", `max retries (${cfg.maxRetries}) exceeded`);
      stats.skipped++;
      continue;
    }

    // 处理任务
    const result = await processJob(env, job, provider, cfg.timeoutMs);

    if (result.ok) {
      stats.succeeded++;
    } else {
      // 失败：增加重试或标记失败
      if (job.retries + 1 < cfg.maxRetries) {
        incrementRetries(env, job.id);
        stats.retried++;

        // 重试延迟
        if (cfg.retryDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, cfg.retryDelayMs));
        }
      } else {
        updateJobStatus(env, job.id, "failed", result.error);
        stats.failed++;
      }
    }
  }

  return stats;
}

/**
 * 获取队列状态
 */
export function getQueueStatus(env: WeaveEnv): {
  pending: number;
  processing: number;
  done: number;
  failed: number;
} {
  try {
    const row = env.db
      .prepare(
        `SELECT
           SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
           SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) as processing,
           SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as done,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
         FROM embedding_jobs`,
      )
      .get() as any;

    return {
      pending: row?.pending ?? 0,
      processing: row?.processing ?? 0,
      done: row?.done ?? 0,
      failed: row?.failed ?? 0,
    };
  } catch {
    return { pending: 0, processing: 0, done: 0, failed: 0 };
  }
}

/**
 * 清理已完成的任务（保留最近 N 条）
 */
export function pruneCompletedJobs(env: WeaveEnv, keepRecent: number = 1000): number {
  try {
    const result = env.db
      .prepare(
        `DELETE FROM embedding_jobs
         WHERE status IN ('done', 'failed')
         AND id NOT IN (
           SELECT id FROM embedding_jobs
           WHERE status IN ('done', 'failed')
           ORDER BY processed_at DESC
           LIMIT ?
         )`,
      )
      .run(keepRecent);

    return Number(result.changes);
  } catch {
    return 0;
  }
}

/**
 * 重置失败的任务（用于重试）
 */
export function retryFailedJobs(env: WeaveEnv): number {
  try {
    const result = env.db
      .prepare(
        `UPDATE embedding_jobs
         SET status = 'pending', error = NULL, retries = 0
         WHERE status = 'failed'`,
      )
      .run();

    return Number(result.changes);
  } catch {
    return 0;
  }
}
