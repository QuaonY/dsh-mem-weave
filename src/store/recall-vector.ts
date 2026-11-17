/**
 * 向量路由集成到混合召回
 * 向量路由（semantic route）：
 * - 使用 embedding 查询语义相似的记忆
 * - 与 keyword/link/calendar/terms 路由一起参与 RRF 融合
 * - 支持超时降级、失败容错（遵循 原则）
 */

import type { WeaveEnv } from "./db";
import type { Level } from "../core/types";
import type { RouteRank } from "../core/score";
import { searchVectorsAsync, getVectorBackend, getVectorStats } from "./vector";

/** 向量路由配置 */
export interface VectorRouteConfig {
  /** 是否启用向量路由 */
  enabled: boolean;
  /** 向量路由权重（默认 0.8，介于 keyword 1.0 和 link 0.5 之间） */
  weight: number;
  /** 返回的最大结果数（默认 30） */
  topK: number;
  /** 最小相似度阈值（0-1，默认 0.5） */
  minScore: number;
  /** 查询超时（毫秒，默认 1000ms） */
  timeoutMs: number;
}

export const DEFAULT_VECTOR_ROUTE: VectorRouteConfig = {
  // 这是「路由调用时的兜底形态」：宿主注入 provider 后会显式传 enabled: true
  // （见 WeaveService.recallAsync），因此语义路默认跟随 provider 自动开启。
  enabled: false,
  weight: 0.8,
  topK: 30,
  minScore: 0.5,
  timeoutMs: 1000,
};

/**
 * 执行向量路由查询（带超时保护）
 * @param env 数据环境
 * @param queryEmbedding 查询的 embedding 向量
 * @param config 向量路由配置
 * @param opts 额外选项（level、project 过滤等）
 * @returns 向量路由结果（RouteRank 数组）
 */
export async function vectorRoute(
  env: WeaveEnv,
  queryEmbedding: Float32Array | null,
  config: VectorRouteConfig,
  opts?: {
    level?: Level;
    /** 项目过滤：`undefined` = 不限，`""` = 无项目的记忆 */
    project?: string;
    excludeIds?: Set<string>;
  },
): Promise<RouteRank[]> {
  // 如果未启用或没有 embedding，返回空
  if (!config.enabled || !queryEmbedding) {
    return [];
  }

  try {
    // 检查后端是否可用
    const backend = getVectorBackend(env);
    if (backend === "disabled") {
      return [];
    }

    // 带超时的向量查询
    const resultsPromise = searchVectorsAsync(env, queryEmbedding, {
      level: opts?.level,
      project: opts?.project,
      topK: config.topK,
      minScore: config.minScore,
    });

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("vector search timeout")), config.timeoutMs),
    );

    const results = await Promise.race([resultsPromise, timeoutPromise]);

    // 过滤已被其他路由命中的条目
    const filtered = opts?.excludeIds
      ? results.filter((r: any) => !opts.excludeIds!.has(r.id))
      : results;

    // 转换为 RouteRank 格式
    return filtered.map((r: any, i: number) => ({
      id: r.id,
      rank: i + 1,
      weight: config.weight,
      route: "semantic" as const,
    }));
  } catch (err) {
    // 向量查询失败不阻塞（原则）
    // 可能的原因：超时、后端不可用、embedding 维度不匹配等
    return [];
  }
}

/**
 * 获取向量路由的统计信息（用于诊断）
 */
export function getVectorRouteStats(
  env: WeaveEnv,
): {
  available: boolean;
  backend: "sqlite-vec" | "vectra" | "builtin" | "disabled";
  indexed: number;
  pending: number;
} {
  try {
    const backend = getVectorBackend(env);
    const stats = getVectorStats(env);
    
    return {
      available: backend !== "disabled",
      backend,
      indexed: stats.indexed,
      pending: stats.pending,
    };
  } catch {
    return {
      available: false,
      backend: "disabled",
      indexed: 0,
      pending: 0,
    };
  }
}
