/**
 * 边界矩阵（P1 第 34 批 · VV 组 · 日期伪造/字段错配/表格残行/装饰厚度检测）
 * 断言按源码规则推导（CALENDAR_DATE_RE/scopeValuePairs/BODY_LABEL_VALUE_RE 等）。
 */
import { describe, expect, it } from 'vitest';
import { fabricatedStartDateIssues, fieldValueMismatchIssues, finishThicknessIssues, mergeTableLineResidues } from '@/services/document-workflow/documentIntegrityChecks';
import type { DocumentFactsModel } from '@/services/document-workflow/types';

const factOf = (key: string, value: string, fieldName = ''): any => ({ key, value, fieldName, fieldId: '', sourceFile: 's', roleId: 'r' });
const emptyModel = { project: [], schedule: [], quality: [], resources: [], bills: [], preciseFacts: [], drawings: [], tables: [], canonical: {}, missing: [], conflicts: [] } as unknown as DocumentFactsModel;

// ── V1. fabricatedStartDateIssues 谱系 ──

describe('V1 开工日期伪造：已知日期豁免', () => {
  it('V1 正文日期在资料已知日期中 → 0 条', () => {
    const model = { ...emptyModel, schedule: [factOf('开工', '2025年6月1日')] } as unknown as DocumentFactsModel;
    expect(fabricatedStartDateIssues('计划于2025年6月1日开工。', model)).toHaveLength(0);
  });
  it('V1 正文日期不在资料 → 1 条', () => {
    expect(fabricatedStartDateIssues('计划于2025年6月1日开工。', emptyModel)).toHaveLength(1);
  });
  it.each([
    ['2025年6月1日', 1],
    ['2025 年 6 月 1 日', 1],
    ['25年6月1日', 0],
    ['2025年13月1日', 1],
    ['2025年6月32日', 1],
    ['20250601', 0],
  ] as const)('V1 日期形态「%s」→ %s 条', (date, exp: number) => {
    expect(fabricatedStartDateIssues(`开工日期为${date}。`, emptyModel)).toHaveLength(exp);
  });
  it('V1 已知日期来自 quality/resources 卡 → 豁免', () => {
    const model = { ...emptyModel, quality: [factOf('q', '验收日期2026年1月2日')] } as unknown as DocumentFactsModel;
    expect(fabricatedStartDateIssues('验收日期2026年1月2日。', model)).toHaveLength(0);
  });
  it('V1 资料含任一日期时，进度计划类上下文豁免', () => {
    const model = { ...emptyModel, schedule: [factOf('开工', '2025年6月1日')] } as unknown as DocumentFactsModel;
    expect(fabricatedStartDateIssues('进度计划节点：主体封顶2025年9月1日。', model)).toHaveLength(0);
  });
  it.each(['里程碑', '节点安排', '验收时间', '完成日期', '竣工日期', '移交日期', '合同签订'])('V1 进度类锚点「%s」上下文豁免', (anchor) => {
    const model = { ...emptyModel, schedule: [factOf('开工', '2025年6月1日')] } as unknown as DocumentFactsModel;
    expect(fabricatedStartDateIssues(`${anchor}：2025年9月1日。`, model)).toHaveLength(0);
  });
  it('V1 资料无日期时进度类上下文不豁免 → 1 条', () => {
    expect(fabricatedStartDateIssues('进度计划节点：主体封顶2025年9月1日。', emptyModel)).toHaveLength(1);
  });
  it('V1 4 处伪造日期 → slice(0,3) 截断 3 条', () => {
    expect(fabricatedStartDateIssues('2025年1月1日。2025年2月1日。2025年3月1日。2025年4月1日。', emptyModel)).toHaveLength(3);
  });
  it('V1 message 含伪造日期', () => {
    const issues = fabricatedStartDateIssues('计划于2025年6月1日开工。', emptyModel);
    expect(issues[0].message).toContain('2025年6月1日');
  });
});

// ── V2. fieldValueMismatchIssues 谱系 ──

describe('V2 字段-数值错配：占地面积误标建筑面积', () => {
  const siteModel = { ...emptyModel, project: [factOf('', '1000㎡', '总占地面积'), factOf('', '2000㎡', '单体建筑面积')] } as unknown as DocumentFactsModel;
  it('V2 正文「单体建筑面积1000㎡」恰为占地面积 → 1 条', () => {
    expect(fieldValueMismatchIssues('单体建筑面积1000㎡。', siteModel)).toHaveLength(1);
  });
  it('V2 正文「总建筑面积1000㎡」→ 1 条', () => {
    expect(fieldValueMismatchIssues('总建筑面积1000㎡。', siteModel)).toHaveLength(1);
  });
  it('V2 正文「建筑面积2000㎡」与建筑值一致 → 0 条', () => {
    expect(fieldValueMismatchIssues('建筑面积2000㎡。', siteModel)).toHaveLength(0);
  });
  it('V2 正文「建筑面积1,000㎡」千分位 → 1000 报 1 条', () => {
    expect(fieldValueMismatchIssues('建筑面积1,000㎡。', siteModel)).toHaveLength(1);
  });
  it('V2 无占地面积卡 → 0 条', () => {
    const model = { ...emptyModel, project: [factOf('', '2000㎡', '单体建筑面积')] } as unknown as DocumentFactsModel;
    expect(fieldValueMismatchIssues('单体建筑面积1000㎡。', model)).toHaveLength(0);
  });
  it('V2 无建筑面积卡 → 0 条', () => {
    const model = { ...emptyModel, project: [factOf('', '1000㎡', '总占地面积')] } as unknown as DocumentFactsModel;
    expect(fieldValueMismatchIssues('单体建筑面积1000㎡。', model)).toHaveLength(0);
  });
  it('V2 建筑值集合也含 1000 → 0 条（恰等建筑值不报）', () => {
    const model = { ...emptyModel, project: [factOf('', '1000㎡', '总占地面积'), factOf('', '1000㎡', '总建筑面积')] } as unknown as DocumentFactsModel;
    expect(fieldValueMismatchIssues('建筑面积1000㎡。', model)).toHaveLength(0);
  });
  it('V2 地上建筑面积卡被标签正则完整识别后过滤 → 建筑集合空 → 0 条', () => {
    const model = { ...emptyModel, project: [factOf('', '1000㎡', '总占地面积'), factOf('', '800㎡', '地上建筑面积')] } as unknown as DocumentFactsModel;
    expect(fieldValueMismatchIssues('建筑面积1000㎡。', model)).toHaveLength(0);
  });
  it('V2 正文「占地面积1000㎡」不匹配正文标签正则 → 0 条', () => {
    expect(fieldValueMismatchIssues('总占地面积1000㎡。', siteModel)).toHaveLength(0);
  });
  it('V2 4 处错配 → slice(0,3) 3 条', () => {
    expect(fieldValueMismatchIssues('单体建筑面积1000㎡。总建筑面积1000㎡。建筑面积1000㎡。建筑面积1000㎡。', siteModel)).toHaveLength(3);
  });
  it('V2 message 含正确建筑值', () => {
    const issues = fieldValueMismatchIssues('单体建筑面积1000㎡。', siteModel);
    expect(issues[0].message).toContain('2000');
  });
});

// ── V3. mergeTableLineResidues 谱系 ──

describe('V3 表格断行残片合并', () => {
  it('V3 单竖线残行拼回上一表格行末单元格', () => {
    const result = mergeTableLineResidues('| 施工准备 | 增开清表作业面， |\n延长有效作业时间 |');
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toBe('| 施工准备 | 增开清表作业面，延长有效作业时间 |');
  });
  it('V3 上单元格非中文标点结尾 → 空格拼接', () => {
    const result = mergeTableLineResidues('| 施工准备 | 作业面A |\n延长作业时间 |');
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toBe('| 施工准备 | 作业面A 延长作业时间 |');
  });
  it('V3 上一行非表格行 → 不合并', () => {
    const result = mergeTableLineResidues('正文段落。\n延长有效作业时间 |');
    expect(result.fixedCount).toBe(0);
  });
  it('V3 残行以竖线开头 → 不合并', () => {
    const result = mergeTableLineResidues('| 施工准备 | 作业面 |\n| 延长作业时间 |');
    expect(result.fixedCount).toBe(0);
  });
  it('V3 残行多竖线 → 不合并', () => {
    const result = mergeTableLineResidues('| 施工准备 | 作业面 |\n延长 | 作业 |');
    expect(result.fixedCount).toBe(0);
  });
  it('V3 残行为标题 → 不合并', () => {
    const result = mergeTableLineResidues('| 施工准备 | 作业面 |\n## 延长作业时间 |');
    expect(result.fixedCount).toBe(0);
  });
  it('V3 残行竖线不在结尾 → 不合并', () => {
    const result = mergeTableLineResidues('| 施工准备 | 作业面 |\n延长作业 | 时间');
    expect(result.fixedCount).toBe(0);
  });
  it('V3 连续两条残行逐条拼回（中文字标点结尾不加空格）', () => {
    const result = mergeTableLineResidues('| 施工准备 | 清表， |\n延长作业 |\n补充人员 |');
    expect(result.fixedCount).toBe(2);
    expect(result.markdown).toBe('| 施工准备 | 清表，延长作业 补充人员 |');
  });
  it('V3 表格正常行不受影响', () => {
    const result = mergeTableLineResidues('| 序号 | 内容 |\n| --- | --- |\n| 1 | 施工准备 |\n| 2 | 土方开挖 |');
    expect(result.fixedCount).toBe(0);
    expect(result.markdown).toContain('| 2 | 土方开挖 |');
  });
  it('V3 残行空白文本 trim 后空 → 不合并', () => {
    const result = mergeTableLineResidues('| 施工准备 | 清表 |\n   ');
    expect(result.fixedCount).toBe(0);
  });
});

// ── V4. finishThicknessIssues 谱系 ──

describe('V4 装饰层厚度异常检测', () => {
  it.each([
    ['找平层厚度200mm', 1],
    ['抹面 100mm', 1],
    ['坐浆层厚度150mm', 1],
    ['打底厚度 99mm', 0],
    ['墙体厚度200mm', 0],
    ['抹灰厚度200mm', 0],
    ['腻子层 100mm', 1],
    ['结合层 200mm', 1],
    ['找平层厚度 200 mm', 1],
    ['找平层厚度2000mm', 1],
  ] as const)('V4 「%s」→ %s 条', (body, exp: number) => {
    expect(finishThicknessIssues(body)).toHaveLength(exp);
  });
  it('V4 反向形态「200mm厚找平层」→ 1 条', () => {
    expect(finishThicknessIssues('200mm厚找平层。')).toHaveLength(1);
  });
  it('V4 反向形态「200mm厚墙体」→ 0 条', () => {
    expect(finishThicknessIssues('200mm厚墙体。')).toHaveLength(0);
  });
  it('V4 装饰词距数字超 10 字 → 0 条', () => {
    expect(finishThicknessIssues('找平层施工厚度为某某某某某某某某某某某200mm')).toHaveLength(0);
  });
  it('V4 3 处命中 → 1 条 issue 含全部 3 处', () => {
    const issues = finishThicknessIssues('找平层厚度200mm。打底100mm。坐浆150mm。');
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('200');
    expect(issues[0].message).toContain('100');
    expect(issues[0].message).toContain('150');
  });
  it('V4 4 处命中 → slice(0,3) 只报 3 处', () => {
    const issues = finishThicknessIssues('找平层200mm。打底100mm。坐浆150mm。罩面180mm。');
    expect(issues).toHaveLength(1);
    expect(issues[0].message).not.toContain('180');
  });
  it('V4 同一处两种形态重复命中 → Set 去重', () => {
    const issues = finishThicknessIssues('找平层厚度200mm。');
    expect(issues).toHaveLength(1);
  });
});
