import type { NextApiRequest, NextApiResponse } from 'next';
import { getConfigStore } from '@/services/configService';

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const store = getConfigStore();
    if (req.method === 'PUT') {
      const models = req.body;
      for (const tier of ['reader', 'reasoning', 'action'] as const) {
        const tc = models[tier];
        if (!tc) continue;
        if (tc.active) store.setActiveModel(tier, tc.active);
        if (Array.isArray(tc.list)) {
          const current = store.getTier(tier);
          for (const e of current.list) { if (!tc.list.some((m: any) => m.name === e.name)) store.removeModel(tier, e.name); }
          for (const entry of tc.list) { if (entry.name && entry.provider) store.addModel(tier, entry); }
        }
      }
      return res.status(200).json({ success: true });
    }
    res.status(200).json(store.load().models);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
}
