/**
 * roadmap v0.7：S1 检索词、§8 待整理队列、S2 会话内归纳的端到端行为。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openService } from "../src/host/index";
import type { WeaveService } from "../src/host/service";
import type { WeaveEnv } from "../src/store/db";
import { getLinks, getMemory, insertLink, insertMemory, listDistillGroups } from "../src/store/dao";
import { entry } from "./link-health.test";

const DAY = 86400000;
let dir: string;
let env: WeaveEnv;
let service: WeaveService;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memweave-curate-"));
  const rt = openService(dir);
  env = rt.env;
  service = rt.service;
  service.config.dream.enabled = true;
});

afterEach(() => {
  service.stopMirror(false);
  env.close();
  rmSync(dir, { recursive: true, force: true });
});

/** 三条同 project、两两有关联边、40 天没动过的 fact（满足 S2 找组条件） */
function seedGroup(): string[] {
  const old = Date.now() - 40 * DAY;
  const ids = ["g1", "g2", "g3"];
  const texts = [
    "忆织打包流程：先运行构建脚本生成 lib 目录",
    "忆织打包流程：构建完成后执行 npm pack 生成 tgz",
    "忆织打包流程：tgz 解压后覆盖桌面端 node_modules",
  ];
  ids.forEach((id, i) => insertMemory(env, entry({ id, level: "fact", project: "memweave", content: texts[i], updatedAt: old })));
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) insertLink(env, { src: ids[i], dst: ids[j], kind: "related", weight: 1, createdAt: old });
  }
  return ids;
}

describe("S1 检索词", () => {
  it("写入带 searchTerms → 召回走 terms 路；正文已有的词被丢掉", async () => {
    const out = await service.remember({ level: "user", content: "不吃香菜，点外卖要备注" }, "human", {
      sessionId: "s",
      turn: 1,
      searchTerms: ["忌口", "饮食", "香菜"],
    });
    expect(out.verdict).toBe("accepted");
    const e = getMemory(env, out.id!)!;
    expect(e.searchTerms).toEqual(["忌口", "饮食"]);
    const hits = service.recall("忌口有哪些");
    expect(hits[0]?.id).toBe(out.id);
    expect(hits[0]?.explain).toContain("terms=");
  });

  it("关掉 searchTerms：参数被忽略，不写词", async () => {
    service.config.searchTerms.enabled = false;
    const out = await service.remember({ level: "user", content: "喜欢深色主题" }, "human", { searchTerms: ["暗色", "主题偏好"] });
    expect(getMemory(env, out.id!)!.searchTerms ?? []).toEqual([]);
  });

  it("weave_annotate 批量补词可撤销", async () => {
    const out = await service.remember({ level: "fact", content: "家里的猫叫橘子" }, "human");
    const r = service.annotate([{ id: out.id, searchTerms: ["宠物", "猫咪名字"] }, { id: "nope", searchTerms: ["x"] }], "agent");
    expect(r.updated).toEqual([out.id]);
    expect(r.skipped[0]).toMatchObject({ id: "nope", reason: "not found" });
    expect(getMemory(env, out.id!)!.searchTerms).toEqual(["宠物", "猫咪名字"]);
    const u = await service.undo(r.undoId!, "human");
    expect(u.ok).toBe(true);
    expect(getMemory(env, out.id!)!.searchTerms ?? []).toEqual([]);
  });
});

describe("§8 待整理提示", () => {
  it("没跑过 dream 不提示；dream 后出现一次，数量不变不再出现", async () => {
    await service.remember({ level: "fact", content: "忆织的库文件叫 memweave.db" }, "human");
    expect(service.curateLine("s1")).toBe("");
    service.consolidate("human");
    const line = service.curateLine("s1");
    expect(line).toContain("【待整理】");
    expect(line).toContain("条缺检索词");
    expect(service.curateLine("s1")).toBe("");
    // 别的会话仍会看到一次
    expect(service.curateLine("s2")).toContain("【待整理】");
  });

  it("dream 之后再写新记忆，提示不会因此重新出现（数量快照只在 dream 时更新）", async () => {
    await service.remember({ level: "fact", content: "忆织默认关掉情绪残响" }, "human");
    service.consolidate("human");
    expect(service.curateLine("s1")).toContain("【待整理】");
    await service.remember({ level: "fact", content: "忆织检索词最多八个" }, "human");
    expect(service.curateLine("s1")).toBe("");
  });

  it("curate.enabled = false 时永远不提示", async () => {
    service.config.curate.enabled = false;
    await service.remember({ level: "fact", content: "忆织的撤销窗口是 24 小时" }, "human");
    service.consolidate("human");
    expect(service.curateLine("s1")).toBe("");
  });
});

describe("S2 会话内归纳", () => {
  it("dream 找组 → weave_backlog 列出 → 提交归纳：成员归档、merged 边、可撤销", async () => {
    const ids = seedGroup();
    service.consolidate("human");
    const bl = service.backlog();
    expect(bl.groups.length).toBe(1);
    expect(bl.groups[0].members.map((m) => m.id).sort()).toEqual(ids);

    const r = await service.submitDistill(
      { groupId: bl.groups[0].groupId, summary: "忆织打包流程：先运行构建脚本生成 lib 目录，再执行 npm pack 生成 tgz，解压后覆盖桌面端 node_modules" },
      "human",
    );
    expect(r.ok).toBe(true);
    expect(r.coverage).toBeGreaterThanOrEqual(0.8);
    const sid = r.id!;
    const summary = getMemory(env, sid)!;
    expect(summary.level).toBe("topic");
    expect(summary.section).toBe("distilled");
    for (const id of ids) {
      if (id === sid) continue;
      expect(getMemory(env, id)!.status).toBe("archived");
      expect(getLinks(env, sid).some((l) => l.kind === "merged" && l.dst === id)).toBe(true);
    }
    expect(listDistillGroups(env, "done").length).toBe(1);

    const u = await service.undo(r.undoId!, "human");
    expect(u.ok).toBe(true);
    for (const id of ids) expect(getMemory(env, id)!.status).toBe("active");
    if (r.verdict === "accepted") expect(getMemory(env, sid)).toBeNull();
    expect(listDistillGroups(env, "open").length).toBe(1);
  });

  it("覆盖率不足 → 转 L2 候选；人接受后才落地，AI 不能裁决", async () => {
    const ids = seedGroup();
    service.consolidate("human");
    const gid = service.backlog().groups[0].groupId;
    const r = await service.submitDistill({ groupId: gid, summary: "量子计算机明年将全面取代传统服务器架构" }, "agent");
    expect(r.ok).toBe(true);
    expect(r.verdict).toBe("pending");
    expect(r.coverage!).toBeLessThan(0.8);
    // 挂着待审候选时不再出现在待归纳清单里
    expect(service.backlog().groups.length).toBe(0);
    for (const id of ids) expect(getMemory(env, id)!.status).toBe("active");

    const cand = service.listCandidates("pending").find((c) => c.id === r.candidateId)!;
    expect(service.decideCandidate(cand.id, "accepted", "agent").ok).toBe(false);
    expect(service.decideCandidate(cand.id, "accepted", "human").ok).toBe(true);
    for (const id of ids) expect(getMemory(env, id)!.status).toBe("archived");
  });

  it("skip 跳过；超长 / 空归纳被拒", async () => {
    seedGroup();
    service.consolidate("human");
    const gid = service.backlog().groups[0].groupId;
    expect((await service.submitDistill({ groupId: gid, summary: "" }, "agent")).ok).toBe(false);
    expect((await service.submitDistill({ groupId: gid, summary: "长".repeat(201) }, "agent")).ok).toBe(false);
    expect((await service.submitDistill({ groupId: gid, skip: true }, "agent")).verdict).toBe("skipped");
    expect(service.backlog().groups.length).toBe(0);
  });

  it("最近被召回过的条目不进组", async () => {
    seedGroup();
    env.db.prepare("INSERT INTO recall_log (memory_id, session_id, turn, ts) VALUES (?, ?, ?, ?)").run("g1", "s", 1, Date.now());
    service.consolidate("human");
    expect(service.backlog().groups.length).toBe(0);
  });

  it("distill.enabled = false：dream 不找组", async () => {
    service.config.distill.enabled = false;
    seedGroup();
    service.consolidate("human");
    expect(listDistillGroups(env, "open").length).toBe(0);
  });
});

describe("v0.7 总开关等价", () => {
  it("searchTerms / distill / curate 全关：召回与注入和从没写过检索词的库一致", async () => {
    const dir2 = mkdtempSync(join(tmpdir(), "memweave-curate-eq-"));
    const rt2 = openService(dir2);
    try {
      const facts = ["不吃香菜，点外卖要备注", "家里的猫叫橘子，只吃冻干", "删除文件前先问主人", "回答尽量简短"];
      const terms = [["忌口", "饮食"], ["宠物", "猫咪零食"], ["危险操作", "确认"], ["风格", "简洁"]];
      for (let i = 0; i < facts.length; i += 1) {
        await service.remember({ level: "user", content: facts[i] }, "human", { searchTerms: terms[i] });
        await rt2.service.remember({ level: "user", content: facts[i] }, "human");
      }
      for (const s of [service, rt2.service]) {
        s.config.searchTerms.enabled = false;
        s.config.distill.enabled = false;
        s.config.curate.enabled = false;
      }
      service.consolidate("human");
      rt2.service.consolidate("human");
      // 两个库的 id 不同（时间戳 base36 + 随机串），比较前统一抹掉
      const strip = (x: string): string => x.replace(/\[(\w+):[^\]]+\]/g, "[$1:#]").replace(/[0-9a-z]{8,}-[0-9a-z]+/gi, "#");
      for (const q of ["忌口", "猫咪零食注意什么", "删东西之前", "回答风格"]) {
        const a = service.recall(q).map((h) => [h.entry.content, h.score.toFixed(6), strip(h.explain)]);
        const b = rt2.service.recall(q).map((h) => [h.entry.content, h.score.toFixed(6), strip(h.explain)]);
        expect(a).toEqual(b);
        expect(a.some((r) => String(r[2]).includes("terms="))).toBe(false);
      }
      const ra = service.renderTurn({ sessionId: "eq", first: false, query: "忌口", baseline: new Map(), turn: 2 });
      const rb = rt2.service.renderTurn({ sessionId: "eq", first: false, query: "忌口", baseline: new Map(), turn: 2 });
      expect(strip(ra.s3)).toBe(strip(rb.s3));
      expect(ra.s3).not.toContain("【待整理】");
      expect(listDistillGroups(env).length).toBe(0);
    } finally {
      rt2.service.stopMirror(false);
      rt2.env.close();
      rmSync(dir2, { recursive: true, force: true });
    }
  });
});
