/**
 * withPatchRollback 接入覆盖防回归（P12）：
 * 源码 grep 式断言——8 个 LLM patch 轮中 7 轮必须接入 withPatchRollback（修复后同源复检 + 变差回滚），
 * qingtian-review-repair 声明保留（块级 LLM 复评已构成轮级变差防线，章级接入将倍增复评调用成本）。
 * 新增修复轮若未接入回滚保护，本测试直接失败。
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC_DIR = path.resolve(__dirname, '../../../src/services/document-workflow');

// P2 拆分后 fact-landing / table-repair 轮位于 finalize/repairRounds/，读新文件断言
const ROLLBACK_FILES = ['finalize/repairRounds/factLanding.ts', 'finalize/repairRounds/tableRepair.ts', 'globalQualityGates.ts'] as const;

/** 解析源码中所有 withPatchRollback({ ... }) 的调用块（按花括号深度截取） */
function rollbackCallBlocks(source: string): string[] {
  const blocks: string[] = [];
  const callRe = /withPatchRollback\(\{/gu;
  for (const match of source.matchAll(callRe)) {
    const start = (match.index ?? 0) + match[0].length - 1;
    let depth = 0;
    let end = -1;
    for (let index = start; index < source.length; index += 1) {
      if (source[index] === '{') depth += 1;
      else if (source[index] === '}') {
        depth -= 1;
        if (depth === 0) {
          end = index;
          break;
        }
      }
    }
    if (end > 0) blocks.push(source.slice(start, end + 1));
  }
  return blocks;
}

describe('withPatchRollback 全链接入防回归（P12）', () => {
  it('7 个修复轮全部接入 withPatchRollback（qingtian-review-repair 声明保留除外）', () => {
    const allBlocks = ROLLBACK_FILES.flatMap(file => rollbackCallBlocks(readFileSync(path.join(SRC_DIR, file), 'utf8')));
    // 7 个调用点：fact-landing / table-repair（finalize/repairRounds）+ 5 处（globalQualityGates）
    expect(allBlocks).toHaveLength(7);
    allBlocks.forEach((block, index) => {
      expect(block, `第 ${index + 1} 个 withPatchRollback 调用点缺少 recheck 同源复检`).toMatch(/recheck\s*:/u);
      expect(block, `第 ${index + 1} 个 withPatchRollback 调用点缺少 repairRound 分组声明`).toMatch(/repairRound\s*:/u);
    });
  });

  it('7 个接入轮的 repairRound 声明与修复轮 id 一一对应', () => {
    const sources = ROLLBACK_FILES.map(file => readFileSync(path.join(SRC_DIR, file), 'utf8'));
    const rounds = sources.flatMap(source => [...source.matchAll(/repairRound\s*:\s*'([\w-]+)'/gu)].map(match => match[1])).sort();
    expect(rounds).toEqual([
      'fact-landing',
      'global-consistency-repair',
      'planned-section-repair',
      'table-execution-repair',
      'table-repair',
      'templating-repair',
      'workpackage-skeleton-repair',
    ]);
  });

  it('fullDimensionReview（qingtian-review-repair）声明保留：不接入 withPatchRollback', () => {
    const source = readFileSync(path.join(SRC_DIR, 'fullDimensionReview.ts'), 'utf8');
    expect(source).not.toMatch(/withPatchRollback\s*\(/u); // 无 withPatchRollback 调用
    expect(source).not.toContain("from './patchRollback'"); // 无模块 import
    expect(source).toContain('qingtian-review-repair 不接入 withPatchRollback');
  });
});
