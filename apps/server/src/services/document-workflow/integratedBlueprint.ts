/**
 * 施工组织设计一体化蓝图（一期旁路版·门面）：
 * 生成前一次性产出整篇文档的结构化蓝图 JSON——大纲、量化数据、工序链、工艺参数、
 * 劳动力配置、机械选型、施工方法全部锁定；冻结后各章节智能体只读蓝图切片展开正文。
 *
 * 数据三来源模型（原 L1b standard「标准板块」通道已移除：数据构建后无消费方，2026-09 审计）：
 * - L1a material：项目资料直填（清单解析产物确定性直填，零 LLM）；
 * - L2 derived：计划推导（清单汇总 + 经验区间系数推导，定额工效知识不全时降级为区间表达，
 *   不硬锁具体值）；一期为确定性区间推导，LLM 初稿优化二期接入；
 * - L3 组织规划：施工部署/重难点（一期确定性归纳，锚定清单村分组与资料特征原文；LLM 规划二期接入）。
 *
 * 三期收口定位：旧 planDataMaster/decisionLock 管线已删除，蓝图是唯一计划类数值权威源——
 * 构建蓝图、落盘 assets/blueprint.json、打印诊断；任何阶段失败沿确定性回退继续，永不阻断生成。
 *
 * 模块结构（S6 零行为拆分）：本文件为门面（主入口 + 公共 API 转发），实现按职责拆分至
 * integratedBlueprint/ 子目录——types（类型与 JSON Schema）/ parse（资料解析与提取）/
 * derive（参数桶推导）/ decisionLock（决策锁提取）/ outline（大纲与章规划转换）/
 * capacity（容量密度规划）/ render（渲染与写时对齐）/ validate（冻结前校验）/
 * citation（引用一致性判定链）。对外导出与拆分前逐一对应。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { generatedRoot } from '../document-core/generatedDocumentService';
import { resolveDerivationStrategy } from './blueprintDerivationStrategies';
import type { BillOfQuantitiesResult } from './billOfQuantitiesParser';
import { PROCESS_KNOWLEDGE_CARDS } from './constructionProcessKnowledge';
import { buildBlueprintData } from './integratedBlueprint/derive';
import { buildBlueprintOutline } from './integratedBlueprint/outline';
import { extractProjectName, resolveBillOfQuantities } from './integratedBlueprint/parse';
import { validateBlueprint } from './integratedBlueprint/validate';
import { BLUEPRINT_DOC_TYPE, BLUEPRINT_VERSION } from './integratedBlueprint/types';
import type { BlueprintBuildDiagnostics, BlueprintMeta, BuildIntegratedBlueprintInput, IntegratedBlueprint } from './integratedBlueprint/types';

// ═══════════════════════════════ 公共 API 转发（S6 模块拆分：对外导出与拆分前逐一对应） ═══════════════════════════════

export * from './integratedBlueprint/types';
export { resolveBillOfQuantities, deriveQuantitiesFromBoq, extractRedLineFacts, extractVillageCount, deriveSpecAuthoritiesFromBoq, extractContractFromFacts, resolveEffectiveTotalDays, extractBasisRegulations, extractLocationFromFacts, renderBasicFactsForBlueprint } from './integratedBlueprint/parse';
export { deriveLaborFromBoq, deriveEquipmentFromBoq, deriveMaterialsPlanFromBoq, deriveMilestonesFromBoq, deriveInspectionBatchesFromBoq, deriveEarthworkBalanceFromBoq, deriveTempUtilitiesFromBoq, deriveConstructionDeployment, deriveKeyDifficulties, deriveTestInstruments, deriveSchedule, deriveTempLand, buildBlueprintData } from './integratedBlueprint/derive';
export { extractDecisionLockEntries, decisionLockCategoryMeta, matchDecisionCategory, locateDecisionOptionAnchor, decisionMentionNegated, buildBlueprintDecisionLock } from './integratedBlueprint/decisionLock';
export { buildBlueprintOutline, buildWorkPackageFromBoqSection, fallbackStructureForSections, buildChapterStructureFromBlueprint, estimateChapterMinFeasibleWords } from './integratedBlueprint/outline';
export type { PlannedChapterSubPoint, PlannedChapterBlock, PlannedChapterStructure } from './integratedBlueprint/capacity';
export { renderBlueprintDataTextForBlock, AUTHORITY_DOMAIN_CHAPTER_ROUTES, renderBlueprintChapterAuthorityCard, renderBlueprintBlockSlice, findBlueprintChapter, alignChapterContentToBlueprint, renderBlueprintMustCiteValues } from './integratedBlueprint/render';
export { blueprintDataForChapterInjection, filterBlueprintDataByAvailability } from './integratedBlueprint/validate';
export { AUTHORITY_PLACEHOLDER_RE, fillAuthorityPlaceholders, renderAuthorityPlaceholderCatalog, renderAuthorityValue, type AuthorityPlaceholderFillResult } from './integratedBlueprint/authorityPlaceholders';
export type { BlueprintBlockSliceOptions } from './integratedBlueprint/render';
export { computeBlueprintAuthorityAvailability, chapterBlueprintAuthoritiesNeeded, chapterBlueprintAuthorityGaps, validateBlueprint } from './integratedBlueprint/validate';
export { collectBlueprintCitationCandidates, blueprintCitationVerdict, blueprintCitationConsistencyIssues, rebaseCitationAnchorsForChapters } from './integratedBlueprint/citation';
export type { QuantityConflictAnchor, BlueprintCitationCollection, BlueprintCitationAdjudicationSummary, BlueprintCitationOptions, BlueprintCitationVerdict } from './integratedBlueprint/citation';

// ═══════════════════════════════ 主入口：阶段 0 → A → B → C → D ═══════════════════════════════

/**
 * 构建一体化蓝图（一期旁路主入口）：任何阶段失败沿确定性回退继续，永不 throw；
 * 清单解析失败时降级为「仅大纲骨架 + 空参数桶」蓝图并报告诊断（不阻断现有生成管线）。
 */
export function buildIntegratedBlueprint(input: BuildIntegratedBlueprintInput): IntegratedBlueprint {
  const startedAt = Date.now();
  const diagnostics: BlueprintBuildDiagnostics = {
    stage: '阶段 0',
    laborDerivationBasis: '清单汇总 × 经验区间系数（定额工效知识不全，降级区间表达）',
    llmCalls: 0,
    fallbackUsed: [],
    warnings: [],
    durationMs: 0,
  };
  const meta: BlueprintMeta = {
    version: BLUEPRINT_VERSION,
    projectCode: extractProjectName(input.basicFacts || '', input.templateName) || undefined,
    docType: BLUEPRINT_DOC_TYPE,
    createdAt: new Date().toISOString().slice(0, 10),
    sourceMaterials: [...input.boundFilePaths],
  };
  // 阶段 0：清单解析（确定性零 LLM）
  const boqResolution = resolveBillOfQuantities({ projectRoot: input.projectRoot, boundFilePaths: input.boundFilePaths });
  if (boqResolution.warning) diagnostics.warnings.push(boqResolution.warning);
  const boq = boqResolution.boq;
  if (boq) {
    diagnostics.boq = {
      sourceFile: boq.sourceFile,
      totalEntries: boq.totalEntries,
      complete: boq.complete,
      groupCount: boq.villages.length,
      pagesMissingTotal: boq.villages.reduce((sum, village) => sum + village.pagesMissing.length, 0),
    };
    if (!boq.complete) diagnostics.warnings.push('清单解析完整性校验未通过（序号缺口/页码缺失），蓝图覆盖校验将兜底报告');
  }
  // 阶段 A：参数桶（L1a 直填 / L1b 参考资产 / L2 区间推导 / L3 确定性组织规划）
  diagnostics.stage = '阶段 A';
  const emptyBoq: BillOfQuantitiesResult = { entries: [], villages: [], totalEntries: 0, sourceFile: '', complete: false, diagnostics: { totalChunks: 0, markdownChunks: 0, declarationChunks: 0, skippedChunks: 0, droppedIncompleteRows: 0 } };
  const boqForData = boq || emptyBoq;
  // 工程类型策略解析（确定性双信号，零 LLM）→ 各推导函数按策略组参数执行
  const strategy = resolveDerivationStrategy({ basicFacts: input.basicFacts, templateName: input.templateName, chapterTitles: input.chapterTitles, boq: boqForData });
  // 4.55.23：把分组维度的**正确标签**回填进诊断（取自策略：building=「单位工程」、villageMunicipal=「村」…）——
  // 原实现界面无条件写「N 村」，房建项目把 8 个单位工程显示成「8 村」（用户实测提问"这个项目有村吗"）
  if (diagnostics.boq) diagnostics.boq.groupLabel = strategy.groupLabel;
  const dataResult = buildBlueprintData({
    boq: boqForData,
    basicFacts: input.basicFacts,
    evidence: input.evidence,
    facts: input.facts,
    projectName: meta.projectCode || '',
    strategy,
  });
  diagnostics.warnings.push(...dataResult.diagnostics.warnings);
  // 标书编制规格承接（阶段 1 判定直传）：附表清单数据源缺口审计（表类附表 → 蓝图真实数据字段）——
  // 资料未提供数据的附表（如试验检测仪器/临时用地）在诊断中显性记录，终稿按招标表头骨架渲染并标注人工补齐
  if (input.composition && input.composition.appendixPlan.length > 0) {
    const dataGaps: string[] = [];
    for (const entry of input.composition.appendixPlan) {
      if (entry.kind !== 'table') continue;
      if (entry.dataSource === 'blueprint.equipment' && (dataResult.data.resources?.equipment?.length || 0) === 0) dataGaps.push(`${entry.title}（机械设备数据为空）`);
      else if (entry.dataSource === 'blueprint.labor' && (dataResult.data.resources?.labor?.composition?.length || 0) === 0) dataGaps.push(`${entry.title}（劳动力构成数据为空）`);
      else if (entry.dataSource === 'blueprint.testInstruments') dataGaps.push(`${entry.title}（绑定资料未提供试验检测仪器数据）`);
      else if (entry.dataSource === 'blueprint.tempLand') dataGaps.push(`${entry.title}（绑定资料未提供临时用地数据）`);
    }
    if (dataGaps.length > 0) diagnostics.warnings.push(`文末附表数据源缺口 ${dataGaps.length} 项：${dataGaps.join('、')}（终稿按招标表头骨架渲染并显性标注，由编制人补齐）`);
  }
  // 阶段 B + C：大纲与配方（清单分部 → 工作包，确定性归纳）
  diagnostics.stage = '阶段 B/C';
  const outline = buildBlueprintOutline({ chapterTitles: input.chapterTitles, boq: boqForData, docType: meta.docType });
  // 阶段 D：四道校验
  diagnostics.stage = '阶段 D';
  const blueprint: IntegratedBlueprint = { meta, data: { ...dataResult.data, composition: input.composition }, outline, validation: { passed: false, checks: [] }, diagnostics };
  blueprint.validation = validateBlueprint(blueprint, boq);
  if (!blueprint.validation.passed) {
    diagnostics.warnings.push(`蓝图校验未通过：${blueprint.validation.checks.filter(check => !check.passed).map(check => check.name).join('、')}（一期旁路仅报告，不阻断生成）`);
  }
  diagnostics.durationMs = Date.now() - startedAt;
  return blueprint;
}

/** 落盘蓝图到 generatedDocuments/assets/blueprint.json（一期旁路：可复用资产 + 人工审查入口） */
export function saveBlueprintAsset(projectRoot: string, blueprint: IntegratedBlueprint): string {
  const assetPath = path.join(generatedRoot(projectRoot), 'assets', 'blueprint.json');
  fs.writeFileSync(assetPath, JSON.stringify(blueprint, null, 2), 'utf8');
  return assetPath;
}

/** 从落盘资产读取蓝图（同项目二次生成跳过阶段 0/A-C 的复用入口，二期启用） */
export function loadBlueprintAsset(projectRoot: string): IntegratedBlueprint | undefined {
  const assetPath = path.join(generatedRoot(projectRoot), 'assets', 'blueprint.json');
  if (!fs.existsSync(assetPath)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(assetPath, 'utf8')) as IntegratedBlueprint;
  } catch {
    return undefined;
  }
}

