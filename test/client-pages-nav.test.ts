/**
 * @vitest-environment happy-dom
 * 点「会话人格」没有任何反应 —— 守住导航链路本身。
 * 点击 tab 走 navigate → refresh → page.load → render。旧实现里 load 或 render
 * 任一抛异常，refresh 就停在半路：state.tab 已经变了，面板还是旧的
 * 用户看到的就是「点了没反应」。这个文件守三件事：
 * 1. 切页必须真的换面板；
 * 2. 某一页 load 抛错，导航照常完成（不能停在旧页）；
 * 3. 某一页 render 抛错，显示错误卡而不是留白。
 */
import { afterEach, describe, expect, it } from "vitest";
import { navigate, PAGES, setRoot, type PageDef } from "../src/client/pages";
import { setCtx, setRpcCtx, state } from "../src/client/ui";

function mount(): HTMLElement {
  document.body.innerHTML = '<div id="mw-root"></div>';
  const root = document.getElementById("mw-root") as HTMLElement;
  setRoot(root);
  return root;
}

function mockRpc(): void {
  setRpcCtx({
    remote: {
      memweave: {
        invoke: async (method: string) => {
          if (method === "status/get") {
            return { ok: true, value: { ok: true, counts: {}, total: 0, readonly: false } };
          }
          if (method === "exclusion/check") return { ok: true, value: { paused: false } };
          if (method === "settings/get") {
            return { ok: true, value: { ok: true, promptLang: "zh", multiPersona: { enabled: false } } };
          }
          if (method === "inject/sessions") return { ok: true, value: { ok: true, sessions: [] } };
          return { ok: true, value: { ok: true } };
        },
      },
    },
  });
  setCtx({});
}

const extra: PageDef[] = [];
afterEach(() => {
  // 注意：extra 必须自己清空，否则 while 条件永远为真（就是这行把上一次跑测挂死的）
  while (extra.length > 0) {
    extra.pop();
    PAGES.pop();
  }
  setRpcCtx(null);
  setCtx(null);
  setRoot(null);
  state.data = {};
  state.status = null;
  state.lang = "zh";
});

describe("设置页导航", () => {
  it("点别的 tab 真的切过去（面板与选中态一起变）", async () => {
    mockRpc();
    const root = mount();
    state.tab = "overview";
    await navigate("overview");
    const before = root.querySelector("#mw-panel")?.textContent ?? "";
    await navigate("advanced");
    expect(root.querySelector("#mw-tab-advanced")?.className).toContain("mw-active");
    expect(root.querySelector("#mw-tab-overview")?.className).not.toContain("mw-active");
    expect(root.querySelector("#mw-panel")?.textContent ?? "").not.toBe(before);
  });

  it("某一页 load 抛错时导航照常完成，不会停在旧页面", async () => {
    mockRpc();
    const root = mount();
    const page: PageDef = {
      key: "boomload",
      labelKey: "nav.overview",
      load: async () => {
        throw new Error("load boom");
      },
      render: () => {
        const node = document.createElement("div");
        node.textContent = "load 失败也要有页面";
        return node;
      },
    };
    PAGES.push(page);
    extra.push(page);

    await navigate("boomload");
    expect(root.textContent).toContain("load 失败也要有页面");
    expect(root.querySelector("#mw-tab-boomload")?.className).toContain("mw-active");
  });

  it("某一页 render 抛错时显示错误卡，而不是留白", async () => {
    mockRpc();
    const root = mount();
    const page: PageDef = {
      key: "boomrender",
      labelKey: "nav.overview",
      load: async () => undefined,
      render: () => {
        throw new Error("render boom");
      },
    };
    PAGES.push(page);
    extra.push(page);

    await navigate("boomrender");
    expect(root.textContent).toContain("这一页没能加载");
    expect(root.textContent).toContain("render boom");
  });
});
