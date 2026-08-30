/**
 * documentValidationService 纯函数单测：
 * validateDraftWithAutoSpec（必填事实覆盖检测/关键对象名称/文档编号/后台话术）。
 * 覆盖：短名与路径包名豁免、归一化匹配（去编号/去副本后缀/去空白标点）、长名 72% 泛化截断。
 */
import { describe, expect, it } from 'vitest';
import type { AutoDocumentSpecPackage } from '../document-core/autoDocumentSpecTypes';
import type { ProjectMaterialSummary } from '../document-core/projectMaterialService';
import { validateDraftWithAutoSpec } from './documentValidationService';

function makeSpec(fields: Array<{ name: string; required?: boolean }>): AutoDocumentSpecPackage {
  return {
    id: 'spec-1',
    name: '测试规范包',
    description: '',
    factFields: fields.map((field, index) => ({
      id: `f${index}`,
      name: field.name,
      type: 'auto',
      required: field.required ?? true,
    })),
    chapterMode: 'fixed',
    chapterRules: [],
    dynamicChapterRule: { source: 'ai_plan', minChapters: 0, maxChapters: 0 },
    gateRules: [],
  };
}

function makeSummary(partial: Partial<ProjectMaterialSummary['facts']> = {}): ProjectMaterialSummary {
  return {
    projectId: 'p1',
    // 默认空项目名，避免干扰「无问题」断言语义；项目名检测用例显式传入
    projectName: '',
    generatedAt: Date.now(),
    fingerprint: { projectNames: [], documentNos: [], fileGroups: [], confidence: 0.9 },
    contaminationCandidates: [],
    source: { totalFiles: 5, selectedFiles: 5, selectionReason: '正常绑定', ambiguous: false },
    facts: partial,
    materialInventory: {} as ProjectMaterialSummary['materialInventory'],
    extractedSections: {
      projectOverview: '', scopeSummary: '', designSummary: '', structuredDataSummary: '', scheduleQualitySafetySummary: '', constraintsAndRisks: '',
    },
    coverage: { requiredRoles: [], satisfiedRoles: [], missingRoles: [] },
  };
}

describe('必填事实覆盖检测', () => {
  it('必填字段未出现在正文 → info', () => {
    const spec = makeSpec([{ name: '总建筑面积' }]);
    const issues = validateDraftWithAutoSpec({ markdown: '本工程概况。', spec, summary: makeSummary() });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.level).toBe('info');
    expect(issues[0]!.message).toContain('总建筑面积');
  });

  it('必填字段已覆盖 → 不报', () => {
    const spec = makeSpec([{ name: '总建筑面积' }]);
    expect(validateDraftWithAutoSpec({ markdown: '本工程总建筑面积 28570.36 平方米。', spec, summary: makeSummary() })).toEqual([]);
  });

  it('非必填字段缺失 → 不报', () => {
    const spec = makeSpec([{ name: '总建筑面积', required: false }]);
    expect(validateDraftWithAutoSpec({ markdown: '无相关内容。', spec, summary: makeSummary() })).toEqual([]);
  });

  it('短字段名（<4 字符）不检查', () => {
    const spec = makeSpec([{ name: '工期' }]);
    expect(validateDraftWithAutoSpec({ markdown: '无相关内容。', spec, summary: makeSummary() })).toEqual([]);
  });

  it('路径包名形态字段不检查', () => {
    const pathLikeNames = ['资料汇总（1）', '2024.03 扫描', '附件打包', '目录备份'];
    const spec = makeSpec(pathLikeNames.map(name => ({ name })));
    expect(validateDraftWithAutoSpec({ markdown: '无相关内容。', spec, summary: makeSummary() })).toEqual([]);
  });

  it('空白与标点差异归一化后视为覆盖', () => {
    const spec = makeSpec([{ name: '结构形式' }]);
    expect(validateDraftWithAutoSpec({ markdown: '结构 形 式：框架结构。', spec, summary: makeSummary() })).toEqual([]);
  });

  it('（数字）编号与副本/扫描件后缀归一化', () => {
    const spec = makeSpec([{ name: '招标公告' }]);
    expect(validateDraftWithAutoSpec({ markdown: '见（3）招标公告（副本）（最终版）。', spec, summary: makeSummary() })).toEqual([]);
  });

  it('英文大小写归一化', () => {
    const spec = makeSpec([{ name: 'GB50300' }]);
    expect(validateDraftWithAutoSpec({ markdown: '依据 gb50300 执行。', spec, summary: makeSummary() })).toEqual([]);
  });

  it('长字段名 72% 前缀泛化匹配', () => {
    // '合肥师范学院滨湖校区总建筑面积' 长度 15，72% 截断 10 字即可视为覆盖
    const spec = makeSpec([{ name: '合肥师范学院滨湖校区总建筑面积' }]);
    expect(validateDraftWithAutoSpec({ markdown: '合肥师范学院滨湖校区总建筑……', spec, summary: makeSummary() })).toEqual([]);
  });

  it('归一化后长度不足 4 的字段值视为已覆盖（不报）', () => {
    const spec = makeSpec([{ name: '，。' }]);
    expect(validateDraftWithAutoSpec({ markdown: '无相关内容。', spec, summary: makeSummary() })).toEqual([]);
  });
});

describe('关键对象名称检测', () => {
  it('项目名未在正文体现 → warning', () => {
    const issues = validateDraftWithAutoSpec({ markdown: '本工程概况。', spec: makeSpec([]), summary: makeSummary({ projectName: '合肥师范学院滨湖校区项目' }) });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.level).toBe('warning');
    expect(issues[0]!.message).toContain('关键对象名称');
  });

  it('项目名已体现 → 不报', () => {
    const summary = makeSummary({ projectName: '合肥师范学院滨湖校区项目' });
    expect(validateDraftWithAutoSpec({ markdown: '合肥师范学院滨湖校区项目概况。', spec: makeSpec([]), summary })).toEqual([]);
  });

  it('当前知识库项目豁免', () => {
    const summary = makeSummary({ projectName: '当前知识库项目' });
    expect(validateDraftWithAutoSpec({ markdown: '正文内容。', spec: makeSpec([]), summary })).toEqual([]);
  });

  it('路径包名项目名豁免', () => {
    const summary = makeSummary({ projectName: '资料--2024.03扫描' });
    expect(validateDraftWithAutoSpec({ markdown: '正文内容。', spec: makeSpec([]), summary })).toEqual([]);
  });
});

describe('文档编号检测', () => {
  it('文档编号未在正文体现 → info', () => {
    const summary = makeSummary({ documentNo: '2026HFJS0034' });
    const issues = validateDraftWithAutoSpec({ markdown: '正文内容。', spec: makeSpec([]), summary });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.level).toBe('info');
    expect(issues[0]!.message).toContain('文档/任务编号');
  });

  it('文档编号已体现 → 不报', () => {
    const summary = makeSummary({ documentNo: '2026HFJS0034' });
    expect(validateDraftWithAutoSpec({ markdown: '编号 2026HFJS0034。', spec: makeSpec([]), summary })).toEqual([]);
  });

  it('无文档编号 → 不报', () => {
    expect(validateDraftWithAutoSpec({ markdown: '正文内容。', spec: makeSpec([]), summary: makeSummary() })).toEqual([]);
  });
});

describe('后台流程话术检测', () => {
  const forbiddenWords = ['知识库证据', '资料类型', '提示词角色', '文档规范包', '规范包', '后台自动规范', '后台优化建议', '基础事实候选', '材料未提供', '未检索到'];

  it.each(forbiddenWords)('话术「%s」→ error', (word) => {
    const issues = validateDraftWithAutoSpec({ markdown: `正文包含${word}字样。`, spec: makeSpec([]), summary: makeSummary() });
    expect(issues.length).toBeGreaterThanOrEqual(1);
    const hit = issues.find(issue => issue.message.includes(word));
    expect(hit?.level).toBe('error');
  });

  it('正常正文不报', () => {
    expect(validateDraftWithAutoSpec({ markdown: '本工程施工组织安排合理。', spec: makeSpec([]), summary: makeSummary() })).toEqual([]);
  });

  it('空正文安全', () => {
    const issues = validateDraftWithAutoSpec({ markdown: '', spec: makeSpec([{ name: '总建筑面积' }]), summary: makeSummary() });
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues.every(issue => issue.level === 'info')).toBe(true);
  });
});
