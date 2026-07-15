import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readEngineeringDocumentConfig } from './engineeringDocumentConfigService';

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

export interface DocumentRolesExportFile {
  type: 'customize-agent.documentRoles';
  version: 1;
  exportedAt: string;
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

function uniqueStrings(values: string[] = []) {
  return [...new Set(values.filter(Boolean))];
}

function uniqueRoleItems(items: ProjectRoleItem[] = []) {
  const seen = new Set<string>();
  return items.filter(item => {
    if (!item.roleId || seen.has(item.roleId)) return false;
    seen.add(item.roleId);
    return true;
  });
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
    builtIn: Boolean(role.builtIn),
    resourceId: type === 'prompt' ? role.resourceId || role.resourceIds?.[0] || undefined : undefined,
    resourceIds: type === 'prompt' ? uniqueStrings(Array.isArray(role.resourceIds) && role.resourceIds.length > 0 ? role.resourceIds : role.resourceId ? [role.resourceId] : []) : [],
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
    fileRoles: uniqueRoleItems(Array.isArray(config.fileRoles) ? config.fileRoles.filter(item => item.roleId).map((item, index) => ({ roleId: item.roleId, order: Number.isFinite(item.order) ? item.order : index })) : []),
    promptRoles: uniqueRoleItems(Array.isArray(config.promptRoles) ? config.promptRoles.filter(item => item.roleId).map((item, index) => ({ roleId: item.roleId, order: Number.isFinite(item.order) ? item.order : index })) : []),
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

function configuredRoles() {
  return readEngineeringDocumentConfig().roles.map(role => sanitizeRole({ ...role, builtIn: true }));
}

function configuredRoleConfigs() {
  return readEngineeringDocumentConfig().roleConfigs.map(config => sanitizeConfig({ ...config, builtIn: true }));
}

export function listDocumentRoles(type?: DocumentRoleType): DocumentRole[] {
  const configRoles = configuredRoles();
  const customRoles = readStore().roles.filter(role => !configRoles.some(item => item.id === role.id && item.type === role.type));
  const roles = [...configRoles, ...customRoles];
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
  if (configuredRoles().some(role => role.id === id && role.type === type)) throw new Error('Configured role cannot be deleted');
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
  const configConfigs = configuredRoleConfigs();
  const customConfigs = readStore().configs.filter(config => !configConfigs.some(item => item.id === config.id));
  return [...configConfigs, ...customConfigs];
}

export function getProjectRoleConfig(id: string): ProjectRoleConfig | undefined {
  return listProjectRoleConfigs().find(config => config.id === id);
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
  if (configuredRoleConfigs().some(config => config.id === id)) throw new Error('Configured role config cannot be deleted');
  const store = readStore();
  store.configs = store.configs.filter(item => item.id !== id);
  writeStore(store);
}

function uniqueImportedId(baseId: string, existing: Set<string>) {
  let id = safeId(baseId);
  if (!existing.has(id)) {
    existing.add(id);
    return id;
  }
  do {
    id = safeId(`${baseId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`);
  } while (existing.has(id));
  existing.add(id);
  return id;
}

function normalizeRoleItemsWithMap(items: ProjectRoleItem[] = [], idMap: Map<string, string>) {
  return items.map((item, index) => ({ roleId: idMap.get(item.roleId) || item.roleId, order: Number.isFinite(item.order) ? item.order : index }));
}

export function exportDocumentRolesPayload(input?: { roleIds?: string[]; configIds?: string[] }): DocumentRolesExportFile {
  const roleIdSet = input?.roleIds ? new Set(input.roleIds) : null;
  const configIdSet = input?.configIds ? new Set(input.configIds) : null;
  const store = readStore();
  return {
    type: 'customize-agent.documentRoles',
    version: 1,
    exportedAt: new Date().toISOString(),
    roles: store.roles.filter(role => !roleIdSet || roleIdSet.has(role.id)).map(sanitizeRole),
    configs: store.configs.filter(config => !configIdSet || configIdSet.has(config.id)).map(sanitizeConfig),
  };
}

export function importDocumentRolesPayload(payload: unknown): { importedRoles: number; importedConfigs: number } {
  const source = payload && typeof payload === 'object' ? payload as Partial<DocumentRolesExportFile> : {};
  const rawRoles = Array.isArray(source.roles) ? source.roles : [];
  const rawConfigs = Array.isArray(source.configs) ? source.configs : [];
  if (rawRoles.length === 0 && rawConfigs.length === 0) throw new Error('没有可导入的角色配置');

  const store = readStore();
  const existingRoleIds = new Set([...configuredRoles().map(role => role.id), ...store.roles.map(role => role.id)]);
  const existingConfigIds = new Set([...configuredRoleConfigs().map(config => config.id), ...store.configs.map(config => config.id)]);
  const roleIdMap = new Map<string, string>();
  const importedRoles: DocumentRole[] = [];

  for (const rawRole of rawRoles) {
    const role = sanitizeRole(rawRole as DocumentRole);
    const nextId = uniqueImportedId(role.id, existingRoleIds);
    roleIdMap.set(role.id, nextId);
    importedRoles.push({ ...role, id: nextId, builtIn: false });
  }

  const allRoleIds = new Set([...configuredRoles().map(role => role.id), ...store.roles.map(role => role.id), ...importedRoles.map(role => role.id)]);
  const importedConfigs = rawConfigs.map(rawConfig => {
    const config = sanitizeConfig(rawConfig as ProjectRoleConfig);
    const id = uniqueImportedId(config.id, existingConfigIds);
    return sanitizeConfig({
      ...config,
      id,
      builtIn: false,
      fileRoles: normalizeRoleItemsWithMap(config.fileRoles, roleIdMap).filter(item => allRoleIds.has(item.roleId)),
      promptRoles: normalizeRoleItemsWithMap(config.promptRoles, roleIdMap).filter(item => allRoleIds.has(item.roleId)),
    });
  });

  store.roles.push(...importedRoles);
  store.configs.push(...importedConfigs);
  writeStore(store);
  return { importedRoles: importedRoles.length, importedConfigs: importedConfigs.length };
}
