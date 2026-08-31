import { describe, expect, it } from 'vitest';
import { CONSTRUCTION_ORG_CATALOG, enrichConstructionOrgOutline, inferConstructionOrgProjectTypes, type ConstructionOrgProjectType } from './constructionOrgCatalog';
import type { DocumentTemplate, DocumentTemplateChapter } from './types';

const template = (name: string, outputTitle: string, chapters: DocumentTemplateChapter[]): DocumentTemplate => ({ id: 't1', name, outputTitle, description: '', category: '', chapters });

const chapter = (id: string, title: string, sections: string[] = []): DocumentTemplateChapter => ({ id, title, purpose: '', queries: [], requiredFacts: [], sections });

describe('CONSTRUCTION_ORG_CATALOG（标准模块库）', () => {
  it('目录非空且 id 唯一', () => {
    expect(CONSTRUCTION_ORG_CATALOG.length).toBeGreaterThan(0);
    const ids = new Set(CONSTRUCTION_ORG_CATALOG.map(module => module.id));
    expect(ids.size).toBe(CONSTRUCTION_ORG_CATALOG.length);
  });

  it('每个模块都有非空标题与小节项', () => {
    expect(CONSTRUCTION_ORG_CATALOG.every(module => module.title.length > 0 && module.sectionItems.length > 0)).toBe(true);
  });
});

describe('inferConstructionOrgProjectTypes（项目类型推断）', () => {
  const input = (name: string, chapters: DocumentTemplateChapter[] = [], requirement = ''): Parameters<typeof inferConstructionOrgProjectTypes>[0] => ({
    template: template(name, '', chapters),
    chapters,
    requirement,
  });

  it('市政类型', () => {
    expect(inferConstructionOrgProjectTypes(input('市政道路工程施工组织设计'))).toEqual(['municipal']);
  });

  it('老旧小区改造类型', () => {
    expect(inferConstructionOrgProjectTypes(input('老旧小区改造施工组织设计'))).toEqual(['renovation']);
  });

  it('装饰装修类型', () => {
    expect(inferConstructionOrgProjectTypes(input('装饰装修工程施工组织设计'))).toEqual(['decoration']);
  });

  it('房建类型', () => {
    expect(inferConstructionOrgProjectTypes(input('房建工程施工组织设计'))).toEqual(['building']);
  });

  it('多类型合并去重', () => {
    expect(inferConstructionOrgProjectTypes(input('市政道路与老旧小区改造施工组织设计'))).toEqual(['municipal', 'renovation']);
  });

  it('无专业特征返回 general', () => {
    expect(inferConstructionOrgProjectTypes(input('普通文档'))).toEqual(['general']);
  });
});

describe('enrichConstructionOrgOutline（施组大纲富化）', () => {
  it('非施组文档原样返回并给出空报告', () => {
    const chapters = [chapter('c1', '服务内容')];
    const result = enrichConstructionOrgOutline({ template: template('普通服务方案', '', chapters), chapters });
    expect(result.chapters).toEqual(chapters);
    expect(result.report.attached).toHaveLength(0);
    expect(result.report.unattached).toHaveLength(0);
    expect(result.report.totals.attachedModules).toBe(0);
  });

  it('施组文档挂靠标准模块并补足主要施工内容小节', () => {
    const chapters = [chapter('c1', '工程概况'), chapter('c2', '主要分部分项工程施工方案')];
    const input = { template: template('市政道路工程施工组织设计', '', chapters), chapters };
    const { chapters: enriched, report } = enrichConstructionOrgOutline(input);
    expect(report.totals.attachedModules).toBeGreaterThan(0);
    expect(report.attached.length).toBeGreaterThan(0);
    // 与方案章节语义匹配的模块按 matched 挂靠
    expect(report.attached.some(item => item.kind === 'matched')).toBe(true);
    // 补足必备小节“项目主要施工内容”
    const overview = enriched.find(item => item.title === '工程概况');
    expect(overview?.sections).toContain('项目主要施工内容');
    // purpose 注入模块挂靠说明
    expect(enriched.some(item => item.purpose.includes('系统已按施工组织设计标准模块库挂靠'))).toBe(true);
  });

  it('无处安放的可选模块进入 unattached 报告（宁多勿丢）', () => {
    const chapters = [chapter('c1', '工程概况'), chapter('c2', '主要分部分项工程施工方案')];
    const input = { template: template('市政道路工程施工组织设计', '', chapters), chapters };
    const { report } = enrichConstructionOrgOutline(input);
    expect(report.unattached.some(item => item.reason === 'no-semantic-chapter')).toBe(true);
  });

  it('已有主要施工内容小节不重复补足', () => {
    const chapters = [chapter('c1', '工程概况', ['项目主要施工内容'])];
    const input = { template: template('施工组织设计', '', chapters), chapters };
    const { chapters: enriched } = enrichConstructionOrgOutline(input);
    const overview = enriched.find(item => item.title === '工程概况');
    expect(overview?.sections?.filter(section => section === '项目主要施工内容')).toHaveLength(1);
  });

  it('模块挂靠不修改模板自带小节（仅追加）', () => {
    const chapters = [chapter('c1', '工程概况', ['编制依据'])];
    const input = { template: template('施工组织设计', '', chapters), chapters };
    const { chapters: enriched } = enrichConstructionOrgOutline(input);
    const overview = enriched.find(item => item.title === '工程概况');
    expect(overview?.sections).toContain('编制依据');
  });
});

describe('类型辅助（模块适用性）', () => {
  it('ConstructionOrgProjectType 全集包含 general', () => {
    const all: ConstructionOrgProjectType[] = ['building', 'municipal', 'renovation', 'decoration', 'general'];
    expect(all).toHaveLength(5);
  });
});
