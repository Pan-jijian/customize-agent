import * as path from 'node:path';
import { listKnowledgeFiles, type KnowledgeFileDiscoveryItem } from '../knowledge/kbService';
import { applyKeywordRules, MATERIAL_ROLE_RULES } from './documentSemanticRules';

export type MaterialRole =
  | 'project_overview'
  | 'requirement_document'
  | 'addendum'
  | 'structured_data'
  | 'budget_cost'
  | 'design_specification'
  | 'resource_recommendation'
  | 'schedule_quality_safety'
  | 'scope_description'
  | 'technical_specification'
  | 'risk_constraints';

export interface MaterialEvidenceRef {
  filePath: string;
  fileName: string;
  role: MaterialRole;
  chunkCount?: number;
}

export interface ProjectMaterialSummary {
  projectId: string;
  projectName: string;
  generatedAt: number;
  fingerprint: {
    projectNames: string[];
    documentNos: string[];
    fileGroups: string[];
    confidence: number;
  };
  contaminationCandidates: string[];
  source: {
    totalFiles: number;
    selectedFiles: number;
    selectionReason: string;
    ambiguous: boolean;
  };
  facts: {
    projectName?: string;
    documentNo?: string;
    scopeDescriptions?: string[];
    professionalScopes?: string[];
    scheduleRequirement?: string;
    qualityRequirement?: string;
    safetyRequirement?: string;
    materialBrandRequirement?: string;
    ownerNames?: string[];
    locationNames?: string[];
    scheduleValues?: string[];
    qualityTargets?: string[];
  };
  materialInventory: Record<MaterialRole, MaterialEvidenceRef[]>;
  extractedSections: {
    projectOverview: string;
    scopeSummary: string;
    designSummary: string;
    structuredDataSummary: string;
    scheduleQualitySafetySummary: string;
    constraintsAndRisks: string;
  };
  coverage: {
    requiredRoles: MaterialRole[];
    satisfiedRoles: MaterialRole[];
    missingRoles: MaterialRole[];
    materialCompletenessRate: number;
  };
}

const REQUIRED_ROLES: MaterialRole[] = ['project_overview', 'requirement_document', 'addendum', 'structured_data', 'design_specification', 'schedule_quality_safety', 'scope_description'];
const ALL_ROLES: MaterialRole[] = ['project_overview', 'requirement_document', 'addendum', 'structured_data', 'budget_cost', 'design_specification', 'resource_recommendation', 'schedule_quality_safety', 'scope_description', 'technical_specification', 'risk_constraints'];

function emptyInventory(): Record<MaterialRole, MaterialEvidenceRef[]> {
  const inventory = {} as Record<MaterialRole, MaterialEvidenceRef[]>;
  for (const role of ALL_ROLES) inventory[role] = [];
  return inventory;
}

function roleForFile(relativePath: string): MaterialRole[] {
  const roles = new Set<MaterialRole>(applyKeywordRules(relativePath, MATERIAL_ROLE_RULES));
  roles.add('project_overview');
  return [...roles];
}

function pathSegments(files: Array<{ relativePath: string }>) {
  const segments: string[] = [];
  for (const file of files) {
    for (const segment of file.relativePath.split(/[\\/]/gu)) {
      if (segment) segments.push(segment);
    }
  }
  return segments;
}

function inferProjectName(files: Array<{ relativePath: string }>) {
  let fileLike: string | undefined;
  for (const candidate of pathSegments(files)) {
    if (!/项目/iu.test(candidate) || candidate.length < 6) continue;
    if (!/\.\w+$/u.test(candidate)) return candidate;
    fileLike ||= candidate;
  }
  return fileLike?.replace(/\.(?:pdf|docx?|xlsx?|xls|dwg)$/iu, '') || '当前知识库项目';
}

function inferDocumentNo(files: Array<{ relativePath: string }>) {
  for (const file of files) {
    const matched = file.relativePath.match(/\b\d{4}[A-Z]{2,}\d{4,}\b/u)?.[0];
    if (matched) return matched;
  }
  return undefined;
}

function uniq<T>(items: T[]) {
  const seen = new Set<T>();
  const result: T[] = [];
  for (const item of items) {
    if (!item || seen.has(item)) continue;
    seen.add(item);
    result.push(item);
  }
  return result;
}

function stripKnownExtension(value: string) {
  return value.replace(/\.(?:pdf|docx?|xlsx?|xls|dwg)$/iu, '').trim();
}

function extractProjectNameCandidates(files: Array<{ relativePath: string }>) {
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const segment of pathSegments(files)) {
    const normalized = stripKnownExtension(segment);
    if (!/项目|任务|文档|合同|计划|方案/iu.test(normalized) || normalized.length < 6 || seen.has(normalized)) continue;
    seen.add(normalized);
    candidates.push(normalized);
    if (candidates.length >= 12) break;
  }
  return candidates;
}

function buildFingerprint(selectedFiles: Array<{ relativePath: string }>, allFiles: Array<{ relativePath: string }>) {
  const selectedProjectNames = extractProjectNameCandidates(selectedFiles);
  const allProjectNames = extractProjectNameCandidates(allFiles);
  const documentNos = uniq(selectedFiles.map(file => file.relativePath).join('\n').match(/\b\d{4}[A-Z]{2,}\d{4,}\b/gu) || []);
  const fileGroups = uniq(selectedFiles.map(file => topLevelGroup(file.relativePath)).filter(Boolean) as string[]);
  const confidenceParts = [selectedProjectNames.length > 0, documentNos.length > 0, fileGroups.length === 1];
  return {
    fingerprint: {
      projectNames: selectedProjectNames,
      documentNos,
      fileGroups,
      confidence: confidenceParts.filter(Boolean).length / confidenceParts.length,
    },
    contaminationCandidates: allProjectNames.filter(name => !selectedProjectNames.includes(name)).slice(0, 20),
  };
}

function summarizeFiles(files: MaterialEvidenceRef[], fallback: string) {
  if (files.length === 0) return fallback;
  const names: string[] = [];
  for (const file of files) {
    names.push(stripKnownExtension(file.fileName));
    if (names.length >= 8) break;
  }
  return names.join('、');
}

function collectMatches(text: string, pattern: RegExp, groupIndex: 0 | 1, limit = 8) {
  pattern.lastIndex = 0;
  const seen = new Set<string>();
  const values: string[] = [];
  for (const match of text.matchAll(pattern)) {
    const value = (match[groupIndex] || '').trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    values.push(value);
    if (values.length >= limit) break;
  }
  pattern.lastIndex = 0;
  return values;
}

function joinRelativePaths(files: Array<{ relativePath: string }>) {
  let text = '';
  for (const file of files) text += `${file.relativePath}\n`;
  return text;
}

function extractTextFacts(files: Array<{ relativePath: string }>) {
  const text = joinRelativePaths(files);
  return {
    ownerNames: collectMatches(text, /(?:责任主体|委托人|客户|甲方|乙方|需求方|服务方|执行方|负责人)[:：]?([^\\/\n，,。；;]{2,40})/gu, 1),
    locationNames: collectMatches(text, /(?:项目地点|实施地点|服务地点|交付地点|项目地址|执行地点)[:：]?([^\\/\n，,。；;]{2,50})/gu, 1),
    scheduleValues: collectMatches(text, /(\d+\s*(?:天|周|个月|月|年|小时)|(?:周期|期限|交付|完成)[^\\/\n，,。；;]{0,30})/gu, 1),
    qualityTargets: collectMatches(text, /(?:质量(?:标准|目标|要求)?[:：]?[^\\/\n，,。；;]{2,40}|合格|优良)/gu, 0),
  };
}

function normalizePathKey(filePath: string) {
  return filePath.replace(/\\/gu, '/').replace(/^\/+|\/+$/gu, '');
}

function topLevelGroup(relativePath: string) {
  const parts = normalizePathKey(relativePath).split('/').filter(Boolean);
  return parts.length > 1 ? parts[0] : undefined;
}

function scoreGroupByRequirement(group: string, requirement: string) {
  let score = 0;
  for (const raw of group.split(/(?:\s|_|-|—|（|）|\(|\)|【|】|\[|\]|、|，|,)+/u)) {
    const token = raw.trim();
    if (token.length >= 2 && requirement.includes(token)) score += 1;
  }
  return score;
}

function selectMaterialFiles(files: KnowledgeFileDiscoveryItem[], options?: { requirement?: string; boundFilePaths?: string[] }) {
  const active = files.filter(file => file.status !== 'error');
  const boundKeys = new Set((options?.boundFilePaths || []).map(normalizePathKey));
  const boundFiles = active.filter(file => boundKeys.has(normalizePathKey(file.relativePath)));
  if (boundFiles.length > 0) {
    const groups = [...new Set(boundFiles.map(file => topLevelGroup(file.relativePath)).filter(Boolean))];
    const selectedGroup = groups.length === 1 ? groups[0] : undefined;
    return { files: boundFiles, reason: selectedGroup ? `模板绑定文件定位到资料组：${selectedGroup}` : '使用模板显式绑定文件作为资料范围', ambiguous: false };
  }
  const requirement = (options?.requirement || '').trim();
  if (requirement) {
    const scored = new Map<string, number>();
    for (const file of active) {
      const group = topLevelGroup(file.relativePath);
      if (!group) continue;
      const score = scoreGroupByRequirement(group, requirement);
      if (score > 0) scored.set(group, (scored.get(group) || 0) + score);
    }
    const best = [...scored.entries()].sort((a, b) => b[1] - a[1])[0];
    if (best) return { files: active.filter(file => topLevelGroup(file.relativePath) === best[0]), reason: `需求描述定位到资料组：${best[0]}`, ambiguous: false };
  }
  const groups = [...new Set(active.map(file => topLevelGroup(file.relativePath)).filter(Boolean))];
  if (groups.length === 1) return { files: active.filter(file => topLevelGroup(file.relativePath) === groups[0]), reason: `知识库单一资料组：${groups[0]}`, ambiguous: false };
  return { files: active, reason: groups.length > 1 ? `未指定资料组，检测到 ${groups.length} 个资料组，已阻断生成避免跨项目污染` : '未检测到资料组，使用全部资料', ambiguous: groups.length > 1 };
}

export function buildProjectMaterialSummary(projectRoot: string, options?: { requirement?: string; boundFilePaths?: string[]; boundFileRoles?: Array<{ filePath: string; roles: MaterialRole[] }> }): ProjectMaterialSummary {
  const allFiles = listKnowledgeFiles(projectRoot);
  const selection = selectMaterialFiles(allFiles, options);
  const files = selection.files;
  const inventory = emptyInventory();
  const boundRoleMap = new Map((options?.boundFileRoles || []).map(item => [normalizePathKey(item.filePath), item.roles]));
  for (const file of files) {
    const pathKey = normalizePathKey(file.relativePath);
    const boundRoles = [...boundRoleMap.entries()].filter(([key]) => pathKey.endsWith(key) || key.endsWith(pathKey)).flatMap(([, roles]) => roles);
    for (const role of [...new Set([...roleForFile(file.relativePath), ...boundRoles])]) {
      inventory[role].push({ filePath: file.relativePath, fileName: path.basename(file.relativePath), role, chunkCount: file.chunkCount });
    }
  }
  const projectName = inferProjectName(files);
  const documentNo = inferDocumentNo(files);
  const projectIdentity = buildFingerprint(files, allFiles);
  const textFacts = extractTextFacts(files);
  const satisfiedRoles = REQUIRED_ROLES.filter(role => inventory[role].length > 0);
  const missingRoles = REQUIRED_ROLES.filter(role => inventory[role].length === 0);
  return {
    projectId: projectName.replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]/gu, '-').slice(0, 80) || 'current-project',
    projectName,
    generatedAt: Date.now(),
    fingerprint: projectIdentity.fingerprint,
    contaminationCandidates: projectIdentity.contaminationCandidates,
    source: {
      totalFiles: allFiles.length,
      selectedFiles: files.length,
      selectionReason: selection.reason,
      ambiguous: selection.ambiguous,
    },
    facts: {
      projectName,
      documentNo,
      scopeDescriptions: inventory.scope_description.slice(0, 12).map(file => file.fileName.replace(/\.(?:pdf|docx?|xlsx?|xls|dwg)$/iu, '')),
      professionalScopes: [...new Set(inventory.scope_description.concat(inventory.design_specification, inventory.structured_data).slice(0, 16).map(file => file.fileName.replace(/\.(?:pdf|docx?|xlsx?|xls|dwg)$/iu, '')))],
      scheduleRequirement: inventory.schedule_quality_safety.length ? '已识别周期、质量、安全或合规相关资料，生成时应以需求文件、变更说明和技术要求为准。' : undefined,
      qualityRequirement: inventory.schedule_quality_safety.length ? '已识别质量或评价相关资料。' : undefined,
      safetyRequirement: inventory.schedule_quality_safety.length ? '已识别安全或合规相关资料。' : undefined,
      materialBrandRequirement: inventory.resource_recommendation.length ? '已识别资源、材料、设备或品牌相关资料。' : undefined,
      ownerNames: textFacts.ownerNames,
      locationNames: textFacts.locationNames,
      scheduleValues: textFacts.scheduleValues,
      qualityTargets: textFacts.qualityTargets,
    },
    materialInventory: inventory,
    extractedSections: {
      projectOverview: `项目资料组：${projectName}${documentNo ? `，项目/任务编号：${documentNo}` : ''}。`,
      scopeSummary: `范围资料：${summarizeFiles(inventory.scope_description, '未识别到明确范围资料')}。`,
      designSummary: `设计/方案/说明资料：${summarizeFiles(inventory.design_specification, '未识别到设计、方案或说明资料')}。`,
      structuredDataSummary: `结构化数据资料：${summarizeFiles(inventory.structured_data, '未识别到表格、列表或明细资料')}。`,
      scheduleQualitySafetySummary: `周期质量安全资料：${summarizeFiles(inventory.schedule_quality_safety, '未识别到周期、质量或安全专项资料')}。`,
      constraintsAndRisks: `约束和风险资料：${summarizeFiles(inventory.risk_constraints, '未识别到重点难点或约束资料')}。`,
    },
    coverage: {
      requiredRoles: REQUIRED_ROLES,
      satisfiedRoles,
      missingRoles,
      materialCompletenessRate: REQUIRED_ROLES.length ? satisfiedRoles.length / REQUIRED_ROLES.length : 1,
    },
  };
}

export function projectMaterialPrompt(summary: ProjectMaterialSummary) {
  return [
    '## 后台项目资料摘要',
    summary.extractedSections.projectOverview,
    `项目指纹：项目名候选 ${summary.fingerprint.projectNames.join('、') || '无'}；编号 ${summary.fingerprint.documentNos.join('、') || '无'}；资料组 ${summary.fingerprint.fileGroups.join('、') || '无'}；置信度 ${Math.round(summary.fingerprint.confidence * 100)}%。`,
    `内容级事实候选：责任主体 ${summary.facts.ownerNames?.join('、') || '无'}；地点 ${summary.facts.locationNames?.join('、') || '无'}；周期 ${summary.facts.scheduleValues?.join('、') || '无'}；质量 ${summary.facts.qualityTargets?.join('、') || '无'}。`,
    summary.extractedSections.scopeSummary,
    summary.extractedSections.structuredDataSummary,
    summary.extractedSections.designSummary,
    summary.extractedSections.scheduleQualitySafetySummary,
    summary.extractedSections.constraintsAndRisks,
    `资料满足率：${Math.round(summary.coverage.materialCompletenessRate * 100)}%`,
  ].join('\n');
}
