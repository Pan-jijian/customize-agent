import { describe, expect, it } from 'vitest';
import { QINGTIAN_REVIEW_SYSTEM, qingtianBlockReviewPrompt, qingtianFixInstructionFor } from '@/services/document-workflow/qingtianReviewSpec';
import type { QingtianReviewIssue } from '@/services/document-workflow/fullDimensionReview';

describe('QINGTIAN_REVIEW_SYSTEM（内置评审系统提示词）', () => {
  it('非空且覆盖九大评审维度', () => {
    expect(QINGTIAN_REVIEW_SYSTEM.length).toBeGreaterThan(100);
    expect(QINGTIAN_REVIEW_SYSTEM).toContain('九大评审维度');
  });

  it('包含对标依据与模板化判定', () => {
    expect(QINGTIAN_REVIEW_SYSTEM).toContain('住建部令第37号');
    expect(QINGTIAN_REVIEW_SYSTEM).toContain('模板化判定');
  });

  it('包含输出铁律与对标材料核对铁律', () => {
    expect(QINGTIAN_REVIEW_SYSTEM).toContain('输出铁律');
    expect(QINGTIAN_REVIEW_SYSTEM).toContain('招标对标材料中已明确的数字事实');
  });
});

describe('qingtianBlockReviewPrompt（分块评审提示词）', () => {
  it('注入块信息与正文块', () => {
    const prompt = qingtianBlockReviewPrompt({ projectName: 'A工程', blockIndex: 2, blockTotal: 5, chapterTitles: ['工程概况', '施工部署'], blockContent: '正文内容。' });
    expect(prompt).toContain('A工程');
    expect(prompt).toContain('第 2/5 块');
    expect(prompt).toContain('包含章节：工程概况、施工部署');
    expect(prompt).toContain('<正文块>');
    expect(prompt).toContain('正文内容。');
    expect(prompt).toContain('</正文块>');
    expect(prompt).toContain('JSON 结构');
  });

  it('3.2 前缀稳定化：不同块序号的 prompt 共享稳定前缀（块序号/章节清单移至尾部）', () => {
    const base = { projectName: 'A工程', tenderContext: '工期540日历天', blockTotal: 5, blockContent: '正文内容。' };
    const promptA = qingtianBlockReviewPrompt({ ...base, blockIndex: 1, chapterTitles: ['工程概况'] });
    const promptB = qingtianBlockReviewPrompt({ ...base, blockIndex: 3, chapterTitles: ['施工部署', '质量管理'] });
    // 稳定段（项目名/招标基准/评审指令/JSON 契约）逐字节一致
    const stableHeadA = promptA.slice(0, promptA.indexOf('本块为第'));
    const stableHeadB = promptB.slice(0, promptB.indexOf('本块为第'));
    expect(stableHeadA).toBe(stableHeadB);
    expect(stableHeadA).toContain('A工程');
    expect(stableHeadA).toContain('JSON 结构');
    // 变化段（块序号/章节清单）位于正文块之前紧邻处
    expect(promptA.indexOf('本块为第 1/5 块')).toBeLessThan(promptA.indexOf('<正文块>'));
    expect(promptB).toContain('本块为第 3/5 块，包含章节：施工部署、质量管理');
  });

  it('tenderContext 优先作为对标材料', () => {
    const prompt = qingtianBlockReviewPrompt({ projectName: 'A工程', tenderContext: '工期540日历天', requirement: '要求摘要', blockIndex: 1, blockTotal: 1, chapterTitles: ['工程概况'], blockContent: 'x' });
    expect(prompt).toContain('【招标对标材料（核对基准，不得偏离）】');
    expect(prompt).toContain('工期540日历天');
    expect(prompt).not.toContain('要求摘要');
  });

  it('无 tenderContext 时回落 requirement 摘要', () => {
    const prompt = qingtianBlockReviewPrompt({ projectName: 'A工程', requirement: '要求摘要', blockIndex: 1, blockTotal: 1, chapterTitles: ['工程概况'], blockContent: 'x' });
    expect(prompt).toContain('招标文件要求摘要：要求摘要');
  });

  it('两者均无时不注入招标块', () => {
    const prompt = qingtianBlockReviewPrompt({ projectName: 'A工程', blockIndex: 1, blockTotal: 1, chapterTitles: ['工程概况'], blockContent: 'x' });
    expect(prompt).not.toContain('对标材料');
    expect(prompt).not.toContain('要求摘要');
  });
});

describe('qingtianFixInstructionFor（评审问题定向修复指令）', () => {
  const issue = (dimension: string): QingtianReviewIssue => ({ dimension, location: '工程概况', quote: '原文片段示例', riskLevel: '高风险', basis: '对标依据示例', description: '问题描述示例' });

  it('按维度下发定向修复头与修复体', () => {
    const instruction = qingtianFixInstructionFor([issue('合规红线')]);
    expect(instruction).toContain('【合规红线定向修复】');
    expect(instruction).toContain('对照住建部37号令');
  });

  it('模板化维度下发改写指令', () => {
    const instruction = qingtianFixInstructionFor([issue('模板化')]);
    expect(instruction).toContain('【模板化定向改写】');
    expect(instruction).toContain('通用表述替换');
  });

  it('未知维度回落全维度修复', () => {
    const instruction = qingtianFixInstructionFor([issue('其他维度')]);
    expect(instruction).toContain('【全维度评审定向修复】');
  });

  it('问题清单逐条列出位置/原文/风险/依据/描述', () => {
    const instruction = qingtianFixInstructionFor([issue('内容质量'), issue('数据逻辑')]);
    expect(instruction).toContain('问题 1：');
    expect(instruction).toContain('问题 2：');
    expect(instruction).toContain('- 位置：工程概况');
    expect(instruction).toContain('- 原文片段：原文片段示例');
    expect(instruction).toContain('- 风险等级：高风险');
    expect(instruction).toContain('只修复下列问题，其余内容保持原样');
  });

  it('无问题时的空清单边界', () => {
    const instruction = qingtianFixInstructionFor([]);
    expect(instruction).toContain('【全维度评审定向修复】');
    expect(instruction).toContain('只修复下列问题，其余内容保持原样');
  });
});
