import { defineConfig } from "vitest/config";

/**
 * 覆盖率门禁。
 * 只统计 `src/**`：测试文件自身不计入，构建脚本与 bench 也不计入。
 * 阈值取「实测基线向下取整」，不是理想值——先量出真实数字，再钉住它，
 * 避免为了达标去写无意义的断言；同时留出余量，小幅重构不会误报。
 *
 * `globalSetup` 在跑用例前确保 `lib/` 已构建：bench 里的跑分器缺产物时会
 * 各自自动构建，并行跑用例会互相覆盖，干净检出第一次跑测试会偶发失败。
 */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/global-setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts"],
      all: true,
      thresholds: {
        statements: 70,
        lines: 70,
        branches: 75,
        functions: 75,
      },
    },
  },
});
