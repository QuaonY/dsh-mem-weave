/**
 * 设置页「恢复默认」的后端口径：settings/defaults 返回出厂值
 * （插件配置 + 内置默认），不受设置页保存过的 settings.json 影响。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { openService, type WeaveRuntime } from "../src/host/index";
import { invokeRpc } from "../src/host/rpc";
import { defaultConfig } from "../src/host/service";

let dir = "";
let rt: WeaveRuntime | null = null;

afterEach(() => {
  rt?.service.stopMirror(false);
  rt?.env.close();
  rt = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

type Cfg = { budget: Record<string, number>; recall: { rrfK: number; weights: Record<string, number> }; dream: { idleMinutes: number; peakHours: number[][] } };

describe("settings/defaults", () => {
  it("没有插件配置时等于内置默认；设置页改过、重启后仍返回出厂值", async () => {
    dir = mkdtempSync(join(tmpdir(), "mw-defaults-"));
    rt = openService(dir);
    const builtin = defaultConfig(dir);
    let d = (await invokeRpc(rt.service, "memweave.settings/defaults", {}, "agent")) as Cfg;
    expect(d.budget).toEqual(builtin.budget);
    expect(d.recall.rrfK).toBe(builtin.recall.rrfK);
    expect(d.dream.peakHours).toEqual(builtin.dream.peakHours);

    const up = (await invokeRpc(rt.service, "memweave.settings/update", { patch: { recall: { rrfK: 30 }, dream: { idleMinutes: 15 } } }, "human")) as { ok: boolean; persisted: boolean };
    expect(up.ok).toBe(true);
    expect(up.persisted).toBe(true);
    d = (await invokeRpc(rt.service, "memweave.settings/defaults", {}, "agent")) as Cfg;
    expect(d.recall.rrfK).toBe(builtin.recall.rrfK);
    expect(d.dream.idleMinutes).toBe(builtin.dream.idleMinutes);

    // 重启：settings.json 叠上去，当前值是改过的，出厂值不变
    rt.service.stopMirror(false);
    rt.env.close();
    rt = openService(dir);
    const cur = (await invokeRpc(rt.service, "memweave.settings/get", {}, "agent")) as Cfg;
    expect(cur.recall.rrfK).toBe(30);
    d = (await invokeRpc(rt.service, "memweave.settings/defaults", {}, "agent")) as Cfg;
    expect(d.recall.rrfK).toBe(builtin.recall.rrfK);
    expect(d.dream.idleMinutes).toBe(builtin.dream.idleMinutes);
  });

  it("插件配置（cordis.patch.yml）给的值算出厂值", async () => {
    dir = mkdtempSync(join(tmpdir(), "mw-defaults-"));
    rt = openService(dir, { budget: { snapshotMaxChars: 4321 } } as never);
    const d = (await invokeRpc(rt.service, "memweave.settings/defaults", {}, "agent")) as Cfg;
    expect(d.budget.snapshotMaxChars).toBe(4321);
    // 没写的键仍取内置默认
    expect(d.budget.deltaMaxChars).toBe(defaultConfig(dir).budget.deltaMaxChars);
  });

  it("出厂值与当前配置互不影响（不是同一个对象）", async () => {
    dir = mkdtempSync(join(tmpdir(), "mw-defaults-"));
    rt = openService(dir);
    await invokeRpc(rt.service, "memweave.settings/update", { patch: { budget: { recallMaxChars: 777 } } }, "human");
    const d = (await invokeRpc(rt.service, "memweave.settings/defaults", {}, "agent")) as Cfg;
    expect(d.budget.recallMaxChars).toBe(defaultConfig(dir).budget.recallMaxChars);
  });
});
