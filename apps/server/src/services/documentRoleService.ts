import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
export type DocumentRoleType = 'file' | 'prompt';
export type PromptExecutionType = 'fact_extraction' | 'chapter_generation' | 'llm_review' | 'validation' | 'formatting' | 'reference';
export type FileProcessingType = 'rule' | 'project_fact' | 'table' | 'drawing' | 'specification' | 'reference';

export interface DocumentRole {
  id: string;
  name: string;
  description: string;
  type: DocumentRoleType;
  resourceId?: string;
  resourceIds?: string[];
  builtIn?: boolean;
  executionType?: PromptExecutionType;
  processingType?: FileProcessingType;
}

export interface ProjectRoleItem {
  roleId: string;
  order: number;
}

export interface ProjectRoleConfig {
  id: string;
  name: string;
  description: string;
  fileRoles: ProjectRoleItem[];
  promptRoles: ProjectRoleItem[];
}

interface RoleStore {
  roles: DocumentRole[];
  configs: ProjectRoleConfig[];
}

const DEMO_ROLES: DocumentRole[] = ([
  { id: 'delta-rule-files', name: '三角洲攻略规则文件', description: '大白话：告诉系统这篇攻略要遵守什么写作规则和输出要求。', type: 'file', processingType: 'rule', resourceIds: ['文档资料/规则文件-攻略写作要求.md'] },
  { id: 'delta-fact-files', name: '三角洲干员事实文件', description: '大白话：存放干员、定位、地图和打法这些真实攻略资料。', type: 'file', processingType: 'project_fact', resourceIds: ['文档资料/项目事实-热门干员资料.md'] },
  { id: 'delta-table-files', name: '三角洲干员表格数据', description: '大白话：存放可以被解析成表格的数据，比如推荐指数、难度、职责。', type: 'file', processingType: 'table', resourceIds: ['表格数据/表格数据-热门干员推荐.csv', '表格数据/表格数据-热门干员推荐.xlsx', '表格数据/表格数据-热门干员推荐.xls'] },
  { id: 'delta-drawing-files', name: '三角洲官方地图图纸文件', description: '大白话：绑定官方地图工具里的真实地图底图/图纸瓦片，用来在攻略和 PDF 中展示地图，并说明地图来源。', type: 'file', processingType: 'drawing', resourceIds: ['图纸文件/图纸文件-官方地图图纸来源.md', '图片素材/干员图片/地图图纸-零号大坝-官方完整地图图纸.jpg', '图片素材/干员图片/地图图纸-航天基地-官方完整地图图纸.jpg', '图片素材/干员图片/地图图纸-巴克什-官方完整地图图纸.jpg', '图片素材/干员图片/地图图纸-潮汐监狱-官方完整地图图纸.jpg', '图片素材/干员图片/地图图纸-AZ3-官方完整地图图纸.jpg', '图片素材/干员图片/地图图纸-全面战场-攀升官方完整地图图纸.jpg'] },
  { id: 'delta-spec-files', name: '三角洲攻略规范文件', description: '大白话：告诉系统攻略应该包含哪些章节、怎么写、怎么校验。', type: 'file', processingType: 'specification', resourceIds: ['文档资料/规范文件-攻略结构规范.md'] },
  { id: 'delta-doc-files', name: '三角洲 Word/PDF 附件资料', description: '大白话：覆盖 PDF、DOC、DOCX 等常见文档格式，验证用户上传文档类资料也能参与生成。', type: 'file', processingType: 'reference', resourceIds: ['文档资料/PDF资料-官方攻略摘录.pdf', '文档资料/Word资料-队伍搭配说明.doc', '文档资料/Word资料-队伍搭配说明.docx'] },
  { id: 'delta-image-files', name: '三角洲干员图片资料', description: '大白话：存放干员图片来源和本地图片文件，生成攻略时用于说明配图来源。', type: 'file', processingType: 'reference', resourceIds: ['图片素材/图片文件-干员图片来源.md', '图片素材/干员图片/露娜.png', '图片素材/干员图片/红狼.png', '图片素材/干员图片/牧羊人.png', '图片素材/干员图片/蜂医.png'] },
  { id: 'delta-reference-image-files', name: '三角洲参考图片文件角色', description: '大白话：把封面参考、干员图、地图截图作为多模态模型可理解的参考图片。', type: 'file', processingType: 'reference', resourceIds: ['图片素材/干员图片/露娜.png', '图片素材/干员图片/红狼.png', '图片素材/干员图片/地图图纸-零号大坝-官方完整地图图纸.jpg', '图片素材/干员图片/地图图纸-航天基地-官方完整地图图纸.jpg'] },
  { id: 'delta-fact-prompt', name: '三角洲事实抽取提示词', description: '从示例资料中抽取干员名称、定位、技能、难度和推荐指数。', type: 'prompt', executionType: 'fact_extraction', resourceIds: ['builtin:delta-fact-extraction'] },
  { id: 'delta-generation-prompt', name: '三角洲章节生成提示词', description: '生成适合新手阅读的热门干员攻略正文。', type: 'prompt', executionType: 'chapter_generation', resourceIds: ['builtin:delta-chapter-generation'] },
  { id: 'delta-cover-image-prompt', name: '三角洲封面图片生成提示词', description: '指导多模态模型生成专业封面图，要求主题、构图、氛围、比例和不可出现的信息。', type: 'prompt', executionType: 'reference', resourceIds: ['builtin:delta-cover-image-generation'] },
  { id: 'delta-review-prompt', name: '三角洲 LLM 审查优化提示词', description: '生成后再次使用文件角色、提示词角色和文档规范包审查初稿并优化。', type: 'prompt', executionType: 'llm_review', resourceIds: ['builtin:delta-review-optimization'] },
  { id: 'delta-validation-prompt', name: '三角洲校验提示词', description: '检查是否缺少热门干员、表格和实战注意事项。', type: 'prompt', executionType: 'validation', resourceIds: ['builtin:delta-validation'] },
  { id: 'delta-formatting-prompt', name: '三角洲收尾润色提示词', description: '对最终攻略进行格式整理、标题优化和结尾收束。', type: 'prompt', executionType: 'formatting', resourceIds: ['builtin:delta-formatting'] },
] as DocumentRole[]).map(role => ({ ...role, builtIn: true }));

const DEMO_CONFIG: ProjectRoleConfig = {
  id: 'delta-force-demo-config',
  name: '三角洲热门干员攻略项目配置',
  description: '内置示例配置：文件角色和提示词角色已排好顺序，用户可直接选择内置模板生成。',
  fileRoles: [
    { roleId: 'delta-rule-files', order: 0 },
    { roleId: 'delta-fact-files', order: 1 },
    { roleId: 'delta-table-files', order: 2 },
    { roleId: 'delta-drawing-files', order: 3 },
    { roleId: 'delta-spec-files', order: 4 },
    { roleId: 'delta-doc-files', order: 5 },
    { roleId: 'delta-image-files', order: 6 },
    { roleId: 'delta-reference-image-files', order: 7 },
  ],
  promptRoles: [
    { roleId: 'delta-fact-prompt', order: 0 },
    { roleId: 'delta-generation-prompt', order: 1 },
    { roleId: 'delta-cover-image-prompt', order: 2 },
    { roleId: 'delta-review-prompt', order: 3 },
    { roleId: 'delta-validation-prompt', order: 4 },
    { roleId: 'delta-formatting-prompt', order: 5 },
  ],
};

function storePath() {
  const dir = path.join(os.homedir(), '.customize-agent');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'document-roles.json');
}

function safeId(input?: string) {
  return (input || `item-${Date.now()}`).replace(/[^a-zA-Z0-9_-]/gu, '-').slice(0, 80);
}

function sanitizeExecutionType(value: unknown): PromptExecutionType {
  return value === 'fact_extraction' || value === 'chapter_generation' || value === 'llm_review' || value === 'validation' || value === 'formatting' || value === 'reference' ? value : 'reference';
}

function sanitizeProcessingType(value: unknown): FileProcessingType {
  return value === 'rule' || value === 'project_fact' || value === 'table' || value === 'drawing' || value === 'specification' || value === 'reference' ? value : 'reference';
}

function sanitizeRole(role: DocumentRole): DocumentRole {
  const type = role.type === 'prompt' ? 'prompt' : 'file';
  return {
    id: safeId(role.id),
    name: role.name || '未命名角色',
    description: role.description || '',
    type,
    resourceId: role.resourceId || role.resourceIds?.[0] || undefined,
    resourceIds: Array.isArray(role.resourceIds) && role.resourceIds.length > 0 ? role.resourceIds.filter(Boolean) : role.resourceId ? [role.resourceId] : [],
    executionType: type === 'prompt' ? sanitizeExecutionType(role.executionType) : undefined,
    processingType: type === 'file' ? sanitizeProcessingType(role.processingType) : undefined,
  };
}

function sanitizeConfig(config: ProjectRoleConfig): ProjectRoleConfig {
  return {
    id: safeId(config.id),
    name: config.name || '未命名配置',
    description: config.description || '',
    fileRoles: Array.isArray(config.fileRoles) ? config.fileRoles.filter(item => item.roleId).map((item, index) => ({ roleId: item.roleId, order: Number.isFinite(item.order) ? item.order : index })) : [],
    promptRoles: Array.isArray(config.promptRoles) ? config.promptRoles.filter(item => item.roleId).map((item, index) => ({ roleId: item.roleId, order: Number.isFinite(item.order) ? item.order : index })) : [],
  };
}

function readStore(): RoleStore {
  try {
    const file = storePath();
    if (!fs.existsSync(file)) return { roles: [], configs: [] };
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<RoleStore> | DocumentRole[];
    if (Array.isArray(raw)) return { roles: raw.map(sanitizeRole), configs: [] };
    return {
      roles: Array.isArray(raw.roles) ? raw.roles.map(sanitizeRole) : [],
      configs: Array.isArray(raw.configs) ? raw.configs.map(sanitizeConfig) : [],
    };
  } catch {
    return { roles: [], configs: [] };
  }
}

function writeStore(store: RoleStore) {
  fs.writeFileSync(storePath(), JSON.stringify({ roles: store.roles.map(sanitizeRole), configs: store.configs.map(sanitizeConfig) }, null, 2), 'utf-8');
}

export function listDocumentRoles(type?: DocumentRoleType): DocumentRole[] {
  const customRoles = readStore().roles;
  const roleMap = new Map([...DEMO_ROLES, ...customRoles].map(role => [role.id, role]));
  const roles = [...roleMap.values()];
  return type ? roles.filter(role => role.type === type) : roles;
}

export function saveDocumentRole(role: DocumentRole): DocumentRole {
  const sanitized = sanitizeRole(role);
  const store = readStore();
  store.roles = store.roles.filter(item => !(item.id === sanitized.id && item.type === sanitized.type));
  store.roles.push(sanitized);
  writeStore(store);
  return sanitized;
}

export function deleteDocumentRole(type: DocumentRoleType, id: string) {
  if (DEMO_ROLES.some(role => role.id === id && role.type === type)) throw new Error('Built-in demo role cannot be deleted');
  const store = readStore();
  store.roles = store.roles.filter(item => !(item.id === id && item.type === type));
  store.configs = store.configs.map(config => ({
    ...config,
    fileRoles: config.fileRoles.filter(item => item.roleId !== id),
    promptRoles: config.promptRoles.filter(item => item.roleId !== id),
  }));
  writeStore(store);
}

export function listProjectRoleConfigs(): ProjectRoleConfig[] {
  const customConfigs = readStore().configs;
  const configMap = new Map([DEMO_CONFIG, ...customConfigs].map(config => [config.id, config]));
  return [...configMap.values()];
}

export function getProjectRoleConfig(id: string): ProjectRoleConfig | undefined {
  if (id === DEMO_CONFIG.id) return DEMO_CONFIG;
  return readStore().configs.find(config => config.id === id);
}

export function saveProjectRoleConfig(config: ProjectRoleConfig): ProjectRoleConfig {
  const sanitized = sanitizeConfig(config);
  const store = readStore();
  store.configs = store.configs.filter(item => item.id !== sanitized.id);
  store.configs.push(sanitized);
  writeStore(store);
  return sanitized;
}

export function deleteProjectRoleConfig(id: string) {
  if (id === DEMO_CONFIG.id) throw new Error('Built-in demo config cannot be deleted');
  const store = readStore();
  store.configs = store.configs.filter(item => item.id !== id);
  writeStore(store);
}
