import { describe, expect, it } from 'vitest';
import { preciseFactUsageIssues } from '../src/services/document-workflow/qualityValidation';
import type { DocumentDraftChapter, DocumentFact, DocumentFactsModel } from '../src/services/document-workflow/types';

/** 构造 20 个不同管径参数，满足精确参数覆盖率校验的最小 token 数门槛 */
const DN_TOKENS = ['DN15', 'DN20', 'DN25', 'DN32', 'DN40', 'DN50', 'DN65', 'DN80', 'DN100', 'DN125', 'DN150', 'DN200', 'DN250', 'DN300', 'DN350', 'DN400', 'DN450', 'DN500', 'DN600', 'DN700'];
const DN_EVIDENCE = `给水管道规格一览：${DN_TOKENS.join('、')}。`;

function makeChapter(evidenceContent: string): DocumentDraftChapter {
  return { id: 'c1', title: '测试章节', content: '', evidence: [{ id: 'e1', roleId: 'evidence', filePath: 'test.md', content: evidenceContent, score: 0.9 }] } as unknown as DocumentDraftChapter;
}

function makeFactsModel(preciseFacts: DocumentFact[] = []): DocumentFactsModel {
  return { preciseFacts, bills: [], drawings: [], tables: [], factIndex: { reliableFacts: [], parameterFacts: [], tableFacts: [], drawingFacts: [], billFacts: [], diagnostics: [] } } as unknown as DocumentFactsModel;
}

function preciseIssueMessages(markdown: string, chapters: DocumentDraftChapter[], factsModel: DocumentFactsModel) {
  return preciseFactUsageIssues(markdown, factsModel, chapters).map(issue => issue.message);
}

describe('preciseFactUsageIssues 证据窗口口径', () => {
  it('章节证据内的关键参数未写入正文时触发关键参数抽查 error', () => {
    const messages = preciseIssueMessages('正文没有任何参数。', [makeChapter(DN_EVIDENCE)], makeFactsModel());
    expect(messages.some(message => message.startsWith('可靠精确参数使用不足：关键参数抽查'))).toBe(true);
  });

  it('章节证据参数全部落位正文时不触发 warning 与 error', () => {
    const markdown = `正文包含全部管径参数：${DN_TOKENS.join('、')}。`;
    const messages = preciseIssueMessages(markdown, [makeChapter(DN_EVIDENCE)], makeFactsModel());
    expect(messages.filter(message => message.includes('可靠精确参数使用不足'))).toHaveLength(0);
  });

  it('商务金额 token 从证据池忽略：金额未落位不拉低使用率', () => {
    const evidence = `${DN_EVIDENCE} 投标报价 12345.67 万元，合价 8899.00 万元。`;
    const markdown = `正文包含全部管径参数：${DN_TOKENS.join('、')}。`;
    const messages = preciseIssueMessages(markdown, [makeChapter(evidence)], makeFactsModel());
    expect(messages.filter(message => message.includes('可靠精确参数使用不足'))).toHaveLength(0);
  });

  it('抽查判定与 evidence 数组顺序无关（确定性排序）', () => {
    const markdown = `正文只写了 3 个管径：DN15、DN20、DN25。`;
    const reversed = makeChapter([...DN_TOKENS].reverse().join('、'));
    const first = preciseIssueMessages(markdown, [makeChapter(DN_EVIDENCE)], makeFactsModel());
    const second = preciseIssueMessages(markdown, [reversed], makeFactsModel());
    expect(second).toEqual(first);
  });

  it('证据池 token 过少时回退全项目精确事实池保持门禁兜底', () => {
    const preciseFacts = DN_TOKENS.map((value, index) => ({ id: `f${index}`, key: '给水管径', fieldName: '管径', value, roleId: 'precise_fact' } as unknown as DocumentFact));
    const messages = preciseIssueMessages('正文没有参数。', [makeChapter('仅 DN15 一条参数。')], makeFactsModel(preciseFacts));
    expect(messages.some(message => /可靠精确参数使用不足：0\/20/u.test(message))).toBe(true);
  });

  it('日历日期噪声（年份/月份）不进入证据池抽查', () => {
    const evidence = `${DN_EVIDENCE} 合同签订日期为 2024年12月，计划 2024 年开工。`;
    const markdown = `正文包含全部管径参数：${DN_TOKENS.join('、')}。`;
    const messages = preciseIssueMessages(markdown, [makeChapter(evidence)], makeFactsModel());
    expect(messages.filter(message => message.includes('可靠精确参数使用不足'))).toHaveLength(0);
  });
});
