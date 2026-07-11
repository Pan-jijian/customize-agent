import type { NextApiRequest, NextApiResponse } from 'next';
import { getMultiProjectManager, getProjectRoot, listKnowledgeFiles } from '@/services/kbService';
import { upsertKbOperation } from '@/services/kbOperationLog';
import { withApiErrorBoundary } from '@/services/apiErrorBoundary';

async function kbFilesIndexHandler(req: NextApiRequest, res: NextApiResponse) {
  if (!['GET', 'DELETE', 'POST'].includes(req.method!)) return res.status(405).json({ error: 'Method not allowed' });
  const bodyProjectRoot = typeof req.body?.projectRoot === 'string' ? req.body.projectRoot : undefined;
  const projectRoot = (req.query.projectRoot as string) || bodyProjectRoot || getProjectRoot();
  if (!projectRoot) return res.status(200).json({ files: [], total: 0 });

  if (req.method === 'GET' && req.query.reindex !== '1') {
    const category = req.query.category as string | undefined;
    const page = parseInt((req.query.page as string) || '1', 10);
    const limit = parseInt((req.query.limit as string) || '50', 10);
    const files = listKnowledgeFiles(projectRoot, { category });
    const total = files.length;
    const paged = files.slice((page - 1) * limit, page * limit);
    return res.status(200).json({ files: paged, total, page, limit, vectorStatus: { enabled: false, dimension: 0, count: 0 }, initializing: false });
  }

  if (req.method === 'POST' && req.query.reindex !== '1') return res.status(400).json({ error: 'reindex=1 is required' });

  const project = await getMultiProjectManager().getProject(projectRoot);
  if (req.method === 'POST' || req.query.reindex === '1') await project.incrementalIndex();

  if (req.method === 'DELETE') {
    const { relativePath, relativePaths, folderPath, folderPaths, all } = req.body;
    const listedFiles = listKnowledgeFiles(projectRoot);
    const requestedFileTargets = all ? listedFiles.map(file => file.relativePath) : Array.isArray(relativePaths) ? relativePaths.map(String) : relativePath ? [String(relativePath)] : [];
    const requestedFolders = Array.isArray(folderPaths) ? folderPaths.map(String) : folderPath ? [String(folderPath)] : [];
    const folderTargets = requestedFolders.flatMap(folder => {
      const prefix = folder.replace(/^\/+|\/+$/gu, '');
      return listedFiles.filter(file => file.relativePath === prefix || file.relativePath.startsWith(`${prefix}/`)).map(file => file.relativePath);
    });
    const requestedTargets = Array.from(new Set([...requestedFileTargets, ...folderTargets]));
    if (requestedTargets.length === 0) return res.status(400).json({ error: 'relativePath, relativePaths or folderPaths is required' });
    const targets = requestedTargets;
    const operationId = `delete-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const title = all ? `删除全部用户文件 ${targets.length} 个` : targets.length === 1 ? `删除 ${targets[0]}` : `批量删除 ${targets.length} 个文件`;
    upsertKbOperation(projectRoot, { id: operationId, type: 'delete', title, stage: 'uploading', status: 'processing', percent: 10, message: '正在删除文件和索引', filePath: targets[0], fileName: targets[0]?.split('/').pop() });
    let deleted = 0;
    for (const target of targets) {
      await project.removeFile(target);
      deleted++;
      upsertKbOperation(projectRoot, { id: operationId, type: 'delete', title, stage: 'uploading', status: 'processing', percent: Math.min(95, Math.round((deleted / targets.length) * 90)), message: `已删除 ${deleted}/${targets.length}`, filePath: target, fileName: target.split('/').pop() });
    }
    upsertKbOperation(projectRoot, { id: operationId, type: 'delete', title, stage: 'done', status: 'success', percent: 100, message: `已删除 ${deleted} 个文件和索引`, filePath: targets[0], fileName: targets[0]?.split('/').pop() });
    return res.status(200).json({ success: true, deleted });
  }

  const category = req.query.category as string | undefined;
  const page = parseInt((req.query.page as string) || '1', 10);
  const limit = parseInt((req.query.limit as string) || '50', 10);
  const files = listKnowledgeFiles(projectRoot, { category });
  const vectorStatus = project.getVectorStatus();
  const total = files.length;
  const paged = files.slice((page - 1) * limit, page * limit);
  return res.status(200).json({ files: paged, total, page, limit, vectorStatus });
}

const kbFilesIndexApiHandler = withApiErrorBoundary('api/kb/files', kbFilesIndexHandler);

export default async function kbFilesIndexApi(req: NextApiRequest, res: NextApiResponse) {
  return kbFilesIndexApiHandler(req, res);
}
