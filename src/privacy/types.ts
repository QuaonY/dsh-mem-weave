/**
 * 忆织 MemWeave —— 隐私与敏感信息类型定义
 */

/**
 * 敏感信息类型
 */
export type SensitiveType =
  | "phone"      // 手机号
  | "email"      // 邮箱
  | "id_card"    // 身份证号
  | "credit_card" // 信用卡号
  | "password"   // 密码/凭证
  | "api_key"    // API密钥
  | "ip_address" // IP地址
  | "address";   // 地址

/**
 * 检测到的敏感信息
 */
export interface SensitiveInfo {
  type: SensitiveType;
  value: string;       // 检测到的敏感值
  start: number;       // 在文本中的起始位置
  end: number;         // 结束位置
  confidence: number;  // 置信度 (0-1)
}

/**
 * 隐私配置
 */
export interface PrivacyConfig {
  enabled: boolean;           // 是否启用隐私保护
  strictMode: boolean;        // 严格模式：检测到敏感信息直接拒绝写入
  detectPII: boolean;         // 是否检测个人身份信息
  filterOnRecall: boolean;    // 召回时是否处理敏感记忆
  /**
   * 召回命中敏感条目时怎么处理。
   * - `redact`（默认）：把敏感值替换成掩码，其余内容照常召回；
   * - `filter`：整条丢弃（及以前的行为）。
   * 仅在 `filterOnRecall = true` 时生效。
   */
  recallPolicy?: "redact" | "filter";
  whitelist: string[];        // 白名单（允许的敏感信息）
}

/**
 * 默认隐私配置
 */
export const DEFAULT_PRIVACY_CONFIG: PrivacyConfig = {
  enabled: true,
  strictMode: false,
  detectPII: true,
  filterOnRecall: true,
  recallPolicy: "redact",
  whitelist: [],
};

/**
 * 隐私审计动作
 */
export type PrivacyAuditAction = "detect" | "filter" | "mark" | "whitelist";

/**
 * 隐私审计日志条目
 */
export interface PrivacyAuditEntry {
  id?: number;
  timestamp: number;
  action: PrivacyAuditAction;
  memoryId?: number;
  sensitiveType: string;
  reason: string;
  userId?: string;
}
