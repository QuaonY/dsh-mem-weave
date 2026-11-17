/**
 * 忆织 MemWeave —— 多模型 Persona
 * 支持为每个会话设置独立的 systemPrompt。
 */

export { PersonaManager } from "./manager";
export {
  getSessionPersona,
  setSessionPersona,
  clearSessionPersona,
  listSessionPersonas,
  disableSessionPersona,
  enableSessionPersona,
} from "./storage";

export type {
  SessionPersona,
  SessionPersonaOverrides,
  MultiPersonaConfig,
} from "./types";

export { DEFAULT_MULTI_PERSONA_CONFIG } from "./types";
