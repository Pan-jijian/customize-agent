import * as path from 'node:path';
import { listKnowledgeFiles } from '../knowledge/kbService';
import type { DocumentEvidence, DocumentTemplate, DocumentTemplateChapter, ProjectBinding } from './types';
import { cleanEvidenceText, selectEvidenceByBudget } from './evidence';

export type MaterialKind =
  | 'tender_document'
  | 'bill_of_quantities'
  | 'drawing'
  | 'addendum'
  | 'contract'
  | 'technical_specification'
  | 'schedule_document'
  | 'quality_safety_document'
  | 'other';

export interface MaterialFileProfile {
  filePath: string;
  fileName: string;
  kind: MaterialKind;
  confidence: number;
  priority: number;
  chunkCount?: number;
  summary: string;
  keySignals: string[];
}

export interface ProjectMaterialProfile {
  projectName: string;
  materialRoots: string[];
  files: MaterialFileProfile[];
  groups: Record<MaterialKind, MaterialFileProfile[]>;
  warnings: string[];
}

export interface ChapterMaterialPlan {
  chapterId: string;
  chapterTitle: string;
  writingGoal: string;
  mustUseMaterialKinds: MaterialKind[];
  evidenceQueries: Record<MaterialKind, string[]>;
  mustCover: string[];
  avoidWriting: string[];
}

export interface ProjectUnderstanding {
  profile: ProjectMaterialProfile;
  globalWritingFocus: string[];
  chapterPlans: ChapterMaterialPlan[];
  prompt: string;
}

type KnowledgeFile = { relativePath: string; chunkCount?: number; indexedAt?: number; status?: string };

const ALL_KINDS: MaterialKind[] = ['tender_document', 'bill_of_quantities', 'drawing', 'addendum', 'contract', 'technical_specification', 'schedule_document', 'quality_safety_document', 'other'];

const KIND_LABELS: Record<MaterialKind, string> = {
  tender_document: '招标文件正文',
  bill_of_quantities: '工程量清单',
  drawing: '图纸/设计资料',
  addendum: '补疑/澄清/答疑',
  contract: '合同资料',
  technical_specification: '技术规范/技术要求',
  schedule_document: '工期/进度资料',
  quality_safety_document: '质量安全文明资料',
  other: '其他资料',
};

const KIND_PRIORITY: Record<MaterialKind, number> = {
  addendum: 100,
  tender_document: 90,
  contract: 80,
  technical_specification: 75,
  bill_of_quantities: 70,
  drawing: 65,
  schedule_document: 60,
  quality_safety_document: 60,
  other: 10,
};

export function materialKindLabel(kind: MaterialKind) {
  return KIND_LABELS[kind] || '其他资料';
}

function isUsableKnowledgeFile(file: KnowledgeFile) {
  return file.status !== 'disk' && file.status !== 'error' && Number(file.indexedAt || 0) > 0 && Number(file.chunkCount || 0) > 0;
}

function normalizePathKey(filePath: string) {
  return filePath.replace(/\\/gu, '/').replace(/^\/+|\/+$/gu, '');
}

function topLevelGroup(relativePath: string) {
  const parts = normalizePathKey(relativePath).split('/').filter(Boolean);
  return parts.length > 1 ? parts[0] : path.basename(parts[0] || '当前项目');
}

function cleanProjectName(value: string) {
  return value.replace(/\.(?:pdf|docx?|xlsx?|xls|dwg|zip)$/iu, '').replace(/^\d+(?:\.\d+)?[-_\s]*/u, '').trim();
}

export function inferMaterialKind(filePath: string): { kind: MaterialKind; confidence: number; signals: string[] } {
  const text = normalizePathKey(filePath).toLowerCase();
  const raw = filePath;
  const signals: string[] = [];
  const hit = (pattern: RegExp, signal: string) => {
    pattern.lastIndex = 0;
    if (!pattern.test(raw) && !pattern.test(text)) return false;
    signals.push(signal);
    return true;
  };
  if (hit(/补疑|答疑|澄清|疑问回复|答复|变更|更正|补充通知|addendum|clarification/iu, '补疑/澄清关键词')) return { kind: 'addendum', confidence: 0.92, signals };
  if (hit(/清单|工程量|分部分项|措施项目|项目特征|招标控制价|boq|bill.?of.?quantities/iu, '清单/工程量关键词')) return { kind: 'bill_of_quantities', confidence: 0.9, signals };
  if (hit(/图纸|施工图|建筑图|结构图|安装图|设计图|总平|平面图|立面图|剖面图|节点|dwg|drawing|cad/iu, '图纸/设计关键词')) return { kind: 'drawing', confidence: 0.88, signals };
  if (hit(/招标文件|投标人须知|评标办法|招标公告|招标正文|招标需求|tender|bidding/iu, '招标文件关键词')) return { kind: 'tender_document', confidence: 0.9, signals };
  if (hit(/合同|协议书|专用条款|通用条款|contract/iu, '合同关键词')) return { kind: 'contract', confidence: 0.82, signals };
  if (hit(/技术规范|技术要求|施工规范|验收规范|标准|做法说明|specification|standard/iu, '技术规范关键词')) return { kind: 'technical_specification', confidence: 0.8, signals };
  if (hit(/工期|进度|计划|节点|里程碑|schedule/iu, '工期进度关键词')) return { kind: 'schedule_document', confidence: 0.72, signals };
  if (hit(/质量|安全|文明|环保|危大|验收|quality|safety/iu, '质量安全关键词')) return { kind: 'quality_safety_document', confidence: 0.72, signals };
  return { kind: 'other', confidence: 0.35, signals: ['未命中明确资料类型，按其他资料处理'] };
}

function selectMaterialFiles(files: KnowledgeFile[], bindings?: ProjectBinding[]) {
  const active = files.filter(isUsableKnowledgeFile);
  const roots = (bindings || []).map(binding => normalizePathKey(binding.materialRootPath)).filter(Boolean);
  if (roots.length === 0) return { files: active, roots: [...new Set(active.map(file => topLevelGroup(file.relativePath)).filter(Boolean))], warnings: ['模板未显式绑定项目资料包，已使用当前知识库全部可用资料。'] };
  const selected = active.filter(file => roots.some(root => normalizePathKey(file.relativePath) === root || normalizePathKey(file.relativePath).startsWith(`${root}/`)));
  return { files: selected, roots, warnings: selected.length === 0 ? ['项目资料包下未找到已完成索引的可用文件。'] : [] };
}

export function templateProjectBindings(template: DocumentTemplate): ProjectBinding[] {
  return (template.projectBindings || []).filter(binding => binding.materialRootPath).map(binding => ({ materialRootPath: normalizePathKey(binding.materialRootPath) }));
}

export function expandProjectMaterialBindings(projectRoot: string, template: DocumentTemplate) {
  const files = listKnowledgeFiles(projectRoot);
  const selection = selectMaterialFiles(files, templateProjectBindings(template));
  return selection.files.map(file => file.relativePath);
}

export function buildProjectMaterialProfile(projectRoot: string, template: DocumentTemplate): ProjectMaterialProfile {
  const files = listKnowledgeFiles(projectRoot);
  const selection = selectMaterialFiles(files, templateProjectBindings(template));
  const groups: Record<MaterialKind, MaterialFileProfile[]> = { tender_document: [], bill_of_quantities: [], drawing: [], addendum: [], contract: [], technical_specification: [], schedule_document: [], quality_safety_document: [], other: [] };
  const profiles = selection.files.map(file => {
    const inferred = inferMaterialKind(file.relativePath);
    const profile: MaterialFileProfile = {
      filePath: file.relativePath,
      fileName: path.basename(file.relativePath),
      kind: inferred.kind,
      confidence: inferred.confidence,
      priority: KIND_PRIORITY[inferred.kind],
      chunkCount: file.chunkCount,
      summary: `${materialKindLabel(inferred.kind)}：${path.basename(file.relativePath)}，可用切片 ${file.chunkCount || 0} 条。`,
      keySignals: inferred.signals,
    };
    groups[inferred.kind].push(profile);
    return profile;
  }).sort((a, b) => b.priority - a.priority || b.confidence - a.confidence);
  const projectName = cleanProjectName(selection.roots[0] || topLevelGroup(profiles[0]?.filePath || '') || '当前知识库项目');
  const warnings = [...selection.warnings];
  if (groups.tender_document.length === 0) warnings.push('未识别到招标文件正文，工程概况、招标响应和评审要求可能不足。');
  if (groups.bill_of_quantities.length === 0) warnings.push('未识别到工程量清单，施工范围、资源配置和主要工程内容可能不足。');
  if (groups.drawing.length === 0) warnings.push('未识别到图纸/设计资料，施工方法、专业接口和构造做法可能不足。');
  return { projectName, materialRoots: selection.roots, files: profiles, groups, warnings };
}

function chapterKinds(title: string): MaterialKind[] {
  if (/概况|工程|项目|总体/u.test(title)) return ['tender_document', 'addendum', 'bill_of_quantities'];
  if (/部署|组织|平面|准备/u.test(title)) return ['tender_document', 'bill_of_quantities', 'drawing', 'addendum'];
  if (/施工|工艺|技术|方案|方法|分部分项/u.test(title)) return ['bill_of_quantities', 'drawing', 'technical_specification', 'addendum'];
  if (/进度|工期/u.test(title)) return ['tender_document', 'addendum', 'schedule_document', 'bill_of_quantities'];
  if (/质量|验收/u.test(title)) return ['tender_document', 'technical_specification', 'drawing', 'quality_safety_document', 'addendum'];
  if (/安全|文明|环保|风险|危大/u.test(title)) return ['tender_document', 'quality_safety_document', 'drawing', 'addendum'];
  if (/资源|材料|设备|劳动力|机械/u.test(title)) return ['bill_of_quantities', 'drawing', 'tender_document'];
  return ['tender_document', 'bill_of_quantities', 'drawing', 'addendum', 'technical_specification'];
}

function queriesForKind(chapter: DocumentTemplateChapter, kind: MaterialKind) {
  const sections = (chapter.sections || []).slice(0, 8).join(' ');
  const facts = chapter.requiredFacts.slice(0, 8).join(' ');
  const base = `${chapter.title} ${sections} ${facts}`.trim();
  const byKind: Record<MaterialKind, string[]> = {
    tender_document: [base, `${chapter.title} 招标范围 工期 质量 标准 评审 响应要求`, '项目概况 招标范围 投标文件 技术标 施工组织设计'],
    bill_of_quantities: [base, `${chapter.title} 工程量清单 分部分项 项目特征 数量 单位`, '清单 工程内容 主要分部分项 工程量 项目特征'],
    drawing: [base, `${chapter.title} 图纸 设计说明 构造做法 施工部位 节点`, '图纸 设计说明 平面 节点 构造 做法 专业接口'],
    addendum: [base, `${chapter.title} 补疑 澄清 答疑 变更 修正`, '补疑 澄清 答疑 招标文件 清单 图纸 修正'],
    contract: [base, `${chapter.title} 合同 条款 履约 责任 验收`],
    technical_specification: [base, `${chapter.title} 技术规范 施工要求 验收标准 控制要点`],
    schedule_document: [base, `${chapter.title} 工期 进度 节点 计划 里程碑`],
    quality_safety_document: [base, `${chapter.title} 质量 安全 文明 环保 验收 风险`],
    other: [base],
  };
  return [...new Set(byKind[kind].filter(Boolean))];
}

export function buildProjectUnderstanding(template: DocumentTemplate, profile: ProjectMaterialProfile): ProjectUnderstanding {
  const globalWritingFocus = [
    `本次文档必须围绕项目资料包“${profile.projectName}”展开，不得把其他项目资料混入正文。`,
    '招标文件正文用于确定项目边界、招标响应、工期质量安全目标和评审关注点。',
    '工程量清单用于确定主要工程内容、分部分项、项目特征、资源配置和施工方法依据。',
    '图纸/设计资料用于确定施工对象、空间关系、构造做法、专业接口和重点难点。',
    '补疑/澄清/答疑属于高优先级修正资料，如与原文件冲突，以补疑/澄清/答疑为准。',
  ];
  const chapterPlans = template.chapters.map(chapter => {
    const kinds: MaterialKind[] = chapterKinds(chapter.title).filter(kind => profile.groups[kind]?.length > 0);
    const fallbackKinds: MaterialKind[] = ['tender_document', 'bill_of_quantities', 'drawing'];
    const mustUseMaterialKinds: MaterialKind[] = kinds.length ? kinds : fallbackKinds.filter(kind => profile.groups[kind]?.length > 0);
    return {
      chapterId: chapter.id,
      chapterTitle: chapter.title,
      writingGoal: `围绕“${chapter.title}”组织本项目资料事实，优先体现招标要求、清单工程内容、图纸施工对象和补疑修正口径。`,
      mustUseMaterialKinds,
      evidenceQueries: Object.fromEntries(ALL_KINDS.map(kind => [kind, queriesForKind(chapter, kind)])) as Record<MaterialKind, string[]>,
      mustCover: [chapter.purpose, ...(chapter.sections || []), ...chapter.requiredFacts].filter(Boolean).slice(0, 16),
      avoidWriting: ['不得脱离项目资料泛泛套写通用内容', '不得编造资料未确认的数字、日期、金额、工程量、规格和标准', '不得忽略补疑/澄清对原始资料的修正'],
    };
  });
  const prompt = projectUnderstandingPrompt({ profile, globalWritingFocus, chapterPlans });
  return { profile, globalWritingFocus, chapterPlans, prompt };
}

export function projectUnderstandingPrompt(input: { profile: ProjectMaterialProfile; globalWritingFocus: string[]; chapterPlans: ChapterMaterialPlan[] }) {
  const { profile } = input;
  const inventoryLines = ALL_KINDS
    .map(kind => `${materialKindLabel(kind)}：${profile.groups[kind].length ? profile.groups[kind].map(file => `${file.fileName}(${file.chunkCount || 0})`).join('、') : '未识别'}`)
    .join('\n');
  const chapterLines = input.chapterPlans.map((plan, index) => [
    `${index + 1}. ${plan.chapterTitle}`,
    `   - 写作目标：${plan.writingGoal}`,
    `   - 必用资料类型：${plan.mustUseMaterialKinds.map(materialKindLabel).join('、') || '按现有资料综合使用'}`,
    `   - 必须覆盖：${plan.mustCover.join('、') || '按章节目标展开'}`,
    `   - 禁止：${plan.avoidWriting.join('；')}`,
  ].join('\n')).join('\n');
  return [
    '## 项目资料理解模型',
    `项目资料包：${profile.projectName}`,
    `资料根目录：${profile.materialRoots.join('、') || '当前知识库全部资料'}`,
    '资料类型清单：',
    inventoryLines,
    profile.warnings.length ? `资料风险：${profile.warnings.join('；')}` : '',
    '全局写作重点：',
    ...input.globalWritingFocus.map(item => `- ${item}`),
    '章节资料使用计划：',
    chapterLines,
  ].filter(Boolean).join('\n');
}

export function materialKindMaps(profile: ProjectMaterialProfile) {
  const kindByPath = new Map<string, MaterialKind>();
  const processingByPath = new Map<string, string>();
  for (const file of profile.files) {
    kindByPath.set(file.filePath, file.kind);
    processingByPath.set(file.filePath, file.kind === 'drawing' ? 'drawing' : file.kind === 'bill_of_quantities' ? 'table' : file.kind === 'technical_specification' ? 'specification' : file.kind === 'tender_document' || file.kind === 'addendum' ? 'rule' : 'reference');
  }
  return { kindByPath, processingByPath };
}

export function materialRoleId(kind?: MaterialKind) {
  return kind || 'other';
}

export function materialProcessingType(kind?: MaterialKind) {
  if (kind === 'drawing') return 'drawing';
  if (kind === 'bill_of_quantities') return 'table';
  if (kind === 'technical_specification') return 'specification';
  if (kind === 'tender_document' || kind === 'addendum') return 'rule';
  return 'reference';
}

export async function retrievePlannedMaterialEvidence(input: {
  manager: { search: (projectRoot: string, query: string, options: any) => Promise<{ results: Array<{ filePath: string; score: number; content: string; sectionTitle?: string; source?: string }> }> };
  projectRoot: string;
  chapter: DocumentTemplateChapter;
  plan?: ChapterMaterialPlan;
  profile: ProjectMaterialProfile;
  scopedFilePaths: string[];
  limitPerQuery: number;
  signal?: AbortSignal;
}) {
  const evidence: DocumentEvidence[] = [];
  if (!input.plan) return evidence;
  for (const kind of input.plan.mustUseMaterialKinds) {
    const filePaths = input.profile.groups[kind].map(file => file.filePath).filter(filePath => input.scopedFilePaths.includes(filePath));
    if (filePaths.length === 0) continue;
    for (const query of input.plan.evidenceQueries[kind].slice(0, 3)) {
      if (input.signal?.aborted) throw new Error('aborted');
      const result = await input.manager.search(input.projectRoot, query, { scope: 'project', filters: { filePaths }, limit: input.limitPerQuery, weights: { keyword: 0.68, vector: 0.25, rewrite: 0.85, hybridBonus: 0.3 }, generationMode: false });
      evidence.push(...result.results.filter(item => filePaths.includes(item.filePath)).map(item => ({
        chapterId: input.chapter.id,
        filePath: item.filePath,
        score: item.score + (KIND_PRIORITY[kind] / 100) + 2,
        content: item.content,
        roleId: materialRoleId(kind),
        processingType: materialProcessingType(kind),
        sectionTitle: item.sectionTitle,
        source: `material-plan:${kind}`,
      })));
    }
  }
  return selectEvidenceByBudget(evidence, { maxItems: 48, maxChars: 52000, preservePinned: true });
}

export function sampleProjectMaterialEvidence(input: { project: { getFileDetail?: (relativePath: string, options?: { maxChunkContentChars?: number }) => { file: { relativePath: string }; chunks: Array<{ content: string; sectionTitle?: string }>; totalChunkCount?: number } | undefined }; chapter: DocumentTemplateChapter; plan?: ChapterMaterialPlan; profile: ProjectMaterialProfile; scopedFilePaths: string[]; highRisk?: boolean }) {
  const evidence: DocumentEvidence[] = [];
  const plannedKinds = new Set(input.plan?.mustUseMaterialKinds || []);
  const files = input.profile.files.filter(file => input.scopedFilePaths.includes(file.filePath) && (plannedKinds.size === 0 || plannedKinds.has(file.kind))).slice(0, input.highRisk ? 80 : 40);
  const tokens = [input.chapter.title, ...(input.chapter.sections || []), ...input.chapter.requiredFacts].filter(Boolean);
  for (const file of files) {
    const detail = input.project.getFileDetail?.(file.filePath, { maxChunkContentChars: input.highRisk ? 24000 : 12000 });
    if (!detail?.chunks?.length) continue;
    const ranked = detail.chunks.map((chunk, index) => {
      const content = cleanEvidenceText(chunk.content);
      const text = `${chunk.sectionTitle || ''}\n${content}`;
      const hits = tokens.filter(token => text.includes(token)).length;
      const numericBonus = /\d+(?:\.\d+)?\s*(?:日历天|天|月|年|万元|元|㎡|m²|m³|米|mm|台|套|人|项|%|MPa|kPa)/u.test(content) ? 1 : 0;
      return { chunk, index, score: hits * 0.8 + numericBonus + (index === 0 ? 0.4 : 0) + file.priority / 120 };
    }).filter(item => item.score > 0).sort((a, b) => b.score - a.score).slice(0, input.highRisk ? 6 : 3);
    for (const item of ranked) evidence.push({
      chapterId: input.chapter.id,
      filePath: detail.file.relativePath,
      score: 1.8 + item.score,
      content: item.chunk.content,
      roleId: materialRoleId(file.kind),
      processingType: materialProcessingType(file.kind),
      sectionTitle: item.chunk.sectionTitle,
      source: 'project-material-sample',
    });
  }
  return selectEvidenceByBudget(evidence, { maxItems: input.highRisk ? 60 : 30, maxChars: input.highRisk ? 60000 : 30000, preservePinned: true });
}
