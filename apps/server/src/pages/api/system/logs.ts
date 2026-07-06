import type { NextApiRequest, NextApiResponse } from 'next';
import { clearErrorLogs, listErrorLogs } from '@/services/errorLogService';
import { withApiErrorBoundary } from '@/services/apiErrorBoundary';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    const limit = Math.max(1, Math.min(1000, Number(req.query.limit || 200) || 200));
    res.status(200).json({ logs: listErrorLogs(limit) });
    return;
  }
  if (req.method === 'DELETE') {
    clearErrorLogs();
    res.status(200).json({ ok: true });
    return;
  }
  res.status(405).json({ error: 'Method not allowed' });
}

export default withApiErrorBoundary('api/system/logs', handler);
