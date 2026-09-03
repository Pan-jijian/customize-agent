/**
 * factConsistencyService 纯函数单测：
 * validateFactConsistency（严格单值字段的事实值冲突检测 + 对象名称覆盖检测）。
 * 覆盖：comparableValue 过滤链（诊断/禁止/表格行/见招标/是否+数字/编号行等）、
 * 工期数值归一化去冲突、严格字段判定（profile 字段与正则兜底）、长名泛化与短名精确匹配。
 */
import { describe, expect, it } from 'vitest';
import type { DocumentFact } from '@/services/document-workflow/types';
import type { ProjectMaterialSummary } from '@/services/document-core/projectMaterialService';
import { DEFAULT_DOCUMENT_DOMAIN_PROFILE } from '@/services/document-core/documentDomainProfileService';
import { validateFactConsistency } from '@/services/document-validation/factConsistencyService';

function makeFact(partial: Partial<DocumentFact>): DocumentFact {
  return {
    key: 'k1',
    value: '测试值',
    sourceFile: '材料A.pdf',
    roleId: 'r1',
    confidence: 0.9,
    ...partial,
  };
}

function makeSummary(partial: Partial<ProjectMaterialSummary> = {}): ProjectMaterialSummary {
  return {
    projectId: 'p1',
    projectName: '',
    generatedAt: Date.now(),
    fingerprint: { projectNames: [], documentNos: [], fileGroups: [], confidence: 0.9 },
    contaminationCandidates: [],
    source: { totalFiles: 5, selectedFiles: 5, selectionReason: '正常绑定', ambiguous: false },
    facts: {},
    materialInventory: {} as ProjectMaterialSummary['materialInventory'],
    extractedSections: {
      projectOverview: '', scopeSummary: '', designSummary: '', structuredDataSummary: '', scheduleQualitySafetySummary: '', constraintsAndRisks: '',
    },
    coverage: { requiredRoles: [], satisfiedRoles: [], missingRoles: [] },
    ...partial,
  };
}

function input(facts: DocumentFact[], summary: Partial<ProjectMaterialSummary> = {}) {
  return { markdown: '', facts, summary: makeSummary(summary), profile: DEFAULT_DOCUMENT_DOMAIN_PROFILE };
}

describe('事实值冲突检测', () => {
  it('同一严格字段两个不同值 → error 且含双方来源', () => {
    const issues = validateFactConsistency(input([
      makeFact({ key: '工期', fieldName: '工期', value: '540 日历天', sourceFile: '材料A.pdf' }),
      makeFact({ key: '工期2', fieldName: '工期', value: '600 日历天', sourceFile: '材料B.pdf' }),
    ]));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.level).toBe('error');
    expect(issues[0]!.message).toContain('事实一致性冲突');
    expect(issues[0]!.message).toContain('材料A.pdf');
    expect(issues[0]!.message).toContain('材料B.pdf');
  });

  it('同一字段相同值 → 不报', () => {
    const issues = validateFactConsistency(input([
      makeFact({ key: '工期', fieldName: '工期', value: '540 日历天', sourceFile: '材料A.pdf' }),
      makeFact({ key: '工期2', fieldName: '工期', value: '540日历天', sourceFile: '材料B.pdf' }),
    ]));
    expect(issues).toEqual([]);
  });

  it('空白差异归一化后视为同值', () => {
    const issues = validateFactConsistency(input([
      makeFact({ key: '招标人', fieldName: '招标人', value: '合肥师范学院' }),
      makeFact({ key: '招标人2', fieldName: '招标人', value: '合肥 师范 学院' }),
    ]));
    expect(issues).toEqual([]);
  });

  it('空 value 事实跳过', () => {
    const issues = validateFactConsistency(input([
      makeFact({ key: '工期', fieldName: '工期', value: '' }),
    ]));
    expect(issues).toEqual([]);
  });

  it('空 label 事实跳过', () => {
    const issues = validateFactConsistency(input([
      makeFact({ key: '', fieldName: '', value: '任意值' }),
    ]));
    expect(issues).toEqual([]);
  });

  it('多值 allow_multiple 字段不检查（质量要求）', () => {
    const issues = validateFactConsistency(input([
      makeFact({ key: '质量1', fieldName: '质量要求', value: '合格' }),
      makeFact({ key: '质量2', fieldName: '质量要求', value: '优良' }),
    ]));
    expect(issues).toEqual([]);
  });

  it('ignore 字段不检查（商务报价）', () => {
    const issues = validateFactConsistency(input([
      makeFact({ key: '报价1', fieldName: '报价', value: '100 万' }),
      makeFact({ key: '报价2', fieldName: '报价', value: '120 万' }),
    ]));
    expect(issues).toEqual([]);
  });

  it('无 profile 字段但命中严格正则兜底（招标人）→ 检查', () => {
    const issues = validateFactConsistency(input([
      makeFact({ key: '招标人', fieldName: '招标人', value: '甲公司' }),
      makeFact({ key: '招标人2', fieldName: '招标人', value: '乙公司' }),
    ]));
    expect(issues).toHaveLength(1);
  });

  it('不在正则兜底范围的字段跳过（施工单位）', () => {
    const issues = validateFactConsistency(input([
      makeFact({ key: '施工单位', fieldName: '施工单位', value: '甲公司' }),
      makeFact({ key: '施工单位2', fieldName: '施工单位', value: '乙公司' }),
    ]));
    expect(issues).toEqual([]);
  });

  it('单值字段不同值数量大于 2 时全部罗列', () => {
    const issues = validateFactConsistency(input([
      makeFact({ key: '工期1', fieldName: '工期', value: '540 日历天', sourceFile: 'A.pdf' }),
      makeFact({ key: '工期2', fieldName: '工期', value: '600 日历天', sourceFile: 'B.pdf' }),
      makeFact({ key: '工期3', fieldName: '工期', value: '720 日历天', sourceFile: 'C.pdf' }),
    ]));
    expect(issues).toHaveLength(1);
    const message = issues[0]!.message;
    expect(message).toContain('540');
    expect(message).toContain('600');
    expect(message).toContain('720');
  });
});

describe('comparableValue 过滤链', () => {
  const skipValues = [
    '投标报价 100 万',        // 禁止值
    'OCR 识别错误',           // 诊断值
    '联系电话：0551-123456',   // 电话关键词
    '| 表格行 | 数据 |',       // 表格行
    '# 标题行',               // markdown 标题
    '见招标公告第 3 条',       // 见招标
    '是否同意 123 条款',       // 是否 + 数字
    '项目名称：合肥项目编号',   // 项目名称 + 项目编号
    '项目编号：2026HFJS0034',  // 编号冒号
    '工程概况：位于合肥',       // 工程概况冒号
    '总建筑面积：28570 平方米', // 总建筑面积冒号
  ];
  it.each(skipValues)('过滤值不参与冲突：%s', (value) => {
    const issues = validateFactConsistency(input([
      makeFact({ key: 'a', fieldName: '工期', value: '540 日历天' }),
      makeFact({ key: 'b', fieldName: '工期', value }),
    ]));
    expect(issues).toEqual([]);
  });

  it('超长值（>80 字符）跳过', () => {
    const issues = validateFactConsistency(input([
      makeFact({ key: 'a', fieldName: '工期', value: '540 日历天' }),
      makeFact({ key: 'b', fieldName: '工期', value: '很长'.repeat(50) }),
    ]));
    expect(issues).toEqual([]);
  });

  it('工期数值归一化：带工期前缀与纯数值同值', () => {
    // 含工期词的值只取 duration 部分参与比较，与不带前缀的纯数值归为一组
    const issues = validateFactConsistency(input([
      makeFact({ key: 'a', fieldName: '总工期', value: '总工期 540 日历天' }),
      makeFact({ key: 'b', fieldName: '总工期', value: '540 日历天' }),
    ]));
    expect(issues).toEqual([]);
  });

  it('工期数值不同 → 冲突', () => {
    const issues = validateFactConsistency(input([
      makeFact({ key: 'a', fieldName: '总工期', value: '总工期 540 日历天' }),
      makeFact({ key: 'b', fieldName: '总工期', value: '600 日历天' }),
    ]));
    expect(issues).toHaveLength(1);
  });

  it('非工期字段含天数数字不触发工期归一', () => {
    // '面积 540 平方米' 不含工期词 → 整串归一，与 '600 平方米' 冲突
    const issues = validateFactConsistency(input([
      makeFact({ key: 'a', fieldName: '建筑面积', value: '540 平方米' }),
      makeFact({ key: 'b', fieldName: '建筑面积', value: '600 平方米' }),
    ]));
    expect(issues).toHaveLength(1);
  });
});

describe('对象名称覆盖检测', () => {
  const summaryWithName = (name: string) => makeSummary({ facts: { projectName: name } });

  it('项目名未体现 → warning', () => {
    const issues = validateFactConsistency({ markdown: '正文内容。', facts: [], summary: summaryWithName('合肥师范学院滨湖校区项目'), profile: DEFAULT_DOCUMENT_DOMAIN_PROFILE });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.level).toBe('warning');
    expect(issues[0]!.message).toContain('合肥师范学院滨湖校区项目');
  });

  it('项目名已体现 → 不报', () => {
    const issues = validateFactConsistency({ markdown: '合肥师范学院滨湖校区项目概况。', facts: [], summary: summaryWithName('合肥师范学院滨湖校区项目'), profile: DEFAULT_DOCUMENT_DOMAIN_PROFILE });
    expect(issues).toEqual([]);
  });

  it('当前知识库项目豁免', () => {
    const issues = validateFactConsistency({ markdown: '正文内容。', facts: [], summary: summaryWithName('当前知识库项目'), profile: DEFAULT_DOCUMENT_DOMAIN_PROFILE });
    expect(issues).toEqual([]);
  });

  it('路径包名项目名豁免', () => {
    const issues = validateFactConsistency({ markdown: '正文内容。', facts: [], summary: summaryWithName('资料--2024.03扫描'), profile: DEFAULT_DOCUMENT_DOMAIN_PROFILE });
    expect(issues).toEqual([]);
  });

  it('短项目名（4-7 字符）只做精确匹配', () => {
    const summary = summaryWithName('徽光阁项目施工');
    // 正文只有前 4 字，不视为覆盖
    const issues = validateFactConsistency({ markdown: '徽光阁项目', facts: [], summary, profile: DEFAULT_DOCUMENT_DOMAIN_PROFILE });
    expect(issues).toHaveLength(1);
    // 精确包含则覆盖
    const noIssues = validateFactConsistency({ markdown: '徽光阁项目施工概况。', facts: [], summary, profile: DEFAULT_DOCUMENT_DOMAIN_PROFILE });
    expect(noIssues).toEqual([]);
  });

  it('长项目名 72% 前缀泛化匹配', () => {
    const summary = summaryWithName('合肥师范学院滨湖校区施工总承包项目');
    const issues = validateFactConsistency({ markdown: '合肥师范学院滨湖校区施工总承包……', facts: [], summary, profile: DEFAULT_DOCUMENT_DOMAIN_PROFILE });
    expect(issues).toEqual([]);
  });

  it('括号内容去除后的变体匹配', () => {
    const summary = summaryWithName('合肥师范学院（滨湖校区）项目');
    const issues = validateFactConsistency({ markdown: '合肥师范学院项目概况。', facts: [], summary, profile: DEFAULT_DOCUMENT_DOMAIN_PROFILE });
    expect(issues).toEqual([]);
  });
});
