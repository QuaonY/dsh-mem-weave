/**
 * roadmap v0.3 G11：库文件损坏/不可写 → 降级只读。
 * 所有写 RPC 返回失败（不抛异常），读与导出照常可用，会话不被阻塞（I8）。
 */
import { closeSync, mkdtempSync, openSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { openService } from "../src/host/index";
import { invokeRpc } from "../src/host/rpc";
import { WeaveService, defaultConfig } from "../src/host/service";
import { buildTools } from "../src/host/tools";
import { openWeaveDb } from "../src/store/db";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function seededDir(): Promise<{ dir: string; id: string }> {
  const dir = mkdtempSync(join(tmpdir(), "memweave-ro-"));
  dirs.push(dir);
  const rt = openService(dir);
  const w = await rt.service.remember({ level: "fact", content: "只读测试条目" }, "human");
  rt.env.close();
  return { dir, id: w.id! };
}

type Out = { ok?: boolean; code?: string; message?: string };
const failed = (o: unknown): boolean => (o as Out)?.ok === false;

describe("G11 只读降级", () => {
  it("只读打开：写 RPC / 写工具全部失败且不抛错，读和导出可用", async () => {
    const { dir, id } = await seededDir();
    const env = openWeaveDb(dir, { readonly: true });
    try {
      const service = new WeaveService(env, defaultConfig(dir));
      expect(service.listMemory({}).length).toBe(1);
      const writes: Array<[string, Record<string, unknown>]> = [
        ["memweave.memory/update", { id, patch: { content: "只读下改写" } }],
        ["memweave.memory/archive", { id }],
        ["memweave.backup/now", {}],
        ["memweave.dream/run", {}],
      ];
      for (const [name, args] of writes) {
        let out: unknown;
        await expect((async () => (out = await invokeRpc(service, name, args, "human")))()).resolves.not.toThrow();
        // dream/run 在只读库上可以是 ran=false；其余必须 ok=false
        if (name !== "memweave.dream/run" && name !== "memweave.backup/now") expect(failed(out), name).toBe(true);
      }
      expect(service.getMemory(id)!.content).toBe("只读测试条目");
      const remember = buildTools(service).find((t) => t.descriptor.name === "weave_remember")!;
      const r = await remember.handler({ level: "fact", content: "只读下新写" });
      expect(JSON.stringify(r)).toMatch(/E_DB|READONLY|readonly/i);
      const exp = await invokeRpc(service, "memweave.data/export", {}, "human");
      expect(JSON.stringify(exp)).toContain("只读测试条目");
    } finally {
      env.close();
    }
  });

  it("库文件头被写坏 → openService 不抛错（降级），写入返回失败", async () => {
    const { dir } = await seededDir();
    const fd = openSync(join(dir, "memweave.db"), "r+");
    writeSync(fd, Buffer.from("THIS IS NOT SQLITE!!"), 0, 20, 0);
    closeSync(fd);
    let rt: ReturnType<typeof openService> | null = null;
    let err: unknown = null;
    try {
      rt = openService(dir);
    } catch (e) {
      err = e;
    }
    expect(err).toBeNull();
    expect(rt!.warnings.length).toBeGreaterThan(0);
    const r = await rt!.service.remember({ level: "fact", content: "坏库上写入" }, "human");
    expect(r.ok).toBe(false);
    expect(() => rt!.service.recall("任意")).not.toThrow();
    rt!.env.close();
  });
});
