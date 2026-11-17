/**
 * 覆盖率门禁自证。
 * 门禁只有在「不能被悄悄调低」时才有意义，所以这里把阈值、统计范围
 * 入口脚本与 CI 步骤都钉成断言：想放宽门槛就必须改测试并在 PR 里说明。
 * 数值基线与阈值见 `vitest.config.ts`。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import config from "../vitest.config";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("覆盖率门禁", () => {
  // provider 是联合类型，按实际用到的字段收窄，避免为测试引入一整套 Coverage 类型
  const coverage = config.test?.coverage as
    | {
        provider?: string;
        include?: string[];
        all?: boolean;
        thresholds?: Record<string, number>;
      }
    | undefined;

  it("阈值固定在实测基线之下、且不低到失去意义", () => {
    expect(coverage?.thresholds).toEqual({
      statements: 70,
      lines: 70,
      branches: 75,
      functions: 75,
    });
  });

  it("只统计 src，且包含从未被 import 的模块", () => {
    expect(coverage?.include).toEqual(["src/**/*.ts"]);
    // all: true 才会把「一次都没被加载」的模块算成 0%，否则门禁只看跑到的文件
    expect(coverage?.all).toBe(true);
    expect(coverage?.provider).toBe("v8");
  });

  it("package.json 提供 test:coverage 入口", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.["test:coverage"]).toBe("vitest run --coverage");
  });

  it("CI 用带门禁的命令跑测试", () => {
    const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
    expect(ci).toContain("pnpm test:coverage");
  });

  it("CI 先构建再测试，用例不会各自并发构建", () => {
    const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
    const build = ci.indexOf("run: pnpm build");
    const test = ci.indexOf("run: pnpm test:coverage");
    expect(build).toBeGreaterThan(-1);
    expect(test).toBeGreaterThan(-1);
    expect(build).toBeLessThan(test);
  });
});
