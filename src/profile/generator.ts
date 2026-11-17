/**
 * 用户画像生成器
 * 从 user/soul/fact/project 层记忆聚合用户画像
 */

import type { WeaveEnv } from "../store/db";
import type { Level, MemoryEntry } from "../core/types";
import type { UserProfile, ProfileItem, ProfileConfig, ProfileSource, ProfileBasis, ProfileCategory } from "./types";
import { DEFAULT_PROFILE_CONFIG } from "./types";

/**
 * 从记忆层获取画像相关的记忆
 */
const PROFILE_LEVELS: Level[] = ['user', 'soul', 'fact', 'project'];

function getProfileMemories(env: WeaveEnv): MemoryEntry[] {
  const memories: MemoryEntry[] = [];
  
  for (const level of PROFILE_LEVELS) {
    const sql = `
      SELECT * FROM ${level}
      WHERE status != 'archived'
      ORDER BY importance DESC, updated_at DESC
    `;
    
    const rows = env.db.prepare(sql).all() as any[];
    for (const row of rows) {
      memories.push({
        id: row.id,
        level: level,
        project: row.project,
        section: row.section,
        content: row.content,
        keywords: JSON.parse(row.keywords || '[]'),
        importance: row.importance,
        status: row.status,
        semanticKey: row.semantic_key,
        confidence: row.confidence,
        validFrom: row.valid_from,
        validTo: row.valid_to,
        evidence: JSON.parse(row.evidence || '[]'),
        hash: row.hash,
        source: row.source,
        accessCount: row.access_count,
        boost: row.boost,
        valence: row.valence,
        arousal: row.arousal,
        flash: row.flash === 1,
        dueAt: row.due_at,
        promiseState: row.promise_state,
        promiseLabel: row.promise_label,
        calendarAnchor: row.calendar_anchor ? JSON.parse(row.calendar_anchor) : null,
        searchTerms: row.search_terms ? JSON.parse(row.search_terms) : null,
        tier: row.tier,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      });
    }
  }
  
  return memories;
}

/**
 * 检测画像内容是否包含敏感关键词
 */
function containsSensitiveKeywords(
  content: string,
  keywords: string[],
  sensitiveList: string[]
): boolean {
  const lowerContent = content.toLowerCase();
  const lowerKeywords = keywords.map(k => k.toLowerCase());
  
  for (const sensitive of sensitiveList) {
    const lowerSensitive = sensitive.toLowerCase();
    if (lowerContent.includes(lowerSensitive) || lowerKeywords.includes(lowerSensitive)) {
      return true;
    }
  }
  
  return false;
}

/**
 * 从记忆推断画像项的分类，并返回命中的规则名（画像依据可追溯）
 */
function inferCategoryWithRule(memory: MemoryEntry): { category: ProfileCategory; rule: string } {
  const content = memory.content.toLowerCase();
  const keywords = memory.keywords.map(k => k.toLowerCase());
  
  // 边界/禁区相关
  if (
    content.includes('不要') ||
    content.includes('不应该') ||
    content.includes('不能') ||
    content.includes('禁止') ||
    keywords.some(k => k.includes('禁止') || k.includes('不要'))
  ) {
    return { category: 'boundary', rule: 'boundary-keyword' };
  }
  
  // 目标相关
  if (
    content.includes('希望') ||
    content.includes('想要') ||
    content.includes('目标') ||
    content.includes('期望') ||
    keywords.some(k => k.includes('目标') || k.includes('期望'))
  ) {
    return { category: 'goal', rule: 'goal-keyword' };
  }
  
  // 沟通风格相关
  if (
    content.includes('喜欢') && (content.includes('说话') || content.includes('交流')) ||
    content.includes('沟通') ||
    content.includes('语气') ||
    keywords.some(k => k.includes('沟通') || k.includes('风格'))
  ) {
    return { category: 'communication', rule: 'communication-keyword' };
  }
  
  // 关系相关
  if (memory.level === 'soul') {
    return { category: 'relationship', rule: 'soul-level' };
  }
  if (content.includes('关系') || content.includes('互动') || keywords.some(k => k.includes('关系'))) {
    return { category: 'relationship', rule: 'relationship-keyword' };
  }
  
  // 默认：偏好
  return { category: 'preference', rule: 'default-preference' };
}

/**
 * 从记忆推断来源类型
 */
function inferSource(memory: MemoryEntry): ProfileSource {
  const content = memory.content.toLowerCase();
  
  // 明说：明确的第一人称陈述
  if (
    content.includes('我喜欢') ||
    content.includes('我希望') ||
    content.includes('我不') ||
    content.includes('我想') ||
    content.includes('我的')
  ) {
    return 'stated';
  }
  
  // 观察：第三人称记录或多次确认
  if (memory.accessCount >= 2 || memory.importance >= 70) {
    return 'observed';
  }
  
  // 推断：其他
  return 'inferred';
}

/**
 * 计算置信度
 */
function calculateConfidence(memory: MemoryEntry, source: ProfileSource): number {
  let confidence = memory.confidence ?? 0.5;
  
  // 根据来源调整
  if (source === 'stated') {
    confidence = Math.max(confidence, 0.9);
  } else if (source === 'observed') {
    confidence = Math.max(confidence, 0.7);
  } else {
    // inferred
    confidence = Math.min(confidence, 0.7);
  }
  
  // 根据 importance 调整
  if (memory.importance >= 80) {
    confidence += 0.1;
  } else if (memory.importance < 50) {
    confidence -= 0.1;
  }
  
  // 根据访问次数调整
  if (memory.accessCount >= 3) {
    confidence += 0.05;
  }
  
  return Math.max(0.1, Math.min(1.0, confidence));
}

/**
 * 生成画像摘要
 */
function generateSummary(items: ProfileItem[]): string {
  const parts: string[] = [];
  
  const preferences = items.filter(i => i.category === 'preference');
  const goals = items.filter(i => i.category === 'goal');
  const communication = items.filter(i => i.category === 'communication');
  const boundaries = items.filter(i => i.category === 'boundary');
  const relationship = items.filter(i => i.category === 'relationship');
  
  if (preferences.length > 0) {
    parts.push(`偏好：${preferences.slice(0, 3).map(p => p.content).join('；')}`);
  }
  
  if (goals.length > 0) {
    parts.push(`目标：${goals.slice(0, 2).map(g => g.content).join('；')}`);
  }
  
  if (communication.length > 0) {
    parts.push(`沟通：${communication[0].content}`);
  }
  
  if (boundaries.length > 0) {
    parts.push(`边界：${boundaries.slice(0, 2).map(b => b.content).join('；')}`);
  }
  
  if (relationship.length > 0) {
    parts.push(`关系：${relationship[0].content}`);
  }
  
  return parts.join('。') || '暂无画像信息。';
}

/** 把本次生成过程收成一份依据快照 */
function buildBasis(
  items: ProfileItem[],
  scanned: number,
  excluded: { sensitive: number; lowConfidence: number; expired: number },
  now: number,
  config: ProfileConfig,
): ProfileBasis {
  const byCategory: Record<ProfileCategory, number> = {
    preference: 0,
    communication: 0,
    goal: 0,
    boundary: 0,
    relationship: 0,
  };
  const bySource: Record<ProfileSource, number> = { stated: 0, observed: 0, inferred: 0 };
  for (const item of items) {
    byCategory[item.category] += 1;
    bySource[item.source] += 1;
  }
  return {
    generatedAt: now,
    levels: PROFILE_LEVELS.slice(),
    scanned,
    used: items.length,
    excluded: { ...excluded },
    evidenceIds: items.flatMap((i) => i.evidenceIds),
    byCategory,
    bySource,
    thresholds: {
      minConfidence: config.minConfidence,
      inferredExpiryDays: config.inferredExpiryDays,
      sensitiveKeywords: config.sensitiveKeywords.length,
    },
  };
}

function emptyBasis(now: number, config: ProfileConfig): ProfileBasis {
  return buildBasis([], 0, { sensitive: 0, lowConfidence: 0, expired: 0 }, now, config);
}

/**
 * 生成用户画像
 */
export function generateUserProfile(
  env: WeaveEnv,
  config: ProfileConfig = DEFAULT_PROFILE_CONFIG
): UserProfile {
  if (!config.enabled) {
    const now = Date.now();
    return {
      summary: '画像功能未启用',
      preferences: [],
      communicationStyle: [],
      goals: [],
      boundaries: [],
      relationship: [],
      generatedAt: now,
      baseMemoryCount: 0,
      basis: emptyBasis(now, config),
    };
  }
  
  const memories = getProfileMemories(env);
  const items: ProfileItem[] = [];
  const now = Date.now();
  const excluded = { sensitive: 0, lowConfidence: 0, expired: 0 };
  
  for (const memory of memories) {
    // 跳过敏感内容
    if (containsSensitiveKeywords(memory.content, memory.keywords, config.sensitiveKeywords)) {
      excluded.sensitive += 1;
      continue;
    }
    
    const source = inferSource(memory);
    const confidence = calculateConfidence(memory, source);
    
    // 跳过低置信度项
    if (confidence < config.minConfidence) {
      excluded.lowConfidence += 1;
      continue;
    }
    
    const { category, rule } = inferCategoryWithRule(memory);
    
    // 计算过期时间（仅 inferred）
    let expiresAt: number | undefined;
    if (source === 'inferred') {
      const expiryMs = config.inferredExpiryDays * 24 * 60 * 60 * 1000;
      expiresAt = memory.updatedAt + expiryMs;
      
      // 跳过已过期的推断
      if (expiresAt < now) {
        excluded.expired += 1;
        continue;
      }
    }
    
    items.push({
      category,
      content: memory.content,
      source,
      confidence,
      evidenceIds: [memory.id],
      lastConfirmedAt: memory.updatedAt,
      expiresAt,
      trace: {
        level: memory.level,
        categoryRule: rule,
        importance: memory.importance,
        accessCount: memory.accessCount,
        memoryConfidence: memory.confidence ?? null,
        updatedAt: memory.updatedAt,
      },
    });
  }
  
  // 按置信度排序
  items.sort((a, b) => b.confidence - a.confidence);
  
  // 分类
  const preferences = items.filter(i => i.category === 'preference');
  const communicationStyle = items.filter(i => i.category === 'communication');
  const goals = items.filter(i => i.category === 'goal');
  const boundaries = items.filter(i => i.category === 'boundary');
  const relationship = items.filter(i => i.category === 'relationship');
  
  return {
    summary: generateSummary(items),
    preferences,
    communicationStyle,
    goals,
    boundaries,
    relationship,
    generatedAt: now,
    baseMemoryCount: memories.length,
    basis: buildBasis(items, memories.length, excluded, now, config),
  };
}

/**
 * 清理过期的推断项
 */
export function pruneExpiredInferences(profile: UserProfile): UserProfile {
  const now = Date.now();
  
  const pruneCategory = (items: ProfileItem[]) =>
    items.filter(item => !item.expiresAt || item.expiresAt > now);
  
  const next: UserProfile = {
    ...profile,
    preferences: pruneCategory(profile.preferences),
    communicationStyle: pruneCategory(profile.communicationStyle),
    goals: pruneCategory(profile.goals),
    boundaries: pruneCategory(profile.boundaries),
    relationship: pruneCategory(profile.relationship),
  };
  // 依据快照跟着裁剪后的条目一起更新，避免「used 比实际条目多」
  if (profile.basis) {
    const items = [
      ...next.preferences,
      ...next.communicationStyle,
      ...next.goals,
      ...next.boundaries,
      ...next.relationship,
    ];
    const byCategory: Record<ProfileCategory, number> = {
      preference: 0,
      communication: 0,
      goal: 0,
      boundary: 0,
      relationship: 0,
    };
    const bySource: Record<ProfileSource, number> = { stated: 0, observed: 0, inferred: 0 };
    for (const item of items) {
      byCategory[item.category] += 1;
      bySource[item.source] += 1;
    }
    next.basis = {
      ...profile.basis,
      used: items.length,
      evidenceIds: items.flatMap((i) => i.evidenceIds),
      byCategory,
      bySource,
    };
  }
  return next;
}
