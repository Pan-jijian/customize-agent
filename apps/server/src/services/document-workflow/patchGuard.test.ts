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

describe('repairChapterByQuality P1-2 空白容错定位', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('originalText 复述空白差异（换行折叠为空格）时唯一命中即应用', async () => {
    const multiLineChapter = { ...chapter, content: '## 工程概况\n\n施工组织总平面\n\n布置按以下原则执行。' } as unknown as DocumentDraftChapter;
    // LLM 复述把正文换行写成单空格：精确匹配失败，空白容错唯一命中后应用
    llmMock.mockResolvedValue({ patches: [{ originalText: '施工组织总平面 布置按以下原则执行。', replacement: '施工组织总平面布置按三条原则执行。' }] });
    const result = await repairChapterByQuality({ template, chapter: multiLineChapter, issues: ['需要修复'], promptTexts: '提示词', forbidDrawingImages: false });
    expect(result.appliedCount).toBe(1);
    expect(result.content).toContain('施工组织总平面布置按三条原则执行。');
  });

  it('空白容错后多处命中时拒绝应用（唯一性保护不变）', async () => {
    const dupChapter = { ...chapter, content: '## 工程概况\n\n阶段一\n投入三百人。\n\n阶段二结束。\n\n阶段一\n投入三百人。' } as unknown as DocumentDraftChapter;
    // 复述用单空格、正文两处都是换行：精确匹配失败，模糊模式命中 2 处 → 拒绝
    llmMock.mockResolvedValue({ patches: [{ originalText: '阶段一 投入三百人。', replacement: '阶段一投入三百五十人。' }] });
    const result = await repairChapterByQuality({ template, chapter: dupChapter, issues: ['需要修复'], promptTexts: '提示词', forbidDrawingImages: false });
    expect(result.appliedCount).toBe(0);
    expect(result.producedCount).toBe(1);
    expect(result.content).toBe(dupChapter.content);
  });

  it('复述漏词（实质差异）不匹配不应用（安全边界）', async () => {
    const multiLineChapter = { ...chapter, content: '## 工程概况\n\n施工组织总平面\n\n布置按以下原则执行。' } as unknown as DocumentDraftChapter;
    // 复述漏掉「以下」：模糊模式无法匹配，patch 不应用（空白容错不放大为漏词容错）
    llmMock.mockResolvedValue({ patches: [{ originalText: '施工组织总平面 布置按原则执行。', replacement: '施工组织总平面布置按三条原则执行。' }] });
    const result = await repairChapterByQuality({ template, chapter: multiLineChapter, issues: ['需要修复'], promptTexts: '提示词', forbidDrawingImages: false });
    expect(result.appliedCount).toBe(0);
    expect(result.content).toBe(multiLineChapter.content);
  });
});

describe('repairChapterByQuality 删除类 patch（空 replacement）', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('锚点模式：replacement 为空字符串 → 删除锚点命中的整句', async () => {
    const padding = '本项目为合肥师范项目，总建筑面积28570平方米，主要建设内容为教学楼、实验楼与附属配套工程。'.repeat(4);
    const content = `## 工程概况\n\n${padding}\n\n本句为来源罗列话术，根据招标文件与工程量清单编制。\n\n正文继续。`;
    const delChapter = { ...chapter, content } as unknown as DocumentDraftChapter;
    llmMock.mockResolvedValue({ patches: [{ anchorIndex: 0, replacement: '' }] });
    const result = await repairChapterByQuality({ template, chapter: delChapter, issues: ['需要删除来源罗列句'], promptTexts: '提示词', forbidDrawingImages: false, anchorTexts: ['本句为来源罗列话术，根据招标文件与工程量清单编制。'] });
    expect(result.appliedCount).toBe(1);
    expect(result.content).not.toContain('来源罗列话术');
    expect(result.content).toContain('正文继续。');
  });

  it('普通模式：originalText 定位 + 空 replacement → 删除该区间', async () => {
    const padding = '本项目为合肥师范项目，总建筑面积28570平方米，主要建设内容为教学楼、实验楼与附属配套工程。'.repeat(4);
    const delChapter = { ...chapter, content: `## 工程概况\n\n${padding}\n\n要删除的句子。\n\n正文继续。` } as unknown as DocumentDraftChapter;
    llmMock.mockResolvedValue({ patches: [{ originalText: '要删除的句子。', replacement: '' }] });
    const result = await repairChapterByQuality({ template, chapter: delChapter, issues: ['需要删除'], promptTexts: '提示词', forbidDrawingImages: false });
    expect(result.appliedCount).toBe(1);
    expect(result.content).not.toContain('要删除的句子');
  });

  it('删除过多内容导致正文缩水超 35% → 拒绝（安全边界不变）', async () => {
    const bigDelete = '该段为需要删除的冗长内容，共计数百字，删除后正文长度将显著缩短。'.repeat(20);
    const delChapter = { ...chapter, content: `## 工程概况\n\n${bigDelete}\n\n正文。` } as unknown as DocumentDraftChapter;
    llmMock.mockResolvedValue({ patches: [{ originalText: bigDelete, replacement: '' }] });
    const result = await repairChapterByQuality({ template, chapter: delChapter, issues: ['需要删除'], promptTexts: '提示词', forbidDrawingImages: false });
    expect(result.appliedCount).toBe(0);
  });
});

describe('repairChapterByQuality 补写模式锚点前缀自动补齐', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('LLM 不复述锚点 → 系统自动补锚点前缀后应用（历史空转根治）', async () => {
    const appendChapter = { ...chapter, content: '## 工程概况\n\n本项目为合肥师范项目，工程质量目标为确保黄山杯。' } as unknown as DocumentDraftChapter;
    // 补写定位：锚点=末尾定位句；LLM 只输出补写内容、不复述锚点
    llmMock.mockResolvedValue({ patches: [{ anchorIndex: 0, replacement: '同时按规定为作业人员办理工伤保险。' }] });
    const result = await repairChapterByQuality({
      template, chapter: appendChapter, issues: ['需要补写工伤保险表述'], promptTexts: '提示词', forbidDrawingImages: false,
      anchorTexts: [{ text: '本项目为合肥师范项目，工程质量目标为确保黄山杯。', append: true }],
    });
    expect(result.appliedCount).toBe(1);
    // 锚点原文保留 + 补写内容追加
    expect(result.content).toContain('工程质量目标为确保黄山杯。');
    expect(result.content).toContain('同时按规定为作业人员办理工伤保险。');
  });

  it('LLM 已复述锚点前缀 → 直接应用不重复拼接', async () => {
    const appendChapter = { ...chapter, content: '## 工程概况\n\n本项目为合肥师范项目，工程质量目标为确保黄山杯。' } as unknown as DocumentDraftChapter;
    llmMock.mockResolvedValue({ patches: [{ anchorIndex: 0, replacement: '本项目为合肥师范项目，工程质量目标为确保黄山杯。同时按规定为作业人员办理工伤保险。' }] });
    const result = await repairChapterByQuality({
      template, chapter: appendChapter, issues: ['需要补写'], promptTexts: '提示词', forbidDrawingImages: false,
      anchorTexts: [{ text: '本项目为合肥师范项目，工程质量目标为确保黄山杯。', append: true }],
    });
    expect(result.appliedCount).toBe(1);
    expect(result.content).toContain('同时按规定为作业人员办理工伤保险。');
    expect((result.content.match(/工伤保险/gu) || []).length).toBe(1);
  });
});
