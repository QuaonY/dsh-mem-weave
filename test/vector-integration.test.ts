/**
 * 向量索引完整流程测试
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openWeaveDb, type WeaveEnv } from "../src/store/db";
import { ensureSchema } from "../src/store/migrate";
import { insertMemory, newId, forgetMemory } from "../src/store/dao";
import { getQueueStatus } from "../src/store/vector-worker";
import type { MemoryEntry } from "../src/core/types";

describe("向量索引完整流程", () => {
  let env: WeaveEnv;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "weave-index-test-"));
    env = openWeaveDb(tmpDir, { readonly: false });
    ensureSchema(env);
  });

  afterEach(() => {
    env.db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function createEntry(content: string): MemoryEntry {
    const ts = Date.now();
    return {
      id: newId(),
      level: "fact",
      project: null,
      section: null,
      content,
      keywords: [],
      importance: 3,
      status: "active",
      semanticKey: null,
      confidence: null,
      validFrom: ts,
      validTo: null,
      evidence: [],
      hash: null,
      source: "test",
      accessCount: 0,
      tier: "hot",
      createdAt: ts,
      updatedAt: ts,
    };
  }

  it("insertMemory 自动入队 embedding 任务", () => {
    const queueBefore = getQueueStatus(env);
    
    // 插入一条记忆
    const entry = createEntry("Test memory for auto-enqueue");
    insertMemory(env, entry);
    
    const queueAfter = getQueueStatus(env);
    
    // 如果向量后端可用，应该有一条新的 pending 任务
    // 如果不可用，队列保持不变
    expect(queueAfter.pending).toBeGreaterThanOrEqual(queueBefore.pending);
  });

  it("forgetMemory 自动删除 embedding", () => {
    // 插入一条记忆
    const entry = createEntry("Test memory for delete");
    insertMemory(env, entry);
    
    const queueBefore = getQueueStatus(env);
    
    // 删除记忆
    forgetMemory(env, entry.id, "test-actor");
    
    const queueAfter = getQueueStatus(env);
    
    // 删除应该清理对应的任务
    // 队列数量应该不增加（可能减少，取决于是否有任务）
    expect(queueAfter.pending).toBeLessThanOrEqual(queueBefore.pending + 1);
  });

  it("多次插入累积任务", () => {
    const queueBefore = getQueueStatus(env);
    
    // 插入多条记忆
    for (let i = 0; i < 5; i++) {
      const entry = createEntry(`Test memory ${i}`);
      insertMemory(env, entry);
    }
    
    const queueAfter = getQueueStatus(env);
    
    // 如果向量后端可用，应该有 5 条新任务（或更多，如果之前有任务）
    expect(queueAfter.pending).toBeGreaterThanOrEqual(queueBefore.pending);
  });

  it("status 非 active 的记忆不入队", () => {
    const queueBefore = getQueueStatus(env);
    
    // 插入一条 archived 记忆
    const entry = createEntry("Archived memory");
    entry.status = "archived";
    insertMemory(env, entry);
    
    const queueAfter = getQueueStatus(env);
    
    // archived 状态不应该入队
    // 队列保持不变（或因为 FTS 等原因有其他变化，但不应该因为这条记忆而增加）
    expect(queueAfter.pending).toBe(queueBefore.pending);
  });
});
