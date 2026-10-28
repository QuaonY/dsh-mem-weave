/**
 * §13.2.6 一致性自检（status/selfcheck RPC）：
 * 三段同源（U4）/ 写权断言（guardHuman）/ 导出往返 / 库完整性，全程只读。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openWeaveDb, type WeaveEnv } from "../src/store/db";
import { ensureSchema } from "../src/store/migrate";
import { insertMemory, newId } from "../src/store/dao";
import { WeaveService, defaultConfig } from "../src/host/service";
import { invokeRpc } from "../src/host/rpc";
import type { MemoryEntry } from "../src/core/types";

let dir: string;
let env: WeaveEnv;
let service: WeaveService;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memweave-selfcheck-"));
  env = openWeaveDb(join(dir, "memweave"));
  ensureSchema(env);
  service = new WeaveService(env, defaultConfig(dir));
});

afterEach(() => {
  service.stopMirror(true);
  env.close();
  rmSync(dir, { recursive: true, force: true });
});

function seed(i: number): MemoryEntry {
  const ts = Date.now();
  return {
    id: newId(),
    level: "fact",
    project: "proj-selfcheck",
    section: null,
    content: "自检样本事实 " + i + "：库状态稳定",
    keywords: ["自检"],
    importance: 3,
    status: "active",
    semanticKey: "selfcheck:" + i,
    confidence: null,
    validFrom: ts,
    validTo: null,
    evidence: [],
    hash: null,
    source: "human",
    accessCount: 0,
    tier: "hot",
    createdAt: ts,
    updatedAt: ts,
  };
}

describe("status/selfcheck 一致性自检", () => {
  it("五项检查全过且顺序稳定", async () => {
    for (let i = 0; i < 3; i++) insertMemory(env, seed(i));
    // 宿主装配时会填工具注册结果；这里模拟注册成功
    service.toolStatus = { registered: ["weave_remember", "weave_recall"], failed: [], lastError: "" };
    const out = (await invokeRpc(service, "memweave.status/selfcheck", {}, "human")) as {
      ok: boolean;
      checks: Array<{ name: string; ok: boolean; detail: string }>;
    };
    expect(out.ok).toBe(true);
    expect(out.checks.map((c) => c.name).sort()).toEqual(["db", "export-roundtrip", "segments", "tools", "write-guard"]);
    for (const c of out.checks) expect(c.ok, c.name + " " + c.detail).toBe(true);
    expect(out.checks.find((c) => c.name === "export-roundtrip")?.detail).toContain("3");
    // 只读：自检不写审计、不改条目
    expect(service.status().total).toBe(3);
  });

  it("记忆工具没注册时自检报红（AI 无法写入记忆）", async () => {
    const out = (await invokeRpc(service, "memweave.status/selfcheck", {}, "human")) as {
      ok: boolean;
      checks: Array<{ name: string; ok: boolean; detail: string }>;
    };
    expect(out.ok).toBe(false);
    expect(out.checks.find((c) => c.name === "tools")?.ok).toBe(false);
  });

  it("写权探针走 humanOnly 拒绝路径（agent → E_PERM），无副作用", async () => {
    const before = service.persona().version;
    const out = (await invokeRpc(service, "memweave.status/selfcheck", {}, "agent")) as {
      checks: Array<{ name: string; ok: boolean }>;
    };
    expect(out.checks.find((c) => c.name === "write-guard")?.ok).toBe(true);
    expect(service.persona().version).toBe(before);
  });
});
