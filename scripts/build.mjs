/**
 * 忆织 MemWeave —— 构建脚本（零运行时依赖，仅 devDep esbuild）
 * host  -> lib/index.js  （platform node，external node:*，esm）
 * client-> lib/client.js （platform browser，cjs，包 __ModuleLoader__ 工厂；react 经宿主模块表注入）
 * 产物体积只打印、不设上限（自带原生扩展需要空间）
 * 打包时调用 vendor-bundle.mjs，把 transformers + vectra 拷进 lib/vendor
 */
import { build } from "esbuild";
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { VENDOR_PACKAGES } from "./vendor-pins.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outdir = join(root, "lib");

await mkdir(outdir, { recursive: true });

const shared = {
  bundle: true,
  minify: false,
  sourcemap: false,
  logLevel: "silent",
  target: "node22",
};

const hostResult = await build({
  ...shared,
  entryPoints: [join(root, "src", "host", "index.ts")],
  outfile: join(outdir, "index.js"),
  platform: "node",
  format: "esm",
  external: ["node:*", "@deepseek-ai/dsh-typert-protocol", "vectra", "sqlite-vec"],
  target: "node22",
});

// client：CJS + 宿主模块表 require("react")（external），产物包 __ModuleLoader__ 工厂
//（id = 包名，对齐 meow-memory 等在架插件的装载约定）
const CLIENT_ID = "dsh-mem-weave";
const clientResult = await build({
  ...shared,
  entryPoints: [join(root, "src", "client", "index.ts")],
  outfile: join(outdir, "client.js"),
  platform: "browser",
  format: "cjs",
  target: "es2022",
  external: ["react"],
  write: false,
});

const clientCode = clientResult.outputFiles?.[0]?.text ?? "";
const clientWrapped =
  "window.__ModuleLoader__.load({\n" +
  '  id: "' + CLIENT_ID + '",\n' +
  "  factory: (require) => {\n" +
  "    var module = { exports: {} };\n" +
  "    var exports = module.exports;\n" +
  clientCode.replace(/^/gm, "    ") +
  "\n    return module.exports;\n" +
  "  }\n" +
  "});\n";
await writeFile(join(outdir, "client.js"), clientWrapped, "utf8");

for (const w of [...(hostResult.warnings ?? []), ...(clientResult.warnings ?? [])]) {
  console.warn("[build] warn:", w.text);
}

// 包内自带的 sqlite-vec 二进制：vendor/ → lib/native/<platform>-<arch>/vec0.*
// 缺失时只警告，不阻塞构建（源码包/CI 无 vendor 时仍可构建，运行时退回 builtin）
const vendorDir = join(root, "vendor", "sqlite-vec");
const nativeDir = join(outdir, "native");
/** 只打包真正需要的平台目录；vendor 下的 README / 校验文件不进产物 */
const BUNDLED = ["win32-x64", "linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"];
await rm(nativeDir, { recursive: true, force: true });
if (existsSync(vendorDir)) {
  await cp(vendorDir, nativeDir, {
    recursive: true,
    filter: (src) => {
      const rel = relative(vendorDir, src).replace(/\\/g, "/");
      return rel === "" || BUNDLED.includes(rel.split("/")[0]);
    },
  });
  let bytes = 0;
  for (const dir of BUNDLED) {
    for (const name of ["vec0.dll", "vec0.so", "vec0.dylib"]) {
      const p = join(nativeDir, dir, name);
      if (existsSync(p)) bytes += (await stat(p)).size;
    }
  }
  console.log("[build] lib/native  " + (bytes / 1024).toFixed(1) + " KB (sqlite-vec)");
} else {
  console.warn("[build] warn: vendor/sqlite-vec 不存在，包内不带 sqlite-vec（退回 builtin）");
}

for (const name of ["index.js", "client.js"]) {
  const s = await stat(join(outdir, name));
  const kb = (s.size / 1024).toFixed(1);
  console.log("[build] lib/" + name + "  " + kb + " KB");
}

// 本地模型推理（transformers + onnxruntime）与 vectra 随包自带 → lib/vendor
// 来源是 vendor-bundle.mjs 里写死的版本（装进 .vendor-cache/），与任何 DSH profile 无关。
// lib/vendor/manifest.json 的版本对得上就复用；MEMWEAVE_VENDOR=0 跳过（只改代码时提速）。
const vendorOut = join(outdir, "vendor");
if (process.env.MEMWEAVE_VENDOR === "0") {
  console.log("[build] 跳过 lib/vendor（MEMWEAVE_VENDOR=0）");
} else {
  const manifest = join(vendorOut, "manifest.json");
  let fresh = false;
  if (existsSync(manifest)) {
    fresh = JSON.stringify(JSON.parse(await readFile(manifest, "utf8")).pinned) === JSON.stringify(VENDOR_PACKAGES);
  }
  if (!fresh) {
    const r = spawnSync(process.execPath, [join(root, "scripts", "vendor-bundle.mjs"), vendorOut], { stdio: "inherit" });
    if (r.status !== 0) {
      console.error("[build] lib/vendor 打包失败");
      process.exit(r.status ?? 1);
    }
  }
  let bytes = 0;
  let files = 0;
  for (const e of await readdir(vendorOut, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    files++;
    bytes += (await stat(join(e.parentPath ?? e.path, e.name))).size;
  }
  console.log("[build] lib/vendor  " + (bytes / 1024 / 1024).toFixed(1) + " MB (" + files + " files" + (fresh ? ", reused" : "") + ")");
}

console.log("[build] done");
