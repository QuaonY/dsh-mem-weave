/**
 * 向量后端管理测试
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WeaveService, defaultConfig } from "../src/host/service";
import { openWeaveDb, type WeaveEnv } from "../src/store/db";
import { ensureSchema } from "../src/store/migrate";
import { countVectraItems, deleteVectraItemSync } from "../src/store/vector";
import { loadOptionalDep } from "../src/store/vector-loader";

describe("向量后端", () => {
  let env: WeaveEnv;
  let svc: WeaveService;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "weave-vec-test-"));
    env = openWeaveDb(tmpDir, { readonly: false });
    ensureSchema(env);
    svc = new WeaveService(env, defaultConfig(tmpDir));
  });

  afterEach(() => {
    env.db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("status 包含向量后端信息", () => {
    const status = svc.status();
    
    // 检查向量后端字段存在
    expect(status.vectorBackend).toBeDefined();
    expect(["sqlite-vec", "vectra", "builtin", "disabled"]).toContain(status.vectorBackend);
    
    // 如果有后端可用，应该有统计信息
    if (status.vectorBackend !== "disabled") {
      expect(status.vectorStats).toBeDefined();
      expect(status.vectorStats?.indexed).toBeGreaterThanOrEqual(0);
      expect(status.vectorStats?.pending).toBeGreaterThanOrEqual(0);
      expect(status.vectorStats?.failed).toBeGreaterThanOrEqual(0);
      expect(status.vectorStats?.totalActive).toBeGreaterThanOrEqual(0);
    }
  });

  it("getVectorBackendStatus 返回详细信息", () => {
    const backendStatus = svc.getVectorBackendStatus();
    
    expect(backendStatus.backend).toBeDefined();
    expect(["sqlite-vec", "vectra", "builtin", "disabled"]).toContain(backendStatus.backend);
    expect(backendStatus.available).toBeDefined();
    expect(typeof backendStatus.available.sqliteVec).toBe("boolean");
    expect(typeof backendStatus.available.vectra).toBe("boolean");
    expect(typeof backendStatus.canRetry).toBe("boolean");
    expect(backendStatus.stats).toBeDefined();
  });

  it("retryVectorBackend 可以重新检测后端", () => {
    const result = svc.retryVectorBackend();
    
    expect(result.ok).toBeDefined();
    expect(["sqlite-vec", "vectra", "builtin", "disabled"]).toContain(result.before);
    expect(["sqlite-vec", "vectra", "builtin", "disabled"]).toContain(result.after);
    expect(typeof result.message).toBe("string");
    
    // 如果没有更好的后端，ok 应该是 false
    if (!result.ok) {
      expect(result.before).toBe(result.after);
    }
  });

  it("clearVectorIndex 可以清空向量索引", async () => {
    const backendStatus = svc.getVectorBackendStatus();
    
    // 只在有可用后端时测试
    if (backendStatus.backend !== "disabled") {
      const result = await svc.clearVectorIndex("test-actor");
      expect(result.ok).toBe(true);
      expect(result.message).toContain(backendStatus.backend);
    } else {
      // 禁用状态应该返回失败
      const result = await svc.clearVectorIndex("test-actor");
      expect(result.ok).toBe(false);
    }
  });

  it("向量后端优先级：sqlite-vec > vectra > builtin > disabled", () => {
    const backendStatus = svc.getVectorBackendStatus();
    
    // 如果 sqlite-vec 可用，应该优先使用
    if (backendStatus.available.sqliteVec) {
      expect(backendStatus.backend).toBe("sqlite-vec");
    }
    // 否则如果 vectra 可用，应该使用 vectra
    else if (backendStatus.available.vectra) {
      expect(backendStatus.backend).toBe("vectra");
    }
    // 都没有时用包内自带的 builtin，而不是禁用
    else {
      expect(backendStatus.backend).toBe("builtin");
    }
  });

  // 此前 vectra 的 indexed 恒为 0，设置页永远显示「0 / N」
  // 语义召回实际可用却看起来没收索引。现在直接读索引文件计数。
  it("countVectraItems 按 index.json 的 items 计数，坏文件回 0", () => {
    // 还没有索引目录
    expect(countVectraItems(tmpDir)).toBe(0);
    mkdirSync(join(tmpDir, "vector-index"), { recursive: true });
    writeFileSync(
      join(tmpDir, "vector-index", "index.json"),
      JSON.stringify({ version: 1, items: [{ id: "a" }, { id: "b" }, { id: "c" }] }),
      "utf8",
    );
    expect(countVectraItems(tmpDir)).toBe(3);
    // JSON 坏掉不能把 status 拖崩
    writeFileSync(join(tmpDir, "vector-index", "index.json"), "{not json", "utf8");
    expect(countVectraItems(tmpDir)).toBe(0);
  });

  it("countVectraItems 与 vectra 自己写出的索引一致", async (ctx) => {
    const dep = loadOptionalDep<{ LocalIndex: new (p: string) => any }>("vectra");
    if (!dep.available || !dep.mod) {
      ctx.skip();
      return;
    }
    const index = new dep.mod.LocalIndex(join(tmpDir, "vector-index"));
    await index.createIndex({ version: 1 });
    await index.upsertItem({ id: "m1", vector: [0.1, 0.2, 0.3], metadata: { level: "fact" } });
    await index.upsertItem({ id: "m2", vector: [0.2, 0.3, 0.4], metadata: { level: "fact" } });
    expect(countVectraItems(tmpDir)).toBe(2);
  });

  // 此前 vectra 分支只留一句注释，forget 之后向量一直留在 index.json 里。
  it("deleteVectraItemSync 从 index.json 删掉条目，其它字段原样保留", () => {
    mkdirSync(join(tmpDir, "vector-index"), { recursive: true });
    const file = join(tmpDir, "vector-index", "index.json");
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        metadata_config: { keep: true },
        items: [{ id: "a" }, { id: "b" }, { id: "c" }],
      }),
      "utf8",
    );

    deleteVectraItemSync(env, "b");

    const raw = JSON.parse(readFileSync(file, "utf8"));
    expect(raw.items.map((i: { id: string }) => i.id)).toEqual(["a", "c"]);
    expect(raw.version).toBe(1);
    expect(raw.metadata_config).toEqual({ keep: true });
    expect(countVectraItems(tmpDir)).toBe(2);
    // 幂等：再删一次不报错、不改动
    deleteVectraItemSync(env, "b");
    expect(countVectraItems(tmpDir)).toBe(2);
  });

  it("deleteVectraItemSync 对不存在 / 损坏的索引文件安静返回", () => {
    expect(() => deleteVectraItemSync(env, "whatever")).not.toThrow();
    mkdirSync(join(tmpDir, "vector-index"), { recursive: true });
    const file = join(tmpDir, "vector-index", "index.json");
    writeFileSync(file, "{not json", "utf8");
    expect(() => deleteVectraItemSync(env, "whatever")).not.toThrow();
  });

  it("deleteVectraItemSync 与真实 vectra 索引一致", async (ctx) => {
    const dep = loadOptionalDep<{ LocalIndex: new (p: string) => any }>("vectra");
    if (!dep.available || !dep.mod) {
      ctx.skip();
      return;
    }
    const indexPath = join(tmpDir, "vector-index");
    const index = new dep.mod.LocalIndex(indexPath);
    await index.createIndex({ version: 1 });
    await index.upsertItem({ id: "keep", vector: [0.1, 0.2, 0.3], metadata: { level: "fact" } });
    await index.upsertItem({ id: "drop", vector: [0.2, 0.3, 0.4], metadata: { level: "fact" } });

    deleteVectraItemSync(env, "drop");

    // 新实例从磁盘读：被删的条目不在列表里，留下的仍可查询
    const reopened = new dep.mod.LocalIndex(indexPath);
    const ids = (await reopened.listItems()).map((i: { id: string }) => i.id);
    expect(ids).toEqual(["keep"]);
    const hits = await reopened.queryItems([0.1, 0.2, 0.3], "", 5);
    expect(hits.map((h: { item: { id: string } }) => h.item.id)).toEqual(["keep"]);
  });
});
