/// <reference lib="dom" />
/**
 * 忆织 MemWeave —— 用户画像页面
 * 展示从记忆聚合的用户画像，支持查看、修正、删除
 */

import { t } from "../i18n";
import { badge, dangerConfirm, el, refresh, rpc, sectionCard, state } from "./ui";
import type { ProfileBasis, ProfileItem, UserProfile } from "../profile/types";

export async function loadProfile(): Promise<void> {
  // 加载画像数据
  const result = (await rpc("profile/get", {})) as { ok: boolean; profile?: UserProfile; enabled?: boolean };
  state.data.profileResult = result;
}

export function pageProfile(): HTMLElement {
  const result = state.data.profileResult as { ok: boolean; profile?: UserProfile; enabled?: boolean } | undefined;
  
  const container = el("div", { class: "mw-container" });

  // 画像功能开关（设置卡片）
  const settingsCard = el("div", { class: "mw-card" }, [
    el("h3", { text: t("profile.settings.title", state.lang) }),
    el("label", { class: "mw-checkbox-label" }, [
      el("input", {
        type: "checkbox",
        checked: result?.enabled ?? true,
        onchange: async (e: Event) => {
          const checked = (e.target as HTMLInputElement).checked;
          await rpc("profile/setEnabled", { enabled: checked });
          await loadProfile();
          refresh();
        },
      }),
      " ",
      t("profile.settings.enableProfile", state.lang),
    ]),
  ]);
  container.appendChild(settingsCard);
  
  if (!result?.ok || !result.enabled) {
    const infoCard = el("div", { class: "mw-card mw-info" }, [
      el("p", { text: t("profile.disabled.description", state.lang) }),
    ]);
    container.appendChild(infoCard);
    return container;
  }

  const profile = result.profile;
  // 计算所有画像项数量
  const itemCount = profile ? 
    (profile.preferences?.length || 0) + 
    (profile.communicationStyle?.length || 0) + 
    (profile.goals?.length || 0) + 
    (profile.boundaries?.length || 0) + 
    (profile.relationship?.length || 0) : 0;
    
  if (!profile || itemCount === 0) {
    const emptyCard = el("div", { class: "mw-card mw-info" }, [
      el("h3", { text: t("profile.empty.title", state.lang) }),
      el("p", { text: t("profile.empty.description", state.lang) }),
    ]);
    container.appendChild(emptyCard);
    return container;
  }

  // AI 画像描述编辑框
  const descTextarea = el("textarea", {
    class: "mw-input",
    rows: 4,
    style: "width: 100%; box-sizing: border-box; resize: vertical;",
    placeholder: state.lang === "zh" ? "AI 生成的画像描述，可编辑..." : "AI-generated profile description, editable...",
    value: profile.customDescription || profile.summary || "",
  }) as HTMLTextAreaElement;
  
  const saveDescBtn = el("button", {
    class: "mw-btn mw-btn-primary",
    text: t("common.save", state.lang),
    onclick: async () => {
      const newDesc = descTextarea.value.trim();
      await rpc("profile/updateDescription", { description: newDesc });
      await loadProfile();
      refresh();
    },
  });
  
  const aiDescCard = el("div", { class: "mw-card" }, [
    el("label", { class: "mw-col", style: "gap: 0.5rem;" }, [
      el("span", { text: t("profile.settings.aiDescription", state.lang), style: "font-weight: 500;" }),
      descTextarea,
    ]),
    el("div", { class: "mw-btn-row" }, [saveDescBtn]),
  ]);
  container.appendChild(aiDescCard);

  // 合并所有画像项
  const allItems: ProfileItem[] = [
    ...(profile.preferences || []),
    ...(profile.communicationStyle || []),
    ...(profile.goals || []),
    ...(profile.boundaries || []),
    ...(profile.relationship || []),
  ];

  // 按类别分组
  const byCategory = new Map<string, ProfileItem[]>();
  for (const item of allItems) {
    const arr = byCategory.get(item.category) ?? [];
    arr.push(item);
    byCategory.set(item.category, arr);
  }
  
  // 统计与操作卡片
  const statsCard = el("div", { class: "mw-card mw-profile-stats-card" }, [
    el("div", { class: "mw-profile-stats" }, [
      el("span", { class: "mw-stat" }, [
        el("strong", { text: String(itemCount) }),
        " ",
        t("profile.stats.items", state.lang),
      ]),
      el("span", { class: "mw-stat" }, [
        t("profile.stats.updated", state.lang),
        " ",
        el("strong", { text: profile.lastUpdatedAt ? new Date(profile.lastUpdatedAt).toLocaleString() : new Date(profile.generatedAt).toLocaleString() }),
      ]),
    ]),
    el("div", { class: "mw-actions" }, [
      el("button", {
        class: "mw-btn mw-primary",
        text: t("profile.actions.regenerate", state.lang),
        onclick: () => regenerateProfile(),
      }),
      el("button", {
        class: "mw-btn mw-danger",
        text: t("profile.actions.clearAll", state.lang),
        onclick: () => clearAllProfile(),
      }),
    ]),
  ]);
  container.appendChild(statsCard);

  // 画像依据（读了哪些层、多少条、过滤了多少）——让「为什么画像长这样」可查
  if (profile.basis) {
    container.appendChild(el("p", { class: "mw-small", text: basisText(profile.basis) }));
  }

  // 按类别显示项目
  const categoryOrder: Array<ProfileItem["category"]> = ["preference", "communication", "goal", "boundary", "relationship"];
  for (const category of categoryOrder) {
    const items = byCategory.get(category);
    if (!items || items.length === 0) continue;

    const categoryCard = renderCategoryCard(category, items);
    container.appendChild(categoryCard);
  }

  return container;
}

function basisText(basis: ProfileBasis): string {
  const zh = state.lang === "zh";
  const filtered = `敏感 ${basis.excluded.sensitive} / 低置信 ${basis.excluded.lowConfidence} / 过期 ${basis.excluded.expired}`;
  return zh
    ? `依据：${basis.levels.join(" / ")} 共 ${basis.scanned} 条，采用 ${basis.used} 条（${filtered}）；阈值 minConfidence=${basis.thresholds.minConfidence}`
    : `Basis: ${basis.scanned} memories from ${basis.levels.join(" / ")}, ${basis.used} used (${filtered}); minConfidence=${basis.thresholds.minConfidence}`;
}

function renderCategoryCard(category: ProfileItem["category"], items: ProfileItem[]): HTMLElement {
  const categoryName = t(`profile.category.${category}`, state.lang);
  
  const itemsContainer = el("div", { class: "mw-profile-items" });
  
  for (const item of items) {
    const itemEl = renderProfileItem(item);
    itemsContainer.appendChild(itemEl);
  }

  return sectionCard(categoryName, itemsContainer);
}

function renderProfileItem(item: ProfileItem): HTMLElement {
  const sourceColor = item.source === "stated" ? "ok" : item.source === "observed" ? "warn" : "plain";
  const confidencePercent = Math.round(item.confidence * 100);
  
  const header = el("div", { class: "mw-profile-item-header" }, [
    el("div", { class: "mw-profile-item-badges" }, [
      badge(t(`profile.source.${item.source}`, state.lang), sourceColor),
      badge(`${confidencePercent}%`, sourceColor),
    ]),
    el("div", { class: "mw-profile-item-actions" }, [
      el("button", {
        class: "mw-btn-icon",
        title: t("profile.actions.viewEvidence", state.lang),
        text: "🔍",
        onclick: () => viewEvidence(item),
      }),
      el("button", {
        class: "mw-btn-icon",
        title: t("profile.actions.delete", state.lang),
        text: "🗑️",
        onclick: () => deleteProfileItem(item),
      }),
    ]),
  ]);

  const content = el("div", { class: "mw-profile-item-content" }, [
    el("p", { text: item.content }),
  ]);

  if (item.expiresAt) {
    const expiryDate = new Date(item.expiresAt);
    const expiryNote = el("div", { class: "mw-profile-item-expiry" }, [
      el("small", { text: `${t("profile.expiresAt", state.lang)}: ${expiryDate.toLocaleDateString()}` }),
    ]);
    content.appendChild(expiryNote);
  }

  return el("div", { class: "mw-profile-item" }, [header, content]);
}

async function viewEvidence(item: ProfileItem): Promise<void> {
  const evidenceIds = item.evidenceIds?.join(", ") || t("profile.evidence.none", state.lang);
  const lastConfirmed = item.lastConfirmedAt
    ? new Date(item.lastConfirmedAt).toLocaleString()
    : t("profile.evidence.never", state.lang);
  
  const zh = state.lang === "zh";
  const trace = item.trace
    ? `\n` +
      (zh
        ? `源层级: ${item.trace.level}\n分类规则: ${item.trace.categoryRule}\n重要度: ${item.trace.importance} · 访问: ${item.trace.accessCount} · 记忆置信度: ${item.trace.memoryConfidence ?? "-"}`
        : `Level: ${item.trace.level}\nCategory rule: ${item.trace.categoryRule}\nImportance: ${item.trace.importance} · Access: ${item.trace.accessCount} · Memory confidence: ${item.trace.memoryConfidence ?? "-"}`)
    : "";

  const message = `${t("profile.evidence.title", state.lang)}:\n\n` +
    `${t("profile.evidence.ids", state.lang)}: ${evidenceIds}\n` +
    `${t("profile.evidence.lastConfirmed", state.lang)}: ${lastConfirmed}\n` +
    `${t("profile.evidence.confidence", state.lang)}: ${Math.round(item.confidence * 100)}%` +
    trace;
  
  alert(message);
}

async function deleteProfileItem(item: ProfileItem): Promise<void> {
  if (!confirm(t("profile.delete.confirm", state.lang))) return;
  
  const result = (await rpc("profile/deleteItem", { 
    category: item.category, 
    content: item.content 
  })) as { ok: boolean };
  
  if (result.ok) {
    await refresh();
  } else {
    alert(t("profile.delete.failed", state.lang));
  }
}

async function regenerateProfile(): Promise<void> {
  if (!confirm(t("profile.regenerate.confirm", state.lang))) return;
  
  const result = (await rpc("profile/regenerate", {})) as { ok: boolean };
  
  if (result.ok) {
    await refresh();
  } else {
    alert(t("profile.regenerate.failed", state.lang));
  }
}

async function clearAllProfile(): Promise<void> {
  const confirmed = dangerConfirm("CLEAR", t("profile.clearAll.confirm", state.lang));
  if (!confirmed) return;
  
  const result = (await rpc("profile/clearAll", {})) as { ok: boolean };
  
  if (result.ok) {
    await refresh();
  } else {
    alert(t("profile.clearAll.failed", state.lang));
  }
}
