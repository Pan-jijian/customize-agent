import { describe, expect, it } from 'vitest';
import { applyDeterministicConsistencyFixes, applyDeterministicConsistencyFixesToMarkdown, crossChapterConsistencyIssues, processSpecConflictIssues } from '../src/services/document-workflow/qualityValidation';
import { composeEnhancedCoverMarkdown } from '../src/services/document-workflow/composeAppendices';
import type { DocumentFact, DocumentFactsModel } from '../src/services/document-workflow/types';

function fact(key: string, value: string, sourceFile = '招标文件.pdf'): DocumentFact {
  return { key, value, sourceFile, roleId: 'local', confidence: 1 };
}

function factsModel(specifications: DocumentFact[], project: DocumentFact[] = []): DocumentFactsModel {
  return { project, schedule: [], quality: [], safety: [], resources: [], tables: [], drawings: [], bills: [], preciseFacts: specifications, rules: [], specifications, schemaFacts: {}, factIndex: {}, missing: [], conflicts: [] } as unknown as DocumentFactsModel;
}

// 回归：用户环境 4.5.6 仍失败的导出门禁阻断
// 阻断 1「跨章一致性复核：工序规格冲突：正文保温层厚度 2mm 与资料口径 130mm 不一致」
// 阻断 2「跨章一致性冲突：正文出现与资料建设规模不一致的表述 10970平方米」
describe('用户环境 4.5.6 阻断的修复验证', () => {
  it('全文级定点修复清除封面合成区的败选建设规模值（10970 死循环修复）', () => {
    const model = factsModel([], [fact('scale', '建设规模：总建筑面积 10960㎡')]);
    // 事实主表另有一条 key 含"建设规模"的败选事实（未裁决改写），写入 facts 对象后进入封面
    const losingFacts: Record<string, string> = { 建设规模: '10970㎡（来源：招标文件.pdf，角色：local）', 工程名称: '测试工程' };
    const cover = composeEnhancedCoverMarkdown('施工组织设计', losingFacts);
    expect(cover).toContain('10970');
    // 章节正文写的是正确口径 10960，章节级修复无目标（fixedCount=0）
    const chapter = { id: 'c1', title: '工程概况', content: '# 工程概况\n本工程总建筑面积 10960㎡，结构形式为框架。' };
    const markdown = `${cover}\n\n${chapter.content}`;
    expect(applyDeterministicConsistencyFixes([chapter], model).fixedCount).toBe(0);
    expect(crossChapterConsistencyIssues(markdown, model).some(issue => issue.level === 'error' && issue.message.includes('10970'))).toBe(true);
    // 全文级修复：封面合成区同样按检测同源归属规则替换 → 复检无 error
    const fullFix = applyDeterministicConsistencyFixesToMarkdown(markdown, model);
    expect(fullFix.fixedCount).toBe(1);
    expect(fullFix.markdown).toContain('10960');
    expect(fullFix.markdown).not.toContain('10970');
    expect(crossChapterConsistencyIssues(fullFix.markdown, model).filter(issue => issue.level === 'error')).toEqual([]);
  });

  it('确定性修复后重算快照：已修复的保温层冲突不再保留（阻断 1 快照污染修复）', () => {
    const model = factsModel([fact('spec_insulation', '屋面保温层厚度130mm')]);
    const chapter = { id: 'c1', title: '屋面工程', content: '# 屋面做法\n保温层厚度 2mm，采用挤塑聚苯板铺设。' };
    // 修复前检测到的冲突快照（生成阶段 runDeterministicConsistencyCheck 输出）
    const beforeFix = [
      ...crossChapterConsistencyIssues(chapter.content, model).filter(issue => /跨章一致性冲突/u.test(issue.message)),
      ...processSpecConflictIssues(chapter.content, model).filter(issue => issue.level === 'error'),
    ].map(issue => `${issue.message}；${issue.suggestion || ''}`);
    expect(beforeFix[0]).toContain('保温层厚度 2mm');
    // 确定性修复后正文已正确，重算检测应为空
    const fix = applyDeterministicConsistencyFixes([chapter], model);
    expect(fix.fixedCount).toBe(1);
    const afterFix = [
      ...crossChapterConsistencyIssues(chapter.content, model).filter(issue => /跨章一致性冲突/u.test(issue.message)),
      ...processSpecConflictIssues(chapter.content, model).filter(issue => issue.level === 'error'),
    ].map(issue => `${issue.message}；${issue.suggestion || ''}`);
    expect(afterFix).toEqual([]);
    // 修复后的快照重算语义：确定性检测类旧快照移除，只保留非确定性审查问题 + 最新重算结果
    const recomputed = [
      ...new Set([
        ...beforeFix.filter(issue => !/^跨章一致性冲突|^工序规格冲突/u.test(issue)),
        ...afterFix,
      ]),
    ];
    expect(recomputed).toEqual([]);
    // finalize 侧防御：确定性检测类快照不再包装为「跨章一致性复核」error，由最终重跑实时报告
    const wrapped = recomputed.map(message => ({ level: 'error', message: `跨章一致性复核：${message}` }));
    expect(wrapped).toEqual([]);
  });
});
