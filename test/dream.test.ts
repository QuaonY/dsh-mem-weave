/**
 * dream 收梭管线测试（§8.7）：过期 stale / 冷记忆合并 / 租约 / 峰时 / 空闲 / 失败上限
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openWeaveDb, type WeaveEnv } from "../src/store/db";
import { ensureSchema } from "../src/store/migrate";
import { getLinks, getMemory, insertMemory, newId, restoreMemory } from "../src/store/dao";
import {
  acquireDreamLease,
  consolidateNow,
  dreamState,
  hourIn,
  isPeakHour,
  resetDreamFailures,
  runDream,
  type DreamConfigLike,
} from "../src/store/dream";
import { WeaveService, defaultConfig } from "../src/host/service";
import { logRecall } from "../src/store/link";
import { DISTILLED_SECTION } from "../src/store/dream-c";
import type { MemoryEntry } from "../src/core/types";

const DAY_MS = 86400000;

let dir: string;
let env: WeaveEnv;
let cfg: DreamConfigLike;

function entry(p: Partial<MemoryEntry> & { content: string }): MemoryEntry {
  const ts = p.updatedAt ?? Date.now();
  return {
    id: p.id ?? newId(),
    level: p.level ?? "fact",
    project: p.project ?? null,
    section: null,
    content: p.content,
    keywords: [],
    importance: 3,
    status: p.status ?? "active",
    semanticKey: null,
    confidence: null,
    validFrom: ts,
    validTo: p.validTo ?? null,
    evidence: [],
    hash: null,
    source: "test",
    accessCount: p.accessCount ?? 0,
    tier: "hot",
    createdAt: ts,
    updatedAt: ts,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memweave-dream-"));
  env = openWeaveDb(join(dir, "memweave"));
  ensureSchema(env);
  cfg = {
    enabled: true,
    idleMinutes: 0,
    timezone: "UTC",
    peakHours: [],
    leaseHours: 6,
    maxFailures: 3,
  };
});

afterEach(() => {
  env.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("轮①：valid_to 过期 → stale", () => {
  it("只标 stale 待人确认，不自动归档", () => {
    const now = Date.now();
    insertMemory(env, entry({ id: "e1", content: "临时授权已过期", validTo: now - 1000 }));
    insertMemory(env, entry({ id: "e2", content: "长期有效" }));

    const r = runDream(env, cfg, "dream", { force: true, now });
    expect(r.ran).toBe(true);
    expect(r.expired).toBe(1);
    expect(r.stalePending).toEqual(["e1"]);
    expect(getMemory(env, "e1")?.status).toBe("stale");
    expect(getMemory(env, "e1")?.status).not.toBe("archived");
    expect(getMemory(env, "e2")?.status).toBe("active");
    expect(dreamState(env).state).toBe("idle");
  });
});

describe("轮②：冷记忆合并进 topic", () => {
  it("≥2 条冷记忆合并、原条目归档且可 restore", () => {
    const old = Date.now() - 200 * DAY_MS;
    insertMemory(env, entry({ id: "c1", content: "旧事实甲", updatedAt: old }));
    insertMemory(env, entry({ id: "c2", content: "旧事实乙", updatedAt: old }));

    const r = runDream(env, cfg, "dream", { force: true });
    expect(r.ran).toBe(true);
    expect(r.merged).toBe(2);
    expect(r.topicId).toBeDefined();
    expect(r.mergedFrom.sort()).toEqual(["c1", "c2"]);

    const topic = getMemory(env, r.topicId as string);
    expect(topic?.level).toBe("topic");
    expect(topic?.content).toContain("[c1]");
    expect(topic?.content).toContain("[c2]");

    // 指针：links kind=merged
    const links = getLinks(env, r.topicId as string);
    expect(links.filter((l) => l.kind === "merged").map((l) => l.dst).sort()).toEqual(["c1", "c2"]);

    // 归档留指针，可人工恢复
    expect(getMemory(env, "c1")?.status).toBe("archived");
    restoreMemory(env, "c1", "human");
    expect(getMemory(env, "c1")?.status).toBe("active");
  });

  it("v0.6 M1 / M2：pending 约定、带日历锚点的冷条目不进合并", () => {
    const old = Date.now() - 200 * DAY_MS;
    insertMemory(env, entry({ id: "c1", content: "旧事实甲", updatedAt: old }));
    insertMemory(env, entry({ id: "c2", content: "旧事实乙", updatedAt: old }));
    // 本文件的 entry() 不带新字段：直接展开补上
    insertMemory(env, { ...entry({ id: "bd", content: "主人的生日", updatedAt: old }), calendarAnchor: { kind: "annual", month: 3, day: 12 } });
    insertMemory(env, { ...entry({ id: "pr", content: "答应的事", updatedAt: old }), dueAt: Date.now() + 30 * DAY_MS, promiseState: "pending" });
    insertMemory(env, { ...entry({ id: "kp", content: "已兑现的旧约定", updatedAt: old }), dueAt: old, promiseState: "kept" });
    const r = runDream(env, cfg, "dream", { force: true });
    expect(r.mergedFrom.sort()).toEqual(["c1", "c2", "kp"]);
    expect(getMemory(env, "bd")?.status).toBe("active");
    expect(getMemory(env, "pr")?.status).toBe("active");
  });

  it("不足 2 条冷记忆不合并", () => {
    insertMemory(env, entry({ id: "c1", content: "唯一冷记忆", updatedAt: Date.now() - 200 * DAY_MS }));
    const r = runDream(env, cfg, "dream", { force: true });
    expect(r.merged).toBe(0);
    expect(r.topicId).toBeUndefined();
    expect(getMemory(env, "c1")?.status).toBe("active");
  });

  it("rules/soul 与有召回、未满 6 月的条目不参与", () => {
    const old = Date.now() - 200 * DAY_MS;
    insertMemory(env, entry({ id: "r1", content: "规则：不许自动归档", level: "rules", updatedAt: old }));
    insertMemory(env, entry({ id: "s1", content: "灵魂设定", level: "soul", updatedAt: old }));
    insertMemory(env, entry({ id: "h1", content: "被召回过", updatedAt: old, accessCount: 3 }));
    insertMemory(env, entry({ id: "n1", content: "还很新", updatedAt: Date.now() - 10 * DAY_MS }));

    const r = runDream(env, cfg, "dream", { force: true });
    expect(r.merged).toBe(0);
    for (const id of ["r1", "s1", "h1", "n1"]) {
      expect(getMemory(env, id)?.status).toBe("active");
    }
  });
});

describe("v0.7.11：user 层不折叠，project 层按整个休眠项目折叠", () => {
  const old = () => Date.now() - 200 * DAY_MS;

  it("user 层 6 个月没动、没被召回也不折叠", () => {
    insertMemory(env, entry({ id: "u1", content: "主人喜欢简洁回复", level: "user", updatedAt: old() }));
    insertMemory(env, entry({ id: "u2", content: "主人不吃香菜", level: "user", updatedAt: old() }));
    const r = runDream(env, cfg, "dream", { force: true });
    expect(r.merged).toBe(0);
    expect(r.projectFolds).toEqual([]);
    expect(getMemory(env, "u1")?.status).toBe("active");
    expect(getMemory(env, "u2")?.status).toBe("active");
  });

  it("活跃项目里的旧条目不折叠：同项目有新条目、被召回过或有待结算约定都算活跃", () => {
    // 甲：有一条新近更新
    insertMemory(env, entry({ id: "a1", content: "甲项目旧约定一", level: "project", project: "甲", updatedAt: old() }));
    insertMemory(env, entry({ id: "a2", content: "甲项目旧约定二", level: "project", project: "甲", updatedAt: old() }));
    insertMemory(env, entry({ id: "a3", content: "甲项目最近进展", level: "project", project: "甲" }));
    // 乙：条目都旧，但其中一条近期被召回
    insertMemory(env, entry({ id: "b1", content: "乙项目旧约定一", level: "project", project: "乙", updatedAt: old() }));
    insertMemory(env, entry({ id: "b2", content: "乙项目旧约定二", level: "project", project: "乙", updatedAt: old() }));
    logRecall(env, ["b2"], "s-test", 1);
    // 丙：条目都旧，但同项目的 fact 层还有一条没结算的约定
    insertMemory(env, entry({ id: "c1", content: "丙项目旧约定一", level: "project", project: "丙", updatedAt: old() }));
    insertMemory(env, entry({ id: "c2", content: "丙项目旧约定二", level: "project", project: "丙", updatedAt: old() }));
    insertMemory(env, { ...entry({ id: "cp", content: "丙项目答应的事", project: "丙", updatedAt: old() }), dueAt: Date.now() + 30 * DAY_MS, promiseState: "pending" });

    const r = runDream(env, cfg, "dream", { force: true });
    expect(r.projectFolds).toEqual([]);
    for (const id of ["a1", "a2", "a3", "b1", "b2", "c1", "c2", "cp"]) {
      expect(getMemory(env, id)?.status).toBe("active");
    }
  });

  it("整个项目休眠后整组折叠成一条项目摘要，每个项目各一条；没填项目名的不折叠", () => {
    insertMemory(env, entry({ id: "d1", content: "丁项目旧约定一", level: "project", project: "丁", updatedAt: old() }));
    insertMemory(env, entry({ id: "d2", content: "丁项目旧约定二", level: "project", project: "丁", updatedAt: old(), accessCount: 5 }));
    insertMemory(env, entry({ id: "e1", content: "戊项目旧约定一", level: "project", project: "戊", updatedAt: old() }));
    insertMemory(env, entry({ id: "e2", content: "戊项目旧约定二", level: "project", project: "戊", updatedAt: old() }));
    insertMemory(env, entry({ id: "n1", content: "无项目名的旧约定一", level: "project", updatedAt: old() }));
    insertMemory(env, entry({ id: "n2", content: "无项目名的旧约定二", level: "project", updatedAt: old() }));

    const r = runDream(env, cfg, "dream", { force: true });
    expect(r.merged).toBe(4);
    expect(r.topicId).toBeUndefined(); // 没有 fact/lesson/topic 冷记忆
    const folds = r.projectFolds ?? [];
    expect(folds.map((f) => f.project)).toEqual(["丁", "戊"]);
    expect(folds[0].memberIds.sort()).toEqual(["d1", "d2"]); // 很久以前被用过也算休眠，只看近期
    for (const f of folds) {
      const topic = getMemory(env, f.topicId);
      expect(topic?.level).toBe("topic");
      expect(topic?.project).toBe(f.project);
      expect(topic?.content).toContain("休眠项目「" + f.project + "」");
      expect(getLinks(env, f.topicId).filter((l) => l.kind === "merged").map((l) => l.dst).sort()).toEqual([...f.memberIds].sort());
      for (const id of f.memberIds) expect(getMemory(env, id)?.status).toBe("archived");
    }
    expect(getMemory(env, "n1")?.status).toBe("active");
    expect(getMemory(env, "n2")?.status).toBe("active");

    // 折叠摘要本身是新的，不会让项目重新算活跃；再跑一轮也不会重复折叠
    const again = runDream(env, cfg, "dream", { force: true });
    expect(again.merged).toBe(0);
  });

  it("项目只剩 1 条旧条目不折叠；dream 写的项目主题索引不算活跃", () => {
    insertMemory(env, entry({ id: "f1", content: "己项目唯一旧约定", level: "project", project: "己", updatedAt: old() }));
    insertMemory(env, entry({ id: "g1", content: "庚项目旧约定一", level: "project", project: "庚", updatedAt: old() }));
    insertMemory(env, entry({ id: "g2", content: "庚项目旧约定二", level: "project", project: "庚", updatedAt: old() }));
    insertMemory(env, { ...entry({ id: "gx", content: "项目「庚」主题索引", level: "project", project: "庚" }), section: DISTILLED_SECTION });

    const r = runDream(env, cfg, "dream", { force: true });
    expect(getMemory(env, "f1")?.status).toBe("active");
    const folds = r.projectFolds ?? [];
    expect(folds.map((f) => f.project)).toEqual(["庚"]);
    expect(folds[0].memberIds.sort()).toEqual(["g1", "g2"]); // 主题索引是新的，本轮不进折叠
  });

  it("休眠项目折叠可撤销：撤摘要、还原成员", async () => {
    const service = new WeaveService(env, defaultConfig(dir));
    service.config.dream.enabled = true;
    insertMemory(env, entry({ id: "h1", content: "辛项目旧约定一", level: "project", project: "辛", updatedAt: old() }));
    insertMemory(env, entry({ id: "h2", content: "辛项目旧约定二", level: "project", project: "辛", updatedAt: old() }));
    const r = service.consolidate("dream");
    const fold = (r.projectFolds ?? [])[0];
    expect(fold?.project).toBe("辛");
    const row = service.undoList().find((u) => u.action === "dream.merge" && u.target === fold.topicId);
    expect(row).toBeDefined();
    const un = await service.undo(row!.id, "human");
    expect(un.ok).toBe(true);
    expect(getMemory(env, fold.topicId)?.status).toBe("archived");
    expect(getMemory(env, "h1")?.status).toBe("active");
    expect(getMemory(env, "h2")?.status).toBe("active");
    service.stopMirror(false);
  });

  it("fact 层冷合并照旧，和休眠项目各自出摘要", () => {
    insertMemory(env, entry({ id: "k1", content: "旧事实甲", updatedAt: old() }));
    insertMemory(env, entry({ id: "k2", content: "旧事实乙", updatedAt: old() }));
    insertMemory(env, entry({ id: "m1", content: "壬项目旧约定一", level: "project", project: "壬", updatedAt: old() }));
    insertMemory(env, entry({ id: "m2", content: "壬项目旧约定二", level: "project", project: "壬", updatedAt: old() }));
    const r = runDream(env, cfg, "dream", { force: true });
    expect(r.merged).toBe(4);
    expect(r.topicId).toBeDefined();
    expect(getMemory(env, r.topicId as string)?.content).toContain("[k1]");
    expect(getMemory(env, r.topicId as string)?.content).not.toContain("[m1]");
    expect((r.projectFolds ?? []).map((f) => f.project)).toEqual(["壬"]);
    expect(r.mergedFrom.sort()).toEqual(["k1", "k2", "m1", "m2"]);
  });
});

describe("租约与失败上限", () => {
  it("租约互斥、过期后可被他人重获", () => {
    const now = Date.now();
    const leaseMs = 3600000;
    expect(acquireDreamLease(env, "a", now, leaseMs)).toBe(true);
    expect(acquireDreamLease(env, "b", now, leaseMs)).toBe(false);
    expect(acquireDreamLease(env, "a", now, leaseMs)).toBe(true); // 同主可续
    expect(acquireDreamLease(env, "b", now + leaseMs + 1, leaseMs)).toBe(true);
  });

  it("failures-limit 锁死后 resetDreamFailures 解锁", () => {
    env.db.prepare("INSERT INTO dream_state (id, failures) VALUES (1, 3) ON CONFLICT(id) DO UPDATE SET failures = 3").run();
    expect(runDream(env, cfg, "dream", { force: true }).reason).toBe("failures-limit");
    expect(consolidateNow(env, cfg).reason).toBe("failures-limit");

    resetDreamFailures(env);
    expect(dreamState(env).failures).toBe(0);
    expect(consolidateNow(env, cfg).ran).toBe(true);
  });

  it("管线异常计入失败次数并写审计", () => {
    env.db.exec("DROP TABLE IF EXISTS fact");
    const r = runDream(env, cfg, "dream", { force: true });
    expect(r.ran).toBe(false);
    expect(r.reason.startsWith("error:")).toBe(true);
    expect(r.failures).toBe(1);
    const st = dreamState(env);
    expect(st.failures).toBe(1);
    expect(st.state).toBe("failed");
  });
});

describe("自动触发门槛（空闲 / 峰时）", () => {
  it("峰时跳过；空峰时表照跑", () => {
    // UTC 03:00
    const now = Date.UTC(2026, 0, 1, 3, 0, 0);
    const allDay: DreamConfigLike = { ...cfg, peakHours: [[0, 24]] };
    expect(runDream(env, allDay, "dream", { now }).reason).toBe("peak-hours");

    const open: DreamConfigLike = { ...cfg, peakHours: [] };
    expect(runDream(env, open, "dream", { now }).ran).toBe(true);
  });

  it("跨零点峰时区间生效", () => {
    expect(isPeakHour(Date.UTC(2026, 0, 1, 23, 0, 0), "UTC", [[22, 2]])).toBe(true);
    expect(isPeakHour(Date.UTC(2026, 0, 1, 12, 0, 0), "UTC", [[22, 2]])).toBe(false);
    expect(hourIn("UTC", Date.UTC(2026, 0, 1, 3, 0, 0))).toBe(3);
  });

  it("空闲不足跳过 busy，force 可跑", () => {
    insertMemory(env, entry({ id: "x1", content: "刚写的记忆" })); // updatedAt = 现在
    const busy: DreamConfigLike = { ...cfg, idleMinutes: 180 };
    expect(runDream(env, busy, "dream").reason).toBe("busy");
    expect(runDream(env, busy, "dream", { force: true }).ran).toBe(true);
  });
});

describe("service 接线", () => {
  it("consolidate(resetFailures) 解锁后跑通，dreamStatus 带 due/peak", () => {
    const service = new WeaveService(env, defaultConfig(dir));
    env.db.prepare("INSERT INTO dream_state (id, failures) VALUES (1, 3) ON CONFLICT(id) DO UPDATE SET failures = 3").run();
    expect(service.consolidate("human").reason).toBe("failures-limit");

    const r = service.consolidate("human", { resetFailures: true });
    expect(r.ran).toBe(true);

    const st = service.dreamStatus();
    expect(typeof st.due).toBe("boolean");
    expect(typeof st.peak).toBe("boolean");
  });
});
