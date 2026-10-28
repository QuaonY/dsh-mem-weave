/**
 * test/reload-config（§13.2.2 立即 reload / 附录 A 配置接线）：
 * persona/reload RPC（humanOnly）+ reloadHook 重装配；memory/recall/lifecycle/governance 死键全部生效。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import plugin, { openService } from "../src/host/index";
import { invokeRpc } from "../src/host/rpc";
import type { WeaveService } from "../src/host/service";
import type { WeaveEnv } from "../src/store/db";

const DAY_MS = 86400000;

let dir: string;
let env: WeaveEnv;
let service: WeaveService;
let sections: Map<string, string>;

function makeCtx(): unknown {
  const host = {
    section(spec: { name: string; order: number; text: string }): () => void {
      sections.set(spec.name, spec.text);
      return () => {
        sections.delete(spec.name);
      };
    },
    getSectionOrder(): number | undefined {
      return undefined;
    },
  };
  return {
    get(key: string): unknown {
      return key === "systemPrompt" ? host : undefined;
    },
    logger: { warn: () => undefined },
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memweave-reload-cfg-"));
  const rt = openService(dir);
  env = rt.env;
  service = rt.service;
  sections = new Map();
});

afterEach(() => {
  plugin.dispose();
  service.stopMirror(false);
  env.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("reload：人格段位重装配（§13.2.2）", () => {
  it("plugin.apply 注册 reloadHook，service.reload() 触发段位重装配（I4 唯一解冻入口）", async () => {
    service.updatePersona({ stance: "初始立场块内容" }, "human");
    plugin.apply(makeCtx(), { dataDir: dir });
    await new Promise((r) => setTimeout(r, 80));

    // 装配后：reloadHook 已接成 rebuildSections（memweave.persona/reload 的生效通道）
    const svc = plugin.runtime()?.service;
    expect(svc).toBeDefined();
    expect(svc?.reloadHook).toBeTypeOf("function");
    expect(sections.get("deployment:persona-prefix") ?? "").toContain("初始立场块内容");

    // 改人格 → service.reload()（persona/reload RPC 同一入口）→ 段位重新装配
    service.updatePersona({ stance: "改后立场块内容" }, "human");
    expect(svc?.reload().ok).toBe(true);
    const text = sections.get("deployment:persona-prefix") ?? "";
    expect(text).toContain("改后立场块内容");
    expect(text).not.toContain("初始立场块内容");
  });

  it("service.reload：无宿主 E_UNAVAILABLE；hook 即触发；hook 抛错不冒泡", () => {
    service.reloadHook = null;
    const none = service.reload();
    expect(none.ok).toBe(false);
    expect(none.code).toBe("E_UNAVAILABLE");

    let calls = 0;
    service.reloadHook = () => {
      calls += 1;
    };
    expect(service.reload().ok).toBe(true);
    expect(calls).toBe(1);

    service.reloadHook = () => {
      throw new Error("section host boom");
    };
    const bad = service.reload();
    expect(bad.ok).toBe(false);
    expect(bad.code).toBe("E_UNAVAILABLE");
  });

  it("RPC persona/reload：humanOnly，人工触发立即生效", async () => {
    const denied = (await invokeRpc(service, "memweave.persona/reload", {}, "agent")) as Record<string, unknown>;
    expect(denied.ok).toBe(false);
    expect(denied.code).toBe("E_PERM");
    expect(denied.status).toBe(403);

    let calls = 0;
    service.reloadHook = () => {
      calls += 1;
    };
    const ok = (await invokeRpc(service, "memweave.persona/reload", {}, "human")) as Record<string, unknown>;
    expect(ok.ok).toBe(true);
    expect(calls).toBe(1);

    service.reloadHook = null;
    const noHost = (await invokeRpc(service, "memweave.persona/reload", {}, "human")) as Record<string, unknown>;
    expect(noHost.ok).toBe(false);
    expect(noHost.code).toBe("E_UNAVAILABLE");
  });

  it("RPC undo/list、undo/run：humanOnly（agent 一律 403 E_PERM）", async () => {
    for (const [id, args] of [
      ["memweave.undo/list", {}],
      ["memweave.undo/run", { id: "x" }],
    ] as Array<[string, Record<string, unknown>]>) {
      const r = (await invokeRpc(service, id, args, "agent")) as Record<string, unknown>;
      expect(r.ok, id).toBe(false);
      expect(r.code, id).toBe("E_PERM");
      expect(r.status, id).toBe(403);
    }

    const w = await service.remember({ level: "fact", content: "RPC 回滚链路验证条目" }, "human");
    const list = (await invokeRpc(service, "memweave.undo/list", {}, "human")) as Record<string, unknown>;
    expect(list.ok).toBe(true);
    expect(list.windowHours).toBe(service.config.governance.undoWindowHours);
    const items = list.items as Array<{ action: string; target: string; id: string }>;
    const row = items.find((u) => u.action === "memory.write" && u.target === w.id);
    expect(row).toBeDefined();

    const run = (await invokeRpc(service, "memweave.undo/run", { id: row?.id }, "human")) as Record<string, unknown>;
    expect(run.ok).toBe(true);
    expect(service.getMemory(String(w.id))?.status).toBe("archived");
  });
});

describe("config：附录 A 配置面全部接线", () => {
  it("缺省值与附录 A 精确一致", () => {
    const c = service.config;
    expect(c.memory.hitTopK).toBe(5);
    expect(c.recall.routes).toEqual(["keyword", "link"]);
    expect(c.recall.rrfK).toBe(60);
    expect(c.recall.weights).toEqual({ keyword: 1, semantic: 0.8, link: 0.5 });
    expect(c.lifecycle.halfLifeDays).toEqual({
      topic: 30,
      fact: 90,
      project: 180,
      user: 365,
      soul: 365,
      lesson: 365,
      rules: 0,
    });
    expect(c.lifecycle.coldMemoryMonths).toBe(6);
    expect(c.lifecycle.mergeOnDream).toBe(true);
    expect(c.governance.autoAcceptLowRisk).toBe(true);
    expect(c.governance.undoWindowHours).toBe(24);
    expect(c.governance.requireConfirmFor).toEqual(["rules", "soul", "persona", "delete"]);
    expect(c.governance.sensitivePatterns).toBe("default");
  });

  it("memory.hitTopK：限制每条消息召回命中数", async () => {
    // 正文需足够不同：只差一个字的条目会被 R9 包含度判据合并（roadmap v0.2）
    for (const s of ["周一买了苹果", "周二修好自行车", "周三去图书馆借书", "周四学会做红烧肉", "周五和朋友看电影", "周六整理衣柜"]) {
      await service.remember({ level: "fact", content: "检索锚点：" + s }, "human");
    }
    service.config.memory.hitTopK = 2;
    expect(service.recall("检索锚点")).toHaveLength(2);
    service.config.memory.hitTopK = 4;
    expect(service.recall("检索锚点")).toHaveLength(4);
  });

  it("governance.requireConfirmFor：裁剪二次确认面", async () => {
    // 缺省 rules 需确认 → 进候选
    const a = await service.remember({ level: "rules", content: "每次构建前必须跑全量回归" }, "human");
    expect(a.ok).toBe(true);
    expect(a.verdict).toBe("pending");
    expect(service.listCandidates("pending")).toHaveLength(1);

    // 放开后 rules 直接入库（AI 低风险写）
    service.config.governance.requireConfirmFor = ["delete"];
    const b = await service.remember({ level: "rules", content: "每次发布前必须核对版本号" }, "agent");
    expect(b.ok).toBe(true);
    expect(b.verdict).toBe("accepted");
    expect(service.getMemory(String(b.id))?.content).toBe("每次发布前必须核对版本号");
  });

  it("governance.autoAcceptLowRisk=false：AI 低风险写进候选待人裁", async () => {
    service.config.governance.autoAcceptLowRisk = false;
    const a = await service.remember({ level: "fact", content: "构建产物存放于发布目录" }, "agent");
    expect(a.ok).toBe(true);
    expect(a.verdict).toBe("pending");
    const cand = service.listCandidates("pending").find((c) => c.id === a.id);
    expect(cand?.reason).toBe("auto-accept-off");

    service.config.governance.autoAcceptLowRisk = true;
    const b = await service.remember({ level: "fact", content: "发布产物留存目录说明文本" }, "agent");
    expect(b.verdict).toBe("accepted");
  });

  it("governance.sensitivePatterns：附加正则拦截且不回显原文；坏正则跳过", async () => {
    service.config.governance.sensitivePatterns = ["内部代号-\\d+"];
    const hit = await service.remember({ level: "fact", content: "部署顺序为内部代号-7 先灰度后全量" }, "agent");
    expect(hit.ok).toBe(false);
    expect(hit.code).toBe("E_SENSITIVE");
    expect(String(hit.message)).not.toContain("内部代号");

    service.config.governance.sensitivePatterns = ["[未闭合"];
    const ok = await service.remember({ level: "fact", content: "部署顺序为内部代号-7 先灰度后全量" }, "agent");
    expect(ok.ok).toBe(true);
  });

  it("recall.synonymsFile：外部同义词表参与检索归一；坏文件降级为空", async () => {
    const synPath = join(dir, "syn.json");
    writeFileSync(synPath, JSON.stringify([["构建", "打包"]]), "utf8");
    service.config.recall.synonymsFile = synPath;

    const r = await service.remember({ level: "fact", content: "打包流水线说明：产物自动校验" }, "human");
    const hits = service.recall("构建流水线说明：产物自动校验");
    expect(hits.map((h) => h.id)).toContain(r.id);

    // 文件更新后按 mtime 重读
    writeFileSync(synPath, JSON.stringify([["构建", "打包"], ["像素风", "像素"]]), "utf8");
    expect(service.fileAliasGroups()).toHaveLength(2);

    service.config.recall.synonymsFile = join(dir, "missing.json");
    expect(service.fileAliasGroups()).toEqual([]);
    expect(() => service.recall("构建流水线")).not.toThrow();

    const badPath = join(dir, "bad.json");
    writeFileSync(badPath, "not-json", "utf8");
    service.config.recall.synonymsFile = badPath;
    expect(service.fileAliasGroups()).toEqual([]);
    expect(service.recall("构建流水线").length).toBeGreaterThanOrEqual(0);
  });

  it("lifecycle.mergeOnDream / coldMemoryMonths：控制冷合并开关与窗口", async () => {
    const mkCold = async (content: string) => {
      const r = await service.remember({ level: "fact", content }, "human");
      const id = String(r.id);
      const old = Date.now() - 200 * DAY_MS;
      env.db.prepare("UPDATE fact SET updated_at = ?, created_at = ? WHERE id = ?").run(old, old, id);
      return id;
    };
    await mkCold("旧冷记忆丙条目内容");
    await mkCold("旧冷记忆丁条目内容");

    // 合并开关关掉：不合并
    service.config.lifecycle.mergeOnDream = false;
    expect(service.consolidate("dream").merged).toBe(0);

    // 窗口拉长到 12 个月：200 天不算冷
    service.config.lifecycle.mergeOnDream = true;
    service.config.lifecycle.coldMemoryMonths = 12;
    expect(service.consolidate("dream").merged).toBe(0);

    // 窗口 1 个月：冷合并执行
    service.config.lifecycle.coldMemoryMonths = 1;
    expect(service.consolidate("dream").merged).toBe(2);
  });
});
