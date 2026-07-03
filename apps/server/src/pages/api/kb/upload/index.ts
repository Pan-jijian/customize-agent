import type { NextApiRequest, NextApiResponse } from 'next';
import { getMultiProjectManager, getProjectRoot } from '@/services/kbService';
import { setKbUploadProgress } from '@/services/kbUploadProgress';
import { upsertKbOperation, type KbOperationStage } from '@/services/kbOperationLog';
import type { KnowledgeIndexProgress } from '@customize-agent/knowledge';

export const config = {
  api: { bodyParser: { sizeLimit: '500mb' }, responseLimit: '500mb' },
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { fileName, fileData, uploadId } = req.body;
    if (!fileName || !fileData) return res.status(400).json({ error: 'fileName and fileData required' });
    const projectRoot = req.body.projectRoot || getProjectRoot();
    if (!projectRoot) return res.status(400).json({ error: 'Project root is required' });
    const operationId = uploadId || `upload-${Date.now()}`;
    setKbUploadProgress(operationId, { stage: 'uploading', percent: 20, message: '文件已接收，正在准备写入', fileName });
    upsertKbOperation(projectRoot, { id: operationId, type: 'upload', title: `上传 ${fileName}`, stage: 'uploading', status: 'processing', percent: 20, message: '文件已接收，正在准备写入', fileName });
    const buffer = Buffer.from(fileData, 'base64');
    const project = await getMultiProjectManager().getProject(projectRoot);
    const uploadedRelativePath = project.getUploadRelativePath(fileName);
    setKbUploadProgress(operationId, { stage: 'parsing', percent: 40, message: '正在解析文件内容', fileName });
    upsertKbOperation(projectRoot, { id: operationId, type: 'upload', title: `上传 ${fileName}`, stage: 'parsing', status: 'processing', percent: 40, message: '正在解析文件内容', fileName, filePath: uploadedRelativePath });
    const diff = await project.uploadFile(fileName, buffer, uploadedRelativePath, (progress: KnowledgeIndexProgress) => {
      const stage = (progress.stage === 'scanning' ? 'uploading' : progress.stage) as KbOperationStage;
      setKbUploadProgress(operationId, { ...progress, stage, fileName });
      upsertKbOperation(projectRoot, { id: operationId, type: 'upload', title: `上传 ${fileName}`, stage, status: 'processing', percent: progress.percent, message: progress.message, fileName, filePath: uploadedRelativePath, chunkCount: progress.chunkCount });
    }, { vectorMode: 'defer' });
    const files = project.listFiles();
    const uploaded = files.find(file => file.relativePath === uploadedRelativePath);
    const uploadedMeta = uploaded?.metadataJson ? JSON.parse(uploaded.metadataJson) : undefined;
    const vectorStatus = project.getVectorStatus();
    const vectorReady = vectorStatus.status === 'ready';
    setKbUploadProgress(operationId, {
      stage: 'done',
      percent: 100,
      message: vectorReady ? '解析、切片和向量入库已完成' : '解析、切片和 SQLite 入库已完成，向量入库待完成',
      fileName,
      chunkCount: uploaded?.chunkCount,
      vectorStatus,
      error: vectorStatus.error,
    });
    upsertKbOperation(projectRoot, {
      id: operationId,
      type: 'upload',
      title: `上传 ${fileName}`,
      stage: 'done',
      status: vectorReady ? 'success' : 'warning',
      percent: 100,
      message: vectorReady ? '解析、切片和向量入库已完成' : '解析、切片和 SQLite 入库已完成，向量入库待完成',
      fileName,
      filePath: uploaded?.relativePath ?? uploadedRelativePath,
      chunkCount: uploaded?.chunkCount,
      textLength: uploadedMeta?.extraction?.textLength,
      extractionMode: uploadedMeta?.extraction?.extractionMode,
      error: vectorStatus.error,
    });
    res.status(200).json({
      success: true,
      relativePath: uploaded?.relativePath ?? uploadedRelativePath,
      added: diff.newFiles.length,
      total: files.length,
      files,
      vectorStatus,
    });
  } catch (e: unknown) {
    const projectRoot = req.body?.projectRoot || getProjectRoot();
    const fileName = req.body?.fileName;
    const operationId = req.body?.uploadId || `upload-${Date.now()}`;
    if (projectRoot && fileName) upsertKbOperation(projectRoot, { id: operationId, type: 'upload', title: `上传 ${fileName}`, stage: 'error', status: 'error', percent: 100, message: '上传或索引失败', fileName, error: 'Internal server error' });
    console.error('[api] kb/upload', e);
    res.status(500).json({ error: 'Internal server error' });
  }
}
