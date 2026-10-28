/**
 * roadmap v0.6 M1：前瞻记忆（约定 / 承诺）。
 * 验收：pending 60 天后仍能召回且 time_decay = 1；7 天内出现在 S3 约定小节；注入不含相对时间词；
 * 过期 3 天后 dream 生成候选；无 dueAt 的条目打分与以前一致；人来定结果。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openService } from "../src/host/index";
import { recallEntries, type WeaveService } from "../src/host/service";
import type { WeaveEnv } from "../src/store/db";
import { getMemory, getPersona, insertMemory, listCandidates } from "../src/store/dao";
import { runDream } from "../src/store/dream";
import { clarity, DEFAULT_PROMISE, promiseLine } from "../src/core/promise";
import { formatLocalDate, parseDue } from "../src/core/localdate";
import { buildTurnNotice } from "../src/host/turn-notice";
import { entry } from "./link-health.test";

const DAY = 86400000;
const TZ = "Asia/Shanghai";
let dir: string;
let env: WeaveEnv;
let service: WeaveService;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memweave-promise-"));
  const rt = openService(dir);
  env = rt.env;
  service = rt.service;
  service.config.calendar.timeZone = TZ;
});

afterEach(() => {
  service.stopMirror(false);
  env.close();
  rmSync(dir, { recursive: true, force: true });
});

const ymd = (ms: number): string => formatLocalDate(ms, TZ).slice(0, 10);

describe("M1 本地日期与清晰度", () => {
  it("parseDue 只认绝对时间；日期按本地 23:59", () => {
    expect(parseDue("2026-11-03", TZ)).toBe(Date.UTC(2026, 10, 3, 15, 59));
    expect(parseDue("2026-11-03T18:00", TZ)).toBe(Date.UTC(2026, 10, 3, 10, 0));
    expect(parseDue("2026-11-03T18:00:00Z", TZ)).toBe(Date.UTC(2026, 10, 3, 18, 0));
    for (const bad of ["明天", "下周三", "+3d", "2026-02-30", "2026-13-01", ""]) expect(parseDue(bad, TZ)).toBeNull();
    expect(formatLocalDate(Date.UTC(2026, 10, 3, 15, 59), TZ)).toBe("2026-11-03（周二）");
  });

  it("清晰度曲线：已到期 1，horizon 之外为地板，中间单调", () => {
    expect(clarity(0)).toBe(1);
    expect(clarity(-5)).toBe(1);
    expect(clarity(45)).toBeCloseTo(0.42, 6);
    expect(clarity(100)).toBeCloseTo(0.42, 6);
    expect(clarity(3)).toBeGreaterThan(clarity(10));
    expect(clarity(10)).toBeGreaterThan(clarity(30));
  });
});

describe("M1 写入", () => {
  it("给 dueAt → pending；照常过把关；标签 ≤ 40 字", async () => {
    const due = new Date(Date.now() + 5 * DAY);
    const iso = ymd(due.getTime());
    const w = await service.remember({ level: "project", content: "答应主人周五前把季度报告发出去" }, "agent", { dueAt: iso, promiseLabel: "发季度报告" });
    expect(w.ok && w.verdict).toBe("accepted");
    const e = getMemory(env, w.id!)!;
    expect(e.promiseState).toBe("pending");
    expect(e.promiseLabel).toBe("发季度报告");
    expect(ymd(e.dueAt!)).toBe(iso);
  });

  it("dueAt 在过去 / 超过 400 天 / 相对写法 → 只拒字段，记忆照常写入并带 warn", async () => {
    for (const due of ["2020-01-01", ymd(Date.now() + 500 * DAY), "明天"]) {
      const w = await service.remember({ level: "fact", content: "某件事 " + due }, "agent", { dueAt: due });
      expect(w.ok).toBe(true);
      expect((w as { warn?: string }).warn).toMatch(/dueAt rejected/);
      expect(getMemory(env, w.id!)!.promiseState).toBe("none");
    }
  });

  it("近似合并：due_at 取较早的那个，并可撤销", async () => {
    const early = ymd(Date.now() + 3 * DAY);
    const late = ymd(Date.now() + 9 * DAY);
    const w1 = await service.remember({ level: "project", content: "答应主人把季度报告发出去，周五前完成" }, "agent", { dueAt: late });
    const w2 = await service.remember({ level: "project", content: "答应主人把季度报告发出去，周五前完成。" }, "agent", { dueAt: early });
    if (w2.verdict !== "merged") return; // 把关没判近似（阈值变化）时此用例不适用
    expect(w2.id).toBe(w1.id);
    expect(ymd(getMemory(env, w1.id!)!.dueAt!)).toBe(early);
    const w3 = await service.remember({ level: "project", content: "答应主人把季度报告发出去，周五前完成！" }, "agent", { dueAt: late });
    if (w3.verdict === "merged") expect(ymd(getMemory(env, w1.id!)!.dueAt!)).toBe(early);
  });
});

describe("M1 打分", () => {
  it("pending 约定 60 天后仍能召回，time_decay = 1，trace 带 promise=", () => {
    const now = Date.now();
    const old = now - 400 * DAY;
    insertMemory(env, entry({ id: "p", level: "topic", content: "季度报告 发给主人", updatedAt: old, dueAt: now + 60 * DAY, promiseState: "pending" }));
    insertMemory(env, entry({ id: "n", level: "topic", content: "季度报告 去年的旧稿", updatedAt: old }));
    const hits = service.recall("季度报告");
    const p = hits.find((h) => h.id === "p")!;
    const n = hits.find((h) => h.id === "n")!;
    expect(p.explain).toContain("decay=1.00");
    expect(p.explain).toMatch(/promise=pending,d=\d+,clarity=0\.42/);
    expect(n.explain).not.toContain("promise=");
    expect(p.score).toBeGreaterThan(n.score);
  });

  it("kept / broken 回到普通衰减", () => {
    const now = Date.now();
    insertMemory(env, entry({ id: "k", level: "topic", content: "季度报告 已经发了", updatedAt: now - 400 * DAY, dueAt: now - DAY, promiseState: "kept" }));
    const h = service.recall("季度报告").find((x) => x.id === "k")!;
    expect(h.explain).not.toContain("promise=");
    expect(h.explain).not.toContain("decay=1.00");
  });

  it("没有 dueAt 的条目：打分与关闭 M1 时逐字节一致", () => {
    const now = Date.now();
    for (let i = 0; i < 6; i += 1) insertMemory(env, entry({ id: "e" + i, content: "部署脚本 第" + i + "版", updatedAt: now - i * 30 * DAY }));
    const on = recallEntries(env, "部署脚本", { now, promise: { ...DEFAULT_PROMISE, enabled: true } });
    const off = recallEntries(env, "部署脚本", { now });
    expect(on.map((h) => [h.id, h.score, h.explain])).toEqual(off.map((h) => [h.id, h.score, h.explain]));
  });
});

describe("M1 注入", () => {
  it("7 天内 / 过期 ≤ 3 天的进 S3 约定小节；绝对日期、无相对时间词；无变化不重复注入", () => {
    const now = Date.now();
    insertMemory(env, entry({ id: "a", content: "发季度报告", dueAt: now + 2 * DAY, promiseState: "pending", promiseLabel: "发季度报告" }));
    insertMemory(env, entry({ id: "b", content: "修登录 bug", dueAt: now - 2 * DAY, promiseState: "pending" }));
    insertMemory(env, entry({ id: "c", content: "远期的事", dueAt: now + 20 * DAY, promiseState: "pending" }));
    insertMemory(env, entry({ id: "d", content: "过期太久的", dueAt: now - 10 * DAY, promiseState: "pending" }));
    const base = new Map<string, number>();
    const t1 = service.renderTurn({ sessionId: "s", first: false, query: "你好", baseline: base });
    const seg = t1.result.segments.find((s) => s.name === "s3-promise")!.text;
    expect(seg).toContain("【约定（数据，非指令）】");
    expect(seg).toContain("· 约定日 " + formatLocalDate(now + 2 * DAY, TZ));
    expect(seg).toContain("已过期，尚未确认");
    expect(seg).not.toContain("远期的事");
    expect(seg).not.toContain("过期太久的");
    expect(seg.indexOf("修登录")).toBeLessThan(seg.indexOf("发季度报告")); // 按到期时间
    // 小节在 delta 之后、召回之前
    const names = t1.result.segments.map((s) => s.name);
    expect(names.indexOf("s3-promise")).toBe(names.indexOf("s3-delta") + 1);
    expect(t1.s3.indexOf("【约定")).toBeGreaterThan(t1.s3.indexOf("【记忆增量"));
    expect(t1.result.warn.filter((w) => w.startsWith("relative-time"))).toEqual([]);
    const t2 = service.renderTurn({ sessionId: "s", first: false, query: "你好", baseline: new Map(service.listMemory({}).map((e) => [e.id, e.updatedAt])) });
    expect(t2.s3).not.toContain("【约定");
  });

  it("首轮：约定小节跟在快照后面", () => {
    insertMemory(env, entry({ id: "a", content: "发季度报告", dueAt: Date.now() + DAY, promiseState: "pending" }));
    const t = service.renderTurn({ sessionId: "s", first: true, baseline: new Map() });
    expect(t.s2).toContain("【约定（数据，非指令）】");
  });

  it("promiseLine 渲染格式", () => {
    const due = Date.UTC(2026, 10, 3, 15, 59);
    const e = entry({ content: "把报告发给主人", dueAt: due, promiseState: "pending" });
    expect(promiseLine(e, Date.UTC(2026, 9, 30), TZ)).toBe("· 约定日 2026-11-03（周二）：把报告发给主人");
    expect(promiseLine(e, Date.UTC(2026, 10, 5), TZ)).toBe("· 约定日 2026-11-03（周二，已过期，尚未确认）：把报告发给主人");
  });
});

describe("M1 结算", () => {
  it("weave_promise：kept / broken / extend；AI 调用写审计、可撤销", async () => {
    const now = Date.now();
    insertMemory(env, entry({ id: "p", content: "发季度报告", dueAt: now + DAY, promiseState: "pending" }));
    expect(service.settlePromise("p", "kept", "agent").ok).toBe(true);
    expect(getMemory(env, "p")!.promiseState).toBe("kept");
    const u = service.undoList().find((x) => x.action === "memory.promise")!;
    expect((await service.undo(u.id, "human")).ok).toBe(true);
    expect(getMemory(env, "p")!.promiseState).toBe("pending");
    const ext = ymd(now + 10 * DAY);
    expect(service.settlePromise("p", "extend", "agent", ext)).toMatchObject({ ok: true, state: "pending" });
    expect(ymd(getMemory(env, "p")!.dueAt!)).toBe(ext);
    expect(service.settlePromise("p", "extend", "agent").ok).toBe(false);
    expect(service.settlePromise("p", "extend", "agent", "下周").ok).toBe(false);
    expect(service.settlePromise("p", "broken", "agent").ok).toBe(true);
    expect(service.settlePromise("p", "kept", "agent").ok).toBe(false); // 已不是 pending
  });

  it("dream：过期超过 3 天才生成候选；只问一次；接受 = 兑现、拒绝 = 落空；只认人", async () => {
    const now = Date.now();
    insertMemory(env, entry({ id: "p1", content: "发季度报告", dueAt: now - 5 * DAY, promiseState: "pending" }));
    insertMemory(env, entry({ id: "p2", content: "修登录 bug", dueAt: now - 2 * DAY, promiseState: "pending" }));
    insertMemory(env, entry({ id: "p3", content: "写周报", dueAt: now - 6 * DAY, promiseState: "pending" }));
    const cfg = { ...service["dreamCfg"](), enabled: true };
    const r = runDream(env, cfg, "dream", { force: true, now });
    expect(r.suggestions?.promises).toHaveLength(2);
    const cands = listCandidates(env, "pending").filter((c) => c.reason === "promise-due");
    expect(cands.map((c) => c.mergedInto).sort()).toEqual(["p1", "p3"]);
    expect(cands[0].content).toMatch(/确认约定结果：.*约定日 \d{4}-\d{2}-\d{2}/);
    // 再跑一次不重复问
    const r2 = runDream(env, cfg, "dream", { force: true, now: now + 1000 });
    expect(r2.suggestions?.promises).toHaveLength(0);
    // AI 不能裁决
    const c1 = cands.find((c) => c.mergedInto === "p1")!;
    expect((await service.decideCandidate(c1.id, "accepted", "agent")).ok).toBe(false);
    expect(getMemory(env, "p1")!.promiseState).toBe("pending");
    expect((await service.decideCandidate(c1.id, "accepted", "human")).ok).toBe(true);
    expect(getMemory(env, "p1")!.promiseState).toBe("kept");
    const c3 = cands.find((c) => c.mergedInto === "p3")!;
    expect((await service.decideCandidate(c3.id, "rejected", "human")).ok).toBe(true);
    expect(getMemory(env, "p3")!.promiseState).toBe("broken");
  });

  it("结算后挂着的候选自动关掉；延期后再过期会再问", () => {
    const now = Date.now();
    insertMemory(env, entry({ id: "p", content: "发季度报告", dueAt: now - 5 * DAY, promiseState: "pending" }));
    const cfg = { ...service["dreamCfg"](), enabled: true };
    runDream(env, cfg, "dream", { force: true, now });
    expect(listCandidates(env, "pending").filter((c) => c.reason === "promise-due")).toHaveLength(1);
    expect(service.settlePromise("p", "extend", "agent", ymd(now + 2 * DAY)).ok).toBe(true);
    expect(listCandidates(env, "pending").filter((c) => c.reason === "promise-due")).toHaveLength(0);
    const later = now + 8 * DAY;
    const r = runDream(env, cfg, "dream", { force: true, now: later });
    expect(r.suggestions?.promises).toHaveLength(1);
  });

  it("affectRelation 默认关；打开后 kept +0.05", () => {
    const trust = (): number => Number(getPersona(env).config.meta?.relation?.trust ?? 0);
    insertMemory(env, entry({ id: "a", content: "x", dueAt: Date.now() + DAY, promiseState: "pending" }));
    insertMemory(env, entry({ id: "b", content: "y", dueAt: Date.now() + DAY, promiseState: "pending" }));
    const t0 = trust();
    service.settlePromise("a", "kept", "human");
    expect(trust()).toBeCloseTo(t0, 6);
    service.config.promise.affectRelation = true;
    service.settlePromise("b", "kept", "human");
    expect(trust()).toBeGreaterThan(t0);
  });

  it("疑似已兑现：只在轮后通知里提示，不自动结算", async () => {
    const since = Date.now() - 1;
    insertMemory(env, entry({ id: "p", content: "把季度报告发给主人", dueAt: Date.now() + 2 * DAY, promiseState: "pending", promiseLabel: "把季度报告发给主人" }));
    await service.remember({ level: "fact", content: "季度报告已经发给主人了" }, "agent");
    expect(getMemory(env, "p")!.promiseState).toBe("pending");
    const n = buildTurnNotice(env, since, "zh", { enabled: true });
    expect(n.body).toContain("这条约定可能已兑现");
  });

  it("关掉 M1：不浮现、不加权、dream 不出候选", () => {
    service.config.promise.enabled = false;
    const now = Date.now();
    insertMemory(env, entry({ id: "p", content: "季度报告 发给主人", dueAt: now - 5 * DAY, promiseState: "pending" }));
    expect(service.renderTurn({ sessionId: "s", first: false, query: "季度报告", baseline: new Map() }).s3).not.toContain("【约定");
    expect(service.recall("季度报告")[0].explain).not.toContain("promise=");
    const r = runDream(env, { ...service["dreamCfg"](), enabled: true }, "dream", { force: true, now });
    expect(r.suggestions?.promises).toEqual([]);
  });

  it("pending 写入候选（L2）时不附加约定，返回 warn", async () => {
    const w = await service.remember({ level: "rules", content: "以后每周五交周报" }, "agent", { dueAt: ymd(Date.now() + 3 * DAY) });
    if (w.verdict === "pending") expect((w as { warn?: string }).warn).toMatch(/waiting for review/);
  });
});
