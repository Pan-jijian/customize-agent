import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import type { NextApiRequest, NextApiResponse } from 'next';

export type ErrorLogLevel = 'error' | 'warn' | 'info';

export interface ErrorLogEntry {
  id: string;
  level: ErrorLogLevel;
  source: string;
  functionName?: string;
  message: string;
  stack?: string;
  request?: { method?: string; url?: string; query?: unknown };
  meta?: unknown;
  createdAt: number;
}

const LOG_DIR = path.join(os.homedir(), '.customize-agent', 'logs');
const ERROR_LOG_FILE = path.join(LOG_DIR, 'errors.jsonl');
const MAX_LOG_BYTES = 2 * 1024 * 1024;

function ensureLogDir() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function serializeError(error: unknown) {
  if (error instanceof Error) return { message: error.message, stack: error.stack };
  if (typeof error === 'string') return { message: error };
  try { return { message: JSON.stringify(error) }; } catch { return { message: String(error) }; }
}

function rotateIfNeeded() {
  try {
    const stat = fs.statSync(ERROR_LOG_FILE);
    if (stat.size <= MAX_LOG_BYTES) return;
    fs.renameSync(ERROR_LOG_FILE, path.join(LOG_DIR, `errors-${Date.now()}.jsonl`));
  } catch {
    // 日志文件尚不存在
  }
}

export function recordErrorLog(input: { level?: ErrorLogLevel; source: string; functionName?: string; error: unknown; req?: NextApiRequest; meta?: unknown }) {
  const { message, stack } = serializeError(input.error);
  const entry: ErrorLogEntry = {
    id: `err_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
    level: input.level || 'error',
    source: input.source,
    functionName: input.functionName,
    message,
    stack,
    request: input.req ? { method: input.req.method, url: input.req.url, query: input.req.query } : undefined,
    meta: input.meta,
    createdAt: Date.now(),
  };
  try {
    ensureLogDir();
    rotateIfNeeded();
    fs.appendFileSync(ERROR_LOG_FILE, `${JSON.stringify(entry)}\n`);
  } catch (writeError) {
    console.error('[errorLogService] failed to write error log', writeError);
  }
  return entry;
}

export function listErrorLogs(limit = 200): ErrorLogEntry[] {
  try {
    const content = fs.readFileSync(ERROR_LOG_FILE, 'utf8');
    return content.split('\n').filter(Boolean).slice(-limit).reverse().map(line => JSON.parse(line) as ErrorLogEntry);
  } catch {
    return [];
  }
}

export function clearErrorLogs() {
  try { fs.rmSync(ERROR_LOG_FILE, { force: true }); } catch { /* 忽略 */ }
}

let processHandlersInstalled = false;

// 异常风暴防护：stdout/stderr 不可写（如管道破裂 EPIPE）时，console.error 会同步抛错再次触发
// uncaughtException，形成无限递归风暴占满事件循环（曾导致生成任务假死、HTTP 无响应）。
// 通过 try-catch 断链 + 同窗口限流，保证处理器自身永不递归。
export function createProcessErrorHandler(
  label: string,
  record: (error: unknown) => void,
  output: (label: string, error: unknown) => void,
  limit = 20,
) {
  let windowStart = 0;
  let count = 0;
  return (error: unknown) => {
    try {
      record(error);
      const now = Date.now();
      if (now - windowStart > 60_000) {
        windowStart = now;
        count = 0;
      }
      if (count < limit) {
        count += 1;
        output(label, error);
      }
    } catch {
      // stdout/stderr 写入失败时静默，避免 console 抛错递归触发 uncaughtException 风暴
    }
  };
}

export function installProcessErrorHandlers() {
  if (processHandlersInstalled) return;
  processHandlersInstalled = true;
  process.on('uncaughtException', createProcessErrorHandler('uncaughtException', error => recordErrorLog({ source: 'process', functionName: 'uncaughtException', error }), (label, error) => console.error(`[process] ${label}`, error)));
  process.on('unhandledRejection', createProcessErrorHandler('unhandledRejection', reason => recordErrorLog({ source: 'process', functionName: 'unhandledRejection', error: reason }), (label, error) => console.error(`[process] ${label}`, error)));
}
