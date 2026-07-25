import { computeProjectId, IndexStateStore, MultiProjectManager } from '@customize-agent/knowledge';
import Database from 'better-sqlite3';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

let manager: MultiProjectManager | null = null;

function getWorkspaceRoot(): string {
  return process.env.INIT_CWD && !isInternalResidualProject(process.env.INIT_CWD)
    ? process.env.INIT_CWD
    : path.resolve(process.cwd(), '../..');
}

export function getStorageRoot(): string {
  return path.join(os.homedir(), '.customize-agent');
}

export function getMultiProjectManager(): MultiProjectManager {
  if (!manager) manager = new MultiProjectManager(getStorageRoot());
  return manager;
}

function isInternalResidualProject(projectRoot: string): boolean {
  const normalized = path.resolve(projectRoot);
  const homeConfig = path.resolve(path.join(os.homedir(), '.customize-agent'));
  if (fs.existsSync(path.join(normalized, 'pnpm-workspace.yaml')) && fs.existsSync(path.join(normalized, 'apps', 'server'))) return false;
  return normalized === homeConfig
    || normalized.includes(`${path.sep}.customize-agent${path.sep}`)
    || normalized.endsWith(`${path.sep}apps${path.sep}server`)
    || normalized.endsWith(`${path.sep}apps${path.sep}cli`);
}

export function getKnownProjectRoots(): string[] {
  const registryPath = path.join(getStorageRoot(), 'projects', 'registry.db');
  if (!fs.existsSync(registryPath)) return [];
  const db = new Database(registryPath, { readonly: true });
  try {
    const rows = db.prepare('SELECT project_root FROM project_registry ORDER BY last_opened_at DESC').all() as Array<{ project_root: string }>;
    return rows.map(r => path.resolve(r.project_root)).filter(root => !isInternalResidualProject(root));
  } finally { db.close(); }
}

export function getProjectRoot(): string {
  const envRoot = process.env.CUSTOMIZE_PROJECT_ROOT ?? process.env.INIT_CWD;
  if (envRoot && fs.existsSync(envRoot) && !isInternalResidualProject(envRoot)) return path.resolve(envRoot);
  const known = getKnownProjectRoots();
  if (known.length > 0) return known[0]!;
  return getWorkspaceRoot();
}

export function resolveProjectRoot(queryRoot?: string): string | null {
  if (queryRoot) {
    const resolved = path.resolve(queryRoot);
    return fs.existsSync(resolved) && !isInternalResidualProject(resolved) ? resolved : null;
  }
  return getProjectRoot();
}

export type KnowledgeFileDiscoveryMatch = 'path' | 'metadata' | 'content' | 'disk';
export type KnowledgeFileDiscoveryItem = {
  relativePath: string;
  category: string;
  format: string;
  contentHash?: string;
  fileSize: number;
  mtime: number;
  chunkCount: number;
  collectionName?: string;
  indexedAt: number;
  lastVerifiedAt: number;
  status: string;
  errorMessage?: string;
  metadataJson?: string;
  matchedBy: KnowledgeFileDiscoveryMatch;
  score?: number;
};

function categoryFromRelativePath(relativePath: string) {
  if (relativePath.includes('表格数据/')) return 'spreadsheet';
  if (relativePath.includes('图片素材/')) return 'image';
  if (relativePath.includes('图纸文件/')) return 'cad';
  if (relativePath.includes('文档资料/')) return 'document';
  return 'other';
}

function formatFromFile(filePath: string) {
  return path.extname(filePath).slice(1).toLowerCase() || 'text';
}

function normalizeKbRelativePath(relativePath: string) {
  return relativePath.split(path.sep).join('/');
}

function scanKnowledgeBaseFiles(projectRoot: string): KnowledgeFileDiscoveryItem[] {
  const kbRoot = path.join(projectRoot, 'knowledgeBase');
  if (!fs.existsSync(kbRoot)) return [];
  const files: KnowledgeFileDiscoveryItem[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.name.endsWith('.source.txt')) continue;
      const stat = fs.statSync(full);
      const relativePath = normalizeKbRelativePath(path.relative(kbRoot, full));
      files.push({
        relativePath,
        category: categoryFromRelativePath(relativePath),
        format: formatFromFile(relativePath),
        contentHash: '',
        fileSize: stat.size,
        mtime: stat.mtimeMs,
        chunkCount: 0,
        collectionName: '',
        indexedAt: 0,
        lastVerifiedAt: 0,
        status: 'disk',
        matchedBy: 'disk',
      });
    }
  };
  walk(kbRoot);
  return files;
}

function readIndexedKnowledgeFiles(projectRoot: string): KnowledgeFileDiscoveryItem[] {
  const dbPath = path.join(os.homedir(), '.customize-agent', 'projects', computeProjectId(path.resolve(projectRoot)), 'kb.db');
  if (!fs.existsSync(dbPath)) return [];
  const store = new IndexStateStore(dbPath);
  try {
    return store.listRecords().map(record => ({
      ...record,
      matchedBy: 'metadata' as const,
    }));
  } finally {
    store.close();
  }
}

function fileMatchesQuery(file: KnowledgeFileDiscoveryItem, query: string) {
  const text = `${file.relativePath}\n${file.category}\n${file.format}\n${file.status}`.toLowerCase();
  return text.includes(query.toLowerCase());
}

export function listKnowledgeFiles(projectRoot: string, options: { category?: string } = {}): KnowledgeFileDiscoveryItem[] {
  const byPath = new Map<string, KnowledgeFileDiscoveryItem>();
  for (const file of readIndexedKnowledgeFiles(projectRoot)) byPath.set(file.relativePath, file);
  for (const file of scanKnowledgeBaseFiles(projectRoot)) {
    const indexed = byPath.get(file.relativePath);
    byPath.set(file.relativePath, indexed ? { ...indexed, fileSize: file.fileSize, mtime: file.mtime, matchedBy: 'metadata' } : file);
  }
  return Array.from(byPath.values())
    .filter(file => !options.category || file.category === options.category)
    .sort((a, b) => b.mtime - a.mtime || a.relativePath.localeCompare(b.relativePath, 'zh-CN'));
}

export async function discoverKnowledgeFiles(projectRoot: string, options: { query?: string; category?: string; limit?: number; includeContent?: boolean } = {}) {
  const query = (options.query || '').trim();
  const limit = Math.max(1, Math.min(500, options.limit ?? 50));
  const byPath = new Map<string, KnowledgeFileDiscoveryItem>();
  const baseFiles = listKnowledgeFiles(projectRoot, { category: options.category });
  for (const file of baseFiles) {
    if (!query || fileMatchesQuery(file, query)) {
      byPath.set(file.relativePath, { ...file, matchedBy: query ? 'path' : file.matchedBy });
    }
  }
  if (query && options.includeContent !== false) {
    try {
      const result = await getMultiProjectManager().search(projectRoot, query, { limit: Math.max(20, limit) });
      for (const item of result.results) {
        const relativePath = item.filePath;
        const existing = byPath.get(relativePath) || baseFiles.find(file => file.relativePath === relativePath);
        byPath.set(relativePath, {
          ...(existing || {
            relativePath,
            category: 'content',
            format: 'knowledge',
            fileSize: 0,
            mtime: 0,
            chunkCount: 0,
            indexedAt: 0,
            lastVerifiedAt: 0,
            status: 'active',
          }),
          matchedBy: 'content',
          score: item.score,
        });
      }
    } catch {
      // 内容索引不可用时仍返回文件名/磁盘匹配结果。
    }
  }
  const files = Array.from(byPath.values())
    .sort((a, b) => {
      const rank = (item: KnowledgeFileDiscoveryItem) => item.matchedBy === 'content' ? 3 : item.matchedBy === 'path' ? 2 : item.matchedBy === 'metadata' ? 1 : 0;
      return rank(b) - rank(a) || (b.score ?? 0) - (a.score ?? 0) || b.mtime - a.mtime || a.relativePath.localeCompare(b.relativePath, 'zh-CN');
    });
  return { files: files.slice(0, limit), total: files.length };
}

export async function shutdownKbService(): Promise<void> {
  if (manager) { await manager.shutdown(); manager = null; }
}
