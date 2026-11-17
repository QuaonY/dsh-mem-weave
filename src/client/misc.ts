/// <reference lib="dom" />
/**
 * 忆织 MemWeave —— 其余子页：
 * 总览/ 候选与冲突（键盘流）/ 注入与预算（滑块 + trace）
 * 治理与审计（撤销列表）/ 数据与导入导出（导入 UI）/ 高级
 */

import { langOf, t } from "../i18n";
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
  resetLang,
  rpc,
  state,
  unsavedNotice,
  watchEdits,
} from "./ui";
import { actorLabel } from "./account";
import { openMemoryDrawer } from "./memory";
import { BUILTIN_RULES, CUSTOM_RULE_LEN_MAX, CUSTOM_RULE_MAX, checkCustomPattern, matchSensitive } from "../core/sensitive";

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** 后端名 → 展示文案；sqlite-vec 不再区分「包内自带」 */
function readableBackend(backend: string, _source: unknown): string {
  return t("advanced.vectorSearch.backend." + backend, state.lang);
}

// ---------- 数据装载 ----------

export async function loadOverview(): Promise<void> {
  const [undo, audit, preview, sessions] = await Promise.all([
    rpc("undo/list", {}),
    rpc("audit/query", { limit: 8 }),
    rpc("persona/preview", {}),
    rpc("inject/sessions", { limit: 5 }),
  ]);
  state.data.undo = obj(undo).items ?? [];
  state.data.overviewAudit = Array.isArray(obj(audit).rows) ? obj(audit).rows : [];
  state.data.overviewPreview = preview;
  state.data.overviewSessions = Array.isArray(obj(sessions).sessions) ? obj(sessions).sessions : [];
}

export async function loadCandidates(): Promise<void> {
  // 只拉待处理的：已裁决的候选 / 已解决的冲突不再显示可点的按钮，数目也和总览角标一致
  const [candidateResult, conflictResult] = await Promise.all([
    rpc("candidates/list", { verdict: "pending" }),
    rpc("conflicts/list", { status: "open" }),
  ]);
  const candidateResponse = obj(candidateResult);
  const conflictResponse = obj(conflictResult);
  state.data.candidates = Array.isArray(candidateResponse.candidates) ? candidateResponse.candidates : [];
  state.data.conflicts = Array.isArray(conflictResponse.conflicts) ? conflictResponse.conflicts : [];
  state.data.candidatesError = candidateResponse.ok === false || !Array.isArray(candidateResponse.candidates)
    ? String(candidateResponse.code ?? "E_UNAVAILABLE") + ": " + String(candidateResponse.message ?? "candidate service unavailable")
    : "";
  state.data.conflictsError = conflictResponse.ok === false || !Array.isArray(conflictResponse.conflicts)
    ? String(conflictResponse.code ?? "E_UNAVAILABLE") + ": " + String(conflictResponse.message ?? "conflict service unavailable")
    : "";
}

export async function loadInject(): Promise<void> {
  state.data.preview = await rpc("persona/preview", { modelHint: (state.data.modelHint as string) || undefined });
  state.data.settings = await rpc("settings/get", {});
  state.data.defaults = await rpc("settings/defaults", {});
  const sessions = obj(await rpc("inject/sessions", { limit: 20 })).sessions;
  state.data.traceSessions = Array.isArray(sessions) ? sessions : [];
  const sid = String(state.data.traceSession ?? "");
  state.data.trace = sid ? ((await rpc("inject/trace", { sessionId: sid })) as { trace?: unknown })?.trace ?? [] : [];
  // 最近一次注入的延迟与规模
  state.data.injectState = sid ? (obj(await rpc("inject/state", { sessionId: sid })).state as Record<string, unknown> | undefined) ?? null : null;
}

export async function loadGovern(): Promise<void> {
  const auditResult = await rpc("audit/query", { limit: 50 });
  const auditResponse = obj(auditResult);
  state.data.audit = Array.isArray(auditResponse.rows) ? auditResponse.rows : [];
  state.data.auditError = auditResponse.ok === false || !Array.isArray(auditResponse.rows)
    ? String(auditResponse.code ?? "E_UNAVAILABLE") + ": " + String(auditResponse.message ?? "audit service unavailable")
    : "";
  state.data.persona = await rpc("persona/get", {});
  const undo = (await rpc("undo/list", {})) as { items?: unknown; windowHours?: number };
  state.data.undo = undo?.items ?? [];
  state.data.undoWindow = undo?.windowHours ?? 24;
}

export async function loadData(): Promise<void> {
  state.data.location = await rpc("data/location", {});
  const [backupResult, rollbackResult] = await Promise.all([rpc("backup/list", {}), rpc("import/list", {})]);
  const backup = obj(backupResult);
  const rollbacks = obj(rollbackResult);
  state.data.backups = Array.isArray(backup.backups) ? backup.backups : [];
  state.data.backupError = backup.ok === false || !Array.isArray(backup.backups)
    ? String(backup.code ?? "E_UNAVAILABLE") + ": " + String(backup.message ?? "backup list unavailable")
    : "";
  state.data.importRollbacks = Array.isArray(rollbacks.items) ? rollbacks.items : [];
  state.data.rollbackError = rollbacks.ok === false || !Array.isArray(rollbacks.items)
    ? String(rollbacks.code ?? "E_UNAVAILABLE") + ": " + String(rollbacks.message ?? "rollback list unavailable")
    : "";
  state.data.settings = await rpc("settings/get", {});
}

export async function loadAdvanced(): Promise<void> {
  state.data.settings = await rpc("settings/get", {});
  state.data.defaults = await rpc("settings/defaults", {});
}

// ---------- 总览 ----------

const LEVELS = ["soul", "user", "project", "fact", "lesson", "topic", "rules"];

const AUDIT_ACTIONS: Record<string, string> = {
  "persona.update": "更新人格",
  "persona.history.restore": "恢复人格版本",
  "preset.apply": "应用预设",
  "memory.remember": "写入记忆",
  "memory.revise": "修改记忆",
  "memory.merge": "合并记忆",
  "memory.forget": "遗忘记忆",
  "memory.archive": "归档记忆",
  "memory.restore": "恢复记忆",
  "candidate.decide": "处理候选",
  "conflict.resolve": "裁决冲突",
  "import.run": "导入数据",
  "import.rollback": "回滚导入",
  "backup.restore": "恢复备份",
  "settings.update": "修改设置",
  "undo.run": "撤销",
};

function auditActionLabel(action: unknown): string {
  const a = String(action ?? "");
  return AUDIT_ACTIONS[a] ?? a ?? "-";
}

function kv(label: string, value: string): HTMLElement {
  return el("div", { class: "mw-kv" }, [el("span", { class: "mw-kv-label", text: label }), el("span", { class: "mw-kv-value", text: value })]);
}

function goTo(tab: string): void {
  state.tab = tab;
  void refresh();
}

export function pageOverview(): HTMLElement {
  const status = state.status ?? {};
  const counts = (status.counts as Record<string, number>) ?? {};
  const undoItems = ((state.data.undo as Array<Record<string, unknown>>) ?? []).filter((u) => !u.undone);
  const conflicts = num(status.conflictsOpen, 0);
  const candidates = num(status.candidatesPending, 0);
  const total = num(status.total, 0);

  // 健康：运行状态 / 库 / 人格 / 格式
  const mode = state.readonly
    ? badge(t("overview.modeReadonly", state.lang), "bad")
    : state.paused
      ? badge(t("overview.modePaused", state.lang), "warn")
      : badge(t("overview.modeOk", state.lang), "ok");
  const health = el("section", { class: "mw-card" }, [
    el("h3", { text: t("overview.health", state.lang) }),
    el("div", { class: "mw-kv-grid" }, [
      el("div", { class: "mw-kv" }, [el("span", { class: "mw-kv-label", text: t("overview.mode", state.lang) }), mode]),
      kv(t("overview.store", state.lang), String(status.dataDir ?? "-")),
      kv(t("overview.persona", state.lang), "v" + String(status.personaVersion ?? 0) + " · " + t(status.strict ? "overview.strictOn" : "overview.strictOff", state.lang)),
      kv(t("overview.schema", state.lang), "v" + String(status.schemaVersion ?? "-")),
    ]),
  ]);

  // 待你处理：冲突 / 候选 / 可撤销
  const pendingRow = (label: string, n: number, tone: "ok" | "warn" | "bad", tab: string): HTMLElement =>
    el("div", { class: "mw-row mw-item" }, [
      badge(String(n), n > 0 ? tone : "ok"),
      el("span", { class: "mw-content", text: label }),
      el("button", { type: "button", text: t("overview.goto", state.lang), disabled: n > 0 ? undefined : "disabled", onclick: () => goTo(tab) }),
    ]);
  const pending = el("section", { class: "mw-card" }, [
    el("h3", { text: t("overview.pending", state.lang) }),
    pendingRow(t("candidates.conflictsTitle", state.lang), conflicts, "bad", "candidates"),
    pendingRow(t("nav.candidates", state.lang), candidates, "warn", "candidates"),
    pendingRow(t("govern.undoList", state.lang), undoItems.length, "warn", "govern"),
  ]);

  // 各层记忆：条形 + 数量
  const maxCount = Math.max(1, ...LEVELS.map((l) => num(counts[l], 0)));
  const levels = el("section", { class: "mw-card" }, [
    el("div", { class: "mw-row" }, [
      el("h3", { text: t("overview.levels", state.lang) }),
      badge(t("overview.total", state.lang).replace("{n}", String(total)), "plain"),
    ]),
    ...LEVELS.map((l) => {
      const n = num(counts[l], 0);
      const bar = el("span", { class: "mw-bar-fill" });
      bar.style.width = String(Math.round((n / maxCount) * 100)) + "%";
      return el("div", { class: "mw-bar-row" }, [
        el("span", { class: "mw-bar-label", text: t("option.level." + l, state.lang) }),
        el("span", { class: "mw-bar" }, [bar]),
        el("span", { class: "mw-bar-num", text: String(n) }),
      ]);
    }),
  ]);

  // 分段体积（当前人格渲染预览）
  const segs = (obj(state.data.overviewPreview).segments as Array<Record<string, unknown>> | undefined) ?? [];
  const segments = el("section", { class: "mw-card" }, [
    el("h3", { text: t("overview.segments", state.lang) }),
    segs.length === 0
      ? el("p", { class: "mw-empty", text: t("common.empty", state.lang) })
      : el("div", { class: "mw-col" }, segs.map((s) => {
          const name = String(s.name ?? "-");
          const label = t("option.segment." + name, state.lang);
          return el("div", { class: "mw-row mw-item" }, [
            badge(label === "option.segment." + name ? name : label, "plain"),
            el("span", { class: "mw-small", text: String(num(s.chars, 0)) + " " + t("inject.chars", state.lang) + " · " + String(num(s.items, 0)) + " " + t("inject.items", state.lang) }),
          ]);
        })),
  ]);

  // 注入账本：最近会话
  const sessions = (state.data.overviewSessions as Array<Record<string, unknown>>) ?? [];
  const ledger = el("section", { class: "mw-card" }, [
    el("h3", { text: t("overview.ledger", state.lang) }),
    sessions.length === 0
      ? el("p", { class: "mw-empty", text: t("common.empty", state.lang) })
      : el("div", { class: "mw-col" }, sessions.map((s) =>
          el("div", { class: "mw-row mw-item" }, [
            el("span", { class: "mw-small", text: fmtTime(s.lastTs) }),
            el("span", { class: "mw-content mw-mono", text: String(s.sessionId ?? "").slice(0, 16) }),
            el("span", { class: "mw-small", text: String(num(s.turns, 0)) + " 次注入 · " + String(num(s.chars, 0)) + " " + t("inject.chars", state.lang) }),
            el("button", {
              type: "button",
              text: t("inject.query", state.lang),
              onclick: () => {
                state.data.traceSession = String(s.sessionId ?? "");
                goTo("inject");
              },
            }),
          ]))),
  ]);

  // 最近活动：审计
  const audit = (state.data.overviewAudit as Array<Record<string, unknown>>) ?? [];
  const activity = el("section", { class: "mw-card" }, [
    el("h3", { text: t("overview.activity", state.lang) }),
    audit.length === 0
      ? el("p", { class: "mw-empty", text: t("overview.noActivity", state.lang) })
      : el("div", { class: "mw-col" }, audit.map((r) =>
          el("div", { class: "mw-row mw-item" }, [
            el("span", { class: "mw-small", text: fmtTime(r.ts) }),
            badge(auditActionLabel(r.action), "plain"),
            el("span", { class: "mw-small", text: actorLabel(r.actor, state.lang) }),
            el("span", { class: "mw-content", text: String(r.target ?? "").slice(0, 40) }),
          ]))),
  ]);

  // 首次使用：一条记忆都没有时，别让用户对着一排 0 发愣
  const firstRun =
    total === 0 && candidates === 0 && conflicts === 0
      ? el("section", { class: "mw-card mw-info" }, [
          el("h3", { text: t("overview.firstRun.title", state.lang) }),
          el("p", { text: t("overview.firstRun.body", state.lang) }),
          el("p", { class: "mw-small", text: t("overview.firstRun.hint", state.lang) }),
        ])
      : null;

  return el("div", { class: "mw-overview" }, [firstRun, health, pending, levels, segments, ledger, activity]);
}

// ---------- 候选与冲突：每条候选一张卡片，按钮就在卡片里 ----------

export function pageCandidates(): HTMLElement {
  const candidates = (state.data.candidates as Array<Record<string, unknown>>) ?? [];
  const conflicts = (state.data.conflicts as Array<Record<string, unknown>>) ?? [];

  const decide = (c: Record<string, unknown>, verdict: string, targetId?: string): void => {
    if (state.readonly) return;
    void rpc("candidates/decide", { id: String(c.id ?? ""), verdict, targetId }).then((out) => {
      if (report(out)) {
        // 晋升候选被接受 → 契约已写入，给出版本反馈（含界面闭环）
        const r = obj(out);
        if (r.promoted === true) {
          flash(t("candidates.promoted", state.lang) + " v" + String(r.version ?? "?"), "ok");
        }
        void refresh();
      }
    });
  };

  const merge = (c: Record<string, unknown>): void => {
    const target = window.prompt(t("field.targetId", state.lang));
    if (target && target.trim()) decide(c, "merged", target.trim());
  };
  // 保持待定：不改库，只在界面上提示
  const hold = (): void => {
    flash(t("candidates.holdDone", state.lang), "ok");
  };

  const candBox = el("div", { class: "mw-col mw-cand-list", "aria-label": t("nav.candidates", state.lang) });

  if (candidates.length === 0) candBox.appendChild(el("p", { class: "mw-empty", text: String(state.data.candidatesError ?? "") || t("common.empty", state.lang) }));
  candidates.forEach((c, i) => {
    const id = String(c.id ?? "");
    const evidence = (c.evidence as Array<Record<string, unknown>>) ?? [];
    const level = String(c.level ?? "");
    const reason = String(c.reason ?? "");
    const reasonText = reason === "contract-promotion"
      ? t("candidates.promoteBadge", state.lang)
      : reason === "contract-review"
        ? t("candidates.reviewHint", state.lang)
        : reason === "archive-suggest" || reason === "core-suggest" || reason === "distill-rules"
          ? t("candidates.hint." + reason, state.lang)
          : reason;
    const ro = state.readonly ? "disabled" : undefined;
    // 卡片三段：头部标签 + 说明，中间正文整段换行，底部操作按钮（窄窗口下也不会把正文挤成竖排）
    candBox.appendChild(
      el("article", { class: "mw-cand", "data-id": id }, [
        el("div", { class: "mw-cand-head" }, [
          // 晋升候选（reason=contract-promotion，对应 store/promote 的 PROMOTION_REASON）单独标记
          ...(reason === "contract-promotion" ? [badge(t("candidates.promoteBadge", state.lang), "warn")] : []),
          // 契约复核（接受 = 停用契约，拒绝 = 保留；改文字去人格页）
          ...(reason === "contract-review" ? [badge(t("candidates.reviewBadge", state.lang), "warn")] : []),
          badge(String(c.risk ?? "L?"), "warn"),
          badge(level ? t("option.level." + level, state.lang) : "-", "plain"),
          el("span", { class: "mw-small mw-cand-reason", text: reasonText + (evidence.length > 0 ? " · 证据 " + String(evidence.length) : "") }),
        ]),
        el("p", { class: "mw-cand-body", text: String(c.content ?? "").slice(0, 400) }),
        ...(c.patch && typeof c.patch === "object"
          ? [el("p", { class: "mw-small mw-cand-body", text: "提案变更：" + JSON.stringify(c.patch).slice(0, 240) })]
          : []),
        el("div", { class: "mw-cand-actions" }, [
          el("button", { type: "button", class: "mw-primary", text: t("candidates.accept", state.lang), disabled: ro, onclick: () => decide(c, "accepted") }),
          el("button", { type: "button", text: t("candidates.reject", state.lang), disabled: ro, onclick: () => decide(c, "rejected") }),
          el("button", { type: "button", text: t("candidates.merge", state.lang), disabled: ro, onclick: () => merge(c) }),
          el("button", { type: "button", text: t("candidates.hold", state.lang), onclick: hold }),
        ]),
      ]),
    );
  });

  const confBox = el("div", { class: "mw-col" });
  if (conflicts.length === 0) confBox.appendChild(el("p", { class: "mw-empty", text: String(state.data.conflictsError ?? "") || t("conflicts.empty", state.lang) }));
  for (const c of conflicts) {
    const id = String(c.id ?? "");
    const contenders = (c.contenders as Array<Record<string, unknown>>) ?? [];
    // 三方以上的冲突：左边放已有的第一条，右边放最新写入的一条（新写入的总排在最后）
    const left = contenders[0];
    const right = contenders[contenders.length - 1];
    const pick = (winner: Record<string, unknown> | undefined): void => {
      if (state.readonly) return;
      void rpc("conflicts/resolve", { id, winnerId: winner ? String(winner.id ?? "") : undefined }).then((out) => {
        if (report(out)) void refresh();
      });
    };
    const ro = state.readonly ? "disabled" : undefined;
    // 两方冲突沿用左 / 右；三方以上逐条列出，每条一个「选这条」
    const sides = contenders.length > 2 ? contenders : [left, right];
    const sideLabel = (i: number): string =>
      contenders.length > 2 ? "#" + String(i + 1) : i === 0 ? (state.lang === "en" ? "Left" : "左") : state.lang === "en" ? "Right" : "右";
    confBox.appendChild(
      el("article", { class: "mw-cand", "data-id": id }, [
        el("div", { class: "mw-cand-head" }, [badge(String(c.semanticKey ?? "-"), "bad")]),
        el(
          "div",
          { class: "mw-cand-pair" },
          sides.map((side, i) =>
            el("div", { class: "mw-cand-side" }, [
              el("span", { class: "mw-small", text: sideLabel(i) }),
              el("p", { class: "mw-cand-body", text: String(side?.content ?? "").slice(0, 300) }),
            ]),
          ),
        ),
        el("div", { class: "mw-cand-actions" }, [
          ...(contenders.length > 2
            ? contenders.map((side, i) =>
                el("button", { type: "button", text: (state.lang === "en" ? "Pick " : "选 ") + "#" + String(i + 1), disabled: ro, onclick: () => pick(side) }),
              )
            : [
                el("button", { type: "button", text: t("conflicts.left", state.lang), disabled: ro, onclick: () => pick(left) }),
                el("button", { type: "button", text: t("conflicts.right", state.lang), disabled: ro, onclick: () => pick(right) }),
              ]),
          el("button", { type: "button", text: t("conflicts.none", state.lang), disabled: ro, onclick: () => pick(undefined) }),
          el("button", { type: "button", text: t("conflicts.stash", state.lang), onclick: () => flash(t("conflicts.stash", state.lang), "ok") }),
        ]),
      ]),
    );
  }

  return el("div", { class: "mw-col" }, [
    el("section", { class: "mw-card" }, [
      el("h3", { text: t("nav.candidates", state.lang) + (candidates.length > 0 ? "（" + candidates.length + "）" : "") }),
      candBox,
    ]),
    el("section", { class: "mw-card" }, [el("h3", { text: t("candidates.conflictsTitle", state.lang) }), confBox]),
  ]);
}

// ---------- 注入与预算（预算滑块 + trace 查看器） ----------

export function pageInject(): HTMLElement {
  const preview = state.data.preview as
    | { segments?: Array<Record<string, number | string>>; hash?: string }
    | undefined;
  const settings = obj(state.data.settings);
  const budget = obj(settings.budget);
  const segs = preview?.segments ?? [];
  const segChars = (name: string): number => num((segs.find((s) => s.name === name) ?? {}).chars, 0);
  const segmentLabel = (name: string): string => t("option.segment." + name, state.lang);

  const mkSlider = (key: string, min: number, max: number, step: number): HTMLElement => {
    const value = num(budget[key], 0);
    const labelText = t("inject." + key, state.lang);
    const label = el("span", { text: labelText + "：" + String(value) });
    const input = el("input", {
      type: "range",
      min: String(min),
      max: String(max),
      step: String(step),
      value: String(value),
      class: "mw-slider",
      "aria-label": labelText,
    }) as HTMLInputElement;
    input.addEventListener("input", () => {
      label.textContent = labelText + "：" + input.value;
    });
    input.addEventListener("change", () => {
      const patch = { ...budget, [key]: num(input.value, value) };
      void rpc("settings/update", { patch: { budget: patch } }).then((out) => {
        if (report(out, labelText + " · " + t("persona.effectNow", state.lang))) void refresh();
      });
    });
    return el("label", { class: "mw-slider-control" }, [label, input]);
  };

  const traceRows = (state.data.trace as Array<Record<string, unknown>>) ?? [];
  const recentSessions = (state.data.traceSessions as Array<Record<string, unknown>>) ?? [];
  const currentSid = String(state.data.traceSession ?? "");
  // 最近会话下拉（有注入记录的会话）；也可以手填其他会话 ID
  const sessionSelect = el("select", { "aria-label": t("inject.session", state.lang) }) as HTMLSelectElement;
  sessionSelect.appendChild(el("option", { value: "", text: recentSessions.length > 0 ? "选择最近的会话…" : "暂无注入记录" }));
  for (const s of recentSessions) {
    const id = String(s.sessionId ?? "");
    const opt = el("option", {
      value: id,
      text: fmtTime(s.lastTs) + " · " + id.replace(/^session-/, "").slice(0, 8) + " · " + String(num(s.turns, 0)) + " 轮",
    }) as HTMLOptionElement;
    if (id === currentSid) opt.selected = true;
    sessionSelect.appendChild(opt);
  }
  sessionSelect.addEventListener("change", () => {
    state.data.traceSession = sessionSelect.value;
    void refresh();
  });
  const sessionIdInput = el("input", {
    type: "text",
    value: currentSid,
    placeholder: "也可以粘贴会话 ID",
    "aria-label": t("inject.session", state.lang),
  }) as HTMLInputElement;
  // 延迟行（inject_ms 含检索，recall_ms 是检索那一段）
  const injectState = (state.data.injectState as Record<string, unknown> | null) ?? null;
  const latencyNode = injectState && injectState.injectAt
    ? el("div", { class: "mw-row mw-item" }, [
        badge("注入 " + num(injectState.injectMs).toFixed(2) + " ms", "plain"),
        el("span", {
          class: "mw-small",
          text:
            "检索 " + num(injectState.recallMs).toFixed(2) + " ms · " +
            String(num(injectState.injectItems)) + " 条 · " +
            String(num(injectState.injectChars)) + " 字符 · 第 " +
            String(num(injectState.injectTurn)) + " 轮" +
            (injectState.injected ? "" : " · 已暂停未注入"),
        }),
      ])
    : null;
  const traceBox = el("div", { class: "mw-col" });
  if (currentSid === "") {
    traceBox.appendChild(el("p", { class: "mw-empty", text: "选择一个会话后显示它的注入记录" }));
  } else if (traceRows.length === 0) {
    traceBox.appendChild(el("p", { class: "mw-empty", text: t("common.empty", state.lang) }));
  }
  for (const r of traceRows) {
    const segment = String(r.segment ?? "-");
    traceBox.appendChild(
      el("div", { class: "mw-row mw-item" }, [
        badge(segment === "-" ? segment : t("option.segment." + segment, state.lang), "plain"),
        el("span", {
          class: "mw-small",
          text: String(r.chars ?? 0) + " " + t("inject.chars", state.lang) + " · " + String(r.items ?? 0) + " " + t("inject.items", state.lang) + " · " + t("inject.trimmed", state.lang) + " " + String(r.trimmed ?? 0),
        }),
      ]),
    );
    // 召回段逐条显示命中解释（路由/关联类型/重要度/衰减/去同质/反刍）
    if (r.detail) traceBox.appendChild(el("pre", { class: "mw-pre", text: String(r.detail).slice(0, 4000) }));
  }

  // 预算滑块是拖完即保存，所以「恢复默认」也直接保存（先确认）
  const budgetDefaults = obj(obj(state.data.defaults).budget);
  const budgetKeys = ["snapshotMaxChars", "deltaMaxChars", "recallMaxChars"];
  const budgetIsDefault = budgetKeys.every((k) => budgetDefaults[k] === undefined || num(budget[k]) === num(budgetDefaults[k]));
  const budgetReset = el("button", {
    type: "button",
    class: "mw-reset",
    text: t("common.resetDefault", state.lang),
    title: budgetKeys.map((k) => t("inject." + k, state.lang) + " " + String(budgetDefaults[k] ?? "-")).join(" · "),
    disabled: state.readonly || budgetIsDefault || Object.keys(budgetDefaults).length === 0 ? "disabled" : undefined,
    onclick: () => {
      if (!window.confirm(t("common.resetConfirm", state.lang))) return;
      const patch: Record<string, unknown> = { ...budget };
      for (const k of budgetKeys) if (budgetDefaults[k] !== undefined) patch[k] = budgetDefaults[k];
      void rpc("settings/update", { patch: { budget: patch } }).then((out) => {
        if (report(out, t("common.resetDone", state.lang))) void refresh();
      });
    },
  });

  // 界面语言与注入提示词同源（promptLang）：切换后重新解析并重绘
  const currentLang = langOf(settings.promptLang);
  const langSelect = el("select", { "aria-label": t("settings.language", state.lang) }) as HTMLSelectElement;
  for (const value of ["zh", "en"] as const) {
    const opt = el("option", {
      value,
      text: t("settings.language." + value, state.lang),
    }) as HTMLOptionElement;
    if (value === currentLang) opt.selected = true;
    langSelect.appendChild(opt);
  }
  langSelect.addEventListener("change", () => {
    const next = langOf(langSelect.value);
    void rpc("settings/update", { patch: { promptLang: next } }).then((out) => {
      if (report(out, t("settings.languageSaved", state.lang))) {
        resetLang();
        void refresh();
      }
    });
  });

  const body = el("div", { class: "mw-col" }, [
    el("label", { class: "mw-field-row" }, [
      el("span", { class: "mw-field-label", text: t("settings.language", state.lang) }),
      langSelect,
    ]),
    el("p", { class: "mw-small", text: t("settings.languageHint", state.lang) }),
    el("div", { class: "mw-card-head" }, [el("h4", { text: t("inject.budget", state.lang) }), budgetReset]),
    el("p", { class: "mw-small", text: t("inject.budgetHint", state.lang) + t("inject.unitHint", state.lang) }),
    mkSlider("snapshotMaxChars", 1000, 12000, 100),
    mkSlider("deltaMaxChars", 200, 4000, 50),
    mkSlider("recallMaxChars", 100, 3000, 50),
    el("div", { class: "mw-row" }, [
      ...([["s2-snapshot", "snapshotMaxChars"], ["s3-delta", "deltaMaxChars"], ["s3-recall", "recallMaxChars"]] as const).map(([seg, key]) => {
        const used = segChars(seg);
        const cap = num(budget[key]);
        return badge(segmentLabel(seg) + " " + String(used) + " / " + String(cap) + " " + t("inject.chars", state.lang), cap > 0 && used >= cap ? "warn" : "plain");
      }),
    ]),
    el("h4", { text: t("inject.trace", state.lang) }),
    el("p", { class: "mw-small", text: t("inject.traceHint", state.lang) }),
    // 下拉独占一行，手填 + 查询在下一行，窄屏也不会把下拉挤成一个字
    el("label", { class: "mw-field-row" }, [el("span", { class: "mw-field-label", text: "最近会话" }), sessionSelect]),
    el("div", { class: "mw-field-row" }, [
      el("span", { class: "mw-field-label", text: t("inject.session", state.lang) }),
      el("div", { class: "mw-inline-input" }, [
        sessionIdInput,
        el("button", {
          type: "button",
          text: t("inject.query", state.lang),
          onclick: () => {
            state.data.traceSession = sessionIdInput.value.trim();
            void refresh();
          },
        }),
      ]),
    ]),
    traceBox,
    ...(latencyNode ? [latencyNode] : []),
    el("h4", { text: t("inject.preview", state.lang) }),
    ...segs.map((s) => {
      const name = String(s.name ?? "-");
      return el("div", { class: "mw-row" }, [
        badge(name === "-" ? name : segmentLabel(name), "plain"),
        el("span", { class: "mw-small", text: String(s.chars ?? 0) + " " + t("inject.chars", state.lang) + " · " + String(s.items ?? 0) + " " + t("inject.items", state.lang) + " · " + t("inject.trimmed", state.lang) + " " + String(s.trimmed ?? 0) }),
      ]);
    }),
    el("pre", { class: "mw-pre", text: "校验摘要：" + String(preview?.hash ?? "") }),
  ]);
  return el("section", { class: "mw-card" }, [el("h3", { text: t("nav.inject", state.lang) }), body]);
}

// ---------- 治理与审计（撤销列表 + 审计 + 自检） ----------

export function pageGovern(): HTMLElement {
  const rows = (state.data.audit as Array<Record<string, unknown>>) ?? [];
  const undoItems = (state.data.undo as Array<Record<string, unknown>>) ?? [];
  const strict = Boolean((state.data.persona as Record<string, unknown>)?.config ? obj((state.data.persona as Record<string, unknown>).config).strict : false);

  const undoBox = el("div", { class: "mw-col" });
  if (undoItems.length === 0) undoBox.appendChild(el("p", { class: "mw-empty", text: t("common.empty", state.lang) }));
  for (const u of undoItems.slice(0, 50)) {
    const id = String(u.id ?? "");
    const done = Boolean(u.undone);
    undoBox.appendChild(
      el("div", { class: "mw-row mw-item" }, [
        el("span", { class: "mw-small", text: fmtTime(u.ts) }),
        badge(({ "persona.update": "人格更新", "persona.history.restore": "恢复人格版本", "memory.forget": "遗忘记忆", "memory.archive": "归档记忆", "memory.restore": "恢复记忆", "conflict.resolve": "裁决冲突" } as Record<string, string>)[String(u.action ?? "")] ?? String(u.action ?? "-"), done ? "warn" : "ok"),
        el("span", { class: "mw-content", text: actorLabel(u.actor, state.lang) + " → " + String(u.target ?? "").slice(0, 24) }),
        done
          ? badge(t("govern.undone", state.lang), "warn")
          : el("button", {
              type: "button",
              text: t("govern.undo", state.lang),
              disabled: state.readonly ? "disabled" : undefined,
              onclick: () => {
                void rpc("undo/run", { id }).then((out) => {
                  if (report(out, t("govern.undo", state.lang) + " ok")) void refresh();
                });
              },
            }),
      ]),
    );
  }

  const auditBox = el("pre", {
    class: "mw-pre",
    text: String(state.data.auditError ?? "") || rows
      .slice(0, 50)
      .map((r) => fmtTime(r.ts) + " " + actorLabel(r.actor, state.lang) + " " + auditActionLabel(r.action) + " " + String(r.target ?? ""))
      .join("\n"),
  });

  const selfBox = el("div", { class: "mw-col" });

  const body = el("div", { class: "mw-col" }, [
    el("label", { class: "mw-row" }, [
      el("span", { text: t("govern.strict", state.lang) }),
      el("input", {
        type: "checkbox",
        checked: strict ? "checked" : undefined,
        onchange: (e: Event) => {
          const on = (e.target as HTMLInputElement).checked;
          void rpc("persona/update", { patch: { strict: on } }).then((out) => {
            if (report(out)) void refresh();
          });
        },
      }),
    ]),
    el("h4", { text: t("govern.undoList", state.lang) + "（" + t("govern.window", state.lang) + " " + String(state.data.undoWindow ?? 24) + "h）" }),
    undoBox,
    el("h4", { text: t("govern.audit", state.lang) }),
    auditBox,
    el("h4", { text: t("govern.selfcheck", state.lang) }),
    selfBox,
    el("button", {
      type: "button",
      text: t("govern.selfcheck", state.lang),
      onclick: () => {
        // 一致性自检：三段同源 / 写权断言 / 导出往返 / 库完整性
        void rpc("status/selfcheck", {}).then((out) => {
          const r = obj(out);
          const items = (r.checks as Array<Record<string, unknown>>) ?? [];
          selfBox.innerHTML = "";
          for (const c of items) {
            selfBox.appendChild(
              el("div", { class: "mw-row mw-item" }, [
                badge(String(c.name ?? "-"), c.ok === true ? "ok" : "bad"),
                el("span", { class: "mw-small", text: String(c.detail ?? "") }),
              ]),
            );
          }
          flash(t("govern.selfcheck", state.lang) + (r.ok === true ? " ok" : " FAIL"), r.ok === true ? "ok" : "bad");
        });
      },
    }),
  ]);
  return el("section", { class: "mw-card" }, [el("h3", { text: t("nav.govern", state.lang) }), body]);
}

// ---------- 数据与导入导出（导入 UI + 共存开关） ----------

let importPayload: Record<string, unknown> | null = null;
let importRollbackId = "";

/** 「存储位置」：查看并更改人格与记忆库所在目录（下次启动 DSH 生效） */
function locationSection(): HTMLElement {
  const loc = obj(state.data.location);
  const current = String(loc.current ?? obj(state.status).dataDir ?? "-");
  const pending = String(loc.pending ?? current);
  const locked = loc.locked === true;
  const restart = loc.restartRequired === true;
  const sourceText = locked
    ? "由插件配置文件里的 dataDir 指定"
    : loc.source === "pointer"
      ? "自定义位置"
      : "默认位置";

  // 新位置：点按钮弹系统文件夹选择框；弹不出来时可展开“手动填写”
  const dirInput = el("input", {
    type: "text",
    value: "",
    placeholder: "例如 D:\\Data\\memweave",
    "aria-label": t("data.newPath", state.lang),
    disabled: locked || state.readonly ? "disabled" : undefined,
  }) as HTMLInputElement;
  const chosen = el("span", { class: "mw-mono mw-path-chosen", text: "未选择" });
  const setChosen = (dir: string): void => {
    dirInput.value = dir;
    chosen.textContent = dir || "未选择";
    chosen.classList.toggle("mw-path-empty", !dir);
  };
  setChosen("");
  dirInput.addEventListener("input", () => {
    chosen.textContent = dirInput.value.trim() || "未选择";
    chosen.classList.toggle("mw-path-empty", !dirInput.value.trim());
  });
  const manual = el("details", { class: "mw-manual" }, [el("summary", { text: "手动填写路径" }), dirInput]) as HTMLDetailsElement;
  const pickBtn = el("button", {
    type: "button",
    text: "选择文件夹…",
    disabled: locked || state.readonly ? "disabled" : undefined,
  }) as HTMLButtonElement;
  pickBtn.addEventListener("click", () => {
    pickBtn.disabled = true;
    pickBtn.textContent = "请在弹出的窗口里选择…";
    void rpc("fs/pickDir", { initial: dirInput.value.trim() || current }).then((out) => {
      pickBtn.disabled = false;
      pickBtn.textContent = "选择文件夹…";
      const r = obj(out);
      if (r.ok === true && typeof r.dir === "string") {
        setChosen(r.dir);
        return;
      }
      if (r.code === "E_CANCEL") return;
      flash(String(r.message ?? "无法打开文件夹选择框，请手动填写路径"), "warn");
      manual.open = true;
      dirInput.focus();
    });
  });
  const modeCopy = el("input", { type: "radio", name: "mw-relocate-mode", value: "copy", checked: "checked" }) as HTMLInputElement;
  const modeUse = el("input", { type: "radio", name: "mw-relocate-mode", value: "use" }) as HTMLInputElement;

  const submit = (dir: string, mode: "copy" | "use"): void => {
    void rpc("data/relocate", { dir, mode }).then((out) => {
      if (!report(out)) return;
      const r = obj(out);
      flash(
        r.restartRequired === false
          ? "已经在使用这个位置"
          : (r.copied ? "已把记忆库复制到新位置。" : "已切换到新位置。") + "重启 DSH 后生效，原位置的数据会保留",
        r.restartRequired === false ? "ok" : "warn",
      );
      void refresh();
    });
  };

  const ro = locked || state.readonly ? "disabled" : undefined;
  return el("section", { class: "mw-item-card" }, [
    el("div", { class: "mw-row" }, [
      el("h4", { text: t("data.location", state.lang), style: "margin:0" }),
      badge(sourceText, "plain"),
      ...(restart ? [badge("重启 DSH 后切换到新位置", "warn")] : []),
    ]),
    el("p", { class: "mw-small", style: "margin:0", text: "人格和记忆都存在这个文件夹里。" }),
    el("div", { class: "mw-kv-grid" }, [
      kv("当前使用", current),
      ...(restart ? [kv("重启后使用", pending)] : []),
      kv("默认位置", String(loc.defaultDir ?? "-")),
    ]),
    locked
      ? el("p", { class: "mw-hint", text: "位置写在插件配置的 dataDir 里，这里不能改。" })
      : el("div", { class: "mw-col" }, [
          el("div", { class: "mw-field-row" }, [
            el("span", { class: "mw-field-label", text: t("data.newPath", state.lang) }),
            el("div", { class: "mw-path-pick" }, [pickBtn, chosen]),
          ]),
          manual,
          el("div", { class: "mw-row" }, [
            el("label", { class: "mw-check-row" }, [modeCopy, el("span", { text: "复制当前数据过去（推荐）" })]),
            el("label", { class: "mw-check-row" }, [modeUse, el("span", { text: "用那里已有的数据" })]),
          ]),
          el("div", { class: "mw-row" }, [
            el("button", {
              type: "button",
              class: "mw-primary",
              text: t("data.relocate", state.lang),
              disabled: ro,
              onclick: () => {
                const dir = dirInput.value.trim();
                if (!dir) {
                  flash("请先选择新的文件夹", "warn");
                  return;
                }
                const mode = modeUse.checked ? "use" : "copy";
                const msg = mode === "copy"
                  ? "将把当前记忆库复制到：\n" + dir + "\n\n重启 DSH 后改用新位置，原位置的数据不会删除。继续吗？"
                  : "重启 DSH 后将直接使用：\n" + dir + "\n里的记忆库（没有就新建空库），当前库不会带过去。继续吗？";
                if (window.confirm(msg)) submit(dir, mode);
              },
            }),
            ...(loc.source === "pointer" || restart
              ? [el("button", {
                  type: "button",
                  text: "恢复默认位置",
                  disabled: ro,
                  onclick: () => {
                    if (window.confirm("重启 DSH 后改回默认位置：\n" + String(loc.defaultDir ?? "") + "\n\n自定义位置里的数据会保留。继续吗？")) {
                      submit(String(loc.defaultDir ?? ""), "use");
                    }
                  },
                })]
              : []),
          ]),
          el("p", { class: "mw-hint", text: "重启 DSH 后生效，原位置的数据不会删除。" }),
        ]),
  ]);
}

export function pageData(): HTMLElement {
  const backups = (state.data.backups as Array<Record<string, unknown>>) ?? [];
  const settings = obj(state.data.settings);
  const status = state.status ?? {};
  const rollbackItems = (state.data.importRollbacks as Array<Record<string, unknown>>) ?? [];
  const availableRollback = rollbackItems.find((item) => item.rolledBackAt == null);
  if (!rollbackItems.some((item) => String(item.rollbackId ?? "") === importRollbackId)) {
    importRollbackId = String(availableRollback?.rollbackId ?? rollbackItems[0]?.rollbackId ?? "");
  }
  const selectedRollback = rollbackItems.find((item) => String(item.rollbackId ?? "") === importRollbackId);
  const scanBox = el("pre", { class: "mw-pre", text: "" });
  const rollbackSelect = el("select", { "aria-label": t("data.rollbackImport", state.lang) }) as HTMLSelectElement;
  for (const item of rollbackItems) {
    const id = String(item.rollbackId ?? "");
    const label = fmtTime(item.at) + " · " + id + (item.rolledBackAt == null ? "" : " · rolled back");
    const option = el("option", { value: id, text: label }) as HTMLOptionElement;
    option.selected = id === importRollbackId;
    rollbackSelect.appendChild(option);
  }
  rollbackSelect.addEventListener("change", () => { importRollbackId = rollbackSelect.value; });
  const backupList = el("div", { class: "mw-col" });
  if (String(state.data.backupError ?? "")) {
    backupList.appendChild(el("pre", { class: "mw-pre", text: String(state.data.backupError) }));
  } else if (backups.length === 0) {
    backupList.appendChild(el("p", { class: "mw-empty", text: t("common.empty", state.lang) }));
  }
  for (const backup of backups) {
    backupList.appendChild(el("div", { class: "mw-row mw-item" }, [
      el("span", { class: "mw-content", text: String(backup.name ?? "") + " · " + String(backup.size ?? "") + " " + t("common.bytes", state.lang) + " · " + fmtTime(backup.mtime) }),
      el("button", {
        type: "button",
        text: t("data.restoreBackup", state.lang),
        disabled: state.readonly ? "disabled" : undefined,
        onclick: () => {
          if (!dangerConfirm("RESTORE", t("data.restoreBackup", state.lang) + ": " + String(backup.name ?? ""))) return;
          void rpc("backup/restore", { path: String(backup.path ?? "") }).then((out) => {
            if (!report(out)) return;
            const result = obj(out);
            if (result.reloadOk === false) flash("Backup restored; prompt reload failed: " + String(result.reloadMessage ?? "restart DSH"), "warn");
            else flash(t("data.restoreBackup", state.lang) + " ok", "ok");
            void refresh();
          });
        },
      }),
    ]));
  }

  const fileInput = el("input", {
    type: "file",
    accept: ".json,application/json",
    onchange: (e: Event) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          importPayload = JSON.parse(String(reader.result ?? "")) as Record<string, unknown>;
          void rpc("import/scan", { payload: importPayload }).then((out) => {
            scanBox.textContent = t("data.scan", state.lang) + ": " + JSON.stringify(out, null, 2);
          });
        } catch {
          scanBox.textContent = "JSON 解析失败";
          importPayload = null;
        }
      };
      reader.readAsText(file);
    },
  });

  const body = el("div", { class: "mw-col" }, [
    locationSection(),
    el("h4", { text: t("data.backupTitle", state.lang) }),
    el("div", { class: "mw-row" }, [
      badge(t("data.schema", state.lang) + " v" + String(status.schemaVersion ?? "-"), "plain"),
      badge(t("overview.persona", state.lang) + " v" + String(status.personaVersion ?? "-"), "plain"),
    ]),
    el("div", { class: "mw-row" }, [
      el("button", {
        type: "button",
        text: t("data.backup", state.lang),
        disabled: state.readonly ? "disabled" : undefined,
        onclick: () => {
          void rpc("backup/now", { label: "ui" }).then((out) => {
            if (report(out, t("data.backup", state.lang) + " ok")) void refresh();
          });
        },
      }),
      el("button", {
        type: "button",
        text: t("data.export", state.lang),
        onclick: () => {
          void rpc("data/export", {}).then((out) => {
            if (report(out)) downloadJson("memweave-export.json", (out as { payload?: unknown }).payload ?? out);
          });
        },
      }),
    ]),
    backupList,
    // Markdown 镜像目录（派生视图，冲突以 SQLite 为准，可一键重建）
    el("h4", { text: t("data.mirror", state.lang) }),
    el("div", { class: "mw-row" }, [
      el("span", { class: "mw-small", text: String(obj(settings.mirror).dir ?? "-") }),
      el("button", {
        type: "button",
        text: t("data.mirrorRebuild", state.lang),
        disabled: state.readonly ? "disabled" : undefined,
        onclick: () => {
          void rpc("mirror/rebuild", {}).then((out) => {
            const r = obj(out);
            if (report(out)) {
              flash(
                t("data.mirrorRebuild", state.lang) + " ok · " + String(r.dir ?? "") + " · " + String(((r.files as unknown[]) ?? []).length),
                "ok",
              );
            }
          });
        },
      }),
    ]),
    el("h4", { text: t("data.import", state.lang) }),
    fileInput,
    scanBox,
    el("div", { class: "mw-row" }, [
      el("button", {
        type: "button",
        text: t("data.importRun", state.lang),
        disabled: state.readonly || !importPayload ? "disabled" : undefined,
        onclick: () => {
          if (!importPayload) return;
          if (!dangerConfirm("IMPORT", t("data.importRun", state.lang))) return;
          void rpc("import/run", { payload: importPayload }).then((out) => {
            const r = out as { ok?: boolean; rollbackId?: string };
            if (report(out, t("data.importRun", state.lang) + " ok")) {
              importRollbackId = String(r.rollbackId ?? "");
              void refresh();
            }
          });
        },
      }),
      rollbackSelect,
      el("button", {
        type: "button",
        text: t("data.rollbackImport", state.lang),
        disabled: state.readonly || !selectedRollback || selectedRollback.rolledBackAt != null ? "disabled" : undefined,
        onclick: () => {
          if (!importRollbackId) return;
          if (!dangerConfirm("ROLLBACK", t("data.rollbackImport", state.lang) + " " + importRollbackId)) return;
          void rpc("import/rollback", { rollbackId: importRollbackId }).then((out) => {
            if (report(out, t("data.rollbackImport", state.lang) + " ok")) {
              importRollbackId = "";
              void refresh();
            }
          });
        },
      }),
    ]),
    el("pre", { class: "mw-pre", text: String(state.data.rollbackError ?? "") }),
    el("button", {
      type: "button",
      text: t("data.reset", state.lang),
      disabled: state.readonly ? "disabled" : undefined,
      onclick: () => {
        if (!dangerConfirm("RESET", t("data.reset", state.lang))) return;
        void rpc("reset/run", { confirm: "RESET" }).then((out) => {
          if (!report(out)) return;
          const result = out as { reloadOk?: boolean; reloadMessage?: string };
          if (result.reloadOk === false) {
            flash("数据已重置，但 prompt 重载失败：" + String(result.reloadMessage ?? "请重启 DSH"), "warn");
          } else {
            flash(t("data.reset", state.lang) + " ok", "ok");
          }
          void refresh();
        });
      },
    }),
  ]);
  return el("section", { class: "mw-card" }, [el("h3", { text: t("nav.data", state.lang) }), body]);
}

// ---------- 高级 ----------

/** [[9,12],[14,18]] → 24 个布尔（与 dream.isPeakHour 同口径：a<=h<b，a>b 表示跨午夜） */
export function peakHoursToSet(ph: unknown): boolean[] {
  const on = new Array<boolean>(24).fill(false);
  for (const p of Array.isArray(ph) ? (ph as unknown[]) : []) {
    if (!Array.isArray(p) || p.length < 2) continue;
    const a = Math.max(0, Math.min(24, Math.trunc(num(p[0], 0))));
    const b = Math.max(0, Math.min(24, Math.trunc(num(p[1], 0))));
    for (let h = 0; h < 24; h += 1) if (a <= b ? h >= a && h < b : h >= a || h < b) on[h] = true;
  }
  return on;
}

/** 24 个布尔 → 连续区间（最后一段若连到 24 点且 0 点也选了，合并成跨午夜的一段） */
export function setToPeakHours(on: boolean[]): number[][] {
  const out: number[][] = [];
  let h = 0;
  while (h < 24) {
    if (!on[h]) {
      h += 1;
      continue;
    }
    const start = h;
    while (h < 24 && on[h]) h += 1;
    out.push([start, h]);
  }
  if (out.length >= 2 && out[0][0] === 0 && out[out.length - 1][1] === 24) {
    const first = out.shift() as number[];
    const last = out.pop() as number[];
    out.push([last[0], first[1]]);
  }
  return out;
}

/** 小时格子：点一下切换，支持按住拖动连选 */
function hourPicker(initial: boolean[], label: string): { node: HTMLElement; value: () => boolean[]; set: (next: boolean[]) => void } {
  const on = initial.slice();
  const cells: HTMLButtonElement[] = [];
  let dragTo: boolean | null = null;
  const paint = (h: number): void => cells[h].setAttribute("aria-pressed", on[h] ? "true" : "false");
  const grid = el("div", { class: "mw-hours", role: "group", "aria-label": label });
  // 冒泡一个 change 事件，让 watchEdits 感知到修改
  const changed = (): void => {
    grid.dispatchEvent(new Event("change", { bubbles: true }));
  };
  for (let h = 0; h < 24; h += 1) {
    const cell = el("button", {
      type: "button",
      class: "mw-hour",
      text: String(h),
      title: String(h).padStart(2, "0") + ":00–" + String(h + 1).padStart(2, "0") + ":00",
      "aria-label": String(h) + " 点",
    }) as HTMLButtonElement;
    cell.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      dragTo = !on[h];
      on[h] = dragTo;
      paint(h);
      changed();
    });
    cell.addEventListener("pointerenter", () => {
      if (dragTo === null || on[h] === dragTo) return;
      on[h] = dragTo;
      paint(h);
      changed();
    });
    cell.addEventListener("keydown", (e) => {
      if (e.key !== " " && e.key !== "Enter") return;
      e.preventDefault();
      on[h] = !on[h];
      paint(h);
      changed();
    });
    cells.push(cell);
    grid.appendChild(cell);
    paint(h);
  }
  window.addEventListener("pointerup", () => {
    dragTo = null;
  });
  const preset = (text: string, hours: number[]): HTMLElement =>
    el("button", {
      type: "button",
      text,
      onclick: () => {
        for (let h = 0; h < 24; h += 1) {
          on[h] = hours.includes(h);
          paint(h);
        }
        changed();
      },
    });
  const range = (a: number, b: number): number[] => Array.from({ length: b - a }, (_, i) => a + i);
  const node = el("div", { class: "mw-col", style: "gap:6px" }, [
    grid,
    el("div", { class: "mw-hours-tools" }, [
      preset("工作时间 9–18", range(9, 18)),
      preset("白天 8–23", range(8, 23)),
      preset("全部清空", []),
    ]),
  ]);
  return {
    node,
    value: () => on.slice(),
    // 「恢复默认」用：整体替换并通知 watchEdits
    set: (next: boolean[]) => {
      for (let h = 0; h < 24; h += 1) {
        on[h] = next[h] === true;
        paint(h);
      }
      changed();
    },
  };
}

/**
 * 敏感规则编辑器：内置规则开关（凭据类锁定）+ 自定义正则列表 + 试一试。
 * 校验与匹配和写入治理共用 core/sensitive，界面上看到的结果就是真实拦截结果。
 */
function sensitiveEditor(
  initialCustom: string[],
  initialDisabled: string[],
): { node: HTMLElement; value: () => { custom: string[]; disabled: string[] } } {
  const lang = state.lang;
  const zh = lang !== "en";
  const custom = initialCustom.slice();
  const disabled = new Set(initialDisabled);
  const root = el("section", { class: "mw-item-card mw-sens" });
  const changed = (): void => {
    root.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const reasonText = (r: string): string => t("advanced.sensReason." + r, lang);

  // 内置规则
  const builtinList = el("div", { class: "mw-sens-builtin" });
  for (const rule of BUILTIN_RULES) {
    const box = el("input", { type: "checkbox", "aria-label": zh ? rule.label.zh : rule.label.en }) as HTMLInputElement;
    box.checked = rule.locked || !disabled.has(rule.id);
    if (rule.locked) box.disabled = true;
    box.addEventListener("change", (e) => {
      e.stopPropagation();
      if (box.checked) disabled.delete(rule.id);
      else disabled.add(rule.id);
      runTest();
      changed();
    });
    builtinList.appendChild(
      el("label", { class: "mw-check-row mw-sens-rule" + (rule.locked ? " mw-sens-locked" : "") }, [
        box,
        el("span", { text: zh ? rule.label.zh : rule.label.en }),
        rule.locked ? el("span", { class: "mw-small", text: t("advanced.sensLocked", lang) }) : null,
      ]),
    );
  }

  // 自定义规则
  const customList = el("div", { class: "mw-sens-custom", role: "list" });
  const renderCustom = (): void => {
    customList.replaceChildren();
    if (custom.length === 0) {
      customList.appendChild(el("p", { class: "mw-small mw-sens-empty", text: t("advanced.sensNoCustom", lang) }));
      return;
    }
    custom.forEach((p, i) => {
      customList.appendChild(
        el("div", { class: "mw-sens-item", role: "listitem" }, [
          el("code", { class: "mw-sens-code", title: p, text: p }),
          el("button", {
            type: "button",
            class: "mw-sens-del",
            text: t("advanced.sensRemove", lang),
            "aria-label": t("advanced.sensRemove", lang) + " " + p,
            onclick: () => {
              custom.splice(i, 1);
              renderCustom();
              runTest();
              changed();
            },
          }),
        ]),
      );
    });
  };

  const addInput = el("input", {
    type: "text",
    placeholder: t("advanced.patternPlaceholder", lang),
    "aria-label": t("advanced.addPattern", lang),
    "data-nodirty": "1",
    maxlength: String(CUSTOM_RULE_LEN_MAX),
  }) as HTMLInputElement;
  const addMsg = el("span", { class: "mw-small mw-sens-msg", role: "status" });
  const addBtn = el("button", { type: "button", text: t("advanced.addPattern", lang), "data-nodirty": "1" }) as HTMLButtonElement;
  const tryAdd = (): void => {
    const p = addInput.value.trim();
    const check = checkCustomPattern(p);
    if (!check.ok) {
      addMsg.textContent = reasonText(check.reason);
      addMsg.dataset.tone = "bad";
      return;
    }
    if (custom.includes(p)) {
      addMsg.textContent = t("advanced.sensDuplicate", lang);
      addMsg.dataset.tone = "bad";
      return;
    }
    if (custom.length >= CUSTOM_RULE_MAX) {
      addMsg.textContent = t("advanced.sensTooMany", lang).replace("{n}", String(CUSTOM_RULE_MAX));
      addMsg.dataset.tone = "bad";
      return;
    }
    custom.push(p);
    addInput.value = "";
    addMsg.textContent = "";
    renderCustom();
    runTest();
    changed();
  };
  addBtn.addEventListener("click", tryAdd);
  addInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      tryAdd();
    }
  });
  // 边输入边提示正则是否有效
  addInput.addEventListener("input", () => {
    const p = addInput.value.trim();
    if (p.length === 0) {
      addMsg.textContent = "";
      return;
    }
    const check = checkCustomPattern(p);
    addMsg.textContent = check.ok ? t("advanced.sensValid", lang) : reasonText(check.reason);
    addMsg.dataset.tone = check.ok ? "ok" : "bad";
  });

  // 试一试：用当前（未保存）规则检测一段文字
  const testInput = el("input", {
    type: "text",
    placeholder: t("advanced.sensTestPlaceholder", lang),
    "aria-label": t("advanced.sensTest", lang),
    "data-nodirty": "1",
  }) as HTMLInputElement;
  const testOut = el("span", { class: "mw-small mw-sens-msg", role: "status" });
  const ruleName = (hit: string): string => {
    if (hit.startsWith("custom:")) return t("advanced.sensCustomHit", lang) + " " + hit.slice(7);
    const r = BUILTIN_RULES.find((x) => x.id === hit);
    return r ? (zh ? r.label.zh : r.label.en) : hit;
  };
  function runTest(): void {
    const text = testInput.value;
    if (text.trim().length === 0) {
      testOut.textContent = "";
      return;
    }
    const hit = matchSensitive(text, custom, [...disabled]);
    testOut.textContent = hit ? t("advanced.sensBlocked", lang) + ruleName(hit) : t("advanced.sensPassed", lang);
    testOut.dataset.tone = hit ? "bad" : "ok";
  }
  testInput.addEventListener("input", runTest);

  renderCustom();
  root.append(
    el("h4", { text: t("advanced.sensitivePatterns", lang) }),
    el("p", { class: "mw-small", text: t("advanced.sensitiveHint", lang) }),
    el("span", { class: "mw-field-label", text: t("advanced.builtinPatterns", lang) }),
    builtinList,
    el("span", { class: "mw-field-label", text: t("advanced.sensCustom", lang) }),
    customList,
    el("div", { class: "mw-sens-add" }, [addInput, addBtn]),
    addMsg,
    el("span", { class: "mw-field-label", text: t("advanced.sensTest", lang) }),
    testInput,
    testOut,
  );
  return { node: root, value: () => ({ custom: custom.slice(), disabled: [...disabled].sort() }) };
}

/**
 * 「待整理」卡片 —— S1 / S2 / 提示三个开关 + 待整理清单 + 「整理」按钮。
 * 清单只读；真正的补词 / 归纳由会话里的 AI 做（主人说「整理一下」），这里点条目可直接去记忆详情手动补词。
 */
function curateCard(
  settings: Record<string, unknown>,
  mkCheck: (key: string, on: unknown, label: string) => HTMLInputElement,
  mkNum: (key: string, value: unknown, label: string) => HTMLInputElement,
): HTMLElement {
  const lang = state.lang;
  const st = obj(settings.searchTerms);
  const ds = obj(settings.distill);
  const cu = obj(settings.curate);
  const chk = (key: string, on: unknown, label: string, desc: string): HTMLElement =>
    el("label", { class: "mw-check-row" }, [
      mkCheck(key, on !== false, t(label, lang)),
      el("span", { class: "mw-col", style: "gap:2px" }, [el("span", { text: t(label, lang) }), el("span", { class: "mw-small", text: t(desc, lang) })]),
    ]);
  const field = (key: string, v: unknown, label: string): HTMLElement =>
    el("label", { class: "mw-field-row" }, [el("span", { class: "mw-field-label", text: t(label, lang) }), mkNum(key, v, t(label, lang))]);

  const listBox = el("div", { class: "mw-col", style: "gap:6px" }, [el("span", { class: "mw-small", text: t("curate.loading", lang) })]);
  const clip = (s: unknown, n = 60): string => {
    const x = String(s ?? "").replace(/\s+/g, " ");
    return x.length > n ? x.slice(0, n) + "…" : x;
  };
  const openEntry = (id: string): void => {
    openMemoryDrawer(id);
    state.tab = "memory";
    void refresh();
  };
  const loadList = (): void => {
    void rpc("memory/backlog", {}).then((raw) => {
      const r = obj(raw);
      if (r.ok === false) {
        listBox.replaceChildren(el("span", { class: "mw-small", text: String(r.code ?? "E_UNAVAILABLE") + ": " + String(r.message ?? "") }));
        return;
      }
      const counts = obj(r.counts);
      const terms = Array.isArray(r.terms) ? (r.terms as Array<Record<string, unknown>>) : [];
      const groups = Array.isArray(r.groups) ? (r.groups as Array<Record<string, unknown>>) : [];
      const rows: HTMLElement[] = [
        el("div", { class: "mw-row" }, [
          badge(t("curate.termsCount", lang) + " " + num(counts.terms), num(counts.terms) > 0 ? "warn" : "plain"),
          badge(t("curate.groupsCount", lang) + " " + num(counts.groups), num(counts.groups) > 0 ? "warn" : "plain"),
        ]),
      ];
      if (terms.length > 0) {
        rows.push(el("span", { class: "mw-field-label", text: t("curate.termsList", lang) }));
        for (const e of terms.slice(0, 8)) {
          rows.push(
            el("button", { type: "button", class: "mw-curate-row", title: t("curate.openHint", lang), onclick: () => openEntry(String(e.id)) }, [
              badge(t("option.level." + String(e.level), lang), "plain"),
              el("span", { text: clip(e.content) }),
            ]),
          );
        }
        if (num(counts.terms) > terms.slice(0, 8).length) rows.push(el("span", { class: "mw-small", text: t("curate.more", lang) }));
      }
      if (groups.length > 0) {
        rows.push(el("span", { class: "mw-field-label", text: t("curate.groupsList", lang) }));
        for (const g of groups) {
          const members = Array.isArray(g.members) ? (g.members as Array<Record<string, unknown>>) : [];
          rows.push(
            el("div", { class: "mw-curate-group" }, [
              el("span", { class: "mw-small", text: t("curate.groupOf", lang) + " " + members.length + (g.reason ? " · " + String(g.reason) : "") }),
              ...members.slice(0, 4).map((m) =>
                el("button", { type: "button", class: "mw-curate-row", title: t("curate.openHint", lang), onclick: () => openEntry(String(m.id)) }, [el("span", { text: clip(m.content, 50) })]),
              ),
            ]),
          );
        }
      }
      if (terms.length === 0 && groups.length === 0) rows.push(el("span", { class: "mw-small", text: t("curate.empty", lang) }));
      listBox.replaceChildren(...rows);
    });
  };
  loadList();

  const runBtn = el("button", {
    type: "button",
    text: t("curate.run", lang),
    title: t("curate.runHint", lang),
    disabled: state.readonly ? "disabled" : undefined,
    onclick: () => {
      (runBtn as HTMLButtonElement).disabled = true;
      void rpc("dream/run", { force: true }).then((raw) => {
        (runBtn as HTMLButtonElement).disabled = state.readonly;
        const r = obj(raw);
        if (r.ok === false) {
          report(r);
          return;
        }
        if (r.ran === false) {
          flash(t("curate.notRun", lang) + String(r.reason ?? ""), "warn");
        } else {
          flash(t("curate.ran", lang), "ok");
        }
        loadList();
      });
    },
  }) as HTMLButtonElement;

  return el("section", { class: "mw-item-card" }, [
    el("h4", { text: t("advanced.curateCard", lang) }),
    el("p", { class: "mw-small", text: t("advanced.curateCardHint", lang) }),
    chk("searchTerms.enabled", st.enabled, "advanced.searchTerms", "advanced.searchTermsDesc"),
    chk("groupDistill.enabled", ds.enabled, "advanced.sessionDistill", "advanced.sessionDistillDesc"),
    chk("curate.enabled", cu.enabled, "advanced.curate", "advanced.curateDesc"),
    el("label", { class: "mw-check-row" }, [mkCheck("curate.autoProcess", cu.autoProcess === true, t("advanced.curateAuto", lang)), el("span", { text: t("advanced.curateAuto", lang) })]),
    el("div", { class: "mw-row" }, [
      field("searchTerms.backfillPerDream", st.backfillPerDream ?? 20, "advanced.termsPerDream"),
      field("groupDistill.perDream", ds.perDream ?? 3, "advanced.groupsPerDream"),
    ]),
    el("div", { class: "mw-row", "data-nodirty": "1" }, [runBtn, el("span", { class: "mw-small", text: t("curate.runHint", lang) })]),
    listBox,
  ]);
}

export function pageAdvanced(): HTMLElement {
  const settings = obj(state.data.settings);
  const recall = obj(settings.recall);
  const weights = obj(recall.weights);
  const lifecycle = obj(settings.lifecycle);
  const halfLife = obj(lifecycle.halfLifeDays);
  const co = obj(obj(settings.links).coRecall);
  const boost = obj(lifecycle.boost);
  const distill = obj(lifecycle.distill);
  const emotion = obj(settings.emotion);
  const intent = obj(recall.intent);
  const dream = obj(settings.dream);
  const quote = obj(settings.quote);
  const promise = obj(settings.promise);
  const calendar = obj(settings.calendar);

  const inputs: Record<string, HTMLInputElement | HTMLSelectElement> = {};
  // 留空 = 宿主时区（占位符显示当前取到的时区）
  const hostTz = (() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch {
      return "UTC";
    }
  })();
  const tzInput = el("input", {
    type: "text",
    value: typeof calendar.timeZone === "string" ? calendar.timeZone : "",
    placeholder: hostTz,
    "aria-label": t("advanced.calendarTz", state.lang),
    style: "width:100%",
  }) as HTMLInputElement;
  inputs["calendar.timeZone"] = tzInput;
  const mkNum = (key: string, value: unknown, label: string): HTMLInputElement => {
    const input = el("input", { type: "number", value: String(num(value, 0)), "aria-label": label, style: "width:100%" }) as HTMLInputElement;
    inputs[key] = input;
    return input;
  };
  const mkSlider = (key: string, value: unknown, label: string): HTMLElement => {
    const input = el("input", {
      type: "range",
      min: "0",
      max: "2",
      step: "0.1",
      value: String(num(value, 1)),
      class: "mw-slider",
      "aria-label": label,
    }) as HTMLInputElement;
    const valueLabel = el("span", { class: "mw-small", text: label + "：" + input.value });
    input.addEventListener("input", () => {
      valueLabel.textContent = label + "：" + input.value;
    });
    inputs[key] = input;
    return el("label", { class: "mw-slider-control" }, [valueLabel, input]);
  };
  const mkCheck = (key: string, on: unknown, label: string): HTMLInputElement => {
    const box = el("input", { type: "checkbox", checked: on ? "checked" : undefined, "aria-label": label }) as HTMLInputElement;
    inputs[key] = box;
    return box;
  };

  const governance = obj(settings.governance ?? {});
  const sensitive = sensitiveEditor(
    Array.isArray(governance.sensitivePatterns) ? governance.sensitivePatterns.filter((p): p is string => typeof p === "string" && p !== "default") : [],
    Array.isArray(governance.disabledSensitive) ? governance.disabledSensitive.filter((p): p is string => typeof p === "string") : [],
  );

  const peak = hourPicker(peakHoursToSet(dream.peakHours), t("advanced.peakHours", state.lang));

  const logSelect = el("select", { "aria-label": t("advanced.log", state.lang) }) as HTMLSelectElement;
  for (const lv of ["debug", "info", "warn", "error"]) {
    const opt = el("option", { value: lv, text: t("option.log." + lv, state.lang) }) as HTMLOptionElement;
    if (String(settings.logLevel ?? "info") === lv) opt.selected = true;
    logSelect.appendChild(opt);
  }
  inputs.logLevel = logSelect;

  const form = el("div", { class: "mw-col" }, [
    el("section", { class: "mw-item-card" }, [
      el("h4", { text: t("advanced.recall", state.lang) }),
      mkSlider("w.keyword", weights.keyword, t("advanced.weightKeyword", state.lang)),
      mkSlider("w.link", weights.link, t("advanced.weightLink", state.lang)),
      el("label", { class: "mw-field-row" }, [el("span", { class: "mw-field-label", text: t("advanced.rrfK", state.lang) }), mkNum("recall.rrfK", recall.rrfK, t("advanced.rrfK", state.lang))]),
      el("label", { class: "mw-field-row" }, [
        el("span", { class: "mw-field-label", text: t("advanced.semanticMinScore", state.lang) }),
        mkNum("recall.semanticMinScore", recall.semanticMinScore ?? 0.42, t("advanced.semanticMinScore", state.lang)),
      ]),
      el("p", { class: "mw-small", text: t("advanced.semanticMinScoreHint", state.lang) }),
    ]),
    // 每个新机制一个开关（默认开）
    el("section", { class: "mw-item-card" }, [
      el("h4", { text: t("advanced.quality", state.lang) }),
      el("p", { class: "mw-small", text: t("advanced.qualityHint", state.lang) }),
      ...([
        ["q.autoLink", obj(obj(settings.links).autoLink).enabled, "advanced.autoLink"],
        ["q.containment", obj(obj(settings.write).containment).enabled, "advanced.containment"],
        ["q.surprise", obj(obj(settings.write).surprise).enabled, "advanced.surprise"],
        ["q.sourceWeight", obj(obj(settings.write).sourceWeight).enabled, "advanced.sourceWeight"],
        ["q.diversity", obj(recall.diversity).enabled, "advanced.diversity"],
        ["q.rumination", obj(recall.rumination).enabled, "advanced.rumination"],
      ] as Array<[string, unknown, string]>).map(([key, on, label]) =>
        el("label", { class: "mw-check-row" }, [mkCheck(key, on !== false, t(label, state.lang)), el("span", { text: t(label, state.lang) })]),
      ),
      el("label", { class: "mw-field-row" }, [el("span", { class: "mw-field-label", text: t("advanced.logKeepDays", state.lang) }), mkNum("recall.logKeepDays", recall.logKeepDays ?? 90, t("advanced.logKeepDays", state.lang))]),
    ]),
    // 反思提示 / 压缩后重放 / 文件日志
    el("section", { class: "mw-item-card" }, [
      el("h4", { text: t("advanced.sessionAids", state.lang) }),
      el("div", { class: "mw-row" }, [
        el("label", { class: "mw-check-row" }, [mkCheck("reflect.enabled", obj(settings.reflect).enabled !== false, t("advanced.reflect", state.lang)), el("span", { text: t("advanced.reflect", state.lang) })]),
        el("label", { class: "mw-field-row" }, [el("span", { class: "mw-field-label", text: t("advanced.reflectSteps", state.lang) }), mkNum("reflect.afterToolSteps", obj(settings.reflect).afterToolSteps ?? 7, t("advanced.reflectSteps", state.lang))]),
      ]),
      el("label", { class: "mw-check-row" }, [mkCheck("replay.enabled", obj(settings.replay).enabled !== false, t("advanced.replay", state.lang)), el("span", { text: t("advanced.replay", state.lang) })]),
      el("div", { class: "mw-row" }, [
        el("label", { class: "mw-field-row" }, [el("span", { class: "mw-field-label", text: t("advanced.logFileMb", state.lang) }), mkNum("log.maxFileMb", obj(settings.log).maxFileMb ?? 5, t("advanced.logFileMb", state.lang))]),
        el("label", { class: "mw-field-row" }, [el("span", { class: "mw-field-label", text: t("advanced.logKeep", state.lang) }), mkNum("log.keepDays", obj(settings.log).keepDays ?? 7, t("advanced.logKeep", state.lang))]),
      ]),
      el("p", { class: "mw-small", text: t("advanced.logHint", state.lang) }),
    ]),
    // 整理（dream）增强
    (() => {
      const lc = obj(settings.lifecycle);
      const bo = obj(lc.boost);
      const di = obj(lc.distill);
      const cr = obj(obj(settings.links).coRecall);
      const num = (key: string, v: unknown, label: string): HTMLElement =>
        el("label", { class: "mw-field-row" }, [el("span", { class: "mw-field-label", text: t(label, state.lang) }), mkNum(key, v, t(label, state.lang))]);
      const chk = (key: string, on: unknown, label: string): HTMLElement =>
        el("label", { class: "mw-check-row" }, [mkCheck(key, on !== false, t(label, state.lang)), el("span", { text: t(label, state.lang) })]);
      return el("section", { class: "mw-item-card" }, [
        el("h4", { text: t("advanced.dreamC", state.lang) }),
        el("p", { class: "mw-small", text: t("advanced.dreamCHint", state.lang) }),
        el("div", { class: "mw-row" }, [chk("coRecall.enabled", cr.enabled, "advanced.coRecall"), num("coRecall.step", cr.step ?? 0.1, "advanced.coRecallStep"), num("coRecall.cap", cr.cap ?? 2, "advanced.coRecallCap"), num("coRecall.decayDays", cr.decayDays ?? 90, "advanced.coRecallDecay")]),
        el("div", { class: "mw-row" }, [chk("boost.enabled", bo.enabled, "advanced.boost"), num("boost.minHits", bo.minHits ?? 3, "advanced.boostHits"), num("boost.minSessions", bo.minSessions ?? 2, "advanced.boostSessions"), num("boost.decayDays", bo.decayDays ?? 90, "advanced.boostDecay")]),
        el("div", { class: "mw-row" }, [chk("distill.enabled", di.enabled, "advanced.distill"), num("distill.topicsPerProject", di.topicsPerProject ?? 5, "advanced.distillTopics"), num("distill.crossProjects", di.crossProjects ?? 3, "advanced.distillProjects")]),
        el("div", { class: "mw-row" }, [num("lifecycle.staleAskDays", lc.staleAskDays ?? 7, "advanced.staleAskDays"), num("lifecycle.maxCandidatesPerDream", lc.maxCandidatesPerDream ?? 5, "advanced.maxCandidates")]),
      ]);
    })(),
    el("section", { class: "mw-item-card" }, [
      el("h4", { text: t("advanced.halfLife", state.lang) }),
      el("div", { class: "mw-option-grid" }, [
        ...["topic", "fact", "project", "user", "soul", "lesson", "rules"].map((lv) =>
          el("label", { class: "mw-col" }, [el("span", { class: "mw-field-label", text: t("option.level." + lv, state.lang) }), mkNum("halfLife." + lv, halfLife[lv], t("option.level." + lv, state.lang))]),
        ),
      ]),
      el("label", { class: "mw-field-row" }, [el("span", { class: "mw-field-label", text: t("advanced.coldMonths", state.lang) }), mkNum("lifecycle.coldMemoryMonths", lifecycle.coldMemoryMonths, t("advanced.coldMonths", state.lang))]),
      el("label", { class: "mw-field-row" }, [el("span", { class: "mw-field-label", text: t("advanced.decayFloor", state.lang) }), mkNum("lifecycle.decayFloor", lifecycle.decayFloor, t("advanced.decayFloor", state.lang))]),
      el("div", { class: "mw-row" }, [
        el("label", { class: "mw-check-row" }, [mkCheck("lifecycle.mergeOnDream", lifecycle.mergeOnDream, t("advanced.mergeOnDream", state.lang)), el("span", { text: t("advanced.mergeOnDream", state.lang) })]),
        el("label", { class: "mw-check-row" }, [mkCheck("lifecycle.autoDream", lifecycle.autoDream, t("advanced.autoDream", state.lang)), el("span", { text: t("advanced.autoDream", state.lang) })]),
      ]),
    ]),
    // （这里原先还有一张重复的「整理增强」卡片，输入键与上面那张不同、保存时不读，改了不生效：已删）
    el("section", { class: "mw-item-card" }, [
      el("h4", { text: t("advanced.emotion", state.lang) }),
      el("div", { class: "mw-row" }, [
        el("label", { class: "mw-check-row" }, [mkCheck("emotion.enabled", emotion.enabled, t("advanced.enabled", state.lang)), el("span", { text: t("advanced.enabled", state.lang) })]),
        el("label", { class: "mw-field-row" }, [el("span", { class: "mw-field-label", text: t("advanced.emotionArousal", state.lang) }), mkNum("emotion.flashArousal", emotion.flashArousal, t("advanced.emotionArousal", state.lang))]),
      ]),
      el("div", { class: "mw-row" }, [
        el("label", { class: "mw-field-row" }, [el("span", { class: "mw-field-label", text: t("advanced.emotionCap", state.lang) }), mkNum("emotion.dailyFlashCap", emotion.dailyFlashCap, t("advanced.emotionCap", state.lang))]),
        el("label", { class: "mw-field-row" }, [el("span", { class: "mw-field-label", text: t("advanced.emotionFactor", state.lang) }), mkNum("emotion.factor", emotion.factor, t("advanced.emotionFactor", state.lang))]),
      ]),
      el("div", { class: "mw-row" }, [
        el("label", { class: "mw-check-row" }, [mkCheck("emotion.residue.enabled", obj(emotion.residue).enabled === true, t("advanced.residue", state.lang)), el("span", { text: t("advanced.residue", state.lang) })]),
        el("label", { class: "mw-field-row" }, [el("span", { class: "mw-field-label", text: t("advanced.residueFloor", state.lang) }), mkNum("emotion.residue.floor", obj(emotion.residue).floor ?? 0.55, t("advanced.residueFloor", state.lang))]),
      ]),
    ]),
    el("section", { class: "mw-item-card" }, [
      el("h4", { text: t("advanced.promise", state.lang) }),
      el("p", { class: "mw-small", text: t("advanced.promiseHint", state.lang) }),
      el("div", { class: "mw-row" }, [
        el("label", { class: "mw-check-row" }, [mkCheck("promise.enabled", promise.enabled !== false, t("advanced.enabled", state.lang)), el("span", { text: t("advanced.enabled", state.lang) })]),
        el("label", { class: "mw-field-row" }, [el("span", { class: "mw-field-label", text: t("advanced.promiseLookahead", state.lang) }), mkNum("promise.surfaceLookaheadDays", promise.surfaceLookaheadDays ?? 7, t("advanced.promiseLookahead", state.lang))]),
        el("label", { class: "mw-field-row" }, [el("span", { class: "mw-field-label", text: t("advanced.promiseGrace", state.lang) }), mkNum("promise.graceDays", promise.graceDays ?? 3, t("advanced.promiseGrace", state.lang))]),
      ]),
      el("div", { class: "mw-row" }, [
        el("label", { class: "mw-check-row" }, [mkCheck("promise.affectRelation", promise.affectRelation === true, t("advanced.promiseRelation", state.lang)), el("span", { text: t("advanced.promiseRelation", state.lang) })]),
      ]),
    ]),
    el("section", { class: "mw-item-card" }, [
      el("h4", { text: t("advanced.calendar", state.lang) }),
      el("p", { class: "mw-small", text: t("advanced.calendarHint", state.lang) }),
      el("div", { class: "mw-row" }, [
        el("label", { class: "mw-check-row" }, [mkCheck("calendar.enabled", calendar.enabled !== false, t("advanced.enabled", state.lang)), el("span", { text: t("advanced.enabled", state.lang) })]),
        el("label", { class: "mw-field-row" }, [el("span", { class: "mw-field-label", text: t("advanced.calendarLookahead", state.lang) }), mkNum("calendar.lookaheadDays", calendar.lookaheadDays ?? 3, t("advanced.calendarLookahead", state.lang))]),
      ]),
      el("label", { class: "mw-field-row" }, [el("span", { class: "mw-field-label", text: t("advanced.calendarTz", state.lang) }), tzInput]),
    ]),
    el("section", { class: "mw-item-card" }, [
      el("h4", { text: t("advanced.intent", state.lang) }),
      el("div", { class: "mw-row" }, [
        el("label", { class: "mw-check-row" }, [mkCheck("recall.intent.enabled", intent.enabled, t("advanced.enabled", state.lang)), el("span", { text: t("advanced.enabled", state.lang) })]),
        el("label", { class: "mw-field-row" }, [el("span", { class: "mw-field-label", text: t("advanced.intentFactor", state.lang) }), mkNum("recall.intent.factor", intent.factor, t("advanced.intentFactor", state.lang))]),
      ]),
    ]),
    el("section", { class: "mw-item-card" }, [
      el("h4", { text: t("advanced.dream", state.lang) }),
      el("div", { class: "mw-row" }, [
        el("label", { class: "mw-check-row" }, [mkCheck("dream.enabled", dream.enabled, t("advanced.enabled", state.lang)), el("span", { text: t("advanced.enabled", state.lang) })]),
        el("label", { class: "mw-field-row" }, [el("span", { class: "mw-field-label", text: t("advanced.idleMinutes", state.lang) }), mkNum("dream.idleMinutes", dream.idleMinutes, t("advanced.idleMinutes", state.lang))]),
      ]),
      el("div", { class: "mw-col", style: "gap:4px" }, [
        el("span", { class: "mw-field-label", text: t("advanced.peakHours", state.lang) }),
        el("span", { class: "mw-small", text: "选中的小时不做整理，可拖动连选。" }),
        peak.node,
      ]),
    ]),
    // 向量检索是可配置的（开关 + 服务地址 / 模型 / 密钥 / 维度）
    (() => {
      const st = obj(state.status);
      const backendText = readableBackend(String(st.vectorBackend ?? "disabled"), st.sqliteVecSource);
      const stats = obj(st.vectorStats);
      const injected = obj(st.embeddingProvider);
      const route = obj(st.vectorRoute);
      const settings = obj(st.embeddingSettings);
      const hasProvider = Boolean(injected.provider);
      const ready = route.enabled === true;
      const userOn = settings.enabled === undefined ? hasProvider : settings.enabled !== false;
      const tone = ready ? "plain" : "warn";
      const providerName = String(injected.provider ?? "");
      const providerText = hasProvider
        ? providerName === "local-model"
          ? t("advanced.vectorSearch.modelname." + String(injected.model), state.lang) +
            " · " + String(injected.dimensions) + "d"
          : providerName === "local-hash"
            ? t("advanced.vectorSearch.mode.local", state.lang) + " · " + String(injected.dimensions) + "d"
            : providerName + " / " + String(injected.model) + " · " + String(injected.dimensions) + "d"
        : t("advanced.vectorSearch.providerNone", state.lang);
      const reasonKey =
        route.reason === "no-backend"
          ? "advanced.vectorSearch.reasonNoBackend"
          : route.reason === "no-provider"
            ? "advanced.vectorSearch.reasonNoProvider"
            : route.reason === "disabled"
              ? "advanced.vectorSearch.reasonDisabled"
              : route.reason === "ready"
                ? "advanced.vectorSearch.reasonReady"
                : "advanced.vectorSearch.reasonNotConfigured";
      // 自动探测只在「还没配」时有意义；已关闭 / 已就绪就不再提示去探测
      const discovery = obj(st.embeddingDiscovery);
      const discoveryText =
        ready || hasProvider
          ? ""
          : route.reason === "disabled"
            ? ""
            : discovery.status === "pending"
              ? t("advanced.vectorSearch.discovery.pending", state.lang)
              : discovery.status === "none"
                ? t("advanced.vectorSearch.discovery.none", state.lang)
                : discovery.status === "failed"
                  ? t("advanced.vectorSearch.discovery.failed", state.lang) + " " + String(discovery.message ?? "")
                  : "";

      const input = (kind: string, value: string, placeholder: string): HTMLInputElement =>
        el("input", { type: kind, class: "mw-input", value, placeholder }) as HTMLInputElement;
      const baseUrl = input("text", String(settings.baseUrl ?? ""), "http://127.0.0.1:11434/v1");
      const model = input("text", String(settings.model ?? ""), "nomic-embed-text");
      const apiKey = input(
        "password",
        "",
        settings.hasApiKey
          ? t("advanced.vectorSearch.apiKeyPlaceholder", state.lang)
          : "sk-…",
      );
      const dimensions = input(
        "text",
        "",
        t("advanced.vectorSearch.dimensionsHint", state.lang) +
          (settings.dimensions == null ? "" : " · 上次 " + String(settings.dimensions)),
      );

      /**
       * 三条来源做成单选卡片：选哪条，下面就只显示那条的配置。
       * 之前是一个下拉 + 三套表单同时铺开（本地模型的时候，服务地址 / 模型 / 维度 / 密钥
       * 全是灰的却照样占位），而且「选择模型」和「模型」两个控件重名，看不出该填哪个。
       */
      const savedProvider = String(settings.provider ?? "");
      // local-hash 只在自动降级时才注入，不给用户选；默认「本地模型」
      const initialMode =
        savedProvider === "local-model"
          ? "local-model"
          : savedProvider === "openai-compatible" || savedProvider
            ? "openai-compatible"
            : hasProvider && providerName === "local-model"
              ? "local-model"
              : hasProvider || String(settings.baseUrl ?? "")
                ? "openai-compatible"
                : "local-model";

      const sources: Array<{ value: string; title: string; desc: string }> = [
        {
          value: "local-model",
          title: t("advanced.vectorSearch.mode.model", state.lang),
          desc: t("advanced.vectorSearch.mode.modelHint", state.lang),
        },
        {
          value: "openai-compatible",
          title: t("advanced.vectorSearch.mode.http", state.lang),
          desc: t("advanced.vectorSearch.mode.httpHint", state.lang),
        },
      ];
      const modeRadios: HTMLInputElement[] = [];
      const sourceList = el("div", { class: "mw-col", style: "gap:0.35rem;" });
      for (const src of sources) {
        const radio = el("input", { type: "radio", name: "mw-embed-source", value: src.value }) as HTMLInputElement;
        radio.checked = src.value === initialMode;
        modeRadios.push(radio);
        const active = hasProvider && providerName === src.value;
        sourceList.appendChild(
          el("label", { class: "mw-pick-row" + (src.value === initialMode ? " mw-picked" : "") }, [
            radio,
            el("span", { class: "mw-pick-body" }, [
              el("span", { class: "mw-field-label", text: src.title }),
              el("span", { class: "mw-small", text: src.desc }),
            ]),
            active ? el("span", { class: "mw-pick-side" }, [badge(t("advanced.vectorSearch.inUse", state.lang), "ok")]) : null,
          ]),
        );
        radio.addEventListener("change", () => {
          for (const r of modeRadios) r.closest("label")?.classList.toggle("mw-picked", r.checked);
        });
      }
      const currentMode = (): string => modeRadios.find((r) => r.checked)?.value ?? "local-model";

      const field = (label: string, control: HTMLElement, hint?: string): HTMLElement =>
        el("label", { class: "mw-col", style: "gap:0.25rem; margin-bottom:0.5rem;" }, [
          el("span", { class: "mw-field-label", text: label }),
          control,
          hint ? el("span", { class: "mw-small", text: hint }) : null,
        ]);

      /**
       * 本地模型：可选清单 + 硬件要求 + 安装状态 + 下载进度。
       * 关键点：所有元素只建一次，之后只改文字/宽度。之前每轮刷新都重建整块 DOM
       * 换页回来才看得到进度，下载中连下拉都会被重置；现在点下按钮就地变成进度条。
       */
      const modelBox = el("div", { class: "mw-col", style: "gap:0.45rem;" });
      let pickedModel = String(settings.model ?? "");
      let pollTimer: number | null = null;
      let lastPct = 0;
      const stopPoll = (): void => {
        if (pollTimer !== null) {
          window.clearInterval(pollTimer);
          pollTimer = null;
        }
      };
      const sizeText = (bytes: number): string =>
        bytes >= 1024 * 1024 ? (bytes / 1024 / 1024).toFixed(1) + " MB" : Math.round(bytes / 1024) + " KB";
      const modelName = (id: string): string => t("advanced.vectorSearch.modelname." + id, state.lang);

      /**
       * 一行一个模型，名字 / 体积 / 内存要求 / 维度 / 语言 / 说明 / 状态全在下载前可见。
       * 用单选列表而不是下拉：用户问「这几个模型要什么配置」，下拉里塞不下这些字。
       */
      const modelList = el("div", { class: "mw-col", style: "gap:0.35rem;" });
      const modelState = el("div", { class: "mw-row", style: "gap:0.4rem; flex-wrap:wrap;" });
      const barWrap = el("div", { class: "mw-bar", style: "height:8px; display:none;" });
      const barFill = el("span", { class: "mw-bar-fill" });
      barWrap.appendChild(barFill);
      const barText = el("p", { class: "mw-small" });
      const modelNote = el("p", { class: "mw-small" });
      const downBtn = el("button", {
        class: "mw-btn mw-btn-primary",
        text: t("advanced.vectorSearch.model.download", state.lang),
      });
      const recheckBtn = el("button", { class: "mw-btn", text: t("advanced.vectorSearch.model.recheck", state.lang) });
      const removeBtn = el("button", { class: "mw-btn", text: t("advanced.vectorSearch.model.remove", state.lang) });
      modelBox.append(
        modelList,
        modelState,
        barWrap,
        barText,
        el("div", { class: "mw-btn-row" }, [downBtn, recheckBtn, removeBtn]),
        modelNote,
      );

      interface ModelRow {
        row: HTMLElement;
        radio: HTMLInputElement;
        title: HTMLElement;
        meta: HTMLElement;
        state: HTMLElement;
      }
      const modelRows = new Map<string, ModelRow>();
      const buildModelRow = (id: string): ModelRow => {
        const radio = el("input", { type: "radio", name: "mw-model-pick", value: id }) as HTMLInputElement;
        const title = el("span", { class: "mw-field-label" });
        const meta = el("span", { class: "mw-small" });
        const state = el("span", { class: "mw-badge mw-plain" });
        const row = el(
          "label",
          { class: "mw-pick-row" },
          [
            radio,
            el("span", { class: "mw-pick-body" }, [title, meta]),
            el("span", { class: "mw-pick-side" }, [state]),
          ],
        );
        radio.addEventListener("change", () => {
          if (radio.checked) void refreshModelBox(id);
        });
        const built: ModelRow = { row, radio, title, meta, state };
        modelRows.set(id, built);
        return built;
      };

      /** 更新（必要时新建）每个模型那一行；只在文字变了才写 textContent，避免每轮重排 */
      const paintModels = (models: Array<Record<string, unknown>>, selectedId: string): void => {
        const ids = models.map((m) => String(m.id ?? ""));
        for (const [id, r] of Array.from(modelRows.entries())) {
          if (!ids.includes(id)) {
            r.row.remove();
            modelRows.delete(id);
          }
        }
        models.forEach((m, i) => {
          const id = String(m.id ?? "");
          const r = modelRows.get(id) ?? buildModelRow(id);
          const want = modelList.children[i] ?? null;
          if (want !== r.row) modelList.insertBefore(r.row, want);
          r.radio.checked = id === selectedId;
          r.row.classList.toggle("mw-picked", id === selectedId);
          const title = modelName(id) + " · " + sizeText(num(m.approxBytes));
          if (r.title.textContent !== title) r.title.textContent = title;
          const meta = [
            t("advanced.vectorSearch.model.req.ram", state.lang).replace("{gb}", String(num(m.ramGb, 4))),
            t("advanced.vectorSearch.model.req.dim", state.lang).replace("{dim}", String(num(m.dimensions))),
            t("advanced.vectorSearch.modelang." + String(m.langs ?? "multi"), state.lang),
            t("advanced.vectorSearch.modeldesc." + id, state.lang),
          ]
            .filter(Boolean)
            .join(" · ");
          if (r.meta.textContent !== meta) r.meta.textContent = meta;
          const running = m.downloading === true || m.installing === true;
          const done = num(m.bytesDone);
          const total = Math.max(1, num(m.bytesTotal, num(m.approxBytes, 1)));
          const tone = m.installed === true ? "ok" : running ? "plain" : "warn";
          const stateText =
            m.installed === true
              ? t("advanced.vectorSearch.model.rowInstalled", state.lang)
              : running
                ? t("advanced.vectorSearch.model.rowBusy", state.lang).replace(
                    "{pct}",
                    String(Math.round((done / total) * 100)),
                  )
                : t("advanced.vectorSearch.model.rowMissing", state.lang);
          r.state.className = "mw-badge mw-" + tone;
          if (r.state.textContent !== stateText) r.state.textContent = stateText;
        });
      };

      /** 把一份状态画进已经存在的元素里（不重建，不闪，不丢焦点） */
      const paintModel = (st: Record<string, unknown> | null): void => {
        if (!st || st.ok === false) {
          modelList.innerHTML = "";
          modelRows.clear();
          modelState.innerHTML = "";
          modelState.appendChild(badge(t("advanced.vectorSearch.model.unknown", state.lang), "warn"));
          barWrap.style.display = "none";
          barText.style.display = "none";
          barText.textContent = "";
          downBtn.style.display = "none";
          recheckBtn.style.display = "";
          removeBtn.style.display = "none";
          modelNote.style.display = "none";
          return;
        }
        const models = Array.isArray(st.models) ? (st.models as Array<Record<string, unknown>>) : [];
        const selectedId = String(st.id ?? "");
        pickedModel = selectedId;
        const current = models.find((m) => String(m.id ?? "") === selectedId) ?? st;
        const installed = st.installed === true;
        const busy = st.downloading === true || st.installing === true;

        paintModels(models, selectedId);

        // 进度条 + 百分比；文件名与文件计数拿不到时（刚开始）就不写，免得出现「（0/0 个文件）」
        if (busy) {
          const done = num(st.bytesDone);
          const total = Math.max(1, num(st.bytesTotal, num(current.approxBytes, 1)));
          lastPct = Math.max(0, Math.min(100, Math.round((done / total) * 100)));
          barFill.style.width = lastPct + "%";
          barWrap.style.display = "";
          const head = t("advanced.vectorSearch.model.progress", state.lang).replace("{pct}", String(lastPct));
          const files = num(st.totalFiles) > 0
            ? t("advanced.vectorSearch.model.progressFile", state.lang)
                .replace("{file}", String(st.currentFile ?? ""))
                .replace("{done}", String(num(st.doneFiles)))
                .replace("{total}", String(num(st.totalFiles)))
            : "";
          barText.textContent = files ? head + " · " + files : head;
          barText.style.display = "";
        } else {
          barWrap.style.display = "none";
          barText.textContent = "";
          barText.style.display = "none";
        }

        // 选中模型的状态：已装带体积与维度；下载中由行内徽章与进度条表达，这里不再重复
        modelState.innerHTML = "";
        if (!busy && installed) {
          modelState.appendChild(
            badge(
              t("advanced.vectorSearch.model.installed", state.lang)
                .replace("{size}", sizeText(num(st.bytes)))
                .replace("{dim}", String(num(st.dimensions))),
              "ok",
            ),
          );
        } else if (!busy) {
          modelState.appendChild(badge(t("advanced.vectorSearch.model.missing", state.lang), "warn"));
        }

        downBtn.style.display = installed || busy ? "none" : "";
        downBtn.disabled = false;
        recheckBtn.style.display = installed || busy ? "none" : "";
        removeBtn.style.display = installed && !busy ? "" : "none";

        // 失败原因留在原地（下载失败 / 清单不一致），别只剩一次 flash
        const err = String(st.lastError ?? st.error ?? "");
        const runtime =
          st.runtimeOk === false
            ? t("advanced.vectorSearch.model.noRuntime", state.lang) + " " + String(st.runtimeMessage ?? "")
            : "";
        modelNote.textContent = [err, runtime].filter(Boolean).join(" · ");
        modelNote.style.display = modelNote.textContent ? "" : "none";
      };

      /** 轮询：下载中每 0.6 秒刷一次，画在同一批元素上 */
      const startPoll = (id: string): void => {
        stopPoll();
        let idle = 0;
        const tick = async (): Promise<void> => {
          if (!modelBox.isConnected) {
            stopPoll(); // 页面被切走了，别再空转
            return;
          }
          let st: Record<string, unknown> | null = null;
          try {
            st = (await rpc("embedding/model.status", { model: id })) as Record<string, unknown> | null;
          } catch {
            // 服务短暂不可用：别每 0.6 秒抛一次，两轮后停掉，留「重新检查」手动重试
            idle += 1;
            if (idle >= 2) stopPoll();
            return;
          }
          if (!modelBox.isConnected) {
            stopPoll();
            return;
          }
          paintModel(st);
          if (st && (st.downloading === true || st.installing === true)) {
            idle = 0;
            return;
          }
          idle += 1;
          if (idle < 2) return; // 收尾再等一轮，别在最后一个文件上提前停
          stopPoll();
          if (st && st.installed === true) flash(t("advanced.vectorSearch.model.done", state.lang), "ok");
          else if (st && (st.lastError || st.error)) flash(String(st.lastError ?? st.error), "bad");
        };
        pollTimer = window.setInterval(() => void tick(), 600);
        void tick();
      };

      const refreshModelBox = async (want?: string): Promise<void> => {
        let st: Record<string, unknown> | null = null;
        try {
          st = (await rpc("embedding/model.status", want ? { model: want } : {})) as Record<string, unknown> | null;
        } catch {
          st = null; // 画成「读不到状态」，别让整个设置页跟着挂
        }
        paintModel(st);
        // 回到页面 / 重新进设置时，如果后台还在下，自动接着显示进度
        if (st && (st.downloading === true || st.installing === true)) {
          startPoll(String(st.id ?? want ?? pickedModel));
        }
      };

      recheckBtn.addEventListener("click", () => {
        void refreshModelBox(pickedModel || undefined);
      });
      downBtn.addEventListener("click", async () => {
        const id = pickedModel;
        if (!id) return;
        // 先就地切成「下载中 0%」：RPC 往返的几百毫秒里也要让用户看到反应
        downBtn.style.display = "none";
        recheckBtn.style.display = "none";
        lastPct = 0;
        barFill.style.width = "0%";
        barWrap.style.display = "";
        barText.style.display = "";
        barText.textContent = t("advanced.vectorSearch.model.starting", state.lang);
        modelState.innerHTML = "";
        modelState.appendChild(
          badge(t("advanced.vectorSearch.model.downloading", state.lang).replace("{pct}", "0"), "plain"),
        );
        let r: { ok?: boolean; message?: string; started?: boolean } | null = null;
        try {
          r = (await rpc("embedding/model.install", { model: id })) as
            | { ok?: boolean; message?: string; started?: boolean }
            | null;
        } catch (e) {
          // 服务没响应 / 被宿主拒绝：别让按钮永远消失，退回可重试状态
          barWrap.style.display = "none";
          barText.style.display = "none";
          await refreshModelBox(id);
          flash(t("advanced.vectorSearch.model.failed", state.lang) + " " + (e instanceof Error ? e.message : ""), "bad");
          return;
        }
        if (r && r.ok === false) {
          barWrap.style.display = "none";
          barText.style.display = "none";
          await refreshModelBox(id);
          flash(String(r.message ?? t("advanced.vectorSearch.model.failed", state.lang)), "bad");
          return;
        }
        startPoll(id);
      });
      removeBtn.addEventListener("click", async () => {
        const r = (await rpc("embedding/model.remove", { model: pickedModel })) as {
          ok?: boolean;
          message?: string;
        } | null;
        if (report(r, t("advanced.vectorSearch.model.removed", state.lang))) await refreshModelBox(pickedModel);
      });

      // 三条来源各自的配置块：只显示当前选中的那条
      const localHashBox = el("div", { class: "mw-col", style: "gap:0.25rem;" }, [
        el("p", { class: "mw-small", text: t("advanced.vectorSearch.localHashNote", state.lang) }),
      ]);
      const discoverBtn = el("button", {
        class: "mw-btn",
        text: t("advanced.vectorSearch.discover", state.lang),
        onclick: async () => {
          const r = (await rpc("embedding/discover", {})) as { ok?: boolean; message?: string } | null;
          if (report(r, t("advanced.vectorSearch.savedOn", state.lang))) await refresh();
        },
      });
      const httpBox = el("div", { class: "mw-col", style: "gap:0;" }, [
        field(t("advanced.vectorSearch.baseUrl", state.lang), baseUrl, t("advanced.vectorSearch.baseUrlHint", state.lang)),
        el("div", { class: "mw-row", style: "margin:-0.25rem 0 0.5rem;" }, [discoverBtn]),
        el("div", { class: "mw-row" }, [
          field(t("advanced.vectorSearch.model", state.lang), model, t("advanced.vectorSearch.modelHint", state.lang)),
          field(t("advanced.vectorSearch.dimensions", state.lang), dimensions),
        ]),
        field(t("advanced.vectorSearch.apiKey", state.lang), apiKey, t("advanced.vectorSearch.keyNote", state.lang)),
      ]);

      const toggle = el("input", { type: "checkbox", class: "mw-switch" }) as HTMLInputElement;
      toggle.checked = userOn;

      const saveBtn = el("button", {
        class: "mw-btn mw-btn-primary",
        text: t("advanced.vectorSearch.save", state.lang),
        onclick: () => {
          void submit();
        },
      });
      const syncSaveLabel = (): void => {
        saveBtn.textContent = t(
          toggle.checked ? "advanced.vectorSearch.save" : "advanced.vectorSearch.saveOff",
          state.lang,
        );
      };
      // 开关只改表单，不立刻落库：否则「关掉」会绕过下面还没保存的改动
      toggle.addEventListener("change", syncSaveLabel);
      syncSaveLabel();

      const syncMode = (): void => {
        const mode = currentMode();
        localHashBox.style.display = mode === "local-hash" ? "" : "none";
        modelBox.style.display = mode === "local-model" ? "" : "none";
        httpBox.style.display = mode === "openai-compatible" ? "" : "none";
        if (mode === "local-model") void refreshModelBox(pickedModel || String(settings.model ?? "") || undefined);
      };
      for (const radio of modeRadios) radio.addEventListener("change", syncMode);
      syncMode();

      /** 收集表单 → 调 host 验证并落库；失败时只 flash，不改现有 provider */
      const submit = async (): Promise<void> => {
        const enabled = toggle.checked;
        const mode = currentMode();
        const dim = Number(dimensions.value.trim());
        // 关着也照存：用户可能先配好再打开；host 会把它记成 enabled=0 并保留字段
        const payload = {
          enabled,
          provider: mode,
          model:
            mode === "openai-compatible"
              ? model.value.trim()
              : mode === "local-model"
                ? pickedModel || undefined
                : undefined,
          baseUrl: mode === "openai-compatible" ? baseUrl.value.trim() : undefined,
          apiKey: mode === "openai-compatible" ? apiKey.value.trim() : undefined,
          dimensions: mode === "openai-compatible" && Number.isFinite(dim) && dim > 0 ? dim : undefined,
        };
        const r = (await rpc("embedding/configure", payload)) as { ok?: boolean; message?: string } | null;
        if (report(r, t(enabled ? "advanced.vectorSearch.savedOn" : "advanced.vectorSearch.savedOff", state.lang))) {
          await refresh();
        } else {
          // 保存失败时开关要回到真实状态，别让界面以为已经开了
          toggle.checked = userOn;
          syncSaveLabel();
        }
      };

      const statsText = ready
        ? t("advanced.vectorSearch.stats", state.lang) +
          " " + String(num(stats.indexed)) + " / " + String(num(stats.totalActive)) +
          " · " + t("advanced.vectorSearch.pending", state.lang) + " " + String(num(stats.pending)) +
          " · " + t("advanced.vectorSearch.failed", state.lang) + " " + String(num(stats.failed))
        : t("advanced.vectorSearch.statsOff", state.lang)
            .replace("{indexed}", String(num(stats.indexed)))
            .replace("{total}", String(num(stats.totalActive)))
            .replace("{pending}", String(num(stats.pending)))
            .replace("{failed}", String(num(stats.failed)));

      return el("section", { class: "mw-item-card" }, [
        el("div", { class: "mw-row", style: "justify-content:space-between;align-items:center;" }, [
          el("h4", { text: t("advanced.vectorSearch.title", state.lang) }),
          badge(t(reasonKey, state.lang), tone),
        ]),

        // ① 现在的状态：只读，放最上面一眼看完
        el("div", { class: "mw-row", style: "gap:0.75rem;flex-wrap:wrap;" }, [
          el("span", { class: "mw-field-label", text: t("advanced.vectorSearch.backend", state.lang) }),
          badge(backendText, "plain"),
          el("span", { class: "mw-field-label", text: t("advanced.vectorSearch.provider", state.lang) }),
          el("span", { class: "mw-small", text: providerText }),
        ]),
        el("p", { class: "mw-small", text: statsText }),
        // 换过模型 / 维度后旧向量会被维度闸门跳过：数字看着满，召回却缺
        num(stats.stale) > 0
          ? el("div", { class: "mw-row" }, [
              badge(
                t("advanced.vectorSearch.stale", state.lang).replace("{n}", String(num(stats.stale))),
                "warn",
              ),
              el("button", {
                class: "mw-btn",
                text: t("advanced.vectorSearch.reindex", state.lang),
                onclick: async () => {
                  const r = (await rpc("embedding/reindex", {})) as { ok?: boolean; message?: string } | null;
                  if (report(r, t("advanced.vectorSearch.reindexed", state.lang))) {
                    await new Promise((res) => setTimeout(res, 800));
                    await refresh();
                  }
                },
              }),
            ])
          : null,

        el("div", { style: "border-top:1px solid var(--mw-line);" }),

        // ② 选一种来源：单选卡片，说明就写在旁边
        el("span", { class: "mw-field-label", text: t("advanced.vectorSearch.step1", state.lang) }),
        sourceList,
        discoveryText ? el("p", { class: "mw-small", text: discoveryText }) : null,

        // ③ 只显示这一种来源需要的配置
        el("span", { class: "mw-field-label", text: t("advanced.vectorSearch.step2", state.lang) }),
        localHashBox,
        modelBox,
        httpBox,

        el("div", { style: "border-top:1px solid var(--mw-line);" }),

        // ④ 启用 + 保存：一个动作，别再让开关偷偷绕过没保存的改动
        el("label", { class: "mw-check-row", style: "align-self:flex-start;" }, [
          toggle,
          el("span", { text: t("advanced.vectorSearch.enable", state.lang) }),
        ]),
        el("p", { class: "mw-small", text: t("advanced.vectorSearch.enableHint", state.lang) }),
        el("p", { class: "mw-small", text: t("advanced.vectorSearch.saveHint", state.lang) }),
        el("div", { class: "mw-btn-row" }, [saveBtn]),
        el("p", { class: "mw-small", text: t("advanced.vectorSearch.note", state.lang) }),
      ]);
    })(),
    el("section", { class: "mw-item-card" }, [
      el("h4", { text: t("advanced.quote", state.lang) }),
      el("div", { class: "mw-row" }, [
        el("label", { class: "mw-check-row" }, [mkCheck("quote.enabled", quote.enabled, t("advanced.enabled", state.lang)), el("span", { text: t("advanced.enabled", state.lang) })]),
        el("label", { class: "mw-field-row" }, [el("span", { class: "mw-field-label", text: t("advanced.indexDays", state.lang) }), mkNum("quote.indexDays", quote.indexDays, t("advanced.indexDays", state.lang))]),
      ]),
    ]),
    curateCard(settings, mkCheck, mkNum),
    el("section", { class: "mw-item-card" }, [
      el("h4", { text: t("advanced.turnNotice", state.lang) }),
      el("label", { class: "mw-check-row" }, [mkCheck("governance.turnNotice.enabled", obj(governance.turnNotice ?? {}).enabled !== false, t("advanced.turnNoticeDesc", state.lang)), el("span", { text: t("advanced.turnNoticeDesc", state.lang) })]),
    ]),
    sensitive.node,
    el("label", { class: "mw-field-row" }, [el("span", { class: "mw-field-label", text: t("advanced.log", state.lang) }), logSelect]),
  ]);

  // ---------- 恢复默认：只把表单填回出厂值，仍需点「保存」才生效，可「放弃修改」撤回 ----------
  const defaults = obj(state.data.defaults);
  const at = (path: string): unknown => path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), defaults);
  /** 表单键 → 出厂配置路径（键名与配置路径不同的列在这里，其余同名） */
  const DEFAULT_PATH: Record<string, string> = {
    "w.keyword": "recall.weights.keyword",
    "w.link": "recall.weights.link",
    "q.autoLink": "links.autoLink.enabled",
    "q.containment": "write.containment.enabled",
    "q.surprise": "write.surprise.enabled",
    "q.sourceWeight": "write.sourceWeight.enabled",
    "q.diversity": "recall.diversity.enabled",
    "q.rumination": "recall.rumination.enabled",
    "coRecall.enabled": "links.coRecall.enabled",
    "coRecall.step": "links.coRecall.step",
    "coRecall.cap": "links.coRecall.cap",
    "coRecall.decayDays": "links.coRecall.decayDays",
    "boost.enabled": "lifecycle.boost.enabled",
    "boost.minHits": "lifecycle.boost.minHits",
    "boost.minSessions": "lifecycle.boost.minSessions",
    "boost.decayDays": "lifecycle.boost.decayDays",
    "distill.enabled": "lifecycle.distill.enabled",
    "distill.topicsPerProject": "lifecycle.distill.topicsPerProject",
    "distill.crossProjects": "lifecycle.distill.crossProjects",
    "groupDistill.enabled": "distill.enabled",
    "groupDistill.perDream": "distill.perDream",
    "halfLife.topic": "lifecycle.halfLifeDays.topic",
    "halfLife.fact": "lifecycle.halfLifeDays.fact",
    "halfLife.project": "lifecycle.halfLifeDays.project",
    "halfLife.user": "lifecycle.halfLifeDays.user",
    "halfLife.soul": "lifecycle.halfLifeDays.soul",
    "halfLife.lesson": "lifecycle.halfLifeDays.lesson",
    "halfLife.rules": "lifecycle.halfLifeDays.rules",
  };
  const defaultOf = (key: string): unknown => at(DEFAULT_PATH[key] ?? key);
  const defaultPeak = peakHoursToSet(at("dream.peakHours"));
  const sameAsDefault = (key: string): boolean => {
    const d = defaultOf(key);
    if (d === undefined) return true;
    const input = inputs[key] as HTMLInputElement;
    if (input.type === "checkbox") return input.checked === (d === true);
    if (input.type === "number" || input.type === "range") return num(input.value, NaN) === num(d, NaN);
    return input.value === String(d ?? "");
  };
  const keysIn = (scope: HTMLElement): string[] => Object.keys(inputs).filter((k) => scope.contains(inputs[k]) && defaultOf(k) !== undefined);
  const peakIn = (scope: HTMLElement): boolean => scope.contains(peak.node) && at("dream.peakHours") !== undefined;
  const peakIsDefault = (): boolean => JSON.stringify(peak.value()) === JSON.stringify(defaultPeak);
  const applyDefaults = (scope: HTMLElement): void => {
    for (const k of keysIn(scope)) {
      const input = inputs[k] as HTMLInputElement;
      const d = defaultOf(k);
      if (input.type === "checkbox") input.checked = d === true;
      else input.value = String(d ?? "");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
    if (peakIn(scope) && !peakIsDefault()) peak.set(defaultPeak);
  };
  // 每张参数卡片标题旁放一个「恢复默认」（敏感规则卡片除外：自定义规则没有出厂值，清空会丢数据）
  const cardResets: Array<{ btn: HTMLButtonElement; card: HTMLElement }> = [];
  for (const card of Array.from(form.children) as HTMLElement[]) {
    if (card === sensitive.node || !card.classList.contains("mw-item-card")) continue;
    if (keysIn(card).length === 0 && !peakIn(card)) continue;
    const h = card.querySelector(":scope > h4");
    if (!h) continue;
    const btn = el("button", {
      type: "button",
      class: "mw-reset",
      text: t("common.resetDefault", state.lang),
      title: t("common.resetHint", state.lang),
      onclick: () => applyDefaults(card),
    }) as HTMLButtonElement;
    const head = el("div", { class: "mw-card-head" });
    h.replaceWith(head);
    head.append(h, btn);
    cardResets.push({ btn, card });
  }
  const resetAllBtn = el("button", {
    type: "button",
    text: t("common.resetAll", state.lang),
    title: t("common.resetHint", state.lang),
    onclick: () => {
      if (!window.confirm(t("common.resetAllConfirm", state.lang))) return;
      applyDefaults(form);
    },
  }) as HTMLButtonElement;
  const syncResets = (): void => {
    let any = false;
    for (const { btn, card } of cardResets) {
      const isDefault = keysIn(card).every(sameAsDefault) && (!peakIn(card) || peakIsDefault());
      btn.disabled = isDefault || state.readonly;
      if (!isDefault) any = true;
    }
    resetAllBtn.disabled = !any || state.readonly;
  };

  // 只有真的改了值才提示“未保存”：和打开页面时的取值逐项比较
  const snapshot = (): string =>
    JSON.stringify([
      ...Object.keys(inputs).sort().map((k) => {
        const input = inputs[k] as HTMLInputElement;
        return input.type === "checkbox" ? input.checked : input.value;
      }),
      peak.value(),
      sensitive.value(),
    ]);
  const initial = snapshot();
  const saveCard = el("section", { class: "mw-card mw-action-bar", "aria-label": t("common.save", state.lang) });
  const notice = unsavedNotice(() => saveCard);
  const statusBadge = el("span");
  const saveBtn = el("button", { type: "button", class: "mw-primary", text: t("advanced.save", state.lang), disabled: "disabled" }) as HTMLButtonElement;
  const discardBtn = el("button", { type: "button", text: t("persona.discard", state.lang), disabled: "disabled" }) as HTMLButtonElement;
  const sync = (): void => {
    const dirty = snapshot() !== initial;
    notice.setDirty(dirty);
    statusBadge.replaceChildren(badge(t(dirty ? "persona.dirty" : "persona.clean", state.lang), dirty ? "warn" : "plain"));
    saveBtn.disabled = !dirty || state.readonly;
    discardBtn.disabled = !dirty;
    syncResets();
  };
  watchEdits(form, sync);
  saveCard.append(
    el("div", { class: "mw-row" }, [el("h3", { text: t("advanced.save", state.lang) }), statusBadge]),
    el("p", { class: "mw-small", text: t("advanced.saveHint", state.lang) }),
    el("div", { class: "mw-row" }, [saveBtn, discardBtn, resetAllBtn]),
  );
  sync();

  discardBtn.onclick = () => {
    delete state.data.modelDirText;
    void refresh();
  };
  saveBtn.addEventListener("click", () => {
    {
      {
        const g = (k: string): number => num((inputs[k] as HTMLInputElement).value, 0);
        const c = (k: string): boolean => (inputs[k] as HTMLInputElement).checked;
        const patch = {
          recall: {
            ...recall,
            rrfK: g("recall.rrfK"),
            weights: { ...weights, keyword: g("w.keyword"), link: g("w.link") },
            diversity: { ...obj(recall.diversity), enabled: c("q.diversity") },
            intent: { ...intent, enabled: c("recall.intent.enabled"), factor: g("recall.intent.factor") },
            rumination: { ...obj(recall.rumination), enabled: c("q.rumination") },
            logKeepDays: Math.max(7, Math.min(3650, Math.round(g("recall.logKeepDays") || 90))),
          },
          lifecycle: {
            ...lifecycle,
            halfLifeDays: {
              topic: g("halfLife.topic"),
              fact: g("halfLife.fact"),
              project: g("halfLife.project"),
              user: g("halfLife.user"),
              soul: g("halfLife.soul"),
              lesson: g("halfLife.lesson"),
              rules: g("halfLife.rules"),
            },
            coldMemoryMonths: g("lifecycle.coldMemoryMonths"),
            decayFloor: Math.max(0, Math.min(1, g("lifecycle.decayFloor"))),
            mergeOnDream: c("lifecycle.mergeOnDream"),
            autoDream: c("lifecycle.autoDream"),
            boost: { ...obj(lifecycle.boost), enabled: c("boost.enabled"), minHits: g("boost.minHits"), minSessions: g("boost.minSessions"), decayDays: g("boost.decayDays") },
            staleAskDays: g("lifecycle.staleAskDays"),
            distill: { ...obj(lifecycle.distill), enabled: c("distill.enabled"), topicsPerProject: g("distill.topicsPerProject"), crossProjects: g("distill.crossProjects") },
            maxCandidatesPerDream: g("lifecycle.maxCandidatesPerDream"),
          },
          dream: {
            ...dream,
            enabled: c("dream.enabled"),
            idleMinutes: g("dream.idleMinutes"),
            peakHours: setToPeakHours(peak.value()),
          },
          quote: { ...quote, enabled: c("quote.enabled"), indexDays: g("quote.indexDays") },
          // S1 / S2
          searchTerms: { ...obj(settings.searchTerms), enabled: c("searchTerms.enabled"), backfillPerDream: g("searchTerms.backfillPerDream") },
          distill: { ...obj(settings.distill), enabled: c("groupDistill.enabled"), perDream: g("groupDistill.perDream") },
          curate: { ...obj(settings.curate), enabled: c("curate.enabled"), autoProcess: c("curate.autoProcess") },
          governance: {
            ...governance,
            sensitivePatterns: sensitive.value().custom,
            disabledSensitive: sensitive.value().disabled,
            turnNotice: { enabled: c("governance.turnNotice.enabled") },
          },
          links: {
            ...obj(settings.links),
            autoLink: { ...obj(obj(settings.links).autoLink), enabled: c("q.autoLink") },
            coRecall: { ...obj(obj(settings.links).coRecall), enabled: c("coRecall.enabled"), step: g("coRecall.step"), cap: g("coRecall.cap"), decayDays: g("coRecall.decayDays") },
          },
          write: {
            ...obj(settings.write),
            containment: { ...obj(obj(settings.write).containment), enabled: c("q.containment") },
            surprise: { ...obj(obj(settings.write).surprise), enabled: c("q.surprise") },
            sourceWeight: { ...obj(obj(settings.write).sourceWeight), enabled: c("q.sourceWeight") },
          },
          // 情绪 / 意图卡片早就有输入框，但之前没进保存补丁（改了不生效）：一并补上
          emotion: {
            ...emotion,
            enabled: c("emotion.enabled"),
            flashArousal: g("emotion.flashArousal"),
            dailyFlashCap: g("emotion.dailyFlashCap"),
            factor: g("emotion.factor"),
            residue: { ...obj(emotion.residue), enabled: c("emotion.residue.enabled"), floor: g("emotion.residue.floor") },
          },
          promise: {
            ...promise,
            enabled: c("promise.enabled"),
            surfaceLookaheadDays: g("promise.surfaceLookaheadDays"),
            graceDays: g("promise.graceDays"),
            affectRelation: c("promise.affectRelation"),
          },
          calendar: { ...calendar, enabled: c("calendar.enabled"), lookaheadDays: g("calendar.lookaheadDays"), timeZone: tzInput.value.trim() },
          reflect: { ...obj(settings.reflect), enabled: c("reflect.enabled"), afterToolSteps: g("reflect.afterToolSteps") },
          replay: { ...obj(settings.replay), enabled: c("replay.enabled") },
          log: { ...obj(settings.log), maxFileMb: g("log.maxFileMb"), keepDays: g("log.keepDays") },
          logLevel: logSelect.value,
        };
        void rpc("settings/update", { patch }).then((out) => {
          if (!report(out)) return;
          delete state.data.modelDirText;
          flash(obj(out).persisted === false ? t("advanced.savedMemoryOnly", state.lang) : t("advanced.saved", state.lang), obj(out).persisted === false ? "warn" : "ok");
          void refresh();
        });
      }
    }
  });
  return el("div", { class: "mw-col" }, [
    notice.node,
    el("section", { class: "mw-card" }, [el("h3", { text: t("nav.advanced", state.lang) }), form]),
    saveCard,
  ]);
}
