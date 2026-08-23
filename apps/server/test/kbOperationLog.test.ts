import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { computeProjectId } from '@customize-agent/knowledge';
import { listActiveKbOperations, listKbOperations, upsertKbOperation } from '../src/services/knowledge/kbOperationLog';

const tmpHome = path.join(fs.realpathSync(os.tmpdir()), `kbop-test-${process.pid}`);

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpHome };
});

function logFile(projectRoot: string) {
  return path.join(tmpHome, '.customize-agent', 'projects', computeProjectId(projectRoot), 'kb-operations.jsonl');
}

function writeRaw(projectRoot: string, records: Array<Record<string, unknown>>) {
  const file = logFile(projectRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${records.map(record => JSON.stringify(record)).join('\n')}\n`, 'utf8');
}

function rawRecord(overrides: Record<string, unknown>) {
  return {
    id: `task-${Date.now()}`,
    type: 'document',
    stage: 'generating',
    status: 'processing',
    title: '生成 生成中',
    message: '',
    percent: 30,
    createdAt: Date.now() - 60000,
    updatedAt: Date.now() - 60000,
    ...overrides,
  };
}

describe('kbOperationLog 启动恢复', () => {
  beforeEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('进程重启后残留的 processing 记录在首次读取时被标记为中断', () => {
    const root = '/tmp/kbop-resume-a';
    writeRaw(root, [rawRecord({ id: 'legacy-1' }), rawRecord({ id: 'legacy-2' })]);

    const jobs = listKbOperations(root);
    expect(jobs).toHaveLength(2);
    for (const job of jobs) {
      expect(job.status).toBe('error');
      expect(job.stage).toBe('error');
      expect(job.error).toContain('服务重启');
    }
    // 标记为中断后不再被视为活跃任务
    expect(listActiveKbOperations(root)).toHaveLength(0);
  });

  it('恢复只执行一次：本进程新建的 processing 任务不会被误标', () => {
    const root = '/tmp/kbop-resume-b';
    // 首次读取带一条残留，触发恢复
    writeRaw(root, [rawRecord({ id: 'legacy-1' })]);
    listKbOperations(root);

    // 本进程新提交的任务保持 processing
    upsertKbOperation(root, { id: 'fresh-1', type: 'document', title: '新任务', status: 'processing', percent: 10 });
    const active = listActiveKbOperations(root);
    expect(active).toHaveLength(1);
    expect(active[0]!.id).toBe('fresh-1');
    expect(active[0]!.status).toBe('processing');
    // 残留记录仍是 error，不干扰新任务
    const all = listKbOperations(root);
    expect(all.find(job => job.id === 'legacy-1')!.status).toBe('error');
  });
});
