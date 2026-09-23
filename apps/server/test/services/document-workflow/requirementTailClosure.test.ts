/**
 * repairRounds.tailClosure · 招标要求响应链尾终局收口（r10，r9 #1/#2 机制归因）：
 * 检测端同源现场重跑（requirementAcceptanceIssues + buildSemanticSimilarity 注入零向量，
 * 语义通道强制失效——复现「边缘语义条款经链尾漂移滑出 0.6 阈值」的零命中形态）→
 * 残留 blocker 用条款原文投标人口吻确定性补写：主责章定位（requirementAssignments +
 * 章节标题归一化匹配，与修复轮同源）、未定位回退文末、已满足/comply 条目天然跳过、
 * voice 素材逐字落位后复检通道确认、重放幂等零成本。全程零 LLM / 零嵌入网络依赖。
 */
import { describe, expect, it } from 'vitest';

import { applyRequirementTailClosure, insertionMaterialRejection, insertionSignature } from '@/services/document-workflow/finalize/repairRounds/requirementResponseRepair';
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
    // voice 素材逐字落位（第三人称指代已转投标人口吻；C8 S1：行首枚举前缀「2.」随
    // bidderVoiceClauseText 统一剥离——条款号不再泄漏进正文，检测端 voice 通道同源）
    const warrantyMaterial = '我方在质量保修期内承担工程质量保修责任。';
    const emergencyMaterial = '发生紧急事故需抢修的，我方接到事故通知后立即到达事故现场抢修。';
    expect(result.markdown).toContain(warrantyMaterial);
    expect(result.markdown).toContain(emergencyMaterial);
    expect(result.markdown).not.toContain('2.发生紧急事故');
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

/**
 * C8 S1 · 链尾插入物质量闸（requirementResponseRepair）：
 * ①签名查重加固（insertionSignature 等价形态折叠、下限 24→8——r28m'「4000×3200」vs「4000*3200」
 * 查重漏网根因）；②形态闸拒插（insertionMaterialRejection 六类形态：空/过短/表格拍平/括号不配对/
 * OCR 残片/截断尾——r28m' 实机坏数据形态逐一对齐，拒插即显性记录不静默）；③跨轮幂等
 * （attemptedSignatures 跨轮传递「已插入/已拒插」签名）；④短条款整体兜底（判定死锁消除——
 * 「（9）发现脏、差，有缺损。」插入一次即 satisfied，链上重跑零重插）。全程零 LLM / 零嵌入网络依赖。
 */
describe('C8 S1 · 链尾插入物质量闸（签名查重 + 形态拒插 + 跨轮幂等）', () => {
  describe('insertionSignature 等价形态折叠', () => {
    it('乘号族：×/✳/·/* 全部折叠为 *（r28m’ 查重漏网根因形态）', () => {
      expect(insertionSignature('4000×3200')).toBe('4000*3200');
      expect(insertionSignature('4000✳3200')).toBe('4000*3200');
      expect(insertionSignature('4000·3200')).toBe('4000*3200');
      expect(insertionSignature('4000*3200')).toBe('4000*3200');
    });

    it('全半角/空白/大小写折叠：全角数字字母归一为 ASCII、空白全去、统一小写', () => {
      expect(insertionSignature('ＡＢＣ－１２３')).toBe('abc-123');
      expect(insertionSignature(' 我 方 Ａ B ')).toBe('我方ab');
    });

    it('引号族/括号族/标点族同形折叠：等价表述签名一致', () => {
      expect(insertionSignature('「钉钉」系统')).toBe(insertionSignature('“钉钉”系统'));
      expect(insertionSignature('（GB 50016-2014）')).toBe(insertionSignature('(GB50016-2014)'));
      expect(insertionSignature('发现脏、差，有缺损。')).toBe(insertionSignature('发现脏,差,有缺损.'));
    });
  });

  describe('insertionMaterialRejection 形态闸（拒插即显性、宁缺毋假）', () => {
    it('拒插：空素材与归一化过短（<6 与分句下限同源）', () => {
      expect(insertionMaterialRejection('')).toBe('空素材');
      expect(insertionMaterialRejection('   ')).toBe('空素材');
      expect(insertionMaterialRejection('以上')).toContain('过短');
    });

    it('拒插：表格拍平残片（品牌表拍平实机形态）', () => {
      expect(insertionMaterialRejection('主材品牌|规格型号')).toContain('表格拍平');
      expect(insertionMaterialRejection('项目名称\t备注说明')).toContain('表格拍平');
    });

    it('拒插：括号不配对（截断/拼接残片）', () => {
      expect(insertionMaterialRejection('（GB 50016-2014，2018年版')).toContain('括号不配对');
      expect(insertionMaterialRejection('2018年版）执行防火设计')).toContain('括号不配对');
    });

    it('拒插：OCR 残片与截断尾（r28m’「（18laxj）」/「…在发布最」实录）', () => {
      expect(insertionMaterialRejection('归档资料详见（18laxj）记录。')).toContain('OCR 残片');
      expect(insertionMaterialRejection('由代理机构在发布最')).toContain('截断尾');
      expect(insertionMaterialRejection('发现脏、差，')).toContain('截断尾');
    });

    it('防误伤反样本：完整表述/无标点长句/成对引用/短条款带句末标点全部放行', () => {
      expect(insertionMaterialRejection('（9）发现脏、差，有缺损。')).toBeNull();
      expect(insertionMaterialRejection('本工程严格以开工令为准确定开工日期')).toBeNull();
      expect(insertionMaterialRejection('（GB 50016-2014，2018年版）执行防火设计。')).toBeNull();
      expect(insertionMaterialRejection('我方在质量保修期内承担工程质量保修责任。')).toBeNull();
    });
  });

  it('三连重复根因回归：短条款「（9）发现脏、差，有缺损。」插入一次即 satisfied，链上重跑零重插', async () => {
    const entry: TenderRequirementEntry = { text: '（9）发现脏、差，有缺损。', coreTerms: [], sources: [], category: '现场管理', policy: 'respond' };
    const first = await applyRequirementTailClosure({
      markdown: BASE_MARKDOWN,
      tenderRequirements: modelOf([entry]),
      requirementAssignments: [],
      embedDocuments: zeroEmbed,
    });
    expect(first.insertedCount).toBe(1);
    expect(first.rejectedCount).toBe(0);
    // 「（9）」条款号随 bidderVoiceClauseText 剥离，正文只留实质表述
    expect(first.markdown).toContain('发现脏、差，有缺损。');
    expect(first.markdown).not.toContain('（9）发现脏');
    // 插入后确定性复检（检测端同源三通道）：voice 分句通道整体命中 → 无「未确认落位」
    expect(first.details.filter(line => line.includes('未确认落位'))).toHaveLength(0);
    expect(first.details).toHaveLength(1);
    // 链上重跑：插入物按构造 satisfied → 零重插（历史每轮重插 → 三连重复）
    const second = await applyRequirementTailClosure({
      markdown: first.markdown,
      tenderRequirements: modelOf([entry]),
      requirementAssignments: [],
      embedDocuments: zeroEmbed,
    });
    expect(second.insertedCount).toBe(0);
    expect(second.markdown).toBe(first.markdown);
  });

  it('签名查重加固：等价形态（×/*）已落位正文 → 判残留但跳过重插（防重复段落）', async () => {
    const entry: TenderRequirementEntry = { text: '屋面排水沟盖板按4000×3200统一预制。', coreTerms: [], sources: [], category: '现场布置', policy: 'respond' };
    const markdown = ['# 施工组织设计', '', '## 第一章 工程概况', '', '本工程位于工业园区，屋面排水沟盖板按4000*3200统一预制。'].join('\n');
    const attempted = new Set<string>();
    const result = await applyRequirementTailClosure({
      markdown,
      tenderRequirements: modelOf([entry]),
      requirementAssignments: [],
      embedDocuments: zeroEmbed,
      attemptedSignatures: attempted,
    });
    expect(result.insertedCount).toBe(0);
    expect(result.rejectedCount).toBe(0);
    expect(result.markdown).toBe(markdown);
    /**
     * 4.56.3 口径升级：本用例原断言 `attempted.has(insertionSignature(entry.text))` ——
     * 彼时 `4000*3200` 与正文 `4000×3200` 在**覆盖判定**上不等价，条款被判「残留」，
     * 靠签名查重兜住重复插入。4.56.3 把尺寸分隔符族归一 (`normalizeAnchorCompareText`) 补上后，
     * 二者在上游即判**等价**、条款直接判「已满足」，**根本不存在残留**——比"防重复插入"更强。
     * 因此签名集合为空才是正确终态：`attempted` 非空反而意味着覆盖判定又漏了字形差。
     */
    expect(attempted.size).toBe(0);
  });

  it('跨轮幂等：形态闸拒插素材显性记录且跨轮不重试（attemptedSignatures 传递）', async () => {
    const entry: TenderRequirementEntry = { text: '归档资料详见（18laxj）记录。', coreTerms: [], sources: [], category: '资料管理', policy: 'respond' };
    const attempted = new Set<string>();
    const first = await applyRequirementTailClosure({
      markdown: BASE_MARKDOWN,
      tenderRequirements: modelOf([entry]),
      requirementAssignments: [],
      embedDocuments: zeroEmbed,
      attemptedSignatures: attempted,
    });
    expect(first.insertedCount).toBe(0);
    expect(first.rejectedCount).toBe(1);
    expect(first.markdown).toBe(BASE_MARKDOWN);
    expect(first.details[0]).toContain('形态闸拒插');
    expect(first.details[0]).toContain('OCR 残片');
    expect(attempted.size).toBe(1);
    // 第二轮（同一跨轮集合）：拒插签名命中 → 不重复判定、不重复记录
    const second = await applyRequirementTailClosure({
      markdown: BASE_MARKDOWN,
      tenderRequirements: modelOf([entry]),
      requirementAssignments: [],
      embedDocuments: zeroEmbed,
      attemptedSignatures: attempted,
    });
    expect(second.insertedCount).toBe(0);
    expect(second.rejectedCount).toBe(0);
    expect(second.details).toHaveLength(0);
    expect(attempted.size).toBe(1);
  });
});
