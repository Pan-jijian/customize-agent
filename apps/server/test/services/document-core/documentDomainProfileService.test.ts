/**
 * documentDomainProfileService 纯函数单测：
 * factFieldForLabel（别名双向包含匹配）/ fieldMatchesCategory /
 * isForbiddenFactValue / isDiagnosticFactValue / isLowConfidenceFactValue /
 * resolveDocumentDomainProfile（施工组织设计域解析）。
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DOCUMENT_DOMAIN_PROFILE,
  CONSTRUCTION_ORGANIZATION_PROFILE,
  factFieldForLabel,
  fieldMatchesCategory,
  isDiagnosticFactValue,
  isForbiddenFactValue,
  isLowConfidenceFactValue,
  resolveDocumentDomainProfile,
  type DocumentDomainProfile,
} from '@/services/document-core/documentDomainProfileService';

describe('factFieldForLabel 名称与别名匹配', () => {
  it('精确 name 命中', () => {
    expect(factFieldForLabel(DEFAULT_DOCUMENT_DOMAIN_PROFILE, '对象名称')?.id).toBe('document_identity');
    expect(factFieldForLabel(DEFAULT_DOCUMENT_DOMAIN_PROFILE, '质量要求')?.id).toBe('quality_requirement');
  });

  it('label 含别名命中（如“总工期要求”含别名“工期”）', () => {
    expect(factFieldForLabel(DEFAULT_DOCUMENT_DOMAIN_PROFILE, '总工期要求')?.id).toBe('schedule_requirement');
    expect(factFieldForLabel(DEFAULT_DOCUMENT_DOMAIN_PROFILE, '招标项目名称')?.id).toBe('document_identity');
  });

  it('别名含 label 命中（如“工期”被别名“计划工期”包含）', () => {
    expect(factFieldForLabel(DEFAULT_DOCUMENT_DOMAIN_PROFILE, '工期')?.id).toBe('schedule_requirement');
  });

  it('无命中返回 undefined', () => {
    expect(factFieldForLabel(DEFAULT_DOCUMENT_DOMAIN_PROFILE, '毫不相关词')).toBeUndefined();
    expect(factFieldForLabel(DEFAULT_DOCUMENT_DOMAIN_PROFILE, '')).toBeUndefined();
  });
});

describe('fieldMatchesCategory 类别判断', () => {
  it('身份/工期/商务类别归属正确', () => {
    expect(fieldMatchesCategory(DEFAULT_DOCUMENT_DOMAIN_PROFILE, '项目名称', 'identity')).toBe(true);
    expect(fieldMatchesCategory(DEFAULT_DOCUMENT_DOMAIN_PROFILE, '计划工期', 'schedule')).toBe(true);
    expect(fieldMatchesCategory(DEFAULT_DOCUMENT_DOMAIN_PROFILE, '报价', 'commercial')).toBe(true);
  });

  it('类别不匹配返回 false', () => {
    expect(fieldMatchesCategory(DEFAULT_DOCUMENT_DOMAIN_PROFILE, '项目名称', 'schedule')).toBe(false);
    expect(fieldMatchesCategory(DEFAULT_DOCUMENT_DOMAIN_PROFILE, '不存在字段', 'identity')).toBe(false);
  });
});

describe('isForbiddenFactValue 禁止值检测', () => {
  const forbiddenCases = ['投标报价为 100 万', '报价明细表', '综合单价 300 元', '预留金 5 万', '暂列金额', '增值税税率', '利润空间'];
  it.each(forbiddenCases)('禁止值：%s', (value) => {
    expect(isForbiddenFactValue(DEFAULT_DOCUMENT_DOMAIN_PROFILE, value)).toBe(true);
  });

  it('普通事实值不误报', () => {
    expect(isForbiddenFactValue(DEFAULT_DOCUMENT_DOMAIN_PROFILE, '总建筑面积 28570.36 平方米')).toBe(false);
    expect(isForbiddenFactValue(DEFAULT_DOCUMENT_DOMAIN_PROFILE, '总工期 540 日历天')).toBe(false);
  });
});

describe('isDiagnosticFactValue 诊断值检测', () => {
  const diagnosticCases = [
    'OCR 识别错误',
    '无法确认的数值',
    '疑似错误',
    '# 绑定片段',
    '见招标公告第 3 条',
    '文件路径 D:/xxx',
    'PDF 第 5 页',
    'Excel 表格',
  ];
  it.each(diagnosticCases)('诊断值：%s', (value) => {
    expect(isDiagnosticFactValue(DEFAULT_DOCUMENT_DOMAIN_PROFILE, value)).toBe(true);
  });

  it('普通值不误报', () => {
    expect(isDiagnosticFactValue(DEFAULT_DOCUMENT_DOMAIN_PROFILE, '总工期 540 日历天')).toBe(false);
  });
});

describe('isLowConfidenceFactValue 低置信值检测', () => {
  it.each(['无法确认', '疑似', '不确定', '需复核', '文字模糊', '语义断裂', '识别错误', '乱码'])('低置信值：%s', (value) => {
    expect(isLowConfidenceFactValue(DEFAULT_DOCUMENT_DOMAIN_PROFILE, value)).toBe(true);
  });

  it('正常值不误报', () => {
    expect(isLowConfidenceFactValue(DEFAULT_DOCUMENT_DOMAIN_PROFILE, '合格')).toBe(false);
  });
});

describe('resolveDocumentDomainProfile 域解析', () => {
  const baseTemplate = { id: 't1', name: '普通模板', category: '报告', description: '', outputTitle: '' };

  it('模板名含施工组织设计 → 施工域', () => {
    const profile = resolveDocumentDomainProfile({ ...baseTemplate, name: '施工组织设计模板' });
    expect(profile.id).toBe(CONSTRUCTION_ORGANIZATION_PROFILE.id);
  });

  it('requirement 含危大工程 → 施工域', () => {
    const profile = resolveDocumentDomainProfile(baseTemplate, '需要编制危大工程专项方案');
    expect(profile.id).toBe(CONSTRUCTION_ORGANIZATION_PROFILE.id);
  });

  it('category 含施工方案 → 施工域', () => {
    const profile = resolveDocumentDomainProfile({ ...baseTemplate, category: '施工方案' });
    expect(profile.id).toBe(CONSTRUCTION_ORGANIZATION_PROFILE.id);
  });

  it('description 含安全文明施工 → 施工域', () => {
    const profile = resolveDocumentDomainProfile({ ...baseTemplate, description: '涉及安全文明施工' });
    expect(profile.id).toBe(CONSTRUCTION_ORGANIZATION_PROFILE.id);
  });

  it('普通模板与空要求 → 通用域', () => {
    expect(resolveDocumentDomainProfile(baseTemplate).id).toBe(DEFAULT_DOCUMENT_DOMAIN_PROFILE.id);
    expect(resolveDocumentDomainProfile(undefined).id).toBe(DEFAULT_DOCUMENT_DOMAIN_PROFILE.id);
  });

  it('施工域与通用域共享 factFields（展开继承）', () => {
    expect(CONSTRUCTION_ORGANIZATION_PROFILE.factFields).toEqual(DEFAULT_DOCUMENT_DOMAIN_PROFILE.factFields);
  });
});

describe('自定义 profile 行为', () => {
  const custom: DocumentDomainProfile = {
    id: 'custom',
    name: '自定义',
    factFields: [
      {
        id: 'f1',
        name: '自定义字段',
        aliases: ['别名A'],
        category: 'other',
        cardinality: 'single',
        derivationPolicy: 'source_only',
        usagePolicy: 'must_use',
        confidencePolicy: { minForGeneration: 0.8, minForValidation: 0.8, allowPathOnly: false },
        conflictPolicy: 'strict',
      },
    ],
    forbiddenValuePatterns: [/禁词/u],
    diagnosticValuePatterns: [/诊断词/u],
    lowConfidenceValuePatterns: [/低置信/u],
  };

  it('自定义 profile 独立生效', () => {
    expect(factFieldForLabel(custom, '自定义字段')?.id).toBe('f1');
    expect(factFieldForLabel(custom, '含别名A的文本')?.id).toBe('f1');
    expect(factFieldForLabel(custom, '对象名称')).toBeUndefined();
    expect(isForbiddenFactValue(custom, '出现禁词')).toBe(true);
    expect(isDiagnosticFactValue(custom, '出现诊断词')).toBe(true);
    expect(isLowConfidenceFactValue(custom, '低置信')).toBe(true);
    expect(isForbiddenFactValue(custom, '投标报价')).toBe(false);
  });
});
