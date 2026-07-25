export type KbUploadStage = 'uploading' | 'parsing' | 'chunking' | 'vectorizing' | 'done' | 'error';

export interface KbUploadProgress {
  id: string;
  stage: KbUploadStage;
  percent: number;
  message: string;
  fileName?: string;
  chunkCount?: number;
  vectorStatus?: unknown;
  error?: string;
  updatedAt: number;
}

const uploads = new Map<string, KbUploadProgress>();

/** 设置知识库文件上传进度（内存缓存），供前端轮询查询当前上传/解析/向量化状态 */
export function setKbUploadProgress(id: string | undefined, progress: Omit<KbUploadProgress, 'id' | 'updatedAt'>): void {
  if (!id) return;
  uploads.set(id, { id, ...progress, updatedAt: Date.now() });
}

export function getKbUploadProgress(id: string): KbUploadProgress | undefined {
  const progress = uploads.get(id);
  if (!progress) return undefined;
  if (Date.now() - progress.updatedAt > 30 * 60_000) {
    uploads.delete(id);
    return undefined;
  }
  return progress;
}
