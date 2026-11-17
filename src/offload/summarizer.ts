/**
 * 忆织 MemWeave —— Offload 摘要生成器
 * 将过长的工具调用输出压缩为摘要。
 */

import type { ToolCallNode } from "./types";

export class OffloadSummarizer {
  /**
   * 摘要单个 node（超长内容）
   * 简单版：截断 + 统计信息
   * 未来可接入 LLM 生成摘要
   */
  summarizeNode(node: ToolCallNode, maxChars: number): ToolCallNode {
    const outputLen = node.output.length;
    if (outputLen <= maxChars) {
      return node;
    }

    // 截断输出，保留头尾
    const headLen = Math.floor(maxChars * 0.6);
    const tailLen = Math.floor(maxChars * 0.3);
    const head = node.output.slice(0, headLen);
    const tail = node.output.slice(-tailLen);

    const summarized = [
      `*(已摘要，原始输出 ${outputLen} 字符)*`,
      ``,
      head,
      ``,
      `... (省略 ${outputLen - headLen - tailLen} 字符) ...`,
      ``,
      tail,
    ].join("\n");

    return {
      ...node,
      output: summarized,
      summarized: true,
    };
  }

  /**
   * 生成一组 nodes 的中间摘要
   * 简单版：工具名称 + 成功/失败统计
   */
  summarizeRange(nodes: ToolCallNode[]): string {
    if (nodes.length === 0) return "";

    const toolCounts: Record<string, { total: number; success: number; failed: number }> = {};

    for (const node of nodes) {
      if (!toolCounts[node.toolName]) {
        toolCounts[node.toolName] = { total: 0, success: 0, failed: 0 };
      }
      toolCounts[node.toolName].total++;
      if (node.success) {
        toolCounts[node.toolName].success++;
      } else {
        toolCounts[node.toolName].failed++;
      }
    }

    const lines = [
      `## 工具调用摘要 (${nodes[0].nodeId} → ${nodes[nodes.length - 1].nodeId})`,
      ``,
      `- **范围**: ${nodes.length} 次调用`,
      `- **时间**: ${new Date(nodes[0].timestamp).toISOString()} → ${new Date(nodes[nodes.length - 1].timestamp).toISOString()}`,
      ``,
      `### 工具统计`,
      ``,
    ];

    for (const [toolName, counts] of Object.entries(toolCounts)) {
      lines.push(
        `- **${toolName}**: ${counts.total} 次 (✅ ${counts.success}, ❌ ${counts.failed})`
      );
    }

    lines.push(``);
    lines.push(`*详细日志见 refs/ 目录*`);

    return lines.join("\n");
  }

  /**
   * 生成任务进展摘要（用于注入上下文）
   */
  summarizeForContext(nodes: ToolCallNode[], keepRecentCount: number): string {
    if (nodes.length === 0) return "";

    const recentNodes = nodes.slice(-keepRecentCount);
    const olderNodes = nodes.slice(0, -keepRecentCount);

    const lines = [`## 工具调用历史`, ``];

    // 旧的调用：只显示摘要统计
    if (olderNodes.length > 0) {
      const summary = this.summarizeRange(olderNodes);
      lines.push(summary);
      lines.push(``);
    }

    // 最近的调用：显示完整信息
    if (recentNodes.length > 0) {
      lines.push(`### 最近 ${recentNodes.length} 次调用`, ``);
      for (const node of recentNodes) {
        const status = node.success ? "✅" : "❌";
        lines.push(
          `- [${node.nodeId}] ${status} **${node.toolName}** (step ${node.step})`
        );
        if (node.error) {
          lines.push(`  - Error: ${node.error}`);
        }
      }
      lines.push(``);
      lines.push(`*完整日志见 offload/refs/${recentNodes[0].sessionId}/*`);
    }

    return lines.join("\n");
  }
}
