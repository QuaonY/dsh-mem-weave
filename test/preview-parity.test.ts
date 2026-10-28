/**
 * ui/preview-parity（§15 / U4）：≥20 组样本断言 hash(预览) === hash(注入)，
 * 且三段文本逐字一致 —— 设置界面预览与真实注入同源同果。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openWeaveDb, type WeaveEnv } from "../src/store/db";
import { ensureSchema } from "../src/store/migrate";
import { insertMemory, newId, updatePersona } from "../src/store/dao";
import { WeaveService, defaultConfig } from "../src/host/service";
import { renderHash } from "../src/core/hash";
import type { Level, MemoryEntry, Tier } from "../src/core/types";

let dir: string;
let env: WeaveEnv;
let service: WeaveService;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memweave-parity-"));
  env = openWeaveDb(join(dir, "memweave"));
  ensureSchema(env);
  service = new WeaveService(env, defaultConfig(dir));
});

afterEach(() => {
  service.stopMirror(true);
  env.close();
  rmSync(dir, { recursive: true, force: true });
});

const LEVELS: Level[] = ["soul", "user", "project", "fact", "lesson", "topic", "rules"];
const TIERS: Tier[] = ["core", "hot", "cold"];

function seedEntry(i: number, j: number): MemoryEntry {
  const ts = Date.now();
  return {
    id: "m-" + i + "-" + j,
    level: LEVELS[(i + j) % LEVELS.length],
    project: (i + j) % 2 === 0 ? "proj-" + i : null,
    section: "sec-" + j,
    content: "样本事实 " + i + "-" + j + "：项目进度稳定推进",
    keywords: ["样本", "进度"],
    importance: ((i + j) % 5) + 1,
    status: "active",
    semanticKey: "parity:" + i + ":" + j,
    confidence: 0.8,
    validFrom: ts,
    validTo: null,
    evidence: [],
    hash: null,
    source: "human",
    accessCount: 0,
    tier: TIERS[(i + j) % TIERS.length],
    createdAt: ts,
    updatedAt: ts,
  };
}

describe("预览与注入一致性（≥20 组样本）", () => {
  it("22 组人格/记忆/模型组合下 hash(预览) === hash(注入) 且三段逐字一致", () => {
    const hashes = new Set<string>();
    const hints = ["", "pro", "flash", "long"];
    for (let i = 0; i < 22; i++) {
      // 人格组合：立场/性格/契约/思考语言/形象/语气轮换
      updatePersona(
        env,
        {
          stance: "立场样本 " + i,
          character: i % 2 === 0 ? "性格文本 " + i : "",
          contracts: i % 3 === 0 ? [{ id: "ct" + i, text: "契约文本 " + i, on: true }] : [],
          thinkingLanguage: i % 2 === 0 ? "中文" : "off",
          appearance: {
            enabled: i % 4 === 0,
            text: i % 4 === 0 ? "形象文本 " + i : "",
            byModel: {},
            cards: [],
            index: false,
          },
          tone: { enabled: i % 5 === 0, text: i % 5 === 0 ? "语气文本 " + i : "", byModel: {} },
        },
        "human",
      );
      // 记忆组合：1~5 条跨层条目
      const n = (i % 5) + 1;
      for (let j = 0; j < n; j++) insertMemory(env, seedEntry(i, j));

      const hint = hints[i % hints.length];
      const p = service.preview(hint);
      const rt = service.renderTurn({ sessionId: "parity-" + i, first: true, baseline: new Map(), modelHint: hint });

      // U4：预览与注入同一 hash
      expect(rt.result.hash, "sample " + i).toBe(p.hash);
      // 三段逐字一致
      expect(rt.result.s1, "sample " + i).toEqual(p.s1);
      expect(rt.result.s2, "sample " + i).toBe(p.s2);
      expect(rt.s2, "sample " + i).toBe(p.s2);
      expect(rt.s3, "sample " + i).toBe("");
      // hash 由三段文本同源拼接（core/hash 的 renderHash）
      expect(p.hash, "sample " + i).toBe(renderHash([p.s1.prefix, p.s1.thinking, p.s1.suffix, p.s2, p.s3]));

      hashes.add(p.hash);
    }
    // 样本确实互异（防退化为同一空态）
    expect(hashes.size).toBeGreaterThan(10);
  });

  it("空库样本下预览与注入同为空态、hash 一致", () => {
    const p = service.preview();
    const rt = service.renderTurn({ sessionId: "parity-empty", first: true, baseline: new Map() });
    expect(rt.result.hash).toBe(p.hash);
    expect(rt.result.s1.prefix + rt.result.s1.thinking + rt.result.s1.suffix + rt.result.s2).toBe("");
    expect(p.hash).toBe(renderHash(["", "", "", "", ""]));
  });
});
