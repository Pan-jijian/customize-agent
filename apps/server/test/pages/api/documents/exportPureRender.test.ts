/**
 * A1 导出纯渲染化（批 1 P0）：三把刀语义分级——假表头=源层结构性缺陷（enforce 阻断、observe 采样）、
 * 单位改写=检测降级（enforce 不改写只告警）、结构语法保障（补分隔线/列对齐/插空行）=保留并审计计数。
 * 默认 observe：产物行为与历史逐字一致（零回归），缺陷照常记录供两轮零误报灰度采样。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { __documentExportTest__ } from '@/pages/api/documents/export';

const { createExportRenderAudit, exportPureRenderMode, exportRenderAuditReport, normalizeExportUnits, normalizeLooseMarkdownTables, normalizeParagraphs, prepareExportMarkdown } = __documentExportTest__;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('A1 导出纯渲染：假表头缺陷检测与阻断', () => {
  it('observe（默认）：裸表沿用历史补表头（产物零回归），同时采样 blocker', () => {
    const audit = createExportRenderAudit('observe');
    const out = normalizeLooseMarkdownTables('| 甲 | 乙 |\n| 丙 | 丁 |', audit);
    expect(out).toContain('| 信息项 | 内容 |');
    expect(audit.blockers.map(item => item.code)).toEqual(['bare-table']);
    expect(audit.blockers[0]?.line).toBe(1);
    expect(audit.ops.tableSeparatorAdded).toBe(1);
  });

  it('enforce：裸表不补假表头（纯渲染原样保留），blocker 供导出 API 阻断', () => {
    const audit = createExportRenderAudit('enforce');
    const out = normalizeLooseMarkdownTables('| 甲 | 乙 |\n| 丙 | 丁 |', audit);
    expect(out).toBe('| 甲 | 乙 |\n| 丙 | 丁 |');
    expect(audit.blockers).toHaveLength(1);
    expect(audit.blockers[0]).toMatchObject({ code: 'bare-table', line: 1 });
  });

  it('enforce：孤立分隔线不补假表头', () => {
    const audit = createExportRenderAudit('enforce');
    const out = normalizeLooseMarkdownTables('| --- | --- |\n| 甲 | 乙 |', audit);
    expect(out).toBe('| --- | --- |\n| 甲 | 乙 |');
    expect(audit.blockers.map(item => item.code)).toEqual(['orphan-separator']);
  });

  it('off：完全关闭（不采样、不计数），行为=历史', () => {
    const audit = createExportRenderAudit('off');
    const out = normalizeLooseMarkdownTables('| 甲 | 乙 |\n| 丙 | 丁 |', audit);
    expect(out).toContain('| 信息项 | 内容 |');
    expect(audit.blockers).toHaveLength(0);
    expect(exportRenderAuditReport(audit).opsTotal).toBe(0);
  });
});

describe('A1 导出纯渲染：单位改写检测降级', () => {
  it('observe：沿用历史改写并计数', () => {
    const audit = createExportRenderAudit('observe');
    expect(normalizeExportUnits('面积100m2，素土夯实', audit)).toContain('100m²');
    expect(audit.ops.unitRewrite).toBe(1);
  });

  it('enforce：不改写（纯渲染），仅 notices 告警', () => {
    const audit = createExportRenderAudit('enforce');
    expect(normalizeExportUnits('面积100m2，素土夯实', audit)).toContain('100m2');
    expect(audit.ops.unitRewrite).toBe(0);
    expect(audit.notices.map(item => item.code)).toContain('unit-notation');
  });

  it('enforce：已归一文本零残留告警', () => {
    const audit = createExportRenderAudit('enforce');
    expect(normalizeExportUnits('面积100m²，素土夯实', audit)).toBe('面积100m²，素土夯实');
    expect(audit.notices).toHaveLength(0);
  });

  it('里程碑 M2/M3 编号在 observe 下仍保留（既有边界不回退）', () => {
    const audit = createExportRenderAudit('observe');
    expect(normalizeExportUnits('M2 污水管网进度过半', audit)).toBe('M2 污水管网进度过半');
  });
});

describe('A1 导出纯渲染：结构操作保留并计数', () => {
  it('段落空行插入属结构操作（文本零改动）', () => {
    const audit = createExportRenderAudit('observe');
    const out = normalizeParagraphs('第一段结束。\n第二段开始。', audit);
    expect(out).toBe('第一段结束。\n\n第二段开始。');
    expect(audit.ops.paragraphBreakInserted).toBe(1);
  });

  it('列对齐（补空列）属结构操作并计数', () => {
    const audit = createExportRenderAudit('observe');
    const out = normalizeLooseMarkdownTables('| 甲 | 乙 | 丙 |\n| --- | --- | --- |\n| 1 | 2 |', audit);
    expect(out).toContain('| 1 | 2 |  |');
    expect(audit.ops.tableCellAligned).toBe(1);
  });

  it('相邻表边界截断（结构操作）并计数：两表无空行紧邻不被吞并', () => {
    const audit = createExportRenderAudit('observe');
    const out = normalizeLooseMarkdownTables('| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |\n| 丙 | 丁 | 戊 |\n| --- | --- | --- |\n| 3 | 4 | 5 |', audit);
    expect(out).toContain('| 丙 | 丁 | 戊 |');
    expect(audit.ops.tableBoundarySplit).toBe(1);
  });

  it('环境开关：默认 observe，enforce/off 可切换', () => {
    expect(exportPureRenderMode()).toBe('observe');
    vi.stubEnv('DOCUMENT_EXPORT_PURE_RENDER', 'enforce');
    expect(exportPureRenderMode()).toBe('enforce');
    vi.stubEnv('DOCUMENT_EXPORT_PURE_RENDER', 'off');
    expect(exportPureRenderMode()).toBe('off');
  });

  it('prepareExportMarkdown：返回 audit（导出 API 阻断/告警/归档的数据源）', () => {
    const prepared = prepareExportMarkdown('# 第一章 总则\n\n正文内容如下。');
    expect(prepared.audit.mode).toBe('observe');
    expect(exportRenderAuditReport(prepared.audit).blockerCount).toBe(0);
  });
});
