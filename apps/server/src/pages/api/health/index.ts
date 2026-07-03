import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type { NextApiRequest, NextApiResponse } from 'next';

const startTime = Date.now();
const moduleDir = dirname(fileURLToPath(import.meta.url));
const buildIdCandidates = [
  join(process.cwd(), '.next', 'BUILD_ID'),
  join(process.cwd(), 'apps', 'server', '.next', 'BUILD_ID'),
  join(moduleDir, '..', '..', '..', '..', '..', 'BUILD_ID'),
];
const buildIdPath = buildIdCandidates.find(existsSync);
const processBuildId = process.env.CUSTOMIZE_DASHBOARD_BUILD_ID ?? (buildIdPath ? readFileSync(buildIdPath, 'utf-8').trim() : null);

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
