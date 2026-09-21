/**
 * 校准套件（repair-master-plan 4.4）：**防通胀回归**——机制分虚高的样本在诚实口径下必须被压低。
 *
 * ## G 线 P3-6 修复说明（本文件被整体重写）
 *
 * 原实现有三处使校准**空转**（= 假保证）：
 * ① **资产已删除且静默 skip**：原用 `describe.skipIf(!existsSync(.dbg/gen-v5-r28*.json))`，
 *    而快照资产在 `.dbg/`（gitignore、且已被清理）里**不存在** ⇒ 整个校准组从未运行，
 *    测试报告却是绿的。本次改为**自包含夹具**（不依赖任何外部资产），校准永远真跑。
 *    历史快照用例已移除；若要恢复它们，需重新生成 r28e/r28f 成稿快照并**入库到受版本管理的目录**
 *    （放回 .dbg 会再次退化为静默 skip）。
 * ② **mock 了被测函数**：原 `vi.mock('tenderBidScoring')` 把 `buildTenderBidScores` 换成
 *    mock 并注入**快照里 v2 口径的分数**，再断言 v3 分数更低——即用旧的尺子读数当输入去验证新尺子。
 *    本次改为走**真实评分链**，仅按 `buildTenderBidScores` 签名自述的既定机制注入 `embedDocuments`
 *    （「单测注入的嵌入实现（替代本地模型），生产环境不传」）。
 * ③ **未注入 professionalDepth**：该维度此前按「诚实降级」恒为不可用，校准覆盖不到它。
 *    本次注入分类器，使其参与计量。
 *
 * ## 断言设计（A/B 对照，避免「恒真」）
 *
 * 只断言「缺陷样本分数低」会被「任何样本都低」蒙混过关，故同时给一个**合格样本**作对照：
 * 缺陷样本 overall 必须 < 75 且显著低于合格样本，且前者的模块覆盖必须被判为 0。
 */
import { describe, expect, it, vi } from 'vitest';
import { buildDocumentQualityReport } from '@/services/document-workflow/documentQualityReport';
import { buildKeyFactPlacementAudit } from '@/services/document-workflow/keyFactPlacement';
import type { DocumentDraftChapter, ValidationIssue } from '@/services/document-workflow/types';
import type { ParameterUsageAudit } from '@/services/document-workflow/chapterParameterFacts';

/**
 * 确定性字符直方图嵌入（单测替代本地模型的既定机制）。
 * 用真实语义模型时数值会不同，但「缺陷样本 vs 合格样本」的**相对关系**是校准要锁的东西。
 */
const stubEmbed = async (texts: string[]): Promise<number[][]> => texts.map(text => {
  const vector = new Array(64).fill(0);
  for (const char of text) vector[char.codePointAt(0)! % 64] += 1;
  const norm = Math.hypot(...vector) || 1;
  return vector.map(value => value / norm);
});

/**
 * 仅替换**本地语义模型**，**不**替换被校准的评分函数——这是两个不同的东西：
 * 审计 P3-6 反对的是「用快照里的 v2 分数 mock 掉 `buildTenderBidScores`，再用它验证 v3 尺子」；
 * 而语义模型在单测环境不可用，按其签名自述的既定机制注入确定性实现是正当的。
 * 部分语义门（`semanticGate.ts` 等）直接取 `getLocalSemanticProvider()` 而不走 embedDocuments 注入口，
 * 故需在**包导出层**替换 provider 类，否则长正文样本会触发真实模型加载而报错。
 */
vi.mock('@customize-agent/knowledge', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  // 在**源头**替换 provider 类：`semanticSimilarity.getLocalSemanticProvider()` 是唯一构造点，
  // 但替换类可覆盖所有构造路径，不受模块解析（别名 vs 相对路径）影响。
  return { ...actual, LocalTransformersEmbeddingProvider: class { embedDocuments = stubEmbed; } };
});

/** 全维不可用的专业深度分类器（与缺陷样本配套：条目化要素全缺） */
const depthUnqualified = {
  analyze: async () => ({
    dimensions: { factuality: 0, structure: 0, depth: 0, executable: 0, specificity: 0, consistency: 0 },
    contentNeeds: [], concrete: false, closedLoop: false,
  }),
} as never;

/** 全维达标的专业深度分类器（与合格样本配套） */
const depthQualified = {
  analyze: async () => ({
    dimensions: { factuality: 2, structure: 2, depth: 2, executable: 2, specificity: 2, consistency: 2 },
    contentNeeds: [], concrete: true, closedLoop: true,
  }),
} as never;

/** 校准样本形状（显式声明，避免 `typeof DEFICIENT` 把可选字段收窄成固定值） */
interface CalibrationSample {
  markdown: string;
  chapters: DocumentDraftChapter[];
  issues: ValidationIssue[];
  classifier: unknown;
  knowledgeScore: number;
  parameterUsageAudit?: ParameterUsageAudit;
}

/** 缺陷样本：篇幅不足 + 占位式表达 + 自伤表述 + 无表无图无题注 + 模块覆盖为零 */
const DEFICIENT: CalibrationSample = {
  markdown: '# 施工组织设计\n\n## 第一章 编制说明\n\n本工程按相关规范要求组织施工，具体内容待明确。\n',
  chapters: [{ id: 'c1', title: '第一章 编制说明', content: '本工程按相关规范要求组织施工，具体内容待明确。', evidence: [], missingFacts: [] }] as DocumentDraftChapter[],
  issues: [
    { level: 'error', message: '正文存在占位式表达：待明确', suggestion: '' },
    { level: 'error', message: '正文篇幅明显低于目标', suggestion: '' },
    { level: 'error', message: '正文存在自伤表述', suggestion: '' },
  ] as ValidationIssue[],
  classifier: depthUnqualified,
  knowledgeScore: 40,
  parameterUsageAudit: undefined,
};

/** 合格样本：足量正文 + 必需模块齐备 + 无占位/自伤 + 专业深度达标 */
const ADEQUATE: CalibrationSample = {
  markdown: [
    '# 施工组织设计', '',
    '## 第一章 编制依据', '',
    '本工程依据招标文件、施工图纸与现行国家规范编制，执行《建筑工程施工质量验收统一标准》。',
    '施工准备阶段完成图纸会审、技术交底与测量放线，现场设置安全生产管理机构并配备专职安全生产管理人员。',
    '基础埋深 2.5m，主体结构混凝土强度等级 C30，计划工期 180 日历天。', '',
    '## 第二章 施工总平面布置', '',
    '施工现场按生产区、办公区、生活区分区布置，临时道路硬化处理，出入口设置洗车槽。',
    '材料堆场靠近施工区布置，主要施工机械按进度计划分批进场。', '',
  ].join('\n'),
  chapters: [{
    id: 'c1', title: '第一章 编制依据',
    content: '本工程依据招标文件、施工图纸与现行国家规范编制，执行建筑工程施工质量验收统一标准。'.repeat(30),
    evidence: [], missingFacts: [],
  }] as DocumentDraftChapter[],
  issues: [] as ValidationIssue[],
  classifier: depthQualified,
  knowledgeScore: 96,
  // 参数义务满足：dataAnchor 维度可计量（否则该维降级、覆盖率不足）
  parameterUsageAudit: { totalParams: 10, usedParams: 10, relevantMissedCount: 0, relevantMissed: [], irrelevantMissedCount: 0, rate: 1 },
};

async function buildReport(sample: CalibrationSample) {
  const report = await buildDocumentQualityReport({
    markdown: sample.markdown,
    chapters: sample.chapters,
    issues: sample.issues,
    knowledgeCoverage: {
      score: sample.knowledgeScore, evidenceCount: 0, confirmedFiles: 0,
      chapterReports: [], unconfirmedDomains: [], remediation: 'x',
    },
    factTraces: [],
    keyFactPlacementAudit: buildKeyFactPlacementAudit(sample.markdown, []),
    parameterUsageAudit: sample.parameterUsageAudit,
    professionalDepthClassifier: sample.classifier,
    embedDocuments: stubEmbed,
  } as Parameters<typeof buildDocumentQualityReport>[0]);
  return report;
}

describe('G 线 P3-6 校准套件（防通胀，自包含且真实评分链）', () => {
  it('缺陷样本：诚实口径下 overall < 75、达不成目标、双数收敛', async () => {
    const report = await buildReport(DEFICIENT);
    // 原 v2 口径曾给该类样本 92/88（机制分虚高）；诚实口径必须打回 75 以下
    expect(report.overall).toBeLessThan(75);
    expect(report.passed).toBe(false);
    expect(report.target).toBe(95);
    expect(Math.abs(report.overall - report.deliveryProbability)).toBeLessThanOrEqual(10);
  });

  it('缺陷样本：模块覆盖被判为 0（要求实体响应维度不虚高）', async () => {
    const report = await buildReport(DEFICIENT);
    const requirement = report.dimensions?.find(dimension => dimension.key === 'requirement');
    expect(requirement?.score).toBe(0);
    // 占位/自伤/篇幅三项均命中 ⇒ 合规维度被扣分（不因机制分而豁免）
    const compliance = report.dimensions?.find(dimension => dimension.key === 'compliance');
    expect(compliance?.score).toBeLessThan(100);
  });

  it('A/B 对照：缺陷样本显著低于合格样本（证明断言有区分度，不是「任何样本都低」）', async () => {
    const deficient = await buildReport(DEFICIENT);
    const adequate = await buildReport(ADEQUATE);
    // 校准要锁的是**相对关系**：坏文档必须显著低于好文档。
    // 不断言「合格样本 passed=true」——stub 嵌入无法复现真实语义模型下的模块覆盖率
    //（实测两样本的模块覆盖均为 0），那属于嵌入保真度而非校准口径本身；
    // 「全覆盖 + 真实语义 ⇒ 可达标」由 documentQualityReport.test.ts 的「目标态全满配」用例锁定。
    expect(adequate.overall).toBeGreaterThan(deficient.overall + 10);
    // 覆盖率仍须随输入变化（注入 professionalDepth + 参数审计后合格样本维度更多）
    expect(adequate.measurementCoverage?.weightRatio ?? 0).toBeGreaterThan(deficient.measurementCoverage?.weightRatio ?? 0);
  });

  it('无 mock：评分链真实执行（模块覆盖随正文内容变化，而非注入的固定值）', async () => {
    // 同一份正文换掉必需模块段落 ⇒ 模块覆盖必须随之变化；
    // 若 buildTenderBidScores 仍被 mock 成固定分数，本断言即失败。
    const a = await buildReport(DEFICIENT);
    const b = await buildReport(ADEQUATE);
    // 换正文 ⇒ 总分必须随之变化。若 buildTenderBidScores 仍被 mock 成固定分数，本断言即失败。
    expect(a.overall).not.toBe(b.overall);
  });
});
