/**
 * 召回测试：BM25 + links 一跳 RRF 融合 / 时间衰减 / 硬过滤（status、valid_to、冲突冻结）
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openWeaveDb, type WeaveEnv } from "../src/store/db";
import { ensureSchema } from "../src/store/migrate";
import { insertConflict, insertLink, insertMemory, newId, type ConflictRow } from "../src/store/dao";
import { recallEntries } from "../src/host/service";
import { decayFactor, importanceFactor, DEFAULT_HALF_LIFE_DAYS } from "../src/core/score";
import type { MemoryEntry } from "../src/core/types";

let dir: string;
let env: WeaveEnv;

function entry(p: Partial<MemoryEntry> & { content: string }): MemoryEntry {
  const ts = p.createdAt ?? Date.now();
  return {
    id: p.id ?? newId(),
    level: p.level ?? "fact",
    project: p.project ?? null,
    section: null,
    content: p.content,
    keywords: p.keywords ?? [],
    importance: p.importance ?? 3,
    status: p.status ?? "active",
    semanticKey: p.semanticKey ?? null,
    confidence: null,
    validFrom: ts,
    validTo: p.validTo ?? null,
    evidence: [],
    hash: null,
    source: "test",
    accessCount: 0,
    tier: "hot",
    createdAt: ts,
    updatedAt: p.updatedAt ?? ts,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memweave-recall-"));
  env = openWeaveDb(dir);
  ensureSchema(env);
});

afterEach(() => {
  env.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("BM25 + RRF 融合", () => {
  it("关键词命中排前，无关条目不进结果", () => {
    insertMemory(env, entry({ id: "px", content: "主人偏好像素风的界面设计" }));
    insertMemory(env, entry({ id: "vd", content: "视频导出规范要求 1080p 分辨率" }));
    const hits = recallEntries(env, "像素风 偏好", { limit: 5 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].id).toBe("px");
    expect(hits.map((h) => h.id)).not.toContain("vd");
    expect(hits[0].explain).toBeTruthy();
  });

  it("links 一跳把关联条目带进结果（route: link）", () => {
    const a = entry({ id: "a1", content: "主人偏好像素风的界面设计" });
    const b = entry({ id: "b1", content: "视频导出规范要求 1080p 分辨率", level: "project" });
    insertMemory(env, a);
    insertMemory(env, b);
    insertLink(env, { src: "a1", dst: "b1", kind: "relate", weight: 0.8, createdAt: Date.now() });
    const hits = recallEntries(env, "像素风 偏好", { limit: 5 });
    const linked = hits.find((h) => h.id === "b1");
    expect(linked).toBeTruthy();
    expect(linked?.routes).toContain("link");
  });

  it("limit 生效", () => {
    for (let i = 0; i < 6; i += 1) {
      insertMemory(env, entry({ id: "m" + i, content: "像素风偏好记录第 " + i + " 条" }));
    }
    const hits = recallEntries(env, "像素风 偏好", { limit: 3 });
    expect(hits).toHaveLength(3);
  });
});

describe("硬过滤", () => {
  it("archived / 过期 valid_to / 冲突冻结条目一律不召回", () => {
    insertMemory(env, entry({ id: "ok1", content: "像素风偏好正常条目" }));
    insertMemory(env, entry({ id: "arch", content: "像素风偏好已归档条目", status: "archived" }));
    insertMemory(env, entry({ id: "exp", content: "像素风偏好已过期条目", validTo: Date.now() - 1000 }));
    insertMemory(env, entry({ id: "frz", content: "像素风偏好冻结条目" }));

    const conflict: ConflictRow = {
      id: "cf1",
      semanticKey: "pref.style",
      contenders: [
        { id: "frz", level: "fact", content: "像素风偏好冻结条目", createdAt: Date.now() },
        { id: "ghost", level: "fact", content: "另一条", createdAt: Date.now() },
      ],
      winnerId: null,
      status: "open",
      note: null,
      createdAt: Date.now(),
      resolvedAt: null,
    };
    insertConflict(env, conflict);

    const hits = recallEntries(env, "像素风 偏好", { limit: 10 });
    const ids = hits.map((h) => h.id);
    expect(ids).toContain("ok1");
    expect(ids).not.toContain("arch");
    expect(ids).not.toContain("exp");
    expect(ids).not.toContain("frz");
  });

  it("project 过滤生效", () => {
    insertMemory(env, entry({ id: "p1", content: "像素风偏好 项目甲", project: "甲" }));
    insertMemory(env, entry({ id: "p2", content: "像素风偏好 项目乙", project: "乙" }));
    const hits = recallEntries(env, "像素风 偏好", { project: "甲", limit: 10 });
    expect(hits.map((h) => h.id)).toEqual(["p1"]);
  });
});

describe("衰减与加权", () => {
  it("decayFactor：越旧越小，rules 层不衰减", () => {
    const now = Date.now();
    const day = 86400000;
    const fresh = entry({ id: "f", content: "x", createdAt: now });
    const old = entry({ id: "o", content: "x", createdAt: now - 200 * day });
    expect(decayFactor(old, now, DEFAULT_HALF_LIFE_DAYS)).toBeLessThan(
      decayFactor(fresh, now, DEFAULT_HALF_LIFE_DAYS),
    );
    const rules = entry({ id: "r", content: "x", level: "rules", createdAt: now - 200 * day });
    expect(decayFactor(rules, now, DEFAULT_HALF_LIFE_DAYS)).toBe(1);
  });

  it("importanceFactor 随重要度递增", () => {
    expect(importanceFactor(5)).toBeGreaterThan(importanceFactor(3));
    expect(importanceFactor(3)).toBeGreaterThan(importanceFactor(1));
  });
});
