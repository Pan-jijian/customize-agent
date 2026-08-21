import type { NextApiRequest, NextApiResponse } from 'next';
import { withApiErrorBoundary } from '@/services/common/apiErrorBoundary';
import { deleteGeneratedDocument, getGeneratedDocument, updateGeneratedDocument } from '@/services/document-core/generatedDocumentService';

export const config = {
  api: { bodyParser: { sizeLimit: '50mb' } },
};

function trimText(value: string | undefined, max = 1200) {
  if (!value || value.length <= max) return value;
  return `${value.slice(0, max)}...`;
}

function liteDocument(record: NonNullable<ReturnType<typeof getGeneratedDocument>>) {
  return {
    id: record.id,
    taskId: record.taskId,
    templateId: record.templateId,
    templateName: record.templateName,
    title: record.title,
    requirement: record.requirement,
    projectRoot: record.projectRoot,
    projectId: record.projectId,
    knowledgeBasePath: record.knowledgeBasePath,
    markdown: record.status === 'generating' ? '' : trimText(record.markdown, 2000) || '',
    status: record.status,
    draft: record.status === 'generating' ? undefined : record.draft,
    executionStages: record.executionStages?.map(stage => ({ ...stage, message: trimText(stage.message, 500), details: stage.details?.slice(0, 6).map(item => trimText(item, 300) || '') })),
    partialChapters: record.partialChapters,
    reviewMetadata: record.status === 'generating' ? record.reviewMetadata : undefined,
    agentWorkflow: record.agentWorkflow ? {
      runId: record.agentWorkflow.runId,
      materialScope: record.agentWorkflow.materialScope,
      materialSnapshot: {
        totalFiles: record.agentWorkflow.materialSnapshot.totalFiles,
        totalChunks: record.agentWorkflow.materialSnapshot.totalChunks,
        roots: record.agentWorkflow.materialSnapshot.roots,
        snapshotHash: record.agentWorkflow.materialSnapshot.snapshotHash,
      },
      nodes: record.agentWorkflow.nodes,
      issues: record.agentWorkflow.issues,
    } : undefined,
    assets: record.assets || [],
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    error: trimText(record.error),
    warningIssues: record.warningIssues?.slice(0, 8).map(item => trimText(item, 500) || ''),
  };
}

function generatedDocumentHandler(req: NextApiRequest, res: NextApiResponse) {
  const id = String(req.query.id || '');
  if (!id) return res.status(400).json({ error: 'id required' });
  const projectRoot = typeof req.query.projectRoot === 'string' ? req.query.projectRoot : undefined;
  if (req.method === 'GET') {
    const record = getGeneratedDocument(id, projectRoot);
    if (!record) return res.status(404).json({ error: 'Document not found' });
    if (req.query.lite === '1') return res.status(200).json({ document: liteDocument(record) });
    return res.status(200).json({ document: record });
  }
  if (req.method === 'PUT') {
    const record = updateGeneratedDocument(id, req.body || {}, projectRoot);
    if (!record) return res.status(404).json({ error: 'Document not found' });
    return res.status(200).json({ document: record });
  }
  if (req.method === 'DELETE') {
    deleteGeneratedDocument(id, projectRoot);
    return res.status(200).json({ ok: true });
  }
  return res.status(405).json({ error: 'Method not allowed' });
}

export default withApiErrorBoundary('api/documents/generated/[id]', generatedDocumentHandler);
