import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { computeProjectId } from '@customize-agent/knowledge';

export type KbOperationType = 'upload' | 'delete' | 'reindex' | 'document';
export type KbOperationStage = 'uploading' | 'parsing' | 'chunking' | 'vectorizing' | 'generating' | 'validating' | 'done' | 'error';
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
  details?: string[];
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
  // 原子写：先写临时文件再 rename，避免并发写盘时读到半截 JSON 导致日志损坏
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${records.slice(-200).map(record => JSON.stringify(record)).join('\n')}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

/** 已完成启动恢复的项目根目录：进程内每个项目只在首次读取时恢复一次 */
const recoveredRoots = new Set<string>();

/** 进程内日志缓存：单写者模型（子进程日志经 IPC 转发、主进程统一落盘）下，
 * 每个项目只读一次磁盘，后续 upsert/查询都走内存，避免每次调用全量 readAll + JSON.parse 的读写放大 */
const logCache = new Map<string, KbOperationRecord[]>();

/** 读取项目日志（含启动恢复）。首次访问读磁盘并触发中断恢复，之后命中内存缓存。
 * 外部直接改写日志文件（如 clearKbOperations 删除文件）后需同步清理缓存。 */
function cachedRecords(projectRoot: string): KbOperationRecord[] {
  let records = logCache.get(projectRoot);
  if (!records) {
    records = readAllRecovered(projectRoot);
    logCache.set(projectRoot, records);
  }
  return records;
}

/**
 * 读取任务日志并在进程启动后首次读取时恢复中断任务。
 * 任务实际运行在当前进程内，日志仅持久化到磁盘；进程退出（重启/被杀）后
 * 遗留的 processing 记录永远不会再被更新，前端会持续显示"有任务在跑"。
 * 因此每个进程首次读取某项目日志时，把残留 processing 记录标记为中断。
 */
function readAllRecovered(projectRoot: string): KbOperationRecord[] {
  const records = readAll(projectRoot);
  if (recoveredRoots.has(projectRoot)) return records;
  const interrupted = records.filter(record => record.status === 'processing');
  if (interrupted.length > 0) {
    const now = Date.now();
    for (const record of interrupted) {
      record.status = 'error';
      record.stage = 'error';
      record.error = '服务重启导致任务中断，未完成';
      record.message = record.error;
      record.updatedAt = now;
    }
    writeAll(projectRoot, records);
  }
  recoveredRoots.add(projectRoot);
  return records;
}

export function upsertKbOperation(projectRoot: string, patch: Omit<Partial<KbOperationRecord>, 'id'> & Pick<KbOperationRecord, 'id' | 'type' | 'title'>): KbOperationRecord {
  const now = Date.now();
  const records = cachedRecords(projectRoot);
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
    details: patch.details ?? current?.details,
    createdAt: current?.createdAt ?? now,
    updatedAt: now,
  };
  if (index >= 0) records[index] = next;
  else records.push(next);
  writeAll(projectRoot, records);
  return next;
}

export function listKbOperations(projectRoot: string, limit = 50): KbOperationRecord[] {
  return cachedRecords(projectRoot).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
}

export function getKbOperation(projectRoot: string, id: string): KbOperationRecord | undefined {
  return cachedRecords(projectRoot).find(record => record.id === id);
}

export function getLatestKbOperation(projectRoot: string, type?: KbOperationType): KbOperationRecord | undefined {
  return cachedRecords(projectRoot)
    .filter(record => !type || record.type === type)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
}

export function listActiveKbOperations(projectRoot: string): KbOperationRecord[] {
  return cachedRecords(projectRoot)
    .filter(record => record.status === 'processing')
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function clearKbOperations(projectRoot: string): number {
  const records = cachedRecords(projectRoot);
  const file = logPath(projectRoot);
  if (fs.existsSync(file)) fs.unlinkSync(file);
  logCache.delete(projectRoot);
  return records.length;
}

export function deleteKbOperation(projectRoot: string, id: string): boolean {
  const records = cachedRecords(projectRoot);
  // 原地删除保持缓存数组引用一致，避免缓存与落盘内容分叉
  const index = records.findIndex(record => record.id === id);
  if (index < 0) return false;
  records.splice(index, 1);
  writeAll(projectRoot, records);
  return true;
}
