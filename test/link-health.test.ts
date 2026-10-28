/**
 * roadmap v0.4 R13：关联网体检（自环 / 悬空 / 重复边 / 补关键词），可撤销；启动时也跑一次。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { MemoryEntry } from "../src/core/types";
import { openService } from "../src/host/index";
import type { WeaveService } from "../src/host/service";
import type { WeaveEnv } from "../src/store/db";
import { archiveMemory, getMemory, insertLink, insertMemory, newId } from "../src/store/dao";
import { linkHealth } from "../src/store/dream-c";

let dir: string;
let env: WeaveEnv;
let service: WeaveService;

export function entry(p: Partial<MemoryEntry> & { content: string }): MemoryEntry {
  const ts = p.updatedAt ?? Date.now();
  return {
    id: p.id ?? newId(),
    level: p.level ?? "fact",
    project: p.project ?? null,
    section: p.section ?? null,
    content: p.content,
    keywords: p.keywords ?? ["k"],
    importance: p.importance ?? 3,
    status: p.status ?? "active",
    semanticKey: null,
    confidence: null,
    validFrom: ts,
    validTo: p.validTo ?? null,
    evidence: [],
    hash: null,
    source: "test",
    accessCount: 0,
    tier: p.tier ?? "hot",
    createdAt: p.createdAt ?? ts,
    updatedAt: ts,
    boost: p.boost ?? 0,
    ...(p.dueAt !== undefined ? { dueAt: p.dueAt } : {}),
    ...(p.promiseState !== undefined ? { promiseState: p.promiseState } : {}),
    ...(p.promiseLabel !== undefined ? { promiseLabel: p.promiseLabel } : {}),
    ...(p.calendarAnchor !== undefined ? { calendarAnchor: p.calendarAnchor } : {}),
    ...(p.searchTerms !== undefined ? { searchTerms: p.searchTerms } : {}),
    ...(p.valence !== undefined ? { valence: p.valence } : {}),
    ...(p.arousal !== undefined ? { arousal: p.arousal } : {}),
    ...(p.flash !== undefined ? { flash: p.flash } : {}),
  };
}

const links = (): Array<{ src: string; dst: string; kind: string; weight: number }> =>
  env.db.prepare("SELECT src, dst, kind, weight FROM links ORDER BY src, dst, kind").all() as never;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memweave-lh-"));
  const rt = openService(dir);
  env = rt.env;
  service = rt.service;
});

afterEach(() => {
  service.stopMirror(false);
  env.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("R13 关联网体检", () => {
  it("删自环、悬空边；重复边留权重大的；归档端的边保留；空关键词补上", async () => {
    insertMemory(env, entry({ id: "a", content: "甲条目内容" }));
    insertMemory(env, entry({ id: "b", content: "乙条目内容" }));
    insertMemory(env, entry({ id: "c", content: "丙条目内容" }));
    insertMemory(env, entry({ id: "k", content: "关键词为空的活跃条目 typescript 插件", keywords: [] }));
    const now = Date.now();
    insertLink(env, { src: "a", dst: "a", kind: "topic", weight: 1, createdAt: now });
    insertLink(env, { src: "a", dst: "ghost", kind: "topic", weight: 1, createdAt: now });
    insertLink(env, { src: "a", dst: "b", kind: "topic", weight: 0.4, createdAt: now });
    insertLink(env, { src: "b", dst: "a", kind: "topic", weight: 0.9, createdAt: now });
    insertLink(env, { src: "a", dst: "c", kind: "time", weight: 0.3, createdAt: now });
    archiveMemory(env, "c", "test");

    const rep = linkHealth(env, "dream");
    expect(rep).toEqual({ selfLoop: 1, dangling: 1, dup: 1, keywords: 1 });
    expect(links()).toEqual([
      { src: "a", dst: "c", kind: "time", weight: 0.3 },
      { src: "b", dst: "a", kind: "topic", weight: 0.9 },
    ]);
    expect(getMemory(env, "k")!.keywords.length).toBeGreaterThan(0);

    // 撤销：删掉的边回来，关键词复原
    const undo = service.undoList().find((u) => u.action === "dream.links")!;
    expect((await service.undo(undo.id, "human")).ok).toBe(true);
    expect(links()).toHaveLength(5);
    expect(getMemory(env, "k")!.keywords).toEqual([]);
  });

  it("没有问题时不写台账；dream 报告带 linksFixed", () => {
    insertMemory(env, entry({ id: "a", content: "甲" }));
    expect(linkHealth(env, "dream")).toEqual({ selfLoop: 0, dangling: 0, dup: 0, keywords: 0 });
    expect(service.undoList().filter((u) => u.action === "dream.links")).toHaveLength(0);
    insertLink(env, { src: "a", dst: "a", kind: "topic", weight: 1, createdAt: Date.now() });
    service.config.dream.enabled = true;
    const r = service.consolidate("human");
    expect(r.linksFixed?.selfLoop).toBe(1);
    expect(r.rounds.map((x) => x.round)).toContain("link-health");
  });
});
