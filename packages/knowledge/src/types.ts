export type KBScope = 'project' | 'global' | 'session';

export type FileCategory =
  | 'document'
  | 'spreadsheet'
  | 'image'
  | 'cad'
  | 'code'
  | 'data'
  | 'web'
  | 'diagram'
  | 'archive'
  | 'other';

export type ProjectStatus = 'active' | 'idle' | 'error';

export interface ProjectInfo {
  projectId: string;
  projectRoot: string;
  projectName?: string;
  kbPath: string;
  fileCount: number;
  chunkCount: number;
  totalSizeBytes: number;
  lastIndexedAt: number;
  lastOpenedAt: number;
  status: ProjectStatus;
}

export interface ProjectConfig {
  projectId: string;
  projectName?: string;
  enabled: boolean;
  includeGlobal: boolean;
  priorityOverGlobal: boolean;
  watch: boolean;
  autoIndex: boolean;
  kbignore: string[];
  projectTags: string[];
  categoryDirs: Partial<Record<FileCategory, string>>;
  createdAt: number;
  lastOpenedAt: number;
}

export interface ClassifiedFile {
  absolutePath: string;
  relativePath: string;
  category: FileCategory;
  format: string;
  fileSize: number;
  mtime: number;
  mimeType: string;
}

export interface IndexStateRecord {
  relativePath: string;
  category: FileCategory;
  format: string;
  contentHash: string;
  fileSize: number;
  mtime: number;
  chunkCount: number;
  collectionName: string;
  indexedAt: number;
  lastVerifiedAt: number;
  status: 'active' | 'outdated' | 'error' | 'deleted';
  errorMessage?: string;
  metadataJson?: string;
}

export interface DiffResult {
  newFiles: ClassifiedFile[];
  modifiedFiles: ClassifiedFile[];
  deletedFiles: IndexStateRecord[];
  unchangedCount: number;
  mtimeOnlyCount: number;
  skippedFiles: Array<{ file: ClassifiedFile; reason: string }>;
  hasChanges: boolean;
  diffTimeMs: number;
}

export interface KnowledgeBaseStats {
  scope: Exclude<KBScope, 'session'>;
  projectId?: string;
  fileCount: number;
  chunkCount: number;
  totalSizeBytes: number;
  lastIndexedAt: number;
}

export interface CrossProjectDuplicate {
  contentHash: string;
  files: Array<{
    projectId: string;
    projectRoot: string;
    relativePath: string;
  }>;
}
