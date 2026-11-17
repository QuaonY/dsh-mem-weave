/**
 * @vitest-environment happy-dom
 * 向量检索卡片：起它既是状态也是配置入口（开关 + 服务地址 / 模型 / 密钥 / 维度）。
 * 这里守住三件事：
 * 1. 没配 / 已关闭 / 已就绪 三种状态说人话，不能只显示「已索引 0」那种像坏了的数字；
 * 2. 开关与表单真的存在（用户要在界面上完成配置，而不是去改 settings.json）；
 * 3. 文案不再指向不存在的「下方的 embedding 配置」。
 */
import { afterEach, describe, expect, it } from "vitest";
import { pageAdvanced } from "../src/client/misc";
import { ensureStyles, setRpcCtx, state } from "../src/client/ui";

function renderWith(status: Record<string, unknown>): HTMLElement {
  state.lang = "zh";
  state.data = { settings: {}, defaults: {} };
  state.status = status;
  return pageAdvanced();
}

afterEach(() => {
  setRpcCtx(null);
  state.data = {};
  state.status = null;
  state.lang = "zh";
});

describe("向量检索卡片", () => {
  it("单选框不吃输入框的通用样式：保持小尺寸，选中行有边框标记", () => {
    ensureStyles();
    const css = document.getElementById("memweave-style")?.textContent ?? "";
    // 输入框的 padding / min-height:40px / 宽度 100% 都必须排除 radio，否则单选框会被撑成大圆
    const generic = css
      .split("}")
      .filter((r) => r.includes("min-height:40px") && r.includes("padding:8px 12px"));
    expect(generic.length).toBeGreaterThan(0);
    for (const rule of generic) expect(rule).toContain(":not([type=radio])");
    expect(css).toMatch(/input\[type=radio\]\{[^}]*width:16px;[^}]*height:16px/);

    const node = renderWith({
      vectorBackend: "sqlite-vec",
      vectorRoute: { enabled: false, reason: "not-configured" },
    });
    const rows = Array.from(node.querySelectorAll<HTMLElement>("label.mw-pick-row"));
    expect(rows.length).toBe(2);
    expect(rows.filter((r) => r.classList.contains("mw-picked")).length).toBe(1);
  });

  it("没配 provider 时说明召回只用关键词，并给出开关与两种来源", () => {
    const node = renderWith({
      vectorBackend: "disabled",
      vectorRoute: { enabled: false, reason: "not-configured" },
    });
    const text = node.textContent ?? "";
    expect(text).toContain("未启用");
    expect(text).toContain("还没有可用的向量模型");
    // 开关与配置项都要在（此前这里是「只读、不提供开关」）
    expect(text).toContain("启用语义检索");
    expect(text).toContain("本地模型（需下载）");
    expect(text).toContain("服务地址");
    // 关着的时候按钮只说「保存」，不承诺「测试」
    expect(text).toContain("保存");
    // 两条来源是单选卡片，默认「本地模型」——内置向量作为兜底不出现在选项里
    const radios = Array.from(node.querySelectorAll<HTMLInputElement>('input[name="mw-embed-source"]'));
    expect(radios.map((r) => r.value)).toEqual(["local-model", "openai-compatible"]);
    expect(radios.filter((r) => r.checked).map((r) => r.value)).toEqual(["local-model"]);
    const toggle = node.querySelector<HTMLInputElement>("input.mw-switch");
    expect(toggle).not.toBeNull();
    expect(toggle?.checked).toBe(false);
  });

  it("选哪种来源就只显示那种设置：本地模型时不露服务地址，外部服务时不露模型清单", async () => {
    setRpcCtx({
      remote: {
        memweave: {
          invoke: async (method: string) => {
            if (method === "embedding/model.status") {
              return {
                ok: true,
                value: {
                  ok: true,
                  id: "bge-small-zh-v1.5",
                  installed: false,
                  downloading: false,
                  bytes: 0,
                  dimensions: 512,
                  approxBytes: 24451175,
                  langs: "zh",
                  runtimeOk: true,
                  models: [{ id: "bge-small-zh-v1.5", approxBytes: 24451175, langs: "zh", installed: false, dimensions: 512 }],
                },
              };
            }
            return { ok: true, value: { ok: true } };
          },
        },
      },
    });
    const node = renderWith({
      vectorBackend: "sqlite-vec",
      vectorRoute: { enabled: false, reason: "not-configured" },
    });
    await new Promise((r) => setTimeout(r, 0));
    const radios = Array.from(node.querySelectorAll<HTMLInputElement>('input[name="mw-embed-source"]'));
    const endpointInput = node.querySelector<HTMLInputElement>("input[placeholder^='http://127.0.0.1:11434']");
    expect(endpointInput).not.toBeNull();
    const httpBox = (): HTMLElement => endpointInput!.closest("div") as HTMLElement;
    // happy-dom 对脱离文档的 radio 组不做互斥，这里手动互斥再派发 change
    const pick = (value: string): void => {
      for (const r of radios) r.checked = r.value === value;
      radios.find((r) => r.value === value)!.dispatchEvent(new Event("change"));
    };

    // 默认内置本地向量：外部服务那组字段整块收起来，本地模型清单也不占位
    expect(httpBox().style.display).toBe("none");

    // 切到「外部服务」：地址、模型名、维度、密钥出现
    pick("openai-compatible");
    expect(httpBox().style.display).toBe("");

    // 切到「本地模型」：地址收起来，模型清单出现
    pick("local-model");
    await new Promise((r) => setTimeout(r, 0));
    expect(httpBox().style.display).toBe("none");
    expect(node.textContent ?? "").toContain("BGE 中文小模型");
  });

  it("开关只是表单的一部分：不点保存不会偷偷落库", () => {
    const calls: string[] = [];
    setRpcCtx({
      remote: {
        memweave: {
          invoke: async (method: string) => {
            calls.push(method);
            return { ok: true, value: { ok: true } };
          },
        },
      },
    });
    const node = renderWith({
      vectorBackend: "builtin",
      embeddingSettings: { enabled: false, provider: "local-hash", baseUrl: "", model: "", dimensions: 256, hasApiKey: false },
      vectorRoute: { enabled: false, reason: "disabled" },
    });
    const toggle = node.querySelector<HTMLInputElement>("input.mw-switch")!;
    const label = (): string =>
      Array.from(node.querySelectorAll<HTMLButtonElement>("button"))
        .map((b) => b.textContent ?? "")
        .join("|");
    expect(label()).toContain("保存");
    toggle.checked = true;
    toggle.dispatchEvent(new Event("change"));
    // 勾上之后按钮承诺「保存并测试」，但此刻一个 embedding/configure 都没发
    expect(label()).toContain("保存并测试");
    expect(calls.filter((m) => m.startsWith("embedding/configure"))).toEqual([]);
  });

  it("后端就绪但连不上时提示配置已写、服务不可达", () => {
    const node = renderWith({
      vectorBackend: "sqlite-vec",
      embeddingProvider: null,
      vectorRoute: { enabled: false, reason: "no-provider" },
      vectorStats: { indexed: 0, pending: 3, failed: 0, totalActive: 5 },
    });
    const text = node.textContent ?? "";
    expect(text).toContain("sqlite-vec");
    expect(text).toContain("已写入配置，但连不上这个服务");
    // 没 provider 时不能只显示「已索引 0 / 5」——那读起来像索引坏了
    expect(text).toContain("语义索引未启用");
    expect(text).toContain("0 / 5 条记忆还没有向量");
    expect(text).toContain("待处理 3");
  });

  it("内置后端就绪时显示「内置（无需安装）」，不再要求装可选依赖", () => {
    const node = renderWith({
      vectorBackend: "builtin",
      embeddingProvider: { provider: "openai-compatible", model: "fake-1", dimensions: 8 },
      vectorRoute: { enabled: true, reason: "ready" },
      vectorStats: { indexed: 3, pending: 0, failed: 0, totalActive: 3 },
    });
    const text = node.textContent ?? "";
    expect(text).toContain("内置（无需安装）");
    expect(text).toContain("语义路已就绪，参与召回融合");
  });

  it("显式关掉后端时说明是 MEMWEAVE_VECTOR_BACKEND=off", () => {
    const node = renderWith({
      vectorBackend: "disabled",
      embeddingProvider: { provider: "openai-compatible", model: "fake-1", dimensions: 8 },
      vectorRoute: { enabled: false, reason: "no-backend" },
    });
    expect(node.textContent ?? "").toContain("显式关闭");
  });

  it("已就绪时展示 provider 与模型，开关为开", () => {
    const node = renderWith({
      vectorBackend: "sqlite-vec",
      embeddingProvider: { provider: "openai-compatible", model: "fake-1", dimensions: 8 },
      embeddingSettings: { enabled: true, baseUrl: "http://127.0.0.1:11434/v1", model: "fake-1", dimensions: 8, hasApiKey: false, timeoutMs: 10000 },
      vectorRoute: { enabled: true, reason: "ready" },
      vectorStats: { indexed: 5, pending: 0, failed: 0, totalActive: 5 },
    });
    const text = node.textContent ?? "";
    expect(text).toContain("openai-compatible / fake-1");
    expect(text).toContain("8d");
    expect(text).toContain("语义路已就绪，参与召回融合");
    const toggle = node.querySelector<HTMLInputElement>("input.mw-switch");
    expect(toggle?.checked).toBe(true);
    // 表单预填保存过的地址与模型
    const inputs = Array.from(node.querySelectorAll<HTMLInputElement>("input"));
    expect(inputs.some((i) => i.value === "http://127.0.0.1:11434/v1")).toBe(true);
  });

  it("用户主动关闭时说明为什么不用语义路，并给出重新开启的入口", () => {
    const node = renderWith({
      vectorBackend: "sqlite-vec",
      embeddingSettings: { enabled: false, baseUrl: "http://127.0.0.1:11434/v1", model: "nomic-embed-text", dimensions: 768, hasApiKey: false, timeoutMs: 10000 },
      vectorRoute: { enabled: false, reason: "disabled" },
      vectorStats: { indexed: 0, pending: 0, failed: 0, totalActive: 107 },
    });
    const text = node.textContent ?? "";
    expect(text).toContain("语义检索已关闭");
    expect(text).toContain("已有向量保留");
    const toggle = node.querySelector<HTMLInputElement>("input.mw-switch");
    expect(toggle?.checked).toBe(false);
  });

  it("自动探测没找到服务时说清楚原因，而不是只写「未配置」", () => {
    const node = renderWith({
      vectorBackend: "builtin",
      vectorRoute: { enabled: false, reason: "not-configured" },
      embeddingDiscovery: { status: "none", message: "no embedding endpoint found" },
    });
    const text = node.textContent ?? "";
    expect(text).toContain("没发现本机的 Ollama / LM Studio");
    expect(text).toContain("OPENAI_API_KEY");
    expect(text).toContain("重新探测本机");
    // 旧文案指向「下方的 embedding 配置」，但设置页里并没有那个表单
    expect(text).not.toContain("下方的 embedding 配置");
  });

  it("自动接入失败时把失败原因带出来", () => {
    const node = renderWith({
      vectorBackend: "builtin",
      vectorRoute: { enabled: false, reason: "not-configured" },
      embeddingDiscovery: { status: "failed", message: "HTTP 401" },
    });
    const text = node.textContent ?? "";
    expect(text).toContain("自动接入向量模型失败");
    expect(text).toContain("HTTP 401");
  });

  it("就绪与否的统计行分开写", () => {
    const off = renderWith({
      vectorBackend: "builtin",
      vectorRoute: { enabled: false, reason: "not-configured" },
      vectorStats: { indexed: 0, pending: 0, failed: 0, totalActive: 107 },
    }).textContent ?? "";
    expect(off).toContain("语义索引未启用：0 / 107 条记忆还没有向量");
    expect(off).toContain("关闭只停用语义路");

    const on = renderWith({
      vectorBackend: "builtin",
      embeddingProvider: { provider: "openai-compatible", model: "fake-1", dimensions: 8 },
      vectorRoute: { enabled: true, reason: "ready" },
      vectorStats: { indexed: 107, pending: 0, failed: 0, totalActive: 107 },
    }).textContent ?? "";
    expect(on).toContain("已索引 107 / 107");
    expect(on).not.toContain("语义索引未启用");
  });

  it("选「本地模型」时显示模型清单、状态与下载按钮", async () => {
    setRpcCtx({
      remote: {
        memweave: {
          invoke: async (method: string) => {
            if (method === "embedding/model.status") {
              return {
                ok: true,
                value: {
                  ok: true,
                  id: "bge-small-zh-v1.5",
                  installed: false,
                  downloading: false,
                  bytes: 0,
                  totalFiles: 5,
                  dimensions: 512,
                  approxBytes: 24451175,
                  langs: "zh",
                  runtimeOk: true,
                  models: [
                    { id: "bge-small-zh-v1.5", approxBytes: 24451175, langs: "zh", installed: false, dimensions: 512 },
                    { id: "all-MiniLM-L6-v2", approxBytes: 23685172, langs: "en", installed: false, dimensions: 384 },
                  ],
                },
              };
            }
            return { ok: true, value: { ok: true } };
          },
        },
      },
    });
    const node = renderWith({
      vectorBackend: "sqlite-vec",
      vectorRoute: { enabled: false, reason: "not-configured" },
      embeddingSettings: {
        enabled: false,
        provider: "local-model",
        baseUrl: "",
        model: "",
        dimensions: null,
        hasApiKey: false,
        timeoutMs: 20000,
      },
    });
    await new Promise((r) => setTimeout(r, 0));
    const text = node.textContent ?? "";
    // 一行一个模型，旁边直接标出体积、内存、维度与语言
    expect(text).toContain("BGE 中文小模型");
    expect(text).toContain("MiniLM 英文小模型");
    expect(text).toContain("内存 ≥ 4 GB");
    expect(text).toContain("512 维");
    expect(text).toContain("384 维");
    expect(text).toContain("未安装");
    expect(text).toContain("下载模型");
  });

  it("下载中显示进度条与百分比", async () => {
    setRpcCtx({
      remote: {
        memweave: {
          invoke: async (method: string) => {
            if (method === "embedding/model.status") {
              return {
                ok: true,
                value: {
                  ok: true,
                  id: "bge-small-zh-v1.5",
                  installed: false,
                  downloading: true,
                  currentFile: "onnx/model_quantized.onnx",
                  doneFiles: 4,
                  totalFiles: 5,
                  bytesDone: 12 * 1024 * 1024,
                  bytesTotal: 24 * 1024 * 1024,
                  approxBytes: 24451175,
                  dimensions: 512,
                  langs: "zh",
                  runtimeOk: true,
                  models: [{ id: "bge-small-zh-v1.5", approxBytes: 24451175, langs: "zh", installed: false, dimensions: 512 }],
                },
              };
            }
            return { ok: true, value: { ok: true } };
          },
        },
      },
    });
    const node = renderWith({
      vectorBackend: "sqlite-vec",
      vectorRoute: { enabled: false, reason: "not-configured" },
      embeddingSettings: {
        enabled: false,
        provider: "local-model",
        baseUrl: "",
        model: "",
        dimensions: null,
        hasApiKey: false,
        timeoutMs: 20000,
      },
    });
    await new Promise((r) => setTimeout(r, 0));
    const text = node.textContent ?? "";
    expect(text).toContain("下载中 50%");
    const fill = node.querySelector<HTMLElement>(".mw-bar-fill");
    expect(fill?.style.width).toBe("50%");
  });

  it("点「下载模型」当场变成进度条，不用切页再切回来", async () => {
    let calls = 0;
    setRpcCtx({
      remote: {
        memweave: {
          invoke: async (method: string) => {
            if (method === "embedding/model.status") {
              calls += 1;
              // 第一次是进页面时的状态；之后模拟「正在下载 6 / 24 MB」
              const busy = calls > 1;
              const bytesDone = busy ? 6 * 1024 * 1024 : 0;
              return {
                ok: true,
                value: {
                  ok: true,
                  id: "bge-small-zh-v1.5",
                  installed: false,
                  downloading: busy,
                  currentFile: "onnx/model_quantized.onnx",
                  doneFiles: 4,
                  totalFiles: 5,
                  bytesDone,
                  bytesTotal: 24 * 1024 * 1024,
                  approxBytes: 24451175,
                  dimensions: 512,
                  langs: "zh",
                  runtimeOk: true,
                  models: [
                    {
                      id: "bge-small-zh-v1.5",
                      approxBytes: 24451175,
                      langs: "zh",
                      installed: false,
                      dimensions: 512,
                      downloading: busy,
                      bytesDone,
                      bytesTotal: 24 * 1024 * 1024,
                    },
                  ],
                },
              };
            }
            if (method === "embedding/model.install") {
              return { ok: true, value: { ok: true, started: true } };
            }
            return { ok: true, value: { ok: true } };
          },
        },
      },
    });
    const node = renderWith({
      vectorBackend: "sqlite-vec",
      vectorRoute: { enabled: false, reason: "not-configured" },
      embeddingSettings: {
        enabled: false,
        provider: "local-model",
        baseUrl: "",
        model: "",
        dimensions: null,
        hasApiKey: false,
        timeoutMs: 20000,
      },
    });
    document.body.appendChild(node);
    await new Promise((r) => setTimeout(r, 0));
    const btn = Array.from(node.querySelectorAll("button")).find((b) => b.textContent === "下载模型") as
      | HTMLButtonElement
      | undefined;
    expect(btn).toBeTruthy();
    btn!.click();
    // 同步就有反馈：RPC 往返期间先显示「正在连接下载源…」
    expect(node.textContent ?? "").toContain("正在连接下载源");
    // 一轮轮询之后就有真实百分比，不需要离开这一页
    await new Promise((r) => setTimeout(r, 750));
    expect(node.textContent ?? "").toContain("下载中 25%");
    expect(node.querySelector<HTMLElement>(".mw-bar-fill")?.style.width).toBe("25%");
    expect(node.querySelector<HTMLElement>(".mw-bar")?.style.display).toBe("");
    node.remove();
  });

  it("sqlite-vec 不再区分来源，统一显示后端名", () => {
    const bundled = renderWith({
      vectorBackend: "sqlite-vec",
      sqliteVecSource: "bundled",
      vectorRoute: { enabled: false, reason: "not-configured" },
    });
    expect(bundled.textContent ?? "").toContain("sqlite-vec");
    expect(bundled.textContent ?? "").not.toContain("包内自带");

    const npm = renderWith({
      vectorBackend: "sqlite-vec",
      sqliteVecSource: "npm",
      vectorRoute: { enabled: false, reason: "not-configured" },
    });
    expect(npm.textContent ?? "").toContain("sqlite-vec");
    expect(npm.textContent ?? "").not.toContain("包内自带");
  });
});
