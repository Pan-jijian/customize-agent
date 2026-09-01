import * as fs from 'node:fs';
import * as path from 'node:path';
import { computeProjectId } from '@customize-agent/knowledge';
import { getMultiProjectManager, getStorageRoot, listKnowledgeFiles } from '../knowledge/kbService';
import { upsertKbOperation } from '../knowledge/kbOperationLog';
import { buildBaseProjectGraph, buildAgentMaterialSnapshot, resolveAgentMaterialScope } from './agentWorkflow';
import { buildProjectGraph } from './projectGraph';
import { dedupeQuantityFacts, filterConstructionSteps } from './chapterGeneration';
import type { DocumentEvidence, DocumentFact, DocumentTemplate, ProjectGraph } from './types';
import { stableHash } from './utils';

const INTELLIGENCE_VERSION = 'project-intelligence-v10' as const;
const SCOPE_VERSION = 'material-scope-v5' as const;

export interface ProjectIntelligenceFileAsset {
  relativePath: string;
  root?: string;
  fileName: string;
  category: string;
  format: string;
  chunkCount: number;
  indexedAt: number;
  contentHash?: string;
  status: string;
  roles: string[];
  usableForBody: boolean;
  excludeReason?: string;
  summarySignals: string[];
  contentFacts: string[];
  intentTags: string[];
  chapterHints: string[];
}

export interface ProjectIntelligenceIntentEntry {
  intent: string;
  filePath: string;
  title: string;
  content: string;
  score: number;
  roleId?: string;
}

export interface ConstructionWorkPackage {
  name: string;
  scope: string;
  quantities: string[];
  materials: string[];
  process: string[];
  methods: string[];
  acceptance: string[];
  sourceFiles: string[];
}

export interface ConstructionControlMatrixItem {
  feature: string;
  difficulty: string;
  relatedWorkPackages: string[];
  methods: string[];
  qualityControls: string[];
  safetyControls: string[];
}

export interface ConstructionOrganizationGraph {
  workPackages: ConstructionWorkPackage[];
  controlMatrix: ConstructionControlMatrixItem[];
  qualityControls: string[];
  safetyControls: string[];
  resourcePlans: string[];
  acceptanceRecords: string[];
  evidenceRankingHints: string[];
}

export interface ProjectIntelligenceCache {
  version: typeof INTELLIGENCE_VERSION;
  projectRoot: string;
  projectId: string;
  createdAt: number;
  sourceHash: string;
  fileCount: number;
  files: ProjectIntelligenceFileAsset[];
  facts: DocumentFact[];
  chapterIntentIndex: ProjectIntelligenceIntentEntry[];
  projectGraph: ProjectGraph;
  projectGraphMessage: string;
  constructionOrganizationGraph: ConstructionOrganizationGraph;
  blueprint: {
    projectNames: string[];
    roots: string[];
    usableFiles: number;
    excludedFiles: number;
    intentTags: string[];
    signals: string[];
  };
}

export interface MaterialScopeSnapshot {
  version: typeof SCOPE_VERSION;
  projectRoot: string;
  createdAt: number;
  scopeHash: string;
  selectedRoots: string[];
  selectedFiles: string[];
  sourceHash: string;
  files: ProjectIntelligenceFileAsset[];
  facts: DocumentFact[];
  projectGraph: ProjectGraph;
  constructionOrganizationGraph: ConstructionOrganizationGraph;
  evidenceByChapterId: Record<string, DocumentEvidence[]>;
  blueprint: ProjectIntelligenceCache['blueprint'];
}

function intelligenceDir(projectRoot: string) {
  const dir = path.join(getStorageRoot(), 'projects', computeProjectId(projectRoot), 'project-intelligence');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'scopes'), { recursive: true });
  return dir;
}

function cachePath(projectRoot: string) {
  return path.join(intelligenceDir(projectRoot), 'project-intelligence.json');
}

function scopePath(projectRoot: string, scopeHash: string) {
  return path.join(intelligenceDir(projectRoot), 'scopes', `${scopeHash}.json`);
}

function topLevelGroup(relativePath: string) {
  return relativePath.split(/[\\/]/u).filter(Boolean)[0];
}

function fileRoles(relativePath: string) {
  const roles = new Set<string>(['project_overview']);
  if (/招标|发包人要求|答疑|补疑|澄清/u.test(relativePath)) roles.add('tender_requirement');
  if (/图纸|设计说明|施工图|道路|桥梁|园林|交通|结构/u.test(relativePath)) roles.add('drawing');
  if (/清单|工程量|xls|xlsx/u.test(relativePath)) roles.add('boq');
  if (/质量|验收|规范|标准/u.test(relativePath)) roles.add('quality_standard');
  if (/安全|危大|风险|文明|环保/u.test(relativePath)) roles.add('safety_requirement');
  if (/施工|方案|组织|进度|工期|材料|机械|劳动力/u.test(relativePath)) roles.add('construction_method');
  return [...roles];
}

function bodyExclusionReason(relativePath: string) {
  if (/投标函|我方已仔细研究/u.test(relativePath)) return '投标函/承诺格式，不进入施工正文';
  if (/保证金|账户|协议书|资金托管/u.test(relativePath)) return '资金账户/保证金资料，不进入施工正文';
  if (/开标|评标|交易系统|示范文本/u.test(relativePath)) return '招投标流程/示范文本，不进入施工正文';
  if (/报价|税率|利润|最高投标限价|招标控制价|计价依据|计价定额/u.test(relativePath)) return '商务报价资料，不进入施工正文';
  if (/招标文件正文|清单编制说明|招标总说明|招标需求/u.test(relativePath)) return '招标说明/清单编制说明，不进入施工正文';
  return undefined;
}

function cleanSignal(text: string) {
  return text
    .replace(/资料参数行摘要\s*[:：]?/gu, '')
    .replace(/#{1,6}\s*/gu, ' ')
    // 标题残留：井号后直接接中文（如「##徽光阁项目」），无空白的 markdown 拼接噪音
    .replace(/[#＃]{1,6}(?=[\u4e00-\u9fa5])/gu, ' ')
    .replace(/(?:PDF\s*)?第\s*\d+\s*页(?:\s*共\s*\d+\s*页)?/giu, ' ')
    .replace(/资料类型\s*[:：]\s*[^\s；;]+/giu, ' ')
    .replace(/MIME\s*[:：]\s*[^\s；;]+/giu, ' ')
    .replace(/文件大小\s*[:：]\s*[^\s；;]+/giu, ' ')
    .replace(/(?:项目编号|招标编号|备案编号|工程编号)\s*[:：]\s*[^\s；;，。]+/giu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function isNonBodySentence(sentence: string) {
  return /投标函|保证金|开标|评标|交易系统|账户|协议书|示范文本|报价|税率|利润|我方已仔细研究|中标|签订合同|专用账户监管|联合体投标|注册建造师|安全生产考核合格证书|安全生产许可证|营业执照|资质要求|投标人资格|资格审查|资格后审|资格预审|业绩要求|信誉要求|财务要求|投标有效期|投标截止|递交投标文件|递交电子投标文件|获取招标文件|获取方式|获取时间|踏勘现场|投标预备会|备选投标方案|分包内容|电子交易系统|电子服务系统|联系方式|联系人|邮编|技术支持|全流程电子化交易|异议|投诉|评标委员会|评标办法|公告发布|媒介|咨询电话|拨打电话|招标工程量清单|最高投标限价|不可竞争费|招标总说明|招标需求|招标范围|招标控制价|编制补疑|计价依据|计价定额|措施项目费|暂列金额|投标总价|综合单价|计价格式|取费标准|清单编制说明|招标文件正文|招标图纸目录|投标人/u.test(sentence);
}

// 文件头/文档属性元数据句：编号、类型、大小、名称等与施工正文无关的登记信息
function isMetadataSentence(sentence: string) {
  return /^(?:项目编号|招标编号|备案编号|工程编号|资料名称|文档名称|文件名称|文档类型|文件类型|创建时间|修改时间|编制单位|编制日期)\s*[:：]/u.test(sentence)
    || /^[#＃]{1,6}/u.test(sentence);
}

export function extractContentFacts(signals: string[]) {
  const facts = new Set<string>();
  for (const signal of signals) {
    for (const raw of signal.split(/[。；;\n]/u)) {
      const sentence = cleanSignal(raw);
      if (sentence.length < 12 || sentence.length > 180) continue;
      if (isNonBodySentence(sentence)) continue;
      if (isMetadataSentence(sentence)) continue;
      if (/(项目|工程|道路|桥梁|园林|交通|结构|排水|照明|绿化|工期|质量|安全|危大|材料|机械|劳动力|验收|规范|清单|工程量|施工)/u.test(sentence)) facts.add(sentence);
      if (facts.size >= 18) break;
    }
    if (facts.size >= 18) break;
  }
  return [...facts];
}

// 清单项目特征描述中的“未尽事宜/具体详见……满足验收要求”“投标人踏勘现场后综合考虑”等模板尾巴，
// 属于招标格式噪音，且会命中 isNonBodySentence 导致真实参数被误删，这里在抽取阶段直接剥除。
function cleanBoqFeature(text: string) {
  return text
    .replace(/\s+/gu, ' ')
    // 招标格式尾巴：未尽事宜/具体详见/详见……（满足验收要求）
    .replace(/[，,;；]?\s*(?:\d+[、．.]\s*)?(?:未尽事宜|具体详见|详见)[^，,;；]*?，?满足验收要求/gu, '')
    // 造价/外弃尾巴：含拆除、垃圾打堆、外弃、运距、渣土费……一切相关费用（含由投标人承担）
    .replace(/[，,;；]?\s*(?:\d+[、．.]\s*)?含拆除、垃圾打堆、外弃[^，,;；]*/gu, '')
    // 踏勘现场综合考虑尾巴
    .replace(/[，,;；]?\s*投标人(?:结合设计图纸、地勘报告)?(?:自行)?踏勘现场后综合考虑/gu, '')
    .replace(/[|｜]+/gu, ' ')
    .replace(/\s*\d+[．.]\s*$/gu, '')
    .replace(/[。．]\s*$/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

// 工程量清单 EXCEL 被索引为 Markdown 表格（每行以 | 分隔），按行抽取「项目名称 + 项目特征描述 + 工程量」。
// 这些是真实的施工方法参数、材料规格与工程量，比纯文本抽取更适合驱动施工工作包。
function extractSpreadsheetFacts(chunks: Array<{ content?: string }>): string[] {
  const facts = new Set<string>();
  const HEADER_NOISE = /工程名称|序号|项目编码|项目名称|项目特征|计量\s*单位|工程量|金额|综合单价|合价|人工费|机械费|暂估价|分部小计|本页|续表|合计|汇总/u;
  for (const chunk of chunks) {
    const text = String(chunk.content || '');
    for (const line of text.split(/\r?\n/u)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('|')) continue;
      const cells = trimmed.split('|').map(cell => cell.trim());
      if (cells.length < 7) continue;
      const body = cells.slice(1, -1);
      const seq = body[0] || '';
      const name = body[2] || '';
      const feature = body[3] || '';
      const unit = body[4] || '';
      const quantity = body[5] || '';
      // 仅收录数据行：序号为纯整数，且项目名称与项目特征描述非空
      if (!/^\d+$/.test(seq)) continue;
      if (!name || !feature) continue;
      if (HEADER_NOISE.test(`${name}${feature}`)) continue;
      const featureClean = cleanBoqFeature(feature);
      if (featureClean.length < 2) continue;
      const quantityPart = quantity && unit ? `${quantity}${unit}` : quantity || unit;
      const fact = `${name}：${featureClean.slice(0, 80)}${quantityPart ? `｜${quantityPart}` : ''}`;
      if (fact.replace(/[^0-9a-zA-Z\u4e00-\u9fa5]/gu, '').length < 4) continue;
      facts.add(fact);
      if (facts.size >= 40) return [...facts];
    }
  }
  return [...facts];
}

function intentTagsForText(relativePath: string, facts: string[]) {
  const text = `${relativePath}\n${facts.join('\n')}`;
  const tags = new Set<string>();
  const add = (tag: string, re: RegExp) => { if (re.test(text)) tags.add(tag); };
  add('工期进度', /工期|进度|节点|计划|流水|穿插/u);
  add('质量验收', /质量|验收|检验|试验|复试|见证取样|规范|标准/u);
  add('安全危大', /安全|危大|风险|脚手架|深基坑|吊装|临电|消防/u);
  add('施工部署', /部署|总平面|临设|场地|组织|施工顺序/u);
  add('施工方法', /施工方法|施工工艺|道路|桥梁|排水|照明|园林|绿化|交通|结构/u);
  add('人材机', /劳动力|材料|机械|设备|周转|进场|资源/u);
  add('环境文明', /环保|扬尘|文明|噪声|水土保持|绿色施工/u);
  add('工程概况', /项目|工程|建设地点|建设规模|招标范围|发包人要求/u);
  return [...tags];
}

function chapterHintsForFile(relativePath: string, facts: string[]) {
  const text = `${relativePath}\n${facts.join('\n')}`;
  const hints = new Set<string>();
  if (/工期|进度|节点|计划/u.test(text)) hints.add('确保工期的保障体系与措施');
  if (/质量|验收|复试|见证取样|规范|标准/u.test(text)) hints.add('确保质量的保障体系与措施');
  if (/安全|危大|风险|应急|临电|消防/u.test(text)) hints.add('确保安全生产的管理体系与措施');
  if (/劳动力|材料|机械|设备|周转|资源/u.test(text)) hints.add('确保人、材、机的保障体系与措施');
  if (/施工方法|施工工艺|道路|桥梁|排水|照明|园林|绿化/u.test(text)) hints.add('主要分部分项工程施工方案');
  if (/环保|扬尘|文明|绿色/u.test(text)) hints.add('环境保护与文明施工措施');
  if (/项目|工程|建设地点|建设规模|招标范围/u.test(text)) hints.add('工程概况与施工部署');
  return [...hints];
}

function buildIntentIndex(files: ProjectIntelligenceFileAsset[]): ProjectIntelligenceIntentEntry[] {
  return files.flatMap(file => file.intentTags.flatMap(intent => file.contentFacts.slice(0, 10).map((fact, index) => ({
    intent,
    filePath: file.relativePath,
    title: file.fileName,
    content: fact,
    score: 0.82 - index * 0.025,
    roleId: file.roles[0],
  }))));
}

export function chapterIntentTags(title: string, sections: string[] = []) {
  const text = `${title}\n${sections.join('\n')}`;
  const tags = new Set<string>();
  const add = (tag: string, re: RegExp) => { if (re.test(text)) tags.add(tag); };
  add('工期进度', /工期|进度|计划|节点/u);
  add('质量验收', /质量|验收|复试|见证|控制点/u);
  add('安全危大', /安全|危大|风险|应急/u);
  add('施工部署', /部署|总平面|施工组织|现场/u);
  add('施工方法', /施工方案|施工方法|分部分项|工艺|新技术|新工艺/u);
  add('人材机', /人材机|劳动力|材料|机械|周转|人、材、机|人员设备/u);
  add('环境文明', /环保|文明|扬尘|绿色/u);
  // 「整体理解/工程理解」：施组第一章「针对工程项目整体理解」；「重点|难点」：重点难点章
  add('工程概况', /概况|工程特点|重点|难点|整体理解|项目理解|工程理解|项目概况/u);
  return [...tags];
}

export function evidenceFromIntentIndex(input: { template: DocumentTemplate; entries: ProjectIntelligenceIntentEntry[]; selected: Set<string> }) {
  const evidenceByChapterId: Record<string, DocumentEvidence[]> = {};
  for (const chapter of input.template.chapters) {
    const tags = chapterIntentTags(chapter.title, chapter.sections || []);
    if (tags.length === 0) continue;
    const tagSet = new Set(tags);
    const matched = input.entries
      .filter(entry => input.selected.has(entry.filePath) && tagSet.has(entry.intent))
      .sort((a, b) => b.score - a.score)
      .slice(0, 24)
      .map(entry => ({
        chapterId: chapter.id,
        filePath: entry.filePath,
        score: entry.score,
        content: entry.content,
        roleId: entry.roleId,
        processingType: 'project_intelligence',
        sectionTitle: entry.intent,
        source: 'project-intelligence',
      }));
    if (matched.length) evidenceByChapterId[chapter.id] = matched;
  }
  return evidenceByChapterId;
}

function buildFileFacts(file: ProjectIntelligenceFileAsset): DocumentFact[] {
  const facts: DocumentFact[] = [];
  const add = (key: string, value: string, confidence = 0.72) => {
    if (!value) return;
    facts.push({ key, value, sourceFile: file.relativePath, roleId: file.roles[0] || 'project_overview', processingType: 'project_intelligence', confidence });
  };
  add('资料文件', file.fileName, 0.6);
  if (file.root) add('资料组', file.root, 0.65);
  for (const role of file.roles) add('资料角色', role, 0.58);
  for (const fact of file.contentFacts) add('资料内容事实', fact, 0.76);
  for (const hint of file.chapterHints) add('章节意图候选', hint, 0.68);
  const projectName = file.relativePath.match(/([^/\\]*项目[^/\\]*)/u)?.[1] || file.root;
  if (projectName) add('项目名称候选', projectName, 0.62);
  return facts;
}

function sourceHash(files: ProjectIntelligenceFileAsset[]) {
  return stableHash(files.map(file => ({ path: file.relativePath, hash: file.contentHash, chunkCount: file.chunkCount, status: file.status })).sort((a, b) => a.path.localeCompare(b.path)));
}

function filterGraphByFiles(graph: ProjectGraph, selectedFiles: Set<string>): ProjectGraph {
  const hasSelected = (files?: string[]) => !files?.length || files.some(file => selectedFiles.has(file));
  return {
    ...graph,
    works: graph.works.filter(item => hasSelected(item.sourceFiles)),
    methods: graph.methods.filter(item => hasSelected(item.sourceFiles)),
    resources: graph.resources.filter(item => hasSelected(item.sourceFiles)),
    schedule: graph.schedule.filter(item => hasSelected(item.sourceFiles)),
    standards: graph.standards.filter(item => hasSelected(item.sourceFiles)),
    risks: graph.risks.filter(item => hasSelected(item.sourceFiles)),
    requirements: graph.requirements.filter(item => hasSelected(item.sourceFiles)),
    siteConditions: graph.siteConditions.filter(item => hasSelected(item.sourceFiles)),
    addendumChanges: graph.addendumChanges.filter(item => selectedFiles.has(item.sourceFile)),
  };
}

function selectedFilesAreFresh(projectRoot: string, files: ProjectIntelligenceFileAsset[]) {
  const currentFilesByPath = new Map(listKnowledgeFiles(projectRoot).map(file => [file.relativePath, file]));
  return files.every(file => {
    const current = currentFilesByPath.get(file.relativePath);
    return current && current.status !== 'error' && current.status !== 'disk' && Number(current.chunkCount || 0) === file.chunkCount && (current.contentHash || '') === (file.contentHash || '');
  });
}

function currentProjectSourceHash(projectRoot: string) {
  const currentFiles = listKnowledgeFiles(projectRoot)
    .filter(file => file.status !== 'disk' && file.status !== 'error' && Number(file.chunkCount || 0) > 0)
    .map(file => ({ relativePath: file.relativePath, contentHash: file.contentHash, chunkCount: file.chunkCount, status: file.status, indexedAt: file.indexedAt } as ProjectIntelligenceFileAsset));
  return sourceHash(currentFiles);
}

function normalizeCachedIntelligence(projectRoot: string, raw: Partial<ProjectIntelligenceCache>): ProjectIntelligenceCache | undefined {
  if (raw.version !== INTELLIGENCE_VERSION) return undefined;
  if (!raw.projectGraph || !Array.isArray(raw.files) || raw.files.length === 0) return undefined;
  const cachedHash = sourceHash(raw.files as ProjectIntelligenceFileAsset[]);
  if (cachedHash !== currentProjectSourceHash(projectRoot)) return undefined;
  const cache = raw as ProjectIntelligenceCache;
  const constructionOrganizationGraph = raw.constructionOrganizationGraph || buildConstructionOrganizationGraph(cache.projectGraph, cache.files);
  const normalized: ProjectIntelligenceCache = {
    ...cache,
    version: INTELLIGENCE_VERSION,
    projectRoot,
    projectId: cache.projectId || computeProjectId(projectRoot),
    sourceHash: cachedHash,
    constructionOrganizationGraph,
  };
  if (raw.version !== INTELLIGENCE_VERSION || !raw.constructionOrganizationGraph || raw.sourceHash !== cachedHash) {
    fs.writeFileSync(cachePath(projectRoot), JSON.stringify(normalized, null, 2));
  }
  return normalized;
}

export function readProjectIntelligence(projectRoot: string): ProjectIntelligenceCache | undefined {
  const file = cachePath(projectRoot);
  if (!fs.existsSync(file)) return undefined;
  try {
    return normalizeCachedIntelligence(projectRoot, JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<ProjectIntelligenceCache>);
  } catch {
    return undefined;
  }
}

/** 施组生成无关的缺口声称（确定性排除，防残留注入生成上下文）：
 * 评标办法/评审属商务程序性内容（对施组编制无用）；地质勘察/土壤氡检测经
 * 本工程确认为非必需资料——此类「缺失」不构成施组资料缺口，无论 LLM 图谱是否产出 */
const IRRELEVANT_GAP_RE = /评标办法|评标(?:委员会|细则)|评分档位|分值构成|评审|地质勘察|地勘|土壤氡/u;

/** gap 文本是否属施组无关缺口（评标办法/地质勘察类），用于图谱合并与生成注入两处过滤 */
export function isIrrelevantProjectGap(gap: string): boolean {
  return IRRELEVANT_GAP_RE.test(gap.replace(/\s+/gu, ' '));
}

export function mergeProjectGraphs(base: ProjectGraph, enhanced: ProjectGraph): ProjectGraph {
  const mergeItems = <T,>(left: T[], right: T[]) => {
    const map = new Map<string, T>();
    for (const item of [...left, ...right]) {
      const key = JSON.stringify(item);
      if (!map.has(key)) map.set(key, item);
    }
    return [...map.values()];
  };
  const works = mergeItems(base.works, enhanced.works);
  const methods = mergeItems(base.methods, enhanced.methods);
  const resources = mergeItems(base.resources, enhanced.resources);
  const schedule = mergeItems(base.schedule, enhanced.schedule);
  const standards = mergeItems(base.standards, enhanced.standards);
  const siteConditions = mergeItems(base.siteConditions, enhanced.siteConditions);
  const risks = mergeItems(base.risks, enhanced.risks);
  // LLM 图谱磁盘缓存命中时不经 normalize 重校验，category 误标「评标办法」的条目会残留
  // （内容多为装配率/业绩证明等真实要求，已在其他类别覆盖）——此处确定性兜底清除
  const requirements = mergeItems(base.requirements, enhanced.requirements).filter(item => !item.category.includes('评标'));
  const addendumChanges = mergeItems(base.addendumChanges, enhanced.addendumChanges);
  // 已解决缺口确定性清理：gap 声称「某事实未找到」，但合并图谱已含该事实（如 schedule
  // 已有「540个日历天」）时移除 gap，避免「工期未找到」类误导进入生成上下文
  const knownTerms = [
    ...schedule.flatMap(item => [item.duration, item.milestone].filter(Boolean) as string[]),
    ...standards.flatMap(item => [item.code, item.description].filter(Boolean) as string[]),
    ...siteConditions.flatMap(item => [item.condition, item.impact].filter(Boolean) as string[]),
  ].map(term => term.replace(/\s+/gu, ''));
  // 泛化声称矛盾检查：gap 声称「未提供 X」，但合并图谱 X 对应类别已有事实（确定性 base
  // 图谱或 LLM 图谱）→ 假声称移除。LLM 每轮 gap 输出不稳定（曾对事实已有内容声称
  // 「未提供建设规模/工程量清单/施工进度计划」），必须以图谱事实为准兜底。
  // 主题词刻意不覆盖「劳动力」：劳动力计划确属投标人自编、招标资料通常缺失的真实缺口
  const gapClaimSatisfied = (text: string): boolean => {
    const claims: Array<[RegExp, number]> = [
      [/建设规模|建筑面积|投资额|层数|建设内容/u, works.length],
      [/招标范围|施工范围/u, works.length],
      [/工程量/u, resources.length],
      [/设备表|设备名称|设备参数|规格型号/u, resources.length],
      [/进度计划|工期安排|开工日期|竣工日期|开工令/u, schedule.length],
      [/施工方法|工艺流程|施工方案/u, methods.length],
      [/验收标准|验收要求|验收清单/u, standards.length],
      [/补疑|澄清|答疑|变更信息/u, requirements.length + addendumChanges.length],
      [/项目风险|安全风险|风险提示/u, risks.length],
    ];
    return claims.some(([pattern, count]) => pattern.test(text) && count > 0);
  };
  const gaps = [...new Set([...(base.gaps || []), ...(enhanced.gaps || [])])].filter(gap => {
    const text = gap.replace(/\s+/gu, ' ');
    // 施组无关缺口（评标办法/评审/地质勘察）：确定性排除，不进图谱、不注入生成上下文
    if (isIrrelevantProjectGap(text)) return false;
    if (!/未找到|未直接出现|未提供|未在资料|未体现|未明确/u.test(text)) return true;
    // 括号声明（如「计划工期（540个日历天）」）：括号内每个片段均已被图谱事实覆盖 → 移除
    const claim = text.match(/[（(]([^（()）]{2,60})[）)]/u)?.[1] || '';
    if (claim) {
      const segments = claim.split(/[、,，]/u).map(segment => segment.replace(/\s+/gu, '')).filter(segment => segment.length >= 4);
      if (segments.length > 0 && segments.every(segment => knownTerms.some(term => term.includes(segment)))) return false;
      // 举例/部分承认型括号（如「（如建筑面积、层数、投资额等）」「（仅提及高温消防轴流通风机）」）
      // 不构成事实声明，不能阻断泛化声称清理；纯事实声明括号未被覆盖时保守保留
      if (!/^(?:如|例如|比如|诸如|仅提及|仅有|只有|含|包括)/u.test(claim)) return true;
    }
    // 无括号的泛化声称：图谱对应类别已有事实即移除（如「未提供计划工期……原文证据」而 schedule 已有 540 天）
    if (/计划工期/u.test(text) && schedule.length > 0) return false;
    if (/质量标准/u.test(text) && standards.length > 0) return false;
    if (/建设地点/u.test(text) && siteConditions.length > 0) return false;
    if (gapClaimSatisfied(text)) return false;
    return true;
  });
  return {
    works,
    methods,
    resources,
    schedule,
    standards,
    siteConditions,
    risks,
    requirements,
    addendumChanges,
    gaps,
    generatedAt: enhanced.generatedAt || Date.now(),
  };
}

function uniqueCompact(items: string[], limit: number) {
  return [...new Set(items.map(item => item.replace(/\s+/gu, ' ').trim()).filter(Boolean))].slice(0, limit);
}

function buildConstructionOrganizationGraph(projectGraph: ProjectGraph, files: ProjectIntelligenceFileAsset[]): ConstructionOrganizationGraph {
  const factByFile = new Map(files.map(file => [file.relativePath, file.contentFacts]));
  const rootNames = new Set(files.map(file => file.root).filter(Boolean));
  const fileNames = new Set(files.map(file => file.fileName).filter(Boolean));
  const isMetaLabel = (text: string) => /资料文件|资料组|资料角色|资料内容事实|章节意图候选|项目名称候选/u.test(text);
  const isNoisy = (text: string) => isNonBodySentence(text) || isMetaLabel(text);
  // 清单项目特征描述通常是「1．xxx 2．xxx」编号罗列，直接进入正文会变成清单条目而非施工叙述。
  // 识别冒号后含编号标记（数字＋．/、）的事实并剔除，改由 LLM 已归纳的叙述化事实（relatedItems/resources）驱动。
  const isBoqListFact = (text: string) => /\d+\s*[．、]/u.test(text.split(/[：:]/u).slice(1).join(':'));
  const clean = (items: string[], limit: number) => uniqueCompact(items, limit).filter(fact => !isNoisy(fact) && !isBoqListFact(fact));

  // 1. 从工程量清单 EXCEL 目录结构确定性识别真实施工工作包（可靠、不易受 LLM 抽取遗漏影响）
  const fileWorkNames = new Map<string, string[]>();
  for (const file of files) {
    if (!/工程量清单EXCEL/iu.test(file.relativePath) || !/\.xls$/iu.test(file.relativePath)) continue;
    const segments = file.relativePath.split('/');
    const fileName = segments[segments.length - 1] || '';
    const dirName = segments[segments.length - 2] || '';
    const name = (dirName.replace(/^\d+\s*/, '').trim() || fileName.replace(/\.xls$/iu, '').trim());
    // 剔除非工作包目录：项目根目录常以“项目施工”结尾（如“X项目施工”），属总体泛化标签而非工作包
    if (!name || /项目施工$|清单编制说明|图纸目录|可调整价差|汇总|一览表/u.test(name)) continue;
    if (!fileWorkNames.has(name)) fileWorkNames.set(name, []);
    fileWorkNames.get(name)!.push(file.relativePath);
  }

  // 2. 用 LLM 图谱补齐工作包范围（按来源文件匹配）
  const llmScopeByFile = new Map<string, string>();
  for (const work of projectGraph.works) {
    for (const file of work.sourceFiles || []) if (!llmScopeByFile.has(file)) llmScopeByFile.set(file, work.scope || '');
  }

  const workPackages: ConstructionWorkPackage[] = [];
  const seenNames = new Set<string>();
  const addWork = (name: string, sourceFileList: string[], scope?: string, extraItems: string[] = []) => {
    if (!name || seenNames.has(name) || rootNames.has(name) || fileNames.has(name)) return;
    if (/投标|报价|保证金|合同协议|账户|开标|评标|资质要求|资格审查|资料目录|招标范围|招标需求|招标总说明|最高投标限价|不可竞争费|补疑|清单编制说明|图纸目录/u.test(`${name}${scope || ''}`)) return;
    // 过滤“X项目施工”这类总体泛化标签（LLM 常把清单编制说明/补疑文档误判为工作包）
    if (/项目施工$/u.test(name.trim())) return;

    // 事实来源：LLM 归纳的 relatedItems 优先，EXCEL 清单事实兜底（clean 已剔除编号罗列清单原文）
    const sourceFacts = clean([...extraItems, ...(sourceFileList || []).flatMap(file => factByFile.get(file) || [])], 16);
    const relatedText = `${name}\n${scope || ''}\n${sourceFacts.join('\n')}`;
    const relatedMethods = projectGraph.methods.filter(method => (method.applicableWorks || []).some(item => item.includes(name) || name.includes(item)) || method.name.includes(name)).slice(0, 4);
    const relatedResources = projectGraph.resources.filter(resource => !isMetaLabel(resource.name) && (relatedText.includes(resource.name) || (resource.sourceFiles || []).some(file => sourceFileList.includes(file)))).slice(0, 8);

    // 施工流程：只用 LLM 方法步骤；清单条目名前缀不是工序动作，混入会在成稿中产生“→配电箱”式残尾
    const process = clean([...relatedMethods.flatMap(item => item.steps || [])], 10);
    // 施工方法：LLM 方法名 + 叙述化事实（真实参数、材料、做法）；已入工程量的清单条目式事实不再重复保留
    const resourceNames = relatedResources.map(item => item.name).filter(Boolean);
    const methods = clean([...relatedMethods.map(item => item.name), ...sourceFacts.filter(fact => !resourceNames.some(resName => resName.length >= 4 && fact.includes(resName)))], 10);
    const finalScope = (scope || '').trim() || sourceFacts.slice(0, 2).join('；') || name;
    // 有真实事实即收录，避免把目录中的真实工作包当作空壳跳过
    if (sourceFacts.length === 0 && !finalScope && process.length === 0 && methods.length === 0) return;

    seenNames.add(name);
    // 工程量：资源“名称：数量”格式优先；清单条目式事实若包含已列资源名（同一对象双格式重复）则丢弃
    workPackages.push({
      name,
      scope: finalScope,
      quantities: clean([...relatedResources.map(item => `${item.name}${item.quantity ? `：${item.quantity}${item.unit || ''}` : ''}`), ...sourceFacts.filter(fact => /\d|㎡|m2|m²|米|m³|立方|吨|台|套|项/u.test(fact) && !resourceNames.some(resName => resName.length >= 4 && fact.includes(resName)))], 8),
      materials: clean(relatedResources.map(item => [item.name, item.spec].filter(Boolean).join('｜')), 8),
      process,
      methods,
      acceptance: clean([...projectGraph.standards.filter(item => (item.sourceFiles || []).some(file => sourceFileList.includes(file))).map(item => item.description || item.code), ...sourceFacts.filter(fact => /验收|复试|检测|见证|检验|质量/u.test(fact))], 8)
        // 验收条目必须含真实验收/检测术语，防止门窗等异包清单条目串台（真实缓存曾把“木质门五金…”混入结构加固验收）
        .filter(item => /验收|检测|试验|复试|实测|试块|测试|检查|记录|报告|见证|取样|拉拔|探伤|闭水|通电|绝缘|接地|电阻|偏差|压实度|密实度|强度|合格|规范/u.test(item)),
      sourceFiles: sourceFileList,
    });
  };

  // 3. 专业工程级聚合：EXCEL 目录结构为主干，LLM 细粒度子工作包（如「安装工程-配电箱安装」、
  //    「结构加固改造工程-加气混凝土砌块墙砌筑」）合并进对应专业工程，避免 -xx 后缀重复与串台。
  const professionalNames = [...fileWorkNames.keys()];
  const parentOf = (name: string): string | undefined => {
    if (professionalNames.includes(name)) return name;
    for (const parent of professionalNames) if (name.startsWith(`${parent}-`) || name.startsWith(`${parent}－`)) return parent;
    return undefined;
  };
  const mergedByParent = new Map<string, { scope: string; files: string[]; items: string[] }>();
  for (const work of projectGraph.works) {
    const name = (work.name || '').trim();
    if (!name) continue;
    const parent = parentOf(name);
    if (!parent) continue;
    const bucket = mergedByParent.get(parent) || { scope: '', files: [], items: [] };
    // 精确匹配的专业工程 scope 优先，细粒度子项 scope 仅作兜底
    if (name === parent && work.scope) bucket.scope = work.scope;
    else if (!bucket.scope) bucket.scope = work.scope || '';
    bucket.files.push(...(work.sourceFiles || []));
    bucket.items.push(...(work.relatedItems || []));
    mergedByParent.set(parent, bucket);
  }

  for (const [name, sourceFiles] of fileWorkNames) {
    const merged = mergedByParent.get(name);
    const llmScope = merged?.scope || sourceFiles.map(file => llmScopeByFile.get(file)).find(Boolean) || '';
    const allFiles = [...new Set([...sourceFiles, ...(merged?.files || [])])];
    addWork(name, allFiles, llmScope, merged?.items || []);
  }
  // 补充 LLM 图谱中未被 EXCEL 目录结构覆盖的独立工作包
  for (const work of projectGraph.works) {
    const name = (work.name || '').trim();
    if (!name || parentOf(name)) continue;
    addWork(name, work.sourceFiles || [], work.scope, work.relatedItems || []);
  }

  const packageNames = workPackages.map(item => item.name);
  const controlMatrix = projectGraph.risks.slice(0, 10).map(risk => ({
    feature: risk.risk,
    difficulty: risk.mitigation || risk.risk,
    relatedWorkPackages: packageNames.filter(name => risk.mitigation.includes(name) || risk.risk.includes(name)).slice(0, 4),
    methods: projectGraph.methods.filter(method => risk.mitigation.includes(method.name) || risk.risk.includes(method.name)).map(method => method.name).slice(0, 4),
    qualityControls: uniqueCompact(projectGraph.standards.map(item => item.description || item.code).filter(Boolean), 4),
    safetyControls: uniqueCompact([risk.mitigation, ...projectGraph.requirements.filter(item => /安全|风险|危大|消防|应急/u.test(item.category + item.detail)).map(item => item.detail)], 4),
  }));
  return {
    workPackages,
    controlMatrix,
    qualityControls: uniqueCompact([...projectGraph.standards.map(item => item.description || item.code), ...projectGraph.requirements.filter(item => /质量|验收|复试|检测/u.test(item.category + item.detail)).map(item => item.detail)], 18),
    safetyControls: uniqueCompact([...projectGraph.risks.map(item => `${item.risk}：${item.mitigation}`), ...projectGraph.requirements.filter(item => /安全|危大|消防|应急|文明/u.test(item.category + item.detail)).map(item => item.detail)], 18),
    resourcePlans: uniqueCompact(projectGraph.resources.map(item => `${item.name}${item.spec ? `｜${item.spec}` : ''}${item.quantity ? `｜${item.quantity}${item.unit || ''}` : ''}`), 24),
    acceptanceRecords: uniqueCompact([...projectGraph.standards.map(item => item.description || item.code), ...projectGraph.requirements.filter(item => /资料|验收|记录|检验批|隐蔽/u.test(item.category + item.detail)).map(item => item.detail)], 18),
    evidenceRankingHints: ['优先使用工程量清单、图纸设计说明、技术规范、发包人要求、补疑澄清中的施工范围、工程量、材料规格、工艺流程、验收标准；降低投标须知、保证金、付款、违约金、电子交易系统等商务合同条款权重。'],
  };
}

function filterConstructionOrganizationGraph(graph: ConstructionOrganizationGraph, selectedFiles: Set<string>): ConstructionOrganizationGraph {
  const hasSelected = (files: string[]) => !files.length || files.some(file => selectedFiles.has(file));
  const workPackages = graph.workPackages.filter(item => hasSelected(item.sourceFiles));
  const names = new Set(workPackages.map(item => item.name));
  return {
    ...graph,
    workPackages,
    controlMatrix: graph.controlMatrix.filter(item => item.relatedWorkPackages.length === 0 || item.relatedWorkPackages.some(name => names.has(name))),
  };
}

export function constructionOrganizationPrompt(graph?: ConstructionOrganizationGraph) {
  if (!graph || graph.workPackages.length === 0) return '';
  // 提示词层面统一清洗：工程量双格式条目去重、流程剔除清单条目，保证 LLM 成稿与确定性兜底拿到一致干净数据
  const cleanedPackages = graph.workPackages.slice(0, 12).map(item => {
    const quantities = dedupeQuantityFacts([...item.quantities, ...item.materials, ...item.methods]
      .map(text => text.replace(/\s+/gu, ' ').trim())
      .filter(text => text.length >= 4 && text.length <= 120));
    const process = filterConstructionSteps(
      item.process.map(text => text.replace(/\s+/gu, ' ').trim()).filter(text => text.length >= 2 && text.length <= 40),
      quantities,
    );
    return { name: item.name, scope: item.scope, quantities, process, acceptance: item.acceptance };
  });
  const structuredPackages = cleanedPackages.map(item => ({
    name: item.name,
    scope: item.scope,
    quantities: item.quantities,
    materials: [],
    process: item.process,
    methods: [],
    acceptance: item.acceptance,
  }));
  return [
    '## 施工组织设计专项图谱',
    '主要施工工作包：',
    ...cleanedPackages.map((item, index) => `${index + 1}. ${item.name}｜范围：${item.scope}｜工程量/材料：${item.quantities.slice(0, 5).join('；') || '按证据展开'}｜流程：${item.process.slice(0, 8).join('→') || '按施工准备→实施→检查→验收组织'}｜验收：${item.acceptance.slice(0, 4).join('；') || '按规范和资料闭环'}`),
    '施工工作包结构化数据：',
    JSON.stringify(structuredPackages),
    graph.controlMatrix.length ? '重点难点—施工内容—措施矩阵：' : '',
    ...graph.controlMatrix.slice(0, 8).map(item => `- ${item.feature} → ${item.relatedWorkPackages.join('、') || '相关工作包'} → ${[...item.methods, ...item.qualityControls, ...item.safetyControls].slice(0, 6).join('；')}`),
    graph.evidenceRankingHints.join('\n'),
  ].filter(Boolean).join('\n');
}

function projectEvidenceFromFiles(files: ProjectIntelligenceFileAsset[]): DocumentEvidence[] {
  return files.flatMap(file => file.contentFacts.slice(0, 10).map((content, index) => ({
    chapterId: 'project-intelligence',
    filePath: file.relativePath,
    content,
    score: 0.82 - index * 0.02,
    roleId: file.roles[0],
    processingType: 'project_intelligence',
    source: 'project-intelligence',
  })));
}

export async function buildProjectIntelligence(projectRoot: string): Promise<ProjectIntelligenceCache> {
  const project = await getMultiProjectManager().getProject(projectRoot);
  const kbFiles = listKnowledgeFiles(projectRoot).filter(file => file.status !== 'disk' && file.status !== 'error' && Number(file.indexedAt || 0) > 0 && Number(file.chunkCount || 0) > 0);
  const files: ProjectIntelligenceFileAsset[] = kbFiles.map(file => {
    const root = topLevelGroup(file.relativePath);
    const roles = fileRoles(file.relativePath);
    // 步长抽样（上限 64 块并强制含最后一块）：前缀 16 块覆盖不到文件中部/尾部的
    // 工期、质量标准等核心条款，是图谱缺口（如「计划工期 540 天未找到」）的直接根因
    const chunks = project.listChunksSampled({ relativePath: file.relativePath, sampleSize: 64 });
    const summarySignals = chunks.map(chunk => cleanSignal(String(chunk.content || ''))).filter(Boolean).slice(0, 48);
    const excludeReason = bodyExclusionReason(file.relativePath);
    const isSpreadsheet = /\.(?:xlsx?|csv|tsv)$/iu.test(file.relativePath);
    const contentFacts = excludeReason ? [] : isSpreadsheet ? extractSpreadsheetFacts(chunks) : extractContentFacts(summarySignals);
    const intentTags = intentTagsForText(file.relativePath, contentFacts);
    const chapterHints = chapterHintsForFile(file.relativePath, contentFacts);
    return {
      relativePath: file.relativePath,
      root,
      fileName: path.basename(file.relativePath),
      category: file.category,
      format: file.format,
      chunkCount: file.chunkCount,
      indexedAt: file.indexedAt,
      contentHash: file.contentHash,
      status: file.status,
      roles,
      usableForBody: !excludeReason,
      excludeReason,
      summarySignals,
      contentFacts,
      intentTags,
      chapterHints,
    };
  });
  const facts = files.flatMap(buildFileFacts);
  const chapterIntentIndex = buildIntentIndex(files);
  const materialScope = { selectedRoots: [...new Set(files.map(file => file.root).filter(Boolean))] as string[], selectedFiles: files.map(file => file.relativePath), totalAvailableFiles: files.length, ambiguous: false, locked: true, reason: '项目入库完成后预计算的项目级资料范围', rejectedRoots: [], scopeHash: sourceHash(files) };
  const materialSnapshot = buildAgentMaterialSnapshot(projectRoot, materialScope);
  const baseProjectGraph = buildBaseProjectGraph({ facts, materialSnapshot });
  const enhancedResult = await buildProjectGraph({ evidence: projectEvidenceFromFiles(files), projectRoot, requirement: '项目入库后预计算项目图谱', templateId: 'project-intelligence' });
  if (!enhancedResult.graph) throw new Error(`项目图谱预计算失败：${enhancedResult.stage.message || enhancedResult.stage.status}`);
  const projectGraph = mergeProjectGraphs(baseProjectGraph, enhancedResult.graph);
  const projectGraphMessage = enhancedResult.stage.message || '项目图谱已预计算';
  const constructionOrganizationGraph = buildConstructionOrganizationGraph(projectGraph, files);
  const cache: ProjectIntelligenceCache = {
    version: INTELLIGENCE_VERSION,
    projectRoot,
    projectId: computeProjectId(projectRoot),
    createdAt: Date.now(),
    sourceHash: sourceHash(files),
    fileCount: files.length,
    files,
    facts,
    chapterIntentIndex,
    projectGraph,
    projectGraphMessage,
    constructionOrganizationGraph,
    blueprint: {
      projectNames: [...new Set(facts.filter(fact => /项目名称/u.test(fact.key)).map(fact => fact.value))].slice(0, 8),
      roots: [...new Set(files.map(file => file.root).filter(Boolean))] as string[],
      usableFiles: files.filter(file => file.usableForBody).length,
      excludedFiles: files.filter(file => !file.usableForBody).length,
      intentTags: [...new Set(files.flatMap(file => file.intentTags))],
      signals: files.flatMap(file => file.contentFacts.slice(0, 2)).slice(0, 24),
    },
  };
  fs.writeFileSync(cachePath(projectRoot), JSON.stringify(cache, null, 2));
  return cache;
}

function buildMaterialScopeSnapshot(input: { projectRoot: string; template: DocumentTemplate; cache: ProjectIntelligenceCache; selectedFiles: string[]; selectedRoots: string[]; scopeHash: string }): MaterialScopeSnapshot | undefined {
  const selected = new Set(input.selectedFiles);
  const files = input.cache.files.filter(file => selected.has(file.relativePath));
  if (files.length === 0) return undefined;
  if (!selectedFilesAreFresh(input.projectRoot, files)) return undefined;
  const facts = input.cache.facts.filter(fact => selected.has(fact.sourceFile));
  const projectGraph = filterGraphByFiles(input.cache.projectGraph, selected);
  const constructionOrganizationGraph = filterConstructionOrganizationGraph(input.cache.constructionOrganizationGraph, selected);
  const evidenceByChapterId = evidenceFromIntentIndex({ template: input.template, entries: input.cache.chapterIntentIndex || [], selected });
  const snapshot: MaterialScopeSnapshot = {
    version: SCOPE_VERSION,
    projectRoot: input.projectRoot,
    createdAt: Date.now(),
    scopeHash: input.scopeHash,
    selectedRoots: input.selectedRoots,
    selectedFiles: input.selectedFiles,
    sourceHash: stableHash(files.map(file => ({ path: file.relativePath, hash: file.contentHash, chunkCount: file.chunkCount })).sort((a, b) => a.path.localeCompare(b.path))),
    files,
    facts,
    projectGraph,
    constructionOrganizationGraph,
    evidenceByChapterId,
    blueprint: {
      projectNames: [...new Set(facts.filter(fact => /项目名称/u.test(fact.key)).map(fact => fact.value))].slice(0, 8),
      roots: [...new Set(files.map(file => file.root).filter(Boolean))] as string[],
      usableFiles: files.filter(file => file.usableForBody).length,
      excludedFiles: files.filter(file => !file.usableForBody).length,
      intentTags: [...new Set(files.flatMap(file => file.intentTags))],
      signals: files.flatMap(file => file.contentFacts.slice(0, 2)).slice(0, 24),
    },
  };
  fs.writeFileSync(scopePath(input.projectRoot, input.scopeHash), JSON.stringify(snapshot, null, 2));
  return snapshot;
}

function readMaterialScopeSnapshot(projectRoot: string, scopeHash: string): MaterialScopeSnapshot | undefined {
  const file = scopePath(projectRoot, scopeHash);
  if (!fs.existsSync(file)) return undefined;
  try {
    const snapshot = JSON.parse(fs.readFileSync(file, 'utf8')) as MaterialScopeSnapshot;
    if (snapshot.version !== SCOPE_VERSION) return undefined;
    if (!selectedFilesAreFresh(projectRoot, snapshot.files)) return undefined;
    return snapshot;
  } catch {
    return undefined;
  }
}

export function buildScopedProjectIntelligence(input: { projectRoot: string; template: DocumentTemplate; requirement?: string }) {
  const cache = readProjectIntelligence(input.projectRoot);
  if (!cache) return undefined;
  const scope = resolveAgentMaterialScope(input.projectRoot, input.template, input.requirement || '');
  if (scope.ambiguous || !scope.locked || scope.selectedFiles.length === 0) return undefined;
  const scopeHash = stableHash({ version: SCOPE_VERSION, selectedFiles: scope.selectedFiles.slice().sort(), templateId: input.template.id, chapters: input.template.chapters.map(chapter => ({ id: chapter.id, title: chapter.title, sections: chapter.sections || [] })) });
  const snapshot = readMaterialScopeSnapshot(input.projectRoot, scopeHash)
    || buildMaterialScopeSnapshot({ projectRoot: input.projectRoot, template: input.template, cache, selectedFiles: scope.selectedFiles, selectedRoots: scope.selectedRoots, scopeHash });
  if (!snapshot) return undefined;
  return {
    cache,
    scope,
    scopeSnapshot: snapshot,
    files: snapshot.files,
    facts: snapshot.facts,
    evidenceByChapterId: snapshot.evidenceByChapterId,
    projectGraph: snapshot.projectGraph,
    constructionOrganizationGraph: snapshot.constructionOrganizationGraph,
    constructionOrganizationContext: constructionOrganizationPrompt(snapshot.constructionOrganizationGraph),
    blueprint: snapshot.blueprint,
  };
}

export function startProjectIntelligenceBuild(projectRoot: string) {
  const id = `project-intelligence-${Date.now()}`;
  upsertKbOperation(projectRoot, { id, type: 'reindex', title: '项目理解缓存', stage: 'generating', status: 'processing', percent: 5, message: '正在构建项目级蓝图、图谱、事实索引和章节意图索引' });
  void buildProjectIntelligence(projectRoot).then(cache => {
    upsertKbOperation(projectRoot, { id, type: 'reindex', title: '项目理解缓存', stage: 'done', status: 'success', percent: 100, message: `项目理解缓存完成：${cache.fileCount} 份资料，${cache.facts.length} 条事实，${cache.chapterIntentIndex.length} 条章节意图证据` });
  }).catch(error => {
    const message = error instanceof Error ? error.message : String(error);
    upsertKbOperation(projectRoot, { id, type: 'reindex', title: '项目理解缓存', stage: 'error', status: 'error', percent: 100, message, error: message });
    console.warn('[project-intelligence] build failed', message);
  });
}
