/**
 * test/undo（§13.2.6 / M4「自动动作 100% 可撤销」）：undo_log 撤销台账
 * 覆盖 memory.write/update/archive/forget/restore、dream.status、dream.merge、
 * govern.resurrect（§12 weave_restore 找回被吞原文）、窗口过期拒绝与重复撤销拒绝。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openService } from "../src/host/index";
import type { WeaveService } from "../src/host/service";
import { appendUndo, type UndoRow } from "../src/store/dao";
import type { WeaveEnv } from "../src/store/db";

const DAY_MS = 86400000;

let dir: string;
let env: WeaveEnv;
let service: WeaveService;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memweave-undo-"));
  const rt = openService(dir);
  env = rt.env;
  service = rt.service;
});

afterEach(() => {
  service.stopMirror(false);
  env.close();
  rmSync(dir, { recursive: true, force: true });
});

function rowOf(action: string): UndoRow {
  const row = service.undoList().find((u) => u.action === action);
  expect(row, "undo row " + action).toBeDefined();
  return row as UndoRow;
}

describe("undo：撤销台账（§13.2.6）", () => {
  it("reset clears old undo records and prevents pre-reset resurrection", async () => {
    const remembered = await service.remember({ level: "fact", content: "reset should clear this memory" }, "human");
    const id = String(remembered.id);
    service.forget(id, "human");
    const staleUndoId = rowOf("memory.forget").id;
    const reset = await service.resetAll("human");
    expect(reset.ok).toBe(true);
    expect(service.undoList()).toHaveLength(0);
    const staleUndo = await service.undo(staleUndoId, "human");
    expect(staleUndo.ok).toBe(false);
    expect(staleUndo.code).toBe("E_VALID");
    expect(service.getMemory(id)).toBeNull();
  });
  it("memory.write：新写条目一键撤销归档，同一条只生效一次", async () => {
    const r = await service.remember({ level: "fact", content: "构建产物自动校验说明文本" }, "agent");
    expect(r.ok).toBe(true);
    expect(r.verdict).toBe("accepted");
    const id = String(r.id);

    const row = rowOf("memory.write");
    expect(row.target).toBe(id);
    expect(row.undone).toBe(false);

    const un = await service.undo(row.id, "human");
    expect(un.ok).toBe(true);
    expect(un.action).toBe("memory.write");
    expect(service.getMemory(id)?.status).toBe("archived");

    // 同一条只生效一次
    const again = await service.undo(row.id, "human");
    expect(again.ok).toBe(false);
    expect(again.code).toBe("E_VALID");
    expect(String(again.message)).toContain("already undone");
    expect(service.undoList().map((u) => u.id)).not.toContain(row.id);
  });

  it("memory.update：改写撤销回滚原文", async () => {
    const r = await service.remember({ level: "fact", content: "原始记录内容甲乙丙丁" }, "human");
    const id = String(r.id);
    const rv = service.revise(id, { content: "改写后的内容戊己庚辛" }, "human");
    expect(rv.ok).toBe(true);
    expect(service.getMemory(id)?.content).toBe("改写后的内容戊己庚辛");

    const un = await service.undo(rowOf("memory.update").id, "human");
    expect(un.ok).toBe(true);
    expect(service.getMemory(id)?.content).toBe("原始记录内容甲乙丙丁");
  });

  it("memory.archive / memory.restore 互逆", async () => {
    const r = await service.remember({ level: "fact", content: "可归档条目内容说明" }, "human");
    const id = String(r.id);

    service.archive(id, "human");
    expect(service.getMemory(id)?.status).toBe("archived");
    const un1 = await service.undo(rowOf("memory.archive").id, "human");
    expect(un1.ok).toBe(true);
    expect(service.getMemory(id)?.status).toBe("active");

    service.restore(id, "human");
    expect(service.getMemory(id)?.status).toBe("active");
    service.archive(id, "human");
    const un2 = await service.undo(rowOf("memory.restore").id, "human");
    expect(un2.ok).toBe(true);
    expect(service.getMemory(id)?.status).toBe("archived");
  });

  it("memory.forget：真删除可撤销，按台账原文重插", async () => {
    const r = await service.remember({ level: "fact", content: "长期留存的条目内容说明" }, "human");
    const id = String(r.id);

    service.forget(id, "human");
    expect(service.getMemory(id)).toBeNull();

    const un = await service.undo(rowOf("memory.forget").id, "human");
    expect(un.ok).toBe(true);
    const back = service.getMemory(id);
    expect(back).not.toBeNull();
    expect(back?.content).toBe("长期留存的条目内容说明");
    expect(back?.status).toBe("active");
    expect(back?.level).toBe("fact");
  });

  it("dream.status：过期标 stale 可回滚回原状态", async () => {
    const r = await service.remember(
      { level: "fact", content: "带有有效期的历史结论记录", validTo: Date.now() - 60000 },
      "human",
    );
    const id = String(r.id);

    const report = service.consolidate("dream");
    expect(report.ran).toBe(true);
    expect(service.getMemory(id)?.status).toBe("stale");

    const un = await service.undo(rowOf("dream.status").id, "human");
    expect(un.ok).toBe(true);
    expect(service.getMemory(id)?.status).toBe("active");
  });

  it("dream.merge：冷合并可撤（撤摘要 + 还原被归档成员）", async () => {
    const a = await service.remember({ level: "fact", content: "旧冷记忆甲条目内容" }, "human");
    const b = await service.remember({ level: "fact", content: "旧冷记忆乙条目内容" }, "human");
    const old = Date.now() - 200 * DAY_MS;
    for (const id of [String(a.id), String(b.id)]) {
      env.db.prepare("UPDATE fact SET updated_at = ?, created_at = ? WHERE id = ?").run(old, old, id);
    }

    const report = service.consolidate("dream");
    expect(report.ran).toBe(true);
    expect(report.merged).toBe(2);
    const topicId = String(report.topicId);
    expect(service.getMemory(topicId)?.status).toBe("active");
    expect(service.getMemory(String(a.id))?.status).toBe("archived");
    expect(service.getMemory(String(b.id))?.status).toBe("archived");

    const un = await service.undo(rowOf("dream.merge").id, "human");
    expect(un.ok).toBe(true);
    expect(service.getMemory(topicId)?.status).toBe("archived");
    expect(service.getMemory(String(a.id))?.status).toBe("active");
    expect(service.getMemory(String(b.id))?.status).toBe("active");
  });

  it("govern.resurrect：被近似合并吞掉的原文可找回（§12 weave_restore）", async () => {
    const a = await service.remember({ level: "fact", content: "主人偏爱像素风的游戏美术风格" }, "human");
    const b = await service.remember({ level: "fact", content: "主人偏爱像素风的游戏美术风格啊" }, "agent");
    expect(b.ok).toBe(true);
    expect(b.verdict).toBe("merged");
    expect(b.mergedInto).toBe(a.id);
    expect(service.listMemory({ level: "fact" })).toHaveLength(1);

    const un = await service.undo(rowOf("govern.resurrect").id, "human");
    expect(un.ok).toBe(true);
    const restored = service.listMemory({ level: "fact" });
    expect(restored).toHaveLength(2);
    const back = restored.find((e) => e.content === "主人偏爱像素风的游戏美术风格啊");
    expect(back).toBeDefined();
    expect(back?.status).toBe("active");
    expect(back?.id).not.toBe(a.id);
  });

  it("窗口：过期动作拒绝撤销（E_PERM），undoList 按窗口裁剪", async () => {
    const r = await service.remember({ level: "fact", content: "超窗条目内容记录" }, "human");
    const row = service.undoList().find((u) => u.action === "memory.write" && u.target === r.id) as UndoRow;
    env.db.prepare("UPDATE undo_log SET ts = ? WHERE id = ?").run(Date.now() - 48 * 3600000, row.id);

    const un = await service.undo(row.id, "human");
    expect(un.ok).toBe(false);
    expect(un.code).toBe("E_PERM");
    expect(service.getMemory(String(r.id))?.status).toBe("active");
    expect(service.undoList().map((u) => u.id)).not.toContain(row.id);
    expect(service.undoList(72).map((u) => u.id)).toContain(row.id);
  });

  it("undoList/undo 都尊重 governance.undoWindowHours（缺省 24h）", async () => {
    const old = Date.now() - 3 * 3600000;
    const id = appendUndo(env, {
      actor: "dream",
      action: "dream.status",
      target: "x",
      payload: { before: { status: "active", validTo: null } },
      now: old,
    });

    service.config.governance.undoWindowHours = 1;
    expect(service.undoList().map((u) => u.id)).not.toContain(id);
    expect(service.undoList(4).map((u) => u.id)).toContain(id);
    const un = await service.undo(id, "human");
    expect(un.ok).toBe(false);
    expect(un.code).toBe("E_PERM");

    service.config.governance.undoWindowHours = 6;
    expect(service.undoList().map((u) => u.id)).toContain(id);
  });

  it("非法目标：记录不存在 E_VALID；未知动作 E_UNAVAILABLE 且不消耗台账", async () => {
    const nf = await service.undo("no-such-undo-id", "human");
    expect(nf.ok).toBe(false);
    expect(nf.code).toBe("E_VALID");

    const badId = appendUndo(env, {
      actor: "dream",
      action: "bogus.action",
      target: "x",
      payload: {},
      now: Date.now(),
    });
    const bad = await service.undo(badId, "human");
    expect(bad.ok).toBe(false);
    expect(bad.code).toBe("E_UNAVAILABLE");
    // 未识别动作不标记 undone，留人工处理
    expect(service.undoList().map((u) => u.id)).toContain(badId);
  });
});
