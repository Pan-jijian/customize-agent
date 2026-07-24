import * as fs from 'node:fs';
import * as path from 'node:path';
import * as XLSX from 'xlsx';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { createProvider } from '@customize-agent/llm';
import { computeProjectId } from '@customize-agent/knowledge';
import { resolveProtocol } from '@customize-agent/runtime';
import { getMultiProjectManager, getProjectRoot, listKnowledgeFiles } from './kbService';
import { recallDocumentContexts } from './contextService';
import { getConfigStore } from '@/services/configService';
import { getProjectRoleConfig, listDocumentRoles } from './documentRoleService';
import type { AutoDocumentSpecGateRule, AutoDocumentSpecPackage, GateRuleEvaluator } from './autoDocumentSpecTypes';
import { autoSpecPrompt, getOrCreateAutoDocumentSpec } from './autoDocumentSpecService';
import { buildProjectMaterialSummary, projectMaterialPrompt, type MaterialRole } from './projectMaterialService';
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
  status: 'running' | 'success' | 'fallback' | 'skipped' | 'failed';
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

export interface DocumentReviewMetadata {
  chapterSummaries: ChapterReviewSummary[];
  globalIssues: string[];
  diagnostics: DocumentGenerationDiagnostics;
}

export interface GeneratedDocumentDraft {
  templateId: string;
  templateName: string;
  title: string;
  requirement: string;
  projectRoot?: string;
  projectId?: string;
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
  partialChapters?: Array<{ id: string; title: string; chars: number; status: 'completed' | 'cached' | 'failed'; updatedAt: number }>;
  reviewMetadata?: DocumentReviewMetadata;
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
  const resolvedProjectRoot = path.resolve(projectRoot);
  const project = await getMultiProjectManager().getProject(resolvedProjectRoot);
  if (template.builtIn) await project.incrementalIndex();
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

function evidenceQualityScore(content: string) {
  const text = cleanEvidenceText(content);
  const chars = Math.max(1, text.length);
  const chinese = (text.match(/[\u4e00-\u9fa5]/gu) || []).length;
  const digits = (text.match(/\d/gu) || []).length;
  const engineeringTerms = (text.match(/工程|施工|质量|安全|工期|验收|材料|设备|清单|图纸|桩|管|钢筋|混凝土|土方|道路|排水|安装|规范/gu) || []).length;
  const noiseHits = (text.match(/CAD|AcDb|Polyline|ByLayer|ObjectId|Handle|Model|Layout|图层|页码|第\s*\d+\s*页|打印|版权所有|^[\s\W\d_]+$/gimu) || []).length;
  const repeatedHeaders = (text.match(/(?:序号|项目名称|单位|数量|综合单价|合价|备注)/gu) || []).length;
  const factDensity = Math.min(1, (chinese / chars) * 0.7 + Math.min(0.3, (digits + engineeringTerms * 3) / 120));
  const noiseScore = Math.min(1, noiseHits * 0.18 + Math.max(0, repeatedHeaders - 8) * 0.04 + (chinese / chars < 0.25 ? 0.35 : 0));
  return { noiseScore, factDensity, shouldUse: text.length >= 30 && noiseScore < 0.72 && factDensity > 0.08 };
}

function sanitizeEvidenceContent(filePath: string, content: string) {
  const ext = path.extname(filePath).toLowerCase();
  const cleaned = cleanEvidenceText(content)
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !/^(?:序号\s*)?(?:项目名称|单位|数量|综合单价|合价|备注)(?:\s+|$)/u.test(line))
    .filter(line => !/^第\s*\d+\s*页\s*(?:共\s*\d+\s*页)?$/u.test(line))
    .join('\n');
  const quality = evidenceQualityScore(cleaned);
  if (cleaned.length > 20 && quality.shouldUse) return cleaned.slice(0, 4000);
  if (cleaned.length > 80 && quality.noiseScore < 0.9) return cleaned.slice(0, 1600);
  if (['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.png', '.jpg', '.jpeg', '.webp', '.dwg'].includes(ext)) {
    return `该资料为${ext.replace('.', '').toUpperCase()}格式附件，仅作为内部事实提取依据；正式正文不得引用文件名。`;
  }
  return cleaned.slice(0, 1200);
}

function evidenceDedupeKey(item: DocumentEvidence): string {
  const normalized = item.content.replace(/\s+/gu, ' ').trim();
  return `${item.filePath}:${item.sectionTitle || ''}:${createHash('sha1').update(normalized).digest('hex')}`;
}

function uniqueEvidence(items: DocumentEvidence[], limit: number, diagnostics?: DocumentGenerationDiagnostics): DocumentEvidence[] {
  const seen = new Set<string>();
  const scored = items.map(item => {
    const content = sanitizeEvidenceContent(item.filePath, item.content);
    const quality = evidenceQualityScore(content);
    return { item: { ...item, content, score: item.score * (1 + quality.factDensity) * (1 - quality.noiseScore * 0.45) }, quality };
  });
  const usable = scored.filter(entry => entry.quality.shouldUse || /附件，仅作为内部事实提取依据/u.test(entry.item.content));
  const selected = (usable.length >= Math.min(3, items.length) ? usable : scored)
    .sort((a, b) => b.item.score - a.item.score)
    .filter(entry => {
      const key = evidenceDedupeKey(entry.item);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit);
  if (diagnostics) {
    const totalNoise = scored.reduce((sum, entry) => sum + entry.quality.noiseScore, 0);
    const totalDensity = scored.reduce((sum, entry) => sum + entry.quality.factDensity, 0);
    diagnostics.evidence.raw += items.length;
    diagnostics.evidence.used += selected.length;
    diagnostics.evidence.filteredNoise += Math.max(0, scored.length - usable.length);
    diagnostics.evidence.avgNoiseScore = scored.length ? Number((totalNoise / scored.length).toFixed(3)) : 0;
    diagnostics.evidence.avgFactDensity = scored.length ? Number((totalDensity / scored.length).toFixed(3)) : 0;
  }
  return selected.map(entry => entry.item);
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

const MAX_EXPLICIT_OUTLINE_CHAPTERS = 80;
const MAX_FALLBACK_CHAPTERS = 40;
const CN_NUMERAL_RE = '[零〇一二三四五六七八九十百千万两]+';

function cleanOutlineTitle(title: string) {
  let cleaned = title.trim();
  let prev = '';
  while (cleaned !== prev) {
    prev = cleaned;
    cleaned = cleaned
      .replace(new RegExp(`^\\s*第(?:\\d{1,3}|${CN_NUMERAL_RE})[章节]\\s*`, 'u'), '')
      .replace(new RegExp(`^\\s*[（(]?(?:\\d{1,3}|${CN_NUMERAL_RE})[)）、.．]\\s*`, 'u'), '')
      .replace(new RegExp(`^\\s*[-*+]\\s+`, 'u'), '')
      .trim();
  }
  return cleaned.replace(/\s+/gu, ' ');
}

function isInvalidOutlineTitle(title: string) {
  // 既然用户显式在 <OUTLINE> 中提供，完全信任用户的输入，不再做语义、关键字或长度限制
  // 仅过滤掉清理后完全为空的行
  return title.trim().length === 0;
}

function outlineTitlesFromBlock(content: string) {
  const cnOrder = `${CN_NUMERAL_RE}`;
  const markers = [
    `第(?:\\d{1,3}|${cnOrder})[章节]\\s*`,
    `(?:\\d{1,3})[、)）]\\s*`,
    `(?:\\d{1,3})[.．]\\s+(?!\\d)`,
    `(?:${cnOrder})[、.．)）]\\s*`,
    `[（(](?:\\d{1,3}|${cnOrder})[)）]\\s*`,
    `[-*+]\\s+`,
  ];
  let normalized = content.replace(/\r?\n/gu, '\n');
  for (const marker of markers) {
    normalized = normalized.replace(new RegExp(`([；;。！？!?])\\s*(?=${marker})`, 'gu'), '$1\n');
    normalized = normalized.replace(new RegExp(`(?<=\\n)\\s+(?=${marker})`, 'gu'), '');
    normalized = normalized.replace(new RegExp(`(?<![\\d.．])\\s+(?=${marker})`, 'gu'), '\n');
  }
  return normalized
    .split(/\n|；|;/u)
    .map(line => cleanOutlineTitle(line))
    .filter(title => !isInvalidOutlineTitle(title));
}

function extractOutlineBlocks(text: string, options?: { strict?: boolean }) {
  const exact = [...text.matchAll(/<\s*OUTLINE\s*>([\s\S]*?)<\/\s*OUTLINE\s*>/giu)].map(match => match[1] || '');
  if (exact.length > 0 || options?.strict) return exact;
  const loose = /(?:<\s*)?OUTLINE\s*>?\s*[:：]?\s*([\s\S]*?)(?:<\/\s*OUTLINE\s*>|END\s+OUTLINE|$)/iu.exec(text);
  return loose?.[1] ? [loose[1]] : [];
}

function extractExplicitOutlineFromText(text: string, source: string, options?: { strict?: boolean }): DocumentTemplateChapter[] {
  const chapters: DocumentTemplateChapter[] = [];
  const blocks = extractOutlineBlocks(text, options);
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
  return chapters.filter(chapter => !isInvalidOutlineTitle(chapter.title)).slice(0, MAX_EXPLICIT_OUTLINE_CHAPTERS);
}

function extractExplicitOutlineFromSources(sources: Array<{ text?: string; source: string; strict?: boolean }>) {
  for (const item of sources) {
    const chapters = extractExplicitOutlineFromText(item.text || '', item.source, { strict: item.strict });
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

function uniqueTemplateChapters(chapters: DocumentTemplateChapter[], options?: { preserveExplicitOutline?: boolean; template?: DocumentTemplate }) {
  const seen = new Set<string>();
  return chapters.filter(chapter => {
    const key = normalizeGeneratedChapterTitle(chapter.title);
    if (!key) return false;
    if (!options?.preserveExplicitOutline) {
      if (seen.has(key) || isPollutedChapterTitle(key)) return false;
      if (options?.template && violatesConfiguredChapterTitleForbiddenFilter(key, options.template)) return false;
    }
    seen.add(key);
    chapter.title = key;
    return true;
  });
}

function effectiveTemplateChapters(template: DocumentTemplate, spec?: AutoDocumentSpecPackage, options?: { preserveExplicitOutline?: boolean }): DocumentTemplateChapter[] {
  if (!spec || options?.preserveExplicitOutline) return uniqueTemplateChapters([...template.chapters], { ...options, template });
  return uniqueTemplateChapters([...template.chapters].map(chapter => {
    const title = displayChapterTitle(chapter.title);
    const rule = spec.chapterRules.find(item => item.id === chapter.id || displayChapterTitle(item.title) === title);
    return {
      ...chapter,
      title,
      purpose: chapter.purpose,
      requiredFacts: chapter.requiredFacts || [],
      queries: [...new Set([...(chapter.queries || []), title, rule?.generationHint || '', ...(chapter.sections || [])].filter(Boolean))],
    };
  }), { ...options, template });
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
  const chapters = effectiveTemplateChapters(template, spec);
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

interface ProjectBasicFact {
  key: string;
  value: string;
  sourceFile: string;
}

interface PromptIntentProfile {
  explicitStructure: boolean;
  explicitSections: boolean;
  lengthLimit: boolean;
  wantsConcise: boolean;
  detailedInstructions: boolean;
  explicitFacts: boolean;
  styleConstraint: boolean;
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

const ROLE_ARTIFACT_CACHE = new Map<string, RoleNodeArtifact>();
const CHAPTER_SEARCH_CACHE = new Map<string, KbSearchResult[]>();
interface DocumentGenerationStrategy {
  mode: 'fast' | 'balanced' | 'longform' | 'strict';
  enableChapterCache: boolean;
  enableChapterReview: boolean;
  enableGlobalReview: boolean;
  enableTypedRepair: boolean;
  maxChapterReviewConcurrency: number;
  targetLlmConcurrency: number;
}

interface DocumentPerformanceMetric {
  name: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  meta?: Record<string, string | number | boolean>;
}

interface DocumentGenerationDiagnostics {
  strategy: DocumentGenerationStrategy;
  metrics: DocumentPerformanceMetric[];
  cache: { chapterHits: number; chapterMisses: number; chapterWrites: number; sectionHits: number; sectionMisses: number; sectionWrites: number; prunedItems: number; rejectedHits: number };
  llm: { calls: number; failures: number; throttledWaits: number; maxActive: number; currentLimit: number; limitAdjustments: number };
  evidence: { raw: number; used: number; filteredNoise: number; avgNoiseScore: number; avgFactDensity: number };
  quality: { blockingCount: number; importantCount: number; minorCount: number; repairedCount: number; reusedChapterCount: number; reusedSectionCount: number };
}

const CHAPTER_DRAFT_CACHE = new Map<string, { value: DocumentDraftChapter; updatedAt: number; hits: number }>();
const SECTION_DRAFT_CACHE = new Map<string, { value: string; updatedAt: number; hits: number }>();
const DOCUMENT_LLM_PROVIDER_CACHE = new Map<string, ReturnType<typeof createProvider>>();
const MAX_DOCUMENT_CACHE_ITEMS = 800;
const DOCUMENT_CACHE_TTL_MS = Math.max(1, Number(process.env.DOCUMENT_CACHE_TTL_DAYS ?? 14)) * 24 * 60 * 60 * 1000;
let activeDocumentLlmCalls = 0;
let adaptiveDocumentLlmLimit = Math.max(1, Math.min(12, Number(process.env.DOCUMENT_LLM_CONCURRENCY ?? 6)));
let documentLlmFailureStreak = 0;
interface PendingDocumentLlmWaiter { resolve: () => void; reject: (error: Error) => void; active: boolean; onAbort?: () => void; signal?: AbortSignal }
const pendingDocumentLlmResolvers: PendingDocumentLlmWaiter[] = [];

function stableHash(value: unknown) {
  return createHash('sha1').update(JSON.stringify(value)).digest('hex');
}

function setLimitedCache<T>(cache: Map<string, T>, key: string, value: T) {
  if (cache.size >= MAX_DOCUMENT_CACHE_ITEMS) cache.delete(cache.keys().next().value as string);
  cache.set(key, value);
}

function selectDocumentGenerationStrategy(input: { template: DocumentTemplate; targetWords: number; requirement?: string }): DocumentGenerationStrategy {
  const chapterCount = input.template.chapters.length;
  const text = `${input.template.name}\n${input.template.category || ''}\n${input.requirement || ''}`;
  const strict = /投标|招标|施工|专项|安全|质量|验收|监理|合同|合规/u.test(text);
  const longform = input.targetWords >= 30000 || chapterCount >= 10;
  const fast = input.targetWords <= 6000 && chapterCount <= 4 && !strict;
  const mode: DocumentGenerationStrategy['mode'] = strict ? 'strict' : longform ? 'longform' : fast ? 'fast' : 'balanced';
  return {
    mode,
    enableChapterCache: !fast,
    enableChapterReview: !fast,
    enableGlobalReview: strict || longform,
    enableTypedRepair: true,
    maxChapterReviewConcurrency: mode === 'strict' ? 2 : mode === 'longform' ? 3 : 2,
    targetLlmConcurrency: mode === 'strict' ? 4 : mode === 'longform' ? 6 : fast ? 3 : 5,
  };
}

function createGenerationDiagnostics(strategy: DocumentGenerationStrategy): DocumentGenerationDiagnostics {
  return {
    strategy,
    metrics: [],
    cache: { chapterHits: 0, chapterMisses: 0, chapterWrites: 0, sectionHits: 0, sectionMisses: 0, sectionWrites: 0, prunedItems: 0, rejectedHits: 0 },
    llm: { calls: 0, failures: 0, throttledWaits: 0, maxActive: 0, currentLimit: adaptiveDocumentLlmLimit, limitAdjustments: 0 },
    evidence: { raw: 0, used: 0, filteredNoise: 0, avgNoiseScore: 0, avgFactDensity: 0 },
    quality: { blockingCount: 0, importantCount: 0, minorCount: 0, repairedCount: 0, reusedChapterCount: 0, reusedSectionCount: 0 },
  };
}

async function measureGenerationStep<T>(diagnostics: DocumentGenerationDiagnostics, name: string, run: () => Promise<T>, meta?: Record<string, string | number | boolean>) {
  const startedAt = Date.now();
  try {
    return await run();
  } finally {
    const endedAt = Date.now();
    diagnostics.metrics.push({ name, startedAt, endedAt, durationMs: endedAt - startedAt, meta });
  }
}

function pruneChapterDraftCache(diagnostics?: DocumentGenerationDiagnostics) {
  const now = Date.now();
  let pruned = 0;
  for (const [key, item] of CHAPTER_DRAFT_CACHE.entries()) {
    if (now - item.updatedAt > DOCUMENT_CACHE_TTL_MS) {
      CHAPTER_DRAFT_CACHE.delete(key);
      pruned += 1;
    }
  }
  while (CHAPTER_DRAFT_CACHE.size > MAX_DOCUMENT_CACHE_ITEMS) {
    const oldest = [...CHAPTER_DRAFT_CACHE.entries()].sort((a, b) => (a[1].updatedAt + a[1].hits * 60000) - (b[1].updatedAt + b[1].hits * 60000))[0]?.[0];
    if (!oldest) break;
    CHAPTER_DRAFT_CACHE.delete(oldest);
    pruned += 1;
  }
  if (diagnostics) diagnostics.cache.prunedItems += pruned;
}

function tuneDocumentLlmConcurrency(success: boolean, diagnostics?: DocumentGenerationDiagnostics) {
  const configured = Math.max(1, Math.min(12, Number(process.env.DOCUMENT_LLM_CONCURRENCY ?? 6)));
  const before = adaptiveDocumentLlmLimit;
  if (!success) {
    documentLlmFailureStreak += 1;
    if (documentLlmFailureStreak >= 2) adaptiveDocumentLlmLimit = Math.max(1, adaptiveDocumentLlmLimit - 1);
  } else {
    documentLlmFailureStreak = 0;
    if (pendingDocumentLlmResolvers.length === 0 && adaptiveDocumentLlmLimit < configured) adaptiveDocumentLlmLimit += 1;
  }
  if (diagnostics) {
    diagnostics.llm.currentLimit = adaptiveDocumentLlmLimit;
    if (before !== adaptiveDocumentLlmLimit) diagnostics.llm.limitAdjustments += 1;
  }
}

function persistentCacheEnabled() {
  return process.env.DOCUMENT_PERSISTENT_FACT_CACHE !== '0';
}

function persistentDocumentCachePath(projectRoot: string, kind: string, key: string) {
  return path.join(os.homedir(), '.customize-agent', 'document-cache', stableHash(projectRoot), kind, `${key}.json`);
}

function readPersistentJson<T>(projectRoot: string, kind: string, key: string): T | undefined {
  if (!persistentCacheEnabled()) return undefined;
  try {
    const filePath = persistentDocumentCachePath(projectRoot, kind, key);
    if (!fs.existsSync(filePath)) return undefined;
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function writePersistentJson(projectRoot: string, kind: string, key: string, value: unknown) {
  if (!persistentCacheEnabled()) return;
  try {
    const filePath = persistentDocumentCachePath(projectRoot, kind, key);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(value));
  } catch {
    // 持久化缓存仅用于提速，失败不影响生成主流程。
  }
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

interface RoleEvidencePool {
  files: Map<string, DocumentEvidence[]>;
  uniqueFileCount: number;
  bindingCount: number;
  fallbackFileCount: number;
}

function evidencePoolKey(projectRoot: string, filePath: string) {
  return path.relative(projectRoot, path.isAbsolute(filePath) ? filePath : path.join(projectRoot, filePath));
}

function projectEvidenceVersionHash(project: any, projectRoot: string, scopePaths: Set<string>) {
  const paths = [...scopePaths].sort();
  const entries = paths.map(filePath => {
    const detail = project.getFileDetail(filePath) || project.getFileDetail(path.join(projectRoot, filePath));
    if (!detail) return { filePath, missing: true };
    const chunks = (detail.chunks || []).slice(0, 200).map((chunk: { content: string; sectionTitle?: string }) => stableHash(`${chunk.sectionTitle || ''}\n${chunk.content}`));
    return { filePath: detail.file?.relativePath || filePath, chunkCount: detail.chunks?.length || 0, chunks };
  });
  return stableHash({ type: 'project-evidence-version-v1', entries });
}

function buildRoleEvidencePool(project: any, nodes: RoleExecutionNode[], projectRoot: string): RoleEvidencePool {
  const files = new Map<string, DocumentEvidence[]>();
  let fallbackFileCount = 0;
  for (const filePath of [...new Set(nodes.flatMap(node => node.filePaths))]) {
    const key = evidencePoolKey(projectRoot, filePath);
    const detail = project.getFileDetail(filePath);
    if (detail && detail.chunks.length > 0) {
      files.set(key, detail.chunks.slice(0, 120).map((chunk: { content: string; sectionTitle?: string }) => ({
        chapterId: 'role-evidence-pool',
        filePath: detail.file.relativePath,
        score: 1,
        content: chunk.content,
        sectionTitle: chunk.sectionTitle,
        source: 'role-node',
      })));
      continue;
    }
    const fallbackEvidence = evidenceFromBoundFile(filePath, undefined, undefined, 'role-evidence-pool', projectRoot);
    if (fallbackEvidence.length > 0) fallbackFileCount += 1;
    files.set(key, fallbackEvidence);
  }
  return { files, uniqueFileCount: files.size, bindingCount: nodes.reduce((sum, node) => sum + node.filePaths.length, 0), fallbackFileCount };
}

function evidenceForRoleFiles(pool: RoleEvidencePool, node: RoleExecutionNode, projectRoot: string): DocumentEvidence[] {
  const evidence = node.filePaths.flatMap(filePath => {
    const fileEvidence = pool.files.get(evidencePoolKey(projectRoot, filePath)) || [];
    return fileEvidence.map(item => ({ ...item, chapterId: node.id, roleId: node.fileRoleId, processingType: node.processingType }));
  });
  return uniqueEvidence(evidence, 120);
}

function roleArtifactCacheKey(input: { template: DocumentTemplate; node: RoleExecutionNode; evidence: DocumentEvidence[]; promptTexts: string; projectRoot: string; modelName?: string }) {
  return stableHash({
    type: 'role-artifact-v1',
    projectRoot: input.projectRoot,
    projectId: computeProjectId(input.projectRoot),
    templateId: input.template.id,
    templateName: input.template.name,
    node: {
      id: input.node.id,
      fileRoleId: input.node.fileRoleId,
      promptRoleIds: input.node.promptRoleIds,
      filePaths: input.node.filePaths,
      outputType: input.node.outputType,
    },
    promptTexts: input.promptTexts,
    modelName: input.modelName,
    evidence: input.evidence.map(item => ({ filePath: item.filePath, sectionTitle: item.sectionTitle, contentHash: stableHash(item.content) })),
  });
}

async function executeRoleExtractionNodeCached(input: { template: DocumentTemplate; node: RoleExecutionNode; evidence: DocumentEvidence[]; promptTexts: string; projectRoot: string; modelName?: string; signal?: AbortSignal }) {
  throwIfAborted(input.signal);
  const key = roleArtifactCacheKey(input);
  const cached = ROLE_ARTIFACT_CACHE.get(key);
  if (cached) return { artifact: cached, cached: true };
  const artifact = await executeRoleExtractionNode(input.template, input.node, input.evidence, input.signal);
  throwIfAborted(input.signal);
  setLimitedCache(ROLE_ARTIFACT_CACHE, key, artifact);
  return { artifact, cached: false };
}

function chapterSearchCacheKey(input: { projectRoot: string; query: string; evidenceScopePaths: Set<string>; maxEvidence: number; fileRolesHash: string }) {
  return stableHash({
    type: 'chapter-search-v1',
    projectRoot: input.projectRoot,
    projectId: computeProjectId(input.projectRoot),
    query: input.query,
    maxEvidence: input.maxEvidence,
    fileRolesHash: input.fileRolesHash,
    scope: [...input.evidenceScopePaths].sort(),
  });
}

async function cachedChapterSearch(input: { manager: ReturnType<typeof getMultiProjectManager>; projectRoot: string; query: string; evidenceScopePaths: Set<string>; maxEvidence: number; fileRolesHash: string }) {
  const key = chapterSearchCacheKey(input);
  const cached = CHAPTER_SEARCH_CACHE.get(key) || readPersistentJson<KbSearchResult[]>(input.projectRoot, 'chapter-search', key);
  if (cached) {
    setLimitedCache(CHAPTER_SEARCH_CACHE, key, cached);
    return cached;
  }
  const result = await input.manager.search(input.projectRoot, input.query, {
    scope: 'project',
    limit: Math.max(input.maxEvidence, input.evidenceScopePaths.size > 0 ? 30 : input.maxEvidence),
    weights: { keyword: 0.4, vector: 0.45, rewrite: 0.75, hybridBonus: 0.15 },
  });
  setLimitedCache(CHAPTER_SEARCH_CACHE, key, result.results);
  writePersistentJson(input.projectRoot, 'chapter-search', key, result.results);
  return result.results;
}

function chapterDraftCacheKey(input: { template: DocumentTemplate; chapter: DocumentTemplateChapter; evidence: DocumentEvidence[]; missingFacts: string[]; promptTexts: string; requirement?: string; projectRoot: string; modelName?: string; targetWords: number; fileRolesHash: string }) {
  return stableHash({
    type: 'chapter-draft-v1',
    projectRoot: input.projectRoot,
    projectId: computeProjectId(input.projectRoot),
    templateId: input.template.id,
    chapterId: input.chapter.id,
    chapterTitle: input.chapter.title,
    requirement: input.requirement || '',
    promptTexts: input.promptTexts,
    modelName: input.modelName || '',
    targetWords: input.targetWords,
    fileRolesHash: input.fileRolesHash,
    missingFacts: input.missingFacts,
    evidence: input.evidence.map(item => ({ filePath: item.filePath, score: Math.round(item.score * 1000) / 1000, roleId: item.roleId, processingType: item.processingType, source: item.source, digest: stableHash(item.content.slice(0, 3000)) })),
  });
}

function blockingChapterCacheIssues(issues: string[]) {
  return issues.filter(issue => /正文缺少章节标题|缺少配置小节|正文篇幅明显低于目标|后台流程话术/u.test(issue));
}

function readChapterDraftCache(input: Parameters<typeof chapterDraftCacheKey>[0], diagnostics?: DocumentGenerationDiagnostics) {
  pruneChapterDraftCache(diagnostics);
  const key = chapterDraftCacheKey(input);
  const memory = CHAPTER_DRAFT_CACHE.get(key);
  const cached = memory?.value || readPersistentJson<DocumentDraftChapter>(input.projectRoot, 'chapter-draft', key);
  if (!cached) {
    if (diagnostics) diagnostics.cache.chapterMisses += 1;
    return undefined;
  }
  if (cached.id !== input.chapter.id || !cached.content?.trim()) {
    if (diagnostics) diagnostics.cache.rejectedHits += 1;
    return undefined;
  }
  const targetIssues = lightweightChapterIssues({ chapter: input.chapter, content: cached.content, missingFacts: cached.missingFacts || input.missingFacts, targetWords: input.targetWords });
  if (blockingChapterCacheIssues(targetIssues).length > 0) {
    if (diagnostics) diagnostics.cache.rejectedHits += 1;
    return undefined;
  }
  if (memory) memory.hits += 1;
  setLimitedCache(CHAPTER_DRAFT_CACHE, key, { value: cached, updatedAt: Date.now(), hits: (memory?.hits || 0) + 1 });
  if (diagnostics) diagnostics.cache.chapterHits += 1;
  return cached;
}

function writeChapterDraftCache(input: Parameters<typeof chapterDraftCacheKey>[0], chapter: DocumentDraftChapter, diagnostics?: DocumentGenerationDiagnostics) {
  const key = chapterDraftCacheKey(input);
  setLimitedCache(CHAPTER_DRAFT_CACHE, key, { value: chapter, updatedAt: Date.now(), hits: 0 });
  writePersistentJson(input.projectRoot, 'chapter-draft', key, chapter);
  if (diagnostics) diagnostics.cache.chapterWrites += 1;
  pruneChapterDraftCache(diagnostics);
}

function sectionDraftCacheKey(input: { template: DocumentTemplate; chapter: DocumentTemplateChapter; sectionTitle: string; evidence: DocumentEvidence[]; promptTexts: string; requirement?: string; projectRoot: string; modelName?: string; targetWords: number; fileRolesHash: string }) {
  return stableHash({
    type: 'section-draft-v1',
    projectRoot: input.projectRoot,
    projectId: computeProjectId(input.projectRoot),
    templateId: input.template.id,
    chapterId: input.chapter.id,
    sectionTitle: input.sectionTitle,
    requirement: input.requirement || '',
    promptTexts: stableHash(input.promptTexts.slice(0, 12000)),
    modelName: input.modelName || '',
    targetWords: input.targetWords,
    fileRolesHash: input.fileRolesHash,
    evidence: input.evidence.map(item => ({ filePath: item.filePath, roleId: item.roleId, digest: stableHash(item.content.slice(0, 2000)) })),
  });
}

function readSectionDraftCache(input: Parameters<typeof sectionDraftCacheKey>[0], diagnostics?: DocumentGenerationDiagnostics) {
  const key = sectionDraftCacheKey(input);
  const memory = SECTION_DRAFT_CACHE.get(key);
  const cached = memory?.value || readPersistentJson<string>(input.projectRoot, 'section-draft', key);
  if (!cached?.trim()) {
    if (diagnostics) diagnostics.cache.sectionMisses += 1;
    return undefined;
  }
  if (/后台流程话术|提示词|占位|TODO|待补充/iu.test(cached) || documentTextLength(cached) < Math.max(120, Math.floor(input.targetWords * 0.45))) {
    if (diagnostics) diagnostics.cache.rejectedHits += 1;
    return undefined;
  }
  setLimitedCache(SECTION_DRAFT_CACHE, key, { value: cached, updatedAt: Date.now(), hits: (memory?.hits || 0) + 1 });
  if (diagnostics) {
    diagnostics.cache.sectionHits += 1;
    diagnostics.quality.reusedSectionCount += 1;
  }
  return cached;
}

function writeSectionDraftCache(input: Parameters<typeof sectionDraftCacheKey>[0], content: string, diagnostics?: DocumentGenerationDiagnostics) {
  if (!content.trim() || /后台流程话术|提示词|占位|TODO|待补充/iu.test(content)) return;
  const key = sectionDraftCacheKey(input);
  setLimitedCache(SECTION_DRAFT_CACHE, key, { value: content, updatedAt: Date.now(), hits: 0 });
  writePersistentJson(input.projectRoot, 'section-draft', key, content);
  if (diagnostics) diagnostics.cache.sectionWrites += 1;
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
      const texts = loadedPrompts.filter(prompt => prompt.roleId === promptRole.id).map(prompt => sanitizePromptForExecution(prompt.content));
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

async function executeRoleExtractionNode(template: DocumentTemplate, node: RoleExecutionNode, evidence: DocumentEvidence[], signal?: AbortSignal): Promise<RoleNodeArtifact> {
  const sample = evidence.slice(0, 36).map(item => `文件:${item.filePath}\n片段:${item.sectionTitle || ''}\n内容:${item.content.slice(0, 1200)}`).join('\n\n---\n\n');
  const promptText = node.promptTexts.join('\n\n') || '请读取绑定文件角色，抽取可用于文档生成的结构化信息。';
  const extractionPrompt = `你正在执行一个“文件角色 × 提示词角色”的读取节点。\n节点类型：${node.outputType}\n文件角色：${node.fileRoleName}（${node.fileRoleId}）\n要求：严格按该节点绑定的提示词读取该文件角色的内容，不要读取其他角色。提示词角色只提供规则和格式约束，其中的示例、样例、占位项目名、编号、日期、数量、清单和示例正文不得作为事实抽取来源。\n\n请返回 JSON，字段包括 chapters、facts、outputRequirements、forbidImageInsertion、warnings。chapters 只提取当前模板和规范包需要的正式章节；requirements 只保留可合并写入正文的核心要求，避免无依据地拆成过细子节点。facts 必须只来自下面的绑定文件片段，优先抽取施工对象、部位、区域、学校/片区、工程量、日期、工期、规格、单位、资源数量、检测频次和来源口径；同类对象不得合并丢失，计量单位保持原文含义，必要时使用导出友好的正式写法。\n\n绑定文件片段：\n${sample}`;
  const warnings: string[] = [];
  throwIfAborted(signal);
  let llm = sample.trim() ? await callDocumentLlmJson<RoleExtractionLlmResult>(promptText, extractionPrompt, { signal }) : undefined;
  throwIfAborted(signal);
  if (roleExtractionNeedsRepair(llm)) {
    warnings.push(`${node.fileRoleName} 结构化读取返回格式异常，已尝试修复 JSON schema。`);
    const repaired = await callDocumentLlmJson<RoleExtractionLlmResult>(
      '你是 JSON schema 修复器。只根据输入 JSON 重新整理字段类型，不新增事实，不改写事实含义。',
      `请把下面 JSON 修复为严格结构：{"chapters":[],"facts":[],"outputRequirements":[],"warnings":[],"forbidImageInsertion":false}。chapters 和 facts 必须是数组；如果原值是对象，请转为数组；如果无法转换，使用空数组。只返回 JSON。\n\n原始 JSON：\n${JSON.stringify(llm).slice(0, 12000)}`,
      { signal },
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
  const evidenceFiles = new Set(evidence.map(item => item.filePath));
  llmFacts.forEach(item => {
    const key = typeof item.key === 'string' ? item.key.trim() : '';
    const sourceFile = item.sourceFile && evidenceFiles.has(item.sourceFile) ? item.sourceFile : evidence.find(e => e.filePath)?.filePath || '';
    if (!key || item.value == null || !sourceFile || !evidenceFiles.has(sourceFile)) return;
    facts.push({
      key,
      value: cleanEvidenceText(stringifyFactValue(item.value)),
      sourceFile,
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

// TODO: 基础事实提取的正则匹配规则，考虑从硬编码迁移到 server-config.json 中配置化
const PROJECT_BASIC_FACT_FIELDS: Array<{ key: string; patterns: RegExp[]; chapterHint: RegExp }> = [
  { key: '项目名称', patterns: [/(?:项目名称|工程名称|项目简称|标的名称)\s*[:：]?\s*([^\n；;。]{3,100})/u], chapterHint: /项目|工程|名称|概况|总述/u },
  { key: '项目编号', patterns: [/(?:项目编号|工程编号|采购编号|招标编号|标段编号|合同编号)\s*[:：]?\s*([^\n；;。]{3,80})/u], chapterHint: /编号|概况|总述/u },
  { key: '建设单位', patterns: [/(?:建设单位|业主单位|采购人|招标人|委托人|甲方)\s*[:：]?\s*([^\n；;。]{2,100})/u], chapterHint: /建设单位|业主|采购人|招标人|甲方|概况/u },
  { key: '实施地点', patterns: [/(?:建设地点|项目地点|工程地点|实施地点|服务地点|交付地点|项目地址)\s*[:：]?\s*([^\n；;。]{2,120})/u], chapterHint: /地点|地址|现场|概况|部署/u },
  { key: '项目规模', patterns: [/(?:建设规模|项目规模|工程规模|服务规模|采购规模)\s*[:：]?\s*([^\n；;。]{2,180})/u], chapterHint: /规模|概况|范围|工程量/u },
  { key: '实施范围', patterns: [/(?:招标范围|工程范围|施工范围|服务范围|采购范围|实施范围|工作范围)\s*[:：]?\s*([^\n。]{5,300})/u], chapterHint: /范围|内容|任务|概况|部署/u },
  { key: '工期周期', patterns: [/(?:计划工期|工期要求|合同履行期限|服务期限|交付周期|实施周期)\s*[:：]?\s*([^\n；;。]{2,120})/u], chapterHint: /工期|周期|进度|计划|部署/u },
  { key: '质量标准', patterns: [/(?:质量标准|质量要求|验收标准|验收要求)\s*[:：]?\s*([^\n；;。]{2,140})/u], chapterHint: /质量|验收|标准/u },
  { key: '资金预算', patterns: [/(?:资金来源|资金落实情况|预算金额|最高限价|合同金额|投资金额)\s*[:：]?\s*([^\n；;。]{2,120})/u], chapterHint: /资金|预算|造价|投资|商务/u },
  { key: '标段包件', patterns: [/(?:标段划分|标包划分|包件划分|合同包)\s*[:：]?\s*([^\n；;。]{2,120})/u], chapterHint: /标段|包件|范围|概况/u },
  { key: '关键日期', patterns: [/(?:开工日期|竣工日期|投标截止|响应截止|交付日期|完成时间)\s*[:：]?\s*([^\n；;。]{2,120})/u], chapterHint: /日期|时间|进度|计划/u },
];

function extractProjectBasicFacts(evidence: DocumentEvidence[]): ProjectBasicFact[] {
  const facts: ProjectBasicFact[] = [];
  const seen = new Set<string>();

  for (const item of evidence) {
    for (const { key, patterns } of PROJECT_BASIC_FACT_FIELDS) {
      if (facts.some(fact => fact.key === key)) continue;
      for (const pattern of patterns) {
        const value = pattern.exec(item.content)?.[1]?.replace(/\s+/gu, ' ').trim();
        if (!value || /见(?:招标|公告|文件|附件)|详见|按.*要求/u.test(value)) continue;
        const dedupeKey = `${key}:${value}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        facts.push({ key, value: value.slice(0, 300), sourceFile: item.filePath });
        break;
      }
    }
  }
  return facts;
}

function analyzePromptIntent(text: string): PromptIntentProfile {
  // 防止超大文本导致正则表达式性能灾难，提取头部和尾部各 5000 字符进行意图判断（指令通常在开头或结尾）
  const safeText = text.length > 10000 ? `${text.slice(0, 5000)}\n\n${text.slice(-5000)}` : text;
  const normalized = safeText.replace(/\s+/gu, ' ');
  return {
    explicitStructure: /(?:目录|大纲|章节|结构|框架|按以下|如下结构|不要新增|不得新增|只写|仅写)/u.test(normalized),
    explicitSections: /(?:小节|二级标题|三级标题|一级标题|##|###|第[一二三四五六七八九十]+章|\d+[.、]\s*[^\s])/u.test(safeText),
    lengthLimit: /(?:\d+\s*(?:字|页|段)|控制在|不超过|不少于|篇幅|字数|页数)/u.test(normalized),
    wantsConcise: /(?:简洁|精简|简要|不要展开|无需展开|概述|摘要|少写|控制篇幅)/u.test(normalized),
    detailedInstructions: normalized.length >= 900 || /(?:必须包含|重点写|详细说明|逐项|分别说明|表格|清单|流程|步骤|标准|责任|频次|验收)/u.test(normalized),
    explicitFacts: /(?:\d+\s*(?:天|日|个月|万元|元|%|㎡|m2|米|m|人|台|套)|项目名称|工期|质量标准|地点|预算|编号)/u.test(normalized),
    styleConstraint: /(?:口吻|语气|风格|措辞|正式|承诺|汇报|方案|不要使用|禁止使用)/u.test(normalized),
  };
}

function shouldInjectProjectBasicFacts(profile: PromptIntentProfile) {
  return !(profile.explicitStructure || profile.explicitSections || profile.lengthLimit || profile.wantsConcise || profile.detailedInstructions || profile.explicitFacts || profile.styleConstraint);
}

function projectBasicFactsPrompt(facts: ProjectBasicFact[], chapter: DocumentTemplateChapter, profile: PromptIntentProfile) {
  if (facts.length === 0 || !shouldInjectProjectBasicFacts(profile)) return '';
  const text = [chapter.title, chapter.purpose, ...(chapter.sections || []), ...(chapter.queries || [])].join('\n');
  const matched = facts.filter(fact => {
    const field = PROJECT_BASIC_FACT_FIELDS.find(item => item.key === fact.key);
    return !field || field.chapterHint.test(text) || /概况|总述|说明|背景/u.test(text);
  });
  if (matched.length === 0) return '';
  return [
    '## 项目基础事实候选',
    '以下事实来自已进入本章证据范围的绑定资料，仅在与本章主题相关时自然吸收进正文；不得新增章节、不得强制生成表格、不得输出本提示标题。',
    ...matched.slice(0, 12).map(fact => `- ${fact.key}：${fact.value}`),
  ].join('\n');
}

function roleArtifactsDigest(artifacts: RoleNodeArtifact[], basicFacts: ProjectBasicFact[] = []) {
  const tenderDigest = basicFacts.length ? `## 项目基础事实候选\n${basicFacts.map(fact => `- ${fact.key}：${fact.value}`).join('\n')}` : '';
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
    validation: '内容优化与质量校验',
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
  '不得把“知识库、检索、文件角色、提示词角色、规范包、事实字段、项目基础事实候选、动态章节、缺失项、校验结果、资料未提供、未检索到”等后台流程话术写入正文。',
  '文档结构优先遵循用户需求、模板章节和绑定提示词；后台内容优化建议只用于提升事实覆盖和表达质量，不得新增、删除或重排章节。',
  '资料信息应内化为正式正文表达；除非用户要求来源追溯章节，否则不要单列系统证据清单。',
  '表格、标题和公式必须使用 Markdown/导出友好的写法，避免 ASCII 流程图和容易导致导出异常的符号组合。',
  '正式正文不得把原始公告、规则条款、说明性附件或系统过程内容误作为章节标题或目录项。',
  '如绑定资料中存在项目基础事实，应在相关章节自然吸收；如模板或用户要求表格化呈现，表格前只保留必要引导语，不得逐项重复叙述同一批字段。',
  '正文必须以当前模板、用户要求和绑定资料中的真实对象、范围、数量、时间、规格、标准、责任和约束为依据，不得自由发挥。',
  '同一规则、方案、流程或措施适用于多个对象、区域、主体、片区或分项时，必须逐项覆盖适用范围和对应依据，不得只写一个代表性对象后泛化到全部范围。',
  '不得使用“本节”“本章将”“以下从”“以下内容”等模板化前缀；标题后直接进入本章对象、关键事实、处理要求、控制措施和结果闭环。',
  '正文二级小节下如需设置三级小节，必须使用“#### 章号.节号.序号 标题”，例如“#### 2.2.1 关键事项”；不得用无编号独立加粗行表示三级小节；三级小节不纳入目录。',
  '资料不足或不同来源数值冲突时，应保持审慎并提示复核口径，不得编造精确数量。',
  '语言应正式、专业、克制，适合直接导出交付。',
].join('\n');

function tenderQualityIssues(markdown: string, chapters: DocumentDraftChapter[], plan: TenderPlanChapter[], artifacts: RoleNodeArtifact[], forbidDrawingImages: boolean) {
  const issues: string[] = [];
  for (const chapter of plan) {
    if (!markdown.includes(chapter.title)) issues.push(`章节计划建议未体现：${chapter.title}`);
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

function repairableQualityIssue(issue: string) {
  return /阻断|错误|正文缺少|缺少配置小节|缺少必要的正式表格|事实一致性|其他项目|项目编号|项目名称|清单\/图纸精确参数使用不足|正文未体现工程量清单|正文未体现图纸|二级小节少于|三级小节|目录|量化|数值|单位|图片/u.test(issue);
}

function lightweightChapterIssues(input: { chapter: DocumentTemplateChapter; content: string; missingFacts: string[]; targetWords: number }) {
  const issues: string[] = [];
  if (!new RegExp(`^##\\s+${input.chapter.title.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`, 'mu').test(input.content)) issues.push('正文缺少章节标题');
  for (const section of input.chapter.sections || []) {
    const escaped = section.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const match = input.content.match(new RegExp(`^###\\s+${escaped}\\s*\\n([\\s\\S]*?)(?=^###\\s+|$)`, 'mu'));
    if (!match) issues.push(`缺少配置小节：${section}`);
    else if (documentTextLength(match[1]) < 180) issues.push(`配置小节正文过短：${section}`);
  }
  if (documentTextLength(input.content) < Math.floor(input.targetWords * 0.65)) issues.push('正文篇幅明显低于目标');
  WORKFLOW_PHRASE_RE.lastIndex = 0;
  if (WORKFLOW_PHRASE_RE.test(input.content) || /知识库|检索|角色节点|事实字段|校验结果/u.test(input.content)) issues.push('正文包含后台流程话术');
  if (/资料未提供|满足相关要求|结合实际情况|按(?:相关|有关|规范|规定|设计)要求/u.test(input.content)) issues.push('正文存在空泛占位表达');
  for (const fact of input.missingFacts.slice(0, 8)) {
    if (fact && !input.content.includes(fact)) issues.push(`requiredFacts 未明显覆盖：${fact}`);
  }
  return [...new Set(issues)].slice(0, 10);
}

function issuesForChapter(chapter: DocumentDraftChapter, issues: string[]) {
  const actionableIssues = issues.filter(repairableQualityIssue);
  const sectionHits = new Set(chapter.sections || []);
  const text = `${chapter.title}\n${chapter.sections?.join('\n') || ''}\n${chapter.content.slice(0, 4000)}`;
  return actionableIssues.filter(issue => issue.includes(chapter.title) || [...sectionHits].some(section => issue.includes(section)) || /图片|三级小节|目录|表格|量化|数值|单位|事实/u.test(issue) && /!\[|####|\*\*|\||按设计要求|按规范要求|m\s*[²2]|mm2|cm2|km2/u.test(text));
}

type QualityRepairType = 'missing_structure' | 'loop_closure' | 'fact_conflict' | 'terminology' | 'table_numeric' | 'placeholder' | 'generic';

function classifyQualityRepairType(issues: string[]): QualityRepairType {
  const text = issues.join('\n');
  if (/缺少配置小节|二级小节少于|三级小节|目录|章节|结构/u.test(text)) return 'missing_structure';
  if (/闭环|责任|检查|验收|整改|风险|安全|质量|进度/u.test(text)) return 'loop_closure';
  if (/事实一致性|其他项目|项目编号|项目名称|冲突|污染|requiredFacts/u.test(text)) return 'fact_conflict';
  if (/术语|名称不一致|前后不一致/u.test(text)) return 'terminology';
  if (/表格|量化|数值|单位|清单|图纸|参数/u.test(text)) return 'table_numeric';
  if (/占位|空泛|后台流程|提示词|泄露|图片/u.test(text)) return 'placeholder';
  return 'generic';
}

function repairTypeInstruction(type: QualityRepairType) {
  switch (type) {
    case 'missing_structure': return '修复重点：补齐缺失小节、修正标题层级和目录相关结构；只在相关位置追加必要正文，不重排一级章节。';
    case 'loop_closure': return '修复重点：补齐对象、责任、措施、检查、验收、整改和记录闭环；不得编造具体数据。';
    case 'fact_conflict': return '修复重点：删除或改正与证据冲突的项目名称、编号、范围、参数；不确定内容改为基于资料的表述，不得新增无来源事实。';
    case 'terminology': return '修复重点：统一同一对象的术语、简称和称谓，保持前后一致，不改变事实含义。';
    case 'table_numeric': return '修复重点：补足表格前后说明、单位、参数来源和量化表达；资料不足时不得编造精确数值。';
    case 'placeholder': return '修复重点：移除占位话术、后台流程话术、提示词痕迹和不允许的图片语法，替换为正式业务表述。';
    default: return '修复重点：仅针对列出问题做最小必要修改，避免全文重写。';
  }
}

async function repairChapterByQuality(input: { template: DocumentTemplate; chapter: DocumentDraftChapter; issues: string[]; promptTexts: string; requirement?: string; forbidDrawingImages: boolean; repairType?: QualityRepairType; signal?: AbortSignal }) {
  throwIfAborted(input.signal);
  const repairType = input.repairType || classifyQualityRepairType(input.issues);
  const repaired = await callDocumentLlm([
    '你是章节局部修复专家。只修复给定章节中明确存在的问题，不得改写其他章节，不得压缩正文，不得改变用户/模板结构。',
    repairTypeInstruction(repairType),
    FORMAL_WRITING_RULES,
    input.forbidDrawingImages ? '图片/图纸类资料只作为文本事实来源，禁止插入图片或 Markdown 图片语法。' : '',
    '必须保留本章节标题和已有小节；如确需补充，只能在相关小节内追加或替换有问题的局部段落。',
    '不得返回整篇文档；只返回修复后的本章节 Markdown。',
    input.promptTexts,
  ].filter(Boolean).join('\n\n'), [
    `模板：${input.template.name}`,
    `章节：${input.chapter.title}`,
    input.requirement ? `用户要求：${input.requirement}` : '',
    `需要局部修复的问题：\n${input.issues.map(item => `- ${item}`).join('\n')}`,
    input.chapter.evidence.length ? `本章证据摘要：\n${evidenceBundlePrompt(buildEvidenceBundle({ id: input.chapter.id, title: input.chapter.title, purpose: input.chapter.title, queries: [], requiredFacts: [] }, input.chapter.evidence))}` : '',
    '当前章节 Markdown：',
    input.chapter.content,
  ].filter(Boolean).join('\n\n'), false, { maxTokens: Math.min(12000, Math.max(4000, Math.ceil(documentTextLength(input.chapter.content) * 1.4))), temperature: 0.2, signal: input.signal });
  throwIfAborted(input.signal);
  if (!repaired || repaired.length < input.chapter.content.length * 0.75 || !repaired.includes(input.chapter.title.replace(/^第[一二三四五六七八九十百千万]+章\s*/u, '').slice(0, 6))) return input.chapter.content;
  return sanitizeFormalMarkdown(removeUnwantedDrawingImages(repaired, input.forbidDrawingImages));
}

async function repairMarkdownByQuality(input: { markdown: string; template: DocumentTemplate; chapters: DocumentDraftChapter[]; promptTexts: string; requirement?: string; issues: string[]; forbidDrawingImages: boolean; strategy?: DocumentGenerationStrategy; signal?: AbortSignal }) {
  const repairableIssues = input.issues.filter(issue => classifyQualitySeverity(issue) !== 'minor').filter(repairableQualityIssue);
  if (repairableIssues.length === 0) return { markdown: input.markdown, chapters: input.chapters, stage: undefined as DocumentExecutionStage | undefined };
  const maxRepairAttempts = Math.max(0, Math.min(5, Number(process.env.DOCUMENT_MAX_REPAIR_CHAPTERS ?? 2)));
  const maxIssuesPerChapter = Math.max(1, Math.min(6, Number(process.env.DOCUMENT_MAX_REPAIR_ISSUES_PER_CHAPTER ?? 3)));
  const candidates = input.chapters
    .map(chapter => ({ chapter, issues: issuesForChapter(chapter, repairableIssues).slice(0, maxIssuesPerChapter) }))
    .filter(item => item.issues.length > 0)
    .slice(0, maxRepairAttempts);
  if (candidates.length === 0) {
    return {
      markdown: input.markdown,
      chapters: input.chapters,
      stage: { type: 'llm_review' as const, roleId: 'quality-repair', status: 'success' as const, message: `已完成质量检查，未定位到可安全局部修复的阻断问题：${repairableIssues.slice(0, 5).join('；')}` },
    };
  }
  const concurrency = Math.max(1, Math.min(3, Number(process.env.DOCUMENT_REPAIR_CONCURRENCY ?? 2)));
  const repairedById = new Map<string, string>();
  for (let offset = 0; offset < candidates.length; offset += concurrency) {
    throwIfAborted(input.signal);
    const batch = candidates.slice(offset, offset + concurrency);
    const results = await Promise.all(batch.map(async item => {
      const repairType = input.strategy?.enableTypedRepair === false ? 'generic' : classifyQualityRepairType(item.issues);
      const content = await repairChapterByQuality({ template: input.template, chapter: item.chapter, issues: item.issues, promptTexts: input.promptTexts, requirement: input.requirement, forbidDrawingImages: input.forbidDrawingImages, repairType, signal: input.signal });
      return { id: item.chapter.id, content, repairType };
    }));
    for (const result of results) repairedById.set(result.id, result.content);
  }
  let repairedCount = 0;
  const repairedChapters = input.chapters.map(chapter => {
    const content = repairedById.get(chapter.id);
    if (!content || content === chapter.content) return chapter;
    repairedCount += 1;
    return { ...chapter, content };
  });
  const message = repairedCount > 0
    ? `已并发精准修复 ${repairedCount} 个存在阻断/结构/事实问题的章节，未进行全文重写`
    : `已完成质量检查，未定位到可安全局部修复的阻断问题：${repairableIssues.slice(0, 5).join('；')}`;
  return {
    markdown: input.markdown,
    chapters: repairedChapters,
    stage: { type: 'llm_review' as const, roleId: 'quality-repair', status: 'success' as const, message },
  };
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

function fileScopeKeys(projectRoot: string, filePath: string) {
  const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(projectRoot, filePath);
  const relativePath = path.isAbsolute(filePath) ? path.relative(projectRoot, filePath) : filePath;
  return [filePath, absolutePath, relativePath, path.join(projectRoot, relativePath)];
}

function evidenceProjectPath(projectRoot: string, filePath: string) {
  const normalizedRoot = path.resolve(projectRoot);
  if (path.isAbsolute(filePath)) return path.resolve(filePath);
  const kbPath = path.resolve(normalizedRoot, 'knowledgeBase', filePath);
  if (fs.existsSync(kbPath)) return kbPath;
  return path.resolve(normalizedRoot, filePath);
}

function evidenceInCurrentProject(projectRoot: string, filePath: string) {
  const normalizedRoot = path.resolve(projectRoot);
  const absolute = evidenceProjectPath(normalizedRoot, filePath);
  return absolute === normalizedRoot || absolute.startsWith(`${normalizedRoot}${path.sep}`);
}

function evidenceInScope(projectRoot: string, filePath: string, scopePaths: Set<string>) {
  return evidenceInCurrentProject(projectRoot, filePath) && scopePaths.size > 0 && fileScopeKeys(projectRoot, filePath).some(key => scopePaths.has(key));
}

function buildBoundEvidenceScope(projectRoot: string, bindings: FileBinding[]) {
  return new Set(bindings.flatMap(binding => fileScopeKeys(projectRoot, binding.filePath)));
}

function sanitizePromptForExecution(content: string) {
  const lines = content.replace(/```[\s\S]*?```/gu, '\n【示例代码块已省略：仅作为格式参考，不作为项目事实】\n').split(/\r?\n/u);
  const result: string[] = [];
  let skippingExample = false;
  let inOutline = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/<\s*OUTLINE\s*>/iu.test(trimmed)) inOutline = true;
    if (inOutline) {
      result.push(line);
      if (/<\/\s*OUTLINE\s*>/iu.test(trimmed)) inOutline = false;
      continue;
    }
    const startsExample = /^(?:#+\s*)?(?:示例|样例|范例|例如|参考示例|示例数据|示例正文|示例目录|example|sample)\s*[:：]?/iu.test(trimmed);
    const startsRule = /(?:不得|禁止|必须|应当|要求|规则|格式|输出|保留|只返回|不要)/u.test(trimmed);
    if (startsExample && !startsRule) {
      if (!result.at(-1)?.includes('示例内容已省略')) result.push('【示例内容已省略：仅作为格式参考，不作为项目事实】');
      skippingExample = true;
      continue;
    }
    if (skippingExample) {
      if (!trimmed) {
        skippingExample = false;
        continue;
      }
      if (/^(?:#+\s*)?(?:规则|要求|输出|格式|禁止|注意|正文|章节|风格|校验)/u.test(trimmed)) skippingExample = false;
      else continue;
    }
    result.push(line);
  }
  return result.join('\n').replace(/\n{3,}/gu, '\n\n').trim();
}

function promptTextsForExecution(promptBindings: PromptBinding[], executionTypes: string[]) {
  const promptRoles = listDocumentRoles('prompt');
  const roleTypes = new Map(promptRoles.map(role => [role.id, role.executionType || 'reference']));
  return readPromptContents(promptBindings)
    .filter(prompt => executionTypes.includes(roleTypes.get(prompt.roleId) || 'reference'))
    .map(prompt => `## [${prompt.roleId}] ${prompt.name}\n${sanitizePromptForExecution(prompt.content)}`)
    .join('\n\n');
}

function promptOutlineTextsForExecution(promptBindings: PromptBinding[]) {
  return readPromptContents(promptBindings)
    .filter(prompt => /<\s*OUTLINE\s*>[\s\S]*?<\/\s*OUTLINE\s*>/iu.test(prompt.content))
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

function wakeNextDocumentLlmWaiter() {
  while (pendingDocumentLlmResolvers.length > 0) {
    const waiter = pendingDocumentLlmResolvers.shift();
    if (!waiter?.active) continue;
    waiter.active = false;
    waiter.signal?.removeEventListener('abort', waiter.onAbort || (() => undefined));
    waiter.resolve();
    break;
  }
}

async function withDocumentLlmSlot<T>(run: () => Promise<T>, signal?: AbortSignal, diagnostics?: DocumentGenerationDiagnostics) {
  while (activeDocumentLlmCalls >= Math.max(1, Math.min(12, adaptiveDocumentLlmLimit))) {
    if (diagnostics) diagnostics.llm.throttledWaits += 1;
    if (signal?.aborted) throw new Error('用户中止');
    await new Promise<void>((resolve, reject) => {
      const waiter: PendingDocumentLlmWaiter = { resolve, reject, active: true, signal };
      waiter.onAbort = () => {
        if (!waiter.active) return;
        waiter.active = false;
        const index = pendingDocumentLlmResolvers.indexOf(waiter);
        if (index >= 0) pendingDocumentLlmResolvers.splice(index, 1);
        reject(new Error('用户中止'));
      };
      signal?.addEventListener('abort', waiter.onAbort, { once: true });
      pendingDocumentLlmResolvers.push(waiter);
    });
  }
  activeDocumentLlmCalls += 1;
  if (diagnostics) diagnostics.llm.maxActive = Math.max(diagnostics.llm.maxActive, activeDocumentLlmCalls);
  try {
    const result = await run();
    tuneDocumentLlmConcurrency(true, diagnostics);
    return result;
  } catch (error) {
    tuneDocumentLlmConcurrency(false, diagnostics);
    throw error;
  } finally {
    activeDocumentLlmCalls = Math.max(0, activeDocumentLlmCalls - 1);
    wakeNextDocumentLlmWaiter();
  }
}

/** 调用底层 LLM 进行文档生成，支持文本模式和 JSON 模式 */
async function callDocumentLlm(system: string, prompt: string, jsonOnly = false, options: { maxTokens?: number; temperature?: number; signal?: AbortSignal; diagnostics?: DocumentGenerationDiagnostics } = {}): Promise<string | undefined> {
  if (options.diagnostics) options.diagnostics.llm.calls += 1;
  try {
    const active = getActiveModelWithProvider();
    if (!active) return undefined;
    const { model: selected, provider: providerConfig } = active;
    const providerKey = stableHash({ provider: selected.provider, model: selected.name, baseUrl: providerConfig.baseUrl, directEndpoint: providerConfig.directEndpoint, protocol: providerConfig.protocol, apiKeyHash: providerConfig.apiKey ? stableHash(providerConfig.apiKey) : '' });
    let provider = DOCUMENT_LLM_PROVIDER_CACHE.get(providerKey);
    if (!provider) {
      provider = createProvider(providerFactoryName(selected.provider, providerConfig), { baseUrl: providerConfig.baseUrl, apiKey: providerConfig.apiKey, modelName: selected.name, directEndpoint: providerConfig.directEndpoint });
      DOCUMENT_LLM_PROVIDER_CACHE.set(providerKey, provider);
    }
    const hardTimeoutMs = Math.max(30_000, Number(process.env.DOCUMENT_LLM_CALL_TIMEOUT_MS ?? 300_000));
    const response = await withDocumentLlmSlot(() => {
      let timer: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('LLM 调用超时')), hardTimeoutMs);
      });
      let abortListener: (() => void) | undefined;
      const raceItems: Array<Promise<Awaited<ReturnType<typeof provider.chat>>>> = [
        provider.chat([
          { role: 'system', content: jsonOnly ? `${system}\n只返回 JSON，不要返回 markdown。` : system },
          { role: 'user', content: prompt },
        ], { temperature: options.temperature ?? (jsonOnly ? 0 : 0.3), maxTokens: options.maxTokens, signal: options.signal }),
        timeoutPromise,
      ];
      if (options.signal) {
        raceItems.push(new Promise<never>((_, reject) => {
          if (options.signal?.aborted) { reject(new Error('用户中止')); return; }
          abortListener = () => reject(new Error('用户中止'));
          options.signal?.addEventListener('abort', abortListener, { once: true });
        }));
      }
      return Promise.race(raceItems).finally(() => {
        if (timer) clearTimeout(timer);
        if (abortListener) options.signal?.removeEventListener('abort', abortListener);
      });
    }, options.signal, options.diagnostics);
    return response.content.trim();
  } catch (error) {
    if (options.diagnostics) options.diagnostics.llm.failures += 1;
    if (options.signal?.aborted) throw new Error('用户中止', { cause: error });
    return undefined;
  }
}

async function callWithTimeout<T>(run: (signal: AbortSignal) => Promise<T>, timeoutMs: number, parentSignal?: AbortSignal): Promise<T | null> {
  const controller = new AbortController();
  if (parentSignal?.aborted) throw new Error('用户中止');
  const abort = () => controller.abort();
  parentSignal?.addEventListener('abort', abort, { once: true });
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, timeoutMs);
  });
  const raceItems: Array<Promise<T | null>> = [Promise.resolve().then(() => run(controller.signal)), timeoutPromise];
  if (parentSignal) {
    raceItems.push(new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => {
        if (parentSignal.aborted) reject(new Error('用户中止'));
      }, { once: true });
    }));
  }
  try {
    const result = await Promise.race(raceItems);
    if (parentSignal?.aborted) throw new Error('用户中止');
    return result;
  } finally {
    if (timer) clearTimeout(timer);
    parentSignal?.removeEventListener('abort', abort);
  }
}

/** 调用 LLM 并以 JSON 格式解析返回结果 */
async function callDocumentLlmJson<T>(system: string, prompt: string, options: { signal?: AbortSignal } = {}): Promise<T | undefined> {
  const response = await callDocumentLlm(system, prompt, true, { signal: options.signal });
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

async function understandReferenceFiles(projectRoot: string, evidence: DocumentEvidence[], signal?: AbortSignal): Promise<{ notes: string[]; stage: DocumentExecutionStage }> {
  const active = getActiveModelWithProvider();
  if (!active?.provider.capabilities?.fileUnderstanding && !active?.provider.capabilities?.imageUnderstanding) {
    return { notes: [], stage: { type: 'file_understanding', roleId: 'multimodal-files', status: 'skipped', message: '当前模型未开启文件理解/图片理解能力' } };
  }
  throwIfAborted(signal);
  const provider = createProvider(providerFactoryName(active.model.provider, active.provider), { baseUrl: active.provider.baseUrl, apiKey: active.provider.apiKey, modelName: active.model.name, directEndpoint: active.provider.directEndpoint });
  const fileAwareProvider = provider as typeof provider & { understandFiles?: (files: Array<{ name: string; mimeType: string; data: Buffer }>, prompt: string, options?: { maxTokens?: number; signal?: AbortSignal }) => Promise<{ content: string }> };
  if (!fileAwareProvider.understandFiles) return { notes: [], stage: { type: 'file_understanding', roleId: 'multimodal-files', status: 'skipped', message: '当前 Provider 未实现文件理解接口' } };
  const candidates = [...new Set(evidence.map(item => item.filePath).filter(file => /\.(png|jpe?g|webp|pdf|docx|xlsx)$/iu.test(file)))].slice(0, 6);
  const files = candidates.map(filePath => {
    const absolute = path.join(projectRoot, 'knowledgeBase', filePath);
    return fs.existsSync(absolute) ? { name: path.basename(filePath), mimeType: mimeTypeFromPath(filePath), data: fs.readFileSync(absolute) } : undefined;
  }).filter(Boolean) as Array<{ name: string; mimeType: string; data: Buffer }>;
  if (files.length === 0) return { notes: [], stage: { type: 'file_understanding', roleId: 'multimodal-files', status: 'skipped', message: '没有可发送给多模态模型的参考文件' } };
  try {
    throwIfAborted(signal);
    const response = await fileAwareProvider.understandFiles(files, '请阅读这些参考图片/文件，提炼可用于文档生成和审查的事实、视觉要点、地图信息和封面设计建议。请用中文要点输出。', { maxTokens: 1200, signal });
    throwIfAborted(signal);
    const note = response.content.trim();
    return { notes: note ? [note] : [], stage: { type: 'file_understanding', roleId: 'multimodal-files', status: note ? 'success' : 'fallback', message: note ? `已理解 ${files.length} 个多模态参考文件` : '多模态模型未返回有效文件理解结果' } };
  } catch {
    return { notes: [], stage: { type: 'file_understanding', roleId: 'multimodal-files', status: 'fallback', message: '文件理解调用失败，继续使用本地解析内容' } };
  }
}

function reliableFactForTarget(fact: DocumentFact, target: ReturnType<typeof specFactTargets>[number]) {
  const value = stringifyFactValue(fact.value).trim();
  if (!value || value.length < 2) return false;
  if (value.length > 220 && fact.confidence < 0.8) return false;
  const identity = `${fact.fieldId || ''} ${fact.fieldName || ''} ${fact.key}`.toLowerCase();
  const matchesTarget = identity.includes(target.id.toLowerCase()) || identity.includes(target.name.toLowerCase());
  if (!matchesTarget) return false;
  if (fact.roleId === 'project_basic_fact' || fact.roleId?.startsWith('role-') || fact.sourceRef?.filePath) return fact.confidence >= 0.55;
  return fact.confidence >= 0.75;
}

function shouldRunLlmFactExtraction(existingFacts: DocumentFact[], template: DocumentTemplate, spec?: AutoDocumentSpecPackage) {
  const targets = specFactTargets(template, spec).filter(target => target.required).slice(0, 30);
  if (targets.length === 0) return existingFacts.filter(fact => fact.confidence >= 0.75 && stringifyFactValue(fact.value).trim().length >= 2).length < 12;
  const covered = targets.filter(target => existingFacts.some(fact => reliableFactForTarget(fact, target))).length;
  return covered / targets.length < 0.9;
}

async function extractFactsWithLlm(evidence: DocumentEvidence[], promptTexts: string, template: DocumentTemplate, spec?: AutoDocumentSpecPackage, signal?: AbortSignal): Promise<{ facts: DocumentFact[]; stages: DocumentExecutionStage[] }> {
  const stages: DocumentExecutionStage[] = [{ type: 'fact_extraction', roleId: 'llm-json', status: 'skipped', message: 'LLM JSON 抽取未启用或无可用模型' }];
  const sample = evidence.slice(0, 24).map(item => `文件:${item.filePath}\n角色:${item.roleId || ''}\n处理:${item.processingType || ''}\n内容:${item.content.slice(0, 1200)}`).join('\n\n---\n\n');
  if (!sample.trim()) return { facts: [], stages };
  throwIfAborted(signal);
  const targets = specFactTargets(template, spec);
  const schemaText = targets.map(field => `- id=${field.id} name=${field.name} type=auto required=${field.required} sourceRoleIds=${field.sourceRoleIds.join(',') || '不限'} hint=${field.extractionHint || '无'}`).join('\n');
  const llm = await callDocumentLlmJson<{ facts?: Array<{ fieldId?: string; fieldName?: string; key: string; value: string; sourceFile?: string; roleId?: string; processingType?: string; confidence?: number }> }>(
    promptTexts || '你是文档事实抽取器。',
    `请严格按下面的动态事实 schema 从资料中抽取事实。只抽取资料明确支持的内容；如果字段限定 sourceRoleIds，必须优先来自对应文件角色；事实取舍和冲突处理遵循规范包字段说明、文件角色和提示词角色配置。\n返回 {"facts":[{"fieldId":"...","fieldName":"...","key":"...","value":"...","sourceFile":"...","roleId":"...","processingType":"project_fact","confidence":0.8}]}。\n\n动态事实 schema：\n${schemaText}\n\n资料：\n${sample}`,
    { signal },
  );
  throwIfAborted(signal);
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
  return /用户要求|出现禁用文本|资料未提供|导出|临时|无效|占位|示例|样例|生成未完成|低于目标页数|低于目标字数|文档预算未达成|正文篇幅低于目标|兜底|章节生成失败|大模型未能|重新生成|缺少配置小节|缺少必要的正式表格|正文缺少章节标题|其他项目|项目编号|项目名称|事实一致性冲突|工程专项资料角色缺失|章节缺少证据|文档质量基准评分未达标/iu.test(issue.message);
}

type QualitySeverity = 'blocking' | 'important' | 'minor';

function classifyQualitySeverity(issue: string | ValidationIssue): QualitySeverity {
  const message = typeof issue === 'string' ? issue : issue.message;
  const level = typeof issue === 'string' ? undefined : issue.level;
  if (level === 'error' || /阻断|缺少配置小节|缺少必要的正式表格|正文缺少章节标题|正文篇幅低于目标|低于目标字数|低于目标页数|章节生成失败|兜底|事实一致性冲突|其他项目|项目编号|项目名称|后台流程|提示词|资料未提供|占位|文档质量基准评分未达标/iu.test(message)) return 'blocking';
  if (/量化|数值|单位|清单|图纸|事实|requiredFacts|专业闭环|安全|质量|工期|表格|三级小节|目录|术语|不一致/iu.test(message)) return 'important';
  return 'minor';
}

function qualitySeveritySummary(issues: Array<string | ValidationIssue>) {
  return issues.reduce((summary, issue) => {
    summary[classifyQualitySeverity(issue)] += 1;
    return summary;
  }, { blocking: 0, important: 0, minor: 0 });
}

function estimateDocumentPages(markdown: string, settings?: DocumentGenerationSettings | DocumentExportSettings) {
  const textLength = documentTextLength(markdown);
  return Math.ceil(textLength / charsPerPageForSettings(settings));
}

function documentTextLength(markdown: string) {
  return markdown.replace(/<[^>]+>/gu, '').replace(/\s+/gu, '').length;
}

function charsPerPageForSettings(settings?: DocumentGenerationSettings | DocumentExportSettings) {
  const bodyFontSize = Number(String(settings && 'typography' in settings ? settings.typography?.bodySize || '' : '').replace(/[^\d.]/gu, '')) || 14;
  const lineHeight = Number(String(settings && 'typography' in settings ? settings.typography?.lineHeight || '' : '').replace(/[^\d.]/gu, '')) || 22;
  return bodyFontSize >= 14 && lineHeight >= 22 ? 900 : 1050;
}

interface DocumentBudget {
  targetPages?: number;
  minPages?: number;
  targetChars?: number;
  minChars?: number;
  charsPerPage: number;
  chapterTargets: Map<string, number>;
  source: 'explicit' | 'template' | 'spec' | 'default';
}

function parseChineseNumber(value: string) {
  const normalized = value.trim();
  if (/^\d+(?:\.\d+)?$/u.test(normalized)) return Number(normalized);
  const digits: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (normalized === '十') return 10;
  const ten = /^([一二两三四五六七八九])?十([一二三四五六七八九])?$/u.exec(normalized);
  if (ten) return (ten[1] ? digits[ten[1]] : 1) * 10 + (ten[2] ? digits[ten[2]] : 0);
  return undefined;
}

function explicitLengthTargets(text: string) {
  const normalized = text.replace(/\s+/gu, ' ');
  const pageMatches = [...normalized.matchAll(/(?:不少于|至少|约|大概|左右|生成|输出|达到|共)?\s*(\d+(?:\.\d+)?|[一二两三四五六七八九十]{1,3})\s*(?:页|頁)/gu)];
  const wordMatches = [...normalized.matchAll(/(?:不少于|至少|约|大概|左右|生成|输出|达到|共)?\s*(\d+(?:\.\d+)?|[一二两三四五六七八九十]{1,3})\s*(万)?\s*(?:字|字符)/gu)];
  const targetPages = pageMatches.map(match => parseChineseNumber(match[1] || '')).filter((value): value is number => Number.isFinite(value)).at(-1);
  const targetChars = wordMatches.map(match => {
    const value = parseChineseNumber(match[1] || '');
    return value ? Math.round(value * (match[2] ? 10000 : 1)) : undefined;
  }).filter((value): value is number => Number.isFinite(value)).at(-1);
  return { targetPages, targetChars };
}

function chapterBudgetWeight(chapter: DocumentTemplateChapter) {
  const title = chapter.title + chapter.purpose;
  if (/方法|施工|技术|质量|安全|进度|资源|保障|措施|部署|方案/u.test(title)) return 1.3;
  if (/概况|结语|附录/u.test(title)) return 0.75;
  return 1;
}

function buildDocumentBudget(input: { requirement?: string; promptTexts: string; template: DocumentTemplate; chapters: DocumentTemplateChapter[]; spec?: AutoDocumentSpecPackage }): DocumentBudget {
  const settings = input.template.generationSettings || input.template.exportSettings;
  const charsPerPage = charsPerPageForSettings(input.template.exportSettings || input.template.generationSettings);
  const explicit = explicitLengthTargets([input.requirement || '', input.promptTexts].join('\n'));
  const hasExplicitTarget = Boolean(explicit.targetChars || explicit.targetPages);
  const settingPages = hasExplicitTarget ? undefined : settings?.targetPages?.target || settings?.targetPages?.min;
  const explicitPageChars = explicit.targetPages ? explicit.targetPages * charsPerPage : undefined;
  const settingPageChars = settingPages ? settingPages * charsPerPage : undefined;
  const targetPages = explicit.targetPages || settingPages;
  const source: DocumentBudget['source'] = hasExplicitTarget ? 'explicit' : settingPages ? 'template' : input.spec?.chapterRules.some(rule => rule.minWords) || input.spec?.dynamicChapterRule.minWordsPerChapter ? 'spec' : 'default';
  const targetChars = hasExplicitTarget ? Math.max(explicit.targetChars || 0, explicitPageChars || 0) || undefined : Math.max(settingPageChars || 0) || undefined;
  const minPages = hasExplicitTarget ? (targetPages ? Math.floor(targetPages * 0.95) : undefined) : settings?.targetPages?.min || (targetPages ? Math.floor(targetPages * 0.95) : undefined);
  const minChars = targetChars ? Math.floor(targetChars * 0.95) : (minPages ? minPages * charsPerPage : undefined);
  const chapters = input.chapters.length > 0 ? input.chapters : input.template.chapters;
  const totalWeight = chapters.reduce((sum, chapter) => sum + chapterBudgetWeight(chapter), 0) || 1;
  const chapterTargets = new Map<string, number>();
  for (const chapter of chapters) {
    const fallback = Math.max(
      input.spec?.chapterRules.find(rule => rule.id === chapter.id || rule.title === chapter.title)?.minWords || 0,
      input.spec?.dynamicChapterRule.minWordsPerChapter || 0,
      1200,
    );
    const weightedTarget = targetChars ? Math.round(targetChars * chapterBudgetWeight(chapter) / totalWeight) : 0;
    chapterTargets.set(chapter.id, Math.max(fallback, weightedTarget));
  }
  return { targetPages, minPages, targetChars, minChars, charsPerPage, chapterTargets, source };
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

function documentBudgetIssues(budget: DocumentBudget, markdown: string): ValidationIssue[] {
  const { currentChars, estimatedPages } = documentBudgetStatus(budget, markdown);
  const issues: ValidationIssue[] = [];
  if (budget.minChars && currentChars < budget.minChars) {
    issues.push({ level: 'error', message: `正文篇幅低于目标字数：当前 ${currentChars} 字，目标不少于 ${budget.minChars} 字`, suggestion: '请继续扩写缺口章节，或降低目标字数/页数后重新生成。' });
  }
  if (budget.minPages && estimatedPages < budget.minPages) {
    issues.push({ level: 'error', message: `正文篇幅低于目标页数：预计约 ${estimatedPages} 页，目标不少于 ${budget.minPages} 页`, suggestion: '请继续扩写正文，或调整导出字号/行距后再导出。' });
  }
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
      issues.push({ level: 'warning', message: `第 ${index + 1} 章可能重复出现项目基本信息`, suggestion: '如该信息与本章主题无关，建议合并到更合适的概况类章节，避免重复铺陈。' });
    }
  }
  if (chapterMatches.length > 0) {
    const firstStart = chapterMatches[0].index || 0;
    const firstEnd = chapterMatches[1]?.index ?? markdown.length;
    const firstChapter = markdown.slice(firstStart, firstEnd);
    const tableIndex = firstChapter.search(/项目基本信息表|招标公告项目基本信息|\|\s*(?:字段|项目|内容)\s*\|/u);
    if (tableIndex > 0) {
      const beforeTable = firstChapter.slice(0, tableIndex).replace(/^##\s+.+$/gmu, '').replace(/^###\s+.+$/gmu, '');
      const repeatedFields = ['项目名称', '项目编号', '实施地点', '建设地点', '建设单位', '招标人', '实施范围', '招标范围', '工期周期', '计划工期', '质量标准'].filter(field => new RegExp(`${field}\\s*[：:]`, 'u').test(beforeTable));
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
  for (const chapter of spec.chapterRules) {
    const draft = chapters.find(item => item.title === chapter.title);
    if (draft && chapter.minWords && draft.content.length < chapter.minWords) next.push({ level: 'warning', message: `章节内容深度建议：${chapter.title}`, suggestion: `可扩展到约 ${chapter.minWords} 字，但不要改变模板章节结构。` });
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

function promptExampleLeakIssues(markdown: string, promptBindings: PromptBinding[]): ValidationIssue[] {
  const promptText = readPromptContents(promptBindings).map(prompt => prompt.content).join('\n\n');
  if (!promptText.trim()) return [];
  const issues: ValidationIssue[] = [];
  const exampleBlocks = [...promptText.matchAll(/(?:示例|样例|范例|例如|参考示例|示例数据|示例正文|示例目录|example|sample)\s*[:：]?\s*([\s\S]{20,800}?)(?=\n\s*\n|$)/giu)]
    .map(match => (match[1] || '').replace(/\s+/gu, ' ').trim())
    .filter(text => text.length >= 20);
  for (const block of exampleBlocks.slice(0, 20)) {
    const probe = block.slice(0, 80);
    if (probe.length >= 20 && markdown.replace(/\s+/gu, ' ').includes(probe)) {
      issues.push({ level: 'error', message: '正文疑似包含提示词示例内容', suggestion: '请删除提示词样例数据，仅保留基于当前项目资料生成的正式正文。' });
      break;
    }
  }
  return issues;
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

function buildChapterFactCoverageContext(input: { chapter: DocumentTemplateChapter; plan?: TenderPlanChapter; spec?: AutoDocumentSpecPackage; roleFacts: Array<{ fact: RoleNodeFact }>; technicalFactAssignment: TechnicalFactAssignment; projectBasicFacts: ProjectBasicFact[]; evidence: DocumentEvidence[]; missingFacts: string[] }) {
  const specRule = input.spec?.chapterRules.find(rule => rule.id === input.chapter.id || rule.title === input.chapter.title);
  const specFactNames = (specRule?.requiredFactIds || [])
    .map(id => input.spec?.factFields.find(field => field.id === id)?.name)
    .filter(Boolean) as string[];
  const requiredFacts = [...new Set([
    ...input.chapter.requiredFacts,
    ...specFactNames,
    ...(input.plan?.requiredContents || []),
    ...(input.plan?.evidenceNeeds || []),
  ].filter(Boolean))].slice(0, 18);
  const roleFactLines = input.roleFacts.slice(0, 10).map(({ fact }) => `- ${fact.key}：${cleanEvidenceText(stringifyFactValue(fact.value)).slice(0, 180)}`);
  const structuredFactLines = input.technicalFactAssignment.facts.slice(0, 14).map(fact => {
    const values = [...(fact.quantities || []), ...(fact.scheduleValues || []), ...(fact.resourceValues || []), ...(fact.standard || []), fact.parameter || '', fact.specification || ''].filter(Boolean).slice(0, 6).join('、');
    return `- ${[fact.discipline, fact.workItem].filter(Boolean).join('/') || fact.text.slice(0, 40)}${values ? `：${values}` : ''}`;
  });
  const projectLines = input.projectBasicFacts.slice(0, 8).map(fact => `- ${fact.key}：${fact.value}`);
  const evidenceSourceCount = new Set(input.evidence.map(item => item.filePath)).size;
  return [
    '【本章事实覆盖反馈】',
    requiredFacts.length ? `必须优先覆盖的事实/要求：\n${requiredFacts.map(item => `- ${item}`).join('\n')}` : '',
    roleFactLines.length ? `角色节点已抽取事实：\n${roleFactLines.join('\n')}` : '',
    structuredFactLines.length ? `结构化/量化事实：\n${structuredFactLines.join('\n')}` : '',
    projectLines.length ? `项目基础事实：\n${projectLines.join('\n')}` : '',
    input.missingFacts.length ? `当前检索未充分命中的事实：${input.missingFacts.join('、')}。如资料未明确提供，不得编造具体数值，应写成需要复核的条件、假设或处理措施。` : '',
    `本章可用资料来源约 ${evidenceSourceCount} 个文件，正文必须把可用事实内化到对应小节，不得单列后台资料清单。`,
  ].filter(Boolean).join('\n');
}

/** 使用 LLM 生成单章内容，基于证据包、提示词角色和用户需求 */
async function buildLlmChapterContent(template: DocumentTemplate, chapter: DocumentTemplate['chapters'][number], evidence: DocumentEvidence[], missingFacts: string[], promptTexts: string, projectContext: string, requirement?: string, roleContext = '', options: { forbidDrawingImages?: boolean; minWords?: number; targetWords?: number; maxTokens?: number; technicalFactContext?: string; coverageMatrixContext?: string; projectBasicFactContext?: string; factCoverageContext?: string; signal?: AbortSignal } = {}) {
  const bundle = buildEvidenceBundle(chapter, evidence);
  const evidenceText = evidenceBundlePrompt(bundle);
  if (!evidenceText.trim() && !roleContext.trim()) return undefined;
  const promptIntent = analyzePromptIntent([promptTexts, requirement || ''].filter(Boolean).join('\n\n'));
  const sectionInstruction = chapter.sections?.length
    ? `本章必须完整包含以下二级小节，且每个小节都要有实质正文：\n${chapter.sections.map(section => `- ${section}`).join('\n')}`
    : (promptIntent.explicitStructure || promptIntent.explicitSections || promptIntent.lengthLimit || promptIntent.wantsConcise)
      ? '本章未预设二级小节；请优先遵循用户提示词和模板结构组织内容，不得因系统增强自行扩展小节。'
      : '本章未预设二级小节；必须根据章节主题、项目资料和专业写作需要生成 3-6 个正式二级小节，不得新增、删除或重排一级章节。';
  const sectionBudgetInstruction = buildSectionBudgetInstruction(chapter, options.targetWords || options.minWords || 0);
  const system = [
    '你是专业项目文档生成专家，必须严格使用已提供的内部资料生成正式文档章节。',
    FORMAL_WRITING_RULES,
    '准确性优先级：用户需求/模板章节 > 绑定提示词与角色节点结构化事实 > 知识库证据 > 后台内容优化建议 > 项目上下文/历史记忆。内部优先级只用于判断事实，不得写入正文。',
    '项目上下文/历史记忆只能作为用户偏好、历史纠偏和连续性参考；不得覆盖、替代或改写知识库证据中的事实。',
    '提示词角色只提供规则和格式约束；其中的示例、样例、占位项目名、编号、日期、数量、清单和示例正文不得作为当前项目事实，不得写入正文。',
    options.forbidDrawingImages ? '图片/图纸类资料只作为文本事实依据；禁止插入图片或 Markdown 图片语法。' : '',
    '不要编造资料；可以基于证据做合理归纳；输出 Markdown；不要输出代码块。',
    promptTexts,
  ].filter(Boolean).join('\n\n');
  const prompt = [
    `文档模板：${template.name}`,
    `章节标题：${chapter.title}`,
    `章节目的：${chapter.purpose}`,
    sectionInstruction,
    sectionBudgetInstruction,
    requirement ? `用户要求：${requirement}` : '',
    projectContext ? `项目上下文/历史记忆（仅作偏好、历史纠偏和连续性参考；如与知识库证据冲突，以知识库证据为准）：\n${projectContext}` : '',
    options.projectBasicFactContext || '',
    roleContext ? roleContext : '',
    options.factCoverageContext || '',
    options.technicalFactContext || '',
    options.coverageMatrixContext || '',
    missingFacts.length ? `需要特别补足的事实：${missingFacts.join('、')}` : '',
    '请生成一个专业、充实、可直接导出的正式文档章节，要求：',
    `- 首轮生成必须尽量达到目标篇幅的 85%-95%；内容不少于 ${options.minWords || 1000} 字${options.targetWords ? `，目标约 ${options.targetWords} 字` : ''}，不得依赖后续扩写补救。`,
    '- 保留章节标题；如模板配置了小节，必须按配置完整生成；如未配置小节且用户未限制结构，必须生成 3-6 个正式二级小节；每个二级小节必须有实质正文，不能只有标题或表格。',
    chapter.tableSections?.length ? `- 本章以下小节适合使用正式表格辅助表达：${chapter.tableSections.join('、')}；表格必须由正文归纳形成，禁止直接粘贴资料摘录。` : '',
    '- 表格只用于模板、用户要求或资料内容适合结构化表达的位置；表格前必须说明数据来源和适用范围，表格后必须说明控制措施、结论或执行要求，不能整节只有表格。',
    '- 不得使用“本节”“本章将”“以下从”“以下内容”等模板化前缀；标题后直接进入本章对象、关键事实、处理要求、控制措施和结果闭环。',
    '- 每个核心小节必须形成“对象/范围 → 依据/关键事实 → 执行或说明动作 → 控制要求 → 结果/责任闭环”的完整表达链条；具体术语以模板、用户要求和资料内容为准。',
    '- 二级小节下如需设置三级小节，必须使用“#### 章号.节号.序号 标题”，例如“#### 2.2.1 关键事项”；三级小节不纳入目录；不得使用无编号独立加粗行表示三级小节。',
    '- 必须使用模板节点提取的章节要求和输出规范；',
    '- 必须结合项目事实、表格数据、标准要求、约束条件等内部资料；',
    '- 对同一对象的事实应综合表达，优先写入准确的数量、单位、规格、参数、做法和标准；',
    '- 日期、数量、数值、规格、周期、资源、范围、对象等量化内容必须来自资料或明确推导；无依据时不得编造具体值。',
    '- 如果同一规则、方案、流程或措施适用于多个对象、区域、主体、片区或分项，必须逐项覆盖适用范围和对应依据，不得只写其中一个。',
    '- 对模板和资料中已经明确给出的关键事实、数量、时间、规格、标准、范围、对象、责任或约束，必须写入对应小节，不能只写原则性要求。',
    '- 严禁使用空泛占位表达替代资料事实；确实缺少资料时，只能写成待复核事项、约束条件或控制措施，不得编造具体数值。',
    '- 正文不得出现“知识库”“证据”“检索”“角色节点”“事实字段”“校验结果”等后台系统话术。',
    '- 存在事实冲突时，优先遵循用户要求、模板结构、绑定文件证据和提示词角色；后台内容优化建议仅作质量参考；',
    '- 默认不要引用原始文件名，不写解析器内部对象名；',
    '- 将资料要点自然融入正文，不单列系统证据或来源章节；',
    '- 小节层级保持适度，不要输出中间分析产物标题；',
    '- 组织关系、流程、职责、资源配置、风险控制等适合表格表达的内容可使用 Markdown 表格；',
    options.targetWords && options.targetWords >= 3500 ? '- 用户已提出较高篇幅目标，本章必须围绕每个二级小节充分展开对象范围、资料依据、关键事实、执行要求、风险约束、检查确认和责任闭环；不得用摘要式段落替代正文。' : '',
    '',
    evidenceText ? '内部资料：' : '',
    evidenceText,
  ].filter(Boolean).join('\n');
  const content = await callDocumentLlm(system, prompt, false, { maxTokens: options.maxTokens, signal: options.signal });
  if (!content || content.length < 120) return undefined;
  return sanitizeFormalMarkdown(removeUnwantedDrawingImages(content.startsWith('## ') ? content : `## ${chapter.title}\n\n${content}`, Boolean(options.forbidDrawingImages)));
}

function sectionTargets(chapter: DocumentTemplateChapter, targetWords: number) {
  const sections = chapter.sections?.filter(Boolean) || [];
  if (sections.length === 0) return [];
  const base = Math.max(700, Math.floor(targetWords / sections.length));
  return sections.map(section => ({ title: section, targetWords: base }));
}

function buildSectionBudgetInstruction(chapter: DocumentTemplateChapter, targetWords: number) {
  const targets = sectionTargets(chapter, targetWords);
  if (targets.length === 0) return '';
  return [
    '本章小节篇幅计划（首轮生成应尽量一次达成，避免后续补写）：',
    ...targets.map(item => `- ${item.title}：约 ${item.targetWords} 字，至少达到 ${Math.floor(item.targetWords * 0.8)} 字，并覆盖对象/范围、依据/关键事实、处理要求、控制措施和结果闭环。`),
  ].join('\n');
}

function tokenizeForRelevance(text: string) {
  return [...new Set((text.match(/[\p{Script=Han}]{2,}|[A-Za-z0-9_-]{3,}/gu) || []).map(item => item.toLowerCase()))].slice(0, 40);
}

function evidenceForSection(sectionTitle: string, chapter: DocumentTemplateChapter, evidence: DocumentEvidence[], limit = 45) {
  const tokens = tokenizeForRelevance([sectionTitle, chapter.title, ...(chapter.requiredFacts || [])].join(' '));
  const scored = evidence.map((item, index) => {
    const text = `${item.sectionTitle || ''}\n${item.content}`.toLowerCase();
    const hitScore = tokens.reduce((score, token) => score + (text.includes(token) ? 1 : 0), 0);
    const sectionScore = item.sectionTitle && sectionTitle.includes(item.sectionTitle) || item.sectionTitle && item.sectionTitle.includes(sectionTitle) ? 4 : 0;
    return { item, score: hitScore + sectionScore + item.score * 0.1 - index * 0.001 };
  }).sort((a, b) => b.score - a.score);
  const selected = scored.filter(item => item.score > 0).slice(0, limit).map(item => item.item);
  return selected.length >= Math.min(12, evidence.length) ? selected : evidence.slice(0, limit);
}

async function buildLlmSectionContent(input: { template: DocumentTemplate; chapter: DocumentTemplateChapter; sectionTitle: string; evidence: DocumentEvidence[]; missingFacts: string[]; promptTexts: string; projectContext: string; requirement?: string; roleContext: string; targetWords: number; forbidDrawingImages: boolean; factCoverageContext?: string; signal?: AbortSignal }) {
  const sectionEvidence = evidenceForSection(input.sectionTitle, input.chapter, input.evidence);
  const evidenceText = evidenceBundlePrompt(buildEvidenceBundle(input.chapter, sectionEvidence));
  const prompt = [
    `文档模板：${input.template.name}`,
    `章节标题：${input.chapter.title}`,
    `当前二级小节：${input.sectionTitle}`,
    input.requirement ? `用户要求：${input.requirement}` : '',
    input.projectContext ? `项目上下文：\n${input.projectContext}` : '',
    input.factCoverageContext || '',
    input.roleContext,
    input.missingFacts.length ? `需要特别补足的事实：${input.missingFacts.join('、')}` : '',
    `请只生成当前二级小节正文，使用“### ${input.sectionTitle}”作为小节标题，目标约 ${input.targetWords} 字。`,
    '- 内容必须围绕当前小节，不得生成其他二级小节，不得重复章节一级标题。',
    '- 必须把资料中的关键事实、数量、时间、规格、标准、范围、对象、责任或约束写入正文；缺少依据时不得编造。',
    '- 每个小节必须包含对象/范围、依据/关键事实、处理要求、控制措施和结果闭环；具体术语以模板、用户要求和资料为准。',
    '- 表格只能作为辅助表达，表格前后必须有正文说明，不能整节只有表格。',
    evidenceText ? `内部资料：\n${evidenceText}` : '',
  ].filter(Boolean).join('\n\n');
  const content = await callDocumentLlm([
    '你是正式业务文档的小节生成专家。',
    FORMAL_WRITING_RULES,
    input.promptTexts,
  ].filter(Boolean).join('\n\n'), prompt, false, { maxTokens: outputTokensForChapter(input.targetWords), temperature: 0.25, signal: input.signal });
  if (!content || content.length < 80) return undefined;
  const normalized = sanitizeFormalMarkdown(removeUnwantedDrawingImages(content.startsWith('### ') ? content : `### ${input.sectionTitle}\n\n${content}`, input.forbidDrawingImages));
  return normalized.replace(/^##\s+.*\n+/u, '').trim();
}

async function buildSectionParallelChapterContent(input: { template: DocumentTemplate; chapter: DocumentTemplateChapter; evidence: DocumentEvidence[]; missingFacts: string[]; promptTexts: string; projectContext: string; requirement?: string; roleContext: string; targetWords: number; forbidDrawingImages: boolean; factCoverageContext?: string; projectRoot?: string; modelName?: string; fileRolesHash?: string; diagnostics?: DocumentGenerationDiagnostics; signal?: AbortSignal }) {
  const targets = sectionTargets(input.chapter, input.targetWords);
  if (targets.length < 2 || input.targetWords < 6000) return undefined;
  const concurrency = Math.max(1, Math.min(4, Number(process.env.DOCUMENT_SECTION_CONCURRENCY ?? 4)));
  const results: Array<string | undefined> = new Array(targets.length);
  const runSection = async (item: { title: string; targetWords: number }, compact = false) => {
    const cacheInput = input.projectRoot && input.fileRolesHash ? { template: input.template, chapter: input.chapter, sectionTitle: item.title, evidence: compact ? input.evidence.slice(0, 80) : input.evidence, promptTexts: input.promptTexts, requirement: input.requirement, projectRoot: input.projectRoot, modelName: input.modelName, targetWords: item.targetWords, fileRolesHash: input.fileRolesHash } : undefined;
    if (!compact && cacheInput) {
      const cached = readSectionDraftCache(cacheInput, input.diagnostics);
      if (cached) return cached;
    }
    try {
      const content = await buildLlmSectionContent({
        ...input,
        evidence: compact ? input.evidence.slice(0, 80) : input.evidence,
        projectContext: compact ? input.projectContext.slice(0, 8000) : input.projectContext,
        roleContext: compact ? input.roleContext.slice(0, 12000) : input.roleContext,
        factCoverageContext: compact ? input.factCoverageContext?.slice(0, 8000) : input.factCoverageContext,
        sectionTitle: item.title,
        targetWords: item.targetWords,
      });
      if (content && cacheInput) writeSectionDraftCache(cacheInput, content, input.diagnostics);
      return content;
    } catch (error) {
      console.warn(`[document-workflow] 小节生成失败：${input.chapter.title} / ${item.title}`, error);
      return undefined;
    }
  };
  for (let offset = 0; offset < targets.length; offset += concurrency) {
    throwIfAborted(input.signal);
    const batch = targets.slice(offset, offset + concurrency);
    const batchResults = await Promise.all(batch.map(item => runSection(item)));
    batchResults.forEach((content, index) => { results[offset + index] = content; });
  }
  const retryLimit = Math.max(0, Math.min(targets.length, Number(process.env.DOCUMENT_SECTION_RETRY_LIMIT ?? 4)));
  const missingIndexes = results.map((content, index) => content ? -1 : index).filter(index => index >= 0).slice(0, retryLimit);
  for (let offset = 0; offset < missingIndexes.length; offset += concurrency) {
    throwIfAborted(input.signal);
    const batchIndexes = missingIndexes.slice(offset, offset + concurrency);
    const batchResults = await Promise.all(batchIndexes.map(index => runSection(targets[index], true)));
    batchResults.forEach((content, index) => { if (content) results[batchIndexes[index]] = content; });
  }
  if (results.some(item => !item)) return undefined;
  return sanitizeFormalMarkdown(removeUnwantedDrawingImages(`## ${input.chapter.title}\n\n${results.filter(Boolean).join('\n\n')}`, input.forbidDrawingImages));
}

function outputTokensForChapter(minWords: number, targetWords?: number) {
  const words = targetWords || minWords;
  return Math.min(32000, Math.max(6000, Math.ceil(words * 1.6)));
}

function timeoutMsForChapter(targetWords?: number) {
  const words = targetWords || 1200;
  if (words >= 8000) return 900000;
  if (words >= 5000) return 600000;
  if (words >= 3000) return 420000;
  return 300000;
}

function expansionRoundsForDeficit(deficitChars: number) {
  if (deficitChars <= 0) return 0;
  return Math.min(3, Math.max(1, Math.ceil(deficitChars / 4000)));
}

function acceptExpandedChapter(previous: string, next: string, chapterTitle: string, targetChars: number) {
  const beforeLength = documentTextLength(previous);
  const afterLength = documentTextLength(next);
  const titleToken = displayChapterTitle(chapterTitle).slice(0, 6);
  const remaining = Math.max(0, targetChars - beforeLength);
  const minimumGrowth = Math.min(300, Math.max(80, Math.floor(remaining * 0.2)));
  if (remaining > 0 && afterLength < beforeLength + minimumGrowth) return false;
  if (afterLength < beforeLength * 0.98) return false;
  if (titleToken && !next.includes(titleToken)) return false;
  return true;
}

async function expandChapterContent(input: { template: DocumentTemplate; chapter: DocumentTemplateChapter; currentContent: string; evidence: DocumentEvidence[]; promptTexts: string; requirement?: string; roleContext: string; targetChars: number; forbidDrawingImages: boolean; maxTokens?: number; signal?: AbortSignal }) {
  const currentLength = documentTextLength(input.currentContent);
  const missing = input.targetChars - currentLength;
  if (missing <= 300) return input.currentContent;
  const evidenceText = evidenceBundlePrompt(buildEvidenceBundle(input.chapter, input.evidence));
  const expanded = await callDocumentLlm([
    '你是章节正文扩写专家。你的任务是在保持章节结构和已有内容连续性的基础上，对当前章节进行局部扩写、补充和衔接优化。',
    FORMAL_WRITING_RULES,
    '返回扩写后的完整本章 Markdown，而不是整篇文档；必须保留本章一级标题，不得新增、删除或重命名一级章节。',
    '不得删除、压缩、总结已有正文中的有效事实和已成文内容；可以在已有二级小节内部补充段落、补充三级小节、补充表格前后说明、增强段落衔接。',
    '可以对局部语句做轻微衔接性改写，但不得改变事实含义，不得减少有效字数；不得把所有新增内容堆到章末，应优先补到对应的小节或语义位置。',
    '不得输出“已满足要求”“由于资料有限”“以下是补充”等说明性话术。',
    input.promptTexts,
  ].filter(Boolean).join('\n\n'), [
    `模板：${input.template.name}`,
    `章节标题：${input.chapter.title}`,
    input.requirement ? `用户要求：${input.requirement}` : '',
    `当前本章有效字数约 ${currentLength} 字，目标约 ${input.targetChars} 字，本轮应尽量扩展到接近目标。`,
    '扩写重点：围绕尚未充分展开的对象范围、关键事实、执行要求、资源条件、风险约束、检查确认和责任闭环补充。资料没有新的精确数值时，可以扩展过程性或管理性正文，但不得编造具体数值。',
    input.roleContext,
    evidenceText ? `内部资料：\n${evidenceText}` : '',
    '当前章节 Markdown：',
    input.currentContent.slice(-24000),
  ].filter(Boolean).join('\n\n'), false, { maxTokens: input.maxTokens ?? outputTokensForChapter(currentLength, input.targetChars), temperature: 0.25, signal: input.signal });
  if (!expanded || expanded.length < 120) return input.currentContent;
  const normalized = sanitizeFormalMarkdown(removeUnwantedDrawingImages(expanded.startsWith('## ') ? expanded : `## ${input.chapter.title}\n\n${expanded}`, input.forbidDrawingImages));
  return acceptExpandedChapter(input.currentContent, normalized, input.chapter.title, input.targetChars) ? normalized : input.currentContent;
}

function mergeSectionSupplementBody(currentBody: string, replacementBody: string) {
  const current = currentBody.trim();
  const replacement = replacementBody.trim();
  if (!replacement) return '';
  if (!current) return replacement;
  if (current.includes(replacement)) return '';
  if (replacement.includes(current)) return replacement.slice(replacement.indexOf(current) + current.length).trim();
  const currentTail = current.slice(-240);
  const overlapAt = currentTail.length >= 80 ? replacement.indexOf(currentTail) : -1;
  if (overlapAt >= 0) return replacement.slice(overlapAt + currentTail.length).trim();
  return replacement;
}

function replaceSectionContent(markdown: string, sectionTitle: string, replacement: string) {
  const escaped = sectionTitle.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const pattern = new RegExp(`(^###\\s+${escaped}\\s*\\n)([\\s\\S]*?)(?=^###\\s+|$)`, 'mu');
  const normalizedReplacement = replacement.trim().replace(/^###\s+[^\n]+\n+/u, '').trim();
  if (pattern.test(markdown)) {
    return markdown.replace(pattern, (_match, heading: string, body: string) => {
      const supplement = mergeSectionSupplementBody(body, normalizedReplacement);
      return supplement ? `${heading}${body.trim()}\n\n${supplement}\n\n` : `${heading}${body.trim()}\n\n`;
    });
  }
  return normalizedReplacement ? `${markdown.trim()}\n\n### ${sectionTitle}\n\n${normalizedReplacement}` : markdown;
}

async function supplementShortSections(input: { template: DocumentTemplate; chapter: DocumentTemplateChapter; content: string; evidence: DocumentEvidence[]; missingFacts: string[]; promptTexts: string; projectContext: string; requirement?: string; roleContext: string; targetWords: number; forbidDrawingImages: boolean; factCoverageContext?: string; signal?: AbortSignal }) {
  const targets = sectionTargets(input.chapter, input.targetWords);
  if (targets.length < 2 || input.targetWords < 3000) return input.content;
  let content = input.content;
  const supplementTargets = targets.map(target => {
    const escaped = target.title.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const match = content.match(new RegExp(`^###\\s+${escaped}\\s*\\n([\\s\\S]*?)(?=^###\\s+|$)`, 'mu'));
    const currentWords = documentTextLength(match?.[1] || '');
    return { ...target, currentWords };
  }).filter(target => target.currentWords < Math.floor(target.targetWords * 0.55)).slice(0, 4);
  const supplements: Array<string | undefined> = new Array(targets.length);
  const concurrency = Math.max(1, Math.min(4, Number(process.env.DOCUMENT_SECTION_SUPPLEMENT_CONCURRENCY ?? process.env.DOCUMENT_SECTION_CONCURRENCY ?? 4)));
  for (let offset = 0; offset < supplementTargets.length; offset += concurrency) {
    const batch = supplementTargets.slice(offset, offset + concurrency);
    const batchResults = await Promise.all(batch.map(target => buildLlmSectionContent({ ...input, sectionTitle: target.title, targetWords: Math.max(700, target.targetWords - target.currentWords) })));
    batch.forEach((target, index) => { supplements[targets.findIndex(item => item.title === target.title)] = batchResults[index]; });
  }
  supplements.forEach((supplement, index) => {
    if (supplement) content = replaceSectionContent(content, targets[index].title, supplement);
  });
  return sanitizeFormalMarkdown(removeUnwantedDrawingImages(content, input.forbidDrawingImages));
}

async function expandChapterToTarget(input: { template: DocumentTemplate; chapter: DocumentTemplateChapter; content: string; evidence: DocumentEvidence[]; promptTexts: string; requirement?: string; roleContext: string; targetChars: number; forbidDrawingImages: boolean; maxTokens?: number; signal?: AbortSignal }) {
  let content = input.content;
  let rounds = 0;
  const maxRounds = expansionRoundsForDeficit(input.targetChars - documentTextLength(content));
  for (; rounds < maxRounds && documentTextLength(content) < input.targetChars; rounds += 1) {
    throwIfAborted(input.signal);
    const before = content;
    const expanded = await callWithTimeout(
      signal => expandChapterContent({
        template: input.template,
        chapter: input.chapter,
        currentContent: content,
        evidence: input.evidence,
        promptTexts: input.promptTexts,
        requirement: input.requirement,
        roleContext: input.roleContext,
        targetChars: input.targetChars,
        forbidDrawingImages: input.forbidDrawingImages,
        maxTokens: input.maxTokens,
        signal,
      }),
      timeoutMsForChapter(input.targetChars),
      input.signal,
    );
    if (!expanded || expanded === before) break;
    content = expanded;
  }
  return { content, rounds };
}

function documentBudgetStatus(budget: DocumentBudget, markdown: string) {
  const currentChars = documentTextLength(markdown);
  const estimatedPages = Math.ceil(currentChars / budget.charsPerPage);
  return { currentChars, estimatedPages };
}

async function expandDocumentToBudget(input: { template: DocumentTemplate; chapters: DocumentDraftChapter[]; budget: DocumentBudget; promptTexts: string; requirement?: string; forbidDrawingImages: boolean; signal?: AbortSignal }) {
  if (!input.budget.minChars) return input.chapters;
  let chapters = input.chapters;
  let totalChars = documentTextLength(chapters.map(chapter => chapter.content).join('\n\n'));
  const maxDocumentRounds = Math.min(2, expansionRoundsForDeficit(input.budget.minChars - totalChars));
  const concurrency = Math.max(1, Math.min(4, Number(process.env.DOCUMENT_BUDGET_EXPAND_CONCURRENCY ?? 2)));
  const lowGrowthChapterIds = new Set<string>();
  for (let round = 0; round < maxDocumentRounds && totalChars < input.budget.minChars; round += 1) {
    throwIfAborted(input.signal);
    const roundStartChars = totalChars;
    const deficits = chapters
      .map(chapter => {
        const target = input.budget.chapterTargets.get(chapter.id) || 0;
        const current = documentTextLength(chapter.content);
        return { chapter, target, current, deficit: target - current };
      })
      .filter(item => item.deficit > 500 && !lowGrowthChapterIds.has(item.chapter.id))
      .sort((a, b) => b.deficit - a.deficit);
    if (deficits.length === 0) break;
    for (let offset = 0; offset < deficits.length && totalChars < input.budget.minChars; offset += concurrency) {
      throwIfAborted(input.signal);
      const batch = deficits.slice(offset, offset + concurrency);
      const results = await Promise.all(batch.map(async item => {
        const expanded = await expandChapterToTarget({ template: input.template, chapter: { id: item.chapter.id, title: item.chapter.title, purpose: item.chapter.title, queries: [], requiredFacts: [], sections: item.chapter.sections }, content: item.chapter.content, evidence: item.chapter.evidence, promptTexts: input.promptTexts, requirement: input.requirement, roleContext: '', targetChars: item.target, forbidDrawingImages: input.forbidDrawingImages, maxTokens: outputTokensForChapter(item.current, item.target), signal: input.signal });
        return { id: item.chapter.id, beforeChars: item.current, content: expanded.content };
      }));
      for (const result of results) {
        const afterChars = documentTextLength(result.content);
        if (afterChars <= result.beforeChars + 300) lowGrowthChapterIds.add(result.id);
        chapters = chapters.map(chapter => chapter.id === result.id ? { ...chapter, content: result.content } : chapter);
      }
      totalChars = documentTextLength(chapters.map(chapter => chapter.content).join('\n\n'));
    }
    if (totalChars <= roundStartChars + 300) break;
  }
  return chapters;
}

interface ChapterReviewSummary {
  chapterId: string;
  title: string;
  status: 'pass' | 'warn' | 'fail';
  issues: string[];
  suggestions: string[];
  chars: number;
}

async function reviewChapterSummaries(input: { template: DocumentTemplate; chapters: DocumentDraftChapter[]; budget: DocumentBudget; promptTexts: string; requirement?: string; strategy: DocumentGenerationStrategy; diagnostics: DocumentGenerationDiagnostics; signal?: AbortSignal }) {
  const startedAt = Date.now();
  const concurrency = Math.max(1, Math.min(input.strategy.maxChapterReviewConcurrency, Number(process.env.DOCUMENT_CHAPTER_REVIEW_CONCURRENCY ?? input.strategy.maxChapterReviewConcurrency)));
  const summaries: ChapterReviewSummary[] = new Array(input.chapters.length);
  for (let offset = 0; offset < input.chapters.length; offset += concurrency) {
    throwIfAborted(input.signal);
    const batch = input.chapters.slice(offset, offset + concurrency);
    const results = await Promise.all(batch.map(async chapter => {
      const target = input.budget.chapterTargets.get(chapter.id) || 1200;
      const localIssues = lightweightChapterIssues({ chapter: input.template.chapters.find(item => item.id === chapter.id) || { id: chapter.id, title: chapter.title, purpose: '', queries: [], requiredFacts: [], sections: chapter.sections }, content: chapter.content, missingFacts: chapter.missingFacts, targetWords: target });
      const reviewed = await callDocumentLlm([
        '你是章节质量审查员。只输出 JSON，不重写正文。',
        '检查维度：章节是否围绕标题、必需事实是否覆盖、是否有占位符/提示词泄露、是否存在重复标题、是否缺少专业闭环、是否明显低于目标深度。',
        input.promptTexts,
      ].filter(Boolean).join('\n\n'), [
        `章节：${chapter.title}`,
        `目标深度：约 ${target} 字；当前 ${documentTextLength(chapter.content)} 字。`,
        input.requirement ? `用户要求：${input.requirement}` : '',
        chapter.missingFacts.length ? `未覆盖事实：${chapter.missingFacts.join('、')}` : '',
        localIssues.length ? `本地检查问题：${localIssues.join('；')}` : '',
        '章节正文：',
        chapter.content.slice(0, 18000),
        '请返回 JSON：{"status":"pass|warn|fail","issues":["..."],"suggestions":["..."]}',
      ].filter(Boolean).join('\n'), true, { maxTokens: 1200, temperature: 0, signal: input.signal, diagnostics: input.diagnostics });
      let parsed: { status?: string; issues?: string[]; suggestions?: string[] } | undefined;
      try { parsed = reviewed ? JSON.parse(reviewed.replace(/^```json\s*/u, '').replace(/^```\s*/u, '').replace(/```$/u, '').trim()) as typeof parsed : undefined; } catch { parsed = undefined; }
      const issues = [...localIssues, ...(Array.isArray(parsed?.issues) ? parsed!.issues!.filter(Boolean).slice(0, 6) : [])];
      const status = parsed?.status === 'fail' || localIssues.some(issue => /缺失|占位|泄露|不足/u.test(issue)) ? 'fail' : parsed?.status === 'warn' || issues.length > 0 ? 'warn' : 'pass';
      return { chapterId: chapter.id, title: chapter.title, status, issues: [...new Set(issues)].slice(0, 8), suggestions: Array.isArray(parsed?.suggestions) ? parsed!.suggestions!.filter(Boolean).slice(0, 5) : [], chars: documentTextLength(chapter.content) } as ChapterReviewSummary;
    }));
    results.forEach((summary, index) => { summaries[offset + index] = summary; });
  }
  const failCount = summaries.filter(item => item.status === 'fail').length;
  const warnCount = summaries.filter(item => item.status === 'warn').length;
  return {
    summaries,
    stage: displayStage({ type: 'llm_review' as const, roleId: 'chapter-review', status: failCount > 0 ? 'fallback' : 'success', message: elapsedMessage(`章节级质量审查完成：通过 ${summaries.length - failCount - warnCount} 章，警告 ${warnCount} 章，失败 ${failCount} 章`, startedAt) }, { subtitle: '章节级质量审查' }),
  };
}

async function reviewGlobalConsistency(input: { template: DocumentTemplate; chapters: DocumentDraftChapter[]; chapterReviews: ChapterReviewSummary[]; promptTexts: string; requirement?: string; projectContext?: string; diagnostics: DocumentGenerationDiagnostics; signal?: AbortSignal }) {
  const startedAt = Date.now();
  const outline = input.chapters.map(chapter => `- ${chapter.title}：${documentTextLength(chapter.content)} 字；审查=${input.chapterReviews.find(item => item.chapterId === chapter.id)?.status || 'unknown'}；问题=${(input.chapterReviews.find(item => item.chapterId === chapter.id)?.issues || []).slice(0, 3).join('；') || '无'}`).join('\n');
  const reviewed = await callDocumentLlm([
    '你是长文档全局一致性审查专家。只检查跨章节问题，不重写正文。',
    '重点检查：章节之间项目信息冲突、术语不一致、重复堆砌、目录层级异常、风险/质量/安全/进度闭环缺失、前后矛盾。',
    input.promptTexts,
  ].filter(Boolean).join('\n\n'), [
    `模板：${input.template.name}`,
    input.requirement ? `用户要求：${input.requirement}` : '',
    input.projectContext ? `项目上下文摘要：\n${input.projectContext.slice(0, 8000)}` : '',
    '章节审查摘要：',
    outline,
    '章节摘录：',
    input.chapters.map(chapter => `## ${chapter.title}\n${chapter.content.slice(0, 2500)}\n...\n${chapter.content.slice(-1200)}`).join('\n\n---\n\n'),
    '请只返回跨章节问题清单和建议，不要返回全文。',
  ].filter(Boolean).join('\n'), false, { maxTokens: 1800, temperature: 0, signal: input.signal, diagnostics: input.diagnostics });
  const issues = (reviewed || '').split('\n').map(line => line.replace(/^[-*\d.、\s]+/u, '').trim()).filter(line => line.length > 6).slice(0, 10);
  return {
    issues,
    stage: displayStage({ type: 'llm_review' as const, roleId: 'global-consistency-review', status: issues.length > 0 ? 'fallback' : 'success', message: elapsedMessage(issues.length > 0 ? `全局一致性审查发现 ${issues.length} 个需关注问题` : '全局一致性审查未发现明显跨章节冲突', startedAt) }, { subtitle: '全局一致性审查' }),
  };
}

/** 对生成的 Markdown 进行非重写式审查，只产出质量状态，不接管正文。 */
async function reviewAndOptimizeMarkdown(input: {
  template: DocumentTemplate;
  spec?: AutoDocumentSpecPackage;
  markdown: string;
  evidence: DocumentEvidence[];
  promptTexts: string;
  projectContext: string;
  requirement?: string;
  signal?: AbortSignal;
}): Promise<{ markdown: string; stage: DocumentExecutionStage }> {
  throwIfAborted(input.signal);
  const reviewBundle = buildEvidenceBundle({ id: 'review', title: '全文审查', purpose: '审查全文证据和资源关系', queries: [], requiredFacts: [] }, input.evidence);
  const evidenceDigest = evidenceBundlePrompt(reviewBundle);
  const specDigest = input.spec ? [
    `优化建议包：${input.spec.name}`,
    `建议关注事实：${input.spec.factFields.map(field => field.name).join('、')}`,
    `章节内容建议：${input.spec.chapterRules.map(rule => `${rule.title}${rule.minWords ? `约${rule.minWords}字` : ''}`).join('、') || '以当前模板章节为准'}`,
    `质量提醒：${input.spec.gateRules.map(rule => `${rule.name}:${rule.type}`).join('、')}`,
    '约束：以上只用于质量检查，不得新增、删除、重排或重写用户/模板章节。',
  ].join('\n') : '后台优化建议未生成。';
  const reviewed = await callDocumentLlm([
    '你是文档质量审查专家。只检查问题，不重写正文，不输出完整文档。',
    '准确性优先级：用户需求/模板结构 > 已绑定或人工确认的知识库证据 > 自动检索知识库证据 > 后台内容优化建议 > 项目上下文/历史记忆。内部优先级只用于判断事实，不得写入正文。',
    '重点检查：章节完整性、资料事实内化使用、参数数字准确性、冲突事实、解析器内部对象名、表格呈现、表达专业性、导出友好性、系统提示泄露。',
    '只返回简短审查结论和问题清单；不得返回优化后的完整 Markdown。',
    input.promptTexts,
  ].filter(Boolean).join('\n\n'), [
    `模板：${input.template.name}`,
    input.requirement ? `用户要求：${input.requirement}` : '',
    input.projectContext ? `项目上下文/历史记忆：\n${input.projectContext}` : '',
    specDigest,
    '知识库证据摘要：',
    evidenceDigest,
    '待审查初稿：',
    input.markdown.slice(0, 24000),
    '请只返回审查问题清单，不要返回全文。',
  ].filter(Boolean).join('\n'), false, { maxTokens: 2000, temperature: 0, signal: input.signal });
  throwIfAborted(input.signal);
  return {
    markdown: input.markdown,
    stage: {
      type: 'llm_review',
      roleId: 'llm-review',
      status: reviewed ? 'success' : 'skipped',
      message: reviewed ? `已完成非重写式质量审查：${reviewed.slice(0, 180)}` : '无可用模型或审查结果不可用，保留生成初稿',
    },
  };
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

function upsertProgressStage(stages: DocumentExecutionStage[], stage: DocumentExecutionStage): number {
  const index = stages.findIndex(item => item.type === stage.type && item.roleId === stage.roleId && item.promptId === stage.promptId);
  if (index >= 0) {
    stages[index] = { ...stage, order: stages[index]?.order ?? stage.order };
    return index;
  }
  stages.push(stage);
  return stages.length - 1;
}

function elapsedMessage(message: string, startedAt: number) {
  return `${message}，耗时 ${Math.round((Date.now() - startedAt) / 1000)} 秒`;
}

/** 文档生成主入口：依次执行角色绑定、知识检索、文件理解、事实抽取、章节生成、封面生成、LLM 审查和导出校验，返回完整文档草稿 */
export async function generateDocumentDraft(input: { templateId: string; requirement?: string; maxEvidencePerChapter?: number; projectRoot?: string; resumeChapters?: DocumentDraftChapter[]; signal?: AbortSignal; onProgress?: (stages: DocumentExecutionStage[]) => void }): Promise<GeneratedDocumentDraft> {
  throwIfAborted(input.signal);
  const baseTemplate = getDocumentTemplate(input.templateId);
  if (!baseTemplate) throw new Error('Document template not found');
  const projectRoot = path.resolve(input.projectRoot || getProjectRoot());
  if (!projectRoot) throw new Error('No knowledge base project found');
  const projectId = computeProjectId(projectRoot);
  let template = baseTemplate;
  const manager = getMultiProjectManager();
  const maxEvidence = Math.max(5, Math.min(30, input.maxEvidencePerChapter ?? 12));
  const projectRoleConfigId = defaultProjectRoleConfigIdForTemplate(template) || 'none';
  const projectRoleConfigName = getProjectRoleConfig(projectRoleConfigId)?.name || projectRoleConfigId;
  const progressStages: DocumentExecutionStage[] = [displayStage({ type: 'role_binding', roleId: projectRoleConfigId, status: 'running', message: `生成任务已创建，正在读取模板与角色配置：${template.name}；当前项目 ${projectId}；资料目录 ${path.join(projectRoot, 'knowledgeBase')}` }, { subtitle: projectRoleConfigName, roleName: projectRoleConfigName, order: 0 })];
  input.onProgress?.([...progressStages]);
  const promptBindings = templatePromptBindings(template);
  const explicitFileBindings = templateFileBindings(template);
  upsertProgressStage(progressStages, displayStage({ type: 'validation', roleId: 'document-preparation', status: 'running', message: '正在分析模板规范、用户要求与项目资料摘要' }, { subtitle: '生成准备', order: progressStages.length }));
  input.onProgress?.([...progressStages]);
  if (explicitFileBindings.length === 0) throw new Error('模板未绑定知识库文件。模板生成文件只允许使用显式绑定的知识库文件，请先在模板中绑定需要参与生成的资料。');
  const promptOutlineTexts = promptOutlineTextsForExecution(promptBindings);
  const explicitPromptChapters = extractExplicitOutlineFromSources([
    { text: input.requirement, source: '用户需求' },
    { text: promptOutlineTexts, source: '提示词角色', strict: true },
  ]);
  const hasExplicitOutline = explicitPromptChapters.length >= 2;
  if (hasExplicitOutline) {
    template = { ...baseTemplate, chapters: explicitPromptChapters };
  }
  const projectMaterialSummary = buildProjectMaterialSummary(projectRoot, { requirement: input.requirement, boundFilePaths: explicitFileBindings.map(binding => binding.filePath), boundFileRoles: boundFileRolesForMaterialSummary(explicitFileBindings) });
  const fileBindings = explicitFileBindings;
  const autoSpec = getOrCreateAutoDocumentSpec(template, input.requirement || '');
  const documentSpec = autoSpec.spec;
  const resolvedMaterialRoles = resolveTemplateMaterialRoles(template, projectMaterialSummary);
  const readiness = evaluateDocumentReadiness({ template, spec: documentSpec, summary: projectMaterialSummary, resolvedRoles: resolvedMaterialRoles });
  if (!readiness.ready) throw new Error(`生成准备度不足：${readiness.blockingIssues.join('；')}`);
  const backgroundControlPrompt = [projectMaterialPrompt(projectMaterialSummary), autoSpecPrompt(documentSpec, autoSpec.sourceHash), readinessPrompt(readiness)].filter(Boolean).join('\n\n');
  const promptTexts = [backgroundControlPrompt, `模板配置章节结构：\n${configuredStructurePrompt(template)}`, promptTextsForExecution(promptBindings, ['chapter_generation', 'formatting', 'reference'])].filter(Boolean).join('\n\n');
  const promptIntent = analyzePromptIntent([promptTexts, input.requirement || ''].filter(Boolean).join('\n\n'));
  const factExtractionPromptTexts = [backgroundControlPrompt, promptTextsForExecution(promptBindings, ['fact_extraction', 'reference'])].filter(Boolean).join('\n\n');
  const reviewPromptTexts = [backgroundControlPrompt, promptTextsForExecution(promptBindings, ['validation', 'llm_review', 'formatting', 'reference'])].filter(Boolean).join('\n\n');
  upsertProgressStage(progressStages, displayStage({ type: 'validation', roleId: 'document-preparation', status: 'success', message: `模板规范与资料摘要分析完成，识别 ${fileBindings.length} 条文件角色绑定` }, { subtitle: '生成准备', order: progressStages.length }));
  input.onProgress?.([...progressStages]);
  const evidenceScopePaths = buildBoundEvidenceScope(projectRoot, fileBindings);
  const allFileRoles = listDocumentRoles('file');
  const fileRoleByPath = new Map(fileBindings.flatMap(binding => fileScopeKeys(projectRoot, binding.filePath).map(key => [key, binding.roleId] as const)));
  const fileProcessingByPath = new Map(fileBindings.flatMap(binding => fileScopeKeys(projectRoot, binding.filePath).map(key => [key, allFileRoles.find(role => role.id === binding.roleId)?.processingType || 'reference'] as const)));
  upsertProgressStage(progressStages, displayStage({ type: 'knowledge_retrieval', roleId: 'knowledge-index', status: 'running', message: '正在检查知识库增量索引状态' }, { subtitle: '知识库索引', order: progressStages.length }));
  input.onProgress?.([...progressStages]);
  const project = await manager.getProject(projectRoot);
  await project.incrementalIndex();
  upsertProgressStage(progressStages, displayStage({ type: 'knowledge_retrieval', roleId: 'knowledge-index', status: 'success', message: '知识库增量索引检查完成，开始构建角色资料证据池' }, { subtitle: '知识库索引', order: progressStages.length }));
  input.onProgress?.([...progressStages]);
  throwIfAborted(input.signal);
  const chapterDrafts: DocumentDraftChapter[] = [];
  const technicalFactAssignments: TechnicalFactAssignment[] = [];
  const allEvidence: DocumentEvidence[] = [];
  const missingItems: string[] = [];
  const failedChapterMessages: string[] = [];
  const chapterGenerationStages: DocumentExecutionStage[] = [];
  let knowledgeBaseStageIndex = -1;
  const roleNodes = buildRoleExecutionNodes(template, promptBindings, fileBindings);
  const roleEvidencePool = buildRoleEvidencePool(project, roleNodes, projectRoot);
  const rolePoolStage = displayStage({ type: 'file_understanding', roleId: 'role-evidence-pool', status: 'success', message: `已构建共享资料证据池：唯一文件 ${roleEvidencePool.uniqueFileCount} 份，角色绑定 ${roleEvidencePool.bindingCount} 条，复用 ${Math.max(0, roleEvidencePool.bindingCount - roleEvidencePool.uniqueFileCount)} 条；${roleEvidencePool.fallbackFileCount} 份使用文件级兜底证据` }, { subtitle: '共享资料池', order: progressStages.length });
  upsertProgressStage(progressStages, rolePoolStage);
  input.onProgress?.([...progressStages]);
  const roleArtifacts: RoleNodeArtifact[] = [];
  const projectEvidenceVersion = projectEvidenceVersionHash(project, projectRoot, evidenceScopePaths);
  const activeModelName = getActiveModelWithProvider()?.model.name;
  const roleCachePromptTexts = promptTextsForExecution(promptBindings, ['fact_extraction', 'reference', 'chapter_generation']);
  const fileRolesHash = stableHash({
    fileBindings,
    evidenceScopePaths: [...evidenceScopePaths].sort(),
    activeModelName,
    projectEvidenceVersion,
    promptTexts: roleCachePromptTexts,
    materialFingerprint: projectMaterialSummary.fingerprint,
    materialInventory: Object.fromEntries(Object.entries(projectMaterialSummary.materialInventory).map(([role, files]) => [role, files.map(file => ({ filePath: file.filePath, chunkCount: file.chunkCount }))])),
  });
  const roleConcurrency = Math.max(1, Math.min(3, Number(process.env.DOCUMENT_ROLE_CONCURRENCY ?? 3)));
  for (let offset = 0; offset < roleNodes.length; offset += roleConcurrency) {
    throwIfAborted(input.signal);
    const batch = roleNodes.slice(offset, offset + roleConcurrency);
    const batchJobs = batch.map(async node => {
      const nodeStartedAt = Date.now();
      const nodeEvidence = evidenceForRoleFiles(roleEvidencePool, node, projectRoot).filter(item => evidenceInScope(projectRoot, item.filePath, evidenceScopePaths));
      const runningStageIndex = progressStages.length;
      const runningStage = displayStage({ type: 'file_understanding', roleId: node.fileRoleId, promptId: node.promptRoleIds[0], status: 'running', message: `${node.fileRoleName} 正在复用共享资料池读取 ${node.filePaths.length} 条绑定，候选证据 ${nodeEvidence.length} 条` }, { subtitle: node.fileRoleName, roleName: node.fileRoleName, promptName: node.promptRoleNames.join('、') || undefined, order: runningStageIndex });
      progressStages.push(runningStage);
      input.onProgress?.([...progressStages]);
      const { artifact, cached } = await executeRoleExtractionNodeCached({ template, node, evidence: nodeEvidence, promptTexts: roleCachePromptTexts, projectRoot, modelName: activeModelName, signal: input.signal });
      const completedStage = displayStage({ type: 'file_understanding', roleId: node.fileRoleId, promptId: node.promptRoleIds[0], status: nodeEvidence.length > 0 ? 'success' : 'fallback', message: elapsedMessage(`${node.fileRoleName} 节点已${cached ? '复用缓存' : '完成'}，产出章节建议 ${artifact.chapters.length} 个、事实 ${artifact.facts.length} 条`, nodeStartedAt) }, { subtitle: node.fileRoleName, roleName: node.fileRoleName, promptName: node.promptRoleNames.join('、') || undefined, order: runningStageIndex });
      progressStages[runningStageIndex] = completedStage;
      input.onProgress?.([...progressStages]);
      return { artifact, evidence: nodeEvidence };
    });
    const batchResults = await Promise.all(batchJobs);
    for (const item of batchResults) {
      allEvidence.push(...item.evidence);
      roleArtifacts.push(item.artifact);
    }
  }
  const tenderPlan = tenderPlanChaptersFromArtifacts(template, roleArtifacts);
  const effectiveChapters = effectiveTemplateChapters(template, documentSpec, { preserveExplicitOutline: hasExplicitOutline });
  const contextQuery = [template.name, template.outputTitle, input.requirement, ...effectiveChapters.flatMap(chapter => [chapter.title, chapter.purpose])].filter(Boolean).join(' ');
  const projectContextEntries = recallDocumentContexts(contextQuery, 8, projectRoot);
  const projectBasicFacts = extractProjectBasicFacts(roleArtifacts.flatMap(artifact => artifact.evidence));
  const projectContext = [formatContextEntries(projectContextEntries), roleArtifactsDigest(roleArtifacts, projectBasicFacts)].filter(Boolean).join('\n\n').slice(0, 24000);
  const documentBudget = buildDocumentBudget({ requirement: input.requirement, promptTexts, template, chapters: effectiveChapters, spec: documentSpec });
  const resumeChapterById = new Map((input.resumeChapters || [])
    .filter(chapter => chapter.id && chapter.content?.trim())
    .map(chapter => [chapter.id, chapter] as const));
  const generationStrategy = selectDocumentGenerationStrategy({ template, targetWords: documentBudget.targetChars || [...documentBudget.chapterTargets.values()].reduce((sum, value) => sum + value, 0), requirement: input.requirement });
  adaptiveDocumentLlmLimit = Math.min(adaptiveDocumentLlmLimit, generationStrategy.targetLlmConcurrency);
  const generationDiagnostics = createGenerationDiagnostics(generationStrategy);
  pruneChapterDraftCache(generationDiagnostics);
  upsertProgressStage(progressStages, displayStage({ type: 'validation', roleId: 'document-strategy', status: 'success', message: `已自动选择 ${generationStrategy.mode} 生成策略：章节缓存 ${generationStrategy.enableChapterCache ? '启用' : '跳过'}、章节审查 ${generationStrategy.enableChapterReview ? '启用' : '跳过'}、全局审查 ${generationStrategy.enableGlobalReview ? '启用' : '跳过'}；LLM 并发上限 ${generationStrategy.targetLlmConcurrency}` }, { subtitle: '后台自动策略' }));
  const contextStage: DocumentExecutionStage = displayStage({
    type: 'context_recall',
    roleId: 'project-memory',
    status: projectContextEntries.length > 0 ? 'success' : 'skipped',
    message: projectContextEntries.length > 0 ? `已注入 ${projectContextEntries.length} 条短期/长期上下文` : '未召回可用项目上下文',
  }, { subtitle: '项目记忆' });

  // 第一个进度回调：角色绑定完成
  const outlineMessage = hasExplicitOutline ? `；识别到 OUTLINE 章节 ${explicitPromptChapters.length} 个` : '；未识别到有效 OUTLINE，将使用模板章节';
  upsertProgressStage(progressStages, displayStage({ type: 'role_binding', roleId: projectRoleConfigId, status: 'success', message: `已绑定 ${fileBindings.length} 个文件角色、${promptBindings.length} 个提示词角色；后台优化建议关注 ${documentSpec.factFields.length} 个事实字段；资料覆盖率 ${Math.round(readiness.materialCoverageRate * 100)}%${outlineMessage}` }, { subtitle: projectRoleConfigName, roleName: projectRoleConfigName }));
  upsertProgressStage(progressStages, displayStage({ type: 'validation', roleId: 'document-readiness', status: readiness.ready ? 'success' : 'failed', message: `生成准备度：资料 ${Math.round(readiness.materialCoverageRate * 100)}%，资料角色 ${Math.round(readiness.roleSatisfactionRate * 100)}%，优化建议 ${Math.round(readiness.specCompletenessRate * 100)}%；${projectMaterialSummary.source.selectionReason}` }, { subtitle: '生成准备度检查' }));
  upsertProgressStage(progressStages, contextStage);
  input.onProgress?.([...progressStages]);

  const chapterConcurrency = Math.max(1, Math.min(4, Number(process.env.DOCUMENT_CHAPTER_CONCURRENCY ?? 4)));
  for (let chapterOffset = 0; chapterOffset < effectiveChapters.length; chapterOffset += chapterConcurrency) {
    const chapterBatch = effectiveChapters.slice(chapterOffset, chapterOffset + chapterConcurrency);
    await Promise.all(chapterBatch.map(async (chapter, batchIndex) => {
    const chapterOrder = chapterOffset + batchIndex;
    throwIfAborted(input.signal);
    try {
    const chapterStartedAt = Date.now();
    const rawEvidence: DocumentEvidence[] = [];
    const plan = chapterPlanFor(chapter, tenderPlan);
    const planQueries = plan ? [plan.title, ...plan.requiredContents, ...plan.evidenceNeeds, ...plan.requirements.flatMap(item => [item.title, item.requirementText, ...item.requiredContents, ...item.evidenceNeeds])].filter(Boolean) : [];
    const baseQueries = chapter.queries.length > 0 ? chapter.queries : [template.name, template.outputTitle, chapter.title];
    const queries = [...new Set([...baseQueries, ...planQueries])].filter(Boolean).slice(0, 4);
    const searchResults = await Promise.all(queries.map(query => cachedChapterSearch({ manager, projectRoot, query, evidenceScopePaths, maxEvidence, fileRolesHash })));
    for (const results of searchResults) {
      rawEvidence.push(...results
        .filter((item: KbSearchResult) => evidenceInScope(projectRoot, item.filePath, evidenceScopePaths))
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
    rawEvidence.push(...matchedRoleContexts.flatMap(({ artifact }) => artifact.evidence
      .filter(item => evidenceInScope(projectRoot, item.filePath, evidenceScopePaths))
      .slice(0, 8)
      .map(item => ({ ...item, chapterId: chapter.id, source: 'role-node' }))));
    const chapterPinnedPaths = new Set([...pinnedEvidencePaths]);
    for (const relativePath of chapterPinnedPaths) {
      if (!evidenceInScope(projectRoot, relativePath, evidenceScopePaths)) continue;
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
    const scopedEvidence = rawEvidence.filter(item => evidenceInScope(projectRoot, item.filePath, evidenceScopePaths));
    const evidence = uniqueEvidence(scopedEvidence, maxEvidence, generationDiagnostics);
    const technicalFactEvidence = uniqueEvidence(scopedEvidence, 120, generationDiagnostics);
    allEvidence.push(...evidence);
    const technicalFacts = extractEngineeringTechnicalFacts(technicalFactEvidence, 160);
    const technicalFactAssignment = assignTechnicalFactsToChapter(chapter, technicalFacts);
    technicalFactAssignments.push(technicalFactAssignment);
    const technicalFactContext = technicalFactsPrompt(technicalFactAssignment);
    const coverageMatrixContext = engineeringCoverageMatrixPrompt(technicalFactAssignment);
    const missingFacts = chapter.requiredFacts.filter(fact => !evidence.some(item => evidenceMatchesFact(item, fact)));
    if (evidence.length === 0) missingItems.push(`${chapter.title}：未检索到明确资料依据`);
    for (const fact of missingFacts) missingItems.push(`${chapter.title}：${fact} 未检索到明确依据`);
    // 证据检索完成 → 持续刷新证据数量
    const knowledgeBaseStage = displayStage({ type: 'knowledge_retrieval', roleId: 'knowledge-base', status: (allEvidence.length > 0 ? 'success' : 'fallback'), message: `已检索/绑定 ${allEvidence.length} 条证据` });
    if (knowledgeBaseStageIndex < 0) {
      knowledgeBaseStageIndex = upsertProgressStage(progressStages, knowledgeBaseStage);
    } else {
      progressStages[knowledgeBaseStageIndex] = { ...knowledgeBaseStage, order: progressStages[knowledgeBaseStageIndex]?.order ?? knowledgeBaseStage.order };
    }
    input.onProgress?.([...progressStages]);

    throwIfAborted(input.signal);
    const forbidDrawingImages = shouldForbidDrawingImages(roleArtifacts, template);
    const roleContext = buildRoleChapterContext(roleArtifacts, chapter, plan);
    const scopedProjectBasicFacts = projectBasicFacts.filter(fact => evidenceInScope(projectRoot, fact.sourceFile, evidenceScopePaths));
    const projectBasicFactContext = projectBasicFactsPrompt(scopedProjectBasicFacts, chapter, promptIntent);
    const factCoverageContext = buildChapterFactCoverageContext({ chapter, plan, spec: documentSpec, roleFacts: matchedRoleContexts, technicalFactAssignment, projectBasicFacts: scopedProjectBasicFacts, evidence, missingFacts });
    const specChapterRule = documentSpec?.chapterRules.find(rule => rule.id === chapter.id || rule.title === chapter.title);
    const budgetTarget = documentBudget.chapterTargets.get(chapter.id) || 1200;
    const minWords = Math.max(plan?.minWords || 0, specChapterRule?.minWords || 0, documentSpec?.dynamicChapterRule.minWordsPerChapter || 0, Math.floor(budgetTarget * 0.82), 1200);
    const targetWords = budgetTarget;
    const resumedChapter = resumeChapterById.get(chapter.id);
    if (resumedChapter) {
      const resumedIssues = lightweightChapterIssues({ chapter, content: resumedChapter.content, missingFacts, targetWords });
      if (blockingChapterCacheIssues(resumedIssues).length === 0) {
        const chapterChars = documentTextLength(resumedChapter.content);
        const reusableChapter: DocumentDraftChapter = { ...resumedChapter, title: chapter.title, evidence: resumedChapter.evidence?.length ? resumedChapter.evidence : evidence, missingFacts, sections: resumedChapter.sections?.length ? resumedChapter.sections : (chapter.sections || extractGeneratedSections(resumedChapter.content)) };
        chapterDrafts.push(reusableChapter);
        generationDiagnostics.cache.chapterHits += 1;
        generationDiagnostics.quality.reusedChapterCount += 1;
        chapterGenerationStages.push(displayStage({
          type: 'chapter_generation',
          roleId: 'chapter_generation',
          promptId: promptBindings.find(binding => binding.roleId === 'chapter_generation')?.promptId,
          status: 'success',
          message: elapsedMessage(`${displayChapterTitle(chapter.title)} 已复用上次完成章节：当前 ${chapterChars} 字 / 目标 ${Math.floor(targetWords * 0.95)} 字`, chapterStartedAt),
        }, { subtitle: displayChapterTitle(chapter.title), order: chapterOrder }));
        progressStages.push(chapterGenerationStages[chapterGenerationStages.length - 1]!);
        input.onProgress?.([...progressStages]);
        return;
      }
      generationDiagnostics.cache.rejectedHits += 1;
    }
    const chapterCacheInput = { template, chapter, evidence, missingFacts, promptTexts, requirement: input.requirement, projectRoot, modelName: activeModelName, targetWords, fileRolesHash };
    const cachedChapter = generationStrategy.enableChapterCache ? readChapterDraftCache(chapterCacheInput, generationDiagnostics) : undefined;
    if (cachedChapter) {
      const chapterChars = documentTextLength(cachedChapter.content);
      chapterGenerationStages.push(displayStage({
        type: 'chapter_generation',
        roleId: 'chapter_generation',
        promptId: promptBindings.find(binding => binding.roleId === 'chapter_generation')?.promptId,
        status: 'success',
        message: elapsedMessage(`${displayChapterTitle(chapter.title)} 已复用章节缓存：当前 ${chapterChars} 字 / 目标 ${Math.floor(targetWords * 0.95)} 字`, chapterStartedAt),
      }, { subtitle: displayChapterTitle(chapter.title), order: chapterOrder }));
      chapterDrafts.push(cachedChapter);
      progressStages.push(chapterGenerationStages[chapterGenerationStages.length - 1]!);
      input.onProgress?.([...progressStages]);
      return;
    }
    const generationMaxTokens = outputTokensForChapter(minWords, targetWords);
    let llmContent = await measureGenerationStep(generationDiagnostics, `chapter-draft:${chapter.id}`, () => callWithTimeout(
      signal => buildSectionParallelChapterContent({ template, chapter, evidence, missingFacts, promptTexts, projectContext, requirement: input.requirement, roleContext, targetWords, forbidDrawingImages, factCoverageContext, projectRoot, modelName: activeModelName, fileRolesHash, diagnostics: generationDiagnostics, signal }),
      timeoutMsForChapter(targetWords),
      input.signal,
    ));
    if (!llmContent) {
      llmContent = await measureGenerationStep(generationDiagnostics, `chapter-draft-fallback:${chapter.id}`, () => callWithTimeout(
        signal => buildLlmChapterContent(template, chapter, evidence, missingFacts, promptTexts, projectContext, input.requirement, roleContext, { forbidDrawingImages, minWords, targetWords, maxTokens: generationMaxTokens, technicalFactContext, coverageMatrixContext, projectBasicFactContext, factCoverageContext, signal }),
        timeoutMsForChapter(targetWords),
        input.signal,
      ));
    }
    throwIfAborted(input.signal);
    if (!llmContent) {
      const compactEvidence = evidence.slice(0, 80);
      const compactRoleContext = roleContext.slice(0, 12000);
      llmContent = await measureGenerationStep(generationDiagnostics, `chapter-draft-compact-fallback:${chapter.id}`, () => callWithTimeout(
        signal => buildLlmChapterContent(template, chapter, compactEvidence, missingFacts, promptTexts, projectContext, input.requirement, compactRoleContext, { forbidDrawingImages, minWords: Math.max(900, Math.floor(minWords * 0.75)), targetWords, maxTokens: generationMaxTokens, technicalFactContext: technicalFactContext.slice(0, 12000), coverageMatrixContext: coverageMatrixContext.slice(0, 8000), projectBasicFactContext: projectBasicFactContext.slice(0, 8000), factCoverageContext: factCoverageContext.slice(0, 10000), signal }),
        timeoutMsForChapter(targetWords),
        input.signal,
      ));
    }
    throwIfAborted(input.signal);
    if (!llmContent) throw new Error(`${chapter.title} 大模型未返回有效章节正文`);
    const initialChapterContent = llmContent;
    llmContent = await measureGenerationStep(generationDiagnostics, `chapter-supplement:${chapter.id}`, () =>
      supplementShortSections({ template, chapter, content: initialChapterContent, evidence, missingFacts, promptTexts, projectContext, requirement: input.requirement, roleContext, targetWords, forbidDrawingImages, factCoverageContext, signal: input.signal })
    );
    const localIssues = lightweightChapterIssues({ chapter, content: llmContent, missingFacts, targetWords });
    const localSeverity = qualitySeveritySummary(localIssues);
    generationDiagnostics.quality.blockingCount += localSeverity.blocking;
    generationDiagnostics.quality.importantCount += localSeverity.important;
    generationDiagnostics.quality.minorCount += localSeverity.minor;
    const blockingIssues = blockingChapterCacheIssues(localIssues);
    if (blockingIssues.length > 0) {
      const contentBeforeRepair = llmContent;
      llmContent = await measureGenerationStep(generationDiagnostics, `chapter-repair:${chapter.id}`, () =>
        repairChapterByQuality({ template, chapter: { id: chapter.id, title: chapter.title, content: contentBeforeRepair, evidence, missingFacts, sections: chapter.sections || [] }, issues: blockingIssues.slice(0, 3), promptTexts, requirement: input.requirement, forbidDrawingImages, signal: input.signal })
      );
      generationDiagnostics.quality.repairedCount += 1;
      throwIfAborted(input.signal);
    }
    const expandedChapter = await measureGenerationStep(generationDiagnostics, `chapter-expand:${chapter.id}`, () =>
      expandChapterToTarget({ template, chapter, content: llmContent, evidence, promptTexts, requirement: input.requirement, roleContext, targetChars: Math.floor(targetWords * 0.95), forbidDrawingImages, maxTokens: generationMaxTokens, signal: input.signal })
    );
    const content = expandedChapter.content;
    const chapterChars = documentTextLength(content);
    const sections = chapter.sections?.length ? chapter.sections : extractGeneratedSections(content);
    chapterGenerationStages.push(displayStage({
      type: 'chapter_generation',
      roleId: 'chapter_generation',
      promptId: promptBindings.find(binding => binding.roleId === 'chapter_generation')?.promptId,
      status: 'success',
      message: elapsedMessage(`${displayChapterTitle(chapter.title)} 已由大模型生成${expandedChapter.rounds > 0 ? `并扩写 ${expandedChapter.rounds} 轮` : ''}：当前 ${chapterChars} 字 / 目标 ${Math.floor(targetWords * 0.95)} 字`, chapterStartedAt),
    }, { subtitle: displayChapterTitle(chapter.title), order: chapterOrder }));
    const draftChapter = { id: chapter.id, title: chapter.title, content, evidence, missingFacts, sections };
    chapterDrafts.push(draftChapter);
    const finalIssues = lightweightChapterIssues({ chapter, content, missingFacts, targetWords });
    const finalSeverity = qualitySeveritySummary(finalIssues);
    generationDiagnostics.quality.blockingCount += finalSeverity.blocking;
    generationDiagnostics.quality.importantCount += finalSeverity.important;
    generationDiagnostics.quality.minorCount += finalSeverity.minor;
    if (generationStrategy.enableChapterCache && blockingChapterCacheIssues(finalIssues).length === 0) writeChapterDraftCache(chapterCacheInput, draftChapter, generationDiagnostics);
    } catch (err) {
      if (input.signal?.aborted) throw err;
      console.error(`[gen] chapter ${chapter.title} failed:`, err);
      failedChapterMessages.push(`${chapter.title}：${err instanceof Error ? err.message : '生成失败'}`);
      chapterGenerationStages.push(displayStage({
        type: 'chapter_generation',
        roleId: 'chapter_generation',
        status: 'failed',
        message: `${displayChapterTitle(chapter.title)} 生成失败`,
      }, { subtitle: displayChapterTitle(chapter.title), order: chapterOrder }));
    }
    // 章节生成完成（成功或失败）→ 汇报进度
    if (!progressStages.some(s => s.type === 'chapter_generation' && s.message === chapterGenerationStages[chapterGenerationStages.length - 1]?.message)) {
      progressStages.push(chapterGenerationStages[chapterGenerationStages.length - 1]!);
    }
    input.onProgress?.([...progressStages]);
    }));
  }
  chapterDrafts.sort((a, b) => effectiveChapters.findIndex(chapter => chapter.id === a.id) - effectiveChapters.findIndex(chapter => chapter.id === b.id));
  technicalFactAssignments.sort((a, b) => effectiveChapters.findIndex(chapter => chapter.id === a.chapterId) - effectiveChapters.findIndex(chapter => chapter.id === b.chapterId));

  if (chapterDrafts.length === 0) {
    throw new Error(`章节生成未完成：${failedChapterMessages.slice(0, 6).join('；') || '没有生成任何有效章节'}`);
  }
  if (hasExplicitOutline && chapterDrafts.length < effectiveChapters.length) {
    throw new Error(`OUTLINE 指定 ${effectiveChapters.length} 章，实际只生成 ${chapterDrafts.length} 章：${failedChapterMessages.slice(0, 6).join('；') || '部分章节未生成'}`);
  }

  throwIfAborted(input.signal);
  let fileUnderstanding: { stage: DocumentExecutionStage; notes: string[] } = { stage: { type: 'file_understanding', roleId: 'multimodal-files', status: 'skipped', message: '文件理解跳过' }, notes: [] };
  try { fileUnderstanding = await understandReferenceFiles(projectRoot, allEvidence, input.signal); } catch (err) { if (input.signal?.aborted) throw err; console.error('[gen] fileUnderstanding failed:', err); }
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
  const roleStructuredFacts: DocumentFact[] = roleArtifacts.flatMap(artifact => artifact.facts.map(fact => ({ key: fact.key, value: stringifyFactValue(fact.value), sourceFile: fact.sourceFile, roleId: fact.roleId, confidence: 0.9 })));
  const projectBasicStructuredFacts: DocumentFact[] = projectBasicFacts.map((fact: ProjectBasicFact) => ({ key: fact.key, value: fact.value, sourceFile: fact.sourceFile, roleId: 'project_basic_fact', confidence: 0.85 }));
  const preLlmFacts = [...projectBasicStructuredFacts, ...roleStructuredFacts, ...localFacts];
  let llmExtraction: { facts: DocumentFact[]; stages: DocumentExecutionStage[] } = { facts: [], stages: [{ type: 'fact_extraction', roleId: 'llm-json', status: 'skipped', message: '已有本地/角色事实覆盖主要必需字段，跳过 LLM 全量事实抽取' }] };
  if (shouldRunLlmFactExtraction(preLlmFacts, template, documentSpec)) {
    try { llmExtraction = await extractFactsWithLlm(allEvidence, factExtractionPromptTexts, template, documentSpec, input.signal); } catch (err) { if (input.signal?.aborted) throw err; console.error('[gen] fact extraction failed:', err); }
  }
  throwIfAborted(input.signal);
  const structuredFacts = [...projectBasicStructuredFacts, ...roleStructuredFacts, ...localFacts, ...llmExtraction.facts];

  // 进度回调：文件理解 + 事实抽取完成
  upsertProgressStage(progressStages, fileUnderstanding.stage);
  for (const stage of llmExtraction.stages) {
    upsertProgressStage(progressStages, stage);
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
  const forbidDrawingImages = shouldForbidDrawingImages(roleArtifacts, template);
  const budgetStartedAt = Date.now();
  const budgetBeforeChars = documentTextLength(chapterDrafts.map(chapter => chapter.content).join('\n\n'));
  const budgetExpandedChapters = await expandDocumentToBudget({ template, chapters: chapterDrafts, budget: documentBudget, promptTexts, requirement: input.requirement, forbidDrawingImages, signal: input.signal });
  chapterDrafts.splice(0, chapterDrafts.length, ...budgetExpandedChapters);
  const budgetDraftMarkdown = chapterDrafts.map(chapter => chapter.content).join('\n\n');
  const budgetStatus = documentBudgetStatus(documentBudget, budgetDraftMarkdown);
  const budgetTargetText = [
    documentBudget.targetChars ? `目标 ${documentBudget.targetChars} 字` : undefined,
    documentBudget.targetPages ? `目标 ${documentBudget.targetPages} 页` : undefined,
  ].filter(Boolean).join(' / ') || '默认章节深度';
  const budgetStage = displayStage({ type: 'validation', roleId: 'document-budget', status: documentBudget.minChars && budgetStatus.currentChars < documentBudget.minChars ? 'fallback' : 'success', message: elapsedMessage(`文档预算：当前 ${budgetStatus.currentChars} 字，新增 ${Math.max(0, budgetStatus.currentChars - budgetBeforeChars)} 字，预计 ${budgetStatus.estimatedPages} 页；${budgetTargetText}`, budgetStartedAt) }, { subtitle: '文档预算' });
  progressStages.push(budgetStage);
  input.onProgress?.([...progressStages]);
  const fallbackChapterCount = chapterGenerationStages.filter(stage => stage.type === 'chapter_generation' && stage.status === 'fallback').length;
  const failedChapterCount = chapterGenerationStages.filter(stage => stage.type === 'chapter_generation' && stage.status === 'failed').length;
  if (fallbackChapterCount > 0) validationIssues.push({ level: 'error', message: `章节生成存在兜底：${fallbackChapterCount} 章`, suggestion: '请检查模型调用、提示词长度或证据负载后重新生成。' });
  if (failedChapterCount > 0) validationIssues.push({ level: 'warning', message: `部分章节生成失败：${failedChapterCount} 章`, suggestion: failedChapterMessages.slice(0, 6).join('；') || '请检查模型调用或资料配置后重新生成失败章节。' });
  const initialBlockingCount = validationIssues.filter(issue => issue.level === 'error' && isExportBlockingIssue(issue)).length;
  const assets: DocumentAsset[] = [];
  const executionStages: DocumentExecutionStage[] = [...progressStages];
  upsertProgressStage(executionStages, displayStage({ type: 'validation', roleId: 'document-workflow', status: initialBlockingCount > 0 ? 'failed' : 'success', message: `阻断 ${initialBlockingCount}，错误 ${validation.errors.length}，警告 ${validation.warnings.length}` }, { subtitle: '最终规范校验' }));
  upsertProgressStage(executionStages, displayStage({ type: 'formatting', roleId: 'document-workflow', status: 'success', message: '已生成正式排版 Markdown' }));
  upsertProgressStage(executionStages, displayStage({ type: 'export_ready', roleId: 'document-workflow', status: initialBlockingCount > 0 ? 'fallback' : 'success', message: initialBlockingCount > 0 ? '导出存在风险项，仍可导出，请人工复核' : '已准备好导出 Markdown/HTML/DOCX/PDF' }));
  const base = {
    templateId: template.id,
    templateName: template.name,
    title: template.outputTitle,
    requirement: input.requirement || '',
    projectRoot,
    projectId,
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
    partialChapters: chapterDrafts.map(chapter => ({ id: chapter.id, title: chapter.title, chars: documentTextLength(chapter.content), status: 'completed' as const, updatedAt: Date.now() })),
    generatedAt: Date.now(),
  };
  const initialMarkdown = composeDocumentMarkdown(base);
  throwIfAborted(input.signal);
  const chapterReview = generationStrategy.enableChapterReview
    ? await measureGenerationStep(generationDiagnostics, 'chapter-review', () => reviewChapterSummaries({ template, chapters: chapterDrafts, budget: documentBudget, promptTexts: reviewPromptTexts || promptTexts, requirement: input.requirement, strategy: generationStrategy, diagnostics: generationDiagnostics, signal: input.signal }), { chapters: chapterDrafts.length })
    : { summaries: chapterDrafts.map(chapter => ({ chapterId: chapter.id, title: chapter.title, status: 'pass' as const, issues: [], suggestions: [], chars: documentTextLength(chapter.content) })), stage: displayStage({ type: 'llm_review' as const, roleId: 'chapter-review', status: 'success', message: '短文档策略已跳过章节级 LLM 审查' }, { subtitle: '章节级质量审查' }) };
  executionStages.push(chapterReview.stage);
  for (const summary of chapterReview.summaries.filter(item => item.status !== 'pass')) {
    validationIssues.push({ level: summary.status === 'fail' ? 'error' : 'warning', message: `${summary.title} 章节审查：${summary.issues.slice(0, 4).join('；') || '存在质量风险'}`, suggestion: summary.suggestions.slice(0, 3).join('；') || '请复核章节事实覆盖、结构完整性和专业闭环。' });
  }
  const globalReview = generationStrategy.enableGlobalReview
    ? await measureGenerationStep(generationDiagnostics, 'global-consistency-review', () => reviewGlobalConsistency({ template, chapters: chapterDrafts, chapterReviews: chapterReview.summaries, promptTexts: reviewPromptTexts || promptTexts, requirement: input.requirement, projectContext, diagnostics: generationDiagnostics, signal: input.signal }), { chapters: chapterDrafts.length })
    : { issues: [] as string[], stage: displayStage({ type: 'llm_review' as const, roleId: 'global-consistency-review', status: 'success', message: '当前策略已跳过全局 LLM 一致性审查' }, { subtitle: '全局一致性审查' }) };
  executionStages.push(globalReview.stage);
  for (const issue of globalReview.issues) validationIssues.push({ level: 'warning', message: `全局一致性审查：${issue}`, suggestion: '请复核跨章节术语、项目参数、范围边界和闭环关系。' });
  input.onProgress?.([...executionStages]);
  const riskChapters = chapterDrafts.filter(chapter => chapter.evidence.length === 0 || chapter.missingFacts.length > 0 || documentTextLength(chapter.content) < Math.floor((documentBudget.chapterTargets.get(chapter.id) || 1200) * 0.7) || chapterReview.summaries.some(summary => summary.chapterId === chapter.id && summary.status !== 'pass') || lightweightChapterIssues({ chapter: effectiveChapters.find(item => item.id === chapter.id) || { id: chapter.id, title: chapter.title, purpose: '', queries: [], requiredFacts: [], sections: chapter.sections }, content: chapter.content, missingFacts: chapter.missingFacts, targetWords: documentBudget.chapterTargets.get(chapter.id) || 1200 }).length > 0);
  const forceFullReview = initialBlockingCount > 0 || globalReview.issues.length > 0 || chapterReview.summaries.some(summary => summary.status === 'fail') || validationIssues.some(issue => /事实一致性|项目污染|章节生成存在兜底|章节生成失败|阻断/u.test(issue.message));
  const shouldFullReview = forceFullReview || riskChapters.length > Math.max(3, Math.floor(chapterDrafts.length * 0.35));
  const reviewStartedAt = Date.now();
  const review = shouldFullReview
    ? await reviewAndOptimizeMarkdown({ template, spec: documentSpec, markdown: initialMarkdown, evidence: allEvidence, promptTexts: reviewPromptTexts || promptTexts, projectContext, requirement: input.requirement, signal: input.signal })
    : { markdown: initialMarkdown, stage: { type: 'llm_review' as const, roleId: 'llm-review', status: riskChapters.length > 0 ? 'skipped' as const : 'success' as const, message: riskChapters.length > 0 ? `本地风险扫描发现 ${riskChapters.length} 个低/中风险章节，已在章节阶段完成局部自检修复，跳过全文审查` : '本地风险扫描未发现需要 LLM 深度审查的章节，跳过全文审查' } };
  review.stage.message = elapsedMessage(review.stage.message || 'LLM 审查完成', reviewStartedAt);
  throwIfAborted(input.signal);
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
  const repairStartedAt = Date.now();
  const repair = await measureGenerationStep(generationDiagnostics, 'typed-quality-repair', () => repairMarkdownByQuality({ markdown: reviewedMarkdownBase, template, chapters: chapterDrafts, promptTexts, requirement: input.requirement, issues: qualityIssues, forbidDrawingImages, strategy: generationStrategy, signal: input.signal }), { issues: qualityIssues.length });
  if (repair.stage) repair.stage.message = elapsedMessage(repair.stage.message || '质量修复完成', repairStartedAt);
  throwIfAborted(input.signal);
  const reviewedStages = repair.stage ? [...executionStages, review.stage, repair.stage] : [...executionStages, review.stage];
  let repairedChapterDrafts = repair.chapters;
  const repairedBudgetStatus = documentBudgetStatus(documentBudget, repairedChapterDrafts.map(chapter => chapter.content).join('\n\n'));
  if (documentBudget.minChars && repairedBudgetStatus.currentChars < Math.floor(documentBudget.minChars * 0.9)) {
    const postRepairBudgetStartedAt = Date.now();
    const postRepairBeforeChars = repairedBudgetStatus.currentChars;
    repairedChapterDrafts = await expandDocumentToBudget({ template, chapters: repairedChapterDrafts, budget: documentBudget, promptTexts, requirement: input.requirement, forbidDrawingImages, signal: input.signal });
    const postRepairBudgetStatus = documentBudgetStatus(documentBudget, repairedChapterDrafts.map(chapter => chapter.content).join('\n\n'));
    reviewedStages.push(displayStage({ type: 'validation', roleId: 'document-budget-repair', status: documentBudget.minChars && postRepairBudgetStatus.currentChars < documentBudget.minChars ? 'fallback' : 'success', message: elapsedMessage(`修复后预算补齐：当前 ${postRepairBudgetStatus.currentChars} 字，新增 ${Math.max(0, postRepairBudgetStatus.currentChars - postRepairBeforeChars)} 字，预计 ${postRepairBudgetStatus.estimatedPages} 页`, postRepairBudgetStartedAt) }, { subtitle: '修复后预算补齐' }));
  }
  const repairedMarkdown = composeDocumentMarkdown({ ...base, chapters: repairedChapterDrafts, validationIssues, exportGate: base.exportGate, executionStages });
  const finalSections = inferChapterSectionsFromMarkdown(repairedMarkdown, repairedChapterDrafts);
  const finalChapterDrafts = repairedChapterDrafts.map((chapter, index) => ({ ...chapter, sections: finalSections[index] || chapter.sections || [] }));
  const finalMarkdown = normalizeTertiaryHeadings(sanitizeFormalMarkdown(ensureFormalToc(removeUnwantedDrawingImages(repairedMarkdown, forbidDrawingImages), finalChapterDrafts)));
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
  validationIssues.push(...promptExampleLeakIssues(finalMarkdown, promptBindings));
  for (const benchmark of validateDocumentQualityBenchmark({ template, chapters: finalChapterDrafts, markdown: finalMarkdown })) validationIssues.push(...benchmark.issues);
  validationIssues.push(...validateEngineeringSpecialty({ markdown: finalMarkdown, chapters: finalChapterDrafts, summary: projectMaterialSummary, roles: resolvedMaterialRoles }));
  validationIssues.push(...configuredAutoSpecGateIssues(finalMarkdown, template));
  const budgetIssues = documentBudgetIssues(documentBudget, finalChapterDrafts.map(chapter => chapter.content).join('\n\n'));
  const pageIssues = pageTargetIssues(template.generationSettings || template.exportSettings, finalMarkdown).filter(issue => !(documentBudget.minPages && /低于目标页数/u.test(issue.message)));
  validationIssues.push(...pageIssues);
  validationIssues.push(...budgetIssues);
  validationIssues.push(...configuredStructureIssues(finalMarkdown, template));
  const finalExportGate = buildExportGate(validationIssues, factsModel, finalChapterDrafts);
  const blockingCount = finalExportGate.blockingIssues.length;
  const finalQualitySummary = qualitySeveritySummary(validationIssues);
  generationDiagnostics.quality.blockingCount += finalQualitySummary.blocking;
  generationDiagnostics.quality.importantCount += finalQualitySummary.important;
  generationDiagnostics.quality.minorCount += finalQualitySummary.minor;
  const finalStages: DocumentExecutionStage[] = reviewedStages.map(stage => {
    if (stage.type === 'validation' && stage.roleId === 'document-workflow') return { ...stage, status: blockingCount > 0 ? 'failed' : 'success', message: `阻断 ${blockingCount}，问题 ${validationIssues.length}` };
    if (stage.type === 'export_ready') return { ...stage, status: finalExportGate.passed ? 'success' : 'fallback', message: finalExportGate.passed ? '已准备好导出 Markdown/HTML/DOCX/PDF' : '导出存在风险项，仍可导出，请人工复核' };
    return stage;
  });
  generationDiagnostics.llm.currentLimit = adaptiveDocumentLlmLimit;
  finalStages.push(displayStage({ type: 'validation', roleId: 'document-diagnostics', status: 'success', message: `性能统计：LLM ${generationDiagnostics.llm.calls} 次，失败 ${generationDiagnostics.llm.failures} 次，缓存命中 ${generationDiagnostics.cache.chapterHits} 章/${generationDiagnostics.cache.sectionHits} 小节，写入 ${generationDiagnostics.cache.chapterWrites} 章/${generationDiagnostics.cache.sectionWrites} 小节，噪声过滤 ${generationDiagnostics.evidence.filteredNoise} 条，质量问题 阻断${generationDiagnostics.quality.blockingCount}/重要${generationDiagnostics.quality.importantCount}/轻微${generationDiagnostics.quality.minorCount}，自动限流调整 ${generationDiagnostics.llm.limitAdjustments} 次` }, { subtitle: '后台诊断' }));
  const finalBase = {
    ...base,
    chapters: finalChapterDrafts,
    validationIssues,
    exportGate: finalExportGate,
    executionStages: finalStages,
    partialChapters: finalChapterDrafts.map(chapter => ({ id: chapter.id, title: chapter.title, chars: documentTextLength(chapter.content), status: 'completed' as const, updatedAt: Date.now() })),
    reviewMetadata: { chapterSummaries: chapterReview.summaries, globalIssues: globalReview.issues, diagnostics: generationDiagnostics },
  };
  return { ...finalBase, markdown: finalMarkdown };
}

export async function regenerateDocumentChapter(input: { templateId: string; chapterId: string; requirement?: string; maxEvidencePerChapter?: number; projectRoot?: string; documentId?: string; currentMarkdown?: string; existingFacts?: string[] }): Promise<DocumentDraftChapter> {
  const template = getDocumentTemplate(input.templateId);
  if (!template) throw new Error('Document template not found');
  const chapter = template.chapters.find(item => item.id === input.chapterId);
  if (!chapter) throw new Error('Document chapter not found');
  const projectRoot = path.resolve(input.projectRoot || getProjectRoot());
  if (!projectRoot) throw new Error('No knowledge base project found');
  const manager = getMultiProjectManager();
  const maxEvidence = Math.max(5, Math.min(30, input.maxEvidencePerChapter ?? 12));
  const boundFilePaths = buildBoundEvidenceScope(projectRoot, templateFileBindings(template));
  const rawEvidence: DocumentEvidence[] = [];
  for (const query of chapter.queries) {
    const result = await manager.search(projectRoot, query, {
      scope: 'project',
      limit: Math.max(maxEvidence, boundFilePaths.size > 0 ? 30 : maxEvidence),
      weights: { keyword: 0.4, vector: 0.45, rewrite: 0.75, hybridBonus: 0.15 },
    });
    rawEvidence.push(...result.results
      .filter((item: KbSearchResult) => evidenceInScope(projectRoot, item.filePath, boundFilePaths))
      .map((item: KbSearchResult) => ({
        chapterId: chapter.id,
        filePath: item.filePath,
        score: item.score,
        content: item.content,
        sectionTitle: item.sectionTitle,
        source: item.source,
      })));
  }
  const evidence = uniqueEvidence(rawEvidence.filter(item => evidenceInScope(projectRoot, item.filePath, boundFilePaths)), maxEvidence);
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
