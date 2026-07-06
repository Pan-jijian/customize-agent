import * as fs from 'node:fs';
import * as path from 'node:path';
import type { NextApiRequest, NextApiResponse } from 'next';
import { generatedAssetAbsolutePath, getGeneratedAsset } from '@/services/generatedDocumentService';
import { getProjectRoot } from '@/services/kbService';

function contentType(filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  return 'image/png';
}

function isImageBuffer(buffer: Buffer) {
  return buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    || buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
    || buffer.subarray(0, 4).toString('ascii') === 'RIFF';
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const id = typeof req.query.id === 'string' ? req.query.id : '';
    if (!id) return res.status(400).json({ error: 'id required' });
    const projectRoot = getProjectRoot();
    const asset = getGeneratedAsset(id, projectRoot);
    if (!asset?.path) return res.status(404).json({ error: 'asset not found' });
    const filePath = generatedAssetAbsolutePath(asset, projectRoot);
    if (!filePath || !fs.existsSync(filePath)) return res.status(404).json({ error: 'file not found' });
    const buffer = fs.readFileSync(filePath);
    if (!isImageBuffer(buffer)) return res.status(422).json({ error: 'asset file is not a valid image' });
    res.setHeader('Content-Type', contentType(filePath));
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(buffer);
  } catch (e: unknown) {
    console.error('[api] assets/generated/preview', e);
    res.status(500).json({ error: e instanceof Error ? e.message : 'Internal server error' });
  }
}
