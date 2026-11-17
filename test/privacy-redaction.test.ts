/**
 * 敏感条目「脱敏后可召回」。
 * 旧行为：条目里只要有一处 PII 就在召回时整条删除。
 * 新行为：字段级掩码后保留，`privacy.recallPolicy = "filter"` 可切回旧行为。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SensitivityDetector } from "../src/privacy/detector";
import {
  applyRedactions,
  maskSensitiveValue,
  redactMemoryEntry,
  redactText,
  selectSpans,
} from "../src/privacy/redact";
import { DEFAULT_PRIVACY_CONFIG, type PrivacyConfig, type SensitiveInfo } from "../src/privacy/types";
import type { MemoryEntry } from "../src/core/types";
import { openService } from "../src/host/index";

const detector = new SensitivityDetector();
const cfg: PrivacyConfig = { ...DEFAULT_PRIVACY_CONFIG };

function info(type: SensitiveInfo["type"], value: string, text: string): SensitiveInfo {
  const start = text.indexOf(value);
  return { type, value, start, end: start + value.length, confidence: 1 };
}

function entry(partial: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: "m1",
    level: "fact",
    project: null,
    section: null,
    content: "默认内容",
    keywords: [],
    importance: 3,
    status: "active",
    semanticKey: null,
    confidence: null,
    validFrom: null,
    validTo: null,
    evidence: [],
    hash: null,
    source: "test",
    accessCount: 0,
    tier: "hot",
    createdAt: 1,
    updatedAt: 1,
    ...partial,
  };
}

describe("掩码规则", () => {
  it("每种 PII 都保留可读上下文、抹掉可识别部分", () => {
    expect(maskSensitiveValue("phone", "13800138000")).toBe("138****8000");
    expect(maskSensitiveValue("email", "alice@example.com")).toBe("a***@example.com");
    expect(maskSensitiveValue("id_card", "110101199001011234")).toBe("11**************34");
    expect(maskSensitiveValue("credit_card", "4111 1111 1111 1111")).toBe("**** **** **** 1111");
    expect(maskSensitiveValue("password", "token=abc123")).toBe("token=***");
    expect(maskSensitiveValue("ip_address", "8.8.8.8")).toBe("8.8.*.*");
    expect(maskSensitiveValue("address", "西湖区文三路 100 号")).toBe("[地址已脱敏]");
  });

  it("过短的凭据整体抹掉，不留尾部", () => {
    expect(maskSensitiveValue("credit_card", "12")).toBe("***");
    expect(maskSensitiveValue("email", "not-an-email")).toBe("***");
    expect(maskSensitiveValue("ip_address", "8.8")).toBe("***");
  });

  it("掩码是幂等的：对已掩码文本再执行一次不再变化", () => {
    const once = redactText("手机 13800138000，邮箱 alice@example.com", detector, cfg);
    const twice = redactText(once, detector, cfg);
    expect(twice).toBe(once);
  });
});

describe("区间选择", () => {
  it("身份证内的手机号片段不会把整条号切成两段", () => {
    const text = "证件号 110101199001011234";
    const idCard = info("id_card", "110101199001011234", text);
    // 10119900101 不匹配手机号；构造一个确实重叠的假命中来验证优先级
    const overlap: SensitiveInfo = { type: "phone", value: "11010119900", start: idCard.start, end: idCard.start + 11, confidence: 0.95 };
    const picked = selectSpans([overlap, idCard]);
    expect(picked).toEqual([idCard]);
    expect(applyRedactions(text, [overlap, idCard])).toBe("证件号 11**************34");
  });

  it("互不重叠时按位置全部替换", () => {
    const text = "a 13800138000 b a***@example.com";
    const phone = info("phone", "13800138000", text);
    const email = info("email", "a***@example.com", text);
    const out = applyRedactions(text, [email, phone]);
    expect(out).toBe("a 138****8000 b a***@example.com");
  });
});

describe("redactText", () => {
  it("关闭检测或没有检测器时原样返回", () => {
    const text = "手机 13800138000";
    expect(redactText(text, detector, { ...cfg, detectPII: false })).toBe(text);
    expect(redactText(text, detector, { ...cfg, enabled: false })).toBe(text);
    expect(redactText(text, null, cfg)).toBe(text);
    expect(redactText("", detector, cfg)).toBe("");
  });

  it("白名单里的值不脱敏", () => {
    const text = "客服电话 13800138000";
    expect(redactText(text, detector, { ...cfg, whitelist: ["13800138000"] })).toBe(text);
  });

  it("一句话里同时命中手机号与邮箱时都替换", () => {
    const text = "联系 13800138000 或 alice@example.com";
    expect(redactText(text, detector, cfg)).toBe("联系 138****8000 或 a***@example.com");
  });
});

describe("redactMemoryEntry", () => {
  it("内容、关键词、检索词、证据引用全部脱敏，原对象不被改动", () => {
    const original = entry({
      content: "手机 13800138000，邮箱 alice@example.com",
      keywords: ["13800138000", "正常词"],
      searchTerms: ["alice@example.com"],
      evidence: [{ sessionId: "s", seq: 1, quote: "我的手机是 13800138000" }],
    });
    const out = redactMemoryEntry(original, detector, cfg);

    expect(out).not.toBe(original);
    expect(out.content).toBe("手机 138****8000，邮箱 a***@example.com");
    expect(out.keywords).toEqual(["138****8000", "正常词"]);
    expect(out.searchTerms).toEqual(["a***@example.com"]);
    expect(out.evidence[0].quote).toBe("我的手机是 138****8000");

    // 原对象仍是原文，避免「注入时脱敏」变成「改掉库里的记忆」
    expect(original.content).toContain("13800138000");
    expect(original.keywords[0]).toBe("13800138000");
  });

  it("没有敏感值时返回原对象（调用方据此判断是否发生脱敏）", () => {
    const original = entry({ content: "今天天气不错", keywords: ["天气"] });
    expect(redactMemoryEntry(original, detector, cfg)).toBe(original);
  });
});

describe("服务层：召回与注入", () => {
  let dir: string;
  let rt: ReturnType<typeof openService>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "memweave-redact-"));
    rt = openService(dir, {
      // 关掉 治理层的 PII 规则，让 隐私层接管（与 m6.1 集成用例一致）
      governance: {
        autoAcceptLowRisk: true,
        undoWindowHours: 72,
        requireConfirmFor: [],
        disabledSensitive: ["phone", "id-card", "bank-card"],
      },
      privacy: { ...DEFAULT_PRIVACY_CONFIG, recallPolicy: "redact" },
    });
  });

  afterEach(() => {
    rt.env.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** 改隐私配置时补全必填字段（config.privacy 可能来自部分对象） */
  function setPolicy(patch: Partial<PrivacyConfig>): void {
    rt.service.config.privacy = { ...DEFAULT_PRIVACY_CONFIG, ...rt.service.config.privacy, ...patch };
  }

  it("敏感条目召回时保留，内容已脱敏，敏感标记仍在", async () => {
    const out = await rt.service.remember(
      {
        level: "fact",
        project: null,
        content: "我的手机是 13800138000，邮箱 alice@example.com",
        keywords: ["13800138000"],
      },
      "human",
      { sessionId: "s1", turn: 1 },
    );
    expect(out.ok).toBe(true);

    const hits = rt.service.recall("手机 邮箱", { limit: 10 });
    const hit = hits.find((h) => h.id === out.id);
    expect(hit).toBeTruthy();
    expect(hit!.entry.content).toContain("138****8000");
    expect(hit!.entry.content).toContain("a***@example.com");
    expect(hit!.entry.content).not.toContain("13800138000");
    expect(hit!.entry.content).not.toContain("alice@example.com");
    expect((hit!.entry as { is_sensitive?: number }).is_sensitive).toBe(1);
  });

  it("recallPolicy=filter 时回到「整条不可召回」", async () => {
    const out = await rt.service.remember(
      { level: "fact", project: null, content: "我的手机是 13800138000" },
      "human",
      { sessionId: "s1", turn: 1 },
    );
    setPolicy({ recallPolicy: "filter" });
    expect(rt.service.recall("手机", { limit: 10 }).map((h) => h.id)).not.toContain(out.id);
  });

  it("filterOnRecall=false 时原样返回（兼容旧配置）", async () => {
    const out = await rt.service.remember(
      { level: "fact", project: null, content: "我的手机是 13800138000" },
      "human",
      { sessionId: "s1", turn: 1 },
    );
    setPolicy({ filterOnRecall: false });
    const hit = rt.service.recall("手机", { limit: 10 }).find((h) => h.id === out.id);
    expect(hit?.entry.content).toContain("13800138000");
  });

  it("S2 首轮快照里的敏感条目也被脱敏", async () => {
    await rt.service.remember(
      { level: "user", project: null, content: "用户手机 13800138000" },
      "human",
      { sessionId: "s1", turn: 1 },
    );
    const turn = rt.service.renderTurn({ sessionId: "s-s2", first: true, baseline: new Map() });
    expect(turn.s2).toContain("138****8000");
    expect(turn.s2).not.toContain("13800138000");
  });

  it("S3 delta 里的敏感条目也被脱敏", async () => {
    await rt.service.remember(
      { level: "fact", project: null, content: "备用手机 13900139000" },
      "human",
      { sessionId: "s1", turn: 1 },
    );
    const turn = rt.service.renderTurn({ sessionId: "s-s3", first: false, baseline: new Map(), turn: 1 });
    expect(turn.s3).toContain("139****9000");
    expect(turn.s3).not.toContain("13900139000");
  });

  it("redactForInject 在 filter 策略下直接丢弃条目", () => {
    const e = { ...entry({ content: "手机 13800138000" }), is_sensitive: 1 } as MemoryEntry;
    expect(rt.service.redactForInject([e])).toHaveLength(1);
    setPolicy({ recallPolicy: "filter" });
    expect(rt.service.redactForInject([e])).toHaveLength(0);
  });

  it("redactInjectText 处理画像等非条目文本", () => {
    expect(rt.service.redactInjectText("用户邮箱 alice@example.com")).toBe("用户邮箱 a***@example.com");
  });
});
