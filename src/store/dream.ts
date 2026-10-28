/**
 * 忆织 MemWeave —— dream 收梭管线（规划文档 §8.7 / §16）
 * 三步：① valid_to 过期 → stale（待人确认归档）
 *      ② 冷记忆合并进 topic（归档留指针）：fact/lesson/topic 按条，project 按整个休眠项目，user/rules/soul 不折叠
 *      ③ lesson → 契约晋升提名（§9-P1，人确认才写 persona.contracts）；记账（失败上限 3、租约 + 心跳）。
 * 衰减只发生在排序分（core/score），不动库。
 * 触发：空闲 ≥idleMinutes 且非峰时的自动定时器 / weave_consolidate 手动（force 跳过空闲与峰时）。
 */

import { LEVEL_ORDER, type Level, type MemoryEntry } from "../core/types";
import type { WeaveEnv } from "./db";
import {
  addAudit,
  appendUndo,
  archiveMemory,
  insertLink,
  insertMemory,
  listMemory,
  newId,
  reviseMemory,
} from "./dao";
import { LAYER_TABLES } from "./schema";
import { promotableLessons, proposeContractPromotion } from "./promote";
import { proposeContractReviews } from "./review";
import type { Contract } from "../core/types";
import type { PromiseConfig } from "../core/promise";
import type { SearchTermsConfig } from "../core/terms";
import { findDistillGroups, termsBacklogCount, type GroupDistillConfig } from "./distill-queue";
import {
  CandidateBudget,
  DEFAULT_BOOST,
  DEFAULT_CORECALL,
  DEFAULT_MAX_CANDIDATES,
  DEFAULT_STALE_ASK_DAYS,
  DISTILLED_SECTION,
  adjustBoost,
  distillProjects,
  linkHealth,
  proposeArchive,
  proposeCore,
  proposePromiseDue,
  proposeRules,
  reinforceCoRecall,
  type BoostConfig,
  type BoostReport,
  type CoRecallConfig,
  type CoRecallReport,
  type DistillConfig,
  type LinkHealthReport,
} from "./dream-c";

export interface DreamConfigLike {
  enabled: boolean;
  idleMinutes: number;
  timezone: string;
  peakHours: Array<[number, number]>;
  leaseHours: number;
  maxFailures: number;
  /** 附录 A lifecycle.coldMemoryMonths：冷记忆窗口月数（缺省 6，§8.7） */
  coldMemoryMonths?: number;
  /** 附录 A lifecycle.mergeOnDream：是否执行冷合并轮（缺省 true） */
  mergeOnDream?: boolean;
  /** roadmap G6：当前人格契约（复核轮用；缺省不跑） */
  contracts?: Contract[];
  /** roadmap 阶段 C（缺省取 dream-c 默认值） */
  coRecall?: CoRecallConfig;
  boost?: BoostConfig;
  staleAskDays?: number;
  distill?: DistillConfig;
  maxCandidatesPerDream?: number;
  /** roadmap v0.6 M1：约定到期轮（缺省不跑） */
  promise?: PromiseConfig;
  /** 本地时区（约定日按本地日算） */
  localTimeZone?: string;
  /** roadmap v0.7 S2：会话内归纳的找组轮（缺省不跑） */
  groupDistill?: GroupDistillConfig;
  /** roadmap v0.7 S1：待补检索词计数（缺省不跑） */
  searchTerms?: SearchTermsConfig;
}

export interface DreamReport {
  ran: boolean;
  reason: string;
  expired: number;
  stalePending: string[];
  merged: number;
  /** fact / lesson / topic 冷合并的摘要 id（休眠项目的摘要见 projectFolds） */
  topicId?: string;
  /** 本轮所有被折叠的条目（冷合并 + 休眠项目） */
  mergedFrom: string[];
  /** 休眠项目折叠：每个项目一条摘要 */
  projectFolds?: ProjectFold[];
  /** P1：提名「拟晋升为人格契约」候选 id（人确认才写 persona.contracts） */
  promoted: string[];
  /** roadmap G6：契约复核候选 id */
  reviews?: string[];
  /** roadmap 阶段 C */
  linksFixed?: LinkHealthReport;
  coRecall?: CoRecallReport;
  boost?: BoostReport;
  distilled?: string[];
  suggestions?: { rules: string[]; core: string[]; archive: string[]; promises?: string[] };
  /** D5：因名额用完这次没生成的候选数 */
  candidatesSkipped?: number;
  roundErrors?: Array<{ round: string; error: string }>;
  failures: number;
  rounds: Array<{ round: string; items: number }>;
}

const DAY_MS = 86400000;
/** 冷记忆窗口默认月数（§8.7：≥6 个月未召回；可由 lifecycle.coldMemoryMonths 覆盖） */
const COLD_MONTHS = 6;

function emptyReport(reason: string, failures = 0): DreamReport {
  return {
    ran: false,
    reason,
    expired: 0,
    stalePending: [],
    merged: 0,
    mergedFrom: [],
    promoted: [],
    failures,
    rounds: [],
  };
}

// ---------- dream_state：租约 / 心跳 / 失败计数 ----------

export interface DreamStateRow {
  leaseOwner: string | null;
  leaseUntil: number | null;
  lastRun: number | null;
  lastHeartbeat: number | null;
  failures: number;
  state: string;
}

export function dreamState(env: WeaveEnv): DreamStateRow {
  const r = env.db.prepare("SELECT * FROM dream_state WHERE id = 1").get() as Record<string, unknown> | undefined;
  return {
    leaseOwner: r?.lease_owner == null ? null : String(r.lease_owner),
    leaseUntil: r?.lease_until == null ? null : Number(r.lease_until),
    lastRun: r?.last_run == null ? null : Number(r.last_run),
    lastHeartbeat: r?.last_heartbeat == null ? null : Number(r.last_heartbeat),
    failures: Number(r?.failures ?? 0),
    state: String(r?.state ?? "idle"),
  };
}

/** 抢租约：空闲或过期才能拿走；心跳 6h（leaseHours）内别人进不来 */
export function acquireDreamLease(env: WeaveEnv, owner: string, now: number, leaseMs: number): boolean {
  const st = dreamState(env);
  const free = st.leaseUntil === null || st.leaseUntil <= now;
  if (!free && st.leaseOwner !== owner) return false;
  env.db
    .prepare(
      "INSERT INTO dream_state (id, lease_owner, lease_until, last_run, last_heartbeat, failures, state)" +
        " VALUES (1, ?, ?, COALESCE((SELECT last_run FROM dream_state WHERE id = 1), 0), ?," +
        " COALESCE((SELECT failures FROM dream_state WHERE id = 1), 0), 'running')" +
        " ON CONFLICT(id) DO UPDATE SET lease_owner = excluded.lease_owner," +
        " lease_until = excluded.lease_until, last_heartbeat = excluded.last_heartbeat, state = 'running'",
    )
    .run(owner, now + leaseMs, now);
  return true;
}

export function heartbeatDreamLease(env: WeaveEnv, owner: string, now: number, leaseMs: number): void {
  env.db
    .prepare("UPDATE dream_state SET lease_until = ?, last_heartbeat = ? WHERE id = 1 AND lease_owner = ?")
    .run(now + leaseMs, now, owner);
}

export function releaseDreamLease(env: WeaveEnv, owner: string, ok: boolean, now: number, failures: number): void {
  env.db
    .prepare(
      "UPDATE dream_state SET lease_owner = NULL, lease_until = NULL, last_run = ?, failures = ?, state = ?" +
        " WHERE id = 1 AND lease_owner = ?",
    )
    .run(now, failures, ok ? "idle" : "failed", owner);
}

/** 人工清失败计数（失败上限 3 后的解锁入口） */
export function resetDreamFailures(env: WeaveEnv): void {
  env.db.prepare("UPDATE dream_state SET failures = 0, state = 'idle' WHERE id = 1").run();
}

// ---------- 峰时与空闲 ----------

/** 当前小时（0-23），时区可配（D14 默认 Asia/Shanghai）；Intl 失败退回 UTC */
export function hourIn(timezone: string, now: number): number {
  try {
    const s = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", hour12: false }).format(
      new Date(now),
    );
    const h = parseInt(s, 10);
    return Number.isFinite(h) ? h % 24 : new Date(now).getUTCHours();
  } catch {
    return new Date(now).getUTCHours();
  }
}

export function isPeakHour(now: number, timezone: string, peakHours: Array<[number, number]>): boolean {
  const h = hourIn(timezone, now);
  return peakHours.some(([a, b]) => (a <= b ? h >= a && h < b : h >= a || h < b));
}

/** 最近一次写活动（七层表 updated_at 与审计 ts 取最大），空闲判定用 */
export function lastActivityAt(env: WeaveEnv): number {
  let last = 0;
  for (const level of LEVEL_ORDER) {
    try {
      const r = env.db.prepare("SELECT MAX(updated_at) AS m FROM " + LAYER_TABLES[level]).get() as
        | { m?: number }
        | undefined;
      last = Math.max(last, Number(r?.m ?? 0));
    } catch {
      // 表缺失忽略
    }
  }
  try {
    const r = env.db.prepare("SELECT MAX(ts) AS m FROM audit_log").get() as { m?: number } | undefined;
    last = Math.max(last, Number(r?.m ?? 0));
  } catch {
    // 同上
  }
  return last;
}

// ---------- 管线 ----------

/** 冷合并写的摘要条目的 section */
export const CONSOLIDATED_SECTION = "consolidated";

/** 一个休眠项目折叠成的一条摘要 */
export interface ProjectFold {
  project: string;
  topicId: string;
  memberIds: string[];
}

interface Collected {
  stale: MemoryEntry[];
  /** fact / lesson / topic 层：从没被召回过、coldMs 没更新的单条冷记忆 */
  cold: MemoryEntry[];
  /** project 层：整个项目都休眠了，按项目分组折叠 */
  dormant: Map<string, MemoryEntry[]>;
}

/**
 * 挑出过期条目和可折叠的冷记忆。
 * - user 层（主人本人）和 rules / soul 层永不自动折叠。
 * - project 层按项目判断：同一项目里任一条目 coldMs 内更新过、被召回过，或还有没结算的约定，
 *   就算活跃，整个项目一条都不折叠；整个项目都休眠，才把它的旧条目一起折叠。没填项目名的不折叠。
 * - pending 约定、带日历锚点的条目在任何层都不折叠（折叠会归档它们，约定与锚点就失效了）。
 */
function collect(env: WeaveEnv, now: number, coldMs: number): Collected {
  const stale: MemoryEntry[] = [];
  const cold: MemoryEntry[] = [];
  const since = now - coldMs;
  // recall_log 只保留 RECALL_LOG_KEEP_DAYS 天，窗口更长时实际看的是保留期内的召回
  const recalled = new Set(
    (env.db.prepare("SELECT DISTINCT memory_id FROM recall_log WHERE ts >= ?").all(since) as Array<{ memory_id: string }>).map((r) =>
      String(r.memory_id),
    ),
  );
  const activeProjects = new Set<string>();
  const projectPool = new Map<string, MemoryEntry[]>();
  for (const level of LEVEL_ORDER) {
    for (const e of listMemory(env, { level })) {
      if (e.status === "archived") continue;
      const p = e.project && e.project.trim().length > 0 ? e.project : null;
      // dream 自己写的摘要（冷合并摘要、项目主题索引）不算项目活跃，否则折叠完项目又「活」了
      if (p && e.section !== CONSOLIDATED_SECTION && e.section !== DISTILLED_SECTION) {
        if (e.updatedAt > since || recalled.has(e.id) || e.promiseState === "pending") activeProjects.add(p);
      }
      if (e.validTo !== null && e.validTo <= now && e.status === "active") {
        stale.push(e);
        continue;
      }
      const foldable =
        e.status === "active" &&
        e.level !== "rules" &&
        e.level !== "soul" &&
        e.level !== "user" &&
        e.promiseState !== "pending" &&
        !e.calendarAnchor &&
        now - e.updatedAt >= coldMs;
      if (!foldable) continue;
      if (e.level === "project") {
        if (!p || recalled.has(e.id)) continue;
        const arr = projectPool.get(p) ?? [];
        arr.push(e);
        projectPool.set(p, arr);
        continue;
      }
      if (e.accessCount === 0) cold.push(e);
    }
  }
  const dormant = new Map<string, MemoryEntry[]>();
  for (const [p, arr] of [...projectPool.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    if (!activeProjects.has(p) && arr.length >= 2) dormant.set(p, arr);
  }
  return { stale, cold, dormant };
}

/** 把一组条目折叠成一条 topic 摘要：原条目归档并用 merged 边指向摘要；写撤销与审计。返回摘要 id */
function foldInto(env: WeaveEnv, members: MemoryEntry[], title: string, project: string | null, actor: string, now: number): string {
  const body = members
    .map((e) => "- [" + e.id + "] " + e.content)
    .join("\n")
    .slice(0, 1900);
  const topicId = newId();
  insertMemory(env, {
    id: topicId,
    level: "topic",
    project,
    section: CONSOLIDATED_SECTION,
    content: title + "（" + members.length + " 条）：\n" + body,
    keywords: ["consolidated"],
    importance: 2,
    status: "active",
    semanticKey: null,
    confidence: null,
    validFrom: now,
    validTo: null,
    evidence: [],
    hash: "consolidated:" + topicId,
    source: actor,
    accessCount: 0,
    tier: "cold",
    createdAt: now,
    updatedAt: now,
  });
  const memberIds: string[] = [];
  for (const e of members) {
    insertLink(env, { src: topicId, dst: e.id, kind: "merged", weight: 1, createdAt: now });
    archiveMemory(env, e.id, actor);
    memberIds.push(e.id);
  }
  // 撤销留痕：冷合并可回滚（撤摘要 + 还原成员，§13.2.6）
  appendUndo(env, { actor, action: "dream.merge", target: topicId, payload: { summaryId: topicId, memberIds } });
  addAudit(env, {
    actor,
    action: "dream.consolidate",
    target: topicId,
    after: JSON.stringify(project ? { merged: memberIds.length, project } : { merged: memberIds.length }),
  });
  return topicId;
}

/**
 * 跑一轮收梭。force=true 手动触发：跳过空闲与峰时判断（租约与失败上限仍生效）。
 * 过期条目只标 stale（待人确认归档，§8.7「dream 时询问归档」），不自动归档。
 */
export function runDream(
  env: WeaveEnv,
  cfg: DreamConfigLike,
  actor: string = "dream",
  opts?: { force?: boolean; now?: number },
): DreamReport {
  const now = opts?.now ?? Date.now();
  if (cfg.enabled !== true && opts?.force !== true) return emptyReport("disabled");

  const st = dreamState(env);
  // 失败上限对 force 同样生效（租约与失败上限仍生效）；解锁入口是 resetDreamFailures
  if (st.failures >= cfg.maxFailures) {
    return emptyReport("failures-limit", st.failures);
  }

  if (opts?.force !== true) {
    const idleMs = cfg.idleMinutes * 60000;
    if (idleMs > 0 && now - lastActivityAt(env) < idleMs) return emptyReport("busy", st.failures);
    if (isPeakHour(now, cfg.timezone, cfg.peakHours)) return emptyReport("peak-hours", st.failures);
  }

  const leaseMs = Math.max(1, cfg.leaseHours) * 3600000;
  if (!acquireDreamLease(env, actor, now, leaseMs)) return emptyReport("lease-held", st.failures);

  try {
    const c = cfg;
    const errors: Array<{ round: string; error: string }> = [];
    /** 单轮失败只记错误，不影响后面的轮次（§5） */
    const round = <T>(name: string, fn: () => T, fallback: T): T => {
      try {
        heartbeatDreamLease(env, actor, now, leaseMs);
        return fn();
      } catch (e) {
        errors.push({ round: name, error: String(e).slice(0, 200) });
        try {
          addAudit(env, { actor, action: "dream.round-failed", target: name, after: String(e).slice(0, 200) });
        } catch {
          // 审计也写不进去时放弃
        }
        return fallback;
      }
    };
    const coldMs = Math.max(1, cfg.coldMemoryMonths ?? COLD_MONTHS) * 30 * DAY_MS;
    const { stale, cold, dormant } = collect(env, now, coldMs);

    // 轮①：过期 → stale（只改状态，不删不归档）
    for (const e of stale) {
      reviseMemory(env, e.id, { status: "stale" }, actor);
      addAudit(env, { actor, action: "dream.expire", target: e.id, after: "stale", reason: "valid_to" });
      // 撤销留痕：过期标 stale 可回滚回原状态（§13.2.6 自动动作可撤销）
      appendUndo(env, {
        actor,
        action: "dream.status",
        target: e.id,
        payload: { before: { status: e.status, validTo: e.validTo ?? null } },
      });
    }

    // 轮②（G4 的询问归档候选放在最后按名额生成）
    // 轮③（R13）：关联网体检
    const linksFixed = round("link-health", () => linkHealth(env, actor, now), { selfLoop: 0, dangling: 0, dup: 0, keywords: 0 });
    // 轮④（R8）：重播强化
    const coRecall = round(
      "co-recall",
      () => reinforceCoRecall(env, c.coRecall ?? DEFAULT_CORECALL, actor, now),
      { pairs: 0, reinforced: 0, created: 0, decayed: 0, removed: 0 },
    );
    // 轮⑤（R6）：升级 / 降级
    const boost = round("boost", () => adjustBoost(env, c.boost ?? DEFAULT_BOOST, actor, now), { up: [] as string[], down: [] as string[] });

    // 轮⑥：冷记忆合并进 topic，原条目归档留指针（links kind=merged + topic 正文列 id）
    // user / rules / soul 层不参与；project 层只折叠整个休眠了的项目，每个项目单独一条摘要
    let merged = 0;
    let topicId: string | undefined;
    const mergedFrom: string[] = [];
    const projectFolds: ProjectFold[] = [];
    if (cfg.mergeOnDream !== false) {
      if (cold.length >= 2) {
        heartbeatDreamLease(env, actor, now, leaseMs);
        topicId = foldInto(env, cold, "冷记忆合并", cold[0].project, actor, now);
        for (const e of cold) mergedFrom.push(e.id);
        merged += cold.length;
      }
      for (const [project, members] of dormant) {
        heartbeatDreamLease(env, actor, now, leaseMs);
        const id = foldInto(env, members, "休眠项目「" + project + "」折叠", project, actor, now);
        projectFolds.push({ project, topicId: id, memberIds: members.map((e) => e.id) });
        for (const e of members) mergedFrom.push(e.id);
        merged += members.length;
      }
    }

    // 轮⑦（G3）：topic 聚成 project 摘要（不产生候选）
    const distilled = round("distill", () => (c.distill ? distillProjects(env, c.distill, actor, now).summaries : []), [] as string[]);

    // 候选名额（D5）：按优先级 契约复核 > 契约晋升 > 设为准则 > 建议常驻 > 建议归档 依次占用
    const budget = new CandidateBudget(Math.max(0, c.maxCandidatesPerDream ?? DEFAULT_MAX_CANDIDATES));

    // 轮⑧（G6）：契约被反复指出违反 → 复核候选
    const reviews = round(
      "contract-review",
      () => (cfg.contracts && cfg.contracts.length > 0 ? proposeContractReviews(env, cfg.contracts, actor, now, { limit: budget.left }) : []),
      [] as string[],
    );
    for (let i = 0; i < reviews.length; i += 1) budget.take();

    // 轮⑧b（v0.6 M1）：约定过期超过宽限期 → 「确认约定结果」候选；优先级在复核之后
    const promises = round(
      "promise-due",
      () => (c.promise?.enabled ? proposePromiseDue(env, c.promise, c.localTimeZone ?? "UTC", budget, actor, now) : []),
      [] as string[],
    );

    // 轮⑧：lesson → 契约晋升提名（§9-P1）；只提名候选，人确认才写 persona.contracts
    const promoted = round(
      "promote",
      () => {
        const out: string[] = [];
        for (const lesson of promotableLessons(env)) {
          if (!budget.take()) break;
          out.push(proposeContractPromotion(env, lesson, actor, now));
        }
        return out;
      },
      [] as string[],
    );
    const rules = round("distill-rules", () => (c.distill ? proposeRules(env, c.distill, budget, actor, now) : []), [] as string[]);
    const core = round("core-suggest", () => (c.boost?.enabled !== false ? proposeCore(env, budget, actor, now) : []), [] as string[]);
    const archive = round(
      "archive-suggest",
      () => proposeArchive(env, c.staleAskDays ?? DEFAULT_STALE_ASK_DAYS, budget, actor, now),
      [] as string[],
    );

    // 轮⑨（v0.7 S2）：待归纳。只找组放进 distill_queue，归纳由 AI 在会话里写（weave_distill）
    const groups = round(
      "distill-groups",
      () => (c.groupDistill ? findDistillGroups(env, c.groupDistill, now).created : []),
      [] as string[],
    );
    // 轮⑩（v0.7 S1 §6.4）：待补检索词。只计数；条目由 weave_backlog 实时列出
    const termsBacklog = round(
      "terms-backfill",
      () => (c.searchTerms?.enabled ? Math.min(c.searchTerms.backfillPerDream, termsBacklogCount(env)) : 0),
      0,
    );

    releaseDreamLease(env, actor, true, now, 0);
    return {
      ran: true,
      reason: "ok",
      expired: stale.length,
      stalePending: stale.map((e) => e.id),
      merged,
      topicId,
      mergedFrom,
      projectFolds,
      promoted,
      reviews,
      linksFixed,
      coRecall,
      boost,
      distilled,
      suggestions: { rules, core, archive, promises },
      candidatesSkipped: budget.skipped,
      failures: 0,
      rounds: [
        { round: "expire", items: stale.length },
        { round: "link-health", items: linksFixed.selfLoop + linksFixed.dangling + linksFixed.dup + linksFixed.keywords },
        { round: "co-recall", items: coRecall.reinforced + coRecall.created + coRecall.decayed + coRecall.removed },
        { round: "boost", items: boost.up.length + boost.down.length },
        { round: "cold-merge", items: merged },
        { round: "distill", items: distilled.length },
        { round: "contract-review", items: reviews.length },
        { round: "promise-due", items: promises.length },
        { round: "promote", items: promoted.length },
        { round: "distill-rules", items: rules.length },
        { round: "core-suggest", items: core.length },
        { round: "archive-suggest", items: archive.length },
        { round: "distill-groups", items: groups.length },
        { round: "terms-backfill", items: termsBacklog },
      ],
      roundErrors: errors,
    };
  } catch (e) {
    const failures = dreamState(env).failures + 1;
    releaseDreamLease(env, actor, false, now, failures);
    addAudit(env, { actor, action: "dream.failed", target: "run", after: String(e).slice(0, 200) });
    return emptyReport("error:" + String(e).slice(0, 120), failures);
  }
}

/** 手动触发（weave_consolidate）：与自动同一管线，force 跳过空闲/峰时 */
export function consolidateNow(env: WeaveEnv, cfg: DreamConfigLike, actor: string = "human"): DreamReport {
  return runDream(env, cfg, actor, { force: true });
}
