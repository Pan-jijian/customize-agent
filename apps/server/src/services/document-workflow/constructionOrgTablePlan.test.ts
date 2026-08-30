/**
 * 4.12.5 组级表格计划过滤单测：主题块并发链路每组只注入本组小节承接的表计划，
 * 末组额外承接全章未分配表，避免每组看到全章表计划导致跨组重复输出。
 */
import { describe, expect, it } from 'vitest';
import { groupTablePlansForSections } from './constructionOrgTablePlan';
import type { DocumentTemplateChapter, ProjectGraphTablePlan } from './types';

function tablePlan(id: string, moduleTitle: string, shouldOutput = true): ProjectGraphTablePlan {
  return {
    id,
    title: `${moduleTitle}计划表`,
    chapterTitle: '资源配置与投入计划',
    moduleTitle,
    required: false,
    reason: '治理决策',
    fields: [{ name: '项目', required: false, sourceDomain: 'project', sourceHint: '资料', fallbackPolicy: 'projectFactOnly' }],
    sourceDomains: ['project'],
    outputDecision: { shouldOutput, outputType: 'markdown_table', decisionReason: '应写' },
  };
}

function chapter(plans: ProjectGraphTablePlan[]): DocumentTemplateChapter {
  return { id: 'ch1', title: '资源配置与投入计划', purpose: '', tablePlans: plans } as DocumentTemplateChapter;
}

describe('groupTablePlansForSections 组级表格计划过滤（4.12.5）', () => {
  it('非末组只注入本组小节承接的表计划', () => {
    const plans = [tablePlan('a', '劳动力'), tablePlan('b', '材料'), tablePlan('c', '机械')];
    const filtered = groupTablePlansForSections(chapter(plans), ['劳动力投入计划'], []);
    expect(filtered.map(plan => plan.id)).toEqual(['a']);
  });

  it('末组额外承接全章未分配表', () => {
    const plans = [tablePlan('a', '劳动力'), tablePlan('b', '材料'), tablePlan('c', '机械')];
    // 全章小节标题承接了劳动力与材料表，机械表未分配 → 末组兜底承接
    const filtered = groupTablePlansForSections(chapter(plans), ['质量保证措施'], ['劳动力投入计划', '材料进场计划']);
    expect(filtered.map(plan => plan.id)).toEqual(['c']);
  });

  it('末组同时承接本组归属表与未分配表且不重复', () => {
    const plans = [tablePlan('a', '劳动力'), tablePlan('b', '材料'), tablePlan('c', '机械')];
    // 全章小节承接了劳动力与材料表，机械表未分配 → 末组兜底承接
    const filtered = groupTablePlansForSections(chapter(plans), ['劳动力投入计划'], ['劳动力投入计划', '材料进场计划']);
    expect(filtered.map(plan => plan.id)).toEqual(['a', 'c']);
  });

  it('无表计划时返回空数组', () => {
    expect(groupTablePlansForSections(chapter([]), ['劳动力投入计划'], ['劳动力投入计划'])).toEqual([]);
  });
});
