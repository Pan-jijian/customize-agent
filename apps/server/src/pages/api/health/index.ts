import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { NextApiRequest, NextApiResponse } from 'next';

const startTime = Date.now();
const buildIdCandidates = [
  join(process.cwd(), '.next', 'BUILD_ID'),
  join(process.cwd(), 'apps', 'server', '.next', 'BUILD_ID'),
];
const buildIdPath = buildIdCandidates.find(existsSync);
const processBuildId = process.env.CUSTOMIZE_DASHBOARD_BUILD_ID ?? (buildIdPath ? readFileSync(buildIdPath, 'utf-8').trim() : null);

/** 健康检查 API：返回服务运行状态、启动时间和构建信息 */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    res.status(200).json({
      status: 'ok',
      uptime: Date.now() - startTime,
      timestamp: new Date().toISOString(),
      buildId: processBuildId,
      pid: process.pid,
    });
  } catch (e: unknown) {
    console.error('[api] health', e);
    res.status(500).json({ error: 'Internal server error' });
  }
}
