/**
 * roadmap v0.3 G8：文件日志按天 + 按大小切分、保留 7 天、不记正文。
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { FileLogger, dayStamp } from "../src/host/logger";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "memweave-log-"));
  dirs.push(d);
  return d;
}

describe("G8 文件日志", () => {
  it("超过单文件上限 → 同日拆成 -1 后缀", () => {
    const dir = tmp();
    const log = new FileLogger({ dir, maxFileMb: 0.05 }); // 约 52KB 便于测试
    const chunk = "x".repeat(1000);
    for (let i = 0; i < 80; i += 1) log.warn("line " + i + " " + chunk);
    const files = readdirSync(dir).sort();
    const day = dayStamp(Date.now());
    expect(files).toContain("memweave-" + day + ".log");
    expect(files).toContain("memweave-" + day + "-1.log");
  });

  it("8 天后启动 → 7 天前的文件被删除，近期文件保留", () => {
    const dir = tmp();
    const now = Date.now();
    const old = dayStamp(now - 8 * 86400000);
    const recent = dayStamp(now - 2 * 86400000);
    writeFileSync(join(dir, "memweave-" + old + ".log"), "old\n");
    writeFileSync(join(dir, "memweave-" + old + "-1.log"), "old\n");
    writeFileSync(join(dir, "memweave-" + recent + ".log"), "recent\n");
    writeFileSync(join(dir, "unrelated.txt"), "keep\n");
    new FileLogger({ dir, keepDays: 7, now: () => now });
    const files = readdirSync(dir).sort();
    expect(files).not.toContain("memweave-" + old + ".log");
    expect(files).not.toContain("memweave-" + old + "-1.log");
    expect(files).toContain("memweave-" + recent + ".log");
    expect(files).toContain("unrelated.txt");
  });

  it("参数里的 content 只记长度，不记正文", () => {
    const dir = tmp();
    const log = new FileLogger({ dir });
    log.warn("write failed", { id: "m1", content: "老大的秘密小名叫小胖", reason: "E_DB" });
    const text = readFileSync(join(dir, readdirSync(dir)[0]), "utf8");
    expect(text).not.toContain("秘密小名");
    expect(text).toContain("content=<10 chars>");
    expect(text).toContain("[memweave][warn] write failed");
    expect(text).toContain("id=m1");
  });

  it("低于级别的不写", () => {
    const dir = tmp();
    const log = new FileLogger({ dir, level: "warn" });
    log.info("不该出现");
    log.debug("也不该出现");
    expect(readdirSync(dir)).toHaveLength(0);
    log.error("该出现");
    expect(readFileSync(join(dir, readdirSync(dir)[0]), "utf8")).toContain("该出现");
  });

  it("目录不可用时不抛错（I8）", () => {
    const dir = tmp();
    const file = join(dir, "not-a-dir");
    writeFileSync(file, "x");
    const log = new FileLogger({ dir: join(file, "sub") });
    expect(() => log.warn("x")).not.toThrow();
  });
});
