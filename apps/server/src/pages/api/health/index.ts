import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { NextApiRequest, NextApiResponse } from 'next';

const buildIdCandidates = [
  join(process.cwd(), '.next', 'BUILD_ID'),
  join(process.cwd(), 'apps', 'server', '.next', 'BUILD_ID'),
];
const buildIdPath = buildIdCandidates.find(existsSync);
let processBuildId: string | null = process.env.CUSTOMIZE_DASHBOARD_BUILD_ID ?? null;
if (!processBuildId && buildIdPath) {
  try {
    processBuildId = readFileSync(buildIdPath, 'utf-8').trim();
  } catch {
    processBuildId = null;
  }
}

/** 健康检查 API：返回服务运行状态、运行时长（秒）和构建信息 */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    res.status(200).json({
      status: 'ok',
      // 4.28.0 E3 修复：原为模块加载至请求的毫秒差（Date.now() - startTime），而消费端 settings 页
      // formatUptime 按秒换算 → 显示放大 1000 倍；改为 process.uptime()（秒），与 /api/system/stats 口径一致
      uptime: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
      buildId: processBuildId,
      pid: process.pid,
    });
  } catch (e: unknown) {
    console.error('[api] health', e);
    res.status(500).json({ error: 'Internal server error' });
  }
}
