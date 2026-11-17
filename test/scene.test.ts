/**
 * 忆织 MemWeave —— 场景块功能测试
 */

import { strict as assert } from "node:assert";
import { describe, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SceneManager, DEFAULT_SCENE_CONFIG, type SceneAggregationConfig } from "../src/scene";
import type { MemoryEntry } from "../src/core/types";

describe("L2 场景块", () => {
  let tempDir: string;
  let manager: SceneManager;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "memweave-scene-test-"));
    const config: SceneAggregationConfig = {
      ...DEFAULT_SCENE_CONFIG,
      enabled: true,
      minEntries: 2, // 降低阈值方便测试
    };
    manager = new SceneManager(tempDir, config);
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("配置关闭时不聚合任何场景", () => {
    const disabledConfig: SceneAggregationConfig = {
      ...DEFAULT_SCENE_CONFIG,
      enabled: false,
    };
    const disabledManager = new SceneManager(tempDir, disabledConfig);

    const entries = createTestEntries(5);
    const result = disabledManager.aggregateScenes(entries);

    assert.equal(result.created, 0);
    assert.equal(result.updated, 0);
    assert.equal(result.sceneIds.length, 0);
  });

  it("从 entries 聚合生成场景块", () => {
    const entries = createTestEntries(10, "project-A");
    const result = manager.aggregateScenes(entries);

    assert.ok(result.created > 0);
    assert.ok(result.sceneIds.length > 0);

    const stats = manager.getStatistics();
    assert.equal(stats.total, result.created);
    assert.equal(stats.active, result.created);
  });

  it("同一项目的 entries 聚合到同一场景", () => {
    const entries = [
      ...createTestEntries(5, "project-A", "topic-1"),
      ...createTestEntries(5, "project-B", "topic-2"),
    ];

    const result = manager.aggregateScenes(entries);

    // 应该至少创建 2 个场景（每个项目一个）
    assert.ok(result.created >= 2);

    const scenes = manager.getActiveScenes();
    const projectA = scenes.filter((s) => s.project === "project-A");
    const projectB = scenes.filter((s) => s.project === "project-B");

    assert.ok(projectA.length > 0);
    assert.ok(projectB.length > 0);
  });

  it("召回相关场景", () => {
    const entries = [
      ...createTestEntries(5, "memweave", "开发"),
      ...createTestEntries(5, "cooking", "烹饪"),
    ];

    manager.aggregateScenes(entries);

    const hits = manager.recallScenes("memweave");
    assert.ok(hits.length > 0);

    // 第一个结果应该是 memweave 相关
    assert.ok(
      hits[0].scene.project === "memweave" ||
      hits[0].scene.keywords.some((k) => k.includes("memweave"))
    );
  });

  it("场景包含正确的 entryIds", () => {
    const entries = createTestEntries(5, "test-project");
    const result = manager.aggregateScenes(entries);

    assert.ok(result.sceneIds.length > 0);

    const scene = manager.getScene(result.sceneIds[0]);
    assert.ok(scene);
    assert.ok(scene.entryIds.length > 0);

    // 检查 entryIds 是否来自输入 entries
    const inputIds = entries.map((e) => e.id);
    for (const id of scene.entryIds) {
      assert.ok(inputIds.includes(id));
    }
  });

  it("场景有正确的元数据", () => {
    const entries = createTestEntries(5, "test-project");
    const result = manager.aggregateScenes(entries);

    const scene = manager.getScene(result.sceneIds[0]);
    assert.ok(scene);

    assert.ok(scene.id.startsWith("scene-"));
    assert.ok(scene.title.length > 0);
    assert.equal(scene.project, "test-project");
    assert.ok(scene.type);
    assert.equal(scene.status, "active");
    assert.ok(scene.confidence >= 0 && scene.confidence <= 1);
    assert.ok(scene.createdAt > 0);
    assert.ok(scene.updatedAt > 0);
  });

  it("更新现有场景不创建重复", () => {
    const entries1 = createTestEntries(3, "project-A");
    const result1 = manager.aggregateScenes(entries1);

    assert.equal(result1.created, 1);

    // 添加更多相同项目的 entries
    const entries2 = [
      ...entries1,
      ...createTestEntries(2, "project-A"),
    ];
    const result2 = manager.aggregateScenes(entries2);

    // 应该更新现有场景而不是创建新的
    assert.equal(result2.created, 0);
    assert.equal(result2.updated, 1);

    const stats = manager.getStatistics();
    assert.equal(stats.total, 1); // 总数仍然是 1
  });

  it("归档场景", () => {
    const entries = createTestEntries(5, "project-A");
    const result = manager.aggregateScenes(entries);

    const sceneId = result.sceneIds[0];
    const success = manager.archiveScene(sceneId);

    assert.equal(success, true);

    const scene = manager.getScene(sceneId);
    assert.ok(scene);
    assert.equal(scene.status, "archived");

    const activeScenes = manager.getActiveScenes();
    assert.equal(activeScenes.length, 0);
  });

  it("删除场景", () => {
    const entries = createTestEntries(5, "project-A");
    const result = manager.aggregateScenes(entries);

    const sceneId = result.sceneIds[0];
    const success = manager.deleteScene(sceneId);

    assert.equal(success, true);

    const scene = manager.getScene(sceneId);
    assert.equal(scene, null);
  });

  it("场景统计正确", () => {
    const entries = [
      ...createTestEntries(5, "project-A"),
      ...createTestEntries(5, "project-B"),
    ];

    manager.aggregateScenes(entries);

    const stats = manager.getStatistics();
    assert.ok(stats.total > 0);
    assert.ok(stats.active > 0);
    assert.equal(stats.inactive, 0);
    assert.equal(stats.archived, 0);

    // 归档一个场景
    const scenes = manager.getActiveScenes();
    if (scenes.length > 0) {
      manager.archiveScene(scenes[0].id);

      const newStats = manager.getStatistics();
      assert.equal(newStats.archived, 1);
      assert.equal(newStats.active, stats.active - 1);
    }
  });

  it("记录场景访问", () => {
    const entries = createTestEntries(5, "project-A");
    const result = manager.aggregateScenes(entries);

    const sceneId = result.sceneIds[0];
    const scene1 = manager.getScene(sceneId);
    assert.ok(scene1);
    assert.equal(scene1.accessCount, 0);

    manager.recordAccess(sceneId);

    const scene2 = manager.getScene(sceneId);
    assert.ok(scene2);
    assert.equal(scene2.accessCount, 1);
    assert.ok(scene2.lastAccessedAt >= scene1.lastAccessedAt);
  });
});

// ---------- 辅助函数 ----------

function createTestEntries(
  count: number,
  project: string = "test-project",
  topic: string = "test-topic"
): MemoryEntry[] {
  const entries: MemoryEntry[] = [];

  for (let i = 0; i < count; i++) {
    entries.push({
      id: `entry-${project}-${i}`,
      level: "project",
      project,
      section: null,
      content: `Test entry ${i} for ${project}`,
      keywords: [topic, `keyword-${i}`],
      importance: 0.5 + Math.random() * 0.5,
      status: "active",
      semanticKey: null,
      confidence: null,
      validFrom: null,
      validTo: null,
      evidence: [],
      hash: null,
      source: "test",
      accessCount: Math.floor(Math.random() * 10),
      tier: "hot",
      createdAt: Date.now() - i * 1000,
      updatedAt: Date.now() - i * 1000,
    });
  }

  return entries;
}
