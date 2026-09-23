/**
 * 招标要求层（全量条款穷举范式）测试：条款化（确定性切分）→ 逐条判定（序号对齐/重试/确定性复核）→
 * 重复合并 → 对账闭合 → 缓存 v4（对账门禁）→ 蓝图分配（唯一主责章）→ 章级验收 → 确定性清理器。
 * 判定链 LLM 经 callDocumentLlmJson mock；语义相似度一律参数注入（内核不依赖真实嵌入）。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/services/document-workflow/llmClient', async () => {
  const actual = (await vi.importActual('@/services/document-workflow/llmClient')) as typeof LlmClientModule;
  return { ...actual, callDocumentLlmJson: vi.fn() };
});
// 语义阈值随模块单源（tenderRequirements 判定用 SEMANTIC_COVERAGE_THRESHOLD 常量而非字面量 0.6），
// mock 工厂须一并给出该导出，与 semanticSimilarity.ts 真实值同值（其余测试同此写法）
vi.mock('@/services/document-workflow/semanticSimilarity', () => ({ buildSemanticSimilarity: vi.fn(), SEMANTIC_COVERAGE_THRESHOLD: 0.6 }));

import type * as LlmClientModule from '@/services/document-workflow/llmClient';
import { callDocumentLlmJson } from '@/services/document-workflow/llmClient';
import {
  assignStructureRequirementsToChapters,
  assignTenderRequirementsToChapters,
  collectRequirementAnchors,
  detectStructureRequirements,
  emptyTenderRequirements,
  extractTenderRequirements,
  fixTenderMetaLanguage,
  hasTenderRequirements,
  isContractAttachmentSectionClause,
  isDocumentReferenceOnlyClause,
  isRequirementPoolNoiseClause,
  judgeTenderClauses,
  readCachedTenderRequirements,
  renderChapterRequirementSlice,
  renderChapterStructureSlice,
  requirementAcceptanceIssues,
  routeTenderRequirementsToChapters,
  saveRequirementAssignmentsAsset,
  saveStructureAssignmentsAsset,
  splitTenderClauses,
  stripDuplicateResponseLines,
  tenderRequirementCheckItems,
  tenderRequirementResponseGaps,
  tenderRequirementSemanticQuery,
  tenderRequirementsCacheKey,
  tenderRequirementsJudgeFingerprint,
  tenderRequirementsSummary,
  tenderRequirementsWritingRules,
  writeCachedTenderRequirements,
  fixFormalSourceResidue,
} from '@/services/document-workflow/tenderRequirements';
import { isMaterialResidueLine } from '@/services/document-workflow/materialResidue';
import type { TenderClauseUnit, TenderRequirementAssignment } from '@/services/document-workflow/tenderRequirements';
import { stableHash } from '@/services/document-workflow/utils';
import type { DocumentEvidence, TenderRequirementEntry, TenderRequirementModel, TenderRequirementPolicy } from '@/services/document-workflow/types';

const evidence: DocumentEvidence[] = [
  { chapterId: 'tender-requirements', filePath: '招标文件.pdf', sectionTitle: '第三章评标办法', score: 1, content: '3.1 创优目标：确保获得“黄山杯”。\n3.2 绿色建筑等级要求：达到国标二星级。' },
];

const entry = (text: string, coreTerms: string[], policy: TenderRequirementPolicy = 'respond', category = '其他要求'): TenderRequirementEntry => ({
  text,
  coreTerms,
  sources: [{ file: '招标文件.pdf' }],
  category,
  policy,
});

/** 对账闭合模型（clauseCount = entries + mergedCount） */
const closedModel = (entries: TenderRequirementEntry[], mergedCount = 0): TenderRequirementModel => ({
  entries,
  excluded: [],
  reconciliation: { clauseCount: entries.length + mergedCount, entryCount: entries.length, excludedCount: 0, undecidedCount: 0, mergedCount, batchCount: 1, retriedBatches: 0 },
  extracted: true,
});

const assignment = (item: TenderRequirementEntry, chapterTitle: string, lowConfidence = false): TenderRequirementAssignment => ({
  entry: item,
  chapterTitle,
  score: lowConfidence ? 0.2 : 0.8,
  lowConfidence,
});

// ═══════════════════════════ L1 条款化（确定性结构切分） ═══════════════════════════

describe('splitTenderClauses 条款化（确定性结构切分，不预筛不剔除）', () => {
  it('编号行开新单元：同编号后续行归入同一单元，单元带文件/章节/条款号来源定位', () => {
    const clauses = splitTenderClauses([{
      chapterId: 'tender-requirements',
      filePath: '招标文件.pdf',
      sectionTitle: '第三章评标办法',
      score: 1,
      content: '3.1 创优目标：确保获得“黄山杯”。\n具体保证措施由我方组织实施。\n3.2 绿色建筑等级要求：达到国标二星级。',
    }]);
    expect(clauses.length).toBe(2);
    expect(clauses[0]).toMatchObject({ file: '招标文件.pdf', section: '第三章评标办法', clauseNo: '3.1' });
    expect(clauses[0].text).toBe('3.1 创优目标：确保获得“黄山杯”。\n具体保证措施由我方组织实施。');
    expect(clauses[1].clauseNo).toBe('3.2');
    expect(clauses[1].text).toBe('3.2 绿色建筑等级要求：达到国标二星级。');
  });

  it('短「名：值」行独立成单元（表格行不做整表合并）', () => {
    const clauses = splitTenderClauses([{
      chapterId: 'tender-requirements',
      filePath: '招标文件.pdf',
      score: 1,
      content: '绿色建筑等级要求：达到国标二星级。\n智慧工地管理要求：基本级。',
    }]);
    expect(clauses.length).toBe(2);
    expect(clauses[0].clauseNo).toBeUndefined();
    expect(clauses[0].text).toBe('绿色建筑等级要求：达到国标二星级。');
    expect(clauses[1].text).toBe('智慧工地管理要求：基本级。');
  });

  it('空行=段落边界：前后段落各自独立成单元', () => {
    const clauses = splitTenderClauses([{
      chapterId: 'tender-requirements',
      filePath: '招标文件.pdf',
      score: 1,
      content: '确保获得黄山杯。\n\n严格执行质量管理制度。',
    }]);
    expect(clauses.length).toBe(2);
    expect(clauses[0].text).toBe('确保获得黄山杯。');
    expect(clauses[1].text).toBe('严格执行质量管理制度。');
  });

  it('markdown 标题行更新 section 上下文（# 是结构标记，不作为条款单元）', () => {
    const clauses = splitTenderClauses([{
      chapterId: 'tender-requirements',
      filePath: '招标文件.pdf',
      score: 1,
      content: '## 第三章 评标办法\n3.1 创优目标：确保获得“黄山杯”。',
    }]);
    expect(clauses.length).toBe(1);
    expect(clauses[0].section).toBe('第三章 评标办法');
    expect(clauses[0].clauseNo).toBe('3.1');
  });

  it('内联 PDF 标题噪声清洗（平方###米 夹断不残留在单元文本）', () => {
    const clauses = splitTenderClauses([{
      chapterId: 'tender-requirements',
      filePath: '招标文件.pdf',
      score: 1,
      content: '活动板房面积约200平方###米，用于现场办公。',
    }]);
    expect(clauses.length).toBe(1);
    expect(clauses[0].text).toBe('活动板房面积约200平方米，用于现场办公。');
    expect(clauses[0].text).not.toContain('#');
  });

  it('超长单元按句二次切分（≤2000 字符，不丢任何句子；带条款号时子单元编号加后缀）', () => {
    const longText = '本工程严格执行质量管理制度并进行全过程检查验收。'.repeat(120);
    const clauses = splitTenderClauses([{
      chapterId: 'tender-requirements',
      filePath: '招标文件.pdf',
      score: 1,
      content: `3.1 创优目标。\n${longText}`,
    }]);
    expect(clauses.length).toBe(2);
    expect(clauses[0].clauseNo).toBe('3.1-1');
    expect(clauses[1].clauseNo).toBe('3.1-2');
    for (const clause of clauses) expect(clause.text.length).toBeLessThanOrEqual(2000);
    expect(clauses.map(clause => clause.text).join('')).toBe(`3.1 创优目标。\n${longText}`);
  });

  it('答疑配对：「问题/回复」相邻行归并为单一单元（上下文完整，判定更准）', () => {
    const clauses = splitTenderClauses([{
      chapterId: 'tender-requirements',
      filePath: '答疑文件.pdf',
      sectionTitle: '答疑',
      score: 1,
      content: '问题1：施工现场扬尘如何控制？\n回复：按六个百分百要求落实。\n问题2：是否允许分包？\n回复：不允许分包。',
    }]);
    expect(clauses.length).toBe(2);
    expect(clauses[0].text).toBe('问题1：施工现场扬尘如何控制？\n回复：按六个百分百要求落实。');
    expect(clauses[1].text).toBe('问题2：是否允许分包？\n回复：不允许分包。');
  });

  it('悬空回复（无上文问题）：独立成单元交判定层复核（不预筛不剔除）', () => {
    const clauses = splitTenderClauses([{
      chapterId: 'tender-requirements',
      filePath: '答疑文件.pdf',
      score: 1,
      content: '回复：按招标文件执行。',
    }]);
    expect(clauses.length).toBe(1);
    expect(clauses[0].text).toBe('回复：按招标文件执行。');
  });

  it('微碎片归并：无独立语义残片与相邻单元合并；资料末尾孤立残片兜底独立产出（不丢数据）', () => {
    const merged = splitTenderClauses([{
      chapterId: 'tender-requirements',
      filePath: '招标文件.pdf',
      score: 1,
      content: '续表\n3.1 创优目标：确保获得黄山杯。',
    }]);
    expect(merged.length).toBe(1);
    expect(merged[0].text).toBe('续表\n3.1 创优目标：确保获得黄山杯。');
    expect(merged[0].clauseNo).toBe('3.1');
    const trailing = splitTenderClauses([{
      chapterId: 'tender-requirements',
      filePath: '招标文件.pdf',
      score: 1,
      content: '3.1 创优目标：确保获得黄山杯。\n\n续表',
    }]);
    expect(trailing.length).toBe(2);
    expect(trailing[1].text).toBe('续表');
  });

  it('假标题容错：折行半句误标 ### 转正文，与跨空行续行拼回完整句（门禁链根因形态）', () => {
    const clauses = splitTenderClauses([{
      chapterId: 'tender-requirements',
      filePath: '招标文件.pdf',
      score: 1,
      content: '### 使用时限的电子证书无效，需重新下载电子证书并再次确\n\n认使用时限。',
    }]);
    expect(clauses.length).toBe(1);
    expect(clauses[0].text).toBe('使用时限的电子证书无效，需重新下载电子证书并再次确\n认使用时限。');
  });

  it('假标题容错：白名单结构标题（第X章/数字编号）仍进 section 上下文', () => {
    const clauses = splitTenderClauses([{
      chapterId: 'tender-requirements',
      filePath: '招标文件.pdf',
      score: 1,
      content: '## 第一章 招标公告\n### 1.5合同文件的优先顺序\n3.1 创优目标：确保获得黄山杯。',
    }]);
    expect(clauses.length).toBe(1);
    expect(clauses[0].section).toBe('1.5合同文件的优先顺序');
    expect(clauses[0].clauseNo).toBe('3.1');
  });

  it('假标题容错：PDF 页标记保留 section，孤立页码残片跳过不入单元', () => {
    const clauses = splitTenderClauses([{
      chapterId: 'tender-requirements',
      filePath: '招标文件.pdf',
      score: 1,
      content: '## PDF 第 2 页\n3.1 创优目标：确保获得黄山杯。\n\n27\n\n3.2 绿色建筑等级要求：达到国标二星级。',
    }]);
    expect(clauses.length).toBe(2);
    expect(clauses[0].section).toBe('PDF 第 2 页');
    expect(clauses[0].text).toBe('3.1 创优目标：确保获得黄山杯。');
    expect(clauses[1].text).toBe('3.2 绿色建筑等级要求：达到国标二星级。');
  });

  it('KV 折行续段：上句未闭合时「名：值」行进续行拼接而非新开单元', () => {
    const clauses = splitTenderClauses([{
      chapterId: 'tender-requirements',
      filePath: '招标文件.pdf',
      score: 1,
      content: '2.6 建设规模：本项目总建筑面积约5000平方米，包含配套基础\n设施工程：道路、绿化及管网工程。',
    }]);
    expect(clauses.length).toBe(1);
    expect(clauses[0].clauseNo).toBe('2.6');
    expect(clauses[0].text).toBe('2.6 建设规模：本项目总建筑面积约5000平方米，包含配套基础\n设施工程：道路、绿化及管网工程。');
  });
});

// ═══════════════════════════ L1 逐条判定（每条必出结果） ═══════════════════════════

describe('judgeTenderClauses 逐条判定（序号严格对齐 + 确定性复核）', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('序号对齐：isRequirement/inScope 三态归宿，排除带 reason，条目带来源与类别', async () => {
    const clauses: TenderClauseUnit[] = [
      { file: '招标文件.pdf', section: '第三章', clauseNo: '3.1', text: '创优目标：确保获得黄山杯。' },
      { file: '招标文件.pdf', section: '第三章', clauseNo: '3.2', text: '开标时间：2026年5月15日9时。' },
      { file: '招标文件.pdf', section: '第三章', clauseNo: '3.3', text: '绿色建筑等级要求：达到国标二星级。' },
    ];
    vi.mocked(callDocumentLlmJson).mockResolvedValueOnce({
      results: [
        { index: 0, isRequirement: true, inScope: true, policy: 'respond', coreTerms: ['黄山杯'], category: '质量创优' },
        { index: 1, isRequirement: true, inScope: false, reason: 'out_of_scope' },
        { index: 2, isRequirement: true, inScope: true, policy: 'respond', coreTerms: ['二星级'], category: '绿色施工' },
      ],
    });
    const result = await judgeTenderClauses(clauses, {});
    expect(result.batchCount).toBe(1);
    expect(result.retriedBatches).toBe(0);
    expect(result.undecided).toEqual([]);
    expect(result.entries.length).toBe(2);
    expect(result.excluded.length).toBe(1);
    expect(result.excluded[0].reason).toBe('out_of_scope');
    expect(result.excluded[0].source).toBe('招标文件.pdf｜第三章·条款3.2');
    expect(result.entries[0]).toMatchObject({
      category: '质量创优',
      policy: 'respond',
      sources: [{ file: '招标文件.pdf', location: '第三章·条款3.1' }],
    });
  });

  it('缺号重试一次：第二次补齐后条目正常产出（retriedBatches 记账）', async () => {
    const mocked = vi.mocked(callDocumentLlmJson);
    mocked.mockResolvedValueOnce({ results: [] });
    mocked.mockResolvedValueOnce({ results: [{ index: 0, isRequirement: true, inScope: true, policy: 'respond', coreTerms: ['黄山杯'], category: '质量创优' }] });
    const result = await judgeTenderClauses([{ file: '招标文件.pdf', text: '创优目标：确保获得黄山杯。' }], {});
    expect(result.entries.length).toBe(1);
    expect(result.undecided.length).toBe(0);
    expect(result.retriedBatches).toBe(1);
    expect(mocked).toHaveBeenCalledTimes(2);
  });

  it('两轮仍缺号：未判定条款显式记录（不静默丢弃），其余条款正常归宿', async () => {
    vi.mocked(callDocumentLlmJson).mockResolvedValue({
      results: [{ index: 0, isRequirement: true, inScope: true, policy: 'respond', coreTerms: ['黄山杯'], category: '质量创优' }],
    });
    const result = await judgeTenderClauses([
      { file: '招标文件.pdf', text: '创优目标：确保获得黄山杯。' },
      { file: '招标文件.pdf', text: '绿色建筑等级要求：达到国标二星级。' },
    ], {});
    expect(result.entries.length).toBe(1);
    expect(result.undecided.length).toBe(1);
    expect(result.undecided[0].text).toBe('绿色建筑等级要求：达到国标二星级。');
    expect(result.retriedBatches).toBe(1);
  });

  it('LLM 零响应（undefined）：全部记入未判定，不抛错', async () => {
    vi.mocked(callDocumentLlmJson).mockResolvedValue(undefined);
    const result = await judgeTenderClauses([
      { file: '招标文件.pdf', text: '创优目标：确保获得黄山杯。' },
      { file: '招标文件.pdf', text: '绿色建筑等级要求：达到国标二星级。' },
    ], {});
    expect(result.entries).toEqual([]);
    expect(result.excluded).toEqual([]);
    expect(result.undecided.length).toBe(2);
  });

  it('确定性复核：勾选无条款（☑无）LLM 判为要求仍强制剔除 no_value', async () => {
    vi.mocked(callDocumentLlmJson).mockResolvedValue({
      results: [{ index: 0, isRequirement: true, inScope: true, policy: 'respond', coreTerms: [], category: '质量创优' }],
    });
    const result = await judgeTenderClauses([{ file: '招标文件.pdf', section: '前附表', clauseNo: '10.9', text: '10.9 创优目标 ☑无' }], {});
    expect(result.entries).toEqual([]);
    expect(result.excluded.length).toBe(1);
    expect(result.excluded[0].reason).toBe('no_value');
  });

  it('确定性复核：评标否决规则/资格条件条款 LLM 判为要求仍强制剔除 out_of_scope', async () => {
    vi.mocked(callDocumentLlmJson).mockResolvedValue({
      results: [
        { index: 0, isRequirement: true, inScope: true, policy: 'respond', coreTerms: [], category: '其他要求' },
        { index: 1, isRequirement: true, inScope: true, policy: 'respond', coreTerms: [], category: '人员管理' },
      ],
    });
    const result = await judgeTenderClauses([
      { file: '招标文件.pdf', text: '经评标委员会认定，技术文件明显文不对题的，一律否决其投标。' },
      { file: '招标文件.pdf', text: '投标人须具有市政公用工程施工总承包二级及以上资质。' },
    ], {});
    expect(result.entries).toEqual([]);
    expect(result.excluded.length).toBe(2);
    expect(result.excluded.every(item => item.reason === 'out_of_scope')).toBe(true);
  });

  it('确定性复核：商务与造价条款 LLM 判为要求仍强制剔除 commercial_scope（技术标正文零商务句）', async () => {
    vi.mocked(callDocumentLlmJson).mockResolvedValue({
      results: [
        { index: 0, isRequirement: true, inScope: true, policy: 'respond', coreTerms: ['履约保证金'], category: '商务支付' },
        { index: 1, isRequirement: true, inScope: true, policy: 'respond', coreTerms: ['预付款'], category: '商务支付' },
        { index: 2, isRequirement: true, inScope: true, policy: 'respond', coreTerms: ['创优'], category: '质量创优' },
      ],
    });
    const result = await judgeTenderClauses([
      { file: '招标文件.pdf', text: '履约保证金金额：中标金额的2%。' },
      { file: '招标文件.pdf', text: '预付款为合同价款的10%，开工前七日内支付。' },
      { file: '招标文件.pdf', text: '创优目标：确保获得黄山杯。' },
    ], {});
    expect(result.entries.length).toBe(1);
    expect(result.entries[0].category).toBe('质量创优');
    expect(result.excluded.length).toBe(2);
    expect(result.excluded.every(item => item.reason === 'commercial_scope')).toBe(true);
  });

  it('comply 且命中全文档约束正则（开工令）→ global 标记；coreTerms/空类别清洗', async () => {
    vi.mocked(callDocumentLlmJson).mockResolvedValue({
      results: [
        { index: 0, isRequirement: true, inScope: true, policy: 'comply', coreTerms: ['开工令'], category: '工期进度' },
        { index: 1, isRequirement: true, inScope: true, coreTerms: ['质', '质量管理制度', 'a'.repeat(30), '制度', '多余词'], category: '' },
      ],
    });
    const result = await judgeTenderClauses([
      { file: '招标文件.pdf', text: '计划工期：开工之日（以开工令时间为准）起，540个日历天。' },
      { file: '招标文件.pdf', text: '严格执行质量管理制度。' },
    ], {});
    expect(result.entries[0].policy).toBe('comply');
    expect(result.entries[0].global).toBe(true);
    expect(result.entries[1].policy).toBe('respond');
    expect(result.entries[1].coreTerms).toEqual(['质量管理制度', '制度', '多余词']);
    expect(result.entries[1].category).toBe('其他要求');
  });

  it('确定性复核：纯引导词碎片（「回复：」无内容残行）LLM 判为要求仍强制剔除 non_requirement', async () => {
    vi.mocked(callDocumentLlmJson).mockResolvedValue({
      results: [
        { index: 0, isRequirement: true, inScope: true, policy: 'respond', coreTerms: [], category: '其他要求' },
        { index: 1, isRequirement: false, inScope: false, reason: 'non_requirement' },
      ],
    });
    const result = await judgeTenderClauses([
      { file: '答疑文件.pdf', text: '回复：' },
      { file: '答疑文件.pdf', text: '回复：按招标文件执行。' },
    ], {});
    expect(result.entries).toEqual([]);
    expect(result.excluded.length).toBe(2);
    expect(result.excluded.every(item => item.reason === 'non_requirement')).toBe(true);
  });

  it('确定性复核：折行残片（≤10 字、无数字、无约束词）LLM 判为要求仍强制剔除 non_requirement；含数字/约束词短句保留', async () => {
    vi.mocked(callDocumentLlmJson).mockResolvedValue({
      results: [
        { index: 0, isRequirement: true, inScope: true, policy: 'respond', coreTerms: [], category: '其他要求' },
        { index: 1, isRequirement: true, inScope: true, policy: 'respond', coreTerms: ['黄山杯'], category: '质量创优' },
        { index: 2, isRequirement: true, inScope: true, policy: 'respond', coreTerms: ['540天'], category: '工期进度' },
      ],
    });
    const result = await judgeTenderClauses([
      { file: '招标文件.pdf', text: '认使用时限。' },
      { file: '招标文件.pdf', text: '确保获得黄山杯。' },
      { file: '招标文件.pdf', text: '工期目标：540天。' },
    ], {});
    expect(result.entries.length).toBe(2);
    expect(result.entries.map(item => item.text)).toEqual(['确保获得黄山杯。', '工期目标：540天。']);
    expect(result.excluded.length).toBe(1);
    expect(result.excluded[0].reason).toBe('non_requirement');
    expect(result.excluded[0].text).toBe('认使用时限。');
  });

  // ── A-T1 结构/呈现要求（第三态通道） ──

  it('A-T1：格式类条款被判排除后仍产出结构信号（信号不随排除丢失）', async () => {
    vi.mocked(callDocumentLlmJson).mockResolvedValue({
      results: [{ index: 0, isRequirement: false, inScope: false, reason: 'out_of_scope' }],
    });
    const result = await judgeTenderClauses([
      { file: '招标文件.pdf', text: '拟为承包本标段工程设立的组织机构以框图方式表示。' },
    ], {});
    expect(result.excluded.length).toBe(1);
    expect(result.structureRequirements).toEqual([
      { element: '项目管理机构', form: 'org_chart', sourceText: '拟为承包本标段工程设立的组织机构以框图方式表示。' },
    ]);
  });

  it('A-T1：词表命中各形态产出（网络图/横道图/平面布置图/组成表/结合图表）；无信号条款不误报', async () => {
    const clauses: TenderClauseUnit[] = [
      { file: '招标文件.pdf', text: '施工进度计划采用网络图表示。' },
      { file: '招标文件.pdf', text: '施工进度计划附横道图。' },
      { file: '招标文件.pdf', text: '提供施工总平面布置图。' },
      { file: '招标文件.pdf', text: '提供项目管理机构人员组成表。' },
      { file: '招标文件.pdf', text: '施工组织设计采用文字并结合图表形式编制。' },
      { file: '招标文件.pdf', text: '质量目标：确保合格。' },
    ];
    vi.mocked(callDocumentLlmJson).mockResolvedValue({
      results: clauses.map((_, index) => ({ index, isRequirement: true, inScope: true, policy: 'respond', coreTerms: [], category: '其他要求' })),
    });
    const result = await judgeTenderClauses(clauses, {});
    expect(result.structureRequirements.map(item => `${item.form}|${item.element}`)).toEqual([
      'diagram|施工进度计划网络图',
      'diagram|施工进度计划横道图',
      'diagram|施工总平面布置图',
      'table|项目管理机构人员组成表',
      'chart_text|施工组织设计',
    ]);
  });

  it('A-T1：LLM 语义 structures 字段与词表合并去重（form 归一化；无效值忽略）', async () => {
    vi.mocked(callDocumentLlmJson).mockResolvedValue({
      results: [{
        index: 0,
        isRequirement: true,
        inScope: true,
        policy: 'respond',
        coreTerms: [],
        category: '其他要求',
        structures: [
          { element: '项目管理机构', form: 'org_chart' },
          { element: '重要工序影像资料', form: 'diagram' },
          { element: '某要素', form: 'unknown_form' },
          { element: '', form: 'table' },
        ],
      }],
    });
    const result = await judgeTenderClauses([
      { file: '招标文件.pdf', text: '组织机构以框图方式表示。' },
    ], {});
    expect(result.structureRequirements.map(item => `${item.form}|${item.element}`)).toEqual([
      'org_chart|项目管理机构',
      'diagram|重要工序影像资料',
    ]);
  });

  it('A-T2：同输入连跑 3 次，结构信号完全一致（确定性词表与 LLM 波动无关）', async () => {
    const clauses: TenderClauseUnit[] = [
      { file: '招标文件.pdf', text: '施工进度计划采用网络图表示，并附横道图。' },
      { file: '招标文件.pdf', text: '拟为承包本标段工程设立的组织机构以框图方式表示。' },
    ];
    const runOnce = async () => {
      vi.mocked(callDocumentLlmJson).mockResolvedValue({
        results: clauses.map((_, index) => ({ index, isRequirement: true, inScope: true, policy: 'respond', coreTerms: [], category: '其他要求' })),
      });
      const result = await judgeTenderClauses(clauses, {});
      return JSON.stringify(result.structureRequirements);
    };
    const first = await runOnce();
    expect(await runOnce()).toBe(first);
    expect(await runOnce()).toBe(first);
    expect(JSON.parse(first).length).toBe(3);
  });

  it('A-T3：表格声明套话（“我公司对该表…均属真实”类）不进池（non_requirement）', async () => {
    vi.mocked(callDocumentLlmJson).mockResolvedValue({
      results: [{ index: 0, isRequirement: true, inScope: true, policy: 'respond', coreTerms: [], category: '其他要求' }],
    });
    const result = await judgeTenderClauses([
      { file: '招标文件.pdf', text: '我公司对该表提供的内容及相关资料均属真实、可靠。' },
    ], {});
    expect(result.entries).toEqual([]);
    expect(result.excluded.length).toBe(1);
    expect(result.excluded[0].reason).toBe('non_requirement');
  });

  it('A-T3：商务域技术工艺语义救回（工艺试验/临时占地类条款不以商业域剔除）', async () => {
    vi.mocked(callDocumentLlmJson).mockResolvedValue({
      results: [
        { index: 0, isRequirement: true, inScope: true, policy: 'respond', coreTerms: [], category: '其他要求' },
        { index: 1, isRequirement: true, inScope: true, policy: 'respond', coreTerms: [], category: '其他要求' },
        { index: 2, isRequirement: true, inScope: true, policy: 'respond', coreTerms: [], category: '商务支付' },
      ],
    });
    const result = await judgeTenderClauses([
      { file: '招标文件.pdf', text: '现场工艺试验及检测费用由我方承担。' },
      { file: '招标文件.pdf', text: '红线外临时占地的复垦与植被恢复费用由我方承担。' },
      { file: '招标文件.pdf', text: '履约保证金金额：中标金额的2%。' },
    ], {});
    expect(result.entries.map(item => item.text)).toEqual([
      '现场工艺试验及检测费用由我方承担。',
      '红线外临时占地的复垦与植被恢复费用由我方承担。',
    ]);
    expect(result.excluded.length).toBe(1);
    expect(result.excluded[0].reason).toBe('commercial_scope');
  });
});

// ═══════════════════════════ L1 提取编排（条款化→判定→合并→对账） ═══════════════════════════

describe('extractTenderRequirements 编排（对账闭合）', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('空证据直接返回空模型（零 LLM 调用）', async () => {
    const model = await extractTenderRequirements([], {});
    expect(model).toEqual(emptyTenderRequirements(false));
    expect(vi.mocked(callDocumentLlmJson)).not.toHaveBeenCalled();
  });

  it('全链对账闭合：切分 = 要求 + 排除 + 未判定 0，onPhase 两阶段上报，sourceHash 生成', async () => {
    vi.mocked(callDocumentLlmJson).mockResolvedValueOnce({
      results: [
        { index: 0, isRequirement: true, inScope: true, policy: 'respond', coreTerms: ['黄山杯'], category: '质量创优' },
        { index: 1, isRequirement: true, inScope: true, policy: 'respond', coreTerms: ['二星级'], category: '绿色施工' },
      ],
    });
    const phases: string[] = [];
    const model = await extractTenderRequirements(evidence, { onPhase: message => phases.push(message) });
    expect(model.extracted).toBe(true);
    expect(model.reconciliation).toEqual({ clauseCount: 2, entryCount: 2, excludedCount: 0, undecidedCount: 0, mergedCount: 0, batchCount: 1, retriedBatches: 0, structureCount: 0 });
    expect(model.sourceHash).toBeTruthy();
    expect(phases.length).toBe(2);
    expect(phases[0]).toContain('条款化完成：2 条单元');
    expect(phases[1]).toContain('未判定 0');
  });

  it('重复文本合并：跨文件同一要求合并为一条并聚合 sources（对账等式含合并项）', async () => {
    const duplicated: DocumentEvidence[] = [
      { chapterId: 'tender-requirements', filePath: '招标文件.pdf', sectionTitle: '前附表', score: 1, content: '3.1 创优目标：确保获得黄山杯。' },
      { chapterId: 'tender-requirements', filePath: '补疑文件.pdf', sectionTitle: '答疑', score: 1, content: '3.1 创优目标：确保获得黄山杯。' },
    ];
    vi.mocked(callDocumentLlmJson).mockResolvedValueOnce({
      results: [
        { index: 0, isRequirement: true, inScope: true, policy: 'respond', coreTerms: ['黄山杯'], category: '质量创优' },
        { index: 1, isRequirement: true, inScope: true, policy: 'respond', coreTerms: ['300万元', '黄山杯'], category: '质量创优' },
      ],
    });
    const model = await extractTenderRequirements(duplicated, {});
    expect(model.reconciliation).toEqual({ clauseCount: 2, entryCount: 1, excludedCount: 0, undecidedCount: 0, mergedCount: 1, batchCount: 1, retriedBatches: 0, structureCount: 0 });
    expect(model.entries.length).toBe(1);
    expect(model.entries[0].sources.map(source => source.file)).toEqual(['招标文件.pdf', '补疑文件.pdf']);
    expect(model.entries[0].coreTerms).toEqual(['黄山杯', '300万元']);
  });

  it('无值条款全链剔除：LLM 判为要求也不进 entries（对账计入排除）', async () => {
    vi.mocked(callDocumentLlmJson).mockResolvedValueOnce({
      results: [
        { index: 0, isRequirement: true, inScope: true, policy: 'respond', coreTerms: [], category: '质量创优' },
        { index: 1, isRequirement: true, inScope: true, policy: 'respond', coreTerms: ['质量目标'], category: '质量创优' },
      ],
    });
    const model = await extractTenderRequirements([{
      chapterId: 'tender-requirements',
      filePath: '招标文件.pdf',
      score: 1,
      content: '10.9 创优目标 ☑无\n3.1 质量目标：确保合格。',
    }], {});
    expect(model.entries.length).toBe(1);
    expect(model.entries[0].text).toContain('质量目标');
    expect(model.excluded.length).toBe(1);
    expect(model.excluded[0].reason).toBe('no_value');
    expect(model.reconciliation.undecidedCount).toBe(0);
  });

  it('LLM 不可用：0 要求 + 全部未判定 → extracted=false、对账未闭合，不抛错', async () => {
    vi.mocked(callDocumentLlmJson).mockResolvedValue(undefined);
    const model = await extractTenderRequirements(evidence, {});
    expect(model.extracted).toBe(false);
    expect(model.entries).toEqual([]);
    expect(model.excluded).toEqual([]);
    expect(model.reconciliation).toEqual({ clauseCount: 2, entryCount: 0, excludedCount: 0, undecidedCount: 2, mergedCount: 0, batchCount: 1, retriedBatches: 1, structureCount: 0 });
  });
});

// ═══════════════════════════ L1 提取缓存 v4（对账闭合门禁） ═══════════════════════════

describe('提取缓存 v4（对账闭合门禁）', () => {
  let tempRoot = '';
  const cacheFile = (key: string) => path.join(os.homedir(), '.customize-agent', 'cache', 'document-workflow', stableHash(tempRoot), `tender-requirements-${key}.json`);

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tender-requirements-cache-test-'));
  });
  afterEach(() => {
    fs.rmSync(path.join(os.homedir(), '.customize-agent', 'cache', 'document-workflow', stableHash(tempRoot)), { recursive: true, force: true });
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('哈希失效：招标文件集合任一字节变化即生成不同 key；key 对证据顺序不敏感', () => {
    const keyA = tenderRequirementsCacheKey({ collectionEvidence: [{ ...evidence[0] }] });
    const keyB = tenderRequirementsCacheKey({ collectionEvidence: [{ ...evidence[0], content: `${evidence[0].content}追加内容` }] });
    expect(keyA).not.toBe(keyB);
    const a = tenderRequirementsCacheKey({ collectionEvidence: [{ ...evidence[0], filePath: 'a' }, { ...evidence[0], filePath: 'b' }] });
    const b = tenderRequirementsCacheKey({ collectionEvidence: [{ ...evidence[0], filePath: 'b' }, { ...evidence[0], filePath: 'a' }] });
    expect(a).toBe(b);
  });

  it('写→读回环：对账闭合结果落盘后可原样读回', () => {
    const model = closedModel([entry('创优目标：确保获得黄山杯。', ['黄山杯'], 'respond', '质量创优')]);
    const key = tenderRequirementsCacheKey({ collectionEvidence: [] });
    writeCachedTenderRequirements(tempRoot, key, model);
    const read = readCachedTenderRequirements(tempRoot, key);
    expect(read?.entries[0].text).toBe('创优目标：确保获得黄山杯。');
    expect(read?.reconciliation.undecidedCount).toBe(0);
  });

  it('合并场景（clauseCount = entries + mergedCount）视为对账闭合，缓存可落盘', () => {
    const model = closedModel([entry('创优目标：确保获得黄山杯。', ['黄山杯'], 'respond', '质量创优')], 2);
    const key = tenderRequirementsCacheKey({ collectionEvidence: [] });
    writeCachedTenderRequirements(tempRoot, key, model);
    expect(fs.existsSync(cacheFile(key))).toBe(true);
    expect(readCachedTenderRequirements(tempRoot, key)?.reconciliation.mergedCount).toBe(2);
  });

  it('防脏写门禁：未判定>0 的结果不落盘（坏数据永不固化）', () => {
    const partial: TenderRequirementModel = {
      ...closedModel([entry('创优目标：确保获得黄山杯。', ['黄山杯'], 'respond', '质量创优')]),
      reconciliation: { clauseCount: 2, entryCount: 1, excludedCount: 0, mergedCount: 0, undecidedCount: 1, batchCount: 1, retriedBatches: 1 },
    };
    const key = tenderRequirementsCacheKey({ collectionEvidence: [] });
    writeCachedTenderRequirements(tempRoot, key, partial);
    expect(fs.existsSync(cacheFile(key))).toBe(false);
  });

  it('防脏写门禁：对账等式不闭合（计数缺失）的结果不落盘', () => {
    const unclosed: TenderRequirementModel = {
      ...closedModel([entry('a。', ['aa'], 'respond'), entry('b。', ['bb'], 'respond')]),
      reconciliation: { clauseCount: 3, entryCount: 2, excludedCount: 0, mergedCount: 0, undecidedCount: 0, batchCount: 1, retriedBatches: 0 },
    };
    const key = tenderRequirementsCacheKey({ collectionEvidence: [] });
    writeCachedTenderRequirements(tempRoot, key, unclosed);
    expect(fs.existsSync(cacheFile(key))).toBe(false);
  });

  it('防脏写门禁：未提取（extracted=false）的空模型不落盘', () => {
    const key = tenderRequirementsCacheKey({ collectionEvidence: [] });
    writeCachedTenderRequirements(tempRoot, key, emptyTenderRequirements(false));
    expect(fs.existsSync(cacheFile(key))).toBe(false);
  });

  it('防脏读门禁：手工写入的未闭合缓存不采用；结构缺失（无 reconciliation）不采用；损坏 JSON 不采用', () => {
    const key = tenderRequirementsCacheKey({ collectionEvidence: [] });
    fs.mkdirSync(path.dirname(cacheFile(key)), { recursive: true });
    fs.writeFileSync(cacheFile(key), JSON.stringify({
      ...closedModel([entry('创优目标：确保获得黄山杯。', ['黄山杯'], 'respond', '质量创优')]),
      reconciliation: { clauseCount: 5, entryCount: 1, excludedCount: 0, mergedCount: 0, undecidedCount: 0, batchCount: 1, retriedBatches: 0 },
    }), 'utf8');
    expect(readCachedTenderRequirements(tempRoot, key)).toBeUndefined();
    fs.writeFileSync(cacheFile(key), JSON.stringify({ entries: [], excluded: [], extracted: true }), 'utf8');
    expect(readCachedTenderRequirements(tempRoot, key)).toBeUndefined();
    fs.writeFileSync(cacheFile(key), '{损坏的JSON', 'utf8');
    expect(readCachedTenderRequirements(tempRoot, key)).toBeUndefined();
  });

  it('缓存 miss：未写入时返回 undefined（走真实提取链）', () => {
    const key = tenderRequirementsCacheKey({ collectionEvidence: [] });
    expect(readCachedTenderRequirements(tempRoot, key)).toBeUndefined();
  });
});

// ═══════════════════════════ 消费侧：摘要/检查项/查询/写作口径 ═══════════════════════════

describe('消费侧（摘要/检查项/语义查询/写作规则/章分片）', () => {
  it('hasTenderRequirements：extracted 且 entries 非空才为 true', () => {
    expect(hasTenderRequirements(closedModel([entry('创优目标：确保获得黄山杯。', ['黄山杯'])]))).toBe(true);
    expect(hasTenderRequirements(emptyTenderRequirements(false))).toBe(false);
    expect(hasTenderRequirements({ ...closedModel([entry('a。', ['aa'])]), extracted: false })).toBe(false);
    expect(hasTenderRequirements(undefined)).toBe(false);
  });

  it('tenderRequirementsSummary：对账等式（含合并项）+ 类别分组全量 + 未判定告警', () => {
    const model: TenderRequirementModel = {
      entries: [
        entry('创优目标：确保获得黄山杯。', ['黄山杯'], 'respond', '质量创优'),
        entry('严格执行六个百分百。', [], 'respond', '质量创优'),
        entry('扬尘治理落实六个百分百。', [], 'respond', '安全文明'),
      ],
      excluded: [{ text: '开标时间：2026年5月15日。', reason: 'out_of_scope' }],
      reconciliation: { clauseCount: 6, entryCount: 3, excludedCount: 1, mergedCount: 2, undecidedCount: 0, batchCount: 1, retriedBatches: 0 },
      extracted: true,
    };
    const summary = tenderRequirementsSummary(model);
    expect(summary[0]).toBe('条款对账：切分 6 = 要求 3 + 排除 1 + 合并 2（来源已聚合） + 未判定 0（闭合）');
    expect(summary.some(line => line.startsWith('质量创优 2 条：'))).toBe(true);
    expect(summary.some(line => line.startsWith('安全文明 1 条：'))).toBe(true);
    const undecided = tenderRequirementsSummary({
      ...model,
      reconciliation: { ...model.reconciliation, clauseCount: 7, mergedCount: 1, undecidedCount: 1 },
    });
    expect(undecided.some(line => line.includes('未判定条款 1 条：对账未闭合'))).toBe(true);
    expect(tenderRequirementsSummary(emptyTenderRequirements(false)).some(line => line.includes('招标要求未提取'))).toBe(true);
  });

  it('tenderRequirementsSummary：商务域排除条数可见（零商务句治理指标）', () => {
    const model: TenderRequirementModel = {
      entries: [entry('创优目标：确保获得黄山杯。', ['黄山杯'], 'respond', '质量创优')],
      excluded: [
        { text: '履约保证金金额：中标金额的2%。', reason: 'commercial_scope' },
        { text: '预付款为合同价款的10%。', reason: 'commercial_scope' },
        { text: '开标时间：2026年5月15日。', reason: 'out_of_scope' },
      ],
      reconciliation: { clauseCount: 4, entryCount: 1, excludedCount: 3, mergedCount: 0, undecidedCount: 0, batchCount: 1, retriedBatches: 0 },
      extracted: true,
    };
    const summary = tenderRequirementsSummary(model);
    expect(summary.some(line => line === '商务域排除 2 条（付款/保证金/结算/报价/税金等，技术标正文零商务句）')).toBe(true);
  });

  it('tenderRequirementCheckItems：条目按类别展开（kind=category）', () => {
    const items = tenderRequirementCheckItems(closedModel([entry('创优目标：确保获得黄山杯。', ['黄山杯'], 'respond', '质量创优')]));
    expect(items.length).toBe(1);
    expect(items[0].kind).toBe('质量创优');
    expect(items[0].item.text).toBe('创优目标：确保获得黄山杯。');
  });

  it('tenderRequirementSemanticQuery：coreTerms 拼接优先，无核心词退回条款原文', () => {
    expect(tenderRequirementSemanticQuery({ text: '创优目标：确保获得黄山杯。', coreTerms: ['黄山杯', '300万元'] })).toBe('黄山杯 300万元');
    expect(tenderRequirementSemanticQuery({ text: '创优目标：确保获得黄山杯。', coreTerms: [] })).toBe('创优目标：确保获得黄山杯。');
  });

  it('tenderRequirementsWritingRules：global 遵守条目注入全局红线，未提取返回空串', () => {
    const globalEntry = { ...entry('计划工期：开工之日（以开工令时间为准）起，540个日历天。', ['开工令'], 'comply', '工期进度'), global: true };
    const rules = tenderRequirementsWritingRules(closedModel([globalEntry, entry('创优目标：确保获得黄山杯。', ['黄山杯'], 'respond', '质量创优')]));
    expect(rules).toContain('【招标要求全局口径红线（全文档适用）】');
    expect(rules).toContain('全局遵守：计划工期：开工之日（以开工令时间为准）起，540个日历天。');
    expect(rules).toContain('必须逐条处理');
    expect(rules).toContain('【系统约束——仅指导写作，禁止写入正文，禁止复述本句】');
    expect(tenderRequirementsWritingRules(undefined)).toBe('');
    expect(tenderRequirementsWritingRules(emptyTenderRequirements(false))).toBe('');
  });

  it('renderChapterRequirementSlice：按 policy 标注处理方式并携带来源，空数组返回空串', () => {
    const slice = renderChapterRequirementSlice([
      entry('创优目标：确保获得黄山杯。', ['黄山杯'], 'respond', '质量创优'),
      { ...entry('计划工期：以开工令时间为准。', ['开工令'], 'comply', '工期进度'), global: true },
    ]);
    expect(slice).toContain('【本章必须处理的招标要求（蓝图分配全量，逐条响应/遵守；零处理即评标失分）】');
    expect(slice).toContain('- [显性响应] 创优目标：确保获得黄山杯。（来源：招标文件.pdf）');
    expect(slice).toContain('- [全文遵守] 计划工期：以开工令时间为准。');
    expect(slice).toContain('【系统约束——仅指导写作，禁止写入正文，禁止复述本句】');
    expect(renderChapterRequirementSlice([])).toBe('');
  });

  it('renderChapterStructureSlice：允许口径提示以图/表形态落实；正文禁表/禁图允许表双口径（B-T1/B-T2 专项）', () => {
    const items = [
      { element: '项目管理机构', form: 'org_chart' as const, sourceText: '组织机构以框图方式表示。' },
      { element: '施工总平面布置图', form: 'diagram' as const, sourceText: '提供施工总平面布置图。' },
    ];
    const open = renderChapterStructureSlice(items);
    expect(open).toContain('【本章必须落实的呈现要求（招标明文规定呈现形态，缺失即评标失分）】');
    expect(open).toContain('须以「框图」呈现「项目管理机构」');
    expect(open).toContain('须以「图（网络图/横道图/平面布置图类）」呈现「施工总平面布置图」');
    // B-T1：图类形态声明（规范图题行「图 X-X 图名」）；B-T2：组织机构专项（岗位责任矩阵，零实名数据）
    expect(open).toContain('规范图题行');
    expect(open).toContain('项目管理机构与岗位职责');
    expect(open).toContain('岗位责任矩阵');
    expect(open).toContain('严禁出现人员姓名');
    // 禁图允许表口径（暗标常态 C1）：表格/框图照常落实，图类文字承载 + 图题行，禁止图片
    // 4.55.12 W5：图类先要求数据表承载（数据取自资料），文字框图/时间轴为等价形态；仅图题行不算落实
    const figurePlain = renderChapterStructureSlice(items, { bodyFigureForbidden: true });
    expect(figurePlain).toContain('数据表（表头字段 + 数据行，数据取自资料，禁止编造）或等价的结构化文字框图/表格式时间轴');
    expect(figurePlain).toContain('只输出图题行而无数据表/框图内容视为该项未落实');
    expect(figurePlain).toContain('禁止插入图片或图件占位');
    expect(figurePlain).toContain('岗位责任矩阵');
    // 正文禁表口径（显式禁表句）：不得出现任何表格/图片，图文由文末附表区承载
    const tableForbidden = renderChapterStructureSlice(items, { bodyTableForbidden: true });
    expect(tableForbidden).toContain('【本章必须落实的呈现要求（招标明文规定呈现形态，正文禁表口径）】');
    expect(tableForbidden).toContain('不得出现任何表格/图片');
    expect(tableForbidden).toContain('文末附表区');
    expect(tableForbidden).toContain('严禁出现人员姓名');
    expect(tableForbidden).not.toContain('规范图题行');
    expect(tableForbidden).toContain('分岗位的职责分工与协作关系');
    expect(renderChapterStructureSlice([])).toBe('');
  });

  it('detectStructureRequirements：词表扫描各形态；无信号文本不误报', () => {
    expect(detectStructureRequirements('组织机构以框图方式表示。')).toEqual([
      { element: '项目管理机构', form: 'org_chart', sourceText: '组织机构以框图方式表示。' },
    ]);
    expect(detectStructureRequirements('质量目标：确保合格。')).toEqual([]);
    expect(detectStructureRequirements('')).toEqual([]);
  });
});

// ═══════════════════════════ L2 蓝图分配（每条要求唯一主责章） ═══════════════════════════

describe('assignTenderRequirementsToChapters 蓝图分配', () => {
  let tempRoot = '';
  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'requirement-assign-test-'));
  });
  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('argmax 语义路由：章节标题归一化匹配，低置信标记记账', () => {
    const chapters = [{ title: '## 第五章 施工组织与分包管理' }, { title: '## 第六章 质量保证措施' }];
    const similarity = (query: string, title: string) => {
      if (query.includes('分包') && title.includes('分包')) return 0.72;
      if (query.includes('黄山杯') && title.includes('质量')) return 0.81;
      return 0.1;
    };
    const { assignments, lowConfidenceCount } = assignTenderRequirementsToChapters([
      entry('本招标项目不允许分包。', ['不允许分包'], 'respond', '禁止性要求'),
      entry('创优目标：确保获得黄山杯。', ['黄山杯'], 'respond', '质量创优'),
    ], chapters, similarity);
    expect(assignments.length).toBe(2);
    expect(assignments[0].chapterTitle).toBe('第五章 施工组织与分包管理');
    expect(assignments[0].lowConfidence).toBe(false);
    expect(assignments[1].chapterTitle).toBe('第六章 质量保证措施');
    expect(lowConfidenceCount).toBe(0);
  });

  it('相似度全零：argmax 兜底退回第一章（未分配恒为 0），标记低置信', () => {
    const chapters = [{ title: '## 第五章 施工组织管理' }, { title: '## 第六章 质量保证措施' }];
    const { assignments, lowConfidenceCount } = assignTenderRequirementsToChapters([
      entry('创优目标：确保获得黄山杯。', ['黄山杯'], 'respond', '质量创优'),
      entry('扬尘治理落实六个百分百。', ['六个百分百'], 'respond', '安全文明'),
    ], chapters, () => 0);
    expect(assignments.length).toBe(2);
    expect(assignments.every(item => item.chapterTitle === '第五章 施工组织管理')).toBe(true);
    expect(assignments.every(item => item.lowConfidence)).toBe(true);
    expect(lowConfidenceCount).toBe(2);
  });

  it('空输入（无条目/无章节）返回空分配', () => {
    expect(assignTenderRequirementsToChapters([], [{ title: '## 第五章' }], () => 1).assignments).toEqual([]);
    expect(assignTenderRequirementsToChapters([entry('a。', ['aa'])], [], () => 1).assignments).toEqual([]);
    // A-T1：结构分配空输入（无要求/无章节）双轨返回空
    expect(assignStructureRequirementsToChapters([], [{ title: '## 第五章' }], () => 1)).toEqual({ assignments: [], unattached: [] });
    const noChapters = assignStructureRequirementsToChapters([{ element: '项目管理机构', form: 'org_chart', sourceText: '组织机构以框图方式表示。' }], [], () => 1);
    expect(noChapters.assignments).toEqual([]);
    expect(noChapters.unattached.length).toBe(1);
  });

  it('分配落盘：审计资产写入 generatedDocuments/assets/requirement-assignments.json', () => {
    const a = assignment(entry('创优目标：确保获得黄山杯。', ['黄山杯'], 'respond', '质量创优'), '第五章 施工组织管理');
    const assetPath = saveRequirementAssignmentsAsset(tempRoot, [a]);
    expect(assetPath).toContain(path.join('assets', 'requirement-assignments.json'));
    const parsed = JSON.parse(fs.readFileSync(assetPath, 'utf8')) as { total: number; assignments: Array<{ chapterTitle: string }> };
    expect(parsed.total).toBe(1);

    // A-T1：结构要求分配（挂章+存疑不挂双轨，资产落盘）
    const structureItems = [
      { element: '项目管理机构', form: 'org_chart' as const, sourceText: '组织机构以框图方式表示。' },
      { element: '施工总平面布置图', form: 'diagram' as const, sourceText: '提供施工总平面布置图。' },
    ];
    const similarity = (query: string, title: string) => (query.includes('项目管理机构') && title.includes('施工组织') ? 0.66 : 0.12);
    const structureResult = assignStructureRequirementsToChapters(structureItems, [{ title: '## 第五章 施工组织管理' }], similarity);
    expect(structureResult.assignments.length).toBe(1);
    expect(structureResult.assignments[0].chapterTitle).toBe('第五章 施工组织管理');
    expect(structureResult.assignments[0].lowConfidence).toBe(false);
    expect(structureResult.unattached.length).toBe(1);
    expect(structureResult.unattached[0].requirement.element).toBe('施工总平面布置图');
    const structureAssetPath = saveStructureAssignmentsAsset(tempRoot, structureResult.assignments, structureResult.unattached);
    expect(structureAssetPath).toContain(path.join('assets', 'structure-assignments.json'));
    const structureParsed = JSON.parse(fs.readFileSync(structureAssetPath, 'utf8')) as { attached: number; unattached: number };
    expect(structureParsed.attached).toBe(1);
    expect(structureParsed.unattached).toBe(1);
    expect(parsed.assignments[0].chapterTitle).toBe('第五章 施工组织管理');
    // 清理生成目录（generatedRoot 落在用户目录按 projectRoot 哈希隔离）
    fs.rmSync(path.dirname(path.dirname(path.dirname(assetPath))), { recursive: true, force: true });
  });
});

// ═══════════════════════════ L2 低置信路由精化（LLM 裁决主责章） ═══════════════════════════

describe('routeTenderRequirementsToChapters 低置信路由精化（LLM 裁决主责章）', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('全部高置信：零 LLM 调用（argmax 结果原样返回）', async () => {
    const result = await routeTenderRequirementsToChapters(
      [entry('创优目标：确保获得黄山杯。', ['黄山杯'], 'respond', '质量创优')],
      [{ title: '## 第五章 施工组织管理' }],
      () => 0.9,
      {},
    );
    expect(result.assignments.length).toBe(1);
    expect(result.lowConfidenceCount).toBe(0);
    expect(result.dropped).toEqual([]);
    expect(vi.mocked(callDocumentLlmJson)).not.toHaveBeenCalled();
  });

  it('高置信条目不经 LLM（仅低置信送裁决）：命中章节列表则覆盖分配并清除低置信标记', async () => {
    const similarity = (query: string, title: string) => (query.includes('黄山杯') && title.includes('质量') ? 0.82 : 0.1);
    vi.mocked(callDocumentLlmJson).mockResolvedValueOnce({
      results: [{ index: 0, chapter: '第五章 施工组织管理' }],
    });
    const chapters = [{ title: '## 第五章 施工组织管理' }, { title: '## 第六章 质量保证措施' }];
    const result = await routeTenderRequirementsToChapters([
      entry('创优目标：确保获得黄山杯。', ['黄山杯'], 'respond', '质量创优'),
      entry('扬尘治理落实六个百分百。', ['六个百分百'], 'respond', '安全文明'),
    ], chapters, similarity, {});
    expect(result.assignments.length).toBe(2);
    expect(result.assignments[0].chapterTitle).toBe('第六章 质量保证措施');
    expect(result.assignments[0].lowConfidence).toBe(false);
    expect(result.assignments[1].chapterTitle).toBe('第五章 施工组织管理');
    expect(result.assignments[1].lowConfidence).toBe(false);
    expect(result.lowConfidenceCount).toBe(0);
    expect(result.dropped).toEqual([]);
    const prompt = vi.mocked(callDocumentLlmJson).mock.calls[0]![1];
    expect(prompt).toContain('六个百分百');
    expect(prompt).not.toContain('黄山杯');
  });

  it('LLM 拒选（none）：条目移出要求池（dropped 审计）', async () => {
    vi.mocked(callDocumentLlmJson).mockResolvedValueOnce({
      results: [
        { index: 0, chapter: 'none' },
        { index: 1, chapter: '第六章 质量保证措施' },
      ],
    });
    const chapters = [{ title: '## 第五章 施工组织管理' }, { title: '## 第六章 质量保证措施' }];
    const result = await routeTenderRequirementsToChapters([
      entry('回复：按招标文件执行。', ['回复'], 'respond', '其他要求'),
      entry('创优目标：确保获得黄山杯。', ['黄山杯'], 'respond', '质量创优'),
    ], chapters, () => 0, {});
    expect(result.assignments.length).toBe(1);
    expect(result.dropped.length).toBe(1);
    expect(result.dropped[0].text).toBe('回复：按招标文件执行。');
    expect(result.assignments[0].chapterTitle).toBe('第六章 质量保证措施');
    expect(result.lowConfidenceCount).toBe(0);
  });

  it('LLM 不可用：保留原 argmax 低置信分配（不丢条目、不阻断生成）', async () => {
    vi.mocked(callDocumentLlmJson).mockResolvedValue(undefined);
    const chapters = [{ title: '## 第五章 施工组织管理' }, { title: '## 第六章 质量保证措施' }];
    const result = await routeTenderRequirementsToChapters([
      entry('创优目标：确保获得黄山杯。', ['黄山杯'], 'respond', '质量创优'),
    ], chapters, () => 0, {});
    expect(result.assignments.length).toBe(1);
    expect(result.assignments[0].chapterTitle).toBe('第五章 施工组织管理');
    expect(result.assignments[0].lowConfidence).toBe(true);
    expect(result.lowConfidenceCount).toBe(1);
    expect(result.dropped).toEqual([]);
  });

  it('输出缺号/无效章节名：该条保留原分配（不误删不误迁，审计可见）', async () => {
    vi.mocked(callDocumentLlmJson).mockResolvedValueOnce({
      results: [{ index: 1, chapter: '不存在的章节' }],
    });
    const chapters = [{ title: '## 第五章 施工组织管理' }, { title: '## 第六章 质量保证措施' }];
    const result = await routeTenderRequirementsToChapters([
      entry('条目缺号。', ['缺号'], 'respond', '其他要求'),
      entry('章节幻觉。', ['幻觉'], 'respond', '其他要求'),
    ], chapters, () => 0, {});
    expect(result.assignments.length).toBe(2);
    expect(result.assignments.every(item => item.lowConfidence)).toBe(true);
    expect(result.lowConfidenceCount).toBe(2);
    expect(result.dropped).toEqual([]);
  });
});

// ═══════════════════════════ 章级验收（requirementAcceptanceIssues） ═══════════════════════════

describe('requirementAcceptanceIssues 章级验收（三通道判定）', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('无条目直接返回空（验收自动跳过）', async () => {
    const issues = await requirementAcceptanceIssues({ markdown: '## 第五章\n正文。', entries: [], semanticSimilarity: () => 0 });
    expect(issues).toEqual([]);
  });

  it('comply（遵守类）不做落位验收（数据一致性域核验）', async () => {
    const issues = await requirementAcceptanceIssues({
      markdown: '## 第五章 施工组织管理\n本工程按计划组织施工。',
      entries: [entry('计划工期：开工之日（以开工令时间为准）起，540个日历天。', ['开工令'], 'comply', '工期进度')],
      semanticSimilarity: () => 0,
    });
    expect(issues).toEqual([]);
  });

  it('respond：语义命中但金额锚点缺失 → 部分响应 blocker（经或选型判定非或选型）', async () => {
    vi.mocked(callDocumentLlmJson).mockResolvedValueOnce({ results: [{ index: 0, alternative: false }] });
    const issues = await requirementAcceptanceIssues({
      markdown: '## 第五章 质量保证措施\n本工程确保获得黄山杯，周密策划创优工作。',
      entries: [entry('本项目确保获得“黄山杯”。获得“黄山杯”的，支付该项300万元。', ['黄山杯', '300万元'], 'respond', '质量创优')],
      semanticSimilarity: () => 0.8,
    });
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('部分响应');
    expect(issues[0].message).toContain('300万元');
    expect(issues[0].severity).toBe('blocker');
  });

  it('respond：语义命中且金额锚点已落位 → 放行；语义命中且条款无金额锚点 → 直接放行', async () => {
    const paid = await requirementAcceptanceIssues({
      markdown: '## 第五章 质量保证措施\n本工程确保获得黄山杯，该项300万元专项用于质量创优奖励。',
      entries: [entry('本项目确保获得“黄山杯”。获得“黄山杯”的，支付该项300万元。', ['黄山杯', '300万元'], 'respond', '质量创优')],
      semanticSimilarity: () => 0.8,
    });
    expect(paid).toEqual([]);
    const noMoney = await requirementAcceptanceIssues({
      markdown: '## 第七章 绿色施工\n本工程绿色建筑等级达到国标二星级。',
      entries: [entry('绿色建筑等级要求：达到国标二星级。', ['二星级'], 'respond', '绿色施工')],
      semanticSimilarity: () => 0.8,
    });
    expect(noMoney).toEqual([]);
  });

  it('respond：条款原文抄写（含投标人口吻转换）分句全落位 → 不报零响应', async () => {
    const clause = entry('对于发包人提供的工程量清单中的清单项目，承包人没有报价的，发包人认为视同该项价格已经包括在其他项目中。', ['未报价处理', '视同已包含'], 'respond', '商务支付');
    const markdown = '## 第二章 投标报价与计量管理\n对于发包人提供的工程量清单中的清单项目，我方没有报价的，视为该项价格已经包括在其他项目中。';
    const issues = await requirementAcceptanceIssues({ markdown, entries: [clause], semanticSimilarity: () => 0 });
    expect(issues).toEqual([]);
  });

  it('respond：真缺失（正文无条款原文）→ 零响应 blocker', async () => {
    const issues = await requirementAcceptanceIssues({
      markdown: '## 第二章 投标报价\n本工程按计划组织施工。',
      entries: [entry('对于发包人提供的工程量清单中的清单项目，承包人没有报价的，发包人认为视同该项价格已经包括在其他项目中。', ['未报价处理', '视同已包含'], 'respond', '商务支付')],
      semanticSimilarity: () => 0,
    });
    expect(issues.length).toBe(1);
    expect(issues[0].level).toBe('error');
    expect(issues[0].severity).toBe('blocker');
    expect(issues[0].message).toContain('零命中');
  });

  it('六个百分百词面兜底：正文逐项落位六项措施（≥4 项）→ 判已响应（语义稀释不误报）', async () => {
    const markdown = [
      '## 第八章 扬尘治理措施',
      '施工工地周边100%围挡，物料堆放100%覆盖，出入车辆100%冲洗，施工现场地面100%硬化，渣土车辆100%密闭运输。',
    ].join('\n');
    const issues = await requirementAcceptanceIssues({
      markdown,
      entries: [entry('扬尘治理必须落实六个百分百。', ['六个百分百'], 'respond', '安全文明')],
      semanticSimilarity: () => 0,
    });
    expect(issues).toEqual([]);
  });
});

// ═══════════════════════════ 交付前确定性清理器 ═══════════════════════════

describe('fixTenderMetaLanguage 招标元语言确定性清理（语气泄漏治理）', () => {
  it('条幅前缀剥离：条款正文保留并转投标人口吻（「按招标文件要求：」不再入正文）', () => {
    const result = fixTenderMetaLanguage('## 第二章 工程概况\n按招标文件要求：承包人负责施工期间的现场管理。');
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toContain('我方负责施工期间的现场管理。');
    expect(result.markdown).not.toContain('按招标文件要求');
    expect(result.markdown).toContain('## 第二章 工程概况');
  });

  it('句内元语言替换：按招标文件约定→按招标要求 / 按上述条款→按招标要求 / 本招标项目→本项目', () => {
    const result = fixTenderMetaLanguage('本工程预付款的支付、扣回与使用按招标文件约定执行，按上述条款办理，本招标项目严格落实。');
    expect(result.markdown).toContain('按招标要求执行');
    expect(result.markdown).toContain('按招标要求办理');
    expect(result.markdown).toContain('本项目严格落实');
    expect(result.markdown).not.toContain('按招标文件');
    expect(result.markdown).not.toContain('按上述条款');
  });

  it('裸词豁免：编制依据「招标文件及补疑补遗」保留（只清理调用式元语言）', () => {
    const input = '编制依据包括招标文件及补疑补遗、工程量清单与施工图纸。';
    const result = fixTenderMetaLanguage(input);
    expect(result.fixedCount).toBe(0);
    expect(result.markdown).toBe(input);
  });

  it('空响应句残留整行删除（fixEmptyScoringResponses 未改写成功的后端兜底；不再产出兜底套话句）', () => {
    const result = fixTenderMetaLanguage('本施工组织设计已按上述条款要求逐项落实执行。');
    expect(result.markdown.trim()).toBe('');
    expect(result.markdown).not.toContain('已按上述条款要求');
    expect(result.markdown).not.toContain('严格执行合同约定的各项要求');
  });

  it('标题行豁免：小节标题含「按招标文件要求」不清理（由标题治理链负责）', () => {
    const input = '### 2.1 按招标文件要求的响应措施\n正文内容。';
    const result = fixTenderMetaLanguage(input);
    expect(result.fixedCount).toBe(0);
    expect(result.markdown).toBe(input);
  });
});

describe('stripDuplicateResponseLines 条款响应重复行去重', () => {
  const duplicatedSentence = '我方承诺本工程严格执行合同约定的各项要求，施工过程中强化过程控制与检查验收管理，确保工程一次成优。';

  it('相同响应句重复出现（≥40 字）：仅保留首次，后续整行删除并吞尾随空行', () => {
    const input = ['## 第五章 施工组织管理', duplicatedSentence, '', duplicatedSentence, ''].join('\n');
    const result = stripDuplicateResponseLines(input);
    expect(result.fixedCount).toBe(1);
    expect(result.markdown.split(duplicatedSentence).length - 1).toBe(1);
    expect(result.markdown).not.toContain('\n\n\n');
  });

  it('短行/标题行/表格行不参与判定（零误伤防线）', () => {
    const input = ['### 2.1 施工措施', '| 序号 | 内容 |', '| 1 | 本工程按合同约定执行 |', '本工程按合同约定执行。'].join('\n');
    const result = stripDuplicateResponseLines(input);
    expect(result.fixedCount).toBe(0);
    expect(result.markdown).toBe(input);
  });

  it('软换行差异视为同一行（空白规范化后同文本去重）', () => {
    const input = [duplicatedSentence, duplicatedSentence.replace('我方承诺', '我方 承诺')].join('\n');
    const result = stripDuplicateResponseLines(input);
    expect(result.fixedCount).toBe(1);
    expect(result.markdown.split('\n').filter(line => line.includes('确保工程一次成优')).length).toBe(1);
  });
});

// ═══════════════════════════ M10 池纯度复核（r28h 实机归因分型） ═══════════════════════════

describe('isRequirementPoolNoiseClause / judgeTenderClauses M10 池纯度复核（程序与澄清形态出池）', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('形态判据：答疑回复/考核惩奖/质量保修/投标表单/勾选填报行命中', () => {
    expect(isRequirementPoolNoiseClause('回复：C25混凝土浇筑，具体详见图纸')).toBe(true);
    expect(isRequirementPoolNoiseClause('考核评分：采取百分制，总分100分，低于80分每项扣2分')).toBe(true);
    expect(isRequirementPoolNoiseClause('质量保修范围包括：地基基础工程、主体结构工程、屋面防水工程')).toBe(true);
    expect(isRequirementPoolNoiseClause('本表应填写项目经理相关情况，并附资格证书')).toBe(true);
    expect(isRequirementPoolNoiseClause('1.2 ☑本工程采用商品砼，泵送浇筑')).toBe(true);
  });

  it('形态判据反例：施工义务/技术标准语境不误伤（考核/保修词表收窄、☑限行首）', () => {
    expect(isRequirementPoolNoiseClause('定期开展安全技术考核，考核不合格者不得上岗')).toBe(false);
    expect(isRequirementPoolNoiseClause('本工程采用预拌混凝土泵送施工工艺')).toBe(false);
    expect(isRequirementPoolNoiseClause('夜间施工噪音控制措施：采用低噪音设备，禁止鸣笛')).toBe(false);
    expect(isRequirementPoolNoiseClause('投标人须确保黄山杯')).toBe(false);
    expect(isRequirementPoolNoiseClause('')).toBe(false);
  });

  it('集成：投标表单与勾选填报行 LLM 判为要求仍强制剔除（non_requirement）', async () => {
    const clauses: TenderClauseUnit[] = [
      { file: '招标文件.pdf', section: '前附表', clauseNo: '1.1', text: '1.1 本表应填写项目经理相关情况，并附身份证复印件及联系方式' },
      { file: '招标文件.pdf', section: '前附表', clauseNo: '1.2', text: '1.2 ☑本工程采用商品砼，泵送浇筑，运距及泵车配置由承包方现场踏勘后确认' },
      { file: '招标文件.pdf', section: '第三章', text: '定期开展安全技术考核，考核不合格者不得上岗' },
    ];
    vi.mocked(callDocumentLlmJson).mockResolvedValue({
      results: clauses.map((_, index) => ({ index, isRequirement: true, inScope: true, policy: 'respond' as const, coreTerms: [], category: '其他要求' })),
    });
    const result = await judgeTenderClauses(clauses, {});
    expect(result.entries.length).toBe(1);
    expect(result.entries[0].text).toBe('定期开展安全技术考核，考核不合格者不得上岗');
    expect(result.excluded.length).toBe(2);
    expect(result.excluded.map(item => item.reason)).toEqual(['non_requirement', 'non_requirement']);
  });

  it('集成：答疑回复/考核惩奖/质量保修条款强制剔除，施工义务条款保留进池', async () => {
    const clauses: TenderClauseUnit[] = [
      { file: '答疑纪要.pdf', section: '答疑', text: '回复：C25混凝土浇筑，具体做法详见图纸' },
      { file: '招标文件.pdf', section: '养护考核办法', clauseNo: '4.1', text: '4.1 考核评分：采取百分制，总分100分，低于80分每项扣2分' },
      { file: '招标文件.pdf', section: '合同专用条款', text: '质量保修范围包括：地基基础工程、主体结构工程、屋面防水工程' },
      { file: '招标文件.pdf', section: '第三章', text: '定期开展安全技术考核，考核不合格者不得上岗' },
    ];
    vi.mocked(callDocumentLlmJson).mockResolvedValue({
      results: clauses.map((_, index) => ({ index, isRequirement: true, inScope: true, policy: 'respond' as const, coreTerms: [], category: '其他要求' })),
    });
    const result = await judgeTenderClauses(clauses, {});
    expect(result.entries.length).toBe(1);
    expect(result.entries[0].text).toBe('定期开展安全技术考核，考核不合格者不得上岗');
    expect(result.excluded.length).toBe(3);
    expect(result.excluded.map(item => item.reason)).toEqual(['non_requirement', 'non_requirement', 'non_requirement']);
  });
});

// ═══════════════════════════ M26 判定层域兜底 + 锚点提取修复（r28k/s28k 要求锚点实机归因） ═══════════════════════════

describe('M26 判定层域兜底（合同附件来源域 + 引用性条款出池）', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('isContractAttachmentSectionClause 形态：合同附件域来源小节命中（GF 通用条款条款名/保修/安全生产合同/管养考核/投标文件格式）', () => {
    expect(isContractAttachmentSectionClause('第三部分 专用合同条款·附件3 工程质量保修书')).toBe(true);
    expect(isContractAttachmentSectionClause('第二章 合同条款 承包人职责')).toBe(true);
    expect(isContractAttachmentSectionClause('1.1 承包人的一般义务')).toBe(true);
    expect(isContractAttachmentSectionClause('安全生产合同')).toBe(true);
    expect(isContractAttachmentSectionClause('监理人的一般规定')).toBe(true);
    expect(isContractAttachmentSectionClause('样品的报送与封存')).toBe(true);
    expect(isContractAttachmentSectionClause('项目经理质量终身责任制承诺')).toBe(true);
    expect(isContractAttachmentSectionClause('投标文件格式 五、施工组织设计')).toBe(true);
    expect(isContractAttachmentSectionClause('绿化养护管理质量标准（一级养护质量标准）')).toBe(true);
    expect(isContractAttachmentSectionClause('景观设施维护 考核表')).toBe(true);
  });

  it('零误伤反向守护：施组/技术域来源小节不命中（「承诺」裸词不入表——工期承诺类实质要求保留）', () => {
    expect(isContractAttachmentSectionClause('第三章 评标办法')).toBe(false);
    expect(isContractAttachmentSectionClause('第二章 工程概况')).toBe(false);
    expect(isContractAttachmentSectionClause('施工组织设计')).toBe(false);
    expect(isContractAttachmentSectionClause('工期承诺与保证措施')).toBe(false);
    expect(isContractAttachmentSectionClause('质量管理体系与措施')).toBe(false);
    expect(isContractAttachmentSectionClause('')).toBe(false);
    expect(isContractAttachmentSectionClause(undefined)).toBe(false);
  });

  it('isDocumentReferenceOnlyClause：coreTerms 全为文号/行政文件名 → 引用性出池；含实质词 → 保留', () => {
    expect(isDocumentReferenceOnlyClause(['建市〔2021〕71号', '建筑工人实名制管理办法'])).toBe(true);
    expect(isDocumentReferenceOnlyClause(['危险性较大的分部分项工程安全管理规定'])).toBe(true);
    // 词尾限行政文件类：「工程质量标准」「技术规范」为技术/管理词，不判引用性（防实质要求误出池）
    expect(isDocumentReferenceOnlyClause(['工程质量标准'])).toBe(false);
    expect(isDocumentReferenceOnlyClause(['施工技术规范'])).toBe(false);
    // 混合：文号 + 实质要求词 → 保留
    expect(isDocumentReferenceOnlyClause(['建市〔2021〕71号', '实名制考勤'])).toBe(false);
    expect(isDocumentReferenceOnlyClause([])).toBe(false);
    expect(isDocumentReferenceOnlyClause(undefined)).toBe(false);
  });

  it('集成：合同附件来源域条款 LLM 判为要求仍出池（out_of_scope）；技术域条款保留（反向守护）', async () => {
    const clauses: TenderClauseUnit[] = [
      { file: '招标文件.pdf', section: '专用合同条款·附件3 工程质量保修书', text: '缺陷责任期内出现质量缺陷的，应及时组织修复并做好记录' },
      { file: '招标文件.pdf', section: '第二章 工程概况', text: '本工程应做好施工期间的绿色施工与环境保护管理' },
    ];
    vi.mocked(callDocumentLlmJson).mockResolvedValue({
      results: clauses.map((_, index) => ({ index, isRequirement: true, inScope: true, policy: 'respond' as const, coreTerms: index === 0 ? ['缺陷责任期', '组织修复'] : ['绿色施工', '环境保护'], category: '其他要求' })),
    });
    const result = await judgeTenderClauses(clauses, {});
    expect(result.entries.length).toBe(1);
    expect(result.entries[0].text).toContain('绿色施工');
    expect(result.excluded.length).toBe(1);
    expect(result.excluded[0].reason).toBe('out_of_scope');
  });

  it('集成：引用性条款（coreTerms 全为文号/行政文件名）出池；实质条款保留（反向守护）', async () => {
    const clauses: TenderClauseUnit[] = [
      { file: '招标文件.pdf', section: '第三章 评标办法', text: '按照建市〔2021〕71号《建筑工人实名制管理办法》相关规定执行' },
      { file: '招标文件.pdf', section: '第三章 施工方案', text: '施工现场临时用电应符合三级配电两级保护要求' },
    ];
    vi.mocked(callDocumentLlmJson).mockResolvedValue({
      results: clauses.map((_, index) => ({ index, isRequirement: true, inScope: true, policy: 'respond' as const, coreTerms: index === 0 ? ['建市〔2021〕71号', '建筑工人实名制管理办法'] : ['三级配电', '两级保护'], category: '其他要求' })),
    });
    const result = await judgeTenderClauses(clauses, {});
    expect(result.entries.length).toBe(1);
    expect(result.entries[0].text).toContain('三级配电');
    expect(result.excluded.length).toBe(1);
    expect(result.excluded[0].reason).toBe('out_of_scope');
  });
});

/**
 * 4.56.3 尺寸分隔符族归一：远端/本机实测 `doc-1790156773687-0c18ca14` 的 11 条
 * 「招标要求部分响应」blocker 里，`600*600mm方形钢筋混凝土户线检查井` 判未落位——
 * 而正文写的是 `600×600mm方形钢筋混凝土户线检查井`（乘号）。两种分隔符字形不同、逐字比对必 miss。
 * 本组用例锁定：分隔符/全角/连接号三种字形差不再造成假 miss，且**真实未落位仍报缺**。
 */
describe('4.56.3 尺寸分隔符族归一（* / × / x 与全角形态）', () => {
  it('条款用 * 正文用 × → 判已落位（实测回放）', () => {
    const [gap] = tenderRequirementResponseGaps(
      [entry('3、雨水、污水靠墙井采用600*600mm方形钢筋混凝土户线检查井', ['户线检查井'])],
      '雨水、污水靠墙井采用600×600mm方形钢筋混凝土户线检查井，井盖设防坠落网。',
    );
    expect(gap.missing).toEqual([]);
    expect(gap.satisfied).toBe(true);
  });

  it('半角 x / 全角 ｘ / 星号 三形态互通（双向）', () => {
    for (const wrote of ['700x700mm', '700ｘ700mm', '700×700mm', '700*700mm']) {
      const [gap] = tenderRequirementResponseGaps(
        [entry('雨水检查井采用700*700mm方形钢筋混凝土井', ['雨水检查井'])],
        `雨水检查井采用${wrote}方形钢筋混凝土井。`,
      );
      expect(gap.missing, `正文写作 ${wrote}`).toEqual([]);
    }
  });

  it('**真实未落位仍报缺**（防归一过度）：正文尺寸不同不得放行', () => {
    const [gap] = tenderRequirementResponseGaps(
      [entry('雨水检查井采用700*700mm方形钢筋混凝土井', ['雨水检查井'])],
      '雨水检查井采用600×600mm方形钢筋混凝土井。',
    );
    // 数字锚点取「数字+单位」组合，`700*700mm` 中只有末段 `700mm` 成锚（既有口径：
    // 一次连写只取一个数字+单位；扩展成 `700×700mm` 会造出更长的锚点、抬高整体 miss 率，不在本批范围）。
    // 关键断言是：**`700mm` 不得被正文的 `600mm` 满足**——归一化只折字形差，不折数值差。
    expect(gap.missing).toEqual(['700mm']);
    expect(gap.satisfied).toBe(false);
  });
});

describe('M26 锚点提取修复（全角％归一 + 「N.N项」编号切片守卫）', () => {
  it('全角％/半角% 同源归一：锚点与正文形态差不再假 miss（双向）', () => {
    const [gap] = tenderRequirementResponseGaps(
      [entry('混凝土强度优良率应达到95％', ['优良率'])],
      '本工程混凝土强度优良率达到95%。',
    );
    expect(gap.satisfied).toBe(true);
    expect(gap.missing).toEqual([]);
    const [gap2] = tenderRequirementResponseGaps(
      [entry('混凝土强度优良率应达到95%', ['优良率'])],
      '本工程混凝土强度优良率达到95％。',
    );
    expect(gap2.satisfied).toBe(true);
  });

  it('「N.N项」编号切片假锚丢弃（「1.1项目名称」截断产物）；「3项」整数+项真实数量锚保留', () => {
    const [missingGap] = tenderRequirementResponseGaps(
      [entry('施工方案应包含1.1项目名称及3项保证措施', [])],
      '施工方案已包含项目名称及保证措施。',
    );
    expect(missingGap.satisfied).toBe(false);
    expect(missingGap.missing).toEqual(['3项']);
    const [hitGap] = tenderRequirementResponseGaps(
      [entry('施工方案应包含1.1项目名称及3项保证措施', [])],
      '施工方案已包含项目名称及3项保证措施。',
    );
    expect(hitGap.satisfied).toBe(true);
  });
});

// ── C8 S4-⑤：锚点变体归一（s28m' 六条部分响应实锤：招标条款 coreTerms 与正文写作四类合法
// 变体形态差导致锚点率与响应判定双失真；四类=引号/顿号/的为省略/括号注释省略）──
describe('tenderRequirementResponseGaps 锚点变体归一（C8 S4-⑤）', () => {
  it('变体通道四类：引号/顿号/的为/括号省略不假 miss（锚点全覆盖 satisfied）', () => {
    const entries = [
      entry('考勤数据应实时上传“钉钉”系统', ['“钉钉”系统']),
      entry('现场管理应覆盖考勤、考核记录', ['考勤、考核']),
      entry('施工场地的清理应符合移交要求', ['施工场地的清理']),
      entry('对竣工保修（养护）期内的质量问题负责修复', ['竣工保修（养护）期内']),
    ];
    const md = '本工程考勤数据实时上传钉钉系统平台；现场管理覆盖考勤考核记录；各单位完成施工场地清理后办理移交；我方对竣工保修期内的质量问题负责修复。';
    const gaps = tenderRequirementResponseGaps(entries, md);
    for (const gap of gaps) {
      expect(gap.missing, gap.entry.text).toEqual([]);
      expect(gap.satisfied, gap.entry.text).toBe(true);
    }
  });

  it('反例①：变体坍缩过半防线（钢筋（HRB400）剥离后仅 2 字）→ 变体通道拒绝，真缺失照报', () => {
    const [gap] = tenderRequirementResponseGaps(
      [entry('进场钢筋（HRB400）应复检合格', ['钢筋（HRB400）'])],
      '进场钢筋已复检合格，检验批按规范划分验收。',
    );
    expect(gap.missing).toContain('钢筋（HRB400）');
    expect(gap.satisfied).toBe(false);
  });

  it('反例②：真缺失（“五一”前 正文未提该时限）→ 变体通道不为缺失背书', () => {
    const [gap] = tenderRequirementResponseGaps(
      [entry('绿化工程应在“五一”前完成', ['“五一”前'])],
      '绿化工程按施工进度计划组织实施。',
    );
    expect(gap.missing).toContain('“五一”前');
    expect(gap.satisfied).toBe(false);
  });
});

describe('M14a 判定口径指纹（缓存失效自动防线：口径变更不再依赖人工递增版本）', () => {
  const SRC = path.join(__dirname, '../../../src/services/document-workflow/tenderRequirements.ts');

  it('指纹稳定非空：sha1 形态、重复调用一致', () => {
    const fingerprint = tenderRequirementsJudgeFingerprint();
    expect(fingerprint).toMatch(/^[0-9a-f]{40}$/u);
    expect(tenderRequirementsJudgeFingerprint()).toBe(fingerprint);
  });

  it('指纹对判据源敏感：源集不同 → 指纹不同（判据代码变更即失效缓存）', () => {
    expect(tenderRequirementsJudgeFingerprint([() => 'alpha'])).not.toBe(tenderRequirementsJudgeFingerprint([() => 'beta']));
    expect(tenderRequirementsJudgeFingerprint([/a/u])).not.toBe(tenderRequirementsJudgeFingerprint([/b/u]));
  });

  it('缓存 key 接线（源码守护）：v10 版本 + judgeFingerprint 入 key（防版本漏递增/指纹漏接线回归）', () => {
    const source = fs.readFileSync(SRC, 'utf8');
    expect(source).toContain("const TENDER_REQUIREMENTS_CACHE_VERSION = 'tender-requirements-extraction-v10'");
    expect(source).toContain('judgeFingerprint: tenderRequirementsJudgeFingerprint()');
  });

  it('判据调用守护：judgeTenderClauses 内判据调用全部入指纹源清单（新增判据漏加即红）', () => {
    const source = fs.readFileSync(SRC, 'utf8');
    const start = source.indexOf('export async function judgeTenderClauses');
    const end = source.indexOf('L1 提取缓存', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = source.slice(start, end);
    // 函数形态判据（负向后行断言排除 `.test(` 等方法调用）+ 正则形态判据（`XXX_RE.test(` 的正则变量名）
    const called = new Set([
      ...[...body.matchAll(/(?<![.\w$])([a-zA-Z_$][\w$]*)\((?:clause\.text|judgment|clause, judgment)\)/gu)].map(match => match[1]),
      ...[...body.matchAll(/\b([A-Z][A-Z0-9_]*_RE)\.test\(/gu)].map(match => match[1]),
    ]);
    expect(called.size).toBeGreaterThan(8);
    const listStart = source.indexOf('const CACHE_JUDGE_FINGERPRINT_SOURCES');
    const listText = source.slice(listStart, source.indexOf('];', listStart));
    for (const name of called) {
      expect(listText, `判据 ${name} 未入 CACHE_JUDGE_FINGERPRINT_SOURCES（口径变更将不失效缓存）`).toContain(name);
    }
  });

  it('指纹对表内容敏感：词表/规则表内容变更 → 指纹不同（String() 退化为 [object Object] 的回归守护）', () => {
    const rulesA = [{ form: 'table', formRe: /一览表/u, elementRules: [{ re: /机构/u, element: '项目管理机构' }], fallbackElement: '要求表格' }];
    const rulesB = [{ form: 'table', formRe: /一览表|汇总表/u, elementRules: [{ re: /机构/u, element: '项目管理机构' }], fallbackElement: '要求表格' }];
    expect(tenderRequirementsJudgeFingerprint([rulesA])).not.toBe(tenderRequirementsJudgeFingerprint([rulesB]));
    expect(tenderRequirementsJudgeFingerprint([{ re: /a/u }])).not.toBe(tenderRequirementsJudgeFingerprint([{ re: /b/u }]));
    expect(tenderRequirementsJudgeFingerprint([['a']])).not.toBe(tenderRequirementsJudgeFingerprint([['b']]));
  });

  it('判据表守护：入表判据（含本文件内传递调用）引用的模块级词表/规则表亦须入清单（表漏加即红）', () => {
    const source = fs.readFileSync(SRC, 'utf8');
    const lines = source.split('\n');
    const listStart = source.indexOf('const CACHE_JUDGE_FINGERPRINT_SOURCES');
    // 去注释后取标识符：清单注释里的词（如「D6 池噪声」）不是判据名
    const listText = source.slice(listStart, source.indexOf('];', listStart)).replace(/\/\/[^\n]*/gu, '');
    const registered = new Set(
      [...listText.matchAll(/(?<![.\w$])([a-zA-Z_$][\w$]*)\b/gu)].map(match => match[1])
        .filter(name => !['const', 'CACHE_JUDGE_FINGERPRINT_SOURCES', 'ReadonlyArray', 'unknown'].includes(name)),
    );
    const fnDecls = new Map<string, number>();
    const constDecls = new Map<string, number>();
    lines.forEach((line, index) => {
      const fn = /^(?:export )?(?:async )?function ([a-zA-Z_$][\w$]*)/u.exec(line);
      if (fn) fnDecls.set(fn[1]!, index);
      const constant = /^const ([a-zA-Z_$][\w$]*)/u.exec(line);
      if (constant) constDecls.set(constant[1]!, index);
    });
    const fnBody = (name: string): string | undefined => {
      const start = fnDecls.get(name);
      if (start === undefined) return undefined;
      for (let index = start + 1; index < lines.length; index += 1) {
        if (/^\}/u.test(lines[index]!)) return lines.slice(start, index + 1).join('\n');
      }
      return undefined;
    };
    // 模块级「表」常量（正则字面量 / 数组 / 对象；类型注解可能跨行，声明后 6 行内找 `=`）
    const isTableConst = (name: string): boolean => {
      const start = constDecls.get(name);
      if (start === undefined) return false;
      for (let index = start; index < Math.min(lines.length, start + 7); index += 1) {
        if (/=\s*\[/u.test(lines[index]!) || /=\s*\/.*\/[a-z]*;?\s*$/u.test(lines[index]!) || /=\s*\{/u.test(lines[index]!)) return true;
      }
      return false;
    };
    const identifiers = (text: string) => [...new Set([...text.matchAll(/(?<![.\w$])([a-zA-Z_$][\w$]*)\b/gu)].map(match => match[1]!))];
    // 传递闭包：入表判据 → 本文件内被调用的函数 → …，逐层收集其引用的表常量
    const reachable = new Set<string>();
    const missingTables = new Map<string, string>();
    for (const entry of registered) {
      const queue = [entry];
      const seen = new Set([entry]);
      while (queue.length > 0) {
        const name = queue.shift()!;
        const body = fnBody(name);
        if (body === undefined) continue;
        reachable.add(name);
        for (const id of identifiers(body)) {
          if (fnDecls.has(id)) {
            if (!seen.has(id)) { seen.add(id); queue.push(id); }
          } else if (registered.has(id)) {
            continue;
          } else if (isTableConst(id)) {
            if (!missingTables.has(id)) missingTables.set(id, entry);
          }
        }
      }
    }
    // 提取有效性下限（格式化变更导致解析失效时须显式报错，不得静默放过）
    expect(reachable.size, '判据函数体解析失效（源格式变更）').toBeGreaterThan(8);
    const missing = [...missingTables.entries()];
    for (const [table, via] of missing) {
      expect(registered.has(table), `词表/规则表 ${table}（经 ${via} 使用）未入 CACHE_JUDGE_FINGERPRINT_SOURCES（编辑该表将不失效缓存）`).toBe(true);
    }
  });
});

describe('collectRequirementAnchors（条款锚点全清单单源）', () => {
  it('coreTerms 数字复合词分解 + 数字单位锚点 + 具名奖项（前导动词剥离）', () => {
    const anchors = collectRequirementAnchors({
      text: '确保一次性成活率95%，工期120天，争创黄山杯。',
      coreTerms: ['一次性成活率95%', '黄山杯'],
    });
    expect(anchors).toEqual(expect.arrayContaining(['一次性成活率', '95%', '120天', '黄山杯']));
    expect(anchors).not.toContain('确保黄山杯');
    expect(anchors).not.toContain('争创黄山杯');
  });

  it('引用性词（文号/行政文件名）不作锚点；「N.N项」编号切片丢弃而整数+项保留', () => {
    const anchors = collectRequirementAnchors({
      text: '按《XX市建设工程施工招标投标管理办法》执行，包含1.1项目名称及3项保证措施。',
      coreTerms: ['XX市建设工程施工招标投标管理办法', '施工招标'],
    });
    expect(anchors).toContain('施工招标');
    expect(anchors).toContain('3项');
    expect(anchors).not.toContain('1.1项');
    expect(anchors.some(anchor => anchor.includes('管理办法'))).toBe(false);
  });

  it('skipNumericAnchors 跳过商务数字参数；长度 <2 的 coreTerms 过滤', () => {
    expect(collectRequirementAnchors({ text: '工期120天。', coreTerms: ['工'] })).toEqual(['120天']);
    expect(collectRequirementAnchors({ text: '工期120天。', coreTerms: [] }, { skipNumericAnchors: true })).toEqual([]);
  });

  it('全角百分号归一（coreTerms 与条款原文同源，写作侧半角不假 miss）', () => {
    const anchors = collectRequirementAnchors({ text: '成活率95％以上。', coreTerms: ['成活率95％'] });
    expect(anchors).toEqual(expect.arrayContaining(['成活率', '95%']));
    expect(anchors.every(anchor => !anchor.includes('％'))).toBe(true);
  });
});

describe('4.55.12 答疑残片出池 + 资料载体残片清理（巢湖实测）', () => {
  it('答疑对答行出池（「答：三级钢，见图纸说明7.4.1。门卫同。」不入要求池）', () => {
    expect(isRequirementPoolNoiseClause('答：三级钢，见图纸说明7.4.1。门卫同。')).toBe(true);
    expect(isRequirementPoolNoiseClause('答复：按设计图纸执行')).toBe(true);
    expect(isRequirementPoolNoiseClause('回复：同意调整')).toBe(true);
  });

  it('正常招标要求不受影响（入池判定未被过宽扩围）', () => {
    expect(isRequirementPoolNoiseClause('确保工程质量达到合格标准并通过一次验收')).toBe(false);
    expect(isRequirementPoolNoiseClause('计划工期 330 日历天，开工日期以开工令为准')).toBe(false);
  });

  it('答疑残片段整行删除（含无长度门槛的短答案行）', () => {
    const md = ['施工组织总述如下。', '', '答：均改为2：8灰土回填', '', '本工程按上述要求组织实施。'].join('\n');
    const result = fixFormalSourceResidue(md);
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).not.toContain('答：');
    expect(result.markdown).toContain('施工组织总述如下。');
  });

  it('图纸 OCR 密集残片段与数值堆砌残句删除（正常数据罗列不受影响）', () => {
    const ocr = '盖板规格表盖板型号盖板覆土厚板厚h混凝土(m)(mm)(m³)J01B1-10.8≤Hs≤2.01400.271801004@20010018050J01B1-2④①钢筋表18080';
    const listing = '本工程关键工程参数还包括：80kPa、DN1000-2、55kPa、13.5平方米、22天、28天、56天、15万元、1.5%、1.0%、1.1%、0.8%、0.7%、0.45%、0.55%、0.5%、0.25%、0.35%、0.1%、6000万元、100万元、1.0万元、2.8万元、2.75万元、14万元、2万元、10万元、50万元、10天、60天、5000元、3.4项、1.1项、3年、21.1人、20万元、2000元、12个、4份、1份、1.4项、6个、18个、24个、4.3项、4.4项、JC-07、JC-08、JC-09。';
    const normal = '1#厂房电气施工涉及配电箱70台、桥架2811m、配管21034.6m、电力电缆12998.83m、电力电缆头170个及各类灯具1222套。';
    const result = fixFormalSourceResidue([normal, ocr, listing].join('\n'));
    expect(result.fixedCount).toBe(2);
    expect(result.markdown).toContain('配电箱70台');
    expect(result.markdown).not.toContain('盖板规格表');
    expect(result.markdown).not.toContain('JC-09');
  });

  it('标题行/表格行豁免（表格是数据形态，由表结构治理链负责）', () => {
    const md = ['#### 1.2.3 防水做法', '| 名称 | 规格 | 数量 |', '| --- | --- | --- |'].join('\n');
    const result = fixFormalSourceResidue(md);
    expect(result.fixedCount).toBe(0);
    expect(result.markdown).toBe(md);
  });

  it('幂等：重复调用不产生二次改写', () => {
    const md = '答：钢质单扇甲级防火门，门洞尺寸1100*2400mm。\n正常段落内容。';
    const once = fixFormalSourceResidue(md).markdown;
    expect(fixFormalSourceResidue(once).fixedCount).toBe(0);
  });
});

describe('4.55.12 残片判据防误伤（CAD 标注行 = 图纸真实事实载体，不得删除）', () => {
  it('CAD 标注行（含基坑底标高等图纸事实）不判残片', () => {
    const cad = '└── 标注文本: 15.65(基坑底标高) | 关联对象: 邻近标注 坡率 1:1.0 | 状态: 普通标注';
    expect(isMaterialResidueLine(cad)).toBe(false);
    expect(fixFormalSourceResidue(cad).fixedCount).toBe(0);
  });
  it('正文数据罗列行不判残片（正常工程数据句）', () => {
    const normal = '1#厂房电气施工涉及配电箱70台、桥架2811m、配管21034.6m、电力电缆12998.83m、电力电缆头170个及各类灯具1222套。';
    expect(isMaterialResidueLine(normal)).toBe(false);
  });
  it('OCR 表格密集串与纯参数堆砌行判残片', () => {
    expect(isMaterialResidueLine('盖板规格表盖板型号盖板覆土厚板厚h混凝土(m)(mm)(m³)J01B1-10.8≤Hs≤2.01400.271801004@20010018050J01B1-2④①钢筋表18080')).toBe(true);
    expect(isMaterialResidueLine('本工程关键工程参数还包括：80kPa、55kPa、22天、28天、56天、15万元、1.5%、1.0%、1.1%、0.8%、6000万元、100万元、10天、60天、12个、4份、6个、18个、24个。')).toBe(true);
  });
});

describe('4.55.19 句中资料残片（澄清表残片以句子出现）', () => {
  it('「现澄清为如下：条款号条款号…编列内容编列内容…」整句移除', () => {
    const md = '本工程总工期为365日历天，现澄清为如下：条款号条款号条款名称条款名称编列内容编列内容1.3.2计划工期计划开工日期：2026年10月10日。项目部按上述要求组织施工。';
    const result = fixFormalSourceResidue(md);
    expect(result.markdown).not.toContain('编列内容');
    expect(result.markdown).not.toContain('条款号');
    expect(result.markdown).toContain('项目部按上述要求组织施工');
  });

  it('正常正文不受影响（无残片零改动）', () => {
    const md = '项目部按施工组织设计组织流水施工，各工序衔接紧密。';
    const result = fixFormalSourceResidue(md);
    expect(result.fixedCount).toBe(0);
    expect(result.markdown).toBe(md);
  });
});

/**
 * 4.58 R4 标准/图集代号不作锚点（实测 `doc-1790168542563-ea526b1b`）。
 *
 * coreTerm `23S516` 走「含数字复合词分解」（本为 `一次性成活率95%` → `…+95%` 设计）被切成
 * `23S` + `516` 两个**无意义碎片**，正文写全 `23S516` 也命中不了 → 报
 * 「招标要求部分响应：…已命中『密闭性试验』，但缺少『23S、516』」。
 */
describe('4.58 R4 标准/图集代号不作锚点', () => {
  it('图集号 23S516 不再被切成 23S + 516 碎片', () => {
    const anchors = collectRequirementAnchors({ text: '排水管道基础详见《混凝土排水管道基础及接口》23S516', coreTerms: ['23S516'] });
    expect(anchors).not.toContain('23S');
    expect(anchors).not.toContain('516');
    expect(anchors).toEqual([]);
  });

  it('规范号（GB/JGJ/DB）同样不作锚点', () => {
    for (const code of ['GB50242', 'JGJ94', 'DB34/T4289', '20S515', '12J201']) {
      expect(collectRequirementAnchors({ text: `执行${code}的规定`, coreTerms: [code] }), code).toEqual([]);
    }
  });

  it('**防过度**：真复合词（成活率95%）仍分解为两锚点', () => {
    const anchors = collectRequirementAnchors({ text: '苗木一次性成活率95%以上', coreTerms: ['一次性成活率95%'] });
    expect(anchors).toContain('一次性成活率');
    expect(anchors).toContain('95%');
  });

  it('**防过度**：普通专有名词锚点不受影响', () => {
    expect(collectRequirementAnchors({ text: '抗震支吊架安装', coreTerms: ['抗震支吊架'] })).toContain('抗震支吊架');
  });
});
