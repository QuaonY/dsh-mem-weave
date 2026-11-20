/**
 * 忆织 MemWeave —— RPC 描述符与方法面
 * 手写 descriptor + codec（{parse}），零依赖；RBAC 在 host 侧。
 */

import { LEVEL_ORDER, type EntryStatus, type Level, type PersonaConfig } from "../core/types";
import { renderHash } from "../core/hash";
import { sanitizeIntentRules } from "../core/intent";
import { sanitizeCustomPatterns, sanitizeDisabledBuiltins } from "../core/sensitive";
import { normalizeDecayFloor, parseHalfLifeValue } from "../core/score";
import { defaultConfig, type WeaveService } from "./service";
import { pickDirectory } from "./pick-dir";
import {
  installLocalModel,
  listLocalModels,
  localModelInstalling,
  localModelLastError,
  localModelStatus,
  removeLocalModel,
  startLocalModelInstall,
  transformersAvailable,
} from "../store/local-model";
// 画像生成
import { generateUserProfile, DEFAULT_PROFILE_CONFIG } from "../profile";

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

// settings/get 与 defaults 对 agent 可读：凭据只报有无、绝不回显（与 status 接口同一不变量）
function redactConfigSecrets(config: WeaveService["config"]): WeaveService["config"] {
  if (!config.embedding?.apiKey) return config;
  return { ...config, embedding: { ...config.embedding, apiKey: "" } };
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
 * 新增数值键过 settings/update 时夹到安全范围；布尔键强制成布尔。
 * 只改 patch 里出现的键，不补默认值。
 */
export function clampSettingsPatch(patch: Record<string, unknown>): void {
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
  clampAt(recall, "semanticMinScore", 0.1, 0.95, false);
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

  const res = (patch.emotion as Record<string, unknown> | undefined)?.residue;
  boolAt(res, "enabled");
  clampAt(res, "floor", 0, 1, false);
  clampAt(res, "minValence", 0, 1, false);

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
  // S1 / S2
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
  const co = sub(patch.links, "coRecall");
  boolAt(co, "enabled");
  clampAt(co, "step", 0.01, 1, false);
  clampAt(co, "cap", 0.5, 10, false);
  clampAt(co, "decayDays", 7, 3650);
  clampAt(co, "decayFactor", 0.1, 1, false);
  const life = patch.lifecycle;
  // 半衰期 / 衰减下限与 score.ts 共用同一套归一化（settings.json 手改也不至于静默关掉衰减）
  if (life && typeof life === "object" && !Array.isArray(life)) {
    const rec = life as Record<string, unknown>;
    const hl = rec.halfLifeDays;
    if (hl && typeof hl === "object" && !Array.isArray(hl)) {
      const table = hl as Record<string, unknown>;
      for (const lv of LEVEL_ORDER) {
        if (!(lv in table)) continue;
        const n = parseHalfLifeValue(table[lv]);
        // 非法值删键：mergeSettings 会保留用户原来的合法值（构造时已归一化）
        if (n === null) delete table[lv];
        else table[lv] = n;
      }
    }
    if ("decayFloor" in rec) rec.decayFloor = normalizeDecayFloor(rec.decayFloor);
  }
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

/**
 * 层名校验。
 * 边界上收到的 `level` 是任意字符串，而它会被用作 `LAYER_TABLES[level]` 的下标：
 * 不校验时非法层名会拼出 `UPDATE undefined ...`（SQL 报错含糊），层名合法但
 * 条目在别的层则静默更新 0 行。这里先收敛成 `Level`，非法值返回 `null` 让调用方
 * 回 `E_VALID`。表名始终来自白名单映射，不参与字符串拼接。
 */
function asLevel(v: unknown): Level | null {
  const s = str(v);
  return (LEVEL_ORDER as readonly string[]).includes(s) ? (s as Level) : null;
}

const STATUSES: readonly EntryStatus[] = ["active", "stale", "archived"];

const mask = (text: string): string => text.replace(/\d{8,}/g, (m) => m.slice(0, 2) + "**" + m.slice(-2));

export interface SelfcheckItem {
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * 一致性自检（治理页按钮）：三段装配同源、写权断言、导出往返、库完整性。
 * 全程只读不改库（写权探针走 humanOnly 拒绝路径，无副作用）。
 */
async function selfcheck(s: WeaveService): Promise<{ ok: boolean; checks: SelfcheckItem[] }> {
  const checks: SelfcheckItem[] = [];

  // ① 三段装配同源：hash 与三段文本的 renderHash 一致
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
    ns: "status",
    method: "health",
    humanOnly: false,
    parameters: { type: "object", properties: {} },
    handler: (s) => s.health(),
  },
  {
    ns: "status",
    method: "queues",
    humanOnly: false,
    parameters: { type: "object", properties: { detailLimit: { type: "number" } } },
    handler: (s, a) => s.queues(typeof a.detailLimit === "number" ? a.detailLimit : undefined),
  },
  {
    // 后台任务租约（多进程时谁跑 dream / 向量索引）
    ns: "status",
    method: "lease",
    humanOnly: false,
    parameters: { type: "object", properties: {} },
    handler: (s) => s.backgroundLeaseStatus(),
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
    method: "preview.full",
    humanOnly: false,
    parameters: { 
      type: "object", 
      properties: { 
        modelHint: { type: "string" },
        sessionId: { type: "string" },
        query: { type: "string" },
        first: { type: "boolean" },
      } 
    },
    handler: (s, a) => s.previewWithContext({
      modelHint: str(a.modelHint) || undefined,
      sessionId: str(a.sessionId) || undefined,
      query: str(a.query) || undefined,
      first: typeof a.first === "boolean" ? a.first : undefined,
    }),
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
    handler: async (s, a, actor) => {
      const patch = obj(a.patch) as Partial<PersonaConfig>;
      const expected = typeof a.expectedVersion === "number" ? a.expectedVersion : undefined;
      return await s.updatePersona(patch, actor, expected);
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
    handler: async (s, a, actor) => {
      const version = Number(a.version);
      const row = s.env.db
        .prepare("SELECT config FROM persona_history WHERE version = ?")
        .get(version) as Record<string, unknown> | undefined;
      if (!row) return { ok: false, code: "E_VALID", message: "version not found" };
      const config = JSON.parse(String(row.config)) as PersonaConfig;
      const expected = typeof a.expectedVersion === "number" ? a.expectedVersion : undefined;
      const updated = await s.updatePersona(config, actor, expected);
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
    handler: async (s, a, actor) => await s.applyPreset(str(a.id), actor),
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
    handler: async (s, a, actor) => {
      const cfg = s.persona().config;
      const appearance = { ...(cfg.appearance ?? { enabled: false, text: "", byModel: {}, cards: [], index: true }), cards: a.cards as never };
      return await s.updatePersona({ appearance } as Partial<PersonaConfig>, actor);
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
    handler: (s, a) => {
      const level = a.level === undefined ? null : asLevel(a.level);
      if (level === null && a.level !== undefined) {
        return { ok: false, code: "E_VALID", message: "level must be one of " + LEVEL_ORDER.join("|") };
      }
      const status = str(a.status);
      if (status && !STATUSES.includes(status as EntryStatus)) {
        return { ok: false, code: "E_VALID", message: "status must be one of " + STATUSES.join("|") };
      }
      return {
        items: s.listMemory({
          level: level ?? undefined,
          status: (status || undefined) as EntryStatus | undefined,
          project: typeof a.project === "string" ? a.project : undefined,
          limit: typeof a.limit === "number" ? a.limit : undefined,
          offset: typeof a.offset === "number" ? a.offset : undefined,
        }),
      };
    },
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
    method: "detail",
    humanOnly: false,
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    handler: (s, a) => {
      const d = s.memoryDetail(str(a.id));
      if (!d) return { ok: false, code: "E_VALID" };
      return {
        ok: true,
        ...d,
        history: d.history.map((h) => ({
          ...h,
          before: h.before === null ? null : mask(h.before),
          after: h.after === null ? null : mask(h.after),
        })),
      };
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
    handler: async (s, a, actor) => {
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
      return await s.revise(id, patch as never, actor, expected);
    },
  },
  {
    ns: "memory",
    method: "archive",
    humanOnly: false,
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    handler: async (s, a, actor) => {
      const id = str(a.id);
      const entry = s.getMemory(id);
      if (!entry) return { ok: false, code: "E_VALID", message: "memory not found" };
      if (actor !== "human" && (entry.level === "rules" || entry.level === "soul")) {
        return { ok: false, code: "E_PERM", message: "rules/soul status changes require human confirmation" };
      }
      await s.archive(id, actor);
      return { ok: true, id };
    },
  },
  {
    // 设置页取消 / 恢复闪光灯（只有人能改）
    ns: "memory",
    method: "flash",
    humanOnly: true,
    parameters: { type: "object", properties: { id: { type: "string" }, flash: { type: "boolean" } }, required: ["id", "flash"] },
    handler: (s, a, actor) => s.setFlash(str(a.id), a.flash === true, actor),
  },
  {
    // 设置页结算约定（兑现 / 落空 / 延期）
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
    // 设置页待整理数量与清单（只读）
    ns: "memory",
    method: "backlog",
    humanOnly: false,
    parameters: { type: "object", properties: {} },
    handler: (s) => ({ ok: true, ...s.backlog() }),
  },
  {
    // 设置页编辑检索词（整体替换；[] 清空）
    ns: "memory",
    method: "terms",
    humanOnly: true,
    parameters: { type: "object", properties: { id: { type: "string" }, searchTerms: { type: "array", items: { type: "string" } } }, required: ["id", "searchTerms"] },
    handler: (s, a, actor) => s.setTerms(str(a.id), Array.isArray(a.searchTerms) ? a.searchTerms : [], actor),
  },
  {
    // 设置页加 / 删日历锚点（anchor=null 删除）
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
    handler: async (s, a, actor) => {
      const id = str(a.id);
      const entry = s.getMemory(id);
      if (!entry) return { ok: false, code: "E_VALID", message: "memory not found" };
      if (actor !== "human" && (entry.level === "rules" || entry.level === "soul")) {
        return { ok: false, code: "E_PERM", message: "rules/soul status changes require human confirmation" };
      }
      await s.restore(id, actor);
      return { ok: true, id };
    },
  },
  {
    ns: "memory",
    method: "forget",
    humanOnly: true,
    parameters: { type: "object", properties: { id: { type: "string" }, confirm: { type: "string" } }, required: ["id"] },
    handler: async (s, a, actor) => {
      if (str(a.confirm) !== "FORGET") return { ok: false, code: "E_VALID", message: "confirm=FORGET required" };
      await s.forget(str(a.id), actor);
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
    handler: async (s, a, actor) => await s.decideCandidate(str(a.id), a.verdict as never, actor, str(a.targetId) || undefined),
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
    // 注入延迟与规模（inject_state 的监控列）
    ns: "inject",
    method: "state",
    humanOnly: false,
    parameters: { type: "object", properties: { sessionId: { type: "string" } }, required: ["sessionId"] },
    handler: (s, a) => ({ state: s.injectState(str(a.sessionId)) }),
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
    handler: (s) => {
      const backups = s.listBackupsEnhanced().map(b => ({ ...b, path: b.filepath }));
      return { ok: true, backups };
    },
  },
  {
    ns: "backup",
    method: "create",
    humanOnly: true,
    parameters: {
      type: "object",
      properties: {
        label: { type: "string" },
        encrypt: { type: "boolean" },
        encryptionKey: { type: "string" },
      },
    },
    handler: async (s, params: { label?: string; encrypt?: boolean; encryptionKey?: string }) => {
      try {
        const result = await s.createBackup({
          label: params.label ? str(params.label) : undefined,
          encrypt: params.encrypt,
          encryptionKey: params.encryptionKey ? str(params.encryptionKey) : undefined,
        });
        return { ok: true, backup: result };
      } catch (e) {
        return { ok: false, code: "E_BACKUP", message: String(e) };
      }
    },
  },
  {
    ns: "backup",
    method: "verify",
    humanOnly: false,
    parameters: {
      type: "object",
      properties: {
        backupId: { type: "number" },
      },
      required: ["backupId"],
    },
    handler: (s, params, actor) => {
      const { backupId } = params as { backupId: number };
      try {
        const result = s.verifyBackup(backupId);
        return { ok: true, verification: result };
      } catch (e) {
        return { ok: false, code: "E_BACKUP", message: String(e) };
      }
    },
  },
  {
    ns: "backup",
    method: "restore",
    humanOnly: true,
    parameters: {
      type: "object",
      properties: {
        backupId: { type: "number" },
        verifyIntegrity: { type: "boolean" },
        createSafetyBackup: { type: "boolean" },
        decryptionKey: { type: "string" },
      },
      required: ["backupId"],
    },
    handler: async (s, params, actor) => {
      const { backupId, verifyIntegrity, createSafetyBackup, decryptionKey } = params as { 
        backupId: number; 
        verifyIntegrity?: boolean; 
        createSafetyBackup?: boolean; 
        decryptionKey?: string 
      };
      try {
        const result = await s.restoreBackupEnhanced(backupId, {
          verifyIntegrity,
          createSafetyBackup,
          decryptionKey: decryptionKey ? str(decryptionKey) : undefined,
        });
        return result;
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    },
  },
  {
    ns: "backup",
    method: "delete",
    humanOnly: true,
    parameters: {
      type: "object",
      properties: {
        backupId: { type: "number" },
      },
      required: ["backupId"],
    },
    handler: async (s, params, actor) => {
      const { backupId } = params as { backupId: number };
      try {
        const deleted = await s.deleteBackup(backupId);
        if (deleted) {
          return { ok: true };
        } else {
          return { ok: false, code: "E_NOT_FOUND", message: "Backup not found" };
        }
      } catch (e) {
        return { ok: false, code: "E_BACKUP", message: String(e) };
      }
    },
  },
  {
    ns: "backup",
    method: "now",
    humanOnly: true,
    parameters: { type: "object", properties: { label: { type: "string" } } },
    handler: (s, a, actor) => {
      try {
        const path = s.backupNow(str(a.label, "manual-" + actor));
        return { ok: true, path };
      } catch (e) {
        return { ok: false, code: "E_BACKUP", message: String(e) };
      }
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
    handler: (s) => redactConfigSecrets(s.config),
  },
  {
    // 设置页「恢复默认」：出厂值 = 插件配置 + 内置默认（不含设置页保存过的 settings.json）
    ns: "settings",
    method: "defaults",
    humanOnly: false,
    parameters: { type: "object", properties: {} },
    handler: (s) => redactConfigSecrets(s.defaults ?? defaultConfig(s.env.dataDir)),
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
      clampSettingsPatch(patch);
      s.config = mergeSettings(s.config, patch) as WeaveService["config"];
      // 多人格开关当轮生效（旧实现要重启才建管理器）
      if (patch.multiPersona && typeof patch.multiPersona === "object") {
        s.syncMultiPersona();
      }
      // 日志级别/目录改动立即生效
      if (s.logger && ("logLevel" in patch || "log" in patch)) {
        try {
          s.attachLogger();
        } catch {

        }
      }
      const persisted = s.persistSettings(patch);
      return { ok: true, config: s.config, persisted };
    },
  },
  {
    // 设置页「保存并测试」/ 开关。模型与维度可留空，host 会探测补全。
    ns: "embedding",
    method: "configure",
    humanOnly: true,
    parameters: {
      type: "object",
      properties: {
        enabled: { type: "boolean" },
        provider: { type: "string" },
        baseUrl: { type: "string" },
        model: { type: "string" },
        apiKey: { type: "string" },
        dimensions: { type: "number" },
      },
    },
    handler: async (s, a) =>
      s.applyEmbeddingConfig({
        enabled: typeof a.enabled === "boolean" ? a.enabled : undefined,
        provider: a.provider === undefined ? undefined : str(a.provider),
        baseUrl: a.baseUrl === undefined ? undefined : str(a.baseUrl),
        model: a.model === undefined ? undefined : str(a.model),
        apiKey: a.apiKey === undefined ? undefined : str(a.apiKey),
        dimensions: typeof a.dimensions === "number" ? a.dimensions : undefined,
      }),
  },
  {
    // 重新探测本机 / 云端 embedding（启动时只探测一次）
    ns: "embedding",
    method: "discover",
    humanOnly: true,
    parameters: { type: "object", properties: {} },
    handler: async (s) => s.rediscoverEmbedding(),
  },
  {
    // 可下载的本地模型清单与安装状态（读，不写）
    ns: "embedding",
    method: "model.status",
    humanOnly: false,
    parameters: { type: "object", properties: { model: { type: "string" } } },
    handler: async (s, a) => {
      const models = listLocalModels(s.env.dataDir);
      const requested = typeof a.model === "string" && a.model.trim() ? a.model.trim() : undefined;
      const current = requested ? localModelStatus(s.env.dataDir, requested) : models.find((m) => m.installed) ?? models[0];
      const rt = await transformersAvailable();
      return {
        ok: true,
        ...current,
        installing: localModelInstalling(s.env.dataDir, current.id),
        lastError: localModelLastError(s.env.dataDir, current.id),
        models,
        runtimeOk: rt.ok,
        runtimeMessage: rt.message,
        runtimeVersion: rt.version,
      };
    },
  },
  {
    // 一键下载本地模型；endpoint 可指向镜像
    ns: "embedding",
    method: "model.install",
    humanOnly: true,
    parameters: { type: "object", properties: { model: { type: "string" }, endpoint: { type: "string" } } },
    handler: async (s, a) => {
      if (s.env.readonly) return { ok: false, message: "记忆库处于只读模式，无法写入模型文件" };
      const endpoint = typeof a.endpoint === "string" && a.endpoint.trim() ? a.endpoint.trim() : undefined;
      const modelId = typeof a.model === "string" && a.model.trim() ? a.model.trim() : undefined;
      // 立即返回，下载在后台；进度用 embedding/model.status 轮询
      return startLocalModelInstall({ dataDir: s.env.dataDir, modelId, endpoint });
    },
  },
  {
    ns: "embedding",
    method: "model.remove",
    humanOnly: true,
    parameters: { type: "object", properties: { model: { type: "string" } } },
    handler: (s, a) => {
      const modelId = typeof a.model === "string" && a.model.trim() ? a.model.trim() : undefined;
      return removeLocalModel(s.env.dataDir, modelId);
    },
  },
  {
    // 换模型 / 换维度后旧向量作废 —— 手动重建（清空 + 全部重新入队）
    ns: "embedding",
    method: "reindex",
    humanOnly: true,
    parameters: { type: "object", properties: {} },
    handler: async (s) => {
      if (s.env.readonly) return { ok: false, message: "记忆库处于只读模式，无法重建索引" };
      const r = await s.rebuildVectorIndex();
      if (r.ok) void s.pumpVectorQueue(20).catch(() => undefined);
      return r;
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
  // 用户画像 RPC 方法
  {
    ns: "profile",
    method: "get",
    humanOnly: false,
    parameters: { type: "object", properties: {} },
    handler: (s) => {
      const config = s.config.profile ?? DEFAULT_PROFILE_CONFIG;
      if (!config.enabled) {
        return { ok: true, enabled: false };
      }
      const profile = generateUserProfile(s.env, config);
      // 添加用户自定义描述
      if ((config as any).customDescription) {
        profile.customDescription = (config as any).customDescription;
      }
      profile.lastUpdatedAt = Date.now();
      return { ok: true, enabled: true, profile };
    },
  },
  {
    ns: "profile",
    method: "regenerate",
    humanOnly: true,
    parameters: { type: "object", properties: {} },
    handler: (s) => {
      const config = s.config.profile ?? DEFAULT_PROFILE_CONFIG;
      if (!config.enabled) {
        return { ok: false, code: "E_VALID", message: "Profile not enabled" };
      }
      const profile = generateUserProfile(s.env, config);
      return { ok: true, profile };
    },
  },
  {
    ns: "profile",
    method: "deleteItem",
    humanOnly: true,
    parameters: { 
      type: "object", 
      properties: { 
        category: { type: "string" },
        content: { type: "string" }
      }, 
      required: ["category", "content"] 
    },
    handler: () => {
      // 注意：画像是派生视图，删除某项需要修改源记忆或加入过滤规则
      // 这里简化实现，实际应该标记为"用户不想看到"
      return { ok: true, message: "Profile items are derived views. To remove, archive or modify the source memories." };
    },
  },
  {
    ns: "profile",
    method: "clearAll",
    humanOnly: true,
    parameters: { type: "object", properties: {} },
    handler: () => {
      // 画像是派生视图，清空意味着禁用功能或清除源记忆
      return { ok: true, message: "Profile is a derived view. To clear, disable profile.enabled in config or archive source memories." };
    },
  },
  {
    ns: "profile",
    method: "setEnabled",
    humanOnly: true,
    parameters: { 
      type: "object", 
      properties: { enabled: { type: "boolean" } }, 
      required: ["enabled"] 
    },
    handler: (s, params, actor) => {
      const { enabled } = params as { enabled: boolean };
      // 更新配置
      s.config.profile = s.config.profile ?? { ...DEFAULT_PROFILE_CONFIG };
      s.config.profile.enabled = enabled;
      // 注意：这里只更新内存中的配置，实际持久化需要宿主支持
      return { ok: true, enabled };
    },
  },
  {
    ns: "profile",
    method: "updateDescription",
    humanOnly: true,
    parameters: { 
      type: "object", 
      properties: { description: { type: "string" } }, 
      required: ["description"] 
    },
    handler: (s, params, actor) => {
      const { description } = params as { description: string };
      // 保存自定义描述到配置或数据库
      // 这里简单存储到内存配置中
      if (!s.config.profile) {
        s.config.profile = { ...DEFAULT_PROFILE_CONFIG };
      }
      // 注意：需要扩展配置类型以支持 customDescription
      (s.config.profile as any).customDescription = description;
      return { ok: true };
    },
  },
  // 会话 Persona RPC 方法
  {
    ns: "persona",
    method: "getForSession",
    humanOnly: false,
    parameters: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
      },
    },
    handler: (s, params: { sessionId?: string }) => {
      const persona = s.getPersonaForSession(params.sessionId);
      return { ok: true, persona };
    },
  },
  {
    ns: "persona",
    method: "getSessionPersona",
    humanOnly: false,
    parameters: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
      },
      required: ["sessionId"],
    },
    handler: (s, params, actor) => {
      const { sessionId } = params as { sessionId: string };
      const sessionPersona = s.getSessionPersona(sessionId);
      if (!sessionPersona) {
        return { ok: true, found: false };
      }
      return { ok: true, found: true, sessionPersona };
    },
  },
  {
    ns: "persona",
    method: "setSessionPersona",
    humanOnly: true,
    parameters: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        overrides: { type: "object" },
      },
      required: ["sessionId", "overrides"],
    },
    handler: (s, params, actor) => {
      const { sessionId, overrides } = params as { sessionId: string; overrides: Record<string, unknown> };
      const config = s.config.multiPersona;
      if (!config?.enabled) {
        return { ok: false, code: "E_VALID", message: "Multi-persona not enabled" };
      }
      s.setSessionPersona(sessionId, overrides as any);
      return { ok: true };
    },
  },
  {
    ns: "persona",
    method: "clearSessionPersona",
    humanOnly: true,
    parameters: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
      },
      required: ["sessionId"],
    },
    handler: (s, params, actor) => {
      const { sessionId } = params as { sessionId: string };
      s.clearSessionPersona(sessionId);
      return { ok: true };
    },
  },
  // 隐私保护端点
  {
    ns: "privacy",
    method: "detect",
    humanOnly: false,
    parameters: {
      type: "object",
      properties: {
        text: { type: "string" },
      },
      required: ["text"],
    },
    handler: (s, params, actor) => {
      const { text } = params as { text: string };
      const textStr = str(text);
      if (!textStr) {
        return { ok: false, code: "E_VALID", message: "text is required" };
      }
      const sensitiveInfo = s.detectSensitiveInfo(textStr);
      return {
        ok: true,
        hasSensitive: sensitiveInfo.length > 0,
        sensitiveInfo,
      };
    },
  },
  {
    ns: "privacy",
    method: "getSensitiveMemories",
    humanOnly: true,
    parameters: {
      type: "object",
      properties: {
        level: { type: "string" },
        limit: { type: "number" },
      },
    },
    handler: (s, params: { level?: string; limit?: number }) => {
      // 非法层名直接 E_VALID，不再把任意字符串当表名下标
      const level = params.level === undefined ? undefined : asLevel(params.level);
      if (level === null) {
        return { ok: false, code: "E_VALID", message: "level must be one of " + LEVEL_ORDER.join("|") };
      }
      const limit = typeof params.limit === "number" ? params.limit : undefined;
      const memories = s.getSensitiveMemories(level, limit);
      return {
        ok: true,
        count: memories.length,
        memories,
      };
    },
  },
  {
    ns: "privacy",
    method: "markSensitive",
    humanOnly: true,
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        level: { type: "string" },
        sensitive: { type: "boolean" },
      },
      required: ["id", "level"],
    },
    handler: (s, params, actor) => {
      const { id, level, sensitive } = params as { id: string; level: string; sensitive?: boolean };
      const idStr = str(id);
      const levelStr = asLevel(level);
      const sensitiveFlag = typeof sensitive === "boolean" ? sensitive : true;

      if (!idStr || !levelStr) {
        return {
          ok: false,
          code: "E_VALID",
          message: "id and a valid level (" + LEVEL_ORDER.join("|") + ") are required",
        };
      }

      try {
        return s.markMemoryAsSensitive(idStr, levelStr, sensitiveFlag);
      } catch (e) {
        return { ok: false, code: "E_STORE", message: String(e) };
      }
    },
  },
  // 冲突解决端点
  {
    ns: "conflict",
    method: "detect",
    humanOnly: false,
    parameters: {
      type: "object",
      properties: {},
    },
    handler: (s) => {
      try {
        const result = s.detectConflicts();
        return {
          ok: true,
          ...result,
        };
      } catch (e) {
        return { ok: false, code: "E_STORE", message: String(e) };
      }
    },
  },
  {
    ns: "conflict",
    method: "list",
    humanOnly: true,
    parameters: {
      type: "object",
      properties: {
        status: { type: "string" },
      },
    },
    handler: (s, params: { status?: "pending" | "resolved" | "ignored" }) => {
      try {
        const conflicts = s.getConflicts(params.status);
        return {
          ok: true,
          count: conflicts.length,
          conflicts,
        };
      } catch (e) {
        return { ok: false, code: "E_STORE", message: String(e) };
      }
    },
  },
  {
    ns: "conflict",
    method: "resolve",
    humanOnly: true,
    parameters: {
      type: "object",
      properties: {
        conflictId: { type: "number" },
        resolution: { type: "string" },
        mergedContent: { type: "string" },
        reason: { type: "string" },
      },
      required: ["conflictId", "resolution"],
    },
    handler: (s, params, actor) => {
      const { conflictId, resolution, mergedContent, reason } = params as { 
        conflictId: number; 
        resolution: string; 
        mergedContent?: string; 
        reason?: string 
      };
      const conflictIdNum = typeof conflictId === "number" ? conflictId : 0;
      const resolutionStr = str(resolution) as any;
      
      if (!conflictIdNum || !resolutionStr) {
        return { ok: false, code: "E_VALID", message: "conflictId and resolution are required" };
      }
      
      try {
        s.resolveMemoryConflict(conflictIdNum, {
          resolution: resolutionStr,
          merged_content: mergedContent ? str(mergedContent) : undefined,
          reason: reason ? str(reason) : undefined,
          actor,
        });
        return { ok: true };
      } catch (e) {
        return { ok: false, code: "E_STORE", message: String(e) };
      }
    },
  },
  {
    ns: "conflict",
    method: "merge",
    humanOnly: true,
    parameters: {
      type: "object",
      properties: {
        conflictId: { type: "number" },
        mergedContent: { type: "string" },
      },
      required: ["conflictId", "mergedContent"],
    },
    handler: (s, params, actor) => {
      const { conflictId, mergedContent } = params as { conflictId: number; mergedContent: string };
      const conflictIdNum = typeof conflictId === "number" ? conflictId : 0;
      const mergedContentStr = str(mergedContent);
      
      if (!conflictIdNum || !mergedContentStr) {
        return { ok: false, code: "E_VALID", message: "conflictId and mergedContent are required" };
      }
      
      try {
        s.mergeConflictingMemories(conflictIdNum, mergedContentStr);
        return { ok: true };
      } catch (e) {
        return { ok: false, code: "E_STORE", message: String(e) };
      }
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
