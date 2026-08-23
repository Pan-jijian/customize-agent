import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { getProjectRoot, listKnowledgeFiles } from '../knowledge/kbService';
import { getProjectRoleConfig, listDocumentRoles } from '../document-core/documentRoleService';
import { readEngineeringDocumentConfig } from '../document-validation/engineeringDocumentConfigService';
import { getOrCreateAutoDocumentSpec } from '../document-core/autoDocumentSpecService';
import { buildProjectMaterialSummary } from '../document-core/projectMaterialService';
import { resolveTemplateMaterialRoles } from '../document-core/materialRoleResolver';
import { evaluateDocumentReadiness } from '../document-validation/documentReadinessService';
import type { DocumentTemplate, ProjectBinding, PromptBinding } from './types';
import { templateProjectBindings } from './projectMaterialProfile';
import { charsPerPageForSettings, explicitLengthTargets } from './budget';
import { referenceStructureSuggestion as buildReferenceStructureSuggestion } from './templateReferenceService';

export type PromptExecutionCategory = 'writer' | 'chapter' | 'extraction' | 'formatting' | 'reference';

type KnowledgeFilePath = { relativePath: string; chunkCount?: number; indexedAt?: number; status?: string };

function isUsableKnowledgeFile(file: KnowledgeFilePath) {
  return file.status !== 'disk' && file.status !== 'error' && Number(file.indexedAt || 0) > 0 && Number(file.chunkCount || 0) > 0;
}

function expandProjectBindings(bindings: ProjectBinding[], files: KnowledgeFilePath[]) {
  if (bindings.length === 0) return [];
  const filePathSet = new Set(files.map(file => file.relativePath));
  const expanded: string[] = [];
  const seen = new Set<string>();
  for (const binding of bindings) {
    const normalizedPath = binding.materialRootPath.replace(/^\/+|\/+$/gu, '');
    const matchedPaths = filePathSet.has(normalizedPath)
      ? [normalizedPath]
      : files.filter(file => file.relativePath.startsWith(`${normalizedPath}/`) && isUsableKnowledgeFile(file)).map(file => file.relativePath);
    for (const filePath of matchedPaths) {
      if (seen.has(filePath)) continue;
      seen.add(filePath);
      expanded.push(filePath);
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
  /** 完整绑定链路：projectRole:<configId>:<roleId>:order=<n> */
  bindingSource: string;
  /** 项目角色配置 ID */
  roleConfigId?: string;
  /** 提示词角色名称 */
  roleName?: string;
  /** 在项目角色配置中的排序 */
  order?: number;
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

/** 计算模版内容签名（排除版本元数据），用于检测内容是否发生实质性变更 */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort().map(key => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function templateContentSignature(template: DocumentTemplate): string {
  const { version, updatedAt, changeLog, ...content } = template as DocumentTemplate & { version?: unknown; updatedAt?: unknown; changeLog?: unknown };
  return createHash('sha256').update(stableJson(content)).digest('hex');
}

function sanitizeTemplate(template: DocumentTemplate): DocumentTemplate {
  return {
    ...template,
    id: template.id.replace(/[^a-zA-Z0-9_-]/gu, '-').slice(0, 80) || `template-${Date.now()}`,
    name: template.name || '未命名模板',
    description: template.description || '',
    category: template.category || '自定义',
    outputTitle: template.outputTitle || template.name || '文档',
    version: Number.isFinite(template.version) && (template.version as number) > 0 ? Math.floor(template.version as number) : 1,
    updatedAt: Number.isFinite(template.updatedAt) ? template.updatedAt : Date.now(),
    changeLog: Array.isArray(template.changeLog) ? template.changeLog.filter((e: unknown) => e && typeof e === 'object' && Number.isFinite((e as Record<string, unknown>).version) && typeof (e as Record<string, unknown>).summary === 'string').slice(0, 50) : [],
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
      tablePlans: Array.isArray(chapter.tablePlans) ? chapter.tablePlans : [],
      pinnedEvidenceFilePaths: Array.isArray(chapter.pinnedEvidenceFilePaths) ? chapter.pinnedEvidenceFilePaths.filter(Boolean) : [],
    })) : [{ id: 'document', title: template.outputTitle || template.name || '文档', purpose: template.description || '', queries: [], requiredFacts: [] }],
    exportSettings: template.exportSettings,
    generationSettings: template.generationSettings,
    promptIds: Array.isArray(template.promptIds) ? template.promptIds.filter(Boolean) : [],
    projectBindings: Array.isArray(template.projectBindings)
      ? template.projectBindings.filter(item => item.materialRootPath).map(item => ({ materialRootPath: item.materialRootPath.replace(/^\/+|\/+$/gu, '') }))
      : templateProjectBindings(template),
    promptBindings: Array.isArray(template.promptBindings)
      ? template.promptBindings.filter(item => item.promptId && item.roleId)
      : (Array.isArray(template.promptIds) ? template.promptIds.filter(Boolean).map(promptId => ({ promptId, roleId: 'chapter_generation' })) : []),
    builtIn: false,
  };
}

function readCustomTemplates(): DocumentTemplate[] {
  try {
    const file = templateStorePath();
    if (!fs.existsSync(file)) return [];
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!Array.isArray(raw)) {
      fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
      return [];
    }
    return (raw as DocumentTemplate[]).map(sanitizeTemplate);
  } catch {
    try {
      const file = templateStorePath();
      if (fs.existsSync(file)) fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
    } catch {
      // 备份失败，放弃
    }
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
    const configItem = projectConfig?.promptRoles.find(item => item.roleId === binding.roleId);
    const executionType = role?.executionType || promptRoleExecutionTypeFromId(binding.roleId);
    const category = categoryForPrompt(binding.roleId, executionType, prompt.name);
    const bindingSource = `projectRole:${projectConfig?.id || 'unknown'}:${binding.roleId}:order=${configItem?.order ?? 0}`;
    prompts.push({
      ...prompt,
      roleId: binding.roleId,
      contentHash: promptContentHash(prompt.content),
      contentPreview: promptContentPreview(prompt.content),
      executionType,
      category,
      bindingSource,
      roleConfigId: projectConfig?.id,
      roleName: role?.name,
      order: configItem?.order,
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

/** 获取指定版本的模版溯源信息（不保留历史内容快照，仅用于溯源展示） */
export function getTemplateAtVersion(templateId: string, reqVersion: number): { template: DocumentTemplate; history: Array<{ version: number; timestamp: number; summary: string }>; currentVersion: number } | undefined {
  const template = getDocumentTemplate(templateId);
  if (!template) return undefined;
  const currentVersion = template.version || 1;
  const clampedVersion = Math.max(1, Math.min(reqVersion, currentVersion));
  const history = (template.changeLog || []).filter(e => e.version <= clampedVersion);
  return { template: { ...template, version: clampedVersion }, history, currentVersion };
}

export function saveDocumentTemplate(template: DocumentTemplate): DocumentTemplate {
  const sanitized = sanitizeTemplate(template);
  const existing = readCustomTemplates().find(item => item.id === sanitized.id);
  const now = Date.now();
  let nextVersion: number;
  let changeLog: Array<{ version: number; timestamp: number; summary: string }>;
  if (existing && templateContentSignature(existing) !== templateContentSignature(sanitized)) {
    // 内容变更：递增版本
    nextVersion = (existing.version || 0) + 1;
    const chapterTitles = sanitized.chapters.map(c => c.title).join('、');
    const summary = chapterTitles ? `章节结构调整：${chapterTitles.slice(0, 80)}${chapterTitles.length > 80 ? '…' : ''}` : '模版内容已更新';
    changeLog = [{ version: nextVersion, timestamp: now, summary }, ...(existing.changeLog || [])].slice(0, 50);
  } else if (existing) {
    // 内容未变更：保留现有版本和日志（防止客户端传旧版本导致回退）
    nextVersion = existing.version || 1;
    changeLog = existing.changeLog || [];
  } else {
    // 新建模版
    nextVersion = 1;
    changeLog = [{ version: 1, timestamp: now, summary: '创建模版' }];
  }
  const versioned = { ...sanitized, version: nextVersion, updatedAt: now, changeLog };
  const templates = readCustomTemplates().filter(item => item.id !== sanitized.id);
  templates.push(versioned);
  writeCustomTemplates(templates);
  return versioned;
}

export async function validateDocumentTemplateRun(templateId: string, projectRoot = getProjectRoot(), options: { requirement?: string } = {}) {
  const template = getDocumentTemplate(templateId);
  const issues: Array<{ level: 'error' | 'warning'; message: string }> = [];
  if (!template) {
    return {
      issues: [{ level: 'error' as const, message: '文档模板不存在或已删除' }],
      fileDiagnostics: [],
      promptDiagnostics: [],
      roleDiagnostics: [],
      readiness: undefined,
      strategyPreview: undefined,
      config: undefined,
    };
  }
  const promptRoles = listDocumentRoles('prompt');
  const configId = defaultProjectRoleConfigIdForTemplate(template);
  const config = projectRoleConfigForTemplate(template);
  if (!configId) issues.push({ level: 'error', message: '模板未绑定项目角色配置，且未匹配到自动专业角色配置' });
  if (configId && !config) issues.push({ level: 'error', message: `项目角色配置不存在或已删除：${configId}` });
  if (template.promptIds?.length) issues.push({ level: 'warning', message: '模板存在旧 promptIds 字段残留，该字段已不参与生成，请清理模板历史数据。' });
  if (template.promptBindings?.length) issues.push({ level: 'warning', message: '模板存在旧 promptBindings 字段残留，该字段已不参与生成，请清理模板历史数据。' });
  const promptBindings = templatePromptBindings(template);
  const projectBindings = templateProjectBindings(template);
  if (config && config.promptRoles.length === 0) issues.push({ level: 'error', message: '项目角色配置未配置提示词角色。' });
  if (config && config.promptRoles.length > 0 && promptBindings.length === 0) issues.push({ level: 'error', message: '项目角色配置中的提示词角色未绑定任何有效提示词资源。' });
  const resolvedProjectRoot = path.resolve(projectRoot);
  const files = listKnowledgeFiles(resolvedProjectRoot);
  const materialFilePaths = expandProjectBindings(projectBindings, files);
  if (projectBindings.length === 0) issues.push({ level: 'error', message: '模板未绑定项目资料包，请先选择需要参与生成的项目文件夹。' });
  else if (materialFilePaths.length === 0) issues.push({ level: 'error', message: '模板绑定的项目资料包不存在或没有可用索引文件，请重新选择项目资料包。' });
  let previewMaterialSummary;
  if (template) {
    previewMaterialSummary = buildProjectMaterialSummary(resolvedProjectRoot, {
      requirement: options.requirement,
      boundFilePaths: materialFilePaths,
    });
    if (projectBindings.length === 0 && !previewMaterialSummary.source.ambiguous && previewMaterialSummary.source.selectedFiles > 0) {
      const index = issues.findIndex(issue => issue.level === 'error' && issue.message === '模板未绑定项目资料包，请先选择需要参与生成的项目文件夹。');
      if (index >= 0) issues.splice(index, 1);
    }
  }
  const fileMap = new Map(files.map(file => [file.relativePath, file]));
  const notIndexedWarnings: Array<{ level: 'warning'; message: string }> = [];
  const fileDiagnostics = materialFilePaths.map(filePath => {
    const file = fileMap.get(filePath);
    if (!file) issues.push({ level: 'error', message: `知识库文件不存在：${filePath}` });
    if (file && (file.status === 'disk' || file.indexedAt === 0)) notIndexedWarnings.push({ level: 'warning', message: `知识库文件存在但尚未完成索引：${filePath}` });
    if (file?.status === 'error') issues.push({ level: 'warning', message: `知识库文件索引失败：${filePath}${file.errorMessage ? `，${file.errorMessage}` : ''}` });
    if (file && file.chunkCount === 0) issues.push({ level: 'warning', message: `知识库文件暂无可检索内容切片：${filePath}` });
    return { filePath, roleId: 'project_material', roleName: '项目资料包', exists: Boolean(file), indexed: Boolean(file && file.indexedAt > 0 && file.status !== 'disk'), chunkCount: file?.chunkCount ?? 0, vectorReady: Boolean(file && file.chunkCount > 0) };
  });
  const existingFileCount = fileDiagnostics.filter(item => item.exists).length;
  const unindexedFileCount = fileDiagnostics.filter(item => item.exists && !item.indexed).length;
  if (existingFileCount > 0 && unindexedFileCount === existingFileCount) {
    // 资料包内文件全部尚未完成解析入库，运行时检索拿不到内容，升级为阻断错误而非仅告警
    issues.push({ level: 'error', message: `模板绑定的项目资料包（${existingFileCount} 份文件）均尚未完成解析入库，请等待后台索引完成后再运行模板` });
  } else {
    issues.push(...notIndexedWarnings);
  }
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
  // B2 绑定链路：项目角色配置中每个提示词角色的完整链路状态（含未绑定提示词的角色）
  const roleDiagnostics = (config?.promptRoles || []).map(item => {
    const role = promptRoles.find(candidate => candidate.id === item.roleId);
    const resourceIds = role ? (role.resourceIds?.length ? role.resourceIds : role.resourceId ? [role.resourceId] : []) : [];
    const boundPromptIds = promptBindings.filter(binding => binding.roleId === item.roleId).map(binding => binding.promptId);
    const status = !role ? 'role_missing' : resourceIds.length === 0 ? 'missing_resource' : boundPromptIds.length === 0 ? 'missing_prompt' : 'ok';
    return { roleId: item.roleId, roleName: role?.name, order: item.order, resourceIds, boundPromptIds, status };
  });
  // 多提示词规则冲突预检（动态 import 规避 templateStore ↔ promptRuleExtraction 模块环）
  if (resolvedPrompts.length > 1) {
    try {
      const { detectPromptRuleConflicts } = await import('./promptRuleExtraction');
      const conflicts = detectPromptRuleConflicts(resolvedPrompts.map(prompt => ({ promptId: prompt.id, name: prompt.name, roleId: prompt.roleId, content: prompt.content })));
      for (const conflict of conflicts) issues.push({ level: conflict.level, message: `提示词规则冲突：${conflict.message}` });
    } catch {
      // 冲突检测失败不影响模板校验主流程
    }
  }
  let readiness;
  if (template) {
    const projectMaterialSummary = previewMaterialSummary || buildProjectMaterialSummary(resolvedProjectRoot, {
      requirement: options.requirement,
      boundFilePaths: materialFilePaths,
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
  // U1 生成前体检：预估生成策略与预算（目标字数为近似估算；动态 import 规避 templateStore ↔ rolePipeline 模块环）
  let strategyPreview;
  try {
    const spec = getOrCreateAutoDocumentSpec(template).spec;
    const { effectiveTemplateChapters } = await import('./outline');
    const previewChapters = effectiveTemplateChapters(template, spec);
    const settings = template.generationSettings || template.exportSettings;
    const charsPerPage = charsPerPageForSettings(template.exportSettings || template.generationSettings);
    const explicit = explicitLengthTargets(options.requirement || '');
    const settingPages = settings?.targetPages?.target || settings?.targetPages?.min;
    const estimatedTargetChars = explicit.targetChars || (explicit.targetPages ? explicit.targetPages * charsPerPage : undefined) || (settingPages ? settingPages * charsPerPage : undefined);
    const specMinTotal = previewChapters.reduce((sum, chapter) => sum + Math.max(
      spec.chapterRules.find(rule => rule.id === chapter.id || rule.title === chapter.title)?.minWords || 0,
      spec.dynamicChapterRule.minWordsPerChapter || 0,
    ), 0);
    const previewTargetWords = Math.round(estimatedTargetChars || specMinTotal || previewChapters.length * 1200);
    const previewEvidenceCount = materialFilePaths.reduce((sum, filePath) => sum + (fileMap.get(filePath)?.chunkCount ?? 0), 0);
    const { previewGenerationBudgetForTemplate } = await import('./generationBudget');
    strategyPreview = previewGenerationBudgetForTemplate({
      template,
      chapters: previewChapters,
      requirement: options.requirement,
      materialFileCount: materialFilePaths.length,
      evidenceCount: previewEvidenceCount,
      targetWords: previewTargetWords,
      hasVeryLargeExplicitChapter: previewChapters.some(chapter => (chapter.sections || []).filter(Boolean).length >= 30),
      configuredChapterConcurrency: Number(process.env.DOCUMENT_CHAPTER_CONCURRENCY || 0),
    });
  } catch {
    // 策略预估失败不影响模板校验主流程
  }
  // T6 大纲建议：模板章节 vs 同类工程典型结构，缺失高频章节仅建议（不阻断、不强制）
  let referenceStructureSuggestion;
  try {
    referenceStructureSuggestion = buildReferenceStructureSuggestion({ templateName: template.name, chapterTitles: template.chapters.map(chapter => chapter.title) });
  } catch {
    // 参考库建议失败不影响模板校验主流程
  }
  return { templateId, projectRoleConfigId: configId, configName: config?.name, fileDiagnostics, promptDiagnostics, roleDiagnostics, readiness, issues, strategyPreview, referenceStructureSuggestion };
}

interface TemplateRunValidationCacheEntry {
  at: number;
  result: Awaited<ReturnType<typeof validateDocumentTemplateRun>>;
}

const templateRunValidationCache = new Map<string, TemplateRunValidationCacheEntry>();
const TEMPLATE_RUN_VALIDATION_CACHE_TTL_MS = Math.max(5_000, Number(process.env.DOCUMENT_TEMPLATE_VALIDATION_CACHE_TTL_MS ?? 30_000));

/** 带短 TTL 缓存的模板运行前校验：前端校验与生成接口校验连续触发时复用结果，避免重复执行昂贵的资料理解与准备度评估 */
export async function validateDocumentTemplateRunCached(templateId: string, projectRoot = getProjectRoot(), options: { requirement?: string } = {}) {
  const resolvedProjectRoot = path.resolve(projectRoot);
  const template = getDocumentTemplate(templateId);
  const files = listKnowledgeFiles(resolvedProjectRoot);
  // 轻量签名：模板版本/更新时间 + 资料文件数量与最新修改时间，任一变化即失效
  const signature = JSON.stringify({
    templateId,
    templateVersion: template?.version ?? 0,
    templateUpdatedAt: template?.updatedAt ?? 0,
    projectRoot: resolvedProjectRoot,
    requirement: options.requirement ?? '',
    fileCount: files.length,
    lastFileMtime: files.reduce((max, file) => Math.max(max, file.mtime), 0),
  });
  const cached = templateRunValidationCache.get(signature);
  if (cached && Date.now() - cached.at < TEMPLATE_RUN_VALIDATION_CACHE_TTL_MS) return cached.result;
  const result = await validateDocumentTemplateRun(templateId, resolvedProjectRoot, options);
  templateRunValidationCache.set(signature, { at: Date.now(), result });
  return result;
}

export function deleteDocumentTemplate(templateId: string) {
  const configTemplateIds = new Set(readEngineeringDocumentConfig().templates.map(template => template.id));
  if (configTemplateIds.has(templateId)) throw new Error('Configured template cannot be deleted');
  writeCustomTemplates(readCustomTemplates().filter(item => item.id !== templateId));
}

export function duplicateDocumentTemplate(templateId: string): DocumentTemplate {
  const source = getDocumentTemplate(templateId);
  if (!source) throw new Error('Document template not found');
  const now = Date.now();
  const duplicated = sanitizeTemplate({
    ...source,
    id: `${source.id}-copy-${now}`,
    name: `${source.name} Copy`,
    builtIn: false,
    version: 1,
    updatedAt: now,
    changeLog: [{ version: 1, timestamp: now, summary: `从 ${source.id} v${source.version || 1} 复制` }],
  });
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

