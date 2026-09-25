/**
 * 4.60 I2-c 标准规范引用残缺链尾收口回归。
 *
 * ## 缺陷（263 份归档语料实测 13 份命中）
 *
 * ```
 * 《建筑给水排水及采暖工程施工质量验收规范》（GB 50242-2002）
 *   → 《建筑给水排水及采暖50242-2002）       ← 中间段被"自吞噬"
 * ```
 * 被吞掉的恒为「标题余部 + 》（GB 」——书名号未闭合、括号未开启，命中终检
 * `punctuationArtifactIssues` / `scanPunctuationBalance` 的「全角括号/书名号不闭合」blocker
 *（成对性破坏 = 内容丢失信号）。
 *
 * 成因是**长同形列举的生成退化**：编制依据段一次列 20+ 条高度同形的
 * 「《X工程施工质量验收规范》（GB NNNNN-YYYY）」，模型在该形态上跳字，跳的正好是每条都相同的中段。
 * 故语料里命中的标准集中在同一批国标（50242 / 50303 / 50203 / 50202）。
 *
 * ## 为什么必须确定性修
 *
 * 链尾 `stageQuotationBalanceRepair` 的 LLM 轮**修不动**它：上一版巢湖实机两轮均报
 * 「模型未产生有效修改；残留 2 对不配对」——要求 LLM 重写一整条 20 引用的长句，它只会把同形残缺
 * 再产一遍。残缺形态是确定性的，确定性修复可靠且零漂移（只插字符、不改字符）。
 */
import { describe, expect, it } from 'vitest';
import { fixTruncatedStandardCitations } from '@/services/document-workflow/documentIntegrityChecks';

describe('fixTruncatedStandardCitations 形态矩阵', () => {
  it('实机原文同形态：书名号未闭合 + 编号后直接右括号 → 补「》（」（只插字符）', () => {
    const input = '标准规范类：《建筑工程施工质量验收统一标准》（GB 50300-2013）、《建筑给水排水及采暖50242-2002）、《建筑桩基技术规范》（JGJ 94-2008）。';
    const result = fixTruncatedStandardCitations(input);
    expect(result.markdown).toBe('标准规范类：《建筑工程施工质量验收统一标准》（GB 50300-2013）、《建筑给水排水及采暖》（50242-2002）、《建筑桩基技术规范》（JGJ 94-2008）。');
    expect(result.fixedCount).toBe(1);
    expect(result.details[0]).toContain('建筑给水排水及采暖50242-2002）');
  });

  it('不构造看似正确的错误引用：不补标准名、不加「GB」前缀（无凭据即不猜）', () => {
    const result = fixTruncatedStandardCitations('《建筑地基基础50202-2018）');
    expect(result.markdown).toBe('《建筑地基基础》（50202-2018）');
    expect(result.markdown, '不得凭空补出「工程施工质量验收标准」').not.toContain('工程施工质量验收');
    expect(result.markdown, '不得凭空加 GB 前缀').not.toContain('GB 50202');
  });

  it('编号形态覆盖：带 /T 的行业标准、半角空格、多位数年份', () => {
    const input = '《某某地方标准DB34/T 4289-2022）、《另一标准50242 - 2002）';
    const result = fixTruncatedStandardCitations(input);
    expect(result.fixedCount).toBe(2);
    expect(result.markdown).toBe('《某某地方标准》（DB34/T 4289-2022）、《另一标准》（50242 - 2002）');
  });

  it('不误伤：形态完好的引用、正文普通括号、纯编号括注一律不动', () => {
    for (const innocent of [
      '《混凝土结构工程施工质量验收规范》（GB 50204-2015）。',
      '钢筋保护层厚度按（GB 50204-2015）执行。',
      '本项目建筑面积 28570.36㎡（其中地上 24000㎡）。',
      '工期要求：（2026-2027）两个年度分期实施。',
    ]) {
      expect(fixTruncatedStandardCitations(innocent), innocent).toEqual({ markdown: innocent, fixedCount: 0, details: [] });
    }
  });

  it('幂等：修复后的文本再跑一遍零命中（链尾重放安全）', () => {
    const once = fixTruncatedStandardCitations('《砌体50203-2011）、《建筑电气50303-2015）').markdown;
    expect(fixTruncatedStandardCitations(once)).toEqual({ markdown: once, fixedCount: 0, details: [] });
  });

  it('成对性验证：修复后全文括号与书名号开闭数相等（终检同口径）', () => {
    const input = '标准规范类：《建筑给水排水及采暖50242-2002）、《砌体50203-2011）、《建筑电气50303-2015）。';
    const fixed = fixTruncatedStandardCitations(input).markdown;
    for (const [open, close] of [['（', '）'], ['《', '》']]) {
      expect(fixed.split(open).length - fixed.split(close).length, `${open}${close} 未成对`).toBe(0);
    }
  });
});
