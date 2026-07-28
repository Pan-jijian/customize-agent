import type { DocumentDraftChapter, DocumentEvidence } from '../document-workflow/types';

/** 文件角色与提示词角色组合后的执行节点。 */
export interface RoleExecutionNode {
  id: string;
  fileRoleId: string;
  fileRoleName: string;
  filePaths: string[];
  processingType?: string;
  promptRoleIds: string[];
  promptRoleNames: string[];
  promptTexts: string[];
  outputType: 'template_requirements' | 'bill_facts' | 'drawing_facts' | 'technical_facts' | 'reference_facts';
}

/** 从模板/用户要求中解析出的章节要求。 */
export interface TenderPlanRequirement {
  id: string;
  title: string;
  requirementText: string;
  requiredContents: string[];
  writingRules: string[];
  evidenceNeeds: string[];
  preferredSourceRoleIds: string[];
}

/** 角色读取阶段形成的正式章节计划。 */
export interface TenderPlanChapter {
  id: string;
  title: string;
  order: number;
  sourceRequirement: string;
  requiredContents: string[];
  writingRules: string[];
  evidenceNeeds: string[];
  minWords?: number;
  requirements: TenderPlanRequirement[];
}

/** 角色节点抽取出的结构化事实。 */
export interface RoleNodeFact {
  key: string;
  value: string;
  sourceFile: string;
  roleId: string;
  processingType?: string;
  relatedChapterHints: string[];
}

/** 单个角色节点执行后的产物。 */
export interface RoleNodeArtifact {
  node: RoleExecutionNode;
  evidence: DocumentEvidence[];
  chapters: TenderPlanChapter[];
  facts: RoleNodeFact[];
  outputRequirements: string[];
  warnings: string[];
  forbidImageInsertion: boolean;
}

/** 角色证据池，按文件聚合证据片段。 */
export interface RoleEvidencePool {
  files: Map<string, DocumentEvidence[]>;
  uniqueFileCount: number;
  bindingCount: number;
  totalChunkCount: number;
  loadedChunkCount: number;
  omittedChunkCount: number;
}

/** 角色 LLM 抽取返回结构。 */
export type RoleExtractionLlmResult = {
  chapters?: unknown;
  facts?: unknown;
  outputRequirements?: unknown;
  warnings?: unknown;
  forbidImageInsertion?: boolean;
};

/** 角色 LLM 返回的章节输入结构。 */
export type RoleExtractionChapterInput = {
  title?: string;
  sourceRequirement?: string;
  requiredContents?: unknown;
  writingRules?: unknown;
  evidenceNeeds?: unknown;
  minWords?: number;
  requirements?: unknown;
};

/** 角色 LLM 返回的事实输入结构。 */
export type RoleExtractionFactInput = {
  key?: string;
  value?: unknown;
  sourceFile?: string;
  relatedChapterHints?: unknown;
};

/** 角色 LLM 返回的要求输入结构。 */
export type RoleExtractionRequirementInput = {
  title?: string;
  requirementText?: string;
  requiredContents?: unknown;
  writingRules?: unknown;
  evidenceNeeds?: unknown;
  preferredSourceRoleIds?: unknown;
};

/** 章节质量修复类别，驱动不同修复提示词策略。 */
export type QualityRepairType = 'missing_structure' | 'loop_closure' | 'fact_conflict' | 'terminology' | 'table_numeric' | 'placeholder' | 'generic';
