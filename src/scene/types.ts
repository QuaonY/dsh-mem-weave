/**
 * 忆织 MemWeave —— L2 场景块类型定义
 * 将一组 L1 entries 归纳成项目/生活场景，作为召回和画像生成的中间层。
 */

import type { Level } from "../core/types";

// ---------- 场景块 ----------

export interface SceneBlock {
  /** 场景块 ID (scene-001, scene-002...) */
  id: string;
  /** 场景标题 */
  title: string;
  /** 所属项目（可空） */
  project: string | null;
  /** 场景类型 */
  type: SceneType;
  /** 包含的 entry IDs */
  entryIds: string[];
  /** AI 生成的场景摘要 */
  summary: string;
  /** 关键词（用于召回） */
  keywords: string[];
  /** 状态 */
  status: SceneStatus;
  /** 置信度 0-1 */
  confidence: number;
  /** 创建时间 */
  createdAt: number;
  /** 更新时间 */
  updatedAt: number;
  /** 最后访问时间 */
  lastAccessedAt: number;
  /** 访问次数 */
  accessCount: number;
}

export type SceneType = 
  | 'project'      // 项目场景（工作、个人项目）
  | 'life'         // 生活场景（日常、家庭）
  | 'learning'     // 学习场景（课程、技能）
  | 'social'       // 社交场景（朋友、活动）
  | 'habit'        // 习惯场景（健康、运动）
  | 'other';       // 其他

export type SceneStatus = 
  | 'active'       // 活跃
  | 'inactive'     // 不活跃
  | 'archived';    // 归档

// ---------- 场景聚合配置 ----------

export interface SceneAggregationConfig {
  /** 是否启用场景块功能（默认 false） */
  enabled: boolean;
  /** 单个场景最少 entries 数（默认 3） */
  minEntries: number;
  /** 单个场景最多 entries 数（默认 20） */
  maxEntries: number;
  /** 生成摘要的最大字符数（默认 500） */
  maxSummaryChars: number;
  /** 闲置多少天标记为 inactive（默认 30） */
  inactiveDays: number;
  /** 多久未访问可归档（默认 90） */
  archiveDays: number;
  /** 场景召回时的权重（默认 0.7） */
  recallWeight: number;
}

export const DEFAULT_SCENE_CONFIG: SceneAggregationConfig = {
  enabled: false,
  minEntries: 3,
  maxEntries: 20,
  maxSummaryChars: 500,
  inactiveDays: 30,
  archiveDays: 90,
  recallWeight: 0.7,
};

// ---------- 场景聚合结果 ----------

export interface SceneAggregationResult {
  /** 新创建的场景数 */
  created: number;
  /** 更新的场景数 */
  updated: number;
  /** 归档的场景数 */
  archived: number;
  /** 场景 IDs */
  sceneIds: string[];
}

// ---------- 场景候选 ----------

export interface SceneCandidate {
  /** 项目名 */
  project: string | null;
  /** 主题/类型 */
  topic: string | null;
  /** 相关 entries */
  entryIds: string[];
  /** 推荐的场景类型 */
  suggestedType: SceneType;
  /** 权重分数 */
  score: number;
}

// ---------- 场景召回结果 ----------

export interface SceneHit {
  /** 场景块 */
  scene: SceneBlock;
  /** 匹配分数 */
  score: number;
  /** 匹配的关键词 */
  matchedKeywords: string[];
}
