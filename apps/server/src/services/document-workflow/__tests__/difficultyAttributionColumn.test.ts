/**
 * W3 归因闸门 · 表格形态改按列判定（防回归）。
 *
 * 实测（巢湖，真实 bge 余弦）：重难点以表格呈现时，**表头行（纯列名）得 0.643 通过，
 * 而真实条目只得 0.476~0.524 不通过**（阈值 0.6）——语义度量对表格形态没有分辨率：
 * 它测的是"是否出现成因/风险来源词汇"，且长表格行被单元格碎片稀释。
 * 表格行的归因本就有独立列承载，故改按列判定。
 */
import { describe, expect, it } from 'vitest';
import { difficultyCountermeasureReport } from '@/services/document-workflow/tenderBidChecks';

/** 巢湖真实表形态（列名「风险描述」承载归因；行内有量化目标） */
const CHAOHU_TABLE = [
  '## 第一章 工程概况',
  '',
  '### 1.1 重点难点分析',
  '',
  '| 重点难点事项 | 风险描述 | 应对措施 | 责任岗位 | 检查频次 | 整改闭环要求 |',
  '| --- | --- | --- | --- | --- | --- |',
  '| 8个自然村分散施工组织协调 | 施工面分散导致材料与人员调配困难 | 按自然村划分施工段，分段设置材料临时堆场 | 施工员 | 每日不少于1次 | 问题当日登记，限期整改，由质检员复查销项 |',
  '| 雨季管网沟槽开挖 | 雨季集中降水叠加土质松散导致边坡坍塌与积水 | 分段开挖、及时支护，设置排水沟与集水井 | 安全员 | 每日不少于1次 | 发现隐患立即停工整改，由安全员复查确认后复工 |',
  '| 村庄内道路施工交通疏导 | 施工占用道路影响村民通行 | 设置临时便道与警示标志，安排专人指挥交通 | 安全员 | 每日不少于1次 | 疏导不到位当日纠正，由施工员复查销项 |',
].join('\n');

describe('重难点归因 · 表格形态按列判定', () => {
  it('表格含「风险描述」列且有实质内容 → 归因达标（不再受语义阈值误杀）', async () => {
    const report = await difficultyCountermeasureReport(CHAOHU_TABLE);
    expect(report.countermeasures).toBeGreaterThanOrEqual(3);
    // 三条实质条目全部归因达标（原先真实条目语义仅 0.476~0.524，全部不达标）
    expect(report.attributed).toBeGreaterThanOrEqual(3);
    // 同时量化达标（行内含量化目标：不少于1次）
    expect(report.quantified).toBeGreaterThanOrEqual(3);
    expect(report.ratio).toBeGreaterThanOrEqual(0.5);
    expect(report.heavyTemplated).toBe(false);
  });

  it('表格无归因列 → 仍按语义判定（不得放行）', async () => {
    const noColumn = [
      '## 第一章 工程概况',
      '',
      '### 1.1 重点难点分析',
      '',
      '| 难点事项 | 应对措施 | 责任岗位 |',
      '| --- | --- | --- |',
      '| 雨季管网沟槽开挖 | 分段开挖、及时支护 | 安全员 |',
    ].join('\n');
    // 注入嵌入替身：返回与查询正交的向量 → 语义相似度 0（vitest 环境无法加载真实语义模型）
    const report = await difficultyCountermeasureReport(noColumn, async (texts) => texts.map(t => (t.includes('成因与风险来源') ? [1, 0] : [0, 1])));
    // 无语义模型可用时相似度为 0 → 不达标（列判据未被误触发）
    expect(report.attributed).toBe(0);
  });

  it('散文形态不受影响（继续走语义通道）', async () => {
    const prose = [
      '## 第一章 工程概况',
      '',
      '### 1.1 重点难点分析',
      '',
      '雨季管网沟槽开挖的难点成因在于当地雨季集中降水叠加土质松散，风险来源为边坡坍塌与积水。',
    ].join('\n');
    const report = await difficultyCountermeasureReport(prose, async (texts) => texts.map(t => (t.includes('成因与风险来源') ? [1, 0] : [0, 1])));
    expect(report.countermeasures).toBeGreaterThan(0);
    // 散文无表格列，attributionColumnIndex = -1 → 走语义（离线无模型 → 不达标）
    expect(report.attributed).toBe(0);
  });
});

describe('归因半项退出判定（实测无分辨力）', () => {
  /** 巢湖实测形态：散文段落字面写着「成因在于…风险源于…」，但语义相似度 0.530~0.565（阈值 0.6）全不过；
   *  而不含成因的段落 0.53~0.57 同区间——两类无区分度；截断归一化（120/200/300 字）亦无法分离。 */
  const proseWithCauses = [
    '## 第一章 工程概况',
    '',
    '### 1.1 重难点分析',
    '',
    '该体系的施工难点成因在于：单根钢构件截面大、自重高，吊装就位时对塔式起重机起吊半径与站位精度要求苛刻；风险源于分段吊装过程中的临时约束不足与高空对接累积误差。',
    '',
    '量化控制目标为：钢柱安装垂直度偏差不大于 10mm，梁跨中起拱值不小于跨度的 1/500，吊车梁顶面标高偏差控制在 ±5mm 以内。',
  ].join('\n');

  it('量化达标即为达标：不因「归因语义不过」判重度模板化（heavyTemplated 只依据可测半项）', async () => {
    const report = await difficultyCountermeasureReport(proseWithCauses, async (texts) => texts.map(t => (t.includes('成因与风险来源') ? [1, 0] : [0, 1])));
    expect(report.countermeasures).toBeGreaterThan(0);
    // 嵌入替身使语义归因恒为 0（模拟实测中真实段落不过阈值的形态）
    expect(report.attributed).toBe(0);
    // 但量化目标存在（结构判定）→ 不得判重度
    expect(report.quantified).toBeGreaterThan(0);
    expect(report.heavyTemplated).toBe(false);
  });

  it('量化也不达标 → 判重度（可测半项确实在起作用，非恒 false）', async () => {
    const noQuant = [
      '## 第一章 工程概况',
      '',
      '### 1.1 重难点分析',
      '',
      '该体系施工难度大，风险来源较多，需加强管理并落实各项措施，确保施工安全有序推进。',
    ].join('\n');
    const report = await difficultyCountermeasureReport(noQuant, async (texts) => texts.map(t => (t.includes('成因与风险来源') ? [1, 0] : [0, 1])));
    expect(report.quantified).toBe(0);
    expect(report.heavyTemplated).toBe(true);
  });
});
