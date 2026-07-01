import type { FileCategory } from './types.js';

export const KNOWLEDGE_BASE_DIR = 'knowledgeBase';
export const PROJECT_CONFIG_PATH = ['.customize-agent', 'kb', 'project.json'] as const;
export const USER_DATA_DIR = '.customize-agent';
export const GLOBAL_KNOWLEDGE_DIR = 'global-knowledge';

export const ALL_CATEGORIES: readonly FileCategory[] = [
  'document',
  'spreadsheet',
  'image',
  'cad',
  'code',
  'data',
  'web',
  'diagram',
  'archive',
  'other',
];

export const DEFAULT_CATEGORY_DIRS: Record<FileCategory, string> = {
  document: '文档资料',
  spreadsheet: '表格数据',
  image: '图片素材',
  cad: '图纸文件',
  code: '代码文件',
  data: '数据文件',
  web: '网页文件',
  diagram: '图表流程',
  archive: '压缩包',
  other: '其他文件',
};

export const COLLECTION_CATEGORY_NAMES: Record<FileCategory, string> = {
  document: 'documents',
  spreadsheet: 'spreadsheets',
  image: 'images',
  cad: 'cad',
  code: 'code',
  data: 'data',
  web: 'web',
  diagram: 'diagrams',
  archive: 'archives',
  other: 'other',
};
