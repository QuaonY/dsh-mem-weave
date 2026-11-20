/**
 * @vitest-environment happy-dom
 * el() 的 value/checked 必须走 DOM 属性而不是 setAttribute：
 * - setAttribute("value", ...) 对 textarea 无效，画像描述框会显示为空，保存即清空数据；
 * - setAttribute("checked", "false") 是布尔属性，反而让复选框选中。
 */
import { afterEach, describe, expect, it } from "vitest";
import { el, setRpcCtx, state } from "../src/client/ui";
import { pageProfile } from "../src/client/profile";
import type { UserProfile } from "../src/profile/types";

afterEach(() => {
  setRpcCtx(null);
  state.data = {};
  state.lang = "zh";
});

describe("el() 表单属性", () => {
  it("textarea 的 value 写入 DOM 属性", () => {
    const ta = el("textarea", { value: "已有的画像描述" });
    expect(ta.value).toBe("已有的画像描述");
  });

  it("checkbox checked:false 不选中，true / \"checked\" 选中", () => {
    expect(el("input", { type: "checkbox", checked: false }).checked).toBe(false);
    expect(el("input", { type: "checkbox", checked: true }).checked).toBe(true);
    // 旧调用点用字符串 "checked"，保持兼容
    expect(el("input", { type: "checkbox", checked: "checked" }).checked).toBe(true);
    expect(el("input", { type: "checkbox" }).checked).toBe(false);
  });

  it("input / option 的 value 正常", () => {
    expect(el("input", { type: "text", value: "abc" }).value).toBe("abc");
    expect(el("option", { value: "x", text: "X" }).value).toBe("x");
  });
});

describe("画像页表单", () => {
  const item = {
    category: "preference" as const,
    content: "喜欢简洁回复",
    source: "stated" as const,
    confidence: 1,
    evidenceIds: ["m1"],
    lastConfirmedAt: Date.now(),
  };
  const profile: UserProfile = {
    summary: "摘要",
    preferences: [item],
    communicationStyle: [],
    goals: [],
    boundaries: [],
    relationship: [],
    generatedAt: Date.now(),
    baseMemoryCount: 1,
    customDescription: "用户手改过的描述",
  };

  it("enabled:false 时开关显示为未选中", () => {
    state.data.profileResult = { ok: true, enabled: false };
    const node = pageProfile();
    const box = node.querySelector<HTMLInputElement>("input[type=checkbox]");
    expect(box).not.toBeNull();
    expect(box!.checked).toBe(false);
  });

  it("enabled:true 时开关选中，描述框显示 customDescription", () => {
    state.data.profileResult = { ok: true, enabled: true, profile };
    const node = pageProfile();
    const box = node.querySelector<HTMLInputElement>("input[type=checkbox]");
    expect(box!.checked).toBe(true);
    const ta = node.querySelector<HTMLTextAreaElement>("textarea");
    expect(ta).not.toBeNull();
    expect(ta!.value).toBe("用户手改过的描述");
  });
});