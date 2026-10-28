/**
 * roadmap v0.6 M2：日历锚点唤醒。
 * 验收：跨年（12-30 看见 01-01）；时区切换；无锚点条目零变化；农历表 2026–2040，范围外不匹配。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openService } from "../src/host/index";
import { recallEntries, type WeaveService } from "../src/host/service";
import type { WeaveEnv } from "../src/store/db";
import { getMemory, insertMemory } from "../src/store/dao";
import { anchorBoost, DEFAULT_CALENDAR, matchAnchor, nextOccurrence, normalizeAnchor } from "../src/core/calendar";
import { LUNAR_FESTIVALS } from "../src/core/lunar-table";
import type { CalendarAnchor } from "../src/core/types";
import { entry } from "./link-health.test";

const DAY = 86400000;
const SH = "Asia/Shanghai";
/** 上海本地 y-m-d h:00 的 UTC 毫秒 */
const sh = (y: number, m: number, d: number, h = 12): number => Date.UTC(y, m - 1, d, h - 8);
const cfg = { ...DEFAULT_CALENDAR };

describe("M2 日期匹配", () => {
  it("annual：当天 0、提前 2 天、窗口外 null", () => {
    const a: CalendarAnchor = { kind: "annual", month: 3, day: 12, label: "生日" };
    expect(matchAnchor(a, sh(2027, 3, 12), SH, cfg)).toMatchObject({ days: 0, boost: 1, name: "生日" });
    expect(matchAnchor(a, sh(2027, 3, 10), SH, cfg)).toMatchObject({ days: 2 });
    expect(matchAnchor(a, sh(2027, 3, 10), SH, cfg)!.boost).toBeCloseTo(0.56, 6);
    expect(matchAnchor(a, sh(2027, 3, 8), SH, cfg)).toBeNull();
    expect(matchAnchor(a, sh(2027, 3, 13), SH, cfg)).toBeNull(); // 过了当天不算
  });

  it("跨年：12-30 能看见 01-01", () => {
    const a: CalendarAnchor = { kind: "festival", festival: "元旦" };
    expect(matchAnchor(a, sh(2026, 12, 30), SH, cfg)).toMatchObject({ days: 2 });
    const b: CalendarAnchor = { kind: "annual", month: 1, day: 1 };
    expect(nextOccurrence(b, sh(2026, 12, 31), SH)).toEqual({ days: 1 });
  });

  it("时区切换：同一 UTC 时刻，上海已是 3-12、纽约还是 3-11", () => {
    const a: CalendarAnchor = { kind: "annual", month: 3, day: 12 };
    const t = Date.UTC(2027, 2, 12, 2); // 上海 10:00 3-12，纽约 22:00 3-11
    expect(nextOccurrence(a, t, SH)).toEqual({ days: 0 });
    expect(nextOccurrence(a, t, "America/New_York")).toEqual({ days: 1 });
  });

  it("monthly / weekly", () => {
    const m: CalendarAnchor = { kind: "monthly", day: 15 };
    expect(matchAnchor(m, sh(2027, 4, 15), SH, cfg)).toMatchObject({ days: 0, boost: 0.8 });
    expect(matchAnchor(m, sh(2027, 4, 13), SH, cfg)).toMatchObject({ days: 2, boost: 0.4 });
    // 31 号：没有 31 号的月份跳到下一个有的
    expect(nextOccurrence({ kind: "monthly", day: 31 }, sh(2027, 4, 1), SH)).toEqual({ days: 60 }); // 4 月没有 31 号 → 5-31
    const w: CalendarAnchor = { kind: "weekly", weekday: 1 }; // 周一
    expect(matchAnchor(w, sh(2026, 11, 2), SH, cfg)).toMatchObject({ days: 0, boost: 0.7 }); // 2026-11-02 周一
    expect(matchAnchor(w, sh(2026, 10, 31), SH, cfg)).toMatchObject({ days: 2, boost: 0.35 });
  });

  it("anniversary：第 N 年；起始年当年不算", () => {
    const a: CalendarAnchor = { kind: "anniversary", month: 5, day: 20, sinceYear: 2024, label: "纪念日" };
    expect(nextOccurrence(a, sh(2027, 5, 19), SH)).toEqual({ days: 1, years: 3 });
    expect(nextOccurrence({ ...a, sinceYear: 2027 }, sh(2027, 5, 19), SH)).toEqual({ days: 367, years: 1 });
  });

  it("2 月 29 日：平年落到 2-28", () => {
    const a: CalendarAnchor = { kind: "annual", month: 2, day: 29 };
    expect(nextOccurrence(a, sh(2027, 2, 28), SH)).toEqual({ days: 0 });
    expect(nextOccurrence(a, sh(2028, 2, 28), SH)).toEqual({ days: 1 });
  });

  it("农历节日：查表；2041 起不匹配", () => {
    expect(LUNAR_FESTIVALS["春节"][2027]).toBe("02-06");
    const a: CalendarAnchor = { kind: "festival", festival: "春节" };
    expect(matchAnchor(a, sh(2027, 2, 4), SH, cfg)).toMatchObject({ days: 2 });
    expect(matchAnchor(a, sh(2027, 2, 6), SH, cfg)).toMatchObject({ days: 0, boost: 1 });
    expect(nextOccurrence({ kind: "festival", festival: "中秋" }, sh(2041, 1, 1), SH)).toBeNull();
  });

  it("boost 曲线下限", () => {
    expect(anchorBoost("annual", 10)).toBe(0.3);
    expect(anchorBoost("festival", 10)).toBe(0.35);
  });

  it("normalizeAnchor 校验", () => {
    expect("anchor" in normalizeAnchor({ kind: "annual", month: 2, day: 29 })).toBe(true);
    expect("error" in normalizeAnchor({ kind: "annual", month: 2, day: 30 })).toBe(true);
    expect("error" in normalizeAnchor({ kind: "anniversary", month: 1, day: 1 })).toBe(true);
    expect("error" in normalizeAnchor({ kind: "weekly", weekday: 7 })).toBe(true);
    expect("error" in normalizeAnchor({ kind: "festival", festival: "清明" })).toBe(true);
    expect("anchor" in normalizeAnchor({ kind: "festival", festival: "国庆" })).toBe(true);
    expect("error" in normalizeAnchor({ kind: "yearly" })).toBe(true);
    expect("error" in normalizeAnchor(null)).toBe(true);
  });
});

describe("M2 召回", () => {
  let dir: string;
  let env: WeaveEnv;
  let service: WeaveService;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "memweave-cal-"));
    const rt = openService(dir);
    env = rt.env;
    service = rt.service;
    service.config.calendar.timeZone = SH;
  });
  afterEach(() => {
    service.stopMirror(false);
    env.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("窗口内的锚点条目即使查询不相关也进候选池（route=calendar），trace 带 calendar=", () => {
    const now = sh(2027, 3, 10);
    insertMemory(env, entry({ id: "bd", level: "user", content: "主人的生日是 3 月 12 日", calendarAnchor: { kind: "annual", month: 3, day: 12, label: "生日" } }));
    insertMemory(env, entry({ id: "x", content: "部署脚本放在 tools 目录" }));
    const hits = recallEntries(env, "部署脚本", { now, calendar: { ...cfg, timeZone: SH } });
    const bd = hits.find((h) => h.id === "bd")!;
    expect(bd).toBeDefined();
    expect(bd.routes).toContain("calendar");
    expect(bd.explain).toContain("calendar=生日,in=2d");
  });

  it("anniversary trace 带第 N 年", () => {
    const now = sh(2027, 5, 20);
    insertMemory(env, entry({ id: "an", content: "和主人第一次聊天", calendarAnchor: { kind: "anniversary", month: 5, day: 20, sinceYear: 2025, label: "相识纪念日" } }));
    const h = recallEntries(env, "随便", { now, calendar: { ...cfg, timeZone: SH } }).find((x) => x.id === "an")!;
    expect(h.explain).toContain("calendar=相识纪念日,in=0d,第2年");
  });

  it("无锚点条目：开 / 关 M2 打分逐字节一致", () => {
    const now = Date.now();
    for (let i = 0; i < 6; i += 1) insertMemory(env, entry({ id: "e" + i, content: "部署脚本 第" + i + "版", updatedAt: now - i * 20 * DAY }));
    const on = recallEntries(env, "部署脚本", { now, calendar: { ...cfg, enabled: true, timeZone: SH } });
    const off = recallEntries(env, "部署脚本", { now });
    expect(on.map((h) => [h.id, h.score, h.explain])).toEqual(off.map((h) => [h.id, h.score, h.explain]));
  });

  it("关掉 M2：锚点条目不强制进池", () => {
    const now = sh(2027, 3, 12);
    insertMemory(env, entry({ id: "bd", content: "主人的生日", calendarAnchor: { kind: "annual", month: 3, day: 12 } }));
    expect(recallEntries(env, "部署脚本", { now, calendar: { ...cfg, enabled: false } }).find((h) => h.id === "bd")).toBeUndefined();
  });

  it("weave_remember 带 anchor：写入后可读回；非法锚点只拒字段；可撤销", async () => {
    const w = await service.remember({ level: "user", content: "主人的生日是 3 月 12 日" }, "agent", { anchor: { kind: "annual", month: 3, day: 12, label: "生日" } });
    expect(getMemory(env, w.id!)!.calendarAnchor).toEqual({ kind: "annual", month: 3, day: 12, label: "生日" });
    const bad = await service.remember({ level: "fact", content: "某个奇怪的日子" }, "agent", { anchor: { kind: "annual", month: 13, day: 1 } });
    expect(bad.ok).toBe(true);
    expect((bad as { warn?: string }).warn).toMatch(/anchor rejected/);
    expect(getMemory(env, bad.id!)!.calendarAnchor).toBeNull();
    const u = service.undoList().find((x) => x.action === "memory.anchor" && x.target === w.id)!;
    expect((await service.undo(u.id, "human")).ok).toBe(true);
    expect(getMemory(env, w.id!)!.calendarAnchor).toBeNull();
  });

  it("设置页 setAnchor：加、删", () => {
    insertMemory(env, entry({ id: "m", content: "每月 15 号发工资" }));
    expect(service.setAnchor("m", { kind: "monthly", day: 15 }, "human").ok).toBe(true);
    expect(getMemory(env, "m")!.calendarAnchor).toEqual({ kind: "monthly", day: 15 });
    expect(service.setAnchor("m", { kind: "monthly", day: 40 }, "human").ok).toBe(false);
    expect(service.setAnchor("m", null, "human").ok).toBe(true);
    expect(getMemory(env, "m")!.calendarAnchor).toBeNull();
  });
});
