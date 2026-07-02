import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { NextApiRequest, NextApiResponse } from 'next';

const startTime = Date.now();
const buildIdPath = join(process.cwd(), '.next', 'BUILD_ID');
const processBuildId = existsSync(buildIdPath) ? readFileSync(buildIdPath, 'utf-8').trim() : null;

export default function handler(_req: NextApiRequest, res: NextApiResponse) {
  res.status(200).json({
    status: 'ok',
    uptime: Date.now() - startTime,
    timestamp: new Date().toISOString(),
    buildId: processBuildId,
    pid: process.pid,
  });
}
