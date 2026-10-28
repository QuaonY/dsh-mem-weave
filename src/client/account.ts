/**
 * 忆织 MemWeave —— 当前登录 DSH 账号的昵称（只用于界面显示“修改者”）
 *
 * 读取路径与 DSH 自带账号设置页一致：`ctx.remote.account.getProfile(client)`，
 * 返回 `{ ok, value: null | { status: "ready", value: { name } } | { status: "failed" } }`。
 * 库里的 actor 仍是 "human" / "agent"（RBAC 依赖它），这里只把 "human" 显示成账号昵称。
 * 账号服务缺失、未登录或请求失败时静默回退为通用称呼，绝不影响设置页其余功能。
 */

import { t } from "../i18n";

type AccountRemote = {
  getProfile?: (client: Record<string, unknown>) => Promise<{ ok?: boolean; value?: unknown }>;
};

/** 账号 Remote 要求客户端带版本号；与本插件适配的 DSH 版本保持一致 */
const CLIENT_VERSION = "0.2.1-rc.3";

let nickname = "";

export function accountNickname(): string {
  return nickname;
}

/** 测试与卸载用 */
export function setAccountNickname(value: string): void {
  nickname = value;
}

/** 从 profile 结果里取昵称；结构不符时返回空串 */
export function nicknameFromProfile(result: unknown): string {
  const outer = result && typeof result === "object" ? (result as { ok?: boolean; value?: unknown }) : null;
  if (!outer || outer.ok === false) return "";
  const profile = outer.value && typeof outer.value === "object" ? (outer.value as { status?: string; value?: unknown }) : null;
  if (!profile || profile.status !== "ready") return "";
  const data = profile.value && typeof profile.value === "object" ? (profile.value as { name?: unknown }) : null;
  return typeof data?.name === "string" ? data.name.trim() : "";
}

/** 用注入了 remote.account 的 ctx 读一次昵称；任何失败都只返回空串 */
export async function loadAccountNickname(ctx: Record<string, unknown>, locale = "zh-CN"): Promise<string> {
  try {
    const remote = ctx.remote as { account?: AccountRemote } | undefined;
    const getProfile = remote?.account?.getProfile;
    if (typeof getProfile !== "function") return "";
    const result = await getProfile.call(remote?.account, {
      version: CLIENT_VERSION,
      locale,
      timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
    });
    nickname = nicknameFromProfile(result);
    return nickname;
  } catch {
    return "";
  }
}

/** 把库里的 actor 翻成界面上的“修改者” */
export function actorLabel(actor: unknown, lang: string): string {
  const raw = String(actor ?? "").trim();
  if (raw === "" || raw === "human") return nickname || t("actor.human", lang);
  if (raw === "agent") return t("actor.agent", lang);
  if (raw === "system") return t("actor.system", lang);
  if (raw === "dream") return t("actor.dream", lang);
  return raw;
}
