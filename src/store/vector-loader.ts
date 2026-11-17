/**
 * 可选向量后端依赖的唯一加载点。
 * `sqlite-vec`（原生扩展）与 `vectra`（纯 JS）都不在 `package.json` 里：前者的二进制、后者的
 * 本体都随包分发，本机另行安装的多半没有——「没装」是常态，不该当成错误。
 * 旧实现用 `require(...) + catch {}` 静默吞错：装坏、ABI 不匹配、ESM/CJS 不兼容
 * 与「没装」看起来完全一样，设置页只会显示 disabled。
 * 这里把两种情况分开记录，并让状态接口把它们带回界面：
 * - `not-installed`：模块根本解析不到（常态，不需要处理）
 * - `load-failed`：模块存在但加载 / 初始化抛错（需要人看）
 * vectra 随包放在 lib/vendor/（见 vendor-path.ts），优先从那里加载，失败再走 node_modules。
 */
import { createRequire } from "node:module";
import { join } from "node:path";
import { bundledVendorDir } from "./vendor-path";

export type OptionalDepName = "sqlite-vec" | "vectra";
export type OptionalDepFailure = "not-installed" | "load-failed";

export interface OptionalDepStatus {
  available: boolean;
  reason: OptionalDepFailure | null;
  error: string | null;
}

export interface OptionalDepLoad<T = unknown> extends OptionalDepStatus {
  name: OptionalDepName;
  mod: T | null;
}

const cache = new Map<OptionalDepName, OptionalDepLoad<unknown>>();

/** 测试可替换的解析器（默认 `createRequire(import.meta.url)`） */
let resolverOverride: ((id: string) => unknown) | null = null;

/** 仅测试使用：注入假的模块解析器；传 null 恢复默认 */
export function setOptionalDepResolver(fn: ((id: string) => unknown) | null): void {
  resolverOverride = fn;
  cache.clear();
}

function resolve(name: string): unknown {
  if (resolverOverride) return resolverOverride(name);
  
  // vectra 随包自带（lib/vendor/）；没有或加载失败再走 node_modules
  const vendorDir = name === "vectra" ? bundledVendorDir() : null;
  if (vendorDir) {
    try {
      return createRequire(join(vendorDir, "package.json"))(name);
    } catch {
      // 退回 node_modules
    }
  }
  return createRequire(import.meta.url)(name);
}

function reasonOf(e: unknown): OptionalDepFailure {
  const code = (e as { code?: unknown } | null)?.code;
  // 模块或它的某个依赖缺失 → 视作没装；其余（语法错误、ERR_REQUIRE_ESM、ABI 等）→ 加载失败
  return code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND" ? "not-installed" : "load-failed";
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 解析一个可选依赖；结果按进程缓存（`resetOptionalDepCache` 可清） */
export function loadOptionalDep<T = unknown>(name: OptionalDepName): OptionalDepLoad<T> {
  const hit = cache.get(name);
  if (hit) return hit as OptionalDepLoad<T>;
  let result: OptionalDepLoad<T>;
  try {
    result = { name, available: true, reason: null, error: null, mod: resolve(name) as T };
  } catch (e) {
    result = { name, available: false, reason: reasonOf(e), error: messageOf(e), mod: null };
  }
  cache.set(name, result as OptionalDepLoad<unknown>);
  return result;
}

/** 模块本身能解析，但初始化（如 sqlite-vec 扩展加载）失败时记为 load-failed */
export function markOptionalDepFailure(name: OptionalDepName, error: unknown): void {
  cache.set(name, {
    name,
    available: false,
    reason: "load-failed",
    error: messageOf(error),
    mod: null,
  });
}

export function resetOptionalDepCache(): void {
  cache.clear();
}

/** 只取状态（不含模块本体），给设置页 / RPC 用 */
export function optionalDepStatus(name: OptionalDepName): OptionalDepStatus {
  const r = loadOptionalDep(name);
  return { available: r.available, reason: r.reason, error: r.error };
}
