/**
 * test/persona-write（§15 / §7.6 写权）：AI 写人格字段必须失败
 * 两条路径都断言：RPC（humanOnly → 403 E_PERM）与工具（weave_persona update → E_PERM）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openService } from "../src/host/index";
import { buildTools, type WeaveTool } from "../src/host/tools";
import { invokeRpc } from "../src/host/rpc";
import type { WeaveService } from "../src/host/service";
import type { WeaveEnv } from "../src/store/db";

let dir: string;
let env: WeaveEnv;
let service: WeaveService;
let tools: Map<string, WeaveTool>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memweave-persona-write-"));
  const rt = openService(dir);
  env = rt.env;
  service = rt.service;
  tools = new Map(buildTools(service).map((t) => [t.descriptor.name, t]));
});

afterEach(() => {
  service.stopMirror(false);
  env.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("persona-write：AI 写人格必须失败（写权断言）", () => {
  it("工具路径：weave_persona update / weave_preset apply 一律 E_PERM", async () => {
    const persona = tools.get("weave_persona") as WeaveTool;
    const upd = await persona.handler({ action: "update", patch: { stance: "AI 想改人格" } });
    expect(upd.ok).toBe(false);
    expect(upd.code).toBe("E_PERM");
    // 人格未被改动
    expect(service.persona().config.stance).not.toContain("AI 想改人格");

    const preset = tools.get("weave_preset") as WeaveTool;
    const apply = await preset.handler({ action: "apply", id: "x" });
    expect(apply.ok).toBe(false);
    expect(apply.code).toBe("E_PERM");

    // 裁决类同样只归人
    const pending = (tools.get("weave_pending") as WeaveTool);
    const decide = await pending.handler({ decide: "accepted", id: "c1" });
    expect(decide.ok).toBe(false);
    expect(decide.code).toBe("E_PERM");
    const resolve = await (tools.get("weave_resolve") as WeaveTool).handler({ resolve: true, id: "k1" });
    expect(resolve.ok).toBe(false);
    expect(resolve.code).toBe("E_PERM");
  });

  it("AI confirm=true 不能永久删除记忆", async () => {
    const remembered = await service.remember({ level: "fact", content: "保留这条记忆" }, "human");
    expect(remembered.id).toBeTruthy();
    const forget = tools.get("weave_forget") as WeaveTool;
    const result = await forget.handler({ id: remembered.id, confirm: true });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("E_PERM");
    expect(service.getMemory(remembered.id as string)?.content).toBe("保留这条记忆");
  });

  it("memory revisions cannot bypass content governance or status permissions", async () => {
    const remembered = await service.remember({ level: "fact", content: "普通的可修订记忆内容" }, "human");
    const id = String(remembered.id);
    const sensitive = service.revise(id, { content: "password: NotARealCredential123" }, "agent");
    expect(sensitive.ok).toBe(false);
    expect(sensitive.code).toBe("E_SENSITIVE");
    const status = service.revise(id, { status: "archived" }, "agent");
    expect(status.ok).toBe(false);
    expect(status.code).toBe("E_PERM");
    expect(service.getMemory(id)?.content).toBe("普通的可修订记忆内容");
    expect(service.getMemory(id)?.status).toBe("active");
  });


  it("settings/update 深合并嵌套配置并保留未修改项", async () => {
    await invokeRpc(service, "memweave.settings/update", { patch: { budget: { snapshotMaxChars: 2500 } } }, "human");
    await invokeRpc(service, "memweave.settings/update", { patch: { governance: { autoAcceptLowRisk: false } } }, "human");

    expect(service.config.budget.snapshotMaxChars).toBe(2500);
    expect(service.config.budget.deltaMaxChars).toBeGreaterThan(0);
    expect(service.config.governance.autoAcceptLowRisk).toBe(false);
    expect(service.config.governance.requireConfirmFor).toContain("rules");
  });

  it("persona history restore applies the saved version and exposes reload failure", async () => {
    const first = service.updatePersona({ stance: "first saved stance" }, "human");
    service.updatePersona({ stance: "later stance" }, "human");
    const current = service.persona().version;
    const restored = await invokeRpc(service, "memweave.persona/history.restore", {
      version: first.version,
      expectedVersion: current,
    }, "human") as Record<string, unknown>;
    expect(restored.ok).toBe(true);
    expect(restored.reloadOk).toBe(false);
    expect(service.persona().config.stance).toBe("first saved stance");
  });
  it("RPC 路径：actor=agent 调人格/预设/裁决/重置类一律 403 E_PERM", async () => {
    const denied: Array<[string, Record<string, unknown>]> = [
      ["memweave.persona/update", { patch: { stance: "AI 想改人格" } }],
      ["memweave.persona/history.restore", { version: 1 }],
      ["memweave.preset/apply", { id: "x" }],
      ["memweave.preset/import", { id: "x", payload: {} }],
      ["memweave.card/update", { cards: [] }],
      ["memweave.candidates/decide", { id: "c1", verdict: "accepted" }],
      ["memweave.conflicts/resolve", { id: "k1", winnerId: null }],
      ["memweave.import/run", { payload: {} }],
      ["memweave.import/rollback", { rollbackId: "imp-x" }],
      ["memweave.backup/now", {}],
      ["memweave.backup/restore", { path: "C:\\outside.db" }],
      ["memweave.settings/update", { patch: {} }],
      ["memweave.reset/run", { confirm: "RESET" }],
    ];
    for (const [id, args] of denied) {
      const r = (await invokeRpc(service, id, args, "agent")) as Record<string, unknown>;
      expect(r.ok, id).toBe(false);
      expect(r.code, id).toBe("E_PERM");
      expect(r.status, id).toBe(403);
    }
    expect(service.persona().config.stance).not.toContain("AI 想改人格");

    // 人工路径可用（对照）
    const ok = (await invokeRpc(
      service,
      "memweave.persona/update",
      { patch: { stance: "主人设定的立场" } },
      "human",
    )) as { ok: boolean; version?: number };
    expect(ok.ok).toBe(true);
    expect(service.persona().config.stance).toBe("主人设定的立场");
  });
});
