import type { NextApiRequest, NextApiResponse } from 'next';
import { getMultiProjectManager, getProjectRoot } from '@/services/kbService';
import { upsertKbOperation } from '@/services/kbOperationLog';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!['GET', 'DELETE'].includes(req.method!)) return res.status(405).json({ error: 'Method not allowed' });
  try {
    const bodyProjectRoot = typeof req.body?.projectRoot === 'string' ? req.body.projectRoot : undefined;
    const projectRoot = (req.query.projectRoot as string) || bodyProjectRoot || getProjectRoot();
    if (!projectRoot) return res.status(200).json({ files: [], total: 0 });
    const project = await getMultiProjectManager().getProject(projectRoot);

    if (req.method === 'DELETE') {
      const { relativePath } = req.body;
      if (!relativePath) return res.status(400).json({ error: 'relativePath is required' });
      const operationId = `delete-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      upsertKbOperation(projectRoot, { id: operationId, type: 'delete', title: `删除 ${relativePath}`, stage: 'uploading', status: 'processing', percent: 10, message: '正在删除文件和索引', filePath: relativePath, fileName: String(relativePath).split('/').pop() });
      await project.removeFile(relativePath);
      upsertKbOperation(projectRoot, { id: operationId, type: 'delete', title: `删除 ${relativePath}`, stage: 'done', status: 'success', percent: 100, message: '文件和索引已删除', filePath: relativePath, fileName: String(relativePath).split('/').pop() });
      return res.status(200).json({ success: true });
    }

    const category = req.query.category as string | undefined;
    const page = parseInt((req.query.page as string) || '1', 10);
    const limit = parseInt((req.query.limit as string) || '50', 10);
    let files = project.listFiles();
    if (category) files = files.filter((f: { category: string }) => f.category === category);
    const vectorStatus = project.getVectorStatus();
    const total = files.length;
    const paged = files.slice((page - 1) * limit, page * limit);
    res.status(200).json({ files: paged, total, page, limit, vectorStatus });
  } catch (e: unknown) { console.error('[api] kb/files/index', e); res.status(500).json({ error: 'Internal server error' }); }
}
