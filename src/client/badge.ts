/// <reference lib="dom" />
/**
 * 忆织 MemWeave —— 会话侧栏状态徽章
 * 「冲突 2 · 候选 5 · 撤销 3 · 本轮 380 字」，点击直达对应页；与设置页共用同一批 RPC。
 */

import { t } from "../i18n";
import { type AnyCtx, el, ensureStyles, getCtx, rpc, setCtx, state } from "./ui";

let rootEl: HTMLElement | null = null;
let timer: number | null = null;

function go(tab: string): void {
  // 受保护上下文里读不存在的字段会抛，跳转口拿不到就只广播事件
  let open: ((tab: string) => void) | null = null;
  try {
    const ctx = getCtx() as Record<string, unknown> | null;
    const fn = ctx?.openTab ?? ctx?.openSettings ?? null;
    if (typeof fn === "function") open = fn as (tab: string) => void;
  } catch {
    open = null;
  }
  if (open) open(tab);
  // 宿主不提供跳转口时，至少把意图广播出去（设置页可监听）
  window.dispatchEvent(new CustomEvent("memweave:navigate", { detail: { tab } }));
}

/** 读宿主 ctx 上的 sessionId：受保护上下文里读未声明字段会抛，读不到就当没有。 */
function readSessionId(): string {
  try {
    return String((getCtx() as AnyCtx | null)?.sessionId ?? "");
  } catch {
    return "";
  }
}

async function draw(): Promise<void> {
  if (!rootEl) return;
  const status = (await rpc("status/get", {})) as Record<string, unknown>;
  const undo = (await rpc("undo/list", {})) as { items?: Array<Record<string, unknown>> };
  const pending = (undo?.items ?? []).filter((u) => !u.undone).length;

  const segs: HTMLElement[] = [];
  const seg = (text: string, tab: string, tone: "ok" | "warn" | "bad"): HTMLElement =>
    el("button", {
      type: "button",
      class: "mw-badge mw-" + tone,
      text,
      title: tab,
      onclick: () => go(tab),
    });
  segs.push(seg(t("badge.conflict", state.lang) + " " + String(status?.conflictsOpen ?? 0), "candidates", "bad"));
  segs.push(seg(t("badge.candidate", state.lang) + " " + String(status?.candidatesPending ?? 0), "candidates", "warn"));
  segs.push(seg(t("badge.undo", state.lang) + " " + String(pending), "govern", "warn"));

  // 本轮字符：拿得到 sessionId 才显示（注入账本最后一条）；
  // 受保护上下文里读未声明字段会抛，读不到就不显示这一段
  const sid = readSessionId();
  if (sid) {
    const ledger = (await rpc("inject/ledger", { sessionId: sid })) as { rows?: Array<Record<string, unknown>> };
    const rows = ledger?.rows ?? [];
    const last = rows[rows.length - 1];
    if (last) segs.push(seg(t("badge.turn", state.lang) + " " + String(last.chars ?? 0) + " 字", "inject", "ok"));
  }

  rootEl.innerHTML = "";
  for (const s of segs) rootEl.appendChild(s);
}

/**
 * 挂载徽章。
 * `host` 是宿主插槽给的 DOM 容器，必须显式传入：DSH 的插件上下文是受保护对象，
 * 往上写未声明的字段（例如把 container 挂到 ctx 副本上）会抛
 * `Cannot set property "container" without provide`，所以只在读不到时退回 body。
 */
export function mountBadge(ctx: AnyCtx, host?: HTMLElement): void {
  setCtx(ctx);
  ensureStyles();
  const target = host ?? fallbackHost(ctx);
  rootEl = el("div", { class: "mw-row", id: "memweave-badge", role: "status", "aria-label": "memweave badge" });
  target.appendChild(rootEl);
  // RPC 还没就绪时 draw 会失败，吞掉即可；下一次定时器会重试
  void draw().catch(() => undefined);
  timer = window.setInterval(() => void draw().catch(() => undefined), 60000);
}

/** 没有显式容器时的兜底：能读到就用，读不到（受保护上下文会抛）就挂到 body。 */
function fallbackHost(ctx: AnyCtx): HTMLElement {
  try {
    const c = (ctx as { container?: HTMLElement }).container ?? (ctx as { element?: HTMLElement }).element;
    if (c) return c;
  } catch {
    // 受保护上下文：忽略，退回 body
  }
  return document.body;
}

export function unmountBadge(): void {
  if (timer !== null) window.clearInterval(timer);
  timer = null;
  rootEl?.remove();
  rootEl = null;
}
