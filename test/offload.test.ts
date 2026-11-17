/**
 * 忆织 MemWeave —— Offload 功能测试
 */

import { strict as assert } from "node:assert";
import { describe, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OffloadManager, DEFAULT_OFFLOAD_CONFIG, type OffloadConfig } from "../src/offload";

describe("短期上下文 Offload", () => {
  let tempDir: string;
  let manager: OffloadManager;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "memweave-offload-test-"));
    const config: OffloadConfig = {
      ...DEFAULT_OFFLOAD_CONFIG,
      enabled: true,
      threshold: 3, // 降低阈值方便测试
      summaryInterval: 2,
      keepRecentCount: 2,
    };
    manager = new OffloadManager(tempDir, config);
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("配置关闭时不记录任何数据", () => {
    const disabledConfig: OffloadConfig = {
      ...DEFAULT_OFFLOAD_CONFIG,
      enabled: false,
    };
    const disabledManager = new OffloadManager(tempDir, disabledConfig);

    disabledManager.recordToolCall({
      sessionId: "session-001",
      step: 1,
      toolName: "test_tool",
      input: "test input",
      output: "test output",
      success: true,
    });

    const injection = disabledManager.generateInjection("session-001");
    assert.equal(injection.offloaded, false);
    assert.equal(injection.text, "");
  });

  it("工具调用次数未达阈值时不激活 offload", () => {
    manager.recordToolCall({
      sessionId: "session-001",
      step: 1,
      toolName: "read_file",
      input: JSON.stringify({ path: "test.txt" }),
      output: "file content",
      success: true,
    });

    manager.recordToolCall({
      sessionId: "session-001",
      step: 2,
      toolName: "write_file",
      input: JSON.stringify({ path: "output.txt" }),
      output: "written",
      success: true,
    });

    const injection = manager.generateInjection("session-001");
    assert.equal(injection.offloaded, false);
  });

  it("达到阈值后激活 offload 并生成摘要", () => {
    // 添加 3 次工具调用
    for (let i = 1; i <= 3; i++) {
      manager.recordToolCall({
        sessionId: "session-002",
        step: i,
        toolName: `tool_${i}`,
        input: `input ${i}`,
        output: `output ${i}`,
        success: true,
      });
    }

    const injection = manager.generateInjection("session-002");
    assert.equal(injection.offloaded, true);
    assert.ok(injection.text.length > 0);
    assert.equal(injection.totalNodes, 3);
    assert.equal(injection.keptNodes, 2); // keepRecentCount = 2
  });

  it("注入内容包含最近的完整日志和历史摘要", () => {
    // 添加 5 次工具调用
    for (let i = 1; i <= 5; i++) {
      manager.recordToolCall({
        sessionId: "session-003",
        step: i,
        toolName: `tool_${i}`,
        input: `input ${i}`,
        output: `output ${i}`,
        success: i !== 3, // 第 3 次调用失败
        error: i === 3 ? "test error" : undefined,
      });
    }

    const injection = manager.generateInjection("session-003");
    assert.equal(injection.offloaded, true);

    // 应该包含最近 2 次的完整信息
    assert.ok(injection.text.includes("tool_4"));
    assert.ok(injection.text.includes("tool_5"));

    // 应该包含历史摘要
    assert.ok(injection.text.includes("摘要"));
  });

  it("超长输出会被摘要压缩", () => {
    const longOutput = "x".repeat(3000); // 超过 maxCharsPerNode (2000)

    manager.recordToolCall({
      sessionId: "session-004",
      step: 1,
      toolName: "long_tool",
      input: "short input",
      output: longOutput,
      success: true,
    });

    manager.recordToolCall({
      sessionId: "session-004",
      step: 2,
      toolName: "another_tool",
      input: "input",
      output: "short output",
      success: true,
    });

    manager.recordToolCall({
      sessionId: "session-004",
      step: 3,
      toolName: "final_tool",
      input: "input",
      output: "output",
      success: true,
    });

    const injection = manager.generateInjection("session-004");
    // 注入的文本应该比原始输出短得多
    assert.ok(injection.savedChars > 0);
    assert.ok(injection.text.length < longOutput.length);
  });

  it("getMetrics 返回正确的统计信息", () => {
    for (let i = 1; i <= 10; i++) {
      manager.recordToolCall({
        sessionId: "session-005",
        step: i,
        toolName: "tool",
        input: "input ".repeat(50), // 更长的输入
        output: "output ".repeat(100), // 更长的输出
        success: true,
      });
    }

    const metrics = manager.getMetrics("session-005");
    assert.equal(metrics.enabled, true);
    assert.equal(metrics.active, true);
    assert.equal(metrics.totalCalls, 10);
    assert.ok(metrics.savedChars > 0);
    assert.ok(metrics.savedTokensEstimate > 0);
  });

  it("clearSession 清除会话数据", () => {
    manager.recordToolCall({
      sessionId: "session-006",
      step: 1,
      toolName: "tool",
      input: "input",
      output: "output",
      success: true,
    });

    manager.recordToolCall({
      sessionId: "session-006",
      step: 2,
      toolName: "tool",
      input: "input",
      output: "output",
      success: true,
    });

    manager.recordToolCall({
      sessionId: "session-006",
      step: 3,
      toolName: "tool",
      input: "input",
      output: "output",
      success: true,
    });

    let injection = manager.generateInjection("session-006");
    assert.equal(injection.offloaded, true);

    manager.clearSession("session-006");

    injection = manager.generateInjection("session-006");
    assert.equal(injection.offloaded, false);
  });

  it("不同会话的 offload 数据互相独立", () => {
    // 会话 A
    for (let i = 1; i <= 5; i++) {
      manager.recordToolCall({
        sessionId: "session-A",
        step: i,
        toolName: "tool_A",
        input: "input",
        output: "output",
        success: true,
      });
    }

    // 会话 B
    for (let i = 1; i <= 3; i++) {
      manager.recordToolCall({
        sessionId: "session-B",
        step: i,
        toolName: "tool_B",
        input: "input",
        output: "output",
        success: true,
      });
    }

    const metricsA = manager.getMetrics("session-A");
    const metricsB = manager.getMetrics("session-B");

    assert.equal(metricsA.totalCalls, 5);
    assert.equal(metricsB.totalCalls, 3);

    const injectionA = manager.generateInjection("session-A");
    const injectionB = manager.generateInjection("session-B");

    assert.ok(injectionA.text.includes("tool_A"));
    assert.ok(!injectionA.text.includes("tool_B"));

    assert.ok(injectionB.text.includes("tool_B"));
    assert.ok(!injectionB.text.includes("tool_A"));
  });
});
