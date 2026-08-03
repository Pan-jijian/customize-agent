import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { getProjectRoot, listKnowledgeFiles } from '../knowledge/kbService';
import { getProjectRoleConfig, listDocumentRoles } from '../document-core/documentRoleService';
import { readEngineeringDocumentConfig } from '../document-validation/engineeringDocumentConfigService';
import type { MaterialRole } from '../document-core/projectMaterialService';
import type { DocumentTemplate, FileBinding, PromptBinding } from './types';

export type PromptExecutionCategory = 'writer' | 'chapter' | 'extraction' | 'validation' | 'formatting' | 'reference';

export interface ResolvedPromptContent {
  id: string;
  roleId: string;
  name: string;
  content: string;
  executionType: string;
  category: PromptExecutionCategory;
  bindingSource: 'template' | 'projectRole' | 'fallback' | 'runtimeRequired';
}

export interface PromptBindingPlan {
  bindings: PromptBinding[];
  prompts: ResolvedPromptContent[];
  writerPrompts: ResolvedPromptContent[];
  chapterPrompts: ResolvedPromptContent[];
  extractionPrompts: ResolvedPromptContent[];
  validationPrompts: ResolvedPromptContent[];
  formattingPrompts: ResolvedPromptContent[];
  referencePrompts: ResolvedPromptContent[];
  unresolvedRoles: string[];
  fallbackBindings: Array<{ roleId: string; promptId: string; reason: string }>;
  runtimeRequiredBindings: Array<{ roleId: string; promptId: string; reason: string }>;
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

function readPromptById(id: string) {
  const customPrompts = readCustomPromptItems();
  if (id.startsWith('custom:')) {
    const custom = customPrompts.find(item => item.id === id);
    return custom ? { id, name: custom.name, content: custom.content } : undefined;
  }
  if (id.startsWith('file:')) {
    const filePath = id.slice('file:'.length);
    if (fs.existsSync(filePath)) return { id, name: path.basename(path.dirname(filePath)) || filePath, content: fs.readFileSync(filePath, 'utf-8') };
  }
  return undefined;
}

export function readPromptContents(promptBindings: PromptBinding[] = []): Array<{ id: string; roleId: string; name: string; content: string }> {
  if (promptBindings.length === 0) return [];
  const prompts: Array<{ id: string; roleId: string; name: string; content: string }> = [];
  for (const binding of promptBindings) {
    const prompt = readPromptById(binding.promptId);
    if (prompt) prompts.push({ ...prompt, roleId: binding.roleId });
  }
  return prompts;
}

function categoryForPrompt(roleId: string, executionType: string, promptName = ''): PromptExecutionCategory {
  const text = `${roleId} ${executionType} ${promptName}`;
  if (/validation|校验|审查|审核|标准/u.test(text)) return 'validation';
  if (/extract|extraction|抽取|清单|图纸|品牌|识别/u.test(text)) return 'extraction';
  if (/format|排版/u.test(text)) return 'formatting';
  if (/总控|writer|施工组织设计总控|写作主控/u.test(text)) return 'writer';
  if (/chapter_generation|method|schedule|quality|resource|safety|dangerous|施工|进度|质量|资源|安全|危大/u.test(text)) return 'chapter';
  return 'reference';
}

function findPromptIdsByName(pattern: RegExp) {
  return readCustomPromptItems().filter(prompt => pattern.test(prompt.name || '')).map(prompt => prompt.id);
}

function isConstructionOrganizationTemplate(template: DocumentTemplate) {
  return /施工组织设计|施工方案|危大工程|安全文明施工/u.test(`${template.name} ${template.category} ${template.outputTitle} ${template.description}`);
}

export function buildPromptBindingPlan(template: DocumentTemplate): PromptBindingPlan {
  const projectConfig = projectRoleConfigForTemplate(template);
  const roles = listDocumentRoles('prompt');
  const rawBindings = templatePromptBindings(template);
  const fallbackBindings: PromptBindingPlan['fallbackBindings'] = [];
  const runtimeRequiredBindings: PromptBindingPlan['runtimeRequiredBindings'] = [];
  const unresolvedRoles: string[] = [];
  if (projectConfig) {
    for (const item of projectConfig.promptRoles) {
      const role = roles.find(candidate => candidate.id === item.roleId);
      if (!role) unresolvedRoles.push(item.roleId);
      const hasBinding = rawBindings.some(binding => binding.roleId === item.roleId || binding.roleId === promptExecutionTypeFromRoleId(item.roleId));
      if (!hasBinding) fallbackBindings.push({ roleId: item.roleId, promptId: '', reason: '项目角色提示词未解析到可用提示词资源' });
    }
  }
  const bindings = [...rawBindings];
  if (isConstructionOrganizationTemplate(template)) {
    const hasWriter = readPromptContents(bindings).some(prompt => categoryForPrompt(prompt.roleId, roles.find(role => role.id === prompt.roleId)?.executionType || promptRoleExecutionTypeFromId(prompt.roleId), prompt.name) === 'writer');
    if (!hasWriter) {
      for (const promptId of findPromptIdsByName(/施工组织设计总控|总控|施工组织/u).slice(0, 1)) {
        bindings.push({ promptId, roleId: 'runtime-construction-writer' });
        runtimeRequiredBindings.push({ roleId: 'runtime-construction-writer', promptId, reason: '施工组织设计运行时必需写作总控提示词' });
      }
    }
  }
  const uniqueBindings = uniquePromptBindings(bindings);
  const prompts: ResolvedPromptContent[] = [];
  for (const binding of uniqueBindings) {
    const prompt = readPromptById(binding.promptId);
    if (!prompt) continue;
    const role = roles.find(candidate => candidate.id === binding.roleId);
    const executionType = role?.executionType || promptRoleExecutionTypeFromId(binding.roleId);
    const category = categoryForPrompt(binding.roleId, executionType, prompt.name);
    const bindingSource = runtimeRequiredBindings.some(item => item.roleId === binding.roleId && item.promptId === binding.promptId)
      ? 'runtimeRequired' as const
      : projectConfig ? 'projectRole' as const : 'template' as const;
    prompts.push({ ...prompt, roleId: binding.roleId, executionType, category, bindingSource });
  }
  return {
    bindings: uniqueBindings,
    prompts,
    writerPrompts: prompts.filter(prompt => prompt.category === 'writer'),
    chapterPrompts: prompts.filter(prompt => prompt.category === 'chapter'),
    extractionPrompts: prompts.filter(prompt => prompt.category === 'extraction'),
    validationPrompts: prompts.filter(prompt => prompt.category === 'validation'),
    formattingPrompts: prompts.filter(prompt => prompt.category === 'formatting'),
    referencePrompts: prompts.filter(prompt => prompt.category === 'reference'),
    unresolvedRoles: [...new Set(unresolvedRoles)],
    fallbackBindings,
    runtimeRequiredBindings,
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
  const promptBindings = templatePromptBindings(template);
  const explicitFileBindings = templateFileBindings(template);
  if (promptBindings.length === 0) issues.push({ level: 'warning', message: '模板未绑定提示词角色，生成会缺少说明提示词约束' });
  const resolvedProjectRoot = path.resolve(projectRoot);
  const files = listKnowledgeFiles(resolvedProjectRoot);
  const fileBindings = explicitFileBindings;
  if (fileBindings.length === 0) issues.push({ level: 'error', message: '模板未绑定知识库文件。模板生成文件只允许使用显式绑定的知识库文件，请先在模板中绑定需要参与生成的资料。' });
  const fileMap = new Map(files.map(file => [file.relativePath, file]));
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
  const promptDiagnostics = promptBindings.map(binding => {
    const role = promptRoles.find(item => item.id === binding.roleId);
    const prompt = resolvedPrompts.find(item => item.id === binding.promptId);
    if (!role) issues.push({ level: 'error', message: `提示词角色不存在：${binding.roleId}` });
    if (!prompt) issues.push({ level: 'error', message: `提示词不存在：${binding.promptId}` });
    if (prompt && !prompt.content.trim()) issues.push({ level: 'warning', message: `提示词为空：${prompt.name}` });
    return { ...binding, roleName: role?.name, promptTitle: prompt?.name, exists: Boolean(prompt), contentLength: prompt?.content.length ?? 0 };
  });
  return { templateId, projectRoleConfigId: configId, fileDiagnostics, promptDiagnostics, issues };
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

function materialRolesForFileRole(roleId: string): MaterialRole[] {
  if (/requirement|response|rule|需求|规则|评审|实质/u.test(roleId)) return ['requirement_document', 'technical_specification', 'schedule_quality_safety'];
  if (/table|sheet|data|scope|quantity|表格|列表|明细|数量|数据|范围/u.test(roleId)) return ['structured_data', 'scope_description', 'budget_cost'];
  if (/drawing|drawings|image|map|design|设计|图像|地图/u.test(roleId)) return ['design_specification'];
  if (/schedule|quality|safety|progress|周期|进度|质量|安全/u.test(roleId)) return ['schedule_quality_safety', 'technical_specification'];
  if (/risk|constraints|重点|难点|约束/u.test(roleId)) return ['risk_constraints', 'addendum', 'requirement_document'];
  if (/material|equipment|brand|resource|材料|设备|品牌|资源/u.test(roleId)) return ['resource_recommendation', 'structured_data', 'technical_specification'];
  if (/enterprise|reference|经验|体系/u.test(roleId)) return ['project_overview', 'technical_specification'];
  return ['project_overview'];
}

export function boundFileRolesForMaterialSummary(bindings: FileBinding[]) {
  const grouped = new Map<string, MaterialRole[]>();
  for (const binding of bindings) {
    grouped.set(binding.filePath, [...new Set([...(grouped.get(binding.filePath) || []), ...materialRolesForFileRole(binding.roleId)])]);
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

function fallbackPromptIdsForRole(roleId: string, roleName = '') {
  const prompts = readCustomPromptItems();
  const text = `${roleId} ${roleName}`;
  const candidates = prompts.filter(prompt => {
    const name = prompt.name || '';
    if (/validation|校验|审查|审核/u.test(text)) return /校验|审查|审核|标准/u.test(name);
    if (/writer|施工组织|construction-organization/u.test(text)) return /施工组织设计总控|总控|施工组织/u.test(name);
    if (/method|施工方法/u.test(text)) return /施工方法|主要施工/u.test(name);
    if (/schedule|quality|进度|工期|质量/u.test(text)) return /工期|进度|质量/u.test(name);
    if (/resource|人材机|资源/u.test(text)) return /人材机|资源|材料|设备/u.test(name);
    if (/safety|文明|安全/u.test(text)) return /安全|文明/u.test(name);
    if (/dangerous|危大/u.test(text)) return /危大|危险性/u.test(name);
    if (/extract|extraction|抽取|清单|图纸|品牌/u.test(text)) return /抽取|识别|清单|图纸|品牌|总控/u.test(name);
    return false;
  });
  return candidates.slice(0, 2).map(prompt => prompt.id);
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
  if (config) {
    const roles = listDocumentRoles('prompt');
    const bindings: PromptBinding[] = [];
    for (const item of [...config.promptRoles].sort((a, b) => a.order - b.order)) {
      const role = roles.find(candidate => candidate.id === item.roleId);
      const resourceIds = role ? (role.resourceIds?.length ? role.resourceIds : role.resourceId ? [role.resourceId] : []) : [];
      const promptIds = resourceIds.length > 0 ? resourceIds : fallbackPromptIdsForRole(item.roleId, role?.name);
      const runtimeRoleId = role?.id || promptExecutionTypeFromRoleId(item.roleId);
      bindings.push(...promptIds.map(promptId => ({ promptId, roleId: runtimeRoleId })));
    }
    if (bindings.length > 0) return uniquePromptBindings(bindings);
  }
  return template.promptBindings?.length ? template.promptBindings : (template.promptIds ?? []).map(promptId => ({ promptId, roleId: 'chapter_generation' }));
}

export function templateFileBindings(template: DocumentTemplate): FileBinding[] {
  return template.fileBindings?.length ? template.fileBindings : (template.boundFilePaths ?? []).map(filePath => ({ filePath, roleId: 'reference' }));
}
