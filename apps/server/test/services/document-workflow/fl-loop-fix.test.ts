import { describe, expect, it } from 'vitest';
import { runDeterministicChainUntilConverged, runFixUntilClean } from '@/services/document-workflow/documentIntegrityChecks';

describe('runFixUntilClean 节点内闭环', () => {
  it('零命中立即收敛（单轮返回）', () => {
    const calls: number[] = [];
    const result = runFixUntilClean((markdown) => {
      calls.push(1);
      return { markdown, fixedCount: 0 };
    }, '正文', 3);
    expect(result.markdown).toBe('正文');
    expect(result.fixedCount).toBe(0);
    expect(calls.length).toBe(1);
  });

  it('一次修复后收敛：第二轮零命中跳出', () => {
    let round = 0;
    const result = runFixUntilClean((markdown) => {
      round += 1;
      if (round === 1) return { markdown: markdown.replace('AA', 'A'), fixedCount: 1 };
      return { markdown, fixedCount: 0 };
    }, 'AA', 3);
    expect(result.markdown).toBe('A');
    expect(result.fixedCount).toBe(1);
    expect(round).toBe(2);
  });

  it('修复自身引入新形态：多轮修复直至清零', () => {
    // 每轮替换一个「AA」为「A」，全部替换完才零命中（模拟修复后自身新命中）
    const result = runFixUntilClean((markdown) => {
      if (!markdown.includes('AA')) return { markdown, fixedCount: 0 };
      return { markdown: markdown.replace('AA', 'A'), fixedCount: 1 };
    }, 'AAAAAA', 3);
    expect(result.markdown).toBe('AAA');
    expect(result.fixedCount).toBe(3);
  });

  it('轮次上限保护：无法清零时达到上限停止', () => {
    // 每轮固定命中 1 次且永远修不完（模拟修复器互搏），maxRounds=2 时最多跑 2 轮
    let calls = 0;
    const result = runFixUntilClean((markdown) => {
      calls += 1;
      return { markdown: `${markdown}改`, fixedCount: 1 };
    }, '正文', 2);
    expect(result.fixedCount).toBe(2);
    expect(calls).toBe(2);
  });
});

describe('runDeterministicChainUntilConverged 链级收敛', () => {
  it('修复器互相引入问题：链循环收敛而非堆到最后节点', () => {
    // fixA 把「AA」换「A」且每次命中时在文尾引入一个「BB」；
    // fixB 把「BB」换「B」——单遍直线模式会在 fixA 修完后残留「BB」，
    // 链循环应在 fixB 清理后再跑 fixA，直至两者都零命中
    const fixA = (markdown: string) => {
      if (!markdown.includes('AA')) return { markdown, fixedCount: 0 };
      return { markdown: markdown.replace('AA', 'A') + 'BB', fixedCount: 1 };
    };
    const fixB = (markdown: string) => {
      if (!markdown.includes('BB')) return { markdown, fixedCount: 0 };
      return { markdown: markdown.replace('BB', 'B'), fixedCount: 1 };
    };
    const result = runDeterministicChainUntilConverged([fixA, fixB], 'AA', 3);
    expect(result.markdown).toBe('AB');
    expect(result.fixedCount).toBe(2);
  });

  it('整链零命中时单轮返回', () => {
    let calls = 0;
    const result = runDeterministicChainUntilConverged([
      (md) => { calls += 1; return { markdown: md, fixedCount: 0 }; },
      (md) => { calls += 1; return { markdown: md, fixedCount: 0 }; },
    ], '正文', 3);
    expect(result.markdown).toBe('正文');
    expect(calls).toBe(2);
  });

  it('无进展即跳出：修复器恒命中时受轮次上限保护', () => {
    let calls = 0;
    const result = runDeterministicChainUntilConverged([
      (md) => { calls += 1; return { markdown: md, fixedCount: 1 }; },
    ], '正文', 2);
    // 轮次上限保护不变（仍调用 2 次）；fixedCount 只统计真实改写（4.55.22 幽灵计数根修）
    expect(calls).toBe(2);
    expect(result.fixedCount).toBe(0);
  });
});
