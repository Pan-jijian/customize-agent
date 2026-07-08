import type { FileCategory } from './types.js';

/** 知识库数据目录名 */
export const KNOWLEDGE_BASE_DIR = 'knowledgeBase';
/** 项目配置文件路径（相对于项目根目录） */
export const PROJECT_CONFIG_PATH = ['.customize-agent', 'kb', 'project.json'] as const;
/** 自定义 Agent 用户数据目录 */
export const USER_DATA_DIR = '.customize-agent';
/** 全局知识库目录名 */
export const GLOBAL_KNOWLEDGE_DIR = 'global-knowledge';

/** 所有支持的文件分类 */
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

/** 各文件分类的默认目录（中文名称） */
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

/** 各文件分类对应的 Vector Collection 名称（英文，供存储使用） */
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
