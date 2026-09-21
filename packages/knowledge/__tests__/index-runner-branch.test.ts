/**
 * runIndexLoop 分支选择回归。
 *
 * 缺陷背景：`relativePaths` 分支优先于 `relativePath` 分支，而「重新解析文件/文件夹」API
 * 对单文件也会传 `relativePaths = [relativePath]`，于是永远走 incrementalIndex —— 它以
 * 「mtime + 大小」初筛、内容哈希复核，解析器升级不改文件内容，这批文件被判「未变更」跳过，
 * 用户点「重新解析」看不到任何变化（强制分支 reindexFile 实际不可达）。
 */
import { describe, expect, it, vi } from 'vitest';
import { runIndexLoop } from '../src/core/index-runner.js';
import type { KnowledgeBaseManager } from '../src/core/knowledge-base-manager.js';
import type { DiffResult } from '../src/types.js';

const emptyDiff = (): DiffResult => ({
  newFiles: [], modifiedFiles: [], deletedFiles: [], unchangedCount: 0,
  mtimeOnlyCount: 0, skippedFiles: [], hasChanges: false, diffTimeMs: 0,
});

/** 用桩替代真实 KnowledgeBaseManager：本用例只验证「选了哪个分支」，不需要真解析与向量化 */
function stubProject() {
  const project = {
    incrementalIndex: vi.fn(async () => emptyDiff()),
    reindexPaths: vi.fn(async () => emptyDiff()),
    reindexFile: vi.fn(async () => emptyDiff()),
    forceReindexAll: vi.fn(async () => emptyDiff()),
    consumePendingIndexJobs: vi.fn(async () => emptyDiff()),
    countPendingIndexJobs: () => 0,
    hasOpenUploadSessions: () => false,
    getVectorStatus: () => ({ status: 'ready' }),
  };
  return project as unknown as KnowledgeBaseManager & typeof project;
}

const noop = () => { /* 进度回调在本用例中不参与断言 */ };

describe('runIndexLoop 重解析分支', () => {
  it('relativePaths + forceReindex：走强制重解析，不被「未变更」跳过', async () => {
    const project = stubProject();
    await runIndexLoop(project, { relativePaths: ['图纸/结构图.dwg'], forceReindex: true }, noop);
    expect(project.reindexPaths).toHaveBeenCalledTimes(1);
    expect(project.reindexPaths).toHaveBeenCalledWith(['图纸/结构图.dwg'], expect.anything());
    expect(project.incrementalIndex).not.toHaveBeenCalled();
  });

  it('relativePaths 未带 forceReindex：保持增量语义（上传批次不吃强制重解析的开销）', async () => {
    const project = stubProject();
    await runIndexLoop(project, { relativePaths: ['图纸/结构图.dwg'] }, noop);
    expect(project.incrementalIndex).toHaveBeenCalledTimes(1);
    expect(project.reindexPaths).not.toHaveBeenCalled();
  });

  it('仅 relativePath（无 relativePaths）：走 reindexFile 强制分支', async () => {
    const project = stubProject();
    await runIndexLoop(project, { relativePath: '图纸/结构图.dwg' }, noop);
    expect(project.reindexFile).toHaveBeenCalledTimes(1);
    expect(project.reindexPaths).not.toHaveBeenCalled();
    expect(project.incrementalIndex).not.toHaveBeenCalled();
  });

  it('forceReindexAll 仍走整库重解析', async () => {
    const project = stubProject();
    await runIndexLoop(project, { forceReindexAll: true }, noop);
    expect(project.forceReindexAll).toHaveBeenCalledTimes(1);
    expect(project.reindexPaths).not.toHaveBeenCalled();
  });

  it('无任何范围参数：消费待处理上传批次', async () => {
    const project = stubProject();
    await runIndexLoop(project, {}, noop);
    expect(project.consumePendingIndexJobs).toHaveBeenCalledTimes(1);
  });
});
