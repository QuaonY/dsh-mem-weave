/**
 * 设置页文案完整性：前端代码里写死的文案键，中英文都必须有（缺了界面会直接显示键名）。
 * 只查字面量键；拼接出来的键（如 "option.level." + lv）不在此列。
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { t } from "../src/i18n";

const dir = join(__dirname, "..", "src", "client");
const keys = new Set<string>();
for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts"))) {
  const src = readFileSync(join(dir, f), "utf8");
  // 以 "." 结尾的是拼接前缀（"option.level." + lv），跳过
  for (const m of src.matchAll(/\b(?:t|tr)\("([a-zA-Z][\w.-]*\.[\w.-]*[\w-])"/g)) keys.add(m[1]);
}

describe("i18n 键", () => {
  it("扫到的键数量合理（防止正则失效后空跑）", () => {
    expect(keys.size).toBeGreaterThan(200);
  });

  it("前端用到的字面量键中文都有", () => {
    expect([...keys].filter((k) => t(k, "zh") === k)).toEqual([]);
  });

  it("中英文词典键一一对应（含拼接出来的键），切到英文不会冒出中文", () => {
    const src = readFileSync(join(__dirname, "..", "src", "i18n", "index.ts"), "utf8");
    const block = (name: string): Set<string> => {
      const start = src.indexOf("const " + name);
      const end = src.indexOf("\n};", start);
      return new Set([...src.slice(start, end).matchAll(/^\s+"([^"]+)":/gm)].map((m) => m[1]));
    };
    const zh = block("ZH");
    const en = block("EN");
    expect(zh.size).toBeGreaterThan(300);
    expect([...zh].filter((k) => !en.has(k))).toEqual([]);
    expect([...en].filter((k) => !zh.has(k))).toEqual([]);
    // 前端用到的字面量键，英文不能直接回退成中文
    expect([...keys].filter((k) => /[\u4e00-\u9fff]/.test(t(k, "en")))).toEqual([]);
  });

  it("v0.7.3 新入口的文案都在", () => {
    for (const k of ["memory.terms", "memory.anchor", "memory.promise", "advanced.curateCard", "curate.run", "common.resetDefault"]) {
      expect(keys.has(k)).toBe(true);
      expect(t(k, "zh")).not.toBe(k);
      expect(t(k, "en")).not.toBe(t(k, "zh"));
    }
  });
});
