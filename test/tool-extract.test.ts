/**
 * weave_extract：有 LLM provider 才可用；没有时返回 E_UNAVAILABLE
 * 而不是像以前那样把「LLM 不可用」说成「未发现新的记忆内容」。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openService } from "../src/host/index";
import { buildTools, type WeaveTool } from "../src/host/tools";
import type { WeaveService } from "../src/host/service";
import { captureL0Message, DEFAULT_L0_CONFIG } from "../src/store/l0";

let dir: string;
let service: WeaveService;
let tool: WeaveTool;
const SID = "sess-extract";
const exec = { agent: { session: { id: SID } } };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memweave-extract-tool-"));
  const rt = openService(dir);
  service = rt.service;
  tool = buildTools(service).find((t) => t.descriptor.name === "weave_extract")!;
  captureL0Message(rt.env, SID, "user", "我的项目使用 TypeScript 和 React", { ...DEFAULT_L0_CONFIG, enabled: true });
});

afterEach(() => {
  service.env.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("weave_extract 的 LLM 可用性", () => {
  it("没有 provider 时显式返回 E_UNAVAILABLE，并指向 weave_remember", async () => {
    expect(service.llmCall).toBeNull();
    const r = (await tool.handler({}, exec)) as {
      ok: boolean;
      code?: string;
      message?: string;
      hint?: string;
    };
    expect(r.ok).toBe(false);
    expect(r.code).toBe("E_UNAVAILABLE");
    expect(r.message).toContain("LLM");
    expect(r.hint).toContain("weave_remember");
  });

  it("宿主注入 provider 后真的走抽取并生成候选", async () => {
    service.llmCall = async () =>
      JSON.stringify([
        {
          level: "project",
          content: "项目技术栈：TypeScript、React",
          keywords: ["TypeScript", "React"],
          confidence: 0.9,
          reason: "用户明确说明",
        },
      ]);
    const r = (await tool.handler({}, exec)) as {
      ok: boolean;
      candidatesCreated?: number;
      autoAccepted?: number;
    };
    expect(r.ok).toBe(true);
    expect(r.candidatesCreated).toBe(1);
    expect(r.autoAccepted).toBe(1);
  });
});
