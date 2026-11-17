/**
 * 自动抽取器
 * 从 L0 消息中自动抽取 L1 记忆
 * - 支持多种触发器（每 N 轮、空闲、预热、手动）
 * - 所有写入通过治理流程
 * - 支持去重/合并/冲突检测
 * - 优雅降级（LLM 不可用时）
 */

import type { WeaveEnv } from "../store/db";
import type { L0Message } from "../store/l0";
import type { Level } from "../core/types";
import { getRecentL0Messages } from "../store/l0";

/** 抽取触发器类型 */
export type ExtractTrigger = "manual" | "turns" | "idle" | "warmup";

/** 抽取配置 */
export interface ExtractConfig {
  /** 是否启用自动抽取 */
  enabled: boolean;
  /** 每 N 轮触发（0 = 禁用） */
  turnsInterval: number;
  /** 空闲 N 秒后触发（0 = 禁用） */
  idleSeconds: number;
  /** 是否启用预热触发 */
  warmupEnabled: boolean;
  /** 每次抽取的最大消息数 */
  maxMessages: number;
  /** 抽取的目标层级 */
  targetLevel: Level;
}

/** 默认抽取配置 */
export const DEFAULT_EXTRACT_CONFIG: ExtractConfig = {
  enabled: true,
  turnsInterval: 5,
  idleSeconds: 600, // 10 分钟
  warmupEnabled: true,
  maxMessages: 10,
  targetLevel: "fact",
};

/** 抽取结果 */
export interface ExtractResult {
  /** 触发器类型 */
  trigger: ExtractTrigger;
  /** 抽取的消息 ID 列表 */
  messageIds: string[];
  /** 生成的候选数量 */
  candidatesCreated: number;
  /** 自动接受的数量 */
  autoAccepted: number;
  /** 跳过的数量（重复/低质量） */
  skipped: number;
  /** 质量指标 */
  quality?: {
    /** 平均质量分数 (0-1) */
    avgScore: number;
    /** 平均置信度 (0-1) */
    avgConfidence: number;
    /** 高风险候选数量 */
    highRiskCount: number;
    /** 质量分布：低（<0.5）/中（0.5-0.7）/高（>=0.7） */
    distribution: {
      low: number;
      medium: number;
      high: number;
    };
  };
  /** 错误信息 */
  error?: string;
}

/** 抽取提示词 */
export interface ExtractPrompt {
  /** 系统提示 */
  system: string;
  /** 用户提示（包含消息内容） */
  user: string;
}

/**
 * 生成抽取提示词
 */
export function buildExtractPrompt(messages: L0Message[]): ExtractPrompt {
  const conversationText = messages
    .reverse() // 按时间正序
    .map(m => `[${m.role}]: ${m.content}`)
    .join("\n\n");

  const system = `你是一个记忆抽取助手。请从对话中提取有价值的信息，转换为结构化的记忆条目。

抽取原则：
1. 只提取**事实性、可验证**的信息（不提取意见、猜测）
2. 优先提取**人物、项目、技术栈、决策**等关键信息
3. 每条记忆应该**独立完整**，无需上下文即可理解
4. 使用**主动语态、第三人称**描述
5. 避免重复已有的信息

输出格式（JSON数组）：
[
  {
    "level": "memory",
    "content": "记忆内容（完整句子）",
    "keywords": ["关键词1", "关键词2"],
    "confidence": 0.8,
    "reason": "提取理由"
  }
]

如果没有值得提取的信息，返回空数组 []。`;

  const user = `请从以下对话中提取记忆：

${conversationText}

请返回 JSON 格式的记忆数组。`;

  return { system, user };
}

/**
 * 解析 LLM 返回的抽取结果
 */
export function parseExtractResponse(response: string): Array<{
  level: Level;
  content: string;
  keywords: string[];
  confidence: number;
  reason: string;
}> {
  try {
    // 尝试提取 JSON（可能被包裹在 markdown 代码块中）
    const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)\s*```/) || 
                      response.match(/(\[[\s\S]*\])/);
    
    const jsonText = jsonMatch ? jsonMatch[1] : response;
    const parsed = JSON.parse(jsonText);
    
    if (!Array.isArray(parsed)) {
      return [];
    }
    
    // 验证并标准化
    return parsed
      .filter(item => {
        if (!item || typeof item !== "object") return false;
        if (typeof item.content !== "string") return false;
        const trimmed = item.content.trim();
        return trimmed.length > 0 && !/^[\s\n\r\t]*$/.test(trimmed);
      })
      .map(item => ({
        level: (item.level || "memory") as Level,
        content: item.content.trim(),
        keywords: Array.isArray(item.keywords) ? item.keywords : [],
        confidence: typeof item.confidence === "number" ? item.confidence : 0.5,
        reason: item.reason || "",
      }));
  } catch (e) {
    // 解析失败，返回空数组
    return [];
  }
}

/**
 * 检查是否应该触发抽取（基于轮数）
 */
export function shouldTriggerByTurns(
  turnCount: number,
  config: ExtractConfig
): boolean {
  if (!config.enabled || config.turnsInterval <= 0) return false;
  return turnCount > 0 && turnCount % config.turnsInterval === 0;
}

/**
 * 检查是否应该触发抽取（基于空闲时间）
 */
export function shouldTriggerByIdle(
  lastActivityMs: number,
  nowMs: number,
  config: ExtractConfig
): boolean {
  if (!config.enabled || config.idleSeconds <= 0) return false;
  const idleMs = nowMs - lastActivityMs;
  return idleMs >= config.idleSeconds * 1000;
}

/**
 * 计算预热触发的间隔（指数退避）
 * 轮数 -> 间隔
 * 1 -> 1（第1轮后立即）
 * 2 -> 2（第2轮后）
 * 3-4 -> 5（第5轮后）
 * 5-9 -> 10（第10轮后）
 * 10+ -> 20（每20轮）
 */
export function getWarmupInterval(turnCount: number): number {
  if (turnCount <= 0) return 0;
  if (turnCount === 1) return 1;
  if (turnCount === 2) return 2;
  if (turnCount <= 4) return 5;
  if (turnCount <= 9) return 10;
  return 20;
}

/**
 * 检查是否应该触发预热抽取
 */
export function shouldTriggerByWarmup(
  turnCount: number,
  config: ExtractConfig
): boolean {
  if (!config.enabled || !config.warmupEnabled) return false;
  
  // 预热序列：1, 2, 5, 10, 20, 40, 60...
  if (turnCount === 1 || turnCount === 2 || turnCount === 5 || turnCount === 10) {
    return true;
  }
  
  // 10 轮后每 20 轮触发一次
  if (turnCount > 10 && turnCount % 20 === 0) {
    return true;
  }
  
  return false;
}

/**
 * 获取需要抽取的消息
 */
export function getMessagesForExtraction(
  env: WeaveEnv,
  sessionId: string,
  config: ExtractConfig
): L0Message[] {
  return getRecentL0Messages(env, sessionId, config.maxMessages);
}

/**
 * 评估抽取项的风险等级
 * 返回 true 表示高风险（需要人工审核）
 */
export function isHighRisk(
  level: Level,
  content: string,
  keywords: string[]
): boolean {
  // soul/rules 层级自动为高风险
  if (level === "soul" || level === "rules") return true;
  
  // 包含敏感关键词
  const sensitiveKeywords = [
    "密码", "password", "token", "secret", "key",
    "删除", "delete", "remove", "清空",
    "永久", "permanent", "不可逆"
  ];
  
  const lowerContent = content.toLowerCase();
  const lowerKeywords = keywords.map(k => k.toLowerCase());
  
  for (const sensitive of sensitiveKeywords) {
    if (lowerContent.includes(sensitive) || 
        lowerKeywords.some(k => k.includes(sensitive))) {
      return true;
    }
  }
  
  return false;
}

/**
 * 评估抽取项的质量分数（0-1）
 */
export function assessQuality(
  content: string,
  keywords: string[],
  confidence: number
): number {
  let score = confidence;
  
  // 内容长度评分
  const contentLength = content.length;
  if (contentLength < 20) {
    score *= 0.5; // 太短
  } else if (contentLength > 500) {
    score *= 0.8; // 太长
  }
  
  // 关键词数量评分
  if (keywords.length === 0) {
    score *= 0.6; // 缺少关键词
  } else if (keywords.length > 10) {
    score *= 0.8; // 关键词过多
  }
  
  // 检查是否包含无意义的占位符
  const placeholders = ["TODO", "TBD", "...", "待补充"];
  for (const ph of placeholders) {
    if (content.includes(ph)) {
      score *= 0.3;
      break;
    }
  }
  
  return Math.max(0, Math.min(1, score));
}
