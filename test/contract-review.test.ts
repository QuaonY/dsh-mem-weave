/**
 * roadmap v0.3 G6：契约被反复违反 → dream 生成复核候选；人接受 = 停用契约；AI 不能裁决。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openService } from "../src/host/index";
import type { WeaveService } from "../src/host/service";
import { buildTools } from "../src/host/tools";
import type { WeaveEnv } from "../src/store/db";
import { REVIEW_REASON, proposeContractReviews } from "../src/store/review";

let dir: string;
let env: WeaveEnv;
let service: WeaveService;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memweave-review-"));
  const rt = openService(dir);
  env = rt.env;
  service = rt.service;
  service.config.dream.enabled = true;
  const r = service.updatePersona(
    { contracts: [{ id: "c-short", text: "回答要简短", on: true }, { id: "c-cite", text: "引用要给来源", on: true }] },
    "human",
  );
  expect(r.ok).toBe(true);
});

afterEach(() => {
  service.stopMirror(false);
  env.close();
  rmSync(dir, { recursive: true, force: true });
});

const pendingReviews = () => service.listCandidates("pending").filter((c) => c.reason === REVIEW_REASON);

describe("G6 契约复核", () => {
  it("30 天内被指出违反 2 次 → dream 生成 1 条 L2 复核候选，附 lesson 原文；不重复提名", async () => {
    const tool = buildTools(service).find((t) => t.descriptor.name === "weave_remember")!;
    await tool.handler({ level: "lesson", content: "主人说我又写了一大段，应该先给结论", violatesContract: "1" }, { agent: { session: { id: "s" } } });
    expect(service.consolidate("human").reviews ?? []).toHaveLength(0); // 1 次不够
    await tool.handler({ level: "lesson", content: "主人再次提醒回复太长，三句话以内", violatesContract: "c-short" }, { agent: { session: { id: "s" } } });
    const r = service.consolidate("human");
    expect(r.reviews).toHaveLength(1);
    const c = pendingReviews();
    expect(c).toHaveLength(1);
    expect(c[0].risk).toBe("L2");
    expect(c[0].content).toContain("回答要简短");
    expect(c[0].content).toContain("2 次");
    expect(c[0].content).toContain("先给结论");
    expect(service.consolidate("human").reviews ?? []).toHaveLength(0);
    expect(pendingReviews()).toHaveLength(1);
  });

  it("AI 不能裁决；人接受 → 契约停用；人拒绝 → 契约保留", async () => {
    const lesson = await service.remember({ level: "lesson", content: "教训一：引用没给出处" }, "agent", { violatesContract: "c-cite" });
    await service.remember({ level: "lesson", content: "教训二：又一次没标来源链接" }, "agent", { violatesContract: "c-cite" });
    expect(lesson.ok).toBe(true);
    const ids = proposeContractReviews(env, service.persona().config.contracts, "dream", Date.now());
    expect(ids).toHaveLength(1);
    const denied = service.decideCandidate(ids[0], "accepted", "agent");
    expect(denied.ok).toBe(false);
    expect(denied.code).toBe("E_PERM");
    expect(service.persona().config.contracts.find((c) => c.id === "c-cite")!.on).toBe(true);
    const ok = service.decideCandidate(ids[0], "accepted", "human");
    expect(ok.ok).toBe(true);
    expect(service.persona().config.contracts.find((c) => c.id === "c-cite")!.on).toBe(false);
    expect(service.persona().config.contracts.find((c) => c.id === "c-cite")!.text).toBe("引用要给来源");
  });

  it("超出 30 天窗口的违反不算；未知契约不记；非 lesson 忽略", async () => {
    const old = Date.now() - 31 * 86400000;
    env.db.prepare("INSERT INTO audit_log (ts, actor, action, target, after) VALUES (?, 'agent', 'contract.violation', 'c-short', 'x')").run(old);
    await service.remember({ level: "lesson", content: "窗口内的一次违反" }, "agent", { violatesContract: "c-short" });
    expect(proposeContractReviews(env, service.persona().config.contracts, "dream", Date.now())).toHaveLength(0);
    await service.remember({ level: "lesson", content: "指向不存在的契约" }, "agent", { violatesContract: "c-nope" });
    await service.remember({ level: "fact", content: "事实层不该记违反" }, "agent", { violatesContract: "c-short" });
    const n = env.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'contract.violation'").get() as { n: number };
    expect(n.n).toBe(2);
  });
});
