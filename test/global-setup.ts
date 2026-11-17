/**
 * 测试前一次性构建。
 *
 * bench 里的跑分器（locomo / longmemeval / eval-adapter）在 `lib/index.js`
 * 缺失时会各自调 build，多个用例并行时同时构建会互相覆盖产物，干净检出
 * 第一次跑测试会因此偶发失败。这里先串行构建一次，用例只读产物。
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export default function setup(): void {
  if (existsSync(join(root, "lib", "index.js"))) return;
  const r = spawnSync(process.execPath, [join(root, "scripts", "build.mjs")], {
    cwd: root,
    encoding: "utf8",
  });
  if (r.status !== 0) {
    throw new Error(`构建 lib/ 失败：\n${r.stdout ?? ""}\n${r.stderr ?? ""}`);
  }
}
