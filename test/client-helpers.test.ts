/**
 * 设置页的纯逻辑：预设卡标识识别、账号昵称解析、修改者显示、注入记录的会话列表。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inferPresetIdentity } from "../src/client/persona";
import { actorLabel, nicknameFromProfile, setAccountNickname } from "../src/client/account";
import { openWeaveDb } from "../src/store/db";
import { ensureSchema } from "../src/store/migrate";
import { addLedger, listLedgerSessions } from "../src/store/dao";

describe("预设卡标识识别", () => {
  it("自家格式直接用合法的 id 和 label", () => {
    expect(inferPresetIdentity({ spec: "memweave-preset/1", id: "night-owl", label: "夜猫子", payload: {} })).toEqual({
      id: "night-owl",
      label: "夜猫子",
    });
  });

  it("酒馆 v2 卡用 data.name：英文名转成标识", () => {
    expect(inferPresetIdentity({ spec: "chara_card_v2", data: { name: "Luna Bright", description: "x" } })).toEqual({
      id: "luna-bright",
      label: "Luna Bright",
    });
  });

  it("中文名生成稳定的短标识，名称保留中文", () => {
    const a = inferPresetIdentity({ spec: "chara_card_v3", data: { name: "小满", description: "x" } });
    const b = inferPresetIdentity({ spec: "chara_card_v3", data: { name: "小满", description: "x" } });
    expect(a?.label).toBe("小满");
    expect(a?.id).toMatch(/^card-[a-z0-9]+$/);
    expect(a?.id).toBe(b?.id);
  });

  it("识别不到名称时返回 null", () => {
    expect(inferPresetIdentity({ description: "only text" })).toBeNull();
  });
});

describe("账号昵称与修改者", () => {
  afterEach(() => setAccountNickname(""));

  it("从 getProfile 结果取昵称", () => {
    expect(nicknameFromProfile({ ok: true, value: { status: "ready", value: { id: "1", name: " 老大 ", contact: null } } })).toBe("老大");
    expect(nicknameFromProfile({ ok: true, value: null })).toBe("");
    expect(nicknameFromProfile({ ok: true, value: { status: "failed" } })).toBe("");
    expect(nicknameFromProfile({ ok: false })).toBe("");
  });

  it("human 显示为账号昵称，取不到时显示“你”", () => {
    expect(actorLabel("human", "zh")).toBe("你");
    setAccountNickname("老大");
    expect(actorLabel("human", "zh")).toBe("老大");
    expect(actorLabel("agent", "zh")).toBe("AI 助手");
    expect(actorLabel("dream", "zh")).toBe("自动整理");
  });
});

describe("注入记录的会话列表", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("按最近一次注入时间倒序，带次数和字符合计", () => {
    dir = mkdtempSync(join(tmpdir(), "memweave-ledger-"));
    const env = openWeaveDb(dir, { readonly: false });
    try {
      ensureSchema(env);
      addLedger(env, { sessionId: "old", segment: "s2-snapshot", chars: 100, items: 1, trimmed: 0 });
      addLedger(env, { sessionId: "new", segment: "s2-snapshot", chars: 50, items: 1, trimmed: 0 });
      addLedger(env, { sessionId: "new", segment: "s3-delta", chars: 30, items: 2, trimmed: 0 });
      env.db.exec("UPDATE budget_ledger SET ts = 1000 WHERE session_id = 'old'");
      const sessions = listLedgerSessions(env, 10);
      expect(sessions.map((s) => s.sessionId)).toEqual(["new", "old"]);
      expect(sessions[0]).toMatchObject({ turns: 2, chars: 80 });
    } finally {
      env.close();
    }
  });
});
