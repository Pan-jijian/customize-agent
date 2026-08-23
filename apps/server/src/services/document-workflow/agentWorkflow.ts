import * as path from 'node:path';
import { listKnowledgeFiles } from '../knowledge/kbService';
import type { AgentChapterTask, AgentDocumentPlan, AgentReviewResult } from './agentPlanner';
import type { DocumentExecutionStage, DocumentFact, DocumentTemplate, ProjectBinding, ProjectGraph, ValidationIssue } from './types';
import { sourcePhraseIssues } from './markdownComposer';
import { displayStage } from './progress';
import { stableHash, stringifyFactValue } from './utils';

export interface AgentMaterialScope {
  selectedRoots: string[];
  selectedFiles: string[];
  totalAvailableFiles: number;
  ambiguous: boolean;
  locked: boolean;
  reason: string;
  rejectedRoots: string[];
  scopeHash: string;
}

export interface AgentMaterialSnapshotFile {
  path: string;
  root: string;
  fileName: string;
  chunkCount: number;
  indexedAt?: number;
  status?: string;
  hash: string;
}

export interface AgentMaterialSnapshot {
  files: AgentMaterialSnapshotFile[];
  totalFiles: number;
  totalChunks: number;
  roots: string[];
  createdAt: number;
  snapshotHash: string;
}

export type AgentWorkflowNodeStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'repairing';

export interface AgentWorkflowNode {
  id: string;
  type: string;
  status: AgentWorkflowNodeStatus;
  startedAt: number;
  completedAt?: number;
  inputSummary?: string;
  outputSummary?: string;
  metrics?: Record<string, string | number | boolean>;
  issues?: ValidationIssue[];
}

export interface AgentWorkflowContext {
  runId: string;
  templateId: string;
  requirement: string;
  projectRoot: string;
  materialScope: AgentMaterialScope;
  materialSnapshot: AgentMaterialSnapshot;
  nodes: AgentWorkflowNode[];
  facts: DocumentFact[];
  baseProjectGraph: ProjectGraph;
  documentPlan?: AgentDocumentPlan;
  chapterTasks?: AgentChapterTask[];
  reviewResults?: Record<string, AgentReviewResult>;
  issues: ValidationIssue[];
  createdAt: number;
}

type KnowledgeFile = { relativePath: string; chunkCount?: number; indexedAt?: number; status?: string };

const BACKSTAGE_OR_FALLBACK_TEXT_RE = /知识库|系统暂未|项目资料暂未|资料未明确|暂未明确|待确认|待资料复核|待系统|通用兜底(?:段落|模板)?|兜底(?:占位|模板|内容)|未检索到|资料不足|无法确认|建议补充|不适用|COL\d+|可核验信息|以本项目招标文件明确内容为准/u;

function normalizePathKey(filePath: string) {
  return filePath.replace(/\\/gu, '/').replace(/^\/+|\/+$/gu, '');
}

function topLevelGroup(relativePath: string) {
  const parts = normalizePathKey(relativePath).split('/').filter(Boolean);
  return parts.length > 1 ? parts[0] : path.basename(parts[0] || '当前项目');
}

function normalizeScopeText(text: string) {
  return text.replace(/[\s_\-—（）()【】、，,.。·]/gu, '').replaceAll('[', '').replaceAll(']', '').toLowerCase();
}

function scoreGroupByRequirement(group: string, requirement: string) {
  const normalizedGroup = normalizeScopeText(group);
  const normalizedRequirement = normalizeScopeText(requirement);
  if (normalizedGroup.length >= 4 && normalizedRequirement.includes(normalizedGroup.slice(0, Math.min(16, normalizedGroup.length)))) return 100;
  const genericTokens = new Set(['项目', '工程', '施工', '总承包', '资料', '招标', '图纸', '清单']);
  return group.split(/(?:\s|_|-|—|（|）|\(|\)|【|】|\[|\]|、|，|,|\.)+/u)
    .filter(token => token.length >= 2 && !genericTokens.has(token))
    .reduce((score, token) => score + (requirement.includes(token) ? Math.min(20, token.length) : 0), 0);
}

function isUsableKnowledgeFile(file: KnowledgeFile) {
  return file.status !== 'disk' && file.status !== 'error' && Number(file.indexedAt || 0) > 0 && Number(file.chunkCount || 0) > 0;
}

function templateProjectBindings(template: DocumentTemplate): ProjectBinding[] {
  return (template.projectBindings || []).filter(binding => binding.materialRootPath).map(binding => ({ materialRootPath: normalizePathKey(binding.materialRootPath) }));
}

function selectByRoots(files: KnowledgeFile[], roots: string[]) {
  return files.filter(file => roots.some(root => normalizePathKey(file.relativePath) === root || normalizePathKey(file.relativePath).startsWith(`${root}/`)));
}

function groupFiles(files: KnowledgeFile[]) {
  const groups = new Map<string, KnowledgeFile[]>();
  for (const file of files) {
    const root = topLevelGroup(file.relativePath);
    groups.set(root, [...(groups.get(root) || []), file]);
  }
  return groups;
}

export function resolveAgentMaterialScope(projectRoot: string, template: DocumentTemplate, requirement = ''): AgentMaterialScope {
  const active = listKnowledgeFiles(projectRoot).filter(isUsableKnowledgeFile);
  const bindings = templateProjectBindings(template);
  const boundRoots = bindings.map(binding => binding.materialRootPath).filter(Boolean);
  const baseFiles = boundRoots.length ? selectByRoots(active, boundRoots) : active;
  const groups = groupFiles(baseFiles);
  const req = requirement.trim();
  const rejectedRoots = [...groups.keys()];

  if (req) {
    const scored = [...groups.entries()]
      .map(([root, files]) => ({ root, files, score: scoreGroupByRequirement(root, req) }))
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score);
    if (scored.length === 1 || (scored.length > 1 && scored[0].score > scored[1].score)) {
      const selectedRoots = [scored[0].root];
      const selectedFiles = scored[0].files.map(file => file.relativePath);
      return {
        selectedRoots,
        selectedFiles,
        totalAvailableFiles: active.length,
        ambiguous: false,
        locked: true,
        reason: `用户需求唯一匹配资料组：${scored[0].root}`,
        rejectedRoots: rejectedRoots.filter(root => !selectedRoots.includes(root)),
        scopeHash: stableHash({ selectedRoots, selectedFiles }),
      };
    }
    if (scored.length > 1) {
      const selectedRoots = scored.filter(item => item.score === scored[0].score).map(item => item.root);
      return {
        selectedRoots: [],
        selectedFiles: [],
        totalAvailableFiles: active.length,
        ambiguous: true,
        locked: false,
        reason: `用户需求同时匹配多个资料组：${selectedRoots.join('、')}`,
        rejectedRoots,
        scopeHash: stableHash({ ambiguous: true, selectedRoots }),
      };
    }
  }

  if (boundRoots.length === 1) {
    const selectedFiles = baseFiles.map(file => file.relativePath);
    return {
      selectedRoots: boundRoots,
      selectedFiles,
      totalAvailableFiles: active.length,
      ambiguous: false,
      locked: true,
      reason: `模板绑定唯一资料组：${boundRoots[0]}`,
      rejectedRoots: rejectedRoots.filter(root => !boundRoots.includes(root)),
      scopeHash: stableHash({ selectedRoots: boundRoots, selectedFiles }),
    };
  }

  return {
    selectedRoots: [],
    selectedFiles: [],
    totalAvailableFiles: active.length,
    ambiguous: true,
    locked: false,
    reason: boundRoots.length > 1 ? `模板绑定多个资料组但需求未唯一指定：${boundRoots.join('、')}` : '未绑定资料组且需求未唯一指定资料范围，禁止回退全量资料',
    rejectedRoots,
    scopeHash: stableHash({ ambiguous: true, boundRoots, requirement }),
  };
}

export function buildAgentMaterialSnapshot(projectRoot: string, scope: AgentMaterialScope): AgentMaterialSnapshot {
  const filesByPath = new Map(listKnowledgeFiles(projectRoot).map(file => [file.relativePath, file]));
  const files = scope.selectedFiles.map(filePath => {
    const file = filesByPath.get(filePath);
    const chunkCount = Number(file?.chunkCount || 0);
    return {
      path: filePath,
      root: topLevelGroup(filePath),
      fileName: path.basename(filePath),
      chunkCount,
      indexedAt: file?.indexedAt,
      status: file?.status,
      hash: stableHash({ filePath, chunkCount, indexedAt: file?.indexedAt, status: file?.status }),
    };
  });
  return {
    files,
    totalFiles: files.length,
    totalChunks: files.reduce((sum, file) => sum + file.chunkCount, 0),
    roots: [...new Set(files.map(file => file.root))],
    createdAt: Date.now(),
    snapshotHash: stableHash(files.map(file => ({ path: file.path, hash: file.hash }))),
  };
}

function factSourceFiles(facts: DocumentFact[]) {
  return [...new Set(facts.map(fact => fact.sourceFile).filter(Boolean))];
}

function factsByPattern(facts: DocumentFact[], pattern: RegExp) {
  return facts.filter(fact => pattern.test(`${fact.fieldId || ''} ${fact.fieldName || ''} ${fact.key} ${stringifyFactValue(fact.value)}`));
}

function factValue(fact: DocumentFact) {
  return stringifyFactValue(fact.value).replace(/\s+/gu, ' ').trim();
}

const META_FACT_KEYS = new Set(['资料文件', '资料组', '资料角色', '资料内容事实', '章节意图候选', '项目名称候选']);

export function buildBaseProjectGraph(input: { facts: DocumentFact[]; materialSnapshot: AgentMaterialSnapshot; requirement?: string }): ProjectGraph {
  const facts = input.facts.filter(fact => !META_FACT_KEYS.has(fact.key) && factValue(fact));
  const projectFacts = factsByPattern(facts, /项目名称|工程名称|招标项目名称|建设地点|建设规模|招标范围|施工范围|建设内容/u);
  const scheduleFacts = factsByPattern(facts, /工期|日历天|进度|开工|竣工/u);
  const qualityFacts = factsByPattern(facts, /质量|验收|合格|标准|规范/u);
  const resourceFacts = factsByPattern(facts, /清单|工程量|材料|设备|机械|劳动力|资源/u);
  const safetyFacts = factsByPattern(facts, /安全|文明|环保|危大|风险/u);
  const scopeText = projectFacts.slice(0, 8).map(fact => `${fact.key}：${factValue(fact)}`).join('；');

  return {
    works: scopeText ? [{ name: input.materialSnapshot.roots[0] || '当前项目', scope: scopeText, sourceFiles: factSourceFiles(projectFacts), relatedItems: resourceFacts.slice(0, 8).map(fact => factValue(fact)) }] : [],
    methods: [],
    resources: resourceFacts.slice(0, 30).map(fact => ({ name: fact.key, type: 'material' as const, spec: factValue(fact), quantity: '', unit: '', sourceFiles: fact.sourceFile ? [fact.sourceFile] : [] })),
    schedule: scheduleFacts.slice(0, 10).map(fact => ({ milestone: fact.key, duration: factValue(fact), startDate: '', endDate: '', sourceFiles: fact.sourceFile ? [fact.sourceFile] : [] })),
    standards: qualityFacts.slice(0, 16).map(fact => ({ code: fact.key, description: factValue(fact), sourceFiles: fact.sourceFile ? [fact.sourceFile] : [] })),
    risks: safetyFacts.slice(0, 16).map(fact => ({ risk: factValue(fact), level: 'medium' as const, mitigation: '', sourceFiles: fact.sourceFile ? [fact.sourceFile] : [] })),
    requirements: factsByPattern(facts, /招标|投标|合同|承包|响应|要求|补疑|澄清|答疑/u).slice(0, 20).map(fact => ({ category: fact.key, detail: factValue(fact), sourceFiles: fact.sourceFile ? [fact.sourceFile] : [] })),
    siteConditions: factsByPattern(facts, /现场|周边|交通|既有|保护|场地/u).slice(0, 12).map(fact => ({ condition: factValue(fact), impact: '', sourceFiles: fact.sourceFile ? [fact.sourceFile] : [] })),
    addendumChanges: [],
    gaps: [],
    generatedAt: Date.now(),
  };
}

export function createAgentWorkflowContext(input: { template: DocumentTemplate; requirement?: string; projectRoot: string; facts: DocumentFact[]; projectGraph?: ProjectGraph; projectGraphSource?: string }): AgentWorkflowContext {
  const materialScope = resolveAgentMaterialScope(input.projectRoot, input.template, input.requirement || '');
  if (materialScope.ambiguous || !materialScope.locked || materialScope.selectedFiles.length === 0) {
    throw new Error(`资料范围未锁定：${materialScope.reason}`);
  }
  const materialSnapshot = buildAgentMaterialSnapshot(input.projectRoot, materialScope);
  const baseProjectGraph = input.projectGraph || buildBaseProjectGraph({ facts: input.facts, materialSnapshot, requirement: input.requirement });
  const graphNodeId = input.projectGraph ? 'project-graph' : 'project-graph-runtime';
  const graphNodeType = 'project_graph';
  const graphSummaryPrefix = input.projectGraph ? '预处理完整项目图谱' : '运行期项目图谱草案';
  const createdAt = Date.now();
  return {
    runId: `run-${createdAt}-${stableHash({ templateId: input.template.id, requirement: input.requirement || '', scopeHash: materialScope.scopeHash }).slice(0, 8)}`,
    templateId: input.template.id,
    requirement: input.requirement || '',
    projectRoot: input.projectRoot,
    materialScope,
    materialSnapshot,
    nodes: [
      { id: 'material-scope', type: 'material_scope', status: 'completed', startedAt: createdAt, completedAt: createdAt, outputSummary: materialScope.reason, metrics: { selectedFiles: materialScope.selectedFiles.length, rejectedRoots: materialScope.rejectedRoots.length } },
      { id: 'material-snapshot', type: 'material_snapshot', status: 'completed', startedAt: createdAt, completedAt: createdAt, outputSummary: `${materialSnapshot.totalFiles} 份资料，${materialSnapshot.totalChunks} 个切片`, metrics: { totalFiles: materialSnapshot.totalFiles, totalChunks: materialSnapshot.totalChunks } },
      { id: graphNodeId, type: graphNodeType, status: 'completed', startedAt: createdAt, completedAt: createdAt, outputSummary: `${graphSummaryPrefix}：${baseProjectGraph.works.length}工程 ${baseProjectGraph.resources.length}资源 ${baseProjectGraph.schedule.length}工期 ${baseProjectGraph.standards.length}标准`, metrics: { facts: input.facts.length, precomputed: Boolean(input.projectGraph), source: input.projectGraphSource || 'runtime' } },
    ],
    facts: input.facts,
    baseProjectGraph,
    issues: [],
    createdAt,
  };
}

/** P1-11 agentWorkflow 节点节流：节点数超过上限时把历史 completed/failed/skipped 节点合并为摘要节点，
 * 避免 20+ 章文档 nodes 随章数线性膨胀（前端渲染/序列化开销）。保留最近 keepRecent 个节点与 project_graph 等关键节点。 */
export function throttleAgentWorkflowNodes(context: AgentWorkflowContext, limit = 200, keepRecent = 50) {
  if (context.nodes.length <= limit) return;
  const recent = context.nodes.slice(-keepRecent);
  const candidates = context.nodes.slice(0, context.nodes.length - keepRecent);
  const archivable = candidates.filter(node => node.type !== 'project_graph' && (node.status === 'completed' || node.status === 'failed' || node.status === 'skipped'));
  const kept = candidates.filter(node => !archivable.includes(node));
  if (archivable.length === 0) return;
  const summaryNode: AgentWorkflowNode = {
    id: `nodes-archive-${Date.now()}`,
    type: 'summary',
    status: 'completed',
    startedAt: archivable[0].startedAt,
    completedAt: archivable[archivable.length - 1].completedAt || Date.now(),
    outputSummary: `已归档 ${archivable.length} 个历史节点（${[...new Set(archivable.map(node => node.type))].join('、')}）`,
    metrics: { archivedNodes: archivable.length },
  };
  context.nodes.splice(0, context.nodes.length, ...kept, summaryNode, ...recent);
}

export function agentWorkflowStages(context: AgentWorkflowContext): DocumentExecutionStage[] {
  const graphNode = context.nodes.find(node => node.type === 'project_graph');
  const precomputed = Boolean(graphNode?.metrics?.precomputed);
  return [
    displayStage({ type: 'validation', roleId: 'agent-material-scope', status: 'success', message: `资料范围已锁定：${context.materialScope.selectedRoots.join('、')}`, details: [`${context.materialScope.reason}`, `入选资料：${context.materialScope.selectedFiles.length}/${context.materialScope.totalAvailableFiles}`, `已排除资料组：${context.materialScope.rejectedRoots.slice(0, 8).join('、') || '无'}`] }, { subtitle: 'Agent 资料范围锁定' }),
    displayStage({ type: 'knowledge_retrieval', roleId: 'agent-material-snapshot', status: 'success', message: `资料快照已固定：${context.materialSnapshot.totalFiles} 份资料、${context.materialSnapshot.totalChunks} 个切片`, details: context.materialSnapshot.files.slice(0, 10).map(file => `${file.root}｜${file.fileName}｜${file.chunkCount}切片`) }, { subtitle: 'Agent 资料快照' }),
    displayStage({ type: 'file_understanding', roleId: precomputed ? 'agent-project-graph-cache' : 'agent-project-graph-runtime', status: 'success', message: precomputed ? `已复用预处理完整项目图谱：${context.baseProjectGraph.works.length}工程 ${context.baseProjectGraph.resources.length}资源 ${context.baseProjectGraph.schedule.length}工期 ${context.baseProjectGraph.standards.length}标准` : `运行期项目图谱草案已建立：${context.baseProjectGraph.works.length}工程 ${context.baseProjectGraph.resources.length}资源 ${context.baseProjectGraph.schedule.length}工期 ${context.baseProjectGraph.standards.length}标准`, details: precomputed ? [`完整图谱来自入库后 project-intelligence 预处理`, `事实数：${context.facts.length}`] : [`缓存缺失时用于资料范围和 Planner 预备分析；正式完整项目图谱会随后由 LLM 构建`, `事实数：${context.facts.length}`] }, { subtitle: precomputed ? 'Agent 完整项目图谱缓存' : 'Agent 项目图谱预备分析' }),
  ];
}

export function formalTextGateIssues(markdown: string): ValidationIssue[] {
  const lines = markdown.split(/\r?\n/u);
  const issues: ValidationIssue[] = [];
  lines.forEach((line, index) => {
    if (BACKSTAGE_OR_FALLBACK_TEXT_RE.test(line)) {
      issues.push({ level: 'error', severity: 'blocker', category: 'style', owner: 'system', message: `正式正文不得出现后台或兜底话术：第 ${index + 1} 行`, suggestion: '必须改为有事实依据的正式表达；非必填缺失字段应删除，必填事实缺失应阻断生成。' });
    }
  });
  return [...issues, ...sourcePhraseIssues(markdown)].slice(0, 20);
}
