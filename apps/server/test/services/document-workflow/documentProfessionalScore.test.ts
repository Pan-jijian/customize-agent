/**
 * documentProfessionalScore 单测：L6 施工组织设计专业度评分（7 维加权、模板化降档、等级分档、
 * 弱维提示与 topIssues 截断）。
 * buildSemanticSimilarity mock 恒返 0（不加载本地 ONNX 模型）：套话语义原型全部不命中，
 * 套话判定仅由模糊应答语义 gate 驱动（mock provider：模糊词根 [1,0]/合法语境 [0,1]），结果确定可控。
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/services/document-workflow/semanticSimilarity', () => ({
  SEMANTIC_COVERAGE_THRESHOLD: 0.6,
  buildSemanticSimilarity: async () => () => 0,
  // 语义 gate（semanticGate 统一入口）用共享 provider 嵌入：
  // 模糊词根/套话词面 → [1,0]；合法语境/具体量化措施词面 → [0,1]；其余 → [0,0]
  getLocalSemanticProvider: () => ({
    embedDocuments: async (texts: string[]) => texts.map(text => {
      const vague = /力争|基本|大致|原则上|大概|左右|尽可能|尽量/u.test(text);
      const filler = /本小节围绕|结合绑定项目资料|交底覆盖率|24小时内/u.test(text);
      const legal = /对称|上游|实测实量|洒水养护|每周组织/u.test(text);
      const positive = (vague || filler) && !legal;
      return [positive ? 1 : 0, legal ? 1 : 0];
    }),
  }),
}));

import { buildProfessionalScoreReport } from '@/services/document-workflow/documentProfessionalScore';
import type { DocumentDraftChapter } from '@/services/document-workflow/types';
import type { TenderBidTemplatingReport } from '@/services/document-workflow/tenderBidScoring';

const draftChapter = (title: string, content: string): DocumentDraftChapter => ({
  id: `d-${title}`,
  title,
  content,
  evidence: [],
  missingFacts: [],
});

/** 覆盖全部 10 个核心结构组 + 5 项评标响应 + 量化/工艺参数的高质量正文 */
const GOOD_CONTENT = [
  '工程概况：本工程为合肥市安置房项目，总建筑面积12000m²，计划工期420日历天。',
  '主要施工内容：主体结构采用C30混凝土浇筑，钢筋HRB400，砌体MU10。',
  '重点难点分析：深基坑开挖与高大模板支撑是本工程重点难点。',
  '施工部署：按施工段组织流水作业。',
  '进度计划：关键线路为主线结构施工。',
  '质量保证措施：执行质量标准，验收合格率100%。',
  '安全文明施工：安全目标杜绝死亡事故，文明施工常态化。',
  '资源配置：劳动力、机械设备按需投入。',
  '绿色环保：绿色施工减少扬尘噪声。',
  '应急管理：制定应急预案并组织演练。',
  '响应招标要求：质量标准为合格，计划工期420日历天，缺陷责任期24个月，安全目标零事故，项目经理常驻现场。',
].join('\n');

const GOOD_CHAPTER = draftChapter('施工组织设计正文', GOOD_CONTENT);

const COMPLETE_TABLE = ['| 序号 | 设备名称 | 规格型号 | 数量 |', '| --- | --- | --- | --- |', '| 1 | 塔吊 | QTZ80 | 1台 |'].join('\n');

const templating = (level: 'heavy' | 'medium' | 'light'): TenderBidTemplatingReport => ({
  level,
  fillerRatio: level === 'heavy' ? 0.5 : level === 'medium' ? 0.3 : 0.05,
  fillerSentences: 5,
  totalSentences: 100,
  vagueHitCount: 0,
  vaguePhrases: [],
  duplicateSentenceRate: 0.1,
  crossProjectResidue: [],
  difficultyCountermeasureRatio: 0.6,
  difficultyBothCount: 3,
  difficultyCountermeasures: 5,
  difficultyHeavyTemplated: false,
});

describe('buildProfessionalScoreReport 维度结构', () => {
  it('7 个维度按固定顺序输出且权重和为 1', async () => {
    const report = await buildProfessionalScoreReport([GOOD_CHAPTER], COMPLETE_TABLE);
    expect(report.dimensions.map(dimension => dimension.key)).toEqual([
      'structure', 'factLanding', 'processParameter', 'table', 'filler', 'duplication', 'reviewResponse',
    ]);
    const weightSum = report.dimensions.reduce((sum, dimension) => sum + dimension.weight, 0);
    expect(weightSum).toBeCloseTo(1, 10);
    for (const dimension of report.dimensions) {
      expect(dimension.score).toBeGreaterThanOrEqual(0);
      expect(dimension.score).toBeLessThanOrEqual(100);
      expect(dimension.detail.length).toBeGreaterThan(0);
    }
  });

  it('结构组全覆盖 → structure 100', async () => {
    const report = await buildProfessionalScoreReport([GOOD_CHAPTER]);
    const structure = report.dimensions.find(dimension => dimension.key === 'structure')!;
    expect(structure.score).toBe(100);
    expect(structure.detail).toContain('覆盖 10/10 个核心结构组');
  });

  it('评标硬性要求 5 项全部响应 → reviewResponse 100', async () => {
    const report = await buildProfessionalScoreReport([GOOD_CHAPTER]);
    const review = report.dimensions.find(dimension => dimension.key === 'reviewResponse')!;
    expect(review.score).toBe(100);
    expect(review.detail).toContain('5/5 项');
  });

  it('markdown 完整表格 → table 100', async () => {
    const report = await buildProfessionalScoreReport([GOOD_CHAPTER], COMPLETE_TABLE);
    const table = report.dimensions.find(dimension => dimension.key === 'table')!;
    expect(table.score).toBe(100);
    expect(table.detail).toContain('表格 1 个，其中字段完整 1 个');
  });

  it('表格空单元格 → table 维 0 分', async () => {
    const incompleteTable = ['| 序号 | 设备名称 | 规格型号 |', '| --- | --- | --- |', '| 1 | | QTZ80 |'].join('\n');
    const report = await buildProfessionalScoreReport([GOOD_CHAPTER], incompleteTable);
    const table = report.dimensions.find(dimension => dimension.key === 'table')!;
    expect(table.score).toBe(0);
  });

  it('无表格内容 → table 兜底 40 分', async () => {
    const report = await buildProfessionalScoreReport([GOOD_CHAPTER]);
    const table = report.dimensions.find(dimension => dimension.key === 'table')!;
    expect(table.score).toBe(40);
  });

  it('高质量正文 filler/duplication 满维', async () => {
    const report = await buildProfessionalScoreReport([GOOD_CHAPTER], COMPLETE_TABLE);
    expect(report.dimensions.find(dimension => dimension.key === 'filler')!.score).toBe(100);
    expect(report.dimensions.find(dimension => dimension.key === 'duplication')!.score).toBe(100);
  });
});

describe('buildProfessionalScoreReport 总分与等级', () => {
  it('空章节 → 低分待提升（确定性标尺）', async () => {
    // structure 0 + factLanding 0 + processParameter 40 + table 40 + filler 100 + duplication 100 + reviewResponse 0
    // total = round(40*0.16 + 40*0.12 + 100*0.14 + 100*0.12) = round(37.2) = 37
    const report = await buildProfessionalScoreReport([draftChapter('空章节', '')]);
    expect(report.total).toBe(37);
    expect(report.grade).toBe('待提升');
  });

  it('高质量正文 ≥ 良好', async () => {
    const report = await buildProfessionalScoreReport([GOOD_CHAPTER], COMPLETE_TABLE);
    expect(['良好', '专业']).toContain(report.grade);
    expect(report.total).toBeGreaterThanOrEqual(72);
  });

  it('重度模板化降档：总分压到合格线以下（≤54）恒为待提升', async () => {
    const report = await buildProfessionalScoreReport([GOOD_CHAPTER], COMPLETE_TABLE, { templating: templating('heavy') });
    expect(report.total).toBeLessThanOrEqual(54);
    expect(report.grade).toBe('待提升');
    expect(report.summary).toContain('模板化等级：重度（降档已生效）');
  });

  it('中度模板化降档：总分压到良好线以下（≤69）', async () => {
    const report = await buildProfessionalScoreReport([GOOD_CHAPTER], COMPLETE_TABLE, { templating: templating('medium') });
    expect(report.total).toBeLessThanOrEqual(69);
    expect(report.grade).toBe('合格');
    expect(report.summary).toContain('模板化等级：中度（降档已生效）');
  });

  it('轻度模板化不降档', async () => {
    const plain = await buildProfessionalScoreReport([GOOD_CHAPTER], COMPLETE_TABLE);
    const light = await buildProfessionalScoreReport([GOOD_CHAPTER], COMPLETE_TABLE, { templating: templating('light') });
    expect(light.total).toBe(plain.total);
    expect(light.summary).not.toContain('降档已生效');
  });

  it('弱维（<70 分）列入 summary 待提升提示', async () => {
    const report = await buildProfessionalScoreReport([draftChapter('空章节', '')]);
    expect(report.summary).toContain('待提升：');
    expect(report.summary).toContain('结构完整度（0分）');
  });
});

describe('buildProfessionalScoreReport 扣分通道', () => {
  it('模糊应答词命中 → filler 维扣分且 detail 含套话占比', async () => {
    // 句子含「力争」且 ≥12 字：套话句 1/1 → ratio 1 → 线性扣分打满
    const content = '本项目部力争在确保质量的前提下按期完成全部施工任务并一次通过验收。';
    const report = await buildProfessionalScoreReport([draftChapter('专项措施', content)]);
    const filler = report.dimensions.find(dimension => dimension.key === 'filler')!;
    expect(filler.score).toBe(0);
    expect(filler.detail).toContain('套话句占比');
  });

  it('模板化空话短语命中 → filler 扣分并进入 topIssues', async () => {
    const content = '工程概况：本小节围绕项目背景与建设规模展开，结合绑定项目资料交代工程概况范围。';
    const report = await buildProfessionalScoreReport([draftChapter('工程概况', content)]);
    const filler = report.dimensions.find(dimension => dimension.key === 'filler')!;
    expect(filler.score).toBeLessThan(100);
    expect(report.topIssues.length).toBeGreaterThan(0);
  });

  it('跨章节重复段落 → duplication 维扣分', async () => {
    const repeated = '本工程模板支撑体系采用盘扣式脚手架搭设，立杆间距900mm，步距1500mm，扫地杆离地高度不大于200mm，每步均设置水平剪刀撑，架体经验收合格后方可投入使用并形成验收记录。';
    const chapters = [draftChapter('模板工程方案', repeated), draftChapter('支撑体系说明', repeated)];
    const report = await buildProfessionalScoreReport(chapters);
    const duplication = report.dimensions.find(dimension => dimension.key === 'duplication')!;
    expect(duplication.score).toBeLessThan(100);
    expect(duplication.detail).toContain('重复段落问题');
  });

  it('topIssues 最多 5 条', async () => {
    const report = await buildProfessionalScoreReport([GOOD_CHAPTER], COMPLETE_TABLE);
    expect(report.topIssues.length).toBeLessThanOrEqual(5);
  });
});
