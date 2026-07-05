import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export type FactFieldType = 'text' | 'number' | 'date' | 'table' | 'list';
export type GateRuleType = 'required_fact' | 'required_chapter' | 'required_file_role' | 'required_prompt_role' | 'source_required' | 'forbidden_text' | 'min_chapter_length' | 'table_required';
export type GateRuleLevel = 'error' | 'warning' | 'info';

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

const DEMO_SPEC: DocumentSpecPackage = {
  id: 'delta-force-demo-spec',
  name: '三角洲热门干员攻略规范包',
  description: '内置示例规范包：要求攻略必须包含干员名称、定位、推荐指数、热门干员章节和表格数据。',
  factFields: [
    { id: 'operator-name', name: '干员名称', type: 'list', required: true, sourceRoleIds: ['delta-fact-files'], extractionHint: '抽取露娜、红狼、牧羊人、蜂医等干员名称。' },
    { id: 'operator-role', name: '定位', type: 'text', required: true, sourceRoleIds: ['delta-fact-files'], extractionHint: '抽取干员定位，例如侦察、突击、工程、支援。' },
    { id: 'recommend-score', name: '推荐指数', type: 'table', required: true, sourceRoleIds: ['delta-table-files'], extractionHint: '从表格中抽取推荐指数和上手难度。' },
    { id: 'map-drawing', name: '地图图纸', type: 'list', required: true, sourceRoleIds: ['delta-drawing-files'], extractionHint: '抽取官方地图工具来源、地图名称和地图图纸瓦片文件。' },
  ],
  chapterRules: [
    { id: 'overview', title: '第一章 攻略目标和适用人群', required: true, order: 0, minWords: 80, requiredFactIds: ['operator-name'] },
    { id: 'operators', title: '第二章 热门干员定位速览', required: true, order: 1, minWords: 120, requiredFactIds: ['operator-name', 'operator-role'] },
    { id: 'tables', title: '第四章 数据表和推荐优先级', required: true, order: 3, minWords: 80, requiredFactIds: ['recommend-score'] },
    { id: 'maps', title: '第五章 官方地图图纸和路线理解', required: true, order: 4, minWords: 100, requiredFactIds: ['map-drawing'], requiredFileRoleIds: ['delta-drawing-files'], generationHint: '必须说明官方地图工具来源，并引用至少一个地图图纸瓦片文件名。' },
  ],
  gateRules: [
    { id: 'gate-operator-fact', name: '必须抽取干员名称', type: 'required_fact', level: 'warning', target: '干员名称' },
    { id: 'gate-table', name: '必须包含推荐表格', type: 'table_required', level: 'warning' },
    { id: 'gate-map-drawing', name: '必须引用官方地图图纸文件', type: 'required_file_role', level: 'error', target: 'delta-drawing-files' },
    { id: 'gate-no-missing', name: '不能出现缺失资料占位语', type: 'forbidden_text', level: 'error', value: '资料未提供' },
  ],
  wordTemplatePath: '',
  builtIn: true,
};

function storePath() {
  const dir = path.join(os.homedir(), '.customize-agent');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'document-specs.json');
}

function safeId(input?: string) {
  return (input || `spec-${Date.now()}`).replace(/[^a-zA-Z0-9_-]/gu, '-').slice(0, 80);
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
    gateRules: Array.isArray(spec.gateRules) ? spec.gateRules.filter(item => item.name).map(item => ({
      id: safeId(item.id),
      name: item.name,
      type: ['required_fact', 'required_chapter', 'required_file_role', 'required_prompt_role', 'source_required', 'forbidden_text', 'min_chapter_length', 'table_required'].includes(item.type) ? item.type : 'required_fact',
      level: item.level === 'warning' || item.level === 'info' ? item.level : 'error',
      target: item.target || '',
      value: item.value || '',
    })) : [],
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

export function listDocumentSpecs() {
  const customSpecs = readSpecs();
  const specMap = new Map([DEMO_SPEC, ...customSpecs].map(spec => [spec.id, spec]));
  return [...specMap.values()];
}

export function getDocumentSpec(id?: string) {
  if (!id) return undefined;
  if (id === DEMO_SPEC.id) return DEMO_SPEC;
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
  if (id === DEMO_SPEC.id) throw new Error('Built-in demo spec cannot be deleted');
  writeSpecs(readSpecs().filter(item => item.id !== id));
}
