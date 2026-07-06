import type { NextApiRequest, NextApiResponse } from 'next';
import * as fs from 'fs';
import * as path from 'path';
import { getMultiProjectManager, getProjectRoot } from '@/services/kbService';
import { setKbUploadProgress } from '@/services/kbUploadProgress';
import { upsertKbOperation, type KbOperationStage } from '@/services/kbOperationLog';
import type { KnowledgeIndexProgress } from '@customize-agent/knowledge';

export const config = {
  api: { bodyParser: { sizeLimit: '500mb' }, responseLimit: '500mb' },
};

function categoryFromRelativePath(relativePath: string) {
  if (relativePath.includes('表格数据/')) return 'spreadsheet';
  if (relativePath.includes('图片素材/')) return 'image';
  if (relativePath.includes('图纸文件/')) return 'cad';
  if (relativePath.includes('文档资料/')) return 'document';
  return 'other';
}

type UploadedFileItem = ReturnType<Awaited<ReturnType<ReturnType<typeof getMultiProjectManager>['getProject']>>['listFiles']>[number];

function fallbackUploadedFile(projectRoot: string, relativePath: string): UploadedFileItem | undefined {
  const absolutePath = path.join(projectRoot, 'knowledgeBase', relativePath);
  if (!fs.existsSync(absolutePath)) return undefined;
  const stat = fs.statSync(absolutePath);
  return {
    relativePath,
    category: categoryFromRelativePath(relativePath),
    format: path.extname(relativePath).slice(1).toLowerCase() || 'text',
    contentHash: '',
    fileSize: stat.size,
    mtime: stat.mtimeMs,
    chunkCount: 0,
    collectionName: '',
    indexedAt: 0,
    lastVerifiedAt: Date.now(),
    status: 'active',
  };
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { fileName, fileData, uploadId } = req.body;
    const uploadFiles = Array.isArray(req.body.files)
      ? req.body.files as Array<{ fileName: string; fileData: string; relativePath?: string }>
      : fileName && fileData
        ? [{ fileName, fileData, relativePath: req.body.relativePath }]
        : [];
    if (uploadFiles.length === 0) return res.status(400).json({ error: 'files required' });
    const projectRoot = req.body.projectRoot || getProjectRoot();
    if (!projectRoot) return res.status(400).json({ error: 'Project root is required' });
    const operationId = uploadId || `upload-${Date.now()}`;
    const titleName = uploadFiles.length === 1 ? uploadFiles[0]!.fileName : `${uploadFiles.length} 个文件`;
    setKbUploadProgress(operationId, { stage: 'uploading', percent: 20, message: '文件已接收，正在准备写入', fileName: titleName });
    upsertKbOperation(projectRoot, { id: operationId, type: 'upload', title: `上传 ${titleName}`, stage: 'uploading', status: 'processing', percent: 20, message: '文件已接收，正在准备写入', fileName: titleName });
    const project = await getMultiProjectManager().getProject(projectRoot);
    const preparedFiles = uploadFiles.map(file => ({
      fileName: file.fileName,
      content: Buffer.from(file.fileData, 'base64'),
      targetRelativePath: project.getUploadRelativePath(file.fileName, file.relativePath),
    }));
    const uploadedRelativePath = preparedFiles[0]?.targetRelativePath;
    setKbUploadProgress(operationId, { stage: 'parsing', percent: 40, message: '正在解析文件内容', fileName: titleName });
    upsertKbOperation(projectRoot, { id: operationId, type: 'upload', title: `上传 ${titleName}`, stage: 'parsing', status: 'processing', percent: 40, message: '正在解析文件内容', fileName: titleName, filePath: uploadedRelativePath });
    const diff = await project.uploadFiles(preparedFiles, (progress: KnowledgeIndexProgress) => {
      const stage = (progress.stage === 'scanning' ? 'uploading' : progress.stage) as KbOperationStage;
      setKbUploadProgress(operationId, { ...progress, stage, fileName: titleName });
      upsertKbOperation(projectRoot, { id: operationId, type: 'upload', title: `上传 ${titleName}`, stage, status: 'processing', percent: progress.percent, message: progress.message, fileName: titleName, filePath: progress.filePath ?? uploadedRelativePath, chunkCount: progress.chunkCount });
    }, { vectorMode: 'defer' });
    const files = project.listFiles();
    const uploadedPaths = preparedFiles.map(file => file.targetRelativePath).filter(Boolean) as string[];
    const uploadedFiles = uploadedPaths.flatMap(relativePath => files.find(file => file.relativePath === relativePath) ?? fallbackUploadedFile(projectRoot, relativePath) ?? []);
    const changedPaths = new Set([...diff.newFiles, ...diff.modifiedFiles].map(file => file.relativePath));
    const changedChunkCount = files.filter(file => changedPaths.has(file.relativePath)).reduce((sum, file) => sum + file.chunkCount, 0);
    const uploaded = uploadedFiles.find(file => file.relativePath === uploadedRelativePath);
    const uploadedMeta = uploaded?.metadataJson ? JSON.parse(uploaded.metadataJson) : undefined;
    const vectorStatus = project.getVectorStatus();
    const vectorReady = vectorStatus.status === 'ready';
    setKbUploadProgress(operationId, {
      stage: 'done',
      percent: 100,
      message: vectorReady ? '解析、切片和向量入库已完成' : '解析、切片和 SQLite 入库已完成，向量入库待完成',
      fileName: titleName,
      chunkCount: uploadFiles.length === 1 ? uploaded?.chunkCount : changedChunkCount,
      vectorStatus,
      error: vectorStatus.error,
    });
    upsertKbOperation(projectRoot, {
      id: operationId,
      type: 'upload',
      title: `上传 ${titleName}`,
      stage: 'done',
      status: vectorReady ? 'success' : 'warning',
      percent: 100,
      message: vectorReady ? '解析、切片和向量入库已完成' : '解析、切片和 SQLite 入库已完成，向量入库待完成',
      fileName: titleName,
      filePath: uploadFiles.length === 1 ? (uploaded?.relativePath ?? uploadedRelativePath) : undefined,
      chunkCount: uploadFiles.length === 1 ? uploaded?.chunkCount : changedChunkCount,
      textLength: uploadedMeta?.extraction?.textLength,
      extractionMode: uploadedMeta?.extraction?.extractionMode,
      error: vectorStatus.error,
    });
    res.status(200).json({
      success: true,
      relativePath: uploadFiles.length === 1 ? (uploaded?.relativePath ?? uploadedRelativePath) : undefined,
      added: diff.newFiles.length,
      total: files.length,
      files,
      uploadedFiles,
      vectorStatus,
    });
  } catch (e: unknown) {
    const projectRoot = req.body?.projectRoot || getProjectRoot();
    const requestFiles = Array.isArray(req.body?.files) ? req.body.files as Array<{ fileName?: string }> : [];
    const fileName = req.body?.fileName || (requestFiles.length > 1 ? `${requestFiles.length} 个文件` : requestFiles[0]?.fileName);
    const operationId = req.body?.uploadId || `upload-${Date.now()}`;
    if (projectRoot && fileName) upsertKbOperation(projectRoot, { id: operationId, type: 'upload', title: `上传 ${fileName}`, stage: 'error', status: 'error', percent: 100, message: '上传或索引失败', fileName, error: 'Internal server error' });
    console.error('[api] kb/upload', e);
    res.status(500).json({ error: 'Internal server error' });
  }
}
