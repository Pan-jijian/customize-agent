/** 封装的 JSON 请求函数，自动将非 2xx 响应解析为错误信息并抛出 */
async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, options);
  if (!res.ok) {
    const body = await res.text();
    let message = body || `HTTP ${res.status}`;
    try {
      const parsed = JSON.parse(body) as { error?: string; message?: string };
      message = parsed.error || parsed.message || message;
    } catch { /* 保留原始响应体 */ }
    throw new Error(message);
  }
  return res.json();
}

// ═══════ 知识库 ═══════

export interface KbVectorStatus { status: string; error?: string; indexedChunks: number; lastIndexedAt: number; backend: string; }
export interface KbStats { scope: string; projectId?: string; fileCount: number; chunkCount: number; totalSizeBytes: number; lastIndexedAt: number; vectorStatus?: KbVectorStatus; }
export interface KbFileItem { relativePath: string; category: string; format: string; fileSize: number; mtime: number; chunkCount: number; indexedAt: number; status: string; errorMessage?: string; metadataJson?: string; matchedBy?: 'path' | 'metadata' | 'content' | 'disk'; score?: number; }
export interface KbFeatures { vectorStore: string; embeddingProvider: string; externalExtractors: string[]; dedupEngine: string; chunker: string; }
export interface KbUploadProgress { id: string; stage: string; percent: number; message: string; fileName?: string; chunkCount?: number; vectorStatus?: KbVectorStatus; error?: string; updatedAt: number; }
export interface KbOperationRecord { id: string; type: 'upload' | 'delete' | 'reindex'; stage: string; status: 'processing' | 'success' | 'warning' | 'error'; title: string; message: string; percent: number; fileName?: string; filePath?: string; chunkCount?: number; textLength?: number; extractionMode?: string; error?: string; createdAt: number; updatedAt: number; }
export interface KbStoredChunk { id: string; relativePath: string; chunkIndex: number; content: string; category: string; format: string; tokenCount: number; sectionTitle?: string; metadataJson?: string; createdAt: number; }
export interface KbParentChunk { id: string; relativePath: string; parentId: string; content: string; category: string; format: string; sectionTitle?: string; chunkCount: number; metadataJson?: string; createdAt: number; }
export interface KbFileDetail { file: KbFileItem; absolutePath?: string; directory?: string; chunks: KbStoredChunk[]; parents: KbParentChunk[]; relationships: unknown[]; tags: Array<{ filePath: string; tag: string; createdAt: number }>; }

export async function getKbStats(projectRoot?: string) {
  const p = projectRoot ? `?projectRoot=${encodeURIComponent(projectRoot)}` : '';
  return fetchJson<KbStats>(`/api/kb/stats${p}`);
}

export async function getKbFiles(opts?: { projectRoot?: string; category?: string; page?: number; limit?: number }) {
  const params = new URLSearchParams();
  if (opts?.projectRoot) params.set('projectRoot', opts.projectRoot);
  if (opts?.category) params.set('category', opts.category);
  if (opts?.page) params.set('page', String(opts.page ?? 1));
  if (opts?.limit) params.set('limit', String(opts.limit ?? 50));
  return fetchJson<{ files: KbFileItem[]; total: number; vectorStatus?: KbVectorStatus; initializing?: boolean }>(`/api/kb/files?${params}`);
}

export async function searchKbFiles(opts?: { query?: string; projectRoot?: string; category?: string; limit?: number; includeContent?: boolean }) {
  const params = new URLSearchParams();
  if (opts?.query) params.set('q', opts.query);
  if (opts?.projectRoot) params.set('projectRoot', opts.projectRoot);
  if (opts?.category) params.set('category', opts.category);
  if (opts?.limit) params.set('limit', String(opts.limit));
  if (opts?.includeContent === false) params.set('includeContent', '0');
  return fetchJson<{ files: KbFileItem[]; total: number }>(`/api/kb/files/search?${params}`);
}

export async function getKbFileDetail(relativePath: string, projectRoot?: string) {
  const params = new URLSearchParams({ relativePath });
  if (projectRoot) params.set('projectRoot', projectRoot);
  return fetchJson<KbFileDetail>(`/api/kb/files/detail?${params}`);
}

export async function reindexKbFile(relativePath: string, projectRoot?: string) {
  return fetchJson<{ success: boolean; accepted?: boolean; alreadyRunning?: boolean; operationId?: string; job?: KbOperationRecord; detail?: KbFileDetail }>('/api/kb/files/reindex', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ relativePath, projectRoot }),
  });
}

export async function openKbFileTarget(relativePath: string, target: 'file' | 'directory', projectRoot?: string) {
  return fetchJson<{ success: boolean }>('/api/kb/files/open', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ relativePath, target, projectRoot }),
  });
}

export interface KbUploadBatchResult { success: boolean; accepted?: boolean; operationId?: string; relativePath?: string; jobs?: Array<{ id: string; relativePath: string; status: string }>; batchIndex?: number; totalBatches?: number; indexingStarted?: boolean; }

function fileRelativePath(file: File) {
  return (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
}

function appendUploadForm(files: File[], opts: { projectRoot?: string; uploadId?: string; batchIndex: number; totalBatches: number; fileOffset: number; startIndex: boolean }) {
  const form = new FormData();
  if (opts.projectRoot) form.append('projectRoot', opts.projectRoot);
  if (opts.uploadId) form.append('uploadId', opts.uploadId);
  form.append('batchIndex', String(opts.batchIndex));
  form.append('totalBatches', String(opts.totalBatches));
  form.append('fileOffset', String(opts.fileOffset));
  form.append('startIndex', opts.startIndex ? '1' : '0');
  form.append('uploadComplete', opts.batchIndex === opts.totalBatches - 1 ? '1' : '0');
  for (const file of files) {
    form.append('files', file, file.name);
    form.append('relativePaths', fileRelativePath(file));
  }
  return form;
}

export async function uploadKbFile(file: File, projectRoot?: string, uploadId?: string) {
  return fetchJson<KbUploadBatchResult>('/api/kb/upload', {
    method: 'POST',
    body: appendUploadForm([file], { projectRoot, uploadId, batchIndex: 0, totalBatches: 1, fileOffset: 0, startIndex: true }),
  });
}

export async function uploadKbFiles(files: File[], projectRoot?: string, uploadId?: string, onBatchProgress?: (progress: { uploadedFiles: number; totalFiles: number; batchIndex: number; totalBatches: number }) => void) {
  const maxFilesPerBatch = Number(process.env.NEXT_PUBLIC_CUSTOMIZE_KB_UPLOAD_BATCH_FILES || 1000);
  const maxBytesPerBatch = Number(process.env.NEXT_PUBLIC_CUSTOMIZE_KB_UPLOAD_BATCH_BYTES || 1024 * 1024 * 1024);
  const batches: File[][] = [];
  let current: File[] = [];
  let currentBytes = 0;
  for (const file of files) {
    if (current.length > 0 && (current.length >= maxFilesPerBatch || currentBytes + file.size > maxBytesPerBatch)) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(file);
    currentBytes += file.size;
  }
  if (current.length > 0) batches.push(current);

  const results: KbUploadBatchResult[] = [];
  let uploadedFiles = 0;
  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const batch = batches[batchIndex]!;
    const result = await fetchJson<KbUploadBatchResult>('/api/kb/upload', {
      method: 'POST',
      body: appendUploadForm(batch, {
        projectRoot,
        uploadId,
        batchIndex,
        totalBatches: batches.length,
        fileOffset: uploadedFiles,
        startIndex: batchIndex === 0,
      }),
    });
    results.push(result);
    uploadedFiles += batch.length;
    onBatchProgress?.({ uploadedFiles, totalFiles: files.length, batchIndex, totalBatches: batches.length });
  }
  return results[results.length - 1] ?? { success: true };
}

export async function getKbUploadProgress(uploadId: string) {
  return fetchJson<KbUploadProgress>(`/api/kb/upload/progress?id=${encodeURIComponent(uploadId)}`);
}

export async function getKbOperations(projectRoot?: string) {
  const params = new URLSearchParams({ limit: '50' });
  if (projectRoot) params.set('projectRoot', projectRoot);
  return fetchJson<{ operations: KbOperationRecord[] }>(`/api/kb/operations?${params}`);
}

export async function getJobs(opts?: { projectRoot?: string; active?: boolean; limit?: number }) {
  const params = new URLSearchParams({ limit: String(opts?.limit ?? 50) });
  if (opts?.projectRoot) params.set('projectRoot', opts.projectRoot);
  if (opts?.active) params.set('active', '1');
  return fetchJson<{ jobs: KbOperationRecord[] }>(`/api/jobs?${params}`);
}

export async function getJob(id: string, projectRoot?: string) {
  const params = new URLSearchParams();
  if (projectRoot) params.set('projectRoot', projectRoot);
  return fetchJson<{ job: KbOperationRecord }>(`/api/jobs/${encodeURIComponent(id)}?${params}`);
}

export async function clearKbOperations(projectRoot?: string) {
  const params = new URLSearchParams();
  if (projectRoot) params.set('projectRoot', projectRoot);
  return fetchJson<{ success: boolean; deleted: number }>(`/api/kb/operations?${params}`, { method: 'DELETE' });
}

export async function deleteKbOperation(id: string, projectRoot?: string) {
  const params = new URLSearchParams({ id });
  if (projectRoot) params.set('projectRoot', projectRoot);
  return fetchJson<{ success: boolean; deleted: number }>(`/api/kb/operations?${params}`, { method: 'DELETE' });
}

export async function deleteKbFile(relativePath: string, projectRoot?: string) {
  return fetchJson<{ success: boolean; deleted?: number }>('/api/kb/files', {
    method: 'DELETE', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ relativePath, projectRoot }),
  });
}

export async function deleteKbFiles(relativePaths: string[], projectRoot?: string) {
  return fetchJson<{ success: boolean; deleted?: number }>('/api/kb/files', {
    method: 'DELETE', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ relativePaths, projectRoot }),
  });
}

export async function deleteKbFolders(folderPaths: string[], projectRoot?: string) {
  return fetchJson<{ success: boolean; deleted?: number }>('/api/kb/files', {
    method: 'DELETE', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folderPaths, projectRoot }),
  });
}

export async function deleteKbSelection(relativePaths: string[], folderPaths: string[], projectRoot?: string) {
  return fetchJson<{ success: boolean; deleted?: number }>('/api/kb/files', {
    method: 'DELETE', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ relativePaths, folderPaths, projectRoot }),
  });
}

export async function deleteAllKbFiles(projectRoot?: string) {
  return fetchJson<{ success: boolean; deleted?: number }>('/api/kb/files', {
    method: 'DELETE', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ all: true, projectRoot }),
  });
}

export async function reindexKb(projectRoot?: string) {
  return fetchJson<{ success: boolean; accepted?: boolean; alreadyRunning?: boolean; operationId?: string; job?: KbOperationRecord; stats?: KbStats }>('/api/kb/reindex', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectRoot }),
  });
}

export async function getReindexStatus(projectRoot?: string) {
  const params = new URLSearchParams();
  if (projectRoot) params.set('projectRoot', projectRoot);
  return fetchJson<{ running: boolean; active?: { operationId: string; startedAt: number }; job: KbOperationRecord | null }>(`/api/kb/reindex?${params}`);
}

export async function getKbTags(projectRoot?: string) {
  const p = projectRoot ? `?projectRoot=${encodeURIComponent(projectRoot)}` : '';
  return fetchJson<string[]>(`/api/kb/tags${p}`);
}

export async function getKbIgnoreRules(projectRoot?: string) {
  const p = projectRoot ? `?projectRoot=${encodeURIComponent(projectRoot)}` : '';
  return fetchJson<string[]>(`/api/kb/ignore${p}`);
}

export async function saveKbIgnoreRules(rules: string[], projectRoot?: string) {
  return fetchJson<{ success: boolean }>('/api/kb/ignore', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rules, projectRoot }),
  });
}

export async function getKbDuplicates(projectRoot?: string) {
  const p = projectRoot ? `?projectRoot=${encodeURIComponent(projectRoot)}` : '';
  return fetchJson(`/api/kb/duplicates${p}`);
}

export async function getKbFeatures() {
  return fetchJson<KbFeatures>('/api/kb/features');
}

export interface KbSearchResult {
  id: string;
  content: string;
  filePath: string;
  scope: 'project' | 'global';
  collection: string;
  score: number;
  chunkIndex?: number;
  parentId?: string;
  source?: 'keyword' | 'vector' | 'hybrid';
  sectionTitle?: string;
  rowRange?: string;
  chunkKind?: string;
  scoreDetails?: { keywordScore?: number; bm25Score?: number; vectorScore?: number; hybridScore?: number; exactPhraseBoost?: number; rerankBoost?: number };
  facets?: Record<string, string | number | string[]>;
}

export async function searchKb(query: string, opts?: { projectRoot?: string; category?: string; limit?: number; weights?: { keyword?: number; vector?: number; rewrite?: number; hybridBonus?: number } }) {
  const params = new URLSearchParams({ q: query });
  if (opts?.projectRoot) params.set('projectRoot', opts.projectRoot);
  if (opts?.category) params.set('category', opts.category);
  if (opts?.limit) params.set('limit', String(opts.limit ?? 20));
  if (opts?.weights?.keyword != null) params.set('keywordWeight', String(opts.weights.keyword));
  if (opts?.weights?.vector != null) params.set('vectorWeight', String(opts.weights.vector));
  if (opts?.weights?.rewrite != null) params.set('rewriteWeight', String(opts.weights.rewrite));
  if (opts?.weights?.hybridBonus != null) params.set('hybridBonus', String(opts.weights.hybridBonus));
  return fetchJson<{ results: KbSearchResult[]; total: number; queryTimeMs?: number; debug?: { originalQuery?: string; rewrittenQueries?: string[]; weights?: Record<string, number>; recallCounts?: Record<string, number>; reranker?: string } }>(`/api/kb/search?${params}`);
}

// ═══════ 文档工作台 ═══════

export interface DocumentTemplateChapter { id: string; title: string; purpose: string; queries: string[]; requiredFacts: string[]; sections?: string[]; tableSections?: string[]; tableRequirements?: string[]; pinnedEvidenceFilePaths?: string[]; }
export interface PromptBinding { promptId: string; roleId: string; }
export interface FileBinding { filePath: string; roleId: string; }
export type PromptExecutionType = 'fact_extraction' | 'chapter_generation' | 'llm_review' | 'validation' | 'formatting' | 'reference';
export type FileProcessingType = 'rule' | 'project_fact' | 'table' | 'drawing' | 'specification' | 'reference';
export interface DocumentRole { id: string; name: string; description: string; type: 'file' | 'prompt'; resourceId?: string; resourceIds?: string[]; builtIn?: boolean; executionType?: PromptExecutionType; processingType?: FileProcessingType; }
export interface ProjectRoleItem { roleId: string; order: number; }
export interface ProjectRoleConfig { id: string; name: string; description: string; fileRoles: ProjectRoleItem[]; promptRoles: ProjectRoleItem[]; builtIn?: boolean; }
export interface DocumentExportSettings { page?: { paper?: string; marginTop?: string; marginRight?: string; marginBottom?: string; marginLeft?: string }; typography?: { fontFamily?: string; lineHeight?: string; titleSize?: string; bodySize?: string }; targetPages?: { min?: number; target?: number; max?: number }; }
export interface DocumentGenerationSettings { targetPages?: { min?: number; target?: number; max?: number }; }
export interface DocumentTemplate { id: string; name: string; description: string; category: string; outputTitle: string; chapters: DocumentTemplateChapter[]; exportSettings?: DocumentExportSettings; generationSettings?: DocumentGenerationSettings; projectRoleConfigId?: string; promptIds?: string[]; boundFilePaths?: string[]; promptBindings?: PromptBinding[]; fileBindings?: FileBinding[]; builtIn?: boolean; }
export interface DocumentTemplateValidation { templateId: string; fileDiagnostics: Array<FileBinding & { roleName?: string; exists: boolean; indexed: boolean; chunkCount: number; vectorReady: boolean }>; promptDiagnostics: Array<PromptBinding & { roleName?: string; promptTitle?: string; exists: boolean; contentLength: number }>; issues: Array<{ level: 'error' | 'warning'; message: string }> }
export interface PromptProject { id: string; projectId: string; projectRoot?: string; projectName: string; customizePath: string; content: string; mtime: string; hasFile: boolean; isCurrent: boolean; selected: boolean; source: 'current' | 'project' | 'custom'; }
export interface DocumentEvidence { chapterId: string; filePath: string; score: number; content: string; roleId?: string; processingType?: string; sectionTitle?: string; source?: string; }
export interface DocumentDraftChapter { id: string; title: string; content: string; evidence: DocumentEvidence[]; missingFacts: string[]; sections?: string[]; }
export interface FactSourceRef { filePath: string; roleId: string; processingType?: string; sectionTitle?: string; chunkIndex?: number; cellRange?: string; }
export interface DocumentFact { key: string; value: string; sourceFile: string; roleId: string; processingType?: string; confidence: number; fieldId?: string; fieldName?: string; sourceRef?: FactSourceRef; }
export interface StructuredTableFact { tableType: string; sheet?: string; headers: string[]; rows: string[][]; sourceFile: string; sourceRange?: string; }
export interface DocumentFactsModel { project: DocumentFact[]; schedule: DocumentFact[]; quality: DocumentFact[]; safety: DocumentFact[]; resources: DocumentFact[]; tables: StructuredTableFact[]; drawings: DocumentFact[]; rules: DocumentFact[]; specifications: DocumentFact[]; schemaFacts: Record<string, DocumentFact[]>; missing: string[]; conflicts: string[]; }
export interface ValidationIssue { level: 'error' | 'warning' | 'info'; message: string; source?: string; suggestion?: string; }
export interface ExportGateResult { passed: boolean; blockingIssues: ValidationIssue[]; checklist: Array<{ key: string; label: string; passed: boolean; message?: string }>; }
export interface DocumentExecutionStage { type: 'role_binding' | 'knowledge_retrieval' | 'context_recall' | 'file_understanding' | 'fact_extraction' | 'chapter_generation' | 'asset_generation' | 'llm_review' | 'validation' | 'formatting' | 'export_ready' | 'reference'; roleId: string; promptId?: string; status: 'success' | 'fallback' | 'skipped' | 'failed'; message?: string; title?: string; subtitle?: string; roleName?: string; promptName?: string; group?: string; order?: number; executionVersion?: 2; }
export interface DocumentAsset { id: string; type: 'image' | 'audio' | 'video' | 'file'; role: 'cover' | 'reference' | 'generated' | 'attachment' | 'map' | 'operator'; path?: string; url?: string; prompt?: string; modelProvider?: string; status: 'generated' | 'prompt_ready' | 'fallback'; message?: string; }
export interface GeneratedAssetRecord extends DocumentAsset { name: string; source: 'knowledge_base' | 'generated' | 'uploaded' | 'external_url'; indexed: boolean; usedByDocumentIds: string[]; createdAt: number; updatedAt: number; }
export interface GeneratedDocumentRecord { id: string; taskId?: string; templateId: string; templateName?: string; title: string; requirement: string; markdown: string; editedMarkdown?: string; status: 'generating' | 'completed' | 'warning' | 'failed'; draft?: GeneratedDocumentDraft; executionStages?: GeneratedDocumentDraft['executionStages']; assets: DocumentAsset[]; createdAt: number; updatedAt: number; completedAt?: number; error?: string; warningIssues?: string[]; }
export interface GeneratedDocumentDraft { templateId: string; templateName: string; title: string; requirement: string; markdown: string; exportSettings?: DocumentExportSettings; generationSettings?: DocumentGenerationSettings; facts: Record<string, string>; structuredFacts: DocumentFact[]; factsModel: DocumentFactsModel; chapters: DocumentDraftChapter[]; sources: Array<{ filePath: string; count: number }>; missingItems: string[]; validation: { passed: boolean; warnings: string[]; errors: string[] }; validationIssues: ValidationIssue[]; executionStages: DocumentExecutionStage[]; exportGate: ExportGateResult; assets?: DocumentAsset[]; generatedAt: number; }
export interface StoredDocumentDraft extends GeneratedDocumentDraft { id: string; updatedAt: number; }

export async function getPromptProjects() { return fetchJson<PromptProject[]>('/api/prompt'); }
export async function getDocumentRoles(type?: 'file' | 'prompt') { return fetchJson<{ roles: DocumentRole[]; configs: ProjectRoleConfig[] }>(`/api/documents/roles${type ? `?type=${type}` : ''}`); }
export async function saveDocumentRole(role: DocumentRole) {
  return fetchJson<{ role: DocumentRole; roles: DocumentRole[]; configs: ProjectRoleConfig[] }>('/api/documents/roles', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(role) });
}
export async function deleteDocumentRole(type: 'file' | 'prompt', id: string) {
  return fetchJson<{ success: boolean; roles: DocumentRole[]; configs: ProjectRoleConfig[] }>(`/api/documents/roles?type=${type}&id=${encodeURIComponent(id)}`, { method: 'DELETE' });
}
export async function saveProjectRoleConfig(config: ProjectRoleConfig) {
  return fetchJson<{ config: ProjectRoleConfig; roles: DocumentRole[]; configs: ProjectRoleConfig[] }>('/api/documents/roles?mode=config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config) });
}
export async function deleteProjectRoleConfig(id: string) {
  return fetchJson<{ success: boolean; roles: DocumentRole[]; configs: ProjectRoleConfig[] }>(`/api/documents/roles?mode=config&id=${encodeURIComponent(id)}`, { method: 'DELETE' });
}
export async function getDocumentTemplates() { return fetchJson<{ templates: DocumentTemplate[] }>('/api/documents/templates'); }
export async function validateDocumentTemplate(templateId: string) { return fetchJson<{ validation: DocumentTemplateValidation }>(`/api/documents/templates?validate=${encodeURIComponent(templateId)}`); }
export async function saveDocumentTemplate(template: DocumentTemplate) {
  return fetchJson<{ template: DocumentTemplate; templates: DocumentTemplate[] }>('/api/documents/templates', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(template) });
}
export async function deleteDocumentTemplate(templateId: string) {
  return fetchJson<{ success: boolean; templates: DocumentTemplate[] }>(`/api/documents/templates?templateId=${encodeURIComponent(templateId)}`, { method: 'DELETE' });
}
export async function duplicateDocumentTemplate(templateId: string) {
  return fetchJson<{ template: DocumentTemplate; templates: DocumentTemplate[] }>('/api/documents/templates', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ templateId }) });
}
export async function generateDocumentDraft(input: { templateId: string; requirement?: string; maxEvidencePerChapter?: number; projectRoot?: string }) {
  return fetchJson<{ draft?: GeneratedDocumentDraft; taskId?: string; documentId?: string; record?: GeneratedDocumentRecord }>('/api/documents/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
}
export async function getGeneratedDocuments() { return fetchJson<{ documents: GeneratedDocumentRecord[] }>('/api/documents/generated'); }
export async function getGeneratedDocument(id: string) { return fetchJson<{ document: GeneratedDocumentRecord }>(`/api/documents/generated/${encodeURIComponent(id)}`); }
export async function updateGeneratedDocument(id: string, patch: Partial<GeneratedDocumentRecord>) { return fetchJson<{ document: GeneratedDocumentRecord }>(`/api/documents/generated/${encodeURIComponent(id)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }); }
export async function deleteGeneratedDocument(id: string) { return fetchJson<{ ok: boolean }>(`/api/documents/generated/${encodeURIComponent(id)}`, { method: 'DELETE' }); }
export async function abortGeneratedDocument(documentId: string) { return fetchJson<{ document: GeneratedDocumentRecord }>('/api/documents/generated', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'abort', documentId }) }); }
export async function getGeneratedAssets() { return fetchJson<{ assets: GeneratedAssetRecord[] }>('/api/assets/generated'); }
export async function deleteGeneratedAsset(id: string) { return fetchJson<{ ok: boolean; assets: GeneratedAssetRecord[] }>(`/api/assets/generated?id=${encodeURIComponent(id)}`, { method: 'DELETE' }); }
export async function indexGeneratedAsset(id: string) { return fetchJson<{ asset: GeneratedAssetRecord; assets: GeneratedAssetRecord[] }>('/api/assets/generated', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, action: 'index' }) }); }
export async function openGeneratedAsset(id: string, target: 'file' | 'directory') { return fetchJson<{ ok: boolean }>('/api/assets/generated', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, action: 'open', target }) }); }
export async function regenerateDocumentChapter(input: { templateId: string; chapterId: string; requirement?: string; maxEvidencePerChapter?: number; projectRoot?: string; documentId?: string; currentMarkdown?: string; existingFacts?: string[] }) {
  return fetchJson<{ chapter: DocumentDraftChapter }>('/api/documents/chapter/regenerate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
}
export async function getDocumentDrafts() { return fetchJson<{ drafts: StoredDocumentDraft[] }>('/api/documents/drafts'); }
export async function saveDocumentDraft(draft: GeneratedDocumentDraft, id?: string) {
  return fetchJson<{ draft: StoredDocumentDraft }>('/api/documents/drafts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ draft, id }) });
}
export async function exportDocument(input: { documentId?: string; title?: string; markdown?: string; format: 'markdown' | 'html' | 'pdf' | 'docx'; enforceGate?: boolean; exportGate?: ExportGateResult; wordTemplatePath?: string }) {
  const response = await fetch('/api/documents/export', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: input.format === 'pdf' ? 'application/pdf' : '*/*' }, body: JSON.stringify(input) });
  const contentType = response.headers.get('content-type') || '';
  const parseExportError = async () => {
    const text = await response.text();
    let message = text || '导出失败';
    try {
      const parsed = JSON.parse(text) as { error?: string; message?: string; issues?: Array<{ message?: string }> };
      const issueText = parsed.issues?.map(issue => issue.message).filter(Boolean).slice(0, 3).join('；');
      message = issueText ? `${parsed.error || '导出失败'}：${issueText}` : parsed.message || parsed.error || message;
    } catch {
      // 保留原始响应文本
    }
    throw new Error(message.length > 300 ? `${message.slice(0, 300)}...` : message);
  };
  if (!response.ok) await parseExportError();
  if (input.format === 'pdf' && !contentType.includes('application/pdf')) await parseExportError();
  if (input.format === 'docx' && !contentType.includes('officedocument.wordprocessingml.document')) await parseExportError();
  return response.blob();
}

// ═══════ 模型配置 ═══════

export interface ModelCapabilities { imageGeneration?: boolean; imageUnderstanding?: boolean; fileUnderstanding?: boolean; audio?: boolean; video?: boolean; }
export interface ProviderInfo { name: string; apiKey?: string; baseUrl?: string; protocol?: string; directEndpoint?: boolean; detectedProtocol: string; hasApiKey: boolean; capabilities?: ModelCapabilities; }
export interface ModelsConfig { reader: { active: string; list: { name: string; provider: string }[] }; reasoning: { active: string; list: { name: string; provider: string }[] }; action: { active: string; list: { name: string; provider: string }[] }; }
export interface EmbeddingConfig { provider: 'openai-compatible' | 'transformers-local'; baseUrl?: string; apiKey?: string; model?: string; dimensions?: number; hasApiKey?: boolean; }

export async function getProviders() { return fetchJson<ProviderInfo[]>('/api/config/providers'); }
export async function saveProvider(name: string, cfg: { apiKey?: string; baseUrl?: string; protocol?: string; directEndpoint?: boolean; capabilities?: ModelCapabilities; oldName?: string }) {
  return fetchJson<{ success: boolean }>('/api/config/providers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, ...cfg }) });
}
export async function deleteProvider(name: string) { return fetchJson<{ success: boolean }>(`/api/config/providers/${encodeURIComponent(name)}`, { method: 'DELETE' }); }
export async function getModels() { return fetchJson<ModelsConfig>('/api/config/models'); }
export async function saveModels(models: ModelsConfig) {
  return fetchJson<{ success: boolean }>('/api/config/models', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(models) });
}
export async function getEmbeddingConfig() { return fetchJson<EmbeddingConfig>('/api/config/embedding'); }
export async function saveEmbeddingConfig(config: EmbeddingConfig) {
  return fetchJson<EmbeddingConfig>('/api/config/embedding', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config) });
}
export async function embeddingHealthCheck() {
  return fetchJson<{ success: boolean; message: string; latencyMs?: number }>('/api/config/embedding/healthCheck', { method: 'POST' });
}
export async function healthCheck(providerName: string) {
  return fetchJson<{ success: boolean; message: string }>('/api/config/healthCheck', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: providerName }) });
}
export async function getHealth() { return fetchJson<{ status: string; uptime: number }>('/api/health'); }

// ═══════ 系统统计 ═══════

export interface SystemStats {
  cpu: { usagePercent: number; cores: number };
  memory: { totalMB: number; usedMB: number; processMB: number; usagePercent: number };
  tokens: { total: number; prompt: number; completion: number };
  models: { provider: string; model: string; count: number }[];
  tasks: { total: number; success: number; failed: number; running: number; types: Record<string, number> };
  logs: { files: number; events: number; latestAt?: string; scannedDirs: string[] };
  uptime: number;
}
export async function getSystemStats() { return fetchJson<SystemStats>('/api/system/stats'); }

export interface ErrorLogEntry {
  id: string;
  level: 'error' | 'warn' | 'info';
  source: string;
  functionName?: string;
  message: string;
  stack?: string;
  request?: { method?: string; url?: string; query?: unknown };
  meta?: unknown;
  createdAt: number;
}

export async function getErrorLogs(limit = 200) { return fetchJson<{ logs: ErrorLogEntry[] }>(`/api/system/logs?limit=${limit}`); }
export async function clearErrorLogs() { return fetchJson<{ ok: true }>('/api/system/logs', { method: 'DELETE' }); }

// ═══════ 上下文 ═══════

export interface ContextEntry {
  id: string; type: string; title: string; content: string;
  importance: 'high' | 'medium' | 'low'; tags: string[]; source: string;
  created_at: number; updated_at: number;
}
export async function getContexts(type: string, search?: string) {
  const p = search ? `?type=${type}&search=${encodeURIComponent(search)}` : `?type=${type}`;
  return fetchJson<ContextEntry[]>(`/api/context${p}`);
}
export async function getContextStats(type: string) {
  return fetchJson<{ count: number; totalBytes: number }>(`/api/context?type=${type}&stats=1`);
}
export async function compressContexts(type: string) {
  return fetchJson<{ success: boolean; changed: number; beforeBytes: number; afterBytes: number }>('/api/context', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'compress', type }) });
}
export async function clearContexts(type: string) {
  return fetchJson<{ success: boolean; deleted: number }>('/api/context', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'clear', type }) });
}
export async function deleteContextById(id: string) {
  return fetchJson<{ success: boolean }>(`/api/context?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
}
export async function updateContextById(id: string, data: { content: string; context?: string }) {
  return fetchJson<{ success: boolean }>('/api/context', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, ...data }) });
}

// ═══════ 提示词 ═══════
// (卡片式 API，直接在 prompt 页面中通过 fetch 使用)

// ═══════ 知识库分类统计 ═══════

export interface KbCategoryStats {
  category: string; fileCount: number; totalSize: number;
}
export async function getKbCategoryStats(projectRoot?: string) {
  const p = projectRoot ? `?projectRoot=${encodeURIComponent(projectRoot)}` : '';
  return fetchJson<KbCategoryStats[]>(`/api/kb/categories${p}`);
}

// ═══════ 供应商详情 ═══════
export async function getProviderDetail(name: string) {
  return fetchJson<ProviderInfo>(`/api/config/providers/${encodeURIComponent(name)}`);
}
