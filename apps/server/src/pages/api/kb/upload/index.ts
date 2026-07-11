import type { NextApiRequest, NextApiResponse } from 'next';
import formidable, { type File as FormidableFile } from 'formidable';
import { getMultiProjectManager, getProjectRoot } from '@/services/kbService';
import { setKbUploadProgress } from '@/services/kbUploadProgress';
import { upsertKbOperation } from '@/services/kbOperationLog';
import { startKnowledgeIndex } from '@/services/kbIndexWorkerService';

export const config = {
  api: { bodyParser: false, responseLimit: '500mb' },
};

type MultipartFields = {
  uploadId?: string;
  projectRoot?: string;
  relativePaths: string[];
  batchIndex: number;
  totalBatches: number;
  startIndex: boolean;
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

function parseMultipart(req: NextApiRequest): Promise<{ fields: MultipartFields; files: FormidableFile[] }> {
  const form = formidable({ multiples: true, maxFileSize: 500 * 1024 * 1024, maxTotalFileSize: 500 * 1024 * 1024, keepExtensions: true });
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
          startIndex: parseBool(firstField(rawFields.startIndex)) || batchIndex >= totalBatches - 1,
          fileOffset: Math.max(0, parseIntField(firstField(rawFields.fileOffset), batchIndex * 1000)),
        },
        files: fileValues,
      });
    });
  });
}

function uploadedFileName(file: FormidableFile): string {
  return file.originalFilename || file.newFilename || 'uploaded-file';
}

/** 文件上传 API：接收 multipart 文件，落盘后按最后批次启动后台索引任务 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  let operationId = `upload-${Date.now()}`;
  let projectRoot = getProjectRoot();
  let titleName: string | undefined;
  try {
    const parsed = await parseMultipart(req);
    operationId = parsed.fields.uploadId || operationId;
    projectRoot = parsed.fields.projectRoot || projectRoot;
    if (!projectRoot) return res.status(400).json({ error: 'Project root is required' });
    if (parsed.files.length === 0) return res.status(400).json({ error: 'files required' });
    if (parsed.fields.relativePaths.length !== parsed.files.length) return res.status(400).json({ error: 'relativePaths count mismatch' });

    titleName = parsed.files.length === 1 ? uploadedFileName(parsed.files[0]!) : `${parsed.files.length} 个文件`;
    const project = await getMultiProjectManager().getProject(projectRoot);
    const preparedFiles = parsed.files.map((file, index) => ({
      fileName: uploadedFileName(file),
      sourcePath: file.filepath,
      targetRelativePath: parsed.fields.relativePaths[index],
    }));

    const jobs = await project.stageUploadedFilePaths(preparedFiles, operationId, parsed.fields.fileOffset);
    const uploadedRelativePath = jobs[0]?.relativePath;
    const percent = parsed.fields.startIndex ? 5 : Math.min(4, Math.max(1, Math.round(((parsed.fields.batchIndex + 1) / parsed.fields.totalBatches) * 4)));
    const message = parsed.fields.startIndex
      ? '文件已落盘，后台索引任务已排队'
      : `文件已落盘：第 ${parsed.fields.batchIndex + 1}/${parsed.fields.totalBatches} 批`;

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
      relativePath: parsed.files.length === 1 ? uploadedRelativePath : undefined,
      jobs,
      batchIndex: parsed.fields.batchIndex,
      totalBatches: parsed.fields.totalBatches,
      indexingStarted: parsed.fields.startIndex,
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : '上传或索引失败';
    setKbUploadProgress(operationId, { stage: 'error', percent: 100, message, fileName: titleName });
    if (projectRoot && titleName) upsertKbOperation(projectRoot, { id: operationId, type: 'upload', title: `上传 ${titleName}`, stage: 'error', status: 'error', percent: 100, message, fileName: titleName, error: message });
    console.error('[api] kb/upload', e);
    res.status(500).json({ error: message });
  }
}
