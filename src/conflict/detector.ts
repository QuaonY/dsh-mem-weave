/**
 * 记忆冲突检测器
 * 检测记忆之间的时间、事实、观点矛盾
 */

import type { MemoryEntry } from "../core/types";
import { buildCandidatePairs } from "./candidates";
import { jaccard, tokenSet } from "./tokens";
import type { ConflictType, MemoryConflict, ConflictResolution } from "./types";

/** 冲突检测器 */
export class ConflictDetector {
  /**
   * 检测两条记忆是否冲突
   */
  detectConflict(
    a: MemoryEntry,
    b: MemoryEntry,
    threshold: number = 0.85,
  ): MemoryConflict | null {
    // 如果记忆相同，不是冲突
    if (a.id === b.id) return null;

    // 如果有情绪价，优先检测观点冲突（避免被事实冲突模式覆盖）
    if ((a.valence !== undefined || b.valence !== undefined)) {
      const opinionConflict = this.detectOpinionConflict(a, b, threshold);
      if (opinionConflict && opinionConflict.confidence >= threshold) {
        return opinionConflict;
      }
    }

    // 检测时间冲突
    const timeConflict = this.detectTimeConflict(a, b);
    if (timeConflict && timeConflict.confidence >= threshold) {
      return timeConflict;
    }

    // 检测事实冲突
    const factConflict = this.detectFactConflict(a, b, threshold);
    if (factConflict && factConflict.confidence >= threshold) {
      return factConflict;
    }

    // 最后检测观点冲突
    const opinionConflict = this.detectOpinionConflict(a, b, threshold);
    if (opinionConflict && opinionConflict.confidence >= threshold) {
      return opinionConflict;
    }

    return null;
  }

  /**
   * 检测时间冲突
   * 例如：同一事件的不同时间记录
   */
  private detectTimeConflict(a: MemoryEntry, b: MemoryEntry): MemoryConflict | null {
    // 检测是否谈论同一事件
    const similarity = this.contentSimilarity(a.content, b.content);
    if (similarity < 0.5) return null; // 不是同一事件

    // 检测文本中的时间词汇冲突
    const timePatterns = [
      { a: /上午|早上|早晨|清晨/, b: /下午|傍晚|晚上|夜间/ },
      { a: /今天|当天/, b: /昨天|前天|明天|后天/ },
      { a: /本周/, b: /上周|下周/ },
      { a: /本月/, b: /上月|下月/ },
      { a: /今年/, b: /去年|明年/ },
      { a: /周一|星期一|Monday/, b: /周二|星期二|Tuesday|周三|星期三|Wednesday|周四|星期四|Thursday|周五|星期五|Friday|周六|星期六|Saturday|周日|星期日|Sunday/ },
    ];

    for (const pattern of timePatterns) {
      const aHasTime = pattern.a.test(a.content);
      const bHasTime = pattern.b.test(b.content);
      
      if (aHasTime && bHasTime && similarity > 0.5) {
        return this.createConflict(a, b, "time", 0.85, "Different time references for similar events");
      }
    }

    // 检查时间戳矛盾
    const hasTimeA = a.validFrom || a.createdAt;
    const hasTimeB = b.validFrom || b.createdAt;
    
    if (!hasTimeA || !hasTimeB) return null;

    // 如果时间差异显著（超过7天），可能是时间冲突
    const timeDiff = Math.abs(hasTimeA - hasTimeB);
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    
    if (timeDiff > sevenDays && similarity > 0.6) {
      return this.createConflict(a, b, "time", 0.90, "Different timestamps for similar events");
    }

    return null;
  }

  /**
   * 检测事实冲突
   * 例如：相互矛盾的陈述
   */
  private detectFactConflict(
    a: MemoryEntry,
    b: MemoryEntry,
    threshold: number,
  ): MemoryConflict | null {
    // 检测否定词和矛盾模式
    const aNormalized = a.content.toLowerCase();
    const bNormalized = b.content.toLowerCase();

    // 相似度高但包含否定词
    const similarity = this.contentSimilarity(a.content, b.content);
    if (similarity < 0.5) return null;

    const negationPatterns = [
      { positive: /喜欢|热爱|偏好/, negative: /不喜欢|讨厌|不爱/ },
      { positive: /是|确实|肯定/, negative: /不是|并非|否定/ },
      { positive: /能|可以|会/, negative: /不能|不可以|不会/ },
      { positive: /有/, negative: /没有|无/ },
      { positive: /支持|赞成/, negative: /反对|不支持/ },
      { positive: /允许|同意/, negative: /禁止|拒绝/ },
      { positive: /好|棒|优秀|很好|不错/, negative: /不好|糟糕|很差|不行/ },
      { positive: /启用|开启|打开/, negative: /不启用|不开启|关闭|禁用/ },
      { positive: /通过|成功|完成/, negative: /不通过|失败|未完成/ },
    ];

    for (const pattern of negationPatterns) {
      const aPositive = pattern.positive.test(aNormalized);
      const aNegative = pattern.negative.test(aNormalized);
      const bPositive = pattern.positive.test(bNormalized);
      const bNegative = pattern.negative.test(bNormalized);

      // A 是肯定，B 是否定 (或相反)
      if ((aPositive && bNegative) || (aNegative && bPositive)) {
        return this.createConflict(
          a,
          b,
          "fact",
          0.85,
          "Contradictory statements detected",
        );
      }
    }

    return null;
  }

  /**
   * 检测观点冲突
   * 例如：态度或偏好改变
   */
  private detectOpinionConflict(
    a: MemoryEntry,
    b: MemoryEntry,
    threshold: number,
  ): MemoryConflict | null {
    const similarity = this.contentSimilarity(a.content, b.content);
    if (similarity < 0.5) return null;

    // 检测情绪价反转
    if (a.valence !== undefined && a.valence !== null && b.valence !== undefined && b.valence !== null) {
      // 情绪价相反（一个积极，一个消极）
      if ((a.valence > 0.3 && b.valence < -0.3) || (a.valence < -0.3 && b.valence > 0.3)) {
        return this.createConflict(
          a,
          b,
          "opinion",
          0.85,
          "Opposite emotional valence for similar content",
        );
      }
    }

    // 检测正反评价词汇对比
    const positiveWords = /很好|不错|优秀|棒|喜欢|满意|赞|好用|舒服|方便/;
    const negativeWords = /不好|很差|糟糕|讨厌|不满意|差|难用|别扭|麻烦/;
    
    const aPositive = positiveWords.test(a.content);
    const aNegative = negativeWords.test(a.content);
    const bPositive = positiveWords.test(b.content);
    const bNegative = negativeWords.test(b.content);
    
    // 注意：如果一个既有正面词又有负面词（如"不好"包含"好"），优先看负面词
    // 因此需要先检查负面词，或者使用更精确的模式
    if (similarity > 0.5) {
      if ((aPositive && !aNegative && bNegative) || (aNegative && bPositive && !bNegative)) {
        return this.createConflict(
          a,
          b,
          "opinion",
          0.85,
          "Opposite opinions on similar topic",
        );
      }
    }

    // 检测偏好词汇矛盾
    const preferencePatterns = [
      /喜欢|热爱|偏爱|倾向/,
      /讨厌|不喜欢|厌恶/,
      /认为|觉得|以为/,
      /希望|期待|想要/,
    ];

    let aHasOpinion = false;
    let bHasOpinion = false;
    for (const pattern of preferencePatterns) {
      if (pattern.test(a.content)) aHasOpinion = true;
      if (pattern.test(b.content)) bHasOpinion = true;
    }

    if (aHasOpinion && bHasOpinion && similarity > 0.5) {
      // 有类似主题的不同观点，可能是观点改变
      return this.createConflict(
        a,
        b,
        "opinion",
        0.85,
        "Different opinions on similar topic",
      );
    }

    return null;
  }

  /**
   * 计算内容相似度（简单版：基于词汇重叠）
   * 分词与相似度口径抽到 `tokens.ts`，与候选对生成共用同一套 token。
   */
  private contentSimilarity(a: string, b: string): number {
    return jaccard(tokenSet(a), tokenSet(b));
  }

  /**
   * 创建冲突记录
   */
  private createConflict(
    a: MemoryEntry,
    b: MemoryEntry,
    type: ConflictType,
    confidence: number,
    reason: string,
  ): MemoryConflict {
    // 建议解决方案：基于时间和置信度
    let suggested: ConflictResolution = "keep_b"; // 默认保留较新的

    if (a.createdAt && b.createdAt) {
      // 保留较新的记忆
      suggested = a.createdAt > b.createdAt ? "keep_a" : "keep_b";
    }

    if (a.confidence && b.confidence) {
      // 如果置信度差异显著，保留置信度高的
      if (Math.abs(a.confidence - b.confidence) > 0.3) {
        suggested = a.confidence > b.confidence ? "keep_a" : "keep_b";
      }
    }

    // 观点冲突建议标记为补充（态度可能随时间改变）
    if (type === "opinion") {
      suggested = "complement";
    }

    return {
      id: 0, // 数据库会分配
      memory_id_a: a.id,
      memory_id_b: b.id,
      level_a: a.level,
      level_b: b.level,
      conflict_type: type,
      confidence,
      status: "pending",
      reason,
      suggested_resolution: suggested,
      created_at: Date.now(),
    };
  }

  /**
   * 批量检测冲突
   * 先用前缀过滤生成候选对（默认精确、不丢 true conflict），再对候选对做精确判定。
   * 输出顺序与旧的两两穷举一致：按下标升序、再按下标升序。
   * @param options.maxCandidatesPerDoc 每篇文档最多保留的候选邻居数；
   *        0 / 不传为精确模式。超大库可用它给倒排探测兜底。
   */
  detectConflicts(
    memories: MemoryEntry[],
    threshold: number = 0.85,
    options: { maxCandidatesPerDoc?: number } = {},
  ): MemoryConflict[] {
    const { pairs } = buildCandidatePairs(
      memories.map((m) => ({ id: m.id, content: m.content })),
      { maxCandidatesPerDoc: options.maxCandidatesPerDoc },
    );

    const conflicts: MemoryConflict[] = [];
    for (const [i, j] of pairs) {
      const conflict = this.detectConflict(memories[i], memories[j], threshold);
      if (conflict) {
        conflicts.push(conflict);
      }
    }

    return conflicts;
  }
}
