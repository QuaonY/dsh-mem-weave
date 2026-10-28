/**
 * 忆织 MemWeave —— 本地日期工具（roadmap v0.6 M1 / M2）。
 * 库内一律 UTC 毫秒（D14）；只有「算哪一天」「渲染成日期」时才换算到配置时区。
 * 零依赖：只用 Intl。注入文本只出绝对日期，不出「明天 / 下周」之类相对词。
 */

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** 0 = 周日 … 6 = 周六 */
  weekday: number;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = fmtCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    fmtCache.set(timeZone, f);
  }
  return f;
}

/** 时区无效时回退 UTC，绝不抛错（I8） */
export function safeZone(timeZone: string | undefined): string {
  if (!timeZone) return "UTC";
  try {
    formatter(timeZone).format(0);
    return timeZone;
  } catch {
    return "UTC";
  }
}

const WD: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function localParts(ms: number, timeZone: string): LocalParts {
  const parts = formatter(safeZone(timeZone)).formatToParts(new Date(ms));
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? "0";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")) % 24,
    minute: Number(get("minute")),
    weekday: WD[get("weekday")] ?? 0,
  };
}

/** 本地墙钟时间 → UTC 毫秒（两次修正，覆盖夏令时边界） */
export function localToUtc(y: number, mo: number, d: number, h: number, mi: number, timeZone: string): number {
  const zone = safeZone(timeZone);
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  let guess = wall;
  for (let i = 0; i < 2; i += 1) {
    const p = localParts(guess, zone);
    const seen = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    guess += wall - seen;
  }
  return guess;
}

/** 本地日序号（自 1970-01-01 起的天数），用来算两天相差几天 */
export function localDayNumber(ms: number, timeZone: string): number {
  const p = localParts(ms, timeZone);
  return Math.floor(Date.UTC(p.year, p.month - 1, p.day) / 86400000);
}

const pad = (n: number): string => String(n).padStart(2, "0");

const WD_ZH = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const WD_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** 2026-11-03（周二）；withTime 时带 18:00（本地 0 点不带） */
export function formatLocalDate(ms: number, timeZone: string, lang: "zh" | "en" = "zh", withTime = false): string {
  const p = localParts(ms, timeZone);
  const date = p.year + "-" + pad(p.month) + "-" + pad(p.day);
  const wd = lang === "en" ? " (" + WD_EN[p.weekday] + ")" : "（" + WD_ZH[p.weekday] + "）";
  const time = withTime && !(p.hour === 23 && p.minute === 59) && !(p.hour === 0 && p.minute === 0) ? " " + pad(p.hour) + ":" + pad(p.minute) : "";
  return date + wd + time;
}

/**
 * 解析写入方给的约定日。只认绝对时间：
 * - 数字：UTC 毫秒
 * - "YYYY-MM-DD"：本地当天 23:59
 * - "YYYY-MM-DDTHH:mm"（可带秒 / 时区后缀；不带后缀按本地时区）
 * 相对写法（"明天"、"+3d"）一律不认，返回 null。
 */
export function parseDue(v: unknown, timeZone: string): number | null {
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? Math.round(v) : null;
  if (typeof v !== "string") return null;
  const s = v.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (!validYmd(y, mo, d)) return null;
    return localToUtc(y, mo, d, 23, 59, timeZone);
  }
  m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(s);
  if (m) {
    const [y, mo, d, h, mi] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])];
    if (!validYmd(y, mo, d) || h > 23 || mi > 59) return null;
    return localToUtc(y, mo, d, h, mi, timeZone);
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(s)) {
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

export function validYmd(y: number, mo: number, d: number): boolean {
  if (!Number.isInteger(y) || !Number.isInteger(mo) || !Number.isInteger(d)) return false;
  if (mo < 1 || mo > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

export function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}
