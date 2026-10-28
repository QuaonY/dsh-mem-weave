/// <reference lib="dom" />
/**
 * 忆织 MemWeave —— 页面注册与装配（§13.1 七子页 + §13.4 tab 懒加载）
 */

import { t } from "../i18n";
import { el, ensureStyles, rpc, setRefresher, state } from "./ui";
import { loadPersona, pagePersona, stashPersonaDraft } from "./persona";
import { loadMemory, pageMemory } from "./memory";
import {
  loadAdvanced,
  loadCandidates,
  loadData,
  loadGovern,
  loadInject,
  loadOverview,
  pageAdvanced,
  pageCandidates,
  pageData,
  pageGovern,
  pageInject,
  pageOverview,
} from "./misc";

interface PageDef {
  key: string;
  labelKey: string;
  render: () => HTMLElement;
  load: () => Promise<void>;
}

export const PAGES: PageDef[] = [
  { key: "overview", labelKey: "nav.overview", render: pageOverview, load: loadOverview },
  { key: "persona", labelKey: "nav.persona", render: pagePersona, load: loadPersona },
  { key: "memory", labelKey: "nav.memory", render: pageMemory, load: loadMemory },
  { key: "candidates", labelKey: "nav.candidates", render: pageCandidates, load: loadCandidates },
  { key: "inject", labelKey: "nav.inject", render: pageInject, load: loadInject },
  { key: "govern", labelKey: "nav.govern", render: pageGovern, load: loadGovern },
  { key: "data", labelKey: "nav.data", render: pageData, load: loadData },
  { key: "advanced", labelKey: "nav.advanced", render: pageAdvanced, load: loadAdvanced },
];

let rootEl: HTMLElement | null = null;

export function setRoot(root: HTMLElement | null): void {
  rootEl = root;
}

export function navigate(tab: string): Promise<void> {
  state.tab = tab;
  return refresh();
}

export async function refresh(): Promise<void> {
  if (!rootEl) return;
  ensureStyles();
  const status = (await rpc("status/get", {})) as Record<string, unknown>;
  if (status && status.ok !== false) state.status = status;
  const ex = (await rpc("exclusion/check", {})) as { paused?: boolean };
  state.readonly = Boolean((state.status ?? {}).readonly);
  state.paused = Boolean(ex?.paused) || Boolean((state.status as { paused?: boolean } | null)?.paused);
  const page = PAGES.find((p) => p.key === state.tab) ?? PAGES[0];
  await page.load();
  render();
}

export function render(): void {
  if (!rootEl) return;
  // 人格页的未保存输入在重绘前收进草稿（切分页 / 切导航 / 后台刷新都不丢）
  stashPersonaDraft();
  rootEl.innerHTML = "";
  rootEl.classList.add("mw-root");
  ensureStyles();

  const page = PAGES.find((p) => p.key === state.tab) ?? PAGES[0];
  const nav = el("nav", { class: "mw-nav", role: "tablist", "aria-label": t("settings.navigation", state.lang) });
  for (const p of PAGES) {
    const active = state.tab === p.key;
    nav.appendChild(
      el("button", {
        type: "button",
        role: "tab",
        id: "mw-tab-" + p.key,
        class: "mw-tab" + (active ? " mw-active" : ""),
        "aria-selected": active ? "true" : "false",
        "aria-controls": "mw-panel",
        tabindex: active ? "0" : "-1",
        text: t(p.labelKey, state.lang),
        onclick: () => navigate(p.key),
        onkeydown: (rawEvent: Event) => {
          const event = rawEvent as KeyboardEvent;
          const current = PAGES.findIndex((item) => item.key === p.key);
          let next = current;
          if (event.key === "Home") next = 0;
          else if (event.key === "End") next = PAGES.length - 1;
          else if (event.key === "ArrowRight") next = (current + 1) % PAGES.length;
          else if (event.key === "ArrowLeft") next = (current + PAGES.length - 1) % PAGES.length;
          else return;
          event.preventDefault();
          const target = PAGES[next];
          void navigate(target.key).then(() => document.getElementById("mw-tab-" + target.key)?.focus());
        },
      }),
    );
  }
  rootEl.appendChild(nav);

  const bannerText = state.readonly
    ? t("banner.readonly", state.lang)
    : state.paused
      ? t("banner.paused", state.lang)
      : "";
  if (bannerText) rootEl.appendChild(el("div", { class: "mw-banner", role: "alert", text: bannerText }));

  rootEl.appendChild(el("main", {
    class: "mw-main",
    id: "mw-panel",
    role: "tabpanel",
    "aria-labelledby": "mw-tab-" + page.key,
    tabindex: "0",
  }, [page.render()]));
}

// 各页模块统一调 ui.refresh() → 走这里的装载 + 重绘
setRefresher(refresh);
