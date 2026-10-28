/**
 * roadmap v0.4 阶段 C：八轮顺序、单轮失败隔离、候选上限 5 与优先级、G4 询问归档、G3 蒸馏阶梯、
 * 以及接受 L2 写入候选真正写进记忆（修复：以前只改 verdict）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openService } from "../src/host/index";
import type { WeaveService } from "../src/host/service";
import type { WeaveEnv } from "../src/store/db";
import { getLinks, getMemory, insertMemory, listMemory, setBoost } from "../src/store/dao";
import { ARCHIVE_REASON, CORE_REASON, DISTILLED_SECTION, RULES_REASON } from "../src/store/dream-c";
import { runDream } from "../src/store/dream";
import { entry } from "./link-health.test";

const DAY = 86400000;
let dir: string;
let env: WeaveEnv;
let service: WeaveService;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memweave-d2-"));
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

const pending = (reason: string) => service.listCandidates("pending").filter((c) => c.reason === reason);

describe("阶段 C 管线", () => {
  it("轮次顺序固定", () => {
    const r = service.consolidate("human");
    expect(r.ran).toBe(true);
    expect(r.rounds.map((x) => x.round)).toEqual([
      "expire",
      "link-health",
      "co-recall",
      "boost",
      "cold-merge",
      "distill",
      "contract-review",
      "promise-due",
      "promote",
      "distill-rules",
      "core-suggest",
      "archive-suggest",
      // roadmap v0.7：S2 待归纳找组、S1 待补检索词
      "distill-groups",
      "terms-backfill",
    ]);
    expect(r.roundErrors).toEqual([]);
  });

  it("单轮失败不影响后面的轮次", () => {
    insertMemory(env, entry({ id: "e1", content: "已过期", validTo: Date.now() - 1000 }));
    env.db.exec("DROP TABLE links");
    const r = service.consolidate("human");
    expect(r.ran).toBe(true);
    expect(r.expired).toBe(1);
    const failed = (r.roundErrors ?? []).map((x) => x.round);
    expect(failed).toContain("link-health");
    expect(failed).toContain("co-recall");
    expect(failed).not.toContain("boost");
  });
});

describe("D5 候选上限与优先级", () => {
  it("每次最多 5 条：设为准则 > 建议常驻 > 建议归档；超出的下次再生成", () => {
    const now = Date.now();
    for (const p of ["P1", "P2", "P3"]) {
      insertMemory(env, entry({ level: "lesson", project: p, content: "提交代码前先跑全量测试和类型检查", keywords: ["测试", "类型检查"] }));
    }
    for (const id of ["f1", "f2"]) {
      insertMemory(env, entry({ id, content: "常驻候选事实 " + id, keywords: [id] }));
      setBoost(env, "fact", id, 3);
    }
    for (let i = 0; i < 6; i += 1) {
      insertMemory(env, entry({ id: "s" + i, content: "过期很久的条目 " + i, keywords: ["s" + i], status: "stale", updatedAt: now - 10 * DAY }));
    }
    const r = runDream(env, { ...service["dreamCfg"](), enabled: true }, "dream", { force: true, now });
    expect(r.suggestions).toEqual({ rules: [expect.any(String)], core: [expect.any(String), expect.any(String)], archive: [expect.any(String), expect.any(String)], promises: [] });
    expect(r.candidatesSkipped).toBe(1);
    expect(pending(ARCHIVE_REASON)).toHaveLength(2);

    // 下一次：剩下的 4 条 stale 进来（前面的已问过不重复）
    const r2 = runDream(env, { ...service["dreamCfg"](), enabled: true }, "dream", { force: true, now: now + 1000 });
    expect(r2.suggestions?.archive).toHaveLength(4);
    expect(r2.suggestions?.rules).toHaveLength(0);
    expect(r2.suggestions?.core).toHaveLength(0);
  });

  it("maxCandidatesPerDream=0 → 一条都不生成", () => {
    insertMemory(env, entry({ id: "s", content: "过期", status: "stale", updatedAt: Date.now() - 10 * DAY }));
    service.config.lifecycle.maxCandidatesPerDream = 0;
    const r = service.consolidate("human");
    expect(r.suggestions?.archive).toHaveLength(0);
    expect(r.candidatesSkipped).toBe(1);
  });
});

describe("G4 询问归档", () => {
  it("stale ≥7 天才问，附过期时间；接受 = 归档；拒绝 = 改回 active 且不再问", () => {
    const now = Date.now();
    insertMemory(env, entry({ id: "old", content: "临时授权", status: "stale", validTo: now - 9 * DAY, updatedAt: now - 8 * DAY }));
    insertMemory(env, entry({ id: "new", content: "刚过期", status: "stale", validTo: now - DAY, updatedAt: now - DAY }));
    insertMemory(env, entry({ id: "old2", content: "另一条过期", status: "stale", updatedAt: now - 8 * DAY }));
    service.consolidate("human");
    const c = pending(ARCHIVE_REASON);
    expect(c.map((x) => x.mergedInto).sort()).toEqual(["old", "old2"]);
    expect(c.find((x) => x.mergedInto === "old")!.content).toContain("过期时间");

    expect(service.decideCandidate(c.find((x) => x.mergedInto === "old")!.id, "accepted", "agent").code).toBe("E_PERM");
    expect(service.decideCandidate(c.find((x) => x.mergedInto === "old")!.id, "accepted", "human").ok).toBe(true);
    expect(getMemory(env, "old")!.status).toBe("archived");
    expect(service.decideCandidate(c.find((x) => x.mergedInto === "old2")!.id, "rejected", "human").ok).toBe(true);
    expect(getMemory(env, "old2")!.status).toBe("active");

    service.consolidate("human");
    expect(pending(ARCHIVE_REASON)).toHaveLength(0);
  });
});

describe("G3 蒸馏阶梯", () => {
  it("同 project ≥5 条 topic → project 层摘要（section=distilled）+ merged 边；topic 不归档；内容不变不重写", () => {
    for (let i = 0; i < 5; i += 1) {
      insertMemory(env, entry({ id: "t" + i, level: "topic", project: "忆织", content: "主题" + i + "。细节说明" }));
    }
    for (let i = 0; i < 4; i += 1) insertMemory(env, entry({ level: "topic", project: "别的", content: "少量主题" + i }));
    const r = service.consolidate("human");
    expect(r.distilled).toHaveLength(1);
    const s = listMemory(env, { level: "project" }).filter((e) => e.section === DISTILLED_SECTION);
    expect(s).toHaveLength(1);
    expect(s[0].project).toBe("忆织");
    expect(s[0].content).toContain("[t0] 主题0");
    expect(getLinks(env, s[0].id).filter((l) => l.kind === "merged")).toHaveLength(5);
    expect(listMemory(env, { level: "topic", status: "active" })).toHaveLength(9);
    expect(service.consolidate("human").distilled).toHaveLength(0);
    // 新增 topic → 原摘要更新，不新建
    insertMemory(env, entry({ id: "t5", level: "topic", project: "忆织", content: "主题5" }));
    expect(service.consolidate("human").distilled).toEqual([s[0].id]);
    expect(getMemory(env, s[0].id)!.content).toContain("[t5]");
  });

  it("近似 lesson 出现在 ≥3 个 project → 候选「设为全局准则」；人接受后写进 rules", () => {
    for (const p of ["A", "B"]) insertMemory(env, entry({ level: "lesson", project: p, content: "改完代码先跑测试再报告", keywords: ["测试"] }));
    service.consolidate("human");
    expect(pending(RULES_REASON)).toHaveLength(0);
    insertMemory(env, entry({ level: "lesson", project: "C", content: "改完代码先跑测试再报告", keywords: ["测试"] }));
    service.consolidate("human");
    const c = pending(RULES_REASON);
    expect(c).toHaveLength(1);
    expect(c[0].level).toBe("rules");
    expect(service.decideCandidate(c[0].id, "accepted", "agent").code).toBe("E_PERM");
    expect(service.decideCandidate(c[0].id, "accepted", "human").ok).toBe(true);
    expect(listMemory(env, { level: "rules", status: "active" }).map((e) => e.content)).toEqual(["改完代码先跑测试再报告"]);
    // 已有同义 rules → 不再提议
    service.consolidate("human");
    expect(pending(RULES_REASON)).toHaveLength(0);
  });
});

describe("接受 L2 写入候选", () => {
  it("rules 层写入走候选；人接受后真正写进记忆，拒绝则不写", async () => {
    const w = await service.remember({ level: "rules", content: "绝不在日志里写记忆正文" }, "agent");
    expect(w.verdict).toBe("pending");
    expect(listMemory(env, { level: "rules" })).toHaveLength(0);
    expect(service.decideCandidate(w.id!, "accepted", "human").ok).toBe(true);
    expect(listMemory(env, { level: "rules", status: "active" }).map((e) => e.content)).toEqual(["绝不在日志里写记忆正文"]);

    const w2 = await service.remember({ level: "rules", content: "另一条被拒绝的规则" }, "agent");
    expect(service.decideCandidate(w2.id!, "rejected", "human").ok).toBe(true);
    expect(listMemory(env, { level: "rules" })).toHaveLength(1);
    expect(pending(CORE_REASON)).toHaveLength(0);
  });
});
