import type { NextApiRequest, NextApiResponse } from 'next';
import formidable, { type File as FormidableFile } from 'formidable';
import { getMultiProjectManager, getProjectRoot } from '@/services/kbService';
import { setKbUploadProgress } from '@/services/kbUploadProgress';
import { upsertKbOperation } from '@/services/kbOperationLog';
import { startKnowledgeIndex } from '@/services/kbIndexWorkerService';

export const config = {
  api: { bodyParser: false, responseLimit: false },
};

type MultipartFields = {
  uploadId?: string;
  projectRoot?: string;
  relativePaths: string[];
  batchIndex: number;
  totalBatches: number;
  startIndex: boolean;
  uploadComplete: boolean;
  fileOffset: number;
};

function firstField(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function fieldArray(value: string | string[] | undefined): string[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function parseBool(value: string | undefined): boolean {
  return value === '1' || value === 'true';
}

function parseIntField(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function queryString(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function parseMultipart(req: NextApiRequest): Promise<{ fields: MultipartFields; files: FormidableFile[] }> {
  const maxUploadBytes = Number(process.env.CUSTOMIZE_KB_UPLOAD_MAX_BYTES || 4 * 1024 * 1024 * 1024);
  const form = formidable({ multiples: true, maxFileSize: maxUploadBytes, maxTotalFileSize: maxUploadBytes, keepExtensions: true, allowEmptyFiles: true });
  return new Promise((resolve, reject) => {
    form.parse(req, (error, rawFields, rawFiles) => {
      if (error) {
        reject(error);
        return;
      }
      const fileValues = Object.values(rawFiles).flat().filter(Boolean) as FormidableFile[];
      const batchIndex = parseIntField(firstField(rawFields.batchIndex), 0);
      const totalBatches = Math.max(1, parseIntField(firstField(rawFields.totalBatches), 1));
      resolve({
        fields: {
          uploadId: firstField(rawFields.uploadId),
          projectRoot: firstField(rawFields.projectRoot),
          relativePaths: fieldArray(rawFields.relativePaths),
          batchIndex,
          totalBatches,
          startIndex: parseBool(firstField(rawFields.startIndex)) || batchIndex === 0,
          uploadComplete: parseBool(firstField(rawFields.uploadComplete)) || batchIndex >= totalBatches - 1,
          fileOffset: Math.max(0, parseIntField(firstField(rawFields.fileOffset), batchIndex * 500)),
        },
        files: fileValues,
      });
    });
  });
}

const SKIPPED_UPLOAD_FILE_PATTERN = /(^|\/)\.DS_Store$|(^|\/)Thumbs\.db$|(^|\/)__MACOSX\/|\.bak$/iu;

function uploadedFileName(file: FormidableFile): string {
  return file.originalFilename || file.newFilename || 'uploaded-file';
}

/** 文件上传 API：接收 multipart 文件，首批落盘后即启动后台索引任务，后续批次持续入队 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  let operationId = queryString(req.query.uploadId) || `upload-${Date.now()}`;
  let projectRoot = getProjectRoot();
  let titleName = '文件夹上传';
  try {
    if (projectRoot) {
      upsertKbOperation(projectRoot, { id: operationId, type: 'upload', title: `上传 ${titleName}`, stage: 'uploading', status: 'processing', percent: 1, message: '正在接收上传请求', fileName: titleName });
      setKbUploadProgress(operationId, { stage: 'uploading', percent: 1, message: '正在接收上传请求', fileName: titleName });
    }

    const parsed = await parseMultipart(req);
    operationId = parsed.fields.uploadId || operationId;
    projectRoot = parsed.fields.projectRoot || projectRoot;
    if (!projectRoot) return res.status(400).json({ error: 'Project root is required' });
    if (parsed.files.length === 0) return res.status(400).json({ error: 'files required' });
    if (parsed.fields.relativePaths.length !== parsed.files.length) return res.status(400).json({ error: 'relativePaths count mismatch' });

    const acceptedFiles = parsed.files
      .map((file, index) => ({ file, relativePath: parsed.fields.relativePaths[index] }))
      .filter(item => (item.file.size || 0) > 0 && !SKIPPED_UPLOAD_FILE_PATTERN.test(item.relativePath || uploadedFileName(item.file)));
    const skippedEmptyCount = parsed.files.length - acceptedFiles.length;
    titleName = acceptedFiles.length === 1 ? uploadedFileName(acceptedFiles[0]!.file) : `${acceptedFiles.length} 个文件`;
    const project = await getMultiProjectManager().getProject(projectRoot);

    if (acceptedFiles.length === 0) {
      if (parsed.fields.uploadComplete) await project.stageUploadedFilePaths([], operationId, parsed.fields.fileOffset, true);
      const message = `第 ${parsed.fields.batchIndex + 1}/${parsed.fields.totalBatches} 批仅包含空文件、系统文件或备份文件，已跳过`;
      setKbUploadProgress(operationId, { stage: parsed.fields.uploadComplete ? 'done' : 'uploading', percent: parsed.fields.uploadComplete ? 100 : Math.min(4, Math.max(1, Math.round(((parsed.fields.batchIndex + 1) / parsed.fields.totalBatches) * 4))), message, fileName: titleName });
      upsertKbOperation(projectRoot, { id: operationId, type: 'upload', title: `上传 ${titleName}`, stage: parsed.fields.uploadComplete ? 'done' : 'uploading', status: 'warning', percent: parsed.fields.uploadComplete ? 100 : Math.min(4, Math.max(1, Math.round(((parsed.fields.batchIndex + 1) / parsed.fields.totalBatches) * 4))), message, fileName: titleName });
      return res.status(202).json({ success: true, accepted: true, operationId, jobs: [], skippedEmptyCount, batchIndex: parsed.fields.batchIndex, totalBatches: parsed.fields.totalBatches, indexingStarted: false });
    }

    const preparedFiles = acceptedFiles.map(item => ({
      fileName: uploadedFileName(item.file),
      sourcePath: item.file.filepath,
      targetRelativePath: item.relativePath,
    }));

    const jobs = await project.stageUploadedFilePaths(preparedFiles, operationId, parsed.fields.fileOffset, parsed.fields.uploadComplete);
    const uploadedRelativePath = jobs[0]?.relativePath;
    const percent = parsed.fields.startIndex ? 5 : Math.min(4, Math.max(1, Math.round(((parsed.fields.batchIndex + 1) / parsed.fields.totalBatches) * 4)));
    const message = parsed.fields.startIndex
      ? `文件已落盘，后台索引任务已排队${skippedEmptyCount ? `，已跳过 ${skippedEmptyCount} 个空文件、系统文件或备份文件` : ''}`
      : `文件已落盘：第 ${parsed.fields.batchIndex + 1}/${parsed.fields.totalBatches} 批${skippedEmptyCount ? `，已跳过 ${skippedEmptyCount} 个空文件、系统文件或备份文件` : ''}`;

    setKbUploadProgress(operationId, { stage: 'uploading', percent, message, fileName: titleName });
    upsertKbOperation(projectRoot, {
      id: operationId,
      type: 'upload',
      title: `上传 ${titleName}`,
      stage: 'uploading',
      status: 'processing',
      percent,
      message,
      fileName: titleName,
      filePath: uploadedRelativePath,
    });

    if (parsed.fields.startIndex) {
      startKnowledgeIndex({ id: `${operationId}-worker`, projectRoot, vectorMode: 'sync', uploadOperationId: operationId, uploadTitle: titleName });
    }

    return res.status(202).json({
      success: true,
      accepted: true,
      operationId,
      relativePath: acceptedFiles.length === 1 ? uploadedRelativePath : undefined,
      jobs,
      skippedEmptyCount,
      batchIndex: parsed.fields.batchIndex,
      totalBatches: parsed.fields.totalBatches,
      indexingStarted: parsed.fields.startIndex,
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : '上传或索引失败';
    setKbUploadProgress(operationId, { stage: 'error', percent: 100, message, fileName: titleName });
    if (projectRoot) {
      try {
        const project = await getMultiProjectManager().getProject(projectRoot);
        await project.stageUploadedFilePaths([], operationId, 0, true);
        project.failPendingIndexJobs(message);
      } catch (cleanupError) {
        console.error('[api] kb/upload cleanup', cleanupError);
      }
      upsertKbOperation(projectRoot, { id: operationId, type: 'upload', title: `上传 ${titleName}`, stage: 'error', status: 'error', percent: 100, message, fileName: titleName, error: message });
    }
    console.error('[api] kb/upload', e);
    res.status(500).json({ error: message });
  }
}
