import { EventEmitter } from 'node:events';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('child_process', () => ({ fork: vi.fn() }));
vi.mock('@customize-agent/knowledge', () => ({ runIndexLoop: vi.fn() }));
vi.mock('@/services/knowledge/kbService', () => ({ getMultiProjectManager: vi.fn() }));
vi.mock('@/services/knowledge/kbOperationLog', () => ({ upsertKbOperation: vi.fn() }));
vi.mock('@/services/document-workflow/projectIntelligence', () => ({ startProjectIntelligenceBuild: vi.fn() }));

import { fork } from 'child_process';
import { runIndexLoop } from '@customize-agent/knowledge';
import { getMultiProjectManager } from '@/services/knowledge/kbService';
import { upsertKbOperation } from '@/services/knowledge/kbOperationLog';
import { startProjectIntelligenceBuild } from '@/services/document-workflow/projectIntelligence';
import {
  enqueueKnowledgeIndex,
  getActiveKnowledgeIndex,
  isKnowledgeIndexing,
  startKnowledgeIndex,
} from '@/services/knowledge/kbIndexWorkerService';

function createFakeChild() {
  return Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
}

type FakeChild = ReturnType<typeof createFakeChild>;

const WORKER_PATH = expect.stringContaining('kb-index-worker.cjs');

beforeEach(() => {
  vi.mocked(fork).mockReset();
  vi.mocked(runIndexLoop).mockReset();
  vi.mocked(upsertKbOperation).mockReset();
  vi.mocked(startProjectIntelligenceBuild).mockReset();
  vi.mocked(getMultiProjectManager).mockReset();
  delete process.env.CUSTOMIZE_AGENT_DISABLE_KB_CHILD_PROCESS;
});

describe('子进程模式（runInChildProcess）', () => {
  it('stdout 清洗噪声行后写入日志，exit 0 完成并触发项目理解构建', async () => {
    const child = createFakeChild();
    vi.mocked(fork).mockReturnValue(child as never);
    const promise = enqueueKnowledgeIndex({ id: 'job-1', projectRoot: '/proj-idx' });
    expect(fork).toHaveBeenCalledWith(
      WORKER_PATH,
      [JSON.stringify({ id: 'job-1', projectRoot: '/proj-idx', operationId: 'job-1' })],
      expect.any(Object),
    );
    expect(upsertKbOperation).toHaveBeenCalledWith('/proj-idx', expect.objectContaining({ id: 'job-1', type: 'reindex', stage: 'uploading', status: 'processing', message: '索引任务已进入后台队列' }));

    child.stdout.emit('data', Buffer.from('line one\nImage too small to scale!!\nLine cannot be recognized!!\nline two'));
    // 输出日志按 500ms 窗口合并节流，exit 前兜底冲刷：断言在 exit 后进行
    child.emit('exit', 0);
    const result = await promise;
    // 噪声行被清洗，剩余行合并进 message
    expect(upsertKbOperation).toHaveBeenCalledWith('/proj-idx', expect.objectContaining({
      id: 'job-1', stage: 'parsing', status: 'processing', percent: 5,
      message: '后台索引输出：line one\nline two',
    }));
    expect(result).toEqual({ success: true });
    expect(startProjectIntelligenceBuild).toHaveBeenCalledWith('/proj-idx');
    expect(isKnowledgeIndexing('/proj-idx')).toBe(false);
  });

  it('stderr 输出以错误输出前缀写入日志', async () => {
    const child = createFakeChild();
    vi.mocked(fork).mockReturnValue(child as never);
    const promise = enqueueKnowledgeIndex({ id: 'job-2', projectRoot: '/proj-idx2' });
    child.stderr.emit('data', Buffer.from('  warning: bad glyph  \n'));
    // 节流窗口内不立即写日志，exit 触发兜底冲刷后可见
    child.emit('exit', 0);
    await promise;
    expect(upsertKbOperation).toHaveBeenCalledWith('/proj-idx2', expect.objectContaining({
      id: 'job-2', message: '后台索引错误输出：warning: bad glyph',
    }));
  });

  it('exit 非 0 且无任何 IPC 上报：自动切换进程内索引并完成', async () => {
    const child = createFakeChild();
    vi.mocked(fork).mockReturnValue(child as never);
    const project = { getStats: vi.fn(() => ({})) };
    vi.mocked(getMultiProjectManager).mockReturnValue({ getProject: vi.fn(async () => project) } as never);
    vi.mocked(runIndexLoop).mockResolvedValue({ vectorStatus: { status: 'ready' } } as never);
    const promise = enqueueKnowledgeIndex({ id: 'job-3', projectRoot: '/proj-idx3' });
    child.emit('exit', 1);
    const result = await promise;
    // 子进程启动即失败：进程内兜底，上传不再报「知识库后台进程退出」
    expect(result.success).toBe(true);
    expect(runIndexLoop).toHaveBeenCalled();
    expect(upsertKbOperation).toHaveBeenCalledWith('/proj-idx3', expect.objectContaining({ id: 'job-3', stage: 'parsing', status: 'processing', message: expect.stringContaining('已自动切换为主进程内索引') }));
    expect(startProjectIntelligenceBuild).toHaveBeenCalledWith('/proj-idx3');
  });

  it('exit 非 0 且已上报过 IPC（运行中途崩溃）：仍按失败处理', async () => {
    const child = createFakeChild();
    vi.mocked(fork).mockReturnValue(child as never);
    const promise = enqueueKnowledgeIndex({ id: 'job-3b', projectRoot: '/proj-idx3b' });
    child.emit('message', { type: 'log', patch: { id: 'job-3b', type: 'reindex', title: '重建', stage: 'chunking', status: 'processing', percent: 30, message: '分块中' } });
    child.emit('exit', 1);
    const result = await promise;
    expect(result).toEqual({ success: false, error: '知识库后台进程退出，退出码 1' });
    expect(upsertKbOperation).toHaveBeenCalledWith('/proj-idx3b', expect.objectContaining({ id: 'job-3b', stage: 'error', status: 'error', percent: 100, error: '知识库后台进程退出，退出码 1' }));
    expect(startProjectIntelligenceBuild).not.toHaveBeenCalled();
  });

  it('子进程 spawn 失败（error 事件）：自动切换进程内索引并完成', async () => {
    const child = createFakeChild();
    vi.mocked(fork).mockReturnValue(child as never);
    const project = { getStats: vi.fn(() => ({})) };
    vi.mocked(getMultiProjectManager).mockReturnValue({ getProject: vi.fn(async () => project) } as never);
    vi.mocked(runIndexLoop).mockResolvedValue({ vectorStatus: { status: 'ready' } } as never);
    const promise = enqueueKnowledgeIndex({ id: 'job-4', projectRoot: '/proj-idx4' });
    child.emit('error', new Error('spawn ENOENT'));
    const result = await promise;
    expect(result.success).toBe(true);
    expect(runIndexLoop).toHaveBeenCalled();
    expect(upsertKbOperation).toHaveBeenCalledWith('/proj-idx4', expect.objectContaining({ id: 'job-4', stage: 'parsing', status: 'processing', message: expect.stringContaining('已自动切换为主进程内索引') }));
    expect(startProjectIntelligenceBuild).toHaveBeenCalledWith('/proj-idx4');
  });

  it('IPC 消息转发操作日志补丁（单写者）', async () => {
    const child = createFakeChild();
    vi.mocked(fork).mockReturnValue(child as never);
    const patch = { id: 'op-x', type: 'reindex' as const, title: '重建', stage: 'chunking' as const, status: 'processing' as const, percent: 50, message: '分块中' };
    const promise = enqueueKnowledgeIndex({ id: 'job-5', projectRoot: '/proj-idx5', uploadOperationId: 'op-x' });
    child.emit('message', { type: 'log', patch });
    expect(upsertKbOperation).toHaveBeenCalledWith('/proj-idx5', patch);
    child.emit('exit', 0);
    await promise;
  });
});

describe('进程内模式（runInProcess）', () => {
  it('runIndexLoop 进度回调映射 stage，完成后触发项目理解构建', async () => {
    process.env.CUSTOMIZE_AGENT_DISABLE_KB_CHILD_PROCESS = '1';
    const project = { getStats: vi.fn(() => ({ files: 1 })) };
    vi.mocked(getMultiProjectManager).mockReturnValue({ getProject: vi.fn(async () => project) } as never);
    vi.mocked(runIndexLoop).mockImplementation(async (_project, _job, onProgress) => {
      onProgress({ stage: 'scanning', percent: 10, message: '扫描中' });
      // 'indexing' 为历史子进程输出兼容分支（类型中已移除，运行时仍映射为 chunking）
      onProgress({ stage: 'indexing' as never, percent: 30, message: '索引中', chunkCount: 5, filePath: 'a.pdf' });
      onProgress({ stage: 'vectorizing', percent: 60, message: '向量化' });
      return { vectorStatus: { status: 'ok' } } as never;
    });
    const promise = enqueueKnowledgeIndex({ id: 'job-6', projectRoot: '/proj-inproc', relativePath: 'a.pdf' });
    const result = await promise;
    expect(result.success).toBe(true);
    expect(fork).not.toHaveBeenCalled();
    // stage 映射：scanning→uploading、indexing→chunking、vectorizing 直通
    expect(upsertKbOperation).toHaveBeenCalledWith('/proj-inproc', expect.objectContaining({ id: 'job-6', stage: 'uploading', message: '扫描中' }));
    expect(upsertKbOperation).toHaveBeenCalledWith('/proj-inproc', expect.objectContaining({ id: 'job-6', stage: 'chunking', chunkCount: 5, filePath: 'a.pdf' }));
    expect(upsertKbOperation).toHaveBeenCalledWith('/proj-inproc', expect.objectContaining({ id: 'job-6', stage: 'vectorizing' }));
    expect(upsertKbOperation).toHaveBeenCalledWith('/proj-inproc', expect.objectContaining({ id: 'job-6', stage: 'done', status: 'success', percent: 100, fileName: 'a.pdf' }));
    expect(startProjectIntelligenceBuild).toHaveBeenCalledWith('/proj-inproc');
  });

  it('vectorStatus 错误：向量降级不阻断，操作以 warning 完成', async () => {
    process.env.CUSTOMIZE_AGENT_DISABLE_KB_CHILD_PROCESS = '1';
    const project = { getStats: vi.fn(() => ({})) };
    vi.mocked(getMultiProjectManager).mockReturnValue({ getProject: vi.fn(async () => project) } as never);
    vi.mocked(runIndexLoop).mockResolvedValue({ vectorStatus: { status: 'error', error: 'HNSWLib 向量入库失败' } } as never);
    const promise = enqueueKnowledgeIndex({ id: 'job-7', projectRoot: '/proj-inproc2' });
    const result = await promise;
    expect(result.success).toBe(true);
    expect(result.warning).toBe('HNSWLib 向量入库失败');
    expect(upsertKbOperation).toHaveBeenCalledWith('/proj-inproc2', expect.objectContaining({ id: 'job-7', stage: 'done', status: 'warning', error: 'HNSWLib 向量入库失败' }));
    expect(startProjectIntelligenceBuild).toHaveBeenCalledWith('/proj-inproc2');
  });

  it('索引抛错：触发 failPendingIndexJobs 并写入错误日志', async () => {
    process.env.CUSTOMIZE_AGENT_DISABLE_KB_CHILD_PROCESS = '1';
    const project = { getStats: vi.fn(() => ({})), failPendingIndexJobs: vi.fn() };
    vi.mocked(getMultiProjectManager).mockReturnValue({ getProject: vi.fn(async () => project) } as never);
    vi.mocked(runIndexLoop).mockRejectedValue(new Error('索引循环崩溃'));
    const promise = enqueueKnowledgeIndex({ id: 'job-8', projectRoot: '/proj-inproc3' });
    const result = await promise;
    expect(result.success).toBe(false);
    expect(project.failPendingIndexJobs).toHaveBeenCalled();
    expect(upsertKbOperation).toHaveBeenCalledWith('/proj-inproc3', expect.objectContaining({ id: 'job-8', stage: 'error', status: 'error', error: expect.stringContaining('索引循环崩溃') }));
  });
});

describe('队列编排', () => {
  it('uploadOperationId 决定操作类型与标题', async () => {
    const child = createFakeChild();
    vi.mocked(fork).mockReturnValue(child as never);
    const promise = enqueueKnowledgeIndex({ id: 'job-u', projectRoot: '/proj-u', uploadOperationId: 'op-up', uploadTitle: '招标文件.pdf' });
    expect(upsertKbOperation).toHaveBeenCalledWith('/proj-u', expect.objectContaining({ id: 'op-up', type: 'upload', title: '上传 招标文件.pdf' }));
    child.emit('exit', 0);
    await promise;
  });

  it('同项目并发入队串成链式队列：前一任务结束后再消费下一任务', async () => {
    const childA = createFakeChild();
    const childB = createFakeChild();
    vi.mocked(fork).mockReturnValueOnce(childA as never).mockReturnValueOnce(childB as never);
    const p1 = enqueueKnowledgeIndex({ id: 'job-1', projectRoot: '/proj-chain' });
    expect(isKnowledgeIndexing('/proj-chain')).toBe(true);
    expect(getActiveKnowledgeIndex('/proj-chain')?.operationId).toBe('job-1');
    const p2 = enqueueKnowledgeIndex({ id: 'job-2', projectRoot: '/proj-chain' });
    // 第一个任务尚未结束，第二个不会立即 fork
    expect(fork).toHaveBeenCalledTimes(1);

    childA.emit('exit', 0);
    await p1;
    await vi.waitFor(() => expect(fork).toHaveBeenCalledTimes(2));
    expect(fork).toHaveBeenLastCalledWith(WORKER_PATH, [JSON.stringify({ id: 'job-2', projectRoot: '/proj-chain', operationId: 'job-2' })], expect.any(Object));
    childB.emit('exit', 0);
    const result = await p2;
    expect(result.success).toBe(true);
    await vi.waitFor(() => expect(isKnowledgeIndexing('/proj-chain')).toBe(false));
    expect(getActiveKnowledgeIndex('/proj-chain')).toBeUndefined();
  });

  it('startKnowledgeIndex 触发后台入队', async () => {
    const child = createFakeChild();
    vi.mocked(fork).mockReturnValue(child as never);
    startKnowledgeIndex({ id: 'job-v', projectRoot: '/proj-v' });
    expect(isKnowledgeIndexing('/proj-v')).toBe(true);
    child.emit('exit', 0);
    await new Promise(resolve => setImmediate(resolve));
    expect(isKnowledgeIndexing('/proj-v')).toBe(false);
  });
});
