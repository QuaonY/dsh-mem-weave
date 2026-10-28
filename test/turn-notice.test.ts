/**
 * 轮后通知：本轮写了/整理了记忆，turn-stopping 时往会话追加一条 memweave notice。
 * 走真实 plugin.apply + 假宿主 ctx（同时接 agent/pre-step 与 agent/turn-stopping）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import plugin from "../src/host/index";
import { buildTurnNotice } from "../src/host/turn-notice";

type Handler = (payload: unknown, next?: () => unknown) => unknown;
type Appended = { type: string; data: { role: string; content: Array<{ text: string }>; source: { kind: string; form: string; summary: string } } };

let dir: string;
let handlers: Map<string, Handler>;

function makeCtx(): unknown {
  return {
    get: (): unknown => undefined,
    logger: { warn: () => undefined },
    on(event: string, handler: Handler): () => void {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
  };
}

function makeAgent(): { agent: object; appended: Appended[] } {
  const appended: Appended[] = [];
  const agent = {
    id: "agent-n",
    session: {
      id: "session-notice",
      append(type: string, data: Appended["data"]): void {
        appended.push({ type, data });
      },
    },
  };
  return { agent, appended };
}

async function startTurn(agent: object, turn: number): Promise<void> {
  const messages = [{ role: "user", content: [{ type: "text", text: "hello" }] }];
  await handlers.get("agent/pre-step")!({ agent, messages, turn, step: 1 }, () => ({ kind: "enter", messages }));
}

async function stopTurn(agent: object, turn: number): Promise<unknown> {
  return await handlers.get("agent/turn-stopping")!({ agent, turn });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memweave-notice-"));
  handlers = new Map();
});

afterEach(() => {
  plugin.dispose(); // 内部已 stopMirror + 关库
  rmSync(dir, { recursive: true, force: true });
});

describe("轮后通知 turn notice", () => {
  it("本轮写入记忆后追加一条 memweave notice，折叠摘要带条数，正文带内容", async () => {
    plugin.apply(makeCtx(), { dataDir: dir });
    const service = plugin.runtime()!.service;
    expect(handlers.has("agent/turn-stopping")).toBe(true);
    const { agent, appended } = makeAgent();

    await startTurn(agent, 1);
    expect((await service.remember({ level: "user", content: "用户喜欢简洁回复" }, "agent")).ok).toBe(true);
    expect((await service.remember({ level: "project", content: "忆织插件版本号放在 package.json" }, "agent")).ok).toBe(true);
    const ret = await stopTurn(agent, 1);

    expect(ret).toBeUndefined(); // serial 事件不拦截
    expect(appended).toHaveLength(1);
    const msg = appended[0];
    expect(msg.type).toBe("user/message");
    expect(msg.data.role).toBe("user");
    expect(msg.data.source).toMatchObject({ kind: "memweave", form: "notice" });
    expect(msg.data.source.summary).toBe("忆织：本轮写入 2 条");
    const body = msg.data.content[0].text;
    expect(body).toContain("非用户发言");
    expect(body).toContain("用户喜欢简洁回复");
    expect(body).toContain("忆织插件版本号放在 package.json");
  });

  it("本轮没有记忆动作就不出卡片；同一轮重复 turn-stopping 不重复计数", async () => {
    plugin.apply(makeCtx(), { dataDir: dir });
    const service = plugin.runtime()!.service;
    const { agent, appended } = makeAgent();

    await startTurn(agent, 1);
    await stopTurn(agent, 1);
    expect(appended).toHaveLength(0);

    await new Promise((r) => setTimeout(r, 3)); // 轮界按毫秒划分，快机器上同一毫秒会被两轮同时圈进
    await startTurn(agent, 2);
    await service.remember({ level: "fact", content: "第二轮写入的一条事实" }, "agent");
    await stopTurn(agent, 2);
    await stopTurn(agent, 2);
    expect(appended).toHaveLength(1);
    expect(appended[0].data.source.summary).toBe("忆织：本轮写入 1 条");
  });

  it("敏感内容被拦截：只报条数，不把原文写进通知", async () => {
    plugin.apply(makeCtx(), { dataDir: dir });
    const service = plugin.runtime()!.service;
    const { agent, appended } = makeAgent();

    await startTurn(agent, 1);
    const out = await service.remember({ level: "user", content: "key：sk-0000test0000fake0000test0000fake" }, "agent");
    expect(out.ok).toBe(false);
    await stopTurn(agent, 1);

    expect(appended).toHaveLength(1);
    expect(appended[0].data.source.summary).toBe("忆织：本轮已拦截 1 条");
    expect(appended[0].data.content[0].text).not.toContain("sk-0000test");
  });

  it("关闭开关后不追加", async () => {
    plugin.apply(makeCtx(), { dataDir: dir });
    const service = plugin.runtime()!.service;
    service.config.governance.turnNotice = { enabled: false };
    const { agent, appended } = makeAgent();

    await startTurn(agent, 1);
    await service.remember({ level: "user", content: "关掉通知后写的记忆" }, "agent");
    await stopTurn(agent, 1);
    expect(appended).toHaveLength(0);
  });

  it("dream 整理计入「整理」，英文提示语言输出英文", async () => {
    plugin.apply(makeCtx(), { dataDir: dir });
    const service = plugin.runtime()!.service;
    const since = Date.now() - 1;
    const w = await service.remember({ level: "fact", content: "will expire soon" }, "agent");
    expect(w.ok).toBe(true);
    service.revise(w.id!, { status: "stale" }, "human");
    const notice = buildTurnNotice(service.env, since, "en", { enabled: true });
    expect(notice.enabled).toBe(true);
    expect(notice.summary).toBe("MemWeave: 1 written, 1 organized");
    expect(notice.body).toContain("will expire soon");
  });
});
