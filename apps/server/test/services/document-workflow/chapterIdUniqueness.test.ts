/**
 * 章节 id 唯一性防回归。
 *
 * 症状（远端用户实测）：章预算可行性校准节点标红 ——
 * `章预算可行性校准失败：沿用原章预算（可能偏离真实要点密度）（章预算可行性校准违约：Σ章预算 X 与目标 Y 偏差超出容差）`。
 *
 * 根因：章 id 是下游映射的键（chapterTargets / chapterPlans / evidenceByChapterId / chapterGraphMap），
 * 模板章 id 直接取自用户输入且「无 id 章」回退为 `chapter-${index+1}`，两条路径都会产生重复 id；
 * 重复时 Map 后写覆盖先写，Σ章预算少算 → 守恒断言失守 → 整轮校准降级为「沿用原章预算」。
 * 随机化定位：id 全唯一 4 万组零违约，允许重复即稳定违约。
 */
import { describe, expect, it } from 'vitest';
import { reanchorChapterTargetsByFeasibility } from '@/services/document-workflow/budget';
import { ensureUniqueChapterIds } from '@/services/document-workflow/utils';
import type { DocumentTemplateChapter } from '@/services/document-workflow/types';

const chapter = (id: string, title: string, sections: number): DocumentTemplateChapter =>
  ({ id, title, purpose: '', sections: Array.from({ length: sections }, (_, i) => `s${i}`) }) as unknown as DocumentTemplateChapter;

describe('ensureUniqueChapterIds', () => {
  it('首现 id 保持不变，重复者改写为 -dupN，章节与标题不丢', () => {
    const input = [chapter('c0', '工程概况', 1), chapter('c1', '主要施工方法', 2), chapter('c0', '质量管理体系与措施', 3), chapter('c0', '结语', 1)];
    const out = ensureUniqueChapterIds(input);
    expect(out.map(c => c.id)).toEqual(['c0', 'c1', 'c0-dup2', 'c0-dup3']);
    expect(out.map(c => c.title)).toEqual(input.map(c => c.title));
    expect(out[2]!.sections).toHaveLength(3);
  });

  it('已是唯一 id 时原样返回（不产生 diff，避免无谓的模板版本递增）', () => {
    const input = [chapter('a', 'A', 1), chapter('b', 'B', 2)];
    const out = ensureUniqueChapterIds(input);
    expect(out).toEqual(input);
  });

  it('与既有 -dupN 同名时继续递增，不死循环', () => {
    const input = [chapter('c0', 'A', 1), chapter('c0-dup2', 'B', 1), chapter('c0', 'C', 1)];
    expect(ensureUniqueChapterIds(input).map(c => c.id)).toEqual(['c0', 'c0-dup2', 'c0-dup3']);
  });
});

describe('章预算可行性校准 · 重复 id 触发守恒失守（回归锁定）', () => {
  // 复现最短形态：4 章，第 0 与第 2 章 id 相同
  const titles = ['施工总平面布置图', '主要施工方法', '确保工期的技术组织措施', '工程概况'];
  const specFloors = [245, 0, 3817, 0];
  const feasibilityFloors = [3600, 3600, 1800, 3600];
  const sectionCounts = [1, 4, 9, 1];
  const target = 15179;
  const build = (ids: string[]) => titles.map((title, i) => chapter(ids[i]!, title, sectionCounts[i]!));
  const run = (chapters: DocumentTemplateChapter[]) =>
    reanchorChapterTargetsByFeasibility({
      chapters,
      targetChars: target,
      floorOf: c => specFloors[titles.indexOf(c.title)]!,
      feasibilityFloorOf: c => feasibilityFloors[titles.indexOf(c.title)]!,
      currentTargets: new Map(chapters.map(c => [c.id, 0])),
    });

  it('重复 id 时守恒断言失守（Map 覆盖使 Σ章预算 少算）', () => {
    expect(() => run(build(['c0', 'c1', 'c0', 'c3']))).toThrow(/章预算可行性校准违约/);
  });

  it('经 ensureUniqueChapterIds 修复后：不抛错且 Σ章预算 = 目标（精确守恒）', () => {
    const repaired = ensureUniqueChapterIds(build(['c0', 'c1', 'c0', 'c3']));
    const out = run(repaired);
    const sum = [...out.chapterTargets.values()].reduce((a, b) => a + b, 0);
    expect(sum).toBe(target);
    // 每个章各自占一个键：修复后键数 = 章数
    expect(out.chapterTargets.size).toBe(repaired.length);
  });
});
