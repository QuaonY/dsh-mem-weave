/**
 * 忆织 MemWeave —— Offload 存储层
 * 将 offload 数据写入 <dataDir>/offload/<sessionId>
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OffloadState, TaskGraph, ToolCallNode } from "./types";

export class OffloadStorage {
  private dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  private offloadDir(): string {
    return join(this.dataDir, "offload");
  }

  private sessionDir(sessionId: string): string {
    return join(this.offloadDir(), sessionId);
  }

  private refsDir(sessionId: string): string {
    return join(this.sessionDir(sessionId), "refs");
  }

  /** 确保目录存在 */
  private ensureDir(dir: string): void {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  /** 写入单个 node 到文件 */
  writeNode(sessionId: string, node: ToolCallNode): void {
    const dir = this.refsDir(sessionId);
    this.ensureDir(dir);

    const filename = `${node.nodeId}.md`;
    const file = join(dir, filename);

    const content = [
      `# ${node.toolName}`,
      ``,
      `- **Node ID**: ${node.nodeId}`,
      `- **Session**: ${node.sessionId}`,
      `- **Step**: ${node.step}`,
      `- **Timestamp**: ${new Date(node.timestamp).toISOString()}`,
      `- **Success**: ${node.success ? "✅" : "❌"}`,
      node.error ? `- **Error**: ${node.error}` : "",
      ``,
      `## Input`,
      ``,
      "```json",
      node.input,
      "```",
      ``,
      `## Output`,
      ``,
      node.summarized ? `*(摘要)*\n\n${node.output}` : "```\n" + node.output + "\n```",
    ]
      .filter(Boolean)
      .join("\n");

    writeFileSync(file, content, "utf8");
  }

  /** 写入摘要 */
  writeSummary(sessionId: string, summaryId: string, text: string): void {
    const dir = this.sessionDir(sessionId);
    this.ensureDir(dir);

    const file = join(dir, `${summaryId}.md`);
    writeFileSync(file, text, "utf8");
  }

  /** 写入任务图 */
  writeGraph(sessionId: string, graph: TaskGraph): void {
    const dir = this.sessionDir(sessionId);
    this.ensureDir(dir);

    const file = join(dir, "task-graph.md");
    const content = [
      `# Task Graph`,
      ``,
      `生成时间: ${new Date().toISOString()}`,
      ``,
      "```mermaid",
      graph.mermaid,
      "```",
    ].join("\n");

    writeFileSync(file, content, "utf8");
  }

  /** 写入 offload 状态快照（调试用） */
  writeState(sessionId: string, state: OffloadState): void {
    const dir = this.sessionDir(sessionId);
    this.ensureDir(dir);

    const file = join(dir, "state.json");
    writeFileSync(file, JSON.stringify(state, null, 2), "utf8");
  }

  /** 读取 offload 状态 */
  readState(sessionId: string): OffloadState | null {
    const file = join(this.sessionDir(sessionId), "state.json");
    if (!existsSync(file)) return null;

    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
      return raw as OffloadState;
    } catch {
      return null;
    }
  }

  /** 检查 session 是否有 offload 数据 */
  hasOffloadData(sessionId: string): boolean {
    return existsSync(this.sessionDir(sessionId));
  }
}
