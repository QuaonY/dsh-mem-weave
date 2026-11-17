/**
 * 忆织 MemWeave —— 多模型 Persona 管理器
 * 合并全局 persona 和会话级 persona 覆盖。
 */

import type { PersonaConfig } from "../core/types";
import type { WeaveEnv } from "../store/db";
import type { SessionPersonaOverrides, MultiPersonaConfig } from "./types";
import { getSessionPersona } from "./storage";

export class PersonaManager {
  private config: MultiPersonaConfig;

  constructor(config: MultiPersonaConfig) {
    this.config = config;
  }

  /**
   * 合并全局 persona 和会话级覆盖
   */
  mergePersona(
    env: WeaveEnv,
    sessionId: string,
    globalPersona: PersonaConfig
  ): PersonaConfig {
    if (!this.config.enabled) {
      return globalPersona;
    }

    const sessionPersona = getSessionPersona(env, sessionId);
    if (!sessionPersona || !sessionPersona.enabled) {
      return globalPersona;
    }

    // 检查是否过期
    if (this.isExpired(sessionPersona.updatedAt)) {
      return globalPersona;
    }

    // 合并覆盖
    return this.applyOverrides(globalPersona, sessionPersona.overrides);
  }

  /**
   * 应用会话级覆盖到全局 persona
   */
  private applyOverrides(
    global: PersonaConfig,
    overrides: Partial<SessionPersonaOverrides>
  ): PersonaConfig {
    const merged: PersonaConfig = { ...global };

    // 简单字段覆盖
    if (overrides.thinkingLanguage !== undefined) {
      merged.thinkingLanguage = overrides.thinkingLanguage;
    }
    if (overrides.stance !== undefined) {
      merged.stance = overrides.stance;
    }
    if (overrides.character !== undefined) {
      merged.character = overrides.character;
    }
    if (overrides.suffix !== undefined) {
      merged.suffix = overrides.suffix;
    }

    // selfName 和 userName
    if (overrides.selfName !== undefined) {
      merged.selfNamePro = overrides.selfName;
      merged.selfNameFlash = overrides.selfName;
    }
    if (overrides.userName !== undefined) {
      merged.userName = overrides.userName;
    }

    // appearance 和 tone（如果启用）
    if (overrides.appearance !== undefined && merged.appearance.enabled) {
      merged.appearance.text = overrides.appearance;
    }
    if (overrides.tone !== undefined && merged.tone.enabled) {
      merged.tone.text = overrides.tone;
    }

    return merged;
  }

  /**
   * 检查会话 persona 是否过期
   */
  private isExpired(updatedAt: number): boolean {
    const now = Date.now();
    const ageMs = now - updatedAt;
    const ttlMs = this.config.defaultTTL * 1000;
    return ageMs > ttlMs;
  }
}
