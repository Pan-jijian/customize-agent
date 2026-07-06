import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { NextApiRequest, NextApiResponse } from 'next';
import { upsertGeneratedAssets } from '@/services/generatedDocumentService';
import { getProjectRoot } from '@/services/kbService';

type ImageSize = 'square_hd' | 'square' | 'portrait_4_3' | 'portrait_16_9' | 'landscape_4_3' | 'landscape_16_9';

const KNOWN_STATIC_GENERATED_IMAGE_HASHES = new Set([
  'e330cd023298a812503e10a067a3f88e1cbc094f37f6fd2a88fdb6799495b37e',
]);

function isValidImageBuffer(buffer: Buffer) {
  return buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    || buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
    || buffer.subarray(0, 4).toString('ascii') === 'RIFF';
}

function imageHash(buffer: Buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function mimeExtension(mimeType: string) {
  if (mimeType.includes('jpeg') || mimeType.includes('jpg')) return 'jpg';
  if (mimeType.includes('webp')) return 'webp';
  return 'png';
}

function buildTextToImageUrl(prompt: string, imageSize: ImageSize) {
  return `https://coresg-normal.trae.ai/api/ide/v1/text_to_image?prompt=${encodeURIComponent(prompt)}&image_size=${imageSize}`;
}

function saveImageAsset(projectRoot: string, fileName: string, buffer: Buffer) {
  const projectId = crypto.createHash('sha1').update(path.resolve(projectRoot)).digest('hex').slice(0, 12);
  const dir = path.join(os.homedir(), '.customize-agent', 'projects', projectId, 'generatedDocuments', 'assets');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, fileName), buffer);
  return `generatedDocuments/assets/${fileName}`;
}

async function downloadImage(prompt: string, imageSize: ImageSize) {
  const response = await fetch(buildTextToImageUrl(prompt, imageSize), { signal: AbortSignal.timeout(60000) });
  const contentType = response.headers.get('content-type') || '';
  const buffer = Buffer.from(await response.arrayBuffer());
  const hash = imageHash(buffer);
  if (!response.ok) throw new Error(`图片生成接口失败：${response.status} ${buffer.toString('utf8').slice(0, 120)}`);
  if (!contentType.startsWith('image/') || !isValidImageBuffer(buffer)) throw new Error(`图片生成接口未返回有效图片：${contentType || 'unknown'} ${buffer.toString('utf8').slice(0, 120)}`);
  return { contentType, buffer, hash, staticPlaceholder: KNOWN_STATIC_GENERATED_IMAGE_HASHES.has(hash) };
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const prompt = typeof req.body?.prompt === 'string' && req.body.prompt.trim()
      ? req.body.prompt.trim()
      : 'professional document cover, blue tactical map blueprint, realistic, clean website hero image, 16:9';
    const imageSize = (typeof req.body?.imageSize === 'string' ? req.body.imageSize : 'landscape_16_9') as ImageSize;
    const projectRoot = getProjectRoot();
    const { contentType, buffer, hash, staticPlaceholder } = await downloadImage(prompt, imageSize);
    const fileName = `test-cover-${Date.now()}.${mimeExtension(contentType)}`;
    const relativePath = saveImageAsset(projectRoot, fileName, buffer);
    const asset = {
      id: `asset-test-${Date.now()}`,
      type: 'image' as const,
      role: 'generated' as const,
      path: relativePath,
      prompt,
      status: 'generated' as const,
      message: staticPlaceholder
        ? `测试生成返回固定图片：${contentType}，${buffer.length} 字节，sha256=${hash}`
        : `测试生成成功：${contentType}，${buffer.length} 字节，sha256=${hash}`,
    };
    upsertGeneratedAssets([asset], `test-${Date.now()}`, projectRoot);
    return res.status(200).json({ asset, contentType, bytes: buffer.length, hash, staticPlaceholder });
  } catch (e: unknown) {
    console.error('[api] assets/generated/test-generate', e);
    return res.status(500).json({ error: e instanceof Error ? e.message : 'Internal server error' });
  }
}
