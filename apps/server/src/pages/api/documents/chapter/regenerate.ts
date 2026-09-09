import type { NextApiRequest, NextApiResponse } from 'next';
import { regenerateDocumentChapter } from '@/services/document-workflow';

/**
 * 文档章节重新生成 API 处理器（@deprecated 第 1 期 P20）
 * 服务函数无 LLM（仅检索拼证据），与主生成管线口径不一致；前端零调用，
 * 保留仅作历史 API 兼容——响应携带 Deprecation 头告知调用方迁移。
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // 仅允许 POST 请求
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { templateId, chapterId, requirement, maxEvidencePerChapter, projectRoot, documentId, currentMarkdown, existingFacts } = req.body as { templateId?: string; chapterId?: string; requirement?: string; maxEvidencePerChapter?: number; projectRoot?: string; documentId?: string; currentMarkdown?: string; existingFacts?: string[] };
    // 校验必填参数
    if (!templateId || !chapterId) return res.status(400).json({ error: 'templateId and chapterId required' });
    const chapter = await regenerateDocumentChapter({ templateId, chapterId, requirement, maxEvidencePerChapter, projectRoot, documentId, currentMarkdown, existingFacts });
    res.setHeader('Deprecation', 'true');
    res.setHeader('Sunset', 'Mon, 31 Dec 2029 23:59:59 GMT');
    res.status(200).json({ chapter, deprecated: true });
  } catch (e: unknown) {
    console.error('[api] documents/chapter/regenerate', e);
    res.status(500).json({ error: e instanceof Error ? e.message : 'Internal server error' });
  }
}
