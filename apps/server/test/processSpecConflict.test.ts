import { describe, expect, it } from 'vitest';
import { applyDeterministicConsistencyFixes, crossChapterConsistencyIssues, processSpecConflictIssues } from '../src/services/document-workflow/qualityValidation';
import type { DocumentFact, DocumentFactsModel } from '../src/services/document-workflow/types';

function fact(key: string, value: string, sourceFile = '招标文件.pdf'): DocumentFact {
  return { key, value, sourceFile, roleId: 'local', confidence: 1 };
}

function factsModel(specifications: DocumentFact[], project: DocumentFact[] = []): DocumentFactsModel {
  return { project, schedule: [], quality: [], safety: [], resources: [], tables: [], drawings: [], bills: [], preciseFacts: specifications, rules: [], specifications, schemaFacts: {}, factIndex: {}, missing: [], conflicts: [] } as unknown as DocumentFactsModel;
}

// 回归：用户环境“保温层 20/30/2mm vs 130mm”门禁阻断
describe('processSpecConflictIssues 结构层规格关联（回归：多层连续描述误报导致导出门禁阻断）', () => {
  it('标准多层连续描述（找平层 20mm、防水层 2mm、结合层 30mm、保温层 130mm）不误报', () => {
    const model = factsModel([fact('spec_insulation', '屋面保温层采用挤塑聚苯板，厚度130mm')]);
    const markdown = '# 屋面做法\n本工程屋面自上而下为：面层、结合层 30mm、防水层 2mm、找平层 20mm、保温层 130mm、结构层。';
    const issues = processSpecConflictIssues(markdown, model);
    expect(issues).toEqual([]);
  });

  it('正文真实写错保温层厚度时仍拦截（20mm vs 资料 130mm）', () => {
    const model = factsModel([fact('spec_insulation', '屋面保温层厚度130mm')]);
    const markdown = '# 屋面做法\n保温层厚度 20mm，采用挤塑聚苯板铺设。';
    const issues = processSpecConflictIssues(markdown, model);
    expect(issues.length).toBe(1);
    expect(issues[0].level).toBe('error');
    expect(issues[0].message).toContain('保温层厚度 20mm');
    expect(issues[0].message).toContain('130mm');
  });

  it('层名在后写法（130mm 厚保温层）不误报', () => {
    const model = factsModel([fact('spec_insulation', '屋面保温层厚度130mm')]);
    const markdown = '# 屋面做法\n屋面铺设 130mm 厚挤塑聚苯板保温层。';
    const issues = processSpecConflictIssues(markdown, model);
    expect(issues).toEqual([]);
  });

  it('施工顺序描述（保温层施工完成后铺设找平层 20mm）不把找平层数值归给保温层', () => {
    const model = factsModel([
      fact('spec_insulation', '屋面保温层厚度130mm'),
      fact('spec_screed', '找平层厚度20mm'),
    ]);
    const markdown = '# 屋面做法\n保温层施工完成后铺设 20mm 厚找平层，再施工防水层。';
    const issues = processSpecConflictIssues(markdown, model);
    expect(issues).toEqual([]);
  });

  it('资料多层连续描述时各层各取各值（不互相污染）', () => {
    const model = factsModel([fact('spec_roof', '屋面做法：找平层 20mm、防水层 2mm、结合层 30mm、保温层 130mm')]);
    const markdown = '# 屋面做法\n本工程屋面自上而下为：结合层 30mm、防水层 2mm、找平层 20mm、保温层 130mm、结构层。';
    const issues = processSpecConflictIssues(markdown, model);
    expect(issues).toEqual([]);
  });

  it('配比关联同样按层隔离（找平层 1:2.5 不误归保温层）', () => {
    const model = factsModel([fact('spec_roof', '屋面找平层采用 1:2.5 水泥砂浆，厚度20mm；保温层130mm')]);
    const markdown = '# 屋面做法\n找平层采用 1:2.5 水泥砂浆厚 20mm，其上铺设保温层 130mm。';
    const issues = processSpecConflictIssues(markdown, model);
    expect(issues).toEqual([]);
  });

  it('正文配比写错时仍拦截（找平层 1:3 vs 资料 1:2.5）', () => {
    const model = factsModel([fact('spec_screed', '找平层采用 1:2.5 水泥砂浆，厚度20mm')]);
    const markdown = '# 屋面做法\n找平层采用 1:3 水泥砂浆厚 20mm。';
    const issues = processSpecConflictIssues(markdown, model);
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('找平层配比 1:3');
    expect(issues[0].message).toContain('1:2.5');
  });
});

// 回归：用户环境“修复器无法定位 → 不产出 patch → 残留冲突 → 导出门禁硬阻断”死循环
// 确定性定点修复兜底：与检测同源归属规则，保证“检测定位=修复定位”
describe('applyDeterministicConsistencyFixes 确定性定点修复（回归：导出门禁死循环）', () => {
  it('保温层厚度写错时确定性替换为资料口径（20mm→130mm），复检无冲突', () => {
    const model = factsModel([fact('spec_insulation', '屋面保温层厚度130mm')]);
    const chapter = { id: 'c1', title: '屋面工程', content: '# 屋面做法\n保温层厚度 20mm，采用挤塑聚苯板铺设。' };
    const result = applyDeterministicConsistencyFixes([chapter], model);
    expect(result.fixedCount).toBe(1);
    expect(chapter.content).toContain('130mm');
    expect(chapter.content).not.toContain('20mm');
    expect(processSpecConflictIssues(chapter.content, model)).toEqual([]);
  });

  it('建设规模冲突（正文 10970平方米 vs 资料 10960㎡）确定性替换，复检无 error', () => {
    const model = factsModel([], [fact('scale', '建设规模：总建筑面积 10960㎡')]);
    const chapter = { id: 'c1', title: '工程概况', content: '# 工程概况\n本工程总建筑面积 10970平方米。' };
    const result = applyDeterministicConsistencyFixes([chapter], model);
    expect(result.fixedCount).toBe(1);
    expect(chapter.content).toContain('10960平方米');
    expect(crossChapterConsistencyIssues(chapter.content, model).filter(issue => issue.level === 'error')).toEqual([]);
  });

  it('配比写错确定性替换（1:3→1:2.5），复检无冲突', () => {
    const model = factsModel([fact('spec_screed', '找平层采用 1:2.5 水泥砂浆，厚度20mm')]);
    const chapter = { id: 'c1', title: '屋面工程', content: '# 屋面做法\n找平层采用 1:3 水泥砂浆厚 20mm。' };
    const result = applyDeterministicConsistencyFixes([chapter], model);
    expect(result.fixedCount).toBe(1);
    expect(chapter.content).toContain('1:2.5');
    expect(processSpecConflictIssues(chapter.content, model)).toEqual([]);
  });

  it('多层连续描述仅修真正写错的层（保温层 20mm 写错，其他层不动）', () => {
    const model = factsModel([fact('spec_roof', '屋面做法：找平层 20mm、防水层 2mm、结合层 30mm、保温层 130mm')]);
    const chapter = { id: 'c1', title: '屋面工程', content: '# 屋面做法\n找平层 20mm、防水层 2mm、结合层 30mm、保温层 20mm。' };
    const result = applyDeterministicConsistencyFixes([chapter], model);
    expect(result.fixedCount).toBe(1);
    expect(chapter.content).toContain('保温层 130mm');
    expect(chapter.content).toContain('找平层 20mm');
    expect(processSpecConflictIssues(chapter.content, model)).toEqual([]);
  });

  it('无冲突时不改动正文（幂等）', () => {
    const model = factsModel([fact('spec_insulation', '屋面保温层厚度130mm')]);
    const chapter = { id: 'c1', title: '屋面工程', content: '# 屋面做法\n保温层厚度 130mm。' };
    const result = applyDeterministicConsistencyFixes([chapter], model);
    expect(result.fixedCount).toBe(0);
    expect(chapter.content).toContain('130mm');
  });

  it('资料同层多口径时不替换（无法确定性裁决）', () => {
    const model = factsModel([fact('spec_insulation', '保温层厚度130mm；另见保温层厚度120mm')]);
    const chapter = { id: 'c1', title: '屋面工程', content: '# 屋面做法\n保温层厚度 20mm。' };
    const result = applyDeterministicConsistencyFixes([chapter], model);
    expect(result.fixedCount).toBe(0);
  });
});
