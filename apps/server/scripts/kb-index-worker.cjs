#!/usr/bin/env node
// 知识库后台索引子进程壳：索引主循环复用 @customize-agent/knowledge 的 runIndexLoop
// （与主进程 runInProcess 共用同一实现），本文件只负责参数解析、进程壳与日志 IPC 转发。
// 操作日志单写者为主进程：worker 不再直接读写 kb-operations.jsonl，
// 而是通过 process.send({ type: 'log', patch }) 把补丁交给主进程统一落盘，
// 避免父子进程同时读改写日志文件造成记录丢失。
const path = require('node:path');

function upsert(_projectRoot, patch) {
  if (process.send) process.send({ type: 'log', patch });
}

function toStage(stage) {
  if (['parsing', 'chunking', 'vectorizing', 'done', 'error'].includes(stage)) return stage;
  if (stage === 'indexing') return 'chunking';
  if (stage === 'scanning') return 'uploading';
  return 'vectorizing';
}

async function main() {
  const job = JSON.parse(process.argv[2] || '{}');
  const projectRoot = path.resolve(job.projectRoot);
  const operationId = job.operationId || job.id;
  const operationType = job.uploadOperationId ? 'upload' : 'reindex';
  const operationTitle = job.uploadOperationId ? `上传 ${job.uploadTitle || '文件'}` : job.relativePath ? `重新解析 ${job.relativePath}` : '知识库后台索引';
  upsert(projectRoot, { id: operationId, type: operationType, title: operationTitle, stage: 'uploading', status: 'processing', percent: 5, message: '索引任务已在独立后台进程启动', filePath: job.relativePath, fileName: job.relativePath ? path.basename(job.relativePath) : undefined });

  const knowledge = await import('@customize-agent/knowledge');
  const manager = new knowledge.MultiProjectManager();
  const project = await manager.getProject(projectRoot);
  const onProgress = progress => upsert(projectRoot, {
    id: operationId,
    type: operationType,
    title: operationTitle,
    stage: toStage(progress.stage),
    status: progress.stage === 'error' ? 'error' : 'processing',
    percent: progress.percent,
    message: progress.message,
    filePath: progress.filePath || job.relativePath,
    chunkCount: progress.chunkCount,
    error: progress.vectorStatus?.error,
  });

  const { vectorStatus } = await knowledge.runIndexLoop(project, job, onProgress);
  if (vectorStatus.status === 'error') {
    const error = vectorStatus.error || 'HNSWLib 向量入库失败';
    upsert(projectRoot, { id: operationId, type: operationType, title: operationTitle, stage: 'error', status: 'error', percent: 100, message: error, error });
    process.exitCode = 1;
    return;
  }
  upsert(projectRoot, { id: operationId, type: operationType, title: operationTitle, stage: 'done', status: 'success', percent: 100, message: job.relativePaths?.length ? '文件夹重新解析完成' : job.relativePath ? '单文件重新解析完成' : '知识库后台索引完成', filePath: job.relativePath, fileName: job.relativePath ? path.basename(job.relativePath) : undefined });
}

main().catch(error => {
  const job = JSON.parse(process.argv[2] || '{}');
  const projectRoot = job.projectRoot ? path.resolve(job.projectRoot) : process.cwd();
  const operationId = job.operationId || job.id || `worker-error-${Date.now()}`;
  const message = error instanceof Error ? (error.stack || error.message) : String(error);
  upsert(projectRoot, { id: operationId, type: job.uploadOperationId ? 'upload' : 'reindex', title: job.uploadOperationId ? `上传 ${job.uploadTitle || '文件'}` : job.relativePath ? `重新解析 ${job.relativePath}` : '知识库后台索引', stage: 'error', status: 'error', percent: 100, message, error: message, filePath: job.relativePath, fileName: job.relativePath ? path.basename(job.relativePath) : undefined });
  process.exit(1);
});
