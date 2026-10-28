/**
 * test/zero-dep（§15 / N1–N5）：运行时零依赖
 * - 打包产物里没有 node_modules / 原生模块；构建产物只引用 node: 内置（roadmap G12，取代 npm ls）；
 * - 产物与源码无 .node / .wasm 原生模块；
 * - 无 install 类钩子（断网冷装不执行任何脚本）；
 * - devDependencies 只允许 typescript / esbuild / vitest / @types/node。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git") continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

describe("zero-dep：运行时零依赖（N1–N5）", () => {
  it("package.json：无 dependencies、无 install 钩子、devDeps 白名单", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      scripts?: Record<string, string>;
    };
    expect(pkg.dependencies ?? {}).toEqual({});
    const allowed = new Set(["typescript", "esbuild", "vitest", "@types/node"]);
    for (const d of Object.keys(pkg.devDependencies ?? {})) {
      expect(allowed.has(d), "unexpected devDependency: " + d).toBe(true);
    }
    for (const hook of ["install", "preinstall", "postinstall", "prepare"]) {
      expect(pkg.scripts?.[hook], "install hook must not exist: " + hook).toBeUndefined();
    }
  });

  it("无 .node / .wasm 原生模块文件", () => {
    const natives = walk(root).filter((p) => /\.(node|wasm)$/i.test(p));
    expect(natives).toEqual([]);
  });

  // roadmap G12：npm ls 在 pnpm 目录里会把开发依赖误报为多余包，改为直接检查打包产物
  it("打包产物（最新 tgz）内无 node_modules / .node / .wasm，且只含 lib、清单与补丁", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name: string; version: string };
    const tgz = join(root, pkg.name + "-" + pkg.version + ".tgz");
    if (!existsSync(tgz)) return; // 未打包时跳过（打包后的全量测试会覆盖）
    const names = tarNames(gunzipSync(readFileSync(tgz)));
    expect(names.length).toBeGreaterThan(0);
    for (const n of names) {
      expect(n.includes("node_modules/"), "bundled node_modules: " + n).toBe(false);
      expect(/\.(node|wasm)$/i.test(n), "native module: " + n).toBe(false);
      expect(/^package\/(lib\/|package\.json$|cordis\.patch\.yml$|README|LICENSE|CHANGELOG)/i.test(n), "unexpected file: " + n).toBe(true);
    }
    expect(names).toContain("package/lib/index.js");
  });

  it("构建产物只引用 node: 内置模块（无第三方运行时依赖）", () => {
    for (const f of ["lib/index.js"]) {
      const p = join(root, f);
      if (!existsSync(p)) continue;
      const src = readFileSync(p, "utf8");
      // 只认语句级 import/export from 与 require/import()，模块名形如包名
      const specs = [
        ...src.matchAll(/(?:^|[;\n])\s*(?:import|export)\b[^;\n]*?\bfrom\s*["']([^"']+)["']/g),
        ...src.matchAll(/(?:^|[;\n])\s*import\s*["']([^"']+)["']/g),
        ...src.matchAll(/\b(?:require|import)\s*\(\s*["']([^"']+)["']\s*\)/g),
      ]
        .map((m) => m[1])
        .filter((s) => /^(@[a-z0-9._-]+\/)?[a-z0-9._:-]+(\/.*)?$/i.test(s) && !s.startsWith("."));
      const bad = specs.filter((s) => !s.startsWith("node:") && !s.startsWith("@deepseek-ai/dsh-typert-protocol"));
      expect(bad, "non-builtin imports in " + f).toEqual([]);
    }
  });
});

/** 极简 ustar 解析：只取文件名 */
function tarNames(buf: Buffer): string[] {
  const out: string[] = [];
  let off = 0;
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/s, "");
    const size = parseInt(header.subarray(124, 136).toString("utf8").replace(/\0.*$/s, "").trim() || "0", 8);
    const type = String.fromCharCode(header[156] || 48);
    if (type === "0" || type === "\0") out.push(prefix ? prefix + "/" + name : name);
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}
