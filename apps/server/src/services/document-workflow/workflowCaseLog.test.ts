/**
 * workflowCaseLog 单测：裁决/修复案例 JSONL 落盘（只写不读）与落盘失败静默语义。
 * os.homedir 经 vi.mock 指向临时目录（避免污染用户真实案例库）；
 * node:fs 的 appendFileSync 替换为 vi.fn（ESM 模块命名导出不可 spy），用于失败静默分支。
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import type * as NodeFsModule from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof NodeFsModule>();
  return { ...actual, appendFileSync: vi.fn(actual.appendFileSync) };
});

vi.mock('os', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { join } = await import('node:path');
  const homeDir = mkdtempSync(join('/tmp', 'case-log-test-'));
  return { homedir: () => homeDir };
});

import { recordArbitrationCases, recordDeterministicFixCases, type ArbitrationCaseRecord, type DeterministicFixCaseRecord } from './workflowCaseLog';

function caseFile(fileName: string): string {
  return path.join(os.homedir(), '.customize-agent', 'cache', 'document-workflow', 'case-log', fileName);
}

function readLines(fileName: string): string[] {
  return fs.readFileSync(caseFile(fileName), 'utf-8').trim().split('\n');
}

afterAll(() => {
  fs.rmSync(path.join(os.homedir(), '.customize-agent'), { recursive: true, force: true });
});

describe('recordArbitrationCases', () => {
  it('裁决案例按 JSONL 逐行落盘', () => {
    const record: ArbitrationCaseRecord = {
      caseType: 'scope_conflict_arbitration',
      recordedAt: 1000,
      kind: '总工期',
      scope: '工期口径',
      values: [{ value: '300', unit: '日历天', priority: 1 }],
      winner: '300日历天',
      confidence: 'high',
      manualReviewRequired: false,
    };
    recordArbitrationCases([record]);
    const lines = readLines('arbitration-cases.jsonl');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual(record);
  });

  it('多次记录追加而非覆盖', () => {
    recordArbitrationCases([
      { caseType: 'scope_conflict_arbitration', recordedAt: 1, kind: 'a', scope: 'x', values: [], manualReviewRequired: false },
      { caseType: 'scope_conflict_arbitration', recordedAt: 2, kind: 'b', scope: 'y', values: [], manualReviewRequired: true },
    ]);
    const lines = readLines('arbitration-cases.jsonl');
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[2]).kind).toBe('b');
  });

  it('落盘失败静默（不抛错、不影响主链路）', () => {
    vi.mocked(fs.appendFileSync).mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    expect(() => recordArbitrationCases([{ caseType: 'scope_conflict_arbitration', recordedAt: 3, kind: 'c', scope: 'z', values: [], manualReviewRequired: false }]))
      .not.toThrow();
  });
});

describe('recordDeterministicFixCases', () => {
  it('修复案例独立文件落盘', () => {
    const record: DeterministicFixCaseRecord = {
      caseType: 'deterministic_fix',
      recordedAt: 2000,
      fixName: '重复小节去重',
      chapter: '施工部署',
      section: '1.2 施工准备',
      detail: '同 H3 内重复 H4 小节整块删除',
    };
    recordDeterministicFixCases([record]);
    const lines = readLines('deterministic-fix-cases.jsonl');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual(record);
  });
});
