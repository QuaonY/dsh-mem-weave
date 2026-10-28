/// <reference lib="dom" />
/**
 * 忆织 MemWeave —— 人格页（§13.2.2）：
 * 基本 / 形象（含形象卡表格）/ 语气 / 契约组 / 思考 / 版本（diff + 回滚）/ 预设卡（多格式导入）
 * 右栏实时预览（U4：预览与注入同源，hash 钉住）。
 */

import { t } from "../i18n";
import {
  badge,
  dangerConfirm,
  downloadJson,
  el,
  flash,
  fmtTime,
  num,
  refresh,
  report,
  rpc,
  state,
  unsavedNotice,
  watchEdits,
} from "./ui";
import { actorLabel } from "./account";
import { looksLikeMarkdown, parseMarkdownPreset } from "./preset-md";

type Sub = "basic" | "appearance" | "tone" | "contracts" | "thinking" | "versions" | "presets";

let sub: Sub = "basic";
let diffVersion = 0;

/**
 * 跨分页的未保存草稿：切分页 / 换预览档位前把当前分页的表单收进来，
 * 最后由底部「保存与生效」栏一次性提交。键与 persona/update 的 patch 一致（顶层字段整体替换）。
 */
let draft: Record<string, unknown> = {};
/** 当前分页的收集器；切走前调用 */
let activeCollect: (() => Record<string, unknown> | null) | null = null;

/**
 * 各分页“刚打开、还没动过”时收集到的值。
 * 分页会把没设置的字段补成默认对象（如 tone: {enabled:false,text:"",byModel:{}}），
 * 直接拿去和库里的 undefined 比会误报“有修改”，所以以它为基准比较。
 * 已保存的配置一变（保存、回滚、AI 修改）就整体作废。
 */
let pristine: Record<string, unknown> = {};
let pristineFor = "";

function syncPristine(): void {
  const key = JSON.stringify(baseCfg());
  if (key !== pristineFor) {
    pristine = {};
    pristineFor = key;
  }
}

/** 分页刚渲染完时记下它的初始值；草稿里已有的字段不覆盖（那是用户改过的） */
function rememberPristine(collect: () => Record<string, unknown> | null): void {
  syncPristine();
  let snap: Record<string, unknown> | null = null;
  try {
    snap = collect();
  } catch {
    snap = null;
  }
  if (!snap) return;
  for (const [k, v] of Object.entries(snap)) {
    if (!(k in pristine) && !(k in draft)) pristine[k] = v;
  }
}

function sameValue(a: unknown, b: unknown): boolean {
  const norm = (v: unknown): string => (v === undefined || v === null ? "null" : JSON.stringify(v));
  return norm(a) === norm(b);
}

/** 这个字段和“没改过”的值相同吗：等于库里的值，或等于分页打开时的初始值 */
function unchanged(k: string, v: unknown): boolean {
  syncPristine();
  const base = baseCfg();
  return sameValue(v, base[k]) || (k in pristine && sameValue(v, pristine[k]));
}

function isDirty(): boolean {
  return Object.keys(draft).some((k) => !unchanged(k, draft[k]));
}

/** 把当前分页的输入并入草稿；校验失败返回 false（保持原分页，不丢输入） */
function stashActive(): boolean {
  if (!activeCollect) return true;
  const patch = activeCollect();
  if (patch === null) return false;
  Object.assign(draft, patch);
  return true;
}

/**
 * 页面重绘前调用（切顶层导航、后台刷新）：把人格页当前分页的输入并入草稿，避免重绘把它冲掉。
 * 校验失败时也不阻止离开，只是这一页的这次输入不并入。
 */
export function stashPersonaDraft(): void {
  try {
    stashActive();
  } catch {
    // 收集失败不影响导航
  }
  activeCollect = null;
}

/** 与 core/render.ts splitNames 同口径：顿号 / 逗号 / 斜杠 / 竖线 / 换行分隔，去重 */
export function splitNameList(v: string): string[] {
  const out: string[] = [];
  for (const part of v.split(/[、，,／/|｜;；\n]+/)) {
    const name = part.trim();
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/** 测试用：草稿里真正改过的字段 */
export function personaDirtyKeys(): string[] {
  return Object.keys(draft).filter((k) => !unchanged(k, draft[k]));
}

/** 测试用：清空草稿状态 */
export function resetPersonaDraft(): void {
  draft = {};
  pristine = {};
  pristineFor = "";
  activeCollect = null;
  sub = "basic";
}

interface CardLike {
  id: string;
  who: string;
  title: string;
  brief: string;
  detail: string;
  media: string[];
  auto: boolean;
  expand: string;
  on: boolean;
}

interface ContractLike {
  id: string;
  text: string;
  on: boolean;
}

interface ViewPart {
  node: HTMLElement;
  /** 返回 null = 校验失败，整体不保存 */
  collect: () => Record<string, unknown> | null;
}

/** 库里已保存的人格配置 */
function baseCfg(): Record<string, unknown> {
  return ((state.data.persona as Record<string, unknown>)?.config as Record<string, unknown>) ?? {};
}

/** 编辑视图看到的配置 = 已保存配置 + 未保存草稿 */
function cfg(): Record<string, unknown> {
  return { ...baseCfg(), ...draft };
}

export async function loadPersona(): Promise<void> {
  state.data.persona = await rpc("persona/get", {});
  state.data.preview = await rpc("persona/preview", { modelHint: (state.data.modelHint as string) || undefined });
  state.data.history = ((await rpc("persona/history", { limit: 50 })) as { versions?: unknown })?.versions ?? [];
  state.data.presets = ((await rpc("preset/list", {})) as { presets?: unknown })?.presets ?? [];
}

// ---------- 子页：基本 ----------

function subBasic(): ViewPart {
  const c = cfg();
  const fields: Record<string, HTMLInputElement | HTMLTextAreaElement> = {};
  const mkArea = (key: string, val: unknown, rows: number, label: string): HTMLTextAreaElement => {
    const area = el("textarea", { rows: String(rows), "aria-label": label }) as HTMLTextAreaElement;
    area.value = String(val ?? "");
    fields[key] = area;
    return area;
  };
  /** 多个称呼：每个一枚标签，回车或逗号添加；存储为「、」连接的一条字符串 */
  const mkNames = (key: string, val: unknown, label: string): HTMLElement => {
    const hidden = el("input", { type: "hidden", value: String(val ?? "") }) as HTMLInputElement;
    fields[key] = hidden;
    const names = splitNameList(String(val ?? ""));
    const chips = el("div", { class: "mw-names-chips" });
    const entry = el("input", {
      type: "text",
      class: "mw-names-entry",
      placeholder: names.length > 0 ? "再加一个…" : "输入后按回车",
      "aria-label": label,
    }) as HTMLInputElement;
    const commit = (): void => {
      hidden.value = names.join("、");
      entry.placeholder = names.length > 0 ? "再加一个…" : "输入后按回车";
      // 冒泡给 watchEdits，让“有未保存的修改”生效
      hidden.dispatchEvent(new Event("input", { bubbles: true }));
    };
    const draw = (): void => {
      chips.replaceChildren(
        ...names.map((name, i) =>
          el("span", { class: "mw-name-chip" }, [
            el("span", { text: name }),
            el("button", {
              type: "button",
              text: "×",
              "aria-label": "删除称呼 " + name,
              onclick: () => {
                names.splice(i, 1);
                draw();
                commit();
              },
            }),
          ]),
        ),
        entry,
      );
    };
    const add = (): void => {
      let added = false;
      for (const name of splitNameList(entry.value)) {
        if (!names.includes(name)) {
          names.push(name);
          added = true;
        }
      }
      entry.value = "";
      if (added) {
        draw();
        commit();
        entry.focus();
      }
    };
    entry.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === "," || e.key === "，" || e.key === "、") {
        e.preventDefault();
        add();
      } else if (e.key === "Backspace" && entry.value === "" && names.length > 0) {
        names.pop();
        draw();
        commit();
        entry.focus();
      }
    });
    entry.addEventListener("blur", add);
    // 输入框本身的键入不算修改，只有真的增删称呼才算
    entry.setAttribute("data-nodirty", "1");
    draw();
    return el("div", { class: "mw-names", onclick: (e: Event) => { if (e.target === e.currentTarget) entry.focus(); } }, [chips, hidden]);
  };
  const charCount = el("span", { class: "mw-small" });
  const character = mkArea("character", c.character, 6, t("field.character", state.lang));
  const updateCount = (): void => {
    charCount.textContent = String(character.value.length) + " / 6000";
  };
  character.addEventListener("input", updateCount);
  updateCount();

  const node = el("div", { class: "mw-col" }, [
    el("div", { class: "mw-field-row" }, [el("span", { class: "mw-field-label", text: t("field.nameFlash", state.lang) }), mkNames("selfNameFlash", c.selfNameFlash, t("field.nameFlash", state.lang))]),
    el("div", { class: "mw-field-row" }, [el("span", { class: "mw-field-label", text: t("field.namePro", state.lang) }), mkNames("selfNamePro", c.selfNamePro, t("field.namePro", state.lang))]),
    el("div", { class: "mw-field-row" }, [el("span", { class: "mw-field-label", text: t("field.userName", state.lang) }), mkNames("userName", c.userName, t("field.userName", state.lang))]),
    el("p", { class: "mw-small", style: "margin:0", text: "每项都可以填多个，AI 会随语境轮换着用。" }),
    el("label", { class: "mw-col" }, [el("span", { text: t("field.stance", state.lang) }), mkArea("stance", c.stance, 3, t("field.stance", state.lang))]),
    el("label", { class: "mw-col" }, [el("span", { text: t("field.character", state.lang) }), character, charCount]),
    el("label", { class: "mw-col" }, [
      el("span", { text: t("field.suffix", state.lang) }),
      mkArea("suffix", c.suffix, 2, t("field.suffix", state.lang)),
      el("span", { class: "mw-small", text: "未识别的 {{变量}} 会原样保留" }),
    ]),
  ]);
  return {
    node,
    collect: () => {
      const patch: Record<string, unknown> = {};
      for (const [k, input] of Object.entries(fields)) patch[k] = input.value;
      if (String(patch.character ?? "").length > 6000) {
        flash("character 超 6000 字", "bad");
        return null;
      }
      return patch;
    },
  };
}

// ---------- 子页：形象（含形象卡表格 §7.2） ----------

function subAppearance(): ViewPart {
  const app = (cfg().appearance as Record<string, unknown>) ?? {};
  const cards: CardLike[] = ((app.cards as CardLike[]) ?? []).map((c) => ({ ...c, media: [...(c.media ?? [])] }));
  const enabled = el("input", { type: "checkbox", checked: app.enabled ? "checked" : undefined }) as HTMLInputElement;
  const textArea = el("textarea", { rows: "3", "aria-label": t("field.text", state.lang) }) as HTMLTextAreaElement;
  textArea.value = String(app.text ?? "");
  const table = el("div", { class: "mw-col" });

  const drawTable = (): void => {
    table.innerHTML = "";
    if (cards.length === 0) table.appendChild(el("p", { class: "mw-empty", text: t("common.empty", state.lang) }));
    cards.forEach((card, i) => {
      const who = el("select", { "aria-label": t("field.who", state.lang) }) as HTMLSelectElement;
      for (const w of ["self", "user", "other"]) {
        const opt = el("option", { value: w, text: t("option.who." + w, state.lang) }) as HTMLOptionElement;
        if (card.who === w) opt.selected = true;
        who.appendChild(opt);
      }
      who.addEventListener("change", () => {
        card.who = who.value;
      });
      const mk = (key: keyof CardLike, val: string): HTMLInputElement => {
        const input = el("input", { type: "text", value: val, "aria-label": t("field." + String(key), state.lang) }) as HTMLInputElement;
        input.addEventListener("input", () => {
          (card[key] as unknown as string) = input.value;
        });
        return input;
      };
      const mediaArea = el("textarea", { rows: "2", "aria-label": t("field.media", state.lang) }) as HTMLTextAreaElement;
      mediaArea.value = card.media.join("\n");
      mediaArea.addEventListener("input", () => {
        card.media = mediaArea.value.split("\n").map((s) => s.trim()).filter((s) => s.length > 0);
      });
      const autoBox = el("input", { type: "checkbox", checked: card.auto ? "checked" : undefined }) as HTMLInputElement;
      autoBox.addEventListener("change", () => {
        card.auto = autoBox.checked;
      });
      const onBox = el("input", { type: "checkbox", checked: card.on ? "checked" : undefined }) as HTMLInputElement;
      onBox.addEventListener("change", () => {
        card.on = onBox.checked;
      });
      const expand = el("select", { "aria-label": t("field.expand", state.lang) }) as HTMLSelectElement;
      for (const w of ["brief", "full"]) {
        const opt = el("option", { value: w, text: t("option.expand." + w, state.lang) }) as HTMLOptionElement;
        if (card.expand === w) opt.selected = true;
        expand.appendChild(opt);
      }
      expand.addEventListener("change", () => {
        card.expand = expand.value;
      });
      table.appendChild(
        el("section", { class: "mw-item-card" }, [
          el("div", { class: "mw-item-head" }, [
            badge("形象卡 " + String(i + 1), "plain"),
            el("span", { class: "mw-small", text: t("field.id", state.lang) + "：" + card.id }),
            el("span", { class: "mw-content" }),
            el("span", { class: "mw-field-label", text: t("field.who", state.lang) }),
            who,
            el("button", {
              type: "button",
              text: t("common.del", state.lang),
              onclick: () => {
                cards.splice(i, 1);
                drawTable();
              },
            }),
          ]),
          el("div", { class: "mw-option-grid" }, [
            el("label", { class: "mw-field-row" }, [el("span", { class: "mw-field-label", text: t("field.title", state.lang) }), mk("title", card.title)]),
            el("label", { class: "mw-check-row" }, [autoBox, el("span", { text: t("field.auto", state.lang) })]),
            el("label", { class: "mw-field-row" }, [el("span", { class: "mw-field-label", text: t("field.expand", state.lang) }), expand]),
            el("label", { class: "mw-check-row" }, [onBox, el("span", { text: t("field.enabled", state.lang) })]),
          ]),
          el("label", { class: "mw-col" }, [el("span", { text: t("field.brief", state.lang) }), mk("brief", card.brief)]),
          el("label", { class: "mw-col" }, [el("span", { text: t("field.detail", state.lang) }), mk("detail", card.detail)]),
          el("label", { class: "mw-col" }, [el("span", { text: t("field.media", state.lang) }), mediaArea]),
        ]),
      );
    });
    table.appendChild(
      el("button", {
        type: "button",
        text: t("persona.addCard", state.lang),
        onclick: () => {
          cards.push({
            id: "card-" + Date.now().toString(36),
            who: "self",
            title: "",
            brief: "",
            detail: "",
            media: [],
            auto: false,
            expand: "brief",
            on: true,
          });
          drawTable();
        },
      }),
    );
  };
  drawTable();

  const node = el("div", { class: "mw-col" }, [
    el("label", { class: "mw-check-row" }, [
      enabled,
      el("span", { text: t("field.enabled", state.lang) + "形象设定" }),
    ]),
    el("label", { class: "mw-col" }, [el("span", { text: t("field.text", state.lang) }), textArea]),
    table,
  ]);
  return {
    node,
    collect: () => {
      for (const card of cards) {
        if (!card.title.trim() && !card.brief.trim() && !card.detail.trim()) {
          flash("形象卡的标题、简述和详细内容不能全部为空", "bad");
          return null;
        }
        if (card.media.length > 3) flash("形象卡「" + card.id + "」的关联素材超过 3 项", "warn");
      }
      return {
        appearance: {
          enabled: enabled.checked,
          text: textArea.value,
          byModel: (app.byModel as Record<string, string>) ?? {},
          cards,
          index: app.index !== false,
        },
      };
    },
  };
}

// ---------- 子页：语气 ----------

function subTone(): ViewPart {
  const tone = (cfg().tone as Record<string, unknown>) ?? {};
  const enabled = el("input", { type: "checkbox", checked: tone.enabled ? "checked" : undefined }) as HTMLInputElement;
  const textArea = el("textarea", { rows: "4", "aria-label": t("field.text", state.lang) }) as HTMLTextAreaElement;
  textArea.value = String(tone.text ?? "");
  const node = el("div", { class: "mw-col" }, [
    el("label", { class: "mw-check-row" }, [enabled, el("span", { text: t("field.enabled", state.lang) + "语气设定" })]),
    el("label", { class: "mw-col" }, [el("span", { text: t("field.text", state.lang) }), textArea]),
  ]);
  return {
    node,
    collect: () => ({
      tone: {
        enabled: enabled.checked,
        text: textArea.value,
        byModel: (tone.byModel as Record<string, string>) ?? {},
      },
    }),
  };
}

// ---------- 子页：契约组（§7.4：≤300 字 / ≤40 条 / 可排序） ----------

function subContracts(): ViewPart {
  const contracts: ContractLike[] = ((cfg().contracts as ContractLike[]) ?? []).map((c) => ({ ...c }));
  const list = el("div", { class: "mw-col" });

  const drawList = (): void => {
    list.innerHTML = "";
    if (contracts.length === 0) list.appendChild(el("p", { class: "mw-empty", text: t("common.empty", state.lang) }));
    contracts.forEach((item, i) => {
      const area = el("textarea", { rows: "2", "aria-label": t("field.contract", state.lang) }) as HTMLTextAreaElement;
      area.value = item.text;
      area.addEventListener("input", () => {
        item.text = area.value;
      });
      const onBox = el("input", { type: "checkbox", checked: item.on ? "checked" : undefined }) as HTMLInputElement;
      onBox.addEventListener("change", () => {
        item.on = onBox.checked;
      });
      const move = (delta: number): void => {
        const j = i + delta;
        if (j < 0 || j >= contracts.length) return;
        const tmp = contracts[i];
        contracts[i] = contracts[j];
        contracts[j] = tmp;
        drawList();
      };
      list.appendChild(
        el("section", { class: "mw-item-card" }, [
          el("div", { class: "mw-item-head" }, [
            badge(t("field.contract", state.lang) + " " + String(i + 1), "plain"),
            ...(String(item.id).startsWith("cp-")
              ? [el("span", { class: "mw-small", text: t("persona.contractFromPromotion", state.lang) })]
              : []),
            el("label", { class: "mw-check-row" }, [onBox, el("span", { text: t("field.enabled", state.lang) })]),
            el("span", { class: "mw-small", text: String(item.text.length) + " / 300 字" }),
            el("span", { class: "mw-content" }),
            el("button", { type: "button", text: "↑", "aria-label": "上移契约", onclick: () => move(-1) }),
            el("button", { type: "button", text: "↓", "aria-label": "下移契约", onclick: () => move(1) }),
            el("button", {
              type: "button",
              text: "×",
              "aria-label": t("common.del", state.lang),
              onclick: () => {
                contracts.splice(i, 1);
                drawList();
              },
            }),
          ]),
          el("label", { class: "mw-col" }, [el("span", { text: t("field.contract", state.lang) }), area]),
        ]),
      );
    });
    list.appendChild(
      el("button", {
        type: "button",
        text: t("persona.addContract", state.lang),
        onclick: () => {
          if (contracts.length >= 40) {
            flash("契约总数已达 40 条上限", "bad");
            return;
          }
          contracts.push({ id: "c-" + Date.now().toString(36), text: "", on: true });
          drawList();
        },
      }),
    );
  };
  drawList();

  return {
    node: list,
    collect: () => {
      for (const item of contracts) {
        if (item.text.length > 300) {
          flash("契约 " + item.id + " 超 300 字", "bad");
          return null;
        }
      }
      if (contracts.length > 40) {
        flash("契约总数超 40 条", "bad");
        return null;
      }
      return { contracts };
    },
  };
}

// ---------- 子页：思考（语言） ----------

function subThinking(): ViewPart {
  const langs = ["off", "zh-CN", "zh-TW", "en", "ja", "ko", "ru", "custom"];
  const cur = String(cfg().thinkingLanguage ?? "off");
  const select = el("select", { "aria-label": t("field.language", state.lang) }) as HTMLSelectElement;
  for (const l of langs) {
    const opt = el("option", { value: l, text: t("option.language." + l, state.lang) }) as HTMLOptionElement;
    if (cur === l || (l === "custom" && !langs.includes(cur))) opt.selected = true;
    select.appendChild(opt);
  }
  const custom = el("input", { type: "text", value: langs.includes(cur) ? "" : cur, "aria-label": "custom" }) as HTMLInputElement;
  const node = el("div", { class: "mw-col" }, [
    el("label", { class: "mw-field-row" }, [el("span", { class: "mw-field-label", text: t("field.language", state.lang) }), select]),
    el("label", { class: "mw-field-row" }, [el("span", { class: "mw-field-label", text: t("field.custom", state.lang) }), custom]),
  ]);
  return {
    node,
    collect: () => ({ thinkingLanguage: select.value === "custom" ? custom.value : select.value }),
  };
}

// ---------- 子页：版本（列表 + diff + 回滚） ----------

function diffConfigs(a: Record<string, unknown>, b: Record<string, unknown>): string {
  const keys = Array.from(new Set([...Object.keys(a), ...Object.keys(b)])).sort();
  const lines: string[] = [];
  for (const k of keys) {
    const sa = JSON.stringify(a[k] ?? null) ?? "null";
    const sb = JSON.stringify(b[k] ?? null) ?? "null";
    if (sa === sb) continue;
    lines.push(k + ":\n  旧 " + sa.slice(0, 200) + "\n  新 " + sb.slice(0, 200));
  }
  return lines.length > 0 ? lines.join("\n") : "（无差异）";
}

function subVersions(): ViewPart {
  const versions = (state.data.history as Array<Record<string, unknown>>) ?? [];
  const diffBox = el("pre", { class: "mw-pre", text: "" });
  const drawDiff = (): void => {
    const v = versions.find((x) => num(x.version) === diffVersion);
    diffBox.textContent = v
      ? "v" + String(diffVersion) + " → 当前 v" + String((state.status ?? {}).personaVersion ?? "?") + "\n" + diffConfigs((v.config as Record<string, unknown>) ?? {}, cfg())
      : "";
  };
  const node = el("div", { class: "mw-col" });
  if (versions.length === 0) node.appendChild(el("p", { class: "mw-empty", text: t("common.empty", state.lang) }));
  for (const v of versions) {
    const ver = num(v.version);
    node.appendChild(
      el("div", { class: "mw-row mw-item" }, [
        badge("v" + String(ver), ver === num((state.status ?? {}).personaVersion) ? "ok" : "warn"),
        el("span", { class: "mw-small", text: fmtTime(v.createdAt) + " · " + actorLabel(v.createdBy, state.lang) }),
        el("button", {
          type: "button",
          text: t("persona.diff", state.lang),
          onclick: () => {
            diffVersion = ver;
            drawDiff();
          },
        }),
        el("button", {
          type: "button",
          text: t("persona.rollback", state.lang),
          disabled: state.readonly ? "disabled" : undefined,
          onclick: () => {
            if (!dangerConfirm("ROLLBACK", t("persona.rollback", state.lang) + " v" + String(ver))) return;
            void rpc("persona/history.restore", {
              version: ver,
              expectedVersion: num((state.status ?? {}).personaVersion, 0),
            }).then((out) => {
              if (!report(out)) return;
              const result = out as { reloadOk?: boolean; reloadMessage?: string };
              if (result.reloadOk === false) {
                flash("人格版本已保存，但 prompt 重载失败：" + String(result.reloadMessage ?? "请手动重载或重启"), "warn");
              } else {
                flash("v" + String(ver) + " " + t("persona.effectNow", state.lang), "ok");
              }
              draft = {};
              activeCollect = null;
              void refresh();
            });
          },
        }),
      ]),
    );
  }
  node.appendChild(diffBox);
  drawDiff();
  return { node, collect: () => ({}) };
}

// ---------- 子页：预设卡（自家 / 酒馆 v2·v3；D8：不导入 whale-persona） ----------

interface ConvertOk {
  payload: Record<string, unknown>;
  unclaimed: string[];
  spec: string;
}

const TAVERN_FIELDS = [
  "first_mes",
  "mes_example",
  "character_book",
  "alternate_greetings",
  "tags",
  "creator",
  "creator_notes",
  "talkativeness",
  "avatar",
  "nickname",
  "group_only_greetings",
  "extensions",
];

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function convertPreset(raw: Record<string, unknown>): ConvertOk | { error: string } {
  const spec = String(raw.spec ?? "");
  if (spec.indexOf("whale-persona") >= 0) {
    return { error: "D8：不导入 whale-persona 格式（无兼容层）" };
  }
  if (spec === "memweave-preset/1" || (raw.payload && typeof raw.payload === "object")) {
    const unclaimed = Object.keys(raw).filter((k) => !["spec", "id", "label", "description", "payload"].includes(k));
    return { payload: obj(raw.payload), unclaimed, spec: spec || "memweave-preset/1(implicit)" };
  }
  const d = (spec === "chara_card_v2" || spec === "chara_card_v3") && raw.data ? obj(raw.data) : raw;
  if (typeof d.description === "string") {
    const name = typeof d.name === "string" ? d.name : "";
    const lines = String(d.system_prompt ?? "").split("\n");
    const contracts: ContractLike[] = [];
    const unclaimed: string[] = [];
    lines.forEach((line, i) => {
      const text = line.trim();
      if (!text) return;
      if (text.length > 300) unclaimed.push("system_prompt 第 " + String(i + 1) + " 行超 300 字已截断");
      contracts.push({ id: "c" + String(i + 1), text: text.slice(0, 300), on: true });
    });
    for (const k of TAVERN_FIELDS) {
      if (d[k] !== undefined && d[k] !== null && String(d[k]).length > 0) unclaimed.push(k);
    }
    return {
      spec: spec || "chara_card_v2(implicit)",
      unclaimed,
      payload: {
        enabled: true,
        selfNameFlash: name,
        selfNamePro: name,
        character: String(d.description ?? ""),
        stance: String(d.personality ?? ""),
        suffix: String(d.post_history_instructions ?? ""),
        contracts,
      },
    };
  }
  return { error: "无法识别的预设卡格式（支持忆织 JSON、酒馆 v2/v3、Markdown）" };
}

/** 把任意文字压成合法的预设标识 [A-Za-z0-9_-]{1,64}；非 ASCII（如中文名）用短哈希代替 */
function slugId(text: string): string {
  const ascii = text
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
  if (ascii.length >= 2) return ascii.slice(0, 64);
  let h = 0;
  for (let i = 0; i < text.length; i += 1) h = (Math.imul(h, 31) + text.charCodeAt(i)) >>> 0;
  return "card-" + h.toString(36);
}

/**
 * 从导入的预设卡里识别标识与名称：
 * 自家格式取 id / label；酒馆 v2·v3 取 data.name（或顶层 name）。识别不到返回 null。
 */
export function inferPresetIdentity(raw: Record<string, unknown>): { id: string; label: string } | null {
  const data = raw.data && typeof raw.data === "object" ? (raw.data as Record<string, unknown>) : {};
  const payload = raw.payload && typeof raw.payload === "object" ? (raw.payload as Record<string, unknown>) : {};
  const ownId = typeof raw.id === "string" ? raw.id.trim() : "";
  const label = [raw.label, data.name, raw.name, payload.selfNamePro, payload.selfNameFlash]
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .find((v) => v.length > 0) ?? "";
  if (ownId && /^[A-Za-z0-9_-]{1,64}$/.test(ownId)) return { id: ownId, label: label || ownId };
  const source = ownId || label;
  if (!source) return null;
  return { id: slugId(source), label: label || source };
}

function subPresets(): ViewPart {
  const presets = (state.data.presets as Array<Record<string, unknown>>) ?? [];
  const node = el("div", { class: "mw-col" });

  for (const p of presets) {
    const id = String(p.id ?? "");
    const builtin = p.builtin === true;
    node.appendChild(
      el("div", { class: "mw-row mw-item" }, [
        builtin ? badge(t("persona.presetBuiltin", state.lang), "ok") : badge(id, "plain"),
        el("span", {
          class: "mw-small",
          title: String(p.description ?? ""),
          text: builtin
            ? String(p.label ?? id) + (p.description ? " · " + String(p.description) : "")
            : String(p.label ?? "") + " · " + String(p.spec ?? "") + " · " + fmtTime(p.importedAt),
        }),
        el("button", {
          type: "button",
          text: t("data.export", state.lang),
          onclick: () => {
            void rpc("preset/export", { id }).then((out) => {
              if (report(out)) downloadJson("memweave-preset-" + id + ".json", (out as { preset?: unknown }).preset ?? out);
            });
          },
        }),
        el("button", {
          type: "button",
          text: t("persona.presetApply", state.lang),
          disabled: state.readonly ? "disabled" : undefined,
          onclick: () => {
            void rpc("preset/apply", { id }).then((out) => {
              if (!report(out, id + " " + t("persona.effectNext", state.lang))) return;
              draft = {};
              activeCollect = null;
              void refresh();
            });
          },
        }),
        // 内置卡不给删除按钮；用户自己导入的卡和 autosave 可以删
        ...(builtin
          ? []
          : [
              el("button", {
                type: "button",
                text: t("persona.presetDelete", state.lang),
                disabled: state.readonly ? "disabled" : undefined,
                onclick: () => {
                  const name = String(p.label ?? "") || id;
                  if (!window.confirm(t("persona.presetDeleteConfirm", state.lang).replace("{name}", name))) return;
                  void rpc("preset/delete", { id }).then((out) => {
                    if (report(out, t("persona.presetDelete", state.lang) + " " + name)) void refresh();
                  });
                },
              }),
            ]),
      ]),
    );
  }

  // 导入区：文件选择 / 粘贴 JSON / 预检报告
  const reportBox = el("pre", { class: "mw-pre", text: "" });
  const idInput = el("input", { type: "text", value: "", placeholder: "导入卡片后自动识别", "aria-label": t("field.id", state.lang) }) as HTMLInputElement;
  const labelInput = el("input", { type: "text", value: "", placeholder: "导入卡片后自动识别", "aria-label": t("field.title", state.lang) }) as HTMLInputElement;
  const idHint = el("span", { class: "mw-small", text: "" });
  /** 用户手动改过标识后，不再被自动识别覆盖 */
  let idTouched = false;
  idInput.addEventListener("input", () => {
    idTouched = true;
    idHint.textContent = "";
  });
  const jsonArea = el("textarea", {
    rows: "8",
    "aria-label": "预设卡内容",
    placeholder: "粘贴 JSON 预设卡，或 Markdown 人设，例如：\n# 夜猫子\n## 用户称呼\n老大\n## 人格描述\n安静、靠谱，晚上话多一点\n## 契约\n- 不编造事实\n- 改代码前先读代码",
  }) as HTMLTextAreaElement;
  let parsed: Record<string, unknown> | null = null;

  const precheck = (): void => {
    const raw = jsonArea.value;
    let format = "JSON";
    if (looksLikeMarkdown(raw)) {
      const md = parseMarkdownPreset(raw);
      if ("error" in md) {
        reportBox.textContent = md.error;
        parsed = null;
        return;
      }
      parsed = md as unknown as Record<string, unknown>;
      format = "Markdown";
    } else {
      try {
        parsed = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        reportBox.textContent = "JSON 解析失败（如果是 Markdown 人设，开头不要用 { 或 [）";
        parsed = null;
        return;
      }
    }
    const conv = convertPreset(parsed);
    if ("error" in conv) {
      reportBox.textContent = conv.error;
      parsed = null;
      return;
    }
    const identity = inferPresetIdentity(parsed);
    if (identity) {
      if (!idTouched) {
        idInput.value = identity.id;
        idHint.textContent = t("persona.presetIdAuto", state.lang);
      }
      if (!labelInput.value.trim()) labelInput.value = identity.label;
    } else if (!idInput.value.trim()) {
      idInput.value = "preset-" + Date.now().toString(36);
    }
    reportBox.textContent =
      "格式: " + (format === "Markdown" ? "Markdown 人设" : conv.spec) + "\n" + t("persona.unclaimed", state.lang) + ": " + (conv.unclaimed.length > 0 ? conv.unclaimed.join(", ") : "无") +
      "\n映射: " + Object.keys(conv.payload).join(", ");
  };
  jsonArea.addEventListener("change", precheck);

  const fileInput = el("input", {
    type: "file",
    accept: ".json,.md,.markdown,.txt,application/json,text/markdown,text/plain",
    "aria-label": "选择预设卡文件（JSON 或 Markdown）",
    onchange: (e: Event) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        jsonArea.value = String(reader.result ?? "");
        precheck();
      };
      reader.readAsText(file);
    },
  });

  node.appendChild(
    el("div", { class: "mw-col" }, [
      el("h4", { text: t("persona.importCard", state.lang) }),
      el("p", { class: "mw-small", style: "margin:0", text: "支持 JSON（忆织 / 酒馆卡）和 Markdown。Markdown 用 ## 标题分节，如「人格描述」「契约」。" }),
      fileInput,
      jsonArea,
      el("button", { type: "button", text: t("data.scan", state.lang), onclick: precheck }),
      el("label", { class: "mw-field-row" }, [el("span", { class: "mw-field-label", text: t("field.id", state.lang) }), idInput]),
      idHint,
      el("label", { class: "mw-field-row" }, [el("span", { class: "mw-field-label", text: t("field.title", state.lang) }), labelInput]),
      reportBox,
      el("button", {
        type: "button",
        text: t("data.import", state.lang),
        disabled: state.readonly ? "disabled" : undefined,
        onclick: () => {
          if (!parsed) {
            precheck();
            if (!parsed) return;
          }
          const id = idInput.value.trim();
          if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
            flash("id 需匹配 [A-Za-z0-9_-]{1,64}", "bad");
            return;
          }
          const conv = convertPreset(parsed as Record<string, unknown>);
          if ("error" in conv) {
            flash(conv.error, "bad");
            return;
          }
          void rpc("preset/import", { id, payload: conv.payload, label: labelInput.value.trim() || undefined }).then((out) => {
            if (report(out, "已导入预设 " + id)) void refresh();
          });
        },
      }),
    ]),
  );
  return { node, collect: () => ({}) };
}

// ---------- 右栏：实时预览（U4） ----------

function previewPanel(): HTMLElement {
  const preview = state.data.preview as
    | { s1?: { prefix?: string; thinking?: string; suffix?: string }; segments?: Array<Record<string, number | string>>; hash?: string; warn?: string[] }
    | undefined;
  const chars = (preview?.segments ?? []).reduce((s, seg) => s + num(seg.chars), 0);
  const text =
    (preview?.s1?.prefix ?? "") +
    "\n--- thinking ---\n" +
    (preview?.s1?.thinking ?? "") +
    "\n--- suffix ---\n" +
    (preview?.s1?.suffix ?? "");
  const box = el("div", { class: "mw-col" }, [
    el("pre", { class: "mw-pre", text }),
    el("div", { class: "mw-row" }, [
      badge("体积 " + String(chars) + " " + t("inject.chars", state.lang), chars > 6000 ? "warn" : "plain"),
      badge("校验 " + String(preview?.hash ?? "-").slice(0, 8), "plain"),
    ]),
    ...(preview?.warn ?? []).map((w) => badge(String(w), "warn")),
    el("button", {
      type: "button",
      text: t("persona.copy", state.lang),
      onclick: () => {
        try {
          void navigator.clipboard?.writeText(text)?.then(() => flash(t("persona.copy", state.lang) + " ok", "ok"));
        } catch {
          flash("clipboard 不可用", "warn");
        }
      },
    }),
    el("button", {
      type: "button",
      text: t("persona.exportSnapshot", state.lang),
      onclick: () => downloadJson("memweave-preview.json", preview ?? {}),
    }),
  ]);
  return el("div", { class: "mw-col" }, [el("h4", { text: t("persona.preview", state.lang) }), box]);
}

// ---------- 主页面 ----------

const SUBS: Array<{ key: Sub; labelKey: string }> = [
  { key: "basic", labelKey: "persona.basic" },
  { key: "appearance", labelKey: "persona.appearance" },
  { key: "tone", labelKey: "persona.tone" },
  { key: "contracts", labelKey: "persona.contracts" },
  { key: "thinking", labelKey: "persona.thinking" },
  { key: "versions", labelKey: "persona.versions" },
  { key: "presets", labelKey: "persona.presets" },
];

async function savePatch(patch: Record<string, unknown>, reload: boolean): Promise<void> {
  if (Object.keys(patch).length === 0) {
    flash(t("persona.clean", state.lang), "ok");
    return;
  }
  const expected = num((state.status ?? {}).personaVersion, 0);
  const out = await rpc("persona/update", { patch, expectedVersion: expected });
  if ((out as { code?: string }).code === "E_CAS") {
    flash("人格已被 AI 或另一个窗口修改过，请先刷新再保存（你的修改仍保留在页面上）", "warn");
    return;
  }
  if (!report(out, reload ? undefined : t("persona.saveNext", state.lang) + " ✓")) return;
  draft = {};
  activeCollect = null;
  if (reload) {
    const result = await rpc("persona/reload", {}) as { ok?: boolean; message?: string };
    if (result?.ok === false) {
      flash("人格已保存，但提示词重载失败：" + String(result.message ?? "请手动重载或重启"), "warn");
    } else {
      flash(t("persona.reload", state.lang) + " ✓", "ok");
    }
  }
  void refresh();
}

/** 预览档位下拉：Pro / Flash 两档 + 人格里按模型单独配置过的模型 + 自定义 */
function modelTierControl(): HTMLElement {
  const c = cfg();
  const byModelKeys = new Set<string>();
  for (const map of [c.selfNameByModel, (c.tone as Record<string, unknown> | undefined)?.byModel, (c.appearance as Record<string, unknown> | undefined)?.byModel]) {
    if (map && typeof map === "object") for (const k of Object.keys(map as Record<string, unknown>)) if (k.trim()) byModelKeys.add(k.trim());
  }
  const current = String(state.data.modelHint ?? "");
  const known = ["", "pro", "flash", ...byModelKeys];
  const select = el("select", { "aria-label": t("persona.modelHint", state.lang) }) as HTMLSelectElement;
  const selectedValue = current === "" ? "pro" : known.includes(current) ? current : "__custom";
  const addOpt = (value: string, label: string): void => {
    const opt = el("option", { value, text: label }) as HTMLOptionElement;
    if (value === selectedValue) opt.selected = true;
    select.appendChild(opt);
  };
  addOpt("pro", t("persona.tier.pro", state.lang));
  addOpt("flash", t("persona.tier.flash", state.lang));
  for (const k of byModelKeys) if (k !== "pro" && k !== "flash") addOpt(k, k);
  addOpt("__custom", t("persona.tier.custom", state.lang));

  const custom = el("input", {
    type: "text",
    value: selectedValue === "__custom" ? current : "",
    placeholder: t("field.model", state.lang),
    "aria-label": t("field.model", state.lang),
  }) as HTMLInputElement;
  custom.style.display = selectedValue === "__custom" ? "" : "none";

  const apply = (hint: string): void => {
    if (!stashActive()) return;
    state.data.modelHint = hint;
    void refresh();
  };
  select.addEventListener("change", () => {
    if (select.value === "__custom") {
      custom.style.display = "";
      custom.focus();
      return;
    }
    apply(select.value === "pro" ? "" : select.value);
  });
  custom.addEventListener("change", () => apply(custom.value.trim()));

  // 每个档位一句话说明，当前选中的高亮
  const active = selectedValue === "__custom" ? (current.toLowerCase().includes("flash") ? "flash" : "custom") : selectedValue === "flash" ? "flash" : selectedValue === "pro" ? "pro" : "custom";
  const tier = (key: string, title: string, desc: string): HTMLElement =>
    el("div", { class: "mw-tier-item" + (active === key ? " mw-tier-on" : "") }, [el("b", { text: title }), el("span", { text: desc })]);
  const proName = String(c.selfNamePro ?? "") || "（未填）";
  const flashName = String(c.selfNameFlash ?? "") || "（未填）";

  return el("div", { class: "mw-col", "data-nodirty": "1" }, [
    el("div", { class: "mw-field-row" }, [
      el("span", { class: "mw-field-label", text: t("persona.modelHint", state.lang) }),
      el("div", { class: "mw-row" }, [select, custom]),
    ]),
    el("p", { class: "mw-small", style: "margin:0", text: t("persona.modelHintHelp", state.lang) }),
    el("div", { class: "mw-tier-help" }, [
      tier("pro", "深度对话（Pro）", "主力模型，自称：" + proName),
      tier("flash", "闪聊（Flash）", "名字带 flash 的快速模型，自称：" + flashName),
      tier("custom", "其他模型", "按模型名单独配置的那一套"),
    ]),
  ]);
}

export function pagePersona(): HTMLElement {
  const c = cfg();
  const row = (state.data.persona as Record<string, unknown>) ?? {};
  const part = ((): ViewPart => {
    switch (sub) {
      case "appearance":
        return subAppearance();
      case "tone":
        return subTone();
      case "contracts":
        return subContracts();
      case "thinking":
        return subThinking();
      case "versions":
        return subVersions();
      case "presets":
        return subPresets();
      default:
        return subBasic();
    }
  })();
  activeCollect = part.collect;
  rememberPristine(part.collect);

  const tabBar = el("div", { class: "mw-nav mw-subnav", role: "tablist", "aria-label": t("nav.persona", state.lang) });
  for (const s of SUBS) {
    const active = sub === s.key;
    tabBar.appendChild(
      el("button", {
        type: "button",
        role: "tab",
        "aria-selected": active ? "true" : "false",
        class: "mw-tab" + (active ? " mw-active" : ""),
        text: t(s.labelKey, state.lang),
        onclick: () => {
          if (active) return;
          // 切分页前收起当前输入；校验不通过就留在原分页
          if (!stashActive()) return;
          sub = s.key;
          void refresh();
        },
      }),
    );
  }

  // ---------- 底部：保存与生效（与上方编辑区分栏） ----------
  const strictBox = el("input", { type: "checkbox", checked: c.strict ? "checked" : undefined }) as HTMLInputElement;
  const applyBox = el("input", {
    type: "checkbox",
    checked: c.applyNextSession !== false ? "checked" : undefined,
  }) as HTMLInputElement;
  const dirty = isDirty();

  const collectAll = (): Record<string, unknown> | null => {
    if (!stashActive()) return null;
    const out: Record<string, unknown> = { ...draft, strict: strictBox.checked, applyNextSession: applyBox.checked };
    const base = baseCfg();
    // 只提交真的变了的顶层字段
    for (const k of Object.keys(out)) {
      if (unchanged(k, out[k])) delete out[k];
    }
    return out;
  };

  const ro = state.readonly ? "disabled" : undefined;
  const statusBadge = el("span");
  const actionBar = el("section", { class: "mw-card mw-action-bar", "aria-label": t("persona.actions", state.lang) }, [
    el("div", { class: "mw-row" }, [
      el("h3", { text: t("persona.actions", state.lang) }),
      statusBadge,
    ]),
    el("p", { class: "mw-small", text: t("persona.actionsHint", state.lang) }),
    el("div", { class: "mw-row" }, [
      el("label", { class: "mw-check-row" }, [strictBox, el("span", { text: t("field.strict", state.lang) })]),
      el("label", { class: "mw-check-row" }, [applyBox, el("span", { text: t("field.applyNextSession", state.lang) })]),
    ]),
    el("div", { class: "mw-action-grid" }, [
      el("div", { class: "mw-col" }, [
        el("button", {
          type: "button",
          text: t("persona.saveNext", state.lang),
          "data-role": "save",
          disabled: ro,
          onclick: () => {
            const patch = collectAll();
            if (patch) void savePatch(patch, false);
          },
        }),
        el("span", { class: "mw-small", text: t("persona.saveNextHint", state.lang) }),
      ]),
      el("div", { class: "mw-col" }, [
        el("button", {
          type: "button",
          class: "mw-primary",
          text: t("persona.reload", state.lang),
          "data-role": "save",
          disabled: ro,
          onclick: () => {
            const patch = collectAll();
            if (patch) void savePatch(patch, true);
          },
        }),
        el("span", { class: "mw-small", text: t("persona.reloadHint", state.lang) }),
      ]),
      el("div", { class: "mw-col" }, [
        el("button", {
          type: "button",
          "data-role": "discard",
          text: t("persona.discard", state.lang),
          disabled: dirty ? undefined : "disabled",
          onclick: () => {
            draft = {};
            activeCollect = null;
            void refresh();
          },
        }),
      ]),
    ]),
    el("span", {
      class: "mw-small",
      text: t("persona.meta", state.lang)
        .replace("{v}", String(row.version ?? 0))
        .replace("{time}", fmtTime(row.updatedAt))
        .replace("{who}", actorLabel(row.updatedBy, state.lang)),
    }),
  ]);

  const editor = el("section", { class: "mw-card" }, [
    el("h3", { text: t("nav.persona", state.lang) }),
    modelTierControl(),
    tabBar,
    el("div", { class: "mw-row mw-persona-split" }, [
      el("div", { class: "mw-col", style: "flex:2;min-width:320px" }, [part.node]),
      el("div", { class: "mw-col", style: "flex:1;min-width:260px" }, [previewPanel()]),
    ]),
  ]);

  // 未保存提示：已有草稿，或在本页改了任意字段（版本 / 预设卡分页的操作是即时的，不算草稿）
  const notice = unsavedNotice(() => actionBar);
  const discardBtn = actionBar.querySelector("[data-role=discard]") as HTMLButtonElement | null;
  const setDirty = (on: boolean): void => {
    notice.setDirty(on);
    statusBadge.replaceChildren(badge(t(on ? "persona.dirty" : "persona.clean", state.lang), on ? "warn" : "plain"));
    if (discardBtn) discardBtn.disabled = !on;
    // 没有改动时两个保存按钮置灰（不再点了才提示“没有未保存的修改”）
    for (const b of Array.from(actionBar.querySelectorAll("[data-role=save]")) as HTMLButtonElement[]) b.disabled = !on || state.readonly;
  };
  setDirty(dirty);
  let touched = false;
  const editable = sub !== "versions" && sub !== "presets";
  if (editable) {
    watchEdits(part.node, () => {
      touched = true;
      setDirty(true);
    });
  }
  watchEdits(actionBar, () => {
    const boxesChanged = strictBox.checked !== Boolean(c.strict) || applyBox.checked !== (c.applyNextSession !== false);
    setDirty(dirty || touched || boxesChanged);
  });

  return el("div", { class: "mw-col" }, [notice.node, editor, actionBar]);
}
