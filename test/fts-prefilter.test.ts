/**
 * FTS5 前置召回
 * 关注三件事：
 * 1. 中文二元组口径下 FTS 真的能命中子串（旧实现整段中文一个词，MATCH 命中不了）
 * 2. 前置候选必须是关键词路的超集（同义组、检索词、links 一跳）
 * 3. 开 / 关前置过滤时，recallEntries 的结果逐条一致
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openWeaveDb, type WeaveEnv } from "../src/store/db";
import { ensureSchema } from "../src/store/migrate";
import { archiveMemory, insertLink, insertMemory, listMemory, newId } from "../src/store/dao";
import {
  buildMemoryFtsMatch,
  ftsText,
  searchMemoryFTS,
  searchMemoryIds,
} from "../src/store/fts";
import { DEFAULT_ALIAS_GROUPS, normalizeAliases, tokenize } from "../src/core/tokenize";
import { bm25Scores } from "../src/core/score";
import { recallEntries } from "../src/host/service";
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
    validFrom: null,
    validTo: p.validTo ?? null,
    evidence: [],
    hash: null,
    source: "test",
    accessCount: 0,
    tier: "hot",
    createdAt: ts,
    updatedAt: p.updatedAt ?? ts,
    searchTerms: p.searchTerms ?? null,
  };
}

/** 对照口径：内核 BM25 > 0 的条目（即「理论上关键词路能看到的全部候选」） */
function bm25HitIds(query: string): Set<string> {
  const q = normalizeAliases(tokenize(query), DEFAULT_ALIAS_GROUPS);
  const docs = listMemory(env, { status: "active" }).map((e) => ({
    id: e.id,
    tokens: normalizeAliases(tokenize(e.content + " " + e.keywords.join(" ")), DEFAULT_ALIAS_GROUPS),
  }));
  return new Set(
    [...bm25Scores(q, docs).entries()].filter(([, s]) => s > 0).map(([id]) => id),
  );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memweave-fts-prefilter-"));
  env = openWeaveDb(dir);
  ensureSchema(env);
});

afterEach(() => {
  env.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("FTS 索引口径", () => {
  it("索引存分词串（中文二元组），查询也走同一口径", () => {
    expect(ftsText("路由器管理地址")).toBe("路由 由器 器管 管理 理地 地址");
    expect(buildMemoryFtsMatch("路由器")).toBe('"路由" OR "由器"');
    expect(buildMemoryFtsMatch("……？！")).toBeNull();
  });

  it("中文子串能命中（旧实现整段中文一个词，MATCH 命中不了）", () => {
    insertMemory(env, entry({ id: "r1", content: "路由器管理地址是 192.168.1.1" }));
    insertMemory(env, entry({ id: "r2", content: "视频导出规范要求 1080p" }));
    expect(searchMemoryIds(env, "管理地址")).toEqual(["r1"]);
    expect(searchMemoryFTS(env, "管理地址").map((r) => r.id)).toEqual(["r1"]);
  });

  it("检索词列也进索引：只有 searchTerms 命中的条目也能当前置候选", () => {
    insertMemory(env, entry({ id: "t1", content: "昨晚把归档脚本跑完了", searchTerms: ["备份", "清理"] }));
    insertMemory(env, entry({ id: "t2", content: "今天天气不错" }));
    expect(searchMemoryIds(env, "备份")).toEqual(["t1"]);
  });

  it("同义组展开：查询「用户」能捞到正文写「主人」的条目（超集要求）", () => {
    insertMemory(env, entry({ id: "s1", content: "主人喜欢深夜改代码" }));
    insertMemory(env, entry({ id: "s2", content: "无关内容，只讲天气" }));
    // 内核 BM25 归一化后确实会把 s1 当命中
    expect(bm25HitIds("用户 喜欢").has("s1")).toBe(true);
    expect(searchMemoryIds(env, "用户 喜欢")).toContain("s1");
  });

  it("归档 / 状态变化后从 FTS 撤下", () => {
    insertMemory(env, entry({ id: "a1", content: "这条马上要归档了" }));
    expect(searchMemoryIds(env, "归档")).toContain("a1");
    archiveMemory(env, "a1", "test");
    expect(searchMemoryIds(env, "归档")).not.toContain("a1");
  });

  it("旧库缺 terms 列：ensureSchema 就地重建并回灌", () => {
    insertMemory(env, entry({ id: "m1", content: "迁移之后仍然可以被检索到" }));
    env.db.exec("DROP TABLE memory_fts");
    env.db.exec(
      "CREATE VIRTUAL TABLE memory_fts USING fts5(" +
        "id UNINDEXED, level UNINDEXED, content, keywords, project," +
        "tokenize='unicode61 remove_diacritics 2')",
    );
    const cols = () =>
      (env.db.prepare("PRAGMA table_info(memory_fts)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols()).not.toContain("terms");
    ensureSchema(env);
    expect(cols()).toContain("terms");
    expect(searchMemoryIds(env, "检索")).toContain("m1");
  });
});

describe("前置候选是超集", () => {
  it("top 候选覆盖全部 BM25 > 0 的条目", () => {
    insertMemory(env, entry({ id: "p1", content: "主人偏好像素风的界面设计" }));
    insertMemory(env, entry({ id: "p2", content: "视频导出规范要求 1080p 分辨率" }));
    insertMemory(env, entry({ id: "p3", content: "主人说过喜欢复古游戏机" }));
    insertMemory(env, entry({ id: "p4", content: "部署脚本放在 scripts 目录", keywords: ["部署"] }));
    for (const q of ["像素风 偏好", "复古 游戏机", "部署脚本", "用户 喜欢"]) {
      const wanted = bm25HitIds(q);
      const got = new Set(searchMemoryIds(env, q, { limit: 1000 }));
      for (const id of wanted) expect(got.has(id), q + " 漏了 " + id).toBe(true);
    }
  });
});

describe("开 / 关前置过滤结果一致", () => {
  function seed(): void {
    const now = Date.now();
    insertMemory(env, entry({ id: "k1", content: "主人偏好像素风的界面设计", updatedAt: now - 86400000 }));
    insertMemory(env, entry({ id: "k2", content: "视频导出规范要求 1080p 分辨率", level: "project" }));
    insertMemory(env, entry({ id: "k3", content: "部署脚本记得先跑测试", keywords: ["部署", "脚本"] }));
    insertMemory(env, entry({ id: "k4", content: "这句只靠检索词才找得到", searchTerms: ["像素风", "界面"] }));
    // k5 与查询无关，只靠链接从 k1 带进来
    insertMemory(env, entry({ id: "k5", content: "配色方案记录", level: "topic" }));
    insertLink(env, { src: "k1", dst: "k5", kind: "co-session", weight: 0.8, createdAt: now });
  }

  const shape = (hits: Array<{ id: string; score: number; routes: string[] }>) =>
    hits.map((h) => ({ id: h.id, score: h.score.toFixed(9), routes: [...h.routes].sort() }));

  it("同一查询：前置过滤版与全量扫描版逐条一致", () => {
    seed();
    const now = Date.now();
    for (const q of ["像素风 偏好", "部署脚本", "视频导出", "只靠检索词"]) {
      const on = shape(recallEntries(env, q, { limit: 5, now }));
      const off = shape(recallEntries(env, q, { limit: 5, now, prefilter: false }));
      expect(on, q).toEqual(off);
    }
  });

  it("links 一跳的条目即使不在前置候选里也能被带进来", () => {
    seed();
    const now = Date.now();
    const hits = recallEntries(env, "像素风 偏好", { limit: 5, now });
    const linked = hits.find((h) => h.id === "k5");
    expect(linked).toBeTruthy();
    expect(linked?.routes).toContain("link");
    // 关联路的权重不因前置过滤而变：与全量扫描版同分
    const off = recallEntries(env, "像素风 偏好", { limit: 5, now, prefilter: false }).find((h) => h.id === "k5");
    expect(linked?.score).toBe(off?.score);
  });

  it("FTS 索引为空（旧库 / 绕过 dao 写入）时回退全量扫描，不把召回清空", () => {
    // 直接写层表，不经过 insertMemory -> FTS 一条都没有
    env.db
      .prepare("INSERT INTO fact (id, content, importance, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("raw1", "Zebra 迁移计划写在仓库根目录", 3, "active", Date.now(), Date.now());
    const hits = recallEntries(env, "Zebra", { limit: 5 });
    expect(hits.map((h) => h.id)).toContain("raw1");
  });
});
