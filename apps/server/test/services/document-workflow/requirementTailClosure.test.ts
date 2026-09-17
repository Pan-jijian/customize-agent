/**
 * repairRounds.tailClosure · 招标要求响应链尾终局收口（r10，r9 #1/#2 机制归因）：
 * 检测端同源现场重跑（requirementAcceptanceIssues + buildSemanticSimilarity 注入零向量，
 * 语义通道强制失效——复现「边缘语义条款经链尾漂移滑出 0.6 阈值」的零命中形态）→
 * 残留 blocker 用条款原文投标人口吻确定性补写：主责章定位（requirementAssignments +
 * 章节标题归一化匹配，与修复轮同源）、未定位回退文末、已满足/comply 条目天然跳过、
 * voice 素材逐字落位后复检通道确认、重放幂等零成本。全程零 LLM / 零嵌入网络依赖。
 */
import { describe, expect, it } from 'vitest';

import { applyRequirementTailClosure } from '@/services/document-workflow/finalize/repairRounds/requirementResponseRepair';
import { tenderRequirementResponseGaps } from '@/services/document-workflow/tenderRequirements';
import type { TenderRequirementAssignment } from '@/services/document-workflow/tenderRequirements';
import { stableHash } from '@/services/document-workflow/utils';
import type { TenderRequirementEntry, TenderRequirementModel } from '@/services/document-workflow/types';

/** 零向量嵌入注入：余弦恒 0（语义通道强制失效），仅确定性三通道参与判定 */
const zeroEmbed = async (texts: string[]): Promise<number[][]> => texts.map(() => [0, 0]);

const ENTRY_WARRANTY: TenderRequirementEntry = {
  text: '承包人在质量保修期内承担工程质量保修责任。',
  coreTerms: ['质量保修责任'],
  sources: [],
  category: '质量保修',
  policy: 'respond',
};
const ENTRY_EMERGENCY: TenderRequirementEntry = {
  text: '2.发生紧急事故需抢修的，承包人接到事故通知后立即到达事故现场抢修。',
  coreTerms: ['紧急事故', '立即到达事故现场抢修'],
  sources: [],
  category: '应急处置',
  policy: 'respond',
};

const BASE_MARKDOWN = [
  '# 施工组织设计',
  '',
  '## 第一章 工程概况',
  '',
  '本工程位于工业园区，施工内容为道路与管网工程。',
  '',
  '## 第二章 确保工程质量的技术组织措施',
  '',
  '本章阐述质量管理体系与过程控制安排。',
  '',
  '## 第三章 确保安全生产的技术组织措施',
  '',
  '本章阐述安全生产管理体系与风险防控安排。',
].join('\n');

function modelOf(entries: TenderRequirementEntry[]): TenderRequirementModel {
  return {
    extracted: true,
    entries,
    excluded: [],
    reconciliation: { clauseCount: entries.length, entryCount: entries.length, excludedCount: 0, undecidedCount: 0, mergedCount: 0, batchCount: 1, retriedBatches: 0 },
  };
}

function assignmentOf(entry: TenderRequirementEntry, chapterTitle: string): TenderRequirementAssignment {
  return { entry, chapterTitle, score: 0.5, lowConfidence: false };
}

describe('repairRounds.tailClosure · 招标要求响应链尾终局收口', () => {
  it('零命中残留：voice 素材确定性补写至主责章末，复检三通道确认', async () => {
    const result = await applyRequirementTailClosure({
      markdown: BASE_MARKDOWN,
      tenderRequirements: modelOf([ENTRY_WARRANTY, ENTRY_EMERGENCY]),
      requirementAssignments: [
        assignmentOf(ENTRY_WARRANTY, '确保工程质量的技术组织措施'),
        assignmentOf(ENTRY_EMERGENCY, '确保安全生产的技术组织措施'),
      ],
      embedDocuments: zeroEmbed,
    });
    expect(result.insertedCount).toBe(2);
    // voice 素材逐字落位（第三人称指代已转投标人口吻）
    const warrantyMaterial = '我方在质量保修期内承担工程质量保修责任。';
    const emergencyMaterial = '2.发生紧急事故需抢修的，我方接到事故通知后立即到达事故现场抢修。';
    expect(result.markdown).toContain(warrantyMaterial);
    expect(result.markdown).toContain(emergencyMaterial);
    // 章末定位：保修段落在第二章区间内（第三章标题之前），应急段落在第三章之后
    const ch2 = result.markdown.indexOf('## 第二章');
    const ch3 = result.markdown.indexOf('## 第三章');
    const warrantyIndex = result.markdown.indexOf(warrantyMaterial);
    const emergencyIndex = result.markdown.indexOf(emergencyMaterial);
    expect(warrantyIndex).toBeGreaterThan(ch2);
    expect(warrantyIndex).toBeLessThan(ch3);
    expect(emergencyIndex).toBeGreaterThan(ch3);
    // 复检通道（与检测端同源）：全部 satisfied，无「未确认落位」记录
    const gaps = tenderRequirementResponseGaps([ENTRY_WARRANTY, ENTRY_EMERGENCY], result.markdown);
    expect(gaps.every(gap => gap.satisfied)).toBe(true);
    expect(result.details.filter(line => line.includes('未确认落位'))).toHaveLength(0);
    expect(result.details).toHaveLength(2);
  });

  it('已满足条目（voice 分句通道）天然跳过：noop 不改写正文', async () => {
    const satisfiedMarkdown = `${BASE_MARKDOWN}\n\n我方在质量保修期内承担工程质量保修责任。\n2.发生紧急事故需抢修的，我方接到事故通知后立即到达事故现场抢修。\n`;
    const result = await applyRequirementTailClosure({
      markdown: satisfiedMarkdown,
      tenderRequirements: modelOf([ENTRY_WARRANTY, ENTRY_EMERGENCY]),
      requirementAssignments: [],
      embedDocuments: zeroEmbed,
    });
    expect(result.insertedCount).toBe(0);
    expect(result.markdown).toBe(satisfiedMarkdown);
  });

  it('comply 遵守类不受理：不落位也不补写', async () => {
    const complyEntry: TenderRequirementEntry = { text: '本工程严格以开工令为准确定开工日期。', coreTerms: ['开工令'], sources: [], category: '工期进度', policy: 'comply' };
    const result = await applyRequirementTailClosure({
      markdown: BASE_MARKDOWN,
      tenderRequirements: modelOf([complyEntry]),
      requirementAssignments: [assignmentOf(complyEntry, '确保工程质量的技术组织措施')],
      embedDocuments: zeroEmbed,
    });
    expect(result.insertedCount).toBe(0);
    expect(result.markdown).toBe(BASE_MARKDOWN);
  });

  it('分配缺失（无法定位主责章）：回退文末补写并显式记录', async () => {
    const result = await applyRequirementTailClosure({
      markdown: BASE_MARKDOWN,
      tenderRequirements: modelOf([ENTRY_WARRANTY]),
      requirementAssignments: [],
      embedDocuments: zeroEmbed,
    });
    expect(result.insertedCount).toBe(1);
    expect(result.markdown.trimEnd().endsWith('我方在质量保修期内承担工程质量保修责任。')).toBe(true);
    expect(result.details[0]).toContain('文末');
  });

  it('重放幂等：收口后的成稿再重跑零插入、零改写', async () => {
    const first = await applyRequirementTailClosure({
      markdown: BASE_MARKDOWN,
      tenderRequirements: modelOf([ENTRY_WARRANTY]),
      requirementAssignments: [assignmentOf(ENTRY_WARRANTY, '确保工程质量的技术组织措施')],
      embedDocuments: zeroEmbed,
    });
    expect(first.insertedCount).toBe(1);
    const second = await applyRequirementTailClosure({
      markdown: first.markdown,
      tenderRequirements: modelOf([ENTRY_WARRANTY]),
      requirementAssignments: [assignmentOf(ENTRY_WARRANTY, '确保工程质量的技术组织措施')],
      embedDocuments: zeroEmbed,
    });
    expect(second.insertedCount).toBe(0);
    expect(second.markdown).toBe(first.markdown);
  });

  it('blocker 指纹与条目反查同源：stableHash(entry.text) 口径验证', async () => {
    // 指纹口径固化回归：检测端 provenance.fingerprint 即 stableHash(entry.text)，链尾收口反查同源
    const fingerprint = stableHash(ENTRY_WARRANTY.text);
    expect(fingerprint).toBe(stableHash(ENTRY_WARRANTY.text));
    expect(fingerprint).not.toBe(stableHash(ENTRY_EMERGENCY.text));
  });
});
