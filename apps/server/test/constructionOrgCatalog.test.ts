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
    const { chapters: enriched } = enrichConstructionOrgOutline({ template: template(chapters), chapters, requirement: '房建施工组织设计，包含高层住宅和塔吊作业' });

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
    const { chapters: enriched } = enrichConstructionOrgOutline({ template: template(chapters), chapters, requirement: '施工组织设计' });

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

describe('construction org outline: 去截断与精准化回归（历史缺陷：写死 50 上限静默丢弃尾部模块小节）', () => {
  it('宽载体章挂靠总量超过旧上限 50 时零截断，全部保留', () => {
    const chapters = [
      { ...chapter('c1', '确保工期与质量的保障体系与措施、确保安全生产的管理体系与措施'), sections: Array.from({ length: 13 }, (_, index) => `规划小节${index + 1}`) },
      chapter('c2', '主要分部分项工程施工方案'),
      chapter('c3', '施工部署与现场平面布置'),
    ];
    const { chapters: enriched, report } = enrichConstructionOrgOutline({ template: template(chapters), chapters, requirement: '房建施工组织设计' });
    const broadChapter = enriched.find(item => item.id === 'c1');
    expect(broadChapter?.sections?.length).toBeGreaterThan(50);
    expect(broadChapter?.sections).toContain('质量管理体系与质量保证措施');
    expect(broadChapter?.sections).toContain('安全管理、风险分级与危大工程管控');
    expect(broadChapter?.sections).toContain('进度计划与工期保障');
    expect(report.totals.sectionCount).toBeGreaterThan(50);
  });

  it('必查模块经 missingMandatory 兜底回流挂靠宽载体章（kind=fallback）', () => {
    const chapters = [chapter('c1', '保障措施'), chapter('c2', '主要施工方案')];
    const { chapters: enriched, report } = enrichConstructionOrgOutline({ template: template(chapters), chapters, requirement: '施工组织设计' });
    const broadChapter = enriched.find(item => item.id === 'c1');
    expect(broadChapter?.sections).toContain('质量管理体系与质量保证措施');
    expect(broadChapter?.sections).toContain('安全管理、风险分级与危大工程管控');
    expect(broadChapter?.sections).toContain('农民工工资保障与劳务管理');
    const qualityAttached = report.attached.find(item => item.moduleId === 'quality');
    expect(qualityAttached?.kind).toBe('fallback');
    const laborAttached = report.attached.find(item => item.moduleId === 'labor-wage');
    expect(laborAttached?.kind).toBe('fallback');
  });

  it('宽载体章不首选挂环境模块（无专属特化锚点，仅兜底回流）', () => {
    const chapters = [chapter('c1', '确保工期与质量的保障体系与措施、确保安全生产的管理体系与措施'), chapter('c2', '主要分部分项工程施工方案')];
    const { report } = enrichConstructionOrgOutline({ template: template(chapters), chapters, requirement: '施工组织设计' });
    const environmentAttached = report.attached.find(item => item.moduleId === 'environment-green');
    expect(environmentAttached?.kind).toBe('fallback');
  });

  it('存在专属章节时模块首选挂专属章节而非宽载体章', () => {
    const chapters = [
      chapter('c1', '确保工期与质量的保障体系与措施'),
      chapter('c2', '文明施工与扬尘治理专项方案'),
      chapter('c3', '主要分部分项工程施工方案'),
    ];
    const { chapters: enriched, report } = enrichConstructionOrgOutline({ template: template(chapters), chapters, requirement: '施工组织设计' });
    const environmentAttached = report.attached.find(item => item.moduleId === 'environment-green');
    expect(environmentAttached?.kind).toBe('matched');
    expect(environmentAttached?.chapterId).toBe('c2');
    const broadChapter = enriched.find(item => item.id === 'c1');
    expect(broadChapter?.sections).not.toContain('文明施工、扬尘、噪声与绿色施工');
  });

  it('可选模块无语义匹配章节时进入 report.unattached；conditional 模块兜底挂靠不丢失', () => {
    const chapters = [chapter('c1', '确保工期与质量的保障体系与措施'), chapter('c2', '主要分部分项工程施工方案')];
    const { chapters: enriched, report } = enrichConstructionOrgOutline({ template: template(chapters), chapters, requirement: '施工组织设计' });
    const unattachedIds = report.unattached.map(item => item.moduleId);
    // optional 模块（BIM/智慧工地）仍不挂宽载体章，显式记录宁可丢可见
    expect(unattachedIds).toContain('digital-bim');
    // conditional 模块（竣工交付）已判定适用，全章落选时兜底挂到语义分最高章，不再静默丢失（历史缺陷：四新/竣工交付整篇 0 次出现）
    const deliveryAttached = report.attached.find(item => item.moduleId === 'delivery');
    expect(deliveryAttached?.kind).toBe('fallback');
    const deliveryChapter = enriched.find(item => item.id === deliveryAttached?.chapterId);
    expect(deliveryChapter?.sections?.some(section => /竣工|验收|保修/u.test(section))).toBe(true);
  });

  it('工期质量宽载体章经特化锚点挂靠进度计划模块（kind=matched）', () => {
    const chapters = [chapter('c1', '确保工期与质量的保障体系与措施'), chapter('c2', '主要分部分项工程施工方案')];
    const { report } = enrichConstructionOrgOutline({ template: template(chapters), chapters, requirement: '施工组织设计' });
    const progressAttached = report.attached.find(item => item.moduleId === 'progress');
    expect(progressAttached?.kind).toBe('matched');
    expect(progressAttached?.chapterId).toBe('c1');
  });

  it('queries/requiredFacts/tableSections 超过旧上限 30/30/20 不截断', () => {
    const chapters = [chapter('c1', '施工组织设计')];
    const { chapters: enriched } = enrichConstructionOrgOutline({ template: template(chapters), chapters, requirement: '房建施工组织设计' });
    const single = enriched[0];
    expect((single.queries || []).length).toBeGreaterThan(30);
    expect((single.requiredFacts || []).length).toBeGreaterThan(30);
    expect((single.tableSections || []).length).toBeGreaterThan(20);
  });
});
