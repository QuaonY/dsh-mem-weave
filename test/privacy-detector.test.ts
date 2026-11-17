/**
 * 忆织 MemWeave —— 敏感信息检测器测试
 */

import { describe, expect, it } from "vitest";
import { SensitivityDetector } from "../src/privacy/detector";
import { DEFAULT_PRIVACY_CONFIG, type PrivacyConfig } from "../src/privacy/types";

describe("敏感信息检测", () => {
  const detector = new SensitivityDetector();
  const config: PrivacyConfig = { ...DEFAULT_PRIVACY_CONFIG };

  describe("手机号检测", () => {
    it("检测有效的中国手机号", () => {
      const text = "我的电话是 13812345678，请联系我。";
      const results = detector.detect(text, config);
      expect(results).toHaveLength(1);
      expect(results[0].type).toBe("phone");
      expect(results[0].value).toBe("13812345678");
      expect(results[0].confidence).toBeGreaterThan(0.9);
    });

    it("检测多个手机号", () => {
      const text = "联系方式：13912345678 或 15812345678";
      const results = detector.detect(text, config);
      const phones = results.filter((r) => r.type === "phone");
      expect(phones).toHaveLength(2);
    });

    it("不检测无效的手机号", () => {
      const text = "12345678901 不是有效手机号";
      const results = detector.detect(text, config);
      const phones = results.filter((r) => r.type === "phone");
      expect(phones).toHaveLength(0);
    });
  });

  describe("邮箱检测", () => {
    it("检测有效的邮箱地址", () => {
      const text = "发邮件到 user@example.com";
      const results = detector.detect(text, config);
      expect(results).toHaveLength(1);
      expect(results[0].type).toBe("email");
      expect(results[0].value).toBe("user@example.com");
    });

    it("检测多种邮箱格式", () => {
      const text = "联系：user@example.com, admin@test.org, info@company.co.uk";
      const results = detector.detect(text, config);
      const emails = results.filter((r) => r.type === "email");
      expect(emails).toHaveLength(3);
    });
  });

  describe("身份证号检测", () => {
    it("检测18位身份证号", () => {
      const text = "身份证：110101199001011234";
      const results = detector.detect(text, config);
      const idCards = results.filter((r) => r.type === "id_card");
      expect(idCards).toHaveLength(1);
    });

    it("检测带X的身份证号", () => {
      const text = "证件号：11010119900101123X";
      const results = detector.detect(text, config);
      const idCards = results.filter((r) => r.type === "id_card");
      expect(idCards).toHaveLength(1);
    });
  });

  describe("信用卡号检测", () => {
    it("检测标准信用卡号", () => {
      const text = "卡号：6222 0012 3456 7890";
      const results = detector.detect(text, config);
      const cards = results.filter((r) => r.type === "credit_card");
      expect(cards).toHaveLength(1);
    });

    it("检测无分隔符的信用卡号", () => {
      const text = "Card: 4532123456789012";
      const results = detector.detect(text, config);
      const cards = results.filter((r) => r.type === "credit_card");
      expect(cards).toHaveLength(1);
    });
  });

  describe("密码/凭证检测", () => {
    it("检测密码字段", () => {
      const text = "password=secret123";
      const results = detector.detect(text, config);
      const passwords = results.filter((r) => r.type === "password");
      expect(passwords).toHaveLength(1);
    });

    it("检测token", () => {
      const text = "API token: sk-abc123def456";
      const results = detector.detect(text, config);
      const passwords = results.filter((r) => r.type === "password");
      expect(passwords).toHaveLength(1);
    });

    it("检测api_key", () => {
      const text = "api_key=AKIAIOSFODNN7EXAMPLE";
      const results = detector.detect(text, config);
      const passwords = results.filter((r) => r.type === "password");
      expect(passwords).toHaveLength(1);
    });
  });

  describe("IP地址检测", () => {
    it("检测公网 IPv4 地址", () => {
      const text = "服务器地址：8.8.8.8";
      const results = detector.detect(text, config);
      const ips = results.filter((r) => r.type === "ip_address");
      expect(ips).toHaveLength(1);
      expect(ips[0].value).toBe("8.8.8.8");
    });

    it("局域网与保留地址不算敏感信息", () => {
      for (const ip of ["192.168.1.100", "10.0.0.8", "172.16.31.4", "127.0.0.1", "169.254.2.3", "0.0.0.0", "224.0.0.1"]) {
        const results = detector.detect(`地址：${ip}`, config);
        expect(results.filter((r) => r.type === "ip_address")).toHaveLength(0);
      }
    });
  });

  describe("白名单功能", () => {
    it("白名单排除指定邮箱", () => {
      const configWithWhitelist: PrivacyConfig = {
        ...config,
        whitelist: ["user@example.com"],
      };
      const text = "发邮件到 user@example.com 或 admin@test.com";
      const results = detector.detect(text, configWithWhitelist);
      const emails = results.filter((r) => r.type === "email");
      expect(emails).toHaveLength(1);
      expect(emails[0].value).toBe("admin@test.com");
    });

    it("白名单排除指定手机号", () => {
      const configWithWhitelist: PrivacyConfig = {
        ...config,
        whitelist: ["13812345678"],
      };
      const text = "我的电话是 13812345678";
      const results = detector.detect(text, configWithWhitelist);
      expect(results).toHaveLength(0);
    });
  });

  describe("配置开关", () => {
    it("detectPII=false时不检测", () => {
      const configDisabled: PrivacyConfig = {
        ...config,
        detectPII: false,
      };
      const text = "我的电话是 13812345678，邮箱 user@example.com";
      const results = detector.detect(text, configDisabled);
      expect(results).toHaveLength(0);
    });
  });

  describe("辅助方法", () => {
    it("hasSensitiveInfo 正确判断", () => {
      expect(detector.hasSensitiveInfo("我的电话是 13812345678", config)).toBe(true);
      expect(detector.hasSensitiveInfo("今天天气不错", config)).toBe(false);
    });

    it("getSensitiveTypes 返回类型列表", () => {
      const text = "联系方式：13812345678, user@example.com";
      const types = detector.getSensitiveTypes(text, config);
      expect(types).toContain("phone");
      expect(types).toContain("email");
      expect(types).toHaveLength(2);
    });
  });

  describe("综合场景", () => {
    it("检测混合敏感信息", () => {
      const text = `
        用户信息：
        姓名：张三
        手机：13912345678
        邮箱：zhangsan@example.com
        身份证：110101199001011234
        地址：北京市朝阳区某某街道123号
      `;
      const results = detector.detect(text, config);
      expect(results.length).toBeGreaterThan(2);
      
      const types = new Set(results.map((r) => r.type));
      expect(types.has("phone")).toBe(true);
      expect(types.has("email")).toBe(true);
      expect(types.has("id_card")).toBe(true);
    });

    it("位置信息正确", () => {
      const text = "电话 13812345678 和邮箱 user@example.com";
      const results = detector.detect(text, config);
      
      for (const result of results) {
        const extracted = text.substring(result.start, result.end);
        expect(extracted).toBe(result.value);
      }
    });
  });
});
