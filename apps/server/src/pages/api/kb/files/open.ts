import { spawn } from 'child_process';
import { platform } from 'os';
import * as fs from 'fs';
import * as path from 'path';
import type { NextApiRequest, NextApiResponse } from 'next';
import { getMultiProjectManager, getProjectRoot } from '@/services/kbService';

/** 根据操作系统调用系统命令打开文件或目录 */
function openPath(targetPath: string) {
  const os = platform();
  if (os === 'darwin') return spawn('open', [targetPath], { detached: true, stdio: 'ignore' });
  if (os === 'win32') return spawn('cmd', ['/c', 'start', '', targetPath], { detached: true, stdio: 'ignore', windowsHide: true });
  return spawn('xdg-open', [targetPath], { detached: true, stdio: 'ignore' });
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
  try {
    const requestedRoot = (req.body?.projectRoot as string) || getProjectRoot();
    const relativePath = req.body?.relativePath as string | undefined;
    const target = req.body?.target as 'file' | 'directory' | undefined;
    if (!requestedRoot || !relativePath || !target) return res.status(400).json({ error: 'projectRoot, relativePath and target are required' });

    const projectRoot = requestedRoot;
    const project = await getMultiProjectManager().getProject(projectRoot);
    const detail = project.getFileDetail(relativePath);
    const fallbackPath = path.join(projectRoot, 'knowledgeBase', relativePath);
    const targetPath = detail
      ? target === 'directory' ? detail.directory : detail.absolutePath
      : fs.existsSync(fallbackPath) ? target === 'directory' ? path.dirname(fallbackPath) : fallbackPath : undefined;
    if (!targetPath) return res.status(404).json({ error: 'target path not found' });

    openPath(targetPath).unref();
    res.status(200).json({ success: true });
  } catch (e: unknown) {
    console.error('[api] kb/files/open', e);
    res.status(500).json({ error: 'Internal server error' });
  }
}
