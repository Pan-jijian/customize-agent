/**
 * 4.61 接线锁死：真值层口径修复**必须在重放链内**。
 *
 * ## 为什么锁这条
 *
 * 这两个修复（日期槽位落位、取消项残留清除）改的是 `session.finalMarkdown`，
 * 而其后任何 `rebuildFinalMarkdown()` 都会把结果整个回退。首版把它们内联调用一次，
 * 实测「氯化橡胶面漆两道」被删掉后又被重建带回来，终检照报「被取代形态残留」——
 * **修了等于没修，而且从进度事件上看还是"success"**（最坏的一种失败：看起来做了）。
 *
 * 正确位置：`runSurfaceDeterministicCleans`（每次重建后重放）。
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const SOURCE = path.resolve(__dirname, '../../../src/services/document-workflow/finalize/repairRounds/postReviewSurface.ts');

describe('4.61 真值层口径修复的接线位置', () => {
  const source = readFileSync(SOURCE, 'utf8');

  it('`applyTruthCaliberCleans` 存在且导出（可被重放链与测试引用）', () => {
    expect(source).toContain('export async function applyTruthCaliberCleans(');
  });

  it('**重放函数内部**调用它（而不是在阶段里内联调用一次）', () => {
    const start = source.indexOf('export async function runSurfaceDeterministicCleans');
    expect(start).toBeGreaterThan(-1);
    // 取重放函数体的前 400 字符（调用点在其最前部）
    const head = source.slice(start, start + 400);
    expect(head, 'applyTruthCaliberCleans 必须在 runSurfaceDeterministicCleans 内被调用').toContain('await applyTruthCaliberCleans(session);');
  });

  it('重放函数被调用 ≥2 次（首次 + 引文修复后的重放）——单次调用不足以覆盖重建', () => {
    expect([...source.matchAll(/await runSurfaceDeterministicCleans\(session\)/gu)].length).toBeGreaterThanOrEqual(2);
  });
});

/**
 * 链尾位置锁死（同型缺陷本仓已复现三次）。
 *
 * `stagePostReviewSurface` 之后还有 12 个阶段会 `rebuildFinalMarkdown()`——实测
 * `fabricated-schedule-date` 记录 success（"开工日期落位权威口径 2026年08月31日→2026年10月10日"）、
 * 终稿里该日期却仍在，终检照报「口径错误」。本仓既有注释记着同型历史缺陷
 * （"修复轮成果被链尾清洗确定性删除……报告说改了、产物里没有"）。
 *
 * 判据：真值层口径修复必须出现在 **最后一次重建之后**（`replaySurfacePunctuationClosure` 之后、
 * `stageFinalGate` 之前）。
 */
describe('4.61 真值层口径修复的链尾位置', () => {
  const pipeline = readFileSync(path.resolve(__dirname, '../../../src/services/document-workflow/documentPipeline.ts'), 'utf8');

  it('在管线里被调用（不只是定义在模块里）', () => {
    expect(pipeline).toContain('await applyTruthCaliberCleans(session);');
  });

  it('位于链尾：标点终局收口**之后**、终门禁**之前**', () => {
    const punctuation = pipeline.indexOf('await replaySurfacePunctuationClosure(session);');
    const truthCaliber = pipeline.indexOf('await applyTruthCaliberCleans(session);');
    const finalGate = pipeline.indexOf('await stageFinalGate(session);');
    expect(punctuation, '标点终局收口应存在').toBeGreaterThan(-1);
    expect(truthCaliber, '真值层口径修复应在链尾').toBeGreaterThan(punctuation);
    expect(finalGate, '终门禁应存在').toBeGreaterThan(truthCaliber);
  });
});
