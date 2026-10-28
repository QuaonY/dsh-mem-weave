/**
 * 忆织 MemWeave —— RPC 描述符与方法面（规划文档 §13.4）
 * 手写 descriptor + codec（{parse}），零依赖（§6.6）；RBAC 在 host 侧（§13.0）。
 */

import type { PersonaConfig } from "../core/types";
import { renderHash } from "../core/hash";
import { sanitizeIntentRules } from "../core/intent";
import { sanitizeCustomPatterns, sanitizeDisabledBuiltins } from "../core/sensitive";
import { defaultConfig, type WeaveService } from "./service";
import { pickDirectory } from "./pick-dir";

export interface RpcParamSpec {
  type: string;
  properties?: Record<string, unknown>;
  required?: string[];
  [k: string]: unknown;
}

export interface RpcCodec {
  parse(value: unknown): unknown;
}

export interface RpcDescriptor {
  id: string;
  service: string;
  namespace: string;
  method: string;
  invocation: { kind: "direct" };
  parameters: RpcParamSpec;
  result: RpcParamSpec;
  codec: RpcCodec;
}

export type RpcHandler = (
  service: WeaveService,
  args: Record<string, unknown>,
  actor: string,
) => unknown | Promise<unknown>;

export interface RpcMethod {
  ns: string;
  method: string;
  humanOnly: boolean;
  parameters: RpcParamSpec;
  handler: RpcHandler;
}

export interface RbacError {
  ok: false;
  status: 403;
  code: "E_PERM";
  message: string;
}

/** RBAC：人格写 / 裁决 / 重置 / 备份 / 导入 / 设置写 只接受 actor=human */
export function guardHuman(actor: string): true | RbacError {
  if (actor === "human") return true;
  return {
    ok: false,
    status: 403,
    code: "E_PERM",
    message: "actor=human required (got " + actor + ")",
  };
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function mergeSettings(current: unknown, patch: unknown): unknown {
  const base = obj(current);
  const next = obj(patch);
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(next)) {
    const oldValue = base[key];
    const isRecord = (v: unknown): v is Record<string, unknown> =>
      v !== null && typeof v === "object" && !Array.isArray(v);
    merged[key] = isRecord(oldValue) && isRecord(value) ? mergeSettings(oldValue, value) : value;
  }
  return merged;
}

/**
 * roadmap §9：新增数值键过 settings/update 时夹到安全范围；布尔键强制成布尔。
 * 只改 patch 里出现的键，不补默认值。
 */
export function clampRoadmapSettings(patch: Record<string, unknown>): void {
  const clampAt = (o: unknown, key: string, lo: number, hi: number, int = true): void => {
    if (!o || typeof o !== "object" || Array.isArray(o)) return;
    const rec = o as Record<string, unknown>;
    if (!(key in rec)) return;
    let n = Number(rec[key]);
    if (!Number.isFinite(n)) {
      delete rec[key];
      return;
    }
    n = Math.min(hi, Math.max(lo, n));
    rec[key] = int ? Math.round(n) : n;
  };
  const boolAt = (o: unknown, key: string): void => {
    if (o && typeof o === "object" && !Array.isArray(o) && key in (o as Record<string, unknown>)) {
      (o as Record<string, unknown>)[key] = (o as Record<string, unknown>)[key] === true;
    }
  };
  const sub = (o: unknown, key: string): unknown => (o && typeof o === "object" ? (o as Record<string, unknown>)[key] : undefined);
  const recall = patch.recall;
  clampAt(recall, "logKeepDays", 7, 3650);
  boolAt(sub(recall, "diversity"), "enabled");
  clampAt(sub(recall, "diversity"), "threshold", 0.1, 1, false);
  boolAt(sub(recall, "rumination"), "enabled");
  clampAt(sub(recall, "rumination"), "windowHours", 1, 24 * 30);
  clampAt(sub(recall, "rumination"), "freeHits", 0, 100);
  clampAt(sub(recall, "rumination"), "factor", 0.1, 1, false);
  clampAt(sub(recall, "rumination"), "floor", 0.1, 1, false);
  const auto = sub(patch.links, "autoLink");
  boolAt(auto, "enabled");
  clampAt(auto, "maxPerWrite", 0, 32);
  clampAt(auto, "topicJaccard", 0.05, 1, false);
  clampAt(auto, "timeWindowMin", 0, 24 * 60);
  for (const k of ["surprise", "sourceWeight", "containment"]) boolAt(sub(patch.write, k), "enabled");
  clampAt(sub(patch.write, "containment"), "jaccard", 0.1, 1, false);
  clampAt(sub(patch.write, "containment"), "containment", 0.1, 1, false);
  boolAt(patch.reflect, "enabled");
  clampAt(patch.reflect, "afterToolSteps", 2, 100);
  boolAt(patch.replay, "enabled");
  clampAt(patch.log, "maxFileMb", 1, 100);
  clampAt(patch.log, "keepDays", 1, 365);
  // 会读写本地文件的路径项只能在配置文件里改：界面 / 远程调用不能把日志、镜像写到任意目录，也不能让插件去读任意文件
  const dropKey = (o: unknown, key: string): void => {
    if (o && typeof o === "object" && !Array.isArray(o)) delete (o as Record<string, unknown>)[key];
  };
  dropKey(patch.log, "dir");
  dropKey(patch.mirror, "dir");
  dropKey(patch.quote, "sessionsDir");
  dropKey(recall, "synonymsFile");
  // roadmap 阶段 D
  const intent = sub(recall, "intent");
  boolAt(intent, "enabled");
  clampAt(intent, "factor", 1, 3, false);
  if (intent && typeof intent === "object" && "rules" in (intent as Record<string, unknown>)) {
    const rules = sanitizeIntentRules((intent as Record<string, unknown>).rules);
    if (rules) (intent as Record<string, unknown>).rules = rules;
    else delete (intent as Record<string, unknown>).rules;
  }
  boolAt(patch.emotion, "enabled");
  clampAt(patch.emotion, "flashArousal", 0.1, 1, false);
  clampAt(patch.emotion, "dailyFlashCap", 0, 100);
  clampAt(patch.emotion, "factor", 1, 3, false);
  // roadmap v0.6.1 M4
  const res = (patch.emotion as Record<string, unknown> | undefined)?.residue;
  boolAt(res, "enabled");
  clampAt(res, "floor", 0, 1, false);
  clampAt(res, "minValence", 0, 1, false);
  // roadmap v0.6 M1 / M2
  const pr = patch.promise;
  for (const k of ["enabled", "affectRelation"]) boolAt(pr, k);
  clampAt(pr, "horizonDays", 1, 400);
  clampAt(pr, "clarityFloor", 0, 1, false);
  clampAt(pr, "clarityCurve", 0.1, 5, false);
  clampAt(pr, "boost", 0, 3, false);
  clampAt(pr, "surfaceLookaheadDays", 0, 60);
  clampAt(pr, "graceDays", 0, 60);
  clampAt(pr, "maxHorizonDays", 1, 3650);
  clampAt(pr, "maxSurface", 0, 20);
  // roadmap v0.7 S1 / S2 / §8
  const st = patch.searchTerms;
  boolAt(st, "enabled");
  clampAt(st, "maxTerms", 1, 16);
  clampAt(st, "maxTermChars", 2, 32);
  clampAt(st, "routeWeight", 0, 2, false);
  clampAt(st, "routeTop", 1, 20);
  clampAt(st, "backfillPerDream", 0, 100);
  const ds = (patch as Record<string, unknown>).distill;
  boolAt(ds, "enabled");
  clampAt(ds, "groupMin", 2, 8);
  clampAt(ds, "groupMax", 3, 12);
  clampAt(ds, "coldDays", 1, 3650);
  clampAt(ds, "jaccard", 0, 1, false);
  clampAt(ds, "perDream", 0, 10);
  clampAt(ds, "maxOpen", 0, 50);
  clampAt(ds, "expireDays", 1, 365);
  clampAt(ds, "maxChars", 50, 1000);
  clampAt(ds, "coverage", 0, 1, false);
  const cu = (patch as Record<string, unknown>).curate;
  for (const k of ["enabled", "autoProcess", "promptOncePerDay"]) boolAt(cu, k);
  const cal = patch.calendar;
  boolAt(cal, "enabled");
  clampAt(cal, "lookaheadDays", 0, 30);
  clampAt(cal, "factor", 0, 3, false);
  if (cal && typeof cal === "object" && "timeZone" in (cal as Record<string, unknown>)) {
    const rec = cal as Record<string, unknown>;
    const z = typeof rec.timeZone === "string" ? rec.timeZone.trim() : "";
    let valid = z === "";
    if (!valid) {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: z });
        valid = true;
      } catch {
        valid = false;
      }
    }
    if (valid) rec.timeZone = z;
    else delete rec.timeZone;
  }
  // roadmap 阶段 C
  const co = sub(patch.links, "coRecall");
  boolAt(co, "enabled");
  clampAt(co, "step", 0.01, 1, false);
  clampAt(co, "cap", 0.5, 10, false);
  clampAt(co, "decayDays", 7, 3650);
  clampAt(co, "decayFactor", 0.1, 1, false);
  const life = patch.lifecycle;
  const boost = sub(life, "boost");
  boolAt(boost, "enabled");
  clampAt(boost, "minHits", 1, 100);
  clampAt(boost, "minSessions", 1, 100);
  clampAt(boost, "decayDays", 7, 3650);
  clampAt(life, "staleAskDays", 0, 365);
  const distill = sub(life, "distill");
  boolAt(distill, "enabled");
  clampAt(distill, "topicsPerProject", 2, 100);
  clampAt(distill, "crossProjects", 2, 20);
  clampAt(life, "maxCandidatesPerDream", 0, 50);
  if ("legacyAccessBonus" in obj(recall)) delete (recall as Record<string, unknown>).legacyAccessBonus; // 仅等价测试用
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

const mask = (text: string): string => text.replace(/\d{8,}/g, (m) => m.slice(0, 2) + "**" + m.slice(-2));

export interface SelfcheckItem {
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * §13.2.6 一致性自检（治理页按钮）：三段装配同源、写权断言、导出往返、库完整性。
 * 全程只读不改库（写权探针走 humanOnly 拒绝路径，无副作用）。
 */
async function selfcheck(s: WeaveService): Promise<{ ok: boolean; checks: SelfcheckItem[] }> {
  const checks: SelfcheckItem[] = [];

  // ① 三段装配同源（U4）：hash 与三段文本的 renderHash 一致
  const p = s.preview();
  const derived = renderHash([p.s1.prefix, p.s1.thinking, p.s1.suffix, p.s2, p.s3]);
  checks.push({ name: "segments", ok: derived === p.hash, detail: "hash=" + p.hash.slice(0, 8) });

  // ② 写权断言：actor=agent 走 RPC 必须 E_PERM（与工具路径同一 guardHuman）
  const probe = (await invokeRpc(s, "memweave.persona/update", { patch: {} }, "agent")) as { code?: string };
  checks.push({
    name: "write-guard",
    ok: probe != null && probe.code === "E_PERM",
    detail: "persona/update(agent) → " + String(probe?.code ?? "accepted"),
  });

  // ③ 导出往返：导出 JSON 可序列化解析且条目计数一致
  try {
    const payload = s.exportAll();
    const parsed = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
    const n1 = ((payload.memories as unknown[]) ?? []).length + ((payload.presets as unknown[]) ?? []).length;
    const n2 = ((parsed.memories as unknown[]) ?? []).length + ((parsed.presets as unknown[]) ?? []).length;
    checks.push({
      name: "export-roundtrip",
      ok: parsed.spec === "memweave-export/1" && n1 === n2,
      detail: n1 + " items",
    });
  } catch (e) {
    checks.push({ name: "export-roundtrip", ok: false, detail: String(e) });
  }

  // ⑤ 记忆工具是否进了模型的工具列表（没注册 = AI 永远写不了记忆）
  const ts = s.toolStatus;
  checks.push({
    name: "tools",
    ok: ts.registered.length > 0 && ts.failed.length === 0,
    detail: ts.registered.length > 0
      ? "已注册 " + ts.registered.length + " 个" + (ts.failed.length > 0 ? "，失败 " + ts.failed.join(", ") + "：" + ts.lastError : "")
      : ts.lastError || "未注册（宿主没有提供 tools 服务）",
  });

  // ④ 库完整性（SQLite 自检）
  try {
    const r = s.env.db.prepare("PRAGMA integrity_check").get() as { integrity_check?: string } | undefined;
    const v = String(r?.integrity_check ?? "?");
    checks.push({ name: "db", ok: v === "ok", detail: v });
  } catch (e) {
    checks.push({ name: "db", ok: false, detail: String(e) });
  }

  return { ok: checks.every((c) => c.ok), checks };
}

export const RPC_METHODS: RpcMethod[] = [
  {
    ns: "status",
    method: "get",
    humanOnly: false,
    parameters: { type: "object", properties: {} },
    handler: (s) => s.status(),
  },
  {
    ns: "status",
    method: "selfcheck",
    humanOnly: false,
    parameters: { type: "object", properties: {} },
    handler: (s) => selfcheck(s),
  },
  {
    ns: "exclusion",
    method: "check",
    humanOnly: false,
    parameters: { type: "object", properties: {} },
    handler: (s) => ({ paused: s.paused, reason: s.pauseReason }),
  },
  {
    ns: "persona",
    method: "get",
    humanOnly: false,
    parameters: { type: "object", properties: {} },
    handler: (s) => s.persona(),
  },
  {
    ns: "persona",
    method: "history",
    humanOnly: false,
    parameters: { type: "object", properties: { limit: { type: "number" } } },
    handler: (s, a) => ({
      ok: true,
      versions: s.personaHistory(typeof a.limit === "number" ? a.limit : undefined),
    }),
  },
  {
    ns: "persona",
    method: "preview",
    humanOnly: false,
    parameters: { type: "object", properties: { modelHint: { type: "string" } } },
    handler: (s, a) => s.preview(str(a.modelHint) || undefined),
  },
  {
    ns: "persona",
    method: "update",
    humanOnly: true,
    parameters: {
      type: "object",
      properties: { patch: { type: "object" }, expectedVersion: { type: "number" } },
      required: ["patch"],
    },
    handler: (s, a, actor) => {
      const patch = obj(a.patch) as Partial<PersonaConfig>;
      const expected = typeof a.expectedVersion === "number" ? a.expectedVersion : undefined;
      return s.updatePersona(patch, actor, expected);
    },
  },
  {
    ns: "persona",
    method: "history.restore",
    humanOnly: true,
    parameters: {
      type: "object",
      properties: { version: { type: "number" }, expectedVersion: { type: "number" } },
      required: ["version"],
    },
    handler: (s, a, actor) => {
      const version = Number(a.version);
      const row = s.env.db
        .prepare("SELECT config FROM persona_history WHERE version = ?")
        .get(version) as Record<string, unknown> | undefined;
      if (!row) return { ok: false, code: "E_VALID", message: "version not found" };
      const config = JSON.parse(String(row.config)) as PersonaConfig;
      const expected = typeof a.expectedVersion === "number" ? a.expectedVersion : undefined;
      const updated = s.updatePersona(config, actor, expected);
      if (!updated.ok) return updated;
      const reload = s.reload();
      return { ...updated, reloadOk: reload.ok, reloadMessage: reload.message };
    },
  },
  {
    ns: "persona",
    method: "reload",
    humanOnly: true,
    parameters: { type: "object", properties: {} },
    handler: (s) => s.reload(),
  },
  {
    ns: "preset",
    method: "list",
    humanOnly: false,
    parameters: { type: "object", properties: {} },
    handler: (s) => ({ presets: s.listPresets() }),
  },
  {
    ns: "preset",
    method: "export",
    humanOnly: false,
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    handler: (s, a) => {
      const preset = s.getPreset(str(a.id));
      return preset ? { ok: true, preset } : { ok: false, code: "E_VALID", message: "preset not found" };
    },
  },
  {
    ns: "preset",
    method: "apply",
    humanOnly: true,
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    handler: (s, a, actor) => s.applyPreset(str(a.id), actor),
  },
  {
    // 人格页删除用户自己导入的预设卡（内置卡不能删）；AI 工具没有这个动作
    ns: "preset",
    method: "delete",
    humanOnly: true,
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    handler: (s, a, actor) => s.deletePreset(str(a.id), actor),
  },
  {
    ns: "preset",
    method: "import",
    humanOnly: true,
    parameters: {
      type: "object",
      properties: { id: { type: "string" }, payload: { type: "object" }, label: { type: "string" } },
      required: ["id", "payload"],
    },
    handler: (s, a, actor) => {
      const id = str(a.id);
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return { ok: false, code: "E_VALID", message: "bad preset id" };
      if (id.startsWith("builtin-")) return { ok: false, code: "E_VALID", message: "builtin- 开头的标识留给内置预设，请换一个" };
      const label = str(a.label).trim().slice(0, 80);
      s.savePreset(id, obj(a.payload) as PersonaConfig, label || undefined);
      return { ok: true, id, by: actor };
    },
  },
  {
    ns: "card",
    method: "list",
    humanOnly: false,
    parameters: { type: "object", properties: {} },
    handler: (s) => ({ cards: s.persona().config.appearance?.cards ?? [] }),
  },
  {
    ns: "card",
    method: "update",
    humanOnly: true,
    parameters: { type: "object", properties: { cards: { type: "array" } }, required: ["cards"] },
    handler: (s, a, actor) => {
      const cfg = s.persona().config;
      const appearance = { ...(cfg.appearance ?? { enabled: false, text: "", byModel: {}, cards: [], index: true }), cards: a.cards as never };
      return s.updatePersona({ appearance } as Partial<PersonaConfig>, actor);
    },
  },
  {
    ns: "memory",
    method: "list",
    humanOnly: false,
    parameters: {
      type: "object",
      properties: {
        level: { type: "string" },
        status: { type: "string" },
        project: { type: "string" },
        limit: { type: "number" },
        offset: { type: "number" },
      },
    },
    handler: (s, a) => ({
      items: s.listMemory({
        level: a.level as never,
        status: a.status as never,
        project: a.project as never,
        limit: typeof a.limit === "number" ? a.limit : undefined,
        offset: typeof a.offset === "number" ? a.offset : undefined,
      }),
    }),
  },
  {
    ns: "memory",
    method: "get",
    humanOnly: false,
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    handler: (s, a) => {
      const e = s.getMemory(str(a.id));
      return e ? { ok: true, entry: e, links: s.linksOf(e.id) } : { ok: false, code: "E_VALID" };
    },
  },
  {
    ns: "memory",
    method: "update",
    humanOnly: false,
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        patch: { type: "object" },
        expectedUpdatedAt: { type: "number" },
      },
      required: ["id", "patch"],
    },
    handler: (s, a, actor) => {
      const id = str(a.id);
      const entry = s.getMemory(id);
      if (!entry) return { ok: false, code: "E_VALID", message: "not found" };
      // L2：rules/soul 的内容改动只允许人
      const patch = obj(a.patch) as Record<string, unknown>;
      const touchesCore = "content" in patch || "status" in patch;
      if (touchesCore && (entry.level === "rules" || entry.level === "soul")) {
        const g = guardHuman(actor);
        if (g !== true) return g;
      }
      const expected = typeof a.expectedUpdatedAt === "number" ? a.expectedUpdatedAt : undefined;
      return s.revise(id, patch as never, actor, expected);
    },
  },
  {
    ns: "memory",
    method: "archive",
    humanOnly: false,
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    handler: (s, a, actor) => {
      const id = str(a.id);
      const entry = s.getMemory(id);
      if (!entry) return { ok: false, code: "E_VALID", message: "memory not found" };
      if (actor !== "human" && (entry.level === "rules" || entry.level === "soul")) {
        return { ok: false, code: "E_PERM", message: "rules/soul status changes require human confirmation" };
      }
      s.archive(id, actor);
      return { ok: true, id };
    },
  },
  {
    // roadmap R10：设置页取消 / 恢复闪光灯（只有人能改）
    ns: "memory",
    method: "flash",
    humanOnly: true,
    parameters: { type: "object", properties: { id: { type: "string" }, flash: { type: "boolean" } }, required: ["id", "flash"] },
    handler: (s, a, actor) => s.setFlash(str(a.id), a.flash === true, actor),
  },
  {
    // roadmap v0.6 M1：设置页结算约定（兑现 / 落空 / 延期）
    ns: "memory",
    method: "promise",
    humanOnly: true,
    parameters: {
      type: "object",
      properties: { id: { type: "string" }, outcome: { type: "string" }, dueAt: { type: "string" } },
      required: ["id", "outcome"],
    },
    handler: (s, a, actor) => {
      const o = str(a.outcome);
      if (o !== "kept" && o !== "broken" && o !== "extend") return { ok: false, code: "E_VALID", message: "outcome must be kept|broken|extend" };
      return s.settlePromise(str(a.id), o, actor, typeof a.dueAt === "string" || typeof a.dueAt === "number" ? (a.dueAt as string | number) : undefined);
    },
  },
  {
    // roadmap v0.7 §8：设置页待整理数量与清单（只读）
    ns: "memory",
    method: "backlog",
    humanOnly: false,
    parameters: { type: "object", properties: {} },
    handler: (s) => ({ ok: true, ...s.backlog() }),
  },
  {
    // roadmap v0.7 S1：设置页编辑检索词（整体替换；[] 清空）
    ns: "memory",
    method: "terms",
    humanOnly: true,
    parameters: { type: "object", properties: { id: { type: "string" }, searchTerms: { type: "array", items: { type: "string" } } }, required: ["id", "searchTerms"] },
    handler: (s, a, actor) => s.setTerms(str(a.id), Array.isArray(a.searchTerms) ? a.searchTerms : [], actor),
  },
  {
    // roadmap v0.6 M2：设置页加 / 删日历锚点（anchor=null 删除）
    ns: "memory",
    method: "anchor",
    humanOnly: true,
    parameters: { type: "object", properties: { id: { type: "string" }, anchor: {} }, required: ["id"] },
    handler: (s, a, actor) => s.setAnchor(str(a.id), a.anchor ?? null, actor),
  },
  {
    ns: "memory",
    method: "restore",
    humanOnly: false,
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    handler: (s, a, actor) => {
      const id = str(a.id);
      const entry = s.getMemory(id);
      if (!entry) return { ok: false, code: "E_VALID", message: "memory not found" };
      if (actor !== "human" && (entry.level === "rules" || entry.level === "soul")) {
        return { ok: false, code: "E_PERM", message: "rules/soul status changes require human confirmation" };
      }
      s.restore(id, actor);
      return { ok: true, id };
    },
  },
  {
    ns: "memory",
    method: "forget",
    humanOnly: true,
    parameters: { type: "object", properties: { id: { type: "string" }, confirm: { type: "string" } }, required: ["id"] },
    handler: (s, a, actor) => {
      if (str(a.confirm) !== "FORGET") return { ok: false, code: "E_VALID", message: "confirm=FORGET required" };
      s.forget(str(a.id), actor);
      return { ok: true, id: str(a.id), forgotten: true };
    },
  },
  {
    ns: "candidates",
    method: "list",
    humanOnly: false,
    parameters: { type: "object", properties: { verdict: { type: "string" } } },
    handler: (s, a) => ({ candidates: s.listCandidates(a.verdict as never) }),
  },
  {
    ns: "candidates",
    method: "decide",
    humanOnly: true,
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        verdict: { type: "string" },
        targetId: { type: "string" },
      },
      required: ["id", "verdict"],
    },
    handler: (s, a, actor) => s.decideCandidate(str(a.id), a.verdict as never, actor, str(a.targetId) || undefined),
  },
  {
    ns: "conflicts",
    method: "list",
    humanOnly: false,
    parameters: { type: "object", properties: { status: { type: "string" } } },
    handler: (s, a) => ({ conflicts: s.listConflicts(str(a.status) || undefined) }),
  },
  {
    ns: "conflicts",
    method: "resolve",
    humanOnly: true,
    parameters: {
      type: "object",
      properties: { id: { type: "string" }, winnerId: { type: "string" } },
      required: ["id"],
    },
    handler: (s, a, actor) =>
      s.resolveConflict(str(a.id), a.winnerId === undefined ? null : str(a.winnerId), actor),
  },
  {
    ns: "inject",
    method: "ledger",
    humanOnly: false,
    parameters: { type: "object", properties: { sessionId: { type: "string" } }, required: ["sessionId"] },
    handler: (s, a) => ({ rows: s.ledger(str(a.sessionId)) }),
  },
  {
    ns: "inject",
    method: "sessions",
    humanOnly: false,
    parameters: { type: "object", properties: { limit: { type: "number" } } },
    handler: (s, a) => ({ sessions: s.ledgerSessions(typeof a.limit === "number" ? a.limit : 20) }),
  },
  {
    ns: "inject",
    method: "trace",
    humanOnly: false,
    parameters: { type: "object", properties: { sessionId: { type: "string" } }, required: ["sessionId"] },
    handler: (s, a) => ({
      trace: s.ledger(str(a.sessionId)).map((r) => ({
        segment: r.segment,
        chars: r.chars,
        items: r.items,
        trimmed: r.trimmed,
        detail: r.detail,
      })),
    }),
  },
  {
    ns: "audit",
    method: "query",
    humanOnly: false,
    parameters: {
      type: "object",
      properties: {
        actor: { type: "string" },
        action: { type: "string" },
        since: { type: "number" },
        limit: { type: "number" },
      },
    },
    handler: (s, a) => ({
      rows: s
        .audit({
          actor: str(a.actor) || undefined,
          action: str(a.action) || undefined,
          since: typeof a.since === "number" ? a.since : undefined,
          limit: typeof a.limit === "number" ? a.limit : undefined,
        })
        .map((r) => ({
          ...r,
          before: r.before === null ? null : mask(r.before),
          after: r.after === null ? null : mask(r.after),
        })),
    }),
  },
  {
    ns: "mirror",
    method: "rebuild",
    humanOnly: false,
    parameters: { type: "object", properties: {} },
    handler: (s) => s.rebuildMirrorNow(),
  },
  {
    ns: "dream",
    method: "run",
    humanOnly: false,
    parameters: {
      type: "object",
      properties: {
        force: { type: "boolean" },
        resetFailures: { type: "boolean" },
      },
    },
    handler: (s, a, actor) =>
      a.force === false
        ? s.maybeDream()
        : s.consolidate(actor, { resetFailures: a.resetFailures === true }),
  },
  {
    ns: "dream",
    method: "state",
    humanOnly: false,
    parameters: { type: "object", properties: {} },
    handler: (s) => s.dreamStatus(),
  },
  {
    ns: "backup",
    method: "list",
    humanOnly: false,
    parameters: { type: "object", properties: {} },
    handler: (s) => ({ backups: s.listBackups() }),
  },
  {
    ns: "backup",
    method: "restore",
    humanOnly: true,
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    handler: (s, a, actor) => s.restoreBackup(str(a.path), actor),
  },
  {
    ns: "backup",
    method: "now",
    humanOnly: true,
    parameters: { type: "object", properties: { label: { type: "string" } } },
    handler: (s, a, actor) => {
      const path = s.backupNow(str(a.label, "manual-" + actor));
      return { ok: true, path };
    },
  },
  {
    ns: "import",
    method: "list",
    humanOnly: false,
    parameters: { type: "object", properties: {} },
    handler: (s) => ({ ok: true, items: s.listImportRollbacks() }),
  },
  {
    ns: "import",
    method: "scan",
    humanOnly: false,
    parameters: { type: "object", properties: { payload: { type: "object" } }, required: ["payload"] },
    handler: (s, a) => s.importScan(obj(a.payload)),
  },
  {
    ns: "import",
    method: "run",
    humanOnly: true,
    parameters: { type: "object", properties: { payload: { type: "object" } }, required: ["payload"] },
    handler: (s, a, actor) => s.importRun(obj(a.payload), actor),
  },
  {
    ns: "import",
    method: "rollback",
    humanOnly: true,
    parameters: { type: "object", properties: { rollbackId: { type: "string" } }, required: ["rollbackId"] },
    handler: (s, a, actor) => s.rollbackImport(str(a.rollbackId), actor),
  },
  {
    ns: "settings",
    method: "get",
    humanOnly: false,
    parameters: { type: "object", properties: {} },
    handler: (s) => s.config,
  },
  {
    // 设置页「恢复默认」：出厂值 = 插件配置 + 内置默认（不含设置页保存过的 settings.json）
    ns: "settings",
    method: "defaults",
    humanOnly: false,
    parameters: { type: "object", properties: {} },
    handler: (s) => s.defaults ?? defaultConfig(s.env.dataDir),
  },
  {
    ns: "settings",
    method: "update",
    humanOnly: true,
    parameters: { type: "object", properties: { patch: { type: "object" } }, required: ["patch"] },
    handler: (s, a) => {
      const patch = obj(a.patch);
      delete patch.dataDir; // 库目录只能走 data/relocate
      // 敏感规则：去坏正则/去重/限量；锁定的凭据规则不允许被关闭
      const gov = patch.governance;
      if (gov && typeof gov === "object" && !Array.isArray(gov)) {
        const g = gov as Record<string, unknown>;
        if ("sensitivePatterns" in g) g.sensitivePatterns = sanitizeCustomPatterns(g.sensitivePatterns);
        if ("disabledSensitive" in g) g.disabledSensitive = sanitizeDisabledBuiltins(g.disabledSensitive);
      }
      clampRoadmapSettings(patch);
      s.config = mergeSettings(s.config, patch) as WeaveService["config"];
      // roadmap G8：日志级别/目录改动立即生效
      if (s.logger && ("logLevel" in patch || "log" in patch)) {
        try {
          s.attachLogger();
        } catch {
          // I8
        }
      }
      const persisted = s.persistSettings(patch);
      return { ok: true, config: s.config, persisted };
    },
  },
  {
    ns: "data",
    method: "location",
    humanOnly: false,
    parameters: { type: "object", properties: {} },
    handler: (s) => ({ ok: true, ...s.dataLocation() }),
  },
  {
    ns: "data",
    method: "relocate",
    humanOnly: true,
    parameters: {
      type: "object",
      properties: { dir: { type: "string" }, mode: { type: "string" } },
      required: ["dir"],
    },
    handler: (s, a, actor) => s.relocate(str(a.dir), a.mode === "use" ? "use" : "copy", actor),
  },
  {
    ns: "fs",
    method: "pickDir",
    humanOnly: true,
    parameters: { type: "object", properties: { initial: { type: "string" } } },
    // 在运行 DSH 的这台电脑上弹系统文件夹对话框；用户点确定/取消前一直等待
    handler: (_s, a) => pickDirectory(str(a.initial)),
  },
  {
    ns: "data",
    method: "export",
    humanOnly: false,
    parameters: { type: "object", properties: {} },
    handler: (s) => ({ ok: true, payload: s.exportAll() }),
  },
  {
    ns: "undo",
    method: "list",
    humanOnly: true,
    parameters: { type: "object", properties: { hours: { type: "number" } } },
    handler: (s, a) => ({
      ok: true,
      items: s.undoList(typeof a.hours === "number" ? a.hours : undefined),
      windowHours: s.config.governance.undoWindowHours,
    }),
  },
  {
    ns: "undo",
    method: "run",
    humanOnly: true,
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    handler: (s, a, actor) => s.undo(str(a.id), actor),
  },
  {
    ns: "reset",
    method: "run",
    humanOnly: true,
    parameters: { type: "object", properties: { confirm: { type: "string" } }, required: ["confirm"] },
    handler: (s, a, actor) => {
      if (str(a.confirm) !== "RESET") return { ok: false, code: "E_VALID", message: "confirm=RESET required" };
      return s.resetAll(actor);
    },
  },
];

export function buildRpcDescriptors(_service: WeaveService): RpcDescriptor[] {
  return RPC_METHODS.map((m) => {
    const spec: RpcParamSpec = m.parameters;
    return {
      id: "memweave." + m.ns + "/" + m.method,
      service: "memweave",
      namespace: m.ns,
      method: m.method,
      invocation: { kind: "direct" },
      parameters: spec,
      result: { type: "object" },
      codec: {
        parse(value: unknown): unknown {
          const v = obj(value);
          for (const key of spec.required ?? []) {
            if (v[key] === undefined) throw new Error("missing parameter: " + key);
          }
          return v;
        },
      },
    };
  });
}

/** 统一调用入口（UI / CLI / 测试共用）；humanOnly 方法校验 actor */
export async function invokeRpc(
  service: WeaveService,
  id: string,
  args: Record<string, unknown>,
  actor = "human",
): Promise<unknown> {
  const key = id.startsWith("memweave.") ? id.slice("memweave.".length) : id;
  const [ns, method] = key.split("/");
  const m = RPC_METHODS.find((x) => x.ns === ns && x.method === method);
  if (!m) return { ok: false, code: "E_VALID", message: "unknown rpc method: " + id };
  if (m.humanOnly) {
    const g = guardHuman(actor);
    if (g !== true) return g;
  }
  try {
    return await m.handler(service, obj(args), actor);
  } catch (e) {
    return { ok: false, code: "E_DB", message: String(e) };
  }
}
