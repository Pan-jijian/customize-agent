import { spawn } from 'node:child_process';
import { platform } from 'node:os';
import type { NextApiRequest, NextApiResponse } from 'next';
import { deleteGeneratedAsset, indexGeneratedAsset, listGeneratedAssets, openGeneratedAssetTarget } from '@/services/generatedDocumentService';

/** 根据操作系统调用系统命令打开文件或目录 */
function openPath(targetPath: string) {
  const os = platform();
  if (os === 'darwin') return spawn('open', [targetPath], { detached: true, stdio: 'ignore' });
  if (os === 'win32') return spawn('cmd', ['/c', 'start', '', targetPath], { detached: true, stdio: 'ignore', windowsHide: true });
  return spawn('xdg-open', [targetPath], { detached: true, stdio: 'ignore' });
}

/** 生成资产 API：GET 列表，DELETE 删除，POST 支持索引和打开操作 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const queryProjectRoot = typeof req.query.projectRoot === 'string' ? req.query.projectRoot : undefined;
    const bodyProjectRoot = typeof req.body?.projectRoot === 'string' ? req.body.projectRoot : undefined;
    const projectRoot = queryProjectRoot || bodyProjectRoot;
    if (req.method === 'GET') return res.status(200).json({ assets: listGeneratedAssets(projectRoot) });
    if (req.method === 'DELETE') {
      const id = typeof req.query.id === 'string' ? req.query.id : req.body?.id;
      if (!id) return res.status(400).json({ error: 'id required' });
      deleteGeneratedAsset(id, projectRoot);
      return res.status(200).json({ ok: true, assets: listGeneratedAssets(projectRoot) });
    }
    if (req.method === 'POST') {
      const { id, action, target = 'file' } = req.body as { id?: string; action?: 'index' | 'open'; target?: 'file' | 'directory' };
      if (!id || !action) return res.status(400).json({ error: 'id and action required' });
      if (action === 'index') {
        const asset = await indexGeneratedAsset(id, projectRoot);
        if (!asset) return res.status(404).json({ error: 'asset not found' });
        return res.status(200).json({ asset, assets: listGeneratedAssets(projectRoot) });
      }
      if (action === 'open') {
        const targetPath = openGeneratedAssetTarget(id, target, projectRoot);
        if (!targetPath) return res.status(404).json({ error: 'asset file not found' });
        openPath(targetPath).unref();
        return res.status(200).json({ ok: true });
      }
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e: unknown) {
    console.error('[api] assets/generated', e);
    res.status(500).json({ error: e instanceof Error ? e.message : 'Internal server error' });
  }
}
