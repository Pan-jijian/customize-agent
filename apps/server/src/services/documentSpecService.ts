import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export type FactFieldType = 'text' | 'number' | 'date' | 'table' | 'list';
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
  chapterRules: DocumentSpecChapterRule[];
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

const DEMO_SPEC: DocumentSpecPackage = {
  id: 'delta-force-demo-spec',
  name: '三角洲热门干员攻略规范包',
  description: '内置示例规范包：演示如何用事实字段、章节规则、文件角色、提示词角色和导出门禁共同约束一篇可交付攻略文档。',
  factFields: [
    { id: 'guide-goal', name: '攻略目标', type: 'text', required: true, sourceRoleIds: ['delta-fact-files', 'delta-case-reference-files'], extractionHint: '抽取本文解决的问题、适用对象和最终交付目标。', validationHint: '正文导语必须能回答“给谁看、解决什么问题”。' },
    { id: 'operator-name', name: '干员名称', type: 'list', required: true, sourceRoleIds: ['delta-fact-files'], extractionHint: '抽取露娜、红狼、牧羊人、蜂医等干员名称。', validationHint: '至少覆盖内置事实文件中的四名热门干员。' },
    { id: 'operator-role', name: '定位', type: 'text', required: true, sourceRoleIds: ['delta-fact-files'], extractionHint: '抽取干员定位，例如侦察、突击、工程、支援。', validationHint: '定位必须和干员名称一一对应。' },
    { id: 'operator-value', name: '核心价值', type: 'text', required: true, sourceRoleIds: ['delta-fact-files', 'delta-doc-files'], extractionHint: '抽取每名干员在队伍中的核心价值和使用场景。' },
    { id: 'recommend-score', name: '推荐指数', type: 'table', required: true, sourceRoleIds: ['delta-table-files'], extractionHint: '从表格中抽取推荐指数、上手难度和推荐场景。', validationHint: '推荐指数应以表格形式呈现。' },
    { id: 'team-composition', name: '队伍搭配', type: 'table', required: true, sourceRoleIds: ['delta-fact-files', 'delta-doc-files'], extractionHint: '抽取新手稳健队、突破压制队、控图防守队等组合和使用要点。' },
    { id: 'map-drawing', name: '地图图纸', type: 'list', required: true, sourceRoleIds: ['delta-drawing-files'], extractionHint: '抽取官方地图工具来源、地图名称和地图图纸文件。', validationHint: '地图图纸必须来自知识库检索资源，不能硬插固定文件。' },
    { id: 'image-reference', name: '图片资源', type: 'list', required: false, sourceRoleIds: ['delta-image-files', 'delta-reference-image-files'], extractionHint: '抽取干员图片、参考图片和可用作配图的本地资源。' },
    { id: 'template-case', name: '模板案例参考', type: 'text', required: true, sourceRoleIds: ['delta-case-reference-files'], extractionHint: '抽取模板案例中的结构、来源清单和示例表达方式。' },
    { id: 'style-rule', name: '模板样式规则', type: 'text', required: true, sourceRoleIds: ['delta-style-reference-files'], extractionHint: '抽取标题层级、章节结构、表格、图片说明和导出排版规则。' },
    { id: 'export-gate', name: '导出门禁', type: 'list', required: true, sourceRoleIds: ['delta-export-gate-files'], extractionHint: '抽取阻断项、警告项和导出通过标准。' },
  ],
  chapterRules: [
    { id: 'overview', title: '第一章 攻略目标和适用人群', required: true, order: 0, minWords: 120, requiredFactIds: ['guide-goal', 'template-case'], requiredFileRoleIds: ['delta-case-reference-files'], requiredPromptRoleIds: ['delta-template-style-prompt'], generationHint: '必须让用户看出这是一个可学习、可复制的内置模板案例。' },
    { id: 'operators', title: '第二章 热门干员定位速览', required: true, order: 1, minWords: 180, requiredFactIds: ['operator-name', 'operator-role', 'operator-value'], requiredFileRoleIds: ['delta-fact-files'], generationHint: '使用表格或分组清单展示干员、定位、核心价值和适合场景。' },
    { id: 'team', title: '第三章 队伍搭配和实战打法', required: true, order: 2, minWords: 160, requiredFactIds: ['team-composition'], requiredFileRoleIds: ['delta-doc-files', 'delta-fact-files'], generationHint: '把侦察、突击、工程、支援和队伍组合对应起来。' },
    { id: 'tables', title: '第四章 数据表和推荐优先级', required: true, order: 3, minWords: 120, requiredFactIds: ['recommend-score'], requiredFileRoleIds: ['delta-table-files'], generationHint: '必须把 CSV/XLS/XLSX 的字段转成可读表格，并解释字段含义。' },
    { id: 'maps', title: '第五章 官方地图图纸和路线理解', required: true, order: 4, minWords: 160, requiredFactIds: ['map-drawing'], requiredFileRoleIds: ['delta-drawing-files'], requiredPromptRoleIds: ['delta-resource-evidence-prompt'], generationHint: '必须说明官方地图工具来源，并解释地图图纸与路线、点位或撤离/交战路径的关系。' },
    { id: 'style', title: '第六章 模板样式和导出检查', required: true, order: 5, minWords: 140, requiredFactIds: ['style-rule', 'export-gate'], requiredFileRoleIds: ['delta-style-reference-files', 'delta-export-gate-files'], requiredPromptRoleIds: ['delta-export-gate-prompt'], generationHint: '说明本模板如何通过规范包、文件角色、提示词角色和导出门禁形成可复用案例。' },
  ],
  gateRules: [
    { id: 'gate-guide-goal', name: '必须说明攻略目标和适用对象', type: 'required_fact', level: 'warning', target: '攻略目标' },
    { id: 'gate-operator-fact', name: '必须抽取干员名称', type: 'required_fact', level: 'warning', target: '干员名称' },
    { id: 'gate-team', name: '必须包含队伍搭配依据', type: 'required_fact', level: 'warning', target: '队伍搭配' },
    { id: 'gate-table', name: '必须包含推荐表格', type: 'table_required', level: 'warning' },
    { id: 'gate-map-drawing', name: '必须引用官方地图图纸文件角色', type: 'required_file_role', level: 'error', target: 'delta-drawing-files' },
    { id: 'gate-case-reference', name: '必须绑定模板案例参考角色', type: 'required_file_role', level: 'warning', target: 'delta-case-reference-files' },
    { id: 'gate-style-prompt', name: '必须绑定模板样式提示词角色', type: 'required_prompt_role', level: 'warning', target: 'delta-template-style-prompt' },
    { id: 'gate-export-prompt', name: '必须绑定导出门禁提示词角色', type: 'required_prompt_role', level: 'warning', target: 'delta-export-gate-prompt' },
    { id: 'gate-no-missing', name: '不能出现缺失资料占位语', type: 'forbidden_text', level: 'error', value: '资料未提供' },
    { id: 'gate-no-remote-image-url', name: '正文不能包含远程临时图片生成 URL', type: 'forbidden_text', level: 'error', value: 'text_to_image' },
  ],
  wordTemplatePath: '',
  builtIn: true,
};

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
      type: ['text', 'number', 'date', 'table', 'list'].includes(item.type) ? item.type : 'text',
      required: Boolean(item.required),
      sourceRoleIds: Array.isArray(item.sourceRoleIds) ? item.sourceRoleIds.filter(Boolean) : [],
      extractionHint: item.extractionHint || '',
      validationHint: item.validationHint || '',
    })) : [],
    chapterRules: Array.isArray(spec.chapterRules) ? spec.chapterRules.filter(item => item.title).map((item, index) => ({
      id: safeId(item.id),
      title: item.title,
      required: Boolean(item.required),
      order: Number.isFinite(item.order) ? item.order : index,
      minWords: Number.isFinite(item.minWords) ? item.minWords : 0,
      requiredFactIds: Array.isArray(item.requiredFactIds) ? item.requiredFactIds.filter(Boolean) : [],
      requiredFileRoleIds: Array.isArray(item.requiredFileRoleIds) ? item.requiredFileRoleIds.filter(Boolean) : [],
      requiredPromptRoleIds: Array.isArray(item.requiredPromptRoleIds) ? item.requiredPromptRoleIds.filter(Boolean) : [],
      generationHint: item.generationHint || '',
    })) : [],
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
  const specMap = new Map([sanitizeSpec(DEMO_SPEC), ...customSpecs].map(spec => [spec.id, spec]));
  return [...specMap.values()];
}

export function getDocumentSpec(id?: string) {
  if (!id) return undefined;
  if (id === DEMO_SPEC.id) return sanitizeSpec(DEMO_SPEC);
  return readSpecs().find(spec => spec.id === id);
}

export function saveDocumentSpec(spec: DocumentSpecPackage) {
  const sanitized = sanitizeSpec(spec);
  if (sanitized.id === DEMO_SPEC.id) throw new Error('Built-in demo spec cannot be overwritten');
  const specs = readSpecs().filter(item => item.id !== sanitized.id);
  specs.push(sanitized);
  writeSpecs(specs);
  return sanitized;
}

export function deleteDocumentSpec(id: string) {
  if (id === DEMO_SPEC.id) throw new Error('Built-in demo spec cannot be deleted');
  writeSpecs(readSpecs().filter(item => item.id !== id));
}
