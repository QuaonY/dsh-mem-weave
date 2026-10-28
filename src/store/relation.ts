/**
 * 忆织 MemWeave —— 关系与情绪状态通径（规划文档 §9-P3 / §7.6）
 * 只由事件驱动小步调整：单次 ±0.05、每日 ±0.15 封顶；trust 夹在 [0,1]。
 * 只影响 S1 ⑧ 锚点措辞（渲染侧读 meta），不改契约、不改记忆内容；
 * 状态本身写进 soul 层一条记忆（semantic_key 固定），可被 weave_recall 检索。
 */

import type { PersonaMeta } from "../core/types";
import type { WeaveEnv } from "./db";
import {
  addAudit,
  findConflictingSemanticKey,
  getPersona,
  insertMemory,
  newId,
  reviseMemory,
  updatePersona,
} from "./dao";

export const RELATION_STATE_KEY = "persona:relation-state";
export const TRUST_STEP = 0.05;
export const TRUST_DAILY_CAP = 0.15;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** UTC 自然日起点（D14：时间一律 UTC 毫秒） */
function dayStart(now: number): number {
  return now - (now % 86400000);
}

/** 当日已消耗的调整额度（audit reason 记 delta=±0.0xx，取绝对值求和） */
export function trustSpentToday(env: WeaveEnv, now: number): number {
  const rows = env.db
    .prepare("SELECT reason FROM audit_log WHERE action = 'meta.trust' AND ts >= ?")
    .all(dayStart(now)) as Array<{ reason?: string | null }>;
  let sum = 0;
  for (const r of rows) {
    const m = /delta=([-+]?[0-9.]+)/.exec(String(r.reason ?? ""));
    if (m) sum += Math.abs(parseFloat(m[1]));
  }
  return sum;
}

export interface RelationPatch {
  trustDelta?: number;
  stage?: string;
  moodBias?: string;
  moodBaseline?: string;
}

export interface RelationResult {
  ok: boolean;
  code?: string;
  message?: string;
  trust?: number;
  applied?: number;
  version?: number;
}

function emptyMeta(meta?: Partial<PersonaMeta>): PersonaMeta {
  return {
    relation: { stage: meta?.relation?.stage ?? "", trust: meta?.relation?.trust ?? 0 },
    mood: { baseline: meta?.mood?.baseline ?? "", bias: meta?.mood?.bias ?? "" },
    taboos: meta?.taboos ?? [],
    lexicon: meta?.lexicon ?? {},
  };
}

/** 事件驱动的小步调整（§9-P3）；返回实际生效的步长 */
export function bumpRelation(
  env: WeaveEnv,
  patch: RelationPatch,
  actor: string,
  now = Date.now(),
): RelationResult {
  const persona = getPersona(env);
  const meta = emptyMeta(persona.config.meta);
  let trust = clamp(meta.relation.trust, 0, 1);
  let applied = 0;

  if (typeof patch.trustDelta === "number" && patch.trustDelta !== 0) {
    const remaining = Math.max(0, TRUST_DAILY_CAP - trustSpentToday(env, now));
    applied = clamp(patch.trustDelta, -TRUST_STEP, TRUST_STEP);
    applied = clamp(applied, -remaining, remaining);
    trust = clamp(trust + applied, 0, 1);
  }

  const nextMeta: PersonaMeta = {
    ...meta,
    relation: { stage: patch.stage ?? meta.relation.stage, trust },
    mood: {
      baseline: patch.moodBaseline ?? meta.mood.baseline,
      bias: patch.moodBias ?? meta.mood.bias,
    },
  };

  const r = updatePersona(env, { meta: nextMeta }, actor);
  if (!r.ok) return { ok: false, code: r.code ?? "E_DB", message: "persona update failed" };

  addAudit(env, {
    actor,
    action: "meta.trust",
    target: "meta.relation",
    reason: "delta=" + applied.toFixed(2),
    after: "trust=" + trust.toFixed(3),
  });
  syncRelationMemory(env, nextMeta, actor);
  return { ok: true, trust, applied, version: r.version };
}

/** 状态镜像进 soul 层（可召回，§9-P3 末条） */
export function syncRelationMemory(env: WeaveEnv, meta: PersonaMeta, actor: string): void {
  const content =
    "关系状态：stage=" +
    (meta.relation.stage || "—") +
    " trust=" +
    meta.relation.trust.toFixed(2) +
    " mood=" +
    (meta.mood.baseline || "—") +
    "/" +
    (meta.mood.bias || "—");
  const existing = findConflictingSemanticKey(env, RELATION_STATE_KEY).find((e) => e.level === "soul");
  if (existing) {
    reviseMemory(env, existing.id, { content }, actor);
    return;
  }
  const ts = Date.now();
  insertMemory(env, {
    id: newId(),
    level: "soul",
    project: null,
    section: "relation",
    content,
    keywords: ["关系状态"],
    importance: 2,
    status: "active",
    semanticKey: RELATION_STATE_KEY,
    confidence: null,
    validFrom: ts,
    validTo: null,
    evidence: [],
    hash: null,
    source: actor,
    accessCount: 0,
    tier: "hot",
    createdAt: ts,
    updatedAt: ts,
  });
}
