import { describe, expect, it } from 'vitest';
import { applyScopeConflictResolutions, detectNumericScopeConflicts } from '../src/services/document-workflow/factGovernance';
import { extractProjectBasicFactsFromEvidence } from '../src/services/document-workflow/factsModel';
import { crossChapterConsistencyIssues } from '../src/services/document-workflow/qualityValidation';
import type { DocumentEvidence, DocumentFact, DocumentFactsModel } from '../src/services/document-workflow/types';

function fact(key: string, value: string, sourceFile: string, roleId = 'local'): DocumentFact {
  return { key, value, sourceFile, roleId, confidence: 1 };
}

function evidence(filePath: string, content: string): DocumentEvidence {
  return { chapterId: 'ch-1', filePath, score: 1, content, roleId: 'material' };
}

describe('detectNumericScopeConflicts', () => {
  it('跨文件同口径建设规模冲突：补疑优先级最高，裁决为补疑值', () => {
    const facts = [
      fact('project_scale_1', '建设规模：总建筑面积约4645㎡', '招标文件.pdf'),
      fact('project_scale_2', '建设规模：总建筑面积约4646㎡', '徽光阁项目施工补疑1.pdf'),
    ];
    const conflicts = detectNumericScopeConflicts(facts);
    const conflict = conflicts.find(item => item.kind === 'area');
    expect(conflict).toBeDefined();
    expect(conflict!.resolution).toBe('4646㎡');
    expect(conflict!.values.map(value => `${value.value}${value.unit}`)).toContain('4645㎡');
  });

  it('同文件内不同数值不判冲突（分层口径隔离）', () => {
    const facts = [
      fact('project_scale_1', '总建筑面积4646㎡；地上建筑面积3200㎡', '招标文件.pdf'),
    ];
    const conflicts = detectNumericScopeConflicts(facts);
    const conflict = conflicts.find(item => item.kind === 'area');
    expect(conflict).toBeUndefined();
  });

  it('同一口径无跨文件差异时不产生裁决', () => {
    const facts = [
      fact('project_scale_1', '建设规模：总建筑面积约4646㎡', '招标文件.pdf'),
      fact('project_scale_2', '建设规模：总建筑面积约4646㎡', '图纸.pdf'),
    ];
    expect(detectNumericScopeConflicts(facts)).toEqual([]);
  });
});

describe('applyScopeConflictResolutions', () => {
  it('面积类事实败选值回写为裁决值', () => {
    const facts = [
      fact('project_scale_1', '建设规模：总建筑面积约4645㎡', '招标文件.pdf'),
      fact('project_scale_2', '建设规模：总建筑面积约4646㎡', '徽光阁项目施工补疑1.pdf'),
    ];
    const conflicts = detectNumericScopeConflicts(facts);
    const resolved = applyScopeConflictResolutions(facts, conflicts);
    const scale = resolved.find(item => item.key === 'project_scale_1');
    expect(scale!.value).toBe('建设规模：总建筑面积约4646㎡');
  });

  it('无裁决时原样返回', () => {
    const facts = [fact('project_scale_1', '建设规模：总建筑面积约4646㎡', '招标文件.pdf')];
    const resolved = applyScopeConflictResolutions(facts, detectNumericScopeConflicts(facts));
    expect(resolved).toBe(facts);
  });

  it('非相关字段不受裁决影响', () => {
    const facts = [
      fact('project_scale_1', '建设规模：总建筑面积约4645㎡', '招标文件.pdf'),
      fact('project_scale_2', '建设规模：总建筑面积约4646㎡', '徽光阁项目施工补疑1.pdf'),
      fact('schedule_1', '计划工期45日历天', '招标文件.pdf'),
    ];
    const conflicts = detectNumericScopeConflicts(facts);
    const resolved = applyScopeConflictResolutions(facts, conflicts);
    expect(resolved.find(item => item.key === 'schedule_1')!.value).toBe('计划工期45日历天');
  });
});

describe('补疑优先与源头裁决（回归：无“总”字前缀 + 单位保留）', () => {
  it('招标正文“建筑面积约为4645㎡”（无“总”字前缀）与补疑4646㎡冲突时裁决补疑', () => {
    const facts = [
      fact('project_scale_1', '建设规模：建筑面积约为4645㎡', '招标文件.pdf'),
      fact('project_scale_2', '建设规模：建筑面积约为4646㎡', '徽光阁项目施工补疑1.pdf'),
    ];
    const conflicts = detectNumericScopeConflicts(facts);
    const conflict = conflicts.find(item => item.kind === 'area');
    expect(conflict).toBeDefined();
    expect(conflict!.resolution).toBe('4646㎡');
    expect(conflict!.values.map(value => `${value.value}${value.unit}`)).toContain('4645㎡');
  });

  it('败选数值回写保留败选单位：4645平方米 → 4646平方米', () => {
    const facts = [
      fact('project_scale_1', '建设规模：建筑面积约4645平方米', '招标文件.pdf'),
      fact('project_scale_2', '建设规模：建筑面积约4646㎡', '徽光阁项目施工补疑1.pdf'),
    ];
    const conflicts = detectNumericScopeConflicts(facts);
    const resolved = applyScopeConflictResolutions(facts, conflicts);
    expect(resolved.find(item => item.key === 'project_scale_1')!.value).toBe('建设规模：建筑面积约4646平方米');
  });

  it('非对称“总”字：招标正文无“总”字 + 补疑带“总”字也必须归入同组检出（历史漏检：分组按原文词隔离）', () => {
    const facts = [
      fact('project_scale_1', '项目位于安庆路城隍庙南大门内，建筑面积约为4645㎡', '招标文件正文.pdf'),
      fact('project_scale_2', '总建筑面积约4646m2', '补疑1.docx'),
    ];
    const conflicts = detectNumericScopeConflicts(facts);
    const conflict = conflicts.find(item => item.kind === 'area');
    expect(conflict).toBeDefined();
    expect(conflict!.resolution).toBe('4646m2');
    expect(conflict!.values.map(value => `${value.value}${value.unit}`)).toContain('4645㎡');
  });
});

describe('crossChapterConsistencyIssues 校验基准与裁决同源', () => {
  function factsModel(project: DocumentFact[]): DocumentFactsModel {
    return { project, schedule: [], quality: [], safety: [], resources: [], tables: [], drawings: [], bills: [], preciseFacts: [], rules: [], specifications: [], schemaFacts: {}, factIndex: {}, missing: [], conflicts: [] } as unknown as DocumentFactsModel;
  }
  const conflictingFacts = [
    fact('project_scale_1', '项目位于安庆路城隍庙南大门内，建筑面积约为4645㎡', '招标文件正文.pdf'),
    fact('project_scale_2', '总建筑面积约4646m2', '补疑1.docx'),
  ];

  it('正文全用裁决胜出值时不误报（历史缺陷：主表取出败选值导致误报）', () => {
    const conflicts = detectNumericScopeConflicts(conflictingFacts);
    const markdown = '# 工程概况\n本项目建设规模为总建筑面积约4646㎡，共地上二层。';
    const issues = crossChapterConsistencyIssues(markdown, factsModel(conflictingFacts), conflicts);
    expect(issues.filter(issue => issue.message.includes('建设规模'))).toEqual([]);
  });

  it('正文混写败选值（无“总”字口径）时确定性检出 error', () => {
    const conflicts = detectNumericScopeConflicts(conflictingFacts);
    const markdown = '# 工程概况\n本项目建设规模为总建筑面积约4646㎡。\n# 施工部署\n现场建筑面积约为4645㎡，场地狭小。';
    const issues = crossChapterConsistencyIssues(markdown, factsModel(conflictingFacts), conflicts);
    const scaleIssue = issues.find(issue => issue.message.includes('建设规模'));
    expect(scaleIssue).toBeDefined();
    expect(scaleIssue!.level).toBe('error');
    expect(scaleIssue!.message).toContain('4645㎡');
  });
});

describe('跨章一致性口径隔离（回归：用地面积误报导致导出门禁阻断）', () => {
  function factsModel(project: DocumentFact[]): DocumentFactsModel {
    return { project, schedule: [], quality: [], safety: [], resources: [], tables: [], drawings: [], bills: [], preciseFacts: [], rules: [], specifications: [], schemaFacts: {}, factIndex: {}, missing: [], conflicts: [] } as unknown as DocumentFactsModel;
  }
  const conflictingFacts = [
    fact('project_scale_1', '项目位于安庆路城隍庙南大门内，建筑面积约为4645㎡', '招标文件正文.pdf'),
    fact('project_scale_2', '总建筑面积约4646m2', '补疑1.docx'),
  ];

  it('正文正确转述资料用地面积不误报（历史缺陷：用地面积与建设规模混比，门禁阻断）', () => {
    const conflicts = detectNumericScopeConflicts(conflictingFacts);
    const markdown = '# 工程概况\n本项目总用地面积28570.36平方米，建设规模为总建筑面积约4646㎡，场地平整。';
    const issues = crossChapterConsistencyIssues(markdown, factsModel(conflictingFacts), conflicts);
    expect(issues.filter(issue => issue.message.includes('建设规模'))).toEqual([]);
  });

  it('正文分层口径（地上建筑面积10970㎡）不判为总量冲突（负向后顾隔离）', () => {
    const conflicts = detectNumericScopeConflicts(conflictingFacts);
    const markdown = '# 工程概况\n本项目建设规模为总建筑面积约4646㎡，其中地上建筑面积10970平方米不计入总量。\n# 施工部署\n现场建筑面积约为4646㎡。';
    const issues = crossChapterConsistencyIssues(markdown, factsModel(conflictingFacts), conflicts);
    expect(issues.filter(issue => issue.message.includes('建设规模'))).toEqual([]);
  });

  it('正文子项建筑面（门卫室120㎡）不判为总量冲突（具体建筑物名称隔离）', () => {
    const conflicts = detectNumericScopeConflicts(conflictingFacts);
    const markdown = '# 工程概况\n本项目建设规模为总建筑面积约4646㎡。\n# 施工部署\n门卫室建筑面积120平方米，临时设施按需布置。';
    const issues = crossChapterConsistencyIssues(markdown, factsModel(conflictingFacts), conflicts);
    expect(issues.filter(issue => issue.message.includes('建设规模'))).toEqual([]);
  });

  it('正文出现与建设规模不符的建筑总量数值仍拦截（保留拦截能力）', () => {
    const conflicts = detectNumericScopeConflicts(conflictingFacts);
    const markdown = '# 工程概况\n本项目建设规模为总建筑面积约4646㎡。\n# 施工部署\n总建筑面积约10970平方米，场地狭小。';
    const issues = crossChapterConsistencyIssues(markdown, factsModel(conflictingFacts), conflicts);
    const scaleIssue = issues.find(issue => issue.message.includes('建设规模'));
    expect(scaleIssue).toBeDefined();
    expect(scaleIssue!.level).toBe('error');
    expect(scaleIssue!.message).toContain('10970平方米');
  });

  it('用地面积跨文件差异不产生 area 裁决（独立字段不得污染建设规模口径）', () => {
    const facts = [
      fact('land_1', '总用地面积28570.36㎡', '招标文件.pdf'),
      fact('land_2', '总用地面积30000㎡', '图纸.pdf'),
    ];
    const conflicts = detectNumericScopeConflicts(facts);
    expect(conflicts.find(item => item.kind === 'area')).toBeUndefined();
  });

  it('建设规模事实与用地面积同文本并存时仍正确提取期望口径', () => {
    const facts = [
      fact('project_scale_1', '建设规模：总建筑面积约4646㎡；总用地面积28570.36㎡', '招标文件.pdf'),
    ];
    const conflicts = detectNumericScopeConflicts(facts);
    const markdown = '# 工程概况\n本项目总用地面积28570.36平方米，总建筑面积约4646㎡。';
    const issues = crossChapterConsistencyIssues(markdown, factsModel(facts), conflicts);
    expect(issues.filter(issue => issue.message.includes('建设规模'))).toEqual([]);
  });
});

describe('事实提取层嵌入句式（补疑总量口径进入事实主表的源头）', () => {
  it('补疑“总建筑面积约4646m2”嵌入句式（无“建设规模：”标签）必须提取为事实', () => {
    const facts = extractProjectBasicFactsFromEvidence([
      evidence('8.4徽光阁项目施工/招标文件正文.pdf', '2.6建设规模：项目位于安庆路城隍庙南大门内，建筑面积约为4645㎡。'),
      evidence('8.4徽光阁项目施工/002招标，图纸补疑/徽光阁项目施工补疑1.docx', '一、工程概况：本项目分为1个标段，现状建筑物为地上三层框架结构，总建筑面积约4646m2，本次改造工程保留现状在营业商铺278m2。'),
    ]);
    const scaleFacts = facts.filter(item => item.fieldId === 'project_scale');
    const scaleValues = scaleFacts.map(item => item.value);
    expect(scaleValues.some(value => value.includes('总建筑面积约4646m2'))).toBe(true);
    expect(scaleValues.some(value => value.includes('4645㎡'))).toBe(true);
  });

  it('提取结果可直接触发源级冲突裁决（4645 vs 4646 → 裁决 4646m2）', () => {
    const extracted = extractProjectBasicFactsFromEvidence([
      evidence('8.4徽光阁项目施工/招标文件正文.pdf', '2.6建设规模：项目位于安庆路城隍庙南大门内，建筑面积约为4645㎡。'),
      evidence('8.4徽光阁项目施工/002招标，图纸补疑/徽光阁项目施工补疑1.docx', '一、工程概况：本项目分为1个标段，现状建筑物为地上三层框架结构，总建筑面积约4646m2，本次改造工程保留现状在营业商铺278m2。'),
    ]);
    const conflicts = detectNumericScopeConflicts(extracted);
    const conflict = conflicts.find(item => item.kind === 'area');
    expect(conflict).toBeDefined();
    expect(conflict!.resolution).toBe('4646m2');
  });

  it('分层口径（地上建筑面积）不得作为总量口径提取', () => {
    const extracted = extractProjectBasicFactsFromEvidence([
      evidence('图纸.pdf', '总建筑面积4646㎡；地上建筑面积3200㎡'),
    ]);
    const values = extracted.filter(item => item.fieldId === 'project_scale').map(item => item.value);
    expect(values.some(value => value.includes('3200'))).toBe(false);
  });
});

describe('目标性数值甄别（业务目标不得作为裁决候选/事实主表口径）', () => {
  it('补疑“拟建设总建筑面积约5000㎡”是业务目标，不得覆盖招标正文确定值（不判冲突）', () => {
    const facts = [
      fact('project_scale_1', '2.6建设规模：项目位于安庆路城隍庙南大门内，建筑面积约为4645㎡', '招标文件正文.pdf'),
      fact('project_scale_2', '本工程拟建设总建筑面积约5000㎡', '徽光阁项目施工补疑1.docx'),
    ];
    const conflicts = detectNumericScopeConflicts(facts);
    expect(conflicts.find(item => item.kind === 'area')).toBeUndefined();
  });

  it('补疑客观陈述（现状建筑物总建筑面积4646m2）仍参与裁决', () => {
    const facts = [
      fact('project_scale_1', '2.6建设规模：项目位于安庆路城隍庙南大门内，建筑面积约为4645㎡', '招标文件正文.pdf'),
      fact('project_scale_2', '现状建筑物为地上三层框架结构，总建筑面积约4646m2', '徽光阁项目施工补疑1.docx'),
    ];
    const conflicts = detectNumericScopeConflicts(facts);
    const conflict = conflicts.find(item => item.kind === 'area');
    expect(conflict).toBeDefined();
    expect(conflict!.resolution).toBe('4646m2');
  });

  it('句读后的确定口径不因前方“计划工期”误伤（“计划工期365日历天，总建筑面积4646㎡”正常参与裁决）', () => {
    const facts = [
      fact('project_scale_1', '2.6建设规模：项目位于安庆路城隍庙南大门内，建筑面积约为4645㎡', '招标文件正文.pdf'),
      fact('project_scale_2', '计划工期365日历天，总建筑面积4646㎡', '徽光阁项目施工补疑1.docx'),
    ];
    const conflicts = detectNumericScopeConflicts(facts);
    const conflict = conflicts.find(item => item.kind === 'area');
    expect(conflict).toBeDefined();
    expect(conflict!.resolution).toBe('4646㎡');
  });

  it('提取层：目标性表述（拟建设总建筑面积约5000㎡）不进入事实主表', () => {
    const extracted = extractProjectBasicFactsFromEvidence([
      evidence('8.4徽光阁项目施工/002招标，图纸补疑/徽光阁项目施工补疑1.docx', '本工程拟建设总建筑面积约5000㎡，分两期实施。'),
    ]);
    const scaleValues = extracted.filter(item => item.fieldId === 'project_scale').map(item => item.value);
    expect(scaleValues.some(value => value.includes('5000'))).toBe(false);
  });

  it('提取层：客观陈述总建筑面积仍被提取（不受目标性负分支影响）', () => {
    const extracted = extractProjectBasicFactsFromEvidence([
      evidence('8.4徽光阁项目施工/002招标，图纸补疑/徽光阁项目施工补疑1.docx', '现状建筑物为地上三层框架结构，总建筑面积约4646m2。'),
    ]);
    const scaleValues = extracted.filter(item => item.fieldId === 'project_scale').map(item => item.value);
    expect(scaleValues.some(value => value.includes('4646m2'))).toBe(true);
  });
});
