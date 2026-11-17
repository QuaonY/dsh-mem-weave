/**
 * 忆织 MemWeave —— 场景块管理器
 * 核心接口：聚合场景、召回场景、管理生命周期。
 */

import type { MemoryEntry } from "../core/types";
import type {
  SceneBlock,
  SceneAggregationConfig,
  SceneAggregationResult,
  SceneHit,
} from "./types";
import { SceneStorage } from "./storage";
import { SceneAggregator } from "./aggregator";

export class SceneManager {
  private config: SceneAggregationConfig;
  private storage: SceneStorage;
  private aggregator: SceneAggregator;

  constructor(dataDir: string, config: SceneAggregationConfig) {
    this.config = config;
    this.storage = new SceneStorage(dataDir);
    this.aggregator = new SceneAggregator(config);
  }

  /**
   * 从 entries 聚合生成场景块
   */
  aggregateScenes(entries: MemoryEntry[]): SceneAggregationResult {
    if (!this.config.enabled) {
      return { created: 0, updated: 0, archived: 0, sceneIds: [] };
    }

    // 只处理 active entries
    const activeEntries = entries.filter((e) => e.status === "active");

    // 识别候选
    const candidates = this.aggregator.identifyCandidates(activeEntries);

    // 现有场景
    const existingScenes = this.storage.readAllScenes();

    let created = 0;
    let updated = 0;
    const sceneIds: string[] = [];

    // 为每个候选生成或更新场景
    for (const candidate of candidates) {
      const scene = this.aggregator.generateScene(candidate, existingScenes);

      const isNew = !existingScenes.some((s) => s.id === scene.id);
      if (isNew) {
        created++;
      } else {
        updated++;
      }

      this.storage.writeScene(scene);
      sceneIds.push(scene.id);
    }

    // 归档闲置场景
    const archived = this.archiveInactiveScenes();

    return { created, updated, archived, sceneIds };
  }

  /**
   * 召回相关场景
   */
  recallScenes(query: string, limit: number = 5): SceneHit[] {
    if (!this.config.enabled) {
      return [];
    }

    const scenes = this.storage.readAllScenes().filter((s) => s.status === "active");
    const hits: SceneHit[] = [];

    const queryTokens = query.toLowerCase().split(/\\s+/);

    for (const scene of scenes) {
      const score = this.calculateMatchScore(scene, queryTokens);
      if (score > 0) {
        const matchedKeywords = scene.keywords.filter((k) =>
          queryTokens.some((t) => k.toLowerCase().includes(t))
        );

        hits.push({
          scene,
          score,
          matchedKeywords,
        });
      }
    }

    // 排序并限制数量
    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /**
   * 获取场景块
   */
  getScene(sceneId: string): SceneBlock | null {
    return this.storage.readScene(sceneId);
  }

  /**
   * 获取所有活跃场景
   */
  getActiveScenes(): SceneBlock[] {
    return this.storage.readAllScenes().filter((s) => s.status === "active");
  }

  /**
   * 更新场景访问记录
   */
  recordAccess(sceneId: string): void {
    const scene = this.storage.readScene(sceneId);
    if (!scene) return;

    scene.lastAccessedAt = Date.now();
    scene.accessCount++;
    this.storage.writeScene(scene);
  }

  /**
   * 归档场景
   */
  archiveScene(sceneId: string): boolean {
    const scene = this.storage.readScene(sceneId);
    if (!scene) return false;

    scene.status = "archived";
    scene.updatedAt = Date.now();
    this.storage.writeScene(scene);
    return true;
  }

  /**
   * 删除场景
   */
  deleteScene(sceneId: string): boolean {
    return this.storage.deleteScene(sceneId);
  }

  /**
   * 获取场景统计
   */
  getStatistics(): {
    total: number;
    active: number;
    inactive: number;
    archived: number;
  } {
    const scenes = this.storage.readAllScenes();
    return {
      total: scenes.length,
      active: scenes.filter((s) => s.status === "active").length,
      inactive: scenes.filter((s) => s.status === "inactive").length,
      archived: scenes.filter((s) => s.status === "archived").length,
    };
  }

  // ---------- 私有方法 ----------

  /**
   * 计算匹配分数
   */
  private calculateMatchScore(scene: SceneBlock, queryTokens: string[]): number {
    let score = 0;

    // 标题匹配
    const titleLower = scene.title.toLowerCase();
    for (const token of queryTokens) {
      if (token.length > 0 && titleLower.includes(token)) {
        score += 0.5;
      }
    }

    // 关键词匹配
    for (const keyword of scene.keywords) {
      const keywordLower = keyword.toLowerCase();
      for (const token of queryTokens) {
        if (token.length > 0 && keywordLower.includes(token)) {
          score += 0.3;
        }
      }
    }

    // 摘要匹配
    const summaryLower = scene.summary.toLowerCase();
    for (const token of queryTokens) {
      if (token.length > 0 && summaryLower.includes(token)) {
        score += 0.2;
      }
    }

    // 项目名匹配
    if (scene.project) {
      const projectLower = scene.project.toLowerCase();
      for (const token of queryTokens) {
        if (token.length > 0 && projectLower.includes(token)) {
          score += 0.4;
        }
      }
    }

    // 访问频率加成
    const accessBonus = Math.min(scene.accessCount / 10, 0.5);
    score += accessBonus;

    return Math.min(score, 1.0);
  }

  /**
   * 归档闲置场景
   */
  private archiveInactiveScenes(): number {
    const now = Date.now();
    const scenes = this.storage.readAllScenes();
    let archived = 0;

    for (const scene of scenes) {
      if (scene.status === "archived") continue;

      const daysSinceAccess = (now - scene.lastAccessedAt) / (1000 * 60 * 60 * 24);

      // 标记为 inactive
      if (daysSinceAccess > this.config.inactiveDays && scene.status === "active") {
        scene.status = "inactive";
        scene.updatedAt = now;
        this.storage.writeScene(scene);
      }

      // 归档
      if (daysSinceAccess > this.config.archiveDays && scene.status === "inactive") {
        scene.status = "archived";
        scene.updatedAt = now;
        this.storage.writeScene(scene);
        archived++;
      }
    }

    return archived;
  }
}
