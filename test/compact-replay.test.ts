/**
 * roadmap v0.3 G7：压缩后重放（退路方案：检查消息列表里的压缩标记）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import plugin, { needsReplay } from "../src/host/index";

type Handler = (payload: unknown, next?: () => unknown) => unknown;
type Msg = { role: string; content: Array<{ type?: string; text: string }>; source?: { kind: string; form?: string; sections?: Array<{ name: string }> } };

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

async function turn(agent: object, messages: Msg[], n: number): Promise<Msg[]> {
  const out = (await handlers.get("agent/pre-step")!({ agent, messages, turn: n, step: 1 }, () => ({ kind: "enter", messages }))) as { messages: Msg[] };
  return out.messages.slice(messages.length);
}

const user = (t: string): Msg => ({ role: "user", content: [{ type: "text", text: t }] });
const checkpoint = (): Msg => ({ role: "user", content: [{ text: "This is an automatically generated checkpoint condensing an earlier span…" }], source: { kind: "compaction", form: "summary" } });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memweave-creplay-"));
  handlers = new Map();
  plugin.apply(makeCtx(), { dataDir: dir });
});

afterEach(() => {
  plugin.dispose();
  rmSync(dir, { recursive: true, force: true });
});

describe("needsReplay 判定", () => {
  it("无压缩标记 → 不重放（宿主只传增量消息时不误判）", () => {
    expect(needsReplay([user("hi")])).toBe(false);
    expect(needsReplay([])).toBe(false);
  });
  it("压缩标记之后没有 S2 → 重放；之后已有 S2 → 不重放", () => {
    const s2: Msg = { role: "user", content: [{ text: "x" }], source: { kind: "runtime-context", sections: [{ name: "memweave:s2-snapshot" }] } };
    expect(needsReplay([s2, checkpoint(), user("继续")])).toBe(true);
    expect(needsReplay([checkpoint(), s2, user("继续")])).toBe(false);
  });
});

describe("G7 压缩后重放", () => {
  it("压缩后下一轮重发 S2，附本会话写过的记忆和查过的项目", async () => {
    const service = plugin.runtime()!.service;
    const agent = { id: "a1", session: { id: "s-replay" } };
    await service.remember({ level: "user", content: "主人喜欢简洁回复" }, "human");
    const first = await turn(agent, [user("你好")], 1);
    expect(first.length).toBe(1);

    await service.remember({ level: "project", project: "忆织", content: "v0.3 正在做压缩后重放" }, "agent", { sessionId: "s-replay", turn: 1 });
    service.noteSessionProject("s-replay", "忆织");

    const normal = await turn(agent, [user("普通的下一轮")], 2);
    const normalText = normal.map((m) => m.content[0].text).join("\n");
    expect(normalText).not.toContain("本会话写过的记忆");

    const after = await turn(agent, [checkpoint(), user("压缩后继续")], 3);
    const text = after.map((m) => m.content[0].text).join("\n");
    expect(text).toContain("本会话写过的记忆");
    expect(text).toContain("v0.3 正在做压缩后重放");
    expect(text).toContain("本会话查过的项目");
    expect(text).toContain("忆织");
    expect(after[0].source?.sections?.some((s) => s.name === "memweave:s2-snapshot")).toBe(true);
  });

  it("关闭开关 → 压缩后不重放", async () => {
    const service = plugin.runtime()!.service;
    service.config.replay.enabled = false;
    const agent = { id: "a2", session: { id: "s-off" } };
    await turn(agent, [user("你好")], 1);
    await service.remember({ level: "fact", content: "关闭时不该重放的条目" }, "agent", { sessionId: "s-off", turn: 1 });
    const after = await turn(agent, [checkpoint(), user("继续")], 2);
    expect(after.map((m) => m.content[0].text).join("\n")).not.toContain("本会话写过的记忆");
  });
});
