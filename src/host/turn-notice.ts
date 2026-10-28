/**
 * 忆织 MemWeave —— 对话内显式通知：每轮结束后在对话里显示本轮写了什么、整理了什么。
 * 给用户清晰的反馈，免得有疑虑："AI 到底记没记？记的准不准？"
 */

import type { WeaveEnv } from "../store/db";
import { queryAudit } from "../store/dao";

export interface TurnNoticeConfig {
  enabled: boolean;
}

export interface TurnNotice {
  /** 自动通知可见否：false = 不在对话里显示 */
  enabled: boolean;
  /** 折叠时的一行摘要 */
  summary: string;
  /** 展开后的详细说明（多行文本） */
  body: string;
}

/**
 * 汇总指定时间窗口内的记忆动作，返回通知卡片内容。
 * @param env 数据库环境
 * @param since 起始时间（Unix ms），通常是轮次开始时刻
 * @param lang 提示语言（zh / en）
 * @param cfg 是否启用通知
 * @returns 通知结构，enabled=false 时不显示
 */
export function buildTurnNotice(env: WeaveEnv, since: number, lang: "zh" | "en", cfg: TurnNoticeConfig): TurnNotice {
  if (!cfg.enabled) return { enabled: false, summary: "", body: "" };

  const rows = queryAudit(env, { since, limit: 500 });
  if (rows.length === 0) return { enabled: false, summary: "", body: "" };

  const writes = rows.filter((r) => r.action === "memory.write" && r.reason?.includes("L0"));
  const merged = rows.filter((r) => r.action === "memory.merge");
  const deduped = rows.filter((r) => r.action === "memory.write" && r.reason?.includes("dedupe"));
  const pending = rows.filter((r) => r.action === "memory.write" && (r.reason?.includes("L2") || r.reason?.includes("conflict:")));
  const blocked = rows.filter((r) => r.action === "memory.write" && r.reason?.includes("sensitive"));
  const revisions = rows.filter((r) => r.action === "memory.revise" || r.action === "memory.archive");
  const dreamExpire = rows.filter((r) => r.action === "dream.expire");
  const dreamConsolidate = rows.filter((r) => r.action === "dream.consolidate");
  const dreamMerge = rows.filter((r) => r.action === "dream.merge");
  const dreamPromote = rows.filter((r) => r.action === "dream.promote");
  // roadmap 阶段 C
  const dreamLinks = rows.filter((r) => r.action === "dream.links");
  const dreamCoRecall = rows.filter((r) => {
    if (r.action !== "dream.co-recall") return false;
    try {
      const j = JSON.parse(r.after ?? "{}") as Record<string, number>;
      return (j.reinforced ?? 0) + (j.created ?? 0) + (j.decayed ?? 0) + (j.removed ?? 0) > 0;
    } catch {
      return false;
    }
  });
  const dreamBoost = rows.filter((r) => r.action === "dream.boost");
  const dreamDistill = rows.filter((r) => r.action === "dream.distill");
  const dreamSuggest = rows.filter((r) => r.action === "dream.suggest");

  const zh = lang === "zh";
  const lines: string[] = [];
  const counts: string[] = [];

  if (writes.length > 0) {
    counts.push(zh ? `写入 ${writes.length} 条` : `${writes.length} written`);
    lines.push(zh ? `**写入** ${writes.length} 条：` : `**Written** ${writes.length}:`);
    writes.slice(0, 5).forEach((r) => {
      const text = (r.after ?? "").replace(/\s+/g, " ").trim();
      const snippet = text.slice(0, 60) + (text.length > 60 ? "…" : "");
      lines.push(`  - ${snippet}`);
    });
    if (writes.length > 5) lines.push(zh ? `  （还有 ${writes.length - 5} 条）` : `  (${writes.length - 5} more)`);
  }

  if (merged.length > 0) {
    counts.push(zh ? `合并 ${merged.length} 条` : `${merged.length} merged`);
    lines.push(zh ? `**合并到已有记忆** ${merged.length} 条` : `**Merged** ${merged.length}`);
  }

  if (deduped.length > 0) {
    counts.push(zh ? `已存在 ${deduped.length} 条` : `${deduped.length} duplicate`);
    lines.push(zh ? `**重复跳过** ${deduped.length} 条（库里已有相同内容）` : `**Duplicate** ${deduped.length} (already stored)`);
  }

  if (pending.length > 0) {
    counts.push(zh ? `待确认 ${pending.length} 条` : `${pending.length} pending`);
    lines.push(zh ? `**候选待确认** ${pending.length} 条` : `**Pending** ${pending.length}`);
  }

  if (blocked.length > 0) {
    counts.push(zh ? `已拦截 ${blocked.length} 条` : `${blocked.length} blocked`);
    lines.push(zh ? `**敏感内容拦截** ${blocked.length} 条` : `**Blocked** ${blocked.length} (sensitive)`);
  }

  const cOrg = [dreamLinks, dreamCoRecall, dreamBoost, dreamDistill].reduce((s, a) => s + a.length, 0);
  if (revisions.length > 0 || dreamExpire.length > 0 || dreamConsolidate.length > 0 || cOrg > 0) {
    const orgTotal = revisions.length + dreamExpire.length + dreamConsolidate.length + cOrg;
    counts.push(zh ? `整理 ${orgTotal} 条` : `${orgTotal} organized`);
    const orgLines: string[] = [];
    if (revisions.length > 0) orgLines.push(zh ? `修订/归档 ${revisions.length}` : `revised/archived ${revisions.length}`);
    if (dreamExpire.length > 0) orgLines.push(zh ? `过期标记 ${dreamExpire.length}` : `expired ${dreamExpire.length}`);
    if (dreamConsolidate.length > 0) orgLines.push(zh ? `冷记忆合并 ${dreamConsolidate.length}` : `cold-merged ${dreamConsolidate.length}`);
    if (dreamLinks.length > 0) orgLines.push(zh ? `关联网体检 ${dreamLinks.length}` : `link check ${dreamLinks.length}`);
    if (dreamCoRecall.length > 0) orgLines.push(zh ? `重播强化 ${dreamCoRecall.length}` : `co-recall ${dreamCoRecall.length}`);
    if (dreamBoost.length > 0) orgLines.push(zh ? `升降级 ${dreamBoost.length}` : `boost ${dreamBoost.length}`);
    if (dreamDistill.length > 0) orgLines.push(zh ? `项目摘要 ${dreamDistill.length}` : `project digest ${dreamDistill.length}`);
    lines.push(zh ? `**整理**：${orgLines.join("，")}` : `**Organized**: ${orgLines.join(", ")}`);
  }

  if (dreamPromote.length > 0) {
    lines.push(zh ? `**提升契约提名** ${dreamPromote.length} 条（需人工确认）` : `**Contract promotion** ${dreamPromote.length} (pending approval)`);
  }
  if (dreamSuggest.length > 0) {
    lines.push(zh ? `**整理建议** ${dreamSuggest.length} 条（候选页确认）` : `**Dream suggestions** ${dreamSuggest.length} (see candidates)`);
  }

  // roadmap v0.6 M1：约定。疑似已兑现只提示，不自动结算
  const promiseSet = rows.filter((r) => r.action === "memory.promise");
  const promiseSettled = rows.filter((r) => r.action === "promise.kept" || r.action === "promise.broken" || r.action === "promise.extend");
  const hintSeen = new Set<string>();
  const promiseHints = rows.filter((r) => r.action === "promise.hint" && !hintSeen.has(r.target) && hintSeen.add(r.target));
  if (promiseSet.length > 0) {
    counts.push(zh ? `约定 ${promiseSet.length} 条` : `${promiseSet.length} promise(s)`);
    lines.push(zh ? `**记下约定** ${promiseSet.length} 条（到期前会提醒）` : `**Promises recorded** ${promiseSet.length}`);
  }
  if (promiseSettled.length > 0) {
    counts.push(zh ? `结算约定 ${promiseSettled.length} 条` : `${promiseSettled.length} promise(s) settled`);
    lines.push(zh ? `**结算约定** ${promiseSettled.length} 条（可撤销）` : `**Promises settled** ${promiseSettled.length} (undoable)`);
  }
  if (promiseHints.length > 0) {
    counts.push(zh ? `约定可能已兑现 ${promiseHints.length} 条` : `${promiseHints.length} promise(s) may be kept`);
    lines.push(zh ? `**这条约定可能已兑现**（未自动结算，确认后可用 weave_promise 标记）：` : `**This promise may already be kept** (not settled automatically):`);
    promiseHints.slice(0, 5).forEach((r) => lines.push(`  - ${(r.after ?? "").slice(0, 60)} [${r.target}]`));
  }

  // 本轮没有可汇报的动作（例如只有召回计数之类的审计）：不出卡片
  if (counts.length === 0 && dreamPromote.length === 0 && dreamSuggest.length === 0) return { enabled: false, summary: "", body: "" };

  const summary = (zh ? "忆织：本轮" : "MemWeave: ") + (counts.length > 0 ? counts.join(zh ? "，" : ", ") : (zh ? "提名契约" : "contract nominated"));
  // 正文模型也会看到：开头声明这是系统记录，避免被当成用户指令
  const header = zh ? "[忆织系统记录，非用户发言，无需回应]" : "[MemWeave system record, not a user message; no reply needed]";
  const body = header + "\n" + lines.join("\n");

  return { enabled: true, summary, body };
}
