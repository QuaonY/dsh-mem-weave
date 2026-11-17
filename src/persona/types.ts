/**
 * 忆织 MemWeave —— 多模型 Persona
 * 支持为每个会话设置独立的 systemPrompt 覆盖。
 */

export interface SessionPersona {
  sessionId: string;
  /** 是否启用会话级 persona */
  enabled: boolean;
  /** 覆盖全局 persona 的字段 */
  overrides: Partial<SessionPersonaOverrides>;
  createdAt: number;
  updatedAt: number;
}

export interface SessionPersonaOverrides {
  /** 自称 */
  selfName?: string;
  /** 用户称呼 */
  userName?: string;
  /** 立场 */
  stance?: string;
  /** 性格 */
  character?: string;
  /** 后缀 */
  suffix?: string;
  /** 思考语言 */
  thinkingLanguage?: string;
  /** 外观描述 */
  appearance?: string;
  /** 语气 */
  tone?: string;
}

export interface MultiPersonaConfig {
  /** 是否启用多模型 persona 功能 */
  enabled: boolean;
  /** 会话 persona 的默认超时时间（秒），超过后恢复全局 persona */
  defaultTTL: number;
}

export const DEFAULT_MULTI_PERSONA_CONFIG: MultiPersonaConfig = {
  enabled: false,
  defaultTTL: 86400, // 24 小时
};
