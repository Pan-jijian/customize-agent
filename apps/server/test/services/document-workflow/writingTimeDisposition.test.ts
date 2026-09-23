/**
 * 4.58 P0「写作期约束覆盖率」门（根治不退化的机制保证）。
 *
 * ## 为什么这道门是必需的（实测数据）
 *
 * 4.58 把一轮真实生成的 30 条阻断按「最早在哪一阶段被发现」归类：
 * **29/30（96.7%）是终检才发现，只有 1 条是写作期已阻止**。
 * 且修复链净增字数 +66%（在**补写**而非改写），补写又产生次生缺陷（段落近重复、句式模板复读、口径漂移）。
 *
 * 根因是结构性的：**写作期只受提示词软约束，所有硬判据都在终检** → 每发现一个新缺陷形态，
 * 只能「再加一个检测器 + 再加一条修复规则」。本仓已有 `detectorCallSiteErrors`（管「检测器接没接线」），
 * 但没有姊妹约束管「接线之后，写作期有没有落点」。
 *
 * 本测试把这个约束从注释变成 CI 可拦住的规则。
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ALL_DETECTORS,
  DETECTOR_WRITING_TIME_DISPOSITIONS,
  PENDING_WRITING_TIME_DISPOSITION,
  assertRegistryConsistency,
  writingTimeDispositionErrors,
} from '@/services/document-workflow/detectorFixerRegistry';
import type { DetectorEntry } from '@/services/document-workflow/detectorFixerRegistry';

const REGISTRY_SRC = path.resolve(__dirname, '../../../src/services/document-workflow/detectorFixerRegistry.ts');

describe('4.58 P0 写作期处置声明', () => {
  it('**全量覆盖（硬约束）**：每个已登记检测器都有写作期处置，欠账表为空', () => {
    // 断言真实数据：若新增检测器未声明处置，这里先红（管道侧的 assertRegistryConsistency 会抛）
    expect(PENDING_WRITING_TIME_DISPOSITION).toEqual([]);
    const errors = writingTimeDispositionErrors({
      detectors: ALL_DETECTORS,
      dispositions: DETECTOR_WRITING_TIME_DISPOSITIONS,
      pending: PENDING_WRITING_TIME_DISPOSITION,
    });
    expect(errors, `写作期处置覆盖不全：\n${errors.join('\n')}`).toEqual([]);
  });

  it('注册表一致性断言整体通过（含新增第 9 项检查）', () => {
    expect(() => assertRegistryConsistency()).not.toThrow();
  });

  it('`terminal-only` 必须写明理由（与沉默缺省区分开）', () => {
    const terminalOnly = Object.entries(DETECTOR_WRITING_TIME_DISPOSITIONS).filter(([, value]) => value.kind === 'terminal-only');
    expect(terminalOnly.length).toBeGreaterThan(0);
    for (const [id, disposition] of terminalOnly) {
      expect(disposition.kind).toBe('terminal-only');
      if (disposition.kind !== 'terminal-only') continue;
      expect(disposition.reason.trim().length, `${id} 的 terminal-only 理由为空`).toBeGreaterThan(10);
    }
  });

  it('处置分布与「可写作期落点」的预期一致（constraint + self-check 应占多数）', () => {
    const kinds = Object.values(DETECTOR_WRITING_TIME_DISPOSITIONS).map(item => item.kind);
    const terminalOnly = kinds.filter(kind => kind === 'terminal-only').length;
    // 只有真正依赖跨章/全文信息的才允许 terminal-only；占比过高意味着分类敷衍
    expect(terminalOnly / kinds.length).toBeLessThan(0.25);
    expect(kinds.filter(kind => kind === 'constraint').length).toBeGreaterThan(0);
    expect(kinds.filter(kind => kind === 'self-check').length).toBeGreaterThan(0);
  });

  it('**负例**：新检测器未声明处置 → 报错（门真的会咬）', () => {
    const orphan: DetectorEntry = { id: 'brand-new-detector-without-disposition', scope: 'chapter', category: 'structure' };
    const errors = writingTimeDispositionErrors({
      detectors: [...ALL_DETECTORS, orphan],
      dispositions: DETECTOR_WRITING_TIME_DISPOSITIONS,
      pending: PENDING_WRITING_TIME_DISPOSITION,
    });
    expect(errors.join('\n')).toContain('brand-new-detector-without-disposition');
    expect(errors.join('\n')).toContain('必须当场给出写作期处置');
  });

  it('**负例**：terminal-only 空理由 → 报错；已声明却仍挂账 → 报错', () => {
    const det: DetectorEntry = { id: 'probe', scope: 'chapter', category: 'structure' };
    const emptyReason = writingTimeDispositionErrors({
      detectors: [det],
      dispositions: { probe: { kind: 'terminal-only', reason: '   ' } },
      pending: [],
    });
    expect(emptyReason.join('\n')).toContain('reason 为空');

    const stillPending = writingTimeDispositionErrors({
      detectors: [det],
      dispositions: { probe: { kind: 'constraint', channel: '块任务卡' } },
      pending: ['probe'],
    });
    expect(stillPending.join('\n')).toContain('仍在欠账清单中');
  });

  it('**声明表单源**：处置只能有一份，禁止源码内再出现第二张映射表', () => {
    const source = readFileSync(REGISTRY_SRC, 'utf8');
    // 表本体只许出现一次定义
    expect((source.match(/export const DETECTOR_WRITING_TIME_DISPOSITIONS/gu) ?? []).length).toBe(1);
    expect((source.match(/export const PENDING_WRITING_TIME_DISPOSITION/gu) ?? []).length).toBe(1);
    // 分类结果只允许一处出现（防止复制一份到别处后漂移）
    expect((source.match(/kind: 'terminal-only', reason:/gu) ?? []).length).toBe(
      Object.values(DETECTOR_WRITING_TIME_DISPOSITIONS).filter(item => item.kind === 'terminal-only').length,
    );
  });
});
