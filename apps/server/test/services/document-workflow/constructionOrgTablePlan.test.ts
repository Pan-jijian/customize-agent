/**
 * 4.12.5 组级表格计划过滤单测：主题块并发链路每组只注入本组小节承接的表计划，
 * 末组额外承接全章未分配表，避免每组看到全章表计划导致跨组重复输出。
 */
import { describe, expect, it } from 'vitest';
import { groupTablePlansForSections } from '@/services/document-workflow/constructionOrgTablePlan';
import type { DocumentTemplateChapter, PlannedTablePlan } from '@/services/document-workflow/types';

function tablePlan(id: string, section: string): PlannedTablePlan {
  return {
    id,
    title: `${section}表`,
    chapterTitle: '资源配置与投入计划',
    section,
    required: false,
    reason: '融合规划产出',
    fields: [],
  };
}

function chapter(plans: PlannedTablePlan[]): DocumentTemplateChapter {
  return { id: 'ch1', title: '资源配置与投入计划', purpose: '', tablePlans: plans } as DocumentTemplateChapter;
}

describe('groupTablePlansForSections 组级表格计划过滤（4.12.5）', () => {
  it('非末组只注入本组小节承接的表计划', () => {
    const plans = [tablePlan('a', '劳动力投入计划'), tablePlan('b', '材料进场计划'), tablePlan('c', '机械配置计划')];
    const filtered = groupTablePlansForSections(chapter(plans), ['劳动力投入计划'], []);
    expect(filtered.map(plan => plan.id)).toEqual(['a']);
  });

  it('末组额外承接全章未分配表', () => {
    const plans = [tablePlan('a', '劳动力投入计划'), tablePlan('b', '材料进场计划'), tablePlan('c', '机械配置计划')];
    // 全章小节标题承接了劳动力与材料表，机械表未分配 → 末组兜底承接
    const filtered = groupTablePlansForSections(chapter(plans), ['质量保证措施'], ['劳动力投入计划', '材料进场计划']);
    expect(filtered.map(plan => plan.id)).toEqual(['c']);
  });

  it('末组同时承接本组归属表与未分配表且不重复', () => {
    const plans = [tablePlan('a', '劳动力投入计划'), tablePlan('b', '材料进场计划'), tablePlan('c', '机械配置计划')];
    // 全章小节承接了劳动力与材料表，机械表未分配 → 末组兜底承接
    const filtered = groupTablePlansForSections(chapter(plans), ['劳动力投入计划'], ['劳动力投入计划', '材料进场计划']);
    expect(filtered.map(plan => plan.id)).toEqual(['a', 'c']);
  });

  it('无表计划时返回空数组', () => {
    expect(groupTablePlansForSections(chapter([]), ['劳动力投入计划'], ['劳动力投入计划'])).toEqual([]);
  });
});
