/**
 * 忆织 MemWeave —— 构建脚本（零运行时依赖，仅 devDep esbuild）
 * host  -> lib/index.js  （platform node，external node:*，esm）
 * client-> lib/client.js （platform browser，cjs，包 __ModuleLoader__ 工厂；react 经宿主模块表注入）
 * N5：产物 <2MB（构建后打印体积自查）
 */
import { build } from "esbuild";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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
  external: ["node:*", "@deepseek-ai/dsh-typert-protocol"],
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

const MAX_BYTES = 2 * 1024 * 1024; // N5 ≤2MB
for (const name of ["index.js", "client.js"]) {
  const s = await stat(join(outdir, name));
  const kb = (s.size / 1024).toFixed(1);
  const flag = s.size > MAX_BYTES ? "  !! 超出 N5 预算（<2MB）" : "";
  console.log("[build] lib/" + name + "  " + kb + " KB" + flag);
}

console.log("[build] done");
