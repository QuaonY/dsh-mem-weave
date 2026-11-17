/**
 * Embedding 配置管理测试
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openWeaveDb, type WeaveEnv } from "../src/store/db";
import { ensureSchema } from "../src/store/migrate";
import {
  getEmbeddingConfig,
  setEmbeddingConfig,
  needsReindex,
  updateEmbeddingConfig,
} from "../src/store/vector";

describe("Embedding 配置管理", () => {
  let env: WeaveEnv;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "weave-config-test-"));
    env = openWeaveDb(tmpDir, { readonly: false });
    ensureSchema(env);
  });

  afterEach(() => {
    env.db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("初始状态无配置", () => {
    const config = getEmbeddingConfig(env);
    expect(config).toBeNull();
  });

  it("设置配置并读取", () => {
    setEmbeddingConfig(env, {
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: 1536,
    });

    const config = getEmbeddingConfig(env);
    expect(config).not.toBeNull();
    expect(config?.provider).toBe("openai");
    expect(config?.model).toBe("text-embedding-3-small");
    expect(config?.dimensions).toBe(1536);
    expect(config?.updatedAt).toBeGreaterThan(0);
  });

  it("更新配置时检测变化", () => {
    // 首次设置
    setEmbeddingConfig(env, {
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: 1536,
    });

    // 相同配置不需要重建
    expect(
      needsReindex(env, {
        provider: "openai",
        model: "text-embedding-3-small",
        dimensions: 1536,
      })
    ).toBe(false);

    // 改变 provider 需要重建
    expect(
      needsReindex(env, {
        provider: "cohere",
        model: "text-embedding-3-small",
        dimensions: 1536,
      })
    ).toBe(true);

    // 改变 model 需要重建
    expect(
      needsReindex(env, {
        provider: "openai",
        model: "text-embedding-3-large",
        dimensions: 1536,
      })
    ).toBe(true);

    // 改变 dimensions 需要重建
    expect(
      needsReindex(env, {
        provider: "openai",
        model: "text-embedding-3-small",
        dimensions: 3072,
      })
    ).toBe(true);
  });

  it("updateEmbeddingConfig 返回是否需要重建", () => {
    // 首次设置不需要重建
    let needsRebuild = updateEmbeddingConfig(env, {
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: 1536,
    });
    expect(needsRebuild).toBe(false);

    // 相同配置不需要重建
    needsRebuild = updateEmbeddingConfig(env, {
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: 1536,
    });
    expect(needsRebuild).toBe(false);

    // 改变配置需要重建
    needsRebuild = updateEmbeddingConfig(env, {
      provider: "openai",
      model: "text-embedding-3-large",
      dimensions: 3072,
    });
    expect(needsRebuild).toBe(true);

    // 验证配置已更新
    const config = getEmbeddingConfig(env);
    expect(config?.model).toBe("text-embedding-3-large");
    expect(config?.dimensions).toBe(3072);
  });

  it("配置覆盖（单行表）", () => {
    setEmbeddingConfig(env, {
      provider: "openai",
      model: "model-v1",
      dimensions: 384,
    });

    setEmbeddingConfig(env, {
      provider: "cohere",
      model: "model-v2",
      dimensions: 768,
    });

    const config = getEmbeddingConfig(env);
    expect(config?.provider).toBe("cohere");
    expect(config?.model).toBe("model-v2");
    expect(config?.dimensions).toBe(768);

    // 只有一行
    const count = env.db.prepare("SELECT COUNT(*) as c FROM embedding_config").get() as { c: number };
    expect(count.c).toBe(1);
  });

  it("配置更新时间戳递增", () => {
    setEmbeddingConfig(env, {
      provider: "openai",
      model: "model-v1",
      dimensions: 384,
    });

    const config1 = getEmbeddingConfig(env);
    const t1 = config1?.updatedAt || 0;

    // 等待至少 1ms
    const start = Date.now();
    while (Date.now() === start) {
      // spin
    }

    setEmbeddingConfig(env, {
      provider: "openai",
      model: "model-v2",
      dimensions: 384,
    });

    const config2 = getEmbeddingConfig(env);
    const t2 = config2?.updatedAt || 0;

    expect(t2).toBeGreaterThan(t1);
  });
});
