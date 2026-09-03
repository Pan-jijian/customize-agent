import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// 文件系统经 homedir mock 重定向到工厂内自建的固定临时目录；
// computeProjectId 按项目根路径派生，保证不同 projectRoot 落盘到独立目录。
vi.mock('os', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { join } = await import('node:path');
  let fixedDir = '';
  const mockOs = {
    homedir: () => {
      if (!fixedDir) fixedDir = mkdtempSync(join('/tmp', 'ca-kblog-test-'));
      return fixedDir;
    },
    tmpdir: () => '/tmp',
  };
  return { ...mockOs, default: mockOs };
});
vi.mock('@customize-agent/knowledge', () => ({
  computeProjectId: vi.fn((root: string) => `proj-${root.replace(/[^a-zA-Z0-9]/gu, '-')}`),
}));

import { computeProjectId } from '@customize-agent/knowledge';
import {
  clearKbOperations,
  deleteKbOperation,
  getKbOperation,
  getLatestKbOperation,
  listActiveKbOperations,
  listKbOperations,
  upsertKbOperation,
} from './kbOperationLog';

function logFile(root: string) {
  return path.join(os.homedir(), '.customize-agent', 'projects', computeProjectId(root), 'kb-operations.jsonl');
}

beforeEach(() => {
  fs.rmSync(path.join(os.homedir(), '.customize-agent'), { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(os.homedir(), { recursive: true, force: true });
});

describe('upsertKbOperation', () => {
  it('新建记录填充默认值并落盘 JSONL', () => {
    vi.useFakeTimers();
    try {
      const record = upsertKbOperation('/proj-a', { id: 'op-1', type: 'upload', title: '上传 招标文件.pdf' });
      expect(record.id).toBe('op-1');
      expect(record.type).toBe('upload');
      expect(record.stage).toBe('uploading');
      expect(record.status).toBe('processing');
      expect(record.percent).toBe(0);
      expect(record.message).toBe('');
      expect(record.createdAt).toBe(record.updatedAt);
      const file = logFile('/proj-a');
      expect(fs.existsSync(file)).toBe(true);
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!).id).toBe('op-1');
    } finally {
      vi.useRealTimers();
    }
  });

  it('更新记录：合并补丁、继承字段、保留 createdAt', () => {
    vi.useFakeTimers();
    try {
      const first = upsertKbOperation('/proj-b', { id: 'op-2', type: 'reindex', title: '重建索引' });
      vi.advanceTimersByTime(1000);
      const updated = upsertKbOperation('/proj-b', { id: 'op-2', type: 'reindex', title: '重建索引', stage: 'chunking', percent: 42, message: '分块中' });
      expect(updated.stage).toBe('chunking');
      expect(updated.percent).toBe(42);
      expect(updated.message).toBe('分块中');
      expect(updated.status).toBe('processing');
      expect(updated.createdAt).toBe(first.createdAt);
      expect(updated.updatedAt).toBeGreaterThan(first.updatedAt);
      // 只存在一条记录
      expect(listKbOperations('/proj-b').length).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('更新可覆盖派生字段 fileName/chunkCount/error/details', () => {
    const record = upsertKbOperation('/proj-c', {
      id: 'op-3',
      type: 'upload',
      title: '上传 招标文件.pdf',
      fileName: '招标文件.pdf',
      chunkCount: 12,
      textLength: 3000,
      extractionMode: 'docx',
      details: ['解析完成'],
      error: 'x',
    });
    expect(record.fileName).toBe('招标文件.pdf');
    expect(record.chunkCount).toBe(12);
    expect(record.extractionMode).toBe('docx');
    expect(record.details).toEqual(['解析完成']);
    expect(record.error).toBe('x');
    // 未提供的字段在下一次更新时继承
    const next = upsertKbOperation('/proj-c', { id: 'op-3', type: 'upload', title: '上传 招标文件.pdf', percent: 99 });
    expect(next.chunkCount).toBe(12);
    expect(next.fileName).toBe('招标文件.pdf');
  });
});

describe('查询', () => {
  it('listKbOperations 按 updatedAt 倒序且受 limit 截断', () => {
    vi.useFakeTimers();
    try {
      upsertKbOperation('/proj-sort', { id: 'op-1', type: 'upload', title: '任务一' });
      vi.advanceTimersByTime(1000);
      upsertKbOperation('/proj-sort', { id: 'op-2', type: 'upload', title: '任务二' });
      vi.advanceTimersByTime(1000);
      upsertKbOperation('/proj-sort', { id: 'op-3', type: 'upload', title: '任务三' });
      expect(listKbOperations('/proj-sort').map(item => item.id)).toEqual(['op-3', 'op-2', 'op-1']);
      expect(listKbOperations('/proj-sort', 2).map(item => item.id)).toEqual(['op-3', 'op-2']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('getKbOperation / getLatestKbOperation（type 过滤）/ listActiveKbOperations', () => {
    vi.useFakeTimers();
    try {
      upsertKbOperation('/proj-q', { id: 'op-1', type: 'upload', title: '上传任务' });
      vi.advanceTimersByTime(1000);
      upsertKbOperation('/proj-q', { id: 'op-2', type: 'reindex', title: '重建任务', status: 'processing', stage: 'chunking' });
      vi.advanceTimersByTime(1000);
      upsertKbOperation('/proj-q', { id: 'op-3', type: 'upload', title: '完成的上传', status: 'success', stage: 'done' });

      expect(getKbOperation('/proj-q', 'op-2')?.title).toBe('重建任务');
      expect(getKbOperation('/proj-q', 'nope')).toBeUndefined();
      expect(getLatestKbOperation('/proj-q')?.id).toBe('op-3');
      expect(getLatestKbOperation('/proj-q', 'reindex')?.id).toBe('op-2');
      expect(getLatestKbOperation('/proj-q', 'document')).toBeUndefined();
      const active = listActiveKbOperations('/proj-q');
      // 活跃任务按 updatedAt 倒序（最新在前）
      expect(active.map(item => item.id)).toEqual(['op-2', 'op-1']);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('删除与清理', () => {
  it('deleteKbOperation 原地删除并同步落盘；不存在返回 false', () => {
    upsertKbOperation('/proj-d', { id: 'op-1', type: 'upload', title: '任务一' });
    upsertKbOperation('/proj-d', { id: 'op-2', type: 'upload', title: '任务二' });
    expect(deleteKbOperation('/proj-d', 'op-1')).toBe(true);
    expect(deleteKbOperation('/proj-d', 'ghost')).toBe(false);
    expect(listKbOperations('/proj-d').map(item => item.id)).toEqual(['op-2']);
    // 磁盘与缓存一致
    const lines = fs.readFileSync(logFile('/proj-d'), 'utf8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).id).toBe('op-2');
  });

  it('clearKbOperations 删除文件并清缓存，返回记录数', () => {
    upsertKbOperation('/proj-clear', { id: 'op-1', type: 'upload', title: '任务一' });
    upsertKbOperation('/proj-clear', { id: 'op-2', type: 'upload', title: '任务二' });
    expect(clearKbOperations('/proj-clear')).toBe(2);
    expect(fs.existsSync(logFile('/proj-clear'))).toBe(false);
    // 缓存已清：重新读取返回空
    expect(listKbOperations('/proj-clear')).toEqual([]);
  });
});

describe('启动恢复与容错', () => {
  it('首次读取时将遗留 processing 记录标记为中断', () => {
    const file = logFile('/proj-recovery');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({
      id: 'op-p', type: 'upload', stage: 'parsing', status: 'processing', title: '上传 a.pdf', message: '解析中', percent: 40, createdAt: 1000, updatedAt: 2000,
    })}\n`);
    const list = listKbOperations('/proj-recovery');
    const recovered = list.find(item => item.id === 'op-p');
    expect(recovered?.status).toBe('error');
    expect(recovered?.stage).toBe('error');
    expect(recovered?.error).toBe('服务重启导致任务中断，未完成');
    expect(recovered?.updatedAt).toBeGreaterThan(2000);
  });

  it('进程内新提交的 processing 记录不被误判为中断', () => {
    // 先触发一次读取（空日志）
    expect(listKbOperations('/proj-recovery-2')).toEqual([]);
    // 新写入的 processing 记录（updatedAt 晚于进程启动时刻）不被误判为重启遗留
    upsertKbOperation('/proj-recovery-2', { id: 'op-q', type: 'reindex', title: '重建', stage: 'chunking', status: 'processing' });
    const active = listActiveKbOperations('/proj-recovery-2');
    expect(active.map(item => item.id)).toEqual(['op-q']);
    expect(active[0]!.status).toBe('processing');
    expect(active[0]!.error).toBeUndefined();
  });

  it('损坏的 JSONL 行被跳过', () => {
    const file = logFile('/proj-corrupt');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `不是合法JSON\n${JSON.stringify({ id: 'op-ok', type: 'upload', stage: 'done', status: 'success', title: '正常', message: '', percent: 100, createdAt: 1, updatedAt: 2 })}\n`);
    const list = listKbOperations('/proj-corrupt');
    expect(list.map(item => item.id)).toEqual(['op-ok']);
  });

  it('日志超过 200 条时只保留最近 200 条', () => {
    vi.useFakeTimers();
    try {
      for (let i = 1; i <= 201; i += 1) {
        upsertKbOperation('/proj-truncate', { id: `op-${i}`, type: 'upload', title: `任务 ${i}` });
        vi.advanceTimersByTime(10);
      }
      const lines = fs.readFileSync(logFile('/proj-truncate'), 'utf8').split('\n').filter(Boolean);
      // 落盘截断：只保留最近 200 条，最旧记录 op-1 被挤出
      expect(lines).toHaveLength(200);
      expect(lines[0]).toContain('op-2');
      expect(lines.some(line => line.includes('"id":"op-1"'))).toBe(false);
      // 内存缓存保持全量，仅落盘截断
      const list = listKbOperations('/proj-truncate', 1000);
      expect(list).toHaveLength(201);
      expect(list[0]!.id).toBe('op-201');
      expect(list.some(item => item.id === 'op-1')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
