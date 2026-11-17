/**
 * 记忆全文检索（FTS5）
 * 索引里存的是**分词后**的文本（空格连接），不是原文。
 * 原因：FTS5 默认 unicode61 把一整段中文当成一个词，原文索引下 MATCH "路由" 命中不了
 * 「路由器管理地址」；而内核 BM25 用的是二元组分词。两边口径对齐后
 * FTS 才能真正当召回的前置候选过滤器（并且是关键词路的超集）。
 */

import type { Level, MemoryEntry } from "../core/types";
import type { WeaveEnv } from "./db";
import { LEVEL_ORDER } from "../core/types";
import { DEFAULT_ALIAS_GROUPS, mergeAliasGroups, tokenize } from "../core/tokenize";
import { LAYER_TABLES } from "./schema";

const LEVELS = LEVEL_ORDER;
const tableOf = (level: Level): string => LAYER_TABLES[level];

/** 索引文本：分词后空格连接；查询侧用同一函数，保证两侧词表一致 */
export function ftsText(text: string | null | undefined): string {
  if (!text) return "";
  return tokenize(text).join(" ");
}

/**
 * 构造 MATCH 表达式 —— 查询分词后逐个加引号（避免 `-` 被当成 NOT 操作符），OR 连接。
 * 同义词组展开是为了「候选必须是超集」：内核 BM25 在**归一化后**的 token 上比较
 * 例如查询「用户」会被归一成「主人」，正文写「主人」的条目也能命中。索引里存的是原文分词
 * 所以这里把查询 token 所在同义组的所有成员一并 OR 进去，才不会漏掉这类条目。
 */
export function buildMemoryFtsMatch(query: string, expand?: string[][]): string | null {
  const base = tokenize(query);
  if (base.length === 0) return null;
  const groups = mergeAliasGroups(DEFAULT_ALIAS_GROUPS, expand);
  const tokens = new Set(base);
  for (const g of groups) {
    const groupTokens = g.flatMap((w) => tokenize(w));
    if (groupTokens.length === 0) continue;
    if (!groupTokens.some((t) => tokens.has(t))) continue;
    for (const t of groupTokens) tokens.add(t);
  }
  return [...tokens].map((t) => '"' + t.replace(/"/g, '""') + '"').join(" OR ");
}

/** 同步单条记忆到 FTS */
export function syncMemoryToFTS(env: WeaveEnv, entry: MemoryEntry): void {
  try {
    // 先删除旧的
    env.db.prepare("DELETE FROM memory_fts WHERE id = ?").run(entry.id);

    // 插入新的（只索引 active 状态）
    if (entry.status === "active") {
      const keywords = Array.isArray(entry.keywords) ? entry.keywords.join(" ") : "";
      const terms = Array.isArray(entry.searchTerms) ? entry.searchTerms.join(" ") : "";
      env.db
        .prepare("INSERT INTO memory_fts(id, level, content, keywords, terms, project) VALUES (?, ?, ?, ?, ?, ?)")
        .run(entry.id, entry.level, ftsText(entry.content), ftsText(keywords), ftsText(terms), entry.project ?? "");
    }
  } catch (e) {
    // FTS 失败不阻塞写入
  }
}

/** 从 FTS 删除记忆 */
export function deleteMemoryFromFTS(env: WeaveEnv, id: string): void {
  try {
    env.db.prepare("DELETE FROM memory_fts WHERE id = ?").run(id);
  } catch (e) {
    // 同上
  }
}

/** 批量重建 FTS 索引 */
export function rebuildMemoryFTS(env: WeaveEnv): number {
  try {
    // 清空 FTS
    env.db.exec("DELETE FROM memory_fts");

    let count = 0;
    // 遍历所有层，只索引 active 的记忆
    for (const level of LEVELS) {
      const table = tableOf(level);
      const rows = env.db
        .prepare("SELECT id, project, content, keywords, search_terms FROM " + table + " WHERE status = 'active'")
        .all() as Array<{
        id: string;
        project: string | null;
        content: string;
        keywords: string | null;
        search_terms: string | null;
      }>;

      const insert = env.db.prepare(
        "INSERT INTO memory_fts(id, level, content, keywords, terms, project) VALUES (?, ?, ?, ?, ?, ?)",
      );

      for (const row of rows) {
        try {
          insert.run(
            row.id,
            level,
            ftsText(row.content),
            ftsText(jarrText(row.keywords)),
            ftsText(jarrText(row.search_terms)),
            row.project ?? "",
          );
          count++;
        } catch {
          // 单条失败不影响整体
        }
      }
    }

    // 优化 FTS 索引
    env.db.exec("INSERT INTO memory_fts(memory_fts) VALUES('optimize')");

    return count;
  } catch (e) {
    return 0;
  }
}

function jarrText(raw: string | null): string {
  if (!raw) return "";
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x) => typeof x === "string").join(" ") : "";
  } catch {
    return "";
  }
}

/** 召回前置候选（只取 id，按 FTS rank 排序） */
export function searchMemoryIds(
  env: WeaveEnv,
  query: string,
  opts: {
    level?: Level;
    limit?: number;
    /** 附录 A recall.synonymsFile / 身份词表等附加同义组，用于查询展开 */
    expand?: string[][];
  } = {},
): string[] {
  try {
    const expr = buildMemoryFtsMatch(query, opts.expand);
    if (!expr) return [];
    const where: string[] = ["memory_fts MATCH ?"];
    const params: any[] = [expr];
    if (opts.level) {
      where.push("level = ?");
      params.push(opts.level);
    }
    const limit = Math.max(1, opts.limit ?? 200);
    params.push(limit);
    const rows = env.db
      .prepare("SELECT id FROM memory_fts WHERE " + where.join(" AND ") + " ORDER BY rank LIMIT ?")
      .all(...params) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  } catch (e) {
    // FTS 查询失败返回空（降级）；调用方会回退全量扫描
    return [];
  }
}

/** 全文搜索记忆（返回 id 和相关度分数） */
export function searchMemoryFTS(
  env: WeaveEnv,
  query: string,
  opts: {
    level?: Level;
    project?: string;
    limit?: number;
  } = {},
): Array<{ id: string; rank: number }> {
  try {
    const expr = buildMemoryFtsMatch(query);
    if (!expr) return [];
    const where: string[] = ["memory_fts MATCH ?"];
    const params: any[] = [expr];

    if (opts.level) {
      where.push("level = ?");
      params.push(opts.level);
    }
    if (opts.project !== undefined) {
      where.push("(project = ? OR project = '')");
      params.push(opts.project);
    }

    const limit = opts.limit ?? 100;
    params.push(limit);

    const sql =
      "SELECT id, rank FROM memory_fts " +
      "WHERE " + where.join(" AND ") +
      " ORDER BY rank " +
      "LIMIT ?";

    const rows = env.db.prepare(sql).all(...params) as Array<{ id: string; rank: number }>;
    return rows;
  } catch (e) {
    // FTS 查询失败返回空（降级）
    return [];
  }
}

/** FTS 统计信息 */
export function getFTSStats(env: WeaveEnv): { indexed: number; totalActive: number } {
  try {
    const indexed = (env.db.prepare("SELECT COUNT(*) as c FROM memory_fts").get() as { c: number }).c;

    let totalActive = 0;
    for (const level of LEVELS) {
      const table = tableOf(level);
      const row = env.db.prepare("SELECT COUNT(*) as c FROM " + table + " WHERE status = 'active'").get() as { c: number };
      totalActive += row.c;
    }

    return { indexed, totalActive };
  } catch {
    return { indexed: 0, totalActive: 0 };
  }
}
