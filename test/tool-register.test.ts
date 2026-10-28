/**
 * 回归：weave_* 工具必须按 DSH dsh-tools 的契约注册，否则模型拿不到工具、记忆永远写不进库。
 * 契约（dsh-tools 0.2.1 ToolsService.register）：
 *   { name, description, parameters: JSON Schema, output: { schema, render(args, value) }, execute(args, exec) }
 *   缺 output / render 直接抛 TypeError；返回值必须是无损 JSON。
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openService, registerTools, toDshToolDefinition } from "../src/host/index";
import { buildTools } from "../src/host/tools";
import type { WeaveRuntime } from "../src/host/index";

/** 仿 dsh-tools register 的硬性检查 */
function strictRegister(registered: Map<string, Record<string, unknown>>) {
  return (def: Record<string, unknown>): (() => void) => {
    const name = String(def.name);
    const output = def.output as { schema?: unknown; render?: unknown } | undefined;
    if (!output || typeof output !== "object" || typeof output.render !== "function") {
      throw new TypeError('tool "' + name + '" must declare output { schema, render, presentationMeta? }');
    }
    if (typeof def.execute !== "function") throw new TypeError('tool "' + name + '" must declare execute');
    const params = def.parameters as { type?: string } | undefined;
    if (!params || params.type !== "object") throw new TypeError('tool "' + name + '" parameters must be an object schema');
    if (registered.has(name)) throw new Error("duplicate tool " + name);
    registered.set(name, def);
    return () => registered.delete(name);
  };
}

let rt: WeaveRuntime | null = null;
let dir = "";
afterEach(() => {
  rt?.env.close();
  rt = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

describe("weave_* 工具注册", () => {
  it("等 ctx.inject(['tools']) 就绪后注册，20 个全部进工具表", () => {
    dir = mkdtempSync(join(tmpdir(), "mw-tools-"));
    rt = openService(dir);
    const registered = new Map<string, Record<string, unknown>>();
    let pending: ((sub: unknown) => void) | null = null;
    const ctx = {
      inject: (names: string[], cb: (sub: unknown) => void) => {
        expect(names).toEqual(["tools"]);
        pending = cb; // 模拟 tools 服务稍后才就绪
      },
    };
    const status = { registered: [] as string[], failed: [] as string[], lastError: "" };
    registerTools(ctx, buildTools(rt.service), () => undefined, status);
    expect(registered.size).toBe(0);
    (pending as unknown as (sub: unknown) => void)({ tools: { register: strictRegister(registered) } });
    expect(registered.size).toBe(20);
    expect(registered.has("weave_remember")).toBe(true);
    // roadmap v0.7：S1 补检索词、§8 待整理队列、S2 会话内归纳
    for (const n of ["weave_annotate", "weave_backlog", "weave_distill"]) expect(registered.has(n)).toBe(true);
    expect(status.failed).toEqual([]);
    expect(status.registered.length).toBe(20);
  });

  it("没有 inject 时直接用 ctx.tools.register", () => {
    dir = mkdtempSync(join(tmpdir(), "mw-tools-"));
    rt = openService(dir);
    const registered = new Map<string, Record<string, unknown>>();
    registerTools({ tools: { register: strictRegister(registered) } }, buildTools(rt.service), () => undefined);
    expect(registered.size).toBe(20);
  });

  it("通过注册后的定义调用 weave_remember，记忆真的写进库，返回值是无损 JSON", async () => {
    dir = mkdtempSync(join(tmpdir(), "mw-tools-"));
    rt = openService(dir);
    const remember = buildTools(rt.service).find((t) => t.descriptor.name === "weave_remember")!;
    const def = toDshToolDefinition(remember) as {
      execute: (args: unknown, exec: unknown) => Promise<unknown>;
      output: { render: (args: unknown, value: unknown) => Array<{ type: string; text: string }> };
    };
    const value = (await def.execute({ level: "user", content: "用户喜欢简洁的回复" }, {})) as Record<string, unknown>;
    expect(value.ok).toBe(true);
    expect(JSON.parse(JSON.stringify(value))).toEqual(value);
    const rendered = def.output.render({}, value);
    expect(rendered[0].type).toBe("text");
    expect(rt.service.listMemory({}).some((m) => m.content === "用户喜欢简洁的回复")).toBe(true);
  });
});
