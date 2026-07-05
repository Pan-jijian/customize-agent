import type { NextApiRequest, NextApiResponse } from 'next';
import { deleteDocumentSpec, listDocumentSpecs, saveDocumentSpec, type DocumentSpecPackage } from '@/services/documentSpecService';

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (req.method === 'GET') return res.status(200).json({ specs: listDocumentSpecs() });
    if (req.method === 'POST' || req.method === 'PUT') {
      const spec = req.body as DocumentSpecPackage;
      if (!spec?.id || !spec.name) return res.status(400).json({ error: 'spec id and name required' });
      return res.status(200).json({ spec: saveDocumentSpec(spec), specs: listDocumentSpecs() });
    }
    if (req.method === 'DELETE') {
      const id = String(req.query.id || '');
      if (!id) return res.status(400).json({ error: 'id required' });
      deleteDocumentSpec(id);
      return res.status(200).json({ success: true, specs: listDocumentSpecs() });
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e: unknown) {
    console.error('[api] documents/specs', e);
    res.status(500).json({ error: e instanceof Error ? e.message : 'Internal server error' });
  }
}
