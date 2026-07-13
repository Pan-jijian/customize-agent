import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export type FactFieldType = 'auto';
export type ChapterRuleMode = 'fixed' | 'dynamic';
export interface DynamicChapterRule {
  source: 'file_outline' | 'file_role' | 'fact_group' | 'table_rows' | 'ai_plan';
  sourceRoleIds?: string[];
  minChapters?: number;
  maxChapters?: number;
  titleStrategy?: 'source_title' | 'field_value' | 'ai_summary' | 'template';
  titleTemplate?: string;
  minWordsPerChapter?: number;
  requiredFactIds?: string[];
  requiredFileRoleIds?: string[];
  requiredPromptRoleIds?: string[];
  generationHint?: string;
}
export type GateRuleType = string;
export type GateRuleLevel = 'error' | 'warning' | 'info';
export type GateRuleSubject = 'document' | 'chapter' | 'fact' | 'file_role' | 'prompt_role' | 'table' | 'image' | 'source';
export type GateRuleOperator = 'exists' | 'contains' | 'not_contains' | 'regex_match' | 'regex_not_match' | 'min_count' | 'min_length' | 'all_have_source' | 'image_caption_required' | 'table_explanation_required';

export interface GateRuleEvaluator {
  subject: GateRuleSubject;
  operator: GateRuleOperator;
  target?: string;
  value?: string;
  min?: number;
}

export interface DocumentSpecGateType {
  id: string;
  name: string;
  description?: string;
  builtIn?: boolean;
  defaultLevel: GateRuleLevel;
  evaluator: GateRuleEvaluator;
}

export interface DocumentSpecFactField {
  id: string;
  name: string;
  type: FactFieldType;
  required: boolean;
  sourceRoleIds?: string[];
  extractionHint?: string;
  validationHint?: string;
}

export interface DocumentSpecChapterRule {
  id: string;
  title: string;
  required: boolean;
  order: number;
  minWords?: number;
  requiredFactIds?: string[];
  requiredFileRoleIds?: string[];
  requiredPromptRoleIds?: string[];
  generationHint?: string;
}

export interface DocumentSpecGateRule {
  id: string;
  name: string;
  type: GateRuleType;
  level: GateRuleLevel;
  target?: string;
  value?: string;
  evaluator?: GateRuleEvaluator;
}

export interface DocumentSpecPackage {
  id: string;
  name: string;
  description: string;
  factFields: DocumentSpecFactField[];
  chapterMode: ChapterRuleMode;
  chapterRules: DocumentSpecChapterRule[];
  dynamicChapterRule: DynamicChapterRule;
  gateRules: DocumentSpecGateRule[];
  wordTemplatePath?: string;
  builtIn?: boolean;
}

export const BUILT_IN_GATE_TYPES: DocumentSpecGateType[] = [
  { id: 'required_fact', name: '必需事实', description: '检查指定事实字段是否存在。', builtIn: true, defaultLevel: 'warning', evaluator: { subject: 'fact', operator: 'exists' } },
  { id: 'required_chapter', name: '必需章节', description: '检查指定章节是否存在。', builtIn: true, defaultLevel: 'error', evaluator: { subject: 'chapter', operator: 'exists' } },
  { id: 'required_file_role', name: '必需文件角色', description: '检查项目角色配置是否绑定指定文件角色。', builtIn: true, defaultLevel: 'error', evaluator: { subject: 'file_role', operator: 'exists' } },
  { id: 'required_prompt_role', name: '必需提示词角色', description: '检查项目角色配置是否绑定指定提示词角色。', builtIn: true, defaultLevel: 'warning', evaluator: { subject: 'prompt_role', operator: 'exists' } },
  { id: 'source_required', name: '事实必须有来源', description: '检查结构化事实是否都有资料来源。', builtIn: true, defaultLevel: 'warning', evaluator: { subject: 'source', operator: 'all_have_source' } },
  { id: 'forbidden_text', name: '禁止出现文本', description: '检查全文是否出现禁用文本。', builtIn: true, defaultLevel: 'error', evaluator: { subject: 'document', operator: 'not_contains' } },
  { id: 'min_chapter_length', name: '章节最低字数', description: '检查指定章节是否达到最低字数。', builtIn: true, defaultLevel: 'warning', evaluator: { subject: 'chapter', operator: 'min_length' } },
  { id: 'table_required', name: '必须有表格', description: '检查文档是否包含结构化表格。', builtIn: true, defaultLevel: 'warning', evaluator: { subject: 'table', operator: 'min_count', min: 1 } },
];

const BUILT_IN_GATE_TYPE_MAP = new Map(BUILT_IN_GATE_TYPES.map(type => [type.id, type]));
const VALID_GATE_SUBJECTS: GateRuleSubject[] = ['document', 'chapter', 'fact', 'file_role', 'prompt_role', 'table', 'image', 'source'];
const VALID_GATE_OPERATORS: GateRuleOperator[] = ['exists', 'contains', 'not_contains', 'regex_match', 'regex_not_match', 'min_count', 'min_length', 'all_have_source', 'image_caption_required', 'table_explanation_required'];

function dataDir() {
  const dir = path.join(os.homedir(), '.customize-agent');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function storePath() {
  return path.join(dataDir(), 'document-specs.json');
}

function gateTypesPath() {
  return path.join(dataDir(), 'document-gate-types.json');
}

function safeId(input?: string) {
  return (input || `spec-${Date.now()}`).replace(/[^a-zA-Z0-9_-]/gu, '-').slice(0, 80);
}

function normalizeText(input?: string, fallback = '') {
  return String(input || fallback).trim().slice(0, 500);
}

function uniqueStrings(values: string[] = []) {
  return [...new Set(values.filter(Boolean))];
}

function sanitizeEvaluator(evaluator?: GateRuleEvaluator, fallback?: GateRuleEvaluator): GateRuleEvaluator {
  const source = evaluator || fallback || { subject: 'document' as const, operator: 'contains' as const };
  const subject = VALID_GATE_SUBJECTS.includes(source.subject) ? source.subject : 'document';
  const operator = VALID_GATE_OPERATORS.includes(source.operator) ? source.operator : 'contains';
  const min = Number(source.min);
  return {
    subject,
    operator,
    target: normalizeText(source.target),
    value: normalizeText(source.value),
    min: Number.isFinite(min) && min > 0 ? min : undefined,
  };
}

function evaluatorForRule(rule: DocumentSpecGateRule): GateRuleEvaluator {
  return sanitizeEvaluator(rule.evaluator, BUILT_IN_GATE_TYPE_MAP.get(rule.type)?.evaluator);
}

function sanitizeGateType(type: DocumentSpecGateType): DocumentSpecGateType {
  const id = safeId(type.id || type.name || `gate-type-${Date.now()}`);
  if (BUILT_IN_GATE_TYPE_MAP.has(id)) throw new Error('不能覆盖系统内置门禁类型');
  return {
    id,
    name: normalizeText(type.name, '自定义门禁类型'),
    description: normalizeText(type.description),
    builtIn: false,
    defaultLevel: type.defaultLevel === 'warning' || type.defaultLevel === 'info' ? type.defaultLevel : 'error',
    evaluator: sanitizeEvaluator(type.evaluator),
  };
}

function sanitizeSpec(spec: DocumentSpecPackage): DocumentSpecPackage {
  return {
    id: safeId(spec.id),
    name: spec.name || '未命名规范包',
    description: spec.description || '',
    factFields: Array.isArray(spec.factFields) ? spec.factFields.filter(item => item.name).map(item => ({
      id: safeId(item.id),
      name: item.name,
      type: 'auto' as const,
      required: Boolean(item.required),
      sourceRoleIds: uniqueStrings(Array.isArray(item.sourceRoleIds) ? item.sourceRoleIds : []),
      extractionHint: item.extractionHint || '',
      validationHint: item.validationHint || '',
    })) : [],
    chapterMode: spec.chapterMode === 'fixed' ? 'fixed' : 'dynamic',
    chapterRules: Array.isArray(spec.chapterRules) ? spec.chapterRules.filter(item => item.title).map((item, index) => ({
      id: safeId(item.id),
      title: item.title,
      required: Boolean(item.required),
      order: Number.isFinite(item.order) ? item.order : index,
      minWords: Number.isFinite(item.minWords) ? item.minWords : 0,
      requiredFactIds: uniqueStrings(Array.isArray(item.requiredFactIds) ? item.requiredFactIds : []),
      requiredFileRoleIds: uniqueStrings(Array.isArray(item.requiredFileRoleIds) ? item.requiredFileRoleIds : []),
      requiredPromptRoleIds: uniqueStrings(Array.isArray(item.requiredPromptRoleIds) ? item.requiredPromptRoleIds : []),
      generationHint: item.generationHint || '',
    })) : [],
    dynamicChapterRule: {
      source: ['file_outline', 'file_role', 'fact_group', 'table_rows'].includes(spec.dynamicChapterRule?.source) ? spec.dynamicChapterRule.source : 'ai_plan',
      sourceRoleIds: uniqueStrings(Array.isArray(spec.dynamicChapterRule?.sourceRoleIds) ? spec.dynamicChapterRule.sourceRoleIds : []),
      minChapters: Number.isFinite(spec.dynamicChapterRule?.minChapters) ? spec.dynamicChapterRule.minChapters : undefined,
      maxChapters: Number.isFinite(spec.dynamicChapterRule?.maxChapters) ? spec.dynamicChapterRule.maxChapters : undefined,
      titleStrategy: ['source_title', 'field_value', 'template'].includes(spec.dynamicChapterRule?.titleStrategy || '') ? spec.dynamicChapterRule?.titleStrategy : 'ai_summary',
      titleTemplate: spec.dynamicChapterRule?.titleTemplate || '',
      minWordsPerChapter: Number.isFinite(spec.dynamicChapterRule?.minWordsPerChapter) ? spec.dynamicChapterRule.minWordsPerChapter : undefined,
      requiredFactIds: uniqueStrings(Array.isArray(spec.dynamicChapterRule?.requiredFactIds) ? spec.dynamicChapterRule.requiredFactIds : []),
      requiredFileRoleIds: uniqueStrings(Array.isArray(spec.dynamicChapterRule?.requiredFileRoleIds) ? spec.dynamicChapterRule.requiredFileRoleIds : []),
      requiredPromptRoleIds: uniqueStrings(Array.isArray(spec.dynamicChapterRule?.requiredPromptRoleIds) ? spec.dynamicChapterRule.requiredPromptRoleIds : []),
      generationHint: spec.dynamicChapterRule?.generationHint || '',
    },
    gateRules: Array.isArray(spec.gateRules) ? spec.gateRules.filter(item => item.name).map(item => {
      const type = safeId(item.type || item.name || 'custom_gate');
      return {
        id: safeId(item.id),
        name: item.name,
        type,
        level: item.level === 'warning' || item.level === 'info' ? item.level : 'error',
        target: item.target || '',
        value: item.value || '',
        evaluator: evaluatorForRule({ ...item, type }),
      };
    }) : [],
    wordTemplatePath: spec.wordTemplatePath || '',
    builtIn: Boolean(spec.builtIn),
  };
}

function readSpecs(): DocumentSpecPackage[] {
  try {
    const file = storePath();
    if (!fs.existsSync(file)) return [];
    return (JSON.parse(fs.readFileSync(file, 'utf-8')) as DocumentSpecPackage[]).map(sanitizeSpec);
  } catch {
    return [];
  }
}

function writeSpecs(specs: DocumentSpecPackage[]) {
  fs.writeFileSync(storePath(), JSON.stringify(specs.map(sanitizeSpec), null, 2), 'utf-8');
}

function readCustomGateTypes(): DocumentSpecGateType[] {
  try {
    const file = gateTypesPath();
    if (!fs.existsSync(file)) return [];
    return (JSON.parse(fs.readFileSync(file, 'utf-8')) as DocumentSpecGateType[]).map(sanitizeGateType);
  } catch {
    return [];
  }
}

function writeCustomGateTypes(types: DocumentSpecGateType[]) {
  fs.writeFileSync(gateTypesPath(), JSON.stringify(types.map(sanitizeGateType), null, 2), 'utf-8');
}

export function listDocumentGateTypes() {
  const customTypes = readCustomGateTypes();
  const typeMap = new Map([...BUILT_IN_GATE_TYPES, ...customTypes].map(type => [type.id, type]));
  return [...typeMap.values()];
}

export function saveDocumentGateType(type: DocumentSpecGateType) {
  const sanitized = sanitizeGateType(type);
  const customTypes = readCustomGateTypes().filter(item => item.id !== sanitized.id);
  customTypes.push(sanitized);
  writeCustomGateTypes(customTypes);
  return sanitized;
}

export function deleteDocumentGateType(id: string) {
  if (BUILT_IN_GATE_TYPE_MAP.has(id)) throw new Error('系统内置门禁类型不可删除');
  writeCustomGateTypes(readCustomGateTypes().filter(item => item.id !== id));
}

export function listDocumentSpecs() {
  const customSpecs = readSpecs();
  const specMap = new Map(customSpecs.map(spec => [spec.id, spec]));
  return [...specMap.values()];
}

export function getDocumentSpec(id?: string) {
  if (!id) return undefined;
  return readSpecs().find(spec => spec.id === id);
}

export function saveDocumentSpec(spec: DocumentSpecPackage) {
  const sanitized = sanitizeSpec(spec);
  const specs = readSpecs().filter(item => item.id !== sanitized.id);
  specs.push(sanitized);
  writeSpecs(specs);
  return sanitized;
}

export function deleteDocumentSpec(id: string) {
  writeSpecs(readSpecs().filter(item => item.id !== id));
}
