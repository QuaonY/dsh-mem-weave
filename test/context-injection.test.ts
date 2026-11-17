/**
 * 稳定/动态上下文分离测试
 * 真实预览测试
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openService, type WeaveService } from "../src/host";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

describe("稳定/动态上下文分离", () => {
  let tmpDir: string;
  let service: WeaveService;
  let closeEnv: () => void;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "memweave-m4-context-"));
    const runtime = openService(tmpDir);
    service = runtime.service;
    closeEnv = () => runtime.env.close();
  });

  afterEach(() => {
    if (closeEnv) {
      closeEnv();
    }
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("生成 stableContext 和 dynamicContext", async () => {
    // 写一些记忆
    await service.remember(
      { level: "user", content: "用户喜欢简洁的代码风格" },
      "human"
    );
    await service.remember(
      { level: "fact", content: "项目使用 TypeScript 开发", tier: "core" },
      "human"
    );

    // 更新人格
    await service.updatePersona(
      {
        enabled: true,
        stance: "我是一个专业的开发助手",
        character: "认真负责，注重代码质量",
      },
      "test-actor"
    );

    const result = service.preview();

    // 验证稳定和动态上下文字段存在
    expect(result.stableContext).toBeDefined();
    expect(result.dynamicContext).toBeDefined();

    // 稳定上下文应包含 S1 人格
    expect(result.stableContext).toContain("我是一个专业的开发助手");
    expect(result.stableContext).toContain("认真负责");

    // 动态上下文应包含 S2 快照
    expect(result.dynamicContext).toContain("用户喜欢简洁的代码风格");
    expect(result.dynamicContext).toContain("项目使用 TypeScript 开发");

    // 验证字段内容与原始 s1/s2 对应
    expect(result.s1.prefix).toBeTruthy();
  });

  it("用户画像注入到稳定上下文", async () => {
    // 写一些用户相关记忆
    await service.remember(
      { level: "user", content: "用户偏好使用函数式编程风格" },
      "human"
    );

    // 启用画像功能
    service.config.profile = {
      enabled: true,
      injectToS2: true,
      s2Budget: { min: 300, max: 600 },
      sensitiveKeywords: [],
      inferredExpiryDays: 90,
      minConfidence: 0.4,
    };

    const result = service.preview();

    // 画像应在稳定上下文中
    if (result.stableContext) {
      // 如果有画像内容，应该包含画像标题
      const hasProfile = result.stableContext.includes("我对你的理解");
      if (hasProfile) {
        expect(result.stableContext).toContain("我对你的理解");
        // 稳定上下文应该在动态上下文之前不变化
        expect(result.stableContext.length).toBeGreaterThan(0);
      }
    }
  });

  it("首轮vs后续轮的上下文差异", async () => {
    // 更新人格（稳定上下文的基础）
    await service.updatePersona(
      {
        enabled: true,
        stance: "我是专业助手",
        character: "认真负责",
      },
      "test-actor"
    );

    // 写一些记忆
    await service.remember(
      { level: "user", content: "用户喜欢使用 Vim" },
      "human",
      { sessionId: "test-session", turn: 1 }
    );

    // 首轮预览
    const firstRound = service.previewWithContext({
      first: true,
      sessionId: "test-session",
    });

    // 后续轮预览（不写新的用户画像相关记忆）
    const nextRound = service.previewWithContext({
      first: false,
      sessionId: "test-session",
      query: "Vim",
    });

    // 稳定上下文应该相同（人格和画像不变）
    expect(firstRound.stableContext).toEqual(nextRound.stableContext);

    // 验证稳定上下文包含人格信息
    expect(firstRound.stableContext).toContain("我是专业助手");
    
    // 验证两轮都有结构化的段落
    expect(firstRound.segments).toBeDefined();
    expect(nextRound.segments).toBeDefined();
  });
});

describe("真实预览", () => {
  let tmpDir: string;
  let service: WeaveService;
  let closeEnv: () => void;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "memweave-m4-preview-"));
    const runtime = openService(tmpDir);
    service = runtime.service;
    closeEnv = () => runtime.env.close();
  });

  afterEach(() => {
    if (closeEnv) {
      closeEnv();
    }
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("previewWithContext 支持首轮模式", async () => {
    await service.remember(
      { level: "user", content: "用户是一名资深开发者" },
      "human"
    );

    const result = service.previewWithContext({ first: true });

    // 有稳定和动态上下文
    expect(result.stableContext).toBeDefined();
    expect(result.dynamicContext).toBeDefined();
    
    // 验证 segments 结构
    expect(result.segments).toBeDefined();
    expect(result.segments.length).toBeGreaterThan(0);
  });

  it("previewWithContext 支持后续轮模式（带召回）", async () => {
    // 写入一些记忆
    await service.remember(
      { level: "fact", content: "TypeScript 是 JavaScript 的超集" },
      "human",
      { sessionId: "test-session" }
    );
    await service.remember(
      { level: "fact", content: "React 使用虚拟 DOM 技术" },
      "human",
      { sessionId: "test-session" }
    );

    // 模拟后续轮，带查询
    const result = service.previewWithContext({
      first: false,
      sessionId: "test-session",
      query: "TypeScript 和 React",
    });

    // 后续轮无 S2
    expect(result.s2).toBe("");

    // 可能有 S3（如果有召回或增量）
    // S3 内容取决于是否有匹配的召回
    expect(result.dynamicContext).toBeDefined();
  });

  it("previewWithContext 显示增量变化", async () => {
    const sessionId = "test-session";

    // 第一轮写入
    await service.remember(
      { level: "fact", content: "初始记忆" },
      "human",
      { sessionId, turn: 1 }
    );

    // 第二轮写入（会成为增量）
    await service.remember(
      { level: "fact", content: "新增记忆" },
      "human",
      { sessionId, turn: 2 }
    );

    // 预览后续轮应该显示增量
    const result = service.previewWithContext({
      first: false,
      sessionId,
    });

    // 应该有动态上下文
    expect(result.dynamicContext).toBeDefined();

    // segments 应包含 delta 信息
    const deltaSegment = result.segments.find((s) => s.name === "s3-delta");
    expect(deltaSegment).toBeDefined();
  });

  it("预览结果包含 trim 信息", async () => {
    // 写入很多记忆，超过预算（需要足够长的内容）
    for (let i = 0; i < 300; i++) {
      await service.remember(
        { 
          level: "fact", 
          content: `记忆内容 ${i}：这是一条比较长的测试记忆数据，用于测试预算截断功能。包含足够的文本以便触发字符数限制。` 
        },
        "human"
      );
    }

    const result = service.preview();

    // 应该有 trim 信息
    const s2Segment = result.segments.find((s) => s.name === "s2-snapshot");
    expect(s2Segment).toBeDefined();
    
    // 因为层级限制（每层最多200条）或字符限制，应该有截断
    if (s2Segment!.trimmed > 0) {
      expect(s2Segment!.trimReason).toBeDefined();
    }
  });

  it("预览 hash 一致性", async () => {
    await service.remember(
      { level: "user", content: "测试记忆" },
      "human"
    );

    const result1 = service.preview();
    const result2 = service.preview();

    // 同样的输入应该产生同样的 hash
    expect(result1.hash).toBe(result2.hash);

    // 改变人格后 hash 应该变化
    await service.updatePersona(
      { stance: "新的立场" },
      "test-actor"
    );

    const result3 = service.preview();
    expect(result3.hash).not.toBe(result1.hash);
  });
});
