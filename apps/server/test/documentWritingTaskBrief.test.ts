import { describe, expect, it } from 'vitest';
import { buildWritingTaskBrief } from '../src/services/document-workflow/documentWritingTaskBrief';
import type { DocumentTemplateChapter } from '../src/services/document-workflow/types';

const chapters: DocumentTemplateChapter[] = [
  { id: 'c1', title: '工程重点难点及危大工程的保障体系', purpose: '', requiredFacts: [], queries: [] },
  { id: 'c2', title: '确保工期与质量的保障体系与措施、确保安全生产的管理体系与措施', purpose: '', requiredFacts: [], queries: [] },
  { id: 'c3', title: '确保人、材、机的保障体系与措施', purpose: '', requiredFacts: [], queries: [] },
];

describe('写作任务简报：招标硬性要求响应（reviewResponse 90 分目标）', () => {
  it('施工组织设计全局写作焦点包含招标硬性要求逐项响应（含缺陷责任期与保修）', () => {
    const brief = buildWritingTaskBrief({ chapters, templateName: '施工组织设计模板', requirement: '依据招标文件要求编制施工组织设计' });
    expect(brief.documentType).toBe('施工组织设计');
    expect(brief.globalWritingFocus.some(focus => /招标硬性要求必须逐项明确响应/u.test(focus))).toBe(true);
    expect(brief.globalWritingFocus.some(focus => /缺陷责任期与保修/u.test(focus))).toBe(true);
  });

  it('质量类章节任务卡必须覆盖保修与缺陷责任期承诺', () => {
    const brief = buildWritingTaskBrief({
      chapters: [...chapters, { id: 'c4', title: '质量保证体系与措施', purpose: '', requiredFacts: [], queries: [] }],
      templateName: '施工组织设计模板',
    });
    const quality = brief.chapters.find(chapter => chapter.chapterTitle === '质量保证体系与措施')!;
    expect(quality.writingGoal).toContain('质量闭环');
    expect(quality.mustCover.some(item => /保修与缺陷责任期/u.test(item))).toBe(true);
  });
});
