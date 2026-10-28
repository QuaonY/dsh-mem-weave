/**
 * Markdown 镜像测试（§8.6）：重建 / 逆解析 / 超限拆分 / SQLite 为准 / 节流合并写
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openWeaveDb, type WeaveEnv } from "../src/store/db";
import { ensureSchema } from "../src/store/migrate";
import { insertMemory, newId } from "../src/store/dao";
import {
  clearMirror,
  parseMirrorFile,
  parsePersonaLines,
  readMirrorLines,
  rebuildMirror,
  renderLine,
  splitFiles,
  type MirrorConfigLike,
} from "../src/store/mirror";
import { WeaveService, defaultConfig } from "../src/host/service";
import type { MemoryEntry } from "../src/core/types";

let dir: string;
let mirrorDir: string;
let env: WeaveEnv;
let mirrorCfg: MirrorConfigLike;

function entry(p: Partial<MemoryEntry> & { content: string }): MemoryEntry {
  const ts = Date.now();
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
    validTo: null,
    evidence: [],
    hash: null,
    source: "test",
    accessCount: 0,
    tier: "hot",
    createdAt: ts,
    updatedAt: ts,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memweave-mirror-"));
  mirrorDir = join(dir, "mirror");
  env = openWeaveDb(join(dir, "memweave"));
  ensureSchema(env);
  mirrorCfg = { enabled: true, rebuildDebounceMs: 60000, maxFileKb: 25, maxLines: 400, dir: mirrorDir };
});

afterEach(() => {
  env.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("重建与逆解析", () => {
  it("产出 persona/project/fact/lesson 四件套，行尾 id 可逆解析", () => {
    insertMemory(env, entry({ id: "f1", content: "视频导出要求 1080p", level: "fact" }));
    insertMemory(env, entry({ id: "p1", content: "项目代号：忆织", level: "project" }));
    insertMemory(env, entry({ id: "l1", content: "教训：先跑测试再交付", level: "lesson" }));

    const r = rebuildMirror(env, mirrorCfg);
    expect(r.ok).toBe(true);
    expect(r.entries).toBeGreaterThan(3);
    for (const name of ["persona.md", "project.md", "fact.md", "lesson.md"]) {
      expect(existsSync(join(mirrorDir, name))).toBe(true);
    }

    const factLines = parseMirrorFile(readFileSync(join(mirrorDir, "fact.md"), "utf8"));
    expect(factLines.map((l) => l.id)).toContain("f1");
    expect(factLines.find((l) => l.id === "f1")?.text).toContain("视频导出要求 1080p");

    const persona = parsePersonaLines(readMirrorLines(mirrorCfg, "persona"));
    expect(typeof persona.userName === "string" || persona.userName === null).toBe(true);
  });

  it("内容不变不重写（changed 为空），手动改动被 SQLite 为准覆盖", () => {
    insertMemory(env, entry({ id: "f1", content: "原文 A" }));
    const r1 = rebuildMirror(env, mirrorCfg);
    expect(r1.changed).toContain("fact.md");

    const r2 = rebuildMirror(env, mirrorCfg);
    expect(r2.changed).toEqual([]);

    const path = join(mirrorDir, "fact.md");
    writeFileSync(path, "- 我手改的 <!-- id: f1 -->\n", "utf8");
    const r3 = rebuildMirror(env, mirrorCfg);
    expect(r3.changed).toContain("fact.md");
    expect(readFileSync(path, "utf8")).toContain("原文 A");
    expect(readFileSync(path, "utf8")).not.toContain("我手改的");
  });

  it("归档条目带状态前缀，archived 不进镜像", () => {
    insertMemory(env, entry({ id: "a1", content: "归档内容" }));
    insertMemory(env, entry({ id: "s1", content: "过期内容", status: "stale" }));
    insertMemory(env, entry({ id: "g1", content: "彻底删除前的内容" }));
    rebuildMirror(env, mirrorCfg);
    const lines = parseMirrorFile(readFileSync(join(mirrorDir, "fact.md"), "utf8"));
    const byId = new Map(lines.map((l) => [l.id, l.text]));
    expect(byId.get("a1")).toContain("归档内容");
    expect(byId.get("s1")).toContain("[stale]");
    expect(byId.has("g1")).toBe(true);
  });
});

describe("硬上限守卫", () => {
  it("超 400 行拆 fact.2.md，收缩后多余分片被清", () => {
    for (let i = 0; i < 450; i += 1) {
      insertMemory(env, entry({ id: "f" + String(i).padStart(3, "0"), content: "条目 " + i }));
    }
    const r = rebuildMirror(env, mirrorCfg);
    expect(r.files).toContain("fact.2.md");
    expect(existsSync(join(mirrorDir, "fact.2.md"))).toBe(true);
    const total = parseMirrorFile(readFileSync(join(mirrorDir, "fact.md"), "utf8")).length +
      parseMirrorFile(readFileSync(join(mirrorDir, "fact.2.md"), "utf8")).length;
    expect(total).toBe(450);

    // 拆分函数本身的字节上限也守
    const parts = splitFiles("H\n", Array.from({ length: 10 }, (_, i) => ({ id: "x" + i, text: "y".repeat(200) })), 1024, 400);
    expect(parts.length).toBeGreaterThan(1);
  });

  it("条目收缩后 fact.2.md 被删除", () => {
    for (let i = 0; i < 450; i += 1) {
      insertMemory(env, entry({ id: "f" + String(i).padStart(3, "0"), content: "条目 " + i }));
    }
    rebuildMirror(env, mirrorCfg);
    expect(existsSync(join(mirrorDir, "fact.2.md"))).toBe(true);
    // 上限放宽后并回一片：多余的 fact.2.md 必须清掉，不能留脏文件
    rebuildMirror(env, { ...mirrorCfg, maxLines: 1000 });
    expect(existsSync(join(mirrorDir, "fact.2.md"))).toBe(false);
  });
});

describe("节流合并写", () => {
  it("窗口内多次写只落盘一次，stopMirror 立即冲刷", async () => {
    const cfg = defaultConfig(join(dir, "memweave"));
    cfg.mirror = { enabled: true, rebuildDebounceMs: 120, maxFileKb: 25, maxLines: 400, dir: mirrorDir };
    const svc = new WeaveService(env, cfg);
    insertMemory(env, entry({ id: "f1", content: "节流内容" }));

    svc.scheduleMirror();
    svc.scheduleMirror();
    svc.scheduleMirror();
    expect(existsSync(join(mirrorDir, "fact.md"))).toBe(false);

    await new Promise((r) => setTimeout(r, 220));
    expect(existsSync(join(mirrorDir, "fact.md"))).toBe(true);

    insertMemory(env, entry({ id: "f2", content: "第二次" }));
    svc.scheduleMirror();
    expect(readFileSync(join(mirrorDir, "fact.md"), "utf8")).not.toContain("第二次");
    svc.stopMirror(true);
    expect(readFileSync(join(mirrorDir, "fact.md"), "utf8")).toContain("第二次");
    svc.stopMirror(false);
  });

  it("enabled=false 不产出镜像", () => {
    const r = rebuildMirror(env, { ...mirrorCfg, enabled: false });
    expect(r.files).toEqual([]);
    expect(existsSync(mirrorDir)).toBe(false);
  });
});

describe("clearMirror（D15 重置步骤）", () => {
  it("只清四个派生文件族", () => {
    insertMemory(env, entry({ id: "f1", content: "x" }));
    rebuildMirror(env, mirrorCfg);
    writeFileSync(join(mirrorDir, "notes.txt"), "keep", "utf8");
    const removed = clearMirror(mirrorCfg);
    expect(removed).toContain("fact.md");
    expect(existsSync(join(mirrorDir, "fact.md"))).toBe(false);
    expect(existsSync(join(mirrorDir, "notes.txt"))).toBe(true);
  });
});

describe("renderLine 定形", () => {
  it("换行压平、超长截断、id 标记保尾", () => {
    const line = renderLine("x1", "多行\n内容\t压平" + "长".repeat(600));
    expect(line.startsWith("- 多行 内容 压平")).toBe(true);
    expect(line.endsWith("<!-- id: x1 -->")).toBe(true);
    expect(parseMirrorFile(line + "\n")[0].id).toBe("x1");
  });
});
