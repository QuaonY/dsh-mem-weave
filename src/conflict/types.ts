/**
 * 记忆冲突解决类型定义
 */

/** 冲突类型 */
export type ConflictType = 
  | "time"       // 时间矛盾（事件时间冲突）
  | "fact"       // 事实矛盾（陈述相互矛盾）
  | "opinion";   // 观点矛盾（态度/偏好改变）

/** 冲突状态 */
export type ConflictStatus = 
  | "pending"    // 待处理
  | "resolved"   // 已解决
  | "ignored";   // 已忽略

/** 冲突解决方式 */
export type ConflictResolution = 
  | "keep_a"     // 保留 A，删除 B
  | "keep_b"     // 保留 B，删除 A
  | "merge"      // 合并两者
  | "complement" // 标记为补充（非矛盾）
  | "ignore";    // 忽略此冲突

/** 记忆冲突记录 */
export interface MemoryConflict {
  id: number;
  memory_id_a: string;      // 记忆 A 的 ID
  memory_id_b: string;      // 记忆 B 的 ID
  level_a: string;          // 记忆 A 的层级
  level_b: string;          // 记忆 B 的层级
  conflict_type: ConflictType;
  confidence: number;       // 冲突置信度 (0-1)
  status: ConflictStatus;
  resolution?: ConflictResolution;
  resolved_at?: number;     // 解决时间 (UTC ms)
  resolved_by?: string;     // 解决者 (human/agent)
  created_at: number;       // 检测时间 (UTC ms)
  
  // 冲突详情
  reason?: string;          // 冲突原因描述
  suggested_resolution?: ConflictResolution; // 系统建议
}

/** 冲突检测结果 */
export interface ConflictDetectionResult {
  conflicts: MemoryConflict[];
  total: number;
  new_conflicts: number;    // 本次新发现的冲突数
  pending_count: number;    // 待处理冲突数
}

/** 冲突解决选项 */
export interface ConflictResolveOptions {
  resolution: ConflictResolution;
  merged_content?: string;  // merge 时的合并内容
  reason?: string;          // 解决原因
  actor?: string;           // 操作者
}

/** 冲突配置 */
export interface ConflictConfig {
  enabled: boolean;                // 启用冲突检测
  autoDetect: boolean;             // 自动检测冲突
  threshold: number;               // 相似度阈值 (0-1)
  notifyUser: boolean;             // 有冲突时通知用户
  detectTypes: ConflictType[];     // 检测的冲突类型
}

/** 默认冲突配置 */
export const DEFAULT_CONFLICT_CONFIG: ConflictConfig = {
  enabled: true,
  autoDetect: true,
  threshold: 0.85,           // 高相似度才判定为冲突
  notifyUser: false,         // 默认不打断用户
  detectTypes: ["time", "fact", "opinion"],
};
