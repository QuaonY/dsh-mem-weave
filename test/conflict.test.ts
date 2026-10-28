/**
 * test/conflict（§15 / §8.4）：同 semanticKey 互斥结论 ⇒ 双方便都不注入
 * （S2 快照 / S3 增量 / 召回三路都不得出现），人工裁决后胜者恢复可注入。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openService } from "../src/host/index";
import type { WeaveService } from "../src/host/service";
import type { WeaveEnv } from "../src/store/db";

let dir: string;
let env: WeaveEnv;
let service: WeaveService;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memweave-conflict-"));
  const rt = openService(dir);
  env = rt.env;
  service = rt.service;
});

afterEach(() => {
  service.stopMirror(false);
  env.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("conflict：互斥结论两条都不注入（§8.4）", () => {
  it("冲突 open 期间两边都不注入，裁决后胜者恢复", async () => {
    const a = await service.remember(
      { level: "project", content: "构建发布只走本地脚本打包，不上 CI", semanticKey: "k.release" },
      "human",
    );
    expect(a.ok).toBe(true);
    const b = await service.remember(
      { level: "project", content: "夜间整理任务全部停用，不做任何自动维护", semanticKey: "k.release" },
      "human",
    );
    expect(b.ok).toBe(false);
    expect(b.code).toBe("E_CONFLICT");
    const conflictId = String(b.conflictId);

    // 冲突登记：open 状态、两个 contender
    const open = service.listConflicts("open");
    expect(open).toHaveLength(1);
    expect(open[0].contenders).toHaveLength(2);

    // ① S2 快照：两边都不得注入
    const preview = service.preview();
    const all = preview.s1.prefix + preview.s2 + preview.s3;
    expect(all).not.toContain("不上 CI");
    expect(all).not.toContain("夜间整理任务");
    const snap = service.snapshotItems().map((e) => e.id);
    expect(snap).not.toContain(a.id);

    // ② S3 增量：冻结条目不得出现在 delta
    const baseline = new Map<string, number>();
    const turn = service.renderTurn({ sessionId: "s-conf", first: false, query: "构建发布", baseline });
    const turnText = turn.result.s2 + turn.result.s3;
    expect(turnText).not.toContain("不上 CI");
    expect(turnText).not.toContain("夜间整理任务");

    // ③ 召回：冻结条目不命中
    const hits = service.recall("构建发布脚本");
    expect(hits.map((h) => h.id)).not.toContain(a.id);

    // 人工裁决：a 胜出 ⇒ 恢复可注入；b 侧候选被归档
    const r = service.resolveConflict(conflictId, String(a.id), "human");
    expect(r.ok).toBe(true);
    const after = service.preview();
    expect(after.s2).toContain("不上 CI");
    expect(service.recall("构建发布脚本").map((h) => h.id)).toContain(a.id);
  });
});
