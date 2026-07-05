import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { NextApiRequest, NextApiResponse } from 'next';
import { getGeneratedAsset } from '@/services/generatedDocumentService';
import { getProjectRoot } from '@/services/kbService';

function generatedRoot(projectRoot: string) {
  const projectId = crypto.createHash('sha1').update(path.resolve(projectRoot)).digest('hex').slice(0, 12);
  return path.join(os.homedir(), '.customize-agent', 'projects', projectId, 'generatedDocuments');
}

function contentType(filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  return 'image/png';
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const id = typeof req.query.id === 'string' ? req.query.id : '';
    if (!id) return res.status(400).json({ error: 'id required' });
    const projectRoot = getProjectRoot();
    const asset = getGeneratedAsset(id, projectRoot);
    if (!asset?.path?.startsWith('generatedDocuments/assets/')) return res.status(404).json({ error: 'asset not found' });
    const filePath = path.join(generatedRoot(projectRoot), asset.path.replace(/^generatedDocuments\/assets\//u, 'assets/'));
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'file not found' });
    res.setHeader('Content-Type', contentType(filePath));
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(fs.readFileSync(filePath));
  } catch (e: unknown) {
    console.error('[api] assets/generated/preview', e);
    res.status(500).json({ error: e instanceof Error ? e.message : 'Internal server error' });
  }
}
