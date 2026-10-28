/**
 * 忆织 MemWeave —— 库结构（规划文档 §5）
 * 全部 IF NOT EXISTS；层表列统一；索引见 §5.5。
 */

import type { Level } from "../core/types";

export const SCHEMA_VERSION = 7;

/** 七层表名即层名 */
export const LAYER_TABLES: Record<Level, string> = {
  soul: "soul",
  user: "user",
  project: "project",
  fact: "fact",
  lesson: "lesson",
  topic: "topic",
  rules: "rules",
};

/** 七层表统一列定义（name -> DDL 片段），用于建表与「只加列」迁移 */
export const LAYER_COLUMNS: Array<[string, string]> = [
  ["id", "id TEXT PRIMARY KEY"],
  ["project", "project TEXT"],
  ["section", "section TEXT"],
  ["content", "content TEXT NOT NULL"],
  ["keywords", "keywords TEXT"],
  ["importance", "importance INTEGER DEFAULT 3"],
  ["status", "status TEXT DEFAULT 'active'"],
  ["semantic_key", "semantic_key TEXT"],
  ["confidence", "confidence REAL"],
  ["valid_from", "valid_from INTEGER"],
  ["valid_to", "valid_to INTEGER"],
  ["evidence", "evidence TEXT"],
  ["hash", "hash TEXT"],
  ["source", "source TEXT"],
  ["access_count", "access_count INTEGER DEFAULT 0"],
  ["tier", "tier TEXT DEFAULT 'hot'"],
  ["created_at", "created_at INTEGER"],
  ["updated_at", "updated_at INTEGER"],
  // v4（roadmap R1）：写入会话，co-session 边判据；不进 ENTRY_COLS，由 dao 单独读写
  ["session_id", "session_id TEXT"],
  // v5（roadmap R6）：常被想起的等级 0–3
  ["boost", "boost INTEGER DEFAULT 0"],
  // v5（roadmap R10）：情绪价 −1..1、唤醒度 0..1、闪光灯
  ["valence", "valence REAL"],
  ["arousal", "arousal REAL"],
  ["flash", "flash INTEGER DEFAULT 0"],
  // v6（roadmap v0.6 M1）：约定到期时间 / 状态 / 标签
  ["due_at", "due_at INTEGER"],
  ["promise_state", "promise_state TEXT DEFAULT 'none'"],
  ["promise_label", "promise_label TEXT"],
  // v6（roadmap v0.6 M2）：日历锚点 JSON
  ["calendar_anchor", "calendar_anchor TEXT"],
  // v7（roadmap v0.7 S1）：AI 补的检索词 JSON 数组；只用于找条目，不进注入、不参与把关
  ["search_terms", "search_terms TEXT"],
];

const LAYER_DDL = (table: string): string =>
  "CREATE TABLE IF NOT EXISTS " + table + " (\n" +
  LAYER_COLUMNS.map(([, ddl]) => "  " + ddl).join(",\n") +
  "\n)";

const LAYER_INDEXES = (table: string): string[] => [
  "CREATE INDEX IF NOT EXISTS ix_" + table + "_status_level ON " + table + "(status, importance DESC)",
  "CREATE INDEX IF NOT EXISTS ix_" + table + "_project ON " + table + "(project, status)",
  "CREATE INDEX IF NOT EXISTS ix_" + table + "_updated ON " + table + "(updated_at DESC)",
  "CREATE UNIQUE INDEX IF NOT EXISTS ux_" + table + "_hash ON " + table + "(hash) WHERE hash IS NOT NULL",
  "CREATE INDEX IF NOT EXISTS ix_" + table + "_semkey ON " + table + "(semantic_key) WHERE semantic_key IS NOT NULL",
  // v6（M1 / M2）
  "CREATE INDEX IF NOT EXISTS ix_" + table + "_promise ON " + table + "(promise_state, due_at)",
  "CREATE INDEX IF NOT EXISTS ix_" + table + "_anchor ON " + table + "(status) WHERE calendar_anchor IS NOT NULL",
];

const LAYER_NAMES: Level[] = ["soul", "user", "project", "fact", "lesson", "topic", "rules"];

export const SCHEMA_SQL: string[] = [
  // ---------- 人格（单行） ----------
  "CREATE TABLE IF NOT EXISTS persona (" +
    "id INTEGER PRIMARY KEY CHECK (id = 1)," +
    "enabled INTEGER NOT NULL DEFAULT 1," +
    "version INTEGER NOT NULL DEFAULT 0," +
    "spec TEXT NOT NULL DEFAULT 'memweave-persona/1'," +
    "self_name TEXT," +
    "user_name TEXT," +
    "stance TEXT," +
    "character TEXT," +
    "suffix TEXT," +
    "thinking_language TEXT," +
    "config TEXT NOT NULL," +
    "updated_at INTEGER NOT NULL," +
    "updated_by TEXT NOT NULL" +
    ")",

  "CREATE TABLE IF NOT EXISTS persona_history (" +
    "version INTEGER PRIMARY KEY," +
    "config TEXT NOT NULL," +
    "note TEXT," +
    "created_at INTEGER NOT NULL," +
    "created_by TEXT NOT NULL" +
    ")",

  "CREATE TABLE IF NOT EXISTS persona_presets (" +
    "id TEXT PRIMARY KEY," +
    "spec TEXT NOT NULL," +
    "label TEXT," +
    "description TEXT," +
    "author TEXT," +
    "tags TEXT," +
    "payload TEXT NOT NULL," +
    "source TEXT," +
    "imported_at INTEGER NOT NULL" +
    ")",

  "CREATE TABLE IF NOT EXISTS persona_cards (" +
    "id TEXT PRIMARY KEY," +
    "who TEXT NOT NULL," +
    "title TEXT," +
    "brief TEXT," +
    "detail TEXT," +
    "media TEXT," +
    "auto INTEGER DEFAULT 1," +
    "expand TEXT DEFAULT 'brief'," +
    "on_ INTEGER DEFAULT 1" +
    ")",

  // ---------- 七层记忆表 ----------
  ...LAYER_NAMES.map(LAYER_DDL),
  ...LAYER_NAMES.flatMap(LAYER_INDEXES),

  // ---------- 治理与账本 ----------
  "CREATE TABLE IF NOT EXISTS candidates (" +
    "id TEXT PRIMARY KEY," +
    "level TEXT," +
    "project TEXT," +
    "content TEXT," +
    "keywords TEXT," +
    "importance INTEGER," +
    "semantic_key TEXT," +
    "evidence TEXT," +
    "tier TEXT," +
    "verdict TEXT DEFAULT 'pending'," +
    "risk TEXT," +
    "reason TEXT," +
    "merged_into TEXT," +
    "created_at INTEGER," +
    "decided_at INTEGER," +
    "decided_by TEXT," +
    "patch TEXT" +
    ")",

  "CREATE TABLE IF NOT EXISTS conflicts (" +
    "id TEXT PRIMARY KEY," +
    "semantic_key TEXT NOT NULL," +
    "contenders TEXT NOT NULL," +
    "winner_id TEXT," +
    "status TEXT DEFAULT 'open'," +
    "note TEXT," +
    "created_at INTEGER," +
    "resolved_at INTEGER" +
    ")",

  "CREATE TABLE IF NOT EXISTS links (" +
    "src TEXT," +
    "dst TEXT," +
    "kind TEXT," +
    "weight REAL DEFAULT 1.0," +
    "created_at INTEGER," +
    "PRIMARY KEY (src, dst, kind)" +
    ")",

  "CREATE TABLE IF NOT EXISTS audit_log (" +
    "id INTEGER PRIMARY KEY AUTOINCREMENT," +
    "ts INTEGER NOT NULL," +
    "actor TEXT," +
    "action TEXT," +
    "target TEXT," +
    "before TEXT," +
    "after TEXT," +
    "reason TEXT," +
    "session_id TEXT" +
    ")",

  "CREATE TABLE IF NOT EXISTS inject_state (" +
    "session_id TEXT PRIMARY KEY," +
    "snapshot_at INTEGER," +
    "snapshot_hash TEXT," +
    "pushed TEXT," +
    "frozen INTEGER DEFAULT 1," +
    "chars_used INTEGER DEFAULT 0" +
    ")",

  "CREATE TABLE IF NOT EXISTS budget_ledger (" +
    "id INTEGER PRIMARY KEY AUTOINCREMENT," +
    "ts INTEGER," +
    "session_id TEXT," +
    "segment TEXT," +
    "chars INTEGER," +
    "items INTEGER," +
    "trimmed INTEGER," +
    "detail TEXT" +
    ")",

  "CREATE VIRTUAL TABLE IF NOT EXISTS session_fts USING fts5(" +
    "workspace, session_id, seq, role, text, tokenize='unicode61'" +
    ")",

  // 原文旁路增量索引台账（按文件 mtime 去重，§8.5）
  "CREATE TABLE IF NOT EXISTS session_files (" +
    "path TEXT PRIMARY KEY," +
    "workspace TEXT," +
    "session_id TEXT," +
    "mtime INTEGER," +
    "size INTEGER," +
    "rows INTEGER," +
    "indexed_at INTEGER" +
    ")",

  // dream 收梭：租约 / 心跳 / 失败计数（§8.7、§16）
  "CREATE TABLE IF NOT EXISTS dream_state (" +
    "id INTEGER PRIMARY KEY CHECK (id = 1)," +
    "lease_owner TEXT," +
    "lease_until INTEGER," +
    "last_run INTEGER," +
    "last_heartbeat INTEGER," +
    "failures INTEGER DEFAULT 0," +
    "state TEXT DEFAULT 'idle'" +
    ")",

  // 撤销台账（§13.2.6 / 附录 A governance.undoWindowHours）：自动动作留逆操作，
  // 窗口内人可一键回滚（M4 验收：自动动作 100% 可撤销）
  "CREATE TABLE IF NOT EXISTS undo_log (" +
    "id TEXT PRIMARY KEY," +
    "ts INTEGER NOT NULL," +
    "actor TEXT NOT NULL," +
    "action TEXT NOT NULL," +
    "target TEXT NOT NULL," +
    "payload TEXT NOT NULL," +
    "undone INTEGER NOT NULL DEFAULT 0," +
    "undone_ts INTEGER" +
    ")",

  "CREATE TABLE IF NOT EXISTS import_undo (" +
    "id TEXT PRIMARY KEY," +
    "created_at INTEGER NOT NULL," +
    "actor TEXT NOT NULL," +
    "payload TEXT NOT NULL," +
    "rolled_back_at INTEGER" +
    ")",

  // v4（roadmap R5/R6/R8）：召回注入记录，保留 90 天
  "CREATE TABLE IF NOT EXISTS recall_log (" +
    "ts INTEGER NOT NULL," +
    "memory_id TEXT NOT NULL," +
    "session_id TEXT," +
    "turn INTEGER" +
    ")",

  // v7（roadmap v0.7 S2）：待归纳组。status: open / done / skipped / expired
  "CREATE TABLE IF NOT EXISTS distill_queue (" +
    "id TEXT PRIMARY KEY," +
    "member_ids TEXT NOT NULL," +
    "reason TEXT," +
    "created_at INTEGER NOT NULL," +
    "status TEXT NOT NULL DEFAULT 'open'" +
    ")",

  "CREATE TABLE IF NOT EXISTS schema_version (" +
    "id INTEGER PRIMARY KEY CHECK (id = 1)," +
    "version INTEGER NOT NULL," +
    "applied_at INTEGER NOT NULL" +
    ")",

  // ---------- 治理与审计索引（§5.5） ----------
  "CREATE INDEX IF NOT EXISTS ix_cand_verdict ON candidates(verdict, created_at DESC)",
  "CREATE INDEX IF NOT EXISTS ix_conf_status ON conflicts(status, created_at DESC)",
  "CREATE INDEX IF NOT EXISTS ix_link_src ON links(src, kind)",
  "CREATE INDEX IF NOT EXISTS ix_link_dst ON links(dst, kind)",
  "CREATE INDEX IF NOT EXISTS ix_audit_ts ON audit_log(ts DESC)",
  "CREATE INDEX IF NOT EXISTS ix_audit_action ON audit_log(action, ts DESC)",
  "CREATE INDEX IF NOT EXISTS ix_ledger_sess ON budget_ledger(session_id, ts DESC)",
  "CREATE INDEX IF NOT EXISTS ix_undo_ts ON undo_log(ts DESC)",
  "CREATE INDEX IF NOT EXISTS ix_undo_action ON undo_log(action, ts DESC)",
  "CREATE INDEX IF NOT EXISTS ix_link_kind ON links(kind, created_at)",
  "CREATE INDEX IF NOT EXISTS ix_recall_mem ON recall_log(memory_id, ts)",
  "CREATE INDEX IF NOT EXISTS ix_recall_turn ON recall_log(session_id, turn)",
  "CREATE INDEX IF NOT EXISTS ix_distill_status ON distill_queue(status, created_at)",
];
