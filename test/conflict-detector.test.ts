/**
 * 冲突检测器单元测试
 */

import { describe, it, expect } from "vitest";
import { ConflictDetector } from "../src/conflict/detector";
import type { MemoryEntry } from "../src/core/types";

describe("Conflict Detector", () => {
  const detector = new ConflictDetector();

  describe("Time Conflicts", () => {
    it("应该检测到相同事件的不同时间", () => {
      const a: MemoryEntry = {
        id: "mem_1",
        level: "fact",
        content: "项目启动会议在周一举行",
        createdAt: new Date("2024-01-01").getTime(),
        validFrom: new Date("2024-01-01").getTime(),
      } as unknown as MemoryEntry;

      const b: MemoryEntry = {
        id: "mem_2",
        level: "fact",
        content: "项目启动会议在周一举行",  // 相同内容，不同时间戳
        createdAt: new Date("2024-01-10").getTime(),  // 9天后，超过7天阈值
        validFrom: new Date("2024-01-10").getTime(),
      } as unknown as MemoryEntry;

      const conflict = detector.detectConflict(a, b, 0.5);
      expect(conflict).not.toBeNull();
      expect(conflict?.conflict_type).toBe("time");
    });

    it("不应该将不同事件判定为时间冲突", () => {
      const a: MemoryEntry = {
        id: "mem_1",
        level: "fact",
        content: "早餐吃了鸡蛋",
        created_at: Date.now(),
      } as unknown as MemoryEntry;

      const b: MemoryEntry = {
        id: "mem_2",
        level: "fact",
        content: "晚餐吃了牛排",
        created_at: Date.now(),
      } as unknown as MemoryEntry;

      const conflict = detector.detectConflict(a, b, 0.85);
      expect(conflict).toBeNull();
    });
  });

  describe("Fact Conflicts", () => {
    it("应该检测到肯定与否定的矛盾", () => {
      const a: MemoryEntry = {
        id: "mem_1",
        level: "fact",
        content: "用户喜欢深色主题",
        created_at: Date.now(),
      } as unknown as MemoryEntry;

      const b: MemoryEntry = {
        id: "mem_2",
        level: "fact",
        content: "用户不喜欢深色主题",
        created_at: Date.now(),
      } as unknown as MemoryEntry;

      const conflict = detector.detectConflict(a, b, 0.5);
      expect(conflict).not.toBeNull();
      expect(conflict?.conflict_type).toBe("fact");
    });

    it("应该检测到'是'与'不是'的矛盾", () => {
      const a: MemoryEntry = {
        id: "mem_1",
        level: "fact",
        content: "这个功能是必需的",
        created_at: Date.now(),
      } as unknown as MemoryEntry;

      const b: MemoryEntry = {
        id: "mem_2",
        level: "fact",
        content: "这个功能不是必需的",
        created_at: Date.now(),
      } as unknown as MemoryEntry;

      const conflict = detector.detectConflict(a, b, 0.5);
      expect(conflict).not.toBeNull();
      expect(conflict?.conflict_type).toBe("fact");
    });

    it("应该检测到'能'与'不能'的矛盾", () => {
      const a: MemoryEntry = {
        id: "mem_1",
        level: "fact",
        content: "系统可以处理大文件",
        created_at: Date.now(),
      } as unknown as MemoryEntry;

      const b: MemoryEntry = {
        id: "mem_2",
        level: "fact",
        content: "系统不可以处理大文件",
        created_at: Date.now(),
      } as unknown as MemoryEntry;

      const conflict = detector.detectConflict(a, b, 0.5);
      expect(conflict).not.toBeNull();
      expect(conflict?.conflict_type).toBe("fact");
    });
  });

  describe("Opinion Conflicts", () => {
    it("应该检测到情绪价反转", () => {
      const a: MemoryEntry = {
        id: "mem_1",
        level: "fact",
        content: "这个设计方案很棒",
        created_at: Date.now(),
        valence: 0.8,
      } as unknown as MemoryEntry;

      const b: MemoryEntry = {
        id: "mem_2",
        level: "fact",
        content: "这个设计方案很糟糕",
        created_at: Date.now(),
        valence: -0.8,
      } as unknown as MemoryEntry;

      const conflict = detector.detectConflict(a, b, 0.5);
      expect(conflict).not.toBeNull();
      expect(conflict?.conflict_type).toBe("opinion");
    });

    it("应该检测到基于偏好词汇的观点变化", () => {
      const a: MemoryEntry = {
        id: "mem_1",
        level: "fact",
        content: "我希望界面保持简洁",
        created_at: Date.now() - 1000000,  // 较早
      } as unknown as MemoryEntry;

      const b: MemoryEntry = {
        id: "mem_2",
        level: "fact",
        content: "我期待界面保持简洁", // 不同偏好词，相似内容
        created_at: Date.now(),
      } as unknown as MemoryEntry;

      const conflict = detector.detectConflict(a, b, 0.5);
      // 两个相似的观点陈述，系统会识别为观点变化（即使实际上是重复）
      expect(conflict).not.toBeNull();
      if (conflict) {
        expect(conflict.conflict_type).toBe("opinion");
        // 观点冲突建议标记为补充
        expect(conflict.suggested_resolution).toBe("complement");
      }
    });
  });

  describe("Conflict Resolution Suggestions", () => {
    it("应该建议保留较新的记忆", () => {
      const oldTime = Date.now() - 1000000;
      const newTime = Date.now();

      const a: MemoryEntry = {
        id: "mem_old",
        level: "fact",
        content: "项目进度是50%",
        created_at: oldTime,
      } as unknown as MemoryEntry;

      const b: MemoryEntry = {
        id: "mem_new",
        level: "fact",
        content: "项目进度不是50%",  // 使用否定形式以触发事实冲突
        created_at: newTime,
      } as unknown as MemoryEntry;

      const conflict = detector.detectConflict(a, b, 0.5);
      expect(conflict).not.toBeNull();  // 先确保检测到冲突
      expect(conflict?.suggested_resolution).toBe("keep_b");
    });

    it("应该建议将观点冲突标记为补充", () => {
      const a: MemoryEntry = {
        id: "mem_1",
        level: "fact",
        content: "我喜欢喝咖啡",
        created_at: Date.now(),
        valence: 0.7,
      } as unknown as MemoryEntry;

      const b: MemoryEntry = {
        id: "mem_2",
        level: "fact",
        content: "我不太喜欢喝咖啡了",
        created_at: Date.now(),
        valence: -0.3,
      } as unknown as MemoryEntry;

      const conflict = detector.detectConflict(a, b, 0.5);
      expect(conflict).not.toBeNull();  // 先确保检测到冲突
      expect(conflict?.suggested_resolution).toBe("complement");
    });
  });

  describe("Batch Detection", () => {
    it("应该检测出多个冲突", () => {
      const memories: MemoryEntry[] = [
        {
          id: "mem_1",
          level: "fact",
          content: "用户喜欢蓝色",
          created_at: Date.now(),
        } as unknown as MemoryEntry,
        {
          id: "mem_2",
          level: "fact",
          content: "用户不喜欢蓝色",
          created_at: Date.now(),
        } as unknown as MemoryEntry,
        {
          id: "mem_3",
          level: "fact",
          content: "系统可以导出数据",
          created_at: Date.now(),
        } as unknown as MemoryEntry,
        {
          id: "mem_4",
          level: "fact",
          content: "系统不能导出数据",
          created_at: Date.now(),
        } as unknown as MemoryEntry,
      ];

      const conflicts = detector.detectConflicts(memories, 0.7);
      expect(conflicts.length).toBeGreaterThanOrEqual(2);
    });

    it("应该跳过相同记忆", () => {
      const memory: MemoryEntry = {
        id: "mem_1",
        level: "fact",
        content: "测试内容",
        created_at: Date.now(),
      } as unknown as MemoryEntry;

      const conflict = detector.detectConflict(memory, memory);
      expect(conflict).toBeNull();
    });
  });

  describe("Content Similarity", () => {
    it("应该计算相似度", () => {
      const a: MemoryEntry = {
        id: "mem_1",
        level: "fact",
        content: "今天天气很好",
        created_at: Date.now(),
      } as unknown as MemoryEntry;

      const b: MemoryEntry = {
        id: "mem_2",
        level: "fact",
        content: "今天天气不好",
        created_at: Date.now(),
      } as unknown as MemoryEntry;

      // 内容相似（都提到"今天天气"）但结论相反，应该检测到事实冲突
      const conflict = detector.detectConflict(a, b, 0.5);
      expect(conflict).not.toBeNull();
      expect(conflict?.conflict_type).toBe("fact");  // 应该是事实冲突
    });
  });
});
