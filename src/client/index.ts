/// <reference lib="dom" />
/**
 * 忆织 MemWeave —— DSH client 插件（web）入口（§13.4 / D11 双入口）
 *
 * 宿主装载约定（对齐 meow-memory 等在架插件的实测形态）：
 * - lib/client.js 打包为 CJS 并包裹 `window.__ModuleLoader__.load({ id: 包名, factory(require) })`
 *   （包裹由 scripts/build.mjs 完成；factory 的 require 提供宿主浏览器模块表）；
 * - 模块导出 cordis 插件形态：`export const inject` + `export const apply = (ctx) => dispose`；
 *   apply 必须是箭头函数：宿主 Fiber runner 对普通 function 走 `new callback()` 构造器分支，
 *   返回的 disposer 会被丢弃（泄漏）；
 * - 所有 slots.register 必须在 slots.inject(name, cb) 回调内执行并返回 disposer：插槽由父条目延迟声明，
 *   直接 register 会在未声明时同步抛错；
 * - apply 全程 try/catch，任何异常不得逃逸（逃逸会拖死 web boot）；
 * - React 经 require("react") 从宿主模块表取用（构建 external，插件零自带依赖）；
 * - UI 本体仍是原生 DOM，React 仅作宿主插槽的薄适配层：
 *   settings.section（带 settingsScope）与 conversation.composer.dock（会话侧栏徽章）。
 */

import { t } from "../i18n";
import { type AnyCtx, el, ensureStyles, setCtx, setRpcCtx, state } from "./ui";
import { navigate, refresh, render, setRoot } from "./pages";
import { mountBadge, unmountBadge } from "./badge";
import { REMOTE_CONTRIBUTION } from "./remote";
import { loadAccountNickname, setAccountNickname } from "./account";

type Disposer = () => void;

/** 宿主模块表提供的 React（仅用 createElement/useRef/useEffect 三个最小面） */
const React = require("react") as {
  createElement: (type: string | ((props: Record<string, unknown>) => unknown), props?: Record<string, unknown> | null, ...children: unknown[]) => unknown;
  useRef: <T>(init: T | null) => { current: T | null };
  useEffect: (fn: () => void | (() => void), deps?: unknown[]) => void;
};

/**
 * 把原生 DOM 挂载器包装成宿主插槽用的 React 薄组件。
 * 卸载时调用挂载器返回的 disposer（资源生命周期随组件）。
 */
function domSlot(mount: (host: HTMLElement, props: Record<string, unknown>) => Disposer): (props: Record<string, unknown>) => unknown {
  return function MemWeaveSlot(props: Record<string, unknown>): unknown {
    const ref = React.useRef<HTMLElement | null>(null);
    React.useEffect(() => {
      const host = ref.current;
      if (!host) return undefined;
      return mount(host, props);
    }, []);
    return React.createElement("div", { ref, style: { display: "contents" } });
  };
}

/** 宿主 ctx + 插槽容器：mountBadge 只读 container/element，其余属性沿原型链透传 */
function slotCtx(ctx: AnyCtx, host: HTMLElement): AnyCtx {
  return Object.assign(Object.create(ctx as object) as AnyCtx, { container: host });
}

function optionalService<T>(ctx: AnyCtx, name: string): T | undefined {
  const get = (ctx as { get?: (key: string) => T | undefined }).get;
  if (typeof get === "function") return get.call(ctx, name);
  try {
    return (ctx as Record<string, unknown>)[name] as T | undefined;
  } catch {
    return undefined;
  }
}

/** cordis 服务依赖 */
export const inject = ["slots", "remote"];

/**
 * 诊断面包屑（console.error 级会进宿主 crash-*-web-boot.log）：
 * 带上 fiber 状态，激活卡点一步定位。
 */
function trace(ctx: AnyCtx, msg: string): void {
  try {
    const fiber = (ctx as unknown as { fiber?: { state?: unknown; inertia?: unknown } }).fiber;
    console.error(`[memweave] ${msg} (fiber.state=${String(fiber?.state)}, inertia=${fiber?.inertia ? "set" : "none"})`);
  } catch {
    console.error(`[memweave] ${msg}`);
  }
}

/**
 * 插件入口（宿主装载后调用）：注册设置分区 + 会话徽章，返回 dispose。
 * 必须是箭头函数（不可作构造器），且不得抛出异常。
 */
export const apply = async (ctx: AnyCtx): Promise<Disposer> => {
  let disposeRemote: Disposer = () => undefined;
  let disposeUi: Disposer = setupUi(ctx);
  let injection: { dispose?: () => Promise<void> } | undefined;
  let accountInjection: { dispose?: () => Promise<void> } | undefined;
  const remote = ctx.remote as { $mount?: (contribution: typeof REMOTE_CONTRIBUTION) => Promise<Disposer> } | undefined;
  try {
    if (typeof remote?.$mount !== "function") throw new Error("ctx.remote.$mount unavailable");
    disposeRemote = await remote.$mount(REMOTE_CONTRIBUTION);
    const inject = (ctx as unknown as {
      inject: (this: AnyCtx, services: string[], callback: (injectedCtx: AnyCtx) => Disposer) => Promise<void> & { dispose?: () => Promise<void> };
    }).inject;
    injection = inject.call(ctx, ["remote.memweave"], (injectedCtx) => {
      setRpcCtx(injectedCtx);
      return () => setRpcCtx(null);
    });
    await injection;
    // 账号昵称只用于显示“修改者”：单独注入、不等待；账号服务不在时这段永远不触发，设置页照常可用
    try {
      accountInjection = inject.call(ctx, ["remote.account"], (accountCtx) => {
        void loadAccountNickname(accountCtx).then((name) => {
          if (name) void refresh();
        });
        return () => setAccountNickname("");
      });
      void Promise.resolve(accountInjection).catch(() => undefined);
    } catch {
      // 没有账号服务：保持通用称呼
    }
    await refresh();
  } catch (error) {
    console.error("[memweave] Remote 初始化失败，设置页保留但 RPC 暂不可用：", error);
  }
  return () => {
    disposeUi();
    void injection?.dispose?.();
    void accountInjection?.dispose?.();
    try { disposeRemote(); } catch { /* 忽略清理错误 */ }
  };
};

function setupUi(ctx: AnyCtx): Disposer {
  const disposers: Disposer[] = [];
  let disposed = false;

  // fiber 状态 watchdog：激活异常（state 卡 0/1/3）时把 state/inertia 打进崩溃日志；
  // 正常激活（state=2）即静默自停。最多 3 跳。
  let ticks = 0;
  const watchdog = setInterval(() => {
    ticks += 1;
    const stateNow = (ctx as unknown as { fiber?: { state?: unknown } }).fiber?.state;
    if (stateNow === 2 || stateNow === 4 || ticks > 3) {
      clearInterval(watchdog);
      return;
    }
    trace(ctx, `watchdog tick ${ticks}: fiber 未激活`);
  }, 800);

  const cleanup = (): void => {
    if (disposed) return;
    disposed = true;
    clearInterval(watchdog);
    for (const d of disposers) {
      try {
        d();
      } catch {
        // 忽略
      }
    }
    setCtx(null);
  };

  try {
    trace(ctx, "apply enter");
    setCtx(ctx);
    ensureStyles();

    const slotsService = (ctx as unknown as {
      slots?: {
        register?: (spec: Record<string, unknown>, comp: unknown) => Disposer | void;
        inject?: (name: string, cb: () => Disposer | void) => Disposer | void;
      };
    }).slots;
    if (!slotsService?.register || !slotsService.inject) {
      console.warn("[memweave] slots service 不可用：设置页与徽章未注册（库与注入功能不受影响）");
      trace(ctx, "apply skip: slots service 缺失");
      return cleanup;
    }
    let scopeService: { bind: (options: { namespace: string }) => unknown } | undefined;
    let configForms: { get: (namespace: string) => unknown } | undefined;
    const getScope = (): unknown => {
      scopeService ??= optionalService<{ bind: (options: { namespace: string }) => unknown }>(ctx, "settingsScope");
      configForms ??= optionalService<{ get: (namespace: string) => unknown }>(ctx, "configForms");
      if (scopeService && typeof scopeService.bind === "function") {
        return scopeService.bind({ namespace: "mem-weave" });
      }
      if (configForms && typeof configForms.get === "function") {
        return configForms.get("mem-weave");
      }
      return undefined;
    };

    const SettingsSection = domSlot((host, props) => {
      const root = el("div", { class: "mw-root", id: "memweave-settings" });
      host.appendChild(root);
      setRoot(root);
      const scope = props.scope;
      if (!scope) {
        root.textContent = "忆织设置已注册，但当前 DSH 未提供可用的设置配置服务。";
      } else {
        void refresh().then(() => {
          if (!root.childElementCount) {
            root.textContent = "忆织设置暂不可用：未能加载页面内容，请检查插件 RPC 服务。";
          }
        }).catch((error: unknown) => {
          root.textContent = `忆织界面加载失败：${error instanceof Error ? error.message : String(error)}`;
          console.error("[memweave] 设置页初始加载失败：", error);
        });
      }
      return () => {
        setRoot(null);
        root.remove();
      };
    });

    // 会话侧栏状态徽章（D11：冲突/候选/撤销/本轮）
    const BadgeDock = domSlot((host) => {
      mountBadge(slotCtx(ctx, host));
      return () => unmountBadge();
    });

    // 插槽就绪（父条目声明）时才注册；未声明则静默等待，注册异常就地吞掉。
    const registerOnSlot = (name: string, spec: Record<string, unknown>, comp: unknown): void => {
      let disposeComp: Disposer | null = null;
      disposers.push(() => {
        try {
          disposeComp?.();
        } catch {
          // 忽略
        }
      });
      const registerComp = (): Disposer | void => {
        try {
          disposeComp?.();
        } catch {
          // 忽略
        }
        disposeComp = null;
        try {
          const d = slotsService.register!(spec, comp);
          if (typeof d === "function") {
            disposeComp = d;
          }
          trace(ctx, `${name} registered`);
          return d;
        } catch (e) {
          console.error(`[memweave] ${name} 注册失败：`, e);
        }
      };
      try {
        const disposeInjection = slotsService.inject!(name, registerComp);
        if (typeof disposeInjection === "function") disposers.push(disposeInjection);
      } catch (e) {
        console.error(`[memweave] ${name} slots.inject 失败：`, e);
      }
    };

    registerOnSlot(
      "settings.section",
      {
        name: "settings.section",
        id: "mem-weave",
        order: 36,
        label: () => t("settings.title", state.lang),
        inject: () => ({ scope: getScope() }),
      },
      SettingsSection,
    );

    // 徽章挂到输入框 dock（conversation.composer.dock，§13.1 轻量入口）
    registerOnSlot("conversation.composer.dock", { name: "conversation.composer.dock", id: "mem-weave", order: 95 }, BadgeDock);

    trace(ctx, "apply done");
  } catch (e) {
    console.error("[memweave] apply 异常：", e);
    trace(ctx, "apply failed");
  }

  return cleanup;
}

export { mountBadge, unmountBadge, navigate, render };
