import type { NextApiRequest, NextApiResponse } from 'next';
import { regenerateDocumentChapter } from '@/services/documentWorkflowService';

/**
 * 文档章节重新生成 API 处理器
 * 用于重新生成文档的特定章节，支持传入额外需求、现有事实和当前 Markdown
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // 仅允许 POST 请求
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { templateId, chapterId, requirement, maxEvidencePerChapter, projectRoot, documentId, currentMarkdown, existingFacts } = req.body as { templateId?: string; chapterId?: string; requirement?: string; maxEvidencePerChapter?: number; projectRoot?: string; documentId?: string; currentMarkdown?: string; existingFacts?: string[] };
    // 校验必填参数
    if (!templateId || !chapterId) return res.status(400).json({ error: 'templateId and chapterId required' });
    const chapter = await regenerateDocumentChapter({ templateId, chapterId, requirement, maxEvidencePerChapter, projectRoot, documentId, currentMarkdown, existingFacts });
    res.status(200).json({ chapter });
  } catch (e: unknown) {
    console.error('[api] documents/chapter/regenerate', e);
    res.status(500).json({ error: e instanceof Error ? e.message : 'Internal server error' });
  }
}
