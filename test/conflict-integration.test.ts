/**
 * 冲突检测集成测试
 * 测试完整的冲突检测、解决、合并流程
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WeaveService, defaultConfig } from "../src/host/service";
import { openWeaveDb } from "../src/store/db";
import { ensureSchema } from "../src/store/migrate";
import type { MemoryEntry } from "../src/core/types";
import type { ConflictStatus } from "../src/conflict/types";

describe("Conflict Integration", () => {
  let service: WeaveService;
  let tmpDir: string;
  let env: any;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "conflict-test-"));
    env = openWeaveDb(tmpDir, { readonly: false });
    ensureSchema(env);
    const config = defaultConfig(tmpDir);
    service = new WeaveService(env, config);
  });

  afterEach(() => {
    env.db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("Conflict Detection", () => {
    it("应该检测数据库中的事实冲突", async () => {
  // Note: 使用不同 level 写入，避免被同层合并
      const mem1 = await service.remember({
        content: "系统启用了备份",
        level: "fact",
      }, "human");

      const mem2 = await service.remember({
        content: "系统不启用备份",
        level: "lesson",  // 不同层级避免同层合并
      }, "human");

      // 检测冲突
      const result = await service.detectConflicts();

      expect(result.conflicts.length).toBeGreaterThan(0);
      expect(result.conflicts[0].conflict_type).toBe("fact");
      expect(result.conflicts[0].status).toBe("pending");
      expect([result.conflicts[0].memory_id_a, result.conflicts[0].memory_id_b]).toContain(mem1.id);
      expect([result.conflicts[0].memory_id_a, result.conflicts[0].memory_id_b]).toContain(mem2.id);
    });

    it("应该检测时间冲突", async () => {
      const oldTime = Date.now() - 10 * 24 * 60 * 60 * 1000; // 10 days ago
      const newTime = Date.now();

      const mem1 = await service.remember({
        content: "项目启动会议在上午",
        level: "fact",
      }, "human");

      const mem2 = await service.remember({
        content: "项目启动会议在下午",
        level: "lesson",
      }, "human");

      const result = await service.detectConflicts();

      const timeConflicts = result.conflicts.filter((c) => c.conflict_type === "time");
      expect(timeConflicts.length).toBeGreaterThan(0);
    });

    it("应该检测观点冲突（情绪价反转）", async () => {
      const mem1 = await service.remember({
        content: "这个界面设计很好",
        level: "fact",
      }, "human");

      const mem2 = await service.remember({
        content: "这个界面设计不好",
        level: "lesson",
      }, "human");

      const result = await service.detectConflicts();

      const opinionConflicts = result.conflicts.filter((c) => c.conflict_type === "opinion");
      expect(opinionConflicts.length).toBeGreaterThan(0);
    });

    it("不应该将不同内容检测为冲突", async () => {
      await service.remember({
        content: "用户喜欢蓝色",
        level: "fact",
      }, "human");

      await service.remember({
        content: "系统支持深色模式",
        level: "fact",
      }, "human");

      const result = await service.detectConflicts();
      expect(result.conflicts.length).toBe(0);
    });
  });

  describe("Conflict Resolution", () => {
    it("应该能解决冲突（保留一方）", async () => {
      const mem1 = await service.remember({
        content: "项目进度是50%",
        level: "fact",
      }, "human");

      const mem2 = await service.remember({
        content: "项目进度不是50%",
        level: "lesson",  // 不同层级避免同层合并
      }, "human");

      // 检测冲突
      const result = await service.detectConflicts();
      expect(result.conflicts.length).toBeGreaterThan(0);

      const conflict = result.conflicts[0];

      // 解决冲突：保留 mem2
      await service.resolveMemoryConflict(conflict.id, {
        resolution: "keep_b",
        actor: "test",
      });

      // 验证冲突状态已更新
      const updatedConflicts = await service.getConflicts();
      const resolvedConflict = updatedConflicts.find((c) => c.id === conflict.id);
      expect(resolvedConflict?.status).toBe("resolved");

      // 验证 mem1 已被删除或标记为已删除
      const mem1After = await service.recall("项目进度是50%", { limit: 10 });
      // mem1 应该不再出现在 recall 结果中
      const hasMem1 = mem1After.some((m) => m.id === mem1.id);
      expect(hasMem1).toBe(false);
    });

    it("应该能标记为补充关系", async () => {
      const mem1 = await service.remember({
        content: "这个界面设计很好",
        level: "fact",
      }, "human");

      const mem2 = await service.remember({
        content: "这个界面设计不好",
        level: "lesson",  // 不同层级避免同层合并
      }, "human");

      const result = await service.detectConflicts();
      expect(result.conflicts.length).toBeGreaterThan(0);

      const conflict = result.conflicts[0];

      // 解决冲突：标记为补充
      await service.resolveMemoryConflict(conflict.id, {
        resolution: "complement",
        actor: "test",
      });

      const updatedConflicts = await service.getConflicts();
      const resolvedConflict = updatedConflicts.find((c) => c.id === conflict.id);
      expect(resolvedConflict?.status).toBe("resolved");

      // 两条记忆都应该保留
      const memories = await service.recall("界面设计", { limit: 10 });
      expect(memories.length).toBe(2);
    });

    it("应该能合并冲突的记忆", async () => {
      const mem1 = await service.remember({
        content: "用户通过了认证",
        level: "fact",
      }, "human");

      const mem2 = await service.remember({
        content: "用户不通过认证",
        level: "lesson",  // 不同层级避免同层合并
      }, "human");

      const result = await service.detectConflicts();
      expect(result.conflicts.length).toBeGreaterThan(0);

      const conflict = result.conflicts[0];

      // 合并记忆
      const mergedId = await service.mergeConflictingMemories(
        conflict.id,
        "用户认证状态不确定"
      );

      expect(mergedId).toBeDefined();

      // 获取合并后的记忆
      const allMemories = await service.recall("认证", { limit: 10 });
      const merged = allMemories.find((m) => m.id === mergedId);
      
      expect(merged).toBeDefined();
      expect(merged?.entry.content).toBe("用户认证状态不确定");

      // 验证冲突已解决
      const updatedConflicts = await service.getConflicts();
      const resolvedConflict = updatedConflicts.find((c) => c.id === conflict.id);
      expect(resolvedConflict?.status).toBe("resolved");

      // 原记忆应该被删除/合并为一条
      const allMemories2 = await service.recall("认证", { limit: 10 });
      expect(allMemories2.length).toBe(1);
      expect(allMemories2[0].id).toBe(mergedId);
    });
  });

  describe("Conflict Listing and Filtering", () => {
    it("应该能列出所有冲突", async () => {
      // 创建多个冲突 (使用不同level避免同层合并)
      await service.remember({ content: "A是真的", level: "fact" }, "human");
      await service.remember({ content: "A不是真的", level: "lesson" }, "human");

      await service.remember({ content: "这个功能很好", level: "fact" }, "human");
      await service.remember({ content: "这个功能很差", level: "topic" }, "human");

      const result = await service.detectConflicts();
      expect(result.conflicts.length).toBeGreaterThanOrEqual(2);
    });

    it("应该能按状态过滤冲突", async () => {
      await service.remember({ content: "测试内容很好", level: "fact" }, "human");
      await service.remember({ content: "测试内容不好", level: "lesson" }, "human");  // 不同层级避免同层合并

      const result = await service.detectConflicts();
      expect(result.conflicts.length).toBeGreaterThan(0);

      // 所有新检测的冲突都应该是 pending 状态
      const pending = result.conflicts.filter((c) => c.status === "pending");
      expect(pending.length).toBe(result.conflicts.length);

      // 解决一个冲突
      await service.resolveMemoryConflict(result.conflicts[0].id, {
        resolution: "keep_a",
        actor: "test",
      });

      // 再次获取冲突，应该有已解决的
      const allConflicts = await service.getConflicts();
      const resolved = allConflicts.filter((c) => c.status === "resolved");
      expect(resolved.length).toBeGreaterThan(0);
    });
  });

  describe("Integration with Remember/Recall", () => {
    it("recall 不应该返回已删除的记忆", async () => {
      const mem1 = await service.remember({
        content: "系统版本是1.0",
        level: "fact",
      }, "human");

      const mem2 = await service.remember({
        content: "系统版本不是1.0",
        level: "lesson",  // 不同层级避免同层合并
      }, "human");

      // 检测并解决冲突
      const result = await service.detectConflicts();
      expect(result.conflicts.length).toBeGreaterThan(0);

      await service.resolveMemoryConflict(result.conflicts[0].id, {
        resolution: "keep_b",
        actor: "test",
      });

      // recall 应该只返回未删除的记忆
      const results = await service.recall("系统版本", { limit: 10 });

      expect(results.length).toBe(1);
      expect(results[0].id).toBe(mem2.id);
    });
  });

  describe("Edge Cases", () => {
    it("应该处理自我冲突（相同ID）", async () => {
      const mem = await service.remember({
        content: "测试记忆",
        level: "fact",
      }, "human");

      // 不应该与自己产生冲突
      const result = await service.detectConflicts();
      const selfConflicts = result.conflicts.filter(
        (c) => c.memory_id_a === mem.id && c.memory_id_b === mem.id
      );
      expect(selfConflicts.length).toBe(0);
    });

    it("应该处理多次检测（幂等性）", async () => {
      await service.remember({ content: "内容A很棒", level: "fact" }, "human");
      await service.remember({ content: "内容A不好", level: "fact" }, "human");

      const result1 = await service.detectConflicts();
      const result2 = await service.detectConflicts();

      // 多次检测应该产生相同数量的冲突（不重复）
      expect(result1.conflicts.length).toBe(result2.conflicts.length);
    });

    it("应该处理空数据库", async () => {
      const result = await service.detectConflicts();
      expect(result.conflicts).toEqual([]);
      expect(result.total).toBe(0);
    });

    it("应该处理无效的冲突ID", async () => {
      expect(() =>
        service.resolveMemoryConflict(99999, {
          resolution: "keep_a",
          actor: "test",
        })
      ).toThrow();
    });
  });
});
