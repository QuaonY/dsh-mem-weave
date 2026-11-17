/**
 * 设置页新交互的纯逻辑：小时格子 ↔ peakHours 区间、Markdown 预设卡解析。
 */
import { describe, expect, it } from "vitest";
import { peakHoursToSet, setToPeakHours } from "../src/client/misc";
import { looksLikeMarkdown, parseMarkdownPreset } from "../src/client/preset-md";
import { splitNameList } from "../src/client/persona";
import { renderS1, splitNames } from "../src/core/render";
import { identityAliasGroups } from "../src/core/tokenize";
import { defaultPersona } from "../src/store/dao";

describe("多个称呼", () => {
  it("顿号 / 逗号 / 斜杠 / 换行都能分开，去重去空；前后端口径一致", () => {
    const raw = "老大、Boss, 老大 /  头儿\n\n";
    expect(splitNames(raw)).toEqual(["老大", "Boss", "头儿"]);
    expect(splitNameList(raw)).toEqual(splitNames(raw));
    expect(splitNames("")).toEqual([]);
    expect(splitNames(undefined)).toEqual([]);
  });

  it("多个称呼全部写进人格锚点，并提示轮换；只有一个时不加提示", () => {
    const multi = renderS1({ ...defaultPersona(), selfNamePro: "小满、满满", userName: "老大、Boss" }).prefix;
    expect(multi).toContain("自称：小满、满满");
    expect(multi).toContain("对用户的称呼：老大、Boss（有多个时随语境自然轮换使用");
    const single = renderS1({ ...defaultPersona(), selfNamePro: "小满", userName: "老大" }).prefix;
    expect(single).toContain("自称：小满；对用户的称呼：老大\n");
    expect(single).not.toContain("轮换");
  });

  it("同一份人格渲染结果稳定（不随机），提示词缓存不失效", () => {
    const p = { ...defaultPersona(), userName: "老大、Boss、头儿" };
    expect(renderS1(p).prefix).toBe(renderS1(p).prefix);
  });

  it("每个称呼都进身份同义组，检索“Boss”也能命中“老大”", () => {
    const groups = identityAliasGroups({ userName: "老大、Boss", selfNamePro: "小满、满满" });
    expect(groups[0]).toEqual(expect.arrayContaining(["老大", "Boss", "主人"]));
    expect(groups[1]).toEqual(expect.arrayContaining(["小满", "满满"]));
  });
});

const hours = (list: number[]): boolean[] => Array.from({ length: 24 }, (_, h) => list.includes(h));

describe("不整理时段：小时格子 ↔ 区间", () => {
  it("默认 [[9,12],[14,18]] 往返不变", () => {
    const on = peakHoursToSet([[9, 12], [14, 18]]);
    expect(on.filter(Boolean).length).toBe(7);
    expect(on[9] && on[11] && !on[12] && on[14] && on[17] && !on[18]).toBe(true);
    expect(setToPeakHours(on)).toEqual([[9, 12], [14, 18]]);
  });

  it("跨午夜：22–2 点合并成一段 [22,2]", () => {
    expect(setToPeakHours(hours([22, 23, 0, 1]))).toEqual([[22, 2]]);
    expect(peakHoursToSet([[22, 2]])).toEqual(hours([22, 23, 0, 1]));
  });

  it("全空 / 全选 / 脏数据", () => {
    expect(setToPeakHours(hours([]))).toEqual([]);
    expect(setToPeakHours(new Array(24).fill(true))).toEqual([[0, 24]]);
    expect(peakHoursToSet("x")).toEqual(hours([]));
    expect(peakHoursToSet([[5], ["a", 3], [30, 40]])).toEqual(hours([0, 1, 2]));
  });
});

describe("Markdown 预设卡", () => {
  it("front matter + 分节 + 契约列表", () => {
    const md = [
      "---",
      "id: night-owl",
      "name: 夜猫子",
      "---",
      "## 用户称呼",
      "老大",
      "## 人格描述",
      "安静、靠谱。",
      "",
      "晚上话多一点。",
      "## 契约",
      "- 不编造事实",
      "* 改代码前先读代码",
      "1. 回复用中文",
      "## 附加提示词",
      "保持简洁",
    ].join("\n");
    const out = parseMarkdownPreset(md);
    expect("error" in out).toBe(false);
    if ("error" in out) return;
    expect(out.id).toBe("night-owl");
    expect(out.label).toBe("夜猫子");
    expect(out.payload.userName).toBe("老大");
    expect(out.payload.selfNamePro).toBe("夜猫子");
    expect(out.payload.character).toBe("安静、靠谱。\n\n晚上话多一点。");
    expect(out.payload.suffix).toBe("保持简洁");
    expect((out.payload.contracts as Array<{ text: string }>).map((c) => c.text)).toEqual(["不编造事实", "改代码前先读代码", "回复用中文"]);
  });

  it("一级标题当名称；认不出的分节并入人格描述；Windows 换行", () => {
    const out = parseMarkdownPreset("# 小满\r\n\r\n## 自称\r\n小满\r\n## 爱好\r\n看海\r\n");
    if ("error" in out) throw new Error(out.error);
    expect(out.label).toBe("小满");
    expect(out.payload.selfNameFlash).toBe("小满");
    expect(out.payload.character).toBe("## 爱好\n看海");
  });

  it("没有标题的纯文本整篇作为人格描述；空内容报错", () => {
    const out = parseMarkdownPreset("一个温和的助手。");
    if ("error" in out) throw new Error(out.error);
    expect(out.payload.character).toBe("一个温和的助手。");
    expect("error" in parseMarkdownPreset("   \n\n")).toBe(true);
  });

  it("JSON 不会被当成 Markdown", () => {
    expect(looksLikeMarkdown('  {"spec":"memweave-preset/1"}')).toBe(false);
    expect(looksLikeMarkdown("# 名字")).toBe(true);
  });
});
