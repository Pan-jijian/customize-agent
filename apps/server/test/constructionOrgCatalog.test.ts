import { describe, expect, it } from 'vitest';
import { enrichConstructionOrgOutline, inferConstructionOrgProjectTypes } from '../src/services/document-workflow/constructionOrgCatalog';
import type { DocumentTemplate, DocumentTemplateChapter } from '../src/services/document-workflow/types';

function chapter(id: string, title: string): DocumentTemplateChapter {
  return { id, title, purpose: `生成${title}`, queries: [title], requiredFacts: [], sections: [] };
}

function template(chapters: DocumentTemplateChapter[], requirement = '施工组织设计'): DocumentTemplate {
  return {
    id: 'test-template',
    name: '施工组织设计测试模板',
    description: '测试',
    category: '施工组织设计',
    outputTitle: '施工组织设计',
    chapters,
  };
}

describe('construction organization catalog enrichment', () => {
  it('keeps three explicit chapters and reasonably attaches standard modules', () => {
    const chapters = [
      chapter('c1', '工程概况与施工部署'),
      chapter('c2', '主要施工方案'),
      chapter('c3', '保障措施'),
    ];
    const enriched = enrichConstructionOrgOutline({ template: template(chapters), chapters, requirement: '房建施工组织设计，包含高层住宅和塔吊作业' });

    expect(enriched.map(item => item.title)).toEqual(['工程概况与施工部署', '主要施工方案', '保障措施']);
    expect(enriched[0].sections?.join('、')).toContain('编制说明与工程概况');
    expect(enriched[0].sections?.join('、')).toContain('施工部署与施工流水组织');
    expect(enriched[1].sections?.join('、')).toContain('主要分部分项工程施工方案');
    expect(enriched[1].sections?.join('、')).toContain('房建工程专项施工工艺');
    expect(enriched[2].sections?.join('、')).toContain('质量管理体系与质量保证措施');
    expect(enriched[2].sections?.join('、')).toContain('安全管理、风险分级与危大工程管控');
    expect(enriched[2].sections?.join('、')).toContain('农民工工资保障与劳务管理');
  });

  it('only expands content that belongs under each user chapter title', () => {
    const chapters = [
      chapter('c1', '雨季施工措施'),
      chapter('c2', '扬尘治理措施'),
      chapter('c3', '农民工工资保障'),
    ];
    const enriched = enrichConstructionOrgOutline({ template: template(chapters), chapters, requirement: '施工组织设计' });

    expect(enriched.map(item => item.title)).toEqual(['雨季施工措施', '扬尘治理措施', '农民工工资保障']);
    expect(enriched[0].sections?.join('、')).toContain('季节性施工保障');
    expect(enriched[1].sections?.join('、')).toContain('文明施工、扬尘、噪声与绿色施工');
    expect(enriched[2].sections?.join('、')).toContain('农民工工资保障与劳务管理');
    expect(enriched[0].sections?.join('、')).not.toContain('主要分部分项工程施工方案');
    expect(enriched[1].sections?.join('、')).not.toContain('项目管理组织机构与职责');
  });

  it('infers municipal and renovation project types from requirement text', () => {
    const chapters = [chapter('c1', '施工方案'), chapter('c2', '保障措施')];
    expect(inferConstructionOrgProjectTypes({ template: template(chapters), chapters, requirement: '市政道路雨污水管网施工组织设计' })).toContain('municipal');
    expect(inferConstructionOrgProjectTypes({ template: template(chapters), chapters, requirement: '老旧小区改造施工组织设计，包含飞线整治' })).toContain('renovation');
  });
});
