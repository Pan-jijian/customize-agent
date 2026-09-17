/**
 * 法规文号残缺链尾收口回归（4.44 丰乐镇实机两轮同形态残留：「（国务院令第279订）」）：
 * 1. fixRegulationNumberTypos 形态矩阵（命中/半角形态/幂等/不误伤）；
 * 2. 接线锁死：FINALIZE_REPAIR_ROUNDS 声明 regulation-number-typo 轮，postReviewSurface.ts
 *    在 terminology-strip 之后、toc-consistency 之前调用收口——stage5 全文数值链之后的 LLM patch
 *    轮（数值/要求定向修复、缺节补写）重写句段可再引入自吞噬残缺，链尾此前无确定性收口点。
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fixRegulationNumberTypos } from '@/services/document-workflow/documentIntegrityChecks';
import { FINALIZE_REPAIR_ROUNDS } from '@/services/document-workflow/detectorFixerRegistry';

const SRC_DIR = path.resolve(__dirname, '../../../src/services/document-workflow');

describe('fixRegulationNumberTypos 形态矩阵（文号残缺确定性修复）', () => {
  it('「第N订」紧邻右括号形态修复为「第N号」（r2 实机原文同形态，同句其它文号不动）', () => {
    const input = '《建设工程质量管理条例》（国务院令第279订）、《建设工程安全生产管理条例》（国务院令第393号）';
    const result = fixRegulationNumberTypos(input);
    expect(result.markdown).toBe('《建设工程质量管理条例》（国务院令第279号）、《建设工程安全生产管理条例》（国务院令第393号）');
    expect(result.fixedCount).toBe(1);
    expect(result.details[0]).toContain('第279订→第279号');
  });

  it('半角右括号形态命中；「订」后非括号（普通词语境）不命中', () => {
    expect(fixRegulationNumberTypos('（国务院令第613订)').markdown).toBe('（国务院令第613号)');
    // 「第N订」后非括号不命中：订购/订购计划等词面不得被改写
    const innocent = '第3订购批次材料已进场，双方签订合同并完成条文修订。';
    expect(fixRegulationNumberTypos(innocent)).toEqual({ markdown: innocent, fixedCount: 0, details: [] });
  });

  it('幂等：修复后重跑零命中', () => {
    const repaired = fixRegulationNumberTypos('（国务院令第279订）').markdown;
    expect(repaired).toBe('（国务院令第279号）');
    expect(fixRegulationNumberTypos(repaired).fixedCount).toBe(0);
  });
});

describe('regulation-number-typo 链尾收口接线（防「修复器存在但未接线」回归）', () => {
  it('FINALIZE_REPAIR_ROUNDS 声明含 regulation-number-typo，且位于 terminology-strip 与 toc-consistency 之间', () => {
    const rounds = [...FINALIZE_REPAIR_ROUNDS];
    const index = rounds.indexOf('regulation-number-typo');
    expect(index).toBeGreaterThan(-1);
    expect(rounds.indexOf('terminology-strip')).toBeLessThan(index);
    expect(rounds.indexOf('toc-consistency')).toBeGreaterThan(index);
  });

  it('postReviewSurface.ts 在 terminology-strip 之后收口，且位于清洗重放组内（quotation rebuild 后可恢复）', () => {
    const source = readFileSync(path.join(SRC_DIR, 'finalize/repairRounds/postReviewSurface.ts'), 'utf8');
    const cleansFnIndex = source.indexOf('async function runSurfaceDeterministicCleans');
    const callIndex = source.indexOf('fixRegulationNumberTypos(session.finalMarkdown)');
    const terminologyIndex = source.indexOf('stripInternalTerminologySentences(session.finalMarkdown)');
    const tocIndex = source.indexOf('fixTocFromBody(session.finalMarkdown)');
    expect(cleansFnIndex).toBeGreaterThan(-1);
    expect(callIndex).toBeGreaterThan(cleansFnIndex);
    expect(terminologyIndex).toBeGreaterThan(cleansFnIndex);
    expect(callIndex).toBeGreaterThan(terminologyIndex);
    // r6（v11 rebuild 回退归因）：清洗组以函数抽取 + quotation 后重放保证回退恢复，重放与 toc 次序不变
    const quotationIndex = source.indexOf('await stageQuotationBalanceRepair(session);');
    const firstCleansCallIndex = source.indexOf('await runSurfaceDeterministicCleans(session);');
    expect(quotationIndex).toBeGreaterThan(firstCleansCallIndex);
    expect(source.indexOf('await runSurfaceDeterministicCleans(session);', quotationIndex)).toBeGreaterThan(quotationIndex);
    expect(quotationIndex).toBeLessThan(tocIndex);
  });

  it('收口命中后重算校验组（修复落地 → recompute 契约）', () => {
    const source = readFileSync(path.join(SRC_DIR, 'finalize/repairRounds/postReviewSurface.ts'), 'utf8');
    const fixBlock = source.slice(source.indexOf('const regulationNumberFix = fixRegulationNumberTypos'));
    const blockEnd = fixBlock.indexOf('\n}');
    expect(blockEnd).toBeGreaterThan(-1);
    expect(fixBlock.slice(0, blockEnd)).toContain('session.recomputeFinalValidationBundle()');
  });
});
