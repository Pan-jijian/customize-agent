/**
 * G 线 P2-8：重排候选的分源保底。
 *
 * 缺陷背景：原实现 `mergedChildChunks.slice(0, 30)` 纯按融合分截断候选集。低密度来源
 * （只切出 1~2 个切片的小文件——补疑、专项说明这类）在融合分上永远挤不进前 30，
 * **连被重排的机会都没有**：重排本应对候选做精排，候选集却已按同一套分数预先判了死刑。
 * 用户侧表现为「某个小文件怎么都检索不到」，且与它是否相关无关。
 *
 * 本文件直接验证选入契约（`diversifiedRerankCandidates` 是导出的纯函数）。
 * 每条正向断言都配一条「朴素 slice 会失败」的对照，确保测试有失败能力。
 */
import { describe, expect, it } from 'vitest';
import { diversifiedRerankCandidates } from '../src/core/knowledge-base-manager.js';

interface Item { filePath: string; score: number }

/** 大文件 40 片（高分） + 小文件 1 片（低分）：朴素 slice 会完全看不到小文件 */
function corpus(): Item[] {
  const big = Array.from({ length: 40 }, (_, i) => ({ filePath: 'big.md', score: 100 - i }));
  const small = { filePath: 'small.md', score: 1 };
  return [...big, small];
}

describe('G 线 P2-8 重排候选分源保底', () => {
  it('低密度来源被保底选入（对照：朴素 slice 会漏掉它）', () => {
    const items = corpus();
    const limit = 30;
    // 对照：证明缺陷真实存在——朴素截断下小文件不在候选集
    expect(items.slice(0, limit).some(item => item.filePath === 'small.md')).toBe(false);
    // 修复后：小文件获得候选席位
    const candidates = diversifiedRerankCandidates(items, limit);
    expect(candidates.some(item => item.filePath === 'small.md')).toBe(true);
  });

  it('保底不越过总额：候选数仍等于 limit', () => {
    const candidates = diversifiedRerankCandidates(corpus(), 30);
    expect(candidates).toHaveLength(30);
  });

  it('保底量有上限（limit/3）：低密度来源不得把高相关结果大量挤出', () => {
    // 高分段由 big.md 提供（20 片），另有 60 个互不相同的小来源各 1 片且分数极低
    const items: Item[] = [
      ...Array.from({ length: 20 }, (_, i) => ({ filePath: 'big.md', score: 100 - i })),
      ...Array.from({ length: 60 }, (_, i) => ({ filePath: `tiny-${i}.md`, score: 1 - i * 0.01 })),
    ];
    const limit = 30;
    const candidates = diversifiedRerankCandidates(items, limit);
    expect(candidates).toHaveLength(limit);
    // 保底上限 = floor(30/3) = 10：低密度源最多占 10 席，其余 20 席仍归纯分数序（big.md 的 20 片全保）
    expect(candidates.filter(item => item.filePath.startsWith('tiny-')).length).toBe(10);
    expect(candidates.filter(item => item.filePath === 'big.md').length).toBe(20);
  });

  it('来源已全覆盖时不裁剪（无低密度源则行为与纯分数序一致）', () => {
    const items = Array.from({ length: 5 }, (_, i) => ({ filePath: `f-${i}.md`, score: 10 - i }));
    expect(diversifiedRerankCandidates(items, 5)).toEqual(items);
    // 候选集小于 limit 时原样返回（不足额无需保底）
    expect(diversifiedRerankCandidates(items, 30)).toHaveLength(5);
  });

  it('每个未代表的来源各占一席（不是只保底第一个）', () => {
    const items: Item[] = [
      ...Array.from({ length: 40 }, (_, i) => ({ filePath: 'big.md', score: 100 - i })),
      { filePath: 'small-a.md', score: 2 },
      { filePath: 'small-b.md', score: 1 },
    ];
    const candidates = diversifiedRerankCandidates(items, 30);
    expect(candidates.some(item => item.filePath === 'small-a.md')).toBe(true);
    expect(candidates.some(item => item.filePath === 'small-b.md')).toBe(true);
    expect(candidates).toHaveLength(30);
  });

  it('高分结果不因保底被裁出（裁剪只发生在纯分数尾部）', () => {
    const items = corpus();
    const candidates = diversifiedRerankCandidates(items, 30);
    const paths = new Set(candidates.map(item => item.filePath));
    // big.md 的前若干高分项必须仍在
    expect(paths.has('big.md')).toBe(true);
    const keptBigScores = candidates.filter(item => item.filePath === 'big.md').map(item => item.score);
    expect(Math.max(...keptBigScores)).toBe(100);
  });
});
