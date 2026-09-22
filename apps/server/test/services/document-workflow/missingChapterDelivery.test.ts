/**
 * 交付前缺章判定防回归（缺章交付解耦）。
 *
 * 历史缺陷：只要「显式大纲」且缺章，finalizeGeneration 在进入 finalize 之前直接抛错，把已完成的其他
 * 章节连同 finalize 全部修复轮与导出门禁一起作废（本机历史实测 21 次中断：8 次「规划块全部失败」
 * + 13 次「大模型未返回有效正文」）。且同一缺章在模板大纲下可交付、在显式大纲下却整篇失败，口径矛盾。
 *
 * 现口径：零章节 = 无可交付物（中断）；缺章 = 可交付，由 rebuildAndRecompute 的 missingChapterCount
 * blocker 经终门禁复核清单呈现，文档状态 completed_with_issues。
 */
import { describe, expect, it } from 'vitest';
import { missingChapterAbortReason } from '@/services/document-workflow/documentPipeline';

describe('missingChapterAbortReason（缺章交付判定）', () => {
  it('缺章不中断：部分章节成稿时继续 finalize 交付', () => {
    expect(missingChapterAbortReason({
      chapterDraftCount: 9,
      failedChapterMessages: ['拟投入的主要物资计划：规划块全部失败：道路结构层材料投入'],
    })).toBeNull();
  });

  it('判定与大纲来源、缺章数量均无关：只剩 1 章也交付（无隐式阈值）', () => {
    // 判定函数的入参里没有 hasExplicitOutline —— 这正是修复本身：缺章的信息量由 blocker 精确表达，
    // 不再按大纲来源分叉成「可交付 / 整篇作废」两种命运，也不设「至少 N 章」的隐式阈值。
    expect(missingChapterAbortReason({ chapterDraftCount: 1, failedChapterMessages: ['其余章节均失败'] })).toBeNull();
  });

  it('零章节中断：无正文可组合，返回带失败消息的原因', () => {
    expect(missingChapterAbortReason({
      chapterDraftCount: 0,
      failedChapterMessages: ['工程概况：大模型未返回有效正文', '主要施工方法：规划块全部失败：道路工程'],
    })).toBe('章节生成未完成：工程概况：大模型未返回有效正文；主要施工方法：规划块全部失败：道路工程');
  });

  it('零章节且无失败消息：回退到明确文案而非空串', () => {
    expect(missingChapterAbortReason({ chapterDraftCount: 0, failedChapterMessages: [] }))
      .toBe('章节生成未完成：没有生成任何有效章节');
  });
});
