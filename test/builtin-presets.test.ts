/**
 * 内置人格预设：启动写入、不改当前人格、渲染不超预算、用户导入不能占用 builtin- 前缀、导出不带内置卡。
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openService } from "../src/host/index";
import { renderS1, PERSONA_WARN_CHARS } from "../src/core/render";
import { defaultPersona } from "../src/store/dao";
import { BUILTIN_PRESETS } from "../src/presets";
import { invokeRpc as callRpc } from "../src/host/rpc";
import { buildTools } from "../src/host/tools";

async function fresh() {
  const dir = await mkdtemp(join(tmpdir(), "memweave-builtin-"));
  return openService(dir);
}

describe("内置人格预设", () => {
  it("启动后出现在预设列表，排在最前，当前人格仍是出厂零注入", async () => {
    const { env, service } = await fresh();
    try {
      const list = service.listPresets();
      expect(list.map((p) => p.id).sort()).toEqual(["builtin-dafeiyu", "builtin-linhe"]);
      expect(list.find((p) => p.id === "builtin-dafeiyu")?.label).toBe("大肥鱼（鲸鱼娘）·小满");
      expect(list.find((p) => p.id === "builtin-linhe")?.label).toBe("林禾·夜班修理铺");
      expect(list.every((p) => p.builtin)).toBe(true);
      expect(service.persona().version).toBe(0);
      expect(service.renderPersona().prefix).toBe("");
    } finally {
      env.close();
    }
  });

  for (const p of BUILTIN_PRESETS) {
    it(p.id + "：应用后九块齐全，人格段不超预算、无告警", async () => {
      const { env, service } = await fresh();
      try {
        expect(service.applyPreset(p.id).ok).toBe(true);
        const s1 = service.renderPersona("deepseek-v4-pro");
        expect(s1.warn).toEqual([]);
        expect(s1.prefix.length + s1.thinking.length + s1.suffix.length).toBeLessThanOrEqual(PERSONA_WARN_CHARS);
        expect(s1.blocks.length).toBe(8); // 立场、性格、形象、形象目录、语气、契约、锚点、记忆导引
        expect(s1.prefix).toContain(p.payload.selfNamePro.split("、")[0]);
        // 锚点标题不带具体角色
        expect(s1.prefix).toContain("【人格锚点】");
        // 应用前自动存了一份 autosave，可以退回
        expect(service.getPreset("autosave")).not.toBeNull();
      } finally {
        env.close();
      }
    });

    it(p.id + "：契约每条 ≤300 字，卡片 id 唯一，不含会被剥掉的「」『』", () => {
      for (const c of p.payload.contracts) expect(c.text.length).toBeLessThanOrEqual(300);
      const ids = p.payload.appearance.cards.map((c) => c.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(JSON.stringify(p.payload)).not.toMatch(/[「」『』]/);
      // 只给白名单键，不碰用户的思考语言和关系 / 情绪元数据
      expect(Object.keys(p.payload)).not.toContain("thinkingLanguage");
      expect(Object.keys(p.payload)).not.toContain("meta");
    });

    it(p.id + "：只放原创内容，不带第三方角色、作者、品牌口号或许可证引用", () => {
      const all = JSON.stringify(p);
      for (const w of ["初音", "Miku", "Crypton", "Piapro", "溟月", "上善无形", "ZipZipPipe", "CC BY", "DeepSeek", "探索未至之境", "便宜货", "鱼片", "女仆", "hersona"]) {
        expect(all, w).not.toContain(w);
      }
    });

    it(p.id + "：活人感写法——口癖看场合、不复述问题、不套固定结尾、不靠编造经历", () => {
      const tone = p.payload.tone.text;
      expect(tone).toContain("不复述用户的问题");
      expect(tone).toContain("希望对你有帮助");
      expect(tone).toMatch(/长短不一/);
      expect(p.payload.contracts.some((c) => c.text.includes("不虚构自己的亲身经历"))).toBe(true);
      expect(p.payload.contracts.some((c) => c.text.includes("如实说明自己是 AI"))).toBe(true);
    });
  }

  it("用户自己的卡和 autosave 可以删；内置卡不能删；AI 没有删除入口", async () => {
    const { env, service } = await fresh();
    try {
      await callRpc(service, "preset/import", { id: "mine", label: "我的卡", payload: { stance: "我的" } }, "human");
      expect(service.applyPreset("builtin-dafeiyu").ok).toBe(true); // 生成 autosave
      expect(service.getPreset("autosave")).not.toBeNull();

      // AI 身份调 RPC 被拒；AI 工具 weave_preset 传 delete 也被拒
      expect(((await callRpc(service, "preset/delete", { id: "mine" }, "agent")) as { ok: boolean }).ok).toBe(false);
      const tool = buildTools(service).find((x) => x.descriptor.name === "weave_preset")!;
      const viaTool = (await tool.handler({ action: "delete", id: "mine" })) as { ok: boolean; code?: string };
      expect(viaTool.ok).toBe(false);
      expect(viaTool.code).toBe("E_PERM");
      expect(service.getPreset("mine")).not.toBeNull();

      expect(((await callRpc(service, "preset/delete", { id: "mine" }, "human")) as { ok: boolean }).ok).toBe(true);
      expect(((await callRpc(service, "preset/delete", { id: "autosave" }, "human")) as { ok: boolean }).ok).toBe(true);
      expect(service.listPresets().map((p) => p.id).sort()).toEqual(["builtin-dafeiyu", "builtin-linhe"]);
      // 删掉的内容不留在撤销台账里，审计只记 id 和标题
      const undo = env.db.prepare("SELECT COUNT(*) AS n FROM undo_log WHERE action LIKE 'preset.%'").get() as { n: number };
      expect(Number(undo.n)).toBe(0);
      const audit = env.db.prepare("SELECT target, before, after FROM audit_log WHERE action = 'preset.delete' ORDER BY id").all() as Array<Record<string, unknown>>;
      expect(audit.map((a) => a.target)).toEqual(["mine", "autosave"]);
      expect(audit.every((a) => a.after == null)).toBe(true);

      const builtin = (await callRpc(service, "preset/delete", { id: "builtin-dafeiyu" }, "human")) as { ok: boolean };
      expect(builtin.ok).toBe(false);
      expect(service.getPreset("builtin-dafeiyu")).not.toBeNull();
      expect(((await callRpc(service, "preset/delete", { id: "nope" }, "human")) as { ok: boolean }).ok).toBe(false);

      // 当前人格不受影响；删除后同名可以重新导入
      expect(service.persona().config.stance).toBe(BUILTIN_PRESETS[0].payload.stance);
      expect(((await callRpc(service, "preset/import", { id: "mine", payload: { stance: "又导入一次" } }, "human")) as { ok: boolean }).ok).toBe(true);
    } finally {
      env.close();
    }
  });

  it("插件下架的旧内置卡启动时清掉；用户自己的卡和当前人格不动", async () => {
    const dir = await mkdtemp(join(tmpdir(), "memweave-builtin-"));
    let opened = openService(dir);
    try {
      // 模拟旧版本写进库、新版本已不再提供的内置卡，以及用户已应用过它
      opened.env.db
        .prepare("INSERT INTO persona_presets (id, spec, label, payload, source, imported_at) VALUES ('builtin-retired', 'memweave-preset/1', '旧卡', ?, 'builtin', 0)")
        .run(JSON.stringify({ stance: "旧内置卡的人格" }));
      opened.service.savePreset("mine", { ...defaultPersona(), stance: "我的" }, "我的卡");
      expect(opened.service.applyPreset("builtin-retired").ok).toBe(true);
    } finally {
      opened.env.close();
    }
    opened = openService(dir);
    try {
      const ids = opened.service.listPresets().map((p) => p.id);
      expect(ids).not.toContain("builtin-retired");
      expect(ids).toContain("mine");
      expect(ids).toContain("builtin-dafeiyu");
      expect(opened.service.persona().config.stance).toBe("旧内置卡的人格");
    } finally {
      opened.env.close();
    }
  });

  it("预算按完整默认人格叠加后计算（没有遗漏字段导致渲染异常）", () => {
    for (const p of BUILTIN_PRESETS) {
      const s1 = renderS1({ ...defaultPersona(), ...p.payload });
      expect(s1.warn).toEqual([]);
    }
  });

  it("用户导入不能占用 builtin- 前缀；改过的内置卡重启后恢复", async () => {
    const dir = await mkdtemp(join(tmpdir(), "memweave-builtin-"));
    let opened = openService(dir);
    try {
      const out = (await callRpc(opened.service, "preset/import", { id: "builtin-dafeiyu", payload: { stance: "x" } }, "human")) as { ok: boolean };
      expect(out.ok).toBe(false);
      // 直接改库模拟旧版本内容，重启后应回到当前内置内容
      opened.env.db.prepare("UPDATE persona_presets SET payload = '{}' WHERE id = 'builtin-dafeiyu'").run();
    } finally {
      opened.env.close();
    }
    opened = openService(dir);
    try {
      expect(opened.service.getPreset("builtin-dafeiyu")?.payload.stance).toBe(BUILTIN_PRESETS[0].payload.stance);
    } finally {
      opened.env.close();
    }
  });

  it("全库导出不带内置预设，自己导入的照常带", async () => {
    const { env, service } = await fresh();
    try {
      service.savePreset("mine", { ...defaultPersona(), stance: "我的" }, "我的卡");
      const ids = (service.exportAll().presets as Array<{ id: string }>).map((p) => p.id);
      expect(ids).toEqual(["mine"]);
    } finally {
      env.close();
    }
  });
});
