/**
 * 发布前一致性判据（与 scripts/conformance.mjs 同一套断言，但直接跑 src）：
 * scripts/conformance.mjs 加载打包后的 lib，lib 依赖宿主提供的 cordis，脱离 DSH 跑不起来；
 * 这里在测试里跑同样的判据，保证每次全量测试都覆盖。
 * ① 出厂态 S1/S2/S3 全空、注入消息数 0、七层条目数 0；
 * ② S1 九块保序，缺块不留空行。
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openService } from "../src/host/index";
import type { PersonaConfig } from "../src/core/types";

describe("conformance/empty + persona-order", () => {
  it("出厂态三段全空，注入消息数 0；九块保序、缺块不留空行", async () => {
    const { env, service } = openService(await mkdtemp(join(tmpdir(), "memweave-conformance-")));
    try {
      const r = service.preview();
      for (const text of [r.s1.prefix, r.s1.thinking, r.s1.suffix, r.s2, r.s3]) expect(text).toBe("");
      expect(r.segments.filter((s) => s.text.length > 0)).toHaveLength(0);
      expect(service.status().total).toBe(0);

      const full = {
        stance: "立场块文本",
        character: "性格块文本",
        appearance: {
          enabled: true,
          text: "形象文本",
          byModel: {},
          cards: [
            { id: "self-1", who: "self", title: "本体", brief: "本体简介", detail: "本体详情", media: [], auto: false, expand: "brief", on: true },
            { id: "full-1", who: "other", title: "全量卡", brief: "全量简介", detail: "全量详情", media: [], auto: false, expand: "full", on: true },
            { id: "idx-1", who: "user", title: "目录卡", brief: "目录简介", detail: "目录详情", media: [], auto: false, expand: "brief", on: true },
          ],
          index: true,
        },
        tone: { enabled: true, text: "语气文本", byModel: {} },
        contracts: [{ id: "c1", text: "契约文本", on: true }],
        thinkingLanguage: "中文",
        meta: { relation: { stage: "熟识", trust: 0 }, mood: { baseline: "", bias: "" }, taboos: [], lexicon: {} },
      } as unknown as Partial<PersonaConfig>;
      service.updatePersona(full, "human");
      const s1 = service.renderPersona();
      expect(s1.blocks).toHaveLength(9);
      let pos = -1;
      for (const b of s1.blocks) {
        const i = s1.prefix.indexOf(b);
        expect(i).toBeGreaterThan(pos);
        pos = i;
      }
      expect(s1.prefix).toBe(s1.blocks.join("\n\n"));
      expect(s1.prefix).not.toContain("\n\n\n");

      service.updatePersona(
        {
          ...full,
          character: "",
          appearance: { enabled: false, text: "", byModel: {}, cards: [], index: true },
          tone: { enabled: false, text: "", byModel: {} },
          contracts: [],
          thinkingLanguage: "off",
        } as unknown as Partial<PersonaConfig>,
        "human",
      );
      const s1b = service.renderPersona();
      expect(s1b.blocks).toHaveLength(3);
      expect(s1b.prefix).toBe(s1b.blocks.join("\n\n"));
      expect(s1b.prefix).not.toContain("\n\n\n");
    } finally {
      env.close();
    }
  });
});
