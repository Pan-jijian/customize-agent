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
vi.mock('@/services/document-workflow/semanticSimilarity', () => ({ buildSemanticSimilarity: vi.fn() }));

import type * as LlmClientModule from '@/services/document-workflow/llmClient';
import { callDocumentLlmJson } from '@/services/document-workflow/llmClient';
import {
  assignTenderRequirementsToChapters,
  emptyTenderRequirements,
  extractTenderRequirements,
  fixTenderMetaLanguage,
  hasTenderRequirements,
  judgeTenderClauses,
  readCachedTenderRequirements,
  renderChapterRequirementSlice,
  requirementAcceptanceIssues,
  routeTenderRequirementsToChapters,
  saveRequirementAssignmentsAsset,
  splitTenderClauses,
  stripDuplicateResponseLines,
  tenderRequirementCheckItems,
  tenderRequirementSemanticQuery,
  tenderRequirementsCacheKey,
  tenderRequirementsSummary,
  tenderRequirementsWritingRules,
  writeCachedTenderRequirements,
} from '@/services/document-workflow/tenderRequirements';
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
    expect(model.reconciliation).toEqual({ clauseCount: 2, entryCount: 2, excludedCount: 0, undecidedCount: 0, mergedCount: 0, batchCount: 1, retriedBatches: 0 });
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
    expect(model.reconciliation).toEqual({ clauseCount: 2, entryCount: 1, excludedCount: 0, undecidedCount: 0, mergedCount: 1, batchCount: 1, retriedBatches: 0 });
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
    expect(model.reconciliation).toEqual({ clauseCount: 2, entryCount: 0, excludedCount: 0, undecidedCount: 2, mergedCount: 0, batchCount: 1, retriedBatches: 1 });
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
  });

  it('分配落盘：审计资产写入 generatedDocuments/assets/requirement-assignments.json', () => {
    const a = assignment(entry('创优目标：确保获得黄山杯。', ['黄山杯'], 'respond', '质量创优'), '第五章 施工组织管理');
    const assetPath = saveRequirementAssignmentsAsset(tempRoot, [a]);
    expect(assetPath).toContain(path.join('assets', 'requirement-assignments.json'));
    const parsed = JSON.parse(fs.readFileSync(assetPath, 'utf8')) as { total: number; assignments: Array<{ chapterTitle: string }> };
    expect(parsed.total).toBe(1);
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
