/**
 * L0 消息捕获测试
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openWeaveDb, type WeaveEnv } from "../src/store/db";
import { ensureSchema } from "../src/store/migrate";
import {
  captureL0Message,
  getL0Messages,
  getRecentL0Messages,
  deleteL0Message,
  deleteL0Session,
  pruneExpiredL0Messages,
  getL0Stats,
  DEFAULT_L0_CONFIG,
} from "../src/store/l0";

describe("L0 消息捕获", () => {
  let env: WeaveEnv;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "weave-l0-test-"));
    env = openWeaveDb(tmpDir, { readonly: false });
    ensureSchema(env);
  });

  afterEach(() => {
    env.db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("默认关闭 L0 捕获", () => {
    const id = captureL0Message(env, "sess-1", "user", "Hello");
    expect(id).toBeNull();
  });

  it("启用后捕获消息", () => {
    const config = { ...DEFAULT_L0_CONFIG, enabled: true };
    const id = captureL0Message(env, "sess-1", "user", "Hello", config);
    
    expect(id).not.toBeNull();
    expect(id).toMatch(/^[a-z0-9]+-[a-z0-9-]+$/);
  });

  it("获取 session 的 L0 消息", () => {
    const config = { ...DEFAULT_L0_CONFIG, enabled: true };
    
    captureL0Message(env, "sess-1", "user", "Message 1", config);
    captureL0Message(env, "sess-1", "assistant", "Reply 1", config);
    captureL0Message(env, "sess-1", "user", "Message 2", config);
    
    const messages = getL0Messages(env, "sess-1");
    
    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe("Message 2"); // 最新的在前
    expect(messages[1].content).toBe("Reply 1");
    expect(messages[2].content).toBe("Message 1");
  });

  it("按角色过滤消息", () => {
    const config = { ...DEFAULT_L0_CONFIG, enabled: true };
    
    captureL0Message(env, "sess-1", "user", "User message", config);
    captureL0Message(env, "sess-1", "assistant", "Assistant reply", config);
    
    const userMessages = getL0Messages(env, "sess-1", { role: "user" });
    const assistantMessages = getL0Messages(env, "sess-1", { role: "assistant" });
    
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0].role).toBe("user");
    
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0].role).toBe("assistant");
  });

  it("限制返回数量", () => {
    const config = { ...DEFAULT_L0_CONFIG, enabled: true };
    
    for (let i = 0; i < 10; i++) {
      captureL0Message(env, "sess-1", "user", `Message ${i}`, config);
    }
    
    const messages = getL0Messages(env, "sess-1", { limit: 5 });
    expect(messages).toHaveLength(5);
  });

  it("获取最近的消息用于抽取", () => {
    const config = { ...DEFAULT_L0_CONFIG, enabled: true };
    
    for (let i = 0; i < 20; i++) {
      captureL0Message(env, "sess-1", i % 2 === 0 ? "user" : "assistant", `Message ${i}`, config);
    }
    
    const recent = getRecentL0Messages(env, "sess-1", 10);
    
    expect(recent).toHaveLength(10);
    expect(recent[0].content).toBe("Message 19");
  });

  it("删除单条消息", () => {
    const config = { ...DEFAULT_L0_CONFIG, enabled: true };
    
    const id1 = captureL0Message(env, "sess-1", "user", "Message 1", config);
    const id2 = captureL0Message(env, "sess-1", "user", "Message 2", config);
    
    deleteL0Message(env, id1!);
    
    const messages = getL0Messages(env, "sess-1");
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe(id2);
  });

  it("删除 session 的所有消息", () => {
    const config = { ...DEFAULT_L0_CONFIG, enabled: true };
    
    captureL0Message(env, "sess-1", "user", "Message 1", config);
    captureL0Message(env, "sess-1", "user", "Message 2", config);
    captureL0Message(env, "sess-2", "user", "Message 3", config);
    
    deleteL0Session(env, "sess-1");
    
    expect(getL0Messages(env, "sess-1")).toHaveLength(0);
    expect(getL0Messages(env, "sess-2")).toHaveLength(1);
  });

  it("清理过期消息", () => {
    const config = { ...DEFAULT_L0_CONFIG, enabled: true, retentionDays: -1 }; // 立即过期
    
    captureL0Message(env, "sess-1", "user", "Expired message", config);
    
    // 添加未过期的消息
    const configFuture = { ...DEFAULT_L0_CONFIG, enabled: true, retentionDays: 7 };
    captureL0Message(env, "sess-1", "user", "Fresh message", configFuture);
    
    const pruned = pruneExpiredL0Messages(env);
    
    expect(pruned).toBe(1);
    
    const remaining = getL0Messages(env, "sess-1");
    expect(remaining).toHaveLength(1);
    expect(remaining[0].content).toBe("Fresh message");
  });

  it("获取 L0 统计信息", () => {
    const config = { ...DEFAULT_L0_CONFIG, enabled: true };
    
    captureL0Message(env, "sess-1", "user", "Message 1", config);
    captureL0Message(env, "sess-1", "user", "Message 2", config);
    captureL0Message(env, "sess-2", "user", "Message 3", config);
    
    const stats = getL0Stats(env);
    
    expect(stats.total).toBe(3);
    expect(stats.bySess).toBe(2);
    expect(stats.expired).toBe(0);
  });

  it("配置控制捕获角色", () => {
    const userOnly = { ...DEFAULT_L0_CONFIG, enabled: true, captureAssistant: false };
    const assistantOnly = { ...DEFAULT_L0_CONFIG, enabled: true, captureUser: false };
    
    captureL0Message(env, "sess-1", "user", "User message", userOnly);
    captureL0Message(env, "sess-1", "assistant", "Assistant reply", userOnly);
    
    let messages = getL0Messages(env, "sess-1");
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
    
    deleteL0Session(env, "sess-1");
    
    captureL0Message(env, "sess-1", "user", "User message", assistantOnly);
    captureL0Message(env, "sess-1", "assistant", "Assistant reply", assistantOnly);
    
    messages = getL0Messages(env, "sess-1");
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("assistant");
  });

  it("保留期设置正确", () => {
    const config = { ...DEFAULT_L0_CONFIG, enabled: true, retentionDays: 3 };
    const now = Date.now();
    
    captureL0Message(env, "sess-1", "user", "Message", config);
    
    const messages = getL0Messages(env, "sess-1");
    expect(messages).toHaveLength(1);
    
    const retainedUntil = messages[0].retainedUntil!;
    const expectedRetention = now + 3 * 24 * 60 * 60 * 1000;
    
    // 允许 1 秒误差
    expect(Math.abs(retainedUntil - expectedRetention)).toBeLessThan(1000);
  });
});
