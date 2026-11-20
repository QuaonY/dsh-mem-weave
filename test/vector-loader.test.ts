/**
 * 可选向量依赖加载器
 * 重点不是「装没装」，而是把「没装」与「装了但加载失败」分开：
 * 旧实现的 require + catch {} 会把两种都吞成 disabled。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadOptionalDep,
  markOptionalDepFailure,
  optionalDepStatus,
  resetOptionalDepCache,
  setOptionalDepResolver,
} from "../src/store/vector-loader";
import { detectBestBackend, getVectorBackend, getVectorConfig, resetBackendDetection, setVectorConfig } from "../src/store/vector";
import { insertMemory, newId } from "../src/store/dao";
import type { MemoryEntry } from "../src/core/types";
import { WeaveService, defaultConfig } from "../src/host/service";
import { openWeaveDb, type WeaveEnv } from "../src/store/db";
import { ensureSchema } from "../src/store/migrate";

function moduleNotFound(name: string): Error {
  const e = new Error("Cannot find module '" + name + "'") as Error & { code?: string };
  e.code = "MODULE_NOT_FOUND";
  return e;
}

/** 只是给 checkSqliteVec 的 load 一个参数，不真的用 */
const fakeEnv = { db: {} } as unknown as WeaveEnv;

afterEach(() => {
  setOptionalDepResolver(null);
  resetOptionalDepCache();
  resetBackendDetection();
});

describe("vector-loader：解析与缓存", () => {
  it("解析成功时返回模块本体", () => {
    const mod = { load: () => undefined };
    setOptionalDepResolver(() => mod);
    const r = loadOptionalDep("sqlite-vec");
    expect(r.available).toBe(true);
    expect(r.reason).toBeNull();
    expect(r.error).toBeNull();
    expect(r.mod).toBe(mod);
  });

  it("MODULE_NOT_FOUND 记为 not-installed（常态）", () => {
    setOptionalDepResolver((id) => {
      throw moduleNotFound(id);
    });
    const r = loadOptionalDep("vectra");
    expect(r.available).toBe(false);
    expect(r.reason).toBe("not-installed");
    expect(r.error).toContain("Cannot find module");
  });

  it("其它异常记为 load-failed（装了但坏）", () => {
    setOptionalDepResolver(() => {
      throw Object.assign(new Error("invalid ELF header"), { code: "ERR_DLOPEN_FAILED" });
    });
    const r = loadOptionalDep("sqlite-vec");
    expect(r.available).toBe(false);
    expect(r.reason).toBe("load-failed");
    expect(r.error).toContain("invalid ELF header");
  });

  it("结果按进程缓存，只解析一次", () => {
    let calls = 0;
    setOptionalDepResolver(() => {
      calls += 1;
      return { load: () => undefined };
    });
    loadOptionalDep("sqlite-vec");
    loadOptionalDep("sqlite-vec");
    optionalDepStatus("sqlite-vec");
    expect(calls).toBe(1);
  });

  it("resetOptionalDepCache 之后重新解析", () => {
    let calls = 0;
    setOptionalDepResolver(() => {
      calls += 1;
      throw moduleNotFound("vectra");
    });
    loadOptionalDep("vectra");
    resetOptionalDepCache();
    loadOptionalDep("vectra");
    expect(calls).toBe(2);
  });

  it("markOptionalDepFailure 覆盖已解析的模块", () => {
    setOptionalDepResolver(() => ({ load: () => undefined }));
    expect(loadOptionalDep("sqlite-vec").available).toBe(true);
    markOptionalDepFailure("sqlite-vec", new Error("load_extension failed"));
    const r = optionalDepStatus("sqlite-vec");
    expect(r.available).toBe(false);
    expect(r.reason).toBe("load-failed");
    expect(r.error).toContain("load_extension failed");
  });
});

describe("vector-loader：后端检测不再静默", () => {
  it("sqlite-vec 装上但 load 抛错 → 记录 load-failed，并降到内置后端", () => {
    setOptionalDepResolver((id) => {
      if (id === "sqlite-vec") {
        return {
          load: () => {
            throw new Error("no such module: vec0");
          },
        };
      }
      throw moduleNotFound(id);
    });
    resetBackendDetection();
    expect(detectBestBackend(fakeEnv)).toBe("builtin");
    const status = optionalDepStatus("sqlite-vec");
    expect(status.reason).toBe("load-failed");
    expect(status.error).toContain("vec0");
  });

  it("MEMWEAVE_VECTOR_BACKEND=off 时才真正禁用（用户主动关闭）", () => {
    const prev = process.env.MEMWEAVE_VECTOR_BACKEND;
    process.env.MEMWEAVE_VECTOR_BACKEND = "off";
    try {
      resetBackendDetection();
      expect(detectBestBackend(fakeEnv)).toBe("disabled");
    } finally {
      if (prev === undefined) delete process.env.MEMWEAVE_VECTOR_BACKEND;
      else process.env.MEMWEAVE_VECTOR_BACKEND = prev;
      resetBackendDetection();
    }
  });

  it("只装了 vectra 时降级到 vectra", () => {
    const LocalIndex = function LocalIndex() {};
    setOptionalDepResolver((id) => {
      if (id === "vectra") return { LocalIndex };
      throw moduleNotFound(id);
    });
    resetBackendDetection();
    expect(detectBestBackend(fakeEnv)).toBe("vectra");
  });
});

describe("vector-loader：服务状态透出原因", () => {
  it("getVectorBackendStatus.detail 与 available 一致，并把未安装的依赖标出来", () => {
    const dir = mkdtempSync(join(tmpdir(), "weave-vec-loader-"));
    const env = openWeaveDb(dir, { readonly: false });
    ensureSchema(env);
    // 迁移时已经探测过一次（缓存为 disabled）：先换解析器再清缓存
    setOptionalDepResolver((id) => {
      if (id === "sqlite-vec") return { load: () => undefined };
      throw moduleNotFound(id);
    });
    resetBackendDetection();
    try {
      const svc = new WeaveService(env, defaultConfig(dir));
      const st = svc.getVectorBackendStatus();
      expect(st.backend).toBe("sqlite-vec");
      expect(st.available).toEqual({ sqliteVec: true, vectra: false });
      expect(st.detail.sqliteVec).toMatchObject({ available: true, reason: null });
      expect(st.detail.vectra).toMatchObject({ available: false, reason: "not-installed" });
      expect(st.canRetry).toBe(false);
    } finally {
      env.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function mem(over: Partial<MemoryEntry> = {}): MemoryEntry {
  const now = Date.now();
  return {
    id: newId(),
    level: "fact",
    project: null,
    section: null,
    content: "向量开关样本：项目使用 SQLite",
    keywords: ["向量"],
    importance: 3,
    status: "active",
    semanticKey: null,
    confidence: null,
    validFrom: now,
    validTo: null,
    evidence: [],
    hash: null,
    source: "human",
    accessCount: 0,
    tier: "hot",
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

describe("vector-loader：后端可用 ≠ 功能开启", () => {
  it("vector_config 未开启时写入不入队，开启后才入队", () => {
    const dir = mkdtempSync(join(tmpdir(), "weave-vec-gate-"));
    // 先换假解析器再迁移，表才会随 sqlite-vec 后端建出来（不依赖本机是否装了原生扩展）
    setOptionalDepResolver((id) => {
      if (id === "sqlite-vec") return { load: () => undefined };
      throw moduleNotFound(id);
    });
    resetBackendDetection();
    const env = openWeaveDb(dir, { readonly: false });
    const jobCount = () =>
      (env.db.prepare("SELECT COUNT(*) AS c FROM embedding_jobs").get() as { c: number }).c;
    try {
      ensureSchema(env);
      expect(getVectorBackend(env)).toBe("sqlite-vec");

      insertMemory(env, mem());
      expect(jobCount()).toBe(0);

      setVectorConfig(env, { enabled: true, dimensions: 384 });
      insertMemory(env, mem());
      expect(jobCount()).toBe(1);
    } finally {
      env.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("未开启时 rebuildVectorIndex 不清空已有队列", async () => {
    const dir = mkdtempSync(join(tmpdir(), "weave-vec-rebuild-off-"));
    setOptionalDepResolver((id) => {
      if (id === "sqlite-vec") return { load: () => undefined };
      throw moduleNotFound(id);
    });
    resetBackendDetection();
    const env = openWeaveDb(dir, { readonly: false });
    const jobCount = () =>
      (env.db.prepare("SELECT COUNT(*) AS c FROM embedding_jobs").get() as { c: number }).c;
    try {
      ensureSchema(env);
      setVectorConfig(env, { enabled: false, dimensions: 384 });
      env.db
        .prepare(
          "INSERT INTO embedding_jobs (id, memory_id, level, content, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)",
        )
        .run("j1", "m1", "fact", "c", Date.now());

      const r = await new WeaveService(env, defaultConfig(dir)).rebuildVectorIndex();
      expect(r.ok).toBe(false);
      expect(r.enqueued).toBe(0);
      expect(jobCount()).toBe(1); // 没有被 clearAllVectorsAsync 顺手清掉
    } finally {
      env.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("开启后 rebuildVectorIndex 清空旧队列并按活跃条目重新入队", async () => {
    const dir = mkdtempSync(join(tmpdir(), "weave-vec-rebuild-on-"));
    setOptionalDepResolver((id) => {
      if (id === "sqlite-vec") return { load: () => undefined };
      throw moduleNotFound(id);
    });
    resetBackendDetection();
    const env = openWeaveDb(dir, { readonly: false });
    const jobCount = () =>
      (env.db.prepare("SELECT COUNT(*) AS c FROM embedding_jobs").get() as { c: number }).c;
    try {
      ensureSchema(env);
      insertMemory(env, mem());
      insertMemory(env, mem());
      env.db
        .prepare(
          "INSERT INTO embedding_jobs (id, memory_id, level, content, status, created_at) VALUES (?, ?, ?, ?, 'failed', ?)",
        )
        .run("stale", "m-old", "fact", "c", Date.now());
      setVectorConfig(env, { enabled: true, dimensions: 384 });

      const r = await new WeaveService(env, defaultConfig(dir)).rebuildVectorIndex();
      expect(r.ok).toBe(true);
      expect(r.enqueued).toBe(2);
      expect(jobCount()).toBe(2);
    } finally {
      env.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("setVectorConfig：部分更新不清空现值", () => {
  function open() {
    const dir = mkdtempSync(join(tmpdir(), "weave-vec-cfg-"));
    const env = openWeaveDb(dir, { readonly: false });
    ensureSchema(env);
    return { dir, env };
  }

  function reindexFlag(env: WeaveEnv): number {
    const row = env.db.prepare("SELECT needs_reindex FROM vector_config WHERE id = 1").get() as
      | { needs_reindex: number }
      | undefined;
    return row?.needs_reindex ?? 0;
  }

  it("只改 enabled 时 dimensions/provider/model 沿用现值", () => {
    const { dir, env } = open();
    try {
      setVectorConfig(env, {
        enabled: true,
        dimensions: 768,
        provider: "openai-compatible",
        model: "text-embedding-3-small",
      });
      setVectorConfig(env, { enabled: false });

      const cfg = getVectorConfig(env)!;
      expect(cfg.enabled).toBe(false);
      expect(cfg.dimensions).toBe(768);
      expect(cfg.provider).toBe("openai-compatible");
      expect(cfg.model).toBe("text-embedding-3-small");
    } finally {
      env.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("无关更新不误触发也不清掉 needs_reindex", () => {
    const { dir, env } = open();
    try {
      setVectorConfig(env, { enabled: true, dimensions: 384, provider: "ollama", model: "nomic-embed-text" });
      expect(reindexFlag(env)).toBe(0);

      // 只开关 enabled：不应被当成换模型
      setVectorConfig(env, { enabled: false });
      expect(reindexFlag(env)).toBe(0);

      // 换维度：置位
      setVectorConfig(env, { dimensions: 1024 });
      expect(reindexFlag(env)).toBe(1);

      // 之后的无关更新不能把挂起的重建标记清掉
      setVectorConfig(env, { enabled: true });
      expect(reindexFlag(env)).toBe(1);
      expect(getVectorConfig(env)!.dimensions).toBe(1024);
    } finally {
      env.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("首次部分写入用缺省值", () => {
    const { dir, env } = open();
    try {
      setVectorConfig(env, { enabled: true });
      const cfg = getVectorConfig(env)!;
      expect(cfg.enabled).toBe(true);
      expect(cfg.dimensions).toBe(384);
      expect(cfg.provider).toBeUndefined();
      expect(cfg.model).toBeUndefined();
    } finally {
      env.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
