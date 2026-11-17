/**
 * Client RPC 服务缺失时应降级返回，不让页面刷新抛异常。
 */
import { afterEach, describe, expect, it } from "vitest";
import { rpc, setRpcCtx } from "../src/client/ui";

afterEach(() => setRpcCtx(null));

describe("client RPC", () => {
  it("remote context 未注入时返回 E_UNAVAILABLE", async () => {
    setRpcCtx(null);
    await expect(rpc("status/get")).resolves.toEqual({
      ok: false,
      code: "E_UNAVAILABLE",
      message: "remote.memweave context has not been injected",
    });
  });

  it("无 context 时返回 E_UNAVAILABLE", async () => {
    setRpcCtx({});
    await expect(rpc("status/get")).resolves.toMatchObject({ ok: false, code: "E_UNAVAILABLE" });
  });

  it("调用 Typert 命名空间并解包成功结果", async () => {
    const calls: unknown[][] = [];
    setRpcCtx({ remote: { memweave: { invoke: async (...args: unknown[]) => { calls.push(args); return { ok: true, value: { ok: true, result: 7 } }; } } } });
    await expect(rpc("status/get", {}, "human")).resolves.toEqual({ ok: true, result: 7 });
    expect(calls).toEqual([["status/get", {}, "human"]]);
  });

  it("保留 Typert Remote 返回的具体错误", async () => {
    setRpcCtx({ remote: { memweave: { invoke: async () => ({ ok: false, error: { code: "gateway/unmounted", message: "method not mounted" } }) } } });
    await expect(rpc("status/get")).resolves.toEqual({ ok: false, code: "gateway/unmounted", message: "method not mounted" });
  });

  it("命名空间尚未挂载时返回可诊断错误", async () => {
    setRpcCtx({ remote: {} });
    await expect(rpc("status/get")).resolves.toEqual({ ok: false, code: "E_UNAVAILABLE", message: "remote.memweave.invoke is not mounted" });
  });

  it("调用拒绝时保留原始错误", async () => {
    setRpcCtx({ remote: { memweave: { invoke: async () => { throw new Error("gateway disconnected"); } } } });
    await expect(rpc("status/get")).resolves.toMatchObject({ ok: false, code: "E_REMOTE", message: "Error: gateway disconnected" });
  });
});
