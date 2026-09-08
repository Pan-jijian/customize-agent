/**
 * dicAmbiguousSupportBoundary：两可表述检测（ambiguousEitherOrIssues）+ 支护形式事实一致性
 * （supportFormFactConsistencyIssues）增量深挖（S 组）。
 * 覆盖增量维度（与 dicFactsBoundary I1-I3 / F1-F4 基线互补，不重复）：
 *  - S1 两可表述：决策词窗口 12/20 字符精确边界、词族谱系逐词单侧命中、1 字豁免、
 *    括号悬置 48 字符上限、管线豁免词谱系、归一化去空白、多命中聚合去重；
 *  - S2 支护形式：资料形式词 10 词谱系、编造体系词 8 词谱系、否定词 13 词谱系、
 *    否定 12 字符前窗精确边界、资料源四谱系、formTexts 过滤、部分落地豁免、表格行形态。
 * 全部为确定性正则提取与词面判定，无语义依赖。
 */
import { describe, expect, it } from 'vitest';
import {
  ambiguousEitherOrIssues, supportFormFactConsistencyIssues,
} from '@/services/document-workflow/documentIntegrityChecks';
import { factOf, factsOf } from './boundaryKit';

// ── S1. ambiguousEitherOrIssues：窗口边界与词族谱系 ──

describe('S1 ambiguousEitherOr 形态A 决策词窗口边界', () => {
  it('S1-1 决策词前 10 字符（末字恰入窗口左界）→ 报', () => {
    expect(ambiguousEitherOrIssues(`采用${'、'.repeat(10)}支护桩/放坡。`).length).toBe(1);
  });
  it('S1-2 决策词前 11 字符（完整词出窗口）→ 不报', () => {
    expect(ambiguousEitherOrIssues(`采用${'、'.repeat(11)}支护桩/放坡。`)).toEqual([]);
  });
  it('S1-3 单字词（桩/墙）不入 {2,8} 枚举 → 不报', () => {
    expect(ambiguousEitherOrIssues('采用桩/墙。')).toEqual([]);
  });
  it('S1-4 换行空白归一后仍命中 → 报', () => {
    expect(ambiguousEitherOrIssues('采用支护桩/\n放坡。').length).toBe(1);
  });
});

describe('S1 ambiguousEitherOr 形态B 括号悬置边界', () => {
  it('S1-5 括号内容恰 48 字符（悬置词在内）→ 报', () => {
    const md = `桩基（或${'暂'.repeat(43)}按图纸实施）。`;
    expect(ambiguousEitherOrIssues(md).length).toBe(1);
  });
  it('S1-6 括号内容 49 字符超上限 → 不报', () => {
    const md = `桩基（或${'暂'.repeat(44)}按图纸实施）。`;
    expect(ambiguousEitherOrIssues(md)).toEqual([]);
  });
  it('S1-7 词族词（桩）在括号前 19 字符（恰入前窗左界）→ 报', () => {
    const md = `桩${'、'.repeat(19)}（或按图纸实施）。`;
    expect(ambiguousEitherOrIssues(md).length).toBe(1);
  });
  it('S1-8 词族词在括号前 20 字符（出前窗）→ 不报', () => {
    const md = `桩${'、'.repeat(20)}（或按图纸实施）。`;
    expect(ambiguousEitherOrIssues(md)).toEqual([]);
  });
});

describe('S1 ambiguousEitherOr 形态C 决策词谱系与窗口边界', () => {
  const decisionWords = ['按', '采用', '选用', '拟用', '拟采用', '方案', '为'];
  it.each(decisionWords)('S1-9 决策词“%s”+放坡或支护 → 报', (word) => {
    expect(ambiguousEitherOrIssues(`${word}放坡或支护。`).length).toBe(1);
  });
  it('S1-10 决策词前 10 字符（完整词恰入窗口左界）→ 报', () => {
    expect(ambiguousEitherOrIssues(`采用${'、'.repeat(10)}放坡或支护。`).length).toBe(1);
  });
  it('S1-11 决策词前 11 字符（完整词出窗口）→ 不报', () => {
    expect(ambiguousEitherOrIssues(`采用${'、'.repeat(11)}放坡或支护。`)).toEqual([]);
  });
  const pipeWords = ['管线', '管道', '电缆', '给水', '排水'];
  it.each(pipeWords)('S1-12 形态C 管线豁免词“%s” → 不报', (word) => {
    expect(ambiguousEitherOrIssues(`钢板桩或槽钢挡护用于${word}保护。`)).toEqual([]);
  });
});

describe('S1 ambiguousEitherOr 设计词族谱系与聚合', () => {
  const designWords = ['基础', '支护', '围护', '桩', '结构', '开挖', '放坡', '喷锚', '排桩', '连续墙', '土钉', '锚杆', '标高', '深度', '形式', '体系'];
  it.each(designWords)('S1-13 词族“%s”单侧命中直陈两可 → 报', (word) => {
    expect(ambiguousEitherOrIssues(`采用${word}或放坡。`).length).toBe(1);
  });
  it('S1-14 多形态命中聚合为 1 条 message', () => {
    const issues = ambiguousEitherOrIssues('采用支护桩/放坡。基坑选用喷锚或土钉墙。');
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('支护桩/放坡');
    expect(issues[0].message).toContain('喷锚或土钉墙');
  });
  it('S1-15 同形态重复命中去重（Set）', () => {
    const issues = ambiguousEitherOrIssues('采用支护桩/放坡。采用支护桩/放坡。');
    expect(issues.length).toBe(1);
    expect(issues[0].message).not.toMatch(/支护桩\/放坡.*支护桩\/放坡/);
  });
});

// ── S2. supportFormFactConsistencyIssues：形式词谱系与豁免边界 ──

describe('S2 supportFormFact 资料形式词 10 词谱系（正文落地不报）', () => {
  const forms = ['土钉墙', '放坡', '喷锚', '挂网喷浆', '排桩', '灌注桩', '地下连续墙', '内支撑', '锚杆', '锚索'];
  it.each(forms)('S2-1 资料形式“%s”正文同词 → 不报', (form) => {
    const model = factsOf({ preciseFacts: [factOf({ fieldName: '基坑支护形式', value: form })] });
    expect(supportFormFactConsistencyIssues(`基坑支护小节：本工程采用${form}。`, model)).toEqual([]);
  });
});

describe('S2 supportFormFact 资料外体系词 8 词谱系（编造报）', () => {
  const foreign = ['支护桩', '冠梁', '钻孔灌注桩', '灌注桩', '地下连续墙', '排桩', '咬合桩', '内支撑'];
  const model = () => factsOf({ preciseFacts: [factOf({ fieldName: '基坑支护形式', value: '放坡' })] });
  it.each(foreign)('S2-2 正文编造“%s” → 报', (word) => {
    const issues = supportFormFactConsistencyIssues(`基坑支护小节：本工程采用放坡及${word}。`, model());
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain(word);
  });
  it('S2-3 多词编造聚合 message', () => {
    const issues = supportFormFactConsistencyIssues('基坑支护小节：本工程采用放坡及支护桩及冠梁。', model());
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('支护桩');
    expect(issues[0].message).toContain('冠梁');
  });
});

describe('S2 supportFormFact 否定豁免词谱系与窗口边界', () => {
  const negationWords = ['不采用', '未采用', '不设置', '未设置', '不使用', '不宜采用', '不得采用', '不再出现', '不得出现', '严禁出现', '避免出现', '已删除', '取消'];
  const model = () => factsOf({ preciseFacts: [factOf({ fieldName: '基坑支护形式', value: '放坡' })] });
  it.each(negationWords)('S2-4 否定词“%s”+编造词 → 豁免', (word) => {
    const md = `基坑支护采用放坡。${word}支护桩。`;
    expect(supportFormFactConsistencyIssues(md, model())).toEqual([]);
  });
  it('S2-5 否定词距编造词 9 字符（完整词恰入 12 前窗）→ 豁免', () => {
    const md = `基坑支护采用放坡。\n不采用${'、'.repeat(9)}支护桩。`;
    expect(supportFormFactConsistencyIssues(md, model())).toEqual([]);
  });
  it('S2-6 否定词距编造词 10 字符（完整词出 12 前窗）→ 报', () => {
    const md = `基坑支护采用放坡。\n不采用${'、'.repeat(10)}支护桩。`;
    expect(supportFormFactConsistencyIssues(md, model()).length).toBe(1);
  });
  it('S2-7 表格行否定豁免（前单元格否定词）→ 不报', () => {
    const md = '基坑支护采用放坡。\n| 不采用 | 支护桩 | 备注 |';
    expect(supportFormFactConsistencyIssues(md, model())).toEqual([]);
  });
});

describe('S2 supportFormFact 资料源四谱系', () => {
  const sources: Array<[string, Parameters<typeof factsOf>[0]]> = [
    ['canonical 槽位', { canonical: { byKey: { foundation_support_form: { value: '放坡' } } } as never }],
    ['drawings 源', { drawings: [factOf({ fieldName: '基坑支护形式', value: '放坡' })] }],
    ['project 源', { project: [factOf({ fieldName: '基坑支护形式', value: '放坡' })] }],
    ['preciseFacts 源', { preciseFacts: [factOf({ fieldName: '基坑支护形式', value: '放坡' })] }],
  ];
  it.each(sources)('S2-8 %s + 正文编造灌注桩 → 报', (_label, partial) => {
    const issues = supportFormFactConsistencyIssues('基坑支护小节：本工程采用放坡及灌注桩。', factsOf(partial));
    expect(issues.length).toBe(1);
  });
});

describe('S2 supportFormFact 反向完整性与过滤', () => {
  it('S2-9 资料形式未落地+正文有基坑语境 → 报', () => {
    const model = factsOf({ preciseFacts: [factOf({ fieldName: '基坑支护形式', value: '土钉墙' })] });
    const issues = supportFormFactConsistencyIssues('基坑支护小节：按设计实施。', model);
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('未落地');
  });
  it('S2-10 资料多形式部分落地 → 不报（部分落地即满足）', () => {
    const model = factsOf({ preciseFacts: [factOf({ fieldName: '基坑支护形式', value: '放坡+喷锚' })] });
    expect(supportFormFactConsistencyIssues('基坑支护小节：采用放坡。', model)).toEqual([]);
  });
  it('S2-11 资料形式词仅在否定语境出现也算落地 → 不报反向', () => {
    const model = factsOf({ preciseFacts: [factOf({ fieldName: '基坑支护形式', value: '放坡' })] });
    expect(supportFormFactConsistencyIssues('基坑支护小节：不采用放坡。', model)).toEqual([]);
  });
  it('S2-12 资料基坑开挖深度事实不触发形式提取 → 0 条', () => {
    const model = factsOf({ preciseFacts: [factOf({ fieldName: '基坑开挖深度', value: '5.15m' })] });
    expect(supportFormFactConsistencyIssues('基坑支护小节：采用灌注桩。', model)).toEqual([]);
  });
  it('S2-13 资料监测事实被过滤 → 0 条', () => {
    const model = factsOf({ preciseFacts: [factOf({ fieldName: '基坑支护监测', value: '监测频次每月1次' })] });
    expect(supportFormFactConsistencyIssues('基坑支护小节：采用灌注桩。', model)).toEqual([]);
  });
  it('S2-14 无资料形式事实 → 0 条', () => {
    expect(supportFormFactConsistencyIssues('基坑支护小节：采用灌注桩。', factsOf({}))).toEqual([]);
  });
});
