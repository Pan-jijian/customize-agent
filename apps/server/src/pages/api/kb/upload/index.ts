import type { NextApiRequest, NextApiResponse } from 'next';
import { getMultiProjectManager, getProjectRoot } from '@/services/kbService';
import { setKbUploadProgress } from '@/services/kbUploadProgress';
import { upsertKbOperation } from '@/services/kbOperationLog';
import { startKnowledgeIndex } from '@/services/kbIndexWorkerService';

export const config = {
  api: { bodyParser: { sizeLimit: '500mb' }, responseLimit: '500mb' },
};

/** 文件上传 API：接收 base64 编码文件，落盘后启动后台索引任务 */
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
    const project = await getMultiProjectManager().getProject(projectRoot);
    const preparedFiles = uploadFiles.map(file => ({
      fileName: file.fileName,
      content: Buffer.from(file.fileData, 'base64'),
      targetRelativePath: project.getUploadRelativePath(file.fileName, file.relativePath),
    }));

    const jobs = await project.stageUploadedFiles(preparedFiles, operationId);
    const uploadedRelativePath = preparedFiles[0]?.targetRelativePath;
    setKbUploadProgress(operationId, { stage: 'uploading', percent: 5, message: '文件已落盘，后台索引任务已排队', fileName: titleName });
    upsertKbOperation(projectRoot, {
      id: operationId,
      type: 'upload',
      title: `上传 ${titleName}`,
      stage: 'uploading',
      status: 'processing',
      percent: 5,
      message: '文件已落盘，后台索引任务已排队',
      fileName: titleName,
      filePath: uploadedRelativePath,
    });

    startKnowledgeIndex({ id: `${operationId}-worker`, projectRoot, vectorMode: 'sync', uploadOperationId: operationId, uploadTitle: titleName });

    return res.status(202).json({
      success: true,
      accepted: true,
      operationId,
      relativePath: uploadFiles.length === 1 ? uploadedRelativePath : undefined,
      jobs,
    });
  } catch (e: unknown) {
    const projectRoot = req.body?.projectRoot || getProjectRoot();
    const requestFiles = Array.isArray(req.body?.files) ? req.body.files as Array<{ fileName?: string }> : [];
    const fileName = req.body?.fileName || (requestFiles.length > 1 ? `${requestFiles.length} 个文件` : requestFiles[0]?.fileName);
    const operationId = req.body?.uploadId || `upload-${Date.now()}`;
    const message = e instanceof Error ? e.message : '上传或索引失败';
    setKbUploadProgress(operationId, { stage: 'error', percent: 100, message, fileName });
    if (projectRoot && fileName) upsertKbOperation(projectRoot, { id: operationId, type: 'upload', title: `上传 ${fileName}`, stage: 'error', status: 'error', percent: 100, message, fileName, error: message });
    console.error('[api] kb/upload', e);
    res.status(500).json({ error: message });
  }
}
