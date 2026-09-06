/**
 * 轮8 残留冲突复现（manual，不入 vitest 常规集）：对 4.18.6 生成的产物跑仅需 markdown 的确定性检测器，
 * 定位「跨章一致性修复完成：仍残留 5 个冲突」的具体冲突内容与检测器来源。
 * 运行：npx vitest run apps/server/test/repro-r8-residual-conflicts.manual.ts
 */
import { readFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import {
  ambiguousEitherOrIssues,
  basicInfoScheduleFieldIssues,
  crossSectionNumericConflictIssues,
  dangerousListConsistencyIssues,
  duplicateParagraphIssues,
  duplicateTableIssues,
  excavationDepthLockIssues,
  foundationFormResidueIssues,
  resourceConsistencyIssues,
  resourceTriadSectionHierarchyIssues,
  sixHundredPercentCoverageIssues,
} from '../src/services/document-workflow/documentIntegrityChecks';

const markdown = readFileSync('/Users/pan/.customize-agent/projects/3c3f04667c69/generatedDocuments/assets/文档生成失败-doc-1788612522589-75b40800.md', 'utf8');

const detectors: Array<[string, (text: string) => unknown[] | Promise<unknown[]>]> = [
  ['crossSectionNumericConflictIssues', crossSectionNumericConflictIssues],
  ['foundationFormResidueIssues', foundationFormResidueIssues],
  ['ambiguousEitherOrIssues', ambiguousEitherOrIssues],
  ['excavationDepthLockIssues', excavationDepthLockIssues],
  ['dangerousListConsistencyIssues', dangerousListConsistencyIssues],
  ['basicInfoScheduleFieldIssues', basicInfoScheduleFieldIssues],
  ['duplicateTableIssues', duplicateTableIssues],
  ['duplicateParagraphIssues', duplicateParagraphIssues],
  ['resourceTriadSectionHierarchyIssues', resourceTriadSectionHierarchyIssues],
  ['resourceConsistencyIssues', resourceConsistencyIssues],
  ['sixHundredPercentCoverageIssues', sixHundredPercentCoverageIssues],
];

describe('轮8 残留冲突复现', () => {
  it('打印全部检测器命中', async () => {
    let total = 0;
    for (const [name, run] of detectors) {
      const issues = await run(markdown);
      total += issues.length;
      if (issues.length > 0) {
        console.log(`\n===== ${name} (${issues.length}) =====`);
        for (const issue of issues) console.log('-', (issue as { message?: string }).message?.slice(0, 200));
      }
    }
    console.log(`\n===== TOTAL ===== ${total}`);
  });
});
