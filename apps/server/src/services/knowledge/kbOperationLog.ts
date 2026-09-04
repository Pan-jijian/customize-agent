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
  // 同步本实例缓存的文件 mtime，避免刚写盘又被本实例误判为“外部改写”而重复读盘
  const cached = logCache.get(projectRoot);
  if (cached) cached.mtimeMs = logFileMtimeMs(file);
}

/** 进程启动时刻：仅将 updatedAt 早于该时刻的 processing 记录视为“重启遗留”任务。
 * 必须用 process.uptime() 反推真实进程启动时刻，而非模块加载时刻 Date.now()：
 * Next.js 按需编译（dev）或 chunk 分割下，本模块可能被多个 API 路由各自实例化，
 * 若取模块加载时刻，任务提交后才首次编译的 bundle 实例会把“正在运行的新任务”
 * （其 updatedAt 早于该实例的加载时刻）误标为“服务重启导致任务中断”。
 * uptime 反推值在同一进程内所有实例一致，天然幂等且不会误标新任务。 */
const PROCESS_START_AT = Math.round(Date.now() - process.uptime() * 1000);

interface LogCacheEntry { mtimeMs: number; records: KbOperationRecord[] }

/** 进程内日志缓存：单写者模型（子进程日志经 IPC 转发、主进程统一落盘）下，
 * 以文件 mtime 为准缓存磁盘内容，mtime 变化（本实例或其他 bundle 实例写盘）时重读，
 * 避免多个模块实例各自维护缓存、全量写盘互相覆盖导致读到过期任务状态。 */
const logCache = new Map<string, LogCacheEntry>();

function logFileMtimeMs(file: string): number {
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}

/** 读取项目日志（含启动恢复）。文件 mtime 未变时命中内存缓存；
 * 外部直接改写日志文件（如 clearKbOperations 删除文件）后 mtime 归零，同样触发重读。 */
function cachedRecords(projectRoot: string): KbOperationRecord[] {
  const file = logPath(projectRoot);
  const mtimeMs = logFileMtimeMs(file);
  const cached = logCache.get(projectRoot);
  if (cached && cached.mtimeMs === mtimeMs) return cached.records;
  const records = readAllRecovered(projectRoot);
  logCache.set(projectRoot, { mtimeMs: logFileMtimeMs(file), records });
  return records;
}

/**
 * 读取任务日志并把“重启遗留”的 processing 记录标记为中断。
 * 任务实际运行在当前进程内，日志仅持久化到磁盘；进程退出（重启/被杀）后
 * 遗留的 processing 记录永远不会再被更新，前端会持续显示“有任务在跑”。
 * 仅标记 updatedAt 早于本进程启动时刻的记录：本进程刚提交、正在运行的新任务
 * 必须跳过，否则 worker 首条 IPC 日志触发其他 bundle 实例的首次读取时，
 * 会把新任务误标为“服务重启导致任务中断”，前端轮询到 error 后弹报错。
 */
function readAllRecovered(projectRoot: string): KbOperationRecord[] {
  const records = readAll(projectRoot);
  const interrupted = records.filter(record => record.status === 'processing' && record.updatedAt < PROCESS_START_AT);
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
    // 补丁明确处于非错误状态（processing/success）时清空残留 error：
    // 恢复逻辑的误标/历史错误一旦残留，后续正常运行补丁（不含 error 字段）会一直携带
    // 旧错误信息，导致成功任务仍显示失败原因。
    error: patch.status && patch.status !== 'error' ? undefined : patch.error ?? current?.error,
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
