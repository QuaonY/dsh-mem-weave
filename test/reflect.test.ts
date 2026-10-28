/**
 * roadmap v0.3 G5：连续工具调用 ≥ 7 次后提示反思；每轮最多 1 次；纯对话轮 0 次；子代理跳过。
 * 走真实 plugin.apply + 假宿主 ctx。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import plugin from "../src/host/index";

type Handler = (payload: unknown, next?: () => unknown) => unknown;
type Msg = { role: string; content: Array<{ text: string }>; source?: { kind: string; form: string } };

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

async function step(agent: object, n: number): Promise<Msg[]> {
  const messages: Msg[] = [{ role: "user", content: [{ text: "hi" }] }];
  const out = (await handlers.get("agent/pre-step")!({ agent, messages, turn: 1, step: n }, () => ({ kind: "enter", messages }))) as { messages: Msg[] };
  return out.messages.filter((m) => m.source?.kind === "memweave" && m.source.form === "notice");
}

async function runTurn(agent: object, steps: number): Promise<number> {
  let hints = 0;
  for (let n = 1; n <= steps; n += 1) hints += (await step(agent, n)).length;
  return hints;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memweave-reflect-"));
  handlers = new Map();
  plugin.apply(makeCtx(), { dataDir: dir });
});

afterEach(() => {
  plugin.dispose();
  rmSync(dir, { recursive: true, force: true });
});

describe("G5 连续工具调用后提示反思", () => {
  it("8 个工具 step（step 1..9）→ 恰好 1 条提示，文字含次数与 weave_remember", async () => {
    const agent = { id: "a1", session: { id: "s1" } };
    let text = "";
    let hints = 0;
    for (let n = 1; n <= 9; n += 1) {
      const got = await step(agent, n);
      hints += got.length;
      if (got.length) text = got[0].content[0].text;
    }
    expect(hints).toBe(1);
    expect(text).toContain("7");
    expect(text).toContain("weave_remember");
    expect(text.length).toBeLessThanOrEqual(120);
  });

  it("同一轮 20 个工具 step → 仍只有 1 条；下一轮重新计", async () => {
    const agent = { id: "a2", session: { id: "s2" } };
    expect(await runTurn(agent, 21)).toBe(1);
    expect(await runTurn(agent, 21)).toBe(1);
  });

  it("纯对话轮（只有 step 1）或工具少于 7 次 → 0 条", async () => {
    const agent = { id: "a3", session: { id: "s3" } };
    expect(await runTurn(agent, 1)).toBe(0);
    expect(await runTurn(agent, 7)).toBe(0);
  });

  it("子代理跳过；关闭开关后 0 条", async () => {
    const sub = { id: "c1", parentId: "a1", session: { id: "s-sub" } };
    expect(await runTurn(sub, 12)).toBe(0);
    plugin.runtime()!.service.config.reflect.enabled = false;
    expect(await runTurn({ id: "a4", session: { id: "s4" } }, 12)).toBe(0);
  });
});
