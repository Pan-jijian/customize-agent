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
import { emptyTenderRequirements, extractTenderRequirements, filterMandatoryClauseEvidence, hasTenderRequirements, mergeTenderRequirements, mergeTenderRequirementSlices, missingMandatoryFields, preselectTenderRequirementEvidence, requirementsCoverageIssues, tenderRequirementsWritingRules, classifyRequirementResponsiveness, classifyAnchorAlternativeClauses, REQUIREMENTS_JSON_SCHEMA } from './tenderRequirements';
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
});

// ============ 阶段三 3.1/3.2：写作规则约束封装与评标办法系统侧消费 ============

describe('3.2 评标办法系统侧消费与约束封装（tenderRequirementsWritingRules）', () => {
  it('evaluationScheme 原文（综合评估法/分值构成）不再注入写作规则，仅保留系统侧说明', () => {
    const model: TenderRequirementModel = {
      ...emptyTenderRequirements(true),
      evaluationScheme: { text: '评标办法采用综合评估法（模式3）；分值构成：技术文件5分、商务文件10分、报价文件85分。', coreTerms: ['综合评估法'], source: '招标文件.pdf' },
    };
    const rules = tenderRequirementsWritingRules(model);
    expect(rules).toContain('评标办法');
    expect(rules).not.toContain('综合评估法');
    expect(rules).not.toContain('模式3');
    expect(rules).not.toContain('技术文件5分');
    expect(rules).toContain('不得复述评标办法');
  });

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
