import type { NextApiRequest, NextApiResponse } from 'next';
import { getProjectRoot, listKnowledgeFiles } from '@/services/knowledge/kbService';
import { withApiErrorBoundary } from '@/services/common/apiErrorBoundary';

interface TreeApiResponseNode {
  key: string;
  title: string;
  isFolder: boolean;
  isLeaf: boolean;
  fileCount?: number;
}

async function kbFilesTreeHandler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  
  const projectRoot = (req.query.projectRoot as string) || getProjectRoot();
  if (!projectRoot) return res.status(200).json({ nodes: [] });

  const parentPath = String(req.query.parentPath || '').replace(/^\/+|\/+$/gu, '');
  const allFiles = listKnowledgeFiles(projectRoot);
  const nodesMap = new Map<string, TreeApiResponseNode>();
  
  for (const file of allFiles) {
    if (parentPath && file.relativePath !== parentPath && !file.relativePath.startsWith(`${parentPath}/`)) continue;
    const relativeToParent = parentPath ? file.relativePath.slice(parentPath.length).replace(/^\//u, '') : file.relativePath;
    if (!relativeToParent) continue;
    const [name, ...rest] = relativeToParent.split('/');
    if (!name) continue;
    const isFolder = rest.length > 0;
    const key = parentPath ? `${parentPath}/${name}` : name;
    const existing = nodesMap.get(key);
    if (!existing) {
      nodesMap.set(key, { key, title: name, isFolder, isLeaf: !isFolder, fileCount: isFolder ? 1 : undefined });
    } else if (isFolder) {
      existing.fileCount = (existing.fileCount || 0) + 1;
    }
  }

  const nodes = Array.from(nodesMap.values()).sort((a, b) => {
    if (a.isFolder && !b.isFolder) return -1;
    if (!a.isFolder && b.isFolder) return 1;
    return a.title.localeCompare(b.title, 'zh-CN');
  });

  return res.status(200).json({ nodes });
}

export default withApiErrorBoundary('api/kb/files/tree', kbFilesTreeHandler);