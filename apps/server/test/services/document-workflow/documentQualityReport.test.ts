/**
 * documentQualityReport 单测（v3 口径，对齐口径 E）：六维加权（要求实体响应 0.30 / 结构呈现落实 0.15 /
 * 数据锚定 0.20 / 专业深度 0.15 / 合规与规范 0.10 / 事实完整与一致性 0.10，目标态全达标 = 95 的精确构造）+
 * 两级重归一降级（缺失输入显式降级不计不扣）+ 锚点口径对照表（comply 类不在文本响应验收域）+
 * 双数收敛（delivery = overall − min(10, blocking×3)）+ 低雷同乘子 + 模式感知结构呈现
 * （明标=表计划执行/图位/题注；暗标=附表区承载/正文禁表）。tenderBidScoring 评分入口全 mock，常量保持真值。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { buildTenderBidScoresMock, buildTenderBidTemplatingReportMock } = vi.hoisted(() => ({
  buildTenderBidScoresMock: vi.fn(),
  buildTenderBidTemplatingReportMock: vi.fn(),
}));
vi.mock('@/services/document-workflow/tenderBidScoring', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/document-workflow/tenderBidScoring')>();
  return {
    ...actual,
    buildTenderBidScores: buildTenderBidScoresMock,
    buildTenderBidTemplatingReport: buildTenderBidTemplatingReportMock,
  };
});

import { buildDocumentQualityReport, qualityReportIssues } from '@/services/document-workflow/documentQualityReport';
import type { AuthorityAuditReport } from '@/services/document-workflow/authorityAudit';
import type { BidCompositionSpec } from '@/services/document-workflow/bidComposition';
import type { DrawingFactLock } from '@/services/document-workflow/drawingFactLock';
import type { ProfessionalDepthClassifier } from '@/services/document-workflow/professionalDepthClassifier';
import type {
  BoqRowTrace, DocumentDraftChapter, DocumentFactTrace, DocumentKnowledgeCoverageReport, DocumentQualityDimension,
  DocumentQualityReport, DocumentTemplateChapter, TenderRequirementEntry, TenderRequirementModel, ValidationIssue,
} from '@/services/document-workflow/types';

interface MockScores {
  completeness: number;
  specificity: number;
  compliance: number;
  executability: number;
  normalization: number;
  uniqueness: number;
  moduleCoverageRate: number;
}

function makeScores(overrides: Partial<MockScores> = {}): MockScores {
  return {
    completeness: 90, specificity: 88, compliance: 85, executability: 82, normalization: 80, uniqueness: 95,
    moduleCoverageRate: 0.9,
    ...overrides,
  };
}

const CHAPTERS: DocumentDraftChapter[] = [];
const TRACES: DocumentFactTrace[] = [];
const KNOWLEDGE_HIGH: DocumentKnowledgeCoverageReport = {
  score: 96, evidenceCount: 10, confirmedFiles: 3, chapterReports: [], unconfirmedDomains: [], remediation: '知识库事实覆盖已达到高置信交付要求。',
};
const KNOWLEDGE_LOW: DocumentKnowledgeCoverageReport = {
  score: 70, evidenceCount: 10, confirmedFiles: 3, chapterReports: [], unconfirmedDomains: [], remediation: '系统需扩大本地知识库检索。',
};

function dimensionOf(report: DocumentQualityReport, key: DocumentQualityDimension['key']) {
  return report.dimensions?.find(dimension => dimension.key === key);
}

function reportFixture(
  issues: ValidationIssue[],
  knowledgeCoverage: DocumentKnowledgeCoverageReport,
  scores = makeScores(),
  extra: Partial<Parameters<typeof buildDocumentQualityReport>[0]> = {},
): ReturnType<typeof buildDocumentQualityReport> {
  buildTenderBidScoresMock.mockResolvedValue(scores);
  buildTenderBidTemplatingReportMock.mockResolvedValue({ level: 'light' });
  return buildDocumentQualityReport({ markdown: '# 正文', chapters: CHAPTERS, issues, knowledgeCoverage, factTraces: TRACES, ...extra });
}

/** 正文禁表口径（bodyTablePolicy=forbidden）产物形态：正文纯文字 + 文末附表区（附表 H2 标题与 appendixPlan.title 同名；
 * C2 承载口径：表类须 ≥2 条真实数据行） */
const BLIND_MARKDOWN = [
  '# 正文', '',
  '## 附表一 拟投入本标段的主要施工设备表', '',
  '| 序号 | 设备名称 |', '| --- | --- |', '| 1 | 挖掘机 |', '| 2 | 自卸汽车 |',
].join('\n');
const BLIND_SPEC: BidCompositionSpec = {
  bidType: 'blind', bodyTablePolicy: 'forbidden', bodyFigurePolicy: 'forbidden',
  appendixPlan: [{ no: '一', title: '附表一 拟投入本标段的主要施工设备表', kind: 'table', dataSource: 'blueprint.equipment' }],
  formatRules: { cover: 'forbidden', monoColor: true },
  identityMarksForbidden: true, conflicts: [], evidence: [],
};
const OPEN_SPEC: BidCompositionSpec = {
  bidType: 'open', bodyTablePolicy: 'allowed', bodyFigurePolicy: 'allowed',
  appendixPlan: [], formatRules: {}, identityMarksForbidden: false, conflicts: [], evidence: [],
};

/** 明标正文双表：首表有题注、次表无题注（超时表格形态） */
const CAPTION_MARKDOWN = [
  '# 正文', '',
  '## 施工设备配置', '',
  '表5-1 施工设备配置表', '',
  '| 序号 | 名称 |', '| --- | --- |', '| 1 | 挖掘机 |', '',
  '| 序号 | 名称 |', '| --- | --- |', '| 2 | 装载机 |',
].join('\n');

const PLANNED_CHAPTERS: DocumentTemplateChapter[] = [{
  id: 'ch-1', title: '第一章 编制说明', purpose: '', queries: [], requiredFacts: [],
  tablePlans: [{
    id: 'plan-1', title: '拟投入本标段的主要施工设备表', chapterTitle: '第一章 编制说明', section: '',
    required: true, reason: '招标要求', fields: [{ name: '序号' }, { name: '设备名称' }],
  }],
}];
const DRAFT_NO_TABLE: DocumentDraftChapter[] = [{ id: 'ch-1', title: '第一章 编制说明', content: '本节以文字说明为主，无表格输出。', evidence: [], missingFacts: [] }];

const REQUIREMENT_MARKDOWN = '# 正文\n\n现场设置安全生产管理机构，并配备专职安全生产管理人员。';
function makeRequirementEntry(overrides: Partial<TenderRequirementEntry>): TenderRequirementEntry {
  return { text: '', coreTerms: [], sources: [], category: '安全管理', policy: 'respond', ...overrides };
}
const REQUIREMENTS: TenderRequirementModel = {
  entries: [
    makeRequirementEntry({ text: '现场设置安全生产管理机构，配备专职安全生产管理人员', category: '安全管理' }),
    makeRequirementEntry({ text: '建立危险性较大的分部分项工程专项施工方案报审制度', category: '安全专项' }),
    makeRequirementEntry({ text: '履约保证金为中标金额的 5%', category: '商务', policy: 'comply' }),
  ],
  excluded: [],
  reconciliation: { clauseCount: 3, entryCount: 3, excludedCount: 0, undecidedCount: 0, mergedCount: 0, batchCount: 1, retriedBatches: 0 },
  extracted: true,
};

/** E 批次审计输入样本：无主数值审计三桶缺口 38 处（u3+d15+p20） */
const AUTHORITY: AuthorityAuditReport = {
  scanned: 214, matched: 173, registered: 0, conventionExempt: 0,
  derivationGaps: Array.from({ length: 15 }, (_, i) => ({ token: `${i}人`, value: `${i}`, context: '劳动力', occurrences: 1 })),
  processGaps: Array.from({ length: 20 }, (_, i) => ({ token: `${i}mm`, value: `${i}`, context: '工艺', occurrences: 1 })),
  unattributed: Array.from({ length: 3 }, (_, i) => ({ token: `${i}m`, value: `${i}`, context: '其他', occurrences: 1 })),
  contextualMatches: [],
  unregisteredCount: 3,
};
const DRAWING_LOCK: DrawingFactLock = {
  groups: [{ sourceFile: '总平面图.dwg', factLines: ['基础埋深 2.5m'], tokens: ['2.5m'] }],
  usableDrawings: 1, unusableDrawings: 0, totalFacts: 1,
};

/** 专业深度分类器语料：全达标（六维 12/12）与弱章（仅事实性 2/12）两种章型 */
const FULL_CHUNK = '资源配置与组织安排。'.repeat(200);
const WEAK_CHUNK = '薄弱章。'.repeat(200);
function depthChapter(title: string, chunk = FULL_CHUNK): DocumentDraftChapter {
  return { id: title, title, content: chunk, evidence: [], missingFacts: [] };
}
const WEAK_DIMS = { factuality: true, structure: false, depth: false, executable: false, specificity: false, consistency: false };
const FULL_DIMS = { factuality: true, structure: true, depth: true, executable: true, specificity: true, consistency: true };
const FULL_NEEDS = { schedule: true, quality: true, safety: true, resource: true, construction: true };
const DEPTH_FULL: ProfessionalDepthClassifier = { analyze: async () => ({ dimensions: FULL_DIMS, contentNeeds: FULL_NEEDS, concrete: true, closedLoop: true }) };
const DEPTH_MIXED: ProfessionalDepthClassifier = {
  analyze: async (text: string) => ({
    dimensions: text.includes('薄弱章') ? WEAK_DIMS : FULL_DIMS, contentNeeds: FULL_NEEDS, concrete: true, closedLoop: true,
  }),
};

describe('buildDocumentQualityReport 六维加权（v3）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('默认输入：结构/数据/深度显式降级，仅可用维度两级重归一', async () => {
    // requirement = 仅模块分量可用（0.9→90）；compliance = 四净项 100；factIntegrity = 对账+绑定零冲突 100；
    // weighted = (90*0.3 + 100*0.1 + 100*0.1) / 0.5 = 94
    const report = await reportFixture([], KNOWLEDGE_HIGH);
    expect(report.overall).toBe(94);
    expect(report.deliveryProbability).toBe(94);
    expect(report.target).toBe(95);
    expect(report.passed).toBe(false);
    expect(dimensionOf(report, 'requirement')).toMatchObject({ score: 90, detail: '强制模块 5/6' });
    expect(dimensionOf(report, 'compliance')).toMatchObject({ score: 100, detail: '自伤 0、占位符 0、篇幅达标、表自洽 100%' });
    expect(dimensionOf(report, 'factIntegrity')).toMatchObject({ score: 100, detail: '对账零冲突、绑定零冲突' });
    expect(dimensionOf(report, 'structure')).toBeUndefined();
    expect(dimensionOf(report, 'dataAnchor')).toBeUndefined();
    expect(dimensionOf(report, 'professionalDepth')).toBeUndefined();
  });

  it('低雷同性低于 90 时对加权结果做乘数修正', async () => {
    // weighted = 94；uniqueness=45 → 94 * 0.5 = 47
    const report = await reportFixture([], KNOWLEDGE_HIGH, makeScores({ uniqueness: 45 }));
    expect(report.overall).toBe(47);
    expect(report.deliveryProbability).toBe(47);
  });

  it('双数收敛：delivery = overall − min(10, blocking×3)（差恒 ≤10）', async () => {
    const issues: ValidationIssue[] = Array.from({ length: 10 }, (_, i) => ({ level: 'error' as const, message: `e${i}`, suggestion: '' }));
    const report = await reportFixture(issues, KNOWLEDGE_HIGH, makeScores({ uniqueness: 100, moduleCoverageRate: 1 }));
    expect(report.overall).toBe(100);
    expect(report.deliveryProbability).toBe(90);
    expect(Math.abs(report.overall - report.deliveryProbability)).toBeLessThanOrEqual(10);
  });

  it('目标态全满配：六维 100，overall 100 / delivery 99 / passed=true', async () => {
    const markdown = '# 正文\n\n现场设置安全生产管理机构，并配备专职安全生产管理人员。建立危险性较大的分部分项工程专项施工方案报审制度。基础埋深 2.5m。\n\n## 施工设备配置\n\n表5-1 施工设备配置表\n\n| 序号 | 名称 |\n| --- | --- |\n| 1 | 挖掘机 |';
    // 章内容需 ≥800 字（documentTextLength 口径）才进入专业深度评分，同时保留表格满足表计划执行对账
    const draftWithTable: DocumentDraftChapter[] = [{ id: 'ch-1', title: '第一章 编制说明', content: `${FULL_CHUNK}\n\n表5-1 施工设备配置表\n\n| 序号 | 名称 |\n| --- | --- |\n| 1 | 挖掘机 |`, evidence: [], missingFacts: [] }];
    const report = await reportFixture([], KNOWLEDGE_HIGH, makeScores({ uniqueness: 100, moduleCoverageRate: 1 }), {
      markdown,
      chapters: draftWithTable,
      tenderRequirements: REQUIREMENTS,
      bidComposition: OPEN_SPEC,
      effectiveChapters: PLANNED_CHAPTERS,
      boqRowTraces: [{ itemCode: 'A', itemName: '挖一般土方', quantity: '100', unit: 'm3', sourceFile: 'x.xlsx', placed: true }],
      parameterUsageAudit: { totalParams: 10, usedParams: 10, relevantMissedCount: 0, relevantMissed: [], irrelevantMissedCount: 0, rate: 1 },
      drawingFactLock: { groups: [{ sourceFile: 'x.dwg', factLines: ['f'], tokens: ['2.5m'] }], usableDrawings: 1, unusableDrawings: 0, totalFacts: 1 },
      authorityAuditReport: { ...AUTHORITY, derivationGaps: [], processGaps: [], unattributed: [], unregisteredCount: 0 },
      keyFactPlacementAudit: { specs: 8, placed: 8, unplaced: [], rate: 1 },
      professionalDepthClassifier: DEPTH_FULL,
    });
    expect(report.overall).toBe(100);
    expect(report.deliveryProbability).toBe(99);
    expect(report.passed).toBe(true);
    expect(report.actions).toEqual(['已达到当前质量目标，建议保持事实口径和导出前复核。']);
    expect(dimensionOf(report, 'requirement')).toMatchObject({ score: 100, detail: '锚点全命中 2/2、强制模块 6/6' });
    expect(dimensionOf(report, 'structure')).toMatchObject({ score: 100, detail: '表执行 1/1、题注 1/1' });
    expect(dimensionOf(report, 'dataAnchor')).toMatchObject({ score: 100, detail: 'BOQ 落位 1/1、参数 10/10、图纸事实 1/1、无主数值 0 缺口' });
    expect(dimensionOf(report, 'professionalDepth')).toMatchObject({ score: 100, detail: '专业深度达标 100（全部章达目标线）' });
    expect(dimensionOf(report, 'compliance')?.score).toBe(100);
    expect(dimensionOf(report, 'factIntegrity')).toMatchObject({ score: 100, detail: '对账零冲突、绑定零冲突、关键事实 8/8' });
  });

  it('有阻断问题（阻断数>0）时 passed=false 且交付扣分', async () => {
    const allPerfect = makeScores({ uniqueness: 100, moduleCoverageRate: 1 });
    const report = await reportFixture([{ level: 'error', message: 'e', suggestion: '' }], KNOWLEDGE_HIGH, allPerfect);
    expect(report.overall).toBe(100);
    expect(report.deliveryProbability).toBe(97);
    expect(report.passed).toBe(false);
    expect(report.actions).toHaveLength(2);
  });

  it('summary 输出 v3 维度明细与未判定模式标注', async () => {
    const report = await reportFixture([], KNOWLEDGE_HIGH);
    expect(report.summary).toContain('交付置信度 94% / 目标 95%');
    expect(report.summary).toContain('综合评分 94/100');
    expect(report.summary).toContain('要求实体响应 90');
    expect(report.summary).toContain('合规与规范 100');
    expect(report.summary).toContain('事实完整与一致性 100');
    expect(report.summary).toContain('低雷同性 95');
    expect(report.summary).toContain('标书类型未判定（按明标口径）');
  });
});

describe('要求实体响应（锚点对账口径，v3）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('锚点全命中率单源计分：respond 类逐条对账，comply 类不在文本响应验收域', async () => {
    // 第二条要求未落位 → 锚点 1/2；requirement = (50*0.85 + 90*0.15) / 1.0 = 56；
    // weighted = (56*0.3 + 100*0.1 + 100*0.1) / 0.5 = 73.6 → 74
    const report = await reportFixture([], KNOWLEDGE_HIGH, makeScores(), {
      markdown: REQUIREMENT_MARKDOWN, tenderRequirements: REQUIREMENTS,
    });
    expect(dimensionOf(report, 'requirement')).toMatchObject({ score: 56, detail: '锚点全命中 1/2、强制模块 5/6' });
    expect(report.requirementChecklist).toEqual([
      { text: '现场设置安全生产管理机构，配备专职安全生产管理人员', category: '安全管理', responded: true },
      { text: '建立危险性较大的分部分项工程专项施工方案报审制度', category: '安全专项', responded: false },
      { text: '履约保证金为中标金额的 5%', category: '商务', responded: true },
    ]);
    expect(report.overall).toBe(74);
  });

  it('要求模型未提取（extracted=false）：响应分量显式降级（不计不扣），对照表不输出', async () => {
    const report = await reportFixture([], KNOWLEDGE_HIGH, makeScores(), {
      markdown: REQUIREMENT_MARKDOWN, tenderRequirements: { ...REQUIREMENTS, extracted: false },
    });
    expect(dimensionOf(report, 'requirement')).toMatchObject({ score: 90, detail: '强制模块 5/6' });
    expect(report.requirementChecklist).toBeUndefined();
  });

  it('无要求模型：response 分量降级，requirement 仅模块分量', async () => {
    const report = await reportFixture([], KNOWLEDGE_HIGH);
    expect(dimensionOf(report, 'requirement')).toMatchObject({ score: 90, detail: '强制模块 5/6' });
    expect(report.requirementChecklist).toBeUndefined();
  });
});

describe('结构呈现落实（模式感知，v3）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('明标：表计划执行率单分量（未执行即 0 分）', async () => {
    // structure = 表执行 0/1 = 0；weighted = (27 + 0 + 10 + 10) / 0.65 = 72.3 → 72
    const report = await reportFixture([], KNOWLEDGE_HIGH, makeScores(), {
      markdown: '# 正文\n\n本节以文字说明为主。',
      bidComposition: OPEN_SPEC,
      effectiveChapters: PLANNED_CHAPTERS,
      chapters: DRAFT_NO_TABLE,
    });
    expect(report.mode).toBe('open');
    expect(dimensionOf(report, 'structure')).toMatchObject({ score: 0, detail: '表执行 0/1' });
    expect(report.overall).toBe(72);
  });

  it('明标：正文题注覆盖率按比例计分（1/2 → 50）', async () => {
    // structure = 题注 1/2 = 50；weighted = (27 + 7.5 + 10 + 10) / 0.65 = 83.8 → 84
    const report = await reportFixture([], KNOWLEDGE_HIGH, makeScores(), {
      markdown: CAPTION_MARKDOWN, bidComposition: OPEN_SPEC,
    });
    expect(dimensionOf(report, 'structure')).toMatchObject({ score: 50, detail: '题注 1/2' });
    expect(report.overall).toBe(84);
  });

  it('暗标：附表区承载率 + 正文禁表合规（目标态满分，overall 95 passed）', async () => {
    // structure = 承载 1/1(0.75) + 正文禁表合规(0.25) = 100；weighted = (27 + 15 + 10 + 10) / 0.65 = 95.4 → 95
    const report = await reportFixture([], KNOWLEDGE_HIGH, makeScores(), {
      markdown: BLIND_MARKDOWN, bidComposition: BLIND_SPEC,
    });
    expect(report.mode).toBe('blind');
    expect(dimensionOf(report, 'structure')).toMatchObject({ score: 100, detail: '附表承载 1/1、正文禁表合规' });
    expect(report.overall).toBe(95);
    expect(report.deliveryProbability).toBe(95);
    expect(report.passed).toBe(true);
    expect(report.summary).not.toContain('标书类型未判定');
    expect(report.summary).toContain('quality-caliber-c8.0');
  });

  it('暗标：正文出现表格按违规处数扣分（2 处 → 87.5 → 88）', async () => {
    const markdown = '# 正文\n\n| 序号 | 名称 |\n| --- | --- |\n\n## 附表一 拟投入本标段的主要施工设备表\n\n| 序号 | 设备名称 |\n| --- | --- |\n| 1 | 挖掘机 |\n| 2 | 自卸汽车 |';
    // structure = (100*0.75 + 50*0.25) / 1.0 = 87.5；weighted = (27 + 13.125 + 10 + 10) / 0.65 = 92.5 → 93
    const report = await reportFixture([], KNOWLEDGE_HIGH, makeScores(), {
      markdown, bidComposition: BLIND_SPEC,
    });
    expect(dimensionOf(report, 'structure')).toMatchObject({ score: 88, detail: '附表承载 1/1、正文禁表 违规 2 处' });
    expect(report.overall).toBe(93);
  });

  it('暗标：附表仅有标题而无内容不计承载（内容级口径）', async () => {
    // 标题落位但 body 为空（紧随下一标题）→ 承载 0/1；structure = (0*0.75 + 100*0.25) / 1.0 = 25
    const markdown = '# 正文\n\n## 附表一 拟投入本标段的主要施工设备表\n\n## 第二章 施工方案\n\n文字。';
    const report = await reportFixture([], KNOWLEDGE_HIGH, makeScores(), {
      markdown, bidComposition: BLIND_SPEC,
    });
    expect(dimensionOf(report, 'structure')).toMatchObject({ score: 25, detail: '附表承载 0/1、正文禁表合规' });
  });

  it('C2 暗标：骨架说明块 / 单行数据不计承载（须 ≥2 条真实数据行）', async () => {
    // 反样本①：骨架缺口说明 + 空表头 → 0/1；反样本②：单数据行（<2）→ 0/1；structure = (0*0.75 + 100*0.25) / 1.0 = 25
    const skeleton = '# 正文\n\n## 附表一 拟投入本标段的主要施工设备表\n\n> 本表为拟投入设备配置，按招标文件规定的表头格式编制。\n\n| 序号 | 设备名称 |\n| --- | --- |';
    const singleRow = '# 正文\n\n## 附表一 拟投入本标段的主要施工设备表\n\n| 序号 | 设备名称 |\n| --- | --- |\n| 1 | 挖掘机 |';
    for (const markdown of [skeleton, singleRow]) {
      const report = await reportFixture([], KNOWLEDGE_HIGH, makeScores(), { markdown, bidComposition: BLIND_SPEC });
      expect(dimensionOf(report, 'structure')).toMatchObject({ score: 25, detail: '附表承载 0/1、正文禁表合规' });
    }
  });
});

describe('数据锚定（v3）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('四源全量：BOQ/参数/图纸/无主数值审计加权', async () => {
    // dataAnchor = (50*0.4 + 17.09*0.3 + 100*0.15 + 0*0.15) = 40.13 → 40；
    // weighted = (27 + 40.13*0.2 + 10 + 10) / 0.7 = 78.6 → 79
    const report = await reportFixture([], KNOWLEDGE_HIGH, makeScores(), {
      markdown: '# 正文\n\n基础埋深 2.5m。',
      boqRowTraces: [
        { itemCode: 'A', itemName: '挖一般土方', quantity: '100', unit: 'm3', sourceFile: 'x.xlsx', placed: true },
        { itemCode: 'B', itemName: '垫层', quantity: '20', unit: 'm3', sourceFile: 'x.xlsx', placed: false },
        { itemCode: 'C', itemName: '合计', quantity: '', unit: '', sourceFile: 'x.xlsx', placed: false, exempt: true },
      ],
      parameterUsageAudit: { totalParams: 749, usedParams: 128, relevantMissedCount: 621, relevantMissed: [], irrelevantMissedCount: 0, rate: 128 / 749 },
      drawingFactLock: DRAWING_LOCK,
      authorityAuditReport: AUTHORITY,
    });
    expect(dimensionOf(report, 'dataAnchor')).toMatchObject({
      score: 40,
      detail: 'BOQ 落位 1/2、参数 128/749、图纸事实 1/1、无主数值 缺口 38 处',
    });
    expect(report.overall).toBe(79);
  });

  it('单源缺失时降级不计不扣（仅 BOQ 可用归一至满分）', async () => {
    // dataAnchor = BOQ 2/2 单分量 → 100；weighted = (27 + 20 + 10 + 10) / 0.7 = 95.7 → 96
    const report = await reportFixture([], KNOWLEDGE_HIGH, makeScores(), {
      boqRowTraces: [
        { itemCode: 'A', itemName: '挖一般土方', quantity: '100', unit: 'm3', sourceFile: 'x.xlsx', placed: true },
        { itemCode: 'B', itemName: '垫层', quantity: '20', unit: 'm3', sourceFile: 'x.xlsx', placed: true },
      ],
    });
    expect(dimensionOf(report, 'dataAnchor')).toMatchObject({ score: 100, detail: 'BOQ 落位 2/2' });
    expect(report.overall).toBe(96);
  });

  it('审计零缺口时数字溯源满分（无主数值 0 缺口）', async () => {
    const report = await reportFixture([], KNOWLEDGE_HIGH, makeScores(), {
      authorityAuditReport: { ...AUTHORITY, derivationGaps: [], processGaps: [], unattributed: [], unregisteredCount: 0 },
    });
    expect(dimensionOf(report, 'dataAnchor')).toMatchObject({ score: 100, detail: '无主数值 0 缺口' });
  });
});

describe('专业深度（v3）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('章级 12 分制按目标线归一（弱章 2/10、强章 12/8 → 60）', async () => {
    // 弱章（资源类目标线 10）2/12 → 0.2；强章（目标线 8）12/12 → 1.0；mean = 0.6；
    // weighted = (27 + 9 + 10 + 10) / 0.65 = 86.2 → 86
    const report = await reportFixture([], KNOWLEDGE_HIGH, makeScores(), {
      chapters: [depthChapter('主要施工机械、设备计划', WEAK_CHUNK), depthChapter('确保工程质量的技术组织措施')],
      professionalDepthClassifier: DEPTH_MIXED,
    });
    expect(dimensionOf(report, 'professionalDepth')).toMatchObject({ score: 60, detail: '专业深度达标 60（薄弱：主要施工机械、设备计划 2/12）' });
    expect(report.overall).toBe(86);
  });

  it('全部章达目标线即 100', async () => {
    const report = await reportFixture([], KNOWLEDGE_HIGH, makeScores(), {
      chapters: [depthChapter('主要施工机械、设备计划')],
      professionalDepthClassifier: DEPTH_FULL,
    });
    expect(dimensionOf(report, 'professionalDepth')).toMatchObject({ score: 100, detail: '专业深度达标 100（全部章达目标线）' });
    expect(report.overall).toBe(95);
  });

  it('无 ≥800 字可评章或分类器缺失时显式降级', async () => {
    const shortChapters: DocumentDraftChapter[] = [{ id: 'c', title: '第一章', content: '短内容。', evidence: [], missingFacts: [] }];
    const report = await reportFixture([], KNOWLEDGE_HIGH, makeScores(), {
      chapters: shortChapters, professionalDepthClassifier: DEPTH_FULL,
    });
    expect(dimensionOf(report, 'professionalDepth')).toBeUndefined();
  });
});

describe('合规与规范（v3）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('自伤/占位符/篇幅/表自洽四项扣分（65），阻断问题同步扣交付置信度', async () => {
    // 自伤 1(0.3)、占位符 2(0.25)、篇幅 1(0.2)、表内不自洽 1(0.25) →
    // compliance = 75*0.3 + 50*0.25 + 50*0.2 + 80*0.25 = 65；structure = 题注 0/1 = 0；
    // weighted = (27 + 0 + 6.5 + 10) / 0.65 = 66.9 → 67；delivery = 67 − 3 = 64
    const mathMarkdown = '# 正文\n\n| 项目 | 数量 |\n| --- | --- |\n| 一 | 10 |\n| 二 | 20 |\n| 合计 | 40 |';
    const issues: ValidationIssue[] = [
      { level: 'warning', message: '自伤表述候选：“本项目经验不足”暴露投标短板，需按上下文判定后改写', suggestion: '' },
      { level: 'error', message: '表格存在占位符单元格：数量（“—”行“待定”）', suggestion: '' },
      { level: 'warning', message: '存在占位式表达：表格数据格占位符（数量“1”行“若干”）共 1 处', suggestion: '' },
      { level: 'warning', message: '正文篇幅低于目标字数：当前 12000 字，目标不少于 15000 字', suggestion: '' },
    ];
    const report = await reportFixture(issues, KNOWLEDGE_HIGH, makeScores(), { markdown: mathMarkdown });
    expect(dimensionOf(report, 'compliance')).toMatchObject({
      score: 65,
      detail: '自伤 1 处、占位符 2 处、篇幅超限 1 条、表内不自洽 1 处',
    });
    expect(dimensionOf(report, 'structure')).toMatchObject({ score: 0, detail: '题注 0/1' });
    expect(report.overall).toBe(67);
    expect(report.deliveryProbability).toBe(64);
  });

  it('全净时四项满分', async () => {
    const report = await reportFixture([], KNOWLEDGE_HIGH, makeScores(), { markdown: '# 正文\n\n纯文字说明。' });
    expect(dimensionOf(report, 'compliance')).toMatchObject({ score: 100, detail: '自伤 0、占位符 0、篇幅达标、表自洽 100%' });
  });

  // C5 P6：编制依据↔正文双向对账分量（权重 0.2，每处缺口扣 20；计数源 auditBasisRegulationsCross 与检测器同源）
  const CROSS_GAP_MARKDOWN = [
    '# 第一章 工程概况',
    '### 1.1 编制依据',
    '依据《室外排水设计规范》（GB 50013-2006）编制。',
    '## 第二章 施工方案',
    '管道敷设按《建筑地基基础工程施工质量验收标准》（GB 50202-2018）执行。',
  ].join('\n');
  const CROSS_ALIGNED_MARKDOWN = [
    '# 第一章 工程概况',
    '### 1.1 编制依据',
    '依据《室外排水设计规范》（GB 50013-2006）编制。',
    '## 第二章 施工方案',
    '管道敷设按《室外排水设计规范》（GB 50013-2006）执行。',
  ].join('\n');

  it('C5 P6：编制依据缺口按处扣分（声明未用 1 + 引用未声明 1 → 60 → 合规 92）', async () => {
    // regulation = 100 − 2×20 = 60；compliance = 100×0.8 + 60×0.2 = 92；weighted = (27 + 9.2 + 10) / 0.5 = 92.4 → 92
    const report = await reportFixture([], KNOWLEDGE_HIGH, makeScores(), { markdown: CROSS_GAP_MARKDOWN });
    expect(dimensionOf(report, 'compliance')).toMatchObject({
      score: 92,
      detail: '自伤 0、占位符 0、篇幅达标、表自洽 100%、编制依据缺口 2 处（声明未用 1/引用未声明 1）',
    });
    expect(report.overall).toBe(92);
  });

  it('C5 P6：编制依据与正文一一对应时该分量满分', async () => {
    const report = await reportFixture([], KNOWLEDGE_HIGH, makeScores(), { markdown: CROSS_ALIGNED_MARKDOWN });
    expect(dimensionOf(report, 'compliance')).toMatchObject({
      score: 100,
      detail: '自伤 0、占位符 0、篇幅达标、表自洽 100%、编制依据对账 0 缺口',
    });
    expect(report.overall).toBe(94);
  });

  it('C5 P6：编制依据区段存在但零可提取条目时该分量显式降级（不计不扣）', async () => {
    const markdown = ['# 第一章 工程概况', '### 1.1 编制依据', '本节说明编制依据的基本情况。', '## 第二章 施工方案', '按设计要求施工。'].join('\n');
    const report = await reportFixture([], KNOWLEDGE_HIGH, makeScores(), { markdown });
    expect(dimensionOf(report, 'compliance')).toMatchObject({ score: 100, detail: '自伤 0、占位符 0、篇幅达标、表自洽 100%' });
  });

  it('C5 P6：编制依据缺口在事实一致性对账不双计（阻断计数仍生效）', async () => {
    // factIntegrity 仅由对账+绑定构成 = 100（缺口消息被排除）；delivery 仍按 error 阻断收敛：92 − 3 = 89
    const issues: ValidationIssue[] = [
      { level: 'error', category: 'fact_consistency', message: '编制依据对账缺口：正文引用《建筑地基基础工程施工质量验收标准》（GB 50202-2018）未列入编制依据小节', suggestion: '' },
    ];
    const report = await reportFixture(issues, KNOWLEDGE_HIGH, makeScores(), { markdown: CROSS_GAP_MARKDOWN });
    expect(dimensionOf(report, 'factIntegrity')).toMatchObject({ score: 100, detail: '对账零冲突、绑定零冲突' });
    expect(dimensionOf(report, 'compliance')).toMatchObject({ score: 92 });
    expect(report.deliveryProbability).toBe(89);
  });
});

describe('事实完整与一致性（v3）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('对账/绑定/关键事实落位三分量加权（60·0.6 + 80·0.2 + 50·0.2 = 62）', async () => {
    // factIntegrity = 62；weighted = (27 + 6.2 + 10) / 0.5 = 86.4 → 86；delivery = 86 − 2*3 = 80
    const issues: ValidationIssue[] = [
      { level: 'error', category: 'fact_consistency', message: '跨章一致性复核：正文引用的管材材质与清单条目不符', suggestion: '' },
      { level: 'error', category: 'fact_consistency', message: '跨章一致性复核：规格-数值绑定冲突（塑料管 DN400）', suggestion: '' },
    ];
    const report = await reportFixture(issues, KNOWLEDGE_HIGH, makeScores(), {
      keyFactPlacementAudit: { specs: 8, placed: 4, unplaced: ['招标人：X'], rate: 0.5 },
    });
    expect(dimensionOf(report, 'factIntegrity')).toMatchObject({
      score: 62,
      detail: '对账冲突 2 条、绑定冲突 1 条、关键事实 4/8',
    });
    expect(report.overall).toBe(86);
    expect(report.deliveryProbability).toBe(80);
    expect(report.passed).toBe(false);
  });

  it('关键事实审计缺失时该分量降级（对账 80 + 绑定 100 重归一）', async () => {
    // factIntegrity = (80*0.6 + 100*0.2) / 0.8 = 85；weighted = (27 + 8.5 + 10) / 0.5 = 91
    const issues: ValidationIssue[] = [
      { level: 'error', category: 'fact_consistency', message: '数据一致性复核：正文引用的管材材质与清单条目不符', suggestion: '' },
    ];
    const report = await reportFixture(issues, KNOWLEDGE_HIGH, makeScores(), {});
    expect(dimensionOf(report, 'factIntegrity')).toMatchObject({ score: 85, detail: '对账冲突 1 条、绑定零冲突' });
    expect(report.overall).toBe(91);
  });
});

describe('C-T5 清单落位审计（billPlacementAudit）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const BOQ_TRACES: BoqRowTrace[] = [
    { itemCode: '030901010001', itemName: '挖一般土方', quantity: '100', unit: 'm3', sourceFile: '清单.xlsx', placed: true },
    { itemCode: '030901010002', itemName: '检查井', quantity: '10', unit: '座', sourceFile: '清单.xlsx', placed: true },
    { itemCode: '030901010003', itemName: '混凝土管铺设', quantity: '80', unit: 'm', sourceFile: '清单.xlsx', placed: false },
    { itemCode: '', itemName: '分部小计', quantity: '', unit: '', sourceFile: '清单.xlsx', placed: false, exempt: true },
  ];

  it('有效行/落位/显性说明/豁免行清单登记（分母豁免口径行）', async () => {
    // 显性说明识别在已落位行内：说明句本身构成字面落位，“检查井利旧”计入 explicitRows 而非落位率补偿
    const markdown = '# 正文\n\n本工程完成挖一般土方施工。原有检查井利旧使用，不另列施工方案。';
    const report = await reportFixture([], KNOWLEDGE_HIGH, makeScores(), { markdown, boqRowTraces: BOQ_TRACES });
    expect(report.billPlacementAudit).toEqual({
      effectiveRows: 3,
      placedRows: 2,
      explicitRows: 1,
      rate: 2 / 3,
      exemptRows: ['分部小计'],
    });
  });

  it('无清单行追踪时不输出审计字段', async () => {
    const report = await reportFixture([], KNOWLEDGE_HIGH);
    expect(report.billPlacementAudit).toBeUndefined();
  });
});

describe('C-T6 可靠参数使用审计（parameterUsageAudit）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('调用侧预计算的审计对象随报告透传（义务满足率出口）', async () => {
    const audit = {
      totalParams: 10,
      usedParams: 7,
      relevantMissedCount: 3,
      relevantMissed: ['排水管道：DN400'],
      irrelevantMissedCount: 0,
      rate: 0.7,
    };
    const report = await reportFixture([], KNOWLEDGE_HIGH, makeScores(), { parameterUsageAudit: audit });
    expect(report.parameterUsageAudit).toEqual(audit);
  });

  it('未传入审计对象时字段缺省（无参数池显式降级）', async () => {
    const report = await reportFixture([], KNOWLEDGE_HIGH);
    expect(report.parameterUsageAudit).toBeUndefined();
  });
});

describe('C-T7 关键事实落位审计（keyFactPlacementAudit）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('调用侧预计算的审计对象随报告透传（须落位清单落位率出口）', async () => {
    const audit = { specs: 8, placed: 7, unplaced: ['质量标准：合格'], rate: 7 / 8 };
    const report = await reportFixture([], KNOWLEDGE_HIGH, makeScores(), { keyFactPlacementAudit: audit });
    expect(report.keyFactPlacementAudit).toEqual(audit);
  });

  it('未传入审计对象时字段缺省（关键事实池为空显式降级）', async () => {
    const report = await reportFixture([], KNOWLEDGE_HIGH);
    expect(report.keyFactPlacementAudit).toBeUndefined();
  });
});

describe('知识覆盖目标线与 templating', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('知识覆盖达 95 时目标 95，否则 85', async () => {
    const high = await reportFixture([], KNOWLEDGE_HIGH, makeScores({ uniqueness: 100, moduleCoverageRate: 1 }));
    expect(high.target).toBe(95);
    expect(high.passed).toBe(true);
    const low = await reportFixture([], KNOWLEDGE_LOW);
    expect(low.target).toBe(85);
  });

  it('模板化报告透传到 templating 字段', async () => {
    buildTenderBidTemplatingReportMock.mockResolvedValue({ level: 'medium' });
    buildTenderBidScoresMock.mockResolvedValue(makeScores());
    const report = await buildDocumentQualityReport({ markdown: '# 正文', chapters: CHAPTERS, issues: [], knowledgeCoverage: KNOWLEDGE_HIGH, factTraces: TRACES });
    expect(report.templating).toEqual({ level: 'medium' });
  });
});

function makeTemplatingReport() {
  return {
    level: 'light' as const, fillerRatio: 0, fillerSentences: 0, totalSentences: 1,
    vagueHitCount: 0, vaguePhrases: [], duplicateSentenceRate: 0, crossProjectResidue: [],
    difficultyCountermeasureRatio: 1, difficultyBothCount: 1, difficultyCountermeasures: 1, difficultyHeavyTemplated: false,
    sentencePatternHits: [],
  };
}

describe('qualityReportIssues', () => {
  it('已达标不产出问题', () => {
    const passedReport: DocumentQualityReport = {
      overall: 90, deliveryProbability: 96, target: 95, passed: true,
      scores: makeScores(), templating: makeTemplatingReport(),
      summary: '', actions: ['已达到当前质量目标，建议保持事实口径和导出前复核。'],
    };
    expect(qualityReportIssues(passedReport)).toEqual([]);
  });

  it('未达标产出 info 级问题（不污染缺陷计分）', () => {
    const failedReport: DocumentQualityReport = {
      overall: 60, deliveryProbability: 60, target: 85, passed: false,
      scores: makeScores(), templating: makeTemplatingReport(),
      summary: '', actions: ['补齐短板维度', '修复阻断问题'],
    };
    const issues = qualityReportIssues(failedReport);
    expect(issues).toHaveLength(1);
    expect(issues[0].level).toBe('info');
    expect(issues[0].message).toContain('60% / 85%');
    expect(issues[0].suggestion).toContain('补齐短板维度');
  });
});
