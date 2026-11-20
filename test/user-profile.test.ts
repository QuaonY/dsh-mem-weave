/**
 * 使用者画像测试
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openWeaveDb, type WeaveEnv } from "../src/store/db";
import { ensureSchema } from "../src/store/migrate";
import { generateUserProfile, pruneExpiredInferences } from "../src/profile/generator";
import { generateProfileInjection, generateBriefProfile } from "../src/profile/inject";
import { DEFAULT_PROFILE_CONFIG } from "../src/profile/types";
import { newId } from "../src/store/dao";

describe("使用者画像生成", () => {
  let env: WeaveEnv;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "weave-profile-"));
    env = openWeaveDb(tmpDir, { readonly: false });
    ensureSchema(env);
  });

  afterEach(() => {
    env.db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("画像功能默认启用，空库时返回空内容", () => {
    const profile = generateUserProfile(env, DEFAULT_PROFILE_CONFIG);
    
    expect(profile.summary).toBe("暂无画像信息。");
    expect(profile.preferences).toHaveLength(0);
    expect(profile.baseMemoryCount).toBe(0);
  });

  it("禁用画像时返回禁用提示", () => {
    const profile = generateUserProfile(env, { ...DEFAULT_PROFILE_CONFIG, enabled: false });
    
    expect(profile.summary).toBe("画像功能未启用");
    expect(profile.preferences).toHaveLength(0);
    expect(profile.baseMemoryCount).toBe(0);
  });

  it("从 user 层记忆生成偏好", () => {
    // 插入 user 层记忆
    env.db.prepare(`
      INSERT INTO user (id, project, section, content, keywords, importance, status, tier, created_at, updated_at, evidence, hash, source, access_count)
      VALUES (?, NULL, NULL, ?, ?, 4, 'active', 'hot', ?, ?, '[]', NULL, 'agent', 1)
    `).run(newId(), "我喜欢编程", JSON.stringify(["编程"]), Date.now(), Date.now());
    
    const config = { ...DEFAULT_PROFILE_CONFIG, enabled: true };
    const profile = generateUserProfile(env, config);
    
    expect(profile.preferences.length).toBeGreaterThan(0);
    expect(profile.preferences[0].content).toBe("我喜欢编程");
    expect(profile.preferences[0].source).toBe("stated");
    expect(profile.preferences[0].confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("已标记敏感的记忆不进画像（画像会随 S2 注入）", () => {
    const id = newId();
    env.db.prepare(`
      INSERT INTO user (id, project, section, content, keywords, importance, status, tier, created_at, updated_at, evidence, hash, source, access_count)
      VALUES (?, NULL, NULL, ?, ?, 3, 'active', 'hot', ?, ?, '[]', NULL, 'human', 0)
    `).run(id, "我喜欢在深夜安静地写代码", JSON.stringify(["写代码"]), Date.now(), Date.now());
    env.db.prepare("UPDATE user SET is_sensitive = 1 WHERE id = ?").run(id);

    const profile = generateUserProfile(env, { ...DEFAULT_PROFILE_CONFIG, enabled: true });
    const all = [
      ...profile.preferences,
      ...profile.communicationStyle,
      ...profile.goals,
      ...profile.boundaries,
      ...profile.relationship,
    ];
    expect(all.some((i) => i.evidenceIds.includes(id))).toBe(false);
    expect(profile.summary).not.toContain("深夜");
  });

  it("识别边界/禁区", () => {
    env.db.prepare(`
      INSERT INTO user (id, project, section, content, keywords, importance, status, tier, created_at, updated_at, evidence, hash, source, access_count)
      VALUES (?, NULL, NULL, ?, ?, 5, 'active', 'hot', ?, ?, '[]', NULL, 'agent', 1)
    `).run(newId(), "不要打断我工作", JSON.stringify(["工作", "不要"]), Date.now(), Date.now());
    
    const config = { ...DEFAULT_PROFILE_CONFIG, enabled: true };
    const profile = generateUserProfile(env, config);
    
    expect(profile.boundaries.length).toBeGreaterThan(0);
    expect(profile.boundaries[0].content).toBe("不要打断我工作");
    expect(profile.boundaries[0].category).toBe("boundary");
  });

  it("识别目标", () => {
    env.db.prepare(`
      INSERT INTO fact (id, project, section, content, keywords, importance, status, tier, created_at, updated_at, evidence, hash, source, access_count)
      VALUES (?, NULL, NULL, ?, ?, 4, 'active', 'hot', ?, ?, '[]', NULL, 'agent', 1)
    `).run(newId(), "希望提高代码质量", JSON.stringify(["代码质量", "目标"]), Date.now(), Date.now());
    
    const config = { ...DEFAULT_PROFILE_CONFIG, enabled: true };
    const profile = generateUserProfile(env, config);
    
    expect(profile.goals.length).toBeGreaterThan(0);
    expect(profile.goals[0].content).toBe("希望提高代码质量");
    expect(profile.goals[0].category).toBe("goal");
  });

  it("多次访问的记忆提升为 observed", () => {
    env.db.prepare(`
      INSERT INTO user (id, project, section, content, keywords, importance, status, tier, created_at, updated_at, evidence, hash, source, access_count)
      VALUES (?, NULL, NULL, ?, ?, 4, 'active', 'hot', ?, ?, '[]', NULL, 'agent', 3)
    `).run(newId(), "使用 TypeScript 开发", JSON.stringify(["TypeScript"]), Date.now(), Date.now());
    
    const config = { ...DEFAULT_PROFILE_CONFIG, enabled: true };
    const profile = generateUserProfile(env, config);
    
    const item = profile.preferences.find(p => p.content === "使用 TypeScript 开发");
    expect(item?.source).toBe("observed");
    expect(item?.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it("过滤敏感关键词", () => {
    env.db.prepare(`
      INSERT INTO user (id, project, section, content, keywords, importance, status, tier, created_at, updated_at, evidence, hash, source, access_count)
      VALUES (?, NULL, NULL, ?, ?, 4, 'active', 'hot', ?, ?, '[]', NULL, 'agent', 1)
    `).run(newId(), "我的政治立场", JSON.stringify(["政治"]), Date.now(), Date.now());
    
    const config = { ...DEFAULT_PROFILE_CONFIG, enabled: true };
    const profile = generateUserProfile(env, config);
    
    // 不应该包含政治相关的画像
    expect(profile.preferences.every(p => !p.content.includes("政治"))).toBe(true);
  });

  it("低置信度项被过滤", () => {
    env.db.prepare(`
      INSERT INTO fact (id, project, section, content, keywords, importance, status, tier, created_at, updated_at, evidence, hash, source, access_count, confidence)
      VALUES (?, NULL, NULL, ?, ?, 2, 'active', 'cold', ?, ?, '[]', NULL, 'agent', 0, 0.2)
    `).run(newId(), "可能喜欢音乐", JSON.stringify(["音乐"]), Date.now(), Date.now());
    
    const config = { ...DEFAULT_PROFILE_CONFIG, enabled: true, minConfidence: 0.4 };
    const profile = generateUserProfile(env, config);
    
    // 低置信度的推断不应该出现
    expect(profile.preferences.every(p => p.content !== "可能喜欢音乐")).toBe(true);
  });
});

describe("stated/observed/inferred", () => {
  let env: WeaveEnv;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "weave-profile-"));
    env = openWeaveDb(tmpDir, { readonly: false });
    ensureSchema(env);
  });

  afterEach(() => {
    env.db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("stated：第一人称明确陈述", () => {
    env.db.prepare(`
      INSERT INTO user (id, project, section, content, keywords, importance, status, tier, created_at, updated_at, evidence, hash, source, access_count)
      VALUES (?, NULL, NULL, ?, ?, 4, 'active', 'hot', ?, ?, '[]', NULL, 'agent', 1)
    `).run(newId(), "我喜欢简洁的代码", JSON.stringify(["代码"]), Date.now(), Date.now());
    
    const config = { ...DEFAULT_PROFILE_CONFIG, enabled: true };
    const profile = generateUserProfile(env, config);
    
    const item = profile.preferences.find(p => p.content === "我喜欢简洁的代码");
    expect(item?.source).toBe("stated");
    expect(item?.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("observed：高访问次数", () => {
    env.db.prepare(`
      INSERT INTO fact (id, project, section, content, keywords, importance, status, tier, created_at, updated_at, evidence, hash, source, access_count)
      VALUES (?, NULL, NULL, ?, ?, 4, 'active', 'hot', ?, ?, '[]', NULL, 'agent', 5)
    `).run(newId(), "经常使用 React", JSON.stringify(["React"]), Date.now(), Date.now());
    
    const config = { ...DEFAULT_PROFILE_CONFIG, enabled: true };
    const profile = generateUserProfile(env, config);
    
    const item = profile.preferences.find(p => p.content === "经常使用 React");
    expect(item?.source).toBe("observed");
    expect(item?.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it("inferred：低访问、非明说", () => {
    env.db.prepare(`
      INSERT INTO project (id, project, section, content, keywords, importance, status, tier, created_at, updated_at, evidence, hash, source, access_count)
      VALUES (?, 'test', NULL, ?, ?, 3, 'active', 'cold', ?, ?, '[]', NULL, 'agent', 0)
    `).run(newId(), "项目使用 Docker", JSON.stringify(["Docker"]), Date.now(), Date.now());
    
    const config = { ...DEFAULT_PROFILE_CONFIG, enabled: true };
    const profile = generateUserProfile(env, config);
    
    const item = profile.preferences.find(p => p.content === "项目使用 Docker");
    expect(item?.source).toBe("inferred");
    expect(item?.confidence).toBeLessThan(0.8);
  });

  it("importance 按 1–5 制：高重要度视为 observed 并加置信度", () => {
    env.db.prepare(`
      INSERT INTO fact (id, project, section, content, keywords, importance, status, tier, created_at, updated_at, evidence, hash, source, access_count)
      VALUES (?, NULL, NULL, ?, ?, 5, 'active', 'hot', ?, ?, '[]', NULL, 'agent', 0)
    `).run(newId(), "部署窗口在周六", JSON.stringify(["部署"]), Date.now(), Date.now());

    const profile = generateUserProfile(env, { ...DEFAULT_PROFILE_CONFIG, enabled: true });
    const item = profile.preferences.find(p => p.content === "部署窗口在周六");
    expect(item?.source).toBe("observed");
    expect(item?.confidence).toBeCloseTo(0.8);
  });

  it("importance 按 1–5 制：低重要度扣置信度", () => {
    env.db.prepare(`
      INSERT INTO fact (id, project, section, content, keywords, importance, status, tier, created_at, updated_at, evidence, hash, source, access_count, confidence)
      VALUES (?, NULL, NULL, ?, ?, 1, 'active', 'cold', ?, ?, '[]', NULL, 'agent', 0, 0.6)
    `).run(newId(), "偶尔喝咖啡", JSON.stringify(["咖啡"]), Date.now(), Date.now());

    const profile = generateUserProfile(env, { ...DEFAULT_PROFILE_CONFIG, enabled: true });
    const item = profile.preferences.find(p => p.content === "偶尔喝咖啡");
    expect(item?.source).toBe("inferred");
    expect(item?.confidence).toBeCloseTo(0.5);
  });

  it("inferred 类型有过期时间", () => {
    const now = Date.now();
    env.db.prepare(`
      INSERT INTO fact (id, project, section, content, keywords, importance, status, tier, created_at, updated_at, evidence, hash, source, access_count)
      VALUES (?, NULL, NULL, ?, ?, 3, 'active', 'cold', ?, ?, '[]', NULL, 'agent', 0)
    `).run(newId(), "可能在学习 Rust", JSON.stringify(["Rust"]), now, now);
    
    const config = { ...DEFAULT_PROFILE_CONFIG, enabled: true, inferredExpiryDays: 30 };
    const profile = generateUserProfile(env, config);
    
    const item = profile.preferences.find(p => p.content === "可能在学习 Rust");
    expect(item?.expiresAt).toBeDefined();
    expect(item!.expiresAt!).toBeGreaterThan(now);
  });

  it("清理过期的推断", () => {
    const now = Date.now();
    const expiredTime = now - 31 * 24 * 60 * 60 * 1000; // 31 天前
    
    env.db.prepare(`
      INSERT INTO fact (id, project, section, content, keywords, importance, status, tier, created_at, updated_at, evidence, hash, source, access_count)
      VALUES (?, NULL, NULL, ?, ?, 3, 'active', 'cold', ?, ?, '[]', NULL, 'agent', 0)
    `).run(newId(), "过期的推断", JSON.stringify(["过期"]), expiredTime, expiredTime);
    
    const config = { ...DEFAULT_PROFILE_CONFIG, enabled: true, inferredExpiryDays: 30 };
    const profile = generateUserProfile(env, config);
    
    // 过期的推断应该被过滤
    expect(profile.preferences.every(p => p.content !== "过期的推断")).toBe(true);
  });
});

describe("画像依据可追溯", () => {
  let env: WeaveEnv;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "weave-profile-basis-"));
    env = openWeaveDb(tmpDir, { readonly: false });
    ensureSchema(env);
  });

  afterEach(() => {
    env.db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function insert(level: "user" | "fact", content: string, opts: {
    importance?: number;
    confidence?: number | null;
    accessCount?: number;
    updatedAt?: number;
  } = {}): string {
    const id = newId();
    const now = opts.updatedAt ?? Date.now();
    env.db
      .prepare(
        `INSERT INTO ${level} (id, project, section, content, keywords, importance, status, tier, created_at, updated_at, evidence, hash, source, access_count, confidence)
         VALUES (?, NULL, NULL, ?, ?, ?, 'active', 'hot', ?, ?, '[]', NULL, 'agent', ?, ?)`,
      )
      .run(
        id,
        content,
        JSON.stringify([content.slice(0, 2)]),
        opts.importance ?? 4,
        now,
        now,
        opts.accessCount ?? 1,
        opts.confidence ?? null,
      );
    return id;
  }

  it("basis 记录层、扫描/采用数、三类过滤计数、阈值与证据 id", () => {
    const kept = insert("user", "我喜欢编程");
    insert("user", "我的政治立场");
    insert("fact", "可能喜欢音乐", { importance: 2, confidence: 0.2, accessCount: 0 });
    insert("fact", "过期的推断", { importance: 3, confidence: null, accessCount: 0, updatedAt: Date.now() - 31 * 86400000 });

    const profile = generateUserProfile(env, { ...DEFAULT_PROFILE_CONFIG, enabled: true, minConfidence: 0.4 });
    expect(profile.basis).toMatchObject({
      levels: ["user", "soul", "fact", "project"],
      scanned: 4,
      used: 1,
      excluded: { sensitive: 1, lowConfidence: 1, expired: 1 },
      byCategory: { preference: 1, communication: 0, goal: 0, boundary: 0, relationship: 0 },
      bySource: { stated: 1, observed: 0, inferred: 0 },
      thresholds: { minConfidence: 0.4, inferredExpiryDays: 30 },
    });
    expect(profile.basis!.evidenceIds).toEqual([kept]);
    const item = profile.preferences.find((p) => p.content === "我喜欢编程");
    expect(item?.evidenceIds).toEqual([kept]);
    expect(item?.trace).toMatchObject({
      level: "user",
      categoryRule: "default-preference",
      importance: 4,
      accessCount: 1,
      memoryConfidence: null,
    });
  });

  it("逐条 trace 记录分类规则：soul 层归关系，边界词命边界", () => {
    env.db
      .prepare(
        "INSERT INTO soul (id, project, section, content, keywords, importance, status, tier, created_at, updated_at, evidence, hash, source, access_count)" +
          " VALUES (?, NULL, NULL, ?, ?, 5, 'active', 'core', ?, ?, '[]', NULL, 'agent', 1)",
      )
      .run(newId(), "陪伴用户完成长期项目", JSON.stringify(["陪伴"]), Date.now(), Date.now());
    insert("user", "不要打断我工作");

    const profile = generateUserProfile(env, { ...DEFAULT_PROFILE_CONFIG, enabled: true });
    expect(profile.relationship[0].trace?.categoryRule).toBe("soul-level");
    expect(profile.boundaries[0].trace?.categoryRule).toBe("boundary-keyword");
  });

  it("pruneExpiredInferences 同步更新 basis 的 used 与证据 id", () => {
    const now = Date.now();
    const id = insert("fact", "过期的推断", { importance: 3, confidence: null, accessCount: 0, updatedAt: now });
    const profile = generateUserProfile(env, { ...DEFAULT_PROFILE_CONFIG, enabled: true, inferredExpiryDays: 30 });
    expect(profile.basis!.used).toBe(1);

    const later = profile.preferences.map((p) => ({
      ...p,
      expiresAt: p.expiresAt === undefined ? undefined : now - 1,
    }));
    const pruned = pruneExpiredInferences({ ...profile, preferences: later, goals: [], communicationStyle: [], boundaries: [], relationship: [] });
    expect(pruned.basis!.used).toBe(0);
    expect(pruned.basis!.evidenceIds).toEqual([]);
    expect(pruned.basis!.byCategory.preference).toBe(0);
    expect(id).toBeTruthy();
  });
});

describe("S2 注入", () => {
  let env: WeaveEnv;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "weave-profile-"));
    env = openWeaveDb(tmpDir, { readonly: false });
    ensureSchema(env);
  });

  afterEach(() => {
    env.db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("生成 S2 注入文本", () => {
    env.db.prepare(`
      INSERT INTO user (id, project, section, content, keywords, importance, status, tier, created_at, updated_at, evidence, hash, source, access_count)
      VALUES (?, NULL, NULL, ?, ?, 5, 'active', 'hot', ?, ?, '[]', NULL, 'agent', 1)
    `).run(newId(), "我喜欢简洁的代码", JSON.stringify(["代码"]), Date.now(), Date.now());
    
    const config = { ...DEFAULT_PROFILE_CONFIG, enabled: true, injectToS2: true };
    const profile = generateUserProfile(env, config);
    const injection = generateProfileInjection(profile, config);
    
    expect(injection).toContain("我对你的理解");
    expect(injection).toContain("我喜欢简洁的代码");
    expect(injection.length).toBeGreaterThan(0);
  });

  it("关闭注入时返回空字符串", () => {
    const config = { ...DEFAULT_PROFILE_CONFIG, enabled: true, injectToS2: false };
    const profile = generateUserProfile(env, config);
    const injection = generateProfileInjection(profile, config);
    
    expect(injection).toBe("");
  });

  it("S2 注入文本符合预算", () => {
    // 插入多条记忆
    for (let i = 0; i < 10; i++) {
      env.db.prepare(`
        INSERT INTO user (id, project, section, content, keywords, importance, status, tier, created_at, updated_at, evidence, hash, source, access_count)
        VALUES (?, NULL, NULL, ?, ?, 5, 'active', 'hot', ?, ?, '[]', NULL, 'agent', 1)
      `).run(newId(), `我喜欢技术 ${i}`, JSON.stringify([`tech${i}`]), Date.now(), Date.now());
    }
    
    const config = { 
      ...DEFAULT_PROFILE_CONFIG, 
      enabled: true, 
      injectToS2: true,
      s2Budget: { min: 100, max: 400 },
    };
    const profile = generateUserProfile(env, config);
    const injection = generateProfileInjection(profile, config);
    
    expect(injection.length).toBeLessThanOrEqual(config.s2Budget.max);
  });

  it("生成简洁预览", () => {
    env.db.prepare(`
      INSERT INTO user (id, project, section, content, keywords, importance, status, tier, created_at, updated_at, evidence, hash, source, access_count)
      VALUES (?, NULL, NULL, ?, ?, 5, 'active', 'hot', ?, ?, '[]', NULL, 'agent', 1)
    `).run(newId(), "我喜欢编程", JSON.stringify(["编程"]), Date.now(), Date.now());
    
    const config = { ...DEFAULT_PROFILE_CONFIG, enabled: true };
    const profile = generateUserProfile(env, config);
    const brief = generateBriefProfile(profile);
    
    expect(brief).toContain("💭");
    expect(brief).toContain("我喜欢编程");
  });
});
