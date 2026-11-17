/**
 * 忆织 MemWeave —— Offload 管理器
 * 核心接口：记录工具调用、生成摘要、注入上下文。
 */

import type {
  OffloadConfig,
  OffloadInjection,
  OffloadState,
  OffloadSummary,
  ToolCallNode,
} from "./types";
import { OffloadStorage } from "./storage";
import { OffloadSummarizer } from "./summarizer";
import { OffloadGraphBuilder } from "./graph";

export class OffloadManager {
  private config: OffloadConfig;
  private storage: OffloadStorage;
  private summarizer: OffloadSummarizer;
  private graphBuilder: OffloadGraphBuilder;

  /** 会话状态缓存 (sessionId -> state) */
  private states: Map<string, OffloadState> = new Map();

  constructor(dataDir: string, config: OffloadConfig) {
    this.config = config;
    this.storage = new OffloadStorage(dataDir);
    this.summarizer = new OffloadSummarizer();
    this.graphBuilder = new OffloadGraphBuilder();
  }

  /**
   * 记录一次工具调用
   */
  recordToolCall(params: {
    sessionId: string;
    step: number;
    toolName: string;
    input: string;
    output: string;
    success: boolean;
    error?: string;
  }): void {
    // 配置关闭时不做任何事
    if (!this.config.enabled) {
      return;
    }

    const { sessionId, step, toolName, input, output, success, error } = params;

    let state = this.states.get(sessionId);
    if (!state) {
      // 尝试从磁盘恢复
      state = this.storage.readState(sessionId) || this.createEmptyState(sessionId);
      this.states.set(sessionId, state);
    }

    // 创建 node
    const nodeId = `node-${String(state.nodes.length + 1).padStart(3, "0")}`;
    const node: ToolCallNode = {
      nodeId,
      sessionId,
      step,
      toolName,
      input: this.truncateInput(input),
      output,
      summarized: false,
      timestamp: Date.now(),
      success,
      error,
    };

    // 摘要超长 node
    const summarizedNode = this.summarizer.summarizeNode(node, this.config.maxCharsPerNode);

    // 添加到状态
    state.nodes.push(summarizedNode);
    state.totalToolCalls++;
    state.lastUpdatedAt = Date.now();

    // 达到阈值时激活 offload
    if (!state.active && state.totalToolCalls >= this.config.threshold) {
      state.active = true;
    }

    // 写入磁盘
    try {
      this.storage.writeNode(sessionId, summarizedNode);

      // 定期生成摘要
      if (state.totalToolCalls % this.config.summaryInterval === 0) {
        this.generateSummary(state);
      }

      // 更新任务图
      if (this.config.graphEnabled) {
        this.updateGraph(state);
      }

      // 保存状态
      this.storage.writeState(sessionId, state);
    } catch (err) {
      if (this.config.fallbackOnError) {
        // 静默失败，不影响主流程
        console.warn("[Offload] Write failed, fallback to no-offload:", err);
        state.active = false;
      } else {
        throw err;
      }
    }
  }

  /**
   * 为当前会话生成注入内容
   */
  generateInjection(sessionId: string): OffloadInjection {
    const state = this.states.get(sessionId);

    // 未激活或无数据
    if (!state || !state.active || state.nodes.length === 0) {
      return {
        offloaded: false,
        text: "",
        savedChars: 0,
        totalNodes: 0,
        keptNodes: 0,
      };
    }

    // 生成上下文摘要
    const text = this.summarizer.summarizeForContext(state.nodes, this.config.keepRecentCount);

    // 计算节省的字符数：被 offload 的旧节点的完整字符数
    const offloadedCount = Math.max(0, state.nodes.length - this.config.keepRecentCount);
    const offloadedNodes = state.nodes.slice(0, offloadedCount);
    const offloadedChars = offloadedNodes.reduce((sum, n) => sum + n.input.length + n.output.length, 0);
    
    // 摘要部分的字符数（从生成的文本中提取摘要部分长度，粗略估算为一半）
    const summaryChars = offloadedCount > 0 ? Math.floor(text.length * 0.3) : 0;
    const savedChars = Math.max(0, offloadedChars - summaryChars);

    return {
      offloaded: true,
      text,
      savedChars,
      totalNodes: state.nodes.length,
      keptNodes: Math.min(this.config.keepRecentCount, state.nodes.length),
    };
  }

  /**
   * 获取 token 节省指标
   */
  getMetrics(sessionId: string): {
    enabled: boolean;
    active: boolean;
    totalCalls: number;
    savedChars: number;
    savedTokensEstimate: number;
  } {
    const state = this.states.get(sessionId);
    if (!state || !state.active) {
      return {
        enabled: this.config.enabled,
        active: false,
        totalCalls: 0,
        savedChars: 0,
        savedTokensEstimate: 0,
      };
    }

    const injection = this.generateInjection(sessionId);
    const savedTokens = Math.floor(injection.savedChars / 4); // 粗略估算 4 chars = 1 token

    return {
      enabled: this.config.enabled,
      active: true,
      totalCalls: state.totalToolCalls,
      savedChars: injection.savedChars,
      savedTokensEstimate: savedTokens,
    };
  }

  /**
   * 清除会话 offload 数据
   */
  clearSession(sessionId: string): void {
    this.states.delete(sessionId);
  }

  // ---------- 私有方法 ----------

  private createEmptyState(sessionId: string): OffloadState {
    return {
      sessionId,
      active: false,
      nodes: [],
      summaries: [],
      graph: null,
      totalToolCalls: 0,
      lastUpdatedAt: Date.now(),
    };
  }

  private truncateInput(input: string): string {
    const maxLen = 500; // 输入只保留 500 字符
    if (input.length <= maxLen) return input;
    return input.slice(0, maxLen) + "...(truncated)";
  }

  private generateSummary(state: OffloadState): void {
    const interval = this.config.summaryInterval;
    const startIdx = Math.max(0, state.nodes.length - interval);
    const endIdx = state.nodes.length;
    const nodes = state.nodes.slice(startIdx, endIdx);

    if (nodes.length === 0) return;

    const summaryId = `summary-${String(state.summaries.length + 1).padStart(3, "0")}`;
    const text = this.summarizer.summarizeRange(nodes);

    const summary: OffloadSummary = {
      summaryId,
      nodeRange: [nodes[0].nodeId, nodes[nodes.length - 1].nodeId],
      text,
      toolCount: nodes.length,
      createdAt: Date.now(),
    };

    state.summaries.push(summary);
    this.storage.writeSummary(state.sessionId, summaryId, text);
  }

  private updateGraph(state: OffloadState): void {
    const graph = this.graphBuilder.buildGraph(state.nodes, state.summaries);
    state.graph = graph;
    this.storage.writeGraph(state.sessionId, graph);
  }
}
