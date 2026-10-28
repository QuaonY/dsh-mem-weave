/**
 * 渲染测试：S1 九块保序 / 空态零注入 / 预算截断尾标 / sanitizeData / hash 稳定
 */
import { describe, expect, it } from "vitest";

import {
  PERSONA_WARN_CHARS,
  renderAll,
  renderDeltaSection,
  renderRecallSection,
  renderS1,
  renderS2,
  renderS3,
  sanitizeData,
  type RenderInput,
} from "../src/core/render";
import { renderHash } from "../src/core/hash";
import { defaultPersona } from "../src/store/dao";
import { promptTemplates } from "../src/prompts";
import type { AppearanceCard, MemoryEntry, PersonaConfig } from "../src/core/types";
import type { RankedHit } from "../src/core/score";

const tpl = promptTemplates("zh");

function card(p: Partial<AppearanceCard> & { id: string; who: AppearanceCard["who"] }): AppearanceCard {
  return {
    id: p.id,
    who: p.who,
    title: p.title ?? "标题",
    brief: p.brief ?? "简介",
    detail: p.detail ?? "详情",
    media: p.media ?? [],
    auto: p.auto ?? false,
    expand: p.expand ?? "brief",
    on: p.on ?? true,
  };
}

function fullPersona(): PersonaConfig {
  return {
    ...defaultPersona(),
    selfNamePro: "小满",
    userName: "主人",
    stance: "立场块：先对齐目标再动手",
    character: "性格块：沉稳细腻",
    appearance: {
      enabled: true,
      text: "形象文本",
      byModel: {},
      cards: [
        card({ id: "a-self", who: "self", detail: "本体形象详情", expand: "brief" }),
        card({ id: "a-full", who: "other", detail: "全量卡详情", expand: "full" }),
        card({ id: "a-index", who: "user", brief: "目录卡简介", expand: "brief" }),
      ],
      index: true,
    },
    tone: { enabled: true, text: "温柔克制", byModel: {} },
    contracts: [{ id: "c1", text: "契约一：先给结论", on: true }],
    thinkingLanguage: "中文",
    meta: {
      relation: { stage: "熟识", trust: 3 },
      mood: { baseline: "平和", bias: "轻快" },
      taboos: ["不评判"],
      lexicon: {},
    },
  };
}

function entry(p: Partial<MemoryEntry> & { content: string }): MemoryEntry {
  const ts = 1700000000000;
  return {
    id: p.id ?? "id-" + p.content.slice(0, 4),
    level: p.level ?? "fact",
    project: p.project ?? null,
    section: null,
    content: p.content,
    keywords: p.keywords ?? [],
    importance: p.importance ?? 3,
    status: "active",
    semanticKey: null,
    confidence: null,
    validFrom: ts,
    validTo: null,
    evidence: [],
    hash: null,
    source: "test",
    accessCount: 0,
    tier: "hot",
    createdAt: ts,
    updatedAt: p.updatedAt ?? ts,
  };
}

function hit(e: MemoryEntry): RankedHit {
  return { id: e.id, score: 1, routes: ["keyword"], explain: "命中：测试", entry: e };
}

describe("S1 九块保序（§6.1）", () => {
  it("九块齐全时顺序固定，缺块不留空行", () => {
    const r = renderS1(fullPersona());
    expect(r.blocks).toHaveLength(9);
    const headers = [
      "立场块",
      "性格块",
      tpl.appearance,
      tpl.appearanceCards,
      tpl.appearanceIndex,
      tpl.tone,
      tpl.contracts,
      "【人格锚点】",
      tpl.guide,
    ];
    const idx = headers.map((h) => r.prefix.indexOf(h));
    for (const i of idx) expect(i).toBeGreaterThanOrEqual(0);
    for (let i = 1; i < idx.length; i += 1) expect(idx[i]).toBeGreaterThan(idx[i - 1]);
    expect(r.prefix).not.toContain("\n\n\n");
  });

  it("只有部分块时按序渲染且无空行", () => {
    const p = defaultPersona();
    p.stance = "只写立场";
    const r = renderS1(p);
    expect(r.prefix).toContain("只写立场");
    expect(r.prefix).toContain(tpl.guide);
    expect(r.prefix).not.toContain(tpl.tone);
    expect(r.prefix).not.toContain("\n\n\n");
  });

  it("self 卡取代 appearance.text；thinking / suffix 独立段", () => {
    const p = fullPersona();
    p.appearance.text = "被取代的文本";
    p.suffix = "尾段在 {{cwd}} 之后";
    const r = renderS1(p);
    expect(r.prefix).toContain("本体形象详情");
    expect(r.prefix).not.toContain("被取代的文本");
    expect(r.thinking).toContain("中文");
    expect(r.suffix).toContain("尾段在 ");
    expect(r.prefix).not.toContain("尾段在 ");
  });
});

describe("空态零行为改变（§6.5）", () => {
  it("出厂 persona 三段全空", () => {
    const r = renderS1(defaultPersona());
    expect(r.prefix).toBe("");
    expect(r.thinking).toBe("");
    expect(r.suffix).toBe("");
  });

  it("delta / recall / quote 全空 ⇒ S3 零注入", () => {
    expect(renderS3([], [], [])).toBe("");
    expect(renderS3([], [], undefined)).toBe("");
  });

  it("renderAll 空输入：s2/s3 空，hash 稳定", () => {
    const input: RenderInput = {
      persona: defaultPersona(),
      snapshotItems: [],
      delta: [],
      recallHits: [],
      quotes: [],
    };
    const a = renderAll(input);
    const b = renderAll(input);
    expect(a.s1.prefix).toBe("");
    expect(a.s2).toBe("");
    expect(a.s3).toBe("");
    expect(a.hash).toBe(b.hash);
    expect(a.hash).toBe(renderHash([a.s1.prefix, a.s1.thinking, a.s1.suffix, a.s2, a.s3]));
  });
});

describe("预算截断与尾标（§6.4）", () => {
  it("S2 超字符预算 → 截断 + 「已省略 N 条」", () => {
    const items = Array.from({ length: 8 }, (_, i) => entry({ id: "e" + i, content: "第" + i + "条记忆内容" }));
    const text = renderS2(items, {
      snapshotMaxChars: 120,
      deltaMaxChars: 1200,
      recallMaxChars: 900,
      recallMaxItems: 5,
      totalWarnChars: 6000,
      personaWarnOnly: true,
    });
    expect(text).toContain("已省略");
  });

  it("S2 每层 ≤200 条", () => {
    const items = Array.from({ length: 205 }, (_, i) =>
      entry({ id: "x" + String(i).padStart(3, "0"), content: "c" + i }),
    );
    const s2 = renderS2(items);
    const lines = s2.split("\n").filter((l) => l.startsWith("- "));
    expect(lines.length).toBeLessThanOrEqual(200);
    expect(s2).toContain("已省略");
  });

  it("S3 delta 只推 12 条，其余裁掉", () => {
    const delta = Array.from({ length: 15 }, (_, i) => ({
      kind: "added" as const,
      entry: entry({ id: "d" + i, content: "delta" + i }),
    }));
    const r = renderDeltaSection(delta);
    expect(r.items).toBe(12);
    expect(r.trimmed).toBe(3);
  });

  it("S3 召回单条 ≤300 字符 + id 尾标", () => {
    const e = entry({ id: "long1", content: "长".repeat(400) });
    const r = renderRecallSection([hit(e)]);
    expect(r.text).toContain("…");
    expect(r.text).toContain("[fact:long1]");
    const body = r.text.split("\n")[2];
    expect(body.length).toBeLessThan(400);
  });

  it("人格段超预算只提醒不裁剪（I2）", () => {
    const p = defaultPersona();
    p.stance = "长".repeat(PERSONA_WARN_CHARS + 500);
    const r = renderS1(p);
    expect(r.warn.length).toBe(1);
    expect(r.warn[0]).toContain("人格段已超预算");
    expect(r.prefix).toContain("长".repeat(300)); // 全文保留
  });
});

describe("sanitizeData 与 hash", () => {
  it("剥离「」『』防提前闭合（I7）", () => {
    expect(sanitizeData("「危险」『闭合』文本")).toBe("危险闭合文本");
  });

  it("数据行内容经 sanitizeData 包裹", () => {
    const e = entry({ id: "s1", content: "带「引号」的内容" });
    const text = renderS2([e]);
    expect(text).toContain("带引号的内容");
    expect(text).not.toContain("「引号」");
  });

  it("同输入 hash 一致、异输入 hash 变", () => {
    const base: RenderInput = {
      persona: defaultPersona(),
      snapshotItems: [entry({ id: "h1", content: "内容A" })],
      delta: [],
      recallHits: [],
    };
    const h1 = renderAll(base).hash;
    const h2 = renderAll(base).hash;
    const h3 = renderAll({ ...base, snapshotItems: [entry({ id: "h1", content: "内容B" })] }).hash;
    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);
  });
});
