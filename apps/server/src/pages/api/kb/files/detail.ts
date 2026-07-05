import type { NextApiRequest, NextApiResponse } from 'next';
import * as fs from 'fs';
import * as path from 'path';
import { getMultiProjectManager, getProjectRoot } from '@/services/kbService';

function categoryFromRelativePath(relativePath: string) {
  if (relativePath.includes('表格数据/')) return 'spreadsheet';
  if (relativePath.includes('图片素材/')) return 'image';
  if (relativePath.includes('图纸文件/')) return 'cad';
  if (relativePath.includes('文档资料/')) return 'document';
  return 'other';
}

function readPreviewContent(file: string, relativePath: string) {
  const ext = path.extname(relativePath).toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) return `图片文件：${relativePath}\n大小：${fs.statSync(file).size} 字节\n说明：该文件为内置知识库真实图片资源，可在文件路径中打开查看。`;
  return fs.readFileSync(file, 'utf-8');
}

function fallbackFileDetail(projectRoot: string, relativePath: string) {
  const kbRoot = path.join(projectRoot, 'knowledgeBase');
  const absolutePath = path.join(kbRoot, relativePath);
  if (!absolutePath.startsWith(kbRoot) || !fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) return undefined;
  const stat = fs.statSync(absolutePath);
  const now = Date.now();
  const format = path.extname(relativePath).slice(1).toLowerCase() || 'text';
  const content = readPreviewContent(absolutePath, relativePath);
  const file = {
    relativePath,
    category: categoryFromRelativePath(relativePath),
    format,
    contentHash: '',
    fileSize: stat.size,
    mtime: stat.mtimeMs,
    chunkCount: 1,
    collectionName: '',
    indexedAt: 0,
    lastVerifiedAt: now,
    status: 'pending',
    metadataJson: JSON.stringify({ extractionMode: 'physical_file_fallback', contentCoverage: '原文件预览', textLength: content.length }),
  };
  const chunk = {
    id: `fallback:${relativePath}`,
    relativePath,
    chunkIndex: 0,
    parentId: `fallback-parent:${relativePath}`,
    content,
    category: file.category,
    format,
    tokenCount: Math.ceil(content.length / 2),
    sectionTitle: path.basename(relativePath),
    collectionName: '',
    metadataJson: JSON.stringify({ chunkKind: ['png', 'jpg', 'jpeg', 'webp'].includes(format) ? 'image' : 'text' }),
  };
  return { file, absolutePath, directory: path.dirname(absolutePath), chunks: [chunk], parents: [{ ...chunk, id: chunk.parentId, chunkCount: 1 }], relationships: [], tags: [] };
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const requestedRoot = (req.query.projectRoot as string) || getProjectRoot();
    const relativePath = req.query.relativePath as string | undefined;
    if (!requestedRoot || !relativePath) return res.status(400).json({ error: 'projectRoot and relativePath are required' });
    const projectRoot = requestedRoot;
    const project = await getMultiProjectManager().getProject(projectRoot);
    const detail = project.getFileDetail(relativePath) ?? fallbackFileDetail(projectRoot, relativePath);
    if (!detail) return res.status(404).json({ error: 'file not found' });
    res.status(200).json(detail);
  } catch (e: unknown) {
    console.error('[api] kb/files/detail', e);
    res.status(500).json({ error: 'Internal server error' });
  }
}
