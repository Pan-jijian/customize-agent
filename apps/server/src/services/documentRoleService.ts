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
  builtIn?: boolean;
}

interface RoleStore {
  roles: DocumentRole[];
  configs: ProjectRoleConfig[];
}

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
    builtIn: Boolean(config.builtIn),
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
  const roles = readStore().roles;
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
  return readStore().configs;
}

export function getProjectRoleConfig(id: string): ProjectRoleConfig | undefined {
  return readStore().configs.find(config => config.id === id);
}

export function saveProjectRoleConfig(config: ProjectRoleConfig): ProjectRoleConfig {
  const sanitized = { ...sanitizeConfig(config), builtIn: false };
  const store = readStore();
  store.configs = store.configs.filter(item => item.id !== sanitized.id);
  store.configs.push(sanitized);
  writeStore(store);
  return sanitized;
}

export function deleteProjectRoleConfig(id: string) {
  const store = readStore();
  store.configs = store.configs.filter(item => item.id !== id);
  writeStore(store);
}
