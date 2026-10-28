/**
 * 写入治理测试：硬规则 / 去重 / 近似合并 / 敏感 / 冲突冻结 / 风险分级 / 审计
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openWeaveDb, type WeaveEnv } from "../src/store/db";
import { ensureSchema } from "../src/store/migrate";
import { MERGE_THRESHOLD, scanSensitive, similar, writeMemory } from "../src/store/govern";
import {
  findConflictingSemanticKey,
  getPersona,
  listCandidates,
  listConflicts,
  listMemory,
  queryAudit,
  updatePersona,
} from "../src/store/dao";

let dir: string;
let env: WeaveEnv;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memweave-govern-"));
  env = openWeaveDb(dir);
  ensureSchema(env);
});

afterEach(() => {
  env.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("硬规则与敏感拦截", () => {
  it("空内容 / 超长内容 → E_VALID + rejected", async () => {
    const empty = await writeMemory(env, { level: "fact", content: "   " }, "human");
    expect(empty.ok).toBe(false);
    expect(empty.code).toBe("E_VALID");
    expect(empty.verdict).toBe("rejected");
    const long = await writeMemory(env, { level: "fact", content: "x".repeat(2001) }, "human");
    expect(long.code).toBe("E_VALID");
  });

  it("敏感内容 → E_SENSITIVE 只回类别不回显原文", async () => {
    const out = await writeMemory(env, { level: "fact", content: "password: SuperSecret9527" }, "human");
    expect(out.ok).toBe(false);
    expect(out.code).toBe("E_SENSITIVE");
    expect(out.message).toContain("password");
    expect(out.message).not.toContain("SuperSecret9527");
    expect(listMemory(env, {})).toHaveLength(0);
  });

  it("scanSensitive 覆盖各类别", () => {
    expect(scanSensitive("api_key: abc")).toBe("api-key");
    expect(scanSensitive("我的身份证是 110101199001011234")).toBe("id-card");
    expect(scanSensitive("手机号 13800138000")).toBe("phone");
    expect(scanSensitive("主人偏好像素风")).toBeNull();
  });
});

describe("去重与近似合并", () => {
  it("精确去重（contentHash）→ deduped", async () => {
    const a = await writeMemory(env, { level: "fact", content: "主人偏爱像素风的游戏美术风格" }, "human");
    expect(a.ok).toBe(true);
    const b = await writeMemory(env, { level: "fact", content: "主人偏爱像素风的游戏美术风格" }, "agent");
    expect(b.ok).toBe(true);
    expect(b.deduped).toBe(true);
    expect(b.id).toBe(a.id);
    expect(listMemory(env, {})).toHaveLength(1);
  });

  it("近似合并 cosine > 0.92 → mergedInto，不新增条目", async () => {
    expect(MERGE_THRESHOLD).toBeCloseTo(0.92);
    const a = await writeMemory(env, { level: "fact", content: "主人偏爱像素风的游戏美术风格" }, "human");
    const b = await writeMemory(env, { level: "fact", content: "主人偏爱像素风的游戏美术风格啊" }, "agent");
    expect(b.ok).toBe(true);
    expect(b.mergedInto).toBe(a.id);
    expect(listMemory(env, {})).toHaveLength(1);
    expect(queryAudit(env, { action: "memory.merge" }).length).toBe(1);
  });

  it("similar 查重按相似度降序", async () => {
    await writeMemory(env, { level: "fact", content: "主人偏爱像素风的游戏美术风格" }, "human");
    await writeMemory(env, { level: "topic", content: "视频导出规范要求 1080p" }, "human");
    const hits = similar(env, "主人偏爱像素风的游戏美术风格");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].sim).toBeGreaterThan(0.9);
  });
});

describe("语义键冲突冻结（§8.4）", () => {
  it("同 semanticKey 不同内容 → E_CONFLICT，双条不注入，冻结候选 + 开放冲突", async () => {
    const a = await writeMemory(
      env,
      { level: "fact", content: "主人偏爱像素风的游戏美术风格", semanticKey: "pref.art-style" },
      "human",
    );
    expect(a.ok).toBe(true);
    const b = await writeMemory(
      env,
      { level: "fact", content: "主人更喜欢写实厚涂的美术路线", semanticKey: "pref.art-style" },
      "human",
    );
    expect(b.ok).toBe(false);
    expect(b.code).toBe("E_CONFLICT");
    expect(b.verdict).toBe("frozen");
    expect(b.conflictId).toBeTruthy();
    // 新内容不落七层表
    expect(listMemory(env, {})).toHaveLength(1);
    expect(findConflictingSemanticKey(env, "pref.art-style")).toHaveLength(1);
    // 冻结候选 + open 冲突
    const frozen = listCandidates(env, "frozen");
    expect(frozen.length).toBe(1);
    expect(frozen[0].content).toBe("主人更喜欢写实厚涂的美术路线");
    const open = listConflicts(env, "open");
    expect(open.length).toBe(1);
    expect(open[0].semanticKey).toBe("pref.art-style");
    expect(open[0].contenders).toHaveLength(2);
  });
});

describe("风险分级写权（§8.3）", () => {
  it("L2：rules / soul 层任何 actor 都进候选池 pending", async () => {
    const r1 = await writeMemory(env, { level: "rules", content: "输出必须使用中文" }, "human");
    expect(r1.ok).toBe(true);
    expect(r1.verdict).toBe("pending");
    const r2 = await writeMemory(env, { level: "soul", content: "核心人格设定第一条" }, "agent");
    expect(r2.verdict).toBe("pending");
    expect(listCandidates(env, "pending")).toHaveLength(2);
    expect(listMemory(env, {})).toHaveLength(0);
  });

  it("L2：删除性质表述 → pending", async () => {
    const r = await writeMemory(env, { level: "fact", content: "删除旧的视频导出规范" }, "agent");
    expect(r.verdict).toBe("pending");
    expect(listCandidates(env, "pending")[0].reason).toBe("delete-nature");
  });

  it("L2：strict 模式下非 human 写入 → pending；human 直接落库", async () => {
    updatePersona(env, { strict: true }, "human");
    expect(getPersona(env).config.strict).toBe(true);
    const agent = await writeMemory(env, { level: "fact", content: "视频导出规范要求 1080p" }, "agent");
    expect(agent.verdict).toBe("pending");
    const human = await writeMemory(env, { level: "fact", content: "视频导出规范要求 720p" }, "human");
    expect(human.verdict).toBe("accepted");
    expect(listMemory(env, {})).toHaveLength(1);
  });

  it("L3：无证据推测词非 human → E_VALID + rejected；有证据可落库", async () => {
    const spec = await writeMemory(env, { level: "fact", content: "主人可能喜欢蓝色界面" }, "agent");
    expect(spec.ok).toBe(false);
    expect(spec.code).toBe("E_VALID");
    expect(spec.verdict).toBe("rejected");
    const withEv = await writeMemory(
      env,
      {
        level: "fact",
        content: "主人可能喜欢蓝色界面",
        evidence: [{ sessionId: "s1", seq: 3, quote: "把主题换成蓝色吧" }],
      },
      "agent",
    );
    expect(withEv.ok).toBe(true);
    expect(withEv.verdict).toBe("accepted");
    expect(listMemory(env, {})).toHaveLength(1);
  });

  it("human 正常事实直接落库并写审计", async () => {
    const r = await writeMemory(env, { level: "fact", content: "主人住在杭州" }, "human");
    expect(r.ok).toBe(true);
    expect(r.verdict).toBe("accepted");
    expect(r.id).toBeTruthy();
    const audits = queryAudit(env, { action: "memory.write" });
    expect(audits.length).toBeGreaterThan(0);
    expect(audits[0].actor).toBe("human");
  });
});
