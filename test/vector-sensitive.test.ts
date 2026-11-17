/**
 * 安全修复：敏感记忆不进向量索引，已完成任务不留原文。
 * 审查发现两处缺口：
 * 1. `enqueueEmbedding` 只看 status 和向量开关，不看 is_sensitive —— 写入时
 *    insertMemory 先把原文排进 embedding_jobs，之后才打敏感标记；外部服务模式下
 *    后台 worker 会把敏感原文 POST 到 Ollama / LM Studio / OpenAI 兼容端点。
 * 2. 任务做完后 embedding_jobs.content 仍是整段原文，多一份敏感数据落盘。
 * 这里守住：写入路径、手动标记 / 取消、worker 完成、打开旧库时的历史残留清理。
 * 后端用内置 builtin（两个可选依赖都记为未安装），与机器环境无关。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MemoryEntry } from "../src/core/types";
import { openService } from "../src/host/index";
import type { WeaveService } from "../src/host/service";
import { markMemorySensitive, setMemorySensitive } from "../src/host/govern";
import { insertMemory, newId } from "../src/store/dao";
import { openWeaveDb, type WeaveEnv } from "../src/store/db";
import { ensureSchema } from "../src/store/migrate";
import {
  enqueueEmbedding,
  ensureVectorTables,
  getVectorBackend,
  resetBackendDetection,
  scrubEmbeddingResidue,
  setEmbeddingProvider,
  setVectorConfig,
  updateJobStatus,
} from "../src/store/vector";
import { setOptionalDepResolver } from "../src/store/vector-loader";
import { runVectorWorker, type EmbeddingProvider } from "../src/store/vector-worker";

const DIMENSIONS = 4;

/** 记录每次被要求 embed 的原文：这就是「发往 embedding 服务」的内容 */
function recordingProvider(): EmbeddingProvider & { seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    dimensions: DIMENSIONS,
    provider: "fake-remote",
    model: "fake-1",
    async generate(text: string): Promise<Float32Array> {
      seen.push(text);
      const v = new Float32Array(DIMENSIONS);
      v[text.length % DIMENSIONS] = 1;
      return v;
    },
  };
}

function notFound(id: string): Error {
  const e = new Error(`Cannot find module '${id}'`);
  (e as { code?: string }).code = "MODULE_NOT_FOUND";
  return e;
}

function useBuiltin(): void {
  setOptionalDepResolver((id) => {
    throw notFound(id);
  });
  resetBackendDetection();
}

function entry(content: string, extra: Partial<MemoryEntry> = {}): MemoryEntry {
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
    ...extra,
  };
}

function jobsOf(env: WeaveEnv, memoryId: string): Array<{ status: string; content: string }> {
  return env.db
    .prepare("SELECT status, content FROM embedding_jobs WHERE memory_id = ?")
    .all(memoryId) as Array<{ status: string; content: string }>;
}

function vectorCount(env: WeaveEnv, memoryId: string): number {
  return (
    env.db.prepare("SELECT COUNT(*) AS c FROM memory_embeddings WHERE memory_id = ?").get(memoryId) as { c: number }
  ).c;
}

describe("敏感记忆与向量索引（store 层）", () => {
  let env: WeaveEnv;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "weave-vec-sens-"));
    useBuiltin();
    env = openWeaveDb(dir, { readonly: false });
    ensureSchema(env);
    ensureVectorTables(env);
    setVectorConfig(env, { enabled: true, dimensions: DIMENSIONS, provider: "fake-remote", model: "fake-1" });
  });

  afterEach(() => {
    setEmbeddingProvider(null);
    setOptionalDepResolver(null);
    resetBackendDetection();
    env.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("后端是内置 builtin（两个可选依赖都未安装）", () => {
    expect(getVectorBackend(env)).toBe("builtin");
  });

  it("已标敏感的条目不入队", () => {
    const e = { ...entry("身份证 110101199003077777"), is_sensitive: 1 } as MemoryEntry;
    enqueueEmbedding(env, e);
    expect(jobsOf(env, e.id)).toEqual([]);
  });

  it("普通条目照常入队", () => {
    const e = entry("今天学会了做红烧肉");
    enqueueEmbedding(env, e);
    expect(jobsOf(env, e.id)).toHaveLength(1);
  });

  it("写入后再标敏感：待处理任务被撤掉，worker 不会把原文发出去", async () => {
    const e = entry("银行卡 6222020200112233445");
    insertMemory(env, e);
    expect(jobsOf(env, e.id)).toHaveLength(1); // 入队发生在标记之前

    markMemorySensitive(env, e.id, "fact");
    expect(jobsOf(env, e.id)).toEqual([]);

    const p = recordingProvider();
    await runVectorWorker(env, p, { retryDelayMs: 0 });
    expect(p.seen).not.toContain(e.content);
    expect(vectorCount(env, e.id)).toBe(0);
  });

  it("已生成向量的条目被标敏感：向量一并删除", async () => {
    const e = entry("我的手机号是 13800138000");
    insertMemory(env, e);
    await runVectorWorker(env, recordingProvider(), { retryDelayMs: 0 });
    expect(vectorCount(env, e.id)).toBe(1);

    setMemorySensitive(env, e.id, "fact", true);
    expect(vectorCount(env, e.id)).toBe(0);
    expect(jobsOf(env, e.id)).toEqual([]);
  });

  it("取消敏感标记：重新入队，下一轮 worker 补上向量", async () => {
    const e = entry("密码提示：小时候的狗的名字");
    insertMemory(env, e);
    setMemorySensitive(env, e.id, "fact", true);
    expect(jobsOf(env, e.id)).toEqual([]);

    setMemorySensitive(env, e.id, "fact", false);
    expect(jobsOf(env, e.id).map((j) => j.status)).toEqual(["pending"]);

    await runVectorWorker(env, recordingProvider(), { retryDelayMs: 0 });
    expect(vectorCount(env, e.id)).toBe(1);
  });

  it("向量未开启时取消标记不入队（与 enqueueEmbedding 同一闸门）", () => {
    setVectorConfig(env, { enabled: false, dimensions: DIMENSIONS, provider: "fake-remote", model: "fake-1" });
    const e = entry("普通内容");
    insertMemory(env, e);
    setMemorySensitive(env, e.id, "fact", true);
    setMemorySensitive(env, e.id, "fact", false);
    expect(jobsOf(env, e.id)).toEqual([]);
  });

  it("worker 完成后清空 content，失败的任务保留原文供重试", async () => {
    const ok = entry("周末去爬山");
    const bad = entry("这一条会失败");
    insertMemory(env, ok);
    insertMemory(env, bad);

    const p: EmbeddingProvider = {
      dimensions: DIMENSIONS,
      provider: "fake-remote",
      model: "fake-1",
      async generate(text: string): Promise<Float32Array> {
        if (text.includes("失败")) throw new Error("boom");
        const v = new Float32Array(DIMENSIONS);
        v[0] = 1;
        return v;
      },
    };
    await runVectorWorker(env, p, { retryDelayMs: 0, maxRetries: 1 });

    expect(jobsOf(env, ok.id)).toEqual([{ status: "done", content: "" }]);
    expect(jobsOf(env, bad.id)).toEqual([{ status: "failed", content: bad.content }]);
    expect(vectorCount(env, ok.id)).toBe(1);
  });

  it("导出的 updateJobStatus 标 done 时同样清空 content", () => {
    const e = entry("导出接口也要清");
    insertMemory(env, e);
    const id = (env.db.prepare("SELECT id FROM embedding_jobs WHERE memory_id = ?").get(e.id) as { id: string }).id;
    updateJobStatus(env, id, "done");
    expect(jobsOf(env, e.id)).toEqual([{ status: "done", content: "" }]);
  });

  it("打开旧库时清理历史残留：done 任务的原文、敏感条目的任务与向量", () => {
    const normal = entry("修复前完成的普通任务");
    const secret = entry("修复前留下的敏感条目 sk-example0123456789abcdefghijklmn");
    insertMemory(env, normal);
    insertMemory(env, secret);
    const now = Date.now();
    // 模拟修复前的状态：任务完成但原文没清，敏感条目仍有向量和待处理任务
    env.db.prepare("UPDATE embedding_jobs SET status = 'done' WHERE memory_id = ?").run(normal.id);
    env.db.prepare("UPDATE fact SET is_sensitive = 1 WHERE id = ?").run(secret.id);
    env.db
      .prepare(
        "INSERT INTO memory_embeddings (memory_id, level, embedding, dimensions, provider, model, created_at) VALUES (?, 'fact', ?, ?, 'x', 'y', ?)",
      )
      .run(secret.id, Buffer.alloc(DIMENSIONS * 4), DIMENSIONS, now);

    const r = scrubEmbeddingResidue(env);
    expect(r.clearedContent).toBe(1);
    expect(r.withdrawn).toBe(2); // 一条任务 + 一条向量

    expect(jobsOf(env, normal.id)).toEqual([{ status: "done", content: "" }]);
    expect(jobsOf(env, secret.id)).toEqual([]);
    expect(vectorCount(env, secret.id)).toBe(0);

    // 幂等：再跑一次什么都不改
    expect(scrubEmbeddingResidue(env)).toEqual({ clearedContent: 0, withdrawn: 0 });
  });

  it("重新打开库（ensureVectorTables）会自动做这次清理", () => {
    const e = entry("重开库也要清");
    insertMemory(env, e);
    env.db.prepare("UPDATE embedding_jobs SET status = 'done' WHERE memory_id = ?").run(e.id);
    expect(jobsOf(env, e.id)[0].content).toBe(e.content);

    ensureVectorTables(env);
    expect(jobsOf(env, e.id)[0].content).toBe("");
  });
});

describe("敏感记忆与向量索引（vectra 后端的历史残留）", () => {
  let env: WeaveEnv;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "weave-vec-sens-vectra-"));
    // 只让 vectra 可解析：后端稳定为 vectra，向量在 index.json 里而不在 SQLite
    setOptionalDepResolver((id) => {
      if (id === "vectra") return { LocalIndex: class {} };
      throw notFound(id);
    });
    resetBackendDetection();
    env = openWeaveDb(dir, { readonly: false });
    ensureSchema(env);
    ensureVectorTables(env);
    setVectorConfig(env, { enabled: true, dimensions: DIMENSIONS, provider: "fake-remote", model: "fake-1" });
  });

  afterEach(() => {
    setOptionalDepResolver(null);
    resetBackendDetection();
    env.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("index.json 里敏感条目的向量被删掉，普通条目保留", () => {
    expect(getVectorBackend(env)).toBe("vectra");
    const plain = entry("普通条目");
    const secret = entry("敏感条目");
    insertMemory(env, plain);
    insertMemory(env, secret);
    env.db.prepare("UPDATE fact SET is_sensitive = 1 WHERE id = ?").run(secret.id);

    const idxDir = join(dir, "vector-index");
    mkdirSync(idxDir, { recursive: true });
    const file = join(idxDir, "index.json");
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        items: [
          { id: plain.id, vector: [1, 0, 0, 0], metadata: {} },
          { id: secret.id, vector: [0, 1, 0, 0], metadata: {} },
        ],
      }),
    );

    const r = scrubEmbeddingResidue(env);
    expect(r.withdrawn).toBeGreaterThanOrEqual(1);
    const ids = (JSON.parse(readFileSync(file, "utf8")) as { items: Array<{ id: string }> }).items.map((i) => i.id);
    expect(ids).toEqual([plain.id]);
  });
});

describe("敏感记忆与向量索引（写入路径端到端）", () => {
  let dir: string;
  let env: WeaveEnv;
  let service: WeaveService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "weave-vec-sens-svc-"));
    useBuiltin();
    // 与隐私集成用例相同：关掉治理层的 PII 拦截，让写入走到「检测 → 标记」这一步
    const rt = openService(dir, {
      governance: {
        autoAcceptLowRisk: true,
        undoWindowHours: 72,
        requireConfirmFor: [],
        disabledSensitive: ["phone", "id-card", "bank-card"],
      },
      privacy: { enabled: true, strictMode: false, detectPII: true, filterOnRecall: true, whitelist: [] },
    });
    env = rt.env;
    service = rt.service;
    ensureVectorTables(env);
    setVectorConfig(env, { enabled: true, dimensions: DIMENSIONS, provider: "fake-remote", model: "fake-1" });
  });

  afterEach(() => {
    setEmbeddingProvider(null);
    setOptionalDepResolver(null);
    resetBackendDetection();
    service.stopMirror(false);
    env.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("remember 写入含手机号的记忆：被标敏感，且原文不会被发往 embedding 服务", async () => {
    const secret = "我的手机号是 13912345678";
    const out = await service.remember({ level: "fact", content: secret }, "human");
    expect(out.ok).toBe(true);
    const id = out.id!;

    expect(service.getSensitiveMemories("fact").some((m) => m.id === id)).toBe(true);
    expect(jobsOf(env, id)).toEqual([]);

    const plain = await service.remember({ level: "fact", content: "周三下午开组会" }, "human");
    const p = recordingProvider();
    await runVectorWorker(env, p, { retryDelayMs: 0 });

    expect(p.seen).toContain("周三下午开组会");
    expect(p.seen.some((t) => t.includes("13912345678"))).toBe(false);
    expect(vectorCount(env, id)).toBe(0);
    expect(vectorCount(env, plain.id!)).toBe(1);
  });
});
