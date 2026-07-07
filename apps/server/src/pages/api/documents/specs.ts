import type { NextApiRequest, NextApiResponse } from 'next';
import { deleteDocumentGateType, deleteDocumentSpec, listDocumentGateTypes, listDocumentSpecs, saveDocumentGateType, saveDocumentSpec, type DocumentSpecGateType, type DocumentSpecPackage } from '@/services/documentSpecService';

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const mode = String(req.query.mode || 'spec');
    if (req.method === 'GET') return res.status(200).json({ specs: listDocumentSpecs(), gateTypes: listDocumentGateTypes() });
    if (req.method === 'POST' || req.method === 'PUT') {
      if (mode === 'gate-type') {
        const gateType = req.body as DocumentSpecGateType;
        if (!gateType?.id || !gateType.name) return res.status(400).json({ error: 'gate type id and name required' });
        return res.status(200).json({ gateType: saveDocumentGateType(gateType), gateTypes: listDocumentGateTypes(), specs: listDocumentSpecs() });
      }
      const spec = req.body as DocumentSpecPackage;
      if (!spec?.id || !spec.name) return res.status(400).json({ error: 'spec id and name required' });
      return res.status(200).json({ spec: saveDocumentSpec(spec), specs: listDocumentSpecs(), gateTypes: listDocumentGateTypes() });
    }
    if (req.method === 'DELETE') {
      const id = String(req.query.id || '');
      if (!id) return res.status(400).json({ error: 'id required' });
      if (mode === 'gate-type') {
        deleteDocumentGateType(id);
        return res.status(200).json({ success: true, specs: listDocumentSpecs(), gateTypes: listDocumentGateTypes() });
      }
      deleteDocumentSpec(id);
      return res.status(200).json({ success: true, specs: listDocumentSpecs(), gateTypes: listDocumentGateTypes() });
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e: unknown) {
    console.error('[api] documents/specs', e);
    res.status(500).json({ error: e instanceof Error ? e.message : 'Internal server error' });
  }
}
