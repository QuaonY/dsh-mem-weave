/**
 * @vitest-environment happy-dom
 * 输入框徽章挂载回归。
 *
 * DSH 0.2.x 的插件上下文是受保护对象：往它的副本上写未声明字段会抛
 * `Cannot set property "container" without provide`，导致徽章每次挂载都报错。
 * 这里用一个「写入未声明字段就抛」的代理模拟宿主上下文，守住两件事：
 * 1. mountBadge 不再往 ctx 写 container；
 * 2. 插槽容器显式传入时徽章挂在容器里，没有容器时退回 body 且不抛。
 */
import { afterEach, describe, expect, it } from "vitest";
import { mountBadge, unmountBadge } from "../src/client/badge";
import { setCtx, setRpcCtx } from "../src/client/ui";

const DECLARED = new Set(["fiber", "reflect", "events", "inject", "get", "provide", "set", "effect"]);

/** 模拟宿主受保护的 ctx：读未声明字段、写未声明字段都抛。 */
function guardedCtx(): Record<string, unknown> {
  const target: Record<string, unknown> = { fiber: { runtime: {} }, reflect: { props: {} } };
  return new Proxy(target, {
    get(t, prop) {
      if (prop in t) return t[prop as string];
      throw new Error(`cannot get property "${String(prop)}" without inject`);
    },
    set(t, prop, value) {
      if (DECLARED.has(String(prop)) || prop in t) {
        t[prop as string] = value;
        return true;
      }
      throw new Error(`cannot set property "${String(prop)}" without provide`);
    },
  });
}

function mockRpc(): void {
  setRpcCtx({
    remote: {
      memweave: {
        invoke: async () => ({ ok: true, value: { ok: true, conflictsOpen: 0, candidatesPending: 0 } }),
      },
    },
  });
}

afterEach(() => {
  unmountBadge();
  document.body.innerHTML = "";
  setCtx(null);
  setRpcCtx(null);
});

describe("会话徽章挂载", () => {
  it("往受保护的 ctx 上挂载不抛错，且挂在插槽容器里", () => {
    mockRpc();
    const host = document.createElement("div");
    document.body.appendChild(host);

    expect(() => mountBadge(guardedCtx() as never, host)).not.toThrow();
    expect(host.querySelector("#memweave-badge")).not.toBeNull();
  });

  it("没有显式容器时退回 body，同样不抛错", () => {
    mockRpc();

    expect(() => mountBadge(guardedCtx() as never)).not.toThrow();
    expect(document.body.querySelector("#memweave-badge")).not.toBeNull();
  });

  it("卸载后节点移除", () => {
    mockRpc();
    const host = document.createElement("div");
    document.body.appendChild(host);
    mountBadge(guardedCtx() as never, host);
    unmountBadge();
    expect(host.querySelector("#memweave-badge")).toBeNull();
  });

  it("点击徽章按钮：读不到跳转口也不抛错", async () => {
    mockRpc();
    const host = document.createElement("div");
    document.body.appendChild(host);
    mountBadge(guardedCtx() as never, host);
    await new Promise((r) => setTimeout(r, 0));

    const btn = host.querySelector<HTMLButtonElement>("button");
    expect(btn).not.toBeNull();
    expect(() => btn!.click()).not.toThrow();
  });
});
