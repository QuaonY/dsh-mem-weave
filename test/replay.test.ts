/**
 * roadmap v0.4 R8：重播强化——同一轮召回注入里共同出现的两条记忆之间加 co-recall 边。
 * （G7 压缩后重放的测试在 compact-replay.test.ts）
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openService } from "../src/host/index";
import type { WeaveService } from "../src/host/service";
import type { WeaveEnv } from "../src/store/db";
import { insertMemory } from "../src/store/dao";
import { DEFAULT_CORECALL, reinforceCoRecall } from "../src/store/dream-c";
import { logRecall } from "../src/store/link";
import { entry } from "./link-health.test";

const DAY = 86400000;
let dir: string;
let env: WeaveEnv;
let service: WeaveService;

const co = (): Array<{ src: string; dst: string; weight: number }> =>
  env.db.prepare("SELECT src, dst, weight FROM links WHERE kind = 'co-recall' ORDER BY src, dst").all() as never;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memweave-r8-"));
  const rt = openService(dir);
  env = rt.env;
  service = rt.service;
  for (const id of ["a", "b", "c"]) insertMemory(env, entry({ id, content: "条目" + id }));
});

afterEach(() => {
  service.stopMirror(false);
  env.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("R8 重播强化", () => {
  it("共激活对：新建边 0.3，再次共激活 +0.1；同一批记录不重复加权", () => {
    const now = Date.now();
    logRecall(env, ["a", "b"], "s1", 1, now - 1000);
    let r = reinforceCoRecall(env, DEFAULT_CORECALL, "dream", now);
    expect(r).toMatchObject({ pairs: 1, created: 1, reinforced: 0 });
    expect(co()).toEqual([{ src: "a", dst: "b", weight: 0.3 }]);

    // 同一批不再算
    r = reinforceCoRecall(env, DEFAULT_CORECALL, "dream", now + 10);
    expect(r.pairs).toBe(0);
    expect(co()[0].weight).toBe(0.3);

    logRecall(env, ["a", "b", "c"], "s2", 4, now + 20);
    r = reinforceCoRecall(env, DEFAULT_CORECALL, "dream", now + 30);
    expect(r).toMatchObject({ pairs: 3, created: 2, reinforced: 1 });
    expect(co()).toEqual([
      { src: "a", dst: "b", weight: 0.4 },
      { src: "a", dst: "c", weight: 0.3 },
      { src: "b", dst: "c", weight: 0.3 },
    ]);
  });

  it("上限 2.0；只看近 7 天；不同轮不算共激活", () => {
    const now = Date.now();
    for (let t = 0; t < 30; t += 1) logRecall(env, ["a", "b"], "s", t, now - 1000 + t);
    logRecall(env, ["a", "c"], "old", 1, now - 8 * DAY);
    logRecall(env, ["b"], "x", 1, now - 500);
    logRecall(env, ["c"], "x", 2, now - 400);
    reinforceCoRecall(env, DEFAULT_CORECALL, "dream", now);
    expect(co()).toEqual([{ src: "a", dst: "b", weight: 2 }]);
  });

  it("90 天没强化的边 ×0.8，低于 0.1 删除；可撤销", async () => {
    const now = Date.now();
    env.db.prepare("INSERT INTO links (src, dst, kind, weight, created_at) VALUES ('a','b','co-recall',1,?), ('a','c','co-recall',0.11,?)").run(now - 91 * DAY, now - 91 * DAY);
    const r = reinforceCoRecall(env, DEFAULT_CORECALL, "dream", now);
    expect(r).toMatchObject({ decayed: 1, removed: 1 });
    expect(co()).toEqual([{ src: "a", dst: "b", weight: 0.8 }]);
    // 衰减后刷新时间，紧接着再跑不会二次衰减
    expect(reinforceCoRecall(env, DEFAULT_CORECALL, "dream", now + 1).decayed).toBe(0);
    const u = service.undoList().find((x) => x.action === "dream.co-recall")!;
    expect((await service.undo(u.id, "human")).ok).toBe(true);
    expect(co()).toEqual([
      { src: "a", dst: "b", weight: 1 },
      { src: "a", dst: "c", weight: 0.11 },
    ]);
  });

  it("关闭开关 → 不建边", () => {
    logRecall(env, ["a", "b"], "s1", 1, Date.now() - 1000);
    reinforceCoRecall(env, { ...DEFAULT_CORECALL, enabled: false }, "dream");
    expect(co()).toHaveLength(0);
  });
});
