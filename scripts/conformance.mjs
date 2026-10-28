/**
 * 忆织 MemWeave —— 一致性自检（§6.5 / §15 机器判据）
 *   node scripts/conformance.mjs --assert-empty
 * ① conformance/empty：出厂状态（空 persona / 空记忆）下 S1/S2/S3 三段全为空字符串，
 *    且注入消息数为 0；
 * ② conformance/persona-order：S1 九块保序（前缀内索引严格递增）、缺块不留空行。
 * 失败退出码 1。
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

const args = process.argv.slice(2);
if (!args.includes("--assert-empty")) {
  console.error("用法: node scripts/conformance.mjs --assert-empty");
  process.exit(1);
}

const dir = await mkdtemp(join(tmpdir(), "memweave-conformance-"));
const { env, service } = openService(dir);

const failures = [];
try {
  const r = service.preview();
  const seg = {
    "S1 persona-prefix": r.s1.prefix,
    "S1 thinking-language": r.s1.thinking,
    "S1 persona-suffix": r.s1.suffix,
    "S2 snapshot": r.s2,
    "S3 delta/recall/quote": r.s3,
  };
  for (const [name, text] of Object.entries(seg)) {
    const ok = typeof text === "string" && text.length === 0;
    console.log((ok ? "PASS" : "FAIL") + "  " + name + " 为空");
    if (!ok) failures.push(name + " 非空: " + JSON.stringify(String(text).slice(0, 80)));
  }

  // 会话消息数：每一段非空文本 = 一条注入消息；出厂态必须为 0
  const messages = r.segments.filter((s) => s.text.length > 0);
  console.log((messages.length === 0 ? "PASS" : "FAIL") + "  会话消息数 = " + messages.length);
  if (messages.length !== 0) failures.push("会话消息数 = " + messages.length);

  // 七层表应为空、无候选、无冲突
  const counts = service.status();
  console.log((counts.total === 0 ? "PASS" : "FAIL") + "  七层条目数 = " + counts.total);
  if (counts.total !== 0) failures.push("七层条目数 = " + counts.total);

  // ---------- conformance/persona-order：S1 九块保序、缺块不留空行（§6.1） ----------
  const full = {
    stance: "立场块文本",
    character: "性格块文本",
    appearance: {
      enabled: true,
      text: "形象文本",
      byModel: {},
      cards: [
        { id: "self-1", who: "self", title: "本体", brief: "本体简介", detail: "本体详情", media: [], auto: false, expand: "brief", on: true },
        { id: "full-1", who: "other", title: "全量卡", brief: "全量简介", detail: "全量详情", media: [], auto: false, expand: "full", on: true },
        { id: "idx-1", who: "user", title: "目录卡", brief: "目录简介", detail: "目录详情", media: [], auto: false, expand: "brief", on: true },
      ],
      index: true,
    },
    tone: { enabled: true, text: "语气文本", byModel: {} },
    contracts: [{ id: "c1", text: "契约文本", on: true }],
    thinkingLanguage: "中文",
    meta: { relation: { stage: "熟识", trust: 0 }, mood: { baseline: "", bias: "" }, taboos: [], lexicon: {} },
  };
  service.updatePersona(full, "human");
  const s1 = service.renderPersona();
  const orderOk =
    s1.blocks.length === 9 &&
    s1.blocks.every((b, i) => s1.prefix.indexOf(b) === (i === 0 ? 0 : s1.prefix.indexOf(s1.blocks[i - 1]) + s1.blocks[i - 1].length + 2));
  console.log((s1.blocks.length === 9 ? "PASS" : "FAIL") + "  九块齐全 blocks = " + s1.blocks.length);
  if (s1.blocks.length !== 9) failures.push("九块缺失: blocks = " + s1.blocks.length);
  console.log((orderOk ? "PASS" : "FAIL") + "  九块保序（拼接顺序 = 前缀顺序）");
  if (!orderOk) failures.push("九块顺序被打乱或拼接不一致");
  const noGap = !s1.prefix.includes("\n\n\n") && s1.prefix === s1.blocks.join("\n\n");
  console.log((noGap ? "PASS" : "FAIL") + "  缺块不留空行");
  if (!noGap) failures.push("前缀出现空行或与块拼接不一致");

  // 缺块场景：只剩立场 + 恒定块，仍不留空行
  service.updatePersona(
    { ...full, character: "", appearance: { enabled: false, text: "", byModel: {}, cards: [], index: true }, tone: { enabled: false, text: "", byModel: {} }, contracts: [], thinkingLanguage: "off" },
    "human",
  );
  const s1b = service.renderPersona();
  const partialOk =
    s1b.blocks.length === 3 && s1b.prefix === s1b.blocks.join("\n\n") && !s1b.prefix.includes("\n\n\n");
  console.log((partialOk ? "PASS" : "FAIL") + "  部分缺块时保序且不留空行");
  if (!partialOk) failures.push("缺块场景渲染不合规: blocks = " + s1b.blocks.length);
} finally {
  env.close();
}

if (failures.length > 0) {
  console.error("\nconformance/empty 未通过：");
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log("\n三段均为空 + 会话消息数为 0 —— conformance/empty 通过。");
