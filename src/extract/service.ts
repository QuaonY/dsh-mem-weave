/**
 * 抽取服务
 * 集成 L0 捕获、抽取器和治理系统
 */

import type { WeaveEnv } from "../store/db";
import type { Level, Evidence } from "../core/types";
import type { ExtractConfig, ExtractResult, ExtractTrigger } from "./extractor";
import {
  getMessagesForExtraction,
  buildExtractPrompt,
  parseExtractResponse,
  isHighRisk,
  assessQuality,
} from "./extractor";
import { insertCandidate, newId, type CandidateRow } from "../store/dao";
import { searchMemoryFTS } from "../store/fts";
import { searchSimilar } from "../store/vector";
import { LAYER_TABLES } from "../store/schema";

/** 抽取选项 */
export interface ExtractOptions {
  /** 触发器类型 */
  trigger: ExtractTrigger;
  /** 是否使用 LLM（false 时优雅降级） */
  useLLM?: boolean;
  /** LLM 调用函数 */
  llmCall?: (system: string, user: string) => Promise<string>;
  /** 质量阈值（0-1） */
  qualityThreshold?: number;
  /** 去重相似度阈值（0-1） */
  dedupeThreshold?: number;
}

/**
 * 执行记忆抽取
 */
export async function extractMemories(
  env: WeaveEnv,
  sessionId: string,
  config: ExtractConfig,
  options: ExtractOptions
): Promise<ExtractResult> {
  const result: ExtractResult = {
    trigger: options.trigger,
    messageIds: [],
    candidatesCreated: 0,
    autoAccepted: 0,
    skipped: 0,
  };

  try {
    // 1. 获取要抽取的消息
    const messages = getMessagesForExtraction(env, sessionId, config);
    
    if (messages.length === 0) {
      return result;
    }
    
    result.messageIds = messages.map(m => m.id);

    // 2. 如果没有 LLM，优雅降级
    if (!options.useLLM || !options.llmCall) {
      result.error = "LLM unavailable, graceful degradation";
      return result;
    }

    // 3. 调用 LLM 进行抽取
    const prompt = buildExtractPrompt(messages);
    const response = await options.llmCall(prompt.system, prompt.user);
    const extractedItems = parseExtractResponse(response);

    if (extractedItems.length === 0) {
      return result;
    }

    // 4. 处理每个抽取项
    const qualityThreshold = options.qualityThreshold ?? 0.5;
    const dedupeThreshold = options.dedupeThreshold ?? 0.85;

    // 质量统计
    const qualityStats = {
      totalQuality: 0,
      totalConfidence: 0,
      count: 0,
      highRisk: 0,
      low: 0,      // < 0.5
      medium: 0,   // 0.5 - 0.7
      high: 0,     // >= 0.7
    };

    for (const item of extractedItems) {
      // 4.1 评估质量
      const quality = assessQuality(item.content, item.keywords, item.confidence);
      
      // 收集统计（即使跳过也统计，了解整体质量）
      qualityStats.totalQuality += quality;
      qualityStats.totalConfidence += item.confidence;
      qualityStats.count++;
      
      // 质量分布
      if (quality < 0.5) {
        qualityStats.low++;
      } else if (quality < 0.7) {
        qualityStats.medium++;
      } else {
        qualityStats.high++;
      }
      
      if (quality < qualityThreshold) {
        result.skipped++;
        continue;
      }

      // 4.2 去重检查
      const isDuplicate = await checkDuplicate(
        env,
        item.level,
        item.content,
        item.keywords,
        dedupeThreshold
      );
      
      if (isDuplicate) {
        result.skipped++;
        continue;
      }

      // 4.3 风险评估
      const highRisk = isHighRisk(item.level, item.content, item.keywords);
      
      if (highRisk) {
        qualityStats.highRisk++;
      }

      // 4.4 创建候选
      const now = Date.now();
      const metadata = {
        quality,
        confidence: item.confidence,
        reason: item.reason,
        l0MessageIds: result.messageIds,
        trigger: options.trigger,
      };

      // 证据回溯 - 将 L0 消息作为证据
      const evidence: Evidence[] = result.messageIds.map(msgId => {
        // Extract session ID and seq from L0 message
        const l0Msg = env.db.prepare("SELECT session_id, seq, content FROM l0_messages WHERE id = ?").get(msgId) as 
          { session_id: string; seq: number; content: string } | undefined;
        return {
          sessionId: l0Msg?.session_id ?? "unknown",
          seq: l0Msg?.seq ?? 0,
          quote: l0Msg?.content.slice(0, 100) ?? "",
        };
      });

      const candidate: CandidateRow = {
        id: newId(),
        level: item.level,
        project: null,
        content: item.content,
        keywords: item.keywords,
        importance: 50, // Default importance
        semanticKey: null,
        evidence,  // L0 消息作为证据
        tier: "hot", // Extract candidates go through L2 review
        verdict: highRisk ? "pending" : "accepted",
        risk: highRisk ? "high" : "low",
        reason: `Auto-extracted (${options.trigger}): ${item.reason}. Quality=${quality.toFixed(2)}, Confidence=${item.confidence}`,
        mergedInto: null,
        createdAt: now,
        decidedAt: highRisk ? null : now,
        decidedBy: highRisk ? null : "extract",
        patch: undefined,
      };

      insertCandidate(env, candidate);

      result.candidatesCreated++;
      
      if (!highRisk) {
        result.autoAccepted++;
      }
    }

    // 5. 添加质量指标
    if (qualityStats.count > 0) {
      result.quality = {
        avgScore: qualityStats.totalQuality / qualityStats.count,
        avgConfidence: qualityStats.totalConfidence / qualityStats.count,
        highRiskCount: qualityStats.highRisk,
        distribution: {
          low: qualityStats.low,
          medium: qualityStats.medium,
          high: qualityStats.high,
        },
      };
    }

    return result;
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
    return result;
  }
}

/**
 * 检查是否与现有记忆重复
 * 使用 FTS + Vector 双重检查，限制在同一层级内
 */
async function checkDuplicate(
  env: WeaveEnv,
  level: Level,
  content: string,
  keywords: string[],
  threshold: number
): Promise<boolean> {
  // 1. FTS 检查（快速，限制在同一层级）
  const ftsResults = searchMemoryFTS(env, content, { level, limit: 5 });
  
  for (const result of ftsResults) {
    // 需要根据 id 查询出 content
    // FTS 已按层级过滤，只需查询对应层级的表
    try {
      const table = LAYER_TABLES[level as Level];
      const row = env.db.prepare(`SELECT content FROM ${table} WHERE id = ?`).get(result.id) as { content: string } | undefined;
      
      if (row) {
        const similarity = calculateTextSimilarity(content, row.content);
        if (similarity >= threshold) {
          return true;
        }
      }
    } catch {
      // 查询失败，跳过
    }
  }

  // 2. Vector 检查（语义）
  try {
    const vectorResults = await searchSimilar(env, content, { limit: 5 });
    
    for (const result of vectorResults) {
      if (result.score >= threshold) {
        return true;
      }
    }
  } catch {
    // Vector 不可用时跳过（优雅降级）
  }

  return false;
}

/**
 * 计算文本相似度（简单实现）
 */
function calculateTextSimilarity(text1: string, text2: string): number {
  const words1 = new Set(text1.toLowerCase().split(/\s+/));
  const words2 = new Set(text2.toLowerCase().split(/\s+/));
  
  const intersection = new Set([...words1].filter(w => words2.has(w)));
  const union = new Set([...words1, ...words2]);
  
  return union.size > 0 ? intersection.size / union.size : 0;
}
