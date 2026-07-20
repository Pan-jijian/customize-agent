import * as path from 'node:path';
import { listKnowledgeFiles, type KnowledgeFileDiscoveryItem } from './kbService';
import { applyKeywordRules, MATERIAL_ROLE_RULES } from './documentSemanticRules';

export type MaterialRole =
  | 'project_overview'
  | 'tender_document'
  | 'addendum'
  | 'bill_of_quantities'
  | 'control_price'
  | 'drawings'
  | 'brand_recommendation'
  | 'schedule_quality_safety'
  | 'construction_scope'
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
    tenderNos: string[];
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
    tenderNo?: string;
    constructionScope?: string[];
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
    drawingSummary: string;
    boqSummary: string;
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

const REQUIRED_ROLES: MaterialRole[] = ['project_overview', 'tender_document', 'addendum', 'bill_of_quantities', 'drawings', 'schedule_quality_safety', 'construction_scope'];
const ALL_ROLES: MaterialRole[] = ['project_overview', 'tender_document', 'addendum', 'bill_of_quantities', 'control_price', 'drawings', 'brand_recommendation', 'schedule_quality_safety', 'construction_scope', 'technical_specification', 'risk_constraints'];

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

function inferProjectName(files: Array<{ relativePath: string }>) {
  const candidates = files.flatMap(file => file.relativePath.split(/[\\/]/gu)).filter(Boolean);
  const projectLike = candidates.find(item => /项目/iu.test(item) && item.length >= 6 && !/\.\w+$/u.test(item));
  if (projectLike) return projectLike;
  const fileLike = candidates.find(item => /项目/iu.test(item) && item.length >= 6);
  return fileLike?.replace(/\.(?:pdf|docx?|xlsx?|xls|dwg)$/iu, '') || '当前知识库项目';
}

function inferTenderNo(files: Array<{ relativePath: string }>) {
  const joined = files.map(file => file.relativePath).join('\n');
  return joined.match(/\b\d{4}[A-Z]{2,}\d{4,}\b/u)?.[0];
}

function uniq<T>(items: T[]) {
  return [...new Set(items.filter(Boolean))];
}

function extractProjectNameCandidates(files: Array<{ relativePath: string }>) {
  return uniq(files.flatMap(file => file.relativePath.split(/[\\/]/gu))
    .map(item => item.replace(/\.(?:pdf|docx?|xlsx?|xls|dwg)$/iu, '').trim())
    .filter(item => /项目|工程|标段|合同段/iu.test(item) && item.length >= 6))
    .slice(0, 12);
}

function buildFingerprint(selectedFiles: Array<{ relativePath: string }>, allFiles: Array<{ relativePath: string }>) {
  const selectedProjectNames = extractProjectNameCandidates(selectedFiles);
  const allProjectNames = extractProjectNameCandidates(allFiles);
  const tenderNos = uniq(selectedFiles.map(file => file.relativePath).join('\n').match(/\b\d{4}[A-Z]{2,}\d{4,}\b/gu) || []);
  const fileGroups = uniq(selectedFiles.map(file => topLevelGroup(file.relativePath)).filter(Boolean) as string[]);
  const confidenceParts = [selectedProjectNames.length > 0, tenderNos.length > 0, fileGroups.length === 1];
  return {
    fingerprint: {
      projectNames: selectedProjectNames,
      tenderNos,
      fileGroups,
      confidence: confidenceParts.filter(Boolean).length / confidenceParts.length,
    },
    contaminationCandidates: allProjectNames.filter(name => !selectedProjectNames.includes(name)).slice(0, 20),
  };
}

function summarizeFiles(files: MaterialEvidenceRef[], fallback: string) {
  if (files.length === 0) return fallback;
  return files.slice(0, 8).map(file => file.fileName.replace(/\.(?:pdf|docx?|xlsx?|xls|dwg)$/iu, '')).join('、');
}

function extractTextFacts(files: Array<{ relativePath: string }>) {
  const text = files.map(file => file.relativePath).join('\n');
  return {
    ownerNames: uniq([...text.matchAll(/(?:建设单位|招标人|采购人)[:：]?([^\\/\n，,。；;]{2,40})/gu)].map(match => match[1]!.trim())).slice(0, 8),
    locationNames: uniq([...text.matchAll(/(?:建设地点|项目地点|工程地点)[:：]?([^\\/\n，,。；;]{2,50})/gu)].map(match => match[1]!.trim())).slice(0, 8),
    scheduleValues: uniq([...text.matchAll(/(\d+\s*(?:日历天|天|个月|月)|工期[^\\/\n，,。；;]{0,30})/gu)].map(match => match[1]!.trim())).slice(0, 8),
    qualityTargets: uniq([...text.matchAll(/(?:质量(?:标准|目标|要求)?[:：]?[^\\/\n，,。；;]{2,40}|合格|优良)/gu)].map(match => match[0]!.trim())).slice(0, 8),
  };
}

function normalizePathKey(filePath: string) {
  return filePath.replace(/\\/gu, '/').replace(/^\/+|\/+$/gu, '');
}

function topLevelGroup(relativePath: string) {
  const parts = normalizePathKey(relativePath).split('/').filter(Boolean);
  return parts.length > 1 ? parts[0] : undefined;
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
      const tokens = group
        .split(/(?:\s|_|-|—|（|）|\(|\)|【|】|\[|\]|、|，|,)+/u)
        .map(token => token.trim())
        .filter(token => token.length >= 2);
      const score = tokens.reduce((sum, token) => sum + (requirement.includes(token) ? 1 : 0), 0);
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
  const tenderNo = inferTenderNo(files);
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
      tenderNo,
      constructionScope: inventory.construction_scope.slice(0, 12).map(file => file.fileName.replace(/\.(?:pdf|docx?|xlsx?|xls|dwg)$/iu, '')),
      professionalScopes: [...new Set(inventory.construction_scope.concat(inventory.drawings, inventory.bill_of_quantities).slice(0, 16).map(file => file.fileName.replace(/\.(?:pdf|docx?|xlsx?|xls|dwg)$/iu, '')))],
      scheduleRequirement: inventory.schedule_quality_safety.length ? '已识别工期/质量/安全文明相关资料，生成时应以招标文件、补遗和技术要求为准。' : undefined,
      qualityRequirement: inventory.schedule_quality_safety.length ? '已识别质量验收相关资料。' : undefined,
      safetyRequirement: inventory.schedule_quality_safety.length ? '已识别安全文明相关资料。' : undefined,
      materialBrandRequirement: inventory.brand_recommendation.length ? '已识别推荐品牌或材料设备相关资料。' : undefined,
      ownerNames: textFacts.ownerNames,
      locationNames: textFacts.locationNames,
      scheduleValues: textFacts.scheduleValues,
      qualityTargets: textFacts.qualityTargets,
    },
    materialInventory: inventory,
    extractedSections: {
      projectOverview: `项目资料组：${projectName}${tenderNo ? `，招标/项目编号：${tenderNo}` : ''}。`,
      scopeSummary: `施工范围资料：${summarizeFiles(inventory.construction_scope, '未识别到明确施工范围专项资料')}。`,
      drawingSummary: `图纸资料：${summarizeFiles(inventory.drawings, '未识别到图纸资料')}。`,
      boqSummary: `清单资料：${summarizeFiles(inventory.bill_of_quantities, '未识别到工程量清单资料')}。`,
      scheduleQualitySafetySummary: `工期质量安全资料：${summarizeFiles(inventory.schedule_quality_safety, '未识别到工期质量安全专项资料')}。`,
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
    `项目指纹：项目名候选 ${summary.fingerprint.projectNames.join('、') || '无'}；编号 ${summary.fingerprint.tenderNos.join('、') || '无'}；资料组 ${summary.fingerprint.fileGroups.join('、') || '无'}；置信度 ${Math.round(summary.fingerprint.confidence * 100)}%。`,
    `内容级事实候选：建设/招标单位 ${summary.facts.ownerNames?.join('、') || '无'}；地点 ${summary.facts.locationNames?.join('、') || '无'}；工期 ${summary.facts.scheduleValues?.join('、') || '无'}；质量 ${summary.facts.qualityTargets?.join('、') || '无'}。`,
    summary.extractedSections.scopeSummary,
    summary.extractedSections.boqSummary,
    summary.extractedSections.drawingSummary,
    summary.extractedSections.scheduleQualitySafetySummary,
    summary.extractedSections.constraintsAndRisks,
    `资料满足率：${Math.round(summary.coverage.materialCompletenessRate * 100)}%`,
  ].join('\n');
}
