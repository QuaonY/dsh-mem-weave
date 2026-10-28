/**
 * 忆织 MemWeave —— CLI 运维入口（零依赖）
 *   node scripts/weave.mjs status
 *   node scripts/weave.mjs render
 *   node scripts/weave.mjs persona show | diff [version] | restore <version>
 *   node scripts/weave.mjs reset            # 必须手输 RESET + 强制备份
 * lib/ 不存在时先自动 build。
 */
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const libEntry = join(root, "lib", "index.js");

if (!existsSync(libEntry)) {
  console.log("[weave] lib/index.js 不存在，先执行 build ...");
  const r = spawnSync(process.execPath, [join(root, "scripts", "build.mjs")], { stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const mod = await import(pathToFileURL(libEntry).href);
const { openService } = mod;

function dataDir() {
  const argIdx = process.argv.indexOf("--data");
  if (argIdx >= 0 && process.argv[argIdx + 1]) return process.argv[argIdx + 1];
  if (process.env.MEMWEAVE_DATA) return process.env.MEMWEAVE_DATA;
  const home = process.env.DSH_HOME || join(homedir(), ".dsh");
  return join(home, "memweave");
}

function parseArgs(argv) {
  return argv.filter((a) => a !== "--data" && !a.startsWith("--data="));
}

function fmtBytes(n) {
  return (n / 1024).toFixed(1) + " KB";
}

const args = parseArgs(process.argv.slice(2));
const cmd = args[0] ?? "status";

let opened;
try {
  opened = openService(dataDir());
} catch (e) {
  // §10.2 E_DB：绝不裸崩；跨进程场景宿主持锁时给出明确指引（§5.6）
  console.error("[weave] 记忆库暂不可用（E_DB）：", e.message ?? e);
  console.error(
    "[weave] 若 DSH 宿主正在运行且持有 memweave.db，请先退出宿主再执行写操作；" +
      "读操作可在宿主空闲时重试。也可用 --data <dir> 指向其他数据目录。",
  );
  process.exit(1);
}
const { env, service } = opened;

try {
  if (cmd === "status") {
    const s = service.status();
    console.log("忆织 MemWeave —— 状态");
    console.log("  数据目录   :", s.dataDir);
    console.log("  库文件     :", s.dbFile, s.readonly ? "（只读降级）" : "");
    console.log("  schema     :", s.schemaVersion, " 人格版本:", s.personaVersion);
    console.log("  七层条数   :", JSON.stringify(s.counts), " 共", s.total, "条");
    console.log("  待裁决     :", s.candidatesPending, " 开放冲突:", s.conflictsOpen);
    console.log("  strict     :", s.strict, service.paused ? "  已暂停:" + service.pauseReason : "");
    const r = service.preview();
    const total = r.segments.reduce((a, seg) => a + seg.chars, 0);
    console.log("  注入体积   :", fmtBytes(total), "(hash " + r.hash + ")");
    for (const seg of r.segments) console.log("    -", seg.name, seg.chars, "字符", seg.items, "条");
  } else if (cmd === "render") {
    const r = service.preview(args[1]);
    console.log("== S1 人格段 ==");
    console.log(r.s1.prefix);
    if (r.s1.thinking) console.log("\n== 思考语言段 ==\n" + r.s1.thinking);
    if (r.s1.suffix) console.log("\n== 后缀段 ==\n" + r.s1.suffix);
    console.log("\n== S2 快照 ==\n" + (r.s2 || "（空）"));
    console.log("\n== S3 增量/召回 ==\n" + (r.s3 || "（空，零注入）"));
    console.log("\nhash:", r.hash);
    for (const w of r.warn) console.log("warn:", w);
  } else if (cmd === "persona") {
    const sub = args[1] ?? "show";
    const cur = service.persona();
    if (sub === "show") {
      console.log("persona v" + cur.version, "updatedBy", cur.updatedBy ?? "-", "at", cur.updatedAt);
      console.log(JSON.stringify(cur.config, null, 2));
    } else if (sub === "diff") {
      const target = Number(args[2]);
      const rows = env.db
        .prepare("SELECT version, config, created_at, created_by FROM persona_history ORDER BY version DESC")
        .all();
      if (!Number.isFinite(target)) {
        console.log("历史版本：");
        for (const row of rows) console.log("  v" + row.version, new Date(Number(row.created_at)).toISOString(), row.created_by ?? "-");
        console.log("（用法：persona diff <version> 对比当前配置）");
      } else {
        const row = rows.find((r) => Number(r.version) === target);
        if (!row) {
          console.error("version not found:", target);
          process.exitCode = 1;
        } else {
          const oldCfg = JSON.parse(String(row.config));
          const nowCfg = cur.config;
          const keys = [...new Set([...Object.keys(oldCfg), ...Object.keys(nowCfg)])].sort();
          let changed = 0;
          for (const k of keys) {
            const a = JSON.stringify(oldCfg[k]);
            const b = JSON.stringify(nowCfg[k]);
            if (a !== b) {
              changed += 1;
              console.log("~ " + k);
              console.log("    v" + target + ": " + (a ?? "undefined"));
              console.log("    当前 : " + (b ?? "undefined"));
            }
          }
          if (changed === 0) console.log("v" + target + " 与当前配置无差异");
        }
      }
    } else if (sub === "restore") {
      const target = Number(args[2]);
      const row = env.db
        .prepare("SELECT config FROM persona_history WHERE version = ?")
        .get(target);
      if (!row) {
        console.error("version not found:", target);
        process.exitCode = 1;
      } else {
        const out = service.updatePersona(JSON.parse(String(row.config)), "cli", cur.version);
        console.log(out.ok ? "已恢复到 v" + target + "（新版本 v" + out.version + "）" : "恢复失败：" + (out.code ?? ""));
        if (!out.ok) process.exitCode = 1;
      }
    } else {
      console.error("未知子命令:", sub);
      process.exitCode = 1;
    }
  } else if (cmd === "reset") {
    // 危险操作：必须手输 RESET + 强制备份（§14）
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const typed = await rl.question("彻底重置将清空全部记忆/人格/审计，且不可撤销。\n请输入确认词 RESET: ");
    rl.close();
    if (typed.trim() !== "RESET") {
      console.error("确认词不匹配，已取消。");
      process.exitCode = 1;
    } else {
      const bak = service.backupNow("reset");
      console.log("已强制备份:", bak);
      const out = await service.resetAll("cli");
      console.log("重置完成", JSON.stringify(out));
    }
  } else {
    console.error("用法: node scripts/weave.mjs status|render|persona show|diff [v]|restore <v>|reset [--data <dir>]");
    process.exitCode = 1;
  }
} catch (e) {
  // §10.2 E_DB：库被占用/损坏时结构化降级，绝不裸崩
  if (e && (e.code === "ERR_SQLITE_ERROR" || String(e.message ?? e).includes("disk I/O"))) {
    console.error("[weave] 记忆库暂不可用（E_DB）：", e.message ?? e);
    console.error(
      "[weave] 若 DSH 宿主正在运行且持有 memweave.db，请先退出宿主再执行写操作；" +
        "读操作可在宿主空闲时重试。也可用 --data <dir> 指向其他数据目录。",
    );
    process.exitCode = 1;
  } else {
    throw e;
  }
} finally {
  env.close();
}
