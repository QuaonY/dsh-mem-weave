/**
 * 检索基准护栏（pnpm bench:guard）。
 * 跑两份全量外部基准，与 test/bench/guard-baseline.json 比对：
 *   - LongMemEval-S 470 题（会话粒度）      → recall_any / recall_all / ndcg @5、@10
 *   - LoCoMo 1,982 题（轮粒度）             → recall_any / recall_all / recall_mean / ndcg / ans_in_ctx @5、@10
 * 任一指标比基线低超过 1 个百分点（默认容差）→ 退出码 1。
 * 退出码约定：0 通过（或数据集缺失被跳过）；1 指标回归；2 配置 / 运行错误。
 * 数据集不随仓库分发，路径可用 --lme-data / --locomo-data 或环境变量
 * MEMWEAVE_LME_DATA / MEMWEAVE_LOCOMO_DATA 指定；缺失时默认跳过
 * 加 --require-all 则当作配置错误（CI 用）。
 * 用法：
 *   node test/bench/guard.mjs                       # 跑全量并与基线比对
 *   node test/bench/guard.mjs --require-all         # 缺数据集直接失败
 *   node test/bench/guard.mjs --update              # 用本次结果重写基线
 *   node test/bench/guard.mjs --lme-report a.json --locomo-report b.json   # 复用已有报告，不重跑
 *   node test/bench/guard.mjs --tolerance 2         # 容差改成 2 个百分点
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const DEFAULT_BASELINE = join(HERE, "guard-baseline.json");

/** 默认容差：1 个百分点（用小数表示，便于与报告里的 0–1 指标直接相减） */
export const DEFAULT_TOLERANCE = 0.01;

/** 数据集默认位置与题数（题数用于拦截子集跑分） */
export const DATASETS = {
  lme: {
    label: "LongMemEval-S",
    script: join(HERE, "longmemeval.mjs"),
    defaultData: join(ROOT, "data", "longmemeval_s_cleaned.json"),
    env: "MEMWEAVE_LME_DATA",
    count: 470,
  },
  locomo: {
    label: "LoCoMo",
    script: join(HERE, "locomo.mjs"),
    defaultData: join(ROOT, "data", "locomo10.json"),
    env: "MEMWEAVE_LOCOMO_DATA",
    count: 1982,
  },
};

const KIND_LABEL = { lme: "LongMemEval-S 470 题（会话粒度）", locomo: "LoCoMo 1,982 题（轮粒度）" };

/* ------------------------------------------------------------------ */
/* 纯函数：抽指标 / 比对 / 题数校验                                      */
/* ------------------------------------------------------------------ */

/** 从报告 JSON 里抽出纳入护栏的指标，键形如 lme.session.k5.recall_any */
export function extractMetrics(report, kind) {
  const out = {};
  const ks = Array.isArray(report?.ks) && report.ks.length > 0 ? report.ks : [5, 10];
  if (kind === "lme") {
    for (const k of ks) {
      const m = report?.overall?.session?.byK?.[`k${k}`];
      if (!m) continue;
      out[`lme.session.k${k}.recall_any`] = m.recallAny;
      out[`lme.session.k${k}.recall_all`] = m.recallAll;
      out[`lme.session.k${k}.ndcg`] = m.ndcgAny;
    }
  } else if (kind === "locomo") {
    for (const k of ks) {
      const m = report?.overall?.byK?.[`k${k}`];
      if (!m) continue;
      out[`locomo.turn.k${k}.recall_any`] = m.recallAny;
      out[`locomo.turn.k${k}.recall_all`] = m.recallAll;
      out[`locomo.turn.k${k}.recall_mean`] = m.recallMean;
      out[`locomo.turn.k${k}.ndcg`] = m.ndcgAny;
      out[`locomo.turn.k${k}.ans_in_ctx`] = m.answerInContext;
    }
  }
  for (const [name, v] of Object.entries(out)) {
    if (typeof v !== "number" || !Number.isFinite(v)) delete out[name];
  }
  return out;
}

/** 报告里的题目数（用于确认不是子集） */
export function extractCounts(report, kind) {
  if (kind === "lme") return typeof report?.evaluated === "number" ? report.evaluated : null;
  if (kind === "locomo") return typeof report?.questions === "number" ? report.questions : null;
  return null;
}

/**
 * 逐项比对。只有「比基线低超过 tolerance」才算回归；持平或更好都通过。
 * 基线里有、本次报告里没有的指标按回归处理（口径消失同样危险）。
 */
export function compareMetrics(baseline, current, tolerance = DEFAULT_TOLERANCE) {
  const rows = [];
  const failures = [];
  for (const [name, base] of Object.entries(baseline ?? {})) {
    const cur = current?.[name];
    if (typeof cur !== "number" || !Number.isFinite(cur)) {
      failures.push({ name, baseline: base, current: null, drop: null, reason: "missing" });
      continue;
    }
    const drop = base - cur;
    rows.push({ name, baseline: base, current: cur, drop });
    if (drop > tolerance + 1e-9) {
      failures.push({ name, baseline: base, current: cur, drop, reason: "regression" });
    }
  }
  return { rows, failures, tolerance };
}

/** 题数必须与基线一致，否则是子集跑分，结果不能与全量比 */
export function checkCounts(expected, actual) {
  const errors = [];
  for (const [kind, want] of Object.entries(expected ?? {})) {
    const got = actual?.[kind];
    if (typeof got !== "number") {
      errors.push(`${kind}: 报告缺少题目数，无法确认是全量`);
    } else if (got !== want) {
      errors.push(`${kind}: 题目数 ${got} ≠ 基线 ${want}（子集跑分不能与全量比较）`);
    }
  }
  return errors;
}

/** 判断指标属于哪个基准（用于「只跑了一个也能比」） */
function kindOf(name) {
  return name.startsWith("locomo.") ? "locomo" : "lme";
}

/* ------------------------------------------------------------------ */
/* CLI                                                               */
/* ------------------------------------------------------------------ */

const USAGE = `用法：node test/bench/guard.mjs [选项]

  --lme-data <file>        LongMemEval-S 数据（默认 data/longmemeval_s_cleaned.json）
  --locomo-data <file>     LoCoMo 数据（默认 data/locomo10.json）
  --lme-report <file>      复用已有的 LME 报告，不重跑
  --locomo-report <file>   复用已有的 LoCoMo 报告，不重跑
  --baseline <file>        基线（默认 test/bench/guard-baseline.json）
  --tolerance <points>     容差，单位「个百分点」，默认 1
  --update                 用本次结果重写基线
  --note <text>            写入基线的口径说明（与 --update 一起用）
  --require-all            数据集缺失视为错误（CI 用）
  --skip-lme / --skip-locomo
  --quiet                  只输出结论
  --help
`;

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      out._.push(a);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    const takesValue = next !== undefined && !next.startsWith("--");
    switch (key) {
      case "update":
      case "require-all":
      case "skip-lme":
      case "skip-locomo":
      case "quiet":
      case "help":
        out[key] = true;
        break;
      case "lme-data":
      case "locomo-data":
      case "lme-report":
      case "locomo-report":
      case "baseline":
      case "tolerance":
      case "note":
        if (!takesValue) fail(`参数 --${key} 缺少值`);
        out[key] = next;
        i += 1;
        break;
      default:
        fail(`未知参数 --${key}`);
    }
  }
  return out;
}

function fail(message) {
  console.error(`[guard] ${message}`);
  console.error(USAGE);
  process.exit(2);
}

const pct = (v) => (typeof v === "number" ? (v * 100).toFixed(1) + "%" : "-");
const signed = (v) => (v > 0 ? "+" : "") + (v * 100).toFixed(2);

function readJson(file, label) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    fail(`${label} 读取失败（${file}）：${e?.message ?? e}`);
  }
}

function runBench(kind, data, reportFile, quiet) {
  const def = DATASETS[kind];
  const dbDir = mkdtempSync(join(tmpdir(), `memweave-guard-${kind}-`));
  mkdirSync(dirname(reportFile), { recursive: true });
  try {
    if (!quiet) console.log(`[guard] ${KIND_LABEL[kind]} 运行中…`);
    const started = Date.now();
    const r = spawnSync(
      process.execPath,
      [def.script, "run", "--data", data, "--report", reportFile, "--db", dbDir, ...(quiet ? ["--quiet"] : [])],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    const sec = Math.round((Date.now() - started) / 1000);
    if (r.status !== 0) {
      if (!quiet) {
        if (r.stdout) process.stdout.write(r.stdout);
        if (r.stderr) process.stderr.write(r.stderr);
      }
      fail(`${def.label} 运行失败（退出码 ${r.status}），用时 ${sec}s`);
    }
    if (!quiet) console.log(`[guard] ${def.label} 完成，用时 ${sec}s`);
  } finally {
    rmSync(dbDir, { recursive: true, force: true });
  }
}

function gitCommit() {
  const r = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

function packageVersion() {
  try {
    return JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version ?? null;
  } catch {
    return null;
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }

  const tolerance = opts.tolerance !== undefined ? Number(opts.tolerance) / 100 : DEFAULT_TOLERANCE;
  if (!Number.isFinite(tolerance) || tolerance < 0) fail("--tolerance 必须是非负数字（单位：个百分点）");

  const baselinePath = opts.baseline ? resolve(opts.baseline) : DEFAULT_BASELINE;
  const baseline = existsSync(baselinePath) ? readJson(baselinePath, "基线") : null;
  if (!baseline && !opts.update) fail(`基线不存在：${baselinePath}（首次请用 --update 生成）`);

  const kinds = ["lme", "locomo"].filter((k) => !opts[`skip-${k}`]);
  const reports = {};
  const counts = {};
  const skipped = [];

  for (const kind of kinds) {
    const def = DATASETS[kind];
    const reportFile = opts[`${kind}-report`] ? resolve(opts[`${kind}-report`]) : join(tmpdir(), `memweave-guard-${process.pid}-${kind}.json`);
    if (opts[`${kind}-report`]) {
      if (!existsSync(reportFile)) fail(`${def.label} 报告不存在：${reportFile}`);
      if (!opts.quiet) console.log(`[guard] ${def.label} 复用报告 ${reportFile}`);
    } else {
      const envData = process.env[def.env];
      const data = resolve(opts[`${kind}-data`] ?? (envData && envData.trim() ? envData : def.defaultData));
      if (!existsSync(data)) {
        const msg = `数据集缺失：${data}`;
        if (opts["require-all"]) fail(`${def.label} ${msg}；去掉 --require-all 可跳过`);
        skipped.push(`${def.label}（${msg}）`);
        if (!opts.quiet) console.log(`[guard] 跳过 ${def.label}：${msg}`);
        continue;
      }
      runBench(kind, data, reportFile, opts.quiet);
    }
    const report = readJson(reportFile, `${def.label} 报告`);
    reports[kind] = extractMetrics(report, kind);
    counts[kind] = extractCounts(report, kind);
    if (!opts[`${kind}-report`]) rmSync(reportFile, { force: true });
  }

  if (kinds.length > 0 && Object.keys(reports).length === 0) {
    console.log(`[guard] 没有可用的基准报告；跳过的：${skipped.join("；")}`);
    return 0;
  }

  // 题数校验：只与基线里记录过的、本次确实跑了的基准比
  const expectedCounts = {};
  for (const kind of Object.keys(reports)) {
    if (baseline?.counts?.[kind] !== undefined) expectedCounts[kind] = baseline.counts[kind];
  }
  const countErrors = checkCounts(expectedCounts, counts);
  if (countErrors.length > 0) {
    for (const e of countErrors) console.error(`[guard] ${e}`);
    return 2;
  }

  const current = {};
  for (const [kind, metrics] of Object.entries(reports)) Object.assign(current, metrics);

  if (opts.update) {
    const mergedMetrics = { ...(baseline?.metrics ?? {}) };
    for (const name of Object.keys(mergedMetrics)) {
      if (!(kindOf(name) in reports)) continue;
      if (!(name in current)) delete mergedMetrics[name];
    }
    Object.assign(mergedMetrics, current);
    const mergedCounts = { ...(baseline?.counts ?? {}) };
    for (const [kind, n] of Object.entries(counts)) if (typeof n === "number") mergedCounts[kind] = n;
    const next = {
      version: packageVersion(),
      commit: gitCommit(),
      recordedAt: new Date().toISOString().slice(0, 10),
      tolerance: baseline?.tolerance ?? DEFAULT_TOLERANCE,
      note: opts.note ?? baseline?.note ?? "由 test/bench/guard.mjs --update 生成；数值为小数（0.962 = 96.2%）。",
      counts: mergedCounts,
      metrics: mergedMetrics,
    };
    writeFileSync(baselinePath, JSON.stringify(next, null, 2) + "\n");
    console.log(`[guard] 基线已更新：${baselinePath}（${Object.keys(mergedMetrics).length} 项指标）`);
    return 0;
  }

  // 只比对本次跑过的基准对应的指标
  const baseMetrics = {};
  for (const [name, v] of Object.entries(baseline.metrics ?? {})) {
    if (kindOf(name) in reports) baseMetrics[name] = v;
  }
  const { rows, failures } = compareMetrics(baseMetrics, current, tolerance);

  if (!opts.quiet) {
    console.log(`[guard] 基线：${baselinePath}`);
    console.log(`[guard] 容差：${(tolerance * 100).toFixed(1)} 个百分点（下降超过才失败）`);
    console.log("[guard] 指标                                基线     本次     差（点）");
    for (const row of rows) {
      console.log(
        `[guard] ${row.name.padEnd(34)} ${pct(row.baseline).padStart(7)} ${pct(row.current).padStart(7)} ${
          row.drop > 0 ? "-" : row.drop < 0 ? "+" : " "
        }${Math.abs(row.drop * 100).toFixed(2)}`,
      );
    }
  }

  if (failures.length > 0) {
    console.error(`[guard] 失败 ${failures.length} 项（容差 ${(tolerance * 100).toFixed(1)} 点）：`);
    for (const f of failures) {
      if (f.reason === "missing") {
        console.error(`[guard]   ${f.name}：基线 ${pct(f.baseline)}，本次报告缺少该指标`);
      } else {
        console.error(
          `[guard]   ${f.name}：${pct(f.baseline)} → ${pct(f.current)}（${signed(-f.drop)} 点）`,
        );
      }
    }
    return 1;
  }

  console.log(`[guard] 通过：${rows.length} 项指标无一跌破 ${(tolerance * 100).toFixed(1)} 点。`);
  if (skipped.length > 0) console.log(`[guard] 已跳过：${skipped.join("；")}`);
  return 0;
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  // 内部会 process.exit；正常路径返回退出码
  const code = await main();
  process.exit(code);
}
