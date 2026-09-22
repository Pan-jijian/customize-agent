/**
 * 日期溯源口径防回归：正文日历日期必须可溯源到**绑定资料**。
 *
 * 实测缺陷（巢湖）：`2026年08月05日` 出自答疑文件**落款日期**（资料原文里就有），正文写作
 * 「招标文件于X日发布」「计划工期于X日变更修改为330日」（用法正确），却被报「编造开工日期」
 * 共 4 处 blocker——根因是 knownCalendarDates 只覆盖**事实抽取表**，而抽取器不覆盖文件落款/批复类日期。
 * 现口径：资料原文里出现过的日期同样视为可溯源（闸门不放松——资料里没有的日期仍判编造）。
 */
import { describe, expect, it } from 'vitest';
import { fabricatedStartDateIssues } from '@/services/document-workflow/documentIntegrityChecks';
import type { DocumentFactsModel } from '@/services/document-workflow/types';

const factsModelOf = (): DocumentFactsModel => ({
  project: [], schedule: [], quality: [], safety: [], resources: [], tables: [], drawings: [],
  bills: [], preciseFacts: [], rules: [], specifications: [], schemaFacts: {},
  factIndex: { parameterFacts: [], billFacts: [], evidenceFacts: [] } as never,
  missing: [], conflicts: [],
} as unknown as DocumentFactsModel);

describe('日期溯源 · 资料原文并入 knownDates', () => {
  it('资料里出现过的日期 → 正文使用不再判编造（实测 4 处误报的根治）', () => {
    const evidence = [{ content: '招标代理机构：巢湖市清诚工程咨询有限公司\n地址：巢湖市太湖山路7号\n2026年08月05日' }];
    const markdown = '招标文件于2026年08月05日发布，招标人为巢湖执珩建设投资有限公司。';
    expect(fabricatedStartDateIssues(markdown, factsModelOf(), evidence)).toHaveLength(0);
  });

  it('资料里没有的日期 → 仍判编造（闸门不放松）', () => {
    const evidence = [{ content: '招标代理机构：巢湖市清诚工程咨询有限公司\n2026年08月05日' }];
    const markdown = '本工程于2027年03月15日开工。';
    const issues = fabricatedStartDateIssues(markdown, factsModelOf(), evidence);
    expect(issues.length).toBeGreaterThan(0);
  });

  it('不传证据池时行为不变（向后兼容）', () => {
    const markdown = '招标文件于2026年08月05日发布。';
    expect(fabricatedStartDateIssues(markdown, factsModelOf())).toHaveLength(1);
  });

  it('同一证据池多次调用结果一致（记忆化不改变语义）', () => {
    const evidence = [{ content: '2026年08月05日' }];
    const markdown = '招标文件于2026年08月05日发布。';
    expect(fabricatedStartDateIssues(markdown, factsModelOf(), evidence)).toHaveLength(0);
    expect(fabricatedStartDateIssues(markdown, factsModelOf(), evidence)).toHaveLength(0);
  });
});
