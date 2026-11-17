/**
 * 跨进程后台租约。
 * 同一个库被多个进程打开时，dream / 向量索引只能由一个进程跑；
 * 别的进程照常读写与会话注入。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openWeaveDb, type WeaveEnv } from "../src/store/db";
import { ensureSchema } from "../src/store/migrate";
import {
  DEFAULT_LEASE_TTL_MS,
  acquireLease,
  createLeaseGuard,
  describeLease,
  getLease,
  releaseLease,
  renewLease,
} from "../src/store/lease";
import { openService } from "../src/host/index";

const T0 = 1_700_000_000_000;

let dir: string;
let env: WeaveEnv;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memweave-lease-"));
  env = openWeaveDb(dir, { readonly: false });
  ensureSchema(env);
});

afterEach(() => {
  env.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("租约表与原子抢占", () => {
  it("第一个进程拿到，未过期时第二个拿不到", () => {
    const a = createLeaseGuard(env, { owner: "a", pid: 100, host: "h1", ttlMs: 60_000 });
    const b = createLeaseGuard(env, { owner: "b", pid: 200, host: "h1", ttlMs: 60_000 });
    expect(a.hold(T0)).toBe(true);
    expect(b.hold(T0 + 1000)).toBe(false);
    expect(getLease(env)?.owner).toBe("a");
    expect(b.info()).toMatchObject({ owner: "a", pid: 100, host: "h1" });
  });

  it("过期后可以接管，接管者刷新 acquired_at", () => {
    const a = createLeaseGuard(env, { owner: "a", pid: 100, host: "h1", ttlMs: 60_000 });
    const b = createLeaseGuard(env, { owner: "b", pid: 200, host: "h1", ttlMs: 60_000 });
    expect(a.hold(T0)).toBe(true);
    expect(b.hold(T0 + 59_999)).toBe(false);
    expect(b.hold(T0 + 60_000)).toBe(true); // 到期时刻即可接管
    expect(getLease(env)).toMatchObject({ owner: "b", pid: 200, acquiredAt: T0 + 60_000 });
  });

  it("续期只作用于自己，续期后别人要继续等", () => {
    const a = createLeaseGuard(env, { owner: "a", pid: 100, host: "h1", ttlMs: 60_000 });
    const b = createLeaseGuard(env, { owner: "b", pid: 200, host: "h1", ttlMs: 60_000 });
    expect(a.hold(T0)).toBe(true);
    expect(b.renew(T0 + 1000)).toBe(false);
    expect(a.renew(T0 + 30_000)).toBe(true);
    expect(b.hold(T0 + 60_000)).toBe(false);
    expect(b.hold(T0 + 90_001)).toBe(true);
  });

  it("释放后立即可被抢占，且释放别人的租约无效", () => {
    const a = createLeaseGuard(env, { owner: "a", pid: 100, host: "h1", ttlMs: 60_000 });
    const b = createLeaseGuard(env, { owner: "b", pid: 200, host: "h1", ttlMs: 60_000 });
    expect(a.hold(T0)).toBe(true);
    expect(releaseLease(env, "host-background", "b")).toBe(false);
    expect(releaseLease(env, "host-background", "a")).toBe(true);
    expect(getLease(env)).toBeNull();
    expect(b.hold(T0 + 1)).toBe(true);
  });

  it("同一 host + pid 也不会因为 pid 相同就抢走活着的租约", () => {
    const old = createLeaseGuard(env, { owner: "old", pid: 100, host: "h1", ttlMs: 60_000 });
    const fresh = createLeaseGuard(env, { owner: "new", pid: 100, host: "h1", ttlMs: 60_000 });
    expect(old.hold(T0)).toBe(true);
    expect(fresh.hold(T0 + 1)).toBe(false);
    expect(getLease(env)?.owner).toBe("old");
    // 旧句柄释放后才能接管
    expect(old.release()).toBe(true);
    expect(fresh.hold(T0 + 2)).toBe(true);
  });

  it("pid 相同但 host 不同不算重启", () => {
    const a = createLeaseGuard(env, { owner: "a", pid: 100, host: "h1", ttlMs: 60_000 });
    const b = createLeaseGuard(env, { owner: "b", pid: 100, host: "h2", ttlMs: 60_000 });
    expect(a.hold(T0)).toBe(true);
    expect(b.hold(T0 + 1)).toBe(false);
  });

  it("租约名可区分：一个进程可以同时持有两个不同用途的租约", () => {
    const dream = createLeaseGuard(env, { name: "dream", owner: "a", pid: 100, host: "h1", ttlMs: 60_000 });
    const vector = createLeaseGuard(env, { name: "vector", owner: "b", pid: 200, host: "h1", ttlMs: 60_000 });
    expect(dream.hold(T0)).toBe(true);
    expect(vector.hold(T0)).toBe(true);
    expect(getLease(env, "dream")?.owner).toBe("a");
    expect(getLease(env, "vector")?.owner).toBe("b");
  });

  it("describeLease 给出可读的持有者标签", () => {
    expect(describeLease(null)).toBe("nobody");
    const a = createLeaseGuard(env, { owner: "a", pid: 321, host: "box", ttlMs: 60_000 });
    a.hold(T0);
    expect(describeLease(a.info())).toBe("pid 321 @ box");
  });
});

describe("缺表与只读库", () => {
  it("没有 process_lease 表时读不到、也抢不到，但不抛错", () => {
    const bare = openWeaveDb(mkdtempSync(join(tmpdir(), "memweave-bare-")), { readonly: false });
    try {
      expect(getLease(bare)).toBeNull();
      const g = createLeaseGuard(bare, { owner: "a", pid: 1, host: "h", ttlMs: 1000 });
      expect(g.hold(T0)).toBe(false);
      expect(g.info()).toBeNull();
      expect(renewLease(bare, "host-background", "a", 1000, T0)).toBe(false);
      expect(releaseLease(bare, "host-background", "a")).toBe(false);
    } finally {
      bare.close();
    }
  });

  it("只读连接不写租约，但能读到别人写的", () => {
    const a = createLeaseGuard(env, { owner: "a", pid: 100, host: "h1", ttlMs: 60_000 });
    expect(a.hold(T0)).toBe(true);
    const ro = openWeaveDb(dir, { readonly: true });
    try {
      const g = createLeaseGuard(ro, { owner: "ro", pid: 300, host: "h1", ttlMs: 60_000 });
      expect(g.hold(T0 + 1)).toBe(false);
      expect(g.renew(T0 + 1)).toBe(false);
      expect(getLease(ro)?.owner).toBe("a");
    } finally {
      ro.close();
    }
  });

  it("默认 TTL 是 3 分钟，供 60 秒一次的定时器续期", () => {
    expect(DEFAULT_LEASE_TTL_MS).toBe(180_000);
    const g = createLeaseGuard(env, { owner: "a", pid: 100, host: "h1" });
    expect(g.ttlMs).toBe(DEFAULT_LEASE_TTL_MS);
    g.hold(T0);
    expect(getLease(env)?.expiresAt).toBe(T0 + DEFAULT_LEASE_TTL_MS);
  });
});

describe("服务层接线", () => {
  it("openService 装配租约，本进程默认是持有者", () => {
    const rt = openService(dir);
    try {
      expect(rt.service.backgroundLease).not.toBeNull();
      const st = rt.service.backgroundLeaseStatus();
      expect(st.shared).toBe(true);
      expect(st.owned).toBe(true);
      expect(st.holder?.pid).toBe(process.pid);
      expect(rt.service.canRunBackground(T0)).toBe(true);
    } finally {
      rt.service.backgroundLease?.release();
      rt.env.close();
    }
  });

  it("另一个进程持有租约时，本进程不跑后台任务、也不启动向量重建", () => {
    const other = createLeaseGuard(env, { owner: "other", pid: 999_999, host: "other-host", ttlMs: 60_000 });
    expect(other.hold(Date.now())).toBe(true);

    const rt = openService(dir);
    try {
      // 不同 host 的另一个进程持有租约：本进程只有读权，不跑后台任务
      const st = rt.service.backgroundLeaseStatus();
      expect(st.owned).toBe(false);
      expect(st.holder).toMatchObject({ pid: 999_999, host: "other-host" });
      expect(rt.service.canRunBackground(Date.now())).toBe(false);

      const cfg = { enabled: true, baseUrl: "http://127.0.0.1:9/v1", model: "fake-embed", dimensions: 8 };
      const r = rt.service.configureEmbedding(cfg);
      expect(r.ok).toBe(true);
      expect(r.message).toContain("another process");
      // provider 仍可用（能查已有索引），但不会派生后台任务
      expect(rt.service.getEmbeddingProvider()).not.toBeNull();
    } finally {
      rt.service.backgroundLease?.release();
      rt.env.close();
      other.release();
    }
  });

  it("关闭连接会释放租约，同进程重开不必等 TTL", () => {
    const first = openService(dir);
    expect(first.service.backgroundLeaseStatus().owned).toBe(true);
    first.env.close();

    const second = openService(dir);
    try {
      expect(second.warnings.join("\n")).not.toContain("background lease");
      expect(second.service.backgroundLeaseStatus().owned).toBe(true);
    } finally {
      second.env.close();
    }
  });

  it("没有租约句柄时视为单进程：后台任务照常", () => {
    const rt = openService(dir);
    try {
      rt.service.backgroundLease = null;
      expect(rt.service.canRunBackground()).toBe(true);
      expect(rt.service.backgroundLeaseStatus()).toEqual({ shared: false, owned: true, holder: null });
      expect(rt.warnings.join("\n")).not.toContain("background lease");
    } finally {
      rt.env.close();
    }
  });

  it("旧持有者过期后，本进程下一次 hold 接管并恢复后台任务", () => {
    const rt = openService(dir);
    try {
      const guard = rt.service.backgroundLease!;
      const t0 = Date.now();
      expect(guard.hold(t0)).toBe(true);
      expect(rt.service.backgroundLeaseStatus().owned).toBe(true);

      // 另一个进程只在租约过期后才拿得到（这里显式把时间推到 TTL 之后）
      const other = createLeaseGuard(env, { owner: "other", pid: 999_999, host: "other-host", ttlMs: 1000 });
      const afterExpiry = t0 + DEFAULT_LEASE_TTL_MS;
      expect(other.hold(afterExpiry)).toBe(true);
      expect(guard.hold(afterExpiry + 1)).toBe(false);
      expect(rt.service.backgroundLeaseStatus().owned).toBe(false);
      // 对方 1 秒 TTL 过后，本进程接管
      expect(guard.hold(afterExpiry + 1001)).toBe(true);
      expect(rt.service.backgroundLeaseStatus()).toMatchObject({ owned: true, shared: true });
    } finally {
      rt.service.backgroundLease?.release();
      rt.env.close();
    }
  });
});

describe("acquireLease 直接调用", () => {
  it("走同一张表，与 guard 语义一致", () => {
    expect(acquireLease(env, { owner: "a", ttlMs: 1000, pid: 1, host: "h", now: T0 })).toBe(true);
    expect(acquireLease(env, { owner: "b", ttlMs: 1000, pid: 2, host: "h", now: T0 + 500 })).toBe(false);
    expect(acquireLease(env, { owner: "b", ttlMs: 1000, pid: 2, host: "h", now: T0 + 1001 })).toBe(true);
  });
});
