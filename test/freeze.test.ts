/**
 * test/freeze（§15 / I4）：人格改配置后本会话注入不变（冻结快照），
 * /weave reload 后重新装配才生效。走真实 plugin.apply + 假宿主 ctx。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import plugin, { openService } from "../src/host/index";
import type { WeaveService } from "../src/host/service";
import type { WeaveEnv } from "../src/store/db";

interface FakeCommand {
  name: string;
  handler: (raw: string) => void;
}

let dir: string;
let env: WeaveEnv;
let service: WeaveService;
let sections: Map<string, string>;
let command: FakeCommand | null;
let preStepHandler: ((payload: unknown, next: () => unknown) => unknown) | null;

function makeCtx(): unknown {
  const host = {
    section(spec: { name: string; order: number; text: string }): () => void {
      sections.set(spec.name, spec.text);
      return () => {
        sections.delete(spec.name);
      };
    },
    getSectionOrder(): number | undefined {
      return undefined;
    },
  };
  return {
    get(key: string): unknown {
      if (key === "systemPrompt") return host;
      if (key === "commands") {
        return {
          register(c: FakeCommand): () => void {
            command = c;
            return () => {
              command = null;
            };
          },
        };
      }
      return undefined;
    },
    logger: { warn: () => undefined },
    on(event: string, handler: (payload: unknown, next: () => unknown) => unknown): () => void {
      if (event !== "agent/pre-step") return () => undefined;
      preStepHandler = handler;
      return () => {
        if (preStepHandler === handler) preStepHandler = null;
      };
    },
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memweave-freeze-"));
  const rt = openService(dir);
  env = rt.env;
  service = rt.service;
  sections = new Map();
  command = null;
  preStepHandler = null;
});

afterEach(() => {
  plugin.dispose();
  service.stopMirror(false);
  env.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("freeze：会话内冻结、reload 解冻（§15 / I4）", () => {
  it("agent/pre-step waterfall 首轮注入 S2，后续 turn 注入 S3", async () => {
    plugin.apply(makeCtx(), { dataDir: dir });
    const activeService = plugin.runtime()?.service;
    expect(activeService).toBeDefined();
    const firstWrite = await activeService!.remember({ level: "user", content: "snapshot memory content" }, "human");
    expect(firstWrite.ok).toBe(true);
    const handler = preStepHandler;
    expect(handler).toBeTypeOf("function");
    const agent = { id: "agent-1", session: { id: "session-s2-s3" } };
    const firstMessages = [{ role: "user", content: [{ type: "text", text: "what is my preference?" }] }];
    const first = await handler!({ agent, messages: firstMessages, turn: 1, step: 1 }, () => ({ kind: "enter", messages: firstMessages })) as {
      messages: Array<{ content?: Array<{ text?: string }> }>;
    };
    expect(first.messages).toHaveLength(2);
    expect(first.messages[1].content?.[0]?.text).toContain("snapshot memory content");

    await new Promise((resolve) => setTimeout(resolve, 5));
    const laterWrite = await activeService!.remember({ level: "user", content: "follow-up delta memory" }, "human");
    expect(laterWrite.ok).toBe(true);
    const nextMessages = [{ role: "user", content: [{ type: "text", text: "unrelated follow-up" }] }];
    const second = await handler!({ agent, messages: nextMessages, turn: 2, step: 1 }, () => ({ kind: "enter", messages: nextMessages })) as {
      messages: Array<{ content?: Array<{ text?: string }> }>;
    };
    expect(second.messages).toHaveLength(2);
    expect(second.messages[1].content?.[0]?.text).toContain("follow-up delta memory");
    expect(second.messages[1].content?.[0]?.text).not.toContain("snapshot memory content");

    const toolStep = await handler!({ agent, messages: [], turn: 2, step: 2 }, () => ({ kind: "enter", messages: [] })) as { messages: unknown[] };
    expect(toolStep.messages).toHaveLength(0);
  });

  it("改人格后本会话不变，/weave reload 后变", async () => {
    service.updatePersona({ stance: "初始立场块内容" }, "human");

    plugin.apply(makeCtx(), { dataDir: dir });
    await new Promise((r) => setTimeout(r, 80));

    // 装配完成：初始人格已注册
    const before = sections.get("deployment:persona-prefix") ?? "";
    expect(before).toContain("初始立场块内容");

    // 改人格：注册文本保持冻结
    const upd = service.updatePersona({ stance: "改后立场块内容" }, "human");
    expect(upd.ok).toBe(true);
    const frozen = sections.get("deployment:persona-prefix") ?? "";
    expect(frozen).toContain("初始立场块内容");
    expect(frozen).not.toContain("改后立场块内容");

    // /weave reload：重新装配后生效
    expect(command).not.toBeNull();
    (command as unknown as FakeCommand).handler("reload");
    const after = sections.get("deployment:persona-prefix") ?? "";
    expect(after).toContain("改后立场块内容");
    expect(after).not.toContain("初始立场块内容");
  });
});
