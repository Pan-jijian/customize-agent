import * as fs from 'node:fs';
import * as path from 'node:path';
import * as XLSX from 'xlsx';
import * as os from 'node:os';
import { createProvider } from '@customize-agent/llm';
import { resolveProtocol } from '@customize-agent/runtime';
import { getMultiProjectManager, getProjectRoot, listKnowledgeFiles } from './kbService';
import { recallDocumentContexts } from './contextService';
import { getConfigStore } from '@/services/configService';
import { getProjectRoleConfig, listDocumentRoles } from './documentRoleService';
import type { AutoDocumentSpecGateRule, AutoDocumentSpecPackage, GateRuleEvaluator } from './autoDocumentSpecTypes';
import { autoSpecPrompt, getOrCreateAutoDocumentSpec } from './autoDocumentSpecService';
import { buildProjectMaterialSummary, projectMaterialPrompt, type ProjectMaterialSummary, type MaterialRole } from './projectMaterialService';
import { resolveTemplateMaterialRoles } from './materialRoleResolver';
import { evaluateDocumentReadiness, readinessPrompt } from './documentReadinessService';
import { validateDraftWithAutoSpec } from './documentValidationService';
import { validateEngineeringSpecialty, validateProjectContamination } from './engineeringDocumentValidationService';
import { chapterReadinessIssues, evaluateChapterReadiness } from './chapterReadinessService';
import { validateFactConsistency } from './factConsistencyService';
import { validateDocumentQualityBenchmark } from './documentQualityBenchmarkService';
import { readEngineeringDocumentConfig } from './engineeringDocumentConfigService';
import { assignTechnicalFactsToChapter, engineeringCoverageMatrixPrompt, extractEngineeringTechnicalFacts, technicalFactsPrompt, validateEngineeringDetailGate, validateQuantifiedCoverage, type TechnicalFactAssignment } from './engineeringTechnicalFactService';
import type { KbSearchResult } from '@/lib/api';

export interface DocumentTemplateChapter {
  id: string;
  title: string;
  purpose: string;
  queries: string[];
  requiredFacts: string[];
  sections?: string[];
  tableSections?: string[];
  tableRequirements?: string[];
  pinnedEvidenceFilePaths?: string[];
}

export interface DocumentExportSettings {
  page?: {
    paper?: string;
    marginTop?: string;
    marginRight?: string;
    marginBottom?: string;
    marginLeft?: string;
  };
  typography?: {
    fontFamily?: string;
    lineHeight?: string;
    titleSize?: string;
    bodySize?: string;
  };
  targetPages?: {
    min?: number;
    target?: number;
    max?: number;
  };
}

export interface DocumentGenerationSettings {
  targetPages?: {
    min?: number;
    target?: number;
    max?: number;
  };
}

export interface PromptBinding {
  promptId: string;
  roleId: string;
}

export interface FileBinding {
  filePath: string;
  roleId: string;
}

export interface DocumentTemplate {
  id: string;
  name: string;
  description: string;
  category: string;
  outputTitle: string;
  chapters: DocumentTemplateChapter[];
  exportSettings?: DocumentExportSettings;
  generationSettings?: DocumentGenerationSettings;
  projectRoleConfigId?: string;
  promptIds?: string[];
  boundFilePaths?: string[];
  promptBindings?: PromptBinding[];
  fileBindings?: FileBinding[];
  builtIn?: boolean;
}

export interface DocumentEvidence {
  chapterId: string;
  filePath: string;
  score: number;
  content: string;
  roleId?: string;
  processingType?: string;
  sectionTitle?: string;
  source?: string;
}

interface ResourceEvidence {
  filePath: string;
  kind: 'map' | 'image' | 'table' | 'document' | 'spreadsheet' | 'text' | 'attachment';
  roleId?: string;
  processingType?: string;
  score: number;
  semanticTitle: string;
  contentUse: string;
  relatedFacts: string[];
  relatedChapters: string[];
  snippets: string[];
}

interface EvidenceBundle {
  chapterId: string;
  textEvidence: DocumentEvidence[];
  resources: ResourceEvidence[];
  byKind: Record<ResourceEvidence['kind'], ResourceEvidence[]>;
  summary: string;
}

export interface DocumentDraftChapter {
  id: string;
  title: string;
  content: string;
  evidence: DocumentEvidence[];
  missingFacts: string[];
  sections?: string[];
}

export interface FactSourceRef {
  filePath: string;
  roleId: string;
  processingType?: string;
  sectionTitle?: string;
  chunkIndex?: number;
  cellRange?: string;
}

export interface DocumentFact {
  key: string;
  value: string;
  sourceFile: string;
  roleId: string;
  processingType?: string;
  confidence: number;
  fieldId?: string;
  fieldName?: string;
  sourceRef?: FactSourceRef;
}

export interface StructuredTableFact {
  tableType: string;
  sheet?: string;
  headers: string[];
  rows: string[][];
  sourceFile: string;
  sourceRange?: string;
}

export interface DocumentFactsModel {
  project: DocumentFact[];
  schedule: DocumentFact[];
  quality: DocumentFact[];
  safety: DocumentFact[];
  resources: DocumentFact[];
  tables: StructuredTableFact[];
  drawings: DocumentFact[];
  bills: DocumentFact[];
  preciseFacts: DocumentFact[];
  rules: DocumentFact[];
  specifications: DocumentFact[];
  schemaFacts: Record<string, DocumentFact[]>;
  missing: string[];
  conflicts: string[];
}

export interface ValidationIssue {
  level: 'error' | 'warning' | 'info';
  message: string;
  source?: string;
  suggestion?: string;
}

export interface ExportGateResult {
  passed: boolean;
  blockingIssues: ValidationIssue[];
  checklist: Array<{ key: string; label: string; passed: boolean; message?: string }>;
}

export interface DocumentExecutionStage {
  type: 'role_binding' | 'knowledge_retrieval' | 'context_recall' | 'file_understanding' | 'fact_extraction' | 'chapter_generation' | 'asset_generation' | 'llm_review' | 'validation' | 'formatting' | 'export_ready' | 'reference';
  roleId: string;
  promptId?: string;
  status: 'success' | 'fallback' | 'skipped' | 'failed';
  message?: string;
  title?: string;
  subtitle?: string;
  roleName?: string;
  promptName?: string;
  group?: string;
  order?: number;
  executionVersion?: 2;
}

export interface DocumentAsset {
  id: string;
  type: 'image' | 'audio' | 'video' | 'file';
  role: 'cover' | 'reference' | 'generated' | 'attachment';
  path?: string;
  url?: string;
  prompt?: string;
  modelProvider?: string;
  status: 'generated' | 'prompt_ready' | 'fallback';
  message?: string;
}

export interface GeneratedDocumentDraft {
  templateId: string;
  templateName: string;
  title: string;
  requirement: string;
  markdown: string;
  exportSettings?: DocumentExportSettings;
  generationSettings?: DocumentGenerationSettings;
  facts: Record<string, string>;
  structuredFacts: DocumentFact[];
  factsModel: DocumentFactsModel;
  chapters: DocumentDraftChapter[];
  sources: Array<{ filePath: string; count: number }>;
  missingItems: string[];
  validation: { passed: boolean; warnings: string[]; errors: string[] };
  validationIssues: ValidationIssue[];
  executionStages: DocumentExecutionStage[];
  exportGate: ExportGateResult;
  assets?: DocumentAsset[];
  generatedAt: number;
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
    outputTitle: template.outputTitle || template.name || '业务文档',
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
    })) : [{ id: 'document', title: template.outputTitle || template.name || '业务文档', purpose: template.description || '', queries: [], requiredFacts: [] }],
    exportSettings: template.exportSettings,
    generationSettings: template.generationSettings,
    promptIds: Array.isArray(template.promptIds) ? template.promptIds.filter(Boolean) : [],
    boundFilePaths: Array.isArray(template.boundFilePaths) ? template.boundFilePaths.filter(Boolean) : [],
    promptBindings: Array.isArray(template.promptBindings)
      ? template.promptBindings.filter(item => item.promptId && item.roleId)
      : (Array.isArray(template.promptIds) ? template.promptIds.filter(Boolean).map(promptId => ({ promptId, roleId: 'chapter_generation' })) : []),
    fileBindings: Array.isArray(template.fileBindings)
      ? template.fileBindings.filter(item => item.filePath && item.roleId)
      : (Array.isArray(template.boundFilePaths) ? template.boundFilePaths.filter(Boolean).map(filePath => ({ filePath, roleId: 'project_fact' })) : []),
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

function readPromptContents(promptBindings: PromptBinding[] = []): Array<{ id: string; roleId: string; name: string; content: string }> {
  if (promptBindings.length === 0) return [];
  const prompts: Array<{ id: string; roleId: string; name: string; content: string }> = [];
  let customPrompts: Array<{ id: string; name: string; content: string }>;
  try {
    const config = JSON.parse(fs.readFileSync(promptConfigPath(), 'utf-8')) as { customPrompts?: Array<{ id: string; name: string; content: string }> };
    customPrompts = Array.isArray(config.customPrompts) ? config.customPrompts : [];
  } catch {
    customPrompts = [];
  }
  for (const binding of promptBindings) {
    const id = binding.promptId;
    if (id.startsWith('custom:')) {
      const custom = customPrompts.find(item => item.id === id);
      if (custom) prompts.push({ id, roleId: binding.roleId, name: custom.name, content: custom.content });
      continue;
    }
    if (id.startsWith('file:')) {
      const filePath = id.slice('file:'.length);
      if (fs.existsSync(filePath)) prompts.push({ id, roleId: binding.roleId, name: path.basename(path.dirname(filePath)) || filePath, content: fs.readFileSync(filePath, 'utf-8') });
    }
  }
  return prompts;
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
  const autoSpec = getOrCreateAutoDocumentSpec(template);
  const spec = autoSpec.spec;
  if (spec.chapterMode === 'fixed' && spec.chapterRules.filter(rule => rule.required).length === 0) {
    issues.push({ level: 'warning', message: '后台自动规范未形成必需章节规则' });
  }
  if (spec.chapterMode === 'dynamic' && spec.dynamicChapterRule.maxChapters && spec.dynamicChapterRule.minChapters && spec.dynamicChapterRule.maxChapters < spec.dynamicChapterRule.minChapters) {
    issues.push({ level: 'error', message: '后台自动规范动态章节规则异常' });
  }
  const resolvedProjectRoot = path.resolve(projectRoot);
  const project = await getMultiProjectManager().getProject(resolvedProjectRoot);
  if (template.builtIn) await project.incrementalIndex();
  const files = listKnowledgeFiles(resolvedProjectRoot);
  const materialSummary = buildProjectMaterialSummary(resolvedProjectRoot, { boundFilePaths: explicitFileBindings.map(binding => binding.filePath), boundFileRoles: boundFileRolesForMaterialSummary(explicitFileBindings) });
  const semanticFileBindings = explicitFileBindings.length > 0 ? explicitFileBindings : fileBindingsFromMaterialSummary(template, materialSummary);
  const fileBindings = semanticFileBindings.length > 0 ? semanticFileBindings : explicitFileBindings;
  if (fileBindings.length === 0) issues.push({ level: 'error', message: '未从当前项目资料中解析到可用文件角色，请先确认知识库已上传并索引项目资料，或在模板高级固定绑定资料中手动指定文件' });
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

const CAD_ENTITY_TOKEN_RE = /\b(?:TDbPipe|TDbPipeValve|TDbPipeFitting|TDbWellh|AcDb\w+|Dwg\w+|Polyline|Hatch|Layer|BlockReference)\b/giu;
const FILE_NAME_RE = /[\w\u4e00-\u9fa5（）()\-—_+\s]+\.(?:pdf|dwg|docx?|xlsx?|xls|csv|png|jpe?g|webp)\b/giu;

function readableSourceLabel(item: Pick<DocumentEvidence, 'roleId' | 'processingType' | 'sectionTitle'>, index = 0) {
  const role = item.processingType === 'drawing' || item.roleId?.includes('drawing') ? '图纸资料'
    : item.processingType === 'table' || item.roleId?.includes('bill') ? '清单资料'
      : item.processingType === 'rule' || item.roleId?.includes('tender') ? '招标资料'
        : '项目资料';
  return `${role}片段${index + 1}${item.sectionTitle ? `（${item.sectionTitle.replace(FILE_NAME_RE, '').slice(0, 40)}）` : ''}`;
}

function cleanEvidenceText(content: string) {
  return [...content]
    .filter(char => {
      const code = char.charCodeAt(0);
      return code === 9 || code === 10 || code === 13 || code >= 32;
    })
    .join('')
    .replace(CAD_ENTITY_TOKEN_RE, '')
    .replace(FILE_NAME_RE, '')
    .replace(/\b(?:Model|Layout\d*|Entity|Handle|ObjectId|ByLayer|Continuous)\b/giu, '')
    .replace(/[\t ]{2,}/gu, ' ')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

function sanitizeEvidenceContent(filePath: string, content: string) {
  const ext = path.extname(filePath).toLowerCase();
  const cleaned = cleanEvidenceText(content);
  if (cleaned.length > 20) return cleaned.slice(0, 4000);
  if (['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.png', '.jpg', '.jpeg', '.webp', '.dwg'].includes(ext)) {
    return `该资料为${ext.replace('.', '').toUpperCase()}格式附件，仅作为内部事实提取依据；正式正文不得引用文件名。`;
  }
  return cleaned.slice(0, 4000);
}

function uniqueEvidence(items: DocumentEvidence[], limit: number): DocumentEvidence[] {
  const seen = new Set<string>();
  return items.map(item => ({ ...item, content: sanitizeEvidenceContent(item.filePath, item.content) }))
    .sort((a, b) => b.score - a.score)
    .filter(item => {
      const key = `${item.filePath}:${item.content.slice(0, 100)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit);
}

function evidenceFromBoundFile(filePath: string, roleId: string | undefined, processingType: string | undefined, chapterId: string, projectRoot: string): DocumentEvidence[] {
  const absolute = path.isAbsolute(filePath) ? filePath : fs.existsSync(path.join(projectRoot, 'knowledgeBase', filePath)) ? path.join(projectRoot, 'knowledgeBase', filePath) : path.join(projectRoot, filePath);
  if (!fs.existsSync(absolute) || fs.statSync(absolute).isDirectory()) return [];
  const ext = path.extname(absolute).toLowerCase();
  const content = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.png', '.jpg', '.jpeg', '.webp'].includes(ext) ? `资料文件：${path.basename(filePath)}，文件类型：${ext}。` : fs.readFileSync(absolute, 'utf-8');
  const chunks = content.match(/[\s\S]{1,1800}/gu) || [];
  return chunks.slice(0, 12).map((chunk, index) => ({
    chapterId,
    filePath,
    score: 1,
    content: chunk,
    roleId,
    processingType,
    sectionTitle: `文件片段 ${index + 1}`,
    source: 'bound-file-direct',
  }));
}

function evidenceLine(item: DocumentEvidence, index = 0): string {
  return `- ${readableSourceLabel(item, index)}：${cleanEvidenceText(item.content).replace(/\s+/gu, ' ').slice(0, 260)}`;
}

function resourceKind(filePath: string, processingType?: string): ResourceEvidence['kind'] {
  const ext = path.extname(filePath).toLowerCase();
  if (processingType === 'drawing' || /地图|图纸|map/iu.test(filePath)) return 'map';
  if (['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) return 'image';
  if (processingType === 'table') return 'table';
  if (['.xls', '.xlsx', '.csv'].includes(ext)) return 'spreadsheet';
  if (['.pdf', '.doc', '.docx'].includes(ext)) return 'document';
  if (ext && !['.md', '.txt'].includes(ext)) return 'attachment';
  return 'text';
}

function semanticResourceTitle(filePath: string, kind: ResourceEvidence['kind']) {
  const name = path.basename(filePath).replace(/\.[^.]+$/u, '');
  if (kind === 'map') return name.replace(/^地图图纸-/u, '').replace(/-完整地图图纸$/u, '完整地图图纸');
  if (kind === 'image') return name.replace(/-/gu, ' ');
  if (kind === 'spreadsheet') return `${name}（结构化表格）`;
  if (kind === 'document') return `${name}（文档附件）`;
  return name;
}

function relatedFactsForResource(item: DocumentEvidence, chapter?: DocumentTemplateChapter) {
  const haystack = `${item.filePath}\n${item.content}`;
  const candidates = [...(chapter?.requiredFacts || []), '表格数据', '规范要求', '项目事实', '附件资料', '图纸资料', '图片资料'];
  return [...new Set(candidates.filter(fact => evidenceMatchesFact(item, fact) || haystack.includes(fact)))];
}

function resourceContentUse(kind: ResourceEvidence['kind']) {
  if (kind === 'map') return '作为地图/图纸证据，用于说明空间关系、区域划分、点位、路线或专业布置。';
  if (kind === 'image') return '作为图片证据，用于视觉说明、参考图或章节配图。';
  if (kind === 'spreadsheet' || kind === 'table') return '作为表格/数据证据，用于字段对比、清单、数量和结构化结论。';
  if (kind === 'document') return '作为 PDF/Word 文档证据，用于提取规范、事实、说明、约束和附件来源。';
  if (kind === 'attachment') return '作为附件证据，用于提供补充来源、文件级约束或可追溯引用。';
  return '作为文本证据，用于事实抽取、章节论据和来源引用。';
}

function emptyEvidenceByKind(): Record<ResourceEvidence['kind'], ResourceEvidence[]> {
  return { map: [], image: [], table: [], document: [], spreadsheet: [], text: [], attachment: [] };
}

/** 构建章节证据包，将原始证据分类为文本片段和结构化资源（图片、表格、文档、地图等） */
function buildEvidenceBundle(chapter: DocumentTemplateChapter, evidence: DocumentEvidence[]): EvidenceBundle {
  const textEvidence = evidence.slice(0, 16);
  const resourceMap = new Map<string, ResourceEvidence>();
  for (const item of evidence) {
    const kind = resourceKind(item.filePath, item.processingType);
    const existing = resourceMap.get(item.filePath);
    const resource: ResourceEvidence = existing || {
      filePath: item.filePath,
      kind,
      roleId: item.roleId,
      processingType: item.processingType,
      score: item.score,
      semanticTitle: semanticResourceTitle(item.filePath, kind),
      contentUse: resourceContentUse(kind),
      relatedFacts: [],
      relatedChapters: [],
      snippets: [],
    };
    resource.score = Math.max(resource.score, item.score);
    resource.relatedFacts = [...new Set([...resource.relatedFacts, ...relatedFactsForResource(item, chapter)])];
    resource.relatedChapters = [...new Set([...resource.relatedChapters, chapter.title])];
    const snippet = item.content.replace(/\s+/gu, ' ').slice(0, 320);
    if (snippet && resource.snippets.length < 3 && !resource.snippets.includes(snippet)) resource.snippets.push(snippet);
    resourceMap.set(item.filePath, resource);
  }
  const resources = [...resourceMap.values()].sort((a, b) => b.score - a.score);
  const byKind = emptyEvidenceByKind();
  for (const resource of resources) byKind[resource.kind].push(resource);
  const summary = [
    `内部资料包：文本片段 ${textEvidence.length} 条、结构化资料 ${resources.length} 个。`,
    `资料类型分布：文本 ${byKind.text.length}、文档 ${byKind.document.length}、表格/清单 ${byKind.spreadsheet.length + byKind.table.length}、图片 ${byKind.image.length}、图纸 ${byKind.map.length}、其他 ${byKind.attachment.length}。`,
    '正文必须只写资料中的工程事实、参数、数量、做法和控制措施，不得出现文件名、来源清单或后台证据描述。',
  ].filter(Boolean).join('\n');
  return { chapterId: chapter.id, textEvidence, resources, byKind, summary };
}

function evidenceBundlePrompt(bundle: EvidenceBundle) {
  const resourceLines = bundle.resources.slice(0, 20).map((item, index) => [
    `- 资料：${readableSourceLabel(item, index)}`,
    `  资料类型：${item.kind}`,
    `  正文用途：${item.contentUse}`,
    item.relatedFacts.length ? `  可用事实方向：${item.relatedFacts.join('、')}` : '',
    item.snippets.length ? `  可用内容：${item.snippets.map(cleanEvidenceText).filter(Boolean).join(' / ')}` : '',
  ].filter(Boolean).join('\n')).join('\n');
  const textLines = bundle.textEvidence.map((item, index) => `${readableSourceLabel(item, index)}\n类型：${item.processingType || 'reference'}\n章节/片段：${item.sectionTitle?.replace(FILE_NAME_RE, '') || '资料片段'}\n内容：${cleanEvidenceText(item.content).replace(/\s+/gu, ' ').slice(0, 900)}`).join('\n\n---\n\n');
  return [bundle.summary, resourceLines ? `结构化资料：\n${resourceLines}` : '', textLines ? `文本/附件片段：\n${textLines}` : ''].filter(Boolean).join('\n\n');
}

function dynamicChapterTitleFromEvidence(item: DocumentEvidence, index: number, titleTemplate?: string) {
  const sourceTitle = (item.sectionTitle || path.basename(item.filePath).replace(/\.[^.]+$/u, '') || `资料片段 ${index + 1}`).replace(/\s+/gu, ' ').slice(0, 60);
  if (titleTemplate) return titleTemplate.replaceAll('{{index}}', String(index + 1)).replaceAll('{{sourceTitle}}', sourceTitle);
  return sourceTitle;
}

const MAX_EXPLICIT_OUTLINE_CHAPTERS = 80;
const MAX_FALLBACK_CHAPTERS = 40;
const CN_NUMERAL_RE = '[零〇一二三四五六七八九十百千万两]+';

function cleanOutlineTitle(title: string) {
  return title
    .replace(new RegExp(`^\\s*第(?:\\d{1,3}|${CN_NUMERAL_RE})[章节]\\s*`, 'u'), '')
    .replace(new RegExp(`^\\s*[（(]?(?:\\d{1,3}|${CN_NUMERAL_RE})[)）、.．]\\s*`, 'u'), '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function isInvalidOutlineTitle(title: string) {
  if (title.length < 2 || title.length > 80) return true;
  if (/^(目录|章节|大纲|要求|说明|注意|输出|格式|示例|例如|写法|占位)$/u.test(title)) return true;
  if (/^(必须|不得|禁止|需要|请|应|输出|返回|使用|格式|示例)/u.test(title)) return true;
  if (/[{}<>]|Markdown|JSON|变量|占位符/u.test(title)) return true;
  return false;
}

function outlineTitlesFromBlock(content: string) {
  const marker = `(?:第(?:\\d{1,3}|${CN_NUMERAL_RE})[章节]|[（(]?(?:\\d{1,3}|${CN_NUMERAL_RE})[)）、.．])`;
  return content
    .replace(/\r?\n/gu, '\n')
    .replace(new RegExp(`\\s+(?=${marker}\\s*)`, 'gu'), '\n')
    .split('\n')
    .map(line => cleanOutlineTitle(line))
    .filter(title => !isInvalidOutlineTitle(title));
}

function extractOutlineBlocks(text: string) {
  const exact = [...text.matchAll(/<\s*OUTLINE\s*>([\s\S]*?)<\/\s*OUTLINE\s*>/giu)].map(match => match[1] || '');
  if (exact.length > 0) return exact;
  const loose = /(?:<\s*)?OUTLINE\s*>?\s*[:：]?\s*([\s\S]*?)(?:<\/\s*OUTLINE\s*>|END\s+OUTLINE|$)/iu.exec(text);
  return loose?.[1] ? [loose[1]] : [];
}

function extractExplicitOutlineFromText(text: string, source: string): DocumentTemplateChapter[] {
  const chapters: DocumentTemplateChapter[] = [];
  const blocks = extractOutlineBlocks(text);
  for (const block of blocks) {
    for (const title of outlineTitlesFromBlock(block)) {
      chapters.push({
        id: `explicit-${source}-${chapters.length + 1}`,
        title,
        purpose: `按照${source}中 <OUTLINE> 块明确指定的章节生成：${title}，二级小节由模型结合本章内容自行组织且不能为空。`,
        requiredFacts: [],
        sections: [],
        queries: [title],
      });
    }
  }
  return uniqueTemplateChapters(chapters).slice(0, MAX_EXPLICIT_OUTLINE_CHAPTERS);
}

function extractExplicitOutlineFromSources(sources: Array<{ text?: string; source: string }>) {
  for (const item of sources) {
    const chapters = extractExplicitOutlineFromText(item.text || '', item.source);
    if (chapters.length >= 2) return chapters;
  }
  return [];
}

function displayChapterTitle(title: string) {
  return title.replace(/^#+\s*/u, '').replace(/^第[一二三四五六七八九十百千万\d]+[章节]\s*/u, '').replace(/^\d+(?:\.\d+)*[、.．\s]*/u, '').trim();
}

function normalizeGeneratedChapterTitle(title: string) {
  return displayChapterTitle(title.replace(/\s+/gu, ' ').trim()).replace(/^[，,、；;：:。.!！?？\-—\s]+/u, '').trim();
}

function isValidGeneratedChapterTitle(title: string) {
  const raw = title.trim();
  const clean = normalizeGeneratedChapterTitle(raw);
  if (!clean || clean.length < 2 || clean.length > 50) return false;
  if (/^#{3,6}\s*/u.test(raw)) return false;
  if (/^\|.*\|/u.test(raw) || /\|/u.test(clean)) return false;
  if (/^[，,、；;：:。.!！?？\-—]/u.test(raw)) return false;
  if (/[{}<>]|Markdown|JSON|变量|占位符/u.test(clean)) return false;
  if (/[。；;]$/u.test(clean) || /[:：]\s*[。；;]?$/u.test(clean)) return false;
  if (/^(目录|章节|大纲|要求|说明|注意|输出|格式|示例|例如|写法|占位)$/u.test(clean)) return false;
  if (/(评标委员会|完全满足评审要求|项目部对本工程|全面梳理与响应|坚实的技术保障)/u.test(clean)) return false;
  return !isPollutedChapterTitle(clean);
}

function numberToChineseChapter(value: number) {
  const digits = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  if (value <= 10) return value === 10 ? '十' : digits[value];
  if (value < 20) return `十${digits[value % 10]}`;
  if (value < 100) {
    const tens = Math.floor(value / 10);
    const ones = value % 10;
    return `${digits[tens]}十${ones ? digits[ones] : ''}`;
  }
  return String(value);
}

function formalChapterTitle(index: number, title: string) {
  const clean = displayChapterTitle(title);
  return `第${numberToChineseChapter(index + 1)}章 ${clean}`;
}

function isPollutedChapterTitle(title: string) {
  return /见(?:招标|公告|文件|图纸)|按(?:图纸|设计要求|相关)|质量标准[:：]|招标范围[:：]|工程量清单.*图纸设计依据/u.test(title);
}

function uniqueTemplateChapters(chapters: DocumentTemplateChapter[]) {
  const seen = new Set<string>();
  return chapters.filter(chapter => {
    const key = normalizeGeneratedChapterTitle(chapter.title);
    if (!key || seen.has(key) || isPollutedChapterTitle(key)) return false;
    seen.add(key);
    chapter.title = key;
    return true;
  });
}

function dynamicChapterLimit(spec?: AutoDocumentSpecPackage) {
  return Math.max(0, Math.min(2, spec?.dynamicChapterRule.maxChapters ?? 2));
}

function effectiveTemplateChapters(template: DocumentTemplate, spec?: AutoDocumentSpecPackage, seedEvidence: DocumentEvidence[] = []): DocumentTemplateChapter[] {
  if (!spec) return uniqueTemplateChapters([...template.chapters]);
  if (spec.chapterMode === 'fixed') {
    if (template.chapters.length > 0) {
      return uniqueTemplateChapters([...template.chapters].map(chapter => {
        const title = displayChapterTitle(chapter.title);
        const rule = spec.chapterRules.find(item => item.id === chapter.id || displayChapterTitle(item.title) === title);
        return {
          ...chapter,
          title,
          purpose: rule?.generationHint || chapter.purpose,
          requiredFacts: [...new Set([...(chapter.requiredFacts || []), ...(rule?.requiredFactIds || [])])],
          queries: [...new Set([...(chapter.queries || []), title, rule?.generationHint || '', ...(chapter.sections || [])].filter(Boolean))],
        };
      }));
    }
    return uniqueTemplateChapters([...spec.chapterRules].sort((a, b) => a.order - b.order).map(rule => {
      const title = displayChapterTitle(rule.title);
      return {
        id: rule.id,
        title,
        purpose: rule.generationHint || title,
        requiredFacts: rule.requiredFactIds || [],
        sections: [],
        queries: [title, rule.generationHint || '', ...(rule.requiredFactIds || [])].filter(Boolean),
        pinnedEvidenceFilePaths: [],
      };
    }));
  }
  if (template.chapters.length > 0) return uniqueTemplateChapters([...template.chapters]);
  const rule = spec.dynamicChapterRule;
  const max = dynamicChapterLimit(spec);
  const min = Math.min(max, Math.max(0, rule.minChapters || 0));
  const sourceRoles = new Set([...(rule.sourceRoleIds || []), ...(rule.requiredFileRoleIds || [])]);
  const candidates = seedEvidence
    .filter(item => sourceRoles.size === 0 || (item.roleId && sourceRoles.has(item.roleId)))
    .filter((item, index, arr) => arr.findIndex(other => `${other.filePath}:${other.sectionTitle || ''}` === `${item.filePath}:${item.sectionTitle || ''}`) === index)
    .slice(0, max);
  const chapters: DocumentTemplateChapter[] = [];
  for (const item of candidates) {
    const title = dynamicChapterTitleFromEvidence(item, chapters.length, rule.titleTemplate);
    if (violatesConfiguredChapterTitleFilter(title, template)) continue;
    chapters.push({
      id: `dynamic-${chapters.length + 1}`,
      title,
      purpose: rule.generationHint || `根据 ${item.filePath} 动态生成章节`,
      requiredFacts: rule.requiredFactIds || [],
      queries: [title, item.filePath, item.sectionTitle || '', rule.generationHint || ''].filter(Boolean),
      pinnedEvidenceFilePaths: [item.filePath],
    });
  }
  if (chapters.length >= min) return chapters;
  const fallbackTitles = template.chapters.length > 0 ? template.chapters.map(chapter => chapter.title) : ['背景与目标', '资料分析', '结论与建议'];
  while (chapters.length < min) {
    const index = chapters.length;
    const title = fallbackTitles[index] || `动态章节 ${index + 1}`;
    chapters.push({
      id: `dynamic-${index + 1}`,
      title,
      purpose: rule.generationHint || title,
      requiredFacts: rule.requiredFactIds || [],
      queries: [title, rule.generationHint || '', inputSafeJoin(rule.sourceRoleIds || [])].filter(Boolean),
      pinnedEvidenceFilePaths: [],
    });
  }
  return chapters;
}

function inputSafeJoin(items: string[]) {
  return items.filter(Boolean).join(' ');
}

function factSearchTerms(fact: string) {
  const normalized = fact.replace(/要求|计划|目标|标准|内容|信息|事实|依据|参数|范围|要点/gu, '');
  return [fact, normalized].filter(Boolean);
}

function evidenceMatchesFact(item: DocumentEvidence, fact: string) {
  const haystack = `${item.filePath}\n${item.content}`;
  return factSearchTerms(fact).some(term => haystack.includes(term));
}

function specFactTargets(template: DocumentTemplate, spec?: AutoDocumentSpecPackage) {
  const chapters = effectiveTemplateChapters(template, spec, []);
  const chapterFacts = chapters.flatMap(chapter => chapter.requiredFacts).map(name => ({ id: name, name, required: true, sourceRoleIds: [] as string[], extractionHint: '' }));
  const specFacts = spec?.factFields.map(field => ({ id: field.id, name: field.name, required: field.required, sourceRoleIds: field.sourceRoleIds || [], extractionHint: field.extractionHint || '' })) || [];
  const map = new Map<string, { id: string; name: string; required: boolean; sourceRoleIds: string[]; extractionHint: string }>();
  for (const item of [...chapterFacts, ...specFacts]) map.set(item.id, { ...(map.get(item.id) || item), ...item, required: item.required || map.get(item.id)?.required || false });
  return [...map.values()];
}

function evidenceSatisfiesSpecField(item: DocumentEvidence, field: { name: string; sourceRoleIds?: string[] }) {
  const roleMatched = !field.sourceRoleIds?.length || Boolean(item.roleId && field.sourceRoleIds.includes(item.roleId));
  return roleMatched && evidenceMatchesFact(item, field.name);
}

interface RoleExecutionNode {
  id: string;
  fileRoleId: string;
  fileRoleName: string;
  filePaths: string[];
  processingType?: string;
  promptRoleIds: string[];
  promptRoleNames: string[];
  promptTexts: string[];
  outputType: 'template_requirements' | 'bill_facts' | 'drawing_facts' | 'technical_facts' | 'project_facts' | 'reference_facts';
}

interface TenderPlanRequirement {
  id: string;
  title: string;
  requirementText: string;
  requiredContents: string[];
  writingRules: string[];
  evidenceNeeds: string[];
  preferredSourceRoleIds: string[];
}

interface TenderPlanChapter {
  id: string;
  title: string;
  order: number;
  sourceRequirement: string;
  requiredContents: string[];
  writingRules: string[];
  evidenceNeeds: string[];
  minWords?: number;
  requirements: TenderPlanRequirement[];
}

interface RoleNodeFact {
  key: string;
  value: string;
  sourceFile: string;
  roleId: string;
  processingType?: string;
  relatedChapterHints: string[];
}

interface TenderAnnouncementFact {
  key: string;
  value: string;
  sourceFile: string;
}

interface RoleNodeArtifact {
  node: RoleExecutionNode;
  evidence: DocumentEvidence[];
  chapters: TenderPlanChapter[];
  facts: RoleNodeFact[];
  outputRequirements: string[];
  warnings: string[];
  forbidImageInsertion: boolean;
}

type RoleExtractionLlmResult = {
  chapters?: unknown;
  facts?: unknown;
  outputRequirements?: unknown;
  warnings?: unknown;
  forbidImageInsertion?: boolean;
};

type RoleExtractionChapterInput = {
  title?: string;
  sourceRequirement?: string;
  requiredContents?: unknown;
  writingRules?: unknown;
  evidenceNeeds?: unknown;
  minWords?: number;
  requirements?: unknown;
};

type RoleExtractionFactInput = {
  key?: string;
  value?: unknown;
  sourceFile?: string;
  relatedChapterHints?: unknown;
};

type RoleExtractionRequirementInput = {
  title?: string;
  requirementText?: string;
  requiredContents?: unknown;
  writingRules?: unknown;
  evidenceNeeds?: unknown;
  preferredSourceRoleIds?: unknown;
};

function normalizeRoleText(value: string) {
  return value.toLowerCase();
}

function inferRoleOutputType(role: { id: string; name: string; processingType?: string }, promptTexts: string[] = []): RoleExecutionNode['outputType'] {
  const text = normalizeRoleText(`${role.id} ${role.name} ${role.processingType || ''} ${promptTexts.join(' ')}`);
  if (/示范文本|招标文件|章节|目录|输出要求|编制要求|template|tender/u.test(text)) return 'template_requirements';
  if (/清单|工程量|bill|boq|quantity/u.test(text)) return 'bill_facts';
  if (/图纸|drawing|cad|设计图|图纸解析/u.test(text)) return 'drawing_facts';
  if (/规范|标准|spec|technical/u.test(text)) return 'technical_facts';
  if (/项目|工程概况|事实|fact/u.test(text)) return 'project_facts';
  return 'reference_facts';
}

function promptExecutionScore(promptRoleId: string, fileRole: { id: string; name: string; processingType?: string }, promptTexts: string[]) {
  const promptText = normalizeRoleText(`${promptRoleId} ${promptTexts.join(' ')}`);
  const fileText = normalizeRoleText(`${fileRole.id} ${fileRole.name} ${fileRole.processingType || ''}`);
  let score = 0;
  if (/fact|抽取|读取|提取|理解|reference/u.test(promptText)) score += 5;
  if (/chapter_generation|章节生成|正文生成/u.test(promptText)) score += 1;
  for (const token of [fileRole.id, fileRole.name, fileRole.processingType || ''].filter(Boolean)) {
    if (promptText.includes(normalizeRoleText(token))) score += 4;
  }
  if (/tender|招标|投标|评审|响应|rule/u.test(fileText) && /tender|招标|投标|评审|响应|示范文本|章节|目录|输出要求|编制要求/u.test(promptText)) score += 6;
  if (/bill|boq|quantity|清单|工程量/u.test(fileText) && /bill|boq|quantity|清单|工程量|项目特征/u.test(promptText)) score += 6;
  if (/drawing|cad|图纸|设计/u.test(fileText) && /drawing|cad|图纸|设计|文本|标注/u.test(promptText)) score += 6;
  if (/material|equipment|brand|材料|设备|品牌/u.test(fileText) && /material|equipment|brand|材料|设备|品牌|推荐/u.test(promptText)) score += 6;
  if (/schedule|quality|safety|工期|质量|安全|文明/u.test(fileText) && /schedule|quality|safety|工期|质量|安全|文明/u.test(promptText)) score += 6;
  if (/risk|constraint|重点|难点|约束|风险/u.test(fileText) && /risk|constraint|重点|难点|约束|风险/u.test(promptText)) score += 6;
  return score;
}

function safePlanId(input: string, fallback: string) {
  return (input || fallback).replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]/gu, '-').slice(0, 80) || fallback;
}

function evidenceForRoleFiles(project: any, node: RoleExecutionNode, projectRoot: string): DocumentEvidence[] {
  const evidence: DocumentEvidence[] = [];
  for (const filePath of node.filePaths) {
    const detail = project.getFileDetail(filePath);
    if (detail) {
      evidence.push(...detail.chunks.slice(0, 120).map((chunk: { content: string; sectionTitle?: string }) => ({
        chapterId: node.id,
        filePath: detail.file.relativePath,
        score: 1,
        content: chunk.content,
        roleId: node.fileRoleId,
        processingType: node.processingType,
        sectionTitle: chunk.sectionTitle,
        source: 'role-node',
      })));
      continue;
    }
    evidence.push(...evidenceFromBoundFile(filePath, node.fileRoleId, node.processingType, node.id, projectRoot));
  }
  return uniqueEvidence(evidence, 120);
}

function buildRoleExecutionNodes(_template: DocumentTemplate, promptBindings: PromptBinding[], fileBindings: FileBinding[]): RoleExecutionNode[] {
  const fileRoles = listDocumentRoles('file');
  const promptRoles = listDocumentRoles('prompt');
  const loadedPrompts = readPromptContents(promptBindings);
  const byRole = new Map<string, string[]>();
  for (const binding of fileBindings) byRole.set(binding.roleId, [...(byRole.get(binding.roleId) || []), binding.filePath]);
  const orderedFileRoles = fileRoles.filter(role => byRole.has(role.id));
  const orderedPromptRoles = promptRoles.filter(role => {
    const executionType = role.executionType || 'reference';
    const isTemplatePlanningRole = /technical-review|review-standard|template|章节|目录|评审标准/u.test(`${role.id} ${role.name} ${role.description || ''}`);
    return loadedPrompts.some(prompt => prompt.roleId === role.id) && (['fact_extraction', 'reference'].includes(executionType) || isTemplatePlanningRole);
  });
  return orderedFileRoles.map(role => {
    const scored = orderedPromptRoles.map(promptRole => {
      const texts = loadedPrompts.filter(prompt => prompt.roleId === promptRole.id).map(prompt => prompt.content);
      return { promptRole, texts, score: promptExecutionScore(promptRole.id, role, texts) };
    }).sort((a, b) => b.score - a.score);
    const matched = scored.filter(item => item.score > 5).slice(0, 2);
    const safeFallback = scored.find(item => {
      const type = item.promptRole.executionType || 'reference';
      return type === 'fact_extraction' || type === 'reference';
    });
    const selected = matched.length > 0 ? matched : safeFallback ? [safeFallback] : [];
    const promptRoleIds = selected.map(item => item.promptRole.id);
    const promptRoleNames = selected.map(item => item.promptRole.name);
    const promptTexts = selected.flatMap(item => item.texts);
    return {
      id: `node-${role.id}`,
      fileRoleId: role.id,
      fileRoleName: role.name,
      filePaths: byRole.get(role.id) || [],
      processingType: role.processingType,
      promptRoleIds,
      promptRoleNames,
      promptTexts,
      outputType: inferRoleOutputType(role, promptTexts),
    };
  });
}

function matchesTextPattern(text: string, pattern: string) {
  try { return new RegExp(pattern, 'iu').test(text); } catch { return text.includes(pattern); }
}

function configuredChapterTitleFilters(template: DocumentTemplate) {
  const templateText = `${template.name} ${template.category} ${template.outputTitle} ${template.description}`;
  return readEngineeringDocumentConfig().chapterTitleFilters.filter(filter => filter.templateMatchers.some(pattern => matchesTextPattern(templateText, pattern)));
}

function violatesConfiguredChapterTitleForbiddenFilter(title: string, template: DocumentTemplate) {
  return configuredChapterTitleFilters(template).some(filter => {
    if (filter.minLength && title.length < filter.minLength) return true;
    if (filter.maxLength && title.length > filter.maxLength) return true;
    return filter.forbiddenPatterns.some(pattern => matchesTextPattern(title, pattern));
  });
}

function violatesConfiguredChapterTitleFilter(title: string, template: DocumentTemplate) {
  return configuredChapterTitleFilters(template).some(filter => {
    if (filter.minLength && title.length < filter.minLength) return true;
    if (filter.maxLength && title.length > filter.maxLength) return true;
    if (filter.forbiddenPatterns.some(pattern => matchesTextPattern(title, pattern))) return true;
    return filter.requiredPatterns.length > 0 && !filter.requiredPatterns.some(pattern => matchesTextPattern(title, pattern));
  });
}

function fallbackChaptersFromEvidence(template: DocumentTemplate, node: RoleExecutionNode, evidence: DocumentEvidence[]): TenderPlanChapter[] {
  if (node.outputType !== 'template_requirements') return [];
  const headings: TenderPlanChapter[] = [];
  const seen = new Set<string>();
  for (const item of evidence) {
    const lines = item.content.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
    for (const line of lines) {
      if (!new RegExp(`^(?:第(?:\\d{1,3}|${CN_NUMERAL_RE})[章节]|[（(]?(?:\\d{1,3}|${CN_NUMERAL_RE})[)）、.．]|\\d+(?:\\.\\d+)*[、.．])`, 'u').test(line)) continue;
      const title = normalizeGeneratedChapterTitle(line);
      if (!isValidGeneratedChapterTitle(line) || seen.has(title) || violatesConfiguredChapterTitleFilter(title, template)) continue;
      seen.add(title);
      headings.push({
        id: safePlanId(title, `chapter-${headings.length + 1}`),
        title,
        order: headings.length,
        sourceRequirement: item.content.replace(/\s+/gu, ' ').slice(0, 500),
        requiredContents: [],
        writingRules: [],
        evidenceNeeds: [],
        minWords: 1200,
        requirements: [],
      });
      if (headings.length >= MAX_FALLBACK_CHAPTERS) break;
    }
    if (headings.length >= MAX_FALLBACK_CHAPTERS) break;
  }
  return headings;
}

function stringifyFactValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(item => stringifyFactValue(item)).filter(Boolean).join('；');
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => `${key}：${stringifyFactValue(item)}`)
      .filter(Boolean)
      .join('；');
  }
  return String(value);
}

function asObjectArray<T extends Record<string, unknown>>(value: unknown): T[] {
  if (Array.isArray(value)) return value.filter((item): item is T => !!item && typeof item === 'object' && !Array.isArray(item));
  if (value && typeof value === 'object') return Object.values(value).filter((item): item is T => !!item && typeof item === 'object' && !Array.isArray(item));
  return [];
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(item => stringifyFactValue(item).trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(/[；;\n]/u).map(item => item.trim()).filter(Boolean);
  return [];
}

function roleExtractionNeedsRepair(llm?: RoleExtractionLlmResult) {
  if (!llm) return false;
  return (llm.chapters != null && !Array.isArray(llm.chapters)) || (llm.facts != null && !Array.isArray(llm.facts));
}

function fallbackFactsFromEvidence(node: RoleExecutionNode, evidence: DocumentEvidence[]): RoleNodeFact[] {
  return evidence.slice(0, 20).map((item, index) => ({
    key: `${node.fileRoleName}事实${index + 1}`,
    value: item.content.replace(/\s+/gu, ' ').slice(0, 360),
    sourceFile: item.filePath,
    roleId: node.fileRoleId,
    processingType: node.processingType,
    relatedChapterHints: item.sectionTitle ? [item.sectionTitle] : [],
  })).filter(item => item.value.length > 20);
}

async function executeRoleExtractionNode(template: DocumentTemplate, node: RoleExecutionNode, evidence: DocumentEvidence[]): Promise<RoleNodeArtifact> {
  const sample = evidence.slice(0, 36).map(item => `文件:${item.filePath}\n片段:${item.sectionTitle || ''}\n内容:${item.content.slice(0, 1200)}`).join('\n\n---\n\n');
  const promptText = node.promptTexts.join('\n\n') || '请读取绑定文件角色，抽取可用于文档生成的结构化信息。';
  const extractionPrompt = `你正在执行一个“文件角色 × 提示词角色”的读取节点。\n节点类型：${node.outputType}\n文件角色：${node.fileRoleName}（${node.fileRoleId}）\n要求：严格按该节点绑定的提示词读取该文件角色的内容，不要读取其他角色。\n\n请返回 JSON，字段包括 chapters、facts、outputRequirements、forbidImageInsertion、warnings。chapters 只提取当前模板和规范包需要的正式章节；requirements 只保留可合并写入正文的核心要求，避免无依据地拆成过细子节点。facts 必须优先抽取施工对象、部位、区域、学校/片区、工程量、日期、工期、规格、单位、资源数量、检测频次和来源口径；同类对象不得合并丢失，计量单位保持原文含义，必要时使用导出友好的正式写法。\n\n绑定文件片段：\n${sample}`;
  const warnings: string[] = [];
  let llm = sample.trim() ? await callDocumentLlmJson<RoleExtractionLlmResult>(promptText, extractionPrompt) : undefined;
  if (roleExtractionNeedsRepair(llm)) {
    warnings.push(`${node.fileRoleName} 结构化读取返回格式异常，已尝试修复 JSON schema。`);
    const repaired = await callDocumentLlmJson<RoleExtractionLlmResult>(
      '你是 JSON schema 修复器。只根据输入 JSON 重新整理字段类型，不新增事实，不改写事实含义。',
      `请把下面 JSON 修复为严格结构：{"chapters":[],"facts":[],"outputRequirements":[],"warnings":[],"forbidImageInsertion":false}。chapters 和 facts 必须是数组；如果原值是对象，请转为数组；如果无法转换，使用空数组。只返回 JSON。\n\n原始 JSON：\n${JSON.stringify(llm).slice(0, 12000)}`,
    );
    if (repaired && !roleExtractionNeedsRepair(repaired)) llm = repaired;
    else warnings.push(`${node.fileRoleName} 结构化读取修复失败，已降级使用证据片段生成。`);
  }
  const llmChapters = asObjectArray<RoleExtractionChapterInput>(llm?.chapters);
  const llmFacts = asObjectArray<RoleExtractionFactInput>(llm?.facts);
  const chapters: TenderPlanChapter[] = [];
  llmChapters.forEach((item, index) => {
    const title = typeof item.title === 'string' ? normalizeGeneratedChapterTitle(item.title) : '';
    if (!title || !isValidGeneratedChapterTitle(item.title || title) || violatesConfiguredChapterTitleFilter(title, template)) return;
    chapters.push({
      id: safePlanId(title, `chapter-${index + 1}`),
      title,
      order: index,
      sourceRequirement: item.sourceRequirement || title,
      requiredContents: asStringArray(item.requiredContents),
      writingRules: asStringArray(item.writingRules),
      evidenceNeeds: asStringArray(item.evidenceNeeds),
      minWords: Math.max(800, Math.min(3500, Number(item.minWords) || 1200)),
      requirements: asObjectArray<RoleExtractionRequirementInput>(item.requirements).map((requirement, reqIndex) => ({
        id: safePlanId(`${title}-${requirement.title || reqIndex + 1}`, `req-${index + 1}-${reqIndex + 1}`),
        title: requirement.title || `要求 ${reqIndex + 1}`,
        requirementText: requirement.requirementText || requirement.title || '',
        requiredContents: asStringArray(requirement.requiredContents),
        writingRules: asStringArray(requirement.writingRules),
        evidenceNeeds: asStringArray(requirement.evidenceNeeds),
        preferredSourceRoleIds: asStringArray(requirement.preferredSourceRoleIds),
      })),
    });
  });
  const facts: RoleNodeFact[] = [];
  llmFacts.forEach(item => {
    const key = typeof item.key === 'string' ? item.key.trim() : '';
    if (!key || item.value == null) return;
    facts.push({
      key,
      value: cleanEvidenceText(stringifyFactValue(item.value)),
      sourceFile: item.sourceFile || evidence.find(e => e.filePath)?.filePath || '',
      roleId: node.fileRoleId,
      processingType: node.processingType,
      relatedChapterHints: asStringArray(item.relatedChapterHints),
    });
  });
  const usedFallback = chapters.length === 0 || facts.length === 0;
  if (usedFallback) warnings.push(`${node.fileRoleName} 部分结构化结果不足，已补充使用证据片段兜底。`);
  return {
    node,
    evidence,
    chapters: chapters.length > 0 ? chapters : fallbackChaptersFromEvidence(template, node, evidence),
    facts: facts.length > 0 ? facts : fallbackFactsFromEvidence(node, evidence),
    outputRequirements: asStringArray(llm?.outputRequirements),
    warnings: [...warnings, ...asStringArray(llm?.warnings)],
    forbidImageInsertion: llm?.forbidImageInsertion ?? node.outputType === 'drawing_facts',
  };
}

function extractTenderAnnouncementFacts(evidence: DocumentEvidence[]): TenderAnnouncementFact[] {
  const tenderEvidence = evidence.filter(item => /招标|示范文本|tender/u.test(`${item.filePath} ${item.roleId || ''} ${item.processingType || ''}`));
  const source = tenderEvidence.length > 0 ? tenderEvidence : evidence;
  const text = source.map(item => item.content).join('\n');
  const fields: Array<[string, RegExp]> = [
    ['项目名称', /(?:项目名称|工程名称)\s*[:：]?\s*([^\n；;。]{3,80})/u],
    ['项目编号', /(?:项目编号|招标编号|标段编号)\s*[:：]?\s*([^\n；;。]{3,80})/u],
    ['招标人', /(?:招标人|建设单位|采购人)\s*[:：]?\s*([^\n；;。]{2,80})/u],
    ['建设地点', /(?:建设地点|项目地点|工程地点)\s*[:：]?\s*([^\n；;。]{2,100})/u],
    ['建设规模', /(?:建设规模|项目规模)\s*[:：]?\s*([^\n；;。]{2,160})/u],
    ['招标范围', /(?:招标范围|工程招标范围|施工范围)\s*[:：]?\s*([^\n。]{5,260})/u],
    ['计划工期', /(?:计划工期|工期要求|合同履行期限)\s*[:：]?\s*([^\n；;。]{2,100})/u],
    ['质量标准', /(?:质量标准|质量要求)\s*[:：]?\s*([^\n；;。]{2,100})/u],
    ['资金来源', /(?:资金来源|资金落实情况)\s*[:：]?\s*([^\n；;。]{2,100})/u],
    ['标段划分', /(?:标段划分|标包划分)\s*[:：]?\s*([^\n；;。]{2,120})/u],
  ];
  const facts: TenderAnnouncementFact[] = [];
  const sourceFile = source.find(item => /招标|示范文本|tender/u.test(item.filePath))?.filePath || source[0]?.filePath || '';
  for (const [key, pattern] of fields) {
    const value = pattern.exec(text)?.[1]?.replace(/\s+/gu, ' ').trim();
    if (value && !/见(?:招标|公告|文件)|详见|按.*要求/u.test(value)) facts.push({ key, value: value.slice(0, 260), sourceFile });
  }
  return facts;
}

function tenderAnnouncementFactsPrompt(facts: TenderAnnouncementFact[]) {
  if (facts.length === 0) return '';
  return [
    '## 招标公告项目基本信息强制落位',
    '以下字段来自招标文件示范文本中的招标公告，必须优先用于第一章项目基本信息表和正文，不得用“见招标公告/见招标文件”替代。',
    '| 字段 | 值 |',
    '|---|---|',
    ...facts.map(fact => `| ${fact.key} | ${fact.value.replace(/\|/gu, '，')} |`),
  ].join('\n');
}

function roleArtifactsDigest(artifacts: RoleNodeArtifact[], tenderFacts: TenderAnnouncementFact[] = []) {
  const tenderDigest = tenderFacts.length ? `## 招标公告项目基本信息\n${tenderFacts.map(fact => `- ${fact.key}：${fact.value}`).join('\n')}` : '';
  const artifactDigest = artifacts.map(artifact => {
    const chapterLines = artifact.chapters.slice(0, 18).map(chapter => `- ${chapter.title}：${chapter.requiredContents.join('、') || chapter.sourceRequirement.slice(0, 120)}`).join('\n');
    const factLines = artifact.facts.slice(0, 30).map(fact => `- ${fact.key}：${stringifyFactValue(fact.value).slice(0, 220)}（来源：${fact.sourceFile}，角色：${fact.roleId}）`).join('\n');
    return [`## ${artifact.node.fileRoleName} / ${artifact.node.outputType}`, chapterLines ? `章节/要求：\n${chapterLines}` : '', factLines ? `事实：\n${factLines}` : '', artifact.outputRequirements.length ? `输出要求：${artifact.outputRequirements.join('；')}` : ''].filter(Boolean).join('\n');
  }).join('\n\n');
  return [tenderDigest, artifactDigest].filter(Boolean).join('\n\n');
}

function tenderPlanChaptersFromArtifacts(template: DocumentTemplate, artifacts: RoleNodeArtifact[]): TenderPlanChapter[] {
  const chapters = artifacts.filter(item => item.node.outputType === 'template_requirements').flatMap(item => item.chapters);
  const byTitle = new Map<string, TenderPlanChapter>();
  for (const chapter of chapters.sort((a, b) => a.order - b.order)) {
    const title = normalizeGeneratedChapterTitle(chapter.title);
    if (!isValidGeneratedChapterTitle(chapter.title) || violatesConfiguredChapterTitleFilter(title, template)) continue;
    if (!byTitle.has(title)) byTitle.set(title, { ...chapter, title });
  }
  return [...byTitle.values()];
}

function stageTitle(type: DocumentExecutionStage['type']) {
  const titles: Record<DocumentExecutionStage['type'], string> = {
    role_binding: '项目角色配置绑定',
    knowledge_retrieval: '知识库证据检索',
    context_recall: '项目上下文召回',
    file_understanding: '文件角色读取',
    fact_extraction: '事实抽取',
    chapter_generation: '章节正文生成',
    asset_generation: '生成资源处理',
    llm_review: 'LLM 审查优化',
    validation: '自动规范与门禁校验',
    formatting: '正式排版整理',
    export_ready: '导出就绪检查',
    reference: '资料增强',
  };
  return titles[type];
}

function stageRoleDisplayName(roleId?: string) {
  const names: Record<string, string> = {
    'knowledge-base': '知识库', 'document-readiness': '生成准备度检查', 'quality-repair': '质量补写', 'export-gate': '导出门禁',
    'context-memory': '项目上下文', 'final-format': '正式排版', 'multimodal-files': '多模态文件理解', 'llm-json': 'LLM 事实抽取',
    'llm-review': 'LLM 审查', 'document-workflow': '最终规范校验',
  };
  return roleId ? names[roleId] : undefined;
}

function displayStage(stage: DocumentExecutionStage, overrides: Partial<DocumentExecutionStage> = {}): DocumentExecutionStage {
  const next = { executionVersion: 2 as const, title: stageTitle(stage.type), group: stage.type, ...stage, ...overrides };
  return { ...next, roleName: next.roleName || stageRoleDisplayName(next.roleId), subtitle: next.subtitle || next.roleName || stageRoleDisplayName(next.roleId) };
}

function chaptersFromTenderPlan(plan: TenderPlanChapter[], limit = 2, baseChapters: DocumentTemplateChapter[] = []): DocumentTemplateChapter[] {
  const baseTitles = new Set(baseChapters.map(chapter => displayChapterTitle(chapter.title)));
  return plan.filter(chapter => {
    const title = normalizeGeneratedChapterTitle(chapter.title);
    if (!title || !isValidGeneratedChapterTitle(chapter.title) || baseTitles.has(title) || isPollutedChapterTitle(title)) return false;
    const text = `${title}\n${chapter.sourceRequirement}\n${chapter.requiredContents.join('、')}\n${chapter.writingRules.join('、')}`;
    if (/(总结|汇总|依据|清单|公告|范围)/u.test(title)) return false;
    return /缺口|补充|未覆盖|遗漏|查漏补缺|专项|必要|深化|保障/u.test(text);
  }).slice(0, Math.max(0, limit)).map((chapter, index) => {
    const title = normalizeGeneratedChapterTitle(chapter.title);
    return {
      id: safePlanId(chapter.id, `dynamic-${index + 1}`),
      title,
      purpose: [`动态补充章节只能用于查漏补缺，补充评审标准未覆盖但本项目必须响应的专项内容；不得作为资料总结、清单依据或招标范围汇总。`, chapter.sourceRequirement, ...chapter.writingRules].filter(Boolean).join('\n').slice(0, 1200),
      requiredFacts: [...new Set([...chapter.requiredContents, ...chapter.evidenceNeeds])],
      queries: [...new Set([title, ...chapter.requiredContents, ...chapter.evidenceNeeds, ...chapter.requirements.flatMap(item => [item.title, item.requirementText, ...item.evidenceNeeds])].filter(Boolean))],
      pinnedEvidenceFilePaths: [],
    };
  });
}

function chapterPlanFor(chapter: DocumentTemplateChapter, plan: TenderPlanChapter[]) {
  return plan.find(item => item.id === chapter.id || item.title === chapter.title);
}

function roleFactsForChapter(artifacts: RoleNodeArtifact[], chapter: DocumentTemplateChapter, plan?: TenderPlanChapter) {
  const hints = [chapter.title, ...(chapter.requiredFacts || []), ...(plan?.requiredContents || []), ...(plan?.evidenceNeeds || []), ...(plan?.requirements.flatMap(item => [item.title, ...item.requiredContents, ...item.evidenceNeeds]) || [])].filter(Boolean);
  return artifacts.flatMap(artifact => artifact.facts.map(fact => ({ artifact, fact }))).filter(({ fact }) => {
    const text = `${fact.key}\n${stringifyFactValue(fact.value)}\n${fact.relatedChapterHints.join('\n')}`;
    return hints.length === 0 || hints.some(hint => text.includes(hint) || hint.includes(fact.key));
  }).slice(0, 80);
}

function buildRoleChapterContext(artifacts: RoleNodeArtifact[], chapter: DocumentTemplateChapter, plan?: TenderPlanChapter) {
  const matchedFacts = roleFactsForChapter(artifacts, chapter, plan);
  const planText = plan ? [
    `章节来源要求：${plan.sourceRequirement}`,
    plan.requiredContents.length ? `必须包含：${plan.requiredContents.join('、')}` : '',
    plan.writingRules.length ? `写作规范：${plan.writingRules.join('、')}` : '',
    plan.evidenceNeeds.length ? `需要证据：${plan.evidenceNeeds.join('、')}` : '',
    plan.requirements.length ? `要求项：\n${plan.requirements.map(item => `- ${item.title}：${item.requirementText || item.requiredContents.join('、')}`).join('\n')}` : '',
  ].filter(Boolean).join('\n') : '';
  const factGroups = new Map<string, string[]>();
  for (const { artifact, fact } of matchedFacts) {
    const key = `${artifact.node.fileRoleName}（${artifact.node.outputType}）`;
    factGroups.set(key, [...(factGroups.get(key) || []), `- ${fact.key}：${cleanEvidenceText(stringifyFactValue(fact.value))}`]);
  }
  const factsText = [...factGroups.entries()].map(([key, lines]) => `### ${key}\n${lines.slice(0, 18).map(line => line.replace(FILE_NAME_RE, '').replace(CAD_ENTITY_TOKEN_RE, '')).join('\n')}`).join('\n\n');
  return [planText ? `【本章章节计划】\n${planText}` : '', factsText ? `【角色节点结构化产物】\n${factsText}` : ''].filter(Boolean).join('\n\n');
}

function shouldForbidDrawingImages(artifacts: RoleNodeArtifact[], _template: DocumentTemplate) {
  return artifacts.some(item => item.forbidImageInsertion || item.node.outputType === 'drawing_facts');
}

function removeUnwantedDrawingImages(markdown: string, forbid: boolean) {
  if (!forbid) return markdown;
  return markdown.replace(/^!\[[^\]]*(?:图纸|drawing|cad|地图|平面|剖面|立面)[^\]]*\]\([^)]*\)\s*$/gimu, '').replace(/\n{3,}/gu, '\n\n');
}

const WORKFLOW_PHRASE_RE = /.*(?:知识库证据|文件角色|提示词角色|后台自动规范|规范包|事实字段|资料未提供|未检索到|待确认事项|证据来源|来源清单|校验结果).*(?:\n|$)/gu;
const RAW_SOURCE_LINE_RE = /^\s*(?:#{1,6}\s*)?(?:PDF\s*第\s*\d+\s*页|rule\b|文件[:：]|片段[:：]|来源[:：]).*$/gimu;
const ASCII_FLOW_LINE_RE = /^\s*(?:[│┃┆┊┌┐└┘├┤┬┴┼─━╭╮╰╯]|[↓↑→←⇒⇨➡])+\s*$/gmu;

function normalizeProductionText(markdown: string) {
  return markdown
    .replace(/\b(m|㎡)\s*2\b/giu, '平方米')
    .replace(/\bm\s*[²2]\b/giu, '平方米')
    .replace(/\b(m|㎥)\s*3\b/giu, '立方米')
    .replace(/\bm\s*[³3]\b/giu, '立方米')
    .replace(/\bmm2\b/giu, '平方毫米')
    .replace(/\bcm2\b/giu, '平方厘米')
    .replace(/\bkm2\b/giu, '平方千米')
    .replace(/\s*×\s*/gu, '×')
    .replace(/\s*≤\s*/gu, '≤')
    .replace(/\s*≥\s*/gu, '≥')
    .replace(/\s*±\s*/gu, '±');
}

function stripMarkdownDocumentFence(markdown: string) {
  const trimmed = markdown.trim();
  const match = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/iu.exec(trimmed);
  return match ? match[1].trim() : markdown;
}

function sanitizeFormalMarkdown(markdown: string) {
  return normalizeProductionText(stripMarkdownDocumentFence(markdown))
    .replace(WORKFLOW_PHRASE_RE, '')
    .replace(RAW_SOURCE_LINE_RE, '')
    .replace(ASCII_FLOW_LINE_RE, '')
    .replace(FILE_NAME_RE, '')
    .replace(/^#\s+/gmu, '')
    .replace(CAD_ENTITY_TOKEN_RE, '')
    .replace(/第\s*\d+\s*页\s*\/\s*共\s*\d+\s*页/gu, '')
    .replace(/\|\s*(?:[/—-]|无|暂无|待定|待补充|N\/?A)\s*(?=\|)/giu, '| 结合项目资料及现场深化确认 ')
    .replace(/见(?:招标文件|招标公告|图纸|设计文件|相关文件)/gu, '依据已提供招标资料和设计资料')
    .replace(/按(?:图纸|设计要求|相关规范|有关规范|文件要求)/gu, '依据已提供设计资料和现行规范')
    .replace(/满足(?:相关|有关)?要求/gu, '满足招标文件、设计文件及现行验收规范要求')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

const FORMAL_WRITING_RULES = [
  '你正在生成可直接交付的正式业务文档，不是分析报告、证据报告或系统调试报告。',
  '不得把“知识库、检索、文件角色、提示词角色、规范包、事实字段、动态章节、缺失项、校验结果、资料未提供、未检索到”等后台流程话术写入正文。',
  '文档结构、禁用标题、必需章节、事实取舍和行业表达必须优先遵循用户绑定的提示词角色、项目角色配置和后台自动规范；通用生成链路不得擅自发明业务规则。',
  '资料信息应内化为正式正文表达；除非后台自动规范或用户要求来源追溯章节，否则不要单列系统证据清单。',
  '表格、标题和公式必须使用 Markdown/导出友好的写法，避免 ASCII 流程图和容易导致导出异常的符号组合。',
  '正式正文不得把招标公告、评标办法、清单编制说明、公共资源交易条款或规程条款原文误作为章节标题或目录项。',
  '施工组织设计类文件必须内化招标公告项目基本信息，编制依据应覆盖招标资料、清单图纸、国家法律法规、现行规范标准和地方规章；项目基本信息已表格化时，表格前只保留一句引导语，不得逐项重复叙述同一批字段。',
  '施工组织设计类文件必须以项目实际工程对象、施工部位、工程量、设计参数、工期节点和资源投入为约束；日期、数量、数值、单位、规格不得自由发挥。',
  '同一施工方案、工艺或措施适用于多个部位、区域、学校、片区或分项时，必须逐项覆盖，不得只写一个代表性数量后泛化到全部范围。',
  '不得使用“本节”“本章将”“以下从”“以下内容”等模板化前缀；标题后直接进入施工对象、工艺动作、控制措施、检查验收和责任闭环。',
  '正文二级小节下如需设置三级小节，必须使用“#### 章号.节号.序号 标题”，例如“#### 2.2.1 管沟开挖”；不得用无编号独立加粗行表示三级小节；三级小节不纳入目录。',
  '资料不足或不同来源数值冲突时，应保持审慎并提示复核口径，不得编造精确数量。',
  '语言应正式、专业、克制，适合直接导出交付。',
].join('\n');

function tenderQualityIssues(markdown: string, chapters: DocumentDraftChapter[], plan: TenderPlanChapter[], artifacts: RoleNodeArtifact[], forbidDrawingImages: boolean) {
  const issues: string[] = [];
  for (const chapter of plan) {
    if (!markdown.includes(chapter.title)) issues.push(`缺少动态章节：${chapter.title}`);
    for (const item of chapter.requiredContents.slice(0, 12)) if (item && !markdown.includes(item)) issues.push(`${chapter.title} 未覆盖必写内容：${item}`);
  }
  for (const chapter of chapters) {
    const planItem = plan.find(item => item.title === chapter.title);
    const min = planItem?.minWords || 1000;
    if (chapter.content.length < min) issues.push(`${chapter.title} 内容深度不足：${chapter.content.length}/${min}`);
    if ((chapter.sections || []).length < 3) issues.push(`${chapter.title} 二级小节少于 3 个，必须由模型结合章节主题和项目资料补齐 3-6 个正式二级小节`);
    for (const section of chapter.sections || []) {
      if (section && !markdown.includes(section)) issues.push(`${chapter.title} 缺少目录小节：${section}`);
    }
  }
  for (const artifact of artifacts) {
    const importantFacts = artifact.facts.slice(0, 5).map(fact => stringifyFactValue(fact.value).slice(0, 24)).filter(value => value.length >= 6);
    if (importantFacts.length > 0 && !importantFacts.some(value => markdown.includes(value))) issues.push(`未体现 ${artifact.node.fileRoleName} 的关键读取结果`);
  }
  if (forbidDrawingImages && /!\[[^\]]*\]\([^)]*\)/iu.test(markdown)) issues.push('正文包含不应插入的图片');
  if (/\b(?:m\s*[²2]|m\s*[³3]|mm2|cm2|km2)\b/iu.test(markdown)) issues.push('正文包含导出不友好的计量单位写法');
  return [...new Set(issues)].slice(0, 40);
}

async function repairMarkdownByQuality(input: { markdown: string; template: DocumentTemplate; plan: TenderPlanChapter[]; artifacts: RoleNodeArtifact[]; promptTexts: string; requirement?: string; issues: string[]; forbidDrawingImages: boolean }) {
  if (input.issues.length === 0) return { markdown: input.markdown, stage: undefined as DocumentExecutionStage | undefined };
  const configuredStructure = configuredStructurePrompt(input.template);
  const repaired = await callDocumentLlm([
    '你是文档质量补写和纠偏专家。必须严格按照模板、章节计划、后台自动规范、提示词角色和已提供资料补齐内容，禁止编造。',
    input.forbidDrawingImages ? '图片/图纸类资料只作为文本事实来源，禁止插入图片或 Markdown 图片语法。' : '',
    '你必须优先修复“配置要求缺少/不得出现/表格不足/Markdown 标题符号”等门禁问题；能通过改写、删除污染文本、补充正式表格解决的问题必须直接修复，不要只解释。',
    '保持 Markdown 标题层级；直接返回修复后的完整 Markdown。',
    '必须保留文档开头的“## 目录”，目录必须是父子级导航：一级章按“第一章 xxx”作为父级单独成行，二级小节按“1.1 xxx、1.2 xxx”缩进列在所属章下方；不得删除目录页和页分隔符。',
    '必须保留模板配置的章节和二级小节；若章节未配置二级小节、出现“缺少模型自行生成的二级小节”或任一章节二级小节少于 3 个，必须由模型结合章节主题和资料补齐 3-6 个正式二级小节，不得使用固定默认小节。配置要求使用表格的小节，应由已提供资料和正文内容归纳生成正式 Markdown 表格，不得输出证据摘录表。',
    '二级小节下如需设置三级小节，必须统一改为“#### 章号.节号.序号 标题”，例如“#### 2.2.1 管沟开挖”；三级小节不纳入目录；不得保留“**管沟开挖**”这类无编号独立加粗标题。',
    '必须进行整文一致性审查：招标公告、清单、图纸、规范、答疑之间如存在项目名称、范围、工期、质量、规格、数量、材料、系统参数冲突，应优先采用招标公告、答疑补遗、图纸设计说明和清单项目特征中的明确事实，并在正文中保持同一口径。',
    '项目基本信息、项目基本信息表、招标公告基本信息只允许出现在第一章；第二章及后续章节如出现此类重复小节或表格，必须删除并改写为本章专业内容；第一章已有项目基本信息表时，表格前只保留一句引导语，不得重复逐项叙述项目名称、编号、地点、工期、质量等字段。',
    '必须删除“本节”“本章将”“以下从”“以下内容”等模板化前缀，标题后直接写实质内容。',
    '必须检查重要信息遗漏：清单/图纸中的规格、管径、尺寸、厚度、强度、工程量、设备数量、试验验收和工艺参数不得被“按设计要求/满足规范”替代；发现遗漏必须补入对应分项章节。',
    '对“量化对象覆盖不足”“量化数值使用不足”的问题，必须按施工对象、部位、区域、学校、片区或分项逐项补齐适用范围、工程量、工期节点、资源配置和控制措施；不得只写一个代表性数量。',
    '补写日期、数量、单位、规格和资源数量时只能使用资料、角色节点产物或正文已有可信事实；缺少依据时不得编造，应改写为需复核的正式管理措施。',
    input.promptTexts,
  ].filter(Boolean).join('\n\n'), [
    `模板：${input.template.name}`,
    input.requirement ? `用户要求：${input.requirement}` : '',
    `需要修复的问题：\n${input.issues.map(item => `- ${item}`).join('\n')}`,
    configuredStructure ? `模板配置结构要求：\n${configuredStructure}` : '',
    `章节计划：\n${input.plan.map(chapter => `- ${chapter.title}：${chapter.requiredContents.join('、')}；要求=${chapter.sourceRequirement.slice(0, 200)}`).join('\n')}`,
    '角色节点产物摘要：',
    roleArtifactsDigest(input.artifacts, extractTenderAnnouncementFacts(input.artifacts.flatMap(artifact => artifact.evidence))),
    '待修复 Markdown：',
    input.markdown,
  ].filter(Boolean).join('\n\n'));
  if (!repaired || repaired.length < input.markdown.length * 0.85 || !repaired.includes('#')) {
    return { markdown: input.markdown, stage: { type: 'llm_review' as const, roleId: 'quality-repair', status: 'fallback' as const, message: `质量补写未返回有效结果：${input.issues.slice(0, 5).join('；')}` } };
  }
  return { markdown: sanitizeFormalMarkdown(removeUnwantedDrawingImages(repaired, input.forbidDrawingImages)), stage: { type: 'llm_review' as const, roleId: 'quality-repair', status: 'success' as const, message: `已按角色节点和章节计划完成质量补写，修复 ${input.issues.length} 项` } };
}

/** 从证据中抽取事实字段，按规范包中的事实定义进行匹配 */
function extractFacts(template: DocumentTemplate, evidence: DocumentEvidence[], spec?: AutoDocumentSpecPackage): Record<string, string> {
  const facts: Record<string, string> = {};
  for (const field of specFactTargets(template, spec)) {
    const hit = evidence.find(item => evidenceSatisfiesSpecField(item, field));
    if (hit) facts[field.name] = `${hit.content.replace(/\s+/gu, ' ').slice(0, 180)}（来源：${hit.filePath}，角色：${hit.roleId || '未标注'}）`;
  }
  return facts;
}

function defaultProjectRoleConfigIdForTemplate(template: DocumentTemplate) {
  if (template.projectRoleConfigId) return template.projectRoleConfigId;
  const text = `${template.name} ${template.category} ${template.outputTitle} ${template.description}`;
  if (templateMatchesConfiguredReviewChapters(template) || /施工组织设计|施工方案|技术标.*施工|施工.*技术标/iu.test(text)) return 'construction-bid-sgzsj-professional';
  return undefined;
}

function projectRoleConfigForTemplate(template: DocumentTemplate) {
  const configId = defaultProjectRoleConfigIdForTemplate(template);
  return configId ? getProjectRoleConfig(configId) : undefined;
}

function materialRolesForFileRole(roleId: string): MaterialRole[] {
  if (/tender|response|requirements|招标|评审|实质/u.test(roleId)) return ['tender_document', 'technical_specification', 'schedule_quality_safety'];
  if (/boq|清单|scope|工程量/u.test(roleId)) return ['bill_of_quantities', 'construction_scope', 'control_price'];
  if (/drawing|drawings|图纸|design/u.test(roleId)) return ['drawings'];
  if (/schedule|quality|safety|工期|质量|安全/u.test(roleId)) return ['schedule_quality_safety', 'technical_specification'];
  if (/risk|constraints|现场|重点|难点/u.test(roleId)) return ['risk_constraints', 'addendum', 'tender_document'];
  if (/material|equipment|brand|材料|设备|品牌/u.test(roleId)) return ['brand_recommendation', 'bill_of_quantities', 'technical_specification'];
  if (/enterprise|reference|经验|体系/u.test(roleId)) return ['project_overview', 'technical_specification'];
  return ['project_overview'];
}

function boundFileRolesForMaterialSummary(bindings: FileBinding[]) {
  const grouped = new Map<string, MaterialRole[]>();
  for (const binding of bindings) {
    grouped.set(binding.filePath, [...new Set([...(grouped.get(binding.filePath) || []), ...materialRolesForFileRole(binding.roleId)])]);
  }
  return [...grouped.entries()].map(([filePath, roles]) => ({ filePath, roles }));
}

function fileBindingsFromMaterialSummary(template: DocumentTemplate, summary: ProjectMaterialSummary): FileBinding[] {
  const config = projectRoleConfigForTemplate(template);
  if (!config) return [];
  const bindings: FileBinding[] = [];
  for (const item of [...config.fileRoles].sort((a, b) => a.order - b.order)) {
    const roles = materialRolesForFileRole(item.roleId);
    const files = roles.flatMap(role => summary.materialInventory[role] || []);
    for (const file of files.slice(0, 20)) bindings.push({ roleId: item.roleId, filePath: file.filePath });
  }
  const seen = new Set<string>();
  return bindings.filter(binding => {
    const key = `${binding.roleId}\n${binding.filePath}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function templatePromptBindings(template: DocumentTemplate): PromptBinding[] {
  const config = projectRoleConfigForTemplate(template);
  if (config) {
    const roles = listDocumentRoles('prompt');
    return [...config.promptRoles]
      .sort((a, b) => a.order - b.order)
      .map(item => roles.find(role => role.id === item.roleId))
      .filter((role): role is NonNullable<typeof role> => !!role)
      .flatMap(role => (role.resourceIds?.length ? role.resourceIds : role.resourceId ? [role.resourceId] : []).map(promptId => ({ promptId, roleId: role.id })));
  }
  return template.promptBindings?.length ? template.promptBindings : (template.promptIds ?? []).map(promptId => ({ promptId, roleId: 'chapter_generation' }));
}

function templateFileBindings(template: DocumentTemplate): FileBinding[] {
  return template.fileBindings?.length ? template.fileBindings : (template.boundFilePaths ?? []).map(filePath => ({ filePath, roleId: 'project_fact' }));
}

function promptTextsForExecution(promptBindings: PromptBinding[], executionTypes: string[]) {
  const promptRoles = listDocumentRoles('prompt');
  const roleTypes = new Map(promptRoles.map(role => [role.id, role.executionType || 'reference']));
  return readPromptContents(promptBindings)
    .filter(prompt => executionTypes.includes(roleTypes.get(prompt.roleId) || 'reference'))
    .map(prompt => `## [${prompt.roleId}] ${prompt.name}\n${prompt.content}`)
    .join('\n\n');
}

function templateMatchesConfiguredReviewChapters(template: DocumentTemplate) {
  const matchers = readEngineeringDocumentConfig().reviewChapterTemplateMatchers;
  if (matchers.length === 0) return false;
  const text = `${template.name} ${template.category} ${template.outputTitle}`;
  return matchers.some(pattern => new RegExp(pattern, 'iu').test(text));
}

function providerFactoryName(providerName: string, providerConfig?: { protocol?: string }) {
  const protocol = resolveProtocol(providerName, providerConfig);
  if (protocol === 'anthropic') return 'anthropic';
  if (protocol === 'google') return 'google';
  if (protocol === 'ollama') return 'ollama';
  if (protocol === 'openrouter') return 'openrouter';
  return 'openai';
}

function getActiveModelWithProvider() {
  const config = getConfigStore().load();
  const activeModel = config.models.reasoning.active || config.models.action.active || config.models.reader.active;
  const selected = [...config.models.reasoning.list, ...config.models.action.list, ...config.models.reader.list].find(model => model.name === activeModel);
  if (!selected) return undefined;
  const providerConfig = config.providers[selected.provider];
  if (!providerConfig) return undefined;
  return { model: selected, provider: providerConfig };
}

/** 调用底层 LLM 进行文档生成，支持文本模式和 JSON 模式 */
async function callDocumentLlm(system: string, prompt: string, jsonOnly = false): Promise<string | undefined> {
  try {
    const active = getActiveModelWithProvider();
    if (!active) return undefined;
    const { model: selected, provider: providerConfig } = active;
    const provider = createProvider(providerFactoryName(selected.provider, providerConfig), { baseUrl: providerConfig.baseUrl, apiKey: providerConfig.apiKey, modelName: selected.name, directEndpoint: providerConfig.directEndpoint });
    const response = await provider.chat([
      { role: 'system', content: jsonOnly ? `${system}\n只返回 JSON，不要返回 markdown。` : system },
      { role: 'user', content: prompt },
    ], { temperature: jsonOnly ? 0 : 0.3 });
    return response.content.trim();
  } catch {
    return undefined;
  }
}

/** 调用 LLM 并以 JSON 格式解析返回结果 */
async function callDocumentLlmJson<T>(system: string, prompt: string): Promise<T | undefined> {
  const response = await callDocumentLlm(system, prompt, true);
  if (!response) return undefined;
  try {
    const raw = response.replace(/^```json\s*/u, '').replace(/^```\s*/u, '').replace(/```$/u, '').trim();
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function extractStructuredTables(evidence: DocumentEvidence[]): StructuredTableFact[] {
  const tables: StructuredTableFact[] = [];
  const seen = new Set<string>();
  for (const item of evidence.filter(e => e.processingType === 'table')) {
    if (seen.has(item.filePath)) continue;
    seen.add(item.filePath);
    const root = getProjectRoot();
    const absolute = path.isAbsolute(item.filePath) ? item.filePath : fs.existsSync(path.join(root, 'knowledgeBase', item.filePath)) ? path.join(root, 'knowledgeBase', item.filePath) : path.join(root, item.filePath);
    const ext = path.extname(item.filePath).toLowerCase();
    if (fs.existsSync(absolute) && ['.xlsx', '.xls', '.csv'].includes(ext)) {
      try {
        const workbook = XLSX.readFile(absolute, { cellDates: true, sheetStubs: false });
        for (const sheetName of workbook.SheetNames) {
          const sheet = workbook.Sheets[sheetName];
          const matrix = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, raw: false, defval: '' }).map(row => row.map(cell => String(cell).trim()));
          const nonEmpty = matrix.filter(row => row.some(Boolean));
          if (nonEmpty.length < 2) continue;
          const headerIndex = nonEmpty.findIndex(row => row.filter(Boolean).length >= 2);
          if (headerIndex < 0) continue;
          const headers = nonEmpty[headerIndex].filter(Boolean);
          const rows = nonEmpty.slice(headerIndex + 1).map(row => row.slice(0, headers.length)).filter(row => row.some(Boolean));
          if (rows.length === 0) continue;
          tables.push({ tableType: item.roleId || 'table', sheet: sheetName, headers, rows: rows.slice(0, 200), sourceFile: item.filePath, sourceRange: sheet['!ref'] });
        }
        continue;
      } catch {
        // 回退到文本解析
      }
    }
    const lines = item.content.split('\n').map(line => line.trim()).filter(Boolean);
    const tableLines = lines.filter(line => line.includes('|') || line.includes('\t') || line.includes(','));
    if (tableLines.length < 2) continue;
    const delimiter = tableLines[0].includes('|') ? '|' : tableLines[0].includes('\t') ? '\t' : ',';
    const rows = tableLines.map(line => line.split(delimiter).map(cell => cell.trim()).filter(Boolean)).filter(row => row.length > 1);
    if (rows.length < 2) continue;
    tables.push({ tableType: item.roleId || 'table', headers: rows[0], rows: rows.slice(1, 80), sourceFile: item.filePath, sourceRange: item.sectionTitle });
  }
  return tables;
}

function fieldExtractionPattern(name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`${escaped}[：:\\s]+([^\\n，。；;]+)`, 'u');
}

function extractStructuredFacts(evidence: DocumentEvidence[], template: DocumentTemplate, spec?: AutoDocumentSpecPackage): DocumentFact[] {
  const dynamicPatterns = specFactTargets(template, spec).map(field => ({ field, pattern: fieldExtractionPattern(field.name) }));
  const facts: DocumentFact[] = [];
  for (const item of evidence) {
    for (const { field, pattern } of dynamicPatterns) {
      if (!evidenceSatisfiesSpecField(item, field)) continue;
      const match = item.content.match(pattern) || [undefined, item.content.replace(/\s+/gu, ' ').slice(0, 220)];
      const value = match?.[1]?.trim();
      if (value && !facts.some(fact => fact.fieldId === field.id && fact.value === value)) {
        facts.push({ key: field.name, fieldId: field.id, fieldName: field.name, value: value.slice(0, 300), sourceFile: item.filePath, roleId: item.roleId || 'unknown', processingType: item.processingType, confidence: item.score, sourceRef: { filePath: item.filePath, roleId: item.roleId || 'unknown', processingType: item.processingType, sectionTitle: item.sectionTitle } });
      }
    }
  }
  return facts;
}

function mimeTypeFromPath(filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.pdf') return 'application/pdf';
  if (ext === '.docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (ext === '.xlsx') return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  return 'application/octet-stream';
}

async function understandReferenceFiles(projectRoot: string, evidence: DocumentEvidence[]): Promise<{ notes: string[]; stage: DocumentExecutionStage }> {
  const active = getActiveModelWithProvider();
  if (!active?.provider.capabilities?.fileUnderstanding && !active?.provider.capabilities?.imageUnderstanding) {
    return { notes: [], stage: { type: 'file_understanding', roleId: 'multimodal-files', status: 'skipped', message: '当前模型未开启文件理解/图片理解能力' } };
  }
  const provider = createProvider(providerFactoryName(active.model.provider, active.provider), { baseUrl: active.provider.baseUrl, apiKey: active.provider.apiKey, modelName: active.model.name, directEndpoint: active.provider.directEndpoint });
  const fileAwareProvider = provider as typeof provider & { understandFiles?: (files: Array<{ name: string; mimeType: string; data: Buffer }>, prompt: string, options?: { maxTokens?: number }) => Promise<{ content: string }> };
  if (!fileAwareProvider.understandFiles) return { notes: [], stage: { type: 'file_understanding', roleId: 'multimodal-files', status: 'skipped', message: '当前 Provider 未实现文件理解接口' } };
  const candidates = [...new Set(evidence.map(item => item.filePath).filter(file => /\.(png|jpe?g|webp|pdf|docx|xlsx)$/iu.test(file)))].slice(0, 6);
  const files = candidates.map(filePath => {
    const absolute = path.join(projectRoot, 'knowledgeBase', filePath);
    return fs.existsSync(absolute) ? { name: path.basename(filePath), mimeType: mimeTypeFromPath(filePath), data: fs.readFileSync(absolute) } : undefined;
  }).filter(Boolean) as Array<{ name: string; mimeType: string; data: Buffer }>;
  if (files.length === 0) return { notes: [], stage: { type: 'file_understanding', roleId: 'multimodal-files', status: 'skipped', message: '没有可发送给多模态模型的参考文件' } };
  try {
    const response = await fileAwareProvider.understandFiles(files, '请阅读这些参考图片/文件，提炼可用于文档生成和审查的事实、视觉要点、地图信息和封面设计建议。请用中文要点输出。', { maxTokens: 1200 });
    const note = response.content.trim();
    return { notes: note ? [note] : [], stage: { type: 'file_understanding', roleId: 'multimodal-files', status: note ? 'success' : 'fallback', message: note ? `已理解 ${files.length} 个多模态参考文件` : '多模态模型未返回有效文件理解结果' } };
  } catch {
    return { notes: [], stage: { type: 'file_understanding', roleId: 'multimodal-files', status: 'fallback', message: '文件理解调用失败，继续使用本地解析内容' } };
  }
}

async function extractFactsWithLlm(evidence: DocumentEvidence[], promptTexts: string, template: DocumentTemplate, spec?: AutoDocumentSpecPackage): Promise<{ facts: DocumentFact[]; stages: DocumentExecutionStage[] }> {
  const stages: DocumentExecutionStage[] = [{ type: 'fact_extraction', roleId: 'llm-json', status: 'skipped', message: 'LLM JSON 抽取未启用或无可用模型' }];
  const sample = evidence.slice(0, 24).map(item => `文件:${item.filePath}\n角色:${item.roleId || ''}\n处理:${item.processingType || ''}\n内容:${item.content.slice(0, 1200)}`).join('\n\n---\n\n');
  if (!sample.trim()) return { facts: [], stages };
  const targets = specFactTargets(template, spec);
  const schemaText = targets.map(field => `- id=${field.id} name=${field.name} type=auto required=${field.required} sourceRoleIds=${field.sourceRoleIds.join(',') || '不限'} hint=${field.extractionHint || '无'}`).join('\n');
  const llm = await callDocumentLlmJson<{ facts?: Array<{ fieldId?: string; fieldName?: string; key: string; value: string; sourceFile?: string; roleId?: string; processingType?: string; confidence?: number }> }>(
    promptTexts || '你是文档事实抽取器。',
    `请严格按下面的动态事实 schema 从资料中抽取事实。只抽取资料明确支持的内容；如果字段限定 sourceRoleIds，必须优先来自对应文件角色；事实取舍和冲突处理遵循规范包字段说明、文件角色和提示词角色配置。\n返回 {"facts":[{"fieldId":"...","fieldName":"...","key":"...","value":"...","sourceFile":"...","roleId":"...","processingType":"project_fact","confidence":0.8}]}。\n\n动态事实 schema：\n${schemaText}\n\n资料：\n${sample}`, 
  );
  if (!llm?.facts?.length) return { facts: [], stages };
  return {
    facts: llm.facts.filter(item => item.key && item.value).map(item => {
      const field = targets.find(target => target.id === item.fieldId || target.name === item.fieldName || target.name === item.key);
      return {
        key: field?.name || item.key,
        fieldId: field?.id || item.fieldId,
        fieldName: field?.name || item.fieldName,
        value: stringifyFactValue(item.value),
        sourceFile: item.sourceFile || '',
        roleId: item.roleId || 'llm',
        processingType: item.processingType,
        confidence: item.confidence ?? 0.8,
        sourceRef: { filePath: item.sourceFile || '', roleId: item.roleId || 'llm', processingType: item.processingType },
      };
    }),
    stages: [{ type: 'fact_extraction', roleId: 'llm-json', status: 'success', message: `LLM 按动态 schema 抽取 ${llm.facts.length} 条事实` }],
  };
}

function normalizedFactValue(value: unknown) {
  return stringifyFactValue(value).replace(/\s+/gu, '').replace(/[，。,.;；：:]/gu, '').toLowerCase();
}

function detectFactConflicts(facts: DocumentFact[], spec?: AutoDocumentSpecPackage) {
  const conflictKeys = spec?.factFields.map(field => field.name) || [...new Set(facts.map(fact => fact.key))];
  const conflicts: string[] = [];
  for (const key of conflictKeys) {
    const items = facts.filter(fact => fact.key === key || fact.fieldName === key);
    const values = new Map<string, DocumentFact[]>();
    for (const item of items) {
      const normalized = normalizedFactValue(item.value);
      if (!normalized) continue;
      values.set(normalized, [...(values.get(normalized) || []), item]);
    }
    if (values.size > 1) {
      const detail = [...values.values()].map(group => `${group[0]!.value}（${group.map(item => item.sourceFile).join('、')}）`).join(' vs ');
      conflicts.push(`事实冲突：${key} 存在多个来源值：${detail}`);
    }
  }
  return conflicts;
}

function buildSchemaFacts(facts: DocumentFact[], spec?: AutoDocumentSpecPackage) {
  const schemaFacts: Record<string, DocumentFact[]> = {};
  for (const field of spec?.factFields || []) {
    schemaFacts[field.id] = facts.filter(fact => fact.fieldId === field.id || fact.key === field.name || fact.fieldName === field.name);
  }
  return schemaFacts;
}

function buildFactsModel(facts: DocumentFact[], tables: StructuredTableFact[] = [], missingItems: string[] = [], spec?: AutoDocumentSpecPackage): DocumentFactsModel {
  const byKeys = (keys: string[]) => facts.filter(fact => keys.some(key => fact.key.includes(key)));
  const byProcessing = (type: string) => facts.filter(fact => fact.processingType === type || fact.roleId.includes(type));
  const preciseFacts = facts.filter(fact => /\d|DN|φ|Φ|mm|cm|m²|m3|MPa|kPa|℃|%|GB|JGJ|CJJ|台|套|个|项|㎡/iu.test(`${fact.key} ${fact.value}`));
  const billFacts = facts.filter(fact => fact.processingType === 'table' || /bill|boq|清单|工程量/u.test(`${fact.roleId} ${fact.sourceFile}`));
  return {
    project: facts,
    schedule: byKeys(['工期', '开工', '竣工', '节点']),
    quality: byKeys(['质量']),
    safety: byKeys(['安全']),
    resources: byKeys(['劳动力', '材料', '机械', '设备']),
    tables,
    drawings: byProcessing('drawing'),
    bills: billFacts,
    preciseFacts,
    rules: byProcessing('rule'),
    specifications: byProcessing('specification'),
    schemaFacts: buildSchemaFacts(facts, spec),
    missing: [...new Set(missingItems)],
    conflicts: detectFactConflicts(facts, spec),
  };
}

function isExportBlockingIssue(issue: ValidationIssue) {
  return /用户要求|出现禁用文本|资料未提供|导出|临时|无效|占位|生成未完成|低于目标页数|兜底|章节生成失败|大模型未能|重新生成|缺少配置小节|缺少必要的正式表格|正文缺少章节标题|其他项目|项目编号|项目名称|事实一致性冲突|工程专项资料角色缺失|章节缺少证据|文档质量基准评分未达标/iu.test(issue.message);
}

function estimateDocumentPages(markdown: string, settings?: DocumentGenerationSettings | DocumentExportSettings) {
  const textLength = markdown.replace(/<[^>]+>/gu, '').replace(/\s+/gu, '').length;
  const bodyFontSize = Number(String(settings && 'typography' in settings ? settings.typography?.bodySize || '' : '').replace(/[^\d.]/gu, '')) || 14;
  const lineHeight = Number(String(settings && 'typography' in settings ? settings.typography?.lineHeight || '' : '').replace(/[^\d.]/gu, '')) || 22;
  const charsPerPage = bodyFontSize >= 14 && lineHeight >= 22 ? 620 : 800;
  return Math.ceil(textLength / charsPerPage);
}

function pageTargetIssues(settings: DocumentGenerationSettings | DocumentExportSettings | undefined, markdown: string): ValidationIssue[] {
  const target = settings?.targetPages;
  if (!target?.min && !target?.target && !target?.max) return [];
  const estimatedPages = estimateDocumentPages(markdown, settings);
  const min = target.min || target.target;
  const max = target.max || target.target;
  const issues: ValidationIssue[] = [];
  if (min && estimatedPages < min) issues.push({ level: 'error', message: `正文篇幅低于目标页数：预计约 ${estimatedPages} 页，目标不少于 ${min} 页`, suggestion: '请重新生成或增加章节正文深度后再导出正式文件。' });
  if (max && estimatedPages > max + 4) issues.push({ level: 'warning', message: `正文篇幅可能超过目标页数：预计约 ${estimatedPages} 页，目标不超过 ${max} 页`, suggestion: '建议检查是否存在重复段落或过度展开。' });
  return issues;
}

function buildExportGate(issues: ValidationIssue[], factsModel: DocumentFactsModel, chapters: DocumentDraftChapter[]): ExportGateResult {
  const checklist = [
    { key: 'no_errors', label: '无阻断级校验错误', passed: !issues.some(issue => issue.level === 'error' && isExportBlockingIssue(issue)) },
    { key: 'project_facts', label: '项目基础事实齐全', passed: factsModel.project.length > 0 },
    { key: 'source_traceability', label: '事实具备来源追踪', passed: [...factsModel.project, ...factsModel.schedule, ...factsModel.quality, ...factsModel.safety].every(fact => Boolean(fact.sourceFile)) },
    { key: 'bill_drawing_precision', label: '清单/图纸精确参数已使用', passed: factsModel.preciseFacts.length < 20 || issues.every(issue => !/清单\/图纸精确参数使用不足|未体现工程量清单|未体现图纸/u.test(issue.message)) },
    { key: 'chapter_evidence', label: '章节均具备证据', passed: chapters.every(chapter => chapter.evidence.length > 0) },
    { key: 'no_missing_content', label: '无资料未提供章节', passed: chapters.every(chapter => !chapter.content.includes('资料未提供')) },
    { key: 'no_project_contamination', label: '无项目污染和事实一致性阻断', passed: !issues.some(issue => issue.level === 'error' && /其他项目|项目编号|项目名称|事实一致性冲突/iu.test(issue.message)) },
  ];
  const blockingIssues = issues.filter(issue => issue.level === 'error' && isExportBlockingIssue(issue));
  return { passed: blockingIssues.length === 0 && checklist.every(item => item.passed), blockingIssues, checklist };
}

function fallbackEvaluatorForRule(rule: AutoDocumentSpecGateRule): GateRuleEvaluator {
  if (rule.evaluator) return rule.evaluator;
  if (rule.type === 'required_fact') return { subject: 'fact', operator: 'exists', target: rule.target };
  if (rule.type === 'required_chapter') return { subject: 'chapter', operator: 'exists', target: rule.target };
  if (rule.type === 'required_file_role') return { subject: 'file_role', operator: 'exists', target: rule.target };
  if (rule.type === 'required_prompt_role') return { subject: 'prompt_role', operator: 'exists', target: rule.target };
  if (rule.type === 'source_required') return { subject: 'source', operator: 'all_have_source' };
  if (rule.type === 'forbidden_text') return { subject: 'document', operator: 'not_contains', value: rule.value };
  if (rule.type === 'min_chapter_length') return { subject: 'chapter', operator: 'min_length', target: rule.target, min: Number(rule.value) || undefined };
  if (rule.type === 'table_required') return { subject: 'table', operator: 'min_count', min: 1 };
  return { subject: 'document', operator: 'contains', value: rule.value || rule.target };
}

function markdownTables(markdown: string) {
  return markdown.split(/\n{2,}/u).filter(block => /\|.+\|/u.test(block) && /\n\s*\|?\s*:?-{3,}:?/u.test(block));
}

function markdownImages(markdown: string) {
  const matches = [...markdown.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/gu)];
  return matches.map(match => ({ alt: match[1] || '', url: match[2] || '', index: match.index ?? 0 }));
}

function safeRegex(value: string) {
  try { return new RegExp(value, 'iu'); } catch { return undefined; }
}

function issueMessage(rule: AutoDocumentSpecGateRule, detail: string) {
  return `${rule.name}：${detail}`;
}

function duplicateProjectBasicInfoIssues(markdown: string): ValidationIssue[] {
  const chapterMatches = [...markdown.matchAll(/^##\s+第[一二三四五六七八九十百]+章\s+.+$/gmu)];
  const issues: ValidationIssue[] = [];
  for (let index = 1; index < chapterMatches.length; index += 1) {
    const start = chapterMatches[index].index || 0;
    const end = chapterMatches[index + 1]?.index ?? markdown.length;
    const content = markdown.slice(start, end);
    if (/项目基本信息表|招标公告项目基本信息|^###\s*项目基本信息\s*$/mu.test(content)) {
      issues.push({ level: 'error', message: `第 ${index + 1} 章重复出现项目基本信息`, suggestion: '项目基本信息只允许放在第一章；请删除后续章节中的项目基本信息小节或表格。' });
    }
  }
  if (chapterMatches.length > 0) {
    const firstStart = chapterMatches[0].index || 0;
    const firstEnd = chapterMatches[1]?.index ?? markdown.length;
    const firstChapter = markdown.slice(firstStart, firstEnd);
    const tableIndex = firstChapter.search(/项目基本信息表|招标公告项目基本信息|\|\s*(?:字段|项目|内容)\s*\|/u);
    if (tableIndex > 0) {
      const beforeTable = firstChapter.slice(0, tableIndex).replace(/^##\s+.+$/gmu, '').replace(/^###\s+.+$/gmu, '');
      const repeatedFields = ['项目名称', '项目编号', '建设地点', '招标人', '招标范围', '计划工期', '质量标准'].filter(field => new RegExp(`${field}\\s*[：:]`, 'u').test(beforeTable));
      if (repeatedFields.length >= 3) issues.push({ level: 'warning', message: `项目基本信息表前重复叙述字段：${repeatedFields.join('、')}`, suggestion: '项目基本信息已表格化时，表格前只保留一句引导语，不要重复逐项叙述项目名称、编号、地点、工期、质量等字段。' });
    }
  }
  return issues;
}

function formalStyleIssues(markdown: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const forbidden = ['本节', '本章将', '以下从', '以下内容', '综上所述'];
  const hit = forbidden.filter(item => markdown.includes(item));
  if (hit.length > 0) issues.push({ level: 'warning', message: `存在模板化前缀或套话：${hit.join('、')}`, suggestion: '请删除“本节/本章将/以下从”等前缀，标题后直接进入施工对象、工艺动作、控制措施、检查验收和责任闭环。' });
  return issues;
}

function minChapterSectionIssues(chapters: Array<Pick<DocumentDraftChapter, 'title' | 'sections'>>): ValidationIssue[] {
  return chapters
    .filter(chapter => (chapter.sections || []).length < 3)
    .map(chapter => ({ level: 'error' as const, message: `${chapter.title} 二级小节少于 3 个`, suggestion: '请由模型结合章节主题、项目资料和专业写作需要补齐 3-6 个正式二级小节，不得使用代码默认小节。' }));
}

function tocHierarchyIssues(markdown: string): ValidationIssue[] {
  const match = /^##\s+目录\s*$([\s\S]*?)(?=\n<div class="page-break"><\/div>|\n##\s+)/mu.exec(markdown);
  if (!match) return [{ level: 'error', message: '缺少目录页', suggestion: '请在封面后生成“## 目录”，并按一级章父级、二级小节子级组织。' }];
  const lines = match[1].split(/\r?\n/u).filter(line => line.trim());
  const sectionLines = lines.filter(line => /^\s*\d+\.\d+\s+\S/u.test(line));
  if (sectionLines.length > 0 && sectionLines.every(line => !/^\s{2,}\d+\.\d+\s+\S/u.test(line))) {
    return [{ level: 'error', message: '目录二级小节未作为子级缩进', suggestion: '目录应为父子级导航：一级章单独成行，二级小节至少缩进两个空格列在所属章下方。' }];
  }
  return [];
}

function preciseFactUsageIssues(markdown: string, factsModel: DocumentFactsModel): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const normalized = markdown.replace(/\s+/gu, '');
  const sourcePreciseFacts = factsModel.preciseFacts.filter(fact => /drawing|table|bill|boq|清单|工程量|图纸|draw/u.test(`${fact.processingType || ''} ${fact.roleId} ${fact.sourceFile}`));
  const tokens = [...new Set(sourcePreciseFacts.flatMap(fact => `${fact.key} ${fact.value}`.match(/(?:DN\d+|φ\d+|Φ\d+|\d+(?:\.\d+)?\s*(?:mm|cm|m|㎡|m²|m3|MPa|kPa|℃|%|台|套|个|项|日历天|天)|\d+\s*[×xX]\s*\d+(?:\s*[×xX]\s*\d+)?\s*mm|GB\/?T?\s*\d+(?:[-—]\d+)?|JGJ\/?T?\s*\d+(?:[-—]\d+)?|CJJ\/?T?\s*\d+(?:[-—]\d+)?)/giu) || []))].slice(0, 160);
  const used = tokens.filter(token => normalized.includes(token.replace(/\s+/gu, '')));
  if (tokens.length >= 20 && used.length / tokens.length < 0.28) issues.push({ level: 'error', message: `清单/图纸精确参数使用不足：${used.length}/${tokens.length}`, suggestion: '请把清单和图纸中的规格、管径、尺寸、厚度、强度、工程量、设备数量和规范编号写入对应分项章节，禁止泛化概括。' });
  if (factsModel.bills.length > 0 && !/(清单|工程量|项目特征|分部分项|分项工程)/u.test(markdown)) issues.push({ level: 'error', message: '正文未体现工程量清单项目特征或分部分项信息', suggestion: '请从清单中提取分部分项、项目特征、单位、工程量和材料设备参数补入施工范围和施工方法。' });
  if (factsModel.drawings.length > 0 && !/(图纸|设计说明|系统图|节点|平面|立面|管径|标高|尺寸|做法)/u.test(markdown)) issues.push({ level: 'error', message: '正文未体现图纸/设计说明参数', suggestion: '请从图纸和设计说明中提取系统、节点、构造做法、规格尺寸、管径标高和试验验收要求。' });
  return issues;
}

function formalPlaceholderIssues(markdown: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const patterns = [
    /见(?:招标文件|招标公告|图纸|设计文件|相关文件)/u,
    /按(?:图纸|设计要求|相关规范|有关规范|文件要求)/u,
    /满足(?:相关|有关)?要求/u,
    /\|\s*(?:[/—-]|无|暂无|待定|待补充|N\/?A)\s*\|/iu,
  ];
  for (const pattern of patterns) {
    if (pattern.test(markdown)) issues.push({ level: 'warning', message: `存在占位式表达：${pattern.source}`, suggestion: '请改写为来自资料的准确事实；资料确实未提供时，改写为正式管理措施，不留空值或“见文件/按图纸”。' });
  }
  return issues;
}

function configuredAutoSpecGateIssues(markdown: string, template: DocumentTemplate): ValidationIssue[] {
  const text = `${template.name} ${template.category} ${template.outputTitle} ${template.description}`;
  const gates = readEngineeringDocumentConfig().autoSpecGates.filter(gate => gate.templateMatchers.some(pattern => {
    try { return new RegExp(pattern, 'iu').test(text); } catch { return text.includes(pattern); }
  }));
  if (gates.length === 0) return [];
  const issues: ValidationIssue[] = [];
  const tableCount = markdownTables(markdown).length;
  for (const item of gates.flatMap(gate => gate.requiredTexts)) if (!markdown.includes(item)) issues.push({ level: 'error', message: `配置要求缺少必要内容：${item}`, suggestion: '请按当前模板匹配的专业规则补齐必要内容。' });
  for (const item of gates.flatMap(gate => gate.forbiddenTexts)) if (markdown.includes(item)) issues.push({ level: 'error', message: `配置要求不得出现：${item}`, suggestion: '请根据当前模板匹配的专业规则清理正文污染内容。' });
  if (/^#\s+/mu.test(markdown)) issues.push({ level: 'error', message: '正式正文存在 Markdown 标题符号 #', suggestion: '导出正文应去除 Markdown 标题符号，保留正式标题文字。' });
  const minTables = Math.max(0, ...gates.map(gate => gate.minTables || 0));
  if (minTables && tableCount < minTables) issues.push({ level: 'error', message: `配置要求正式表格不足：${tableCount}/${minTables}`, suggestion: '请按当前模板匹配的专业规则补充必要表格。' });
  return issues;
}

function applySpecGateRules(spec: AutoDocumentSpecPackage | undefined, issues: ValidationIssue[], factsModel: DocumentFactsModel, chapters: DocumentDraftChapter[], markdown: string, fileBindings: FileBinding[], promptBindings: PromptBinding[]) {
  if (!spec) return issues;
  const next = [...issues];
  const allFacts = [...factsModel.project, ...factsModel.schedule, ...factsModel.quality, ...factsModel.safety, ...factsModel.resources, ...Object.values(factsModel.schemaFacts).flat()];
  const factNames = new Set([
    ...allFacts.map(fact => fact.key),
    ...allFacts.map(fact => fact.fieldName).filter(Boolean),
    ...factsModel.tables.flatMap(table => [...table.headers, ...table.rows.flat()]),
  ]);
  const chapterTitles = new Set(chapters.map(chapter => chapter.title));
  for (const field of spec.factFields.filter(field => field.required)) {
    const schemaFacts = factsModel.schemaFacts[field.id] || [];
    const satisfiedByChapterEvidence = chapters.some(chapter => !chapter.missingFacts.includes(field.name) && chapter.evidence.some(item => evidenceSatisfiesSpecField(item, field)));
    const satisfiedBySourceRole = !field.sourceRoleIds?.length || schemaFacts.some(fact => field.sourceRoleIds?.includes(fact.roleId)) || chapters.some(chapter => chapter.evidence.some(item => evidenceSatisfiesSpecField(item, field)));
    if (schemaFacts.length === 0 && !factNames.has(field.name) && !satisfiedByChapterEvidence) next.push({ level: 'warning', message: `必需事实缺失：${field.name}`, suggestion: field.extractionHint || '请补充资料或调整事实字段配置。' });
    if (!satisfiedBySourceRole) next.push({ level: 'warning', message: `必需事实来源角色不匹配：${field.name}`, suggestion: `请确认该事实来自角色：${field.sourceRoleIds?.join('、')}` });
  }
  if (spec.chapterMode === 'fixed') {
    for (const chapter of spec.chapterRules.filter(chapter => chapter.required)) {
      if (!chapterTitles.has(chapter.title)) next.push({ level: 'error', message: `必需章节缺失：${chapter.title}`, suggestion: '请在模板或规范包章节规则中补齐章节。' });
      const draft = chapters.find(item => item.title === chapter.title);
      if (draft && chapter.minWords && draft.content.length < chapter.minWords) next.push({ level: 'warning', message: `章节内容低于最低字数：${chapter.title}`, suggestion: `建议不少于 ${chapter.minWords} 字。` });
    }
  } else {
    const rule = spec.dynamicChapterRule;
    if (rule.minChapters && chapters.length < rule.minChapters) next.push({ level: 'warning', message: `动态章节数量低于最少章节：${chapters.length}/${rule.minChapters}`, suggestion: '请补充资料或降低最少章节数。' });
    if (rule.maxChapters && chapters.length > rule.maxChapters) next.push({ level: 'warning', message: `动态章节数量超过最多章节：${chapters.length}/${rule.maxChapters}`, suggestion: '请收紧来源文件角色或降低召回范围。' });
    if (rule.minWordsPerChapter) {
      for (const chapter of chapters) {
        if (chapter.content.length < rule.minWordsPerChapter) next.push({ level: 'warning', message: `动态章节内容低于最低字数：${chapter.title}`, suggestion: `建议不少于 ${rule.minWordsPerChapter} 字。` });
      }
    }
  }
  const tableBlocks = markdownTables(markdown);
  const imageRefs = markdownImages(markdown);
  const estimatedPages = estimateDocumentPages(markdown);
  for (const rule of spec.gateRules) {
    const level = rule.level;
    const evaluator = fallbackEvaluatorForRule(rule);
    const target = evaluator.target || rule.target || '';
    const value = evaluator.value || rule.value || target;
    const min = evaluator.min || Number(rule.value) || 1;
    const chapter = chapters.find(item => item.title === target);
    const textScope = evaluator.subject === 'chapter' && chapter ? chapter.content : markdown;
    const regex = value ? safeRegex(value) : undefined;

    if (evaluator.subject === 'fact' && evaluator.operator === 'exists' && target && !factNames.has(target)) next.push({ level, message: issueMessage(rule, `缺少事实 ${target}`) });
    if (evaluator.subject === 'chapter' && evaluator.operator === 'exists' && target && !chapterTitles.has(target)) next.push({ level, message: issueMessage(rule, `缺少章节 ${target}`) });
    if (evaluator.subject === 'file_role' && evaluator.operator === 'exists' && target && !fileBindings.some(binding => binding.roleId === target)) next.push({ level, message: issueMessage(rule, `缺少文件角色 ${target}`) });
    if (evaluator.subject === 'prompt_role' && evaluator.operator === 'exists' && target && !promptBindings.some(binding => binding.roleId === target)) next.push({ level, message: issueMessage(rule, `缺少提示词角色 ${target}`) });
    if (evaluator.subject === 'document' && evaluator.operator === 'contains' && value && !markdown.includes(value)) next.push({ level, message: issueMessage(rule, `全文必须包含 ${value}`) });
    if (evaluator.subject === 'document' && evaluator.operator === 'not_contains' && value && markdown.includes(value)) next.push({ level, message: issueMessage(rule, `出现禁用文本 ${value}`) });
    if ((evaluator.subject === 'document' || evaluator.subject === 'chapter') && evaluator.operator === 'regex_match' && value && (!regex || !regex.test(textScope))) next.push({ level, message: issueMessage(rule, `未匹配正则 ${value}`) });
    if ((evaluator.subject === 'document' || evaluator.subject === 'chapter') && evaluator.operator === 'regex_not_match' && regex?.test(textScope)) next.push({ level, message: issueMessage(rule, `匹配到禁止正则 ${value}`) });
    if (evaluator.subject === 'chapter' && evaluator.operator === 'contains' && target && value && (!chapter || !chapter.content.includes(value))) next.push({ level, message: issueMessage(rule, `章节 ${target} 必须包含 ${value}`) });
    if (evaluator.subject === 'chapter' && evaluator.operator === 'not_contains' && chapter?.content.includes(value)) next.push({ level, message: issueMessage(rule, `章节 ${target} 出现禁用文本 ${value}`) });
    if (evaluator.subject === 'chapter' && evaluator.operator === 'min_length' && target && (!chapter || chapter.content.length < min)) next.push({ level, message: issueMessage(rule, `章节 ${target} 低于 ${min} 字`) });
    if (evaluator.subject === 'table' && evaluator.operator === 'min_count' && factsModel.tables.length + tableBlocks.length < min) next.push({ level, message: issueMessage(rule, `表格数量少于 ${min}`) });
    if (evaluator.subject === 'table' && evaluator.operator === 'table_explanation_required' && tableBlocks.some(block => markdown.indexOf(block) >= 0 && markdown.slice(markdown.indexOf(block) + block.length, markdown.indexOf(block) + block.length + 120).trim().length < 10)) next.push({ level, message: issueMessage(rule, '存在缺少说明文字的表格') });
    if (evaluator.subject === 'image' && evaluator.operator === 'min_count' && imageRefs.length < min) next.push({ level, message: issueMessage(rule, `图片数量少于 ${min}`) });
    if (evaluator.subject === 'page' && evaluator.operator === 'min_count' && estimatedPages < min) next.push({ level, message: issueMessage(rule, `预计页数 ${estimatedPages} 少于 ${min}`) });
    if (evaluator.subject === 'page' && evaluator.operator === 'max_count' && estimatedPages > min) next.push({ level, message: issueMessage(rule, `预计页数 ${estimatedPages} 超过 ${min}`) });
    if (evaluator.subject === 'image' && evaluator.operator === 'image_caption_required' && imageRefs.some(image => !image.alt && markdown.slice(image.index + image.url.length, image.index + image.url.length + 120).trim().length < 10)) next.push({ level, message: issueMessage(rule, '存在缺少说明文字的图片') });
    if (evaluator.subject === 'source' && evaluator.operator === 'all_have_source' && allFacts.some(fact => !fact.sourceFile)) next.push({ level, message: issueMessage(rule, '存在无来源事实') });
    if (evaluator.subject === 'source' && evaluator.operator === 'min_count' && new Set(allFacts.map(fact => fact.sourceFile).filter(Boolean)).size < min) next.push({ level, message: issueMessage(rule, `来源数量少于 ${min}`) });
  }
  return next;
}

function buildValidationIssues(validation: { warnings: string[]; errors: string[] }, factsModel: DocumentFactsModel, draftChapters: DocumentDraftChapter[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [
    ...validation.errors.map(message => ({ level: 'error' as const, message, suggestion: '请补充配置或资料后重新生成。' })),
    ...validation.warnings.map(message => ({ level: 'warning' as const, message, suggestion: '建议人工确认或补充对应资料。' })),
  ];
  if (draftChapters.some(chapter => chapter.content.includes('资料未提供'))) issues.push({ level: 'warning', message: '存在资料未提供章节', suggestion: '请检查项目角色配置中的文件绑定和顺序。' });
  if (factsModel.conflicts.length > 0) issues.push(...factsModel.conflicts.map(message => ({ level: 'error' as const, message })));
  return issues;
}

/** 使用 LLM 生成单章内容，基于证据包、提示词角色和用户需求 */
async function buildLlmChapterContent(template: DocumentTemplate, chapter: DocumentTemplate['chapters'][number], evidence: DocumentEvidence[], missingFacts: string[], promptTexts: string, projectContext: string, requirement?: string, roleContext = '', options: { forbidDrawingImages?: boolean; minWords?: number; technicalFactContext?: string; coverageMatrixContext?: string; tenderAnnouncementContext?: string } = {}) {
  const bundle = buildEvidenceBundle(chapter, evidence);
  const evidenceText = evidenceBundlePrompt(bundle);
  if (!evidenceText.trim() && !roleContext.trim()) return undefined;
  const system = [
    '你是专业项目文档生成专家，必须严格使用已提供的内部资料生成正式文档章节。',
    FORMAL_WRITING_RULES,
    '准确性优先级：章节计划/示范文本节点产物 > 规范包事实字段 > 角色节点结构化事实 > 知识库证据 > 项目上下文/历史记忆。内部优先级只用于判断事实，不得写入正文。',
    '项目上下文/历史记忆只能作为用户偏好、历史纠偏和连续性参考；不得覆盖、替代或改写知识库证据中的事实。',
    options.forbidDrawingImages ? '图片/图纸类资料只作为文本事实依据；禁止插入图片或 Markdown 图片语法。' : '',
    '不要编造资料；可以基于证据做合理归纳；输出 Markdown；不要输出代码块。',
    promptTexts,
  ].filter(Boolean).join('\n\n');
  const prompt = [
    `文档模板：${template.name}`,
    `章节标题：${chapter.title}`,
    `章节目的：${chapter.purpose}`,
    chapter.sections?.length ? `本章必须包含以下二级小节：\n${chapter.sections.map(section => `- ${section}`).join('\n')}` : '本章未预设二级小节，请根据章节主题、项目资料和专业写作需要自行组织 3-6 个二级小节；二级小节不能为空。',
    requirement ? `用户要求：${requirement}` : '',
    projectContext ? `项目上下文/历史记忆（仅作偏好、历史纠偏和连续性参考；如与知识库证据冲突，以知识库证据为准）：\n${projectContext}` : '',
    options.tenderAnnouncementContext || '',
    !options.tenderAnnouncementContext ? '本章不得重复设置“项目基本信息”“项目基本信息表”“招标公告项目基本信息”等小节或表格；项目基本信息只允许出现在第一章。' : '',
    roleContext ? roleContext : '',
    options.technicalFactContext || '',
    options.coverageMatrixContext || '',
    missingFacts.length ? `需要特别补足的事实：${missingFacts.join('、')}` : '',
    '请生成一个专业、充实、可直接导出的正式文档章节，要求：',
    '- 保留章节标题；如模板配置了小节，必须按配置生成；如未配置小节，必须结合本章内容自行生成 3-6 个正式二级小节，且小节不能为空；不要无依据地拆分过细小节；',
    chapter.tableSections?.length ? `- 本章以下小节适合使用正式工程表格辅助表达：${chapter.tableSections.join('、')}；表格必须由正文归纳形成，禁止直接粘贴证据摘录。` : '',
    '- 表格只用于工程概况、施工部署、重点难点、资源配置、质量安全控制、验收移交等适合结构化表达的位置；项目基本信息已表格化时，表格前只保留一句引导语，不得逐项重复叙述同一批字段；其他表格前后必须有说明，不能整节只有表格。',
    '- 不得使用“本节”“本章将”“以下从”“以下内容”等模板化前缀；标题后直接进入施工对象、工艺动作、控制措施、检查验收和责任闭环。',
    '- 二级小节下如需设置三级小节，必须使用“#### 章号.节号.序号 标题”，例如“#### 2.2.1 管沟开挖”；三级小节不纳入目录；不得使用无编号独立加粗行表示三级小节。',
    '- 必须使用模板节点提取的章节要求和输出规范；',
    '- 必须结合项目事实、表格数据、技术规范等内部资料；',
    '- 对同一对象的事实应综合表达，优先写入准确的数量、单位、规格、参数、做法和标准；',
    '- 日期、数量、数值、规格、工程量、工期、资源配置等量化内容必须来自资料或明确推导；无依据时不得编造具体值。',
    '- 如果同一施工方案、工艺或措施适用于多个部位、区域、学校、片区或分项，必须逐项覆盖适用范围和对应工程量，不得只写其中一个数量。',
    '- 对工程类章节，必须把工程技术事实表和量化事实覆盖矩阵中的参数、规格、数量、部位、工艺动作、试验验收和规范标准落到正文；禁止用“按设计要求、按规范要求、加强管理”等空泛表述替代已知事实；',
    '- 存在事实冲突时，按后台自动规范、文件角色、提示词角色和用户要求指定的优先级处理；',
    '- 默认不要引用原始文件名，不写解析器内部对象名；',
    '- 将资料要点自然融入正文，不单列系统证据或来源章节；',
    '- 小节层级保持适度，除非规范包或提示词要求，不要输出中间分析产物标题；',
    '- 组织关系、流程、职责、资源配置、风险控制等适合表格表达的内容可使用 Markdown 表格；',
    `- 内容不少于 ${options.minWords || 1000} 字，避免空泛口号。`,
    '',
    evidenceText ? '内部资料：' : '',
    evidenceText,
  ].filter(Boolean).join('\n');
  const content = await callDocumentLlm(system, prompt);
  if (!content || content.length < 120) return undefined;
  return sanitizeFormalMarkdown(removeUnwantedDrawingImages(content.startsWith('## ') ? content : `## ${chapter.title}\n\n${content}`, Boolean(options.forbidDrawingImages)));
}

/** 对生成的 Markdown 进行 LLM 二次审查和优化，检查结构、证据使用和导出合规性 */
async function reviewAndOptimizeMarkdown(input: {
  template: DocumentTemplate;
  spec?: AutoDocumentSpecPackage;
  markdown: string;
  evidence: DocumentEvidence[];
  promptTexts: string;
  projectContext: string;
  requirement?: string;
}): Promise<{ markdown: string; stage: DocumentExecutionStage }> {
  const reviewBundle = buildEvidenceBundle({ id: 'review', title: '全文审查', purpose: '审查全文证据和资源关系', queries: [], requiredFacts: [] }, input.evidence);
  const evidenceDigest = evidenceBundlePrompt(reviewBundle);
  const specDigest = input.spec ? [
    `规范包：${input.spec.name}`,
    `事实字段：${input.spec.factFields.map(field => `${field.name}${field.required ? '(必需)' : ''}`).join('、')}`,
    input.spec.chapterMode === 'dynamic' ? `章节规则：动态章节｜来源=${input.spec.dynamicChapterRule.source}｜标题=${input.spec.dynamicChapterRule.titleStrategy || 'ai_summary'}｜${input.spec.dynamicChapterRule.generationHint || '由资料自动规划'}` : `章节规则：${input.spec.chapterRules.map(rule => `${rule.title}${rule.minWords ? `≥${rule.minWords}字` : ''}`).join('、')}`,
    `门禁规则：${input.spec.gateRules.map(rule => `${rule.name}:${rule.type}`).join('、')}`,
  ].join('\n') : '后台自动规范未生成。';
  const reviewed = await callDocumentLlm([
    '你是文档质量审查与优化专家。你要基于模板、后台自动规范、提示词角色和内部资料对初稿进行二次审查和优化，使其成为正式业务文档。',
    FORMAL_WRITING_RULES,
    '准确性优先级：后台自动规范/模板要求 > 已绑定或人工确认的知识库证据 > 自动检索知识库证据 > 项目上下文/历史记忆。内部优先级只用于判断事实，不得写入正文。',
    '项目上下文/历史记忆只能用于风格偏好、历史纠偏和连续性检查；如果与知识库证据冲突，必须以知识库证据为准。',
    '必须保持 Markdown 输出；必须保留文档开头的“## 目录”，目录必须是父子级导航结构：一级章单独成行，二级小节缩进列在所属章下方，三级小节不纳入目录；不得平铺成同级列表；不得删除目录页、页分隔符或已有正式标题层级和表格；不得保留或新增证据来源、资料来源、缺失项、校验结果等后台信息。',
    '项目基本信息、项目基本信息表、招标公告基本信息只允许保留在第一章；后续章节如重复出现，应删除并替换为该章对应的分项、工艺、参数、资源、质量安全等内容。',
    '图片/图纸类资料默认只作为文本事实依据，除非用户明确要求插图，否则不要插入图片或 Markdown 图片语法；不得引用 PDF/DWG/Excel 文件名。',
    '重点检查：正式章节完整性、资料事实内化使用、参数数字准确性、冲突事实是否按配置优先级处理、解析器内部对象名清理、表格呈现、表达专业性、导出友好性。',
    '必须检查日期、数量、数值、单位、规格、工程量和资源数量是否有资料依据；同一方案涉及多个部位/区域/学校/片区/分项时，必须检查是否逐项覆盖。',
    '除非后台自动规范或提示词明确要求，删除中间分析产物标题和后台流程说明。',
    input.promptTexts,
  ].filter(Boolean).join('\n\n'), [
    `模板：${input.template.name}`,
    input.requirement ? `用户要求：${input.requirement}` : '',
    input.projectContext ? `项目上下文/历史记忆（仅作偏好、历史纠偏和连续性参考；如与知识库证据冲突，以知识库证据为准）：\n${input.projectContext}` : '',
    specDigest,
    '',
    '知识库证据摘要：',
    evidenceDigest,
    '',
    '待审查初稿：',
    input.markdown,
    '',
    '请直接返回优化后的完整正式 Markdown，不要附加解释。',
  ].filter(Boolean).join('\n'));
  if (!reviewed || reviewed.length < input.markdown.length * 0.7 || !reviewed.includes('#')) {
    return { markdown: input.markdown, stage: { type: 'llm_review', roleId: 'llm-review', status: 'skipped', message: '无可用模型或审查结果不可用，保留生成初稿' } };
  }
  return { markdown: sanitizeFormalMarkdown(reviewed), stage: { type: 'llm_review', roleId: 'llm-review', status: 'success', message: '已完成 LLM 二次审查与优化' } };
}

function formatContextEntries(entries: ReturnType<typeof recallDocumentContexts>) {
  return entries.length > 0
    ? entries.map((entry, index) => `${index + 1}. [${entry.type}/${entry.importance}] ${entry.content}${entry.source ? `（来源：${entry.source}）` : ''}`).join('\n')
    : '';
}

function validateDraft(chapters: DocumentDraftChapter[], structuredFacts: DocumentFact[] = [], template?: DocumentTemplate) {
  const warnings: string[] = [];
  const errors: string[] = [];
  for (const chapter of chapters) {
    if (chapter.evidence.length === 0) warnings.push(`${chapter.title} 未检索到资料证据`);
    if (chapter.content.length < 80) warnings.push(`${chapter.title} 内容较短，建议人工补充或重新生成`);
  }
  if (template && chapters.length < template.chapters.length) errors.push(`章节生成不完整：已生成 ${chapters.length}/${template.chapters.length} 章`);
  if (template && templatePromptBindings(template).length === 0) errors.push('模板未绑定任何提示词');
  const roleIds = new Set(structuredFacts.map(fact => fact.roleId));
  for (const requiredRole of ['project_fact', 'rule']) {
    if (template?.fileBindings?.some(binding => binding.roleId === requiredRole) && !roleIds.has(requiredRole)) warnings.push(`${requiredRole} 角色未抽取到结构化事实`);
  }
  return { passed: errors.length === 0, warnings, errors };
}

function hasSectionNumber(section: string) {
  return /^\s*\d+(?:\.\d+)+\s+/.test(section);
}

function extractGeneratedSections(markdown: string) {
  const sections = [...markdown.matchAll(/^###\s+(.+)$/gmu)]
    .map(match => displayChapterTitle(match[1] || ''))
    .filter(section => section.length >= 2 && section.length <= 80);
  return [...new Set(sections)].slice(0, 12);
}

function standaloneBoldTitle(line: string) {
  const match = /^\*\*([^*]+?)\*\*\s*[:：]?\s*$/u.exec(line.trim());
  if (!match) return '';
  const title = displayChapterTitle(match[1] || '');
  if (title.length < 2 || title.length > 40) return '';
  if (/[。；;.!！?？]$/u.test(title)) return '';
  if (/^(注|说明|备注|提示|要求)[:：]/u.test(title)) return '';
  return title;
}

function normalizeTertiaryHeadings(markdown: string) {
  const lines = markdown.split(/\r?\n/u);
  let currentSectionNumber = '';
  let tertiaryIndex = 0;
  const normalized = lines.map(line => {
    const section = /^###\s+(\d+\.\d+)\s+.+$/u.exec(line.trim());
    if (section) {
      currentSectionNumber = section[1];
      tertiaryIndex = 0;
      return line;
    }
    if (/^##\s+/u.test(line.trim())) {
      currentSectionNumber = '';
      tertiaryIndex = 0;
      return line;
    }
    if (!currentSectionNumber) return line;
    const heading = /^####\s+(.+)$/u.exec(line.trim());
    if (heading) {
      const rawTitle = (heading[1] || '').trim();
      if (/^\d+\.\d+\.\d+\s+\S/u.test(rawTitle)) return line;
      const title = displayChapterTitle(rawTitle);
      tertiaryIndex += 1;
      return `#### ${currentSectionNumber}.${tertiaryIndex} ${title}`;
    }
    const boldTitle = standaloneBoldTitle(line);
    if (boldTitle) {
      tertiaryIndex += 1;
      return `#### ${currentSectionNumber}.${tertiaryIndex} ${boldTitle}`;
    }
    return line;
  }).join('\n');
  return normalized.replace(/\n{3,}/gu, '\n\n').trim();
}

function tertiaryHeadingIssues(markdown: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  let currentSectionNumber = '';
  for (const rawLine of markdown.split(/\r?\n/u)) {
    const line = rawLine.trim();
    const section = /^###\s+(\d+\.\d+)\s+.+$/u.exec(line);
    if (section) {
      currentSectionNumber = section[1];
      continue;
    }
    if (/^##\s+/u.test(line)) currentSectionNumber = '';
    if (!currentSectionNumber) continue;
    const heading = /^####\s+(.+)$/u.exec(line);
    if (heading) {
      const rawTitle = (heading[1] || '').trim();
      if (!new RegExp(`^${escapedRegExp(currentSectionNumber)}\\.\\d+\\s+\\S`, 'u').test(rawTitle)) {
        issues.push({ level: 'warning', message: `三级小节缺少 ${currentSectionNumber}.x 编号：${displayChapterTitle(rawTitle)}`, suggestion: '三级小节必须使用“#### 章号.节号.序号 标题”，且不纳入目录。' });
      }
    }
    const boldTitle = standaloneBoldTitle(line);
    if (boldTitle) issues.push({ level: 'warning', message: `独立加粗行疑似未编号三级小节：${boldTitle}`, suggestion: '请改为“#### 章号.节号.序号 标题”，不要用无编号加粗行表示三级小节。' });
  }
  return issues.slice(0, 20);
}

function tocSectionTitle(chapterIndex: number, sectionIndex: number, section: string) {
  return hasSectionNumber(section) ? section : `${chapterIndex + 1}.${sectionIndex + 1} ${section}`;
}

function composeTocLines(chapters: Array<Pick<DocumentDraftChapter, 'title' | 'sections'>>) {
  return chapters.flatMap((chapter, index) => {
    const sections = chapter.sections || [];
    return [
      formalChapterTitle(index, chapter.title),
      '',
      ...sections.flatMap((section, sectionIndex) => [`  ${tocSectionTitle(index, sectionIndex, section)}`, '']),
    ];
  });
}

function composeTocMarkdown(chapters: Array<Pick<DocumentDraftChapter, 'title' | 'sections'>>) {
  return ['## 目录', '', ...composeTocLines(chapters)].join('\n');
}

function inferChapterSectionsFromMarkdown(markdown: string, chapters: Array<Pick<DocumentDraftChapter, 'title' | 'sections'>>) {
  const normalizedMarkdown = normalizeFormalChapterHeadings(removeDuplicateTocBlocks(markdown), chapters);
  return chapters.map((chapter, index) => {
    const start = normalizedMarkdown.search(new RegExp(`^##\\s+${escapedRegExp(formalChapterTitle(index, chapter.title))}\\s*$`, 'mu'));
    if (start < 0) return chapter.sections || [];
    const rest = normalizedMarkdown.slice(start);
    const next = rest.slice(1).search(/^##\s+/mu);
    const block = next >= 0 ? rest.slice(0, next + 1) : rest;
    const extracted = extractGeneratedSections(block);
    return extracted.length > 0 ? extracted : chapter.sections || [];
  });
}

function normalizeChapterDraftContent(chapter: Pick<DocumentDraftChapter, 'title' | 'content'>, index: number) {
  const targetHeading = `## ${formalChapterTitle(index, chapter.title)}`;
  const cleaned = sanitizeFormalMarkdown(chapter.content);
  return /^##\s+.+$/mu.test(cleaned) ? cleaned.replace(/^##\s+.+$/mu, targetHeading) : `${targetHeading}\n\n${cleaned}`;
}

function removeDuplicateTocBlocks(markdown: string) {
  let seenToc = false;
  return markdown.replace(/^##\s+目录\s*$[\s\S]*?(?=\n<div class="page-break"><\/div>|\n##\s+)/gmu, match => {
    if (!seenToc) {
      seenToc = true;
      return match;
    }
    return '';
  }).replace(/\n{3,}/gu, '\n\n').trim();
}

function normalizeFormalChapterHeadings(markdown: string, chapters: Array<Pick<DocumentDraftChapter, 'title' | 'sections'>>) {
  let result = removeDuplicateTocBlocks(markdown);
  chapters.forEach((chapter, index) => {
    const clean = displayChapterTitle(chapter.title);
    const re = new RegExp(`^##\\s+(?:第[一二三四五六七八九十百千万\\d]+章\\s*)?${escapedRegExp(clean)}\\s*$`, 'mu');
    result = re.test(result) ? result.replace(re, `## ${formalChapterTitle(index, chapter.title)}`) : result;
  });
  const lines = result.split(/\r?\n/u);
  let chapterIndex = -1;
  let sectionIndex = 0;
  return lines.map(line => {
    const trimmed = line.trim();
    if (/^##\s+第[一二三四五六七八九十百千万\d]+章\s+/u.test(trimmed)) {
      chapterIndex += 1;
      sectionIndex = 0;
      return line;
    }
    const h2NumberedSection = /^##\s+(\d+)\.(\d+)\s+(.+)$/u.exec(trimmed);
    if (chapterIndex >= 0 && h2NumberedSection) {
      sectionIndex = Number(h2NumberedSection[2]) || sectionIndex + 1;
      return `### ${chapterIndex + 1}.${sectionIndex} ${displayChapterTitle(h2NumberedSection[3] || '')}`;
    }
    const section = /^###\s+(?:(\d+)\.(\d+)\s+)?(.+)$/u.exec(trimmed);
    if (chapterIndex >= 0 && section) {
      sectionIndex += 1;
      return `### ${chapterIndex + 1}.${sectionIndex} ${displayChapterTitle(section[3] || '')}`;
    }
    return line;
  }).join('\n');
}

function ensureFormalToc(markdown: string, chapters: Array<Pick<DocumentDraftChapter, 'title' | 'sections'>>) {
  const normalizedMarkdown = normalizeFormalChapterHeadings(markdown, chapters);
  const toc = composeTocMarkdown(chapters);
  if (/^##\s+目录\s*$/mu.test(normalizedMarkdown)) {
    return normalizedMarkdown.replace(/^##\s+目录\s*$[\s\S]*?(?=\n<div class="page-break"><\/div>|\n##\s+)/mu, toc.trim());
  }
  const coverBreak = '<div class="page-break"></div>';
  const index = normalizedMarkdown.indexOf(coverBreak);
  if (index >= 0) {
    const insertAt = index + coverBreak.length;
    return `${normalizedMarkdown.slice(0, insertAt)}\n\n${toc}\n\n${coverBreak}\n\n${normalizedMarkdown.slice(insertAt).trimStart()}`;
  }
  return `${toc}\n\n<div class="page-break"></div>\n\n${normalizedMarkdown}`;
}

function escapedRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function findChapterBlock(markdown: string, title: string) {
  const clean = displayChapterTitle(title);
  const re = new RegExp(`(^##\\s+(?:第[一二三四五六七八九十百千万\\d]+章\\s*)?${escapedRegExp(clean)}\\s*$)([\\s\\S]*?)(?=\\n##\\s+|(?![\\s\\S]))`, 'mu');
  const match = re.exec(markdown);
  if (!match || match.index === undefined) return undefined;
  return { start: match.index, end: match.index + match[0].length, heading: match[1] || `## ${title}`, body: match[2] || '' };
}

function hasMarkdownTable(markdown: string) {
  return /\|[^\n]+\|\s*\n\s*\|\s*:?-{3,}:?\s*\|/u.test(markdown);
}

function sectionPattern(section: string) {
  const plain = section.replace(/^\s*\d+(?:\.\d+)+\s+/u, '').trim();
  return new RegExp(`^###\\s+(?:${escapedRegExp(section)}|(?:\\d+(?:\\.\\d+)+\\s+)?${escapedRegExp(plain)})\\s*$`, 'mu');
}

function configuredStructurePrompt(template: DocumentTemplate) {
  return template.chapters.map(chapter => [
    `- ${chapter.title}`,
    chapter.sections?.length ? `  二级小节：${chapter.sections.join('、')}` : '',
    chapter.tableSections?.length ? `  表格小节：${chapter.tableSections.join('、')}` : '',
    chapter.tableRequirements?.length ? `  表格内容要求：${chapter.tableRequirements.join('；')}` : '',
  ].filter(Boolean).join('\n')).join('\n');
}

function configuredStructureIssues(markdown: string, template: DocumentTemplate): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const chapter of template.chapters) {
    const block = findChapterBlock(markdown, chapter.title);
    if (!block) {
      issues.push({ level: 'error', message: `${chapter.title} 正文缺少章节标题`, suggestion: '请重新生成，确保模板章节完整输出。' });
      continue;
    }
    const body = block.heading + block.body;
    const missingSections = (chapter.sections || []).filter(section => !sectionPattern(section).test(body));
    if (missingSections.length > 0) issues.push({ level: 'error', message: `${chapter.title} 正文缺少配置小节：${missingSections.join('、')}`, suggestion: '请重新生成或检查审查阶段是否删除了二级小节。' });
    if (chapter.tableSections?.length && !hasMarkdownTable(body)) issues.push({ level: 'error', message: `${chapter.title} 缺少必要的正式表格`, suggestion: '请按模板 tableSections/tableRequirements 在对应小节补充正式 Markdown 表格。' });
  }
  return issues;
}

export function composeDocumentMarkdown(draft: Omit<GeneratedDocumentDraft, 'markdown'>): string {
  const chapterMarkdown = draft.chapters
    .map((chapter, index) => normalizeChapterDraftContent(chapter, index))
    .filter(Boolean)
    .join('\n\n');
  const tocMarkdown = composeTocMarkdown(draft.chapters);

  return sanitizeFormalMarkdown([
    `<div class="document-cover">`,
    `# ${draft.title}`,
    '',
    `</div>`,
    '',
    '<div class="page-break"></div>',
    '',
    tocMarkdown,
    '',
    '<div class="page-break"></div>',
    '',
    chapterMarkdown,
  ].join('\n'));
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new Error('用户中止');
}

/** 文档生成主入口：依次执行角色绑定、知识检索、文件理解、事实抽取、章节生成、封面生成、LLM 审查和导出校验，返回完整文档草稿 */
export async function generateDocumentDraft(input: { templateId: string; requirement?: string; maxEvidencePerChapter?: number; projectRoot?: string; signal?: AbortSignal; onProgress?: (stages: DocumentExecutionStage[]) => void }): Promise<GeneratedDocumentDraft> {
  throwIfAborted(input.signal);
  const baseTemplate = getDocumentTemplate(input.templateId);
  if (!baseTemplate) throw new Error('Document template not found');
  const projectRoot = path.resolve(input.projectRoot || getProjectRoot());
  if (!projectRoot) throw new Error('No knowledge base project found');
  let template = baseTemplate;
  const manager = getMultiProjectManager();
  const maxEvidence = Math.max(5, Math.min(30, input.maxEvidencePerChapter ?? 12));
  const projectRoleConfigId = defaultProjectRoleConfigIdForTemplate(template) || 'none';
  const projectRoleConfigName = getProjectRoleConfig(projectRoleConfigId)?.name || projectRoleConfigId;
  const promptBindings = templatePromptBindings(template);
  const explicitFileBindings = templateFileBindings(template);
  const autoSpec = getOrCreateAutoDocumentSpec(template, input.requirement || '');
  const documentSpec = autoSpec.spec;
  const projectMaterialSummary = buildProjectMaterialSummary(projectRoot, { requirement: input.requirement, boundFilePaths: explicitFileBindings.map(binding => binding.filePath), boundFileRoles: boundFileRolesForMaterialSummary(explicitFileBindings) });
  const semanticFileBindings = explicitFileBindings.length > 0 ? explicitFileBindings : fileBindingsFromMaterialSummary(template, projectMaterialSummary);
  const fileBindings = semanticFileBindings.length > 0 ? semanticFileBindings : explicitFileBindings;
  const resolvedMaterialRoles = resolveTemplateMaterialRoles(template, projectMaterialSummary);
  const readiness = evaluateDocumentReadiness({ template, spec: documentSpec, summary: projectMaterialSummary, resolvedRoles: resolvedMaterialRoles });
  if (!readiness.ready) throw new Error(`生成准备度不足：${readiness.blockingIssues.join('；')}`);
  const backgroundControlPrompt = [projectMaterialPrompt(projectMaterialSummary), autoSpecPrompt(documentSpec, autoSpec.sourceHash), readinessPrompt(readiness)].filter(Boolean).join('\n\n');
  const promptTexts = [backgroundControlPrompt, promptTextsForExecution(promptBindings, ['chapter_generation', 'formatting', 'reference'])].filter(Boolean).join('\n\n');
  const factExtractionPromptTexts = [backgroundControlPrompt, promptTextsForExecution(promptBindings, ['fact_extraction', 'reference'])].filter(Boolean).join('\n\n');
  const reviewPromptTexts = [backgroundControlPrompt, promptTextsForExecution(promptBindings, ['validation', 'llm_review', 'formatting', 'reference'])].filter(Boolean).join('\n\n');
  const explicitPromptChapters = extractExplicitOutlineFromSources([
    { text: input.requirement, source: '用户需求' },
    { text: promptTextsForExecution(promptBindings, ['chapter_generation', 'formatting', 'reference']), source: '提示词角色' },
  ]).filter(chapter => !violatesConfiguredChapterTitleForbiddenFilter(chapter.title, baseTemplate));
  const hasExplicitOutline = explicitPromptChapters.length >= 2;
  if (hasExplicitOutline) {
    template = { ...baseTemplate, chapters: explicitPromptChapters };
  }
  const fileBindingKeys = (filePath: string) => [filePath, path.isAbsolute(filePath) ? path.relative(projectRoot, filePath) : path.join(projectRoot, filePath)];
  const boundFilePaths = new Set(fileBindings.flatMap(binding => fileBindingKeys(binding.filePath)));
  const materialFilePaths = new Set(Object.values(projectMaterialSummary.materialInventory).flat().flatMap(file => fileBindingKeys(file.filePath)));
  const evidenceScopePaths = boundFilePaths.size > 0 ? boundFilePaths : materialFilePaths;
  const allFileRoles = listDocumentRoles('file');
  const fileRoleByPath = new Map(fileBindings.flatMap(binding => fileBindingKeys(binding.filePath).map(key => [key, binding.roleId] as const)));
  const fileProcessingByPath = new Map(fileBindings.flatMap(binding => fileBindingKeys(binding.filePath).map(key => [key, allFileRoles.find(role => role.id === binding.roleId)?.processingType || 'reference'] as const)));
  const project = await manager.getProject(projectRoot);
  await project.incrementalIndex();
  throwIfAborted(input.signal);
  const chapterDrafts: DocumentDraftChapter[] = [];
  const technicalFactAssignments: TechnicalFactAssignment[] = [];
  const allEvidence: DocumentEvidence[] = [];
  const missingItems: string[] = [];
  const failedChapterMessages: string[] = [];
  const chapterGenerationStages: DocumentExecutionStage[] = [];
  const progressStages: DocumentExecutionStage[] = [];
  const roleNodes = buildRoleExecutionNodes(template, promptBindings, fileBindings);
  const roleArtifacts: RoleNodeArtifact[] = [];
  for (const node of roleNodes) {
    throwIfAborted(input.signal);
    const nodeEvidence = evidenceForRoleFiles(project, node, projectRoot);
    allEvidence.push(...nodeEvidence);
    const artifact = await executeRoleExtractionNode(template, node, nodeEvidence);
    roleArtifacts.push(artifact);
    progressStages.push(displayStage({ type: 'file_understanding', roleId: node.fileRoleId, promptId: node.promptRoleIds[0], status: nodeEvidence.length > 0 ? 'success' : 'fallback', message: `${node.fileRoleName} 节点已按绑定提示词读取，产出章节建议 ${artifact.chapters.length} 个、事实 ${artifact.facts.length} 条` }, { subtitle: node.fileRoleName, roleName: node.fileRoleName, promptName: node.promptRoleNames.join('、') || undefined, order: progressStages.length }));
    input.onProgress?.([...progressStages]);
  }
  const tenderPlan = tenderPlanChaptersFromArtifacts(template, roleArtifacts);
  const dynamicSeedQuery = [template.name, template.outputTitle, input.requirement, documentSpec?.dynamicChapterRule?.generationHint, ...(documentSpec?.dynamicChapterRule?.sourceRoleIds || [])].filter(Boolean).join(' ');
  const dynamicSeedEvidence = documentSpec?.chapterMode === 'dynamic' && tenderPlan.length === 0 ? (await manager.search(projectRoot, dynamicSeedQuery || template.name, { scope: 'project', limit: 20, weights: { keyword: 0.45, vector: 0.35, rewrite: 0.65, hybridBonus: 0.1 } })).results.map((item: KbSearchResult) => ({
    chapterId: 'dynamic-planning',
    filePath: item.filePath,
    score: item.score,
    content: item.content,
    roleId: fileRoleByPath.get(item.filePath),
    processingType: fileProcessingByPath.get(item.filePath),
    sectionTitle: item.sectionTitle,
    source: item.source,
  } as DocumentEvidence)) : [];
  const baseChapters = effectiveTemplateChapters(template, documentSpec, dynamicSeedEvidence);
  const supplementalDynamicChapters = chaptersFromTenderPlan(tenderPlan, dynamicChapterLimit(documentSpec), baseChapters);
  const effectiveChapters = uniqueTemplateChapters([...baseChapters, ...supplementalDynamicChapters]);
  const contextQuery = [template.name, template.outputTitle, input.requirement, ...effectiveChapters.flatMap(chapter => [chapter.title, chapter.purpose])].filter(Boolean).join(' ');
  const projectContextEntries = recallDocumentContexts(contextQuery, 8, projectRoot);
  const projectContext = formatContextEntries(projectContextEntries);
  const tenderAnnouncementFacts = extractTenderAnnouncementFacts(roleArtifacts.flatMap(artifact => artifact.evidence));
  const tenderAnnouncementContext = tenderAnnouncementFactsPrompt(tenderAnnouncementFacts);
  const contextStage: DocumentExecutionStage = displayStage({
    type: 'context_recall',
    roleId: 'project-memory',
    status: projectContextEntries.length > 0 ? 'success' : 'skipped',
    message: projectContextEntries.length > 0 ? `已注入 ${projectContextEntries.length} 条短期/长期上下文` : '未召回可用项目上下文',
  }, { subtitle: '项目记忆' });

  // 第一个进度回调：角色绑定完成
  const outlineMessage = hasExplicitOutline ? `；识别到 OUTLINE 章节 ${explicitPromptChapters.length} 个` : '；未识别到有效 OUTLINE，将使用模板/资料兜底章节';
  progressStages.push(displayStage({ type: 'role_binding', roleId: projectRoleConfigId, status: 'success', message: `已绑定 ${fileBindings.length} 个文件角色、${promptBindings.length} 个提示词角色；后台自动规范 ${documentSpec.factFields.length} 个事实字段；资料覆盖率 ${Math.round(readiness.materialCoverageRate * 100)}%${outlineMessage}` }, { subtitle: projectRoleConfigName, roleName: projectRoleConfigName }));
  progressStages.push(displayStage({ type: 'validation', roleId: 'document-readiness', status: readiness.ready ? 'success' : 'failed', message: `生成准备度：资料 ${Math.round(readiness.materialCoverageRate * 100)}%，资料角色 ${Math.round(readiness.roleSatisfactionRate * 100)}%，规范 ${Math.round(readiness.specCompletenessRate * 100)}%；${projectMaterialSummary.source.selectionReason}` }, { subtitle: '生成准备度检查' }));
  progressStages.push(contextStage);
  input.onProgress?.([...progressStages]);

  for (const chapter of effectiveChapters) {
    throwIfAborted(input.signal);
    try {
    const rawEvidence: DocumentEvidence[] = [];
    const plan = chapterPlanFor(chapter, tenderPlan);
    const planQueries = plan ? [plan.title, ...plan.requiredContents, ...plan.evidenceNeeds, ...plan.requirements.flatMap(item => [item.title, item.requirementText, ...item.requiredContents, ...item.evidenceNeeds])].filter(Boolean) : [];
    const queries = [...new Set([...(chapter.queries.length > 0 ? chapter.queries : [template.name, template.outputTitle, chapter.title]), ...planQueries])];
    for (const query of queries) {
      const result = await manager.search(projectRoot, query, {
        scope: 'project',
        limit: Math.max(maxEvidence, evidenceScopePaths.size > 0 ? 30 : maxEvidence),
        weights: { keyword: 0.4, vector: 0.45, rewrite: 0.75, hybridBonus: 0.15 },
      });
      rawEvidence.push(...result.results
        .filter((item: KbSearchResult) => evidenceScopePaths.size === 0 || fileBindingKeys(item.filePath).some(key => evidenceScopePaths.has(key)))
        .map((item: KbSearchResult) => ({
          chapterId: chapter.id,
          filePath: item.filePath,
          score: item.score,
          content: item.content,
          roleId: fileRoleByPath.get(item.filePath),
          processingType: fileProcessingByPath.get(item.filePath),
          sectionTitle: item.sectionTitle,
          source: item.source,
        })));
    }
    const pinnedEvidencePaths = new Set(chapter.pinnedEvidenceFilePaths || []);
    const matchedRoleContexts = roleFactsForChapter(roleArtifacts, chapter, plan);
    rawEvidence.push(...matchedRoleContexts.flatMap(({ artifact }) => artifact.evidence.slice(0, 8).map(item => ({ ...item, chapterId: chapter.id, source: 'role-node' }))));
    const chapterPinnedPaths = new Set([...pinnedEvidencePaths]);
    for (const relativePath of chapterPinnedPaths) {
      const isPinnedEvidence = pinnedEvidencePaths.has(relativePath);
      const detail = project.getFileDetail(relativePath);
      if (!detail) {
        rawEvidence.push(...evidenceFromBoundFile(relativePath, fileRoleByPath.get(relativePath), fileProcessingByPath.get(relativePath), chapter.id, projectRoot).map(item => ({ ...item, source: isPinnedEvidence ? 'pinned-evidence' : item.source })));
        continue;
      }
      rawEvidence.push(...detail.chunks.slice(0, Math.max(maxEvidence, 20)).map(chunk => ({
        chapterId: chapter.id,
        filePath: detail.file.relativePath,
        score: 1,
        content: chunk.content,
        roleId: fileRoleByPath.get(detail.file.relativePath),
        processingType: fileProcessingByPath.get(detail.file.relativePath),
        sectionTitle: chunk.sectionTitle,
        source: isPinnedEvidence ? 'pinned-evidence' : 'bound-file',
      })));
    }
    const evidence = uniqueEvidence(rawEvidence, maxEvidence);
    const technicalFactEvidence = uniqueEvidence(rawEvidence, 120);
    allEvidence.push(...evidence);
    const technicalFacts = extractEngineeringTechnicalFacts(technicalFactEvidence, 160);
    const technicalFactAssignment = assignTechnicalFactsToChapter(chapter, technicalFacts);
    technicalFactAssignments.push(technicalFactAssignment);
    const technicalFactContext = technicalFactsPrompt(technicalFactAssignment);
    const coverageMatrixContext = engineeringCoverageMatrixPrompt(technicalFactAssignment);
    const missingFacts = chapter.requiredFacts.filter(fact => !evidence.some(item => evidenceMatchesFact(item, fact)));
    if (evidence.length === 0) missingItems.push(`${chapter.title}：未检索到明确资料依据`);
    for (const fact of missingFacts) missingItems.push(`${chapter.title}：${fact} 未检索到明确依据`);
    // 证据检索完成 → 立即汇报进度
    if (!progressStages.some(s => s.type === 'knowledge_retrieval')) {
      progressStages.push(displayStage({ type: 'knowledge_retrieval', roleId: 'knowledge-base', status: (allEvidence.length > 0 ? 'success' : 'fallback'), message: `已检索/绑定 ${allEvidence.length} 条证据` }));
      input.onProgress?.([...progressStages]);
    }

    throwIfAborted(input.signal);
    const forbidDrawingImages = shouldForbidDrawingImages(roleArtifacts, template);
    const roleContext = buildRoleChapterContext(roleArtifacts, chapter, plan);
    const specChapterRule = documentSpec?.chapterRules.find(rule => rule.id === chapter.id || rule.title === chapter.title);
    const minWords = plan?.minWords || specChapterRule?.minWords || documentSpec?.dynamicChapterRule.minWordsPerChapter || 1200;
    const isFirstChapter = chapterDrafts.length === 0;
    let llmContent = await Promise.race([
      buildLlmChapterContent(template, chapter, evidence, missingFacts, promptTexts, projectContext, input.requirement, roleContext, { forbidDrawingImages, minWords, technicalFactContext, coverageMatrixContext, tenderAnnouncementContext: isFirstChapter ? tenderAnnouncementContext : '' }),
      new Promise<null>(resolve => setTimeout(() => resolve(null), 120000)),
    ]);
    throwIfAborted(input.signal);
    if (!llmContent) {
      const compactEvidence = evidence.slice(0, 80);
      const compactRoleContext = roleContext.slice(0, 12000);
      llmContent = await Promise.race([
        buildLlmChapterContent(template, chapter, compactEvidence, missingFacts, promptTexts, projectContext, input.requirement, compactRoleContext, { forbidDrawingImages, minWords: Math.max(900, Math.floor(minWords * 0.75)), technicalFactContext: technicalFactContext.slice(0, 12000), coverageMatrixContext: coverageMatrixContext.slice(0, 8000), tenderAnnouncementContext: isFirstChapter ? tenderAnnouncementContext.slice(0, 8000) : '' }),
        new Promise<null>(resolve => setTimeout(() => resolve(null), 120000)),
      ]);
    }
    throwIfAborted(input.signal);
    if (!llmContent) throw new Error(`${chapter.title} 大模型未返回有效章节正文`);
    const content = llmContent;
    const sections = chapter.sections?.length ? chapter.sections : extractGeneratedSections(content);
    chapterGenerationStages.push(displayStage({
      type: 'chapter_generation',
      roleId: 'chapter_generation',
      promptId: promptBindings.find(binding => binding.roleId === 'chapter_generation')?.promptId,
      status: 'success',
      message: `${displayChapterTitle(chapter.title)} 已由大模型生成`,
    }, { subtitle: displayChapterTitle(chapter.title), order: chapterGenerationStages.length }));
    chapterDrafts.push({ id: chapter.id, title: chapter.title, content, evidence, missingFacts, sections });
    } catch (err) {
      if (input.signal?.aborted) throw err;
      console.error(`[gen] chapter ${chapter.title} failed:`, err);
      failedChapterMessages.push(`${chapter.title}：${err instanceof Error ? err.message : '生成失败'}`);
      chapterGenerationStages.push(displayStage({
        type: 'chapter_generation',
        roleId: 'chapter_generation',
        status: 'failed',
        message: `${displayChapterTitle(chapter.title)} 生成失败`,
      }, { subtitle: displayChapterTitle(chapter.title), order: chapterGenerationStages.length }));
    }
    // 章节生成完成（成功或失败）→ 汇报进度
    if (!progressStages.some(s => s.type === 'chapter_generation' && s.message === chapterGenerationStages[chapterGenerationStages.length - 1]?.message)) {
      progressStages.push(chapterGenerationStages[chapterGenerationStages.length - 1]!);
    }
    input.onProgress?.([...progressStages]);
  }

  if (chapterDrafts.length === 0) {
    throw new Error(`章节生成未完成：${failedChapterMessages.slice(0, 6).join('；') || '没有生成任何有效章节'}`);
  }

  throwIfAborted(input.signal);
  let fileUnderstanding: { stage: DocumentExecutionStage; notes: string[] } = { stage: { type: 'file_understanding', roleId: 'multimodal-files', status: 'skipped', message: '文件理解跳过' }, notes: [] };
  try { fileUnderstanding = await understandReferenceFiles(projectRoot, allEvidence); } catch (err) { if (input.signal?.aborted) throw err; console.error('[gen] fileUnderstanding failed:', err); }
  throwIfAborted(input.signal);
  for (const note of fileUnderstanding.notes) {
    allEvidence.push({
      chapterId: 'multimodal-file-understanding',
      filePath: '多模态模型文件理解结果',
      score: 1,
      content: note,
      roleId: 'multimodal-files',
      processingType: 'reference',
      source: 'multimodal',
    });
  }

  const facts = extractFacts(template, allEvidence, documentSpec);
  for (const artifact of roleArtifacts) {
    for (const fact of artifact.facts) facts[fact.key] = `${stringifyFactValue(fact.value)}（来源：${fact.sourceFile}，角色：${fact.roleId}）`;
  }
  const localFacts = extractStructuredFacts(allEvidence, template, documentSpec);
  let llmExtraction: { facts: DocumentFact[]; stages: DocumentExecutionStage[] } = { facts: [], stages: [] };
  try { llmExtraction = await extractFactsWithLlm(allEvidence, factExtractionPromptTexts, template, documentSpec); } catch (err) { if (input.signal?.aborted) throw err; console.error('[gen] fact extraction failed:', err); }
  throwIfAborted(input.signal);
  const roleStructuredFacts: DocumentFact[] = roleArtifacts.flatMap(artifact => artifact.facts.map(fact => ({ key: fact.key, value: stringifyFactValue(fact.value), sourceFile: fact.sourceFile, roleId: fact.roleId, confidence: 0.9 })));
  const tenderAnnouncementStructuredFacts: DocumentFact[] = tenderAnnouncementFacts.map(fact => ({ key: fact.key, value: fact.value, sourceFile: fact.sourceFile, roleId: 'tender_announcement', confidence: 0.95 }));
  const structuredFacts = [...tenderAnnouncementStructuredFacts, ...roleStructuredFacts, ...localFacts, ...llmExtraction.facts];

  // 进度回调：文件理解 + 事实抽取完成
  if (!progressStages.some(s => s.type === fileUnderstanding.stage.type)) {
    progressStages.push(fileUnderstanding.stage);
  }
  for (const stage of llmExtraction.stages) {
    if (!progressStages.some(s => s.type === stage.type)) {
      progressStages.push(stage);
    }
  }
  input.onProgress?.([...progressStages]);
  const structuredTables = extractStructuredTables(allEvidence);
  const pinnedEvidenceCount = allEvidence.filter(item => item.source === 'pinned-evidence').length;
  const autoEvidenceCount = allEvidence.filter(item => item.source !== 'pinned-evidence' && item.source !== 'bound-file').length;
  const enhancementStage: DocumentExecutionStage = displayStage({
    type: 'reference',
    roleId: 'quality-enhancement',
    status: allEvidence.length > 0 ? 'success' : 'skipped',
    message: `增强贡献：知识库证据 ${allEvidence.length} 条，人工确认/固定证据 ${pinnedEvidenceCount} 条，项目上下文 ${projectContextEntries.length} 条，自动检索证据 ${autoEvidenceCount} 条`,
  }, { subtitle: '证据与上下文增强' });
  progressStages.push(enhancementStage);
  input.onProgress?.([...progressStages]);
  for (const fact of structuredFacts) facts[fact.key] = `${stringifyFactValue(fact.value)}（来源：${fact.sourceFile}，角色：${fact.roleId}）`;
  const sourceCounts = new Map<string, number>();
  for (const item of allEvidence) sourceCounts.set(item.filePath, (sourceCounts.get(item.filePath) ?? 0) + 1);
  const sources = [...sourceCounts.entries()].sort((a, b) => b[1] - a[1]).map(([filePath, count]) => ({ filePath, count }));
  const factsModel = buildFactsModel(structuredFacts, structuredTables, missingItems, documentSpec);
  const chapterReadiness = evaluateChapterReadiness(chapterDrafts, documentSpec);
  const validation = validateDraft(chapterDrafts, structuredFacts, template);
  validation.warnings.push(...readiness.warnings);
  validation.errors.push(...readiness.blockingIssues);
  let validationIssues = buildValidationIssues(validation, factsModel, chapterDrafts);
  validationIssues.push(...chapterReadinessIssues(chapterReadiness));
  const fallbackChapterCount = chapterGenerationStages.filter(stage => stage.type === 'chapter_generation' && stage.status === 'fallback').length;
  const failedChapterCount = chapterGenerationStages.filter(stage => stage.type === 'chapter_generation' && stage.status === 'failed').length;
  if (fallbackChapterCount > 0) validationIssues.push({ level: 'error', message: `章节生成存在兜底：${fallbackChapterCount} 章`, suggestion: '请检查模型调用、提示词长度或证据负载后重新生成。' });
  if (failedChapterCount > 0) validationIssues.push({ level: 'warning', message: `部分章节生成失败：${failedChapterCount} 章`, suggestion: failedChapterMessages.slice(0, 6).join('；') || '请检查模型调用或资料配置后重新生成失败章节。' });
  const initialBlockingCount = validationIssues.filter(issue => issue.level === 'error' && isExportBlockingIssue(issue)).length;
  const assets: DocumentAsset[] = [];
  const executionStages: DocumentExecutionStage[] = [
    displayStage({ type: 'role_binding', roleId: projectRoleConfigId, status: fileBindings.length > 0 ? 'success' : 'fallback', message: `已绑定 ${fileBindings.length} 个文件角色、${promptBindings.length} 个提示词角色；后台自动规范 ${documentSpec.factFields.length} 个事实字段` }, { subtitle: projectRoleConfigName, roleName: projectRoleConfigName }),
    displayStage({ type: 'validation', roleId: 'document-readiness', status: readiness.ready ? 'success' : 'failed', message: `生成准备度：资料 ${Math.round(readiness.materialCoverageRate * 100)}%，资料角色 ${Math.round(readiness.roleSatisfactionRate * 100)}%，规范 ${Math.round(readiness.specCompletenessRate * 100)}%；${projectMaterialSummary.source.selectionReason}` }, { subtitle: '生成准备度检查' }),
    contextStage,
    displayStage({ type: 'knowledge_retrieval', roleId: 'knowledge-base', status: allEvidence.length > 0 ? 'success' : 'fallback', message: `已检索/绑定 ${allEvidence.length} 条证据` }),
    enhancementStage,
    displayStage(fileUnderstanding.stage),
    ...llmExtraction.stages.map(stage => displayStage(stage)),
    ...chapterGenerationStages,

    displayStage({ type: 'validation', roleId: 'document-workflow', status: initialBlockingCount > 0 ? 'failed' : 'success', message: `阻断 ${initialBlockingCount}，错误 ${validation.errors.length}，警告 ${validation.warnings.length}` }, { subtitle: '最终规范校验' }),
    displayStage({ type: 'formatting', roleId: 'document-workflow', status: 'success', message: '已生成正式排版 Markdown' }),
    displayStage({ type: 'export_ready', roleId: 'document-workflow', status: initialBlockingCount > 0 ? 'failed' : 'success', message: initialBlockingCount > 0 ? '导出门禁存在阻断项' : '已准备好导出 Markdown/HTML/DOCX/PDF' }),
  ];
  const base = {
    templateId: template.id,
    templateName: template.name,
    title: template.outputTitle,
    requirement: input.requirement || '',
    exportSettings: template.exportSettings,
    generationSettings: template.generationSettings,
    facts,
    structuredFacts,
    factsModel,
    chapters: chapterDrafts,
    sources,
    missingItems: [...new Set(missingItems)],
    validation,
    validationIssues,
    executionStages,
    exportGate: { passed: true, blockingIssues: [], checklist: [] },
    assets,
    generatedAt: Date.now(),
  };
  const initialMarkdown = composeDocumentMarkdown(base);
  throwIfAborted(input.signal);
  const review = await reviewAndOptimizeMarkdown({ template, spec: documentSpec, markdown: initialMarkdown, evidence: allEvidence, promptTexts: reviewPromptTexts || promptTexts, projectContext, requirement: input.requirement });
  throwIfAborted(input.signal);
  const forbidDrawingImages = shouldForbidDrawingImages(roleArtifacts, template);
  const reviewedMarkdownBase = normalizeTertiaryHeadings(removeUnwantedDrawingImages(review.markdown === initialMarkdown ? composeDocumentMarkdown({ ...base, validationIssues, exportGate: base.exportGate, executionStages }) : review.markdown, forbidDrawingImages));
  const structureIssueMessages = configuredStructureIssues(reviewedMarkdownBase, template).map(issue => issue.message);
  const placeholderIssueMessages = formalPlaceholderIssues(reviewedMarkdownBase).map(issue => `${issue.message}${issue.suggestion ? `：${issue.suggestion}` : ''}`);
  const gateIssueMessages = configuredAutoSpecGateIssues(reviewedMarkdownBase, template).map(issue => `${issue.message}${issue.suggestion ? `：${issue.suggestion}` : ''}`);
  const preciseIssueMessages = preciseFactUsageIssues(reviewedMarkdownBase, factsModel).map(issue => `${issue.message}${issue.suggestion ? `：${issue.suggestion}` : ''}`);
  const quantifiedCoverageMessages = validateQuantifiedCoverage({ assignments: technicalFactAssignments, markdown: reviewedMarkdownBase }).map(issue => `${issue.message}${issue.suggestion ? `：${issue.suggestion}` : ''}`);
  const tocIssueMessages = tocHierarchyIssues(reviewedMarkdownBase).map(issue => `${issue.message}${issue.suggestion ? `：${issue.suggestion}` : ''}`);
  const duplicateBasicInfoMessages = duplicateProjectBasicInfoIssues(reviewedMarkdownBase).map(issue => `${issue.message}${issue.suggestion ? `：${issue.suggestion}` : ''}`);
  const formalStyleMessages = formalStyleIssues(reviewedMarkdownBase).map(issue => `${issue.message}${issue.suggestion ? `：${issue.suggestion}` : ''}`);
  const minSectionMessages = minChapterSectionIssues(chapterDrafts).map(issue => `${issue.message}${issue.suggestion ? `：${issue.suggestion}` : ''}`);
  const tertiaryHeadingMessages = tertiaryHeadingIssues(reviewedMarkdownBase).map(issue => `${issue.message}${issue.suggestion ? `：${issue.suggestion}` : ''}`);
  const qualityIssues = [...tenderQualityIssues(reviewedMarkdownBase, chapterDrafts, tenderPlan, roleArtifacts, forbidDrawingImages), ...structureIssueMessages, ...placeholderIssueMessages, ...gateIssueMessages, ...preciseIssueMessages, ...quantifiedCoverageMessages, ...tocIssueMessages, ...duplicateBasicInfoMessages, ...formalStyleMessages, ...minSectionMessages, ...tertiaryHeadingMessages];
  const repair = await repairMarkdownByQuality({ markdown: reviewedMarkdownBase, template, plan: tenderPlan, artifacts: roleArtifacts, promptTexts, requirement: input.requirement, issues: qualityIssues, forbidDrawingImages });
  throwIfAborted(input.signal);
  const reviewedStages = repair.stage ? [...executionStages, review.stage, repair.stage] : [...executionStages, review.stage];
  const repairedMarkdown = removeUnwantedDrawingImages(repair.markdown, forbidDrawingImages);
  const finalSections = inferChapterSectionsFromMarkdown(repairedMarkdown, chapterDrafts);
  const finalChapterDrafts = chapterDrafts.map((chapter, index) => ({ ...chapter, sections: finalSections[index] || chapter.sections || [] }));
  const finalMarkdown = normalizeTertiaryHeadings(sanitizeFormalMarkdown(ensureFormalToc(repairedMarkdown, finalChapterDrafts)));
  const preRepairWarningIssues = [...tenderQualityIssues(reviewedMarkdownBase, chapterDrafts, tenderPlan, roleArtifacts, forbidDrawingImages), ...structureIssueMessages];
  validationIssues = applySpecGateRules(documentSpec, [...validationIssues, ...preRepairWarningIssues.map(message => ({ level: 'warning' as const, message }))], factsModel, finalChapterDrafts, finalMarkdown, fileBindings, promptBindings);
  validationIssues.push(...validateDraftWithAutoSpec({ markdown: finalMarkdown, spec: documentSpec, summary: projectMaterialSummary }));
  validationIssues.push(...validateFactConsistency({ markdown: finalMarkdown, facts: structuredFacts, summary: projectMaterialSummary }));
  validationIssues.push(...validateProjectContamination(finalMarkdown, projectMaterialSummary));
  validationIssues.push(...validateEngineeringDetailGate({ template, chapters: finalChapterDrafts, assignments: technicalFactAssignments, finalMarkdown }));
  validationIssues.push(...validateQuantifiedCoverage({ assignments: technicalFactAssignments, markdown: finalMarkdown }));
  validationIssues.push(...tocHierarchyIssues(finalMarkdown));
  validationIssues.push(...duplicateProjectBasicInfoIssues(finalMarkdown));
  validationIssues.push(...formalStyleIssues(finalMarkdown));
  validationIssues.push(...tertiaryHeadingIssues(finalMarkdown));
  validationIssues.push(...minChapterSectionIssues(finalChapterDrafts));
  validationIssues.push(...preciseFactUsageIssues(finalMarkdown, factsModel));
  validationIssues.push(...formalPlaceholderIssues(finalMarkdown));
  for (const benchmark of validateDocumentQualityBenchmark({ template, chapters: finalChapterDrafts, markdown: finalMarkdown })) validationIssues.push(...benchmark.issues);
  validationIssues.push(...validateEngineeringSpecialty({ markdown: finalMarkdown, chapters: finalChapterDrafts, summary: projectMaterialSummary, roles: resolvedMaterialRoles }));
  validationIssues.push(...configuredAutoSpecGateIssues(finalMarkdown, template));
  validationIssues.push(...pageTargetIssues(template.generationSettings || template.exportSettings, finalMarkdown));
  validationIssues.push(...configuredStructureIssues(finalMarkdown, template));
  const finalExportGate = buildExportGate(validationIssues, factsModel, finalChapterDrafts);
  const blockingCount = finalExportGate.blockingIssues.length;
  const finalStages: DocumentExecutionStage[] = reviewedStages.map(stage => {
    if (stage.type === 'validation') return { ...stage, status: blockingCount > 0 ? 'failed' : 'success', message: `阻断 ${blockingCount}，问题 ${validationIssues.length}` };
    if (stage.type === 'export_ready') return { ...stage, status: finalExportGate.passed ? 'success' : 'failed', message: finalExportGate.passed ? '已准备好导出 Markdown/HTML/DOCX/PDF' : '导出门禁存在阻断项' };
    return stage;
  });
  const finalBase = { ...base, chapters: finalChapterDrafts, validationIssues, exportGate: finalExportGate, executionStages: finalStages };
  return { ...finalBase, markdown: finalMarkdown };
}

export async function regenerateDocumentChapter(input: { templateId: string; chapterId: string; requirement?: string; maxEvidencePerChapter?: number; projectRoot?: string; documentId?: string; currentMarkdown?: string; existingFacts?: string[] }): Promise<DocumentDraftChapter> {
  const template = getDocumentTemplate(input.templateId);
  if (!template) throw new Error('Document template not found');
  const chapter = template.chapters.find(item => item.id === input.chapterId);
  if (!chapter) throw new Error('Document chapter not found');
  const projectRoot = input.projectRoot || getProjectRoot();
  if (!projectRoot) throw new Error('No knowledge base project found');
  const manager = getMultiProjectManager();
  const maxEvidence = Math.max(5, Math.min(30, input.maxEvidencePerChapter ?? 12));
  const rawEvidence: DocumentEvidence[] = [];
  for (const query of chapter.queries) {
    const result = await manager.search(projectRoot, query, {
      scope: 'project',
      limit: maxEvidence,
      weights: { keyword: 0.4, vector: 0.45, rewrite: 0.75, hybridBonus: 0.15 },
    });
    rawEvidence.push(...result.results.map((item: KbSearchResult) => ({
      chapterId: chapter.id,
      filePath: item.filePath,
      score: item.score,
      content: item.content,
      sectionTitle: item.sectionTitle,
      source: item.source,
    })));
  }
  const evidence = uniqueEvidence(rawEvidence, maxEvidence);
  const existingContext = input.currentMarkdown ? input.currentMarkdown.slice(0, 4_000) : '';
  const existingFactSet = new Set(input.existingFacts ?? []);
  const missingFacts = chapter.requiredFacts.filter(fact => !existingFactSet.has(fact) && !evidence.some(item => evidenceMatchesFact(item, fact)));
  const content = [
    `## ${chapter.title}`,
    '',
    input.requirement ? `> 生成要求：${input.requirement}` : '',
    existingContext ? `> 当前文档上下文摘要：${existingContext.replace(/\s+/gu, ' ').slice(0, 800)}` : '',
    evidence.length > 0 ? `本章根据知识库资料围绕“${chapter.purpose}”重新整理，并与当前文档上下文保持一致。` : '建议补充更多资料后复核。',
    '',
    evidence.length > 0 ? '### 资料依据' : '',
    ...evidence.map(evidenceLine),
    '',
    missingFacts.length > 0 ? '### 待确认事项' : '',
    ...missingFacts.map(item => `- ${item}：建议人工复核或补充更明确资料。`),
  ].filter(Boolean).join('\n');
  return { id: chapter.id, title: chapter.title, content, evidence, missingFacts };
}
