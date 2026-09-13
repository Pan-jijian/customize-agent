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
import { validateJsonAgainstSchema } from '@/services/document-workflow/llmClient';
import { buildSemanticSimilarity } from '@/services/document-workflow/semanticSimilarity';
import { emptyTenderRequirements, extractTenderRequirements, extractRequirementFieldGaps, filterMandatoryClauseEvidence, hasTenderRequirements, mandatoryFieldGaps, mergeTenderRequirements, mergeTenderRequirementSlices, missingMandatoryFields, preselectTenderRequirementEvidence, readCachedTenderRequirements, requirementFieldGaps, requirementsCoverageIssues, tenderRequirementsCacheKey, tenderRequirementsWritingRules, writeCachedTenderRequirements, classifyRequirementResponsiveness, classifyAnchorAlternativeClauses, fixScoringRequirementResponses, fixScoringRequirementResponsesInFinalMarkdown, fixTenderMetaLanguage, stripDuplicateResponseLines, REQUIREMENTS_JSON_SCHEMA } from '@/services/document-workflow/tenderRequirements';
import { stableHash } from '@/services/document-workflow/utils';
import type { DocumentEvidence, TenderRequirementModel } from '@/services/document-workflow/types';

const evidence: DocumentEvidence[] = [
  { chapterId: 'tender-requirements', filePath: '9.4合肥师范学院新一代信息技术产教融合实训基地项目/招标文件.pdf', sectionTitle: '第三章评标办法', score: 1, content: '评标办法采用综合评估法（模式3）；技术文件5分、商务文件10分、报价文件85分；优秀得4.5分≤F≤5分。' },
];

// 复现自真实 deepseek 输出：awardClauses[0].text 为 85 字符，旧 maxLength=80 会校验失败 → undefined → 空模型 → skipped
const realModelOutput = {
  awardObjectives: [{ text: '创优目标：确保黄山杯。', coreTerms: ['黄山杯'], source: '招标文件.pdf' }],
  specialQualityStandards: [{ text: '特殊质量标准和要求：确保黄山杯。', coreTerms: ['黄山杯'], source: '招标文件.pdf' }],
  awardClauses: [{ text: '关于工程奖项的约定：本项目确保获得“黄山杯”。获得“黄山杯”的，支付该项300万元（工程量清单中已单独列项）；自竣工验收合格之日起3年内未获得“黄山杯”的，该项不予支付。', coreTerms: ['黄山杯', '300万元'], source: '招标文件.pdf' }],
  greenBuildingGrade: { text: '绿色建筑等级要求：达到国标二星级。', coreTerms: ['二星级'], source: '招标文件.pdf' },
  smartSiteGrade: { text: '智慧工地管理要求：基本级。', coreTerms: ['基本级'], source: '招标文件.pdf' },
  assemblyRate: { text: '本工程有装配式技术要求，装配率为30%。', coreTerms: ['装配率', '30%'], source: '招标文件.pdf' },
  systematicBenchmarks: [],
  dateFabricationProhibited: true,
  prohibitionNotes: [{ text: '计划工期：开工之日（以开工令时间为准）起，540个日历天。', coreTerms: ['开工令'], source: '招标文件.pdf' }],
};

describe('extractTenderRequirements 回归（round-21 S6：schema 超长失败修复）', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('真实模型输出（奖项条款 85 字超旧上限 80）能通过放宽后的 schema 校验', async () => {
    // 直接验证校验层：旧 maxLength=80 时该输出会报“字段 $.awardClauses[0].text 长度超限”
    const errors = validateJsonAgainstSchema(realModelOutput, REQUIREMENTS_JSON_SCHEMA);
    expect(errors).toEqual([]);
  });

  it('真实模型输出能被正确解析并生成写作规则', async () => {
    const mocked = vi.mocked(callDocumentLlmJson);
    mocked.mockResolvedValueOnce(realModelOutput);
    const model = await extractTenderRequirements(evidence, {});
    expect(hasTenderRequirements(model)).toBe(true);
    expect(model.awardClauses.length).toBe(1);
    expect(model.awardClauses[0].text).toContain('300万元');
    expect(model.dateFabricationProhibited).toBe(true);
    const rules = tenderRequirementsWritingRules(model);
    expect(rules).toContain('黄山杯');
  });

  it('LLM 返回 undefined 时返回空模型（零响应降级，不抛错）', async () => {
    const mocked = vi.mocked(callDocumentLlmJson);
    mocked.mockResolvedValueOnce(undefined);
    const model = await extractTenderRequirements(evidence, {});
    expect(hasTenderRequirements(model)).toBe(false);
  });

  it('无值条款表述（值为无/勾选无/数据表占位）被丢弃不入模型（真实回归：新版招标文件「绿色建筑等级要求：无」被当字段值污染下游）', async () => {
    const mocked = vi.mocked(callDocumentLlmJson);
    mocked.mockResolvedValueOnce({
      awardObjectives: [{ text: '创优目标：无', coreTerms: [], source: '前附表10.9' }],
      specialQualityStandards: [{ text: '特殊质量标准和要求：无。', coreTerms: [], source: '数据表5.1.1' }],
      awardClauses: [{ text: '关于工程奖项的约定：本项目确保获得“黄山杯”。获得“黄山杯”的，支付该项300万元。', coreTerms: ['黄山杯'], source: '数据表5.1.1' }],
      greenBuildingGrade: { text: '绿色建筑等级要求：无', coreTerms: [], source: '数据表5.1.1' },
      smartSiteGrade: { text: '智慧工地管理要求：无', coreTerms: [], source: '数据表5.1.1' },
      assemblyRate: { text: '装配式建筑装配率要求：无', coreTerms: [], source: '数据表5.1.1' },
      frontScheduleClauses: [{ text: '特殊质量标准和要求：见《专用合同条款数据表》', coreTerms: [], source: '正文5.1' }],
    });
    const model = await extractTenderRequirements(evidence, {});
    expect(model.awardObjectives.length).toBe(0);
    expect(model.specialQualityStandards.length).toBe(0);
    expect(model.awardClauses.length).toBe(1);
    expect(model.awardClauses[0].text).toContain('300万元');
    expect(model.greenBuildingGrade).toBeUndefined();
    expect(model.smartSiteGrade).toBeUndefined();
    expect(model.assemblyRate).toBeUndefined();
    expect(model.frontScheduleClauses.length).toBe(0);
  });

  it('空证据直接返回空模型', async () => {
    const model = await extractTenderRequirements([], {});
    expect(model).toEqual(emptyTenderRequirements(false));
    expect(vi.mocked(callDocumentLlmJson)).not.toHaveBeenCalled();
  });
});

// ============ round-23 P0-1/P0-2：必提条款窄通道与奖项忠实性 ============

const fullModel: TenderRequirementModel = {
  ...emptyTenderRequirements(true),
  awardObjectives: [{ text: '创优目标：确保黄山杯。', coreTerms: ['黄山杯'], source: '招标文件.pdf' }],
  awardClauses: [{ text: '本项目确保获得“黄山杯”。获得“黄山杯”的，支付该项300万元。', coreTerms: ['黄山杯', '300万元'], source: '招标文件.pdf' }],
  greenBuildingGrade: { text: '绿色建筑等级要求：达到国标二星级。', coreTerms: ['二星级'], source: '招标文件.pdf' },
  smartSiteGrade: { text: '智慧工地管理要求：基本级。', coreTerms: ['基本级'], source: '招标文件.pdf' },
  assemblyRate: { text: '装配率：30%。', coreTerms: ['30%'], source: '招标文件.pdf' },
  systematicBenchmarks: [{ text: '施工组织设计采用图表结合形式。', coreTerms: ['图表结合'], source: '招标文件.pdf' }],
};

describe('round-23 P0-1 必提条款窄通道召回/缺失判定/合并', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('filterMandatoryClauseEvidence 召回创优/绿色词形候选，滤掉纯程序性切片', async () => {
    const candidates: DocumentEvidence[] = [
      { chapterId: 'tender-requirements', filePath: '招标文件.pdf', sectionTitle: '投标人须知前附表10.9', score: 1, content: '有，具体要求如下：确保黄山杯。' },
      { chapterId: 'tender-requirements', filePath: '招标文件.pdf', sectionTitle: '第七章技术标准', score: 1, content: '本项目绿色建筑等级为国标二星级，智慧工地基本级。' },
      { chapterId: 'tender-requirements', filePath: '招标文件.pdf', sectionTitle: '投标人须知', score: 1, content: '开标时间为2026年5月15日9时，评标委员会由5人组成。' },
    ];
    // 语义召回 mock：必提条款特征切片命中（黄山杯/二星级），纯程序性切片低分滤掉
    vi.mocked(buildSemanticSimilarity).mockResolvedValue(((_left: string, right: string) => (/黄山杯|二星级/u.test(right) ? 0.8 : 0.1)) as unknown as ReturnType<typeof buildSemanticSimilarity> extends Promise<infer F> ? F : never);
    const result = await filterMandatoryClauseEvidence(candidates);
    expect(result.length).toBe(2);
    expect(result[0].content).toContain('确保黄山杯');
    expect(result[1].content).toContain('二星级');
  });

  it('filterMandatoryClauseEvidence 清洗 PDF 标题标记噪声（平方###米夹断）', async () => {
    const candidates: DocumentEvidence[] = [
      { chapterId: 'tender-requirements', filePath: '招标文件.pdf', sectionTitle: '专用合同条款', score: 1, content: '关于工程奖项的约定：本项目确保获得“黄山杯”，单体建筑面积28570.36平方\n\n### 米（其中：地上建筑面积24783.39平方米）。' },
    ];
    vi.mocked(buildSemanticSimilarity).mockResolvedValue((() => 0.8) as unknown as ReturnType<typeof buildSemanticSimilarity> extends Promise<infer F> ? F : never);
    const result = await filterMandatoryClauseEvidence(candidates);
    expect(result.length).toBe(1);
    expect(result[0].content).not.toContain('###');
    expect(result[0].content).toContain('28570.36平方米');
  });

  it('missingMandatoryFields：必提字段任一缺失为 true（触发窄通道），全部齐全为 false（真实生成回归：黄山杯单独漏提）', () => {
    expect(missingMandatoryFields(undefined)).toBe(true);
    expect(missingMandatoryFields(emptyTenderRequirements(true))).toBe(true);
    const withAwardOnly = { ...emptyTenderRequirements(true), awardObjectives: [{ text: '确保黄山杯', coreTerms: ['黄山杯'] }] };
    expect(missingMandatoryFields(withAwardOnly)).toBe(true);
    const withGreenOnly = { ...emptyTenderRequirements(true), greenBuildingGrade: { text: '二星级', coreTerms: ['二星级'] } };
    expect(missingMandatoryFields(withGreenOnly)).toBe(true);
    expect(missingMandatoryFields(fullModel)).toBe(false);
  });

  // ============ round-26 字段级缺口检测与定向补提闭环 ============
  it('mandatoryFieldGaps：字段级缺失清单（空模型全 6 字段，部分缺失仅列缺失项，全齐空数组）', () => {
    expect(mandatoryFieldGaps(undefined)).toEqual(['awardObjectives', 'awardClauses', 'greenBuildingGrade', 'smartSiteGrade', 'assemblyRate', 'systematicBenchmarks']);
    expect(mandatoryFieldGaps(emptyTenderRequirements(true))).toEqual(['awardObjectives', 'awardClauses', 'greenBuildingGrade', 'smartSiteGrade', 'assemblyRate', 'systematicBenchmarks']);
    const withAwardOnly = { ...emptyTenderRequirements(true), awardObjectives: [{ text: '确保黄山杯', coreTerms: ['黄山杯'] }] };
    expect(mandatoryFieldGaps(withAwardOnly)).toEqual(['awardClauses', 'greenBuildingGrade', 'smartSiteGrade', 'assemblyRate', 'systematicBenchmarks']);
    const missingAssembly = { ...fullModel, assemblyRate: undefined };
    expect(mandatoryFieldGaps(missingAssembly)).toEqual(['assemblyRate']);
    expect(mandatoryFieldGaps(fullModel)).toEqual([]);
  });

  it('requirementFieldGaps：全字段缺失清单（覆盖全部评分项要求字段，评标办法/篇幅不在其中）', () => {
    // 空模型：全部 10 个评分项要求字段（必提 6 + 特殊质量/前附表/禁编/禁止性）均为缺失
    expect(requirementFieldGaps(undefined)).toEqual([
      'awardObjectives', 'specialQualityStandards', 'awardClauses', 'greenBuildingGrade', 'smartSiteGrade',
      'assemblyRate', 'systematicBenchmarks', 'frontScheduleClauses', 'dateFabricationProhibited', 'prohibitionNotes',
    ]);
    // 常规字段齐全 → 空清单；缺任一常规字段 → 只列该字段（非仅必提字段）
    const completeOptional = {
      ...fullModel,
      specialQualityStandards: [{ text: '特殊质量标准：按最高标准执行。', coreTerms: ['最高标准'] }],
      frontScheduleClauses: [{ text: '计划工期：540日历天。', coreTerms: ['540日历天'] }],
      dateFabricationProhibited: true,
      prohibitionNotes: [{ text: '不得转包。', coreTerms: ['转包'] }],
    };
    expect(requirementFieldGaps(completeOptional)).toEqual([]);
    expect(requirementFieldGaps({ ...completeOptional, specialQualityStandards: [] })).toEqual(['specialQualityStandards']);
    expect(requirementFieldGaps({ ...completeOptional, dateFabricationProhibited: false })).toEqual(['dateFabricationProhibited']);
  });

  it('extractRequirementFieldGaps：窗口聚焦提取补齐缺失字段（LLM 一次调用覆盖全部有窗口的缺失字段）', async () => {
    const mocked = vi.mocked(callDocumentLlmJson);
    const model = { ...fullModel, awardClauses: [], assemblyRate: undefined };
    mocked.mockResolvedValueOnce({
      awardClauses: [{ text: '获得“黄山杯”的，支付该项300万元。', coreTerms: ['300万元'] }],
      assemblyRate: { text: '装配率：30%。', coreTerms: ['30%'] },
      frontScheduleClauses: [{ text: '获得“黄山杯”的，支付该项300万元。', coreTerms: ['黄山杯', '300万元'] }],
    });
    const gapEvidence: DocumentEvidence[] = [
      { chapterId: 'tender-requirements', filePath: '招标文件.pdf', sectionTitle: '专用合同条款数据表5.1.1', score: 1, content: '关于工程奖项的约定：本项目确保获得“黄山杯”。获得“黄山杯”的，支付该项300万元；本工程有装配式技术要求，装配率为30%。' },
    ];
    const result = await extractRequirementFieldGaps(model, gapEvidence, {});
    expect(result.stillGaps).toEqual([]);
    // 证据中无窗口命中的 3 个常规字段归 noEvidenceGaps（资料无此要求，非漏提）；
    // 前附表词形覆盖创优奖惩（黄山杯/支付300万元）→ 窗口命中参与补提，不再失明
    expect(result.noEvidenceGaps).toEqual(['specialQualityStandards', 'dateFabricationProhibited', 'prohibitionNotes']);
    expect(result.model.awardClauses.length).toBe(1);
    expect(result.model.awardClauses[0].text).toContain('300万元');
    expect(result.model.assemblyRate?.text).toContain('30%');
    expect(result.model.awardObjectives.length).toBe(1);
    expect(result.model.frontScheduleClauses.length).toBe(1);
    expect(result.model.frontScheduleClauses[0].text).toContain('300万元');
  });

  it('extractRequirementFieldGaps：常规字段（特殊质量标准/前附表/禁止性/禁编）缺失同样触发补提', async () => {
    const mocked = vi.mocked(callDocumentLlmJson);
    // fullModel 缺 4 个常规字段 → 全部进入补提窗口
    const model = { ...fullModel };
    mocked.mockResolvedValueOnce({
      specialQualityStandards: [{ text: '特殊质量标准和要求：按最高标准执行。', coreTerms: ['最高标准'] }],
      prohibitionNotes: [{ text: '不得转包、违法分包。', coreTerms: ['转包'] }],
      dateFabricationProhibited: true,
      frontScheduleClauses: [{ text: '不得转包、违法分包。', coreTerms: ['转包'] }],
    });
    const gapEvidence: DocumentEvidence[] = [
      { chapterId: 'tender-requirements', filePath: '招标文件.pdf', sectionTitle: '专用合同条款', score: 1, content: '特殊质量标准和要求：按最高标准执行；不得转包、违法分包；开工日期以开工令为准。' },
    ];
    const result = await extractRequirementFieldGaps(model, gapEvidence, {});
    expect(result.stillGaps).toEqual([]);
    expect(result.noEvidenceGaps).toEqual([]);
    expect(result.model.specialQualityStandards.length).toBe(1);
    expect(result.model.prohibitionNotes.length).toBe(1);
    expect(result.model.dateFabricationProhibited).toBe(true);
    expect(result.model.frontScheduleClauses.length).toBe(1);
  });

  it('extractRequirementFieldGaps：窗口无证据字段判定「资料无此要求」（不误告警、不空跑 LLM）', async () => {
    const mocked = vi.mocked(callDocumentLlmJson);
    const model = { ...fullModel, greenBuildingGrade: undefined };
    const gapEvidence: DocumentEvidence[] = [
      { chapterId: 'tender-requirements', filePath: '招标文件.pdf', sectionTitle: '投标人须知', score: 1, content: '开标时间为2026年5月15日9时，评标委员会由5人组成。' },
    ];
    const result = await extractRequirementFieldGaps(model, gapEvidence, {});
    // stillGaps 与 noEvidenceGaps 互斥：全部缺口无窗口命中 → 全归 noEvidence，无真漏提告警
    expect(result.stillGaps).toEqual([]);
    expect(result.noEvidenceGaps).toEqual(['specialQualityStandards', 'greenBuildingGrade', 'frontScheduleClauses', 'dateFabricationProhibited', 'prohibitionNotes']);
    expect(result.model.greenBuildingGrade).toBeUndefined();
    expect(mocked).not.toHaveBeenCalled();
  });

  it('extractRequirementFieldGaps：LLM 两轮均提取失败仍缺失（真漏提告警，不无限循环）', async () => {
    const mocked = vi.mocked(callDocumentLlmJson);
    const model = { ...fullModel, awardObjectives: [] };
    // 两轮 LLM 均返回空（输出有效但未含该字段）
    mocked.mockResolvedValue({});
    const gapEvidence: DocumentEvidence[] = [
      { chapterId: 'tender-requirements', filePath: '招标文件.pdf', sectionTitle: '专用合同条款', score: 1, content: '创优目标：本项目确保获得“黄山杯”。' },
    ];
    const result = await extractRequirementFieldGaps(model, gapEvidence, {});
    // 创优目标与前附表窗口证据均存在但提取失败 → stillGaps；其余 3 常规字段无窗口 → noEvidenceGaps
    expect(result.stillGaps).toEqual(['awardObjectives', 'frontScheduleClauses']);
    expect(result.noEvidenceGaps).toEqual(['specialQualityStandards', 'dateFabricationProhibited', 'prohibitionNotes']);
    expect(mocked).toHaveBeenCalledTimes(2);
  });

  it('extractRequirementFieldGaps：条款值为「无」的命中句不产生窗口（勾选无/值为无归「资料无此要求」，零 LLM 调用零误报）', async () => {
    const mocked = vi.mocked(callDocumentLlmJson);
    // 真实回归：新版招标文件前附表10.9「创优目标 ☑无」、数据表5.1.1「关于工程奖项的约定：无」
    // 词形命中窗口，LLM 正确输出空数组，旧逻辑误报「条款窗口证据存在但 LLM 提取失败」
    const model = {
      ...fullModel,
      awardObjectives: [],
      awardClauses: [],
      greenBuildingGrade: undefined,
      smartSiteGrade: undefined,
      assemblyRate: undefined,
    };
    const gapEvidence: DocumentEvidence[] = [
      { chapterId: 'tender-requirements', filePath: '招标文件.pdf', sectionTitle: '投标人须知前附表10.9', score: 1, content: '10.9 创优目标 ☑无 □有，具体要求如下： /' },
      { chapterId: 'tender-requirements', filePath: '招标文件.pdf', sectionTitle: '专用合同条款数据表5.1.1', score: 1, content: '5.1.1 特殊质量标准和要求：无。关于工程奖项的约定：无。绿色建筑等级要求：无；智慧工地管理要求：无；装配式建筑装配率要求：无。' },
    ];
    const result = await extractRequirementFieldGaps(model, gapEvidence, {});
    expect(result.stillGaps).toEqual([]);
    expect(result.noEvidenceGaps).toEqual(['awardObjectives', 'specialQualityStandards', 'awardClauses', 'greenBuildingGrade', 'smartSiteGrade', 'assemblyRate', 'frontScheduleClauses', 'dateFabricationProhibited', 'prohibitionNotes']);
    expect(result.model.awardObjectives.length).toBe(0);
    expect(result.model.awardClauses.length).toBe(0);
    expect(mocked).not.toHaveBeenCalled();
  });

  it('extractRequirementFieldGaps：混合否定/肯定窗口——值为无的命中句跳过，有值条款正常参与补提', async () => {
    const mocked = vi.mocked(callDocumentLlmJson);
    const model = { ...fullModel, awardObjectives: [], awardClauses: [] };
    // 创优目标 ☑无 句被跳过（不产生窗口）；奖项约定句含「确保获得黄山杯」→ 创优目标/奖项条款/前附表窗口均有值，一次调用全部提取
    mocked.mockResolvedValueOnce({
      awardObjectives: [{ text: '创优目标：确保获得“黄山杯”。', coreTerms: ['黄山杯'] }],
      awardClauses: [{ text: '获得“黄山杯”的，支付该项300万元。', coreTerms: ['300万元'] }],
      frontScheduleClauses: [{ text: '本项目确保获得“黄山杯”。获得“黄山杯”的，支付该项300万元。', coreTerms: ['黄山杯', '300万元'] }],
    });
    const gapEvidence: DocumentEvidence[] = [
      { chapterId: 'tender-requirements', filePath: '招标文件.pdf', sectionTitle: '投标人须知前附表10.9', score: 1, content: '10.9 创优目标 ☑无 □有，具体要求如下： /' },
      { chapterId: 'tender-requirements', filePath: '招标文件.pdf', sectionTitle: '专用合同条款数据表5.1.1', score: 1, content: '关于工程奖项的约定：本项目确保获得“黄山杯”。获得“黄山杯”的，支付该项300万元（工程量清单中已单独列项）。' },
    ];
    const result = await extractRequirementFieldGaps(model, gapEvidence, {});
    expect(result.stillGaps).toEqual([]);
    // ☑无 句不产生窗口；无窗口命中的常规字段归 noEvidence，创优/奖项字段均正常补提
    expect(result.noEvidenceGaps).toEqual(['specialQualityStandards', 'dateFabricationProhibited', 'prohibitionNotes']);
    expect(result.model.awardClauses.length).toBe(1);
    expect(result.model.awardClauses[0].text).toContain('300万元');
    expect(result.model.awardObjectives.length).toBe(1);
  });

  it('extractRequirementFieldGaps：前附表词形覆盖创优奖惩条款（300万根治：无工期/人员词形时窗口定位不失明）', async () => {
    const mocked = vi.mocked(callDocumentLlmJson);
    // fullModel 缺 4 个常规字段；证据只有创优奖惩条款（无计划工期/项目经理/分包等旧词形）
    const model = { ...fullModel };
    mocked.mockResolvedValueOnce({
      frontScheduleClauses: [{ text: '本项目确保获得“黄山杯”。获得“黄山杯”的，支付该项300万元。', coreTerms: ['黄山杯', '300万元'] }],
    });
    const gapEvidence: DocumentEvidence[] = [
      { chapterId: 'tender-requirements', filePath: '招标文件.pdf', sectionTitle: '投标人须知前附表', score: 1, content: '创优目标与奖惩：本项目确保获得“黄山杯”。获得“黄山杯”的，支付该项300万元（工程量清单中已单独列项）。' },
    ];
    const result = await extractRequirementFieldGaps(model, gapEvidence, {});
    // 前附表窗口命中 → 发起补提而非判「资料无此要求」；其余 3 字段无窗口 → noEvidenceGaps
    expect(mocked).toHaveBeenCalledTimes(1);
    expect(result.stillGaps).toEqual([]);
    expect(result.noEvidenceGaps).toEqual(['specialQualityStandards', 'dateFabricationProhibited', 'prohibitionNotes']);
    expect(result.model.frontScheduleClauses.length).toBe(1);
    expect(result.model.frontScheduleClauses[0].text).toContain('300万元');
  });

  it('filterMandatoryClauseEvidence 词形兜底：语义召回全低分时，必提词形命中切片仍保留（真实生成回归：黄山杯长段落切片 bge 低分漏网）', async () => {
    const candidates: DocumentEvidence[] = [
      { chapterId: 'tender-requirements', filePath: '招标文件.pdf', sectionTitle: '专用合同条款数据表5.1.1', score: 1, content: '特殊质量标准和要求：确保黄山杯。关于工程奖项的约定：本项目确保获得“黄山杯”。获得“黄山杯”的，支付该项300万元；绿色建筑等级要求：达到国标二星级；智慧工地管理要求：基本级。' },
      { chapterId: 'tender-requirements', filePath: '招标文件.pdf', sectionTitle: '投标人须知', score: 1, content: '开标时间为2026年5月15日9时，评标委员会由5人组成。' },
    ];
    // 语义召回全部低于 0.5（模拟 bge 对长段落切片的低相似度），仅词形兜底应命中第一条
    vi.mocked(buildSemanticSimilarity).mockResolvedValue((() => 0.1) as unknown as ReturnType<typeof buildSemanticSimilarity> extends Promise<infer F> ? F : never);
    const result = await filterMandatoryClauseEvidence(candidates);
    expect(result.length).toBe(1);
    expect(result[0].content).toContain('确保黄山杯');
  });

  it('mergeTenderRequirementSlices：分片结果并集合并（任何片提到即保留，跨片按 text 去重）', () => {
    const sliceA: TenderRequirementModel = {
      ...emptyTenderRequirements(true),
      frontScheduleClauses: [{ text: '计划工期：540日历天。', coreTerms: ['540日历天'] }],
      awardClauses: [{ text: '本项目确保获得“黄山杯”。', coreTerms: ['黄山杯'] }],
      greenBuildingGrade: { text: '绿色建筑等级要求：达到国标二星级。', coreTerms: ['二星级'] },
    };
    const sliceB: TenderRequirementModel = {
      ...emptyTenderRequirements(true),
      frontScheduleClauses: [{ text: '计划工期：540日历天。', coreTerms: ['540日历天'] }, { text: '本项目脚手架需采用承插型盘扣式钢管。', coreTerms: ['盘扣'] }],
      awardClauses: [{ text: '获得“黄山杯”的，支付该项300万元。', coreTerms: ['300万元'] }],
      smartSiteGrade: { text: '智慧工地管理要求：基本级。', coreTerms: ['基本级'] },
    };
    const merged = mergeTenderRequirementSlices(sliceA, sliceB);
    expect(merged.frontScheduleClauses.length).toBe(2);
    expect(merged.awardClauses.length).toBe(2);
    expect(merged.greenBuildingGrade?.text).toContain('二星级');
    expect(merged.smartSiteGrade?.text).toContain('基本级');
  });

  it('extractTenderRequirements 分片阈值：证据超 4 万字符按片分批提取，片间并集合并（真实生成回归：单片超长噪声稀释短条款提取）', async () => {
    const bigContentA = '通用表述填充。'.repeat(6000); // 4.2 万字符
    const bigContentB = '通用表述填充。'.repeat(6000);
    const slicedEvidence: DocumentEvidence[] = [
      { chapterId: 'tender-requirements', filePath: '招标文件.pdf', sectionTitle: '前部章节', score: 1, content: bigContentA },
      { chapterId: 'tender-requirements', filePath: '招标文件.pdf', sectionTitle: '专用合同条款数据表5.1.1', score: 1, content: `特殊质量标准和要求：确保黄山杯。${bigContentB}` },
    ];
    const mocked = vi.mocked(callDocumentLlmJson);
    // 片1 提取到绿色等级；片2 提取到黄山杯奖项与 300 万元条款
    mocked.mockResolvedValueOnce({ greenBuildingGrade: { text: '绿色建筑等级要求：达到国标二星级。', coreTerms: ['二星级'], source: '招标文件.pdf' } });
    mocked.mockResolvedValueOnce({ awardObjectives: [{ text: '特殊质量标准和要求：确保黄山杯。', coreTerms: ['黄山杯'], source: '招标文件.pdf' }], awardClauses: [{ text: '获得“黄山杯”的，支付该项300万元。', coreTerms: ['300万元'], source: '招标文件.pdf' }] });
    const model = await extractTenderRequirements(slicedEvidence, {});
    expect(mocked).toHaveBeenCalledTimes(2);
    expect(model.awardObjectives.length).toBe(1);
    expect(model.awardObjectives[0].text).toContain('黄山杯');
    expect(model.greenBuildingGrade?.text).toContain('二星级');
  });

  it('preselectTenderRequirementEvidence 有用数据预筛：义务词形/语义命中保留，纯程序切片三条件齐备才剔除', async () => {
    const candidates: DocumentEvidence[] = [
      { chapterId: 'tender-requirements', filePath: '招标文件.pdf', sectionTitle: '专用合同条款数据表5.1.1', score: 1, content: '特殊质量标准和要求：确保黄山杯。本项目确保获得“黄山杯”，支付该项300万元。' },
      { chapterId: 'tender-requirements', filePath: '招标文件.pdf', sectionTitle: '第七章技术标准', score: 1, content: '质量标准：本工程必须达到合格标准。' },
      { chapterId: 'tender-requirements', filePath: '招标文件.pdf', sectionTitle: '投标文件格式', score: 1, content: '投标文件格式要求：正本1份副本4份，密封递交。' },
      { chapterId: 'tender-requirements', filePath: '招标文件.pdf', sectionTitle: '投标人须知', score: 1, content: '开标时间为2026年5月15日9时，解密方式为电子交易系统在线解密。' },
    ];
    // 语义召回全低分：仅依赖义务词形通道与程序剔除通道
    vi.mocked(buildSemanticSimilarity).mockResolvedValue((() => 0.1) as unknown as ReturnType<typeof buildSemanticSimilarity> extends Promise<infer F> ? F : never);
    const result = await preselectTenderRequirementEvidence(candidates);
    expect(result.length).toBe(2);
    expect(result[0].content).toContain('确保黄山杯');
    expect(result[1].content).toContain('必须达到合格');
  });

  it('preselectTenderRequirementEvidence 语义命中切片保留（无义务词形但语义相关，防误杀）', async () => {
    const candidates: DocumentEvidence[] = [
      { chapterId: 'tender-requirements', filePath: '招标文件.pdf', sectionTitle: '投标人须知', score: 1, content: '施工进度计划须经总监审核批准后实施。' },
    ];
    // 语义召回高分保留（"计划工期"特征命中）
    vi.mocked(buildSemanticSimilarity).mockResolvedValue(((_left: string, right: string) => (/总监审核/u.test(right) ? 0.7 : 0.1)) as unknown as ReturnType<typeof buildSemanticSimilarity> extends Promise<infer F> ? F : never);
    const result = await preselectTenderRequirementEvidence(candidates);
    expect(result.length).toBe(1);
  });

  it('preselectTenderRequirementEvidence 预筛零命中回退全量（防误杀导致零输入）', async () => {
    const candidates: DocumentEvidence[] = [
      { chapterId: 'tender-requirements', filePath: '招标文件.pdf', sectionTitle: '投标文件格式', score: 1, content: '投标文件格式要求：正本1份副本4份，密封递交。' },
      { chapterId: 'tender-requirements', filePath: '招标文件.pdf', sectionTitle: '投标人须知', score: 1, content: '开标时间为2026年5月15日9时，解密方式为电子交易系统在线解密。' },
    ];
    vi.mocked(buildSemanticSimilarity).mockResolvedValue((() => 0.1) as unknown as ReturnType<typeof buildSemanticSimilarity> extends Promise<infer F> ? F : never);
    const result = await preselectTenderRequirementEvidence(candidates);
    expect(result.length).toBe(2);
  });

  it('mergeTenderRequirements：主结果非空字段优先，缺失字段由窄通道补齐', () => {
    const main: TenderRequirementModel = {
      ...emptyTenderRequirements(true),
      frontScheduleClauses: [{ text: '计划工期：540日历天。', coreTerms: ['540日历天'] }],
    };
    const narrow = fullModel;
    const merged = mergeTenderRequirements(main, narrow);
    expect(merged.frontScheduleClauses.length).toBe(1);
    expect(merged.frontScheduleClauses[0].text).toContain('540日历天');
    expect(merged.awardObjectives.length).toBe(1);
    expect(merged.awardObjectives[0].text).toContain('黄山杯');
    expect(merged.greenBuildingGrade?.text).toContain('二星级');
    expect(merged.smartSiteGrade?.text).toContain('基本级');
    expect(merged.extracted).toBe(true);
  });

  it('mergeTenderRequirements：主结果字段非空时窄通道不覆盖主结果', () => {
    const main: TenderRequirementModel = {
      ...emptyTenderRequirements(true),
      awardObjectives: [{ text: '确保鲁班奖', coreTerms: ['鲁班奖'] }],
    };
    const merged = mergeTenderRequirements(main, fullModel);
    expect(merged.awardObjectives[0].text).toContain('鲁班奖');
    expect(merged.greenBuildingGrade?.text).toContain('二星级');
  });
});

describe('round-23 P0-2 奖项名称忠实性检测（requirementsCoverageIssues）', () => {
  // 覆盖判定语义通道注入恒零相似度（所有要求项零命中），LLM 分类 mock 返回 undefined 走保守全检
  const zeroSimilarity = () => 0;

  it('正文出现要求外的具名奖项（庐州杯）报杜撰 error', async () => {
    const markdown = '## 质量目标\n本工程质量目标为合格，争创合肥市优质工程奖（庐州杯）。';
    const issues = await requirementsCoverageIssues(markdown, fullModel, { semanticSimilarity: zeroSimilarity });
    const fabrication = issues.filter(issue => issue.message.includes('杜撰'));
    expect(fabrication.length).toBe(1);
    expect(fabrication[0].level).toBe('error');
    expect(fabrication[0].message).toContain('庐州杯');
  });

  it('正文使用要求原文奖项（黄山杯）不报杜撰', async () => {
    const markdown = '## 质量目标\n本项目确保获得“黄山杯”。';
    const issues = await requirementsCoverageIssues(markdown, fullModel, { semanticSimilarity: zeroSimilarity });
    expect(issues.filter(issue => issue.message.includes('杜撰'))).toEqual([]);
  });

  it('“确保黄山杯”被弱化为“争创黄山杯”报降级 error', async () => {
    const markdown = '## 质量目标\n本项目质量目标为争创黄山杯。';
    const issues = await requirementsCoverageIssues(markdown, fullModel, { semanticSimilarity: zeroSimilarity });
    const weakened = issues.filter(issue => issue.message.includes('弱化'));
    expect(weakened.length).toBe(1);
    expect(weakened[0].level).toBe('error');
  });

  it('通用荣誉措辞（省优质工程奖）不误报杜撰', async () => {
    const markdown = '## 质量目标\n本项目确保获得“黄山杯”，并争创省优质工程奖。';
    const issues = await requirementsCoverageIssues(markdown, fullModel, { semanticSimilarity: zeroSimilarity });
    expect(issues.filter(issue => issue.message.includes('杜撰'))).toEqual([]);
  });

  it('奖惩管理词汇不误报杜撰（4.12.13 真实生成回归：奖励/奖金/奖惩/不奖励）', async () => {
    const markdown = [
      '## 创优奖惩机制',
      '技术负责人每月编制创优资金使用台账，逐笔登记奖励发放、整改投入与检测费用支出。',
      '合同约定创优奖励300万元，该金额作为项目创优专项激励资金。',
      '班组自检记录完整且一次验收合格奖励200元/周；漏检每次扣100元。',
      '创优目标实现奖励项目创优奖金的20%；未实现扣减绩效工资的30%。',
      '项目部将该条款作为创优管理的合同刚性约束，建立与合同奖惩挂钩的内部考核体系。',
      '承包人提出的合理化建议降低了合同价格的，按合同约定不奖励。',
    ].join('\n');
    const issues = await requirementsCoverageIssues(markdown, fullModel, { semanticSimilarity: zeroSimilarity });
    expect(issues.filter(issue => issue.message.includes('杜撰'))).toEqual([]);
  });

  it('奖惩词汇与真杜撰奖项并存时只报真杜撰（4.12.13）', async () => {
    const markdown = '## 质量目标\n逐笔登记奖励发放，确保获得庐州杯。';
    const issues = await requirementsCoverageIssues(markdown, fullModel, { semanticSimilarity: zeroSimilarity });
    const fabrication = issues.filter(issue => issue.message.includes('杜撰'));
    expect(fabrication).toHaveLength(1);
    expect(fabrication[0].message).toContain('庐州杯');
  });

  it('通用词“奖项”不误报杜撰（4.12.13：创优目标与奖项申报）', async () => {
    const markdown = '## 创优目标\n本项目创优目标与奖项申报路径一致，确保获得黄山杯。';
    const issues = await requirementsCoverageIssues(markdown, fullModel, { semanticSimilarity: zeroSimilarity });
    expect(issues.filter(issue => issue.message.includes('杜撰'))).toEqual([]);
  });
});

// ============ 评分报告问题2：商务纪律条款提取过滤与分类兜底 ============

describe('商务纪律条款确定性治理（评分报告问题2）', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('extractTenderRequirements：frontScheduleClauses/prohibitionNotes 纪律条款提取后即过滤，技术条款保留', async () => {
    const mocked = vi.mocked(callDocumentLlmJson);
    mocked.mockResolvedValueOnce({
      awardObjectives: [{ text: '创优目标：确保黄山杯。', coreTerms: ['黄山杯'], source: '招标文件.pdf' }],
      specialQualityStandards: [],
      awardClauses: [],
      systematicBenchmarks: [],
      frontScheduleClauses: [
        { text: '计划工期：540个日历天。', coreTerms: ['540日历天'], source: '招标文件.pdf' },
        { text: '我公司对参与本项目投标及施工组织设计编制的工作人员实行严格的纪律管理，确保投标活动合法合规。', coreTerms: ['纪律管理'], source: '招标文件.pdf' },
        { text: '投标人不得向评标委员会成员行贿、打招呼、递条子。', coreTerms: ['行贿'], source: '招标文件.pdf' },
      ],
      dateFabricationProhibited: false,
      prohibitionNotes: [
        { text: '禁止编造开工日期。', coreTerms: ['开工日期'], source: '招标文件.pdf' },
        { text: '参与本项目投标的全体人员签订廉洁从业承诺书。', coreTerms: ['廉洁从业'], source: '招标文件.pdf' },
      ],
    });
    const model = await extractTenderRequirements(evidence, {});
    expect(model.frontScheduleClauses.length).toBe(1);
    expect(model.frontScheduleClauses[0].text).toContain('540个日历天');
    expect(model.prohibitionNotes.length).toBe(1);
    expect(model.prohibitionNotes[0].text).toContain('禁止编造开工日期');
    // 纪律条款不得进入写作规则
    const rules = tenderRequirementsWritingRules(model);
    expect(rules).not.toContain('纪律管理');
    expect(rules).not.toContain('行贿');
    expect(rules).not.toContain('廉洁从业');
  });

  it('classifyRequirementResponsiveness：纪律条款 LLM 判 responsive=true 仍强制 false', async () => {
    const mocked = vi.mocked(callDocumentLlmJson);
    // LLM 误判纪律条款为实质要求（responsive=true）
    mocked.mockResolvedValueOnce({ results: [{ index: 0, responsive: true }, { index: 1, responsive: true }] });
    const judged = await classifyRequirementResponsiveness([
      { kind: '前附表响应条款', text: '计划工期：540个日历天。' },
      { kind: '前附表响应条款', text: '我公司对参与本项目投标的工作人员实行严格的纪律管理，确保投标活动合法合规。' },
    ]);
    expect(judged.get(0)).toBe(true);
    expect(judged.get(1)).toBe(false);
  });

  it('classifyRequirementResponsiveness：LLM 失败保守全检时纪律条款同样强制 false', async () => {
    const mocked = vi.mocked(callDocumentLlmJson);
    mocked.mockResolvedValueOnce(undefined);
    const judged = await classifyRequirementResponsiveness([
      { kind: '前附表响应条款', text: '确保黄山杯。' },
      { kind: '前附表响应条款', text: '投标人不得串标、围标、弄虚作假。' },
    ]);
    expect(judged.get(0)).toBe(true);
    expect(judged.get(1)).toBe(false);
  });
});

// ============ 2.3 锚点级响应检测（300万缺失根治） ============

describe('2.3 锚点全覆盖响应检测（requirementsCoverageIssues）', () => {
  const zeroSimilarity = () => 0;

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('“确保黄山杯+支付300万元”条款：黄山杯命中而300万元缺失时报部分响应', async () => {
    // 语义通道恒零（最坏情形），字面锚点兜底：黄山杯命中、300万元缺失 → LLM 或选型判定失败保守 false → 报部分响应
    const markdown = '## 质量目标\n本项目确保获得“黄山杯”。';
    const issues = await requirementsCoverageIssues(markdown, fullModel, { semanticSimilarity: zeroSimilarity });
    const partial = issues.filter(issue => issue.message.includes('部分响应'));
    expect(partial.length).toBe(1);
    expect(partial[0].level).toBe('error');
    expect(partial[0].severity).toBe('blocker');
    expect(partial[0].message).toContain('黄山杯');
    expect(partial[0].message).toContain('300万元');
    expect(partial[0].suggestion).toContain('300万元');
  });

  it('条款内全部锚点（黄山杯+300万元）均命中时不报部分响应', async () => {
    const markdown = '## 质量目标\n本项目确保获得“黄山杯”，获得“黄山杯”的支付该项300万元。';
    const issues = await requirementsCoverageIssues(markdown, fullModel, { semanticSimilarity: zeroSimilarity });
    expect(issues.filter(issue => issue.message.includes('部分响应'))).toEqual([]);
  });

  it('“或”选型条款（鲁班奖或黄山杯）：命中其一不报部分响应（LLM 或选型判定兜底）', async () => {
    const mocked = vi.mocked(callDocumentLlmJson);
    // 第一次调用：classifyRequirementResponsiveness 保守全检；第二次：classifyAnchorAlternativeClauses 判 alternative=true
    mocked.mockResolvedValueOnce(undefined);
    mocked.mockResolvedValueOnce({ results: [{ index: 0, alternative: true }] });
    const model: TenderRequirementModel = {
      ...emptyTenderRequirements(true),
      awardObjectives: [{ text: '创优目标：获得鲁班奖或黄山杯。', coreTerms: ['鲁班奖', '黄山杯'], source: '招标文件.pdf' }],
    };
    const markdown = '## 质量目标\n本项目确保获得“黄山杯”。';
    const issues = await requirementsCoverageIssues(markdown, model, { semanticSimilarity: zeroSimilarity });
    expect(issues.filter(issue => issue.message.includes('部分响应'))).toEqual([]);
  });

  it('classifyAnchorAlternativeClauses：LLM 失败时保守判非或选型（宁报部分响应不漏检）', async () => {
    const mocked = vi.mocked(callDocumentLlmJson);
    mocked.mockResolvedValueOnce(undefined);
    const judged = await classifyAnchorAlternativeClauses([
      { text: '本项目确保获得“黄山杯”，支付该项300万元。', missingAnchors: ['300万元'] },
    ]);
    expect(judged.get(0)).toBe(false);
  });

  it('语义命中放行前金额锚点检查（评分报告合肥师范4：黄山杯已写但300万元未落位）', async () => {
    // 语义通道恒高（旧逻辑直接放行），条款内金额锚点“300万元”缺失 → 报部分响应定向补写
    const markdown = '## 质量目标\n本项目确保获得“黄山杯”。';
    const issues = await requirementsCoverageIssues(markdown, fullModel, { semanticSimilarity: () => 0.8 });
    const partial = issues.filter(issue => issue.message.includes('部分响应'));
    expect(partial.length).toBe(1);
    expect(partial[0].level).toBe('error');
    expect(partial[0].severity).toBe('blocker');
    expect(partial[0].message).toContain('300万元');
  });

  it('语义命中且金额锚点已落位（300万元）→ 放行不报', async () => {
    const markdown = '## 质量目标\n本项目确保获得“黄山杯”，获得“黄山杯”的支付该项300万元。';
    const issues = await requirementsCoverageIssues(markdown, fullModel, { semanticSimilarity: () => 0.8 });
    expect(issues.filter(issue => issue.message.includes('部分响应'))).toEqual([]);
  });

  it('条款无金额锚点（如装配率 30%）时语义命中直接放行，不触发锚点检查', async () => {
    const model: TenderRequirementModel = {
      ...emptyTenderRequirements(true),
      assemblyRate: { text: '装配率：30%。', coreTerms: ['30%'], source: '招标文件.pdf' },
    };
    const markdown = '## 新技术\n本项目装配率30%。';
    const issues = await requirementsCoverageIssues(markdown, model, { semanticSimilarity: () => 0.8 });
    expect(issues).toEqual([]);
  });
});

// ============ 阶段三 3.1/3.2：写作规则约束封装 ============

describe('3.1/3.2 写作规则约束封装（tenderRequirementsWritingRules）', () => {
  it('写作规则尾部携带系统约束声明（禁止复述提示词文字）', () => {
    const model: TenderRequirementModel = {
      ...emptyTenderRequirements(true),
      awardObjectives: [{ text: '创优目标：确保黄山杯。', coreTerms: ['黄山杯'], source: '招标文件.pdf' }],
    };
    const rules = tenderRequirementsWritingRules(model);
    expect(rules).toContain('【系统约束——仅指导写作，禁止写入正文，禁止复述本句】');
    expect(rules).toContain('黄山杯');
  });
});

describe('B 阶段 提取结果磁盘缓存（防脏双门禁+哈希失效）', () => {
  let tempRoot = '';
  /** 必提字段齐全的合法提取结果（写门禁放行的最小形态） */
  const validModel = (): TenderRequirementModel => ({
    ...emptyTenderRequirements(true),
    awardObjectives: [{ text: '创优目标：确保黄山杯。', coreTerms: ['黄山杯'], source: '招标文件.pdf' }],
    awardClauses: [{ text: '确保获得黄山杯的支付300万元。', coreTerms: ['黄山杯', '300万元'], source: '招标文件.pdf' }],
    greenBuildingGrade: { text: '绿色建筑等级要求：达到国标二星级。', coreTerms: ['二星级'], source: '招标文件.pdf' },
    smartSiteGrade: { text: '智慧工地管理要求：基本级。', coreTerms: ['基本级'], source: '招标文件.pdf' },
    assemblyRate: { text: '装配率为30%。', coreTerms: ['装配率', '30%'], source: '招标文件.pdf' },
    systematicBenchmarks: [{ text: '质量体系要求：ISO9001。', coreTerms: ['ISO9001'], source: '招标文件.pdf' }],
  });
  const cacheFile = (key: string) => path.join(os.homedir(), '.customize-agent', 'cache', 'document-workflow', stableHash(tempRoot), `tender-requirements-${key}.json`);

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tender-requirements-cache-test-'));
  });
  afterEach(() => {
    fs.rmSync(path.join(os.homedir(), '.customize-agent', 'cache', 'document-workflow', stableHash(tempRoot)), { recursive: true, force: true });
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('哈希失效：招标文件集合任一字节变化即生成不同 key', () => {
    const keyA = tenderRequirementsCacheKey({ collectionEvidence: [{ ...evidence[0] }], preselectEvidence: [] });
    const keyB = tenderRequirementsCacheKey({ collectionEvidence: [{ ...evidence[0], content: `${evidence[0].content}追加内容` }], preselectEvidence: [] });
    expect(keyA).not.toBe(keyB);
  });

  it('哈希失效：预筛输入内容变化即生成不同 key', () => {
    const keyA = tenderRequirementsCacheKey({ collectionEvidence: [], preselectEvidence: [{ ...evidence[0] }] });
    const keyB = tenderRequirementsCacheKey({ collectionEvidence: [], preselectEvidence: [{ ...evidence[0], content: '不同预筛输入' }] });
    expect(keyA).not.toBe(keyB);
  });

  it('key 对证据顺序不敏感（指纹排序后一致，同一资料重排不失效）', () => {
    const a = tenderRequirementsCacheKey({ collectionEvidence: [{ ...evidence[0], filePath: 'a' }, { ...evidence[0], filePath: 'b' }], preselectEvidence: [] });
    const b = tenderRequirementsCacheKey({ collectionEvidence: [{ ...evidence[0], filePath: 'b' }, { ...evidence[0], filePath: 'a' }], preselectEvidence: [] });
    expect(a).toBe(b);
  });

  it('写→读回环：合法结果落盘后可原样读回', () => {
    const model = validModel();
    const key = tenderRequirementsCacheKey({ collectionEvidence: [], preselectEvidence: [] });
    writeCachedTenderRequirements(tempRoot, key, model);
    const read = readCachedTenderRequirements(tempRoot, key);
    expect(read?.awardObjectives[0].text).toBe(model.awardObjectives[0].text);
    expect(read?.assemblyRate?.text).toBe('装配率为30%。');
  });

  it('防脏写门禁：必提字段缺失的坏结果不落盘（坏数据永不固化）', () => {
    const bad = { ...validModel(), awardClauses: [], greenBuildingGrade: undefined };
    const key = tenderRequirementsCacheKey({ collectionEvidence: [], preselectEvidence: [] });
    writeCachedTenderRequirements(tempRoot, key, bad);
    expect(fs.existsSync(cacheFile(key))).toBe(false);
    expect(readCachedTenderRequirements(tempRoot, key)).toBeUndefined();
  });

  it('防脏写门禁：空结果不落盘', () => {
    const key = tenderRequirementsCacheKey({ collectionEvidence: [], preselectEvidence: [] });
    writeCachedTenderRequirements(tempRoot, key, emptyTenderRequirements(true));
    expect(fs.existsSync(cacheFile(key))).toBe(false);
  });

  it('防脏读门禁：手工写入的脏缓存（缺必提字段）不采用', () => {
    const key = tenderRequirementsCacheKey({ collectionEvidence: [], preselectEvidence: [] });
    fs.mkdirSync(path.dirname(cacheFile(key)), { recursive: true });
    fs.writeFileSync(cacheFile(key), JSON.stringify({ ...validModel(), awardClauses: [] }), 'utf8');
    expect(readCachedTenderRequirements(tempRoot, key)).toBeUndefined();
  });

  it('防脏读门禁：损坏 JSON 不采用', () => {
    const key = tenderRequirementsCacheKey({ collectionEvidence: [], preselectEvidence: [] });
    fs.mkdirSync(path.dirname(cacheFile(key)), { recursive: true });
    fs.writeFileSync(cacheFile(key), '{损坏的JSON', 'utf8');
    expect(readCachedTenderRequirements(tempRoot, key)).toBeUndefined();
  });

  it('缓存 miss：未写入时返回 undefined（走真实提取链）', () => {
    const key = tenderRequirementsCacheKey({ collectionEvidence: [], preselectEvidence: [] });
    expect(readCachedTenderRequirements(tempRoot, key)).toBeUndefined();
  });
});

// ============ B1/B2 评分项响应确定性补写（第十次回归：双判脱节 + 空泛补写） ============

describe('评分项响应确定性补写（fixScoringRequirementResponses）', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('classifyRequirementResponsiveness：同输入二次调用命中缓存（LLM 只调一次，检测/路由/补写三处双判一致）', async () => {
    const mocked = vi.mocked(callDocumentLlmJson);
    mocked.mockResolvedValueOnce({ results: [{ index: 0, responsive: true }, { index: 1, responsive: false }] });
    const items = [
      { kind: '前附表响应条款', text: '项目经理具备建筑工程专业二级及以上注册建造师，并持有安全生产考核合格证书（B证）。' },
      { kind: '前附表响应条款', text: '本项目开标时间为2026年5月15日9时，投标文件递交截止时间同开标时间。' },
    ];
    const first = await classifyRequirementResponsiveness(items);
    const second = await classifyRequirementResponsiveness(items);
    expect(mocked).toHaveBeenCalledTimes(1);
    expect(first.get(0)).toBe(true);
    expect(first.get(1)).toBe(false);
    expect(second.get(0)).toBe(true);
    expect(second.get(1)).toBe(false);
  });

  it('部分响应条款补写条款全文（不再产出 missing 锚点拼接的空泛句）', async () => {
    const mocked = vi.mocked(callDocumentLlmJson);
    mocked.mockResolvedValueOnce({ results: [{ index: 0, responsive: true }] });
    const model: TenderRequirementModel = {
      ...emptyTenderRequirements(true),
      awardClauses: [{ text: '本项目确保获得鲁班奖，获得鲁班奖的支付奖励100万元。', coreTerms: ['鲁班奖', '100万元'], source: '招标文件.pdf' }],
    };
    const chapters = [
      { title: '## 第六章 质量与创优管理', content: '本项目创优目标为确保获得鲁班奖，配套创优管理制度。' },
    ];
    // 条款 query（coreTerms 拼接）与章节标题语义相似度 0.7 命中路由；正文缺「100万元」锚点 → 部分响应
    const similarity = (query: string, title: string) => (query.includes('鲁班奖') && title.includes('质量') ? 0.7 : 0);
    const result = await fixScoringRequirementResponses({ chapters, model, similarity });
    expect(result.fixedCount).toBe(1);
    expect(chapters[0].content).toContain('获得鲁班奖的支付奖励100万元');
    expect(chapters[0].content).not.toContain('相关内容严格按招标文件要求执行');
  });

  it('零响应条款同样补写条款全文（锚点全落位）', async () => {
    const mocked = vi.mocked(callDocumentLlmJson);
    mocked.mockResolvedValueOnce({ results: [{ index: 0, responsive: true }] });
    const model: TenderRequirementModel = {
      ...emptyTenderRequirements(true),
      awardClauses: [{ text: '本项目确保获得鲁班奖，获得鲁班奖的支付奖励100万元。', coreTerms: ['鲁班奖', '100万元'], source: '招标文件.pdf' }],
    };
    const chapters = [
      { title: '## 第六章 质量与创优管理', content: '质量目标为合格，质量保证体系健全。' },
    ];
    const similarity = (query: string, title: string) => (query.includes('鲁班奖') && title.includes('质量') ? 0.7 : 0);
    const result = await fixScoringRequirementResponses({ chapters, model, similarity });
    expect(result.fixedCount).toBe(1);
    // 4.27.2 语气治理：补写句为投标人口吻条款全文 + 差异化落实句，不得出现「按招标文件要求：」条幅前缀
    expect(chapters[0].content).toContain('本项目确保获得鲁班奖，获得鲁班奖的支付奖励100万元。');
    expect(chapters[0].content).not.toContain('按招标文件');
  });

  it('商务口径条款（暂列金额）补写定性响应句（第十六版：不再整条跳过，防零响应闭环断裂）', async () => {
    const mocked = vi.mocked(callDocumentLlmJson);
    mocked.mockResolvedValueOnce({ results: [{ index: 0, responsive: true }] });
    const model: TenderRequirementModel = {
      ...emptyTenderRequirements(true),
      awardClauses: [{ text: '本项目暂列金额为1000万元（税金另计），其中包含300万元优质优价费。', coreTerms: ['暂列金额', '1000万元'], source: '招标文件.pdf' }],
    };
    const chapters = [
      { title: '## 第六章 合同与造价管理', content: '工程造价管理措施。' },
    ];
    const similarity = (query: string, title: string) => (query.includes('暂列金额') && title.includes('造价') ? 0.7 : 0);
    const result = await fixScoringRequirementResponses({ chapters, model, similarity });
    expect(result.fixedCount).toBe(1);
    // 定性响应句：含「暂列金额」词面（检测侧锚点命中），但不含商务数字参数（1000万元不落位）
    expect(chapters[0].content).toContain('暂列金额');
    expect(chapters[0].content).not.toContain('1000万元');
  });

  it('商务响应条款（履约保证金金额）补写只落定性句，不抄条款原文商务参数（round-27：中标金额的2% 曾进技术标正文）', async () => {
    const mocked = vi.mocked(callDocumentLlmJson);
    mocked.mockResolvedValueOnce({ results: [{ index: 0, responsive: true }] });
    const model: TenderRequirementModel = {
      ...emptyTenderRequirements(true),
      frontScheduleClauses: [{ text: '履约保证金金额：中标金额的2%；提交期限：签订合同前；退还时限：履约保证金有效期满7日内退还。', coreTerms: ['履约保证金', '中标金额'], source: '招标文件.pdf' }],
    };
    const chapters = [
      { title: '## 第一章 工程概况', content: '本工程计划工期90日历天。' },
    ];
    const similarity = (query: string, title: string) => (query.includes('履约保证金') && title.includes('概况') ? 0.7 : 0);
    const result = await fixScoringRequirementResponses({ chapters, model, similarity });
    expect(result.fixedCount).toBe(1);
    // 定性响应句落位（4.27.2 语气治理：统一「按合同约定」），商务参数（百分比/金额）不抄入正文，内部格式词不出现
    expect(chapters[0].content).toContain('履约保证金按合同约定的金额');
    expect(chapters[0].content).not.toContain('按招标文件');
    expect(chapters[0].content).not.toContain('中标金额的2%');
    expect(chapters[0].content).not.toContain('招标要求响应');
    expect(chapters[0].content).not.toContain('前附表响应条款');
  });

  it('评标否决规则条款（forcedProgrammatic）：不补写进正文（4.28.x 舒城实测「一律否决其投标」曾入施组）', async () => {
    const mocked = vi.mocked(callDocumentLlmJson);
    // 语义分类不可用时仍强制程序性：isBidEvaluationRuleText 不经 LLM 判定
    mocked.mockResolvedValueOnce(undefined);
    const model: TenderRequirementModel = {
      ...emptyTenderRequirements(true),
      frontScheduleClauses: [{ text: '投标文件技术标内容明显文不对题的，评标委员会一律否决其投标。', coreTerms: ['否决投标'], source: '招标文件.pdf' }],
    };
    const chapters = [{ title: '## 第一章 工程概况', content: '本工程为市政道路工程。' }];
    const result = await fixScoringRequirementResponses({ chapters, model, similarity: () => 0.7 });
    expect(result.fixedCount).toBe(0);
    expect(chapters[0].content).not.toContain('否决其投标');
  });

  it('classifyRequirementResponsiveness：评标否决/废标规则强制 responsive=false（LLM 未裁决也不放行）', async () => {
    const mocked = vi.mocked(callDocumentLlmJson);
    mocked.mockResolvedValueOnce(undefined);
    const result = await classifyRequirementResponsiveness([
      { kind: '前附表响应条款', text: '投标文件技术标明显文不对题或存在严重错误的，评标委员会一律否决其投标。' },
      { kind: '前附表响应条款', text: '投标报价低于成本的，作废标处理。' },
    ]);
    expect(result.get(0)).toBe(false);
    expect(result.get(1)).toBe(false);
  });
});

// ============ 第十六版 B 闭环：商务条款定性响应分支 + 检测降级 + 终检 markdown 补写 ============

describe('第十六版 B 闭环（商务分支补写/幂等/检测降级/终检 markdown 补写）', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  // 实测条款文本（丰乐镇 4.26.0 报告 blocker）：商务参数不落位技术标，只做定性响应
  const WATER_FEE_CLAUSE = '承包人投标报价已经包含水电费用，工程结算时按照发包人实际缴纳的水电费在结算价（税前）中扣除。';
  const waterFeeModel = (): TenderRequirementModel => ({
    ...emptyTenderRequirements(true),
    frontScheduleClauses: [{ text: WATER_FEE_CLAUSE, coreTerms: ['水电费', '结算价'], source: '招标文件.pdf' }],
  });
  const costChapter = () => [{ title: '## 第六章 合同与造价管理', content: '工程造价管理措施。' }];
  const costSimilarity = (keyword: string) => (query: string, title: string) => (query.includes(keyword) && title.includes('造价') ? 0.7 : 0);

  it('质量保证金条款（实测文本）补写质量保证金定性句，不被通用保证金分支透支', async () => {
    vi.mocked(callDocumentLlmJson).mockResolvedValueOnce({ results: [{ index: 0, responsive: true }] });
    const model: TenderRequirementModel = {
      ...emptyTenderRequirements(true),
      frontScheduleClauses: [{ text: '质量保证金：最终结算价款的3%的工程款，或由银行业金融机构、工程担保公司、保险机构出具电子保函、纸质保函等担保方式，担保/保证金额为3%的工程结算价款。', coreTerms: ['质量保证金', '3%'], source: '招标文件.pdf' }],
    };
    const chapters = costChapter();
    const result = await fixScoringRequirementResponses({ chapters, model, similarity: costSimilarity('质量保证金') });
    expect(result.fixedCount).toBe(1);
    expect(chapters[0].content).toContain('质量保证金按合同约定的金额、担保方式与退还时限执行');
    expect(chapters[0].content).not.toContain('履约保证金');
    expect(chapters[0].content).not.toContain('按招标文件');
    // 商务参数（比例/金额）不落位技术标正文
    expect(chapters[0].content).not.toContain('3%');
  });

  it('水电费条款（实测文本）走水电费分支，泛结算分支不抢捕获', async () => {
    vi.mocked(callDocumentLlmJson).mockResolvedValueOnce({ results: [{ index: 0, responsive: true }] });
    const chapters = costChapter();
    const result = await fixScoringRequirementResponses({ chapters, model: waterFeeModel(), similarity: costSimilarity('水电费') });
    expect(result.fixedCount).toBe(1);
    expect(chapters[0].content).toContain('水电费用由我方承担');
    expect(chapters[0].content).not.toContain('进度款、竣工结算款与最终结清款');
  });

  it('核减条款（实测文本）走核减分支：响应句含核减/报审口径，不落 10% 商务比例', async () => {
    vi.mocked(callDocumentLlmJson).mockResolvedValueOnce({ results: [{ index: 0, responsive: true }] });
    const model: TenderRequirementModel = {
      ...emptyTenderRequirements(true),
      frontScheduleClauses: [{ text: '工程结算审核核减额超过报审金额10%的，其超过10%部分的造价咨询费用由施工单位（合同乙方）承担，建设单位在支付工程结算款时予以代扣。', coreTerms: ['核减', '造价咨询费'], source: '招标文件.pdf' }],
    };
    const chapters = costChapter();
    const result = await fixScoringRequirementResponses({ chapters, model, similarity: costSimilarity('核减') });
    expect(result.fixedCount).toBe(1);
    expect(chapters[0].content).toContain('核减额与报审金额的核对');
    expect(chapters[0].content).not.toContain('10%');
    expect(chapters[0].content).not.toContain('进度款、竣工结算款与最终结清款');
  });

  it('清单异议条款（实测文本）走异议分支：响应句含异议截止日期，泛结算分支不抢捕获', async () => {
    vi.mocked(callDocumentLlmJson).mockResolvedValueOnce({ results: [{ index: 0, responsive: true }] });
    const model: TenderRequirementModel = {
      ...emptyTenderRequirements(true),
      frontScheduleClauses: [{ text: '对于发包人提供的工程量清单中工程量的错误，承包人未在招标文件规定的异议截止日期前提出异议并附计算书的，工程结算时不再调整。', coreTerms: ['异议', '工程量'], source: '招标文件.pdf' }],
    };
    const chapters = costChapter();
    const result = await fixScoringRequirementResponses({ chapters, model, similarity: costSimilarity('异议') });
    expect(result.fixedCount).toBe(1);
    expect(chapters[0].content).toContain('异议截止日期');
    expect(chapters[0].content).not.toContain('进度款、竣工结算款与最终结清款');
  });

  it('注册地条款（实测文本）走注册地分支：不落公告号数字，落预缴口径', async () => {
    vi.mocked(callDocumentLlmJson).mockResolvedValueOnce({ results: [{ index: 0, responsive: true }] });
    const model: TenderRequirementModel = {
      ...emptyTenderRequirements(true),
      frontScheduleClauses: [{ text: '注册地不在合肥市行政区域范围（含四县一市）的中标人，应按照《纳税人跨县（市、区）提供建筑服务增值税征收管理暂行办法》（国家税务总局公告2016年第17号）规定，在建筑服务发生地及时足额预缴增值税。', coreTerms: ['注册地', '增值税'], source: '招标文件.pdf' }],
    };
    const chapters = costChapter();
    const result = await fixScoringRequirementResponses({ chapters, model, similarity: costSimilarity('注册地') });
    expect(result.fixedCount).toBe(1);
    expect(chapters[0].content).toContain('注册地及纳税人身份');
    expect(chapters[0].content).toContain('建筑服务发生地');
    expect(chapters[0].content).not.toContain('2016');
  });

  it('商务条款幂等：正文已有对应定性句不再重复补写', async () => {
    vi.mocked(callDocumentLlmJson).mockResolvedValueOnce({ results: [{ index: 0, responsive: true }] });
    const chapters = [{ title: '## 第六章 合同与造价管理', content: '本工程水电费用由我方承担，工程结算时按合同约定在结算价中核算处理，缴费与结算资料按合同约定办理。' }];
    const result = await fixScoringRequirementResponses({ chapters, model: waterFeeModel(), similarity: costSimilarity('水电费') });
    expect(result.fixedCount).toBe(0);
  });

  it('商务条款幂等防护：其他条款的定性句不构成已响应（关键词不同不误判）', async () => {
    vi.mocked(callDocumentLlmJson).mockResolvedValueOnce({ results: [{ index: 0, responsive: true }] });
    const chapters = [{ title: '## 第六章 合同与造价管理', content: '本工程预付款的支付、扣回与使用按合同约定执行，专款用于施工准备。' }];
    const result = await fixScoringRequirementResponses({ chapters, model: waterFeeModel(), similarity: costSimilarity('水电费') });
    expect(result.fixedCount).toBe(1);
    expect(chapters[0].content).toContain('水电费用由我方承担');
  });

  it('检测降级：商务条款定性句缺失报 info（不阻断），存在则静默通过', async () => {
    const missing = await requirementsCoverageIssues('## 工程概况\n本工程按计划组织施工。', waterFeeModel(), { semanticSimilarity: () => 0 });
    const biz = missing.filter(issue => issue.message.includes('商务条款定性响应'));
    expect(biz.length).toBe(1);
    expect(biz[0].level).toBe('info');
    expect(biz[0].severity).toBe('warning');
    expect(biz[0].category).toBe('evidence_coverage');
    const ok = await requirementsCoverageIssues('## 工程概况\n本工程水电费用由我方承担，工程结算时按合同约定在结算价中核算处理，缴费与结算资料按合同约定办理。', waterFeeModel(), { semanticSimilarity: () => 0 });
    expect(ok).toEqual([]);
  });

  it('终检 markdown 补写：锚点被 LLM 改写丢失后按路由章节行级重插（插入位在下一章标题前，章节快照同步）', async () => {
    vi.mocked(callDocumentLlmJson).mockResolvedValueOnce({ results: [{ index: 0, responsive: true }] });
    const model: TenderRequirementModel = {
      ...emptyTenderRequirements(true),
      frontScheduleClauses: [{ text: '本招标项目不允许分包。', coreTerms: ['不允许分包'], source: '招标文件.pdf' }],
    };
    const markdown = ['## 第一章 工程概况', '本工程位于合肥市。', '', '## 第五章 施工组织与分包管理', '本工程严禁转包和违法分包。', '', '## 第六章 质量保证措施', '质量保证体系健全。'].join('\n');
    const chapters = [{ title: '## 第五章 施工组织与分包管理', content: '本工程严禁转包和违法分包。' }];
    const similarity = (query: string, title: string) => (query.includes('分包') && title.includes('分包') ? 0.7 : 0);
    const result = await fixScoringRequirementResponsesInFinalMarkdown({ markdown, chapters, model, similarity });
    expect(result.fixedCount).toBe(1);
    const inserted = result.markdown.indexOf('本项目不允许分包。本工程全部施工任务由我公司项目部自行组织实施，严禁违法分包、转包及挂靠行为。');
    expect(inserted).toBeGreaterThan(result.markdown.indexOf('## 第五章'));
    expect(inserted).toBeLessThan(result.markdown.indexOf('## 第六章'));
    expect(chapters[0].content).toContain('本项目不允许分包');
    expect(result.markdown).not.toContain('按招标文件要求');
    // 幂等：二次调用不再补写（最终成稿已含锚点）
    const again = await fixScoringRequirementResponsesInFinalMarkdown({ markdown: result.markdown, chapters, model, similarity });
    expect(again.fixedCount).toBe(0);
  });

  it('终检 markdown 补写：商务条款缺失定性句时补「按合同约定」定性句（检测端闭环）', async () => {
    vi.mocked(callDocumentLlmJson).mockResolvedValueOnce({ results: [{ index: 0, responsive: true }] });
    const markdown = '## 第二章 造价与合同管理\n工程量清单计价管理措施。';
    const chapters = [{ title: '## 第二章 造价与合同管理', content: '工程量清单计价管理措施。' }];
    const similarity = (query: string, title: string) => (query.includes('水电费') && title.includes('造价') ? 0.7 : 0);
    const result = await fixScoringRequirementResponsesInFinalMarkdown({ markdown, chapters, model: waterFeeModel(), similarity });
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toContain('本工程水电费用由我方承担');
    expect(result.markdown).not.toContain('按招标文件');
    expect(result.markdown).toContain('水电费');
    expect(result.markdown).not.toContain('结算价（税前）');
  });
});

// ============ B 闭环终收尾（4.27.1）：条款原文分句兜底（coreTerms 概括短语与抄写句词面错位） ============

describe('B 闭环终收尾（条款原文分句兜底：coreTerms 词面错位误报根治）', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  const zeroSimilarity = () => 0;
  // 实测条款文本（丰乐镇 4.25/4.26/4.27 三轮持续误报的四条同族条款）
  const QUOTE_MISSING_CLAUSE = '对于发包人提供的工程量清单中的清单项目，承包人没有报价的，发包人认为视同该项价格已经包括在其他项目中。';
  const METER_CLAUSE = '发包人在现场安装计量装置，承包人负责施工期间的保护，并在工程移交的同时完好地移交给发包人。';
  const REPAIR_CLAUSE = '因承包人保护不善造成计量装置损坏，承包人负责修复（包括但不限于修复费用），并承担由此造成的增加费用。';

  it('漏报价条款（实测）：coreTerms 概括短语零命中但条款原文抄写落位 → 不报零响应', async () => {
    vi.mocked(callDocumentLlmJson).mockResolvedValueOnce(undefined);
    const model: TenderRequirementModel = {
      ...emptyTenderRequirements(true),
      frontScheduleClauses: [{ text: QUOTE_MISSING_CLAUSE, coreTerms: ['未报价处理', '视同已包含'], source: '招标文件.pdf' }],
    };
    const markdown = `## 第二章 投标报价与计量管理\n对于发包人提供的工程量清单中的清单项目，我方没有报价的，视为该项价格已经包括在其他项目中。本工程对清单项目逐项复核报价，未报价项目费用按合同约定执行，不重复计取。`;
    const issues = await requirementsCoverageIssues(markdown, model, { semanticSimilarity: zeroSimilarity });
    expect(issues).toEqual([]);
  });

  it('计量装置条款（实测）：部分 coreTerm 命中（保护移交缺失）+ 条款原文抄写落位 → 不报部分响应', async () => {
    vi.mocked(callDocumentLlmJson).mockResolvedValueOnce(undefined);
    const model: TenderRequirementModel = {
      ...emptyTenderRequirements(true),
      frontScheduleClauses: [{ text: METER_CLAUSE, coreTerms: ['计量装置', '保护移交'], source: '招标文件.pdf' }],
    };
    const markdown = `## 第二章 施工计量与现场保护\n发包人在现场安装计量装置，我方负责施工期间的保护，并在工程移交的同时完好地移交给发包人。`;
    const issues = await requirementsCoverageIssues(markdown, model, { semanticSimilarity: zeroSimilarity });
    expect(issues).toEqual([]);
  });

  it('修复费用条款（实测）：正文抄写句省略括号补充（短版）→ 去括号分句全落位不报', async () => {
    vi.mocked(callDocumentLlmJson).mockResolvedValueOnce(undefined);
    const model: TenderRequirementModel = {
      ...emptyTenderRequirements(true),
      frontScheduleClauses: [{ text: REPAIR_CLAUSE, coreTerms: ['修复费用'], source: '招标文件.pdf' }],
    };
    // 「修复费用」只在括号补充内，短版抄写句无此词面——分句去括号后「承包人负责修复」等分句全落位
    const markdown = '## 第二章 计量装置保护管理\n因我方保护不善造成计量装置损坏，我方负责修复，并承担由此造成的增加费用。';
    const issues = await requirementsCoverageIssues(markdown, model, { semanticSimilarity: zeroSimilarity });
    expect(issues).toEqual([]);
  });

  it('真缺失条款（正文无条款原文）→ 仍报零响应（兜底不误放行）', async () => {
    vi.mocked(callDocumentLlmJson).mockResolvedValueOnce(undefined);
    const model: TenderRequirementModel = {
      ...emptyTenderRequirements(true),
      frontScheduleClauses: [{ text: QUOTE_MISSING_CLAUSE, coreTerms: ['未报价处理', '视同已包含'], source: '招标文件.pdf' }],
    };
    const issues = await requirementsCoverageIssues('## 第二章 投标报价\n本工程按计划组织施工。', model, { semanticSimilarity: zeroSimilarity });
    const zero = issues.filter(issue => issue.message.includes('零命中'));
    expect(zero.length).toBe(1);
    expect(zero[0].level).toBe('error');
    expect(zero[0].severity).toBe('blocker');
  });

  it('抄写句只落位前半条款（分句部分缺失）→ 仍报部分响应（兜底不全命中不放行）', async () => {
    const mocked = vi.mocked(callDocumentLlmJson);
    // 响应性分类缓存跨用例命中时首条 mock 可能被或选型判定消耗——两态均判非或选型，断言稳定
    mocked.mockResolvedValueOnce(undefined);
    mocked.mockResolvedValueOnce({ results: [{ index: 0, alternative: false }] });
    const model: TenderRequirementModel = {
      ...emptyTenderRequirements(true),
      frontScheduleClauses: [{ text: QUOTE_MISSING_CLAUSE, coreTerms: ['清单项目', '视同已包含'], source: '招标文件.pdf' }],
    };
    const markdown = '## 第二章 投标报价\n对于发包人提供的工程量清单中的清单项目，我方没有报价的。';
    const issues = await requirementsCoverageIssues(markdown, model, { semanticSimilarity: zeroSimilarity });
    const partial = issues.filter(issue => issue.message.includes('部分响应'));
    expect(partial.length).toBe(1);
    expect(partial[0].severity).toBe('blocker');
    expect(partial[0].message).toContain('视同已包含');
  });
});

// ============ 4.27.2 交付链清理器：招标元语言剥离 + 条款响应重复行去重 ============

describe('fixTenderMetaLanguage 招标元语言确定性清理（4.27.2 语气泄漏治理）', () => {
  it('条幅前缀剥离：条款正文保留并转投标人口吻（「按招标文件要求：」不再入正文）', () => {
    const result = fixTenderMetaLanguage('## 第二章 工程概况\n按招标文件要求：承包人负责施工期间的现场管理。');
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toContain('我方负责施工期间的现场管理。');
    expect(result.markdown).not.toContain('按招标文件要求');
    expect(result.markdown).toContain('## 第二章 工程概况');
  });

  it('句内元语言替换：按招标文件约定→按合同约定 / 按上述条款→按合同约定 / 本招标项目→本项目', () => {
    const result = fixTenderMetaLanguage('本工程预付款的支付、扣回与使用按招标文件约定执行，按上述条款办理，本招标项目严格落实。');
    expect(result.markdown).toContain('按合同约定执行');
    expect(result.markdown).toContain('按合同约定办理');
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

describe('stripDuplicateResponseLines 条款响应重复行去重（4.27.2 重复补写治理）', () => {
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
