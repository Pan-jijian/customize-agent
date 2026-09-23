/**
 * 4.58 R1-c 缺节补写**迭代到收敛**（源码防回归）。
 *
 * `enforcePlannedSectionCompleteness` 是「尽力而为」实现：单次调用只按当次入口重算的缺口下达补写，
 * 而 LLM 一次未必补齐全部。实测 `doc-1790168542563-ea526b1b`——`planned-section-repair` 阶段报
 * 「补写完成：补写 2 章」，终稿仍缺 `钢筋加工绑扎与代换管理`、`1#/2#/3#门卫土建结构与基础工程`。
 *
 * 修法（最小改动）：在调用侧循环。函数入口每次重算缺口，缺口清零或本次无 patch 落地即退出
 *（不会空转），上限 3 轮防死循环。
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const GENERATOR = path.resolve(__dirname, '../../../src/services/document-workflow/documentGenerator.ts');

describe('4.58 R1-c 缺节补写迭代到收敛', () => {
  const source = readFileSync(GENERATOR, 'utf8');

  it('调用侧循环（上限 3 轮），无 patch 落地即退出', () => {
    expect(source).toContain('for (let plannedSectionPass = 0; plannedSectionPass < 3; plannedSectionPass += 1)');
    // 可选链：无 patch 落地（含早退无返回值）即停——不空转，也防未来早退分支漏带字段时崩栈
    expect(source).toContain('if (!plannedSectionPassResult?.plannedSectionFixApplied) break;');
  });

  it('迭代理由入注释（防后人删掉循环时不知道代价）', () => {
    expect(source).toContain('迭代到收敛');
    expect(source).toContain('planned-section-repair` 阶段报');
  });
});
