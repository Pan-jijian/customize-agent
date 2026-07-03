import { spawn } from 'child_process';
import { platform } from 'os';
import type { NextApiRequest, NextApiResponse } from 'next';
import { getMultiProjectManager, getProjectRoot } from '@/services/kbService';

function openPath(targetPath: string) {
  const os = platform();
  if (os === 'darwin') return spawn('open', [targetPath], { detached: true, stdio: 'ignore' });
  if (os === 'win32') return spawn('cmd', ['/c', 'start', '', targetPath], { detached: true, stdio: 'ignore', windowsHide: true });
  return spawn('xdg-open', [targetPath], { detached: true, stdio: 'ignore' });
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
  try {
    const projectRoot = (req.body?.projectRoot as string) || getProjectRoot();
    const relativePath = req.body?.relativePath as string | undefined;
    const target = req.body?.target as 'file' | 'directory' | undefined;
    if (!projectRoot || !relativePath || !target) return res.status(400).json({ error: 'projectRoot, relativePath and target are required' });

    const project = await getMultiProjectManager().getProject(projectRoot);
    const detail = project.getFileDetail(relativePath);
    if (!detail) return res.status(404).json({ error: 'file not found' });

    const targetPath = target === 'directory' ? detail.directory : detail.absolutePath;
    if (!targetPath) return res.status(404).json({ error: 'target path not found' });

    openPath(targetPath).unref();
    res.status(200).json({ success: true });
  } catch (e: unknown) {
    console.error('[api] kb/files/open', e);
    res.status(500).json({ error: 'Internal server error' });
  }
}
