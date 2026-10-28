/**
 * 忆织 MemWeave —— 日历锚点唤醒（roadmap v0.6 M2）。
 * 匹配一律用配置时区的本地日期（localdate.ts）；库内仍是 UTC（D14）。
 * boost 曲线沿用 MMTR calendar.ts 默认值（MIT）。
 */

import type { CalendarAnchor } from "./types";
import { LUNAR_FESTIVALS, LUNAR_TABLE_RANGE } from "./lunar-table";
import { localDayNumber, localParts, validYmd } from "./localdate";

export interface CalendarConfig {
  enabled: boolean;
  /** 提前几天开始浮现（默认 3；当天也算） */
  lookaheadDays: number;
  /** score × (1 + factor × boost) */
  factor: number;
  /** 留空 = 宿主进程时区 */
  timeZone: string;
}

export const DEFAULT_CALENDAR: CalendarConfig = {
  enabled: true,
  lookaheadDays: 3,
  factor: 0.5,
  timeZone: "",
};

/** 内置公历节日（每年固定月日） */
export const GREGORIAN_FESTIVALS: Record<string, { month: number; day: number }> = {
  元旦: { month: 1, day: 1 },
  情人节: { month: 2, day: 14 },
  劳动节: { month: 5, day: 1 },
  国庆: { month: 10, day: 1 },
  圣诞: { month: 12, day: 25 },
};

export const FESTIVAL_NAMES: string[] = [...Object.keys(LUNAR_FESTIVALS), ...Object.keys(GREGORIAN_FESTIVALS)];

const KINDS = new Set(["annual", "anniversary", "monthly", "weekly", "festival"]);
const LABEL_MAX = 20;

/** 时区：配置优先，留空取宿主进程时区 */
export function resolveTimeZone(cfg?: Pick<CalendarConfig, "timeZone">): string {
  const z = cfg?.timeZone?.trim();
  if (z) return z;
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** 校验并规范化锚点；非法返回 { error } */
export function normalizeAnchor(raw: unknown): { anchor: CalendarAnchor } | { error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "anchor must be an object" };
  const a = raw as Record<string, unknown>;
  const kind = String(a.kind ?? "");
  if (!KINDS.has(kind)) return { error: "anchor.kind must be annual|anniversary|monthly|weekly|festival" };
  const int = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) ? v : undefined);
  const label = typeof a.label === "string" && a.label.trim() ? a.label.trim().slice(0, LABEL_MAX) : undefined;
  const out: CalendarAnchor = { kind: kind as CalendarAnchor["kind"], ...(label ? { label } : {}) };
  if (kind === "annual" || kind === "anniversary") {
    const month = int(a.month);
    const day = int(a.day);
    // 用闰年校验，允许 2 月 29 日
    if (month === undefined || day === undefined || !validYmd(2024, month, day)) return { error: "anchor.month/day invalid" };
    out.month = month;
    out.day = day;
    if (kind === "anniversary") {
      const since = int(a.sinceYear);
      if (since === undefined || since < 1900 || since > 2100) return { error: "anchor.sinceYear must be 1900–2100" };
      out.sinceYear = since;
    }
  } else if (kind === "monthly") {
    const day = int(a.day);
    if (day === undefined || day < 1 || day > 31) return { error: "anchor.day must be 1–31" };
    out.day = day;
  } else if (kind === "weekly") {
    const wd = int(a.weekday);
    if (wd === undefined || wd < 0 || wd > 6) return { error: "anchor.weekday must be 0(Sun)–6(Sat)" };
    out.weekday = wd;
  } else {
    const f = typeof a.festival === "string" ? a.festival.trim() : "";
    if (!FESTIVAL_NAMES.includes(f)) return { error: "anchor.festival must be one of " + FESTIVAL_NAMES.join("/") };
    out.festival = f;
  }
  return { anchor: out };
}

const dayNum = (y: number, m: number, d: number): number => Math.floor(Date.UTC(y, m - 1, d) / 86400000);

/** 某年里这个锚点落在哪些本地日（日序号）；没有就空数组 */
function occurrencesInYear(a: CalendarAnchor, year: number): number[] {
  switch (a.kind) {
    case "annual":
    case "anniversary": {
      if (a.kind === "anniversary" && year <= (a.sinceYear ?? 0)) return [];
      let d = a.day!;
      // 2 月 29 日的锚点在平年落到 2 月 28 日
      if (a.month === 2 && d === 29 && !validYmd(year, 2, 29)) d = 28;
      return validYmd(year, a.month!, d) ? [dayNum(year, a.month!, d)] : [];
    }
    case "monthly": {
      const out: number[] = [];
      for (let m = 1; m <= 12; m += 1) if (validYmd(year, m, a.day!)) out.push(dayNum(year, m, a.day!));
      return out;
    }
    case "festival": {
      const g = GREGORIAN_FESTIVALS[a.festival ?? ""];
      if (g) return [dayNum(year, g.month, g.day)];
      if (year < LUNAR_TABLE_RANGE.from || year > LUNAR_TABLE_RANGE.to) return [];
      const s = LUNAR_FESTIVALS[a.festival ?? ""]?.[year];
      if (!s) return [];
      const [m, d] = s.split("-").map(Number);
      return [dayNum(year, m, d)];
    }
    default:
      return [];
  }
}

export interface AnchorHit {
  /** 距下一次的本地天数（0 = 今天） */
  days: number;
  /** anniversary：第几年 */
  years?: number;
}

/** 下一次（含今天）在几天后；一年半内找不到返回 null（如农历表超出范围） */
export function nextOccurrence(a: CalendarAnchor, now: number, timeZone: string): AnchorHit | null {
  const today = localDayNumber(now, timeZone);
  if (a.kind === "weekly") {
    const wd = localParts(now, timeZone).weekday;
    return { days: ((a.weekday ?? 0) - wd + 7) % 7 };
  }
  const y = localParts(now, timeZone).year;
  for (const year of [y, y + 1]) {
    for (const n of occurrencesInYear(a, year)) {
      if (n >= today) {
        const hit: AnchorHit = { days: n - today };
        if (a.kind === "anniversary") hit.years = year - (a.sinceYear ?? year);
        return hit;
      }
    }
  }
  return null;
}

/** boost 曲线（MMTR 默认值）：days = 距当天天数，0 = 当天 */
export function anchorBoost(kind: CalendarAnchor["kind"], days: number): number {
  const d = Math.max(0, days);
  switch (kind) {
    case "annual":
    case "anniversary":
      return d === 0 ? 1 : Math.max(0.3, 1 - 0.22 * d);
    case "festival":
      return d === 0 ? 1 : Math.max(0.35, 1 - 0.2 * d);
    case "monthly":
      return d === 0 ? 0.8 : 0.4;
    case "weekly":
      return d === 0 ? 0.7 : 0.35;
    default:
      return 0;
  }
}

export interface CalendarMatch extends AnchorHit {
  boost: number;
  /** trace 用名字：label > festival > kind */
  name: string;
}

/** 在窗口内（0..lookaheadDays）才算命中 */
export function matchAnchor(a: CalendarAnchor | null | undefined, now: number, timeZone: string, cfg: CalendarConfig): CalendarMatch | null {
  if (!a || !cfg.enabled) return null;
  const hit = nextOccurrence(a, now, timeZone);
  if (!hit || hit.days > Math.max(0, cfg.lookaheadDays)) return null;
  return { ...hit, boost: anchorBoost(a.kind, hit.days), name: a.label ?? a.festival ?? a.kind };
}

/** trace 片段：calendar=生日,in=2d[,第3年] */
export function anchorTrace(m: CalendarMatch): string {
  return "calendar=" + m.name.replace(/[;,=]/g, " ") + ",in=" + m.days + "d" + (m.years !== undefined ? ",第" + m.years + "年" : "");
}
