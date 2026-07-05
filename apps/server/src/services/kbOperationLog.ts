import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { computeProjectId } from '@customize-agent/knowledge';

export type KbOperationType = 'upload' | 'delete' | 'reindex';
export type KbOperationStage = 'uploading' | 'parsing' | 'chunking' | 'vectorizing' | 'done' | 'error';
export type KbOperationStatus = 'processing' | 'success' | 'warning' | 'error';

export interface KbOperationRecord {
  id: string;
  type: KbOperationType;
  stage: KbOperationStage;
  status: KbOperationStatus;
  title: string;
  message: string;
  percent: number;
  fileName?: string;
  filePath?: string;
  chunkCount?: number;
  textLength?: number;
  extractionMode?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

function logPath(projectRoot: string) {
  return path.join(os.homedir(), '.customize-agent', 'projects', computeProjectId(projectRoot), 'kb-operations.jsonl');
}

function readAll(projectRoot: string): KbOperationRecord[] {
  const file = logPath(projectRoot);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line) as KbOperationRecord]; } catch { return []; }
  });
}

function writeAll(projectRoot: string, records: KbOperationRecord[]) {
  const file = logPath(projectRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${records.slice(-200).map(record => JSON.stringify(record)).join('\n')}\n`, 'utf8');
}

export function upsertKbOperation(projectRoot: string, patch: Omit<Partial<KbOperationRecord>, 'id'> & Pick<KbOperationRecord, 'id' | 'type' | 'title'>): KbOperationRecord {
  const now = Date.now();
  const records = readAll(projectRoot);
  const index = records.findIndex(record => record.id === patch.id);
  const current = index >= 0 ? records[index]! : undefined;
  const next: KbOperationRecord = {
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
  return next;
}

export function listKbOperations(projectRoot: string, limit = 50): KbOperationRecord[] {
  return readAll(projectRoot).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
}

export function clearKbOperations(projectRoot: string): number {
  const records = readAll(projectRoot);
  const file = logPath(projectRoot);
  if (fs.existsSync(file)) fs.unlinkSync(file);
  return records.length;
}
