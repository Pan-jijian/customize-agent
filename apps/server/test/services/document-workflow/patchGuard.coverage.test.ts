/**
 * patchGuard 覆盖率防回归（P22 第 4 项 / P11）：
 * 源码 grep 式断言——所有 repairChapterByQuality 调用点（8 处）必须传入 patchGuard 参数。
 * 新增调用点若漏传 patchGuard，本测试直接失败（防修复链重新引入已知坏内容而无预检）。
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC_DIR = path.resolve(__dirname, '../../../src/services/document-workflow');

// P2 拆分后 fact-landing / table-repair 轮位于 finalize/repairRounds/，读新文件断言
const REPAIR_CALL_FILES = ['finalize/repairRounds/factLanding.ts', 'finalize/repairRounds/tableRepair.ts', 'globalQualityGates.ts', 'fullDimensionReview.ts'] as const;

/** 解析源码中所有 repairChapterByQuality({ ... }) 的调用块（按花括号深度截取，忽略字符串干扰足够应付本场景） */
function repairCallBlocks(source: string): string[] {
  const blocks: string[] = [];
  const callRe = /repairChapterByQuality\(\{/gu;
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

describe('patchGuard 全链接入防回归（P11/P22）', () => {
  it('8 个调用点全部存在且每处均传 patchGuard（源码 grep 式断言）', () => {
    const allBlocks = REPAIR_CALL_FILES.flatMap(file => repairCallBlocks(readFileSync(path.join(SRC_DIR, file), 'utf8')));
    // 8 个调用点：fact-landing / table-repair（finalize/repairRounds）+ 5 处（globalQualityGates）+ qingtian-review-repair（fullDimensionReview）
    expect(allBlocks).toHaveLength(8);
    allBlocks.forEach((block, index) => {
      // fullDimensionReview 以「patchGuard,」简写形式传参（外层变量），其余调用点以「patchGuard:」显式传参
      expect(block, `第 ${index + 1} 个调用点未传 patchGuard`).toMatch(/patchGuard\s*[,:]/u);
    });
  });

  it('8 个调用点的 patchGuard 轮次声明与 LLM_PATCH_REPAIR_ROUNDS 八轮 id 一一对应', () => {
    const sources = REPAIR_CALL_FILES.map(file => readFileSync(path.join(SRC_DIR, file), 'utf8'));
    const rounds = sources.flatMap(source => [...source.matchAll(/repairPatchGuard\('([\w-]+)'/gu)].map(match => match[1])).sort();
    expect(rounds).toEqual([
      'fact-landing',
      'global-consistency-repair',
      'planned-section-repair',
      'qingtian-review-repair',
      'table-execution-repair',
      'table-repair',
      'templating-repair',
      'workpackage-skeleton-repair',
    ]);
  });
});
