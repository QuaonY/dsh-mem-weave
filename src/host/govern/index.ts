/**
 * 治理模块 —— 从 host/service.ts 纯搬迁（行为不变）。
 * 两件事：隐私检测的查询口与冲突的检测/列表/解决。
 * 这里只做 env + config 之上的计算，状态仍由 WeaveService 持有。
 */

import type { SQLInputValue } from "node:sqlite";
import { LEVEL_ORDER, type Level, type MemoryEntry } from "../../core/types";
import { appendUndo, archiveMemory, getMemory, listConflicts as listConflictRows, listMemory, reviseMemory } from "../../store/dao";
import { LAYER_TABLES } from "../../store/schema";
import type { WeaveEnv } from "../../store/db";
import { enqueueEmbedding, withdrawSensitiveEmbedding } from "../../store/vector";
import { MAX_CONTENT, scanSensitiveContent } from "../../store/govern";
import { extractKeywords } from "../../core/tokenize";
import type { FileLogger } from "../logger";
import type { SensitivityDetector } from "../../privacy/detector";
import {
  DEFAULT_PRIVACY_CONFIG,
  type PrivacyConfig,
  type SensitiveInfo,
} from "../../privacy/types";
import type { ConflictDetector } from "../../conflict/detector";
import {
  DEFAULT_CONFLICT_CONFIG,
  type ConflictConfig,
  type ConflictDetectionResult,
  type ConflictResolveOptions,
  type MemoryConflict,
} from "../../conflict/types";

// ---------- 隐私 ----------

export function detectSensitiveInfo(
  detector: SensitivityDetector | null,
  config: PrivacyConfig | undefined,
  text: string,
): SensitiveInfo[] {
  const cfg = config ?? DEFAULT_PRIVACY_CONFIG;
  if (!cfg.enabled || !detector) {
    return [];
  }
  return detector.detect(text, cfg);
}

export function hasSensitiveInfo(
  detector: SensitivityDetector | null,
  config: PrivacyConfig | undefined,
  text: string,
): boolean {
  const cfg = config ?? DEFAULT_PRIVACY_CONFIG;
  if (!cfg.enabled || !detector) {
    return false;
  }
  return detector.hasSensitiveInfo(text, cfg);
}

export function getSensitiveTypes(
  detector: SensitivityDetector | null,
  config: PrivacyConfig | undefined,
  text: string,
): string[] {
  const cfg = config ?? DEFAULT_PRIVACY_CONFIG;
  if (!cfg.enabled || !detector) {
    return [];
  }
  return detector.getSensitiveTypes(text, cfg);
}

/**
 * 只置位、不改其他字段：写入口自己判断是否敏感时用。
 * 置位后同步撤出向量索引。写入时 insertMemory 已经把原文排进 embedding_jobs
 * 不撤的话后台 worker 会把敏感原文发往 embedding 服务（外部服务模式下即出机器）。
 */
export function markMemorySensitive(env: WeaveEnv, id: string, level: Level): void {
  const table = LAYER_TABLES[level];
  // 表名只来自白名单映射；这里再兜一层，避免非法层名走到 `UPDATE undefined`
  if (!table) throw new Error("unknown level: " + String(level));
  env.db.prepare(`UPDATE ${table} SET is_sensitive = 1 WHERE id = ?`).run(id);
  withdrawSensitiveEmbedding(env, id);
}

/**
 * 设置页的手动标记/取消（actor 台账由调用方负责）。
 * 标记 → 撤出向量索引；取消 → 重新入队（向量未开启时 enqueueEmbedding 自己会跳过）。
 */
export function setMemorySensitive(env: WeaveEnv, id: string, level: Level, sensitive = true): void {
  const table = LAYER_TABLES[level];
  if (!table) throw new Error("unknown level: " + String(level));
  env.db.prepare(`UPDATE ${table} SET is_sensitive = ? WHERE id = ?`).run(sensitive ? 1 : 0, id);
  if (sensitive) {
    withdrawSensitiveEmbedding(env, id);
  } else {
    const entry = getMemory(env, id);
    if (entry) enqueueEmbedding(env, entry);
  }
}

export function listSensitiveMemories(env: WeaveEnv, level?: Level, limit = 100): MemoryEntry[] {
  const levels = level ? [level] : LEVEL_ORDER;
  const results: MemoryEntry[] = [];

  for (const lv of levels) {
    const lvResults = listMemory(env, { level: lv, limit }).filter((m) => {
      const table = LAYER_TABLES[lv];
      const row = env.db.prepare(`SELECT is_sensitive FROM ${table} WHERE id = ?`).get(m.id) as
        | { is_sensitive: number }
        | undefined;
      return row?.is_sensitive === 1;
    });
    results.push(...lvResults);
    if (results.length >= limit) break;
  }

  return results.slice(0, limit);
}

// ---------- 冲突 ----------

export function listConflicts(env: WeaveEnv, status?: "pending" | "resolved" | "ignored"): MemoryConflict[] {
  let sql = "SELECT * FROM memory_conflicts";
  const params: SQLInputValue[] = [];

  if (status) {
    sql += " WHERE status = ?";
    params.push(status);
  }

  sql += " ORDER BY created_at DESC";

  const stmt = env.db.prepare(sql);
  return stmt.all(...params) as unknown as MemoryConflict[];
}

/**
 * 每层最多扫描的活跃记忆条数。
 * 旧实现每层只取一页 500 条并叠加 90 天时间截断，长期使用的库会悄悄漏检。
 * 现在按 500 条一页分页读满该上限（7 层合计最多 7,000 条）
 * 冲突检测本身改为候选对生成，代价不再随条数平方增长。
 * 触顶时写一条 warn 日志，使截断不再是静默行为。
 */
export const CONFLICT_SCAN_PER_LEVEL = 1000;
const CONFLICT_SCAN_PAGE = 500;

/**
 * 每篇记忆最多保留的候选邻居数（按共享前缀 token 数排序）。
 * 用于给倒排探测兜底：超大同主题语料下，候选对不会再退化为 n²。
 * 实测 7,000 条重复度极高的中文语料，500 条截断 vs 精确只差 0.1% 的候选对。
 */
export const CONFLICT_MAX_CANDIDATES_PER_DOC = 500;

/** 分页读取待检测的活跃记忆（不按时间截断，按 updated_at 由新到旧）。 */
function loadActiveMemories(env: WeaveEnv, logger?: FileLogger | null): MemoryEntry[] {
  const out: MemoryEntry[] = [];
  for (const level of LEVEL_ORDER) {
    for (let offset = 0; offset < CONFLICT_SCAN_PER_LEVEL; offset += CONFLICT_SCAN_PAGE) {
      const limit = Math.min(CONFLICT_SCAN_PAGE, CONFLICT_SCAN_PER_LEVEL - offset);
      const page = listMemory(env, { level, status: "active", limit, offset });
      out.push(...page);
      if (page.length < limit) break;
      if (offset + limit >= CONFLICT_SCAN_PER_LEVEL) {
        logger?.warn("[Conflict] scan limit reached, older memories not checked", {
          level,
          limit: CONFLICT_SCAN_PER_LEVEL,
        });
      }
    }
  }
  return out;
}

/**
 * 检测记忆冲突：分页取活跃记忆，交检测器打分，落库新冲突，返回全量。
 * 去掉 90 天硬截断，改为每层上限 + 分页，避免旧记忆永远不参与检测。
 */
export function detectConflicts(
  env: WeaveEnv,
  detector: ConflictDetector | null,
  config: ConflictConfig | undefined,
  logger?: FileLogger | null,
): ConflictDetectionResult {
  const cfg = config ?? DEFAULT_CONFLICT_CONFIG;
  if (!cfg.enabled || !cfg.autoDetect || !detector) {
    return { conflicts: [], total: 0, new_conflicts: 0, pending_count: 0 };
  }

  const memories = loadActiveMemories(env, logger);

  const detected = detector.detectConflicts(memories, cfg.threshold, {
    maxCandidatesPerDoc: CONFLICT_MAX_CANDIDATES_PER_DOC,
  });

  const existingPairs = new Set<string>();
  const existingStmt = env.db.prepare(`
    SELECT memory_id_a, memory_id_b FROM memory_conflicts
  `);
  for (const row of existingStmt.all() as Array<{ memory_id_a: string; memory_id_b: string }>) {
    existingPairs.add(`${row.memory_id_a}:${row.memory_id_b}`);
    existingPairs.add(`${row.memory_id_b}:${row.memory_id_a}`);
  }

  const insertStmt = env.db.prepare(`
    INSERT INTO memory_conflicts (
      memory_id_a, memory_id_b, level_a, level_b,
      conflict_type, confidence, status, reason,
      suggested_resolution, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let newCount = 0;
  for (const conflict of detected) {
    const pair = `${conflict.memory_id_a}:${conflict.memory_id_b}`;
    if (!existingPairs.has(pair)) {
      insertStmt.run(
        conflict.memory_id_a,
        conflict.memory_id_b,
        conflict.level_a,
        conflict.level_b,
        conflict.conflict_type,
        conflict.confidence,
        "pending",
        conflict.reason ?? null,
        conflict.suggested_resolution ?? null,
        conflict.created_at,
      );
      newCount++;
    }
  }

  const countStmt = env.db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending
    FROM memory_conflicts
  `);
  const stats = countStmt.get() as { total: number; pending: number };

  return {
    conflicts: listConflicts(env),
    total: stats.total,
    new_conflicts: newCount,
    pending_count: stats.pending,
  };
}

/**
 * 解决冲突：keep_a / keep_b / merge / complement / ignore。
 * @returns resolution 为 merge 时返回留下的记忆 ID
 */
export function resolveMemoryConflict(
  env: WeaveEnv,
  conflictId: number,
  options: ConflictResolveOptions,
): string | undefined {
  const { resolution, merged_content, actor = "human" } = options;

  if (!["keep_a", "keep_b", "merge", "complement", "ignore"].includes(resolution)) {
    throw new Error(`unknown resolution: ${resolution}`);
  }

  const conflict = env.db.prepare("SELECT * FROM memory_conflicts WHERE id = ?").get(conflictId) as
    | MemoryConflict
    | undefined;

  if (!conflict) {
    throw new Error(`Conflict ${conflictId} not found`);
  }
  if (conflict.status !== "pending") {
    throw new Error(`Conflict ${conflictId} already ${conflict.status}`);
  }

  let mergedMemoryId: string | undefined;

  switch (resolution) {
    case "keep_a": {
      const loser = getMemory(env, conflict.memory_id_b);
      archiveMemory(env, conflict.memory_id_b, actor);
      if (loser) appendUndo(env, { actor, action: "memory.archive", target: loser.id, payload: { beforeStatus: loser.status } });
      mergedMemoryId = conflict.memory_id_a;
      break;
    }

    case "keep_b": {
      const loser = getMemory(env, conflict.memory_id_a);
      archiveMemory(env, conflict.memory_id_a, actor);
      if (loser) appendUndo(env, { actor, action: "memory.archive", target: loser.id, payload: { beforeStatus: loser.status } });
      mergedMemoryId = conflict.memory_id_b;
      break;
    }

    case "merge": {
      // 合并正文与写入/修订走同一套把关：长度、敏感词；落库走 reviseMemory（hash/FTS/向量同步）
      const content = (merged_content ?? "").trim();
      if (!content) {
        throw new Error("merged_content is required for merge resolution");
      }
      if (content.length > MAX_CONTENT) {
        throw new Error("merged_content too long (max " + MAX_CONTENT + ")");
      }
      const sensitive = scanSensitiveContent(content);
      if (sensitive) {
        throw new Error("sensitive pattern matched: " + sensitive);
      }
      const a = getMemory(env, conflict.memory_id_a);
      const b = getMemory(env, conflict.memory_id_b);
      if (!a || !b) {
        throw new Error("conflict memories not found");
      }
      const r = reviseMemory(env, a.id, { content, keywords: extractKeywords(content) }, actor);
      if (!r.ok) {
        throw new Error("merge revise failed: " + (r.code ?? "unknown"));
      }
      appendUndo(env, { actor, action: "memory.update", target: a.id, payload: { before: { content: a.content, keywords: a.keywords } } });
      archiveMemory(env, b.id, actor);
      appendUndo(env, { actor, action: "memory.archive", target: b.id, payload: { beforeStatus: b.status } });
      mergedMemoryId = a.id;
      break;
    }

    case "complement":
      break;

    case "ignore":
      break;
  }

  env.db
    .prepare(`
      UPDATE memory_conflicts
      SET status = ?, resolution = ?, resolved_at = ?, resolved_by = ?
      WHERE id = ?
    `)
    .run(
      resolution === "ignore" ? "ignored" : "resolved",
      resolution,
      Date.now(),
      actor,
      conflictId,
    );

  return mergedMemoryId;
}

/** open 冲突的 contester id 集合 —— 双方便都不注入（S2 / delta / 召回都过滤） */
export function openConflictIds(env: WeaveEnv): Set<string> {
  const out = new Set<string>();
  for (const c of listConflictRows(env, "open")) {
    for (const t of c.contenders) out.add(t.id);
  }
  return out;
}
