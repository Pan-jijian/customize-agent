import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./llmClient', async () => {
  const actual = (await vi.importActual('./llmClient')) as typeof LlmClientModule;
  return { ...actual, callDocumentLlmJson: vi.fn() };
});
vi.mock('./semanticSimilarity', () => ({ buildSemanticSimilarity: vi.fn() }));

import type * as LlmClientModule from './llmClient';
import { callDocumentLlmJson } from './llmClient';
import { validateJsonAgainstSchema } from './llmClient';
import { buildSemanticSimilarity } from './semanticSimilarity';
import { emptyTenderRequirements, extractTenderRequirements, filterMandatoryClauseEvidence, hasTenderRequirements, mergeTenderRequirements, missingMandatoryFields, requirementsCoverageIssues, tenderRequirementsWritingRules, classifyRequirementResponsiveness, REQUIREMENTS_JSON_SCHEMA } from './tenderRequirements';
import type { DocumentEvidence, TenderRequirementModel } from './types';

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
  pageLimit: { text: '编制篇幅:施工组织设计的篇幅不超过50页（不含封面和目录）。', coreTerms: ['50页'], source: '招标文件.pdf' },
  evaluationScheme: { text: '评标办法采用综合评估法（模式3）；分值构成：技术文件5分、商务文件10分、报价文件85分；优秀得4.5分≤F≤5分。', coreTerms: ['综合评估法', '模式3', '技术文件5分'], source: '招标文件.pdf' },
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
    expect(model.evaluationScheme?.text).toContain('综合评估法');
    expect(model.dateFabricationProhibited).toBe(true);
    const rules = tenderRequirementsWritingRules(model);
    expect(rules).toContain('黄山杯');
    expect(rules).toContain('评标办法');
  });

  it('LLM 返回 undefined 时返回空模型（零响应降级，不抛错）', async () => {
    const mocked = vi.mocked(callDocumentLlmJson);
    mocked.mockResolvedValueOnce(undefined);
    const model = await extractTenderRequirements(evidence, {});
    expect(hasTenderRequirements(model)).toBe(false);
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

  it('missingMandatoryFields：必提字段全空为 true，任一非空为 false', () => {
    expect(missingMandatoryFields(undefined)).toBe(true);
    expect(missingMandatoryFields(emptyTenderRequirements(true))).toBe(true);
    const withAward = { ...emptyTenderRequirements(true), awardObjectives: [{ text: '确保黄山杯', coreTerms: ['黄山杯'] }] };
    expect(missingMandatoryFields(withAward)).toBe(false);
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
