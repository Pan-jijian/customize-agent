import type { NextApiRequest, NextApiResponse } from 'next';
import { installProcessErrorHandlers, recordErrorLog } from './errorLogService';

installProcessErrorHandlers();

/** API 错误边界装饰器：捕获 handler 执行过程中的异常，记录错误日志并返回统一错误响应 */
export function withApiErrorBoundary(source: string, handler: (req: NextApiRequest, res: NextApiResponse) => unknown | Promise<unknown>) {
  return async function apiErrorBoundary(req: NextApiRequest, res: NextApiResponse) {
    try {
      await handler(req, res);
    } catch (error) {
      const entry = recordErrorLog({ source, functionName: handler.name || 'anonymous', error, req });
      console.error(`[${source}]`, entry.id, error);
      if (!res.headersSent) res.status(500).json({ error: error instanceof Error ? error.message : 'Internal server error', requestId: entry.id });
    }
  };
}
