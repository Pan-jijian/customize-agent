/**
 * C2 大纲要求校准单测：additions-only 防幻觉校验（章名匹配/标题清洗/重复剔除/条款碎片过滤/数量上限）、
 * 结构守恒校验（原大纲小节逐条保留，任一缺失整体回退）、空响应/调用失败回退。
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/services/document-workflow/llmClient', () => ({ callDocumentLlmJson: vi.fn() }));

import { callDocumentLlmJson } from '@/services/document-workflow/llmClient';
import { applyRequirementSectionAdditions, calibrateOutlineSectionsToRequirements } from '@/services/document-workflow/requirementCalibration';
import type { DocumentTemplateChapter } from '@/services/document-workflow/types';

const llmJsonMock = vi.mocked(callDocumentLlmJson);

const chapters: DocumentTemplateChapter[] = [
  { id: 'c-1', title: '第一章 编制说明与工程概况', sections: ['工程概况', '编制依据'], purpose: '', queries: [], requiredFacts: [] },
  { id: 'c-2', title: '第三章 质量目标与创优计划', sections: ['质量目标', '质量保证体系'], purpose: '', queries: [], requiredFacts: [] },
  { id: 'c-3', title: '第五章 绿色施工与智慧工地', sections: ['绿色施工措施'], purpose: '', queries: [], requiredFacts: [] },
];
const requirementSummary = ['创优目标：确保黄山杯。', '绿色建筑等级要求：达到国标二星级。', '装配率要求：装配率为30%。'];

describe('calibrateOutlineSectionsToRequirements', () => {
  it('空要求摘要或空章列表 → 不发起 LLM 调用，返回空数组', async () => {
    expect(await calibrateOutlineSectionsToRequirements({ chapters, requirementSummary: [], templateName: '施工组织设计' })).toEqual([]);
    expect(await calibrateOutlineSectionsToRequirements({ chapters: [], requirementSummary, templateName: '施工组织设计' })).toEqual([]);
    expect(llmJsonMock).not.toHaveBeenCalled();
  });

  it('LLM 调用失败（返回 undefined）→ 空数组（回退原规划）', async () => {
    llmJsonMock.mockResolvedValue(undefined);
    expect(await calibrateOutlineSectionsToRequirements({ chapters, requirementSummary, templateName: '施工组织设计' })).toEqual([]);
  });

  it('合法新增：清洗后返回，章名匹配到原章（去序号归一化）', async () => {
    llmJsonMock.mockResolvedValue({ additions: [{ chapterTitle: '质量目标与创优计划', sections: ['创优目标与奖惩承诺'] }] });
    const result = await calibrateOutlineSectionsToRequirements({ chapters, requirementSummary, templateName: '施工组织设计' });
    expect(result).toEqual([{ chapterTitle: '第三章 质量目标与创优计划', sections: ['创优目标与奖惩承诺'] }]);
  });

  it('防幻觉：不存在的章名丢弃', async () => {
    llmJsonMock.mockResolvedValue({ additions: [{ chapterTitle: '第十章 不存在的章节', sections: ['某小节'] }] });
    expect(await calibrateOutlineSectionsToRequirements({ chapters, requirementSummary, templateName: '施工组织设计' })).toEqual([]);
  });

  it('防重复：与已有小节等效的新增被剔除', async () => {
    llmJsonMock.mockResolvedValue({ additions: [{ chapterTitle: '质量目标与创优计划', sections: ['质量目标'] }] });
    expect(await calibrateOutlineSectionsToRequirements({ chapters, requirementSummary, templateName: '施工组织设计' })).toEqual([]);
  });

  it('条款碎片与指令型标题被过滤（与规划同口径）', async () => {
    llmJsonMock.mockResolvedValue({ additions: [{ chapterTitle: '质量目标与创优计划', sections: ['1委员会确定中', '创优目标与奖惩承诺'] }] });
    const result = await calibrateOutlineSectionsToRequirements({ chapters, requirementSummary, templateName: '施工组织设计' });
    expect(result).toEqual([{ chapterTitle: '第三章 质量目标与创优计划', sections: ['创优目标与奖惩承诺'] }]);
  });

  it('数量上限：每章最多 2 个新增、全局最多 8 个', async () => {
    llmJsonMock.mockResolvedValue({ additions: [{ chapterTitle: '质量目标与创优计划', sections: ['创优目标与奖惩承诺', '奖项申报保障措施', '超额第三个', '超额第四个'] }] });
    const result = await calibrateOutlineSectionsToRequirements({ chapters, requirementSummary, templateName: '施工组织设计' });
    expect(result[0]?.sections).toHaveLength(2);
  });

  it('空 additions → 空数组', async () => {
    llmJsonMock.mockResolvedValue({ additions: [] });
    expect(await calibrateOutlineSectionsToRequirements({ chapters, requirementSummary, templateName: '施工组织设计' })).toEqual([]);
  });
});

describe('applyRequirementSectionAdditions（结构守恒）', () => {
  it('新增挂到匹配章节尾部，原大纲小节逐条完整保留（结构守恒）', () => {
    const result = applyRequirementSectionAdditions(chapters, [{ chapterTitle: '第三章 质量目标与创优计划', sections: ['创优目标与奖惩承诺'] }]);
    expect(result.applied).toHaveLength(1);
    expect(result.chapters).toHaveLength(3);
    expect(result.chapters[0]?.sections).toEqual(['工程概况', '编制依据']);
    expect(result.chapters[1]?.sections).toEqual(['质量目标', '质量保证体系', '创优目标与奖惩承诺']);
    expect(result.chapters[2]?.sections).toEqual(['绿色施工措施']);
  });

  it('未匹配到章节的新增不应用', () => {
    const result = applyRequirementSectionAdditions(chapters, [{ chapterTitle: '第十章 不存在的章节', sections: ['某小节'] }]);
    expect(result.applied).toEqual([]);
    expect(result.chapters[0]?.sections).toEqual(['工程概况', '编制依据']);
  });

  it('与已有小节等效的新增不应用', () => {
    const result = applyRequirementSectionAdditions(chapters, [{ chapterTitle: '第三章 质量目标与创优计划', sections: ['质量目标'] }]);
    expect(result.applied).toEqual([]);
    expect(result.chapters[1]?.sections).toEqual(['质量目标', '质量保证体系']);
  });

  it('空 additions → 原章节直接返回', () => {
    const result = applyRequirementSectionAdditions(chapters, []);
    expect(result.chapters).toBe(chapters);
    expect(result.applied).toEqual([]);
  });
});
