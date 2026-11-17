/**
 * 界面语言接线（promptLang 同源）
 * settings/get 的 promptLang 决定 state.lang，失败时保持中文且不反复请求。
 */
import { afterEach, describe, expect, it } from "vitest";
import { applyLang, ensureLang, langResolvedState, resetLang, setRpcCtx, state } from "../src/client/ui";

afterEach(() => {
  setRpcCtx(null);
  resetLang();
  state.lang = "zh";
});

describe("界面语言接线", () => {
  it("applyLang 读取 promptLang，非法值回落到中文", () => {
    applyLang({ promptLang: "en" });
    expect(state.lang).toBe("en");
    applyLang({ promptLang: "zh" });
    expect(state.lang).toBe("zh");
    applyLang({});
    expect(state.lang).toBe("zh");
    applyLang({ promptLang: "fr" });
    expect(state.lang).toBe("zh");
  });

  it("ensureLang 拉一次 settings/get 并解析语言", async () => {
    let calls = 0;
    setRpcCtx({
      remote: {
        memweave: {
          invoke: async () => {
            calls += 1;
            return { ok: true, value: { ok: true, promptLang: "en" } };
          },
        },
      },
    });
    resetLang();
    await ensureLang();
    expect(state.lang).toBe("en");
    expect(langResolvedState()).toBe(true);
    // 已解析后再次调用不重复请求
    await ensureLang();
    expect(calls).toBe(1);
  });

  it("RPC 失败时保持中文，且不重复重试", async () => {
    let calls = 0;
    setRpcCtx({
      remote: {
        memweave: {
          invoke: async () => {
            calls += 1;
            return { ok: false, error: { code: "E_DB", message: "boom" } };
          },
        },
      },
    });
    resetLang();
    await ensureLang();
    expect(state.lang).toBe("zh");
    await ensureLang();
    expect(calls).toBe(1);
  });

  it("resetLang 后重新拉取，用于设置页切语言", async () => {
    let lang = "zh";
    let calls = 0;
    setRpcCtx({
      remote: {
        memweave: {
          invoke: async () => {
            calls += 1;
            return { ok: true, value: { ok: true, promptLang: lang } };
          },
        },
      },
    });
    resetLang();
    await ensureLang();
    expect(state.lang).toBe("zh");
    lang = "en";
    resetLang();
    await ensureLang();
    expect(state.lang).toBe("en");
    expect(calls).toBe(2);
  });
});
