/**
 * 忆织 MemWeave —— 三段注入逐字预览 + hash
 * 默认在临时目录建出厂态空库预览（零行为改变自检：三段全空）。
 * `--data <dir>` 可对真实数据目录做逐字预览。
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const libEntry = join(root, "lib", "index.js");
if (!existsSync(libEntry)) {
  const r = spawnSync(process.execPath, [join(root, "scripts", "build.mjs")], { stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
const { openService } = await import(pathToFileURL(libEntry).href);

const argv = process.argv.slice(2);
const dataArgIdx = argv.indexOf("--data");
let dir;
if (dataArgIdx >= 0 && argv[dataArgIdx + 1]) {
  dir = argv[dataArgIdx + 1];
} else {
  dir = await mkdtemp(join(tmpdir(), "memweave-preview-"));
}

const { env, service } = openService(dir);
try {
  const r = service.preview();
  const bar = "=".repeat(64);
  console.log(bar);
  console.log("[S1 persona-prefix] " + r.s1.prefix.length + " 字符");
  console.log(bar);
  console.log(r.s1.prefix || "（空）");
  console.log(bar);
  console.log("[S1 thinking-language] " + r.s1.thinking.length + " 字符");
  console.log(bar);
  console.log(r.s1.thinking || "（空）");
  console.log(bar);
  console.log("[S1 persona-suffix] " + r.s1.suffix.length + " 字符");
  console.log(bar);
  console.log(r.s1.suffix || "（空）");
  console.log(bar);
  console.log("[S2 snapshot] " + r.s2.length + " 字符");
  console.log(bar);
  console.log(r.s2 || "（空）");
  console.log(bar);
  console.log("[S3 delta/recall/quote] " + r.s3.length + " 字符");
  console.log(bar);
  console.log(r.s3 || "（空，零注入）");
  console.log(bar);
  console.log("hash: " + r.hash);
  if (r.warn.length > 0) for (const w of r.warn) console.log("warn: " + w);
  const empty = !r.s1.prefix && !r.s1.thinking && !r.s1.suffix && !r.s2 && !r.s3;
  console.log("三段状态: " + (empty ? "全部为空（零行为改变）" : "非空"));
} finally {
  env.close();
}
