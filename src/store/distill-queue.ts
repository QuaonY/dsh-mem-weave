/**
 * roadmap v0.7 S2：会话内 AI 归纳的「找组」与「落地」。
 * dream 只找组、不写归纳；AI 在会话里用 weave_distill 提交，照常过四级把关（C1）。
 * 与 G3 的 lifecycle.distill（topic → project 摘要，store/dream-c.ts）是两件事。
 */
import { tokenize } from "../core/tokenize";
import type { MemoryEntry } from "../core/types";
import type { WeaveEnv } from "./db";
import {
  archiveMemory,
  deleteLink,
  getLinks,
  getMemory,
  insertDistillGroup,
  insertLink,
  listConflicts,
  listDistillGroups,
  listMemory,
  newId,
  restoreMemory,
  setDistillStatus,
  type DistillGroup,
} from "./dao";

const DAY_MS = 86400000;

export interface GroupDistillConfig {
  enabled: boolean;
  groupMin: number;
  groupMax: number;
  coldDays: number;
  jaccard: number;
  perDream: number;
  maxOpen: number;
  expireDays: number;
  maxChars: number;
  coverage: number;
}

export const DEFAULT_GROUP_DISTILL: GroupDistillConfig = {
  enabled: true,
  groupMin: 3,
  groupMax: 8,
  coldDays: 30,
  jaccard: 0.3,
  perDream: 3,
  maxOpen: 10,
  expireDays: 30,
  maxChars: 200,
  coverage: 0.8,
};

/** dream 冷合并写出的机械拼接 topic（F3：可被改写成真正的归纳） */
export const CONSOLIDATED_PREFIX = "冷记忆合并（";
export const DISTILL_CAND_REASON = "session-distill";

export function isConsolidated(e: Pick<MemoryEntry, "level" | "section" | "content">): boolean {
  return e.level === "topic" && e.section === "consolidated" && e.content.startsWith(CONSOLIDATED_PREFIX);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/**
 * dream「待归纳」轮：过期旧组 → 找新组（每次最多 perDream 组，队列里 open 最多 maxOpen 组）。
 * 返回新建的组 id。
 */
export function findDistillGroups(env: WeaveEnv, cfg: GroupDistillConfig, now: number): { created: string[]; expired: number } {
  let expired = 0;
  const open = listDistillGroups(env, "open");
  const live: DistillGroup[] = [];
  for (const g of open) {
    if (now - g.createdAt >= cfg.expireDays * DAY_MS) {
      setDistillStatus(env, g.id, "expired");
      expired += 1;
    } else live.push(g);
  }
  const created: string[] = [];
  if (!cfg.enabled) return { created, expired };
  let room = Math.min(cfg.perDream, Math.max(0, cfg.maxOpen - live.length));
  if (room <= 0) return { created, expired };

  const queued = new Set(live.flatMap((g) => g.memberIds));
  const frozen = new Set<string>();
  for (const c of listConflicts(env, "open")) for (const t of c.contenders) frozen.add(t.id);
  const lastRecall = env.db.prepare("SELECT MAX(ts) AS t FROM recall_log WHERE memory_id = ?");
  const coldMs = cfg.coldDays * DAY_MS;
  const eligible = (e: MemoryEntry): boolean => {
    if (e.status !== "active") return false;
    // 排除名单：rules / soul / lesson / user 层不进组；闪光灯、pending 约定、日历锚点、未决冲突永远不进组
    if (e.level !== "topic" && e.level !== "fact" && e.level !== "project") return false;
    if (e.flash || e.promiseState === "pending" || e.calendarAnchor || frozen.has(e.id) || queued.has(e.id)) return false;
    const t = (lastRecall.get(e.id) as { t?: number | null } | undefined)?.t ?? null;
    return now - Math.max(t ?? 0, e.updatedAt) >= coldMs;
  };
  const pool = listMemory(env, { status: "active" })
    .filter(eligible)
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));

  // F3：旧的机械冷合并条目单独成组（改写成真正的归纳）
  for (const e of pool) {
    if (room <= 0) break;
    if (!isConsolidated(e)) continue;
    const g: DistillGroup = { id: newId(), memberIds: [e.id], reason: "consolidated", createdAt: now, status: "open" };
    insertDistillGroup(env, g);
    created.push(g.id);
    queued.add(e.id);
    room -= 1;
  }

  // 按 project 分桶；两两之间有关联边或分词 Jaccard ≥ 阈值才算相连；贪心取「与组内每条都相连」的成员
  const rest = pool.filter((e) => !queued.has(e.id) && !isConsolidated(e));
  const byProject = new Map<string, MemoryEntry[]>();
  for (const e of rest) {
    const k = e.project ?? "";
    byProject.set(k, [...(byProject.get(k) ?? []), e]);
  }
  for (const [, list] of [...byProject.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    if (room <= 0) break;
    if (list.length < cfg.groupMin) continue;
    const ids = new Set(list.map((e) => e.id));
    const toks = new Map(list.map((e) => [e.id, new Set(tokenize(e.content))]));
    const linked = new Map<string, Set<string>>();
    for (const e of list) {
      const s = new Set<string>();
      for (const l of getLinks(env, e.id)) {
        const o = l.src === e.id ? l.dst : l.src;
        if (o !== e.id && ids.has(o)) s.add(o);
      }
      linked.set(e.id, s);
    }
    const near = (a: string, b: string): boolean =>
      linked.get(a)!.has(b) || jaccard(toks.get(a)!, toks.get(b)!) >= cfg.jaccard;
    const used = new Set<string>();
    for (const seed of list) {
      if (room <= 0) break;
      if (used.has(seed.id)) continue;
      const members = [seed.id];
      let byLink = false;
      for (const c of list) {
        if (members.length >= cfg.groupMax) break;
        if (c.id === seed.id || used.has(c.id)) continue;
        if (members.every((m) => near(m, c.id))) {
          if (members.some((m) => linked.get(m)!.has(c.id))) byLink = true;
          members.push(c.id);
        }
      }
      if (members.length < cfg.groupMin) continue;
      for (const m of members) used.add(m);
      const g: DistillGroup = { id: newId(), memberIds: members, reason: byLink ? "links" : "jaccard", createdAt: now, status: "open" };
      insertDistillGroup(env, g);
      created.push(g.id);
      room -= 1;
    }
  }
  return { created, expired };
}

// ---------- roadmap v0.7 S1 §6.4：待补检索词 ----------

/** 缺检索词的 active 条目（含 rules / soul：只影响召回、不改内容）；按 importance、最近召回次数排序 */
export function termsBacklog(env: WeaveEnv, limit: number): MemoryEntry[] {
  const recent = env.db.prepare("SELECT COUNT(*) AS n FROM recall_log WHERE memory_id = ? AND ts >= ?");
  const since = Date.now() - 30 * DAY_MS;
  return listMemory(env, { status: "active" })
    .filter((e) => !e.searchTerms || e.searchTerms.length === 0)
    .map((e) => ({ e, n: Number((recent.get(e.id, since) as { n?: number } | undefined)?.n ?? 0) }))
    .sort((a, b) => b.e.importance - a.e.importance || b.n - a.n || (a.e.id < b.e.id ? -1 : 1))
    .slice(0, Math.max(0, limit))
    .map((x) => x.e);
}

export function termsBacklogCount(env: WeaveEnv): number {
  return listMemory(env, { status: "active" }).filter((e) => !e.searchTerms || e.searchTerms.length === 0).length;
}

/** 组成员（仍 active 的）；成员已被改动 / 归档的不算 */
export function groupMembers(env: WeaveEnv, g: DistillGroup): MemoryEntry[] {
  return g.memberIds.map((id) => getMemory(env, id)).filter((e): e is MemoryEntry => !!e && e.status === "active");
}

/** §7.3「不许编新事实」：归纳的分词（二元组 + 英文词）有多少比例在成员正文里出现过 */
export function coverage(summary: string, members: MemoryEntry[]): number {
  const toks = [...new Set(tokenize(summary))];
  if (toks.length === 0) return 0;
  const body = new Set(members.flatMap((e) => tokenize(e.content)));
  return toks.filter((t) => body.has(t)).length / toks.length;
}

export interface DistillUndo {
  summaryId: string;
  /** false = 归纳被近似合并进了已有条目（撤销时不删那条） */
  created?: boolean;
  groupId: string;
  memberIds: string[];
  /** F3：从旧冷合并条目转移过来的 merged 边终点 */
  movedFrom?: string;
  moved?: string[];
}

/**
 * 归纳通过后落地：和每个成员建 merged 边、成员归档；改写旧冷合并条目时旧条目归档、merged 边转给新条目。
 * 返回撤销载荷。
 */
export function landDistill(env: WeaveEnv, summaryId: string, g: DistillGroup, members: MemoryEntry[], actor: string, now: number): DistillUndo {
  const undo: DistillUndo = { summaryId, groupId: g.id, memberIds: [] };
  for (const m of members) {
    if (m.id === summaryId) continue;
    if (isConsolidated(m)) {
      const moved: string[] = [];
      for (const l of getLinks(env, m.id)) {
        if (l.kind !== "merged" || l.src !== m.id) continue;
        deleteLink(env, m.id, l.dst, "merged");
        insertLink(env, { src: summaryId, dst: l.dst, kind: "merged", weight: l.weight, createdAt: now });
        moved.push(l.dst);
      }
      undo.movedFrom = m.id;
      undo.moved = moved;
    }
    insertLink(env, { src: summaryId, dst: m.id, kind: "merged", weight: 1, createdAt: now });
    archiveMemory(env, m.id, actor);
    undo.memberIds.push(m.id);
  }
  setDistillStatus(env, g.id, "done");
  return undo;
}

/** 撤销：成员恢复 active、删掉新条目与边、边转回旧冷合并条目、组回到 open */
export function undoDistill(env: WeaveEnv, u: DistillUndo, actor: string): void {
  for (const mid of u.memberIds) {
    deleteLink(env, u.summaryId, mid, "merged");
    restoreMemory(env, mid, actor);
  }
  if (u.movedFrom) {
    for (const dst of u.moved ?? []) {
      deleteLink(env, u.summaryId, dst, "merged");
      insertLink(env, { src: u.movedFrom, dst, kind: "merged", weight: 1, createdAt: Date.now() });
    }
  }
  // 归纳是新写的条目才删；被近似合并进已有条目时，已有条目保留（合并本身由把关台账另行撤销）
  if (u.created !== false) {
    env.db.prepare("DELETE FROM links WHERE src = ? OR dst = ?").run(u.summaryId, u.summaryId);
    const e = getMemory(env, u.summaryId);
    if (e) env.db.prepare("DELETE FROM " + e.level + " WHERE id = ?").run(u.summaryId);
  }
  setDistillStatus(env, u.groupId, "open");
}
