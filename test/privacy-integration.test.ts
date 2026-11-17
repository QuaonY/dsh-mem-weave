/**
 * 隐私保护 - 集成测试
 * 测试敏感信息检测、标记和过滤的端到端流程
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openService } from "../src/host/index";
import { invokeRpc } from "../src/host/rpc";
import type { WeaveService } from "../src/host/service";
import type { WeaveEnv } from "../src/store/db";

describe("Privacy Integration", () => {
  let dir: string;
  let env: WeaveEnv;
  let service: WeaveService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "memweave-privacy-"));
    const rt = openService(dir, {
      // 禁用 治理层的 PII 规则，让 隐私检测接管
      governance: {
        autoAcceptLowRisk: true,
        undoWindowHours: 72,
        requireConfirmFor: [],
        disabledSensitive: ["phone", "id-card", "bank-card"],
      },
      privacy: {
        enabled: true,
        strictMode: false,
        detectPII: true,
        filterOnRecall: true,
        whitelist: [],
      },
    });
    env = rt.env;
    service = rt.service;
  });

  afterEach(() => {
    service.stopMirror(false);
    env.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe("Remember with Sensitivity Detection", () => {
    it("应该检测并标记包含手机号的记忆", async () => {
      const result = await service.remember(
        {
          content: "我的手机号是 13800138000",
          level: "fact",
        },
        "human",
      );

      expect(result.ok).toBe(true);
      expect(result.verdict).toBe("accepted");
      
      // 验证记忆被标记为敏感
      const memories = service.getSensitiveMemories("fact");
      expect(memories.length).toBeGreaterThan(0);
      expect(memories[0].content).toContain("13800138000");
    });

    it("应该检测并标记包含邮箱的记忆", async () => {
      const result = await service.remember(
        {
          content: "联系方式：test@example.com",
          level: "fact",
        },
        "human",
      );

      expect(result.ok).toBe(true);
      
      const memories = service.getSensitiveMemories("fact");
      expect(memories.some((m) => m.content.includes("test@example.com"))).toBe(true);
    });

    it("应该检测并标记包含多种敏感信息的记忆", async () => {
      const result = await service.remember(
        {
          content: "联系人张三，手机13900139000，邮箱zhang@test.com",
          level: "fact",
        },
        "human",
      );

      expect(result.ok).toBe(true);
      
      // 验证检测到多种敏感类型
      const types = service.getSensitiveTypes("联系人张三，手机13900139000，邮箱zhang@test.com");
      expect(types.length).toBeGreaterThanOrEqual(2);  // 至少检测到手机和邮箱
      expect(types).toContain("phone");
      expect(types).toContain("email");
    });

    it("不应该标记不包含敏感信息的记忆", async () => {
      const result = await service.remember(
        {
          content: "今天天气不错",
          level: "fact",
        },
        "human",
      );

      expect(result.ok).toBe(true);
      
      const memories = service.getSensitiveMemories("fact");
      expect(memories.every((m) => m.content !== "今天天气不错")).toBe(true);
    });
  });

  describe("Strict Mode", () => {
    beforeEach(() => {
      // 启用严格模式
      service.config.privacy = {
        ...service.config.privacy!,
        strictMode: true,
      };
    });

    it("应该拒绝包含敏感信息的写入", async () => {
      const result = await service.remember(
        {
          content: "我的手机号是 13800138000",
          level: "fact",
        },
        "human",
      );

      expect(result.ok).toBe(false);
      expect(result.code).toBe("E_SENSITIVE");
      expect(result.message).toContain("Sensitive information detected");
    });

    it("应该允许不含敏感信息的写入", async () => {
      const result = await service.remember(
        {
          content: "今天学习了新知识",
          level: "fact",
        },
        "human",
      );

      expect(result.ok).toBe(true);
      expect(result.verdict).toBe("accepted");
    });
  });

  describe("Recall Filtering", () => {
    it("敏感记忆脱敏后仍可召回（不再整条丢弃）", async () => {
      // 写入一条敏感记忆
      const sensitive = await service.remember(
        {
          content: "敏感信息：手机13800138000",
          level: "fact",
        },
        "human",
      );

      // 写入一条非敏感记忆
      await service.remember(
        {
          content: "普通信息：天气很好",
          level: "fact",
        },
        "human",
      );

      // 召回时保留条目，但把手机号替换成掩码
      const recalled = service.recall("信息", { limit: 10 });

      const hit = recalled.find((h) => h.id === sensitive.id);
      expect(hit).toBeTruthy();
      expect(hit!.entry.content).toContain("138****8000");
      expect(hit!.entry.content).not.toContain("13800138000");
      expect(recalled.some((h) => h.entry.content.includes("天气很好"))).toBe(true);
    });

    it("privacy.recallPolicy=filter 时保留旧的整条过滤行为", async () => {
      await service.remember(
        { content: "敏感信息：手机13800138000", level: "fact" },
        "human",
      );
      await service.remember(
        { content: "普通信息：天气很好", level: "fact" },
        "human",
      );
      service.config.privacy = {
        enabled: true,
        strictMode: false,
        detectPII: true,
        filterOnRecall: true,
        recallPolicy: "filter",
        whitelist: [],
      };
      const recalled = service.recall("信息", { limit: 10 });
      expect(recalled.some((h) => h.entry.content.includes("13800138000"))).toBe(false);
      expect(recalled.some((h) => h.entry.content.includes("天气很好"))).toBe(true);
    });
  });

  describe("RPC Endpoints", () => {
    it("privacy/detect 应该检测敏感信息", () => {
      const result = service.detectSensitiveInfo("我的手机号是 13800138000");
      
      expect(result.length).toBeGreaterThan(0);
      expect(result[0].type).toBe("phone");
      expect(result[0].value).toBe("13800138000");
    });

    it("privacy/detect 应该返回空数组对于非敏感文本", () => {
      const result = service.detectSensitiveInfo("今天天气不错");
      
      expect(result).toEqual([]);
    });

    it("privacy/getSensitiveMemories 应该返回所有敏感记忆", async () => {
      // 写入敏感记忆
      await service.remember(
        {
          content: "手机13800138000",
          level: "fact",
        },
        "human",
      );

      const memories = service.getSensitiveMemories();
      
      expect(memories.length).toBeGreaterThan(0);
      expect(memories.every((m) => (m as any).is_sensitive === 1)).toBe(true);
    });

    it("privacy/markSensitive 应该标记/取消标记记忆", async () => {
      // 写入普通记忆
      const result = await service.remember(
        {
          content: "普通内容",
          level: "fact",
        },
        "human",
      );

      const id = result.id!;

      // 标记为敏感
      expect(service.markMemoryAsSensitive(id, "fact", true).ok).toBe(true);
      let memories = service.getSensitiveMemories("fact");
      expect(memories.some((m) => m.id === id)).toBe(true);

      // 取消标记
      expect(service.markMemoryAsSensitive(id, "fact", false).ok).toBe(true);
      memories = service.getSensitiveMemories("fact");
      expect(memories.some((m) => m.id === id)).toBe(false);
    });

    it("markSensitive 拒绝非法层名、不存在的 id 与层不一致", async () => {
      const written = await service.remember({ content: "层校验用内容", level: "fact" }, "human");
      const id = written.id!;

      // 层名不是七层之一：过去会拼出 `UPDATE undefined ...`，报错含糊
      const rpcBadLevel = (await invokeRpc(
        service,
        "memweave.privacy/markSensitive",
        { id, level: "facts" },
        "human",
      )) as { ok: boolean; code?: string };
      expect(rpcBadLevel.ok).toBe(false);
      expect(rpcBadLevel.code).toBe("E_VALID");

      // 层名合法但条目在别的层：过去静默更新 0 行，界面却显示成功
      const rpcWrongLevel = (await invokeRpc(
        service,
        "memweave.privacy/markSensitive",
        { id, level: "user" },
        "human",
      )) as { ok: boolean; code?: string };
      expect(rpcWrongLevel.ok).toBe(false);
      expect(rpcWrongLevel.code).toBe("E_VALID");

      // 条目不存在
      const rpcMissing = (await invokeRpc(
        service,
        "memweave.privacy/markSensitive",
        { id: "no-such-memory", level: "fact" },
        "human",
      )) as { ok: boolean; code?: string };
      expect(rpcMissing.ok).toBe(false);
      expect(rpcMissing.code).toBe("E_VALID");

      // getSensitiveMemories 的 level 同样要校验
      const rpcListBad = (await invokeRpc(
        service,
        "memweave.privacy/getSensitiveMemories",
        { level: "facts" },
        "human",
      )) as { ok: boolean; code?: string };
      expect(rpcListBad.ok).toBe(false);
      expect(rpcListBad.code).toBe("E_VALID");

      // 正确层名照常工作
      const ok = (await invokeRpc(
        service,
        "memweave.privacy/markSensitive",
        { id, level: "fact", sensitive: true },
        "human",
      )) as { ok: boolean };
      expect(ok.ok).toBe(true);
      expect(service.getSensitiveMemories("fact").some((m) => m.id === id)).toBe(true);
    });
  });
});
