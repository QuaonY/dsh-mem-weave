/**
 * roadmap v0.3 G10：并发修订的乐观锁（CAS）。
 * 两次修订带同一个 expectedUpdatedAt：第一次成功，第二次必须返回冲突，且第一次的结果不被覆盖。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openService } from "../src/host/index";
import { invokeRpc } from "../src/host/rpc";
import type { WeaveService } from "../src/host/service";
import { buildTools } from "../src/host/tools";
import type { WeaveEnv } from "../src/store/db";

let dir: string;
let env: WeaveEnv;
let service: WeaveService;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memweave-cas-"));
  const rt = openService(dir);
  env = rt.env;
  service = rt.service;
});

afterEach(() => {
  env.close();
  rmSync(dir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("G10 CAS", () => {
  it("weave_revise：同一 expectedUpdatedAt 第二次返回冲突，原值保留第一次的修改", async () => {
    const w = await service.remember({ level: "fact", content: "CAS 测试原始正文" }, "human");
    const stamp = service.getMemory(w.id!)!.updatedAt;
    const revise = buildTools(service).find((t) => t.descriptor.name === "weave_revise")!;
    await sleep(3);
    const first = (await revise.handler({ id: w.id, patch: { content: "第一次修改" }, expectedUpdatedAt: stamp })) as unknown;
    expect(JSON.stringify(first)).not.toMatch(/E_CAS/);
    expect(service.getMemory(w.id!)!.content).toBe("第一次修改");
    const second = await revise.handler({ id: w.id, patch: { content: "第二次修改" }, expectedUpdatedAt: stamp });
    expect(JSON.stringify(second)).toMatch(/E_CAS/);
    expect(service.getMemory(w.id!)!.content).toBe("第一次修改");
  });

  it("memory/update RPC：同测", async () => {
    const w = await service.remember({ level: "fact", content: "RPC CAS 原始正文" }, "human");
    const stamp = service.getMemory(w.id!)!.updatedAt;
    await sleep(3);
    const a = (await invokeRpc(service, "memweave.memory/update", { id: w.id, patch: { content: "RPC 第一次" }, expectedUpdatedAt: stamp }, "human")) as { ok: boolean };
    expect(a.ok).toBe(true);
    const b = (await invokeRpc(service, "memweave.memory/update", { id: w.id, patch: { content: "RPC 第二次" }, expectedUpdatedAt: stamp }, "human")) as { ok: boolean; code?: string };
    expect(b.ok).toBe(false);
    expect(b.code).toBe("E_CAS");
    expect(service.getMemory(w.id!)!.content).toBe("RPC 第一次");
  });

  it("不带 expectedUpdatedAt 时照常写（向后兼容）", async () => {
    const w = await service.remember({ level: "fact", content: "无 CAS 正文" }, "human");
    const r = service.revise(w.id!, { content: "无 CAS 改后" }, "human");
    expect(r.ok).toBe(true);
  });
});
