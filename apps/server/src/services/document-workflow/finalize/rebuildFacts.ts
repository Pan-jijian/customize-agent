/**
 * rebuildFacts：证据收口 + 事实主表重建 + 权威口径抽取（P2 拆分，方案 5.2）。
 * 由 finalizeGeneration 代码块机械搬迁而来，业务语义逐字一致（行为保持）。
 * decisionLockEntries 计算由语义矛盾检测轮迁入本阶段末尾（依赖事实池局部变量，提前计算行为等价）。
 */
import { assertEvidenceInProjectScope, filterEvidenceByProjectScope, filterFactsByProjectScope } from '../projectMaterialScope';
import { selectEvidenceByBudget } from '../evidence';
import { extractFacts, extractFactsWithLlm, extractLocalFactPool, buildFactsModel, shouldRunLlmFactExtraction } from '../factsModel';
import { applyScopeConflictResolutions, buildCanonicalFactModel, detectNumericScopeConflicts, extractDrawingAnnotationFacts } from '../factGovernance';
import { extractScheduleAuthority, extractAssemblyRateAuthority, extractProjectScaleSummary, extractSupportSystemAuthority } from '../documentIntegrityChecks';
import { extractDecisionLockEntries } from '../integratedBlueprint';
import { factsWithEvidenceSource } from '../documentGeneratorHelpers';
import { stringifyFactValue, throwIfAborted } from '../utils';
import { upsertProgressStage } from '../progress';
import type { DocumentFact, DocumentExecutionStage } from '../types';
import type { FinalizeSession } from './finalizeSession';

export async function stageRebuildFacts(session: FinalizeSession): Promise<void> {
  const generatedChapterEvidence = filterEvidenceByProjectScope(session.chapterDrafts.flatMap(chapter => chapter.evidence || []), session.projectMaterialScope);
  assertEvidenceInProjectScope(generatedChapterEvidence, session.projectMaterialScope, 'finalize:chapter-evidence');
  if (generatedChapterEvidence.length > 0) {
    session.allEvidence.push(...generatedChapterEvidence);
    // 证据全量保留（无预算截断）：章节证据收集后不再压缩，数据零丢失
    session.allEvidence.splice(0, session.allEvidence.length, ...selectEvidenceByBudget(session.allEvidence, { preservePinned: true }));
  }
  const scopedAllEvidence = filterEvidenceByProjectScope(session.allEvidence, session.projectMaterialScope);
  session.allEvidence.splice(0, session.allEvidence.length, ...scopedAllEvidence);
  assertEvidenceInProjectScope(session.allEvidence, session.projectMaterialScope, 'finalize:all-evidence');

  throwIfAborted(session.signal);
  const compactPostFileEvidence = selectEvidenceByBudget(session.allEvidence, { preservePinned: true });
  session.allEvidence.splice(0, session.allEvidence.length, ...filterEvidenceByProjectScope(compactPostFileEvidence, session.projectMaterialScope));
  assertEvidenceInProjectScope(session.allEvidence, session.projectMaterialScope, 'finalize:post-file-understanding');

  session.facts = extractFacts(session.template, session.allEvidence, session.documentSpec);
  // 本地事实池统一入口（与生成准备抽取点同源，见 factsModel.extractLocalFactPool）；
  // structuredTables 经工作簿解析缓存复用生成准备阶段对同批表文件的解析结果，零重复磁盘 IO
  const { localFacts, projectBasicFacts, preciseFacts, structuredTables } = extractLocalFactPool({ evidence: session.allEvidence, template: session.template, spec: session.documentSpec, profile: session.domainProfile, scope: session.projectMaterialScope, diagnostics: session.generationDiagnostics });
  const preLlmFacts = [...localFacts, ...projectBasicFacts, ...preciseFacts];
  let llmExtraction: { facts: DocumentFact[]; stages: DocumentExecutionStage[] } = { facts: [], stages: [{ type: 'fact_extraction', roleId: 'llm-json', status: 'skipped', message: '已有本地/资料事实覆盖主要必需字段，跳过 LLM 全量事实抽取' }] };
  if (shouldRunLlmFactExtraction(preLlmFacts, session.template, session.documentSpec)) {
    const factExtractionEvidence = selectEvidenceByBudget(session.allEvidence, { preservePinned: true });
    try {
      llmExtraction = await extractFactsWithLlm(factExtractionEvidence, session.factExtractionPromptTexts, session.template, session.documentSpec, session.signal, session.generationDiagnostics);
    } catch (err) {
      if (session.signal?.aborted) throw err;
      console.error('[gen] fact extraction failed:', err);
    }
  }
  for (const stage of llmExtraction.stages) upsertProgressStage(session.progressStages, stage);
  // 4.19 图纸标注事实补抽（finalize 同源接入）：生成准备阶段接入的 CAD 语义标注（坡底线/钢管土钉）
  // 只喂了 Writer 输入；finalize 重建事实主表未接入 → 危大/支护形式检查器输入槽位全空（真实回归实测：
  // 正文深度/支护形式留白、canonical 空）。与 documentGenerator L299 同口径确定性补抽并入主表链。
  const drawingAnnotationFacts = extractDrawingAnnotationFacts(session.allEvidence);
  session.structuredFacts = filterFactsByProjectScope(factsWithEvidenceSource([...localFacts, ...projectBasicFacts, ...preciseFacts, ...llmExtraction.facts, ...drawingAnnotationFacts], session.allEvidence), session.projectMaterialScope);
  // 源级同口径冲突裁决回写：裁决值统一进入事实主表与确定性校验基准，避免正文被主表败选值误导（如 4645㎡ 与 4646㎡ 并存）
  session.governedStructuredFacts = applyScopeConflictResolutions(session.structuredFacts, session.scopeConflicts ?? detectNumericScopeConflicts(session.structuredFacts));
  for (const fact of session.governedStructuredFacts) session.facts[fact.key] = `${stringifyFactValue(fact.value)}（来源：${fact.sourceFile}，角色：${fact.roleId}）`;

  session.factsModel = await buildFactsModel(session.governedStructuredFacts, structuredTables, session.missingItems, session.documentSpec, session.domainProfile);
  // 4.19 canonical 主表构建（finalize 同源接入）：危大判定/支护形式一致性检查器消费 factsModel.canonical
  // 的 excavation_depth/foundation_support_form 槽位（byKey）；此前 finalize 从未构建 canonical，
  // 补抽事实即使进入主表也无 canonical 索引 → excavationHazardClassificationIssues 永远无输入
  const canonicalFactsModel = buildCanonicalFactModel({ facts: session.governedStructuredFacts, projectRoot: session.projectRoot, requirement: session.requirement || '', templateId: session.template.id });
  session.factsModel.canonical = canonicalFactsModel;
  // 4.17.3 计划总工期权威口径：factsModel 计划工期事实卡作为全文工期确定性修复的裁决基准
  //（庐江实测：45 vs 210 两套体系各自带表格，表格口径不唯一导致修复零产出、修复节点 failed）
  session.scheduleAuthority = extractScheduleAuthority(session.factsModel);
  // 4.17.4：装配率权威口径（38.4% vs 招标锁定 30%）与工程规模摘要（6.1 一览表套话填充）
  session.assemblyRateAuthority = extractAssemblyRateAuthority(session.factsModel);
  session.scaleSummary = extractProjectScaleSummary(session.factsModel);
  // B1 支护体系权威（图纸/地质槽位 foundation_support_form）：交付前确定性裁决依据
  session.supportAuthority = extractSupportSystemAuthority(session.factsModel);
  // P2 拆分迁移：决策锁实体-选择冲突比对条目原在语义矛盾检测轮计算，随轮迁至事实主表重建末尾
  //（依赖 localFacts/projectBasicFacts/preciseFacts 局部变量，提前计算行为等价——中间阶段不修改这些事实池）
  session.decisionLockEntries = extractDecisionLockEntries({ facts: [...localFacts, ...projectBasicFacts, ...preciseFacts], evidence: session.allEvidence });

}
