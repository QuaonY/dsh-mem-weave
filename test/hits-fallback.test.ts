/**
 * 回归测试：宿主 recall / recallAsync 违约返回 undefined 时渲染不得崩。
 * 1.0.2 起线上报错 TypeError: Cannot read properties of undefined (reading 'length')
 * at finishTurn 的 hits.length —— `let hits = []` 的初值被 undefined 覆盖。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import { openService, type WeaveService } from "../src/host";
import {
  SessionRenderState,
  renderTurn,
  renderTurnAsync,
  type RenderHost,
} from "../src/host/render";
import type { RankedHit } from "../src/core/score";

/** 宿主的 recall 契约是 RankedHit[]，这里故意违约返回 undefined */
const notAnArray = undefined as unknown as RankedHit[];

type HostWithAsync = RenderHost & { recallAsync?: (query: string, opts?: unknown) => Promise<RankedHit[]> };

function asHost(service: WeaveService): HostWithAsync {
  return service as unknown as HostWithAsync;
}

describe("hits 兜底：宿主 recall 返回 undefined", () => {
  let tmpDir: string;
  let service: WeaveService;
  let closeEnv: () => void;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "memweave-hits-fallback-"));
    const runtime = openService(tmpDir);
    service = runtime.service;
    closeEnv = () => runtime.env.close();
  });

  afterEach(() => {
    if (closeEnv) closeEnv();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("renderTurn：同步召回返回 undefined 时不抛异常，结果结构完整", async () => {
    await service.remember({ level: "fact", content: "召回兜底用的记忆" }, "human", {
      sessionId: "s-fallback",
    });
    const host = asHost(service);
    host.recall = () => notAnArray;

    const out = renderTurn(host, new SessionRenderState(), {
      sessionId: "s-fallback",
      first: false,
      query: "兜底",
      baseline: new Map(),
      turn: 2,
    });

    expect(out.result).toBeDefined();
    expect(Array.isArray(out.result.segments)).toBe(true);
    expect(typeof out.s3).toBe("string");
    expect(out.inject).toBe(true);
  });

  it("renderTurnAsync：await recallAsync 返回 undefined 时不抛异常", async () => {
    const host = asHost(service);
    host.recall = () => notAnArray;
    host.recallAsync = async () => notAnArray;

    const out = await renderTurnAsync(host, new SessionRenderState(), {
      sessionId: "s-fallback-async",
      first: false,
      query: "兜底",
      baseline: new Map(),
      turn: 2,
    });

    expect(out.result).toBeDefined();
    expect(Array.isArray(out.result.segments)).toBe(true);
    expect(typeof out.s3).toBe("string");
  });

  it("renderTurnAsync：recallAsync 抛错回退到同步 recall，trim 返回 undefined 也不崩", async () => {
    const host = asHost(service);
    host.recall = () => notAnArray;
    host.recallAsync = async () => {
      throw new Error("embedding offline");
    };

    const out = await renderTurnAsync(host, new SessionRenderState(), {
      sessionId: "s-fallback-catch",
      first: false,
      query: "兜底",
      baseline: new Map(),
      turn: 3,
    });

    expect(out.result).toBeDefined();
    expect(Array.isArray(out.result.segments)).toBe(true);
  });

  it("service.renderTurn 公共入口：recall 返回 undefined 时不抛异常", () => {
    const host = asHost(service);
    host.recall = () => notAnArray;

    const out = service.renderTurn({
      sessionId: "s-fallback-public",
      first: false,
      query: "兜底",
      baseline: new Map(),
      turn: 2,
    });

    expect(out.result).toBeDefined();
    expect(typeof out.s3).toBe("string");
  });

  it("previewWithContext：后续轮召回返回 undefined 时不抛异常", () => {
    const host = asHost(service);
    host.recall = () => notAnArray;

    const result = service.previewWithContext({
      first: false,
      sessionId: "s-fallback-preview",
      query: "兜底",
    });

    expect(result.segments).toBeDefined();
    expect(Array.isArray(result.segments)).toBe(true);
  });

  it("首轮不调用召回：recall 抛错也不影响首轮注入", async () => {
    await service.remember({ level: "user", content: "首轮快照内容" }, "human");
    const host = asHost(service);
    let called = 0;
    host.recall = () => {
      called += 1;
      throw new Error("首轮不应召回");
    };

    const out = renderTurn(host, new SessionRenderState(), {
      sessionId: "s-fallback-first",
      first: true,
      baseline: new Map(),
    });

    expect(called).toBe(0);
    expect(out.s2).toContain("首轮快照内容");
  });
});
