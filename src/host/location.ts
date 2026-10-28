/**
 * 忆织 MemWeave —— 记忆库位置与设置持久化
 *
 * - 记忆库目录指针：`<DSH_HOME>/memweave-location.json`（库外，换目录后仍能找到）。
 *   优先级：插件配置里显式的 dataDir > 指针文件 > 默认 `<DSH_HOME>/memweave`。
 * - 高级设置：`<dataDir>/settings.json`（此前 settings/update 只改内存，重启即丢）。
 * 读失败一律回退默认，绝不阻塞开库。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";

export function dshHome(): string {
  return process.env.DSH_HOME || join(homedir(), ".dsh");
}

export function defaultDataDir(): string {
  return join(dshHome(), "memweave");
}

export function pointerFile(): string {
  return join(dshHome(), "memweave-location.json");
}

/** 指针文件里记录的目录；不存在或损坏返回空串 */
export function readPointer(): string {
  try {
    const file = pointerFile();
    if (!existsSync(file)) return "";
    const raw = JSON.parse(readFileSync(file, "utf8")) as { dataDir?: unknown };
    return typeof raw.dataDir === "string" && isAbsolute(raw.dataDir) ? raw.dataDir : "";
  } catch {
    return "";
  }
}

function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = file + ".tmp-" + process.pid;
  writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  renameSync(tmp, file);
}

export function writePointer(dataDir: string): void {
  writeJsonAtomic(pointerFile(), { dataDir, updatedAt: Date.now() });
}

export function clearPointer(): void {
  rmSync(pointerFile(), { force: true });
}

/** 规范化并校验用户输入的目录；不合法时返回错误信息 */
export function normalizeDataDir(input: string): { ok: true; dir: string } | { ok: false; message: string } {
  const raw = String(input ?? "").trim().replace(/^["']|["']$/g, "");
  if (!raw) return { ok: false, message: "路径不能为空" };
  if (!isAbsolute(raw)) return { ok: false, message: "请填写完整的绝对路径，例如 D:\\Data\\memweave" };
  if (/['\u0000]/.test(raw)) return { ok: false, message: "路径里不能包含单引号" };
  return { ok: true, dir: normalize(resolve(raw)) };
}

export function samePath(a: string, b: string): boolean {
  const n = (p: string): string => normalize(resolve(p)).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
}

// ---------- 设置持久化 ----------

export function settingsFile(dataDir: string): string {
  return join(dataDir, "settings.json");
}

export function readSettings(dataDir: string): Record<string, unknown> {
  try {
    const file = settingsFile(dataDir);
    if (!existsSync(file)) return {};
    const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function writeSettings(dataDir: string, settings: Record<string, unknown>): void {
  writeJsonAtomic(settingsFile(dataDir), settings);
}
