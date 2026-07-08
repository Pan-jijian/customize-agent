/** 知识库作用域：项目级、全局级或会话级 */
export type KBScope = 'project' | 'global' | 'session';

/** 文件分类枚举 */
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

/** 项目状态：活跃、空闲或错误 */
export type ProjectStatus = 'active' | 'idle' | 'error';

/** 项目信息 */
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

/** 项目配置 */
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

/** 已分类的文件信息 */
export interface ClassifiedFile {
  absolutePath: string;
  relativePath: string;
  category: FileCategory;
  format: string;
  fileSize: number;
  mtime: number;
  mimeType: string;
}

/** 索引状态记录 */
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

/** 文件差异对比结果 */
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

/** 知识库统计信息 */
export interface KnowledgeBaseStats {
  scope: Exclude<KBScope, 'session'>;
  projectId?: string;
  fileCount: number;
  chunkCount: number;
  totalSizeBytes: number;
  lastIndexedAt: number;
}

/** 跨项目重复文件检测结果 */
export interface CrossProjectDuplicate {
  contentHash: string;
  files: Array<{
    projectId: string;
    projectRoot: string;
    relativePath: string;
  }>;
}
