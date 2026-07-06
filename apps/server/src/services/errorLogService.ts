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
    // no log file yet
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
  try { fs.rmSync(ERROR_LOG_FILE, { force: true }); } catch { /* ignore */ }
}

let processHandlersInstalled = false;
export function installProcessErrorHandlers() {
  if (processHandlersInstalled) return;
  processHandlersInstalled = true;
  process.on('uncaughtException', error => { recordErrorLog({ source: 'process', functionName: 'uncaughtException', error }); console.error('[process] uncaughtException', error); });
  process.on('unhandledRejection', reason => { recordErrorLog({ source: 'process', functionName: 'unhandledRejection', error: reason }); console.error('[process] unhandledRejection', reason); });
}
