async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, options);
  if (!res.ok) {
    const body = await res.text();
    let message = body || `HTTP ${res.status}`;
    try {
      const parsed = JSON.parse(body) as { error?: string; message?: string };
      message = parsed.error || parsed.message || message;
    } catch { /* keep raw body */ }
    throw new Error(message);
  }
  return res.json();
}

// ═══════ Knowledge Base ═══════

export interface KbStats { scope: string; projectId?: string; fileCount: number; chunkCount: number; totalSizeBytes: number; lastIndexedAt: number; }
export interface KbFileItem { relativePath: string; category: string; format: string; fileSize: number; mtime: number; chunkCount: number; indexedAt: number; status: string; }
export interface KbFeatures { vectorStore: string; embeddingProvider: string; externalExtractors: string[]; dedupEngine: string; chunker: string; }

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
  return fetchJson<{ files: KbFileItem[]; total: number }>(`/api/kb/files?${params}`);
}

export async function uploadKbFile(file: File, projectRoot?: string) {
  const base64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => { const r = reader.result as string; const c = r.indexOf(','); resolve(c >= 0 ? r.slice(c + 1) : r); };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
  return fetchJson<{ success: boolean; relativePath?: string; files?: KbFileItem[]; total?: number }>('/api/kb/upload', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileName: file.name, fileData: base64, projectRoot }),
  });
}

export async function deleteKbFile(relativePath: string, projectRoot?: string) {
  return fetchJson<{ success: boolean }>('/api/kb/files', {
    method: 'DELETE', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ relativePath, projectRoot }),
  });
}

export async function reindexKb(projectRoot?: string) {
  return fetchJson<{ success: boolean; stats?: KbStats }>('/api/kb/reindex', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectRoot }),
  });
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

export async function searchKb(query: string, opts?: { projectRoot?: string; category?: string; limit?: number }) {
  const params = new URLSearchParams({ q: query });
  if (opts?.projectRoot) params.set('projectRoot', opts.projectRoot);
  if (opts?.category) params.set('category', opts.category);
  if (opts?.limit) params.set('limit', String(opts.limit ?? 20));
  return fetchJson<{ results: { filePath: string }[]; total: number }>(`/api/kb/search?${params}`);
}

// ═══════ Model Config ═══════

export interface ProviderInfo { name: string; apiKey?: string; baseUrl?: string; protocol?: string; detectedProtocol: string; hasApiKey: boolean; }
export interface ModelsConfig { reader: { active: string; list: { name: string; provider: string }[] }; reasoning: { active: string; list: { name: string; provider: string }[] }; action: { active: string; list: { name: string; provider: string }[] }; }

export async function getProviders() { return fetchJson<ProviderInfo[]>('/api/config/providers'); }
export async function saveProvider(name: string, cfg: { apiKey?: string; baseUrl?: string; protocol?: string }) {
  return fetchJson<{ success: boolean }>('/api/config/providers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, ...cfg }) });
}
export async function deleteProvider(name: string) { return fetchJson<{ success: boolean }>(`/api/config/providers/${encodeURIComponent(name)}`, { method: 'DELETE' }); }
export async function getModels() { return fetchJson<ModelsConfig>('/api/config/models'); }
export async function saveModels(models: ModelsConfig) {
  return fetchJson<{ success: boolean }>('/api/config/models', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(models) });
}
export async function healthCheck(providerName: string) {
  return fetchJson<{ success: boolean; message: string }>('/api/config/healthCheck', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: providerName }) });
}
export async function getHealth() { return fetchJson<{ status: string; uptime: number }>('/api/health'); }

// ═══════ System Stats ═══════

export interface SystemStats {
  cpu: { usagePercent: number; cores: number };
  memory: { totalMB: number; usedMB: number; processMB: number; usagePercent: number };
  tokens: { total: number };
  models: { provider: string; model: string; count: number }[];
  tasks: { total: number; success: number; failed: number; types: Record<string, number> };
  uptime: number;
}
export async function getSystemStats() { return fetchJson<SystemStats>('/api/system/stats'); }

// ═══════ Context ═══════

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

// ═══════ Prompt ═══════
// (card-based API used directly in prompt page via fetch)

// ═══════ KB Category Stats ═══════

export interface KbCategoryStats {
  category: string; fileCount: number; totalSize: number;
}
export async function getKbCategoryStats(projectRoot?: string) {
  const p = projectRoot ? `?projectRoot=${encodeURIComponent(projectRoot)}` : '';
  return fetchJson<KbCategoryStats[]>(`/api/kb/categories${p}`);
}

// ═══════ Provider Detail ═══════
export async function getProviderDetail(name: string) {
  return fetchJson<ProviderInfo>(`/api/config/providers/${encodeURIComponent(name)}`);
}
