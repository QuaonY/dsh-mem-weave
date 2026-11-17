/**
 * 自动抽取器测试
 */

import { describe, expect, it } from "vitest";
import {
  buildExtractPrompt,
  parseExtractResponse,
  shouldTriggerByTurns,
  shouldTriggerByIdle,
  shouldTriggerByWarmup,
  getWarmupInterval,
  isHighRisk,
  assessQuality,
  DEFAULT_EXTRACT_CONFIG,
} from "../src/extract/extractor";
import type { L0Message } from "../src/store/l0";

describe("自动抽取器", () => {
  describe("提示词生成", () => {
    it("生成正确格式的提示词", () => {
      const messages: L0Message[] = [
        {
          id: "m1",
          sessionId: "s1",
          seq: 1,
          role: "user",
          content: "项目使用 TypeScript 和 React",
          ts: 1000,
          source: null,
          retainedUntil: null,
        },
        {
          id: "m2",
          sessionId: "s1",
          seq: 2,
          role: "assistant",
          content: "好的，我了解了技术栈",
          ts: 2000,
          source: null,
          retainedUntil: null,
        },
      ];

      const prompt = buildExtractPrompt(messages);

      expect(prompt.system).toContain("记忆抽取");
      expect(prompt.system).toContain("JSON");
      expect(prompt.user).toContain("[user]: 项目使用 TypeScript 和 React");
      expect(prompt.user).toContain("[assistant]: 好的，我了解了技术栈");
    });
  });

  describe("响应解析", () => {
    it("解析标准 JSON 响应", () => {
      const response = JSON.stringify([
        {
          level: "memory",
          content: "项目使用 TypeScript 和 React",
          keywords: ["TypeScript", "React"],
          confidence: 0.9,
          reason: "明确陈述了技术栈",
        },
      ]);

      const result = parseExtractResponse(response);

      expect(result).toHaveLength(1);
      expect(result[0].content).toBe("项目使用 TypeScript 和 React");
      expect(result[0].keywords).toEqual(["TypeScript", "React"]);
      expect(result[0].confidence).toBe(0.9);
    });

    it("解析 Markdown 包裹的 JSON", () => {
      const response = "```json\n[{\"level\":\"memory\",\"content\":\"Test\",\"keywords\":[],\"confidence\":0.8}]\n```";

      const result = parseExtractResponse(response);

      expect(result).toHaveLength(1);
      expect(result[0].content).toBe("Test");
    });

    it("解析不带标记的 JSON", () => {
      const response = "[{\"content\":\"Test\"}]";

      const result = parseExtractResponse(response);

      expect(result).toHaveLength(1);
      expect(result[0].content).toBe("Test");
      expect(result[0].level).toBe("memory"); // 默认值
      expect(result[0].confidence).toBe(0.5); // 默认值
    });

    it("过滤无效条目", () => {
      const response = JSON.stringify([
        { content: "Valid" },
        { content: "" }, // 空内容
        { keywords: [] }, // 缺少 content
        null,
        { content: "Valid 2" },
      ]);

      const result = parseExtractResponse(response);

      expect(result).toHaveLength(2);
      expect(result[0].content).toBe("Valid");
      expect(result[1].content).toBe("Valid 2");
    });

    it("处理解析错误", () => {
      const invalidResponse = "This is not JSON";

      const result = parseExtractResponse(invalidResponse);

      expect(result).toEqual([]);
    });
  });

  describe("轮数触发", () => {
    it("按配置的间隔触发", () => {
      const config = { ...DEFAULT_EXTRACT_CONFIG, turnsInterval: 5 };

      expect(shouldTriggerByTurns(0, config)).toBe(false);
      expect(shouldTriggerByTurns(3, config)).toBe(false);
      expect(shouldTriggerByTurns(5, config)).toBe(true);
      expect(shouldTriggerByTurns(10, config)).toBe(true);
      expect(shouldTriggerByTurns(11, config)).toBe(false);
    });

    it("禁用时不触发", () => {
      const config = { ...DEFAULT_EXTRACT_CONFIG, enabled: false };

      expect(shouldTriggerByTurns(5, config)).toBe(false);
    });

    it("间隔为 0 时不触发", () => {
      const config = { ...DEFAULT_EXTRACT_CONFIG, turnsInterval: 0 };

      expect(shouldTriggerByTurns(5, config)).toBe(false);
    });
  });

  describe("空闲触发", () => {
    it("超过空闲时间后触发", () => {
      const config = { ...DEFAULT_EXTRACT_CONFIG, idleSeconds: 600 };
      const lastActivity = 1000;

      expect(shouldTriggerByIdle(lastActivity, lastActivity + 300000, config)).toBe(false); // 5分钟
      expect(shouldTriggerByIdle(lastActivity, lastActivity + 600000, config)).toBe(true);  // 10分钟
      expect(shouldTriggerByIdle(lastActivity, lastActivity + 900000, config)).toBe(true);  // 15分钟
    });

    it("禁用时不触发", () => {
      const config = { ...DEFAULT_EXTRACT_CONFIG, enabled: false };

      expect(shouldTriggerByIdle(1000, 2000000, config)).toBe(false);
    });
  });

  describe("预热触发", () => {
    it("计算正确的预热间隔", () => {
      expect(getWarmupInterval(0)).toBe(0);
      expect(getWarmupInterval(1)).toBe(1);
      expect(getWarmupInterval(2)).toBe(2);
      expect(getWarmupInterval(3)).toBe(5);
      expect(getWarmupInterval(5)).toBe(10);
      expect(getWarmupInterval(10)).toBe(20);
      expect(getWarmupInterval(50)).toBe(20);
    });

    it("按预热间隔触发", () => {
      const config = { ...DEFAULT_EXTRACT_CONFIG, warmupEnabled: true };

      expect(shouldTriggerByWarmup(1, config)).toBe(true);
      expect(shouldTriggerByWarmup(2, config)).toBe(true);
      expect(shouldTriggerByWarmup(3, config)).toBe(false);
      expect(shouldTriggerByWarmup(5, config)).toBe(true);
      expect(shouldTriggerByWarmup(10, config)).toBe(true);
      expect(shouldTriggerByWarmup(20, config)).toBe(true);
    });

    it("禁用时不触发", () => {
      const config = { ...DEFAULT_EXTRACT_CONFIG, warmupEnabled: false };

      expect(shouldTriggerByWarmup(1, config)).toBe(false);
    });
  });

  describe("风险评估", () => {
    it("规则/灵魂层级为高风险", () => {
      expect(isHighRisk("rules", "Some rule", [])).toBe(true);
      expect(isHighRisk("soul", "Core value", [])).toBe(true);
    });

    it("普通记忆为低风险", () => {
      expect(isHighRisk("fact", "Normal memory", [])).toBe(false);
      expect(isHighRisk("topic", "Thread info", [])).toBe(false);
    });

    it("包含敏感关键词为高风险", () => {
      expect(isHighRisk("fact", "用户的密码是 123", [])).toBe(true);
      expect(isHighRisk("fact", "删除所有数据", [])).toBe(true);
      expect(isHighRisk("fact", "API token: xxx", [])).toBe(true);
    });

    it("关键词中的敏感词也被检测", () => {
      expect(isHighRisk("fact", "配置更新", ["password", "config"])).toBe(true);
    });
  });

  describe("质量评估", () => {
    it("高质量内容得高分", () => {
      const score = assessQuality(
        "项目使用 TypeScript 和 React 进行前端开发",
        ["TypeScript", "React", "前端"],
        0.9
      );

      expect(score).toBeGreaterThan(0.8);
    });

    it("过短内容降分", () => {
      const score = assessQuality("短", ["关键词"], 0.9);

      expect(score).toBeLessThan(0.5);
    });

    it("过长内容降分", () => {
      const longContent = "x".repeat(600);
      const score = assessQuality(longContent, ["关键词"], 0.9);

      expect(score).toBeLessThan(0.9);
    });

    it("缺少关键词降分", () => {
      const score = assessQuality("这是一段内容", [], 0.9);

      expect(score).toBeLessThan(0.6);
    });

    it("包含占位符严重降分", () => {
      const score = assessQuality("这是内容 TODO 待完善", ["关键词"], 0.9);

      expect(score).toBeLessThan(0.5);
    });

    it("分数限制在 0-1 范围", () => {
      const score1 = assessQuality("x", [], 0.1);
      const score2 = assessQuality("好的内容", ["关键词"], 1.5);

      expect(score1).toBeGreaterThanOrEqual(0);
      expect(score1).toBeLessThanOrEqual(1);
      expect(score2).toBeGreaterThanOrEqual(0);
      expect(score2).toBeLessThanOrEqual(1);
    });
  });
});
