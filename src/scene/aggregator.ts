/**
 * 忆织 MemWeave —— 场景块聚合器
 * 从记忆条目中聚合生成场景块。
 */

import type { MemoryEntry } from "../core/types";
import type { SceneBlock, SceneCandidate, SceneType, SceneAggregationConfig } from "./types";

export class SceneAggregator {
  private config: SceneAggregationConfig;

  constructor(config: SceneAggregationConfig) {
    this.config = config;
  }

  /**
   * 从 entries 中识别场景候选
   */
  identifyCandidates(entries: MemoryEntry[]): SceneCandidate[] {
    // 按 project 和 keywords 分组
    const groups = new Map<string, MemoryEntry[]>();

    for (const entry of entries) {
      const key = this.getGroupKey(entry);
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key)!.push(entry);
    }

    // 过滤并转换为候选
    const candidates: SceneCandidate[] = [];

    for (const [key, groupEntries] of groups) {
      if (groupEntries.length < this.config.minEntries) {
        continue; // 太少，不形成场景
      }

      const parts = key.split("::");
      const project = parts[0] === "null" ? null : parts[0];
      const level = parts[1] || null;
      
      const candidate = this.createCandidate(
        project,
        level, // 使用 level 作为 topic
        groupEntries
      );

      candidates.push(candidate);
    }

    // 按分数排序
    return candidates.sort((a, b) => b.score - a.score);
  }

  /**
   * 从候选生成场景块
   */
  generateScene(candidate: SceneCandidate, existingScenes: SceneBlock[]): SceneBlock {
    // 检查是否已有相似场景
    const existing = this.findSimilarScene(candidate, existingScenes);
    if (existing) {
      return this.updateScene(existing, candidate);
    }

    // 创建新场景 - 使用时间戳确保唯一性
    const sceneId = `scene-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
    const summary = this.generateSummary(candidate);
    const keywords = this.extractKeywords(candidate);

    return {
      id: sceneId,
      title: this.generateTitle(candidate),
      project: candidate.project,
      type: candidate.suggestedType,
      entryIds: candidate.entryIds,
      summary,
      keywords,
      status: "active",
      confidence: this.calculateConfidence(candidate),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastAccessedAt: Date.now(),
      accessCount: 0,
    };
  }

  /**
   * 生成场景摘要
   */
  private generateSummary(candidate: SceneCandidate): string {
    // 简单版：提取项目和主题信息
    const parts: string[] = [];

    if (candidate.project) {
      parts.push(`项目: ${candidate.project}`);
    }

    if (candidate.topic) {
      parts.push(`主题: ${candidate.topic}`);
    }

    parts.push(`包含 ${candidate.entryIds.length} 条相关记忆`);

    const summary = parts.join(", ");

    // 限制长度
    return summary.length > this.config.maxSummaryChars
      ? summary.slice(0, this.config.maxSummaryChars) + "..."
      : summary;
  }

  /**
   * 生成场景标题
   */
  private generateTitle(candidate: SceneCandidate): string {
    if (candidate.project && candidate.topic) {
      return `${candidate.project} - ${candidate.topic}`;
    }
    if (candidate.project) {
      return candidate.project;
    }
    if (candidate.topic) {
      return candidate.topic;
    }
    return `场景 (${candidate.entryIds.length} 条记忆)`;
  }

  /**
   * 提取关键词
   */
  private extractKeywords(candidate: SceneCandidate): string[] {
    const keywords = new Set<string>();

    if (candidate.project) {
      keywords.add(candidate.project);
    }

    if (candidate.topic) {
      keywords.add(candidate.topic);
    }

    // 限制关键词数量
    return Array.from(keywords).slice(0, 10);
  }

  /**
   * 计算置信度
   */
  private calculateConfidence(candidate: SceneCandidate): number {
    // 基于 entries 数量和分数
    const countFactor = Math.min(candidate.entryIds.length / 10, 1.0);
    const scoreFactor = candidate.score;
    return Math.min(countFactor * 0.5 + scoreFactor * 0.5, 1.0);
  }

  /**
   * 分组键
   */
  private getGroupKey(entry: MemoryEntry): string {
    const project = entry.project || "null";
    // 使用 level 和 project 作为分组键，忽略 topic
    return `${project}::${entry.level}`;
  }

  /**
   * 创建候选
   */
  private createCandidate(
    project: string | null,
    topic: string | null,
    entries: MemoryEntry[]
  ): SceneCandidate {
    const entryIds = entries.map((e) => e.id);
    const suggestedType = this.suggestType(project, topic, entries);
    const score = this.calculateScore(entries);

    return {
      project,
      topic: topic || (entries[0]?.keywords[0] || null), // 使用第一个 entry 的第一个 keyword
      entryIds,
      suggestedType,
      score,
    };
  }

  /**
   * 推荐场景类型
   */
  private suggestType(project: string | null, topic: string | null, entries: MemoryEntry[]): SceneType {
    // 简单规则：根据 level 分布
    const levels = entries.map((e) => e.level);
    const projectCount = levels.filter((l) => l === "project").length;
    const lessonCount = levels.filter((l) => l === "lesson").length;

    if (projectCount > entries.length * 0.5) return "project";
    if (lessonCount > entries.length * 0.3) return "learning";

    // 默认
    return project ? "project" : "other";
  }

  /**
   * 计算分数
   */
  private calculateScore(entries: MemoryEntry[]): number {
    // 基于重要性和访问次数
    const avgImportance = entries.reduce((sum, e) => sum + e.importance, 0) / entries.length;
    const avgAccessCount = entries.reduce((sum, e) => sum + e.accessCount, 0) / entries.length;

    return Math.min(avgImportance * 0.7 + Math.min(avgAccessCount / 10, 1.0) * 0.3, 1.0);
  }

  /**
   * 查找相似场景
   */
  private findSimilarScene(candidate: SceneCandidate, scenes: SceneBlock[]): SceneBlock | null {
    for (const scene of scenes) {
      if (scene.project === candidate.project && scene.status !== "archived") {
        // 检查 entryIds 重叠
        const overlap = candidate.entryIds.filter((id) => scene.entryIds.includes(id));
        if (overlap.length > candidate.entryIds.length * 0.5) {
          return scene;
        }
      }
    }
    return null;
  }

  /**
   * 更新场景
   */
  private updateScene(scene: SceneBlock, candidate: SceneCandidate): SceneBlock {
    // 合并 entryIds
    const entryIds = Array.from(new Set([...scene.entryIds, ...candidate.entryIds]));

    // 限制数量
    const limitedIds = entryIds.slice(0, this.config.maxEntries);

    return {
      ...scene,
      entryIds: limitedIds,
      updatedAt: Date.now(),
      lastAccessedAt: Date.now(),
    };
  }
}
