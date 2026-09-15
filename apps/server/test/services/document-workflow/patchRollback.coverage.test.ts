/**
 * withPatchRollback 接入覆盖防回归（P12）：
 * 源码 grep 式断言——8 个 LLM patch 轮全部必须接入 withPatchRollback（修复后同源复检 + 变差回滚）。
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
  it('8 个修复轮全部接入 withPatchRollback（全链接入，无声明保留轮）', () => {
    const allBlocks = ROLLBACK_FILES.flatMap(file => rollbackCallBlocks(readFileSync(path.join(SRC_DIR, file), 'utf8')));
    // 8 个调用点：fact-landing / table-repair（finalize/repairRounds）+ 6 处（globalQualityGates：
    // 补表/拆表同域 table-execution-repair 双闭环——补表（非暗标缺表）与暗标拆表（bodyTablePolicy=forbidden）互斥）
    expect(allBlocks).toHaveLength(8);
    allBlocks.forEach((block, index) => {
      expect(block, `第 ${index + 1} 个 withPatchRollback 调用点缺少 recheck 同源复检`).toMatch(/recheck\s*:/u);
      expect(block, `第 ${index + 1} 个 withPatchRollback 调用点缺少 repairRound 分组声明`).toMatch(/repairRound\s*:/u);
    });
  });

  it('8 个接入轮的 repairRound 声明与修复轮 id 一一对应（table-execution-repair 双闭环）', () => {
    const sources = ROLLBACK_FILES.map(file => readFileSync(path.join(SRC_DIR, file), 'utf8'));
    const rounds = sources.flatMap(source => [...source.matchAll(/repairRound\s*:\s*'([\w-]+)'/gu)].map(match => match[1])).sort();
    expect(rounds).toEqual([
      'fact-landing',
      'global-consistency-repair',
      'planned-section-repair',
      'table-execution-repair',
      'table-execution-repair',
      'table-repair',
      'templating-repair',
      'workpackage-skeleton-repair',
    ]);
  });
});
