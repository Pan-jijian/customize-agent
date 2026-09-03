/**
 * documentContaminationService 纯函数单测：
 * validateProjectContamination（对象名称污染检测 + 外来文档编号检测）。
 * 覆盖：候选名长度门槛（≥6）、当前对象豁免、空白归一化匹配、编号格式约束。
 */
import { describe, expect, it } from 'vitest';
import type { ProjectMaterialSummary } from '@/services/document-core/projectMaterialService';
import { validateProjectContamination } from '@/services/document-validation/documentContaminationService';

function makeSummary(partial: Partial<ProjectMaterialSummary> = {}): ProjectMaterialSummary {
  return {
    projectId: 'p1',
    projectName: '合肥师范学院滨湖校区项目',
    generatedAt: Date.now(),
    fingerprint: {
      projectNames: [],
      documentNos: [],
      fileGroups: [],
      confidence: 0.9,
    },
    contaminationCandidates: [],
    source: {
      totalFiles: 5,
      selectedFiles: 5,
      selectionReason: '正常绑定',
      ambiguous: false,
    },
    facts: {},
    materialInventory: {} as ProjectMaterialSummary['materialInventory'],
    extractedSections: {
      projectOverview: '',
      scopeSummary: '',
      designSummary: '',
      structuredDataSummary: '',
      scheduleQualitySafetySummary: '',
      constraintsAndRisks: '',
    },
    coverage: { requiredRoles: [], satisfiedRoles: [], missingRoles: [] },
    ...partial,
  };
}

describe('对象名称污染检测', () => {
  it('候选名长度不足 6 字符不报', () => {
    const summary = makeSummary({ contaminationCandidates: ['徽光阁', 'xxx'] });
    expect(validateProjectContamination('正文提到徽光阁。', summary)).toEqual([]);
  });

  it('候选名等于当前项目名不报', () => {
    const summary = makeSummary({ contaminationCandidates: ['合肥师范学院滨湖校区项目'] });
    expect(validateProjectContamination('合肥师范学院滨湖校区项目概况。', summary)).toEqual([]);
  });

  it('候选名在指纹项目名列表不报', () => {
    const summary = makeSummary({
      fingerprint: { projectNames: ['徽光阁小学项目'], documentNos: [], fileGroups: [], confidence: 0.9 },
      contaminationCandidates: ['徽光阁小学项目'],
    });
    expect(validateProjectContamination('徽光阁小学项目位于合肥。', summary)).toEqual([]);
  });

  it('外来对象名命中 → error', () => {
    const summary = makeSummary({ contaminationCandidates: ['安徽理工大学项目'] });
    const issues = validateProjectContamination('正文混入安徽理工大学项目内容。', summary);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.level).toBe('error');
    expect(issues[0]!.message).toContain('安徽理工大学项目');
  });

  it('空白差异归一化后仍命中', () => {
    const summary = makeSummary({ contaminationCandidates: ['安徽理工大学新校区项目'] });
    const issues = validateProjectContamination('正文提到安徽 理工 大学 新校区 项目。', summary);
    expect(issues).toHaveLength(1);
  });

  it('候选未出现在正文不报', () => {
    const summary = makeSummary({ contaminationCandidates: ['安徽理工大学项目'] });
    expect(validateProjectContamination('正文内容完全无关。', summary)).toEqual([]);
  });

  it('多候选只报命中项', () => {
    const summary = makeSummary({ contaminationCandidates: ['安徽理工大学项目', '南京工业大学项目'] });
    const issues = validateProjectContamination('正文包含安徽理工大学项目。', summary);
    expect(issues.map(issue => issue.message)).toEqual(['正文疑似混入其他对象名称：安徽理工大学项目']);
  });

  it('空正文与空候选安全', () => {
    expect(validateProjectContamination('', makeSummary())).toEqual([]);
    expect(validateProjectContamination('正文内容', makeSummary())).toEqual([]);
  });
});

describe('外来文档编号检测', () => {
  const foreignNo = '2026AHGG0012';

  it('编号不在本地编号列表 → error', () => {
    const summary = makeSummary({
      fingerprint: { projectNames: [], documentNos: ['2026HFJS0034'], fileGroups: [], confidence: 0.9 },
    });
    const issues = validateProjectContamination(`正文出现 ${foreignNo} 编号。`, summary);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain(foreignNo);
  });

  it('编号在本地列表 → 不报', () => {
    const summary = makeSummary({
      fingerprint: { projectNames: [], documentNos: [foreignNo], fileGroups: [], confidence: 0.9 },
    });
    expect(validateProjectContamination(`正文出现 ${foreignNo} 编号。`, summary)).toEqual([]);
  });

  it('本地编号列表为空 → 不报编号问题', () => {
    const summary = makeSummary();
    expect(validateProjectContamination(`正文出现 ${foreignNo} 编号。`, summary)).toEqual([]);
  });

  it('不符合编号形态的文本不触发', () => {
    const summary = makeSummary({
      fingerprint: { projectNames: [], documentNos: ['2026HFJS0034'], fileGroups: [], confidence: 0.9 },
    });
    // 尾数不足 4 位 / 前缀不足 4 数字 / 无中间大写段
    expect(validateProjectContamination('编号 2026AB12。', summary)).toEqual([]);
    expect(validateProjectContamination('编号 26AB1234。', summary)).toEqual([]);
    expect(validateProjectContamination('编号 20261234。', summary)).toEqual([]);
  });

  it('多个外来编号只报第一个', () => {
    const summary = makeSummary({
      fingerprint: { projectNames: [], documentNos: ['2026HFJS0034'], fileGroups: [], confidence: 0.9 },
    });
    const issues = validateProjectContamination(`正文有 2026AHGG0012 和 2026BJDD0088 两个编号。`, summary);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain('2026AHGG0012');
  });

  it('名称与编号同时命中各报一条', () => {
    const summary = makeSummary({
      fingerprint: { projectNames: [], documentNos: ['2026HFJS0034'], fileGroups: [], confidence: 0.9 },
      contaminationCandidates: ['安徽理工大学项目'],
    });
    const issues = validateProjectContamination('安徽理工大学项目，编号 2026AHGG0012。', summary);
    expect(issues).toHaveLength(2);
    expect(issues.some(issue => issue.message.includes('安徽理工大学项目'))).toBe(true);
    expect(issues.some(issue => issue.message.includes('2026AHGG0012'))).toBe(true);
  });
});
