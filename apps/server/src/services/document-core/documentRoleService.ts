import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DOCUMENT_ROLE_ID_MAX_LENGTH, PROMPT_EXECUTION_TYPES } from '../constants';
import type { DocumentRole, DocumentRolesExportFile, DocumentRoleType, ProjectRoleConfig, ProjectRoleItem, PromptExecutionType, RoleStore } from '../types';
import { readEngineeringDocumentConfig } from '../document-validation/engineeringDocumentConfigService';

export type { DocumentRole, DocumentRolesExportFile, DocumentRoleType, ProjectRoleConfig, ProjectRoleItem, PromptExecutionType } from '../types';

function storePath() {
  const dir = path.join(os.homedir(), '.customize-agent');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'document-roles.json');
}

function safeId(input?: string) {
  return (input || `item-${Date.now()}`).replace(/[^a-zA-Z0-9_-]/gu, '-').slice(0, DOCUMENT_ROLE_ID_MAX_LENGTH);
}

function sanitizeExecutionType(value: unknown): PromptExecutionType {
  return typeof value === 'string' && PROMPT_EXECUTION_TYPES.has(value) ? value as PromptExecutionType : 'reference';
}

function uniqueStrings(values: string[] = []) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function uniqueRoleItems(items: ProjectRoleItem[] = []) {
  const seen = new Set<string>();
  const result: ProjectRoleItem[] = [];
  for (const item of items) {
    if (!item.roleId || seen.has(item.roleId)) continue;
    seen.add(item.roleId);
    result.push(item);
  }
  return result;
}


function sanitizeRoleItems(items: unknown): ProjectRoleItem[] {
  if (!Array.isArray(items)) return [];
  const normalized: ProjectRoleItem[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index] as Partial<ProjectRoleItem>;
    if (!item.roleId) continue;
    normalized.push({ roleId: item.roleId, order: Number.isFinite(item.order) ? item.order! : index });
  }
  return uniqueRoleItems(normalized);
}

function isPromptRole(role: unknown): role is DocumentRole {
  return Boolean(role && typeof role === 'object' && (role as { type?: unknown }).type === 'prompt');
}

function sanitizeRole(role: DocumentRole): DocumentRole {
  return {
    id: safeId(role.id),
    name: role.name || '未命名角色',
    description: role.description || '',
    type: 'prompt',
    builtIn: Boolean(role.builtIn),
    resourceId: role.resourceId || role.resourceIds?.[0] || undefined,
    resourceIds: uniqueStrings(Array.isArray(role.resourceIds) && role.resourceIds.length > 0 ? role.resourceIds : role.resourceId ? [role.resourceId] : []),
    executionType: sanitizeExecutionType(role.executionType),
  };
}

function sanitizeConfig(config: ProjectRoleConfig): ProjectRoleConfig {
  return {
    id: safeId(config.id),
    name: config.name || '未命名配置',
    description: config.description || '',
    builtIn: Boolean(config.builtIn),
    promptRoles: sanitizeRoleItems(config.promptRoles),
  };
}

function readStore(): RoleStore & { deletedRoleIds?: string[]; deletedConfigIds?: string[] } {
  try {
    const file = storePath();
    if (!fs.existsSync(file)) return { roles: [], configs: [], deletedRoleIds: [], deletedConfigIds: [] };
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as (Partial<RoleStore> & { deletedRoleIds?: string[]; deletedConfigIds?: string[] }) | DocumentRole[];
    if (Array.isArray(raw)) return { roles: raw.filter(isPromptRole).map(sanitizeRole), configs: [], deletedRoleIds: [], deletedConfigIds: [] };
    return {
      roles: Array.isArray(raw.roles) ? raw.roles.filter(isPromptRole).map(sanitizeRole) : [],
      configs: Array.isArray(raw.configs) ? raw.configs.map(sanitizeConfig) : [],
      deletedRoleIds: uniqueStrings(raw.deletedRoleIds || []),
      deletedConfigIds: uniqueStrings(raw.deletedConfigIds || []),
    };
  } catch {
    return { roles: [], configs: [], deletedRoleIds: [], deletedConfigIds: [] };
  }
}

function writeStore(store: RoleStore & { deletedRoleIds?: string[]; deletedConfigIds?: string[] }) {
  fs.writeFileSync(storePath(), JSON.stringify({
    roles: store.roles.map(sanitizeRole),
    configs: store.configs.map(sanitizeConfig),
    deletedRoleIds: uniqueStrings(store.deletedRoleIds || []),
    deletedConfigIds: uniqueStrings(store.deletedConfigIds || []),
  }, null, 2), 'utf-8');
}

function configuredRoles() {
  return readEngineeringDocumentConfig().roles.filter(isPromptRole).map(role => sanitizeRole({ ...role, builtIn: true }));
}

function configuredRoleConfigs() {
  return readEngineeringDocumentConfig().roleConfigs.map(config => sanitizeConfig({ ...config, builtIn: true }));
}

export function listDocumentRoles(type?: DocumentRoleType): DocumentRole[] {
  const store = readStore();
  const deletedRoleIds = new Set(store.deletedRoleIds || []);
  const configRoles = configuredRoles().filter(role => !deletedRoleIds.has(`${role.type}:${role.id}`));
  const customRoles = store.roles.filter(role => !configRoles.some(item => item.id === role.id && item.type === role.type) && !deletedRoleIds.has(`${role.type}:${role.id}`));
  const roles = [...configRoles, ...customRoles];
  return type ? roles.filter(role => role.type === type) : roles;
}

export function saveDocumentRole(role: DocumentRole): DocumentRole {
  const sanitized = sanitizeRole(role);
  const store = readStore();
  store.deletedRoleIds = (store.deletedRoleIds || []).filter(key => key !== `${sanitized.type}:${sanitized.id}`);
  store.roles = store.roles.filter(item => !(item.id === sanitized.id && item.type === sanitized.type));
  store.roles.push(sanitized);
  writeStore(store);
  return sanitized;
}

export function deleteDocumentRole(type: DocumentRoleType, id: string) {
  const store = readStore();
  const key = `${type}:${id}`;
  if (configuredRoles().some(role => role.id === id && role.type === type)) store.deletedRoleIds = uniqueStrings([...(store.deletedRoleIds || []), key]);
  store.roles = store.roles.filter(item => !(item.id === id && item.type === type));
  store.configs = store.configs.map(config => ({
    ...config,
    promptRoles: config.promptRoles.filter(item => !(type === 'prompt' && item.roleId === id)),
  }));
  writeStore(store);
}

export function listProjectRoleConfigs(): ProjectRoleConfig[] {
  const store = readStore();
  const deletedConfigIds = new Set(store.deletedConfigIds || []);
  const deletedRoleIds = new Set(store.deletedRoleIds || []);
  const customConfigs = store.configs.filter(config => !deletedConfigIds.has(config.id));
  const customConfigIds = new Set(customConfigs.map(config => config.id));
  const configConfigs = configuredRoleConfigs().filter(config => !deletedConfigIds.has(config.id) && !customConfigIds.has(config.id));
  return [...configConfigs, ...customConfigs].map(config => ({
    ...config,
    promptRoles: config.promptRoles.filter(item => !deletedRoleIds.has(`prompt:${item.roleId}`)),
  }));
}

export function getProjectRoleConfig(id: string): ProjectRoleConfig | undefined {
  return listProjectRoleConfigs().find(config => config.id === id);
}

export function saveProjectRoleConfig(config: ProjectRoleConfig): ProjectRoleConfig {
  const sanitized = { ...sanitizeConfig(config), builtIn: false };
  const store = readStore();
  store.deletedConfigIds = (store.deletedConfigIds || []).filter(item => item !== sanitized.id);
  store.configs = store.configs.filter(item => item.id !== sanitized.id);
  store.configs.push(sanitized);
  writeStore(store);
  return sanitized;
}

export function deleteProjectRoleConfig(id: string) {
  const store = readStore();
  if (configuredRoleConfigs().some(config => config.id === id)) store.deletedConfigIds = uniqueStrings([...(store.deletedConfigIds || []), id]);
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
  const rawRoles = Array.isArray(source.roles) ? source.roles.filter(isPromptRole) : [];
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
      promptRoles: normalizeRoleItemsWithMap(config.promptRoles, roleIdMap).filter(item => allRoleIds.has(item.roleId)),
    });
  });

  store.roles.push(...importedRoles);
  store.configs.push(...importedConfigs);
  writeStore(store);
  return { importedRoles: importedRoles.length, importedConfigs: importedConfigs.length };
}
