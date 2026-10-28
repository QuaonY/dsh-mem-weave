/// <reference lib="dom" />
/**
 * 忆织 MemWeave —— 记忆页（§13.2.3）：七层过滤 + 虚拟列表（≥1000 条不卡）+ 详情抽屉。
 */

import { t } from "../i18n";
import {
  badge,
  dangerConfirm,
  el,
  flash,
  fmtTime,
  num,
  refresh,
  report,
  rpc,
  state,
  virtualList,
} from "./ui";
import { anchorSection, promiseSection, termsSection, type ExtraEntry } from "./memory-extra";

const PAGE = 200;

/** 从别的页（如高级页「待整理」清单）直接打开某条记忆的详情 */
export function openMemoryDrawer(id: string): void {
  drawerId = id;
}
/** 两行：上面是层级/重要度/命中/时间，下面是正文（单行省略，点开看全文） */
const ROW_H = 60;

const filter = { level: "", status: "active", project: "", keyword: "" };
let drawerId: string | null = null;

interface EntryLike {
  id: string;
  level: string;
  project: string | null;
  section: string | null;
  content: string;
  keywords: string[];
  importance: number;
  status: string;
  semanticKey: string | null;
  tier: string;
  accessCount: number;
  createdAt: number;
  updatedAt: number;
  evidence?: Array<{ sessionId: string; seq: number; quote: string }>;
  /** roadmap R10：高唤醒「闪光灯」条目（检索 ×1.45）；设置页能看到并取消 */
  flash?: boolean;
}

export async function loadMemory(): Promise<void> {
  const cur = (state.data.memory as Array<Record<string, unknown>>) ?? [];
  const limit = Math.max(PAGE, cur.length);
  const response = await rpc("memory/list", {
    level: filter.level || undefined,
    status: filter.status === "all" ? undefined : filter.status,
    project: filter.project || undefined,
    limit,
    offset: 0,
  }) as { items?: Array<Record<string, unknown>>; ok?: boolean; code?: string; message?: string };
  if (response?.ok === false || !Array.isArray(response?.items)) {
    state.data.memoryError = String(response?.code ?? "E_UNAVAILABLE") + ": " + String(response?.message ?? "memory service unavailable");
    state.data.memory = [];
    state.data.memoryDone = true;
    return;
  }
  state.data.memoryError = "";
  state.data.memory = response.items;
  state.data.memoryDone = response.items.length < limit;
  if (drawerId) state.data.entry = await rpc("memory/get", { id: drawerId });
}

async function loadMore(): Promise<void> {
  const cur = (state.data.memory as Array<Record<string, unknown>>) ?? [];
  if (state.data.memoryDone === true) return;
  const response = await rpc("memory/list", {
    level: filter.level || undefined,
    status: filter.status === "all" ? undefined : filter.status,
    project: filter.project || undefined,
    limit: PAGE,
    offset: cur.length,
  }) as { items?: Array<Record<string, unknown>>; ok?: boolean; code?: string; message?: string };
  if (response?.ok === false || !Array.isArray(response?.items)) {
    state.data.memoryError = String(response?.code ?? "E_UNAVAILABLE") + ": " + String(response?.message ?? "memory service unavailable");
    state.data.memoryDone = true;
    void refresh();
    return;
  }
  const got = response.items;
  state.data.memoryError = "";
  state.data.memory = [...cur, ...got];
  state.data.memoryDone = got.length < PAGE;
  void refresh();
}

function visibleItems(): EntryLike[] {
  const items = ((state.data.memory as Array<Record<string, unknown>>) ?? []) as unknown as EntryLike[];
  const kw = filter.keyword.trim().toLowerCase();
  if (!kw) return items;
  return items.filter(
    (e) =>
      e.content.toLowerCase().includes(kw) ||
      (e.keywords ?? []).some((k) => String(k).toLowerCase().includes(kw)),
  );
}

// ---------- 详情抽屉 ----------

function drawer(): HTMLElement {
  const out = state.data.entry as { ok?: boolean; entry?: EntryLike; links?: Array<Record<string, unknown>> } | undefined;
  const e = out?.entry;
  if (!drawerId || !e) return el("div");
  const keywords: string[] = [...(e.keywords ?? [])];

  const kwBox = el("div", { class: "mw-row" });
  const drawKw = (): void => {
    kwBox.innerHTML = "";
    keywords.forEach((k, i) => {
      kwBox.appendChild(
        el("span", { class: "mw-chip" }, [
          document.createTextNode(k),
          el("button", {
            type: "button",
            text: "×",
            "aria-label": t("common.del", state.lang),
            onclick: () => {
              keywords.splice(i, 1);
              drawKw();
            },
          }),
        ]),
      );
    });
  };
  drawKw();
  const kwInput = el("input", { type: "text", "aria-label": t("memory.keywords", state.lang) }) as HTMLInputElement;
  kwInput.addEventListener("keydown", (ev: KeyboardEvent) => {
    if (ev.key !== "Enter" || !kwInput.value.trim()) return;
    keywords.push(kwInput.value.trim());
    kwInput.value = "";
    drawKw();
  });

  const projectInput = el("input", { type: "text", value: String(e.project ?? ""), "aria-label": t("field.project", state.lang) }) as HTMLInputElement;
  const sectionInput = el("input", { type: "text", value: String(e.section ?? ""), "aria-label": t("field.section", state.lang) }) as HTMLInputElement;
  const semanticInput = el("input", { type: "text", value: String(e.semanticKey ?? ""), "aria-label": t("field.semanticKey", state.lang) }) as HTMLInputElement;
  const tierSelect = el("select", { "aria-label": t("field.tier", state.lang) }) as HTMLSelectElement;
  for (const tier of ["core", "hot", "cold"]) {
    const opt = el("option", { value: tier, text: t("option.tier." + tier, state.lang) }) as HTMLOptionElement;
    if (e.tier === tier) opt.selected = true;
    tierSelect.appendChild(opt);
  }

  const linksBox = el("div", { class: "mw-col" });
  for (const l of out?.links ?? []) {
    const dst = String(l.dst ?? "");
    linksBox.appendChild(
      el("button", {
        type: "button",
        class: "mw-row",
        text: String(l.kind ?? "link") + " → " + dst.slice(0, 12),
        onclick: () => {
          drawerId = dst;
          void refresh();
        },
      }),
    );
  }

  const evidenceBox = el("div", { class: "mw-col" });
  for (const ev of e.evidence ?? []) {
    evidenceBox.appendChild(
      el("div", { class: "mw-row mw-item" }, [
        badge(String(ev.sessionId ?? "-").slice(0, 8) + "#" + String(ev.seq ?? 0), "warn"),
        el("span", { class: "mw-content", text: String(ev.quote ?? "").slice(0, 120) }),
      ]),
    );
  }

  return el("div", { class: "mw-drawer" }, [
    el("div", { class: "mw-row" }, [
      el("h4", { text: t("memory.detail", state.lang) }),
      badge(t("option.level." + e.level, state.lang), "plain"),
      badge(t("option.status." + e.status, state.lang), e.status === "active" ? "ok" : "warn"),
      ...(e.flash ? [badge(t("memory.flashOn", state.lang), "warn")] : []),
      el("span", { class: "mw-small", text: t("field.id", state.lang) + "：" + e.id }),
      el("button", {
        type: "button",
        text: t(e.flash ? "memory.flashCancel" : "memory.flashSet", state.lang),
        title: t("memory.flashHint", state.lang),
        disabled: state.readonly ? "disabled" : undefined,
        onclick: () => {
          void rpc("memory/flash", { id: e.id, flash: !e.flash }).then((out2) => {
            if (report(out2, t(e.flash ? "memory.flashCancel" : "memory.flashSet", state.lang))) void refresh();
          });
        },
      }),
      el("button", {
        type: "button",
        text: t("memory.close", state.lang),
        onclick: () => {
          drawerId = null;
          state.data.entry = undefined;
          void refresh();
        },
      }),
    ]),
    el("pre", { class: "mw-pre", text: e.content }),
    el("div", { class: "mw-field-stack" }, [
      el("span", { class: "mw-field-label", text: t("field.keywords", state.lang) }),
      kwBox,
      kwInput,
    ]),
    el("label", { class: "mw-field-row" }, [el("span", { class: "mw-field-label", text: t("field.project", state.lang) }), projectInput]),
    el("label", { class: "mw-field-row" }, [el("span", { class: "mw-field-label", text: t("field.section", state.lang) }), sectionInput]),
    el("label", { class: "mw-field-row" }, [el("span", { class: "mw-field-label", text: t("field.semanticKey", state.lang) }), semanticInput]),
    el("div", { class: "mw-field-stack" }, [
      el("span", { class: "mw-field-label", text: t("field.tier", state.lang) }),
      tierSelect,
      el("span", { class: "mw-small", text: "更新时间：" + fmtTime(e.updatedAt) + " · " + t("memory.hits", state.lang) + "：" + String(e.accessCount ?? 0) }),
    ]),
    // v0.6 M1/M2、v0.7 S1：这三节各自保存（不随下方「保存修改」）
    termsSection(e as unknown as ExtraEntry),
    anchorSection(e as unknown as ExtraEntry),
    promiseSection(e as unknown as ExtraEntry),
    el("h5", { text: t("memory.evidence", state.lang) }),
    evidenceBox,
    el("h5", { text: t("memory.links", state.lang) }),
    linksBox,
    el("div", { class: "mw-row" }, [
      el("button", {
        type: "button",
        text: t("memory.saveChanges", state.lang),
        disabled: state.readonly ? "disabled" : undefined,
        onclick: () => {
          void rpc("memory/update", {
            id: e.id,
            patch: {
              keywords,
              project: projectInput.value || null,
              section: sectionInput.value || null,
              semanticKey: semanticInput.value || null,
              tier: tierSelect.value,
            },
            expectedUpdatedAt: num(e.updatedAt),
          }).then((out2) => {
            if (report(out2, t("memory.saveChanges", state.lang))) void refresh();
          });
        },
      }),
      el("button", {
        type: "button",
        text: t("memory.archive", state.lang),
        disabled: state.readonly ? "disabled" : undefined,
        onclick: () => {
          void rpc("memory/archive", { id: e.id }).then((out2) => {
            if (report(out2)) void refresh();
          });
        },
      }),
      el("button", {
        type: "button",
        text: t("memory.restore", state.lang),
        disabled: state.readonly ? "disabled" : undefined,
        onclick: () => {
          void rpc("memory/restore", { id: e.id }).then((out2) => {
            if (report(out2)) void refresh();
          });
        },
      }),
      el("button", {
        type: "button",
        text: t("memory.forget", state.lang),
        disabled: state.readonly ? "disabled" : undefined,
        onclick: () => {
          if (!dangerConfirm("FORGET", t("memory.forget", state.lang) + " " + e.id)) return;
          void rpc("memory/forget", { id: e.id, confirm: "FORGET" }).then((out2) => {
            if (report(out2)) {
              drawerId = null;
              void refresh();
            }
          });
        },
      }),
    ]),
  ]);
}

// ---------- 主页面 ----------

export function pageMemory(): HTMLElement {
  const items = visibleItems();
  const levelSelect = el("select", { "aria-label": t("memory.level", state.lang) }) as HTMLSelectElement;
  for (const lv of ["", "soul", "user", "project", "fact", "lesson", "topic", "rules"]) {
    const opt = el("option", { value: lv, text: lv === "" ? t("memory.all", state.lang) : t("option.level." + lv, state.lang) }) as HTMLOptionElement;
    if (filter.level === lv) opt.selected = true;
    levelSelect.appendChild(opt);
  }
  levelSelect.addEventListener("change", () => {
    filter.level = levelSelect.value;
    void refresh();
  });
  const statusSelect = el("select", { "aria-label": t("memory.status", state.lang) }) as HTMLSelectElement;
  for (const st of ["active", "stale", "archived", "all"]) {
    const opt = el("option", { value: st, text: t("option.status." + st, state.lang) }) as HTMLOptionElement;
    if (filter.status === st) opt.selected = true;
    statusSelect.appendChild(opt);
  }
  statusSelect.addEventListener("change", () => {
    filter.status = statusSelect.value;
    void refresh();
  });
  const projectInput = el("input", { type: "text", value: filter.project, "aria-label": t("field.project", state.lang) }) as HTMLInputElement;
  const keywordInput = el("input", { type: "text", value: filter.keyword, "aria-label": t("memory.search", state.lang) }) as HTMLInputElement;

  const list = virtualList<EntryLike>({
    items,
    rowHeight: ROW_H,
    height: 420,
    emptyText: String(state.data.memoryError ?? "") || t("common.empty", state.lang),
    onReachEnd: () => {
      void loadMore();
    },
    renderRow: (e) =>
      el("div", {
        class: "mw-vrow mw-vrow-2l" + (drawerId === e.id ? " mw-sel" : ""),
        role: "listitem",
        tabindex: "0",
        onclick: () => {
          drawerId = e.id;
          void refresh();
        },
        onkeydown: (event: Event) => {
          const keyEvent = event as KeyboardEvent;
          if (keyEvent.key !== "Enter" && keyEvent.key !== " ") return;
          keyEvent.preventDefault();
          drawerId = e.id;
          void refresh();
        },
      }, [
        el("div", { class: "mw-vrow-meta" }, [
          badge(t("option.level." + e.level, state.lang), "plain"),
          el("span", { class: "mw-small", text: t("memory.importance", state.lang) + " " + String(num(e.importance, 0).toFixed(1)) }),
          el("span", { class: "mw-small", text: t("memory.hits", state.lang) + " " + String(e.accessCount ?? 0) }),
          el("span", { class: "mw-small mw-vrow-time", text: fmtTime(e.updatedAt) }),
        ]),
        el("div", { class: "mw-vrow-text", title: e.content, text: e.content }),
      ]),
  });

  return el("section", { class: "mw-card" }, [
    el("h3", { text: t("nav.memory", state.lang) }),
    el("div", { class: "mw-filter-grid" }, [
      el("label", { class: "mw-col" }, [el("span", { text: t("memory.level", state.lang) }), levelSelect]),
      el("label", { class: "mw-col" }, [el("span", { text: t("memory.status", state.lang) }), statusSelect]),
      el("label", { class: "mw-col" }, [el("span", { text: t("field.project", state.lang) }), projectInput]),
      el("label", { class: "mw-col" }, [el("span", { text: t("memory.search", state.lang) }), keywordInput]),
    ]),
    el("div", { class: "mw-filter-actions" }, [
      el("button", {
        type: "button",
        text: t("memory.search", state.lang),
        onclick: () => {
          filter.project = projectInput.value.trim();
          filter.keyword = keywordInput.value;
          void refresh();
        },
      }),
      el("span", { class: "mw-small", text: "已载入 " + String(items.length) + " 条记忆" }),
    ]),
    list,
    drawer(),
  ]);
}
