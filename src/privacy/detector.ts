/**
 * 忆织 MemWeave —— 敏感信息检测器
 * 使用规则引擎检测文本中的敏感信息（PII）
 */

import type { PrivacyConfig, SensitiveInfo } from "./types";

/**
 * 敏感信息检测器
 */
export class SensitivityDetector {
  // 中国手机号：1[3-9]\d{9}
  private static readonly PHONE_PATTERN = /1[3-9]\d{9}/g;

  // 邮箱
  private static readonly EMAIL_PATTERN = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g;

  // 身份证号：18位
  private static readonly ID_CARD_PATTERN = /\b\d{17}[\dXx]\b/g;

  // 信用卡号：13-19位数字，可能包含空格或-分隔
  private static readonly CREDIT_CARD_PATTERN = /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{3,4}\b/g;

  // 密码特征：password=xxx, pwd:xxx, token=xxx, api_key=xxx
  private static readonly PASSWORD_PATTERN = /(password|pwd|token|secret|apikey|api_key)[=:]\s*\S+/gi;

  // IPv4 地址（先由 isPrivateIpv4 过滤非法写法与局域网/保留地址，只把公网地址当敏感信息）
  private static readonly IP_PATTERN = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g;

  /** 局域网/保留地址不指向具体人，不按 PII 处理 */
  private static isPrivateIpv4(value: string): boolean {
    const parts = value.split(".").map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // 运营商级 NAT
    if (a >= 224) return true; // 组播与保留段
    return false;
  }

  // 地址特征（简化版，检测中文地址关键词）
  private static readonly ADDRESS_PATTERN = /[省市区县镇街道路号楼室]\d+[号楼室]|[\u4e00-\u9fa5]{2,}[省市区县][^\d]{0,20}\d+号/g;

  /**
   * 检测文本中的敏感信息
   */
  detect(text: string, config: PrivacyConfig): SensitiveInfo[] {
    const results: SensitiveInfo[] = [];

    if (!config.detectPII) {
      return results;
    }

    // 检测手机号
    this.detectPattern(text, SensitivityDetector.PHONE_PATTERN, "phone", 0.95, config.whitelist, results);

    // 检测邮箱
    this.detectPattern(text, SensitivityDetector.EMAIL_PATTERN, "email", 0.9, config.whitelist, results);

    // 检测身份证号
    this.detectPattern(text, SensitivityDetector.ID_CARD_PATTERN, "id_card", 0.85, config.whitelist, results);

    // 检测信用卡号
    this.detectPattern(text, SensitivityDetector.CREDIT_CARD_PATTERN, "credit_card", 0.8, config.whitelist, results);

    // 检测密码/token
    this.detectPattern(text, SensitivityDetector.PASSWORD_PATTERN, "password", 0.8, config.whitelist, results);

    // 检测IP地址（只记公网地址；局域网/保留地址不算 PII）
    this.detectIpv4(text, config.whitelist, results);

    // 检测地址
    this.detectPattern(text, SensitivityDetector.ADDRESS_PATTERN, "address", 0.6, config.whitelist, results);

    return results;
  }

  /**
   * 使用正则模式检测
   */
  private detectPattern(
    text: string,
    pattern: RegExp,
    type: SensitiveInfo["type"],
    confidence: number,
    whitelist: string[],
    results: SensitiveInfo[]
  ): void {
    // 重置正则的 lastIndex
    pattern.lastIndex = 0;

    for (const match of text.matchAll(pattern)) {
      const value = match[0];
      if (!this.isWhitelisted(value, whitelist)) {
        results.push({
          type,
          value,
          start: match.index!,
          end: match.index! + value.length,
          confidence,
        });
      }
    }
  }

  /**
   * 检测 IPv4：跳过非法写法与局域网/保留地址。
   */
  private detectIpv4(
    text: string,
    whitelist: string[],
    results: SensitiveInfo[]
  ): void {
    SensitivityDetector.IP_PATTERN.lastIndex = 0;
    for (const match of text.matchAll(SensitivityDetector.IP_PATTERN)) {
      const value = match[0];
      if (SensitivityDetector.isPrivateIpv4(value)) continue;
      if (this.isWhitelisted(value, whitelist)) continue;
      results.push({
        type: "ip_address",
        value,
        start: match.index!,
        end: match.index! + value.length,
        confidence: 0.7,
      });
    }
  }

  /**
   * 检查是否在白名单中
   */
  private isWhitelisted(value: string, whitelist?: string[]): boolean {
    if (!whitelist || whitelist.length === 0) {
      return false;
    }
    return whitelist.some((item) => value.includes(item) || item.includes(value));
  }

  /**
   * 检测文本是否包含敏感信息
   */
  hasSensitiveInfo(text: string, config: PrivacyConfig): boolean {
    return this.detect(text, config).length > 0;
  }

  /**
   * 获取敏感信息类型列表
   */
  getSensitiveTypes(text: string, config: PrivacyConfig): string[] {
    const results = this.detect(text, config);
    const types = new Set(results.map((r) => r.type));
    return Array.from(types);
  }
}
