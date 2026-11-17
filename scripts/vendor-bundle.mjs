/**
 * 把本地模型推理（transformers + onnxruntime）与 vectra 打进 lib/vendor/，随插件包发布。
 * 来源：固定版本装进 .vendor-cache/（npm --ignore-scripts），不依赖任何 DSH profile 的状态。
 * 内容：
 * - transformers：只要 transformers.node.{mjs,cjs}，外加 tokenizers / jinja / onnxruntime-common
 * - onnxruntime-node：JS + 五平台原生库，去掉 GPU 加速文件（DirectML / dxcompiler / dxil）
 * - vectra：本体 + 全部运行时依赖（依赖保留嵌套的 node_modules，避免版本冲突的依赖被拍平）
 * - sharp：空壳。transformers 加载时检查它存在，文本 embedding 用不到
 * 每个包都保留许可证文件；另生成 THIRD_PARTY_LICENSES.txt 与 manifest.json（包名、版本、许可证）。
 * 用法：node scripts/vendor-bundle.mjs <输出目录>
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { VENDOR_PACKAGES } from "./vendor-pins.mjs";

const PLATFORMS = ["win32/x64", "win32/arm64", "linux/x64", "linux/arm64", "darwin/arm64"];
const GPU_ONLY = /^(DirectML\.dll|dxcompiler\.dll|dxil\.dll)$/;
const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\.|-|$)/i;

/** onnxruntime 的 npm 包不带许可证文件，这里补上原文（MIT，© Microsoft Corporation） */
const ONNXRUNTIME_LICENSE = `MIT License

Copyright (c) Microsoft Corporation

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cacheDir = path.join(root, ".vendor-cache");

function fail(msg) {
  console.error("[vendor] " + msg);
  process.exit(1);
}

/** 按固定版本装到 .vendor-cache；版本已对上就直接复用 */
function ensureCache() {
  const stamp = path.join(cacheDir, "vendor-versions.json");
  const want = JSON.stringify(VENDOR_PACKAGES);
  if (fs.existsSync(stamp) && fs.readFileSync(stamp, "utf8") === want) return path.join(cacheDir, "node_modules");
  console.log("[vendor] 安装固定版本到 .vendor-cache/ ...");
  fs.rmSync(cacheDir, { recursive: true, force: true });
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, "package.json"), JSON.stringify({ name: "memweave-vendor-cache", private: true }));
  const specs = Object.entries(VENDOR_PACKAGES).map(([n, v]) => n + "@" + v);
  // --ignore-scripts：onnxruntime-node 的 postinstall 只给 linux 下 CUDA 文件，CPU 推理不需要
  const args = ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--omit=optional", "--legacy-peer-deps", ...specs];
  // Windows 上 npm 是 .cmd，只能经 cmd.exe 启动；参数全是上面写死的包名与版本
  const r =
    process.platform === "win32"
      ? spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "npm", ...args], { cwd: cacheDir, stdio: "inherit" })
      : spawnSync("npm", args, { cwd: cacheDir, stdio: "inherit" });
  if (r.status !== 0) fail("npm install 失败（需要能访问 npm registry）");
  fs.writeFileSync(stamp, want);
  return path.join(cacheDir, "node_modules");
}

const outVendor = process.argv[2];
if (!outVendor) fail("用法: node scripts/vendor-bundle.mjs <输出目录>");

const srcNm = ensureCache();
fs.rmSync(outVendor, { recursive: true, force: true });
const vendorNm = path.join(outVendor, "node_modules");
fs.mkdirSync(vendorNm, { recursive: true });
fs.writeFileSync(path.join(outVendor, "package.json"), JSON.stringify({ name: "dsh-mem-weave-vendor", private: true }) + "\n");

/** 所有包都适用的过滤：去掉文档、类型、源码映射、测试与开发残留，保留许可证 */
function commonKeep(rel, name) {
  if (LICENSE_FILE.test(name)) return true;
  if (/\.(map|d\.ts|d\.mts|d\.cts|md|markdown)$/i.test(name)) return false;
  if (/\.(spec|test)\.[cm]?[jt]s$/i.test(name)) return false;
  const segs = rel.split("/");
  const banned = ["test", "tests", "__tests__", ".nyc_output", ".github", ".yarn", "runkit", "coverage", "docs", "example", "examples"];
  if (segs.some((s) => banned.includes(s))) return false;
  if (/^\.(nycrc|jsdoc|eslintrc|prettierrc|editorconfig|npmignore|travis)/.test(name)) return false;
  return true;
}

/** 不随包的依赖：onnxruntime-web 是浏览器版；sharp 只处理图像（换成空壳）；adm-zip / global-agent 只给安装脚本用 */
const SKIP_DEPS = {
  "@huggingface/transformers": ["onnxruntime-web", "sharp"],
  "onnxruntime-node": ["adm-zip", "global-agent"],
};

/** 个别包只留运行时用得到的部分 */
const KEEP = {
  // 只要 node 版入口
  "@huggingface/transformers": (rel, base, dir) =>
    dir ? rel === "dist" : rel === "package.json" || LICENSE_FILE.test(base) || /^dist\/transformers\.node\.(mjs|cjs)$/.test(rel),
  "onnxruntime-common": (rel) => !rel.startsWith("lib/"),
  // 五平台原生库，去 GPU 文件；macOS 带版本号的 dylib 是重复副本
  "onnxruntime-node": (rel, base, dir) => {
    if (rel.startsWith("lib/") || rel === "lib" || rel.startsWith("script")) return false;
    if (!rel.startsWith("bin")) return true;
    const parts = rel.split("/");
    if (parts.length <= 2) return true; // bin, bin/napi-v6
    if (parts.length === 3) return PLATFORMS.some((p) => p.startsWith(parts[2] + "/"));
    if (parts.length === 4) return PLATFORMS.includes(parts[2] + "/" + parts[3]);
    if (dir) return false;
    if (GPU_ONLY.test(base)) return false;
    if (parts[2] === "darwin" && /\.1\.\d+\.\d+\.dylib$/.test(base)) return false;
    return true;
  },
  vectra: (rel) => !rel.startsWith("src/") && rel !== "src",
  // 同一份词表有 cjs/esm/src/dist 四份，vectra 走 require，只留 cjs 与 data
  "gpt-tokenizer": (rel) => !/^(esm|src|dist)(\/|$)/.test(rel),
};

const readPkg = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));

/** 按 Node 的查找规则从 fromDir 往上找依赖，范围限定在 .vendor-cache 内 */
function resolvePkgDir(fromDir, name) {
  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    const cand = path.join(dir, "node_modules", name);
    if (fs.existsSync(path.join(cand, "package.json"))) return cand;
    if (path.resolve(dir) === path.resolve(cacheDir)) return null;
  }
}

/**
 * 收集要随包的包目录。保留 npm 装出来的目录结构（含嵌套的 node_modules）：
 * 版本冲突的依赖（如 htmlparser2 要 entities@7、parse5 要 entities@6）只存在于嵌套目录里
 * 拍平到一层会让 vectra 加载时拿到错的版本。
 */
const include = new Set();
function collect(pkgDir) {
  if (include.has(pkgDir)) return;
  include.add(pkgDir);
  const pkg = readPkg(pkgDir);
  const skip = SKIP_DEPS[pkg.name] ?? [];
  for (const [deps, required] of [[pkg.dependencies, true], [pkg.optionalDependencies, false]]) {
    for (const dep of Object.keys(deps ?? {})) {
      if (skip.includes(dep)) continue;
      const d = resolvePkgDir(pkgDir, dep);
      if (d) collect(d);
      else if (required) fail(pkg.name + " 的依赖 " + dep + " 不在 .vendor-cache（删掉 .vendor-cache 重试）");
    }
  }
}
for (const name of Object.keys(VENDOR_PACKAGES)) {
  const d = path.join(srcNm, name);
  if (!fs.existsSync(path.join(d, "package.json"))) fail("缺少包 " + name + "（.vendor-cache 不完整，删掉它重试）");
  collect(d);
}

// 1. 逐个拷贝（不带包自己的 node_modules，嵌套依赖在 include 里单独拷到对应位置）
const copied = [];
for (const from of [...include].sort()) {
  const pkg = readPkg(from);
  const dest = path.join(vendorNm, path.relative(srcNm, from));
  const extraKeep = KEEP[pkg.name] ?? (() => true);
  fs.cpSync(from, dest, {
    recursive: true,
    filter: (p) => {
      const rel = path.relative(from, p).replace(/\\/g, "/");
      if (rel === "") return true;
      if (rel.split("/").includes("node_modules")) return false;
      const base = path.basename(p);
      return commonKeep(rel, base) && extraKeep(rel, base, fs.statSync(p).isDirectory());
    },
  });
  const license = typeof pkg.license === "string" ? pkg.license : pkg.license?.type ?? "UNKNOWN";
  copied.push({ name: pkg.name, version: pkg.version, license, dir: dest });
}
for (const p of copied) if (p.name.startsWith("onnxruntime")) fs.writeFileSync(path.join(p.dir, "LICENSE"), ONNXRUNTIME_LICENSE);

// 4. sharp 空壳
const sharpDir = path.join(vendorNm, "sharp");
fs.mkdirSync(sharpDir, { recursive: true });
fs.writeFileSync(path.join(sharpDir, "package.json"), JSON.stringify({ name: "sharp", version: "0.0.0-memweave-stub", main: "index.js", type: "commonjs" }) + "\n");
fs.writeFileSync(
  path.join(sharpDir, "index.js"),
  'module.exports = function sharp() { throw new Error("image processing is not bundled with MemWeave"); };\n',
);

// 5. 许可证汇总与清单
const missing = [];
const parts = [];
for (const p of copied.sort((a, b) => a.name.localeCompare(b.name))) {
  const lic = fs.readdirSync(p.dir).find((f) => LICENSE_FILE.test(f));
  if (!lic) {
    missing.push(p.name);
    continue;
  }
  parts.push("=".repeat(78) + "\n" + p.name + "@" + p.version + " (" + p.license + ")\n" + "=".repeat(78) + "\n\n" + fs.readFileSync(path.join(p.dir, lic), "utf8").trim() + "\n");
}
fs.writeFileSync(
  path.join(outVendor, "THIRD_PARTY_LICENSES.txt"),
  "Third-party software bundled in lib/vendor/ of dsh-mem-weave.\n\n" + parts.join("\n"),
);
fs.writeFileSync(
  path.join(outVendor, "manifest.json"),
  JSON.stringify({ pinned: VENDOR_PACKAGES, platforms: PLATFORMS, packages: copied.map(({ name, version, license }) => ({ name, version, license })) }, null, 2) + "\n",
);

console.log("[vendor] " + copied.length + " 个包 → " + outVendor);
if (missing.length) {
  // 没有单独许可证文件的包：许可证写在 package.json 里，汇总时补一行声明
  fs.appendFileSync(
    path.join(outVendor, "THIRD_PARTY_LICENSES.txt"),
    "\n" + "=".repeat(78) + "\nPackages without a separate license file (license as declared in package.json):\n" +
      missing.map((n) => { const p = copied.find((c) => c.name === n); return "  " + n + "@" + p.version + " (" + p.license + ")"; }).join("\n") + "\n",
  );
  console.log("[vendor] 无单独许可证文件（已按 package.json 声明列出）: " + missing.join(", "));
}
