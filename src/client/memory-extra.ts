/// <reference lib="dom" />
/**
 * 忆织 MemWeave —— 记忆详情抽屉的补充小节（roadmap v0.6 §5 M1/M2、v0.7 §6 S1）：
 * 检索词、日历锚点、约定。每个小节各自保存，直接调对应的人工 RPC。
 */

import { t } from "../i18n";
import { FESTIVAL_NAMES } from "../core/calendar";
import { badge, el, fmtTime, refresh, report, rpc, state } from "./ui";

export interface ExtraEntry {
  id: string;
  searchTerms?: string[] | null;
  calendarAnchor?: {
    kind: string;
    month?: number;
    day?: number;
    weekday?: number;
    festival?: string;
    sinceYear?: number;
    label?: string;
  } | null;
  dueAt?: number | null;
  promiseState?: string | null;
  promiseLabel?: string | null;
}

/** 与 core/terms.ts 的上限一致：最多 8 个，每个 ≤ 12 字 */
const TERMS_MAX = 8;
const TERM_LEN = 12;

const tr = (key: string): string => t(key, state.lang);

function section(title: string, children: Array<HTMLElement | string>): HTMLElement {
  return el("section", { class: "mw-drawer-sec" }, [el("h5", { text: title }), ...children]);
}

// ---------- 检索词（S1） ----------

export function termsSection(e: ExtraEntry): HTMLElement {
  const terms: string[] = [...(e.searchTerms ?? [])];
  const initial = JSON.stringify(terms);
  const box = el("div", { class: "mw-row" });
  const msg = el("span", { class: "mw-small", role: "status" });
  const saveBtn = el("button", { type: "button", text: tr("memory.termsSave"), disabled: "disabled" }) as HTMLButtonElement;
  const sync = (): void => {
    saveBtn.disabled = state.readonly || JSON.stringify(terms) === initial;
    msg.textContent = terms.length + " / " + TERMS_MAX;
  };
  const draw = (): void => {
    box.replaceChildren();
    if (terms.length === 0) box.appendChild(el("span", { class: "mw-small", text: tr("memory.termsNone") }));
    terms.forEach((k, i) => {
      box.appendChild(
        el("span", { class: "mw-chip" }, [
          document.createTextNode(k),
          el("button", {
            type: "button",
            text: "×",
            "aria-label": tr("common.del") + " " + k,
            onclick: () => {
              terms.splice(i, 1);
              draw();
            },
          }),
        ]),
      );
    });
    sync();
  };
  const input = el("input", {
    type: "text",
    maxlength: String(TERM_LEN),
    placeholder: tr("memory.termsPlaceholder"),
    "aria-label": tr("memory.terms"),
  }) as HTMLInputElement;
  input.addEventListener("keydown", (ev: KeyboardEvent) => {
    if (ev.key !== "Enter") return;
    ev.preventDefault();
    const v = input.value.trim();
    if (!v) return;
    if (terms.length >= TERMS_MAX) {
      msg.textContent = tr("memory.termsFull");
      return;
    }
    if (!terms.includes(v)) terms.push(v);
    input.value = "";
    draw();
  });
  saveBtn.addEventListener("click", () => {
    void rpc("memory/terms", { id: e.id, searchTerms: terms }).then((out) => {
      if (report(out, tr("memory.termsSaved"))) void refresh();
    });
  });
  draw();
  return section(tr("memory.terms"), [
    el("p", { class: "mw-small", text: tr("memory.termsHint") }),
    box,
    el("div", { class: "mw-row" }, [input, saveBtn, msg]),
  ]);
}

// ---------- 日历锚点（M2） ----------

const KINDS = ["", "annual", "anniversary", "monthly", "weekly", "festival"];

export function anchorText(a: ExtraEntry["calendarAnchor"]): string {
  if (!a) return tr("memory.anchorNone");
  const wd = tr("memory.weekday." + String(a.weekday ?? 0));
  const body =
    a.kind === "annual" ? tr("memory.anchorEveryYear") + " " + a.month + "/" + a.day :
    a.kind === "anniversary" ? tr("memory.anchorEveryYear") + " " + a.month + "/" + a.day + " · " + tr("memory.anchorSince") + " " + a.sinceYear :
    a.kind === "monthly" ? tr("memory.anchorEveryMonth") + " " + a.day :
    a.kind === "weekly" ? tr("memory.anchorEveryWeek") + " " + wd :
    String(a.festival ?? "");
  return (a.label ? a.label + " · " : "") + body;
}

export function anchorSection(e: ExtraEntry): HTMLElement {
  const a = e.calendarAnchor ?? null;
  const kind = el("select", { "aria-label": tr("memory.anchorKind") }) as HTMLSelectElement;
  for (const k of KINDS) {
    const opt = el("option", { value: k, text: tr("memory.anchorKind." + (k || "none")) }) as HTMLOptionElement;
    if ((a?.kind ?? "") === k) opt.selected = true;
    kind.appendChild(opt);
  }
  const numIn = (label: string, v: unknown, min: number, max: number): HTMLInputElement =>
    el("input", { type: "number", min: String(min), max: String(max), step: "1", value: v === undefined ? "" : String(v), "aria-label": label, style: "width:5.5em" }) as HTMLInputElement;
  const month = numIn(tr("memory.anchorMonth"), a?.month, 1, 12);
  const day = numIn(tr("memory.anchorDay"), a?.day, 1, 31);
  const since = numIn(tr("memory.anchorSince"), a?.sinceYear, 1900, 2100);
  since.style.width = "6.5em";
  const weekday = el("select", { "aria-label": tr("memory.anchorWeekday") }) as HTMLSelectElement;
  for (let i = 0; i < 7; i += 1) {
    const opt = el("option", { value: String(i), text: tr("memory.weekday." + i) }) as HTMLOptionElement;
    if (a?.weekday === i) opt.selected = true;
    weekday.appendChild(opt);
  }
  const festival = el("select", { "aria-label": tr("memory.anchorFestival") }) as HTMLSelectElement;
  for (const f of FESTIVAL_NAMES) {
    const opt = el("option", { value: f, text: f }) as HTMLOptionElement;
    if (a?.festival === f) opt.selected = true;
    festival.appendChild(opt);
  }
  const label = el("input", { type: "text", maxlength: "20", value: a?.label ?? "", placeholder: tr("memory.anchorLabelPh"), "aria-label": tr("memory.anchorLabel") }) as HTMLInputElement;
  const field = (text: string, input: HTMLElement): HTMLElement =>
    el("label", { class: "mw-field-row" }, [el("span", { class: "mw-field-label", text }), input]);
  const fMonth = field(tr("memory.anchorMonth"), month);
  const fDay = field(tr("memory.anchorDay"), day);
  const fSince = field(tr("memory.anchorSince"), since);
  const fWeek = field(tr("memory.anchorWeekday"), weekday);
  const fFest = field(tr("memory.anchorFestival"), festival);
  const fLabel = field(tr("memory.anchorLabel"), label);
  const show = (): void => {
    const k = kind.value;
    fMonth.hidden = !(k === "annual" || k === "anniversary");
    fDay.hidden = !(k === "annual" || k === "anniversary" || k === "monthly");
    fSince.hidden = k !== "anniversary";
    fWeek.hidden = k !== "weekly";
    fFest.hidden = k !== "festival";
    fLabel.hidden = k === "";
  };
  kind.addEventListener("change", show);
  show();
  const n = (i: HTMLInputElement): number | undefined => (i.value.trim() === "" ? undefined : Number(i.value));
  const saveBtn = el("button", {
    type: "button",
    text: tr("memory.anchorSave"),
    disabled: state.readonly ? "disabled" : undefined,
    onclick: () => {
      const k = kind.value;
      const anchor = k === ""
        ? null
        : {
            kind: k,
            label: label.value.trim() || undefined,
            month: k === "annual" || k === "anniversary" ? n(month) : undefined,
            day: k === "annual" || k === "anniversary" || k === "monthly" ? n(day) : undefined,
            sinceYear: k === "anniversary" ? n(since) : undefined,
            weekday: k === "weekly" ? Number(weekday.value) : undefined,
            festival: k === "festival" ? festival.value : undefined,
          };
      void rpc("memory/anchor", { id: e.id, anchor }).then((out) => {
        if (report(out, tr(anchor ? "memory.anchorSaved" : "memory.anchorRemoved"))) void refresh();
      });
    },
  });
  return section(tr("memory.anchor"), [
    el("p", { class: "mw-small", text: tr("memory.anchorCurrent") + "：" + anchorText(a) }),
    el("div", { class: "mw-row" }, [field(tr("memory.anchorKind"), kind), fMonth, fDay, fSince, fWeek, fFest, fLabel]),
    el("div", { class: "mw-row" }, [saveBtn, el("span", { class: "mw-small", text: tr("memory.anchorHint") })]),
  ]);
}

// ---------- 约定（M1） ----------

const pad = (x: number): string => String(x).padStart(2, "0");
const ymd = (ts: number): string => {
  const d = new Date(ts);
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
};

export function promiseSection(e: ExtraEntry): HTMLElement {
  const st = e.promiseState && e.promiseState !== "none" ? e.promiseState : "";
  const due = typeof e.dueAt === "number" ? e.dueAt : null;
  const settle = (outcome: "kept" | "broken"): void => {
    void rpc("memory/promise", { id: e.id, outcome }).then((out) => {
      if (report(out, tr("memory.promise." + outcome))) void refresh();
    });
  };
  const dateIn = el("input", {
    type: "date",
    value: due ? ymd(due) : "",
    min: ymd(Date.now()),
    "aria-label": tr("memory.promiseDue"),
  }) as HTMLInputElement;
  const setDue = el("button", {
    type: "button",
    text: tr(st === "pending" ? "memory.promiseExtend" : "memory.promiseSet"),
    disabled: state.readonly ? "disabled" : undefined,
    onclick: () => {
      if (!dateIn.value) {
        report({ ok: false, code: "E_VALID", message: tr("memory.promisePickDate") });
        return;
      }
      void rpc("memory/promise", { id: e.id, outcome: "extend", dueAt: dateIn.value }).then((out) => {
        if (report(out, tr("memory.promiseDueSaved"))) void refresh();
      });
    },
  });
  const overdue = st === "pending" && due !== null && due < Date.now();
  const head = st
    ? el("div", { class: "mw-row" }, [
        badge(tr("memory.promiseState." + st), st === "kept" ? "ok" : st === "broken" ? "bad" : overdue ? "warn" : "plain"),
        el("span", { class: "mw-small", text: tr("memory.promiseDue") + "：" + (due ? fmtTime(due) : "-") + (overdue ? " · " + tr("memory.promiseOverdue") : "") }),
        e.promiseLabel ? el("span", { class: "mw-small", text: "「" + e.promiseLabel + "」" }) : el("span"),
      ])
    : el("p", { class: "mw-small", text: tr("memory.promiseNone") });
  const actions: HTMLElement[] = [];
  if (st === "pending") {
    actions.push(
      el("button", { type: "button", text: tr("memory.promiseKept"), disabled: state.readonly ? "disabled" : undefined, onclick: () => settle("kept") }),
      el("button", { type: "button", text: tr("memory.promiseBroken"), disabled: state.readonly ? "disabled" : undefined, onclick: () => settle("broken") }),
    );
  }
  return section(tr("memory.promise"), [
    head,
    el("div", { class: "mw-row" }, [...actions, dateIn, setDue]),
    el("p", { class: "mw-small", text: tr("memory.promiseHint") }),
  ]);
}
