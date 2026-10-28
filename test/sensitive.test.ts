/** 敏感内容规则：内置开关 / 锁定 / 自定义正则 / 设置清洗 / 写入链路 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkCustomPattern,
  matchSensitive,
  sanitizeCustomPatterns,
  sanitizeDisabledBuiltins,
} from "../src/core/sensitive";
import { openWeaveDb, type WeaveEnv } from "../src/store/db";
import { ensureSchema } from "../src/store/migrate";
import { WeaveService, defaultConfig } from "../src/host/service";
import { invokeRpc } from "../src/host/rpc";

describe("matchSensitive", () => {
  it("常见密钥格式按凭据拦截", () => {
    expect(matchSensitive("key：sk-0000test0000fake0000test0000fake")).toBe("api-key");
    expect(matchSensitive("用这个 sk-proj-abcdefghijklmnop1234")).toBe("api-key");
    expect(matchSensitive("ghp_abcdefghijklmnopqrstuvwxyz0123")).toBe("api-key");
    expect(matchSensitive("AKIAIOSFODNN7EXAMPLE")).toBe("api-key");
    expect(matchSensitive("secret = 'abcdef0123456789abcd'")).toBe("api-key");
    expect(matchSensitive("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N")).toBe("api-key");
    // 不误伤：普通提交号、键值里的普通文字
    expect(matchSensitive("dsh-femwa 提交 901daa4，13 文件")).toBeNull();
    expect(matchSensitive("key: 重点是先确认方案")).toBeNull();
    expect(matchSensitive("任务分配 task-assignee 已完成")).toBeNull();
  });

  it("内置规则默认全开", () => {
    expect(matchSensitive("手机号 13800138000")).toBe("phone");
    expect(matchSensitive("电话是 12345978910")).toBeNull(); // 12 开头不是手机号段
    expect(matchSensitive("主人偏好像素风")).toBeNull();
  });

  it("可关闭非锁定规则，锁定的凭据规则关不掉", () => {
    expect(matchSensitive("手机号 13800138000", [], ["phone"])).toBeNull();
    expect(matchSensitive("我的密码是 abc", [], ["password"])).toBe("password");
  });

  it("自定义规则不区分大小写，返回命中的规则", () => {
    expect(matchSensitive("我家住址在幸福路", ["住址"])).toBe("custom:住址");
    expect(matchSensitive("My SECRET plan", ["secret"])).toBe("custom:secret");
    expect(matchSensitive("普通内容", ["住址"])).toBeNull();
  });
});

describe("规则清洗", () => {
  it("checkCustomPattern 区分空/过长/坏正则", () => {
    expect(checkCustomPattern("  ")).toEqual({ ok: false, reason: "empty" });
    expect(checkCustomPattern("a".repeat(201))).toEqual({ ok: false, reason: "too-long" });
    expect(checkCustomPattern("(abc")).toEqual({ ok: false, reason: "invalid" });
    expect(checkCustomPattern("住址|门牌")).toEqual({ ok: true });
  });

  it("sanitize 去空、去重、去坏正则、只留可关闭的内置 id", () => {
    expect(sanitizeCustomPatterns([" 住址 ", "住址", "(bad", "", 3, "default"])).toEqual(["住址"]);
    expect(sanitizeDisabledBuiltins(["phone", "password", "nope", "phone"])).toEqual(["phone"]);
  });
});

describe("设置保存 → 写入生效", () => {
  let dir = "";
  let env: WeaveEnv;
  let service: WeaveService;
  afterEach(() => {
    service?.stopMirror(true);
    env?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("settings/update 清洗规则，之后的写入按新规则拦截", async () => {
    dir = mkdtempSync(join(tmpdir(), "mw-sens-"));
    env = openWeaveDb(join(dir, "memweave"));
    ensureSchema(env);
    service = new WeaveService(env, defaultConfig(dir));

    const out = (await invokeRpc(
      service,
      "memweave.settings/update",
      { patch: { governance: { sensitivePatterns: ["住址", "(bad"], disabledSensitive: ["phone", "password"] } } },
      "human",
    )) as { ok: boolean };
    expect(out.ok).toBe(true);
    expect(service.config.governance.sensitivePatterns).toEqual(["住址"]);
    expect(service.config.governance.disabledSensitive).toEqual(["phone"]);

    const blocked = await service.remember({ level: "user", content: "用户的住址是幸福路 1 号" }, "agent");
    expect(blocked.ok).toBe(false);
    expect(blocked.code).toBe("E_SENSITIVE");

    // 手机号规则已关闭：可以写入
    const phone = await service.remember({ level: "user", content: "用户手机号 13800138000" }, "agent");
    expect(phone.ok).toBe(true);

    // 密码规则锁定：仍然拦截
    const pw = await service.remember({ level: "user", content: "用户的密码是 hunter2" }, "agent");
    expect(pw.code).toBe("E_SENSITIVE");
  });
});
