/**
 * render 模块 —— 从 host/service.ts 纯搬迁（行为不变）。
 * 注入装配（S1 人格 / S2 快照 / S3 delta+召回+原文旁路）
 * 会话轨迹重放、约定小节与原文索引同步。
 */
import { dirname, join } from "node:path";
import { openConflictIds } from "../govern";
import {
  renderAll,
  renderS1,
  sanitizeLine,
  type RenderInput,
} from "../../core/render";
import {
  DEFAULT_PROFILE_CONFIG,
  generateProfileInjection,
  generateUserProfile,
} from "../../profile";
import {
  promiseLine,
  surfacePromises,
} from "../../core/promise";
import { recallDetail } from "../recall";
import type {
  DeltaChange,
  Level,
  MemoryEntry,
  PersonaConfig,
  PersonaRow,
  RenderResult,
} from "../../core/types";
import type { RankedHit } from "../../core/score";
import {
  addLedger,
  bumpAccess,
  computeDelta,
  listMemory,
  recordInjectMetric,
} from "../../store/dao";
import { logRecall } from "../../store/link";
import { queryQuotes, syncSessionIndex, zstdAvailable, type QuoteHit, type QuoteSyncReport } from "../../store/quote";
import type { WeaveEnv } from "../../store/db";

export interface RenderHost {
  env: WeaveEnv;
  config: import("../service").WeaveConfig;
  warn: ((m: string) => void) | null;
  paused: boolean;
  timeZone(): string;
  persona(): PersonaRow;
  getPersonaForSession(sessionId?: string): PersonaConfig;
  listMemory(f: Parameters<typeof listMemory>[1]): MemoryEntry[];
  getMemory(id: string): MemoryEntry | null;
  recall(
    query: string,
    opts?: { limit?: number; project?: string | null; halfLife?: Record<Level, number>; rrfK?: number },
  ): RankedHit[];
  /** 语义召回入口；缺省时 renderTurnAsync 退回同步 recall */
  recallAsync?(
    query: string,
    opts?: { limit?: number; project?: string | null; halfLife?: Record<Level, number>; rrfK?: number },
  ): Promise<RankedHit[]>;
  /**
   * 注入前的条目光脱敏（S2 快照 / delta / 约定 / 重放）。
   * 缺省时原样返回，测试宿主与只读装配不必实现。
   */
  redactForInject?(entries: MemoryEntry[]): MemoryEntry[];
  /** 注入文本（画像摘要）脱敏；缺省时原样返回 */
  redactInjectText?(text: string): string;
  curateLine(sessionId: string, now?: number): string;
}

/** 会话级进程内状态：约定小节是否注入过、本会话写过的/查过的（重放） */
export class SessionRenderState {
  private promiseShown = new Map<string, string>();
  private sessionWrites = new Map<string, string[]>();
  private sessionProjects = new Map<string, string[]>();

  /**
   * 约定小节去同质：内容和本会话上次注入的一样就不再注入；
   * 首轮（含压缩重放）清空记录。
   */
  promisesFor(sessionId: string, lines: string[], first: boolean): string[] {
    if (first) this.promiseShown.delete(sessionId);
    const key = lines.join("\n");
    if (key === (this.promiseShown.get(sessionId) ?? "")) return [];
    this.promiseShown.set(sessionId, key);
    if (this.promiseShown.size > 500) {
      const firstKey = this.promiseShown.keys().next().value;
      if (firstKey !== undefined && firstKey !== sessionId) this.promiseShown.delete(firstKey);
    }
    return lines;
  }

  noteWrite(sessionId: string, id: string): void {
    const list = (this.sessionWrites.get(sessionId) ?? []).filter((x) => x !== id);
    list.push(id);
    this.sessionWrites.set(sessionId, list.slice(-20));
  }

  noteProject(sessionId: string, project: string): void {
    if (!project) return;
    const list = (this.sessionProjects.get(sessionId) ?? []).filter((x) => x !== project);
    list.push(project);
    this.sessionProjects.set(sessionId, list.slice(-8));
  }

  /** 重放附加块：受 S2 预算约束（snapshotMaxChars 的一半） */
  replayBlock(host: RenderHost, sessionId: string): string {
    const en = host.config.promptLang === "en";
    const max = Math.max(200, Math.floor((host.config.budget.snapshotMaxChars ?? 2000) / 2));
    const lines: string[] = [];
    const rawWrites = (this.sessionWrites.get(sessionId) ?? [])
      .map((id) => host.getMemory(id))
      .filter((e): e is MemoryEntry => !!e && e.status === "active");
    // 重放块同样按隐私策略脱敏（不能因为绕过 recall 就漏掉）
    const writes = host.redactForInject ? host.redactForInject(rawWrites) : rawWrites;
    if (writes.length > 0) {
      lines.push(en ? "## Memories written in this session" : "## 本会话写过的记忆");
      // 清洗记忆内容，防止注入攻击
      for (const e of writes) lines.push("- [" + e.level + "] " + sanitizeLine(e.content));
    }
    const projects = this.sessionProjects.get(sessionId) ?? [];
    if (projects.length > 0) {
      lines.push(en ? "## Projects looked up in this session" : "## 本会话查过的项目");
      for (const p of projects) {
        const n = host.listMemory({ project: p, status: "active", limit: 200 }).length;
        // 清洗项目名称
        lines.push("- " + sanitizeLine(p) + (en ? " (" + n + " entries)" : "（" + n + " 条）"));
      }
    }
    let out = lines.join("\n");
    if (out.length > max) out = out.slice(0, max - 1) + "…";
    return out;
  }
}

export function renderPersona(
  host: RenderHost,
  modelHint?: string,
): { prefix: string; thinking: string; suffix: string; blocks: string[]; warn: string[] } {
  return renderS1(host.persona().config, modelHint, host.config.budget);
}

/** 用户画像注入块：未启用或没内容时返回 undefined */
function userProfileBlock(host: RenderHost): string | undefined {
  const profileConfig = host.config.profile ?? DEFAULT_PROFILE_CONFIG;
  if (!(profileConfig.enabled && profileConfig.injectToS2)) return undefined;
  const profile = generateUserProfile(host.env, profileConfig);
  const itemCount =
    profile.preferences.length +
    profile.communicationStyle.length +
    profile.goals.length +
    profile.boundaries.length +
    profile.relationship.length;
  if (itemCount === 0) return undefined;
  const text = generateProfileInjection(profile, profileConfig);
  return host.redactInjectText ? host.redactInjectText(text) : text;
}

/** 注入前按隐私策略处理条目；宿主没实现时原样返回 */
function redactEntries(host: RenderHost, entries: MemoryEntry[]): MemoryEntry[] {
  return host.redactForInject ? host.redactForInject(entries) : entries;
}

/**
 * delta 的脱敏。
 * `redactForInject` 在 `filter` 策略下会删条目，因此按 id 回填并跳过被删项
 * 不能按下标一一对应。
 */
function redactDelta(host: RenderHost, delta: DeltaChange[]): DeltaChange[] {
  if (!host.redactForInject || delta.length === 0) return delta;
  const byId = new Map(host.redactForInject(delta.map((d) => d.entry)).map((e) => [e.id, e]));
  const out: DeltaChange[] = [];
  for (const d of delta) {
    const entry = byId.get(d.entry.id);
    if (!entry) continue;
    out.push(entry === d.entry ? d : { ...d, entry });
  }
  return out;
}

export function preview(host: RenderHost, modelHint?: string): RenderResult {
  const input: RenderInput = {
    persona: host.persona().config,
    modelHint,
    budget: host.config.budget,
    snapshotItems: snapshotItems(host),
    delta: [],
    recallHits: [],
    quotes: [],
    userProfile: userProfileBlock(host),
    promptLang: host.config.promptLang,
  };
  return renderAll(input);
}

/** 真实预览 - 模拟实际注入场景（包括 delta、召回、S3） */
export function previewWithContext(
  host: RenderHost,
  params?: { modelHint?: string; sessionId?: string; query?: string; first?: boolean },
): RenderResult {
  const { modelHint, sessionId = "preview-session", query, first = true } = params ?? {};

  const frozenIds = openConflictIds(host.env);
  const delta: DeltaChange[] = first
    ? []
    : redactDelta(host, computeDelta(host.env, sessionId, new Map()).filter((d) => !frozenIds.has(d.entry.id)));

  let hits: RankedHit[] = [];
  if (!first && query) {
    hits = host.recall(query, {
      limit: Math.min(host.config.memory.hitTopK, host.config.budget.recallMaxItems),
    });
  }

  // 模拟原文旁路（无召回时）
  const quotes = !first && hits.length === 0 && query ? quoteLookup(host, query) : [];
  const promises = host.config.promise.enabled ? promiseLines(host) : [];

  const input: RenderInput = {
    persona: host.persona().config,
    modelHint,
    budget: host.config.budget,
    snapshotItems: snapshotItems(host), // 首轮和后续都提供，renderAll 会根据是否为空处理
    delta,
    recallHits: hits,
    quotes,
    promises,
    userProfile: userProfileBlock(host),
    promptLang: host.config.promptLang,
  };

  return renderAll(input);
}

/** S2 快照取材：soul / user / rules / project 的 active 条目 + tier=core 的 fact/lesson/topic（open 冲突双方便都不注入） */
export function snapshotItems(host: RenderHost): MemoryEntry[] {
  const frozen = openConflictIds(host.env);
  const levels: Level[] = ["soul", "user", "rules", "project"];
  const out: MemoryEntry[] = [];
  for (const level of levels) {
    out.push(...host.listMemory({ level, status: "active" }).filter((e) => !frozen.has(e.id)));
  }
  // 首轮记忆可用性 - 添加 tier=core 的其他层级
  const coreOnlyLevels: Level[] = ["fact", "lesson", "topic"];
  for (const level of coreOnlyLevels) {
    const coreEntries = host.listMemory({ level, status: "active" }).filter(
      (e) => !frozen.has(e.id) && e.tier === "core",
    );
    out.push(...coreEntries);
  }
  return redactEntries(host, out);
}
/**
 * 装配一轮注入：S2 首轮 / S3 后续（delta+召回+原文旁路）。
 * 互斥暂停（paused）时只算不注入，返回空串。
 */
export function renderTurn(
  host: RenderHost,
  state: SessionRenderState,
  input: TurnInput,
): { result: RenderResult; inject: boolean; s2: string; s3: string } {
  const t0 = nowMs();
  let hits: RankedHit[] = [];
  if (!input.first && input.query) {
    hits = host.recall(input.query, {
      limit: Math.min(host.config.memory.hitTopK, host.config.budget.recallMaxItems),
    });
  }
  const recalledAt = nowMs();
  const out = finishTurn(host, state, input, hits);
  recordInject(host, input, out, recalledAt - t0, nowMs() - t0);
  return out;
}

/**
 * 异步装配一轮注入。
 * 与 `renderTurn` 唯一的区别是「召回那一步可能等一次 embedding」。
 * 宿主没实现 `recallAsync` 时行为与同步版一致。
 */
export async function renderTurnAsync(
  host: RenderHost,
  state: SessionRenderState,
  input: TurnInput,
): Promise<{ result: RenderResult; inject: boolean; s2: string; s3: string }> {
  const t0 = nowMs();
  let hits: RankedHit[] = [];
  if (!input.first && input.query) {
    const opts = { limit: Math.min(host.config.memory.hitTopK, host.config.budget.recallMaxItems) };
    if (host.recallAsync) {
      try {
        hits = await host.recallAsync(input.query, opts);
      } catch (e) {
        host.warn?.("async recall failed, falling back to sync: " + String(e));
        hits = host.recall(input.query, opts);
      }
    } else {
      hits = host.recall(input.query, opts);
    }
  }
  const recalledAt = nowMs();
  const out = finishTurn(host, state, input, hits);
  recordInject(host, input, out, recalledAt - t0, nowMs() - t0);
  return out;
}

/** 单调时钟（毫秒）；没有 performance 的旧环境退回 Date.now */
function nowMs(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}

/**
 * 记录本轮注入耗时与规模。
 * inject_ms 是整轮装配（含检索），recall_ms 是其中检索那一段；只读模式下跳过。
 */
function recordInject(
  host: RenderHost,
  input: TurnInput,
  out: { result: RenderResult; inject: boolean; s2: string; s3: string },
  recallMs: number,
  injectMs: number,
): void {
  if (host.env.readonly) return;
  try {
    let items = 0;
    for (const seg of out.result.segments) items += seg.items;
    recordInjectMetric(host.env, {
      sessionId: input.sessionId,
      at: Date.now(),
      turn: input.turn ?? 0,
      injectMs,
      recallMs,
      chars: out.s2.length + out.s3.length,
      items,
      injected: out.inject,
    });
  } catch (e) {
    host.warn?.("inject metric write failed (readonly?): " + String(e));
  }
}

interface TurnInput {
  sessionId: string;
  first: boolean;
  modelHint?: string;
  query?: string;
  baseline: Map<string, number>;
  /** 本会话第几轮（recall_log 分组用） */
  turn?: number;
  /** 压缩后重放（S2 + 本会话写过的 + 查过的项目） */
  replay?: boolean;
}

/** 拿到 hits 之后的共同装配（同步 / 异步入口共用） */
function finishTurn(
  host: RenderHost,
  state: SessionRenderState,
  input: TurnInput,
  hits: RankedHit[],
): { result: RenderResult; inject: boolean; s2: string; s3: string } {
  // 使用会话级 persona（如果有）
  const personaCfg = host.getPersonaForSession(input.sessionId);
  const frozenIds = openConflictIds(host.env);
  const delta: DeltaChange[] = input.first
    ? []
    : redactDelta(
        host,
        computeDelta(host.env, input.sessionId, input.baseline).filter((d) => !frozenIds.has(d.entry.id)),
      );
  if (!input.first && input.query) {
    // 只读模式下 bumpAccess/logRecall 失败不影响注入
    if (!host.env.readonly) {
      try {
        bumpAccess(host.env, hits.map((h) => h.id));
      } catch (e) {
        host.warn?.("bumpAccess failed (readonly?): " + String(e));
      }
      try {
        // 记命中原因（keyword/vector/link/terms 的组合），排障时不必再重跑召回
        const reasons = new Map(hits.map((h) => [h.id, h.routes.join("+")]));
        logRecall(host.env, hits.map((h) => h.id), input.sessionId, input.turn ?? 0, Date.now(), reasons);
      } catch (e) {
        host.warn?.("recall_log write failed (readonly?): " + String(e));
      }
    }
  }
  // 仅关键词与语义两路都空时才走原文旁路（语义路默认关，视为常空）
  const quotes = !input.first && hits.length === 0 ? quoteLookup(host, input.query ?? "") : [];
  // 约定小节；内容和本会话上次注入的一样就不再注入（同 delta 无变化零注入）
  const promises = host.config.promise.enabled ? state.promisesFor(input.sessionId, promiseLines(host), input.first) : [];
  const result = renderAll({
    persona: personaCfg,
    modelHint: input.modelHint,
    budget: host.config.budget,
    snapshotItems: input.first ? snapshotItems(host) : [],
    delta,
    recallHits: hits,
    quotes,
    promises,
    promptLang: host.config.promptLang,
  });
  // 只读模式下 addLedger 失败不影响注入
  if (!host.env.readonly) {
    for (const seg of result.segments) {
      try {
        addLedger(host.env, {
          sessionId: input.sessionId,
          segment: seg.name,
          chars: seg.chars,
          items: seg.items,
          trimmed: seg.trimmed,
          // 召回段逐条记命中解释（层、重要度、路由、关联类型、衰减、去同质、反刍），注入页展示
          detail:
            seg.name === "s3-recall" && hits.length > 0 && seg.items > 0
              ? recallDetail(hits.slice(0, seg.items))
              : undefined,
        });
      } catch (e) {
        host.warn?.("addLedger failed (readonly?): " + String(e));
      }
    }
  }
  const inject = !host.paused;
  let s2 = input.first ? result.s2 : "";
  // 首轮（含压缩重放）没有 S3：约定小节跟在快照后面
  const promiseText = result.segments.find((s) => s.name === "s3-promise")?.text ?? "";
  if (input.first && promiseText) s2 = s2 ? s2 + "\n\n" + promiseText : promiseText;
  if (input.first && input.replay) {
    const extra = state.replayBlock(host, input.sessionId);
    if (extra) s2 = s2 ? s2 + "\n\n" + extra : extra;
    // 只读模式下 addLedger 失败不影响注入
    if (!host.env.readonly) {
      try {
        addLedger(host.env, { sessionId: input.sessionId, segment: "s2-replay", chars: s2.length, items: 0, trimmed: 0 });
      } catch (e) {
        host.warn?.("addLedger failed (readonly?): " + String(e));
      }
    }
  }
  // S3 末尾的【待整理】一行（数量变化才出现，每会话每天最多一次）
  let s3 = input.first ? "" : result.s3;
  if (!input.first) {
    let line = "";
    try {
      line = host.curateLine(input.sessionId);
    } catch {
      line = "";
    }
    if (line) {
      s3 = s3 ? s3 + "\n\n" + line : line;
      // 只读模式下 addLedger 失败不影响注入
      if (!host.env.readonly) {
        try {
          addLedger(host.env, { sessionId: input.sessionId, segment: "s3-curate", chars: line.length, items: 1, trimmed: 0 });
        } catch (e) {
          host.warn?.("addLedger failed (readonly?): " + String(e));
        }
      }
    }
  }
  return { result, inject, s2, s3 };
}

/** S3 约定小节的行（绝对日期） */
export function promiseLines(host: RenderHost, now: number = Date.now()): string[] {
  const tz = host.timeZone();
  const frozen = openConflictIds(host.env);
  const candidates = redactEntries(
    host,
    host.listMemory({ status: "active" }).filter((e) => !frozen.has(e.id)),
  );
  const list = surfacePromises(candidates, now, tz, host.config.promise);
  return list.map((e) => promiseLine(e, now, tz, host.config.promptLang === "en" ? "en" : "zh"));
}

/** 会话原文旁路：默认关闭；FTS 索引未建时返回空 */
export function quoteLookup(host: Pick<RenderHost, "env" | "config">, query: string): QuoteHit[] {
  if (host.config.quote.enabled !== true || !query) return [];
  return queryQuotes(host.env, query, 3);
}

/** 原文旁路数据源：$DSH_HOME/sessions（config.quote.sessionsDir 可覆盖） */
export function quoteSessionsDir(host: Pick<RenderHost, "env" | "config">): string {
  if (typeof host.config.quote.sessionsDir === "string" && host.config.quote.sessionsDir.length > 0) {
    return host.config.quote.sessionsDir;
  }
  const home = process.env.DSH_HOME;
  if (typeof home === "string" && home.length > 0) return join(home, "sessions");
  return join(dirname(host.env.dataDir), "sessions");
}

/**
 * 按文件 mtime 增量同步会话原文索引。
 * zstd 不可用时强制 quote.enabled=false（降级分支），返回 available:false。
 */
export async function refreshQuoteIndex(
  host: Pick<RenderHost, "env" | "config">,
  opts?: { now?: number },
): Promise<QuoteSyncReport> {
  if (!zstdAvailable()) {
    host.config.quote.enabled = false;
    return { available: false, files: 0, indexed: 0, skipped: 0, pruned: 0, rows: 0 };
  }
  if (host.config.quote.enabled !== true) {
    return { available: true, files: 0, indexed: 0, skipped: 0, pruned: 0, rows: 0 };
  }
  return syncSessionIndex(host.env, {
    sessionsDir: quoteSessionsDir(host),
    indexDays: host.config.quote.indexDays,
    now: opts?.now,
  });
}
