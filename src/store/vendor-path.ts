/**
 * 随包自带依赖（lib/vendor/）的位置。
 * 打包后本模块在 lib/index.js 里，vendor 是同级的 lib/vendor；
 * 源码运行（测试）时本模块在 src/store/，vendor 在仓库的 lib/vendor（构建过才有）。
 * 以目录里有 package.json 为准，避免误认仓库根的 vendor/（那里放的是 sqlite-vec 源文件）。
 */
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let cached: string | null | undefined;

export function bundledVendorDir(): string | null {
  if (cached !== undefined) return cached;
  const here = dirname(fileURLToPath(import.meta.url));
  // 打包产物只认包内的 lib/vendor；源码目录（src/store）才去仓库的 lib/vendor 找
  const candidates = basename(here) === "store" ? [join(here, "..", "..", "lib", "vendor")] : [join(here, "vendor")];
  cached = candidates.find((d) => existsSync(join(d, "package.json"))) ?? null;
  return cached;
}
