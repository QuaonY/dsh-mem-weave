/**
 * 跨进程后台租约。
 * 同一个数据目录可能被多个宿主进程同时打开（桌面端 + CLI、两个 IDE 窗口）。
 * SQLite 自己会串行化写入，但**定时任务不会**：dream 收梭、向量索引消费
 * 都会在每个进程里各跑一遍，造成重复归纳与重复 embedding 调用。
 * 这里用一个单行表 `process_lease` 做「谁负责后台任务」的租约：
 * - `hold` 先续期，失败再尝试抢占；成功即本进程负责；
 * - 持有者每轮定时器续期，进程退出后租约在 TTL 内自然过期，别的进程接管；
 * - 同一 host + pid 视为同一进程重启，新句柄可直接接管（避免测试里
 *   重开同一个库要等 TTL）。
 * 只覆盖「可以不做、做了会重复」的后台任务；会话注入与写入不走租约
 * 任何进程都能读写（SQLite WAL 负责并发安全）。
 */

import { hostname as osHostname } from "node:os";
import type { WeaveEnv } from "./db";

export const LEASE_TABLE = "process_lease";
export const DEFAULT_LEASE_NAME = "host-background";
/** 默认 TTL：3 分钟。持有者靠 60 秒一次的向量定时器续期。 */
export const DEFAULT_LEASE_TTL_MS = 180_000;

export interface LeaseInfo {
  name: string;
  owner: string;
  pid: number | null;
  host: string | null;
  acquiredAt: number;
  heartbeatAt: number;
  expiresAt: number;
}

export interface LeaseOptions {
  name?: string;
  ttlMs?: number;
  owner?: string;
  pid?: number;
  host?: string;
}

export interface LeaseGuard {
  readonly name: string;
  readonly owner: string;
  readonly ttlMs: number;
  /** 续期，或抢占已过期的租约；返回是否由本句柄持有 */
  hold(now?: number): boolean;
  /** 只续期，不抢占 */
  renew(now?: number): boolean;
  /** 释放（只删自己持有的行） */
  release(): boolean;
  /** 当前租约快照；没有表 / 没有行时返回 null */
  info(): LeaseInfo | null;
}

type Row = Record<string, unknown>;

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function toInfo(r: Row): LeaseInfo {
  return {
    name: String(r.name),
    owner: String(r.owner),
    pid: num(r.pid),
    host: str(r.host),
    acquiredAt: Number(r.acquired_at ?? 0),
    heartbeatAt: Number(r.heartbeat_at ?? 0),
    expiresAt: Number(r.expires_at ?? 0),
  };
}

/**
 * 读当前租约。表不存在（只读连接打开的旧库、或还没跑 ensureSchema 的库）
 * 时返回 null，不抛错——后台任务缺席不该影响任何读路径。
 */
export function getLease(env: WeaveEnv, name: string = DEFAULT_LEASE_NAME): LeaseInfo | null {
  try {
    const r = env.db
      .prepare("SELECT name, owner, pid, host, acquired_at, heartbeat_at, expires_at FROM " + LEASE_TABLE + " WHERE name = ?")
      .get(name) as Row | undefined;
    return r ? toInfo(r) : null;
  } catch {
    return null;
  }
}

/**
 * 抢占或接管租约。
 * 允许接管的条件只有两个：已过期 / 本来就是自己。
 * owner 是每次创建句柄生成的随机 token，不是 pid：同 pid 的新进程不能
 * 因为 pid 相同就抢走还活着的租约。
 * 用一条 `INSERT ... ON CONFLICT ... WHERE` 完成，读-判-写之间不留给别的进程插队。
 */
export function acquireLease(
  env: WeaveEnv,
  opts: Required<Pick<LeaseOptions, "owner" | "ttlMs">> & LeaseOptions & { now?: number },
): boolean {
  if (env.readonly) return false;
  const name = opts.name ?? DEFAULT_LEASE_NAME;
  const now = opts.now ?? Date.now();
  const pid = opts.pid ?? process.pid;
  const host = opts.host ?? osHostname();
  try {
    env.db
      .prepare(
        "INSERT INTO " + LEASE_TABLE + " (name, owner, pid, host, acquired_at, heartbeat_at, expires_at)" +
          " VALUES (?, ?, ?, ?, ?, ?, ?)" +
          " ON CONFLICT(name) DO UPDATE SET" +
          " owner = excluded.owner, pid = excluded.pid, host = excluded.host," +
          " acquired_at = excluded.acquired_at, heartbeat_at = excluded.heartbeat_at, expires_at = excluded.expires_at" +
          " WHERE " + LEASE_TABLE + ".expires_at <= excluded.heartbeat_at" +
          " OR " + LEASE_TABLE + ".owner = excluded.owner",
      )
      .run(name, opts.owner, pid, host, now, now, now + opts.ttlMs);
    return getLease(env, name)?.owner === opts.owner;
  } catch {
    return false;
  }
}

/** 续期；不是自己持有就返回 false（不会误改别人） */
export function renewLease(
  env: WeaveEnv,
  name: string,
  owner: string,
  ttlMs: number,
  now: number = Date.now(),
): boolean {
  if (env.readonly) return false;
  try {
    const r = env.db
      .prepare("UPDATE " + LEASE_TABLE + " SET heartbeat_at = ?, expires_at = ? WHERE name = ? AND owner = ?")
      .run(now, now + ttlMs, name, owner);
    return r.changes === 1;
  } catch {
    return false;
  }
}

/** 释放；只删自己持有的行 */
export function releaseLease(env: WeaveEnv, name: string, owner: string): boolean {
  if (env.readonly) return false;
  try {
    const r = env.db.prepare("DELETE FROM " + LEASE_TABLE + " WHERE name = ? AND owner = ?").run(name, owner);
    return r.changes === 1;
  } catch {
    return false;
  }
}

/** 「pid 1234 @ host」这种能写进日志的标签 */
export function describeLease(lease: LeaseInfo | null): string {
  if (!lease) return "nobody";
  const who = lease.host ?? "unknown-host";
  const pid = lease.pid === null ? "?" : String(lease.pid);
  return "pid " + pid + " @ " + who;
}

/** 每个句柄唯一的 owner：host + pid + 随机后缀，用于区分同进程的多个句柄 */
function newOwner(): string {
  const suffix = Math.random().toString(36).slice(2, 10);
  return osHostname() + ":" + process.pid + ":" + suffix;
}

/**
 * 创建一个租约句柄。
 * 注意：句柄只是「操作入口」，创建本身不写库；第一次 `hold` 才会尝试接管
 * 这样打开只读库或纯测试场景不会产生任何写操作。
 */
export function createLeaseGuard(env: WeaveEnv, opts: LeaseOptions = {}): LeaseGuard {
  const name = opts.name ?? DEFAULT_LEASE_NAME;
  const ttlMs = opts.ttlMs ?? DEFAULT_LEASE_TTL_MS;
  const owner = opts.owner ?? newOwner();
  const pid = opts.pid ?? process.pid;
  const host = opts.host ?? osHostname();
  return {
    name,
    owner,
    ttlMs,
    hold(now: number = Date.now()): boolean {
      if (env.readonly) return false;
      if (renewLease(env, name, owner, ttlMs, now)) return true;
      return acquireLease(env, { name, owner, ttlMs, pid, host, now });
    },
    renew(now: number = Date.now()): boolean {
      return renewLease(env, name, owner, ttlMs, now);
    },
    release(): boolean {
      return releaseLease(env, name, owner);
    },
    info(): LeaseInfo | null {
      return getLease(env, name);
    },
  };
}
