#!/usr/bin/env node
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function computeProjectId(projectRoot) {
  return crypto.createHash('sha256').update(path.resolve(projectRoot)).digest('hex').slice(0, 12);
}

function logPath(projectRoot) {
  return path.join(os.homedir(), '.customize-agent', 'projects', computeProjectId(path.resolve(projectRoot)), 'kb-operations.jsonl');
}

function readAll(projectRoot) {
  const file = logPath(projectRoot);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

function writeAll(projectRoot, records) {
  const file = logPath(projectRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${records.slice(-200).map(record => JSON.stringify(record)).join('\n')}\n`, 'utf8');
}

function upsert(projectRoot, patch) {
  const now = Date.now();
  const records = readAll(projectRoot);
  const index = records.findIndex(record => record.id === patch.id);
  const current = index >= 0 ? records[index] : undefined;
  const next = {
    id: patch.id,
    type: patch.type,
    title: patch.title,
    stage: patch.stage ?? current?.stage ?? 'uploading',
    status: patch.status ?? current?.status ?? 'processing',
    message: patch.message ?? current?.message ?? '',
    percent: patch.percent ?? current?.percent ?? 0,
    fileName: patch.fileName ?? current?.fileName,
    filePath: patch.filePath ?? current?.filePath,
    chunkCount: patch.chunkCount ?? current?.chunkCount,
    textLength: patch.textLength ?? current?.textLength,
    extractionMode: patch.extractionMode ?? current?.extractionMode,
    error: patch.error ?? current?.error,
    createdAt: current?.createdAt ?? now,
    updatedAt: now,
  };
  if (index >= 0) records[index] = next;
  else records.push(next);
  writeAll(projectRoot, records);
  if (process.send) process.send({ type: 'progress', record: next });
  return next;
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

  let diff = job.relativePath
    ? await project.reindexFile(job.relativePath, { vectorMode: job.vectorMode, onProgress })
    : job.forceReindexAll
      ? await project.forceReindexAll({ vectorMode: job.vectorMode, onProgress })
      : await project.consumePendingIndexJobs({ vectorMode: job.vectorMode, onProgress, waitForUploadId: job.uploadOperationId });

  let idleChecks = 0;
  while (!job.relativePath && (project.countPendingIndexJobs() > 0 || (job.uploadOperationId && project.uploadSessionIsOpen(job.uploadOperationId) && idleChecks < 120))) {
    if (project.countPendingIndexJobs() === 0) {
      idleChecks += 1;
      await new Promise(resolve => setTimeout(resolve, 1000));
      continue;
    }
    idleChecks = 0;
    const nextDiff = await project.consumePendingIndexJobs({ vectorMode: job.vectorMode, onProgress, waitForUploadId: job.uploadOperationId });
    diff = {
      newFiles: [...diff.newFiles, ...nextDiff.newFiles],
      modifiedFiles: [...diff.modifiedFiles, ...nextDiff.modifiedFiles],
      deletedFiles: [...diff.deletedFiles, ...nextDiff.deletedFiles],
      unchangedCount: diff.unchangedCount + nextDiff.unchangedCount,
      mtimeOnlyCount: diff.mtimeOnlyCount + nextDiff.mtimeOnlyCount,
      skippedFiles: [...diff.skippedFiles, ...nextDiff.skippedFiles],
      hasChanges: diff.hasChanges || nextDiff.hasChanges,
      diffTimeMs: diff.diffTimeMs + nextDiff.diffTimeMs,
    };
  }

  const vectorStatus = project.getVectorStatus();
  if (vectorStatus.status === 'error') {
    const error = vectorStatus.error || 'HNSWLib 向量入库失败';
    upsert(projectRoot, { id: operationId, type: operationType, title: operationTitle, stage: 'error', status: 'error', percent: 100, message: error, error });
    process.exitCode = 1;
    return;
  }
  upsert(projectRoot, { id: operationId, type: operationType, title: operationTitle, stage: 'done', status: 'success', percent: 100, message: job.relativePath ? '单文件重新解析完成' : '知识库后台索引完成', filePath: job.relativePath, fileName: job.relativePath ? path.basename(job.relativePath) : undefined });
}

main().catch(error => {
  const job = JSON.parse(process.argv[2] || '{}');
  const projectRoot = job.projectRoot ? path.resolve(job.projectRoot) : process.cwd();
  const operationId = job.operationId || job.id || `worker-error-${Date.now()}`;
  const message = error instanceof Error ? (error.stack || error.message) : String(error);
  upsert(projectRoot, { id: operationId, type: job.uploadOperationId ? 'upload' : 'reindex', title: job.uploadOperationId ? `上传 ${job.uploadTitle || '文件'}` : job.relativePath ? `重新解析 ${job.relativePath}` : '知识库后台索引', stage: 'error', status: 'error', percent: 100, message, error: message, filePath: job.relativePath, fileName: job.relativePath ? path.basename(job.relativePath) : undefined });
  process.exit(1);
});
