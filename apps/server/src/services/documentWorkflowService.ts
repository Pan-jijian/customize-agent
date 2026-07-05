import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createProvider } from '@customize-agent/llm';
import { getMultiProjectManager, getProjectRoot } from '@/services/kbService';
import { getConfigStore } from '@/services/configService';
import { getProjectRoleConfig, listDocumentRoles } from './documentRoleService';
import type { KbSearchResult } from '@/lib/api';

export interface DocumentTemplateChapter {
  id: string;
  title: string;
  purpose: string;
  queries: string[];
  requiredFacts: string[];
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

export interface DocumentDraftChapter {
  id: string;
  title: string;
  content: string;
  evidence: DocumentEvidence[];
  missingFacts: string[];
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
  rules: DocumentFact[];
  specifications: DocumentFact[];
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
  type: 'fact_extraction' | 'chapter_generation' | 'validation' | 'formatting' | 'reference';
  roleId: string;
  promptId?: string;
  status: 'success' | 'fallback' | 'skipped' | 'failed';
  message?: string;
}

export interface GeneratedDocumentDraft {
  templateId: string;
  templateName: string;
  title: string;
  requirement: string;
  markdown: string;
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
  generatedAt: number;
}

const CONSTRUCTION_ORG_TEMPLATE: DocumentTemplate = {
  id: 'construction-organization-design',
  name: '施工组织设计',
  description: '根据招标文件、图纸、清单、表格和项目资料生成施工组织设计草稿。',
  category: '工程建设',
  outputTitle: '施工组织设计',
  chapters: [
    { id: 'basis', title: '第一章 编制依据', purpose: '整理招标文件、图纸、规范和编制说明。', requiredFacts: ['招标文件', '图纸', '规范标准'], queries: ['招标文件 编制依据 技术规范 标准 图纸 合同', '规范 标准 图纸 招标文件'] },
    { id: 'overview', title: '第二章 工程概况', purpose: '提取工程名称、地点、规模、范围和建设条件。', requiredFacts: ['工程名称', '工程地点', '工程规模', '施工范围'], queries: ['工程名称 工程地点 建设单位 工程规模 建筑面积 结构类型', '工程概况 招标范围 项目规模'] },
    { id: 'deployment', title: '第三章 施工部署', purpose: '形成项目组织、施工区段和总体部署。', requiredFacts: ['施工部署', '组织机构', '施工段'], queries: ['施工部署 项目组织机构 施工段划分 总体安排', '施工组织 施工顺序 施工流水'] },
    { id: 'schedule', title: '第四章 施工进度计划及保证措施', purpose: '提取工期、节点、进度要求并形成保证措施。', requiredFacts: ['工期要求', '节点工期'], queries: ['工期要求 开工 竣工 进度计划 节点工期', '工期 进度 保证措施'] },
    { id: 'preparation', title: '第五章 施工准备', purpose: '整理技术、现场、材料、机械和劳动力准备。', requiredFacts: ['技术准备', '现场准备', '材料准备'], queries: ['施工准备 技术准备 现场准备 材料准备 机械准备', '临设 水电 进场 准备'] },
    { id: 'methods', title: '第六章 主要分部分项工程施工方案', purpose: '依据工程范围生成主要施工方法。', requiredFacts: ['主要分部分项工程', '施工工艺'], queries: ['土方 基础 主体 砌体 装饰 安装 道路 管线 主要施工方法', '分部分项 施工工艺 技术措施'] },
    { id: 'quality', title: '第七章 质量保证体系及措施', purpose: '形成质量目标、体系和保证措施。', requiredFacts: ['质量目标', '质量标准'], queries: ['质量目标 质量标准 验收规范 质量保证措施', '质量管理 检验 试验'] },
    { id: 'safety', title: '第八章 安全生产管理体系及措施', purpose: '形成安全目标、风险控制和应急管理。', requiredFacts: ['安全目标', '安全要求'], queries: ['安全目标 安全文明施工 安全管理 危险源 应急预案', '安全生产 风险 防护'] },
    { id: 'civilized', title: '第九章 文明施工及环境保护措施', purpose: '整理文明施工、扬尘、噪声、污水和固废措施。', requiredFacts: ['文明施工', '环境保护'], queries: ['文明施工 环境保护 扬尘 噪声 污水 固废', '绿色施工 环保 控制措施'] },
    { id: 'resources', title: '第十章 劳动力、材料、机械设备投入计划', purpose: '提取资源计划和相关表格。', requiredFacts: ['劳动力计划', '材料计划', '机械设备计划'], queries: ['劳动力计划 材料计划 机械设备计划 主要设备 表格', '资源投入 机械 劳动力 材料'] },
    { id: 'layout', title: '第十一章 施工总平面布置', purpose: '整理临设、道路、水电、堆场和平面布置要求。', requiredFacts: ['施工总平面布置'], queries: ['施工平面布置 临时设施 道路 水电 堆场', '总平面布置 临时用地'] },
    { id: 'season', title: '第十二章 季节性施工措施', purpose: '形成雨季、冬季、高温、防汛等措施。', requiredFacts: ['季节性施工要求'], queries: ['雨季施工 冬季施工 高温施工 台风 防汛', '季节性施工 措施'] },
    { id: 'emergency', title: '第十三章 应急预案', purpose: '形成风险、组织、响应和救援措施。', requiredFacts: ['应急预案'], queries: ['应急预案 风险 应急组织 救援措施', '事故 应急 响应'] },
    { id: 'appendix', title: '第十四章 附表及附件', purpose: '汇总附件、表格、图纸和来源清单。', requiredFacts: ['附表', '附件'], queries: ['附表 计划表 机械表 劳动力表 进度表', '附件 表格 清单 图纸'] },
  ],
};

const BUILT_IN_TEMPLATES: DocumentTemplate[] = [
  { ...CONSTRUCTION_ORG_TEMPLATE, builtIn: true },
];

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
    })) : [{ id: 'document', title: template.outputTitle || template.name || '业务文档', purpose: template.description || '', queries: [], requiredFacts: [] }],
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
  return [...BUILT_IN_TEMPLATES, ...readCustomTemplates()];
}

export function getDocumentTemplate(templateId: string): DocumentTemplate | undefined {
  return listDocumentTemplates().find(template => template.id === templateId);
}

export function saveDocumentTemplate(template: DocumentTemplate): DocumentTemplate {
  const sanitized = sanitizeTemplate(template);
  if (BUILT_IN_TEMPLATES.some(item => item.id === sanitized.id)) throw new Error('Built-in template cannot be overwritten');
  const templates = readCustomTemplates().filter(item => item.id !== sanitized.id);
  templates.push(sanitized);
  writeCustomTemplates(templates);
  return sanitized;
}

export function deleteDocumentTemplate(templateId: string) {
  if (BUILT_IN_TEMPLATES.some(item => item.id === templateId)) throw new Error('Built-in template cannot be deleted');
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

function uniqueEvidence(items: DocumentEvidence[], limit: number): DocumentEvidence[] {
  const seen = new Set<string>();
  return items
    .sort((a, b) => b.score - a.score)
    .filter(item => {
      const key = `${item.filePath}:${item.content.slice(0, 100)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit);
}

function evidenceLine(item: DocumentEvidence): string {
  return `- ${item.filePath}（score=${item.score.toFixed(3)}）：${item.content.replace(/\s+/gu, ' ').slice(0, 260)}`;
}

function extractFacts(template: DocumentTemplate, evidence: DocumentEvidence[]): Record<string, string> {
  const facts: Record<string, string> = {};
  for (const fact of [...new Set(template.chapters.flatMap(chapter => chapter.requiredFacts))]) {
    const hit = evidence.find(item => item.content.includes(fact.replace(/要求|计划|目标|标准/gu, '')) || item.content.includes(fact));
    if (hit) facts[fact] = `${hit.content.replace(/\s+/gu, ' ').slice(0, 180)}（来源：${hit.filePath}）`;
  }
  return facts;
}

function templatePromptBindings(template: DocumentTemplate): PromptBinding[] {
  if (template.projectRoleConfigId) {
    const config = getProjectRoleConfig(template.projectRoleConfigId);
    const roles = listDocumentRoles('prompt');
    if (config) return [...config.promptRoles]
      .sort((a, b) => a.order - b.order)
      .map(item => roles.find(role => role.id === item.roleId))
      .filter((role): role is NonNullable<typeof role> => !!role?.resourceId)
      .map(role => ({ promptId: role.resourceId!, roleId: role.id }));
  }
  return template.promptBindings?.length ? template.promptBindings : (template.promptIds ?? []).map(promptId => ({ promptId, roleId: 'chapter_generation' }));
}

function templateFileBindings(template: DocumentTemplate): FileBinding[] {
  if (template.projectRoleConfigId) {
    const config = getProjectRoleConfig(template.projectRoleConfigId);
    const roles = listDocumentRoles('file');
    if (config) return [...config.fileRoles]
      .sort((a, b) => a.order - b.order)
      .map(item => roles.find(role => role.id === item.roleId))
      .filter((role): role is NonNullable<typeof role> => !!role?.resourceId)
      .map(role => ({ filePath: role.resourceId!, roleId: role.id }));
  }
  return template.fileBindings?.length ? template.fileBindings : (template.boundFilePaths ?? []).map(filePath => ({ filePath, roleId: 'project_fact' }));
}

async function callDocumentLlmJson<T>(system: string, prompt: string): Promise<T | undefined> {
  try {
    const store = getConfigStore();
    const config = store.load();
    const activeModel = config.models.reasoning.active || config.models.action.active || config.models.reader.active;
    const selected = [...config.models.reasoning.list, ...config.models.action.list, ...config.models.reader.list].find(model => model.name === activeModel);
    if (!selected) return undefined;
    const providerConfig = config.providers[selected.provider];
    if (!providerConfig) return undefined;
    const provider = createProvider(selected.provider, { baseUrl: providerConfig.baseUrl, apiKey: providerConfig.apiKey, modelName: selected.name });
    const response = await provider.chat([
      { role: 'system', content: `${system}\n只返回 JSON，不要返回 markdown。` },
      { role: 'user', content: prompt },
    ], { temperature: 0 });
    const raw = response.content.trim().replace(/^```json\s*/u, '').replace(/^```\s*/u, '').replace(/```$/u, '').trim();
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function extractStructuredTables(evidence: DocumentEvidence[]): StructuredTableFact[] {
  const tables: StructuredTableFact[] = [];
  for (const item of evidence.filter(e => e.processingType === 'table')) {
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

function extractStructuredFacts(evidence: DocumentEvidence[]): DocumentFact[] {
  const patterns: Array<[string, RegExp]> = [
    ['工程名称', /工程名称[：:\s]+([^\n，。；;]+)/u],
    ['工程地点', /(?:工程地点|建设地点)[：:\s]+([^\n，。；;]+)/u],
    ['建设单位', /建设单位[：:\s]+([^\n，。；;]+)/u],
    ['工期要求', /(?:工期|计划工期)[：:\s]+([^\n，。；;]+)/u],
    ['质量目标', /质量目标[：:\s]+([^\n，。；;]+)/u],
    ['安全目标', /安全目标[：:\s]+([^\n，。；;]+)/u],
    ['施工范围', /(?:施工范围|招标范围)[：:\s]+([^\n]+)/u],
  ];
  const facts: DocumentFact[] = [];
  for (const item of evidence) {
    for (const [key, pattern] of patterns) {
      const match = item.content.match(pattern);
      if (match?.[1] && !facts.some(fact => fact.key === key && fact.value === match[1].trim())) {
        facts.push({ key, value: match[1].trim().slice(0, 300), sourceFile: item.filePath, roleId: item.roleId || 'unknown', processingType: item.processingType, confidence: item.score });
      }
    }
  }
  return facts;
}

async function extractFactsWithLlm(evidence: DocumentEvidence[], promptTexts: string): Promise<{ facts: DocumentFact[]; stages: DocumentExecutionStage[] }> {
  const stages: DocumentExecutionStage[] = [{ type: 'fact_extraction', roleId: 'llm-json', status: 'skipped', message: 'LLM JSON 抽取未启用或无可用模型' }];
  const sample = evidence.slice(0, 20).map(item => `文件:${item.filePath}\n角色:${item.roleId || ''}\n处理:${item.processingType || ''}\n内容:${item.content.slice(0, 1200)}`).join('\n\n---\n\n');
  if (!sample.trim()) return { facts: [], stages };
  const llm = await callDocumentLlmJson<{ facts?: Array<{ key: string; value: string; sourceFile?: string; roleId?: string; processingType?: string; confidence?: number }> }>(
    promptTexts || '你是工程文档事实抽取器。',
    `请从资料中抽取工程文档结构化事实，返回 {"facts":[{"key":"工程名称","value":"...","sourceFile":"...","roleId":"...","processingType":"project_fact","confidence":0.8}]}。\n\n${sample}`,
  );
  if (!llm?.facts?.length) return { facts: [], stages };
  return {
    facts: llm.facts.filter(item => item.key && item.value).map(item => ({
      key: item.key,
      value: item.value,
      sourceFile: item.sourceFile || '',
      roleId: item.roleId || 'llm',
      processingType: item.processingType,
      confidence: item.confidence ?? 0.8,
      sourceRef: { filePath: item.sourceFile || '', roleId: item.roleId || 'llm', processingType: item.processingType },
    })),
    stages: [{ type: 'fact_extraction', roleId: 'llm-json', status: 'success', message: `LLM 抽取 ${llm.facts.length} 条事实` }],
  };
}

function buildFactsModel(facts: DocumentFact[], tables: StructuredTableFact[] = [], missingItems: string[] = []): DocumentFactsModel {
  const byKeys = (keys: string[]) => facts.filter(fact => keys.some(key => fact.key.includes(key)));
  const byProcessing = (type: string) => facts.filter(fact => fact.processingType === type || fact.roleId.includes(type));
  return {
    project: byKeys(['工程名称', '工程地点', '建设单位', '施工范围']),
    schedule: byKeys(['工期', '开工', '竣工', '节点']),
    quality: byKeys(['质量']),
    safety: byKeys(['安全']),
    resources: byKeys(['劳动力', '材料', '机械', '设备']),
    tables,
    drawings: byProcessing('drawing'),
    rules: byProcessing('rule'),
    specifications: byProcessing('specification'),
    missing: [...new Set(missingItems)],
    conflicts: [],
  };
}

function buildExportGate(issues: ValidationIssue[], factsModel: DocumentFactsModel, chapters: DocumentDraftChapter[]): ExportGateResult {
  const checklist = [
    { key: 'no_errors', label: '无阻断级校验错误', passed: !issues.some(issue => issue.level === 'error') },
    { key: 'project_facts', label: '项目基础事实齐全', passed: factsModel.project.length > 0 },
    { key: 'source_traceability', label: '事实具备来源追踪', passed: [...factsModel.project, ...factsModel.schedule, ...factsModel.quality, ...factsModel.safety].every(fact => Boolean(fact.sourceFile)) },
    { key: 'chapter_evidence', label: '章节均具备证据', passed: chapters.every(chapter => chapter.evidence.length > 0) },
    { key: 'no_missing_content', label: '无资料未提供章节', passed: chapters.every(chapter => !chapter.content.includes('资料未提供')) },
  ];
  const blockingIssues = issues.filter(issue => issue.level === 'error');
  return { passed: blockingIssues.length === 0 && checklist.every(item => item.passed), blockingIssues, checklist };
}

function buildValidationIssues(validation: { warnings: string[]; errors: string[] }, factsModel: DocumentFactsModel, draftChapters: DocumentDraftChapter[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [
    ...validation.errors.map(message => ({ level: 'error' as const, message, suggestion: '请补充配置或资料后重新生成。' })),
    ...validation.warnings.map(message => ({ level: 'warning' as const, message, suggestion: '建议人工确认或补充对应资料。' })),
  ];
  if (factsModel.project.length === 0) issues.push({ level: 'error', message: '项目基础事实缺失', suggestion: '请在项目事实文件角色中绑定包含工程概况的资料。' });
  if (draftChapters.some(chapter => chapter.content.includes('资料未提供'))) issues.push({ level: 'warning', message: '存在资料未提供章节', suggestion: '请检查项目角色配置中的文件绑定和顺序。' });
  if (factsModel.conflicts.length > 0) issues.push(...factsModel.conflicts.map(message => ({ level: 'error' as const, message })));
  return issues;
}

function validateDraft(chapters: DocumentDraftChapter[], facts: Record<string, string>, structuredFacts: DocumentFact[] = [], template?: DocumentTemplate) {
  const warnings: string[] = [];
  const errors: string[] = [];
  for (const chapter of chapters) {
    if (chapter.evidence.length === 0) warnings.push(`${chapter.title} 未检索到资料证据`);
    if (chapter.content.length < 80) warnings.push(`${chapter.title} 内容较短，建议人工补充或重新生成`);
  }
  for (const key of ['工程名称', '工期要求', '质量目标', '施工范围']) {
    if (!facts[key] && !structuredFacts.some(fact => fact.key === key)) warnings.push(`${key} 未形成明确事实，请人工确认`);
  }
  if (template && templateFileBindings(template).length === 0) errors.push('模板未绑定任何知识库文件');
  if (template && templatePromptBindings(template).length === 0) errors.push('模板未绑定任何提示词');
  const roleIds = new Set(structuredFacts.map(fact => fact.roleId));
  for (const requiredRole of ['project_fact', 'rule']) {
    if (template?.fileBindings?.some(binding => binding.roleId === requiredRole) && !roleIds.has(requiredRole)) warnings.push(`${requiredRole} 角色未抽取到结构化事实`);
  }
  return { passed: errors.length === 0, warnings, errors };
}

export function composeDocumentMarkdown(draft: Omit<GeneratedDocumentDraft, 'markdown'>): string {
  return [
    `<div class="document-cover">`,
    `# ${draft.title}`,
    '',
    `**文档版本**：V1.0  `,
    `**生成时间**：${new Date(draft.generatedAt).toLocaleString('zh-CN')}  `,
    `**生成要求**：${draft.requirement || '未填写'}  `,
    `</div>`,
    '',
    '<div class="page-break"></div>',
    '',
    '## 目录',
    '',
    ...draft.chapters.map((chapter, index) => `${index + 1}. ${chapter.title}`),
    '',
    '<div class="page-break"></div>',
    '',
    '## 结构化事实表',
    '',
    Object.keys(draft.facts).length > 0
      ? ['| 事实项 | 依据 |', '|---|---|', ...Object.entries(draft.facts).map(([key, value]) => `| ${key} | ${value.replace(/\|/gu, ' ')} |`)].join('\n')
      : '未抽取到明确事实，需人工确认。',
    '',
    ...draft.chapters.flatMap(chapter => [chapter.content, '']),
    '## 资料来源清单',
    '',
    '| 文件 | 引用次数 |',
    '|---|---:|',
    ...draft.sources.map(source => `| ${source.filePath} | ${source.count} |`),
    '',
    '## 缺失项与需确认事项',
    '',
    ...(draft.missingItems.length > 0 ? draft.missingItems.map(item => `- ${item}`) : ['- 暂未发现完全缺失章节；仍需人工复核关键数据。']),
    '',
    '## 校验结果',
    '',
    ...draft.validation.warnings.map(item => `- 警告：${item}`),
    ...draft.validation.errors.map(item => `- 错误：${item}`),
    '',
    '## 严格校验清单',
    '',
    ...draft.validationIssues.map(issue => `- ${issue.level.toUpperCase()}：${issue.message}${issue.suggestion ? `（建议：${issue.suggestion}）` : ''}`),
  ].join('\n');
}

export async function generateDocumentDraft(input: { templateId: string; requirement?: string; maxEvidencePerChapter?: number; projectRoot?: string }): Promise<GeneratedDocumentDraft> {
  const template = getDocumentTemplate(input.templateId);
  if (!template) throw new Error('Document template not found');
  const projectRoot = input.projectRoot || getProjectRoot();
  if (!projectRoot) throw new Error('No knowledge base project found');
  const manager = getMultiProjectManager();
  const maxEvidence = Math.max(5, Math.min(30, input.maxEvidencePerChapter ?? 12));
  const promptBindings = templatePromptBindings(template);
  const fileBindings = templateFileBindings(template);
  const promptTexts = readPromptContents(promptBindings).map(item => `## [${item.roleId}] ${item.name}\n${item.content}`).join('\n\n');
  const boundFilePaths = new Set(fileBindings.map(binding => binding.filePath));
  const allFileRoles = listDocumentRoles('file');
  const fileRoleByPath = new Map(fileBindings.map(binding => [binding.filePath, binding.roleId]));
  const fileProcessingByPath = new Map(fileBindings.map(binding => [binding.filePath, allFileRoles.find(role => role.id === binding.roleId)?.processingType || 'reference']));
  const project = await manager.getProject(projectRoot);
  await project.incrementalIndex();
  const chapterDrafts: DocumentDraftChapter[] = [];
  const allEvidence: DocumentEvidence[] = [];
  const missingItems: string[] = [];

  for (const chapter of template.chapters) {
    const rawEvidence: DocumentEvidence[] = [];
    const queries = chapter.queries.length > 0 ? chapter.queries : [template.name, template.outputTitle, chapter.title, ...fileBindings.map(binding => binding.filePath)];
    for (const query of queries) {
      const result = await manager.search(projectRoot, query, {
        scope: 'project',
        limit: Math.max(maxEvidence, boundFilePaths.size > 0 ? 30 : maxEvidence),
        weights: { keyword: 0.4, vector: 0.45, rewrite: 0.75, hybridBonus: 0.15 },
      });
      rawEvidence.push(...result.results
        .filter((item: KbSearchResult) => boundFilePaths.size === 0 || boundFilePaths.has(item.filePath))
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
    for (const relativePath of boundFilePaths) {
      const detail = project.getFileDetail(relativePath);
      if (!detail) continue;
      rawEvidence.push(...detail.chunks.slice(0, Math.max(maxEvidence, 20)).map(chunk => ({
        chapterId: chapter.id,
        filePath: detail.file.relativePath,
        score: 1,
        content: chunk.content,
        roleId: fileRoleByPath.get(detail.file.relativePath),
        processingType: fileProcessingByPath.get(detail.file.relativePath),
        sectionTitle: chunk.sectionTitle,
        source: 'bound-file',
      })));
    }
    const evidence = uniqueEvidence(rawEvidence, maxEvidence);
    allEvidence.push(...evidence);
    const missingFacts = chapter.requiredFacts.filter(fact => !evidence.some(item => item.content.includes(fact.replace(/要求|计划|目标|标准/gu, '')) || item.content.includes(fact)));
    if (evidence.length === 0) missingItems.push(`${chapter.title}：未检索到明确资料依据`);
    for (const fact of missingFacts) missingItems.push(`${chapter.title}：${fact} 未检索到明确依据`);
    const content = [
      `## ${chapter.title}`,
      '',
      promptTexts ? `### 模板绑定提示词规则\n${promptTexts.slice(0, 3000)}` : '',
      '',
      evidence.length > 0 ? `本章根据模板绑定资料围绕“${chapter.purpose || template.description}”整理。` : '模板绑定资料未检索到明确内容，需进一步确认。',
      '',
      evidence.length > 0 ? '### 资料依据' : '',
      ...evidence.map(evidenceLine),
      '',
      missingFacts.length > 0 ? '### 待确认事项' : '',
      ...missingFacts.map(item => `- ${item}：资料未提供，需进一步确认。`),
    ].filter(Boolean).join('\n');
    chapterDrafts.push({ id: chapter.id, title: chapter.title, content, evidence, missingFacts });
  }

  const facts = extractFacts(template, allEvidence);
  const localFacts = extractStructuredFacts(allEvidence);
  const llmExtraction = await extractFactsWithLlm(allEvidence, promptTexts);
  const structuredFacts = [...localFacts, ...llmExtraction.facts];
  const structuredTables = extractStructuredTables(allEvidence);
  for (const fact of structuredFacts) facts[fact.key] = `${fact.value}（来源：${fact.sourceFile}，角色：${fact.roleId}）`;
  const sourceCounts = new Map<string, number>();
  for (const item of allEvidence) sourceCounts.set(item.filePath, (sourceCounts.get(item.filePath) ?? 0) + 1);
  const sources = [...sourceCounts.entries()].sort((a, b) => b[1] - a[1]).map(([filePath, count]) => ({ filePath, count }));
  const factsModel = buildFactsModel(structuredFacts, structuredTables, missingItems);
  const validation = validateDraft(chapterDrafts, facts, structuredFacts, template);
  const validationIssues = buildValidationIssues(validation, factsModel, chapterDrafts);
  const exportGate = buildExportGate(validationIssues, factsModel, chapterDrafts);
  const executionStages: DocumentExecutionStage[] = [
    ...llmExtraction.stages,
    { type: 'chapter_generation', roleId: 'document-workflow', status: 'success', message: `生成 ${chapterDrafts.length} 个章节` },
    { type: 'validation', roleId: 'document-workflow', status: validation.errors.length > 0 ? 'failed' : 'success', message: `错误 ${validation.errors.length}，警告 ${validation.warnings.length}` },
    { type: 'formatting', roleId: 'document-workflow', status: 'success', message: '已生成正式排版 Markdown' },
  ];
  const base = {
    templateId: template.id,
    templateName: template.name,
    title: template.outputTitle,
    requirement: input.requirement || (promptBindings.length ? `使用模板绑定提示词：${promptBindings.map(binding => `${binding.promptId}(${binding.roleId})`).join(', ')}` : ''),
    facts,
    structuredFacts,
    factsModel,
    chapters: chapterDrafts,
    sources,
    missingItems: [...new Set(missingItems)],
    validation,
    validationIssues,
    executionStages,
    exportGate,
    generatedAt: Date.now(),
  };
  return { ...base, markdown: composeDocumentMarkdown(base) };
}

export async function regenerateDocumentChapter(input: { templateId: string; chapterId: string; requirement?: string; maxEvidencePerChapter?: number; projectRoot?: string }): Promise<DocumentDraftChapter> {
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
  const missingFacts = chapter.requiredFacts.filter(fact => !evidence.some(item => item.content.includes(fact.replace(/要求|计划|目标|标准/gu, '')) || item.content.includes(fact)));
  const content = [
    `## ${chapter.title}`,
    '',
    input.requirement ? `> 生成要求：${input.requirement}` : '',
    evidence.length > 0 ? `本章根据知识库资料围绕“${chapter.purpose}”重新整理。` : '资料未提供，需进一步确认。',
    '',
    evidence.length > 0 ? '### 资料依据' : '',
    ...evidence.map(evidenceLine),
    '',
    missingFacts.length > 0 ? '### 待确认事项' : '',
    ...missingFacts.map(item => `- ${item}：资料未提供，需进一步确认。`),
  ].filter(Boolean).join('\n');
  return { id: chapter.id, title: chapter.title, content, evidence, missingFacts };
}
