/**
 * 存储位置与设置持久化：指针文件、复制迁移、settings.json 重启后保留。
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openService } from "../src/host/index";
import { invokeRpc } from "../src/host/rpc";
import { normalizeDataDir, readPointer } from "../src/host/location";

let home = "";
let prevHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "memweave-loc-"));
  prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

describe("存储位置", () => {
  it("默认用 DSH_HOME/memweave；复制到新目录后，重启改用新目录，旧库保留", () => {
    const first = openService();
    try {
      expect(first.env.dataDir).toBe(join(home, "memweave"));
      const loc = first.service.dataLocation();
      expect(loc.source).toBe("default");
      expect(loc.restartRequired).toBe(false);
      const target = join(home, "elsewhere");
      const out = first.service.relocate(target, "copy", "human");
      expect(out.ok).toBe(true);
      expect(out.copied).toBe(true);
      expect(existsSync(join(target, "memweave.db"))).toBe(true);
      expect(readPointer()).toBe(target);
      expect(first.service.dataLocation().restartRequired).toBe(true);
      // 目标已有库时不覆盖
      expect(first.service.relocate(target, "copy", "human").code).toBe("E_EXISTS");
    } finally {
      first.env.close();
    }
    const second = openService();
    try {
      expect(second.env.dataDir).toBe(join(home, "elsewhere"));
      expect(second.service.dataDirSource).toBe("pointer");
      expect(existsSync(join(home, "memweave", "memweave.db"))).toBe(true);
      // 改回默认会删掉指针
      expect(second.service.relocate(join(home, "memweave"), "use", "human").ok).toBe(true);
      expect(readPointer()).toBe("");
    } finally {
      second.env.close();
    }
  });

  it("插件配置显式指定 dataDir 时锁定，不允许在设置页改", () => {
    const rt = openService(join(home, "fixed"));
    try {
      expect(rt.service.dataLocation().locked).toBe(true);
      expect(rt.service.relocate(join(home, "x"), "copy", "human").code).toBe("E_LOCKED");
    } finally {
      rt.env.close();
    }
  });

  it("拒绝相对路径和带单引号的路径", () => {
    expect(normalizeDataDir("relative/dir").ok).toBe(false);
    expect(normalizeDataDir(join(home, "it's")).ok).toBe(false);
    expect(normalizeDataDir("").ok).toBe(false);
  });
});

describe("高级设置持久化", () => {
  it("settings/update 写入 settings.json，重启后仍生效", async () => {
    const first = openService();
    try {
      const out = (await invokeRpc(first.service, "settings/update", { patch: { lifecycle: { coldMemoryMonths: 9 } } }, "human")) as Record<string, unknown>;
      expect(out.persisted).toBe(true);
    } finally {
      first.env.close();
    }
    const second = openService();
    try {
      expect(second.service.config.lifecycle.coldMemoryMonths).toBe(9);
      // 没改过的项仍是默认值
      expect(second.service.config.lifecycle.mergeOnDream).toBe(first.service.config.lifecycle.mergeOnDream);
    } finally {
      second.env.close();
    }
  });
});
