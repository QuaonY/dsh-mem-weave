/// <reference lib="dom" />
/**
 * 忆织 MemWeave —— client 共享层：DOM 工具 / RPC 通道 / UI 状态 / 虚拟列表 / 样式
 * 零运行时依赖（原生 DOM）；一切数据经 host RPC，前端不碰 SQLite（§13.0）。
 */

import { t } from "../i18n";

export type AnyCtx = Record<string, unknown> & {
  remote?: Record<string, unknown>;
  container?: HTMLElement;
  element?: HTMLElement;
  sessionId?: string;
};

export interface UiState {
  lang: string;
  readonly: boolean;
  paused: boolean;
  tab: string;
  status: Record<string, unknown> | null;
  data: Record<string, unknown>;
}

export const state: UiState = {
  lang: "zh",
  readonly: false,
  paused: false,
  tab: "overview",
  status: null,
  data: {},
};

let ctxRef: AnyCtx | null = null;
let rpcCtxRef: AnyCtx | null = null;

export function setCtx(ctx: AnyCtx | null): void {
  ctxRef = ctx;
}

export function setRpcCtx(ctx: AnyCtx | null): void {
  rpcCtxRef = ctx;
}

export function getCtx(): AnyCtx | null {
  return ctxRef;
}

// ---------- 刷新回调（pages.ts 注册；各页模块统一调 refresh()） ----------

type Refresher = () => Promise<void> | void;
let refresher: Refresher | null = null;

export function setRefresher(fn: Refresher): void {
  refresher = fn;
}

export function refresh(): Promise<void> {
  return Promise.resolve(refresher ? refresher() : undefined);
}

// ---------- 极简 DOM 工具 ----------

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Record<string, unknown> | null,
  children?: Array<Node | string | null>,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null) continue;
      if (k === "class") node.className = String(v);
      else if (k === "text") node.textContent = String(v);
      else if (k.startsWith("on") && typeof v === "function") {
        node.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      } else node.setAttribute(k, String(v));
    }
  }
  for (const child of children ?? []) {
    if (child === null || child === undefined) continue;
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

export function badge(text: string, tone: "ok" | "warn" | "bad" | "plain"): HTMLElement {
  return el("span", { class: "mw-badge mw-" + tone, text });
}

export function sectionCard(title: string, body: HTMLElement): HTMLElement {
  return el("section", { class: "mw-card" }, [el("h3", { text: title }), body]);
}

/** 危险操作双确认：必须手输确认词（U2） */
export function dangerConfirm(word: string, message: string): boolean {
  const typed = window.prompt(message + "\n" + t("common.dangerConfirm", state.lang) + " [" + word + "]");
  return typed === word;
}

const FLASH_ICON: Record<string, string> = { ok: "✓", warn: "!", bad: "✕" };

/**
 * 轻量提示：窗口顶部居中的浮层（不压住底部输入框和保存按钮），
 * 同时最多 3 条，成功 3 秒、警告/错误 6 秒后淡出，可点 × 关掉。
 */
export function flash(text: string, tone: "ok" | "warn" | "bad" = "ok"): void {
  let box = document.getElementById("memweave-flash");
  if (!box) {
    box = el("div", { id: "memweave-flash", class: "mw-flashbox", role: "status", "aria-live": "polite" });
    document.body.appendChild(box);
  }
  while (box.children.length >= 3) box.firstElementChild?.remove();
  const close = (): void => {
    item.classList.add("mw-flash-out");
    setTimeout(() => item.remove(), 180);
  };
  const item = el("div", { class: "mw-flash mw-flash-" + tone }, [
    el("span", { class: "mw-flash-icon", text: FLASH_ICON[tone] ?? "i", "aria-hidden": "true" }),
    el("span", { class: "mw-flash-text", text }),
    el("button", { type: "button", class: "mw-flash-close", text: "×", "aria-label": "关闭提示", onclick: close }),
  ]);
  box.appendChild(item);
  setTimeout(close, tone === "ok" ? 3000 : 6000);
}

/**
 * 「有未保存的修改」顶部悬浮条：滚动时贴在设置页顶部，点按钮滑到底部的保存区。
 * 返回 node（放在页面最上方）和 setDirty。
 */
export function unsavedNotice(target: () => HTMLElement | null, text = "有未保存的修改"): { node: HTMLElement; setDirty: (dirty: boolean) => void } {
  const node = el("div", { class: "mw-unsaved", role: "status", hidden: "hidden" }, [
    el("span", { class: "mw-unsaved-dot", "aria-hidden": "true" }),
    el("span", { class: "mw-unsaved-text", text: text + "，改完记得到底部保存" }),
    el("button", {
      type: "button",
      class: "mw-primary",
      text: "滑到底部保存 ↓",
      onclick: () => {
        const t = target();
        if (!t) return;
        t.scrollIntoView({ behavior: "smooth", block: "center" });
        t.classList.remove("mw-pulse");
        void t.offsetWidth;
        t.classList.add("mw-pulse");
      },
    }),
  ]);
  return {
    node,
    setDirty: (dirty: boolean) => {
      if (dirty) node.removeAttribute("hidden");
      else node.setAttribute("hidden", "hidden");
    },
  };
}

/** 监听容器里的任何输入变化（带 data-nodirty 的区域除外） */
export function watchEdits(container: HTMLElement, onEdit: () => void): void {
  const handler = (ev: Event): void => {
    const target = ev.target as HTMLElement | null;
    if (target?.closest?.("[data-nodirty]")) return;
    onEdit();
  };
  container.addEventListener("input", handler);
  container.addEventListener("change", handler);
}

export function fmtTime(ts: unknown): string {
  const n = Number(ts);
  if (!n) return "-";
  const d = new Date(n);
  const p = (x: number) => String(x).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
}

export function num(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function downloadJson(name: string, payload: unknown): void {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const a = el("a", { href: URL.createObjectURL(blob), download: name }) as HTMLAnchorElement;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---------- RPC（短名调用，如 "settings/update"） ----------

export async function rpc(id: string, args: Record<string, unknown> = {}, actor = "human"): Promise<unknown> {
  if (!rpcCtxRef) return { ok: false, code: "E_UNAVAILABLE", message: "remote.memweave context has not been injected" };
  let remote: Record<string, unknown> | undefined;
  try {
    remote = rpcCtxRef?.remote as Record<string, unknown> | undefined;
  } catch {
    return { ok: false, code: "E_UNAVAILABLE", message: "remote.memweave context has not been injected" };
  }
  const namespace = remote?.memweave as { invoke?: (id: string, args: Record<string, unknown>, actor: string) => Promise<unknown> } | undefined;
  if (typeof namespace?.invoke !== "function") {
    return { ok: false, code: "E_UNAVAILABLE", message: "remote.memweave.invoke is not mounted" };
  }
  try {
    const result = await namespace.invoke(id, args, actor) as { ok?: boolean; value?: unknown; error?: { code?: string; message?: string } } | undefined;
    if (result === undefined) return { ok: false, code: "E_REMOTE_EMPTY", message: "Remote returned no result" };
    if (result.ok === true && "value" in result) return result.value;
    if (result.ok === false && result.error) {
      return { ok: false, code: result.error.code ?? "E_REMOTE", message: result.error.message ?? "Remote call failed" };
    }
    return result;
  } catch (error) {
    return { ok: false, code: "E_REMOTE", message: String(error) };
  }
}

/** 统一的写后反馈：失败走 flash（bad），成功可选提示 */
export function report(out: unknown, okMsg?: string): boolean {
  const r = out as { ok?: boolean; code?: string; message?: string };
  if (r && r.ok === false) {
    flash(String(r.code ?? "E_DB") + ": " + String(r.message ?? ""), "bad");
    return false;
  }
  if (okMsg) flash(okMsg, "ok");
  return true;
}

// ---------- 虚拟列表（U6：≥1000 条不卡） ----------

export interface VirtualOpts<T> {
  items: T[];
  rowHeight: number;
  height: number;
  renderRow: (item: T, index: number) => HTMLElement;
  onReachEnd?: () => void;
  emptyText?: string;
}

export function virtualList<T>(opts: VirtualOpts<T>): HTMLElement {
  const outer = el("div", { class: "mw-vlist", tabindex: "0", role: "list" });
  outer.style.height = opts.height + "px";
  if (opts.items.length === 0) {
    outer.appendChild(el("p", { class: "mw-empty", text: opts.emptyText ?? t("common.empty", state.lang) }));
    return outer;
  }
  const spacer = el("div");
  spacer.style.height = String(opts.items.length * opts.rowHeight) + "px";
  const rows = el("div", { class: "mw-vrows" });
  outer.appendChild(spacer);
  outer.appendChild(rows);
  let lastStart = -1;
  let lastEnd = -1;
  let endFired = false;
  const draw = (): void => {
    const start = Math.max(0, Math.floor(outer.scrollTop / opts.rowHeight) - 5);
    const end = Math.min(opts.items.length, start + Math.ceil(opts.height / opts.rowHeight) + 10);
    if (start !== lastStart || end !== lastEnd) {
      lastStart = start;
      lastEnd = end;
      rows.innerHTML = "";
      rows.style.top = String(start * opts.rowHeight) + "px";
      for (let i = start; i < end; i++) {
        const r = opts.renderRow(opts.items[i], i);
        r.style.height = opts.rowHeight + "px";
        rows.appendChild(r);
      }
    }
    if (opts.onReachEnd && !endFired && outer.scrollTop + opts.height >= outer.scrollHeight - opts.rowHeight) {
      if (end >= opts.items.length) {
        endFired = true;
        opts.onReachEnd();
      }
    }
  };
  outer.addEventListener("scroll", draw);
  setTimeout(draw, 0);
  return outer;
}

// ---------- 样式（一次注入；UI bundle 自包含，不依赖宿主主题） ----------

let styled = false;

export function ensureStyles(): void {
  if (styled || document.getElementById("memweave-style")) return;
  styled = true;
  const css = [
    ".mw-root{--mw-line:color-mix(in srgb,currentColor 12%,transparent);--mw-muted:color-mix(in srgb,currentColor 58%,transparent);--mw-wash:color-mix(in srgb,currentColor 3%,transparent);font-family:inherit;font-size:14px;line-height:1.55;color:inherit;min-width:0}",
    ".mw-nav{display:flex;flex-wrap:wrap;align-items:stretch;column-gap:20px;row-gap:0;overflow:visible;white-space:normal;padding:0 12px;border-bottom:1px solid var(--mw-line)}",
    ".mw-tab{flex:0 0 auto;width:auto;min-height:44px;padding:9px 2px 8px;border:0;border-bottom:2px solid transparent;border-radius:0;background:transparent;color:var(--mw-muted);font:inherit;font-size:14px;text-align:center;white-space:nowrap;cursor:pointer;transition:color .14s,border-color .14s}",
    ".mw-tab:hover{color:inherit;background:transparent}",
    ".mw-tab.mw-active{color:inherit;border-bottom-color:currentColor;font-weight:700}",
    ".mw-subnav{column-gap:18px;row-gap:0;margin:4px 0 8px;padding:0 2px;border-bottom:1px solid var(--mw-line)}",
    ".mw-subnav .mw-tab{min-height:36px;padding:6px 2px;font-size:13px}",
    ".mw-main{min-width:0;padding:18px 14px 28px;outline:none}",
    ".mw-main:focus-visible{box-shadow:inset 0 0 0 2px color-mix(in srgb,currentColor 30%,transparent)}",
    ".mw-card{min-width:0;margin:0;padding:14px 0 20px;border:0;border-bottom:1px solid var(--mw-line);border-radius:0;background:transparent}",
    ".mw-card:last-child{border-bottom:0}",
    ".mw-card h3{margin:0 0 14px;font-size:16px;font-weight:650;line-height:1.4}",
    ".mw-card h4{margin:12px 0 2px;font-size:14px;font-weight:650}",
    ".mw-col{display:flex;flex-direction:column;gap:12px;min-width:0}",
    ".mw-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}",
    ".mw-field-row{display:grid;grid-template-columns:minmax(140px,220px) minmax(0,1fr);align-items:center;gap:12px;min-width:0}",
    ".mw-field-label{font-size:13px;font-weight:600;color:var(--mw-muted)}",
    ".mw-field-stack{display:flex;flex-direction:column;gap:7px;min-width:0}",
    ".mw-field-stack>input,.mw-field-stack>select,.mw-field-stack>textarea{width:100%}",
    ".mw-filter-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,190px),1fr));align-items:end;gap:12px}",
    ".mw-filter-actions{display:flex;align-items:center;gap:10px;min-height:40px}",
    ".mw-inline-input{display:flex;align-items:center;gap:8px;min-width:0}",
    ".mw-inline-input>input{flex:1 1 auto;min-width:0}",
    ".mw-inline-input>button,.mw-path-pick>button{flex:0 0 auto;white-space:nowrap}",
    ".mw-path-pick{display:flex;align-items:center;gap:10px;flex-wrap:wrap;min-width:0}",
    ".mw-path-chosen{min-width:0;overflow-wrap:anywhere;font-size:13px}",
    ".mw-path-chosen.mw-path-empty{color:var(--mw-muted)}",
    ".mw-manual>summary{cursor:pointer;font-size:12px;color:var(--mw-muted);margin-bottom:6px}",
    ".mw-manual>input{width:100%}",
    // 小时选择：24 个可点的小格子
    ".mw-hours{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:4px;min-width:0}",
    ".mw-hour{min-height:30px!important;padding:0!important;border-radius:6px;font-size:12px;font-variant-numeric:tabular-nums}",
    // 选中：实心深色底 + 白字（原先淡黄底被 .mw-root button 的透明背景盖掉，几乎看不出来）
    ".mw-root .mw-hours .mw-hour[aria-pressed=true]{background:#1f6feb!important;border-color:#1f6feb!important;color:#fff!important;font-weight:650}",
    ".mw-root .mw-hours .mw-hour[aria-pressed=true]:hover{background:#1a5fd0!important}",
    ".mw-root .mw-hours .mw-hour[aria-pressed=false]{color:var(--mw-muted)}",
    ".mw-hours-tools{display:flex;gap:6px;flex-wrap:wrap;align-items:center}",
    ".mw-hours-tools button{min-height:28px!important;padding:2px 10px!important;font-size:12px}",
    "@media(max-width:600px){.mw-hours{grid-template-columns:repeat(6,minmax(0,1fr))}}",
    ".mw-field-row input:not([type=checkbox]),.mw-field-row select{width:100%;min-width:0}",
    ".mw-check-row{display:inline-flex;align-items:center;gap:9px;min-height:38px;padding:5px 10px;border:1px solid var(--mw-line);border-radius:6px;background:var(--mw-wash);cursor:pointer}",
    ".mw-check-row span{font-size:13px}",
    ".mw-option-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr));gap:10px 16px}",
    ".mw-item-card{display:flex;flex-direction:column;gap:12px;min-width:0;padding:14px;border:1px solid var(--mw-line);border-radius:7px;background:var(--mw-wash)}",
    ".mw-item-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}",
    ".mw-setting-toolbar{padding:10px 0;border-bottom:1px solid var(--mw-line)}",
    ".mw-root button,.mw-root input,.mw-root select,.mw-root textarea{font:inherit;color:inherit}",
    ".mw-root button:not(.mw-tab){min-height:36px;padding:6px 12px;border:1px solid var(--mw-line);border-radius:6px;background:transparent;cursor:pointer;transition:background .14s,border-color .14s}",
    ".mw-root button:not(.mw-tab):hover{background:var(--mw-wash);border-color:color-mix(in srgb,currentColor 28%,transparent)}",
    ".mw-root button:disabled{opacity:.45;cursor:not-allowed}",
    ".mw-root input:not([type=checkbox]):not([type=range]),.mw-root select,.mw-root textarea{box-sizing:border-box;min-height:40px;max-width:100%;padding:8px 12px;border:1px solid var(--mw-line);border-radius:7px;background:transparent}",
    ".mw-slider-control{display:flex;flex-direction:column;gap:5px;width:min(100%,420px);min-width:220px}",
    ".mw-slider-control input[type=range]{width:100%;margin:3px 0}",
    ".mw-option-grid>.mw-col{gap:6px}",
    ".mw-item-head>.mw-content{flex:1 1 auto}",
    ".mw-root label.mw-col{gap:7px}",
    ".mw-root label.mw-col>span:first-child{font-size:13px;font-weight:650;color:var(--mw-muted)}",
    ".mw-root label.mw-col input:not([type=checkbox]),.mw-root label.mw-col select,.mw-root label.mw-col textarea{width:100%}",
    ".mw-root label.mw-row{gap:10px}",
    ".mw-root textarea{resize:vertical}",
    ".mw-root input:focus-visible,.mw-root select:focus-visible,.mw-root textarea:focus-visible,.mw-root button:focus-visible{outline:2px solid color-mix(in srgb,currentColor 42%,transparent);outline-offset:2px}",
    ".mw-root input[type=checkbox]{width:20px;height:20px;accent-color:#171717;vertical-align:middle}",
    ".mw-pre{white-space:pre-wrap;overflow-wrap:anywhere;background:var(--mw-wash);border:1px solid var(--mw-line);padding:12px 14px;border-radius:7px;max-height:320px;overflow:auto;margin:0;font:12px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace}",
    // 状态标签：胶囊形、细字重、无硬边框，颜色只用来区分语义，不抢正文
    ".mw-badge{display:inline-flex;align-items:center;gap:6px;min-height:22px;padding:2px 10px;border:0;border-radius:999px;font-size:12px;font-weight:500;line-height:18px;white-space:nowrap;letter-spacing:.01em;font-variant-numeric:tabular-nums}",
    ".mw-badge::before{content:'';flex:0 0 auto;width:6px;height:6px;border-radius:50%;background:currentColor;opacity:.75}",
    ".mw-badge.mw-ok{background:color-mix(in srgb,#2f9e63 11%,transparent);color:color-mix(in srgb,#1f7a4a 82%,currentColor)}",
    ".mw-badge.mw-warn{background:color-mix(in srgb,#d49a1c 14%,transparent);color:color-mix(in srgb,#9a6a00 82%,currentColor)}",
    ".mw-badge.mw-bad{background:color-mix(in srgb,#d84a4a 12%,transparent);color:color-mix(in srgb,#b23030 85%,currentColor)}",
    ".mw-badge.mw-plain{background:var(--mw-wash);color:var(--mw-muted)}",
    ".mw-badge.mw-plain::before{display:none}",
    ".mw-banner{margin:12px 14px 0;padding:9px 12px;border:1px solid rgba(210,70,70,.22);border-left:3px solid rgba(210,70,70,.7);border-radius:5px;background:rgba(210,70,70,.07)}",
    ".mw-item{border-bottom:1px solid var(--mw-line);padding:10px 0}",
    ".mw-sel{background:var(--mw-wash);outline:1px solid color-mix(in srgb,currentColor 24%,transparent)}",
    ".mw-content{flex:1;min-width:0;overflow-wrap:anywhere}",
    ".mw-vlist{position:relative;overflow:auto;border:1px solid var(--mw-line);border-radius:7px;background:transparent}",
    ".mw-vrows{position:absolute;left:0;right:0;top:0}",
    ".mw-vrow{display:flex;align-items:center;gap:8px;padding:0 12px;cursor:pointer;box-sizing:border-box;overflow:hidden;border-bottom:1px solid color-mix(in srgb,currentColor 7%,transparent)}",
    ".mw-vrow:hover{background:var(--mw-wash)}",
    // 敏感内容规则编辑器
    ".mw-sens{display:flex;flex-direction:column;gap:8px}",
    ".mw-sens-builtin{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:6px 16px}",
    ".mw-sens-rule{gap:6px}",
    ".mw-sens-locked{opacity:.75}",
    ".mw-sens-custom{display:flex;flex-direction:column;gap:6px}",
    ".mw-sens-item{display:flex;align-items:center;gap:8px;padding:6px 10px;border:1px solid var(--mw-line);border-radius:6px;min-width:0}",
    ".mw-sens-code{flex:1 1 auto;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-family:ui-monospace,Consolas,monospace;font-size:13px}",
    ".mw-sens-del{flex:0 0 auto}",
    ".mw-sens-empty{margin:0}",
    ".mw-sens-add{display:flex;gap:8px}",
    ".mw-sens-add>input{flex:1 1 auto;min-width:0}",
    ".mw-sens-msg{min-height:18px}",
    ".mw-sens-msg[data-tone=ok]{color:#1a7f37}",
    ".mw-sens-msg[data-tone=bad]{color:#cf222e}",
    // 记忆列表：两行布局，正文单行省略，不再溢出压到上下行
    ".mw-vrow.mw-vrow-2l{flex-direction:column;align-items:stretch;justify-content:center;gap:4px;padding:6px 14px}",
    ".mw-vrow-meta{display:flex;align-items:center;gap:10px;min-width:0}",
    ".mw-vrow-meta .mw-badge{min-height:20px;line-height:16px}",
    ".mw-vrow-time{margin-left:auto;white-space:nowrap}",
    ".mw-vrow-text{min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:14px;line-height:20px}",
    ".mw-vrow.mw-sel{background:color-mix(in srgb,#1f6feb 9%,transparent);box-shadow:inset 3px 0 0 #1f6feb}",
    ".mw-empty{color:var(--mw-muted);padding:20px 12px;margin:0;text-align:center}",
    ".mw-drawer{display:flex;flex-direction:column;gap:10px;padding:14px 16px;border:1px solid var(--mw-line);border-radius:7px;background:var(--mw-wash)}",
    ".mw-chip{display:inline-flex;align-items:center;gap:4px;padding:3px 8px;border:1px solid var(--mw-line);border-radius:5px;background:transparent}",
    ".mw-chip button{min-height:24px!important;padding:1px 5px!important;border:0!important;background:transparent!important;cursor:pointer}",
    // 多称呼输入：标签 + 末尾输入框，整体看起来像一个输入框
    ".mw-names{display:flex;align-items:center;min-height:40px;padding:4px 6px;border:1px solid var(--mw-line);border-radius:7px;cursor:text;min-width:0}",
    ".mw-names:focus-within{outline:2px solid color-mix(in srgb,currentColor 42%,transparent);outline-offset:2px}",
    ".mw-names-chips{display:flex;flex-wrap:wrap;align-items:center;gap:6px;flex:1 1 auto;min-width:0}",
    ".mw-name-chip{display:inline-flex;align-items:center;gap:2px;padding:2px 4px 2px 10px;border-radius:999px;background:color-mix(in srgb,#1f6feb 12%,transparent);color:inherit;font-size:13px;line-height:20px}",
    ".mw-root .mw-name-chip button{min-height:20px!important;width:20px;padding:0!important;border:0!important;border-radius:50%;background:transparent!important;opacity:.6;line-height:1}",
    ".mw-root .mw-name-chip button:hover{opacity:1;background:color-mix(in srgb,CanvasText 10%,transparent)!important}",
    ".mw-root .mw-names .mw-names-entry{flex:1 1 90px;width:auto;min-width:90px;min-height:28px!important;padding:2px 4px!important;border:0!important;outline:none!important;background:transparent}",
    ".mw-flashbox{position:fixed;left:50%;top:20px;z-index:2147483000;display:flex;flex-direction:column;align-items:center;gap:8px;width:max-content;max-width:min(520px,calc(100vw - 32px));transform:translateX(-50%);pointer-events:none}",
    ".mw-flash{display:flex;align-items:center;gap:10px;min-height:20px;padding:9px 10px 9px 12px;border:1px solid color-mix(in srgb,CanvasText 10%,transparent);border-radius:10px;background:Canvas;color:CanvasText;box-shadow:0 8px 28px rgba(0,0,0,.16),0 1px 3px rgba(0,0,0,.08);font-size:13px;line-height:1.45;pointer-events:auto;animation:mw-flash-in .2s ease-out}",
    ".mw-flash-out{opacity:0;transform:translateY(-6px);transition:opacity .18s,transform .18s}",
    ".mw-flash-icon{display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;width:20px;height:20px;border-radius:50%;font-size:12px;font-weight:700;color:#fff}",
    ".mw-flash-ok .mw-flash-icon{background:#2f9e63}",
    ".mw-flash-warn .mw-flash-icon{background:#d49a1c}",
    ".mw-flash-bad .mw-flash-icon{background:#d84a4a}",
    ".mw-flash-text{flex:1 1 auto;min-width:0;overflow-wrap:anywhere}",
    ".mw-flash .mw-flash-close{flex:0 0 auto;min-height:22px!important;width:22px;padding:0!important;border:0!important;border-radius:6px;background:transparent;color:inherit;opacity:.5;cursor:pointer;font-size:15px;line-height:1}",
    ".mw-flash .mw-flash-close:hover{opacity:1;background:color-mix(in srgb,CanvasText 8%,transparent)}",
    "@keyframes mw-flash-in{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:none}}",
    // 未保存修改的顶部悬浮条
    ".mw-unsaved{position:sticky;top:0;z-index:20;display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:-4px 0 12px;padding:8px 10px 8px 14px;border:1px solid color-mix(in srgb,#d49a1c 35%,transparent);border-radius:10px;background:color-mix(in srgb,#d49a1c 10%,Canvas);box-shadow:0 4px 16px rgba(0,0,0,.08)}",
    ".mw-unsaved[hidden]{display:none}",
    ".mw-unsaved-dot{width:8px;height:8px;border-radius:50%;background:#d49a1c;flex:0 0 auto}",
    ".mw-unsaved-text{flex:1 1 200px;font-size:13px}",
    ".mw-pulse{animation:mw-pulse 1.2s ease-out}",
    "@keyframes mw-pulse{0%{box-shadow:0 0 0 0 color-mix(in srgb,#d49a1c 55%,transparent)}100%{box-shadow:0 0 0 14px transparent}}",
    // 模型档位说明
    ".mw-tier-help{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr));gap:8px}",
    ".mw-tier-item{padding:8px 12px;border:1px solid var(--mw-line);border-radius:8px;font-size:12px;line-height:1.5;color:var(--mw-muted)}",
    ".mw-tier-item b{display:block;margin-bottom:2px;font-size:13px;color:CanvasText;color:inherit}",
    ".mw-tier-item.mw-tier-on{border-color:color-mix(in srgb,currentColor 40%,transparent);background:var(--mw-wash)}",
    ".mw-tier-item.mw-tier-on b{color:inherit}",
    ".mw-slider{width:min(260px,100%)}",
    ".mw-small{font-size:12px;color:var(--mw-muted)}",
    ".mw-hint{margin:0;padding:8px 12px;border-left:3px solid var(--mw-line);border-radius:4px;background:var(--mw-wash);font-size:12px;color:var(--mw-muted)}",
    ".mw-mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px}",
    ".mw-overview{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr));gap:0 28px;align-items:start}",
    ".mw-kv-grid{display:grid;grid-template-columns:minmax(0,1fr);gap:8px}",
    ".mw-kv{display:grid;grid-template-columns:minmax(80px,110px) minmax(0,1fr);align-items:center;gap:10px;min-width:0}",
    ".mw-kv-label{font-size:13px;font-weight:600;color:var(--mw-muted)}",
    ".mw-kv-value{min-width:0;overflow-wrap:anywhere}",
    ".mw-bar-row{display:grid;grid-template-columns:minmax(76px,96px) minmax(0,1fr) 44px;align-items:center;gap:10px;padding:4px 0}",
    ".mw-bar-label{font-size:13px}",
    ".mw-bar{display:block;height:8px;border-radius:4px;background:var(--mw-wash);border:1px solid var(--mw-line);overflow:hidden}",
    ".mw-bar-fill{display:block;height:100%;background:color-mix(in srgb,currentColor 45%,transparent)}",
    ".mw-bar-num{text-align:right;font-variant-numeric:tabular-nums}",
    ".mw-clickable{cursor:pointer;padding-left:8px;padding-right:8px;border-radius:6px}",
    ".mw-clickable:hover{background:var(--mw-wash)}",
    // 候选 / 冲突卡片：头部标签、正文整段换行、底部按钮；窄窗口按钮自动换行
    ".mw-cand-list{gap:10px}",
    ".mw-cand{display:flex;flex-direction:column;gap:10px;min-width:0;padding:12px 14px;border:1px solid var(--mw-line);border-radius:8px;background:var(--mw-wash)}",
    ".mw-cand-head{display:flex;align-items:center;flex-wrap:wrap;gap:6px 8px;min-width:0}",
    ".mw-cand-reason{flex:1 1 180px;min-width:0}",
    ".mw-cand-body{margin:0;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere;word-break:normal}",
    ".mw-cand-pair{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px}",
    ".mw-cand-side{display:flex;flex-direction:column;gap:4px;min-width:0;padding:8px 10px;border:1px solid var(--mw-line);border-radius:6px;background:Canvas}",
    ".mw-cand-actions{display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end}",
    ".mw-drawer-sec{display:flex;flex-direction:column;gap:6px;padding:10px 0;border-top:1px solid var(--mw-line)}",
    ".mw-drawer-sec>h5{margin:0}",
    ".mw-drawer-sec .mw-row{flex-wrap:wrap}",
    ".mw-curate-row{display:flex;align-items:center;gap:8px;min-width:0;text-align:left;width:100%}",
    ".mw-curate-row>span:last-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}",
    ".mw-curate-group{display:flex;flex-direction:column;gap:4px;padding:8px;border:1px solid var(--mw-line);border-radius:6px}",
    ".mw-card-head{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;min-width:0}",
    ".mw-card-head>h4{margin:0}",
    ".mw-reset{font-size:12px;padding:2px 10px;flex:0 0 auto}",
    ".mw-reset[disabled]{opacity:.45}",
    ".mw-action-bar{margin-top:6px;padding:16px;border:1px solid var(--mw-line)!important;border-radius:8px;background:var(--mw-wash)}",
    ".mw-action-bar h3{margin:0}",
    ".mw-action-bar p{margin:0}",
    ".mw-action-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr));gap:12px 16px;align-items:start}",
    ".mw-action-grid button{width:100%}",
    ".mw-col.mw-col>.mw-small{margin:0}",
    ".mw-root button.mw-primary{border-color:color-mix(in srgb,currentColor 45%,transparent);font-weight:650}",
    "@media(max-width:600px){.mw-nav{column-gap:16px;padding:0 8px}.mw-main{padding:14px 8px 22px}.mw-subnav{column-gap:14px}.mw-row{gap:6px}.mw-row>.mw-col{flex:1 1 100%!important;min-width:0!important}.mw-field-row{grid-template-columns:minmax(0,1fr);gap:5px}.mw-option-grid{grid-template-columns:minmax(0,1fr)}.mw-item-head>.mw-content{display:none}.mw-slider-control{width:100%;min-width:0}}",
  ].join("\n");
  document.head.appendChild(el("style", { id: "memweave-style", text: css }));
}
