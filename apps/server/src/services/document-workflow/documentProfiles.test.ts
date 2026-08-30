/**
 * documentProfiles 单测：文档画像分类（五类专业文档 + 施组默认）。
 */
import { describe, expect, it } from 'vitest';
import { buildDocumentProfileReport } from './documentProfiles';
import type { DocumentTemplate, DocumentTemplateChapter } from './types';

function makeTemplate(name: string, outputTitle: string, chapterTitles: string[], requirement = ''): DocumentTemplate {
  return {
    id: 't1',
    name,
    description: '',
    category: 'doc',
    outputTitle,
    chapters: chapterTitles.map((title, index): DocumentTemplateChapter => ({ id: `c${index}`, title, purpose: '', queries: [], requiredFacts: [] })),
  };
}

describe('buildDocumentProfileReport', () => {
  it('专项施工方案画像', () => {
    const report = buildDocumentProfileReport({
      template: makeTemplate('危大工程专项施工方案', '基坑支护', ['专项方案编制', '风险控制']),
      chapters: [],
      requirement: '',
    });
    expect(report.type).toBe('专项施工方案');
    expect(report.dimensions).toContain('工艺参数');
    expect(report.requiredEvidencePolicy).toContain('本地知识库');
  });

  it('投标技术方案画像（需求文本参与匹配）', () => {
    const report = buildDocumentProfileReport({
      template: makeTemplate('技术标', '响应文件', []),
      chapters: [],
      requirement: '本项目采用公开招标方式，投标人须提交技术标',
    });
    expect(report.type).toBe('投标技术方案');
    expect(report.dimensions).toContain('招标响应');
  });

  it('监理规划/细则画像', () => {
    const report = buildDocumentProfileReport({
      template: makeTemplate('监理规划', '旁站细则', ['平行检验']),
      chapters: [],
      requirement: '',
    });
    expect(report.type).toBe('监理规划/细则');
  });

  it('可研/项目建议书画像', () => {
    const report = buildDocumentProfileReport({
      template: makeTemplate('可行性研究报告', '投资估算', []),
      chapters: [],
      requirement: '',
    });
    expect(report.type).toBe('可研/项目建议类文档');
  });

  it('运维维护方案画像', () => {
    const report = buildDocumentProfileReport({
      template: makeTemplate('运维方案', '巡检计划', ['维护保养']),
      chapters: [],
      requirement: '',
    });
    expect(report.type).toBe('运维维护方案');
  });

  it('无匹配 → 施工组织设计默认画像', () => {
    const report = buildDocumentProfileReport({
      template: makeTemplate('施组', '施工组织设计', ['工程概况', '施工部署']),
      chapters: [],
      requirement: '',
    });
    expect(report.type).toBe('施工组织设计/施工技术方案');
    expect(report.dimensions).toContain('工程概况');
  });
});
