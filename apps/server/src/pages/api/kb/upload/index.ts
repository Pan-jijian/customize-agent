import type { NextApiRequest, NextApiResponse } from 'next';
import { getMultiProjectManager, getProjectRoot } from '@/services/kbService';

export const config = {
  api: { bodyParser: { sizeLimit: '500mb' }, responseLimit: '500mb' },
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const { fileName, fileData } = req.body;
    if (!fileName || !fileData) return res.status(400).json({ error: 'fileName and fileData required' });
    const projectRoot = req.body.projectRoot || getProjectRoot();
    if (!projectRoot) return res.status(400).json({ error: 'Project root is required' });
    const buffer = Buffer.from(fileData, 'base64');
    const project = await getMultiProjectManager().getProject(projectRoot);
    const uploadedRelativePath = project.getUploadRelativePath(fileName);
    const diff = await project.uploadFile(fileName, buffer, uploadedRelativePath);
    const files = project.listFiles();
    const uploaded = files.find(file => file.relativePath === uploadedRelativePath);
    res.status(200).json({
      success: true,
      relativePath: uploaded?.relativePath ?? uploadedRelativePath,
      added: diff.newFiles.length,
      total: files.length,
      files,
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
}
