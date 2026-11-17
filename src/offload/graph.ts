/**
 * 忆织 MemWeave —— Offload 任务图生成器
 * 生成 Mermaid 任务流程图。
 */

import type { TaskGraph, TaskGraphEdge, TaskGraphNode, ToolCallNode, OffloadSummary } from "./types";

export class OffloadGraphBuilder {
  /**
   * 从 nodes 和 summaries 构建任务图
   */
  buildGraph(nodes: ToolCallNode[], summaries: OffloadSummary[]): TaskGraph {
    const graphNodes: TaskGraphNode[] = [];
    const graphEdges: TaskGraphEdge[] = [];

    // 添加工具节点（只保留关键节点，避免图过大）
    const step = Math.max(1, Math.floor(nodes.length / 20)); // 最多 20 个节点
    for (let i = 0; i < nodes.length; i += step) {
      const node = nodes[i];
      graphNodes.push({
        id: node.nodeId,
        label: `${node.toolName}\\n(${node.nodeId})`,
        type: "tool",
      });

      // 连接到下一个节点
      if (i + step < nodes.length) {
        graphEdges.push({
          from: node.nodeId,
          to: nodes[i + step].nodeId,
        });
      }
    }

    // 添加摘要节点
    for (const summary of summaries) {
      graphNodes.push({
        id: summary.summaryId,
        label: `Summary\\n(${summary.toolCount} calls)`,
        type: "summary",
      });

      // 连接到第一个 node
      const firstNodeId = summary.nodeRange[0];
      if (graphNodes.some((n) => n.id === firstNodeId)) {
        graphEdges.push({
          from: summary.summaryId,
          to: firstNodeId,
          label: "covers",
        });
      }
    }

    const mermaid = this.generateMermaid(graphNodes, graphEdges);

    return {
      nodes: graphNodes,
      edges: graphEdges,
      mermaid,
    };
  }

  /**
   * 生成 Mermaid 语法
   */
  private generateMermaid(nodes: TaskGraphNode[], edges: TaskGraphEdge[]): string {
    const lines = ["graph TD"];

    // 节点定义
    for (const node of nodes) {
      let shape = "";
      if (node.type === "tool") {
        shape = `[${node.label}]`;
      } else if (node.type === "summary") {
        shape = `{${node.label}}`;
      } else {
        shape = `((${node.label}))`;
      }
      lines.push(`  ${node.id}${shape}`);
    }

    // 边定义
    for (const edge of edges) {
      if (edge.label) {
        lines.push(`  ${edge.from} -->|${edge.label}| ${edge.to}`);
      } else {
        lines.push(`  ${edge.from} --> ${edge.to}`);
      }
    }

    return lines.join("\n");
  }

  /**
   * 生成简化版的文本图（ASCII）
   */
  generateTextGraph(nodes: ToolCallNode[]): string {
    const lines = ["任务流程:", ""];

    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const prefix = i === nodes.length - 1 ? "└─" : "├─";
      const status = node.success ? "✅" : "❌";
      lines.push(`${prefix} [${node.nodeId}] ${status} ${node.toolName}`);
    }

    return lines.join("\n");
  }
}
