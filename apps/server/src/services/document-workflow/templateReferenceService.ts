/**
 * 模板参考库服务：用户上传的优秀入围施组文件的独立存储与质量画像管理。
 * 红线：参考文件独立存放于 ~/.customize-agent/template-references/，
 * 永不进入知识库检索通道、永不作为生成的事实材料——仅用于质量对标与结构范式参考。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FileClassifier, ContentExtractor } from '@customize-agent/knowledge';
import { buildReferenceQualityProfile, suggestProjectType, type ReferenceProjectType, type ReferenceQualityProfile } from './referenceQualityProfile';

export interface TemplateReferenceRecord {
  id: string;
  fileName: string;
  projectType: ReferenceProjectType;
  /** 工程类型来源：手动标注或系统自动分类建议 */
  typeSource: 'manual' | 'auto';
  uploadedAt: number;
  fileSize: number;
  /** 原文相对存储目录的路径 */
  filePath: string;
  status: 'parsing' | 'ready' | 'failed';
  errorMessage?: string;
  qualityProfile?: ReferenceQualityProfile;
  /** 画像计算逻辑版本：与 PROFILE_VERSION 不符的旧画像在读取前自动重算，保证口径升级后沉淀数据仍准确 */
  profileVersion?: number;
  /** 是否该工程类型的主参考（用于默认对标基准） */
  isPrimary?: boolean;
}

/**
 * 画像计算逻辑版本。提取口径变更（层级分层/正则修复等）时必须递增，
 * 否则已入库文件的旧画像不会重算，页面会持续展示口径错误的数据。
 */
export const PROFILE_VERSION = 2;

function referencesRoot() {
  const dir = path.join(os.homedir(), '.customize-agent', 'template-references');
  fs.mkdirSync(path.join(dir, 'files'), { recursive: true });
  return dir;
}

function referencesIndexPath() {
  return path.join(referencesRoot(), 'references.json');
}

/** 读取参考库索引（容错：损坏时备份并重置） */
function readIndex(): TemplateReferenceRecord[] {
  try {
    const file = referencesIndexPath();
    if (!fs.existsSync(file)) return [];
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown;
    return Array.isArray(raw) ? (raw as TemplateReferenceRecord[]) : [];
  } catch {
    return [];
  }
}

function writeIndex(records: TemplateReferenceRecord[]) {
  fs.writeFileSync(referencesIndexPath(), JSON.stringify(records, null, 2), 'utf-8');
}

/** 列出全部参考文件 */
export function listTemplateReferences(): TemplateReferenceRecord[] {
  return readIndex().sort((a, b) => b.uploadedAt - a.uploadedAt);
}

/** 按工程类型列出参考文件 */
export function listTemplateReferencesByType(type: ReferenceProjectType): TemplateReferenceRecord[] {
  return listTemplateReferences().filter(item => item.projectType === type);
}

/** 提取文件文本（复用知识库提取管道，支持 PDF/DOCX 等文档格式） */
async function extractReferenceText(absolutePath: string): Promise<string> {
  const stat = fs.statSync(absolutePath);
  const classifier = new FileClassifier();
  const classified = classifier.classify(absolutePath, path.basename(absolutePath), stat);
  const extractor = new ContentExtractor();
  const result = await extractor.extract(classified);
  const text = (result.text || '').trim();
  if (!text) throw new Error('文件未能提取到有效文本（可能是扫描件或加密文件）');
  return text;
}

/** 画像重算互斥：并发请求只触发一次重算，避免重复提取大文件与索引竞写 */
let recomputePromise: Promise<void> | null = null;

/**
 * 画像版本迁移：提取口径升级后，旧画像在读取前自动重算写回（惰性、幂等）。
 * 重算失败保留旧画像与版本，下次读取重试；保证沉淀数据始终与当前口径一致。
 */
export function recomputeStaleProfiles(): Promise<void> {
  recomputePromise ??= doRecomputeStaleProfiles().finally(() => { recomputePromise = null; });
  return recomputePromise;
}

async function doRecomputeStaleProfiles(): Promise<void> {
  const records = readIndex();
  const stale = records.filter(item => item.status === 'ready' && item.profileVersion !== PROFILE_VERSION);
  if (stale.length === 0) return;
  let changed = false;
  for (const record of stale) {
    const filePath = path.join(referencesRoot(), record.filePath);
    if (!fs.existsSync(filePath)) continue;
    try {
      const text = await extractReferenceText(filePath);
      record.qualityProfile = buildReferenceQualityProfile(text);
      record.profileVersion = PROFILE_VERSION;
      changed = true;
    } catch {
      // 保留旧画像与版本标记，下次读取重试
    }
  }
  if (changed) writeIndex(records);
}

/**
 * 添加参考文件：把上传的临时文件移入参考库独立目录，提取文本并计算质量画像。
 * projectType 传 undefined 时使用系统自动分类建议。
 */
export async function addTemplateReference(input: {
  tempFilePath: string;
  fileName: string;
  projectType?: ReferenceProjectType;
}): Promise<TemplateReferenceRecord> {
  const root = referencesRoot();
  const id = `ref-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const extension = path.extname(input.fileName) || '.pdf';
  const storedName = `${id}${extension.toLowerCase()}`;
  const storedPath = path.join(root, 'files', storedName);
  fs.copyFileSync(input.tempFilePath, storedPath);
  const fileSize = fs.statSync(storedPath).size;
  const record: TemplateReferenceRecord = {
    id,
    fileName: input.fileName,
    projectType: input.projectType || '其他',
    typeSource: input.projectType ? 'manual' : 'auto',
    uploadedAt: Date.now(),
    fileSize,
    filePath: path.join('files', storedName),
    status: 'parsing',
  };
  const records = readIndex();
  records.push(record);
  writeIndex(records);
  // 解析画像：成功置 ready，失败保留原文与失败状态供用户查看
  try {
    const text = await extractReferenceText(storedPath);
    const profile = buildReferenceQualityProfile(text);
    record.qualityProfile = profile;
    record.profileVersion = PROFILE_VERSION;
    record.status = 'ready';
    if (record.typeSource === 'auto') record.projectType = suggestProjectType(text);
    // 每类型首个 ready 参考默认作为主参考
    const sameType = records.filter(item => item.projectType === record.projectType && item.status === 'ready' && item.id !== id);
    record.isPrimary = sameType.length === 0;
    writeIndex(records);
  } catch (error) {
    record.status = 'failed';
    record.errorMessage = error instanceof Error ? error.message : '解析失败';
    writeIndex(records);
  }
  return record;
}

/** 删除参考文件（含原文） */
export function deleteTemplateReference(id: string): boolean {
  const records = readIndex();
  const target = records.find(item => item.id === id);
  if (!target) return false;
  const next = records.filter(item => item.id !== id);
  // 若删除的是主参考，自动让同类型最早的 ready 记录接任
  if (target.isPrimary) {
    const successor = next.find(item => item.projectType === target.projectType && item.status === 'ready');
    if (successor) successor.isPrimary = true;
  }
  writeIndex(next);
  const filePath = path.join(referencesRoot(), target.filePath);
  try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch { /* 原文删除失败不阻断索引删除 */ }
  return true;
}

/** 设置某工程类型的主参考（同类型其他记录取消主参考） */
export function setPrimaryTemplateReference(id: string, primary: boolean): TemplateReferenceRecord | undefined {
  const records = readIndex();
  const target = records.find(item => item.id === id);
  if (!target || target.status !== 'ready') return undefined;
  if (primary) {
    for (const item of records) {
      if (item.projectType === target.projectType) item.isPrimary = item.id === id;
    }
  } else {
    target.isPrimary = false;
  }
  writeIndex(records);
  return target;
}

/** 修改参考文件的工程类型标注（改为手动标注） */
export function updateTemplateReferenceType(id: string, projectType: ReferenceProjectType): TemplateReferenceRecord | undefined {
  const records = readIndex();
  const target = records.find(item => item.id === id);
  if (!target) return undefined;
  target.projectType = projectType;
  target.typeSource = 'manual';
  writeIndex(records);
  return target;
}

/** 读取参考文件原文文本（用于用户浏览对照，仅返回前 N 字） */
export function readTemplateReferenceText(id: string, maxChars = 20000): string {
  const record = readIndex().find(item => item.id === id);
  if (!record) return '';
  const filePath = path.join(referencesRoot(), record.filePath);
  if (!fs.existsSync(filePath)) return '';
  // 同步提取不可行时直接读原始字节兜底（PDF 为二进制，仅用于存在性确认）
  try {
    const buffer = fs.readFileSync(filePath);
    if (buffer.subarray(0, 4).toString() === '%PDF') return '';
    return buffer.toString('utf-8').slice(0, maxChars);
  } catch {
    return '';
  }
}

/** 获取某工程类型的对标基准（取主参考画像，缺省取同类型画像均值） */
export function referenceBenchmarkForType(type: ReferenceProjectType): { profile: ReferenceQualityProfile; sourceCount: number } | undefined {
  const ready = listTemplateReferencesByType(type).filter(item => item.status === 'ready' && item.qualityProfile);
  if (ready.length === 0) return undefined;
  const primary = ready.find(item => item.isPrimary) || ready[0];
  return { profile: primary.qualityProfile!, sourceCount: ready.length };
}

/** 某工程类型的章节结构范式：把主参考的标题结构格式化为可直接插入提示词的章节列表文本 */
export function referenceParadigmText(type: ReferenceProjectType): { text: string; sourceCount: number } | undefined {
  const ready = listTemplateReferencesByType(type).filter(item => item.status === 'ready' && item.qualityProfile?.headingStructure?.length);
  if (ready.length === 0) return undefined;
  const primary = ready.find(item => item.isPrimary) || ready[0];
  const headings = primary.qualityProfile!.headingStructure.slice(0, 12);
  const text = headings.map((title, index) => `第${['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二'][index] ?? (index + 1)}章 ${title}`).join('\n');
  return { text, sourceCount: ready.length };
}

// ═══════ 类型级累积画像（T2）══════

/** 类型级累积画像：某工程类型下全部 ready 样本的聚合特征，随上传/删除/改类型自动重算 */
export interface ReferenceTypeProfile {
  projectType: ReferenceProjectType;
  /** 参与画像的样本数 */
  sourceCount: number;
  /** 样本总字数 */
  totalWords: number;
  /** 画像最近一次更新时间（取最新样本上传时间） */
  updatedAt: number;
  metrics: {
    paramDensity: { avg: number; min: number; max: number };
    arrowChainCoverage: { avg: number; min: number; max: number };
    duplicationRate: { avg: number; min: number; max: number };
    tableCount: { avg: number; min: number; max: number };
    sectionCount: { avg: number; min: number; max: number };
    subsectionCount: { avg: number; min: number; max: number };
    subitemCount: { avg: number; min: number; max: number };
    avgSectionWords: { avg: number };
  };
  /** 典型章节结构：合并所有样本的一级标题频次（ratio = 出现该标题的样本占比） */
  typicalHeadings: Array<{ title: string; count: number; ratio: number }>;
  /** 常见表格标题：跨样本频次 top */
  commonTables: Array<{ title: string; count: number }>;
  /** 高频工艺参数词条：跨样本计数 top */
  frequentParams: Array<{ token: string; count: number }>;
}

function average(values: number[]): number {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function range(values: number[]): { avg: number; min: number; max: number } {
  return { avg: average(values), min: values.length ? Math.min(...values) : 0, max: values.length ? Math.max(...values) : 0 };
}

/** 汇总一组样本的频次表（典型章节/常见表格/高频参数通用） */
function mergeCounts(groups: Array<Array<{ value: string; weight?: number }>>): Array<{ value: string; count: number }> {
  const counts = new Map<string, number>();
  for (const group of groups) {
    for (const item of group) {
      counts.set(item.value, (counts.get(item.value) || 0) + (item.weight ?? 1));
    }
  }
  return [...counts.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count);
}

/**
 * 画像指标加权聚合：率类指标（参数密度/工序链/重复率/每章字数）按
 * 有效字数或段落数加权重算，避免 2 万字与 10 万字样本等权平均的偏差；
 * 计数类指标（表格/章节数）保持等权平均；min/max 取样本极值。
 */
export function aggregateProfileMetrics(profiles: ReferenceQualityProfile[]): {
  paramDensity: { avg: number; min: number; max: number };
  arrowChainCoverage: { avg: number; min: number; max: number };
  duplicationRate: { avg: number; min: number; max: number };
  tableCount: { avg: number; min: number; max: number };
  sectionCount: { avg: number; min: number; max: number };
  subsectionCount: { avg: number; min: number; max: number };
  subitemCount: { avg: number; min: number; max: number };
  avgSectionWords: { avg: number };
} {
  if (profiles.length === 0) {
    const zero = { avg: 0, min: 0, max: 0 };
    return { paramDensity: { ...zero }, arrowChainCoverage: { ...zero }, duplicationRate: { ...zero }, tableCount: { ...zero }, sectionCount: { ...zero }, subsectionCount: { ...zero }, subitemCount: { ...zero }, avgSectionWords: { avg: 0 } };
  }
  const paramDensities = profiles.map(item => item.paramDensity);
  const arrowChains = profiles.map(item => item.arrowChainCoverage);
  const duplications = profiles.map(item => item.duplicationRate);
  const totalEffective = profiles.reduce((sum, item) => sum + (item.effectiveWordCount || item.wordCount), 0);
  const totalParams = profiles.reduce((sum, item) => sum + item.paramCount, 0);
  const totalSegments = profiles.reduce((sum, item) => sum + (item.segmentCount || 0), 0);
  const totalArrow = profiles.reduce((sum, item) => sum + (item.arrowChainSegmentCount || 0), 0);
  const totalDup = profiles.reduce((sum, item) => sum + (item.duplicatedSegmentCount || 0), 0);
  const totalSections = profiles.reduce((sum, item) => sum + item.sectionCount, 0);
  return {
    paramDensity: { avg: totalEffective > 0 ? (totalParams * 1000) / totalEffective : 0, min: Math.min(...paramDensities), max: Math.max(...paramDensities) },
    arrowChainCoverage: { avg: totalSegments > 0 ? totalArrow / totalSegments : 0, min: Math.min(...arrowChains), max: Math.max(...arrowChains) },
    duplicationRate: { avg: totalSegments > 0 ? totalDup / totalSegments : 0, min: Math.min(...duplications), max: Math.max(...duplications) },
    tableCount: range(profiles.map(item => item.tableCount)),
    sectionCount: range(profiles.map(item => item.sectionCount)),
    subsectionCount: range(profiles.map(item => item.subsectionCount || 0)),
    subitemCount: range(profiles.map(item => item.subitemCount || 0)),
    avgSectionWords: { avg: totalSections > 0 ? Math.round(totalEffective / totalSections) : 0 },
  };
}

/** 构建全部工程类型的累积画像（纯派生：从 ready 记录的画像实时聚合，无独立存储一致性负担） */
export function buildTypeProfiles(): ReferenceTypeProfile[] {
  const ready = listTemplateReferences().filter(item => item.status === 'ready' && item.qualityProfile);
  const byType = new Map<ReferenceProjectType, TemplateReferenceRecord[]>();
  for (const record of ready) {
    const list = byType.get(record.projectType) || [];
    list.push(record);
    byType.set(record.projectType, list);
  }
  const profiles: ReferenceTypeProfile[] = [];
  for (const [projectType, records] of byType) {
    const profilesOfType = records.map(item => item.qualityProfile!);
    const headingGroups = profilesOfType.map(item => (item.headingStructure || []).map(title => ({ value: title })));
    const headingCounts = mergeCounts(headingGroups);
    const tableGroups = profilesOfType.map(item => (item.tableTitles || []).map(title => ({ value: title })));
    const tableCounts = mergeCounts(tableGroups);
    const paramGroups = profilesOfType.map(item => (item.paramTokens || []).map(token => ({ value: token.token, weight: token.count })));
    const paramCounts = mergeCounts(paramGroups);
    profiles.push({
      projectType,
      sourceCount: records.length,
      totalWords: profilesOfType.reduce((sum, item) => sum + item.wordCount, 0),
      updatedAt: Math.max(...records.map(item => item.uploadedAt)),
      metrics: aggregateProfileMetrics(profilesOfType),
      typicalHeadings: headingCounts.slice(0, 16).map(item => ({ title: item.value, count: item.count, ratio: records.length > 0 ? Math.min(1, item.count / records.length) : 0 })),
      commonTables: tableCounts.slice(0, 10).map(item => ({ title: item.value, count: item.count })),
      frequentParams: paramCounts.slice(0, 12).map(item => ({ token: item.value, count: item.count })),
    });
  }
  return profiles.sort((a, b) => b.sourceCount - a.sourceCount);
}

// ═══════ 蓝图注入（T5）：生成过程中把同类工程画像作为软性质量参考 ═══════

/**
 * 生成「同类工程质量参考」段落（注入文档蓝图，随章节生成与审查全链路生效）。
 * 防负面干扰设计：
 * - 只按"形"给软性参考，明确"项目专属数字与参数仍以知识库证据为准"，与事实红线同向；
 * - 量化目标按本项目目标字数与参考样本平均字数折减，避免小项目被大工程典型值误导；
 * - 样本门槛：仅 1 份样本时只给结构参考（不给量化目标），≥2 份才给量化目标，避免单一样本误导；
 * - 无同类型样本时返回空数组，不注入任何内容。
 */
export function referenceQualityTargetLines(input: { templateName: string; chapterTitles: string[]; requirement?: string; targetWords: number }): string[] {
  const type = suggestProjectType([input.templateName, ...input.chapterTitles, input.requirement].filter(Boolean).join(' '));
  const ready = listTemplateReferencesByType(type).filter(item => item.status === 'ready' && item.qualityProfile);
  if (ready.length === 0) return [];
  const profiles = ready.map(item => item.qualityProfile!);
  const sourceCount = ready.length;
  const avgWords = average(profiles.map(item => item.wordCount));
  const scale = avgWords > 0 ? Math.max(0.3, Math.min(2, input.targetWords / avgWords)) : 1;
  const headingGroups = profiles.map(item => (item.headingStructure || []).map(title => ({ value: title })));
  const headingCounts = mergeCounts(headingGroups);
  const frequentHeadings = headingCounts.filter(item => item.count >= Math.ceil(sourceCount / 2)).slice(0, 12);
  const lines: string[] = [
    `同类工程（${type}）参考特征（来自 ${sourceCount} 份优秀入围文件画像，仅供软性参考；任何项目专属数字与参数仍必须以知识库证据为准，为对齐特征而编造参数、虚构表格或堆砌无意义内容严格禁止）：`,
  ];
  if (sourceCount >= 2) {
    const aggregated = aggregateProfileMetrics(profiles);
    const paramDensity = aggregated.paramDensity.avg;
    const arrowChain = aggregated.arrowChainCoverage.avg;
    const tablesPerSection = aggregated.sectionCount.avg > 0 ? aggregated.tableCount.avg / aggregated.sectionCount.avg : 0;
    const avgSectionWords = aggregated.avgSectionWords.avg;
    lines.push(`- 工艺参数密度参考：约 ${(paramDensity * scale).toFixed(1)} 个/千字（同类工程画像均值 ${paramDensity.toFixed(1)}，已按本项目篇幅折减）；参数应来自已确认事实与专业知识，不得编造。`);
    lines.push(`- 工序链覆盖率参考：含"→"工序链的段落占比约 ${Math.round(arrowChain * 100)}%；施工与流程小节宜用工序链串联工艺步骤。`);
    lines.push(`- 表格参考：同类工程平均每章约 ${tablesPerSection.toFixed(1)} 张正式表格（在事实允许的前提下合理配置）。`);
    lines.push(`- 章节体量参考：同类工程平均约 ${Math.round(aggregated.sectionCount.avg)} 章、平均每章约 ${avgSectionWords} 字；实际以模板章节与篇幅目标为准。`);
  }
  if (frequentHeadings.length > 0) {
    lines.push(`- 典型章节结构参考（出现于半数以上样本，仅供结构参考，不强制）：${frequentHeadings.map(item => item.value).join('、')}`);
  }
  return lines;
}

// ═══════ 大纲建议（T6）：模板章节与同类工程典型结构对比，缺失高频章节给出建议 ═══════

/** 归一化章节标题（去"第X章/第X篇/编号"前缀），用于与参考画像标题对比 */
export function normalizeHeadingTitle(title: string): string {
  return title.replace(/^第[一二三四五六七八九十百千\d]+[章节篇][、.．]?\s*/u, '').replace(/^\d+(?:\.\d+)*[、.．]?\s*/u, '').trim();
}

/** 模板章节结构建议：同类工程中出现于 ≥50% 样本、且模板缺失的典型章节（只建议不强制） */
export function referenceStructureSuggestion(input: { templateName: string; chapterTitles: string[] }): { projectType: ReferenceProjectType; sourceCount: number; missingHeadings: Array<{ title: string; ratio: number }> } | undefined {
  const type = suggestProjectType([input.templateName, ...input.chapterTitles].join(' '));
  const ready = listTemplateReferencesByType(type).filter(item => item.status === 'ready' && item.qualityProfile);
  if (ready.length === 0) return undefined;
  const profiles = ready.map(item => item.qualityProfile!);
  const headingGroups = profiles.map(item => (item.headingStructure || []).map(title => ({ value: title })));
  const headingCounts = mergeCounts(headingGroups);
  const existing = new Set(input.chapterTitles.map(normalizeHeadingTitle));
  const missingHeadings = headingCounts
    .filter(item => item.count >= Math.ceil(ready.length / 2))
    .filter(item => !existing.has(normalizeHeadingTitle(item.value)))
    .slice(0, 6)
    .map(item => ({ title: item.value, ratio: Math.min(1, item.count / ready.length) }));
  return missingHeadings.length > 0 ? { projectType: type, sourceCount: ready.length, missingHeadings } : undefined;
}
