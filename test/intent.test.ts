/**
 * roadmap v0.5 R11：按问题类型给层加权（默认关；规则表，设置页可编辑）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_INTENT_RULES, detectIntent } from "../src/core/intent";
import { openService } from "../src/host/index";
import type { WeaveService } from "../src/host/service";
import type { WeaveEnv } from "../src/store/db";
import { insertMemory } from "../src/store/dao";
import { entry } from "./link-health.test";

let dir: string;
let env: WeaveEnv;
let service: WeaveService;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memweave-intent-"));
  const rt = openService(dir);
  env = rt.env;
  service = rt.service;
  service.config.recall.intent.enabled = true;
});

afterEach(() => {
  service.stopMirror(false);
  env.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("R11 按问题类型给层加权", () => {
  it("detectIntent：规则表触发词匹配 → 对应层", () => {
    const cfg = { enabled: true, rules: DEFAULT_INTENT_RULES, factor: 1.35 };
    expect(detectIntent("主人喜欢什么", cfg).get("user")).toEqual(["偏好"]);
    expect(detectIntent("怎么做", cfg).get("lesson")).toEqual(["做法"]);
    expect(detectIntent("项目代码", cfg).get("project")).toEqual(["项目"]);
    expect(detectIntent("必须这样", cfg).get("rules")).toEqual(["规则"]);
    expect(detectIntent("某个事实", cfg)).toEqual(new Map());
  });

  it("同时命中多个意图", () => {
    const cfg = { enabled: true, rules: DEFAULT_INTENT_RULES, factor: 1.35 };
    const map = detectIntent("主人喜欢怎么做项目", cfg);
    expect([...map.keys()]).toEqual(["user", "lesson", "project"]);
  });

  it("intent 加权应用到 recall：直接查询命中 user 并加权", () => {
    insertMemory(env, entry({ id: "u", level: "user", content: "喜欢简洁的回复" }));
    const h = service.recall("喜欢简洁", { limit: 5 });
    const u = h.find((x) => x.id === "u");
    expect(u).toBeDefined();
    expect(u!.explain).toContain("intent=偏好");
  });

  it("multiple layers in one query", () => {
    insertMemory(env, entry({ id: "l", level: "lesson", content: "怎么处理的" }));
    const h = service.recall("怎么处理", { limit: 5 });
    const l = h.find((x) => x.id === "l");
    expect(l).toBeDefined();
    expect(l!.explain).toContain("intent=做法");
  });

  it("关闭开关 → 不加权", () => {
    service.config.recall.intent.enabled = false;
    insertMemory(env, entry({ id: "u", level: "user", content: "喜欢简洁的回复" }));
    const h = service.recall("喜欢简洁", { limit: 5 });
    const u = h.find((x) => x.id === "u");
    expect(u).toBeDefined();
    expect(u!.explain).not.toContain("intent=");
  });
});
