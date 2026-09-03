/**
 * factMatching 单测：证据-事实匹配（归一化搜索词）/spec 事实目标汇总/字段满足判定。
 */
import { describe, expect, it } from 'vitest';
import { evidenceMatchesFact, evidenceSatisfiesSpecField, specFactTargets } from '@/services/document-workflow/factMatching';
import type { AutoDocumentSpecPackage } from '@/services/document-core/autoDocumentSpecTypes';
import type { DocumentEvidence, DocumentTemplate } from '@/services/document-workflow/types';

function makeTemplate(overrides: Partial<DocumentTemplate> = {}): DocumentTemplate {
  return {
    id: 't1',
    name: '模板',
    description: '',
    category: '施工组织设计',
    outputTitle: '施工组织设计',
    chapters: [
      { id: 'c1', title: '施工部署', purpose: '', queries: [], requiredFacts: ['计划工期', '质量目标'] },
      { id: 'c2', title: '资源配置', purpose: '', queries: [], requiredFacts: ['计划工期'] },
    ],
    ...overrides,
  };
}

describe('evidenceMatchesFact', () => {
  it('事实原文命中', () => {
    const evidence: DocumentEvidence = { chapterId: 'c1', filePath: '/f.pdf', score: 1, content: '计划工期为300日历天' };
    expect(evidenceMatchesFact(evidence, '计划工期')).toBe(true);
  });

  it('剥离修饰词后命中（归一化搜索词）', () => {
    const evidence: DocumentEvidence = { chapterId: 'c1', filePath: '/f.pdf', score: 1, content: '工期300天' };
    expect(evidenceMatchesFact(evidence, '计划工期')).toBe(true);
  });

  it('文件名与正文均参与匹配', () => {
    const evidence: DocumentEvidence = { chapterId: 'c1', filePath: '/质量目标.pdf', score: 1, content: '' };
    expect(evidenceMatchesFact(evidence, '质量目标')).toBe(true);
  });

  it('不命中返回 false', () => {
    const evidence: DocumentEvidence = { chapterId: 'c1', filePath: '/f.pdf', score: 1, content: '安全目标零事故' };
    expect(evidenceMatchesFact(evidence, '计划工期')).toBe(false);
  });
});

describe('specFactTargets', () => {
  it('章节事实与 spec 事实合并去重，required 取或', () => {
    const spec = {
      chapterRules: [],
      dynamicChapterRule: {},
      factFields: [
        { id: '计划工期', name: '计划工期', required: false, sourceRoleIds: ['r1'], extractionHint: '工期' },
        { id: '招标人', name: '招标人', required: true, sourceRoleIds: [], extractionHint: '' },
      ],
    } as unknown as AutoDocumentSpecPackage;
    const targets = specFactTargets(makeTemplate(), spec);
    expect(targets).toHaveLength(3);
    const schedule = targets.find(item => item.id === '计划工期');
    expect(schedule).toMatchObject({ name: '计划工期', required: true, extractionHint: '工期' });
    expect(schedule?.sourceRoleIds).toEqual(['r1']);
    const owner = targets.find(item => item.id === '招标人');
    expect(owner?.required).toBe(true);
  });

  it('无 spec 时仅章节事实', () => {
    const targets = specFactTargets(makeTemplate());
    expect(targets.map(item => item.id)).toEqual(['计划工期', '质量目标']);
    expect(targets.every(item => item.required)).toBe(true);
  });
});

describe('evidenceSatisfiesSpecField', () => {
  const evidence: DocumentEvidence = { chapterId: 'c1', filePath: '/f.pdf', score: 1, roleId: 'r1', content: '计划工期300天' };

  it('角色匹配且事实命中', () => {
    expect(evidenceSatisfiesSpecField(evidence, { name: '计划工期', sourceRoleIds: ['r1'] })).toBe(true);
  });

  it('角色不匹配 → false', () => {
    expect(evidenceSatisfiesSpecField(evidence, { name: '计划工期', sourceRoleIds: ['r2'] })).toBe(false);
  });

  it('无角色限定 + 事实命中', () => {
    expect(evidenceSatisfiesSpecField(evidence, { name: '计划工期' })).toBe(true);
  });

  it('事实不命中 → false', () => {
    expect(evidenceSatisfiesSpecField(evidence, { name: '质量目标' })).toBe(false);
  });
});
