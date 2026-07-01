export type DashboardLocale = 'zh-CN' | 'en-US';

export interface DashboardMessages {
  title: string;
  subtitle: string;
  reindex: string;
  refresh: string;
  stats: string;
  projects: string;
  fileOps: string;
  search: string;
  relationships: string;
  relationshipSummary: string;
  duplicates: string;
  tags: string;
  ignoreRules: string;
  config: string;
  capabilities: string;
  pluginGuide: string;
  vectorizable: string;
  builtInTool: string;
  extraction: string;
  sourceFilePath: string;
  targetRelativePath: string;
  addFile: string;
  relativePath: string;
  remove: string;
  filePath: string;
  tagsPlaceholder: string;
  tag: string;
  ignorePattern: string;
  ignore: string;
  ignoreSimilar: string;
  searchPlaceholder: string;
  loading: string;
  noProjects: string;
  noResults: string;
  noRelationships: string;
  noDuplicates: string;
  noTags: string;
  noIgnoreRules: string;
  project: string;
  global: string;
  files: string;
  chunks: string;
  size: string;
  path: string;
  scope: string;
  score: string;
  updated: string;
  ok: string;
  failed: string;
  overviewTab: string;
  filesTab: string;
  settingsTab: string;
  searchHelp: string;
  scopeLabel: string;
  scopeAll: string;
  scopeProject: string;
  scopeGlobal: string;
  uploadTitle: string;
  uploadHelp: string;
  uploadChoose: string;
  uploadSupport: string;
  filesTitle: string;
  filesHelp: string;
  fileType: string;
  allTypes: string;
  folderDir: string;
  allFolders: string;
  categoryDirs: string;
  categoryDirsHelp: string;
  projectId: string;
  noCategoryDirs: string;
  loadFailed: string;
  uploadSuccess: string;
  filesSyncSkipped: string;
  filesSyncChanged: string;
  filesSyncUnchanged: string;
  noFilteredFiles: string;
  rootFolder: string;
  confirmRemove: string;
  tagPrompt: string;
  defaultTag: string;
  ignorePrompt: string;
  enabled: string;
  disabled: string;
  yes: string;
  plugin: string;
  externalPlugins: string;
  available: string;
  unavailable: string;
  syncNow: string;
  language: string;
  delete: string;
  cancel: string;
  confirm: string;
  retryIndex: string;
  failedFilesTitle: string;
  failedFilesHelp: string;
  noFailedFiles: string;
  reason: string;
  operation: string;
  deleteConfirmTitle: string;
  deleteConfirmMessage: string;
  retryStarted: string;
  categoryLabels: Record<string, string>;
}

const zhCN: DashboardMessages = {
  title: 'Customize Agent — 知识库管理',
  subtitle: '本地项目知识库、全局知识库、关系与去重状态总览',
  reindex: '重新索引',
  refresh: '刷新',
  stats: '统计',
  projects: '项目',
  fileOps: '文件操作',
  search: '搜索',
  relationships: '关系明细',
  relationshipSummary: '关系摘要',
  duplicates: '跨项目重复',
  tags: '标签',
  ignoreRules: '忽略规则',
  config: '配置',
  capabilities: '类型能力矩阵',
  pluginGuide: '解析器能力',
  vectorizable: '可向量化',
  builtInTool: '内置工具',
  extraction: '提取策略',
  sourceFilePath: '源文件路径',
  targetRelativePath: '目标相对路径（可选）',
  addFile: '添加文件',
  relativePath: '相对路径',
  remove: '移除',
  filePath: '文件路径',
  tagsPlaceholder: '标签，逗号分隔',
  tag: '打标签',
  ignorePattern: '忽略规则，如 **/*.tmp',
  ignore: '忽略',
  ignoreSimilar: '忽略相似',
  searchPlaceholder: '搜索知识库...',
  loading: '加载中...',
  noProjects: '暂无项目',
  noResults: '无结果',
  noRelationships: '暂无关系',
  noDuplicates: '暂无重复文件',
  noTags: '暂无标签',
  noIgnoreRules: '暂无忽略规则',
  project: '项目',
  global: '全局',
  files: '文件',
  chunks: 'Chunks',
  size: '大小',
  path: '路径',
  scope: '范围',
  score: '得分',
  updated: '已更新',
  ok: '完成',
  failed: '失败',
  overviewTab: '总览',
  filesTab: '文件管理',
  settingsTab: '设置',
  searchHelp: '输入你想找的内容，例如“招标文件”“合同”“接口文档”。系统只检索已解析入库的知识，不直接读取 knowledgeBase 原始文件。',
  scopeLabel: '搜索范围',
  scopeAll: '全部知识库',
  scopeProject: '当前项目',
  scopeGlobal: '全局知识库',
  uploadTitle: '上传资料到知识库',
  uploadHelp: '直接选择文件即可。系统会自动按文件类型归类，并立即解析入库。',
  uploadChoose: '选择文件上传',
  uploadSupport: '支持 PDF、Word、Excel、代码、图纸、数据文件、图表文件等',
  filesTitle: '文件管理',
  filesHelp: '这里展示的是已经成功解析并入库的文件。你可以按类型或目录筛选，并对单个文件打标签、忽略同类或移除。',
  fileType: '文件类型',
  allTypes: '全部类型',
  folderDir: '文件夹目录',
  allFolders: '全部目录',
  categoryDirs: '分类文件夹',
  categoryDirsHelp: '这些是 knowledgeBase 中的默认分类目录名称。上传文件时会自动归类；技术用户后续可以改这些目录名。',
  projectId: '项目 ID',
  noCategoryDirs: '暂无分类目录配置',
  loadFailed: '加载失败',
  uploadSuccess: '上传并入库成功',
  filesSyncSkipped: '已同步本地 knowledgeBase，{count} 个文件解析失败未入库',
  filesSyncChanged: '已同步本地 knowledgeBase：{count} 个变更',
  filesSyncUnchanged: '已同步本地 knowledgeBase，无新增变更',
  noFilteredFiles: '没有符合筛选条件的已入库文件。',
  rootFolder: '根目录',
  confirmRemove: '确定从知识库移除这个文件吗？',
  tagPrompt: '给这个文件添加标签，多个标签用逗号分隔：',
  defaultTag: '重要',
  ignorePrompt: '要忽略哪类文件？',
  enabled: '启用',
  disabled: '禁用',
  yes: '是',
  plugin: '插件',
  externalPlugins: '外部增强插件',
  available: '可用',
  unavailable: '不可用',
  syncNow: '同步知识库',
  language: '语言',
  delete: '删除',
  cancel: '取消',
  confirm: '确认',
  retryIndex: '重新入库',
  failedFilesTitle: '入库失败文件',
  failedFilesHelp: '这里展示最近一次同步中解析失败、未入库的文件。你可以删除无效文件，或修复文件后重新入库。',
  noFailedFiles: '暂无入库失败文件。',
  reason: '原因',
  operation: '操作',
  deleteConfirmTitle: '删除文件',
  deleteConfirmMessage: '确定要从 knowledgeBase 删除这个文件吗？此操作会删除本地文件。',
  retryStarted: '已重新尝试入库',
  categoryLabels: { document:'文档', code:'代码', data:'数据', cad:'图纸', diagram:'图表', image:'图片', spreadsheet:'表格', archive:'压缩包', web:'网页', other:'其他' },
};

const enUS: DashboardMessages = {
  title: 'Customize Agent — Knowledge Dashboard',
  subtitle: 'Overview for project KB, global KB, relationships and deduplication',
  reindex: 'Reindex',
  refresh: 'Refresh',
  stats: 'Stats',
  projects: 'Projects',
  fileOps: 'File Ops',
  search: 'Search',
  relationships: 'Relationships',
  relationshipSummary: 'Relationship Summary',
  duplicates: 'Cross-project Duplicates',
  tags: 'Tags',
  ignoreRules: 'Ignore Rules',
  config: 'Config',
  capabilities: 'Type Capability Matrix',
  pluginGuide: 'External Parser Setup',
  vectorizable: 'Vectorizable',
  builtInTool: 'Built-in Tool',
  extraction: 'Extraction',
  sourceFilePath: 'source file path',
  targetRelativePath: 'target relative path (optional)',
  addFile: 'Add File',
  relativePath: 'relative path',
  remove: 'Remove',
  filePath: 'file path',
  tagsPlaceholder: 'tags, comma separated',
  tag: 'Tag',
  ignorePattern: 'ignore pattern, e.g. **/*.tmp',
  ignore: 'Ignore',
  ignoreSimilar: 'Ignore Similar',
  searchPlaceholder: 'Search knowledge base...',
  loading: 'Loading...',
  noProjects: 'No projects',
  noResults: 'No results',
  noRelationships: 'No relationships',
  noDuplicates: 'No duplicates',
  noTags: 'No tags',
  noIgnoreRules: 'No ignore rules',
  project: 'Project',
  global: 'Global',
  files: 'Files',
  chunks: 'Chunks',
  size: 'Size',
  path: 'Path',
  scope: 'Scope',
  score: 'Score',
  updated: 'Updated',
  ok: 'OK',
  failed: 'Failed',
  overviewTab: 'Overview',
  filesTab: 'File Manager',
  settingsTab: 'Settings',
  searchHelp: 'Enter what you want to find, such as bid documents, contracts, or API docs. The system searches parsed knowledge only and does not read raw knowledgeBase files directly.',
  scopeLabel: 'Search Scope',
  scopeAll: 'All Knowledge Bases',
  scopeProject: 'Current Project',
  scopeGlobal: 'Global Knowledge Base',
  uploadTitle: 'Upload Knowledge Files',
  uploadHelp: 'Select files directly. The system classifies, parses, and indexes them immediately.',
  uploadChoose: 'Choose files to upload',
  uploadSupport: 'Supports PDF, Word, Excel, code, drawings, data files, diagrams, and more',
  filesTitle: 'File Manager',
  filesHelp: 'This page shows files that were parsed and indexed successfully. Filter by type or folder, then tag, ignore similar files, or remove individual files.',
  fileType: 'File Type',
  allTypes: 'All Types',
  folderDir: 'Folder',
  allFolders: 'All Folders',
  categoryDirs: 'Category Folders',
  categoryDirsHelp: 'These are the default category folder names in knowledgeBase. Uploaded files are classified automatically; advanced users can rename them later.',
  projectId: 'Project ID',
  noCategoryDirs: 'No category folder config',
  loadFailed: 'Load failed',
  uploadSuccess: 'Uploaded and indexed successfully',
  filesSyncSkipped: 'Local knowledgeBase synced, {count} files failed to parse and were not indexed',
  filesSyncChanged: 'Local knowledgeBase synced: {count} changes',
  filesSyncUnchanged: 'Local knowledgeBase synced, no changes',
  noFilteredFiles: 'No indexed files match the current filters.',
  rootFolder: 'Root',
  confirmRemove: 'Remove this file from the knowledge base?',
  tagPrompt: 'Add tags to this file, separated by commas:',
  defaultTag: 'important',
  ignorePrompt: 'Which files should be ignored?',
  enabled: 'Enabled',
  disabled: 'Disabled',
  yes: 'yes',
  plugin: 'plugin',
  externalPlugins: 'External Enhancements',
  available: 'available',
  unavailable: 'unavailable',
  syncNow: 'Sync Knowledge Base',
  language: 'Language',
  delete: 'Delete',
  cancel: 'Cancel',
  confirm: 'Confirm',
  retryIndex: 'Retry Indexing',
  failedFilesTitle: 'Failed Files',
  failedFilesHelp: 'Files that failed to parse during the latest sync are listed here. Delete invalid files or fix them and retry indexing.',
  noFailedFiles: 'No failed files.',
  reason: 'Reason',
  operation: 'Actions',
  deleteConfirmTitle: 'Delete File',
  deleteConfirmMessage: 'Remove this file from knowledgeBase? This deletes the local file.',
  retryStarted: 'Retry indexing started',
  categoryLabels: { document:'Documents', code:'Code', data:'Data', cad:'Drawings', diagram:'Diagrams', image:'Images', spreadsheet:'Spreadsheets', archive:'Archives', web:'Web', other:'Other' },
};

export const DASHBOARD_MESSAGES: Record<DashboardLocale, DashboardMessages> = {
  'zh-CN': zhCN,
  'en-US': enUS,
};

export function resolveDashboardMessages(locale: string | undefined): { locale: DashboardLocale; messages: DashboardMessages } {
  const normalized = locale === 'en-US' ? 'en-US' : 'zh-CN';
  return { locale: normalized, messages: DASHBOARD_MESSAGES[normalized] };
}
