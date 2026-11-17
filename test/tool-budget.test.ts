/**
 * 工具调用预算测试
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WeaveService, defaultConfig } from "../src/host/service";
import { openWeaveDb } from "../src/store/db";
import { ensureSchema } from "../src/store/migrate";

describe("工具调用预算", () => {
  let service: WeaveService;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "weave-budget-test-"));
    const env = openWeaveDb(tmpDir, { readonly: false });
    ensureSchema(env);
    service = new WeaveService(env, defaultConfig(tmpDir));
  });

  afterEach(() => {
    service.env.db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("初始化工具预算", () => {
    service.initToolBudget("session-1:turn-1");
    
    const stats = service.getToolUsageStats();
    
    expect(stats["weave_recall"]).toEqual({ used: 0, limit: 3 });
    expect(stats["weave_read"]).toEqual({ used: 0, limit: 10 });
    expect(stats["weave_quote"]).toEqual({ used: 0, limit: 3 });
  });

  it("自定义预算限制", () => {
    service.initToolBudget("session-1:turn-1", {
      recall: 5,
      read: 20,
      quote: 2,
    });
    
    const stats = service.getToolUsageStats();
    
    expect(stats["weave_recall"].limit).toBe(5);
    expect(stats["weave_read"].limit).toBe(20);
    expect(stats["weave_quote"].limit).toBe(2);
  });

  it("检查预算（未超限）", () => {
    service.initToolBudget("session-1:turn-1");
    
    const check1 = service.checkToolBudget("weave_recall", "session-1:turn-1");
    expect(check1.allowed).toBe(true);
    expect(check1.used).toBe(0);
    expect(check1.limit).toBe(3);
    expect(check1.message).toBeUndefined();
  });

  it("记录工具调用并检查预算", () => {
    service.initToolBudget("session-1:turn-1");
    
    // 第一次调用
    service.recordToolCallBudget("weave_recall", "session-1:turn-1");
    let check = service.checkToolBudget("weave_recall", "session-1:turn-1");
    expect(check.allowed).toBe(true);
    expect(check.used).toBe(1);
    
    // 第二次调用
    service.recordToolCallBudget("weave_recall", "session-1:turn-1");
    check = service.checkToolBudget("weave_recall", "session-1:turn-1");
    expect(check.allowed).toBe(true);
    expect(check.used).toBe(2);
    
    // 第三次调用
    service.recordToolCallBudget("weave_recall", "session-1:turn-1");
    check = service.checkToolBudget("weave_recall", "session-1:turn-1");
    expect(check.allowed).toBe(false);
    expect(check.used).toBe(3);
    expect(check.message).toContain("exceeded budget");
  });

  it("超出预算后拒绝调用", () => {
    service.initToolBudget("session-1:turn-1", { recall: 2 });
    
    // 用完预算
    service.recordToolCallBudget("weave_recall", "session-1:turn-1");
    service.recordToolCallBudget("weave_recall", "session-1:turn-1");
    
    // 第三次应该被拒绝
    const check = service.checkToolBudget("weave_recall", "session-1:turn-1");
    expect(check.allowed).toBe(false);
    expect(check.used).toBe(2);
    expect(check.limit).toBe(2);
  });

  it("新轮次重置预算", () => {
    service.initToolBudget("session-1:turn-1");
    
    // 用完第一轮的预算
    service.recordToolCallBudget("weave_recall", "session-1:turn-1");
    service.recordToolCallBudget("weave_recall", "session-1:turn-1");
    service.recordToolCallBudget("weave_recall", "session-1:turn-1");
    
    let check = service.checkToolBudget("weave_recall", "session-1:turn-1");
    expect(check.allowed).toBe(false);
    
    // 新轮次自动重置
    check = service.checkToolBudget("weave_recall", "session-1:turn-2");
    expect(check.allowed).toBe(true);
    expect(check.used).toBe(0);
  });

  it("不同工具独立计数", () => {
    service.initToolBudget("session-1:turn-1");
    
    service.recordToolCallBudget("weave_recall", "session-1:turn-1");
    service.recordToolCallBudget("weave_read", "session-1:turn-1");
    service.recordToolCallBudget("weave_quote", "session-1:turn-1");
    
    const stats = service.getToolUsageStats();
    
    expect(stats["weave_recall"].used).toBe(1);
    expect(stats["weave_read"].used).toBe(1);
    expect(stats["weave_quote"].used).toBe(1);
  });

  it("获取使用统计", () => {
    service.initToolBudget("session-1:turn-1", { recall: 5, read: 10, quote: 2 });
    
    service.recordToolCallBudget("weave_recall", "session-1:turn-1");
    service.recordToolCallBudget("weave_recall", "session-1:turn-1");
    service.recordToolCallBudget("weave_read", "session-1:turn-1");
    
    const stats = service.getToolUsageStats("session-1:turn-1");
    
    expect(stats["weave_recall"]).toEqual({ used: 2, limit: 5 });
    expect(stats["weave_read"]).toEqual({ used: 1, limit: 10 });
    expect(stats["weave_quote"]).toEqual({ used: 0, limit: 2 });
  });

  it("未设置预算的工具不限制", () => {
    service.initToolBudget("session-1:turn-1");
    
    // weave_remember 没有设置预算
    const check = service.checkToolBudget("weave_remember", "session-1:turn-1");
    
    expect(check.allowed).toBe(true);
    expect(check.limit).toBe(-1);
  });

  it("参考腾讯标准：recall 最多 3 次", () => {
    service.initToolBudget("session-1:turn-1");
    
    // 默认 recall 限制为 3
    const stats = service.getToolUsageStats();
    expect(stats["weave_recall"].limit).toBe(3);
    
    // 调用 3 次后超限
    service.recordToolCallBudget("weave_recall", "session-1:turn-1");
    service.recordToolCallBudget("weave_recall", "session-1:turn-1");
    service.recordToolCallBudget("weave_recall", "session-1:turn-1");
    
    const check = service.checkToolBudget("weave_recall", "session-1:turn-1");
    expect(check.allowed).toBe(false);
  });
});
