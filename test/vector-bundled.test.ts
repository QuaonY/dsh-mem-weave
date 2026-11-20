/**
 * 包内自带 sqlite-vec 二进制（不再要求用户自己装 optionalDependency）。
 * 三件事要分别验证，缺一件都可能「看起来带了、实际没用上」：
 *   1. 路径解析（平台/架构映射、显式覆盖、缺失时返回 null）
 *   2. 真的能加载（宿主 `DatabaseSync` 允许扩展时，vec0 扩展装得上）
 *   3. 加载后检索口径与 builtin 一致（维度不匹配的行跳过，而不是整条查询报错）
 * 第 2/3 步依赖宿主 Node 是否支持扩展加载（`allowExtension`，Node >= 22.13）
 * 不支持时用例自动跳过，而不是假装通过。
 */
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { MemoryEntry } from "../src/core/types";
import { WeaveService, defaultConfig } from "../src/host/service";
import { insertMemory, newId } from "../src/store/dao";
import { openWeaveDb, type WeaveEnv } from "../src/store/db";
import { ensureSchema } from "../src/store/migrate";
import {
  bundledVecDir,
  bundledVecPath,
  detectBestBackend,
  ensureVectorTables,
  getVectorBackend,
  resetBackendDetection,
  searchVectors,
  storeEmbedding,
} from "../src/store/vector";
import { resetOptionalDepCache } from "../src/store/vector-loader";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const vendorDir = join(repoRoot, "vendor", "sqlite-vec");
const vendorBinary = bundledVecPath({ baseDir: vendorDir });

function vecFileName(platform: NodeJS.Platform): string {
  if (platform === "win32") return "vec0.dll";
  if (platform === "darwin") return "vec0.dylib";
  return "vec0.so";
}

/** 宿主 Node 是否真的能加载扩展（与 `openWeaveDb` 的 allowExtension 一起判定） */
function hostCanLoadExtension(binary: string): boolean {
  const dir = mkdtempSync(join(tmpdir(), "weave-vec-probe-"));
  try {
    const probe = openWeaveDb(dir, { memory: true });
    try {
      const db = probe.db as { loadExtension?: (p: string) => void };
      if (typeof db.loadExtension !== "function") return false;
      db.loadExtension(binary);
      return true;
    } finally {
      probe.db.close();
    }
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function createEntry(
  content: string,
  level: MemoryEntry["level"] = "fact",
  project: string | null = null,
): MemoryEntry {
  const ts = Date.now();
  return {
    id: newId(),
    level,
    project,
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

afterEach(() => {
  delete process.env.MEMWEAVE_SQLITE_VEC_PATH;
  resetBackendDetection();
  resetOptionalDepCache();
});

describe("内置 sqlite-vec：路径解析", () => {
  it("按 platform-arch 映射到 vendor 目录名", () => {
    expect(bundledVecDir("win32", "x64")).toBe("win32-x64");
    expect(bundledVecDir("win32", "arm64")).toBeNull(); // sqlite-vec 没有 win32-arm64 预编译
    expect(bundledVecDir("linux", "x64")).toBe("linux-x64");
    expect(bundledVecDir("linux", "arm64")).toBe("linux-arm64");
    expect(bundledVecDir("darwin", "arm64")).toBe("darwin-arm64");
    expect(bundledVecDir("darwin", "x64")).toBe("darwin-x64");
    expect(bundledVecDir("freebsd", "x64")).toBeNull();
    expect(bundledVecDir("linux", "ia32")).toBeNull();
  });

  it("目录里有二进制才返回路径，没有则 null", () => {
    const base = mkdtempSync(join(tmpdir(), "weave-vec-native-"));
    try {
      const dir = bundledVecDir("linux", "x64")!;
      expect(bundledVecPath({ platform: "linux", arch: "x64", baseDir: base })).toBeNull();
      mkdirSync(join(base, dir), { recursive: true });
      writeFileSync(join(base, dir, "vec0.so"), "not-a-real-so");
      expect(bundledVecPath({ platform: "linux", arch: "x64", baseDir: base })).toBe(
        join(base, dir, "vec0.so"),
      );
      // 不支持的平台即便有文件也不认
      expect(bundledVecPath({ platform: "freebsd", arch: "x64", baseDir: base })).toBeNull();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("MEMWEAVE_SQLITE_VEC_PATH 显式指定优先", () => {
    const dir = mkdtempSync(join(tmpdir(), "weave-vec-explicit-"));
    try {
      const explicit = join(dir, "my-vec0.custom");
      writeFileSync(explicit, "x");
      process.env.MEMWEAVE_SQLITE_VEC_PATH = explicit;
      expect(bundledVecPath()).toBe(explicit);
      // 指向不存在的文件时不生效，继续按平台找
      process.env.MEMWEAVE_SQLITE_VEC_PATH = join(dir, "missing.custom");
      expect(bundledVecPath()).not.toBe(join(dir, "missing.custom"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("仓库里带着当前平台的二进制", () => {
    const dir = bundledVecDir();
    if (!dir) return; // 未支持平台：由 builtin 兜底，不算失败
    expect(vendorBinary).toBe(join(vendorDir, dir, vecFileName(process.platform)));
    expect(existsSync(vendorBinary!)).toBe(true);
  });

  it("构建产物里的 lib/native 与 vendor 一致（构建后才校验）", () => {
    const builtEntry = join(repoRoot, "lib", "index.js");
    if (!existsSync(builtEntry)) return; // 没跑过 build：跳过
    const dir = bundledVecDir();
    if (!dir) return;
    const packaged = join(repoRoot, "lib", "native", dir, vecFileName(process.platform));
    expect(existsSync(packaged)).toBe(true);
  });
});

const canLoad = !!vendorBinary && hostCanLoadExtension(vendorBinary);

describe.skipIf(!canLoad)("内置 sqlite-vec：真实加载与检索", () => {
  let env: WeaveEnv;
  let tmpDir: string;

  function open(): void {
    process.env.MEMWEAVE_SQLITE_VEC_PATH = vendorBinary!;
    resetBackendDetection();
    tmpDir = mkdtempSync(join(tmpdir(), "weave-vec-bundled-"));
    env = openWeaveDb(tmpDir, { readonly: false });
    ensureSchema(env);
    ensureVectorTables(env);
  }

  afterEach(() => {
    try {
      env.db.close();
    } catch {
      // 已关闭
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("自带二进制加载成功后后端为 sqlite-vec，且能按余弦距离召回", () => {
    open();
    expect(detectBestBackend(env)).toBe("sqlite-vec");

    // 状态接口要认「包内二进制」，不能因为 npm 包没装就说 not-installed
    const status = new WeaveService(env, defaultConfig(tmpDir)).getVectorBackendStatus();
    expect(status.sqliteVecSource).toBe("bundled");
    expect(status.available.sqliteVec).toBe(true);
    expect(status.detail.sqliteVec.reason).toBeNull();

    const cat = createEntry("用户喜欢猫");
    const dog = createEntry("用户养了两只狗");
    const deploy = createEntry("部署脚本放在 scripts/ 下");
    for (const e of [cat, dog, deploy]) insertMemory(env, e);

    storeEmbedding(env, cat.id, "fact", new Float32Array([1, 0, 0, 0]));
    storeEmbedding(env, dog.id, "fact", new Float32Array([0, 1, 0, 0]));
    storeEmbedding(env, deploy.id, "fact", new Float32Array([0, 0, 1, 0]));

    const hits = searchVectors(env, new Float32Array([1, 0, 0, 0]), { topK: 3, minScore: 0.9 });
    expect(hits.map((h) => h.id)).toEqual([cat.id]);
    expect(hits[0].distance).toBeCloseTo(0, 5);
  });

  it("维度不匹配的旧索引被跳过，不会让整次查询返回空", () => {
    open();

    const old = createEntry("旧模型索引的记忆");
    const fresh = createEntry("新模型索引的记忆");
    insertMemory(env, old);
    insertMemory(env, fresh);

    // 换过 embedding 模型：一条 4 维、一条 8 维
    storeEmbedding(env, old.id, "fact", new Float32Array(8).fill(0.5));
    storeEmbedding(env, fresh.id, "fact", new Float32Array([1, 0, 0, 0]));

    const hits = searchVectors(env, new Float32Array([1, 0, 0, 0]), { topK: 5, minScore: 0.5 });
    expect(hits.map((h) => h.id)).toEqual([fresh.id]);
  });

  it("非 active 的记忆不会被召回", () => {
    open();

    const active = createEntry("仍在用的记忆");
    const archived = createEntry("已归档的记忆");
    insertMemory(env, active);
    insertMemory(env, archived);
    env.db.prepare("UPDATE fact SET status = 'archived' WHERE id = ?").run(archived.id);

    storeEmbedding(env, active.id, "fact", new Float32Array([1, 0, 0, 0]));
    storeEmbedding(env, archived.id, "fact", new Float32Array([1, 0, 0, 0]));

    const hits = searchVectors(env, new Float32Array([1, 0, 0, 0]), { topK: 5, minScore: 0.5 });
    expect(hits.map((h) => h.id)).toEqual([active.id]);
  });

  it("level / project 过滤与 builtin 口径一致", () => {
    open();

    const factAlpha = createEntry("甲项目的事实", "fact", "alpha");
    const factBeta = createEntry("乙项目的事实", "fact", "beta");
    const lessonAlpha = createEntry("甲项目的教训", "lesson", "alpha");
    for (const e of [factAlpha, factBeta, lessonAlpha]) {
      insertMemory(env, e);
      storeEmbedding(env, e.id, e.level, new Float32Array([1, 0, 0, 0]));
    }

    const q = new Float32Array([1, 0, 0, 0]);
    const ids = (opts: Parameters<typeof searchVectors>[2]) =>
      searchVectors(env, q, { minScore: 0.5, topK: 10, ...opts }).map((h) => h.id).sort();

    expect(ids({})).toEqual([factAlpha.id, factBeta.id, lessonAlpha.id].sort());
    expect(ids({ level: "fact" })).toEqual([factAlpha.id, factBeta.id].sort());
    expect(ids({ project: "alpha" })).toEqual([factAlpha.id, lessonAlpha.id].sort());
    expect(ids({ level: "fact", project: "alpha" })).toEqual([factAlpha.id]);
    // 空字符串 = 只匹配无项目的记忆
    expect(ids({ project: "" })).toEqual([]);
  });

  it("恢复备份后向量后端重新探测，检索仍可用", async () => {
    open();
    const service = new WeaveService(env, defaultConfig(tmpDir));
    expect(detectBestBackend(env)).toBe("sqlite-vec");

    const cat = createEntry("用户喜欢猫");
    insertMemory(env, cat);
    storeEmbedding(env, cat.id, "fact", new Float32Array([1, 0, 0, 0]));

    const backupPath = env.backup("vec-restore-test");
    const result = await service.restoreBackup(backupPath, "test");
    expect(result.ok).toBe(true);

    // restoreFromBackup 换了新连接：缓存不复位就会在新连接上直接查 vec0 而报错
    expect(getVectorBackend(env)).toBe("sqlite-vec");
    const hits = searchVectors(env, new Float32Array([1, 0, 0, 0]), { topK: 3, minScore: 0.9 });
    expect(hits.map((h) => h.id)).toEqual([cat.id]);
  });
});
