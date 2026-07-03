import type { NextApiRequest, NextApiResponse } from 'next';
import { getMultiProjectManager, getProjectRoot } from '@/services/kbService';

export const config = { api: { responseLimit: false } };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const projectRoot = (req.query.projectRoot as string) || getProjectRoot();
    const relativePath = req.query.relativePath as string | undefined;
    const page = Math.max(1, Number(req.query.page ?? 1));
    if (!projectRoot || !relativePath) return res.status(400).json({ error: 'projectRoot and relativePath are required' });
    const project = await getMultiProjectManager().getProject(projectRoot);
    const detail = project.getFileDetail(relativePath);
    if (!detail?.absolutePath || detail.file.format !== 'pdf') return res.status(404).json({ error: 'pdf not found' });

    const [{ createCanvas }, pdfjs] = await Promise.all([
      import('@napi-rs/canvas'),
      import('pdfjs-dist/legacy/build/pdf.mjs'),
    ]);
    const fs = await import('node:fs');
    const bytes = new Uint8Array(fs.readFileSync(detail.absolutePath));
    const doc = await pdfjs.getDocument({ data: bytes }).promise;
    const pdfPage = await doc.getPage(Math.min(page, doc.numPages));
    const viewport = pdfPage.getViewport({ scale: 1.6 });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    await pdfPage.render({ canvasContext: canvas.getContext('2d'), viewport } as any).promise;
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.status(200).send(canvas.toBuffer('image/png'));
  } catch (e: unknown) {
    console.error('[api] kb/files/preview-pdf-page', e);
    res.status(500).json({ error: 'Internal server error' });
  }
}
