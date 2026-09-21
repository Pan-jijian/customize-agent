/**
 * 评分机制对抗套件（C0-6 固化，repair-master-plan-v3 C0 闭合动作⑥）：
 * 四类历史骗分样本的确定性封堵回归——评分机制任何变更（权重/公式/判定口径）必须先过本套件。
 * 样本与 .dbg/meta-audit.ts 离线真跑（bge）互为表里：本套件 mock 语义（6 字符前缀）做日常回归，
 * meta-audit 用真 bge 做轮次级验证。
 *
 * 四样本（C0 根因定位结论）：
 * ① 标题党：纯标题无正文——旧口径下空壳标题单独命中 14/19 项（6 强制模块全部靠标题）；
 * ② 堆词：词表+参数串堆叠——旧口径下专业分 87（结构/事实落位/工艺参数/评标响应虚高）；
 * ③ 空壳：标题 + 目录聚簇行/表头骨架——目录行作独立块命中「编制专项施工方案」类查询；
 * ④ 词面垃圾：响应词表行——词面命中即判响应（无承诺语境）。
 * 判定口径：C0-1 内容级判定（标题不单独成单元）+ C0-2 叙述语境约束（罗列段不计）。
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/services/document-workflow/semanticSimilarity', () => ({
  SEMANTIC_COVERAGE_THRESHOLD: 0.6,
  buildSemanticSimilarity: async () => (left: string, right: string) => (left.includes(right.slice(0, 6)) ? 1 : 0),
  getLocalSemanticProvider: () => ({
    embedDocuments: async (texts: string[]) => texts.map(() => [0, 0]),
  }),
}));

import { buildTenderBidScores, splitScoringBlocks } from '@/services/document-workflow/tenderBidScoring';
import { buildProfessionalScoreReport } from '@/services/document-workflow/documentProfessionalScore';
import { buildEvaluationCriteriaAttainmentAudit } from '@/services/document-workflow/evaluationCriteriaMapping';
import type { DocumentDraftChapter } from '@/services/document-workflow/types';

const draftChapter = (title: string, content: string): DocumentDraftChapter => ({ id: `d-${title}`, title, content, evidence: [], missingFacts: [] });

/** ① 标题党：6 强制模块 + 目录条目形态的纯标题文档（无任何正文） */
const TITLE_ONLY = [
  '# 扬尘污染防治措施',
  '## 建筑工人实名制管理',
  '### 农民工工资专用账户与工资支付保障',
  '#### 生产安全事故应急预案与应急演练',
  '##### 绿色施工与四节一环保措施',
  '###### 危险性较大的分部分项工程安全管理',
  '## 编制专项施工方案',
].join('\n');

/** ② 堆词：结构词表 + 响应词表 + 参数串 + 套话句（无完整叙述正文） */
const STUFFED = [
  '# 第一章 工程概况 主要施工内容 重难点分析 施工部署 进度计划 质量保证 安全文明施工 资源配置 绿色环保 应急管理',
  '',
  '质量标准 计划工期 日历天 缺陷责任期 保修 安全目标 文明施工目标 项目经理 项目负责人',
  '',
  'C30，C25，C35，M5.0，M7.5，HRB400，HRB335，Q235，Q345，QTZ80，SC200，12000m²，420日历天，24个月，1500mm，900mm，200mm',
  '',
  '本小节围绕按施工准备→过程实施→检查验收→问题整改→资料归档的闭环组织',
].join('\n');

/** ③ 空壳：标题 + 目录聚簇行 / 表头骨架（无实质正文） */
const SHELL = [
  '## 施工部署',
  '第一章 工程概况 1.1 编制说明与工程概况 1.2 编制依据 1.3 工程范围',
  '',
  '## 扬尘污染防治措施',
  '| 序号 | 措施 | 标准 |',
  '| --- | --- | --- |',
].join('\n');

/** ④ 词面垃圾：响应词表行（响应词齐备但无承诺语境、无叙述句） */
const WORD_SURFACE = [
  '## 质量目标',
  '质量标准 计划工期 日历天 缺陷责任期 保修 安全目标 文明施工目标 项目经理 项目负责人',
].join('\n');

describe('对抗套件①标题党：空壳标题不得单独命中', () => {
  it('纯标题文档不产出任何判定单元', () => {
    expect(splitScoringBlocks(TITLE_ONLY)).toEqual([]);
  });

  it('模块/合规语义覆盖率归零（旧口径仅标题命中 14/19）', async () => {
    const scores = await buildTenderBidScores({ markdown: TITLE_ONLY, chapters: [], template: null, factTraces: [], issues: [] });
    expect(scores.moduleCoverageRate).toBe(0);
    expect(scores.compliance).toBe(0);
  });

  it('评分细则映射：标题承接至多 partial，不得判 met', async () => {
    const audit = await buildEvaluationCriteriaAttainmentAudit({ items: ['扬尘污染防治措施', '建筑工人实名制管理'], markdown: TITLE_ONLY });
    expect(audit.met).toBe(0);
    expect(audit.criteria.every(entry => entry.status !== 'met')).toBe(true);
  });
});

describe('对抗套件②堆词:词表/参数串堆叠不得骗取专业分', () => {
  it('结构/事实落位/评标响应三通道归零（旧口径 87 分专业级）', async () => {
    const chapters = [draftChapter('第一章 工程概况', STUFFED)];
    const report = await buildProfessionalScoreReport(chapters, STUFFED);
    const dimension = (key: string) => report.dimensions.find(item => item.key === key)!.score;
    expect(dimension('structure')).toBe(0);
    expect(dimension('factLanding')).toBeLessThanOrEqual(5);
    expect(dimension('reviewResponse')).toBe(0);
    expect(report.total).toBeLessThanOrEqual(45);
  });

  it('词表/参数串行不构成实质正文（仅闭环句支撑单元且语义不命中）', async () => {
    const scores = await buildTenderBidScores({ markdown: STUFFED, chapters: [], template: null, factTraces: [], issues: [] });
    expect(scores.moduleCoverageRate).toBe(0);
    expect(scores.compliance).toBe(0);
  });
});

describe('对抗套件③空壳：目录聚簇行/表头骨架不作正文证据', () => {
  it('目录聚簇行与表头骨架不产出判定单元', () => {
    expect(splitScoringBlocks(SHELL)).toEqual([]);
  });

  it('空壳标题不得命中模块查询（旧口径目录行命中「编制专项施工方案」）', async () => {
    const scores = await buildTenderBidScores({ markdown: SHELL, chapters: [], template: null, factTraces: [], issues: [] });
    expect(scores.moduleCoverageRate).toBe(0);
  });
});

describe('对抗套件④词面垃圾：响应词表行不得判响应', () => {
  it('响应词齐备但无承诺语境 → 评标响应 0（旧口径词面命中即 100）', async () => {
    const chapters = [draftChapter('质量目标', WORD_SURFACE.split('\n').slice(1).join('\n'))];
    const report = await buildProfessionalScoreReport(chapters, WORD_SURFACE);
    const reviewResponse = report.dimensions.find(item => item.key === 'reviewResponse')!;
    expect(reviewResponse.score).toBe(0);
  });

  it('正面守护：响应词 + 承诺语境同句出现仍判响应（防误伤）', async () => {
    const positive = [
      '## 质量目标',
      '本工程质量标准为合格，计划工期420日历天，缺陷责任期24个月，安全目标零事故，项目经理常驻现场负责履约。',
    ].join('\n');
    const chapters = [draftChapter('质量目标', positive.split('\n').slice(1).join('\n'))];
    const report = await buildProfessionalScoreReport(chapters, positive);
    const reviewResponse = report.dimensions.find(item => item.key === 'reviewResponse')!;
    expect(reviewResponse.score).toBe(100);
  });
});
