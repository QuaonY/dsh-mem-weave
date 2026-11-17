/**
 * 忆织 MemWeave —— 白盒健康检查
 * 与 status/selfcheck 互补：selfcheck 管「三段同源 / 写权 / 导出往返 / integrity_check / 工具注册」
 * 这里管结构版本、索引、孤儿引用、保留清理是否在跑、向量任务积压和库空间。全程只读。
 */

import type { WeaveEnv } from "./db";
import { LAYER_TABLES, SCHEMA_VERSION } from "./schema";
import { LEVEL_ORDER, type BudgetConfig } from "../core/types";

export type HealthStatus = "pass" | "warn" | "fail";

export interface HealthCheck {
  name: string;
  status: HealthStatus;
  detail: string;
  data?: Record<string, unknown>;
}

export interface HealthReport {
  ok: boolean;
  ts: number;
  checks: HealthCheck[];
  summary: { pass: number; warn: number; fail: number };
}

export interface HealthOptions {
  budget: BudgetConfig;
  /** governance.auditKeepDays；未设置则不检查审计清理 */
  auditKeepDays?: number;
  /** 语义路状态（service 传入；缺省表示未配置 provider） */
  vector?: {
    provider: string | null;
    model: string | null;
    dimensions: number | null;
    backend: "sqlite-vec" | "vectra" | "builtin" | "disabled";
    enabled: boolean;
    reason: string;
  };
  now?: number;
}

const DAY = 86400000;
/** 待索引任务超过这个时长仍未处理，视为向量工作器停摆 */
const STALE_JOB_MS = 3600000;

export function tableExists(env: WeaveEnv, name: string): boolean {
  return !!env.db.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?").get(name);
}

function count(env: WeaveEnv, sql: string, ...params: Array<string | number>): number {
  const r = env.db.prepare(sql).get(...params) as { n?: number } | undefined;
  return Number(r?.n ?? 0);
}

/** 七层表 id 的并集子查询 */
export function allMemoryIdsSql(): string {
  return LEVEL_ORDER.map((l) => "SELECT id FROM " + LAYER_TABLES[l]).join(" UNION ALL ");
}

function guarded(name: string, fn: () => HealthCheck): HealthCheck {
  try {
    return fn();
  } catch (e) {
    return { name, status: "fail", detail: "检查出错: " + String(e) };
  }
}

function checkSchema(env: WeaveEnv): HealthCheck {
  const r = env.db.prepare("SELECT version FROM schema_version WHERE id = 1").get() as { version?: number } | undefined;
  const version = r?.version ?? null;
  if (version === SCHEMA_VERSION) {
    return { name: "schema", status: "pass", detail: "结构版本 v" + version, data: { version, expected: SCHEMA_VERSION } };
  }
  return {
    name: "schema",
    status: "fail",
    detail: "结构版本 " + (version === null ? "缺失" : "v" + version) + "，应为 v" + SCHEMA_VERSION,
    data: { version, expected: SCHEMA_VERSION },
  };
}

export function requiredIndexes(): string[] {
  const perLayer = LEVEL_ORDER.flatMap((l) => {
    const t = LAYER_TABLES[l];
    return ["ix_" + t + "_status_level", "ix_" + t + "_semkey", "ix_" + t + "_updated"];
  });
  return [
    ...perLayer,
    "ix_cand_verdict",
    "ix_audit_ts",
    "ix_audit_action",
    "ix_ledger_sess",
    "ix_recall_mem",
    "ix_l0_session",
    "ix_l0_retained",
    "ix_distill_status",
  ];
}

function checkIndexes(env: WeaveEnv): HealthCheck {
  const rows = env.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>;
  const have = new Set(rows.map((r) => r.name));
  const missing = requiredIndexes().filter((n) => !have.has(n));
  if (missing.length === 0) {
    return { name: "indexes", status: "pass", detail: "关键索引齐全（共 " + rows.length + " 个索引）", data: { total: rows.length } };
  }
  return { name: "indexes", status: "warn", detail: "缺少索引: " + missing.join(", "), data: { missing } };
}

function checkStatusValues(env: WeaveEnv): HealthCheck {
  const bad: Record<string, number> = {};
  for (const l of LEVEL_ORDER) {
    const n = count(
      env,
      "SELECT COUNT(*) AS n FROM " + LAYER_TABLES[l] + " WHERE status IS NULL OR status NOT IN ('active', 'stale', 'archived')",
    );
    if (n > 0) bad[l] = n;
  }
  const levels = Object.keys(bad);
  if (levels.length === 0) return { name: "status-values", status: "pass", detail: "条目状态取值正常" };
  return {
    name: "status-values",
    status: "warn",
    detail: "状态取值异常: " + levels.map((l) => l + " " + bad[l]).join(", "),
    data: { bad },
  };
}

function checkOrphans(env: WeaveEnv): HealthCheck {
  const ids = allMemoryIdsSql();
  const orphans: Record<string, number> = {
    recall_log: count(env, "SELECT COUNT(*) AS n FROM recall_log WHERE memory_id NOT IN (" + ids + ")"),
  };
  if (tableExists(env, "embedding_jobs")) {
    orphans.embedding_jobs = count(
      env,
      "SELECT COUNT(*) AS n FROM embedding_jobs WHERE status IN ('pending', 'processing') AND memory_id NOT IN (" + ids + ")",
    );
  }
  if (tableExists(env, "memory_embeddings")) {
    orphans.memory_embeddings = count(
      env,
      "SELECT COUNT(*) AS n FROM memory_embeddings WHERE memory_id NOT IN (" + ids + ")",
    );
  }
  const found = Object.entries(orphans).filter(([, n]) => n > 0);
  if (found.length === 0) return { name: "orphans", status: "pass", detail: "没有指向已删除条目的记录", data: orphans };
  return {
    name: "orphans",
    status: "warn",
    detail: "指向已删除条目的记录: " + found.map(([t, n]) => t + " " + n).join(", "),
    data: orphans,
  };
}

function checkRetention(env: WeaveEnv, opts: HealthOptions, now: number): HealthCheck {
  const data: Record<string, number> = {
    l0Expired: count(
      env,
      "SELECT COUNT(*) AS n FROM l0_messages WHERE retained_until IS NOT NULL AND retained_until < ?",
      now,
    ),
  };
  const issues: string[] = [];
  if (data.l0Expired > 0) issues.push("L0 有 " + data.l0Expired + " 条已过保留期未清理");
  if (typeof opts.auditKeepDays === "number" && opts.auditKeepDays > 0) {
    // 清理按天跑，留一天余量再报
    const cutoff = now - (opts.auditKeepDays + 1) * DAY;
    data.auditOverdue = count(env, "SELECT COUNT(*) AS n FROM audit_log WHERE ts < ?", cutoff);
    if (data.auditOverdue > 0) issues.push("审计日志有 " + data.auditOverdue + " 条超过保留天数");
  }
  if (issues.length === 0) return { name: "retention", status: "pass", detail: "保留期清理正常", data };
  return { name: "retention", status: "warn", detail: issues.join("；"), data };
}

function checkEmbeddingJobs(env: WeaveEnv, now: number): HealthCheck {
  if (!tableExists(env, "embedding_jobs")) {
    return { name: "embedding-jobs", status: "pass", detail: "向量索引未启用" };
  }
  const failed = count(env, "SELECT COUNT(*) AS n FROM embedding_jobs WHERE status = 'failed'");
  const pending = count(env, "SELECT COUNT(*) AS n FROM embedding_jobs WHERE status = 'pending'");
  const stalePending = count(
    env,
    "SELECT COUNT(*) AS n FROM embedding_jobs WHERE status = 'pending' AND created_at < ?",
    now - STALE_JOB_MS,
  );
  const data = { pending, failed, stalePending };
  const issues: string[] = [];
  if (failed > 0) issues.push(failed + " 个任务失败");
  if (stalePending > 0) issues.push(stalePending + " 个任务等待超过 1 小时");
  if (issues.length === 0) return { name: "embedding-jobs", status: "pass", detail: "待索引 " + pending + " 个", data };
  return { name: "embedding-jobs", status: "warn", detail: issues.join("；"), data };
}

/**
 * 语义路状态。
 * 以前「向量」只在 embedding-jobs 里以队列积压的形式出现，看不出「没配 provider」和
 * 「配了但后端没装」的区别。这里把原因直接写进健康检查，避免把「不可用」当成「正常」。
 */
function checkVector(opts: HealthOptions): HealthCheck {
  const v = opts.vector;
  if (!v || !v.provider) {
    return {
      name: "vector",
      status: "pass",
      detail: "未配置 embedding provider，语义路停用（关键词 + 关联图检索不受影响）",
      data: { enabled: false, reason: v?.reason ?? "not-configured" },
    };
  }
  const data = { ...v };
  if (v.enabled) {
    return {
      name: "vector",
      status: "pass",
      detail: "语义路可用（" + v.backend + " / " + v.provider + " / " + v.model + "）",
      data,
    };
  }
  const why =
    v.reason === "no-backend"
      ? "向量后端被显式关闭（MEMWEAVE_VECTOR_BACKEND=off）"
      : v.reason === "disabled"
        ? "vector_config.enabled = false"
        : v.reason;
  return { name: "vector", status: "warn", detail: "已配置 provider 但语义路不可用：" + why, data };
}

function checkBudget(budget: BudgetConfig): HealthCheck {
  const fields: Array<keyof BudgetConfig> = [
    "snapshotMaxChars",
    "deltaMaxChars",
    "recallMaxChars",
    "recallMaxItems",
    "totalWarnChars",
  ];
  const bad = fields.filter((k) => {
    const v = budget[k];
    return typeof v !== "number" || !Number.isFinite(v) || v <= 0;
  });
  if (bad.length === 0) return { name: "budget", status: "pass", detail: "注入预算取值有效" };
  return { name: "budget", status: "warn", detail: "预算取值无效: " + bad.join(", "), data: { bad } };
}

function checkStorage(env: WeaveEnv): HealthCheck {
  const pages = count(env, "SELECT page_count AS n FROM pragma_page_count()");
  const pageSize = count(env, "SELECT page_size AS n FROM pragma_page_size()");
  const free = count(env, "SELECT freelist_count AS n FROM pragma_freelist_count()");
  const sizeMb = (pages * pageSize) / (1024 * 1024);
  const freeRatio = pages > 0 ? free / pages : 0;
  const data = { sizeMb: Math.round(sizeMb * 10) / 10, freePages: free, freeRatio: Math.round(freeRatio * 100) / 100 };
  const issues: string[] = [];
  if (sizeMb >= 500) issues.push("库文件 " + data.sizeMb + "MB");
  // 小库的空闲页比例波动大，不报
  if (pages >= 1000 && freeRatio > 0.3) issues.push("空闲页占 " + Math.round(freeRatio * 100) + "%，可执行 VACUUM");
  if (issues.length === 0) return { name: "storage", status: "pass", detail: "库文件 " + data.sizeMb + "MB", data };
  return { name: "storage", status: "warn", detail: issues.join("；"), data };
}

export function runHealthCheck(env: WeaveEnv, opts: HealthOptions): HealthReport {
  const now = opts.now ?? Date.now();
  const checks = [
    guarded("schema", () => checkSchema(env)),
    guarded("indexes", () => checkIndexes(env)),
    guarded("status-values", () => checkStatusValues(env)),
    guarded("orphans", () => checkOrphans(env)),
    guarded("retention", () => checkRetention(env, opts, now)),
    guarded("embedding-jobs", () => checkEmbeddingJobs(env, now)),
    guarded("vector", () => checkVector(opts)),
    guarded("budget", () => checkBudget(opts.budget)),
    guarded("storage", () => checkStorage(env)),
  ];
  const summary = { pass: 0, warn: 0, fail: 0 };
  for (const c of checks) summary[c.status]++;
  return { ok: summary.fail === 0, ts: now, checks, summary };
}
