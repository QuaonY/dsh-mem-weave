/**
 * 随包自带依赖（lib/vendor/）的位置与加载优先级。
 * 构建过（lib/vendor 存在）时：vectra 与 transformers 都应从 lib/vendor 加载，而不是 node_modules。
 * 打包布局下 vendor 必须是 lib/index.js 的同级目录（曾错写成包根的 vendor/，装好后永远找不到）。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { bundledVendorDir } from "../src/store/vendor-path";
import { loadOptionalDep, resetOptionalDepCache } from "../src/store/vector-loader";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const libVendor = join(root, "lib", "vendor");
const built = existsSync(join(libVendor, "package.json"));

describe("lib/vendor 随包依赖", () => {
  it("源码运行时指向仓库的 lib/vendor（不是仓库根的 vendor/）", () => {
    const dir = bundledVendorDir();
    if (!built) return expect(dir).toBeNull();
    expect(dir).toBe(libVendor);
  });

  it("打包产物按 lib/index.js 同级目录找 vendor", () => {
    const lib = join(root, "lib", "index.js");
    if (!existsSync(lib)) return;
    const src = readFileSync(lib, "utf8");
    expect(src).toMatch(/\[join\d*\(here, "vendor"\)\]/);
  });

  it.runIf(built)("vectra 从 lib/vendor 加载", () => {
    resetOptionalDepCache();
    const r = loadOptionalDep("vectra");
    expect(r.available).toBe(true);
    const req = createRequire(import.meta.url) as unknown as { cache: Record<string, unknown> };
    expect(Object.keys(req.cache).some((k) => k.startsWith(join(libVendor, "node_modules", "vectra")))).toBe(true);
  });

  it.runIf(built)("清单列出固定版本与五个平台，GPU 文件不随包", () => {
    const m = JSON.parse(readFileSync(join(libVendor, "manifest.json"), "utf8")) as {
      pinned: Record<string, string>;
      platforms: string[];
      packages: { name: string; license: string }[];
    };
    expect(Object.keys(m.pinned).sort()).toEqual(["@huggingface/transformers", "vectra"]);
    expect(m.platforms).toEqual(["win32/x64", "win32/arm64", "linux/x64", "linux/arm64", "darwin/arm64"]);
    for (const p of m.packages) expect(p.license, p.name).not.toBe("UNKNOWN");
    for (const plat of m.platforms) {
      const d = join(libVendor, "node_modules", "onnxruntime-node", "bin", "napi-v6", ...plat.split("/"));
      expect(existsSync(join(d, "onnxruntime_binding.node")), plat).toBe(true);
      expect(existsSync(join(d, "DirectML.dll")), plat).toBe(false);
    }
    expect(existsSync(join(libVendor, "THIRD_PARTY_LICENSES.txt"))).toBe(true);
  });
});
