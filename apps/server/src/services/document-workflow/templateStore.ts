import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { getProjectRoot, listKnowledgeFiles } from '../knowledge/kbService';
import { getProjectRoleConfig, listDocumentRoles } from '../document-core/documentRoleService';
import { readEngineeringDocumentConfig } from '../document-validation/engineeringDocumentConfigService';
import { getOrCreateAutoDocumentSpec } from '../document-core/autoDocumentSpecService';
import { buildProjectMaterialSummary, type MaterialRole } from '../document-core/projectMaterialService';
import { applyKeywordRules, MATERIAL_ROLE_RULES } from '../document-core/documentSemanticRules';
import { resolveTemplateMaterialRoles } from '../document-core/materialRoleResolver';
import { evaluateDocumentReadiness } from '../document-validation/documentReadinessService';
import type { DocumentTemplate, FileBinding, PromptBinding } from './types';

export type PromptExecutionCategory = 'writer' | 'chapter' | 'extraction' | 'formatting' | 'reference';

type KnowledgeFilePath = { relativePath: string; chunkCount?: number; indexedAt?: number; status?: string };

function isUsableKnowledgeFile(file: KnowledgeFilePath) {
  return file.status !== 'disk' && file.status !== 'error' && Number(file.indexedAt || 0) > 0 && Number(file.chunkCount || 0) > 0;
}

function expandTemplateFileBindings(bindings: FileBinding[], files: KnowledgeFilePath[]) {
  if (bindings.length === 0) return bindings;
  const filePathSet = new Set(files.map(file => file.relativePath));
  const expanded: FileBinding[] = [];
  const seen = new Set<string>();
  for (const binding of bindings) {
    const normalizedPath = binding.filePath.replace(/^\/+|\/+$/gu, '');
    const matchedPaths = filePathSet.has(normalizedPath)
      ? [normalizedPath]
      : files.filter(file => file.relativePath.startsWith(`${normalizedPath}/`) && isUsableKnowledgeFile(file)).map(file => file.relativePath);
    for (const filePath of matchedPaths) {
      const key = `${binding.roleId}\n${filePath}`;
      if (seen.has(key)) continue;
      seen.add(key);
      expanded.push({ ...binding, filePath });
    }
  }
  return expanded;
}

export interface ResolvedPromptContent {
  id: string;
  roleId: string;
  name: string;
  content: string;
  source: 'custom' | 'file';
  contentHash: string;
  contentPreview: string;
  executionType: string;
  category: PromptExecutionCategory;
  bindingSource: 'projectRole';
}

export interface PromptBindingPlan {
  bindings: PromptBinding[];
  prompts: ResolvedPromptContent[];
  writerPrompts: ResolvedPromptContent[];
  chapterPrompts: ResolvedPromptContent[];
  extractionPrompts: ResolvedPromptContent[];
  formattingPrompts: ResolvedPromptContent[];
  referencePrompts: ResolvedPromptContent[];
  unresolvedRoles: string[];
  missingResourceRoles: string[];
}

function agentHome() {
  const dir = path.join(os.homedir(), '.customize-agent');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function templateStorePath() {
  return path.join(agentHome(), 'document-templates.json');
}

function promptConfigPath() {
  return path.join(agentHome(), 'prompts.json');
}

function sanitizeTemplate(template: DocumentTemplate): DocumentTemplate {
  return {
    ...template,
    id: template.id.replace(/[^a-zA-Z0-9_-]/gu, '-').slice(0, 80) || `template-${Date.now()}`,
    name: template.name || '未命名模板',
    description: template.description || '',
    category: template.category || '自定义',
    outputTitle: template.outputTitle || template.name || '文档',
    projectRoleConfigId: template.projectRoleConfigId || undefined,
    chapters: Array.isArray(template.chapters) && template.chapters.length > 0 ? template.chapters.map((chapter, index) => ({
      id: (chapter.id || `chapter-${index + 1}`).replace(/[^a-zA-Z0-9_-]/gu, '-').slice(0, 80),
      title: chapter.title || `第 ${index + 1} 章`,
      purpose: chapter.purpose || '',
      queries: Array.isArray(chapter.queries) ? chapter.queries.filter(Boolean) : [],
      requiredFacts: Array.isArray(chapter.requiredFacts) ? chapter.requiredFacts.filter(Boolean) : [],
      sections: Array.isArray(chapter.sections) ? chapter.sections.filter(Boolean) : [],
      tableSections: Array.isArray(chapter.tableSections) ? chapter.tableSections.filter(Boolean) : [],
      tableRequirements: Array.isArray(chapter.tableRequirements) ? chapter.tableRequirements.filter(Boolean) : [],
      pinnedEvidenceFilePaths: Array.isArray(chapter.pinnedEvidenceFilePaths) ? chapter.pinnedEvidenceFilePaths.filter(Boolean) : [],
    })) : [{ id: 'document', title: template.outputTitle || template.name || '文档', purpose: template.description || '', queries: [], requiredFacts: [] }],
    exportSettings: template.exportSettings,
    generationSettings: template.generationSettings,
    promptIds: Array.isArray(template.promptIds) ? template.promptIds.filter(Boolean) : [],
    boundFilePaths: Array.isArray(template.boundFilePaths) ? template.boundFilePaths.filter(Boolean) : [],
    promptBindings: Array.isArray(template.promptBindings)
      ? template.promptBindings.filter(item => item.promptId && item.roleId)
      : (Array.isArray(template.promptIds) ? template.promptIds.filter(Boolean).map(promptId => ({ promptId, roleId: 'chapter_generation' })) : []),
    fileBindings: Array.isArray(template.fileBindings)
      ? template.fileBindings.filter(item => item.filePath && item.roleId)
      : (Array.isArray(template.boundFilePaths) ? template.boundFilePaths.filter(Boolean).map(filePath => ({ filePath, roleId: 'reference' })) : []),
    builtIn: false,
  };
}

function readCustomTemplates(): DocumentTemplate[] {
  try {
    const file = templateStorePath();
    if (!fs.existsSync(file)) return [];
    return (JSON.parse(fs.readFileSync(file, 'utf-8')) as DocumentTemplate[]).map(sanitizeTemplate);
  } catch {
    return [];
  }
}

function writeCustomTemplates(templates: DocumentTemplate[]) {
  fs.writeFileSync(templateStorePath(), JSON.stringify(templates.map(sanitizeTemplate), null, 2), 'utf-8');
}

function readCustomPromptItems(): Array<{ id: string; name: string; content: string }> {
  try {
    const config = JSON.parse(fs.readFileSync(promptConfigPath(), 'utf-8')) as { customPrompts?: Array<{ id: string; name: string; content: string }> };
    return Array.isArray(config.customPrompts) ? config.customPrompts : [];
  } catch {
    return [];
  }
}

function promptContentHash(content: string) {
  return createHash('sha256').update(content).digest('hex').slice(0, 12);
}

function promptContentPreview(content: string) {
  return content.replace(/\s+/gu, ' ').trim().slice(0, 160);
}

function readPromptById(id: string) {
  const customPrompts = readCustomPromptItems();
  if (id.startsWith('custom:')) {
    const custom = customPrompts.find(item => item.id === id);
    return custom ? { id, name: custom.name, content: custom.content, source: 'custom' as const } : undefined;
  }
  if (id.startsWith('file:')) {
    const filePath = id.slice('file:'.length);
    if (fs.existsSync(filePath)) return { id, name: path.basename(path.dirname(filePath)) || filePath, content: fs.readFileSync(filePath, 'utf-8'), source: 'file' as const };
  }
  return undefined;
}

export function readPromptContents(promptBindings: PromptBinding[] = []): Array<{ id: string; roleId: string; name: string; content: string; source: 'custom' | 'file'; contentHash: string; contentPreview: string }> {
  if (promptBindings.length === 0) return [];
  const prompts: Array<{ id: string; roleId: string; name: string; content: string; source: 'custom' | 'file'; contentHash: string; contentPreview: string }> = [];
  for (const binding of promptBindings) {
    const prompt = readPromptById(binding.promptId);
    if (prompt) prompts.push({ ...prompt, roleId: binding.roleId, contentHash: promptContentHash(prompt.content), contentPreview: promptContentPreview(prompt.content) });
  }
  return prompts;
}

function categoryForPrompt(roleId: string, executionType: string, promptName = ''): PromptExecutionCategory {
  const text = `${roleId} ${executionType} ${promptName}`;
  if (/extract|extraction|抽取|清单|图纸|品牌|识别/u.test(text)) return 'extraction';
  if (/format|排版/u.test(text)) return 'formatting';
  if (/总控|writer|施工组织设计总控|写作主控/u.test(text)) return 'writer';
  if (/chapter_generation|method|schedule|quality|resource|safety|dangerous|施工|进度|质量|资源|安全|危大/u.test(text)) return 'chapter';
  return 'reference';
}

export function buildPromptBindingPlan(template: DocumentTemplate): PromptBindingPlan {
  const projectConfig = projectRoleConfigForTemplate(template);
  const roles = listDocumentRoles('prompt');
  const rawBindings = templatePromptBindings(template);
  const unresolvedRoles: string[] = [];
  const missingResourceRoles: string[] = [];
  if (projectConfig) {
    for (const item of projectConfig.promptRoles) {
      const role = roles.find(candidate => candidate.id === item.roleId);
      if (!role) {
        unresolvedRoles.push(item.roleId);
        continue;
      }
      const resourceIds = role.resourceIds?.length ? role.resourceIds : role.resourceId ? [role.resourceId] : [];
      if (resourceIds.length === 0) missingResourceRoles.push(item.roleId);
    }
  }
  const uniqueBindings = uniquePromptBindings(rawBindings);
  const prompts: ResolvedPromptContent[] = [];
  for (const binding of uniqueBindings) {
    const prompt = readPromptById(binding.promptId);
    if (!prompt) continue;
    const role = roles.find(candidate => candidate.id === binding.roleId);
    const executionType = role?.executionType || promptRoleExecutionTypeFromId(binding.roleId);
    const category = categoryForPrompt(binding.roleId, executionType, prompt.name);
    prompts.push({
      ...prompt,
      roleId: binding.roleId,
      contentHash: promptContentHash(prompt.content),
      contentPreview: promptContentPreview(prompt.content),
      executionType,
      category,
      bindingSource: 'projectRole',
    });
  }
  return {
    bindings: uniqueBindings,
    prompts,
    writerPrompts: prompts.filter(prompt => prompt.category === 'writer'),
    chapterPrompts: prompts.filter(prompt => prompt.category === 'chapter'),
    extractionPrompts: prompts.filter(prompt => prompt.category === 'extraction'),
    formattingPrompts: prompts.filter(prompt => prompt.category === 'formatting'),
    referencePrompts: prompts.filter(prompt => prompt.category === 'reference'),
    unresolvedRoles: [...new Set(unresolvedRoles)],
    missingResourceRoles: [...new Set(missingResourceRoles)],
  };
}

function promptRoleExecutionTypeFromId(roleId: string) {
  return promptExecutionTypeFromRoleId(roleId);
}

export function listDocumentTemplates(): DocumentTemplate[] {
  const configTemplates = readEngineeringDocumentConfig().templates;
  const customTemplates = readCustomTemplates().filter(template => !configTemplates.some(item => item.id === template.id));
  return [...configTemplates, ...customTemplates];
}

export function getDocumentTemplate(templateId: string): DocumentTemplate | undefined {
  return listDocumentTemplates().find(template => template.id === templateId);
}

export function saveDocumentTemplate(template: DocumentTemplate): DocumentTemplate {
  const sanitized = sanitizeTemplate(template);
  const templates = readCustomTemplates().filter(item => item.id !== sanitized.id);
  templates.push(sanitized);
  writeCustomTemplates(templates);
  return sanitized;
}

export async function validateDocumentTemplateRun(templateId: string, projectRoot = getProjectRoot()) {
  const template = getDocumentTemplate(templateId);
  const issues: Array<{ level: 'error' | 'warning'; message: string }> = [];
  if (!template) {
    return {
      issues: [{ level: 'error' as const, message: '文档模板不存在或已删除' }],
      fileDiagnostics: [],
      promptDiagnostics: [],
      config: undefined,
    };
  }
  const promptRoles = listDocumentRoles('prompt');
  const fileRoles = listDocumentRoles('file');
  const configId = defaultProjectRoleConfigIdForTemplate(template);
  const config = projectRoleConfigForTemplate(template);
  if (!configId) issues.push({ level: 'error', message: '模板未绑定项目角色配置，且未匹配到自动专业角色配置' });
  if (configId && !config) issues.push({ level: 'error', message: `项目角色配置不存在或已删除：${configId}` });
  if (template.promptIds?.length) issues.push({ level: 'warning', message: '模板存在旧 promptIds 字段残留，该字段已不参与生成，请清理模板历史数据。' });
  if (template.promptBindings?.length) issues.push({ level: 'warning', message: '模板存在旧 promptBindings 字段残留，该字段已不参与生成，请清理模板历史数据。' });
  if (template.boundFilePaths?.length) issues.push({ level: 'warning', message: '模板存在旧 boundFilePaths 字段残留，生成只使用项目角色配置和显式文件角色绑定。' });
  const promptBindings = templatePromptBindings(template);
  const explicitFileBindings = templateFileBindings(template);
  if (config && config.promptRoles.length === 0) issues.push({ level: 'error', message: '项目角色配置未配置提示词角色。' });
  if (config && config.promptRoles.length > 0 && promptBindings.length === 0) issues.push({ level: 'error', message: '项目角色配置中的提示词角色未绑定任何有效提示词资源。' });
  const resolvedProjectRoot = path.resolve(projectRoot);
  const files = listKnowledgeFiles(resolvedProjectRoot);
  const fileBindings = expandTemplateFileBindings(explicitFileBindings, files);
  if (explicitFileBindings.length === 0) issues.push({ level: 'error', message: '模板未绑定知识库文件。模板生成文件只允许使用显式绑定的知识库文件，请先在模板中绑定需要参与生成的资料。' });
  else if (fileBindings.length === 0) issues.push({ level: 'error', message: '模板绑定的知识库文件或文件夹不存在，请重新选择项目文件绑定。' });
  const fileMap = new Map(files.map(file => [file.relativePath, file]));
  for (const item of config?.fileRoles || []) {
    const role = fileRoles.find(candidate => candidate.id === item.roleId);
    if (!role) {
      issues.push({ level: 'error', message: `文件角色不存在：${item.roleId}` });
      continue;
    }
    const hasBinding = explicitFileBindings.some(binding => binding.roleId === item.roleId);
    if (!hasBinding) issues.push({ level: 'warning', message: `项目角色配置包含文件角色但模板未绑定资料：${role.name}` });
  }
  const fileDiagnostics = fileBindings.map(binding => {
    const role = fileRoles.find(item => item.id === binding.roleId);
    const file = fileMap.get(binding.filePath);
    if (!role) issues.push({ level: 'error', message: `文件角色不存在：${binding.roleId}` });
    if (!file) issues.push({ level: 'error', message: `知识库文件不存在：${binding.filePath}` });
    if (file && (file.status === 'disk' || file.indexedAt === 0)) issues.push({ level: 'warning', message: `知识库文件存在但尚未完成索引：${binding.filePath}` });
    if (file?.status === 'error') issues.push({ level: 'warning', message: `知识库文件索引失败：${binding.filePath}${file.errorMessage ? `，${file.errorMessage}` : ''}` });
    if (file && file.chunkCount === 0) issues.push({ level: 'warning', message: `知识库文件暂无可检索内容切片：${binding.filePath}` });
    return { ...binding, roleName: role?.name, exists: Boolean(file), indexed: Boolean(file && file.indexedAt > 0 && file.status !== 'disk'), chunkCount: file?.chunkCount ?? 0, vectorReady: Boolean(file && file.chunkCount > 0) };
  });
  const resolvedPrompts = readPromptContents(promptBindings);
  const configuredPromptRoleIds = new Set(config?.promptRoles.map(item => item.roleId) || []);
  for (const item of config?.promptRoles || []) {
    const role = promptRoles.find(candidate => candidate.id === item.roleId);
    if (!role) {
      issues.push({ level: 'error', message: `提示词角色不存在：${item.roleId}` });
      continue;
    }
    const resourceIds = role.resourceIds?.length ? role.resourceIds : role.resourceId ? [role.resourceId] : [];
    if (resourceIds.length === 0) issues.push({ level: 'error', message: `提示词角色未绑定资源：${role.name}` });
  }
  const promptDiagnostics = promptBindings.map(binding => {
    const role = promptRoles.find(item => item.id === binding.roleId);
    const prompt = resolvedPrompts.find(item => item.id === binding.promptId);
    if (!role) issues.push({ level: 'error', message: `提示词角色不存在：${binding.roleId}` });
    if (!configuredPromptRoleIds.has(binding.roleId)) issues.push({ level: 'error', message: `提示词绑定不属于当前项目角色配置：${binding.roleId}` });
    if (!prompt) issues.push({ level: 'error', message: `提示词不存在：${binding.promptId}` });
    if (prompt && !prompt.content.trim()) issues.push({ level: 'warning', message: `提示词为空：${prompt.name}` });
    return {
      ...binding,
      roleName: role?.name,
      promptTitle: prompt?.name,
      promptSource: prompt?.source,
      contentLength: prompt?.content.length ?? 0,
      contentHash: prompt?.contentHash,
      contentPreview: prompt?.contentPreview,
      exists: Boolean(prompt),
    };
  });
  let readiness;
  if (template) {
    const projectMaterialSummary = buildProjectMaterialSummary(resolvedProjectRoot, {
      boundFilePaths: fileBindings.map(binding => binding.filePath),
      boundFileRoles: boundFileRolesForMaterialSummary(fileBindings),
    });
    const resolvedMaterialRoles = resolveTemplateMaterialRoles(template, projectMaterialSummary);
    readiness = evaluateDocumentReadiness({
      template,
      spec: getOrCreateAutoDocumentSpec(template).spec,
      summary: projectMaterialSummary,
      resolvedRoles: resolvedMaterialRoles,
    });
    for (const message of readiness.blockingIssues) issues.push({ level: 'error', message: `生成准备度不足：${message}` });
    for (const message of readiness.warnings) issues.push({ level: 'warning', message });
  }
  return { templateId, projectRoleConfigId: configId, fileDiagnostics, promptDiagnostics, readiness, issues };
}

export function deleteDocumentTemplate(templateId: string) {
  const configTemplateIds = new Set(readEngineeringDocumentConfig().templates.map(template => template.id));
  if (configTemplateIds.has(templateId)) throw new Error('Configured template cannot be deleted');
  writeCustomTemplates(readCustomTemplates().filter(item => item.id !== templateId));
}

export function duplicateDocumentTemplate(templateId: string): DocumentTemplate {
  const source = getDocumentTemplate(templateId);
  if (!source) throw new Error('Document template not found');
  const duplicated = sanitizeTemplate({ ...source, id: `${source.id}-copy-${Date.now()}`, name: `${source.name} Copy`, builtIn: false });
  const templates = readCustomTemplates();
  templates.push(duplicated);
  writeCustomTemplates(templates);
  return duplicated;
}

function matchesTextPattern(text: string, pattern: string) {
  try { return new RegExp(pattern, 'iu').test(text); } catch { return text.includes(pattern); }
}

function configuredChapterTitleFilters(template: DocumentTemplate) {
  const templateText = `${template.name} ${template.category} ${template.outputTitle} ${template.description}`;
  return readEngineeringDocumentConfig().chapterTitleFilters.filter(filter => filter.templateMatchers.some(pattern => matchesTextPattern(templateText, pattern)));
}

export function violatesConfiguredChapterTitleForbiddenFilter(title: string, template: DocumentTemplate) {
  return configuredChapterTitleFilters(template).some(filter => {
    if (filter.minLength && title.length < filter.minLength) return true;
    if (filter.maxLength && title.length > filter.maxLength) return true;
    return filter.forbiddenPatterns.some(pattern => matchesTextPattern(title, pattern));
  });
}

export function violatesConfiguredChapterTitleFilter(title: string, template: DocumentTemplate) {
  return configuredChapterTitleFilters(template).some(filter => {
    if (filter.minLength && title.length < filter.minLength) return true;
    if (filter.maxLength && title.length > filter.maxLength) return true;
    if (filter.forbiddenPatterns.some(pattern => matchesTextPattern(title, pattern))) return true;
    return filter.requiredPatterns.length > 0 && !filter.requiredPatterns.some(pattern => matchesTextPattern(title, pattern));
  });
}

export function defaultProjectRoleConfigIdForTemplate(template: DocumentTemplate) {
  return template.projectRoleConfigId || undefined;
}

export function projectRoleConfigForTemplate(template: DocumentTemplate) {
  const configId = defaultProjectRoleConfigIdForTemplate(template);
  return configId ? getProjectRoleConfig(configId) : undefined;
}

function materialRolesForFileRole(role?: { id?: string; name?: string; description?: string; processingType?: string }): MaterialRole[] {
  const roles = new Set<MaterialRole>(['project_overview']);
  const processingType = role?.processingType || '';
  if (processingType === 'rule') roles.add('requirement_document');
  if (processingType === 'table') roles.add('structured_data');
  if (processingType === 'drawing') roles.add('design_specification');
  if (processingType === 'specification') roles.add('technical_specification');

  const text = `${role?.id || ''} ${role?.name || ''} ${role?.description || ''} ${processingType}`;
  for (const inferred of applyKeywordRules(text, MATERIAL_ROLE_RULES)) roles.add(inferred);
  if (/清单|工程量|范围|施工范围|工作内容|boq|scope/iu.test(text)) roles.add('scope_description');
  if (/工期|进度|质量|安全|文明|环保|验收|schedule|quality|safety/iu.test(text)) roles.add('schedule_quality_safety');
  if (/重点|难点|风险|约束|现场|限制|管线|危大|risk|constraint/iu.test(text)) roles.add('risk_constraints');
  if (/材料|设备|品牌|资源|人员|机械|采购|resource|brand|equipment/iu.test(text)) roles.add('resource_recommendation');
  if (/招标|响应|实质性|评审|废标|条款|要求|tender|requirement/iu.test(text)) roles.add('requirement_document');
  if (/图纸|设计|说明|drawing|design/iu.test(text)) roles.add('design_specification');
  return [...roles];
}

export function boundFileRolesForMaterialSummary(bindings: FileBinding[]) {
  const grouped = new Map<string, MaterialRole[]>();
  const fileRoles = listDocumentRoles('file');
  for (const binding of bindings) {
    const role = fileRoles.find(item => item.id === binding.roleId);
    const roles = materialRolesForFileRole(role);
    grouped.set(binding.filePath, [...new Set([...(grouped.get(binding.filePath) || []), ...roles])]);
  }
  return [...grouped.entries()].map(([filePath, roles]) => ({ filePath, roles }));
}

function promptExecutionTypeFromRoleId(roleId: string) {
  if (/extract|extraction|抽取|清单|图纸|品牌/u.test(roleId)) return 'fact_extraction';
  if (/validation|校验|审查|审核/u.test(roleId)) return 'validation';
  if (/format|排版/u.test(roleId)) return 'formatting';
  if (/writer|method|schedule|quality|resource|safety|dangerous|施工|进度|质量|资源|安全|危大/u.test(roleId)) return 'chapter_generation';
  return 'reference';
}

function uniquePromptBindings(bindings: PromptBinding[]) {
  const seen = new Set<string>();
  const result: PromptBinding[] = [];
  for (const binding of bindings) {
    const key = `${binding.roleId}:${binding.promptId}`;
    if (!binding.promptId || !binding.roleId || seen.has(key)) continue;
    seen.add(key);
    result.push(binding);
  }
  return result;
}

export function templatePromptBindings(template: DocumentTemplate): PromptBinding[] {
  const config = projectRoleConfigForTemplate(template);
  if (!config) return [];
  const roles = listDocumentRoles('prompt');
  const bindings: PromptBinding[] = [];
  for (const item of [...config.promptRoles].sort((a, b) => a.order - b.order)) {
    const role = roles.find(candidate => candidate.id === item.roleId);
    const resourceIds = role ? (role.resourceIds?.length ? role.resourceIds : role.resourceId ? [role.resourceId] : []) : [];
    if (!role || resourceIds.length === 0) continue;
    bindings.push(...resourceIds.map(promptId => ({ promptId, roleId: role.id })));
  }
  return uniquePromptBindings(bindings);
}

export function templateFileBindings(template: DocumentTemplate): FileBinding[] {
  return template.fileBindings?.length ? template.fileBindings : (template.boundFilePaths ?? []).map(filePath => ({ filePath, roleId: 'reference' }));
}
