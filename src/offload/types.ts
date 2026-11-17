/**
 * 忆织 MemWeave —— 短期上下文 Offload 类型定义
 * 将长任务中的工具调用历史 offload 到文件系统，减少上下文膨胀。
 * 默认关闭；独立模块，不混入记忆核心。
 */

// ---------- 配置 ----------

export interface OffloadConfig {
  /** 是否启用 offload（默认 false） */
  enabled: boolean;
  /** 工具调用超过此数量才启用 offload（默认 10） */
  threshold: number;
  /** 单个 node 最大字符数（超过则摘要，默认 2000） */
  maxCharsPerNode: number;
  /** 每 N 个工具调用生成一次中间摘要（默认 5） */
  summaryInterval: number;
  /** 在上下文中保留最近 N 个完整日志（默认 3） */
  keepRecentCount: number;
  /** 是否生成 Mermaid 任务图（默认 true） */
  graphEnabled: boolean;
  /** 出错时回退到不 offload（默认 true） */
  fallbackOnError: boolean;
}

export const DEFAULT_OFFLOAD_CONFIG: OffloadConfig = {
  enabled: false,
  threshold: 10,
  maxCharsPerNode: 2000,
  summaryInterval: 5,
  keepRecentCount: 3,
  graphEnabled: true,
  fallbackOnError: true,
};

// ---------- 工具调用节点 ----------

export interface ToolCallNode {
  /** 节点 ID（node-001, node-002...） */
  nodeId: string;
  /** 会话 ID */
  sessionId: string;
  /** 步骤序号 */
  step: number;
  /** 工具名称 */
  toolName: string;
  /** 工具输入（JSON 字符串或摘要） */
  input: string;
  /** 工具输出（完整或摘要） */
  output: string;
  /** 是否已被摘要（超过 maxCharsPerNode） */
  summarized: boolean;
  /** 时间戳 */
  timestamp: number;
  /** 是否成功 */
  success: boolean;
  /** 错误信息（如果失败） */
  error?: string;
}

// ---------- 摘要 ----------

export interface OffloadSummary {
  /** 摘要 ID */
  summaryId: string;
  /** 覆盖的 node 范围 */
  nodeRange: [string, string]; // [startNodeId, endNodeId]
  /** 摘要文本 */
  text: string;
  /** 工具调用次数 */
  toolCount: number;
  /** 创建时间 */
  createdAt: number;
}

// ---------- 任务图 ----------

export interface TaskGraphNode {
  id: string;
  label: string;
  type: 'tool' | 'summary' | 'milestone';
}

export interface TaskGraphEdge {
  from: string;
  to: string;
  label?: string;
}

export interface TaskGraph {
  nodes: TaskGraphNode[];
  edges: TaskGraphEdge[];
  /** Mermaid 格式 */
  mermaid: string;
}

// ---------- Offload 状态 ----------

export interface OffloadState {
  /** 会话 ID */
  sessionId: string;
  /** 是否已激活 offload */
  active: boolean;
  /** 所有节点 */
  nodes: ToolCallNode[];
  /** 摘要列表 */
  summaries: OffloadSummary[];
  /** 任务图 */
  graph: TaskGraph | null;
  /** 总工具调用次数 */
  totalToolCalls: number;
  /** 最后更新时间 */
  lastUpdatedAt: number;
}

// ---------- 注入结果 ----------

export interface OffloadInjection {
  /** 是否使用了 offload */
  offloaded: boolean;
  /** 注入的文本（包含最近的完整日志 + 摘要 + 图链接） */
  text: string;
  /** offload 节省的字符数 */
  savedChars: number;
  /** 节点总数 */
  totalNodes: number;
  /** 保留在上下文的节点数 */
  keptNodes: number;
}
