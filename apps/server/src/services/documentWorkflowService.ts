import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as XLSX from 'xlsx';
import * as os from 'node:os';
import { createProvider } from '@customize-agent/llm';
import { resolveProtocol } from '@customize-agent/runtime';
import { ensureBuiltInKnowledgeBase, getMultiProjectManager, getProjectRoot } from './kbService';
import { recallDocumentContexts } from './contextService';
import { getConfigStore } from '@/services/configService';
import { getProjectRoleConfig, listDocumentRoles } from './documentRoleService';
import { getDocumentSpec, type DocumentSpecGateRule, type DocumentSpecPackage, type GateRuleEvaluator } from './documentSpecService';
import type { KbSearchResult } from '@/lib/api';

export interface DocumentTemplateChapter {
  id: string;
  title: string;
  purpose: string;
  queries: string[];
  requiredFacts: string[];
  pinnedEvidenceFilePaths?: string[];
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
  documentSpecId?: string;
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

const DELTA_OPERATOR_GUIDE_TEMPLATE: DocumentTemplate = {
  id: 'delta-force-hot-operators-guide',
  name: '三角洲热门干员攻略',
  description: '内置全流程示例：基于示例攻略资料、表格、图纸、图片、模板案例、样式规范、导出门禁和文档规范包生成可复用的热门干员攻略文档。',
  category: '游戏攻略',
  outputTitle: '三角洲热门干员攻略',
  projectRoleConfigId: 'delta-force-demo-config',
  documentSpecId: 'delta-force-demo-spec',
  chapters: [
    { id: 'overview', title: '第一章 攻略目标和适用人群', purpose: '说明攻略面向的新手/进阶玩家和使用场景。', requiredFacts: ['攻略目标', '适用人群'], queries: ['三角洲行动 干员 攻略 适用 新手 进阶'] },
    { id: 'operators', title: '第二章 热门干员定位速览', purpose: '汇总热门干员定位、技能和推荐场景。', requiredFacts: ['干员名称', '定位', '技能'], queries: ['三角洲行动 干员 定位 技能 露娜 红狼 牧羊人 蜂医'] },
    { id: 'team', title: '第三章 队伍搭配和实战打法', purpose: '按突击、侦察、支援、工程等职责给出队伍搭配。', requiredFacts: ['队伍分工', '搭配建议'], queries: ['三角洲行动 干员 搭配 队伍 分工 突击 侦察 支援 工程'] },
    { id: 'tables', title: '第四章 数据表和推荐优先级', purpose: '引用表格数据生成优先级和推荐清单。', requiredFacts: ['推荐指数', '上手难度'], queries: ['干员 推荐指数 上手难度 表格 优先级'] },
    { id: 'maps', title: '第五章 官方地图图纸和路线理解', purpose: '引用官方地图工具的地图图纸/底图瓦片，说明热门地图的关键区域和新手路线理解。', requiredFacts: ['地图事实', '地图图纸'], queries: ['三角洲行动 官方地图工具 地图图纸 零号大坝 航天基地 巴克什'] },
    { id: 'style', title: '第六章 模板样式和导出检查', purpose: '说明内置模板案例如何使用模板样式、来源清单和导出门禁形成可复用示例。', requiredFacts: ['模板样式规则', '导出门禁', '实战技巧', '注意事项'], queries: ['模板案例 导出样式 标题层级 表格 图片 来源 门禁 检查'] },
  ],
};

const BUILT_IN_TEMPLATES: DocumentTemplate[] = [
  { ...DELTA_OPERATOR_GUIDE_TEMPLATE, builtIn: true },
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
    documentSpecId: template.documentSpecId || undefined,
    chapters: Array.isArray(template.chapters) && template.chapters.length > 0 ? template.chapters.map((chapter, index) => ({
      id: (chapter.id || `chapter-${index + 1}`).replace(/[^a-zA-Z0-9_-]/gu, '-').slice(0, 80),
      title: chapter.title || `第 ${index + 1} 章`,
      purpose: chapter.purpose || '',
      queries: Array.isArray(chapter.queries) ? chapter.queries.filter(Boolean) : [],
      requiredFacts: Array.isArray(chapter.requiredFacts) ? chapter.requiredFacts.filter(Boolean) : [],
      pinnedEvidenceFilePaths: Array.isArray(chapter.pinnedEvidenceFilePaths) ? chapter.pinnedEvidenceFilePaths.filter(Boolean) : [],
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

const BUILT_IN_PROMPTS: Record<string, { name: string; content: string }> = {
  'builtin:delta-fact-extraction': {
    name: '内置｜三角洲事实抽取',
    content: `你是“资料事实抽取员”，任务是把绑定文件角色中的资料转成可追溯、可审查、可用于正式文档生成的事实模型。

工作要求：
1. 只使用输入资料和知识库证据，不要凭空补充游戏机制、数值、角色技能或地图信息。
2. 优先抽取带来源的事实：干员名称、定位、核心价值、推荐指数、上手难度、推荐场景、队伍搭配、地图图纸、表格字段、图片来源、规范约束。
3. 对冲突信息要标记 conflict；对缺失信息要标记 missing，不要用“可能”“大概”替代事实。
4. 输出要便于下游章节生成使用，字段名稳定、表达简洁、每条事实可回溯到文件角色和文件路径。
5. 如果输入中包含表格、Word/PDF、图片、地图图纸说明，要分别提取其用途和可用于文档的证据价值。

输出格式要求：
- 仅返回 JSON。
- 顶层字段包含 facts、tables、drawings、references、missing、conflicts。
- 每条 fact 至少包含 key、value、sourceFile、confidence。`,
  },
  'builtin:delta-chapter-generation': {
    name: '内置｜三角洲章节生成',
    content: `你是“专业攻略文档作者”，需要基于文件角色、提示词角色、文档规范包和知识库证据生成正式章节正文。

写作原则：
1. 先给结论，再解释依据，最后给可执行建议。
2. 每个判断必须能从证据中找到依据；证据不足时明确写“资料未覆盖”，不要编造。
3. 面向真实用户，语言要专业但易懂，避免空泛口号。
4. 必须利用表格数据、图片资料、地图图纸、Word/PDF 附件和规范要求，而不是只复述用户需求。
5. 章节内容要可导出到 Markdown/HTML/DOCX/PDF，标题层级、列表、表格和图片引用必须规范。
6. 针对干员攻略，至少覆盖：定位、推荐原因、适用场景、配队方式、新手误区、地图/撤离路线使用建议。

章节结构建议：
- 本节结论
- 证据依据
- 实战建议
- 风险或缺失资料提醒

禁止事项：
- 不要输出“作为 AI”之类说明。
- 不要删除已有图片和表格引用。
- 不要把没有来源的内容写成确定事实。`,
  },
  'builtin:delta-cover-image-generation': {
    name: '内置｜三角洲封面图片生成',
    content: `你是“多模态封面视觉设计师”。请为正式导出的攻略文档生成封面图片提示词或调用图片生成能力。

目标：生成 16:9 专业封面，适合放在 Markdown/HTML/DOCX/PDF 首页。

视觉要求：
1. 主题：三角洲行动热门干员攻略。
2. 构图：战术小队剪影 + 地图蓝图线稿 + 冷色科技 HUD + 干净留白标题区。
3. 风格：真实、专业、高清、现代军事科技感，不要卡通化，不要廉价海报感。
4. 画面中不要出现真实品牌、水印、乱码文字、错误 UI、低清文字。
5. 需要能和正文中的干员图片、地图图纸形成统一视觉风格。
6. 如果有参考图片角色，请利用参考图的配色、构图和主题信息，但不要简单复制。

输出要求：
- 如果模型支持图片生成：返回适合 SDXL/多模态图片生成的英文 prompt。
- 如果模型不支持图片生成：返回完整封面生成提示词，并说明可使用参考图片兜底。
- prompt 应包含 subject、composition、lighting、style、quality、negative constraints。`,
  },
  'builtin:delta-template-style': {
    name: '内置｜三角洲模板样式规范',
    content: `你是“模板样式设计师”。你的目标不是重新写事实，而是把生成结果整理成用户一眼能看懂、可复制为自定义模板的优秀示例。

样式目标：
1. 开头必须有“适用对象 + 使用场景 + 本文结论”的短导语，避免直接进入长正文。
2. 每章采用稳定结构：本章结论、核心依据、操作建议、引用资料。
3. 重要建议使用清单、表格或引用块，不要堆长段落。
4. 图片、地图、表格必须有前置说明和后置解释，说明为什么引用该资源。
5. 来源清单要区分规则文件、事实文件、表格、图纸、图片、附件和模板案例。
6. 对用户可学习的地方要明显：哪里来自文档规范包，哪里来自文件角色，哪里来自提示词角色。
7. 适合导出 DOCX/PDF：标题层级稳定、段落短、表格列宽友好、图片说明完整。

禁止事项：
- 不要加入没有证据支持的新事实。
- 不要把提示词全文渲染进正文。
- 不要让示例看起来像固定模板；要体现“可按角色和规范包自定义”。`,
  },
  'builtin:delta-resource-evidence': {
    name: '内置｜三角洲资源证据使用',
    content: `你是“资源证据编排专家”。你需要把知识库检索到的不同类型文件转成正文可用的信息，而不是只引用文件名。

资源使用规则：
1. 文本/Markdown：提炼规则、结论、注意事项和章节依据。
2. PDF/Word：提炼正式说明、附件依据、队伍搭配、规则解释和可引用来源。
3. CSV/XLS/XLSX：转成 Markdown 表格，保留字段含义，形成推荐优先级和对比结论。
4. 图片：说明图片中的对象、用途、与章节结论的关系；仅在需要时作为配图。
5. 地图图纸：说明区域、路线、点位、撤离/交战路径和队伍分工，不要当装饰图。
6. 模板案例：学习结构、表达和来源组织方式，不要照抄无关内容。
7. 导出门禁文件：用于检查完整性，不应作为正文事实。

输出要求：
- 每次引用资源都要写明“资源类型 + 来源文件 + 用途”。
- 如果多个来源冲突，必须提示冲突并建议用户确认。
- 如果资源不足，说明缺口，不要硬插固定文件。`,
  },
  'builtin:delta-export-gate': {
    name: '内置｜三角洲导出门禁',
    content: `你是“交付前导出门禁审核员”。你需要从 Markdown/HTML/DOCX/PDF 四种导出视角检查文档。

门禁维度：
1. 结构完整：封面、目录、核心结论、正文章节、表格、图片/地图、来源、缺失说明。
2. 事实完整：规范包 required facts 已覆盖，且来源角色匹配。
3. 资源完整：表格可读、图片路径有效、地图图纸不是硬编码、附件来源清楚。
4. 格式完整：标题不跳级，表格语法正确，图片 alt 文本完整，列表缩进稳定。
5. 导出安全：正文不包含提示词全文、远程临时生成 URL、内部错误堆栈、空占位符。
6. 可复核：关键结论能追溯到文件角色、资源证据或章节证据。

输出格式：
- error：必须阻断导出的问题。
- warning：可导出但建议优化的问题。
- info：交付提示。
- 每个问题都要包含定位、原因和修复建议。`,
  },
  'builtin:delta-review-optimization': {
    name: '内置｜三角洲 LLM 审查优化',
    content: `你是“文档总审 + 质量优化专家”。你需要在初稿生成后，再次利用文件角色、提示词角色、文档规范包和知识库证据进行二次审查与优化。

审查清单：
1. 角色配置是否被使用：文件角色、提示词角色、文档规范包是否在正文中体现。
2. 知识库证据是否被使用：表格、PDF/DOC/DOCX、XLS/XLSX、图片、地图图纸是否转化为内容价值。
3. 结构是否完整：封面、标题、目录、核心结论、正文章节、表格、图片、地图、来源、导出门禁。
4. 事实是否可靠：是否存在无来源断言、夸大描述、冲突信息未处理。
5. 表达是否专业：是否有重复、空泛、口语过度、章节衔接差的问题。
6. 导出是否友好：Markdown 标题层级、表格、图片链接、列表、引用块是否规范。

优化要求：
- 直接返回优化后的完整 Markdown。
- 保留已有图片引用、表格和来源信息。
- 对证据不足的地方，用“资料未覆盖/建议补充”标注，不要编造。
- 增强章节过渡、总结和行动建议，让文档更像正式交付成果。`,
  },
  'builtin:delta-validation': {
    name: '内置｜三角洲攻略校验',
    content: `你是“导出前质量门禁检查员”。请检查文档是否达到可导出、可交付、可复核标准。

必须检查：
1. 是否覆盖核心干员：露娜、红狼、牧羊人、蜂医。
2. 是否包含推荐表格，且表格列名清晰。
3. 是否包含封面图、干员图片、地图图纸或其引用说明。
4. 是否有目录和稳定的 Markdown 标题层级。
5. 是否说明事实来源或资料依据。
6. 是否存在明显占位符、空章节、重复章节、无来源断言。
7. 是否满足文档规范包中的必填事实和章节规则。

输出要求：
- 给出 error、warning、info 三类问题。
- error 代表阻断导出；warning 代表可导出但建议优化；info 代表提示信息。
- 每个问题都要给出修复建议。`,
  },
  'builtin:delta-formatting': {
    name: '内置｜三角洲攻略格式化',
    content: `你是“Markdown 排版编辑”。请把攻略整理成适合 Markdown/HTML/DOCX/PDF 导出的正式结构。

排版要求：
1. 使用清晰的一级、二级、三级标题，不跳级。
2. 重要结论使用列表或引用块突出。
3. 表格必须使用标准 Markdown 表格语法。
4. 图片必须保留 alt 文本，图片前后要有说明。
5. 长段落要拆分，避免一段超过 5 行。
6. 结尾应包含来源说明、适用范围和资料缺失提醒。
7. 不要改变事实含义，不要新增没有来源的内容。`,
  },
};

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
    if (id.startsWith('builtin:')) {
      const builtIn = BUILT_IN_PROMPTS[id];
      if (builtIn) prompts.push({ id, roleId: binding.roleId, name: builtIn.name, content: builtIn.content });
      continue;
    }
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

export async function validateDocumentTemplateRun(templateId: string, projectRoot = getProjectRoot()) {
  const template = getDocumentTemplate(templateId);
  if (!template) throw new Error('Document template not found');
  const issues: Array<{ level: 'error' | 'warning'; message: string }> = [];
  const promptRoles = listDocumentRoles('prompt');
  const fileRoles = listDocumentRoles('file');
  const config = template.projectRoleConfigId ? getProjectRoleConfig(template.projectRoleConfigId) : undefined;
  if (!template.projectRoleConfigId) issues.push({ level: 'error', message: '模板未绑定项目角色配置' });
  if (template.projectRoleConfigId && !config) issues.push({ level: 'error', message: '项目角色配置不存在或已删除' });
  const promptBindings = templatePromptBindings(template);
  const fileBindings = templateFileBindings(template);
  if (promptBindings.length === 0) issues.push({ level: 'warning', message: '模板未绑定提示词角色，生成会缺少说明提示词约束' });
  if (fileBindings.length === 0) issues.push({ level: 'error', message: '模板未绑定知识库文件角色' });
  const spec = template.documentSpecId ? getDocumentSpec(template.documentSpecId) : undefined;
  if (template.documentSpecId && !spec) issues.push({ level: 'error', message: '文档规范包不存在或已删除' });
  if (spec) {
    const chapterIds = new Set(template.chapters.map(chapter => chapter.id));
    const chapterTitles = new Set(template.chapters.map(chapter => chapter.title));
    for (const rule of spec.chapterRules.filter(rule => rule.required)) {
      if (!chapterIds.has(rule.id) && !chapterTitles.has(rule.title)) issues.push({ level: 'error', message: `模板章节不满足规范包要求：${rule.title}` });
    }
  }
  const resolvedProjectRoot = ensureBuiltInKnowledgeBase(projectRoot);
  const project = await getMultiProjectManager().getProject(resolvedProjectRoot);
  if (template.builtIn) await project.incrementalIndex();
  const files = project.listFiles();
  const fileMap = new Map(files.map(file => [file.relativePath, file]));
  const fileDiagnostics = fileBindings.map(binding => {
    const role = fileRoles.find(item => item.id === binding.roleId);
    const file = fileMap.get(binding.filePath);
    if (!role) issues.push({ level: 'error', message: `文件角色不存在：${binding.roleId}` });
    if (!file) issues.push({ level: 'error', message: `知识库文件不存在或未索引：${binding.filePath}` });
    return { ...binding, roleName: role?.name, exists: Boolean(file), indexed: Boolean(file), chunkCount: file?.chunkCount ?? 0, vectorReady: Boolean(file && file.chunkCount > 0) };
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
  return { templateId, projectRoleConfigId: template.projectRoleConfigId, documentSpecId: template.documentSpecId, fileDiagnostics, promptDiagnostics, spec: spec ? { id: spec.id, name: spec.name, factFields: spec.factFields.length, gateRules: spec.gateRules.length } : undefined, issues };
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

function sanitizeEvidenceContent(filePath: string, content: string) {
  const ext = path.extname(filePath).toLowerCase();
  if (['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.png', '.jpg', '.jpeg', '.webp'].includes(ext)) {
    return `资料文件：${path.basename(filePath)}，文件类型：${ext}。该文件作为来源附件参与生成，正文只引用其文件名、类型和角色，不直接混入二进制内容。`;
  }
  return [...content].filter(char => {
    const code = char.charCodeAt(0);
    return code === 9 || code === 10 || code === 13 || code >= 32;
  }).join('').slice(0, 4000);
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
  const content = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.png', '.jpg', '.jpeg', '.webp'].includes(ext) ? `内置示例资料文件：${path.basename(filePath)}，用于三角洲热门干员攻略生成，文件类型：${ext}。` : fs.readFileSync(absolute, 'utf-8');
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

function evidenceLine(item: DocumentEvidence): string {
  return `- ${item.filePath}（score=${item.score.toFixed(3)}）：${item.content.replace(/\s+/gu, ' ').slice(0, 260)}`;
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
  if (kind === 'map') return name.replace(/^地图图纸-/u, '').replace(/-官方完整地图图纸$/u, '官方完整地图图纸');
  if (kind === 'image') return name.replace(/-/gu, ' ');
  if (kind === 'spreadsheet') return `${name}（结构化表格）`;
  if (kind === 'document') return `${name}（文档附件）`;
  return name;
}

function relatedFactsForResource(item: DocumentEvidence, chapter?: DocumentTemplateChapter) {
  const haystack = `${item.filePath}\n${item.content}`;
  const candidates = [...(chapter?.requiredFacts || []), '地图图纸', '官方地图工具', '路线理解', '干员图片', '表格数据', '规范要求', '项目事实', '附件资料', '队伍搭配', '推荐指数'];
  return [...new Set(candidates.filter(fact => evidenceMatchesFact(item, fact) || haystack.includes(fact)))];
}

function resourceContentUse(kind: ResourceEvidence['kind'], item: DocumentEvidence) {
  if (kind === 'map') return '作为地图/图纸证据，用于说明区域、路线、点位、撤离/交战路径和队伍分工。';
  if (kind === 'image') return item.roleId?.includes('operator') || /干员|露娜|红狼|牧羊人|蜂医/u.test(item.filePath) ? '作为干员或对象图片证据，用于对应角色形象、定位和正文配图。' : '作为图片证据，用于视觉说明、参考图或章节配图。';
  if (kind === 'spreadsheet' || kind === 'table') return '作为表格/数据证据，用于字段对比、优先级、清单和结构化结论。';
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
      contentUse: resourceContentUse(kind, item),
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
    `本章证据包：文本片段 ${textEvidence.length} 条、资源文件 ${resources.length} 个。`,
    `资源类型分布：文本 ${byKind.text.length}、文档 ${byKind.document.length}、表格 ${byKind.spreadsheet.length + byKind.table.length}、图片 ${byKind.image.length}、地图图纸 ${byKind.map.length}、其他附件 ${byKind.attachment.length}。`,
    resources.length ? `关键资源：${resources.slice(0, 10).map(item => `${item.semanticTitle}（${item.kind}：${item.filePath}）`).join('；')}` : '',
  ].filter(Boolean).join('\n');
  return { chapterId: chapter.id, textEvidence, resources, byKind, summary };
}

function evidenceBundlePrompt(bundle: EvidenceBundle) {
  const resourceLines = bundle.resources.slice(0, 20).map(item => [
    `- 文件：${item.filePath}`,
    `  资源类型：${item.kind}`,
    `  语义标题：${item.semanticTitle}`,
    item.roleId ? `  文件角色：${item.roleId}` : '',
    item.processingType ? `  处理类型：${item.processingType}` : '',
    `  正文用途：${item.contentUse}`,
    item.relatedFacts.length ? `  关联事实：${item.relatedFacts.join('、')}` : '',
    item.snippets.length ? `  证据片段：${item.snippets.join(' / ')}` : '',
  ].filter(Boolean).join('\n')).join('\n');
  const textLines = bundle.textEvidence.map(item => `文件：${item.filePath}\n角色：${item.roleId || '未标注'}\n类型：${item.processingType || 'reference'}\n章节/片段：${item.sectionTitle || '未标注'}\n内容：${item.content.replace(/\s+/gu, ' ').slice(0, 900)}`).join('\n\n---\n\n');
  return [bundle.summary, resourceLines ? `结构化资源证据：\n${resourceLines}` : '', textLines ? `文本/附件片段证据：\n${textLines}` : ''].filter(Boolean).join('\n\n');
}

function factAliases(fact: string) {
  const aliases: Record<string, string[]> = {
    定位: ['侦察', '突击', '工程', '支援', '干员定位'],
    地图图纸: ['官方地图工具', '地图图纸', '完整地图图纸', '地图底图', '零号大坝', '航天基地', '巴克什'],
    搭配建议: ['队伍建议', '常见组合', '队伍搭配', '搭配', '分工'],
  };
  return [fact, fact.replace(/要求|计划|目标|标准/gu, ''), ...(aliases[fact] ?? [])].filter(Boolean);
}

function evidenceMatchesFact(item: DocumentEvidence, fact: string) {
  const haystack = `${item.filePath}\n${item.content}`;
  return factAliases(fact).some(alias => haystack.includes(alias));
}

function specFactTargets(template: DocumentTemplate, spec?: DocumentSpecPackage) {
  const chapterFacts = template.chapters.flatMap(chapter => chapter.requiredFacts).map(name => ({ id: name, name, required: true, sourceRoleIds: [] as string[], extractionHint: '' }));
  const specFacts = spec?.factFields.map(field => ({ id: field.id, name: field.name, required: field.required, sourceRoleIds: field.sourceRoleIds || [], extractionHint: field.extractionHint || '' })) || [];
  const map = new Map<string, { id: string; name: string; required: boolean; sourceRoleIds: string[]; extractionHint: string }>();
  for (const item of [...chapterFacts, ...specFacts]) map.set(item.id, { ...(map.get(item.id) || item), ...item, required: item.required || map.get(item.id)?.required || false });
  return [...map.values()];
}

function evidenceSatisfiesSpecField(item: DocumentEvidence, field: { name: string; sourceRoleIds?: string[] }) {
  const roleMatched = !field.sourceRoleIds?.length || Boolean(item.roleId && field.sourceRoleIds.includes(item.roleId));
  return roleMatched && evidenceMatchesFact(item, field.name);
}

/** 从证据中抽取事实字段，按规范包中的事实定义进行匹配 */
function extractFacts(template: DocumentTemplate, evidence: DocumentEvidence[], spec?: DocumentSpecPackage): Record<string, string> {
  const facts: Record<string, string> = {};
  for (const field of specFactTargets(template, spec)) {
    const hit = evidence.find(item => evidenceSatisfiesSpecField(item, field));
    if (hit) facts[field.name] = `${hit.content.replace(/\s+/gu, ' ').slice(0, 180)}（来源：${hit.filePath}，角色：${hit.roleId || '未标注'}）`;
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
      .filter((role): role is NonNullable<typeof role> => !!role)
      .flatMap(role => (role.resourceIds?.length ? role.resourceIds : role.resourceId ? [role.resourceId] : []).map(promptId => ({ promptId, roleId: role.id })));
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
      .filter((role): role is NonNullable<typeof role> => !!role)
      .flatMap(role => (role.resourceIds?.length ? role.resourceIds : role.resourceId ? [role.resourceId] : []).map(filePath => ({ filePath, roleId: role.id })));
  }
  return template.fileBindings?.length ? template.fileBindings : (template.boundFilePaths ?? []).map(filePath => ({ filePath, roleId: 'project_fact' }));
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

function extractStructuredFacts(evidence: DocumentEvidence[], template: DocumentTemplate, spec?: DocumentSpecPackage): DocumentFact[] {
  const fixedPatterns: Array<[string, RegExp]> = [
    ['工程名称', /工程名称[：:\s]+([^\n，。；;]+)/u],
    ['工程地点', /(?:工程地点|建设地点)[：:\s]+([^\n，。；;]+)/u],
    ['建设单位', /建设单位[：:\s]+([^\n，。；;]+)/u],
    ['工期要求', /(?:工期|计划工期)[：:\s]+([^\n，。；;]+)/u],
    ['质量目标', /质量目标[：:\s]+([^\n，。；;]+)/u],
    ['安全目标', /安全目标[：:\s]+([^\n，。；;]+)/u],
    ['施工范围', /(?:施工范围|招标范围)[：:\s]+([^\n]+)/u],
    ['攻略目标', /攻略目标[：:\s]+([^\n]+)/u],
    ['适用人群', /适用人群[：:\s]+([^\n]+)/u],
    ['干员名称', /(?:热门干员|干员)[：:\s\n-]+([^\n]+)/u],
    ['定位', /(?:定位|职责)[：:\s]+([^\n，。；;]+)/u],
    ['推荐指数', /推荐指数[：:\s,，]+([^\n，。；;]+)/u],
    ['实战技巧', /实战技巧[：:\s]+([^\n]+)/u],
  ];
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
    for (const [key, pattern] of fixedPatterns) {
      const match = item.content.match(pattern);
      if (match?.[1] && !facts.some(fact => fact.key === key && fact.value === match[1].trim())) {
        facts.push({ key, value: match[1].trim().slice(0, 300), sourceFile: item.filePath, roleId: item.roleId || 'unknown', processingType: item.processingType, confidence: item.score, sourceRef: { filePath: item.filePath, roleId: item.roleId || 'unknown', processingType: item.processingType, sectionTitle: item.sectionTitle } });
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

async function extractFactsWithLlm(evidence: DocumentEvidence[], promptTexts: string, template: DocumentTemplate, spec?: DocumentSpecPackage): Promise<{ facts: DocumentFact[]; stages: DocumentExecutionStage[] }> {
  const stages: DocumentExecutionStage[] = [{ type: 'fact_extraction', roleId: 'llm-json', status: 'skipped', message: 'LLM JSON 抽取未启用或无可用模型' }];
  const sample = evidence.slice(0, 24).map(item => `文件:${item.filePath}\n角色:${item.roleId || ''}\n处理:${item.processingType || ''}\n内容:${item.content.slice(0, 1200)}`).join('\n\n---\n\n');
  if (!sample.trim()) return { facts: [], stages };
  const targets = specFactTargets(template, spec);
  const schemaText = targets.map(field => `- id=${field.id} name=${field.name} required=${field.required} sourceRoleIds=${field.sourceRoleIds.join(',') || '不限'} hint=${field.extractionHint || '无'}`).join('\n');
  const llm = await callDocumentLlmJson<{ facts?: Array<{ fieldId?: string; fieldName?: string; key: string; value: string; sourceFile?: string; roleId?: string; processingType?: string; confidence?: number }> }>(
    promptTexts || '你是文档事实抽取器。',
    `请严格按下面的动态事实 schema 从资料中抽取事实。只抽取资料明确支持的内容；如果字段限定 sourceRoleIds，必须优先来自对应文件角色。返回 {"facts":[{"fieldId":"...","fieldName":"...","key":"...","value":"...","sourceFile":"...","roleId":"...","processingType":"project_fact","confidence":0.8}]}。\n\n动态事实 schema：\n${schemaText}\n\n资料：\n${sample}`,
  );
  if (!llm?.facts?.length) return { facts: [], stages };
  return {
    facts: llm.facts.filter(item => item.key && item.value).map(item => {
      const field = targets.find(target => target.id === item.fieldId || target.name === item.fieldName || target.name === item.key);
      return {
        key: field?.name || item.key,
        fieldId: field?.id || item.fieldId,
        fieldName: field?.name || item.fieldName,
        value: item.value,
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

function normalizedFactValue(value: string) {
  return value.replace(/\s+/gu, '').replace(/[，。,.;；：:]/gu, '').toLowerCase();
}

function detectFactConflicts(facts: DocumentFact[], spec?: DocumentSpecPackage) {
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

function buildSchemaFacts(facts: DocumentFact[], spec?: DocumentSpecPackage) {
  const schemaFacts: Record<string, DocumentFact[]> = {};
  for (const field of spec?.factFields || []) {
    schemaFacts[field.id] = facts.filter(fact => fact.fieldId === field.id || fact.key === field.name || fact.fieldName === field.name);
  }
  return schemaFacts;
}

function buildFactsModel(facts: DocumentFact[], tables: StructuredTableFact[] = [], missingItems: string[] = [], spec?: DocumentSpecPackage): DocumentFactsModel {
  const byKeys = (keys: string[]) => facts.filter(fact => keys.some(key => fact.key.includes(key)));
  const byProcessing = (type: string) => facts.filter(fact => fact.processingType === type || fact.roleId.includes(type));
  return {
    project: byKeys(['工程名称', '工程地点', '建设单位', '施工范围', '攻略目标', '适用人群', '干员名称', '定位', '推荐指数']),
    schedule: byKeys(['工期', '开工', '竣工', '节点']),
    quality: byKeys(['质量']),
    safety: byKeys(['安全']),
    resources: byKeys(['劳动力', '材料', '机械', '设备']),
    tables,
    drawings: byProcessing('drawing'),
    rules: byProcessing('rule'),
    specifications: byProcessing('specification'),
    schemaFacts: buildSchemaFacts(facts, spec),
    missing: [...new Set(missingItems)],
    conflicts: detectFactConflicts(facts, spec),
  };
}

function isExportBlockingIssue(issue: ValidationIssue) {
  return /出现禁用文本|资料未提供|导出|临时|无效|占位/iu.test(issue.message);
}

function buildExportGate(issues: ValidationIssue[], factsModel: DocumentFactsModel, chapters: DocumentDraftChapter[]): ExportGateResult {
  const checklist = [
    { key: 'no_errors', label: '无阻断级校验错误', passed: !issues.some(issue => issue.level === 'error' && isExportBlockingIssue(issue)) },
    { key: 'project_facts', label: '项目基础事实齐全', passed: factsModel.project.length > 0 },
    { key: 'source_traceability', label: '事实具备来源追踪', passed: [...factsModel.project, ...factsModel.schedule, ...factsModel.quality, ...factsModel.safety].every(fact => Boolean(fact.sourceFile)) },
    { key: 'chapter_evidence', label: '章节均具备证据', passed: chapters.every(chapter => chapter.evidence.length > 0) },
    { key: 'no_missing_content', label: '无资料未提供章节', passed: chapters.every(chapter => !chapter.content.includes('资料未提供')) },
  ];
  const blockingIssues = issues.filter(issue => issue.level === 'error' && isExportBlockingIssue(issue));
  return { passed: blockingIssues.length === 0 && checklist.every(item => item.passed), blockingIssues, checklist };
}

function fallbackEvaluatorForRule(rule: DocumentSpecGateRule): GateRuleEvaluator {
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

function issueMessage(rule: DocumentSpecGateRule, detail: string) {
  return `${rule.name}：${detail}`;
}

function applySpecGateRules(spec: DocumentSpecPackage | undefined, issues: ValidationIssue[], factsModel: DocumentFactsModel, chapters: DocumentDraftChapter[], markdown: string, fileBindings: FileBinding[], promptBindings: PromptBinding[]) {
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
  for (const chapter of spec.chapterRules.filter(chapter => chapter.required)) {
    if (!chapterTitles.has(chapter.title)) next.push({ level: 'error', message: `必需章节缺失：${chapter.title}`, suggestion: '请在模板或规范包章节规则中补齐章节。' });
    const draft = chapters.find(item => item.title === chapter.title);
    if (draft && chapter.minWords && draft.content.length < chapter.minWords) next.push({ level: 'warning', message: `章节内容低于最低字数：${chapter.title}`, suggestion: `建议不少于 ${chapter.minWords} 字。` });
  }
  const tableBlocks = markdownTables(markdown);
  const imageRefs = markdownImages(markdown);
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
    if (evaluator.subject === 'image' && evaluator.operator === 'image_caption_required' && imageRefs.some(image => !image.alt && markdown.slice(image.index + image.url.length, image.index + image.url.length + 120).trim().length < 10)) next.push({ level, message: issueMessage(rule, '存在缺少说明文字的图片') });
    if (evaluator.subject === 'source' && evaluator.operator === 'all_have_source' && allFacts.some(fact => !fact.sourceFile)) next.push({ level, message: issueMessage(rule, '存在无来源事实') });
    if (evaluator.subject === 'source' && evaluator.operator === 'min_count' && new Set(allFacts.map(fact => fact.sourceFile).filter(Boolean)).size < min) next.push({ level, message: issueMessage(rule, `来源数量少于 ${min}`) });
  }
  return next;
}

function buildValidationIssues(validation: { warnings: string[]; errors: string[] }, factsModel: DocumentFactsModel, draftChapters: DocumentDraftChapter[], template?: DocumentTemplate): ValidationIssue[] {
  const issues: ValidationIssue[] = [
    ...validation.errors.map(message => ({ level: 'error' as const, message, suggestion: '请补充配置或资料后重新生成。' })),
    ...validation.warnings.map(message => ({ level: 'warning' as const, message, suggestion: '建议人工确认或补充对应资料。' })),
  ];
  if (!template?.documentSpecId && factsModel.project.length === 0) issues.push({ level: 'error', message: '项目基础事实缺失', suggestion: '请在项目事实文件角色中绑定包含工程概况的资料。' });
  if (draftChapters.some(chapter => chapter.content.includes('资料未提供'))) issues.push({ level: 'warning', message: '存在资料未提供章节', suggestion: '请检查项目角色配置中的文件绑定和顺序。' });
  if (factsModel.conflicts.length > 0) issues.push(...factsModel.conflicts.map(message => ({ level: 'error' as const, message })));
  return issues;
}

function operatorTable(evidence: DocumentEvidence[]) {
  const table = evidence.find(item => item.filePath.endsWith('.csv') && item.content.includes('干员名称'));
  if (!table) return '';
  const lines = table.content.trim().split(/\r?\n/u).filter(Boolean);
  if (lines.length < 2) return '';
  const rows = lines.slice(1).map(line => line.split(',').map(cell => cell.trim()));
  return ['| 干员 | 定位 | 推荐指数 | 上手难度 | 推荐场景 |', '|---|---|---:|---|---|', ...rows.map(row => `| ${row[0] || ''} | ${row[1] || ''} | ${row[2] || ''} | ${row[3] || ''} | ${row[4] || ''} |`)].join('\n');
}

function getPromptContentById(promptBindings: PromptBinding[], promptId: string) {
  return readPromptContents(promptBindings).find(prompt => prompt.id === promptId)?.content || '';
}

function buildTextToImageUrl(prompt: string, imageSize: 'landscape_16_9' | 'square_hd' = 'landscape_16_9') {
  return `https://coresg-normal.trae.ai/api/ide/v1/text_to_image?prompt=${encodeURIComponent(prompt)}&image_size=${imageSize}`;
}

function mimeExtension(mimeType: string) {
  if (mimeType.includes('jpeg') || mimeType.includes('jpg')) return 'jpg';
  if (mimeType.includes('webp')) return 'webp';
  if (mimeType.includes('svg')) return 'svg';
  return 'png';
}

function documentAssetRelativePath(fileName: string) {
  return path.join('generatedDocuments', 'assets', fileName).split(path.sep).join('/');
}

function projectIdForGeneratedAssets(projectRoot: string) {
  return crypto.createHash('sha1').update(path.resolve(projectRoot)).digest('hex').slice(0, 12);
}

function saveDocumentImageAsset(projectRoot: string, fileName: string, data: Buffer) {
  const root = path.join(os.homedir(), '.customize-agent', 'projects', projectIdForGeneratedAssets(projectRoot), 'generatedDocuments');
  const relativePath = documentAssetRelativePath(fileName);
  const absolutePath = path.join(root, 'assets', fileName);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, data);
  return relativePath;
}

function isValidImageBuffer(buffer: Buffer) {
  const text = buffer.toString('utf8', 0, Math.min(buffer.length, 200)).trimStart();
  return buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    || buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
    || buffer.subarray(0, 4).toString('ascii') === 'RIFF'
    || text.startsWith('<svg');
}

const KNOWN_STATIC_GENERATED_IMAGE_HASHES = new Set([
  'e330cd023298a812503e10a067a3f88e1cbc094f37f6fd2a88fdb6799495b37e',
]);

function imageHash(buffer: Buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function validateGeneratedImage(buffer: Buffer, contentType: string) {
  if (!contentType.startsWith('image/') || !isValidImageBuffer(buffer)) {
    throw new Error(`图片生成接口未返回有效图片：${contentType || 'unknown'} ${buffer.toString('utf8').slice(0, 80)}`);
  }
  const hash = imageHash(buffer);
  return { hash, staticPlaceholder: KNOWN_STATIC_GENERATED_IMAGE_HASHES.has(hash) };
}

function imageGenerationPlaceholderMessage(buffer: Buffer) {
  const text = buffer.toString('utf8').slice(0, 300).trim();
  if (/image is generating|please refresh|generating/i.test(text)) return text;
  return '';
}

async function saveImageFromUrl(projectRoot: string, imageUrl: string, fileName: string): Promise<{ path: string; diagnostics: { hash: string; staticPlaceholder: boolean } }> {
  let lastMessage = '';
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const response = await fetch(imageUrl);
    if (!response.ok) throw new Error(`图片下载失败：${response.status}`);
    const contentType = response.headers.get('content-type') || '';
    const buffer = Buffer.from(await response.arrayBuffer());
    const placeholder = imageGenerationPlaceholderMessage(buffer);
    if (placeholder) {
      lastMessage = placeholder;
      await new Promise(resolve => setTimeout(resolve, 1500));
      continue;
    }
    const diagnostics = validateGeneratedImage(buffer, contentType);
    const path = saveDocumentImageAsset(projectRoot, `${fileName}.${mimeExtension(contentType)}`, buffer);
    return { path, diagnostics };
  }
  throw new Error(lastMessage || '图片仍在生成中，请稍后重新生成或刷新资源');
}

async function generatedCoverAssetFromUrl(projectRoot: string, prompt: string, modelProvider?: string): Promise<DocumentAsset> {
  const imageUrl = buildTextToImageUrl(prompt);
  const saved = await saveImageFromUrl(projectRoot, imageUrl, `cover-${Date.now()}`);
  return {
    id: `asset-cover-${Date.now()}`,
    type: 'image',
    role: 'cover',
    path: saved.path,
    prompt,
    modelProvider,
    status: 'generated',
    message: saved.diagnostics.staticPlaceholder
      ? `备用图片生成通道返回固定图片，已保存但需要检查模型图片生成配置；sha256=${saved.diagnostics.hash}`
      : `已生成封面图片并保存为本地生成资源；sha256=${saved.diagnostics.hash}`,
  };
}

function fallbackCoverAsset(prompt: string, message = '封面图片生成失败，使用本地参考图兜底并仅在资源元数据保留提示词'): DocumentAsset {
  return {
    id: `asset-cover-${Date.now()}`,
    type: 'image',
    role: 'cover',
    path: '图片素材/干员图片/露娜.png',
    prompt,
    status: 'fallback',
    message,
  };
}

async function generateCoverAsset(template: DocumentTemplate, promptBindings: PromptBinding[], evidence: DocumentEvidence[], projectRoot: string): Promise<DocumentAsset> {
  const active = getActiveModelWithProvider();
  const coverPromptRole = promptBindings.find(binding => binding.roleId === 'delta-cover-image-prompt');
  const configuredPrompt = coverPromptRole ? getPromptContentById(promptBindings, coverPromptRole.promptId) : BUILT_IN_PROMPTS['builtin:delta-cover-image-generation'].content;
  const referenceFiles = [...new Set(evidence.map(item => item.filePath).filter(file => /\.(png|jpe?g|webp)$/iu.test(file)))].slice(0, 6);
  const basePrompt = [
    configuredPrompt,
    `文档标题：${template.outputTitle}`,
    referenceFiles.length ? `参考图片文件：${referenceFiles.join('、')}` : '',
    '画面要求：真实网站/正式文档封面可用，战术小队剪影，地图蓝图线稿，冷色科技 HUD，专业、干净、高清、16:9，预留标题区域。',
  ].filter(Boolean).join('\n');
  if (active?.provider.capabilities?.imageGeneration) {
    const optimized = await callDocumentLlm('你是专业视觉设计提示词专家。请把用户需求优化成英文 SDXL 图片生成提示词，只返回提示词正文。', basePrompt);
    const prompt = optimized && optimized.length > 40 ? optimized : basePrompt;
    const provider = createProvider(providerFactoryName(active.model.provider, active.provider), { baseUrl: active.provider.baseUrl, apiKey: active.provider.apiKey, modelName: active.model.name, directEndpoint: active.provider.directEndpoint });
    if (provider.generateImage) {
      try {
        const image = await provider.generateImage(prompt, { size: '1536x1024', quality: 'high' });
        const diagnostics = validateGeneratedImage(image.data, image.mimeType);
        const fileName = `cover-${Date.now()}.${mimeExtension(image.mimeType)}`;
        const relativePath = saveDocumentImageAsset(projectRoot, fileName, image.data);
        return {
          id: `asset-cover-${Date.now()}`,
          type: 'image',
          role: 'cover',
          path: relativePath,
          prompt: image.revisedPrompt || prompt,
          modelProvider: active.model.provider,
          status: 'generated',
          message: diagnostics.staticPlaceholder
            ? `多模态模型返回固定图片，已保存但需要检查模型图片生成配置；sha256=${diagnostics.hash}`
            : `已调用多模态模型生成封面图片并保存为文档资源；sha256=${diagnostics.hash}`,
        };
      } catch (error) {
        try {
          return await generatedCoverAssetFromUrl(projectRoot, prompt, active.model.provider);
        } catch (fallbackError) {
          return fallbackCoverAsset(prompt, `图片生成失败，且本地化备用生成失败：${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}；原始错误：${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    try {
      return await generatedCoverAssetFromUrl(projectRoot, prompt, active.model.provider);
    } catch (error) {
      return fallbackCoverAsset(prompt, `图片生成备用通道失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return fallbackCoverAsset(basePrompt, '当前模型未开启图片生成能力，使用本地参考图兜底并仅在资源元数据保留提示词');
}

function markdownImage(filePath: string, alt: string) {
  const normalized = filePath.split(path.sep).join('/');
  return `![${alt}](${encodeURI(normalized)})`;
}

function operatorImageGallery() {
  const items = [
    ['露娜', '图片素材/干员图片/露娜.png'],
    ['红狼', '图片素材/干员图片/红狼.png'],
    ['牧羊人', '图片素材/干员图片/牧羊人.png'],
    ['蜂医', '图片素材/干员图片/蜂医.png'],
  ];
  return items.map(([name, file]) => `### ${name}\n\n${markdownImage(file, `${name}干员形象`)}`).join('\n\n');
}

function resourceGallery(resources: ResourceEvidence[], kind: ResourceEvidence['kind']) {
  const files = resources.filter(item => item.kind === kind && ['map', 'image'].includes(item.kind));
  return files.slice(0, 6).map(item => `### ${item.semanticTitle}\n\n${markdownImage(item.filePath, item.semanticTitle)}`).join('\n\n');
}

function hasMapImageMarkdown(markdown: string) {
  return /!\[[^\]]*(?:地图|图纸|零号大坝|航天基地|巴克什|潮汐监狱|AZ3|攀升)[^\]]*\]\([^)]*地图图纸-[^)]*\)/u.test(markdown);
}

function ensureDeltaMapGallery(markdown: string, template: DocumentTemplate, evidence: DocumentEvidence[]) {
  if (template.id !== 'delta-force-hot-operators-guide' || hasMapImageMarkdown(markdown)) return markdown;
  const bundle = buildEvidenceBundle({ id: 'maps', title: '第五章 官方地图图纸和路线理解', purpose: '补齐地图图纸预览', queries: [], requiredFacts: ['地图图纸'] }, evidence);
  const gallery = resourceGallery(bundle.resources, 'map');
  if (!gallery) return markdown;
  const block = `\n\n### 官方完整地图图纸预览\n\n${gallery}\n`;
  const mapHeading = /^## 第五章 官方地图图纸和路线理解\s*$/mu;
  const match = markdown.match(mapHeading);
  if (!match || match.index === undefined) return `${markdown.trimEnd()}${block}\n`;
  const insertAt = match.index + match[0].length;
  return `${markdown.slice(0, insertAt)}${block}${markdown.slice(insertAt)}`;
}

function resourceFileList(resources: ResourceEvidence[]) {
  if (resources.length === 0) return '- 未从知识库检索到可引用资源。';
  return resources.slice(0, 12).map(item => `- ${item.semanticTitle}（${item.kind}）：${item.filePath}；用途：${item.contentUse}`).join('\n');
}

/** 构建三角洲攻略内置模板的可读章节内容（带预设模板文案和资源引用） */
function buildDeltaReadableChapter(chapter: DocumentTemplate['chapters'][number], evidence: DocumentEvidence[], missingFacts: string[]) {
  const table = operatorTable(evidence);
  const bundle = buildEvidenceBundle(chapter, evidence);
  const resourceList = resourceFileList(bundle.resources);
  const mapGallery = resourceGallery(bundle.resources, 'map');
  const imageGallery = resourceGallery(bundle.resources, 'image');
  const sections: Record<string, string[]> = {
    overview: [
      `## ${chapter.title}`,
      '',
      '这份攻略面向刚开始接触《三角洲行动》的玩家，以及想快速理解队伍分工的进阶玩家。核心目标是：先知道热门干员各自负责什么，再根据地图和队伍需求选择合适组合。',
      '',
      '建议阅读方式：先看推荐表，再看队伍搭配，最后结合官方完整地图图纸理解路线。',
    ],
    operators: [
      `## ${chapter.title}`,
      '',
      table || '| 干员 | 定位 | 推荐场景 |\n|---|---|---|\n| 露娜 | 侦察 | 信息侦察和路线判断 |\n| 红狼 | 突击 | 突破和正面交火 |\n| 牧羊人 | 工程 | 防守控场和区域封锁 |\n| 蜂医 | 支援 | 治疗救援和续航 |',
      '',
      '### 干员配图',
      '',
      imageGallery || operatorImageGallery(),
      '',
      '- 露娜：适合先手获取信息，帮队伍判断推进方向。',
      '- 红狼：适合打开突破口，但不要脱离队伍单人深入。',
      '- 牧羊人：适合守点、卡入口和限制敌方推进。',
      '- 蜂医：适合新手优先练习，能显著提高队伍容错。',
    ],
    loadout: [
      `## ${chapter.title}`,
      '',
      '推荐新手队伍至少包含一名侦察和一名支援。侦察负责信息，支援负责救援和续航。需要主动进攻时加入红狼，需要防守或卡点时加入牧羊人。',
      '',
      '常见组合：露娜 + 蜂医 + 红狼，适合主动推进；露娜 + 蜂医 + 牧羊人，适合稳扎稳打和守关键区域。',
    ],
    tables: [
      `## ${chapter.title}`,
      '',
      table || '推荐表暂未生成，请检查表格数据。',
      '',
      '推荐指数用于新手决策参考，不代表绝对强度。实际选择还要结合地图、队友位置和任务目标。',
    ],
    maps: [
      `## ${chapter.title}`,
      '',
      '本章不会硬插固定地图，而是根据知识库检索到的地图、图片、表格、文档附件等资源证据组织内容。',
      '',
      resourceList,
      '',
      mapGallery ? '### 官方完整地图图纸预览' : '',
      '',
      mapGallery,
      '',
      '使用建议：先在完整地图上确认主要区域和撤离/交战路线，再决定侦察位观察点、突击位推进线、工程位控场点和支援位救援路线。',
    ],
    tips: [
      `## ${chapter.title}`,
      '',
      '- 不要只看干员强度，先看队伍缺什么位置。',
      '- 新手优先保证“侦察信息 + 支援续航”，再考虑高风险突破。',
      '- 推进前先用地图确认路线，避免全队挤在同一入口。',
      '- 防守时让工程位处理关键入口，支援位保持在能救人的安全距离。',
    ],
  };
  const content = sections[chapter.id] || [`## ${chapter.title}`, '', evidence.length ? `本章根据已绑定知识库资料整理：${chapter.purpose}` : '本章缺少明确资料。'];
  if (missingFacts.length > 0) content.push('', '### 需人工复核', ...missingFacts.map(item => `- ${item}`));
  return content.join('\n');
}

/** 使用 LLM 生成单章内容，基于证据包、提示词角色和用户需求 */
async function buildLlmChapterContent(template: DocumentTemplate, chapter: DocumentTemplate['chapters'][number], evidence: DocumentEvidence[], missingFacts: string[], promptTexts: string, projectContext: string, requirement?: string) {
  const bundle = buildEvidenceBundle(chapter, evidence);
  const evidenceText = evidenceBundlePrompt(bundle);
  if (!evidenceText.trim()) return undefined;
  const system = [
    '你是专业项目文档生成专家，必须严格使用知识库证据、文件角色、提示词角色和文档规范包生成正式文档章节。',
    '准确性优先级：文档规范包/模板要求 > 已绑定或人工确认的知识库证据 > 自动检索知识库证据 > 项目上下文/历史记忆。',
    '项目上下文/历史记忆只能作为用户偏好、历史纠偏和连续性参考；不得覆盖、替代或改写知识库证据中的事实。',
    '不要编造资料；可以基于证据做合理归纳；输出 Markdown；不要输出代码块；不要输出“资料不足”等调试话术。',
    promptTexts,
  ].filter(Boolean).join('\n\n');
  const prompt = [
    `文档模板：${template.name}`,
    `章节标题：${chapter.title}`,
    `章节目的：${chapter.purpose}`,
    requirement ? `用户要求：${requirement}` : '',
    projectContext ? `项目上下文/历史记忆（仅作偏好、历史纠偏和连续性参考；如与知识库证据冲突，以知识库证据为准）：\n${projectContext}` : '',
    missingFacts.length ? `需要特别补足的事实：${missingFacts.join('、')}` : '',
    '请生成一个专业、丰富、可直接导出的章节，要求：',
    '- 保留章节二级标题；',
    '- 有结论、依据、操作建议/使用建议；',
    '- 引用表格、图片、地图、PDF/Word、文本、附件等资料时写清楚来源文件名；',
    '- 必须理解“结构化资源证据”中每类文件的正文用途，把相关文件和事实对应起来，不要硬插固定文件；',
    '- 如果章节涉及资源文件，应自然说明它与章节结论、操作建议或配图/附件引用的关系；',
    '- 如果章节涉及地图图纸，必须使用 Markdown 图片语法插入对应本地地图文件，例如 ![地图名称](图片素材/干员图片/地图图纸-xxx-官方完整地图图纸.jpg)，不能只写文件名；',
    '- 内容不少于 500 字，结构清晰。',
    '',
    '知识库证据：',
    evidenceText,
  ].filter(Boolean).join('\n');
  const content = await callDocumentLlm(system, prompt);
  if (!content || content.length < 120) return undefined;
  return content.startsWith('## ') ? content : `## ${chapter.title}\n\n${content}`;
}

/** 对生成的 Markdown 进行 LLM 二次审查和优化，检查结构、证据使用和导出合规性 */
async function reviewAndOptimizeMarkdown(input: {
  template: DocumentTemplate;
  spec?: DocumentSpecPackage;
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
    `章节规则：${input.spec.chapterRules.map(rule => `${rule.title}${rule.minWords ? `≥${rule.minWords}字` : ''}`).join('、')}`,
    `门禁规则：${input.spec.gateRules.map(rule => `${rule.name}:${rule.type}`).join('、')}`,
  ].join('\n') : '未绑定文档规范包。';
  const reviewed = await callDocumentLlm([
    '你是文档质量审查与优化专家。你要基于文件角色、提示词角色、文档规范包和知识库证据，对初稿进行二次审查和优化。',
    '准确性优先级：文档规范包/模板要求 > 已绑定或人工确认的知识库证据 > 自动检索知识库证据 > 项目上下文/历史记忆。',
    '项目上下文/历史记忆只能用于风格偏好、历史纠偏和连续性检查；如果与知识库证据冲突，必须以知识库证据为准。',
    '必须保持 Markdown 输出；保留已有图片引用、表格、标题层级和目录；不要删除证据来源；不要编造不存在的事实。',
    '如果正文涉及地图图纸，必须保留或补充对应本地地图文件的 Markdown 图片引用，不能只写文件名。',
    '重点检查：标题、封面、目录、章节完整性、事实来源、所有相关文件类型的资源证据使用、表格呈现、表达专业性、导出友好性。',
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
    '请直接返回优化后的完整 Markdown。',
  ].filter(Boolean).join('\n'));
  if (!reviewed || reviewed.length < input.markdown.length * 0.7 || !reviewed.includes('#')) {
    return { markdown: input.markdown, stage: { type: 'llm_review', roleId: 'llm-review', status: 'skipped', message: '无可用模型或审查结果不可用，保留生成初稿' } };
  }
  return { markdown: reviewed, stage: { type: 'llm_review', roleId: 'llm-review', status: 'success', message: '已完成 LLM 二次审查与优化' } };
}

function formatContextEntries(entries: ReturnType<typeof recallDocumentContexts>) {
  return entries.length > 0
    ? entries.map((entry, index) => `${index + 1}. [${entry.type}/${entry.importance}] ${entry.content}${entry.source ? `（来源：${entry.source}）` : ''}`).join('\n')
    : '';
}

function buildReadableChapterContent(templateId: string, chapter: DocumentTemplate['chapters'][number], evidence: DocumentEvidence[], missingFacts: string[]) {
  if (templateId === 'delta-force-hot-operators-guide') return buildDeltaReadableChapter(chapter, evidence, missingFacts);
  return [
    `## ${chapter.title}`,
    '',
    evidence.length > 0 ? `本章根据知识库资料整理：${chapter.purpose}` : '模板绑定资料未检索到明确内容，需进一步确认。',
    '',
    ...evidence.slice(0, 5).map(item => `- ${item.filePath}：${item.content.replace(/\s+/gu, ' ').slice(0, 180)}`),
    ...(missingFacts.length > 0 ? ['', '### 待确认事项', ...missingFacts.map(item => `- ${item}：建议人工复核或补充更明确资料。`)] : []),
  ].join('\n');
}

function validateDraft(chapters: DocumentDraftChapter[], facts: Record<string, string>, structuredFacts: DocumentFact[] = [], template?: DocumentTemplate) {
  const warnings: string[] = [];
  const errors: string[] = [];
  for (const chapter of chapters) {
    if (chapter.evidence.length === 0) warnings.push(`${chapter.title} 未检索到资料证据`);
    if (chapter.content.length < 80) warnings.push(`${chapter.title} 内容较短，建议人工补充或重新生成`);
  }
  if (!template?.documentSpecId) {
    for (const key of ['工程名称', '工期要求', '质量目标', '施工范围']) {
      if (!facts[key] && !structuredFacts.some(fact => fact.key === key)) warnings.push(`${key} 未形成明确事实，请人工确认`);
    }
  }
  if (template && templateFileBindings(template).length === 0) errors.push('模板未绑定任何知识库文件');
  if (template && templatePromptBindings(template).length === 0) errors.push('模板未绑定任何提示词');
  const roleIds = new Set(structuredFacts.map(fact => fact.roleId));
  for (const requiredRole of ['project_fact', 'rule']) {
    if (template?.fileBindings?.some(binding => binding.roleId === requiredRole) && !roleIds.has(requiredRole)) warnings.push(`${requiredRole} 角色未抽取到结构化事实`);
  }
  return { passed: errors.length === 0, warnings, errors };
}

function coverAssetMarkdown(asset?: DocumentAsset) {
  const imageRef = asset?.path || '图片素材/干员图片/露娜.png';
  return markdownImage(imageRef, '三角洲行动攻略封面图');
}

export function composeDocumentMarkdown(draft: Omit<GeneratedDocumentDraft, 'markdown'>): string {
  const coverAsset = draft.assets?.find(asset => asset.role === 'cover' && asset.type === 'image');
  return [
    `<div class="document-cover">`,
    `# ${draft.title}`,
    '',
    draft.templateId === 'delta-force-hot-operators-guide' ? coverAssetMarkdown(coverAsset) : '',
    '',
    `**文档版本**：V1.0  `,
    `**生成时间**：${new Date(draft.generatedAt).toLocaleString('zh-CN')}  `,
    `**文档类型**：内置模板生成的生产级示例文档  `,
    draft.requirement ? `**生成要求**：${draft.requirement}  ` : '',
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
    '## 核心结论',
    '',
    draft.templateId === 'delta-force-hot-operators-guide'
      ? ['- 新手优先选择“露娜 + 蜂医”建立信息和续航基础。', '- 需要主动突破时加入红狼，需要稳守关键点时加入牧羊人。', '- 地图章节使用官方完整地图图纸，不使用单个瓦片截图。'].join('\n')
      : Object.keys(draft.facts).length > 0
        ? ['| 事实项 | 依据 |', '|---|---|', ...Object.entries(draft.facts).slice(0, 12).map(([key, value]) => `| ${key} | ${value.replace(/\|/gu, ' ').slice(0, 160)} |`)].join('\n')
        : '未抽取到明确事实，需人工确认。',
    '',
    ...draft.chapters.flatMap(chapter => [chapter.content, '']),
    '## 资料来源清单',
    '',
    '| 文件 | 引用次数 |',
    '|---|---:|',
    ...draft.sources.map(source => `| ${source.filePath} | ${source.count} |`),
    '',
    ...(draft.templateId === 'delta-force-hot-operators-guide' ? [] : [
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
    ]),
  ].join('\n');
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new Error('用户中止');
}

/** 文档生成主入口：依次执行角色绑定、知识检索、文件理解、事实抽取、章节生成、封面生成、LLM 审查和导出校验，返回完整文档草稿 */
export async function generateDocumentDraft(input: { templateId: string; requirement?: string; maxEvidencePerChapter?: number; projectRoot?: string; signal?: AbortSignal; onProgress?: (stages: DocumentExecutionStage[]) => void }): Promise<GeneratedDocumentDraft> {
  throwIfAborted(input.signal);
  const template = getDocumentTemplate(input.templateId);
  if (!template) throw new Error('Document template not found');
  const projectRoot = ensureBuiltInKnowledgeBase(input.projectRoot || getProjectRoot());
  if (!projectRoot) throw new Error('No knowledge base project found');
  const manager = getMultiProjectManager();
  const maxEvidence = Math.max(5, Math.min(30, input.maxEvidencePerChapter ?? 12));
  const promptBindings = templatePromptBindings(template);
  const fileBindings = templateFileBindings(template);
  const documentSpec = getDocumentSpec(template.documentSpecId);
  const promptTexts = readPromptContents(promptBindings).map(item => `## [${item.roleId}] ${item.name}\n${item.content}`).join('\n\n');
  const fileBindingKeys = (filePath: string) => [filePath, path.isAbsolute(filePath) ? path.relative(projectRoot, filePath) : path.join(projectRoot, filePath)];
  const boundFilePaths = new Set(fileBindings.flatMap(binding => fileBindingKeys(binding.filePath)));
  const allFileRoles = listDocumentRoles('file');
  const fileRoleByPath = new Map(fileBindings.flatMap(binding => fileBindingKeys(binding.filePath).map(key => [key, binding.roleId] as const)));
  const fileProcessingByPath = new Map(fileBindings.flatMap(binding => fileBindingKeys(binding.filePath).map(key => [key, allFileRoles.find(role => role.id === binding.roleId)?.processingType || 'reference'] as const)));
  const project = await manager.getProject(projectRoot);
  await project.incrementalIndex();
  throwIfAborted(input.signal);
  const chapterDrafts: DocumentDraftChapter[] = [];
  const allEvidence: DocumentEvidence[] = [];
  const missingItems: string[] = [];
  const chapterGenerationStages: DocumentExecutionStage[] = [];
  const progressStages: DocumentExecutionStage[] = [];
  const contextQuery = [template.name, template.outputTitle, input.requirement, ...template.chapters.flatMap(chapter => [chapter.title, chapter.purpose])].filter(Boolean).join(' ');
  const projectContextEntries = recallDocumentContexts(contextQuery, 8, projectRoot);
  const projectContext = formatContextEntries(projectContextEntries);
  const contextStage: DocumentExecutionStage = {
    type: 'context_recall',
    roleId: 'project-memory',
    status: projectContextEntries.length > 0 ? 'success' : 'skipped',
    message: projectContextEntries.length > 0 ? `已注入 ${projectContextEntries.length} 条短期/长期上下文` : '未召回可用项目上下文',
  };

  // 第一个进度回调：角色绑定完成
  progressStages.push({ type: 'role_binding', roleId: template.projectRoleConfigId || 'none', status: 'success', message: `已绑定 ${fileBindings.length} 个文件角色、${promptBindings.length} 个提示词角色` });
  progressStages.push(contextStage);
  input.onProgress?.([...progressStages]);

  for (const chapter of template.chapters) {
    throwIfAborted(input.signal);
    try {
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
    const pinnedEvidencePaths = new Set(chapter.pinnedEvidenceFilePaths || []);
    const chapterPinnedPaths = new Set([...pinnedEvidencePaths, ...boundFilePaths]);
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
    for (const binding of fileBindings) {
      rawEvidence.push(...evidenceFromBoundFile(binding.filePath, binding.roleId, allFileRoles.find(role => role.id === binding.roleId)?.processingType || 'reference', chapter.id, projectRoot));
    }
    const evidence = uniqueEvidence(rawEvidence, maxEvidence);
    allEvidence.push(...evidence);
    const missingFacts = chapter.requiredFacts.filter(fact => !evidence.some(item => evidenceMatchesFact(item, fact)));
    if (evidence.length === 0) missingItems.push(`${chapter.title}：未检索到明确资料依据`);
    for (const fact of missingFacts) missingItems.push(`${chapter.title}：${fact} 未检索到明确依据`);
    // 证据检索完成 → 立即汇报进度
    if (!progressStages.some(s => s.type === 'knowledge_retrieval')) {
      progressStages.push({ type: 'knowledge_retrieval', roleId: 'knowledge-base', status: (allEvidence.length > 0 ? 'success' : 'fallback'), message: `已检索/绑定 ${allEvidence.length} 条证据` });
      input.onProgress?.([...progressStages]);
    }

    throwIfAborted(input.signal);
    const llmContent = await Promise.race([
      buildLlmChapterContent(template, chapter, evidence, missingFacts, promptTexts, projectContext, input.requirement),
      new Promise<null>(resolve => setTimeout(() => resolve(null), 60000)),
    ]);
    throwIfAborted(input.signal);
    const content = llmContent || buildReadableChapterContent(template.id, chapter, evidence, missingFacts);
    chapterGenerationStages.push({
      type: 'chapter_generation',
      roleId: 'chapter_generation',
      promptId: promptBindings.find(binding => binding.roleId === 'chapter_generation')?.promptId,
      status: llmContent ? 'success' : 'fallback',
      message: llmContent ? `${chapter.title} 已由大模型生成` : `${chapter.title} 使用本地专业兜底生成`,
    });
    chapterDrafts.push({ id: chapter.id, title: chapter.title, content, evidence, missingFacts });
    } catch (err) {
      if (input.signal?.aborted) throw err;
      console.error(`[gen] chapter ${chapter.title} failed:`, err);
      chapterGenerationStages.push({
        type: 'chapter_generation',
        roleId: 'chapter_generation',
        status: 'failed',
        message: `${chapter.title} 生成失败`,
      });
    }
    // 章节生成完成（成功或失败）→ 汇报进度
    if (!progressStages.some(s => s.type === 'chapter_generation' && s.message === chapterGenerationStages[chapterGenerationStages.length - 1]?.message)) {
      progressStages.push(chapterGenerationStages[chapterGenerationStages.length - 1]!);
    }
    input.onProgress?.([...progressStages]);
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
  const localFacts = extractStructuredFacts(allEvidence, template, documentSpec);
  let llmExtraction: { facts: DocumentFact[]; stages: DocumentExecutionStage[] } = { facts: [], stages: [] };
  try { llmExtraction = await extractFactsWithLlm(allEvidence, promptTexts, template, documentSpec); } catch (err) { if (input.signal?.aborted) throw err; console.error('[gen] fact extraction failed:', err); }
  throwIfAborted(input.signal);
  const structuredFacts = [...localFacts, ...llmExtraction.facts];

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
  const enhancementStage: DocumentExecutionStage = {
    type: 'reference',
    roleId: 'quality-enhancement',
    status: allEvidence.length > 0 ? 'success' : 'skipped',
    message: `增强贡献：知识库证据 ${allEvidence.length} 条，人工确认/固定证据 ${pinnedEvidenceCount} 条，项目上下文 ${projectContextEntries.length} 条，自动检索证据 ${autoEvidenceCount} 条`,
  };
  progressStages.push(enhancementStage);
  input.onProgress?.([...progressStages]);
  for (const fact of structuredFacts) facts[fact.key] = `${fact.value}（来源：${fact.sourceFile}，角色：${fact.roleId}）`;
  const sourceCounts = new Map<string, number>();
  for (const item of allEvidence) sourceCounts.set(item.filePath, (sourceCounts.get(item.filePath) ?? 0) + 1);
  const sources = [...sourceCounts.entries()].sort((a, b) => b[1] - a[1]).map(([filePath, count]) => ({ filePath, count }));
  const factsModel = buildFactsModel(structuredFacts, structuredTables, missingItems, documentSpec);
  const validation = validateDraft(chapterDrafts, facts, structuredFacts, template);
  let validationIssues = buildValidationIssues(validation, factsModel, chapterDrafts, template);
  const assets = template.id === 'delta-force-hot-operators-guide' ? [await generateCoverAsset(template, promptBindings, allEvidence, projectRoot)] : [];
  const executionStages: DocumentExecutionStage[] = [
    { type: 'role_binding', roleId: template.projectRoleConfigId || 'none', status: fileBindings.length > 0 ? 'success' : 'fallback', message: `已绑定 ${fileBindings.length} 个文件角色、${promptBindings.length} 个提示词角色` },
    contextStage,
    { type: 'knowledge_retrieval', roleId: 'knowledge-base', status: allEvidence.length > 0 ? 'success' : 'fallback', message: `已检索/绑定 ${allEvidence.length} 条证据` },
    enhancementStage,
    fileUnderstanding.stage,
    ...llmExtraction.stages,
    ...chapterGenerationStages,
    ...assets.map(asset => ({ type: 'asset_generation' as const, roleId: 'delta-cover-image-prompt', status: asset.status === 'fallback' ? 'fallback' as const : 'success' as const, message: asset.message })),
    { type: 'validation', roleId: 'document-workflow', status: validation.errors.length > 0 ? 'failed' : 'success', message: `错误 ${validation.errors.length}，警告 ${validation.warnings.length}` },
    { type: 'formatting', roleId: 'document-workflow', status: 'success', message: '已生成正式排版 Markdown' },
    { type: 'export_ready', roleId: 'document-workflow', status: validation.errors.length > 0 ? 'failed' : 'success', message: validation.errors.length > 0 ? '导出门禁存在阻断项' : '已准备好导出 Markdown/HTML/DOCX/PDF' },
  ];
  const base = {
    templateId: template.id,
    templateName: template.name,
    title: template.outputTitle,
    requirement: input.requirement || '',
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
  const review = await reviewAndOptimizeMarkdown({ template, spec: documentSpec, markdown: initialMarkdown, evidence: allEvidence, promptTexts, projectContext, requirement: input.requirement });
  throwIfAborted(input.signal);
  const reviewedStages = [...executionStages, review.stage];
  validationIssues = applySpecGateRules(documentSpec, validationIssues, factsModel, chapterDrafts, review.markdown, fileBindings, promptBindings);
  const exportGate = buildExportGate(validationIssues, factsModel, chapterDrafts);
  const finalBase = { ...base, validationIssues, exportGate, executionStages: reviewedStages };
  const reviewedMarkdown = review.markdown === initialMarkdown ? composeDocumentMarkdown(finalBase) : review.markdown;
  const markdown = ensureDeltaMapGallery(reviewedMarkdown, template, allEvidence);
  return { ...finalBase, markdown };
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
