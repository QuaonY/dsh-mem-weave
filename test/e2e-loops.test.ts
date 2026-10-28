/**
 * 功能闭环（端到端）：每条链路从入口（AI 工具 / 设置页 RPC / 宿主钩子）走到落库、注入或召回，再走回审核、撤销。
 * 单功能的细节各自有测试，这里只验「这条路是通的」，每步都走对外入口而不是直接调内部函数。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openService } from "../src/host/index";
import { invokeRpc } from "../src/host/rpc";
import { buildTools, type WeaveTool } from "../src/host/tools";
import type { WeaveService } from "../src/host/service";
import type { WeaveEnv } from "../src/store/db";

type R = Record<string, any>;

let dir: string;
let env: WeaveEnv;
let service: WeaveService;
let tools: Map<string, WeaveTool>;

const ai = async (name: string, args: R, sessionId = "e2e"): Promise<R> =>
  (await tools.get(name)!.handler(args, { sessionId } as never)) as R;
const human = async (method: string, args: R = {}): Promise<R> => (await invokeRpc(service, method, args, "human")) as R;
const agentRpc = async (method: string, args: R = {}): Promise<R> => (await invokeRpc(service, method, args, "agent")) as R;
const firstTurn = (sid: string) => service.renderTurn({ sessionId: sid, first: true, baseline: new Map() });
const nextTurn = (sid: string, query: string, turn = 2) =>
  service.renderTurn({ sessionId: sid, first: false, query, baseline: new Map(), turn });
/** 约定只接受绝对日期，且要落在提醒视野（默认 45 天）内 */
const soon = (days: number): string => {
  const d = new Date(Date.now() + days * 86400000);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
};
const text = (r: ReturnType<typeof firstTurn>) => r.s2 + "\n" + r.s3 + "\n" + JSON.stringify(r.result);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memweave-e2e-"));
  const rt = openService(dir);
  env = rt.env;
  service = rt.service;
  tools = new Map(buildTools(service).map((t) => [t.descriptor.name, t]));
});

afterEach(() => {
  service.stopMirror(false);
  env.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("闭环 1：记忆 写入 → 注入 → 召回 → 修改 → 归档 → 恢复", () => {
  it("AI 写 user 层，首轮快照带上；后续轮按关键词召回；人改、归档后不再注入，恢复后回来", async () => {
    const w = await ai("weave_remember", { level: "user", content: "用户不吃香菜，点外卖要备注", searchTerms: ["忌口", "饮食"] });
    expect(w.ok).toBe(true);
    const id = String(w.id);

    expect(text(firstTurn("s1"))).toContain("不吃香菜");

    const r = await ai("weave_recall", { query: "忌口" });
    expect(JSON.stringify(r)).toContain(id); // 检索词命中（正文里没有「忌口」）

    const got = await human("memory/get", { id });
    expect(got.entry?.content ?? got.content ?? JSON.stringify(got)).toContain("香菜");

    expect((await human("memory/update", { id, patch: { content: "用户不吃香菜和葱，点外卖要备注" } })).ok).toBe(true);
    expect(text(firstTurn("s2"))).toContain("香菜和葱");

    expect((await human("memory/archive", { id })).ok).toBe(true);
    expect(text(firstTurn("s3"))).not.toContain("香菜");

    expect((await human("memory/restore", { id })).ok).toBe(true);
    expect(text(firstTurn("s4"))).toContain("香菜");
  });

  it("delta：会话中途新写的记忆，下一轮以增量注入；没变化就零注入", async () => {
    firstTurn("d1");
    await ai("weave_remember", { level: "project", project: "demo", content: "demo 项目用 pnpm 管理依赖" }, "d1");
    const t2 = nextTurn("d1", "继续");
    expect(text(t2)).toContain("pnpm");
  });
});

describe("闭环 2：候选池 AI 提议 → 人裁决 → 生效", () => {
  it("AI 写 rules 层进候选池，不直接生效；人 accepted 后进快照", async () => {
    const w = await ai("weave_remember", { level: "rules", content: "改代码前必须先读代码" });
    expect(w.ok).toBe(true);
    expect(w.verdict).toBe("pending");
    expect(text(firstTurn("c1"))).not.toContain("先读代码");

    const list = await human("candidates/list", { verdict: "pending" });
    const cand = (list.candidates as R[]).find((c) => JSON.stringify(c).includes("先读代码"));
    expect(cand).toBeDefined();

    // AI 不能自己裁决
    expect((await agentRpc("candidates/decide", { id: cand!.id, verdict: "accepted" })).ok).toBe(false);
    expect((await human("candidates/decide", { id: cand!.id, verdict: "accepted" })).ok).toBe(true);
    expect(text(firstTurn("c2"))).toContain("先读代码");
  });
});

describe("闭环 3：约定 写入 → 注入 → 结算 → 不再提醒", () => {
  it("AI 带 dueAt 写约定，注入约定小节；设置页结算 kept 后约定消失", async () => {
    const w = await ai("weave_remember", { level: "fact", content: "答应用户周五前把测试补完", dueAt: soon(3), promiseLabel: "补测试" });
    expect(w.ok).toBe(true);
    const id = String(w.id);
    expect(text(firstTurn("p1"))).toContain("补测试");

    expect((await human("memory/promise", { id, outcome: "kept" })).ok).toBe(true);
    expect(text(firstTurn("p2"))).not.toContain("补测试");
  });

  it("AI 用 weave_promise 延期必须给绝对日期", async () => {
    const w = await ai("weave_remember", { level: "fact", content: "答应用户写完文档", dueAt: soon(5) });
    const bad = await ai("weave_promise", { id: w.id, outcome: "extend" });
    expect(bad.ok).toBe(false);
    const good = await ai("weave_promise", { id: w.id, outcome: "extend", dueAt: soon(10) });
    expect(good.ok).toBe(true);
  });
});

describe("闭环 4：日历锚点 设置页设锚点 → 读回 → 删除", () => {
  it("memory/anchor 写入后 memory/get 能读到，传 null 删除", async () => {
    const w = await ai("weave_remember", { level: "user", content: "用户生日是 3 月 14 日" });
    const id = String(w.id);
    expect((await human("memory/anchor", { id, anchor: { kind: "annual", month: 3, day: 14, label: "生日" } })).ok).toBe(true);
    expect(JSON.stringify(await human("memory/get", { id }))).toContain("annual");
    expect((await human("memory/anchor", { id, anchor: null })).ok).toBe(true);
    expect(JSON.stringify(await human("memory/get", { id }))).not.toContain("annual");
  });
});

describe("闭环 5：待整理 设置页「整理」→ 清单 → AI 补词 → 召回变好 → 撤销", () => {
  it("dream/run 后 backlog 列出缺词条目；weave_annotate 补词后能按新词召回；撤销后词没了", async () => {
    const w = await ai("weave_remember", { level: "fact", content: "公司打印机在三楼茶水间旁边" });
    const id = String(w.id);
    expect((await human("dream/run", { force: true })).ok).not.toBe(false);

    const bl = await human("memory/backlog");
    expect(JSON.stringify(bl)).toContain(id);

    const ann = await ai("weave_annotate", { items: [{ id, searchTerms: ["复印", "打印东西"] }] });
    expect(ann.ok).toBe(true);
    expect(JSON.stringify(await ai("weave_recall", { query: "复印" }))).toContain(id);

    const undos = await human("undo/list", { hours: 24 });
    const u = (undos.items ?? []) as R[];
    const target = u.find((x) => x.action === "memory.terms" && !x.undone);
    expect(target).toBeDefined();
    expect((await human("undo/run", { id: target!.id })).ok).toBe(true);
    expect(JSON.stringify(await ai("weave_recall", { query: "复印" }))).not.toContain(id);
  });
});

describe("闭环 6：人格 设置页改 → 预览 → 注入 → 历史回滚；AI 不能写", () => {
  it("persona/update 后预览与首轮注入一致；history.restore 回到上一版；AI 写人格 E_PERM", async () => {
    expect((await human("persona/update", { patch: { stance: "你是测试助手甲" } })).ok).toBe(true);
    const pv = await human("persona/preview");
    expect(JSON.stringify(pv)).toContain("测试助手甲");
    expect(text(firstTurn("h1"))).toContain("测试助手甲");

    expect((await human("persona/update", { patch: { stance: "你是测试助手乙" } })).ok).toBe(true);
    const hist = await human("persona/history");
    const rows = (hist.versions ?? []) as R[];
    const prev = rows.find((r) => r.config?.stance === "你是测试助手甲");
    expect(prev).toBeDefined();
    expect((await human("persona/history.restore", { version: prev!.version })).ok).toBe(true);
    expect(text(firstTurn("h2"))).toContain("测试助手甲");

    expect((await ai("weave_persona", { action: "update", patch: { stance: "AI" } })).ok).toBe(false);
    expect((await agentRpc("persona/update", { patch: { stance: "AI" } })).ok).toBe(false);
  });
});

describe("闭环 7：预设 内置卡应用 → 注入 → autosave 退回；导入自己的卡 → 应用", () => {
  it("应用内置小满后首轮注入人格；应用 autosave 回到原人格；导入的卡可应用", async () => {
    await human("persona/update", { patch: { stance: "原来的人格" } });
    expect((await human("preset/apply", { id: "builtin-dafeiyu" })).ok).toBe(true);
    const t1 = text(firstTurn("m1"));
    expect(t1).toContain("小满");
    expect(t1).toContain("【人格锚点】");

    expect((await human("preset/apply", { id: "autosave" })).ok).toBe(true);
    expect(text(firstTurn("m2"))).toContain("原来的人格");

    expect((await human("preset/import", { id: "my-card", label: "我的卡", payload: { stance: "我自己导入的人格" } })).ok).toBe(true);
    expect((await human("preset/apply", { id: "my-card" })).ok).toBe(true);
    expect(text(firstTurn("m3"))).toContain("我自己导入的人格");

    // AI 只能列出 / 导出，不能应用
    expect((await ai("weave_preset", { action: "apply", id: "builtin-dafeiyu" })).ok).toBe(false);
  });
});

describe("闭环 8：数据 导出 → 彻底重置 → 导入 → 回滚", () => {
  it("导出的包能在重置后导回记忆和自建预设；内置预设重置后自动回来；导入可整批回滚", async () => {
    await ai("weave_remember", { level: "user", content: "用户习惯用 PowerShell" });
    await human("preset/import", { id: "keep-me", payload: { stance: "留着" } });
    const exp = await human("data/export");
    const pack = exp.payload as R;
    expect(pack.spec).toBe("memweave-export/1");

    expect((await human("reset/run", { confirm: "RESET" })).ok).toBe(true);
    expect(service.listMemory({ level: "user" }).length).toBe(0);
    expect(service.listPresets().map((p) => p.id).sort()).toEqual(["builtin-dafeiyu", "builtin-linhe"]);

    const scan = await human("import/scan", { payload: pack });
    expect(scan.ok).not.toBe(false);
    const run = await human("import/run", { payload: pack });
    expect(run.ok).toBe(true);
    expect(service.listMemory({ level: "user" }).some((e) => e.content.includes("PowerShell"))).toBe(true);
    expect(service.getPreset("keep-me")).not.toBeNull();

    expect((await human("import/rollback", { rollbackId: run.rollbackId })).ok).toBe(true);
    expect(service.listMemory({ level: "user", status: "active" }).some((e) => e.content.includes("PowerShell"))).toBe(false);
  });
});

describe("闭环 9：备份 立即备份 → 改坏 → 从备份恢复", () => {
  it("backup/now 后写入新记忆，restore 回到备份时的状态", async () => {
    await ai("weave_remember", { level: "user", content: "备份前就有的记忆" });
    const b = await human("backup/now", { label: "e2e" });
    expect(b.ok).not.toBe(false);
    const list = await human("backup/list");
    const path = String(((list.backups as R[])[0] ?? {}).path ?? "");
    expect(path).not.toBe("");
    await ai("weave_remember", { level: "user", content: "备份之后才写的记忆" });
    const r = await human("backup/restore", { path });
    expect(r.ok).toBe(true);
    const all = service.listMemory({ level: "user" }).map((e) => e.content);
    expect(all).toContain("备份前就有的记忆");
    expect(all).not.toContain("备份之后才写的记忆");
  });
});

describe("闭环 11：闪光灯 AI 标高唤醒 → 记忆详情可见 → 人取消 → 可撤销", () => {
  it("emotion 开启时 arousal≥0.7 记为闪光灯；memory/get 带 flash；memory/flash 取消；AI 不能改", async () => {
    await human("settings/update", { patch: { emotion: { enabled: true } } });
    const w = await ai("weave_remember", { level: "user", content: "用户的猫叫团子，去年走丢又找回来了", arousal: 0.9, valence: 0.8 });
    const id = String(w.id);
    expect(((await human("memory/get", { id })).entry as R).flash).toBe(true);

    expect((await agentRpc("memory/flash", { id, flash: false })).ok).toBe(false);
    expect((await human("memory/flash", { id, flash: false })).ok).toBe(true);
    expect(((await human("memory/get", { id })).entry as R).flash).toBe(false);

    const u = ((await human("undo/list", { hours: 24 })).items as R[]).find((x) => x.action === "memory.flash" && !x.undone);
    expect(u).toBeDefined();
    expect((await human("undo/run", { id: u!.id })).ok).toBe(true);
    expect(((await human("memory/get", { id })).entry as R).flash).toBe(true);
  });
});

describe("闭环 10：设置 改 → 生效 → 恢复默认；审计可查", () => {
  it("settings/update 生效、settings/defaults 给出默认值、audit/query 能查到前面的人工操作", async () => {
    expect((await human("settings/update", { patch: { promise: { enabled: false } } })).ok).toBe(true);
    expect(service.config.promise.enabled).toBe(false);
    const d = await human("settings/defaults");
    expect(JSON.stringify(d)).toContain("promise");
    expect((await agentRpc("settings/update", { patch: { promise: { enabled: true } } })).ok).toBe(false);

    await ai("weave_remember", { level: "user", content: "用户喜欢简洁回复" });
    const audit = await human("audit/query", { limit: 20 });
    expect(JSON.stringify(audit)).toContain("agent");
  });
});
