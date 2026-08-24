import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  generatedRoot,
  generatingRecordRequiresFullPoll,
  getGeneratedDocument,
} from '../src/services/document-core/generatedDocumentService';
import type { GeneratedDocumentRecord } from '../src/services/document-core/generatedDocumentService';

/**
 * stale 判定（“生成任务已中断”）回归测试：
 * - dev 多实例/进程重启场景下，宽限期内不得误杀仍在更新的 generating 记录
 * - 宽限期过后，进程启动前遗留的记录应立即标记中断
 * - 本进程内启动的任务即使超过宽限期，也应走长阈值（24h）而非立即标记
 */
const REAL_NOW = Date.now();
const PROCESS_STARTED_AT = (globalThis as unknown as { __generatedDocumentProcessStartedAt?: number }).__generatedDocumentProcessStartedAt;
const FAKE_NOW = REAL_NOW + 10 * 60_000;
const TMP_PROJECT_ROOT = path.join(os.tmpdir(), `stale-guard-test-${process.pid}`);

function writeGeneratingRecord(projectRoot: string, record: GeneratedDocumentRecord) {
  const draftsDir = path.join(generatedRoot(projectRoot), 'drafts');
  fs.mkdirSync(draftsDir, { recursive: true });
  fs.writeFileSync(path.join(draftsDir, `${record.id}.json`), JSON.stringify(record));
  fs.writeFileSync(path.join(draftsDir, `${record.id}.meta.json`), JSON.stringify({ updatedAt: record.updatedAt, status: record.status }));
}

function makeRecord(overrides: Partial<GeneratedDocumentRecord>): GeneratedDocumentRecord {
  return {
    id: 'doc-stale-test',
    templateId: 'tpl-stale-test',
    title: '生成中',
    requirement: '',
    markdown: '',
    status: 'generating',
    createdAt: 0,
    updatedAt: 0,
    assets: [],
    ...overrides,
  };
}

describe('generatedDocument stale guard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FAKE_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(() => {
    const projectDir = path.dirname(generatedRoot(TMP_PROJECT_ROOT));
    if (projectDir.includes(os.homedir()) && path.basename(path.dirname(projectDir)) === 'projects') {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('任务注册表与进程启动时刻挂在 globalThis 上跨模块实例共享', () => {
    const store = globalThis as unknown as {
      __generatedDocumentTasks?: Map<string, unknown>;
      __generatedDocumentProcessStartedAt?: number;
    };
    expect(store.__generatedDocumentTasks).toBeInstanceOf(Map);
    expect(typeof store.__generatedDocumentProcessStartedAt).toBe('number');
    expect(PROCESS_STARTED_AT).toBeTypeOf('number');
  });

  it('generatingRecordRequiresFullPoll：宽限期内不强制全量读取，进程启动前遗留记录宽限期后强制读取', () => {
    const meta = { status: 'generating' as const, updatedAt: 0, completedAt: undefined };
    // 宽限期内（30s 下限内）：不强制
    expect(generatingRecordRequiresFullPoll({ ...meta, updatedAt: FAKE_NOW - 5_000 })).toBe(false);
    // 本进程启动时刻之后、未达 24h 长阈值：不强制
    expect(generatingRecordRequiresFullPoll({ ...meta, updatedAt: FAKE_NOW - 5 * 60_000 })).toBe(false);
    // 进程启动时刻之前、宽限期已过：强制全量读取以触发 stale 标记
    expect(generatingRecordRequiresFullPoll({ ...meta, updatedAt: REAL_NOW - 60_000 })).toBe(true);
    // 非 generating 状态：不强制
    expect(generatingRecordRequiresFullPoll({ ...meta, status: 'failed', updatedAt: REAL_NOW - 60_000 })).toBe(false);
  });

  it('宽限期内不误杀仍在更新的 generating 记录', () => {
    writeGeneratingRecord(TMP_PROJECT_ROOT, makeRecord({ updatedAt: FAKE_NOW - 5_000 }));
    const result = getGeneratedDocument('doc-stale-test', TMP_PROJECT_ROOT);
    expect(result?.status).toBe('generating');
    expect(result?.error).toBeUndefined();
  });

  it('本进程内启动的任务超过宽限期后仍走长阈值，不立即标记中断', () => {
    // FAKE_NOW - 5min 晚于进程启动时刻：即使超过宽限期，也不属于“重启遗留”记录
    writeGeneratingRecord(TMP_PROJECT_ROOT, makeRecord({ updatedAt: FAKE_NOW - 5 * 60_000 }));
    const result = getGeneratedDocument('doc-stale-test', TMP_PROJECT_ROOT);
    expect(result?.status).toBe('generating');
    expect(result?.error).toBeUndefined();
  });

  it('进程启动前遗留的 generating 记录在宽限期过后标记为中断', () => {
    // REAL_NOW - 1min 早于进程启动时刻且超过宽限期：应立即判定为“生成任务已中断”
    writeGeneratingRecord(TMP_PROJECT_ROOT, makeRecord({ updatedAt: REAL_NOW - 60_000 }));
    const result = getGeneratedDocument('doc-stale-test', TMP_PROJECT_ROOT);
    expect(result?.status).toBe('failed');
    expect(result?.error).toBe('生成任务已中断，请点击继续生成或重新生成');
    expect(result?.completedAt).toBeTypeOf('number');
  });
});
