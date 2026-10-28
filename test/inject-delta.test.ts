/**
 * test/inject-delta（§15）：连续 10 轮无变化 ⇒ 零注入（S2/S3 全空），
 * 且 S1 前缀字节逐轮完全一致（会话内冻结的装配口径）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openService } from "../src/host/index";
import type { WeaveService } from "../src/host/service";
import type { WeaveEnv } from "../src/store/db";
import type { MemoryEntry } from "../src/core/types";

let dir: string;
let env: WeaveEnv;
let service: WeaveService;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memweave-inject-delta-"));
  const rt = openService(dir);
  env = rt.env;
  service = rt.service;
});

afterEach(() => {
  service.stopMirror(false);
  env.close();
  rmSync(dir, { recursive: true, force: true });
});

function baselineOf(entries: MemoryEntry[]): Map<string, number> {
  return new Map(entries.map((e) => [e.id, e.updatedAt]));
}

describe("inject-delta：无变化零注入 + 前缀字节一致（§15）", () => {
  it("连续 10 轮无变化：S2/S3 全空，前缀逐轮字节一致", async () => {
    service.updatePersona({ stance: "立场：先对齐目标再动手" }, "human");
    const a = await service.remember({ level: "user", content: "主人偏好像素风的游戏美术风格" }, "human");
    const b = await service.remember({ level: "project", content: "当前项目是忆织记忆插件开发" }, "human");
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);

    const baseline = baselineOf(service.listMemory({}));
    expect(baseline.size).toBe(2);

    // 第 1 轮：首轮快照
    const r1 = service.renderTurn({ sessionId: "s-delta", first: true, baseline });
    expect(r1.s2.length).toBeGreaterThan(0);
    expect(r1.s3).toBe("");
    const prefixRef = Buffer.from(r1.result.s1.prefix, "utf8");
    expect(prefixRef.length).toBeGreaterThan(0);

    // 第 2..10 轮：无变化 ⇒ 零注入
    for (let i = 2; i <= 10; i += 1) {
      const r = service.renderTurn({
        sessionId: "s-delta",
        first: false,
        query: "zzzqqqxyz",
        baseline,
      });
      expect(r.s2).toBe("");
      expect(r.s3).toBe("");
      expect(r.result.s2).toBe("");
      expect(r.result.s3).toBe("");
      // 除 S1 静态段外不得有任何注入文本
      const dynamic = r.result.segments.filter((s) => s.name !== "s1-persona" && s.text.length > 0);
      expect(dynamic).toHaveLength(0);
      // 前缀字节一致
      const prefixNow = Buffer.from(r.result.s1.prefix, "utf8");
      expect(Buffer.compare(prefixNow, prefixRef)).toBe(0);
    }

    // 有变化时才注入 delta
    await service.remember({ level: "user", content: "主人偏好深色主题的界面配色" }, "human");
    const r11 = service.renderTurn({ sessionId: "s-delta", first: false, query: "zzzqqqxyz", baseline });
    expect(r11.s3.length).toBeGreaterThan(0);
    expect(Buffer.compare(Buffer.from(r11.result.s1.prefix, "utf8"), prefixRef)).toBe(0);
  });
});
