// @customize-agent/search — Worker 共享类型（pool.ts 和 worker.ts 共用）

/** 发给 Worker 线程的请求 */
export interface WorkerRequest {
  id: number;
  filePath: string;
  code: string;
  mode: 'index' | 'validate';
}

/** Worker 返回的符号条目 */
export interface SymbolEntry {
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
}

/** Worker 线程的响应消息 */
export interface WorkerResponse {
  id: number;
  symbols?: SymbolEntry[];
  errors?: Array<{ line: number; column: number; message: string }>;
  valid?: boolean;
  language?: string;
  skipped?: boolean;
  reason?: string;
}
