/// <reference lib="dom" />
/**
 * 忆织 MemWeave —— 会话侧栏状态徽章（§13.1 / D11）：
 * 「冲突 2 · 候选 5 · 撤销 3 · 本轮 380 字」，点击直达对应页；与设置页共用同一批 RPC。
 */

import { t } from "../i18n";
import { type AnyCtx, el, ensureStyles, getCtx, rpc, setCtx, state } from "./ui";

let rootEl: HTMLElement | null = null;
let timer: number | null = null;

function go(tab: string): void {
  const ctx = getCtx() as Record<string, unknown> | null;
  const open = (ctx?.openTab ?? ctx?.openSettings ?? null) as ((tab: string) => void) | null;
  if (typeof open === "function") open(tab);
  // 宿主不提供跳转口时，至少把意图广播出去（设置页可监听）
  window.dispatchEvent(new CustomEvent("memweave:navigate", { detail: { tab } }));
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

  // 本轮字符：拿得到 sessionId 才显示（注入账本最后一条）
  const sid = String((getCtx() as AnyCtx | null)?.sessionId ?? "");
  if (sid) {
    const ledger = (await rpc("inject/ledger", { sessionId: sid })) as { rows?: Array<Record<string, unknown>> };
    const rows = ledger?.rows ?? [];
    const last = rows[rows.length - 1];
    if (last) segs.push(seg(t("badge.turn", state.lang) + " " + String(last.chars ?? 0) + " 字", "inject", "ok"));
  }

  rootEl.innerHTML = "";
  for (const s of segs) rootEl.appendChild(s);
}

export function mountBadge(ctx: AnyCtx): void {
  setCtx(ctx);
  ensureStyles();
  const host = ctx.container ?? ctx.element ?? document.body;
  rootEl = el("div", { class: "mw-row", id: "memweave-badge", role: "status", "aria-label": "memweave badge" });
  host.appendChild(rootEl);
  void draw();
  timer = window.setInterval(() => void draw(), 60000);
}

export function unmountBadge(): void {
  if (timer !== null) window.clearInterval(timer);
  timer = null;
  rootEl?.remove();
  rootEl = null;
}
