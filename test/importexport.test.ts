/**
 * 导入导出测试：memweave-export/1 导出/导入/强制备份/报告/可回滚
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { contentHash } from "../src/core/hash";
import { openWeaveDb, type WeaveEnv } from "../src/store/db";
import { ensureSchema } from "../src/store/migrate";
import { getMemory, insertMemory, newId } from "../src/store/dao";
import { captureL0Message } from "../src/store/l0";
import { getEmbeddingConfig, getVectorConfig, setEmbeddingProvider } from "../src/store/vector";
import { setSessionPersona } from "../src/persona/storage";
import { WeaveService, defaultConfig } from "../src/host/service";
import type { MemoryEntry, PersonaConfig } from "../src/core/types";

let dir: string;
let env: WeaveEnv;
let service: WeaveService;

function entry(p: Partial<MemoryEntry> & { content: string }): MemoryEntry {
  const ts = Date.now();
  return {
    id: p.id ?? newId(),
    level: p.level ?? "fact",
    project: p.project ?? null,
    section: null,
    content: p.content,
    keywords: p.keywords ?? [],
    importance: 3,
    status: "active",
    semanticKey: p.semanticKey ?? null,
    confidence: null,
    validFrom: ts,
    validTo: null,
    evidence: [],
    hash: p.hash ?? contentHash(p.content),
    source: "test",
    accessCount: 0,
    tier: "hot",
    createdAt: ts,
    updatedAt: ts,
  };
}

function openSide(): { dir: string; env: WeaveEnv; service: WeaveService } {
  const d = mkdtempSync(join(tmpdir(), "memweave-io-"));
  const e = openWeaveDb(join(d, "memweave"));
  ensureSchema(e);
  return { dir: d, env: e, service: new WeaveService(e, defaultConfig(d)) };
}

function closeSide(s: { dir: string; env: WeaveEnv; service: WeaveService }): void {
  s.service.stopMirror(true);
  s.env.close();
  rmSync(s.dir, { recursive: true, force: true });
}

beforeEach(() => {
  const side = openSide();
  dir = side.dir;
  env = side.env;
  service = side.service;
});

afterEach(() => {
  closeSide({ dir, env, service });
});

describe("备份恢复", () => {
  it("reset invalidates persistent import rollback handles", async () => {
    const payload = { spec: "memweave-export/1", memories: [entry({ id: "reset-import", content: "reset removes imported memory" })] };
    const imported = await service.importRun(payload as unknown as Record<string, unknown>, "human") as Record<string, unknown>;
    const rollbackId = String(imported.rollbackId);
    await service.resetAll("human");
    const handle = service.listImportRollbacks().find((item) => item.rollbackId === rollbackId);
    expect(handle).toBeTruthy();
    expect(handle?.rolledBackAt).toEqual(expect.any(Number));
    const rollback = await service.rollbackImport(rollbackId, "human");
    expect(rollback.ok).toBe(true);
    expect(rollback.alreadyRolledBack).toBe(true);
    expect(getMemory(env, "reset-import")).toBeNull();
  });


  it("reset clears raw messages, conflicts and per-session persona", async () => {
    const memory = await service.remember({ level: "fact", content: "要被彻底重置的记忆内容甲乙" }, "human");
    expect(memory.ok).toBe(true);
    captureL0Message(env, "sess-reset", "user", "原始对话：我的手机号是 13800001111", {
      enabled: true,
      retentionDays: 7,
      captureUser: true,
      captureAssistant: true,
    });
    env.db
      .prepare(
        "INSERT INTO memory_conflicts (memory_id_a, memory_id_b, level_a, level_b, conflict_type, confidence, status, created_at) " +
          "VALUES (?, ?, 'fact', 'fact', 'value', 0.9, 'pending', ?)",
      )
      .run(String(memory.id), "gone-after-reset", Date.now());
    setSessionPersona(env, "sess-reset", { tone: "brief" });

    const count = (table: string): number =>
      (env.db.prepare("SELECT COUNT(*) AS n FROM " + table).get() as { n: number }).n;
    expect(count("l0_messages")).toBe(1);
    expect(count("memory_conflicts")).toBe(1);
    expect(count("session_persona")).toBe(1);

    const reset = await service.resetAll("human");
    expect(reset.ok).toBe(true);
    // l0_messages 存原始对话（含隐私信息），「彻底重置」后必须真的消失；
    // memory_conflicts / session_persona 否则会留下指向已删记忆的悬空数据。
    expect(count("l0_messages")).toBe(0);
    expect(count("memory_conflicts")).toBe(0);
    expect(count("session_persona")).toBe(0);
    expect(service.getMemory(String(memory.id))).toBeNull();
  });

  it("reset rebuilds the live embedding config and clears it when no provider is injected", async () => {
    setEmbeddingProvider({
      dimensions: 4,
      provider: "fake",
      model: "fake-embed",
      generate: async () => new Float32Array(4),
    });
    try {
      const reset = await service.resetAll("human");
      expect(reset.ok).toBe(true);
      // provider 仍注入着：配置行要同步写回，不能「库里说没配、内存里还在用」
      expect(getVectorConfig(env)?.enabled).toBe(true);
      expect(getEmbeddingConfig(env)?.model).toBe("fake-embed");
      // 向量数据已清空，不需要标记重建
      expect(
        (env.db.prepare("SELECT needs_reindex AS n FROM vector_config WHERE id = 1").get() as { n: number }).n,
      ).toBe(0);
    } finally {
      setEmbeddingProvider(null);
    }

    await service.resetAll("human");
    expect(getVectorConfig(env)).toBeNull();
    expect(getEmbeddingConfig(env)).toBeNull();
  });

  it("restores a listed backup and preserves a safety backup", async () => {
    const first = await service.remember({ level: "fact", content: "memory in saved backup" }, "human");
    const backupPath = service.backupNow("restore-test");
    const later = await service.remember({ level: "fact", content: "memory after backup" }, "human");
    const result = await service.restoreBackup(backupPath, "human") as Record<string, unknown>;
    expect(result.ok).toBe(true);
    expect(existsSync(String(result.safetyBackup))).toBe(true);
    expect(service.getMemory(String(first.id))).not.toBeNull();
    expect(service.getMemory(String(later.id))).toBeNull();
  });

  it("rejects paths outside the plugin backup list", async () => {
    const result = await service.restoreBackup(join(dir, "not-a-backup.db"), "human");
    expect(result.ok).toBe(false);
    expect(result.code).toBe("E_PERM");
  });
});

describe("导出 memweave-export/1", () => {
  it("含记忆 JSON（七层 + 元数据）/ 预设卡 / 镜像目录", () => {
    insertMemory(env, entry({ id: "f1", content: "事实：导出测试" }));
    service.savePreset("card1", { ...service.persona().config, userName: "测试主人" } as PersonaConfig);
    service.rebuildMirrorNow();

    const payload = service.exportAll() as Record<string, unknown>;
    expect(payload.spec).toBe("memweave-export/1");
    expect(typeof payload.exportedAt).toBe("number");
    const memories = payload.memories as MemoryEntry[];
    expect(memories.some((m) => m.id === "f1")).toBe(true);

    const presets = payload.presets as Array<Record<string, unknown>>;
    expect(presets[0].id).toBe("card1");
    expect((presets[0].payload as Record<string, unknown>).userName).toBe("测试主人");

    const mirror = payload.mirror as Record<string, string>;
    expect(Object.keys(mirror).length).toBeGreaterThan(0);
    expect(mirror["fact.md"]).toContain("导出测试");
  });
});

describe("导入：只认自家格式 + 报告", () => {
  it("非 memweave-export/1 一律拒绝", () => {
    const r = service.importScan({ spec: "whale-persona-preset/1" });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("E_VALID");
  });

  it("预检报告 新增/跳过/冲突，并识别 payload 内部重复", () => {
    insertMemory(env, entry({ id: "e1", content: "已存在的事实", semanticKey: "k1" }));
    const payload = {
      spec: "memweave-export/1",
      memories: [
        entry({ id: "n1", content: "新事实" }),
        entry({ id: "n2", content: "新事实" }), // payload 内重复
        entry({ id: "d1", content: "已存在的事实", semanticKey: "k1" }), // 重复
        entry({ id: "c1", content: "与 k1 冲突的不同内容", semanticKey: "k1" }), // 语义键冲突
      ],
    };
    const r = service.importScan(payload as unknown as Record<string, unknown>);
    expect(r.ok).toBe(true);
    expect(r.adds).toBe(1);
    expect(r.skips).toBe(2);
    expect(r.conflicts).toBe(1);
  });
});

describe("导入执行：强制备份 + 可回滚", () => {
  it("roundtrip 导入 → 回滚后恢复原状", async () => {
    const a = openSide();
    insertMemory(a.env, entry({ id: "m1", content: "第一条记忆" }));
    insertMemory(a.env, entry({ id: "m2", content: "第二条记忆", level: "lesson" }));
    a.service.savePreset("cardA", { ...a.service.persona().config } as PersonaConfig);
    await a.service.updatePersona({ userName: "阿主" } as Partial<PersonaConfig>, "human");
    const exported = a.service.exportAll();
    closeSide(a);

    const r = await service.importRun(exported, "human") as Record<string, unknown>;
    expect(r.ok).toBe(true);
    expect(r.added).toBe(2);
    expect(r.conflicts).toBe(0);
    expect(existsSync(String(r.backup))).toBe(true);
    expect(getMemory(env, "m1")?.content).toBe("第一条记忆");
    expect(service.getPreset("cardA")).not.toBeNull();
    expect(service.persona().config.userName).toBe("阿主");

    const rollbackId = String(r.rollbackId);
    const rb = await service.rollbackImport(rollbackId, "human") as Record<string, unknown>;
    expect(rb.ok).toBe(true);
    expect(rb.removed).toBe(2);
    expect(getMemory(env, "m1")).toBeNull();
    expect(service.getPreset("cardA")).toBeNull();
    expect(service.persona().config.userName).not.toBe("阿主");

    // 回滚幂等：再回滚条目已不在，removed=0
    const again = await service.rollbackImport(rollbackId, "human") as Record<string, unknown>;
    expect(again.ok).toBe(true);
    expect(again.removed).toBe(0);
  });

  it("transaction failure leaves no partial import or rollback handle", async () => {
    env.db.exec("CREATE TRIGGER fail_import BEFORE INSERT ON fact WHEN NEW.content = 'force import failure' BEGIN SELECT RAISE(ABORT, 'forced import failure'); END");
    const payload = {
      spec: "memweave-export/1",
      memories: [
        entry({ id: "partial-ok", content: "first imported row" }),
        entry({ id: "partial-fail", content: "force import failure" }),
      ],
    };
    const result = await service.importRun(payload as unknown as Record<string, unknown>, "human") as Record<string, unknown>;
    expect(result.ok).toBe(false);
    expect(getMemory(env, "partial-ok")).toBeNull();
    expect(getMemory(env, "partial-fail")).toBeNull();
    expect(service.listImportRollbacks()).toHaveLength(0);
  });
  it("rollback skips imported entries edited after import", async () => {
    const payload = { spec: "memweave-export/1", memories: [entry({ id: "edited-after-import", content: "original imported text" })] };
    const imported = await service.importRun(payload as unknown as Record<string, unknown>, "human") as Record<string, unknown>;
    const id = String(imported.rollbackId);
    const revised = await service.revise("edited-after-import", { content: "later human edit" }, "human");
    expect(revised.ok).toBe(true);
    const rollback = await service.rollbackImport(id, "human") as Record<string, unknown>;
    expect(rollback.ok).toBe(true);
    expect(rollback.removed).toBe(0);
    expect(rollback.skipped).toBe(1);
    expect(getMemory(env, "edited-after-import")?.content).toBe("later human edit");
  });
  it("导入不覆盖已有预设卡", async () => {
    service.savePreset("cardX", { ...service.persona().config, userName: "原卡" } as PersonaConfig);
    const payload = {
      spec: "memweave-export/1",
      memories: [],
      presets: [{ id: "cardX", payload: { userName: "外来卡" } }],
    };
    const r = await service.importRun(payload as unknown as Record<string, unknown>, "human") as Record<string, unknown>;
    expect(r.ok).toBe(true);
    expect(r.presets).toBe(0);
    expect((service.getPreset("cardX")!.payload as Record<string, unknown>).userName).toBe("原卡");
  });
});
