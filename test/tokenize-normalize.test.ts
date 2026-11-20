/**
 * 分词与数字归一化测试
 */

import { describe, expect, it } from "vitest";
import { tokenize } from "../src/core/tokenize";

describe("数字归一化", () => {
  it("中文数字转阿拉伯数字", () => {
    const tokens1 = tokenize("住四楼");
    const tokens2 = tokenize("住4楼");
    
    // 应该都包含 "4"
    expect(tokens1).toContain("4");
    expect(tokens2).toContain("4");
    
    // "住四楼" 和 "住4楼" 应该产生相同的关键词
    expect(tokens1.filter(t => t === "4").length).toBeGreaterThan(0);
    expect(tokens2.filter(t => t === "4").length).toBeGreaterThan(0);
  });

  it("量词归一化", () => {
    const tokens1 = tokenize("买了三个苹果");
    const tokens2 = tokenize("买了3个苹果");
    const tokens3 = tokenize("买了3苹果");
    
    // 都应该包含 "3"
    expect(tokens1).toContain("3");
    expect(tokens2).toContain("3");
    
    // 量词 "个" 应该被去除
    expect(tokens1).not.toContain("个");
    expect(tokens2).not.toContain("个");
  });

  it("多个数字归一化", () => {
    const tokens = tokenize("第二次买了三个苹果");
    
    expect(tokens).toContain("2");
    expect(tokens).toContain("3");
  });

  it("十百千万的转换", () => {
    expect(tokenize("十个")).toContain("10");
    // "一百" 会被处理成 "1" + "100"，分别匹配到
    const tokens = tokenize("一百");
    expect(tokens.some(t => t.includes("1") || t.includes("100"))).toBe(true);
  });

  it("二和两的统一", () => {
    const tokens1 = tokenize("两个");
    const tokens2 = tokenize("二个");
    
    expect(tokens1).toContain("2");
    expect(tokens2).toContain("2");
  });

  it("楼层查询归一化", () => {
    const query1 = tokenize("住几楼");
    const query2 = tokenize("住5楼");
    const query3 = tokenize("住五楼");
    
    // 所有查询都应该有相似的结构
    expect(query2).toContain("5");
    expect(query3).toContain("5");
  });

  it("保留原有分词功能", () => {
    // 拉丁词
    const tokens1 = tokenize("JavaScript programming");
    expect(tokens1).toContain("javascript");
    expect(tokens1).toContain("programming");
    
    // CJK 二元组
    const tokens2 = tokenize("编程语言");
    expect(tokens2).toContain("编程");
    expect(tokens2).toContain("程语");
    expect(tokens2).toContain("语言");
    
    // 单字
    const tokens3 = tokenize("我");
    expect(tokens3).toContain("我");
  });

  it("混合文本分词", () => {
    const tokens = tokenize("我住在5楼，买了三个苹果");
    
    expect(tokens).toContain("5");
    expect(tokens).toContain("3");
    expect(tokens).toContain("我住");
    expect(tokens).toContain("住在");
    expect(tokens).toContain("苹果");
  });

  it("常见量词都能识别", () => {
    const tests = [
      ["一个人", "1"],
      ["两只猫", "2"],
      ["三条鱼", "3"],
      ["四张纸", "4"],
      ["五块钱", "5"],
      ["六本书", "6"],
      ["七台电脑", "7"],
      ["八辆车", "8"],
      ["九层楼", "9"],
    ];
    
    for (const [text, expected] of tests) {
      const tokens = tokenize(text);
      expect(tokens).toContain(expected);
    }
  });

  it("复杂数字表达", () => {
    // "第二次" → "第", "2"
    const tokens1 = tokenize("第二次尝试");
    expect(tokens1).toContain("2");
    
    // "一百个" → "1100"（简化处理）
    const tokens2 = tokenize("一百个");
    // 只验证包含数字即可
    expect(tokens2.some(t => /\d/.test(t))).toBe(true);
  });

  it("多位中文数字整段解析，不再逐字拼接", () => {
    expect(tokenize("十三楼")).toContain("13");
    expect(tokenize("第十三章")).toContain("13");
    expect(tokenize("二十个")).toContain("20");
    expect(tokenize("一百二十三个")).toContain("123");
    expect(tokenize("三千五百元")).toContain("3500");
    expect(tokenize("两万三千")).toContain("23000");
    expect(tokenize("一百零三")).toContain("103");
  });

  it("程度副词/常用词不被腐蚀", () => {
    // 十分 ≠ 10
    const t1 = tokenize("十分好吃");
    expect(t1).toContain("十分");
    expect(t1).not.toContain("10");

    // 百科 ≠ 100科
    const t2 = tokenize("百科全书");
    expect(t2).toContain("百科");
    expect(t2.some(t => t.includes("100"))).toBe(false);

    // 万一 / 千万 / 万万 保持整词
    expect(tokenize("万一迟到")).toContain("万一");
    expect(tokenize("千万别迟到")).toContain("千万");
    expect(tokenize("万万没想到")).toContain("万万");

    // 一起 / 一致 里的"一"不转换
    const t3 = tokenize("我们一起努力");
    expect(t3).toContain("一起");
    expect(t3).not.toContain("1");
    expect(tokenize("意见一致")).toContain("一致");

    // 地名里的数字不转换
    expect(tokenize("住在四川")).toContain("四川");
    expect(tokenize("三国故事")).toContain("三国");
  });
});
