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
  const onProgress = progress => {
    upsert(projectRoot, {
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
  };

  const { vectorStatus } = await knowledge.runIndexLoop(project, job, onProgress);
  // 向量索引失败/降级不阻断上传：文本解析与切片已入库，操作以 warning 完成（主进程据 status='warning' 保留降级原因）
  if (vectorStatus.status === 'error' || vectorStatus.status === 'unavailable') {
    const error = vectorStatus.error || (vectorStatus.status === 'unavailable' ? 'hnswlib-node native 绑定不可用，向量索引已降级' : 'HNSWLib 向量入库失败');
    upsert(projectRoot, { id: operationId, type: operationType, title: operationTitle, stage: 'done', status: 'warning', percent: 100, message: job.relativePaths?.length ? '文件夹重新解析完成（向量索引降级）' : job.relativePath ? '单文件重新解析完成（向量索引降级）' : '知识库后台索引完成（向量索引降级）', filePath: job.relativePath, fileName: job.relativePath ? path.basename(job.relativePath) : undefined, error });
    try { await manager.shutdown(); } catch { /* 忽略关闭异常，不掩盖索引结果 */ }
    setImmediate(() => process.kill(process.pid, 'SIGKILL'));
    return;
  }
  upsert(projectRoot, { id: operationId, type: operationType, title: operationTitle, stage: 'done', status: 'success', percent: 100, message: job.relativePaths?.length ? '文件夹重新解析完成' : job.relativePath ? '单文件重新解析完成' : '知识库后台索引完成', filePath: job.relativePath, fileName: job.relativePath ? path.basename(job.relativePath) : undefined });
  // 索引完成后显式释放 native 资源并自然退出。
  // 根因：直接 process.exit(0) 或未 shutdown 自然退出，都会在 native 模块
  // （hnswlib-node 向量索引）析构阶段触发 SIGABRT（libc++abi: mutex lock failed），
  // 主进程会误报“退出码 unknown”并把成功任务覆盖为失败。
  // shutdown 后进程已无任何待完成工作（数据已落盘、IPC 已同步写入管道），
  // 最后用 SIGKILL 自终结绕过 Node teardown（fork 场景实测 process.exit(0)、
  // disconnect+自然退出均会 SIGABRT）；主进程据 receivedDone 防护把任务视为成功。
  try { await manager.shutdown(); } catch { /* 忽略关闭异常，不掩盖索引成功结果 */ }
  setImmediate(() => process.kill(process.pid, 'SIGKILL'));
}

main().catch(error => {
  const job = JSON.parse(process.argv[2] || '{}');
  const projectRoot = job.projectRoot ? path.resolve(job.projectRoot) : process.cwd();
  const operationId = job.operationId || job.id || `worker-error-${Date.now()}`;
  const message = error instanceof Error ? (error.stack || error.message) : String(error);
  upsert(projectRoot, { id: operationId, type: job.uploadOperationId ? 'upload' : 'reindex', title: job.uploadOperationId ? `上传 ${job.uploadTitle || '文件'}` : job.relativePath ? `重新解析 ${job.relativePath}` : '知识库后台索引', stage: 'error', status: 'error', percent: 100, message, error: message, filePath: job.relativePath, fileName: job.relativePath ? path.basename(job.relativePath) : undefined });
  // 同样避免 teardown 阶段的 SIGABRT 掩盖真实错误信息（主进程据 error 补丁已落盘）
  setImmediate(() => process.kill(process.pid, 'SIGKILL'));
});
