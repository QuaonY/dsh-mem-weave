/**
 * 忆织 MemWeave —— 插件入口（cordis apply / dispose）
 * 所有步骤 try/catch 降级，绝不阻塞会话（§3-I8）。
 */

import { randomUUID } from "node:crypto";
import { openWeaveDb, type WeaveEnv } from "../store/db";
import { defaultDataDir, readPointer, readSettings } from "./location";
import { ensureSchema } from "../store/migrate";
import { SCHEMA_SQL } from "../store/schema";
import { buildWeaveCommand, type CommandDeps } from "./commands";
import { buildSections, registerSections, waitFor, type RegisteredSection, type SectionHost } from "./sections";
import { WeaveService, defaultConfig, type WeaveConfig } from "./service";
import { buildRpcDescriptors, invokeRpc } from "./rpc";
import { buildTools, type ToolExec, type WeaveTool } from "./tools";
import { buildTurnNotice } from "./turn-notice";

export interface WeavePlugin {
  name: string;
  inject: string[];
  apply(ctx: unknown, config?: Partial<WeaveConfig>): void | Promise<void>;
  dispose(): void;
  /** 当前装配的运行时（宿主/测试观测用）；未装配或已卸载返回 null */
  runtime(): WeaveRuntime | null;
}

export type DataDirSource = "config" | "pointer" | "default";

/** 记忆库目录：插件配置显式 dataDir > 设置页选的目录（指针文件）> 默认 */
export function resolveDataDirWithSource(config: Partial<WeaveConfig> | undefined): { dir: string; source: DataDirSource } {
  const explicit = config?.dataDir;
  if (typeof explicit === "string" && explicit.length > 0) return { dir: explicit, source: "config" };
  const pointed = readPointer();
  if (pointed) return { dir: pointed, source: "pointer" };
  return { dir: defaultDataDir(), source: "default" };
}


function mergeDeep(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  const isRec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
  for (const [k, v] of Object.entries(patch)) out[k] = isRec(out[k]) && isRec(v) ? mergeDeep(out[k] as Record<string, unknown>, v) : v;
  return out;
}

function mergeConfig(config: Partial<WeaveConfig> | undefined, dataDir: string): WeaveConfig {
  const base = defaultConfig(dataDir);
  // 每个对象段都深合并：旧 settings.json 缺新键（roadmap 各阶段新增）时取默认值
  const merged = mergeDeep(base as unknown as Record<string, unknown>, (config ?? {}) as Record<string, unknown>) as unknown as WeaveConfig;
  merged.dataDir = dataDir;
  return merged;
}

/** 互斥检测（§11.2）：探测旧记忆 / 人格插件是否启用 */
export function detectLegacyPlugins(ctx: unknown): string[] {
  const found: string[] = [];
  const probe = ["meow-memory", "whale-persona"];
  for (const name of probe) {
    try {
      const c = ctx as { get?: (k: string) => unknown; registry?: { get?: (k: string) => unknown } };
      const svc = c?.get?.(name) ?? c?.registry?.get?.(name);
      if (svc) found.push(name);
    } catch {
      // 探测失败按未命中处理
    }
  }
  return found;
}

function ctxGet(ctx: unknown, key: string): unknown {
  try {
    return (ctx as { get?: (k: string) => unknown })?.get?.(key);
  } catch {
    return undefined;
  }
}

/** 把结果压成无损 JSON（去掉 undefined / 函数 / 循环引用），满足 dsh-tools 的输出校验 */
function toJsonValue(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value ?? null)) as unknown;
  } catch {
    return { ok: false, code: "E_DB", message: "tool result is not serializable" };
  }
}

/**
 * 转成 dsh-tools ctx.tools.register 认的工具定义：
 * { name, description, parameters(JSON Schema), output: { schema, render }, execute }。
 * 旧写法传的是 { descriptor, handler }，宿主校验 output 缺失直接抛错，工具从来没进过模型的工具列表。
 */
export function toDshToolDefinition(tool: WeaveTool): Record<string, unknown> {
  return {
    name: tool.descriptor.name,
    description: tool.descriptor.description,
    parameters: tool.descriptor.input,
    output: {
      schema: {},
      render: (_args: unknown, value: unknown) => [{ type: "text", text: JSON.stringify(value) }],
    },
    async execute(args: unknown, exec?: unknown): Promise<unknown> {
      const input = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
      const ex = exec && typeof exec === "object" ? (exec as ToolExec) : undefined;
      return toJsonValue(await tool.handler(input, ex));
    },
  };
}

export function registerTools(
  ctx: unknown,
  tools: WeaveTool[],
  warn: (m: string) => void,
  toolRegistry: { registered: string[]; failed: string[]; lastError: string } = { registered: [], failed: [], lastError: "" },
): Array<() => void> {
  const out: Array<() => void> = [];
  let disposed = false;
  const doRegister = (svc: { register?: (t: unknown) => unknown } | undefined): boolean => {
    if (disposed) return true;
    if (!svc || typeof svc.register !== "function") return false;
    toolRegistry.registered = [];
    toolRegistry.failed = [];
    for (const tool of tools) {
      try {
        const dispose = svc.register(toDshToolDefinition(tool)) as unknown;
        if (typeof dispose === "function") out.push(dispose as () => void);
        toolRegistry.registered.push(tool.descriptor.name);
      } catch (e) {
        const msg = String((e as Error)?.message ?? e);
        // 热重载时同名工具已在：不算失败
        if (/duplicate|already/i.test(msg)) {
          toolRegistry.registered.push(tool.descriptor.name);
          continue;
        }
        toolRegistry.failed.push(tool.descriptor.name);
        toolRegistry.lastError = tool.descriptor.name + ": " + msg;
        warn("tool registration failed: " + tool.descriptor.name + ": " + msg);
      }
    }
    return true;
  };

  // DSH 0.2.x：apply 阶段 ctx.tools 可能还没就绪，同步 register 不报错但工具不生效。
  // 官方做法是 ctx.inject(["tools"], cb)，等 tools 服务可用后再注册。
  const c = ctx as { inject?: (names: string[], cb: (sub: unknown) => void) => unknown; tools?: unknown };
  let injected = false;
  if (typeof c.inject === "function") {
    try {
      c.inject(["tools"], (sub: unknown) => {
        const svc = ((sub as { tools?: unknown })?.tools ?? ctxGet(sub, "tools") ?? c.tools ?? ctxGet(ctx, "tools")) as
          | { register?: (t: unknown) => unknown }
          | undefined;
        if (!doRegister(svc)) warn("tools service injected but has no register()");
      });
      injected = true;
    } catch (e) {
      warn("ctx.inject(['tools']) failed: " + String(e));
    }
  }
  if (!injected) {
    // 没有 inject：直接拿，拿不到就退避重试 1s/2s/4s/8s/16s
    const now = (c.tools ?? ctxGet(ctx, "tools")) as { register?: (t: unknown) => unknown } | undefined;
    if (!doRegister(now)) {
      let attempt = 0;
      const retry = (): void => {
        if (disposed) return;
        attempt += 1;
        const timer = setTimeout(() => {
          const svc = (c.tools ?? ctxGet(ctx, "tools")) as { register?: (t: unknown) => unknown } | undefined;
          if (doRegister(svc)) return;
          if (attempt < 5) retry();
          else warn("tools service unavailable after retries; weave_* tools not registered");
        }, 1000 * 2 ** (attempt - 1));
        (timer as { unref?: () => void }).unref?.();
      };
      retry();
    }
  }
  out.push(() => {
    disposed = true;
  });
  return out;
}

export interface WeaveRuntime {
  env: WeaveEnv;
  service: WeaveService;
  warnings: string[];
}

/** 供 CLI / 测试 / 宿主共用的开库入口 */
export function openService(
  dataDir?: string,
  config?: Partial<WeaveConfig>,
): WeaveRuntime {
  // 优先级：config.dataDir > dataDir 参数 > 指针文件 > 默认
  const cfgForResolve = config?.dataDir ? config : dataDir ? { dataDir } : undefined;
  const resolved = resolveDataDirWithSource(cfgForResolve);
  const dir = resolved.dir;
  const warnings: string[] = [];
  let env: WeaveEnv;
  let rw: WeaveEnv | null = null;
  try {
    rw = openWeaveDb(dir, { readonly: false });
    env = rw;
    ensureSchema(env);
  } catch (e) {
    warnings.push("db open failed, degraded to readonly: " + String(e));
    try {
      rw?.close();
    } catch {
      // 失败的写连接关不掉也继续
    }
    let ro: WeaveEnv | null = null;
    try {
      ro = openWeaveDb(dir, { readonly: true });
      env = ro;
      // 文件头损坏时只读连接能打开但任何查询都抛错：先探一次
      env.db.prepare("SELECT count(*) FROM sqlite_master").get();
    } catch (e2) {
      try {
        ro?.close();
      } catch {
        // 同上
      }
      // roadmap G11：连只读都读不了 → 空内存库兜底，读路径返回空、写入一律拒绝，绝不阻塞会话（I8）
      warnings.push("db unreadable, using empty in-memory readonly store: " + String(e2));
      env = openWeaveDb(dir, { readonly: true, memory: true });
      try {
        // memory 兜底的连接可建表；ensureSchema 在 readonly 下跳过旧表升级
        for (const sql of SCHEMA_SQL) env.db.exec(sql);
      } catch {
        // 同上
      }
    }
    try {
      ensureSchema(env);
    } catch {
      // 只读下无法建表：继续，读路径返回空
    }
  }
  // 设置页保存过的高级设置（settings.json）叠在插件配置之上
  const saved = readSettings(dir) as Partial<WeaveConfig>;
  delete (saved as Record<string, unknown>).dataDir;
  const service = new WeaveService(env, mergeConfig(mergeDeep((config ?? {}) as Record<string, unknown>, saved as Record<string, unknown>) as Partial<WeaveConfig>, dir));
  service.dataDirSource = resolved.source;
  // 设置页「恢复默认」的基准：插件配置 + 内置默认，不含 settings.json 里用户改过的值
  service.defaults = mergeConfig(config, dir);
  // 内置人格预设：只写进预设卡列表，不改当前人格
  service.seedBuiltinPresets();
  return { env, service, warnings };
}

type PreStepDecision = { kind: string; messages: unknown[]; [key: string]: unknown };

type PreStepPayload = {
  agent?: unknown;
  messages?: unknown[];
  turn?: number;
  step?: number;
};

function textFromTurnMessages(messages: unknown[]): string {
  const out: string[] = [];
  for (const raw of messages) {
    if (!raw || typeof raw !== "object") continue;
    const message = raw as { role?: unknown; content?: unknown };
    if (message.role !== "user") continue;
    if (typeof message.content === "string") {
      out.push(message.content);
      continue;
    }
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string") {
        out.push((block as { text: string }).text);
      }
    }
  }
  return out.join("\n");
}

/**
 * roadmap v0.3 G7（spike 结论：插件拿不到压缩事件，走退路）：
 * 消息列表里有压缩摘要（source.kind/form 含 compact，或正文是 DSH 的 checkpoint 摘要），
 * 且摘要之后没有忆织的 S2 快照 → 视为压缩吃掉了快照，需要重放。
 * 只认「有压缩标记」的情况，不会因为宿主只传增量消息而误判。
 */
export function needsReplay(messages: unknown[]): boolean {
  let lastCompact = -1;
  let lastSnapshot = -1;
  messages.forEach((raw, i) => {
    if (!raw || typeof raw !== "object") return;
    const m = raw as { source?: { kind?: unknown; form?: unknown; sections?: unknown }; content?: unknown };
    const kind = String(m.source?.kind ?? "") + "/" + String(m.source?.form ?? "");
    const text = typeof m.content === "string"
      ? m.content
      : Array.isArray(m.content)
        ? m.content.map((b) => (b && typeof b === "object" ? String((b as { text?: unknown }).text ?? "") : "")).join("\n")
        : "";
    if (/compact|checkpoint/i.test(kind) || /^This is an automatically generated checkpoint/.test(text.trimStart())) lastCompact = i;
    const sections = Array.isArray(m.source?.sections) ? (m.source!.sections as Array<{ name?: unknown }>) : [];
    if (sections.some((s) => s?.name === "memweave:s2-snapshot")) lastSnapshot = i;
  });
  return lastCompact >= 0 && lastSnapshot < lastCompact;
}

/** 每个 agent 本轮开始的时刻（pre-step step 1 记录），轮后通知用它圈定 audit 窗口 */
const turnStartByAgent = new WeakMap<object, number>();

type NoticeSession = { append?: (type: string, data: unknown, opts?: unknown) => unknown };

/**
 * 轮后通知：本轮结束、AI 回复完之后，若本轮有记忆写入/整理，就往会话追加一条
 * source.kind="memweave"、form="notice" 的消息。DSH 对话界面把它显示成可折叠卡片：
 * 折叠时一行摘要，展开看明细。直接 append 到会话、不经 inbox，不会触发额外一步推理。
 */
export function appendTurnNotice(service: WeaveService, agent: unknown, warn: (message: string) => void): boolean {
  if (!agent || typeof agent !== "object") return false;
  const session = (agent as { session?: NoticeSession }).session;
  if (!session || typeof session.append !== "function") return false;
  const since = turnStartByAgent.get(agent);
  if (since === undefined) return false;
  try {
    const cfg = service.config.governance?.turnNotice ?? { enabled: true };
    const notice = buildTurnNotice(service.env, since, service.config.promptLang ?? "zh", cfg);
    if (!notice.enabled) return false;
    // 同一轮里 turn-stopping 可能再次触发：窗口前移，避免重复计数
    turnStartByAgent.set(agent, Date.now());
    session.append("user/message", {
      id: randomUUID(),
      role: "user",
      content: [{ type: "text", text: notice.body }],
      source: { kind: "memweave", form: "notice", summary: notice.summary },
    }, { surfaceOp: "append" });
    return true;
  } catch (error) {
    warn("turn notice failed: " + String(error));
    return false;
  }
}

function registerTurnNotice(ctx: unknown, service: WeaveService, warn: (message: string) => void): (() => void) | null {
  const eventContext = ctx as {
    on?: (event: string, handler: (payload: unknown) => unknown) => unknown;
  };
  if (typeof eventContext.on !== "function") {
    warn("agent/turn-stopping unavailable: turn notice disabled");
    return null;
  }
  // serial 事件：返回 undefined，不拦截后续处理器
  const dispose = eventContext.on.call(ctx, "agent/turn-stopping", (raw) => {
    appendTurnNotice(service, (raw as { agent?: unknown } | null)?.agent, warn);
    return undefined;
  });
  return typeof dispose === "function" ? dispose as () => void : () => undefined;
}

/** roadmap G5：本轮已提示过反思的 agent（每轮最多一次；step 1 时清除） */
const reflectHinted = new WeakSet<object>();

export const REFLECT_TEXT_ZH = (n: number): string =>
  "已连续调用工具 " + n + " 次。如果这一串操作里有值得记住的教训（踩坑、纠正、有效做法），可以用 weave_remember 记为 lesson。";
export const REFLECT_TEXT_EN = (n: number): string =>
  "You have made " + n + " consecutive tool calls. If this sequence taught something worth keeping (a pitfall, a correction, an approach that worked), record it with weave_remember as a lesson.";

function isSubagent(agent: object): boolean {
  const a = agent as { parent?: unknown; parentId?: unknown; session?: { parentId?: unknown; parent?: unknown } };
  return Boolean(a.parent || a.parentId || a.session?.parentId || a.session?.parent);
}

/** 达到阈值时返回一条提示消息，否则 null；每轮最多一次，子代理跳过 */
export function reflectHint(service: WeaveService, agent: object, step: unknown): Record<string, unknown> | null {
  const cfg = service.config.reflect ?? { enabled: true, afterToolSteps: 7 };
  if (!cfg.enabled || service.paused) return null;
  if (typeof step !== "number" || !Number.isFinite(step)) return null;
  const toolSteps = step - 1;
  if (toolSteps < Math.max(1, cfg.afterToolSteps)) return null;
  if (reflectHinted.has(agent) || isSubagent(agent)) return null;
  reflectHinted.add(agent);
  const text = (service.config.promptLang === "en" ? REFLECT_TEXT_EN : REFLECT_TEXT_ZH)(toolSteps);
  return {
    id: randomUUID(),
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "memweave", form: "notice", sections: [{ name: "memweave:reflect", text }] },
  };
}

/** 测试用：模拟新一轮开始 */
export function resetReflect(agent: object): void {
  reflectHinted.delete(agent);
}

function registerTurnInjection(ctx: unknown, service: WeaveService, warn: (message: string) => void): (() => void) | null {
  const eventContext = ctx as {
    on?: (event: string, handler: (payload: unknown, next: () => unknown) => unknown) => unknown;
  };
  if (typeof eventContext.on !== "function") {
    warn("agent/pre-step unavailable: S2/S3 turn injection disabled");
    return null;
  }

  const stateByAgent = new WeakMap<object, { initialized: boolean; baseline: Map<string, number> }>();
  const dispose = eventContext.on.call(ctx, "agent/pre-step", async (raw, next) => {
    const decision = await next() as PreStepDecision;
    if (!decision || decision.kind !== "enter" || !Array.isArray(decision.messages)) return decision;
    const input = raw as PreStepPayload;
    if (!input.agent || typeof input.agent !== "object") return decision;
    if (input.step !== 1) {
      // roadmap G5：同一轮里 step ≥ 2 必然紧跟工具结果（纯文本回复会结束本轮），连续工具数 = step − 1
      try {
        const hint = reflectHint(service, input.agent as object, input.step);
        if (hint) return { ...decision, messages: [...decision.messages, hint] };
      } catch (error) {
        warn("reflect hint failed: " + String(error));
      }
      return decision;
    }
    reflectHinted.delete(input.agent as object);
    turnStartByAgent.set(input.agent as object, Date.now());
    const agent = input.agent as { id?: unknown; session?: { id?: unknown } };
    const sessionId = String(agent.session?.id ?? agent.id ?? "");
    if (!sessionId) return decision;

    const state = stateByAgent.get(input.agent as object) ?? { initialized: false, baseline: new Map<string, number>() };
    const turnNo = service.beginTurn(sessionId);
    try {
      // roadmap G7：压缩后重放快照 + 本会话写过的 / 查过的项目
      const replay = state.initialized && service.config.replay?.enabled !== false &&
        needsReplay(Array.isArray(input.messages) ? input.messages : []);
      const turn = service.renderTurn({
        sessionId,
        first: !state.initialized || replay,
        replay,
        query: textFromTurnMessages(Array.isArray(input.messages) ? input.messages : []) || undefined,
        baseline: state.baseline,
        turn: turnNo,
      });
      if (!turn.inject) return decision;

      const sections = [
        ...(turn.s2 ? [{ name: "memweave:s2-snapshot", text: turn.s2 }] : []),
        ...(turn.s3 ? [{ name: "memweave:s3-dynamic", text: turn.s3 }] : []),
      ];
      state.initialized = true;
      state.baseline = new Map(service.listMemory({}).map((entry) => [entry.id, entry.updatedAt]));
      stateByAgent.set(input.agent as object, state);
      if (sections.length === 0) return decision;

      const text = "Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n" +
        sections.map((section) => section.text).join("\n\n");
      const contextMessage = {
        id: randomUUID(),
        role: "user",
        content: [{ type: "text", text }],
        source: { kind: "runtime-context", form: "snapshot", sections },
      };
      return { ...decision, messages: [...decision.messages, contextMessage] };
    } catch (error) {
      warn("agent/pre-step S2/S3 injection failed: " + String(error));
      return decision;
    }
  });
  return typeof dispose === "function" ? dispose as () => void : () => undefined;
}


const plugin: WeavePlugin = {
  name: "dsh-mem-weave",
  inject: ["typert"],

  apply(ctx: unknown, config?: Partial<WeaveConfig>): void {
    const warnings: string[] = [];
    let fileLog: ((m: string) => void) | null = null;
    const warn = (m: string): void => {
      warnings.push(m);
      try {
        fileLog?.(m);
      } catch {
        // I8
      }
      try {
        (ctx as { logger?: { warn?: (s: string) => void } })?.logger?.warn?.("[memweave] " + m);
      } catch {
        // 无 logger 也照常
      }
    };

    let runtime: WeaveRuntime;
    try {
      runtime = openService(undefined, config);
    } catch (e) {
      warn("openService failed: " + String(e));
      return;
    }
    warnings.push(...runtime.warnings);
    const service = runtime.service;
    service.startupLinkHealth();
    // roadmap G8：文件日志（失败不影响启动）
    try {
      service.attachLogger();
      for (const w of warnings) service.logger?.warn(w);
    } catch {
      // I8
    }
    fileLog = (m) => service.logger?.warn(m);
    service.warn = warn;
    (this as { __runtime?: WeaveRuntime }).__runtime = runtime;

    // 互斥检测（§11.2）：绝不静默双份注入
    try {
      const legacy = detectLegacyPlugins(ctx);
      // 0.7.1 起去掉「允许共存」开关：检测到旧插件一律暂停注入（旧配置里的 allowCoexist 忽略）
      if (legacy.length > 0) {
        service.paused = true;
        service.pauseReason = "legacy plugins detected: " + legacy.join(", ");
        warn("检测到旧记忆插件（" + legacy.join(", ") + "），忆织已暂停注入（只写库）");
      }
    } catch (e) {
      warn("exclusion check failed: " + String(e));
    }

    const disposers: Array<() => void> = [];
    let sectionHandles: RegisteredSection[] = [];

    const rebuildSections = (): void => {
      for (const h of sectionHandles) {
        try {
          h.dispose();
        } catch {
          // 忽略
        }
      }
      sectionHandles = [];
      const svc = ctxGet(ctx, "systemPrompt") as SectionHost | undefined;
      if (!svc || typeof svc.section !== "function") {
        warn("systemPrompt service not available");
        return;
      }
      try {
        const specs = buildSections(service.persona().config, undefined, service.config.budget);
        sectionHandles = registerSections(svc, specs, warn);
      } catch (e) {
        warn("section build failed: " + String(e));
      }
    };

    // §13.2.2「立即 reload 并生效」：UI 经 memweave.persona/reload 触发同一重装配（I4 唯一解冻入口）
    service.reloadHook = rebuildSections;

    try {
      const stopTurnInjection = registerTurnInjection(ctx, service, warn);
      if (stopTurnInjection) disposers.push(stopTurnInjection);
    } catch (e) {
      warn("agent/pre-step registration failed: " + String(e));
    }

    try {
      const stopTurnNotice = registerTurnNotice(ctx, service, warn);
      if (stopTurnNotice) disposers.push(stopTurnNotice);
    } catch (e) {
      warn("turn notice registration failed: " + String(e));
    }

    // systemPrompt 服务轮询等待（§6.6：最多 20s）
    void waitFor(() => {
      const svc = ctxGet(ctx, "systemPrompt") as SectionHost | undefined;
      return svc && typeof svc.section === "function" ? svc : undefined;
    }, 20000)
      .then((svc) => {
        if (!svc) {
          warn("systemPrompt service timeout (20s): persona sections not registered");
          return;
        }
        rebuildSections();
      })
      .catch((e) => warn("systemPrompt wait failed: " + String(e)));

    // /weave 命令（commands 在 apply 期不可见，须动态 inject，§6.6）
    try {
      (ctx as { inject?: (names: string[]) => void })?.inject?.(["commands"]);
    } catch {
      // 忽略
    }
    try {
      const cmdSvc = ctxGet(ctx, "commands") as
        | { register?: (c: unknown) => unknown }
        | undefined;
      const deps: CommandDeps = {
        service,
        reload: rebuildSections,
        log: warn,
        applyPreset: (id: string) => service.applyPreset(id, "human"),
      };
      const cmd = buildWeaveCommand(deps);
      const dispose = cmdSvc?.register?.(cmd) as unknown;
      if (typeof dispose === "function") disposers.push(dispose as () => void);
      else if (!cmdSvc?.register) warn("commands service not available");
    } catch (e) {
      warn("command registration failed: " + String(e));
    }

    // 16 个 weave_* 工具
    try {
      disposers.push(...registerTools(ctx, buildTools(service), warn, service.toolStatus));
    } catch (e) {
      warn("tools registration failed: " + String(e));
    }

    // Typert Remote 服务异步注册，不阻塞 apply：网关在 internal/service 事件时会重建端点索引，
    // 注册稍晚也能被发现。dispose 先于注册完成时跳过注册，避免卸载后仍挂着服务。
    let remoteDisposed = false;
    disposers.push(() => {
      remoteDisposed = true;
    });
    void import("./remote-service")
      .then(({ WeaveRemoteService }) => {
        if (remoteDisposed) return;
        new WeaveRemoteService(ctx as object, service);
      })
      .catch((e: unknown) => warn("Typert Remote service registration failed: " + String(e)));

    // dream 自动收梭（§8.7）：每 10 分钟看一次，空闲且非峰时才真正跑（runDream 内部判定）；
    // 附录 A lifecycle.autoDream=false 可整体关掉自动触发
    const dreamTimer = setInterval(() => {
      try {
        if (service.config.lifecycle.autoDream === false) return;
        service.maybeDream();
      } catch {
        // dream 绝不阻塞会话
      }
    }, 600000);
    dreamTimer.unref?.();

    (this as { __dispose?: () => void }).__dispose = () => {
      for (const d of disposers) {
        try {
          d();
        } catch {
          // 忽略
        }
      }
      for (const h of sectionHandles) {
        try {
          h.dispose();
        } catch {
          // 忽略
        }
      }
      try {
        clearInterval(dreamTimer);
        service.reloadHook = null;
      } catch {
        // 忽略
      }
      try {
        service.stopMirror(true);
      } catch {
        // 忽略
      }
      try {
        runtime.env.close();
      } catch {
        // 忽略
      }
      (this as { __runtime?: WeaveRuntime }).__runtime = undefined;
    };
  },

  dispose(): void {
    const d = (this as { __dispose?: () => void }).__dispose;
    if (typeof d === "function") d();
  },

  runtime(): WeaveRuntime | null {
    return (this as { __runtime?: WeaveRuntime }).__runtime ?? null;
  },
};

export { invokeRpc, buildRpcDescriptors, buildTools, WeaveService, defaultConfig };
export { openWeaveDb, type WeaveEnv } from "../store/db";
export { ensureSchema } from "../store/migrate";
export { renderAll, renderS1, renderS2, renderS3, sanitizeData } from "../core/render";
export { buildSections, registerSections } from "./sections";
export { runLine as runWeaveCommand } from "./commands";

export default plugin;
