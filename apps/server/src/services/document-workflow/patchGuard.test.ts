/**
 * patchGuard 单测（二期 2.1）：
 * 1. deterministicDefectPrecheck 四类确定性缺陷检测（命中/误伤边界）；
 * 2. repairChapterByQuality 的 patchGuard 行为（observe 照常应用只计数、enforce 拒绝坏 patch、
 *    producedCount 与 appliedCount 区分、不传 patchGuard 时行为不变）。
 * LLM 通道全部 mock（避免真实 LLM 调用）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./llmClient', () => ({
  callDocumentLlmJson: vi.fn(),
  isContextOverflowLlmError: vi.fn(() => false),
  // 3.4 分层统计 helper 与生产实现同源（空段过滤后字符求和）
  contextLayerChars: (parts: Array<string | undefined | false>) => parts.filter((part): part is string => Boolean(part)).reduce((sum, part) => sum + part.length, 0),
}));

import { callDocumentLlmJson } from './llmClient';
import { deterministicDefectPrecheck } from './patchGuard';
import { repairChapterByQuality } from './rolePipeline';
import type { DocumentDraftChapter, DocumentGenerationDiagnostics, DocumentTemplate } from './types';

const llmMock = vi.mocked(callDocumentLlmJson);

function mockDiagnostics(): DocumentGenerationDiagnostics {
  return { llm: { calls: 0, failures: 0, maxActive: 0, retries: 0 } } as unknown as DocumentGenerationDiagnostics;
}

const template = { name: '测试模板' } as DocumentTemplate;
const chapter = { id: 'c1', title: '工程概况', content: '## 工程概况\n\n原文正文。', evidence: [], missingFacts: [], sections: [] } as unknown as DocumentDraftChapter;

describe('deterministicDefectPrecheck', () => {
  it('资料来源罗列句命中（E4 同源正则）', () => {
    expect(deterministicDefectPrecheck('本工程根据招标文件、补疑澄清文件、设计图纸及工程量清单，确定工期为540日历天。')).toContain('资料来源罗列句');
  });

  it('内部术语命中（E7 同源词集）', () => {
    const hits = deterministicDefectPrecheck('本工程按工作包组织施工。');
    expect(hits.some(hit => hit.includes('工作包'))).toBe(true);
  });

  it('内部话术扩展词命中（落位/峰值口径）', () => {
    expect(deterministicDefectPrecheck('各阶段劳动力配置不得出现其他峰值口径。').some(hit => hit.includes('峰值口径'))).toBe(true);
    expect(deterministicDefectPrecheck('本专业工程主要清单项落位如下。').some(hit => hit.includes('落位'))).toBe(true);
  });

  it('具体日历日期命中（R5 同源正则）', () => {
    expect(deterministicDefectPrecheck('计划于2026年8月31日开工。').some(hit => hit.includes('2026年8月31日'))).toBe(true);
  });

  it('叠词命中（Q8 同源正则）', () => {
    expect(deterministicDefectPrecheck('本工程执行执行专项施工方案。').some(hit => hit.includes('叠词'))).toBe(true);
  });

  it('正常正文不误伤', () => {
    expect(deterministicDefectPrecheck('主体结构阶段高峰投入约300人，装饰装修阶段高峰投入约350人，各阶段劳动力配置与分阶段投入明细表保持一致。')).toEqual([]);
  });

  it('商务纪律词不命中内部术语（子集排除 BID_DISCIPLINE_PHRASES）', () => {
    expect(deterministicDefectPrecheck('严格执行评标纪律，确保投标活动合法合规。')).toEqual([]);
  });

  it('多类缺陷同时命中时全部上报', () => {
    const hits = deterministicDefectPrecheck('根据招标文件及工程量清单，计划于2026年8月31日按工作包组织施工。');
    expect(hits.some(hit => hit.includes('资料来源罗列句'))).toBe(true);
    expect(hits.some(hit => hit.includes('工作包'))).toBe(true);
    expect(hits.some(hit => hit.includes('2026年8月31日'))).toBe(true);
  });
});

describe('repairChapterByQuality patchGuard', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('observe 模式：坏 patch 照常应用并计数 patchGuardHits', async () => {
    const diagnostics = mockDiagnostics();
    llmMock.mockResolvedValue({ patches: [{ originalText: '原文正文。', replacement: '本工程按工作包组织施工。' }] });
    const result = await repairChapterByQuality({
      template, chapter, issues: ['需要修复'], promptTexts: '提示词', forbidDrawingImages: false, patchGuard: { observeOnly: true, diagnostics },
    });
    expect(result.appliedCount).toBe(1);
    expect(result.content).toContain('工作包');
    expect(diagnostics.llm.patchGuardHits).toBe(1);
    expect(diagnostics.llm.patchGuardRejects).toBeUndefined();
  });

  it('enforce 模式：坏 patch 被拒绝，content 不变且 producedCount 保留', async () => {
    const diagnostics = mockDiagnostics();
    llmMock.mockResolvedValue({ patches: [{ originalText: '原文正文。', replacement: '本工程按工作包组织施工。' }] });
    const result = await repairChapterByQuality({
      template, chapter, issues: ['需要修复'], promptTexts: '提示词', forbidDrawingImages: false, patchGuard: { observeOnly: false, diagnostics },
    });
    expect(result.appliedCount).toBe(0);
    expect(result.producedCount).toBe(1);
    expect(result.content).toBe(chapter.content);
    expect(diagnostics.llm.patchGuardRejects).toBe(1);
    expect(diagnostics.llm.patchGuardHits).toBeUndefined();
  });

  it('干净 patch 在 enforce 模式下正常应用', async () => {
    const diagnostics = mockDiagnostics();
    llmMock.mockResolvedValue({ patches: [{ originalText: '原文正文。', replacement: '主体结构阶段高峰投入约300人。' }] });
    const result = await repairChapterByQuality({
      template, chapter, issues: ['需要修复'], promptTexts: '提示词', forbidDrawingImages: false, patchGuard: { observeOnly: false, diagnostics },
    });
    expect(result.appliedCount).toBe(1);
    expect(diagnostics.llm.patchGuardRejects).toBeUndefined();
  });

  it('不传 patchGuard 时行为不变（回归保护）', async () => {
    llmMock.mockResolvedValue({ patches: [{ originalText: '原文正文。', replacement: '本工程按工作包组织施工。' }] });
    const result = await repairChapterByQuality({ template, chapter, issues: ['需要修复'], promptTexts: '提示词', forbidDrawingImages: false });
    expect(result.appliedCount).toBe(1);
    expect(result.content).toContain('工作包');
  });
});
