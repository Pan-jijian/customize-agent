import type { DocumentTemplate } from '../document-workflow/types';

export type FactCategory = 'identity' | 'scope' | 'schedule' | 'quality' | 'safety' | 'resource' | 'technical' | 'commercial' | 'compliance' | 'diagnostic' | 'other';
export type FactCardinality = 'single' | 'multiple' | 'range';
export type FactDerivationPolicy = 'source_only' | 'plan_inferable' | 'forbidden';
export type FactUsagePolicy = 'must_use' | 'use_if_relevant' | 'do_not_use' | 'diagnostic_only';
export type FactConflictPolicy = 'strict' | 'same_source_preferred' | 'allow_multiple' | 'ignore';

export interface FactFieldProfile {
  id: string;
  name: string;
  aliases: string[];
  category: FactCategory;
  cardinality: FactCardinality;
  derivationPolicy: FactDerivationPolicy;
  usagePolicy: FactUsagePolicy;
  confidencePolicy: {
    minForGeneration: number;
    minForValidation: number;
    allowPathOnly: boolean;
  };
  conflictPolicy: FactConflictPolicy;
}

export interface DocumentDomainProfile {
  id: string;
  name: string;
  factFields: FactFieldProfile[];
  forbiddenValuePatterns: RegExp[];
  diagnosticValuePatterns: RegExp[];
  lowConfidenceValuePatterns: RegExp[];
}

const DEFAULT_FACT_FIELDS: FactFieldProfile[] = [
  {
    id: 'document_identity',
    name: '对象名称',
    aliases: ['项目名称', '工程名称', '文档名称', '任务名称', '招标项目名称', '建设项目名称'],
    category: 'identity',
    cardinality: 'single',
    derivationPolicy: 'source_only',
    usagePolicy: 'must_use',
    confidencePolicy: { minForGeneration: 0.75, minForValidation: 0.85, allowPathOnly: false },
    conflictPolicy: 'strict',
  },
  {
    id: 'schedule_requirement',
    name: '周期要求',
    aliases: ['计划工期', '工期', '周期要求', '进度节点要求', '开工日期', '竣工日期'],
    category: 'schedule',
    cardinality: 'single',
    derivationPolicy: 'source_only',
    usagePolicy: 'must_use',
    confidencePolicy: { minForGeneration: 0.7, minForValidation: 0.8, allowPathOnly: false },
    conflictPolicy: 'strict',
  },
  {
    id: 'quality_requirement',
    name: '质量要求',
    aliases: ['质量要求', '质量标准', '验收要求', '评价标准'],
    category: 'quality',
    cardinality: 'multiple',
    derivationPolicy: 'source_only',
    usagePolicy: 'use_if_relevant',
    confidencePolicy: { minForGeneration: 0.65, minForValidation: 0.75, allowPathOnly: false },
    conflictPolicy: 'allow_multiple',
  },
  {
    id: 'safety_requirement',
    name: '安全合规要求',
    aliases: ['安全要求', '安全合规要求', '风险控制要求', '合规要求'],
    category: 'safety',
    cardinality: 'multiple',
    derivationPolicy: 'source_only',
    usagePolicy: 'use_if_relevant',
    confidencePolicy: { minForGeneration: 0.65, minForValidation: 0.75, allowPathOnly: false },
    conflictPolicy: 'allow_multiple',
  },
  {
    id: 'technical_parameter',
    name: '技术参数',
    aliases: ['技术参数', '参数规格范围', '规格', '型号', '尺寸', '标准编号', '材料设备'],
    category: 'technical',
    cardinality: 'multiple',
    derivationPolicy: 'source_only',
    usagePolicy: 'must_use',
    confidencePolicy: { minForGeneration: 0.7, minForValidation: 0.8, allowPathOnly: false },
    conflictPolicy: 'allow_multiple',
  },
  {
    id: 'resource_plan',
    name: '资源配置',
    aliases: ['劳动力', '机械', '检测设备', '应急物资', '资源配置', '人员配置'],
    category: 'resource',
    cardinality: 'multiple',
    derivationPolicy: 'plan_inferable',
    usagePolicy: 'use_if_relevant',
    confidencePolicy: { minForGeneration: 0.45, minForValidation: 0.55, allowPathOnly: false },
    conflictPolicy: 'allow_multiple',
  },
  {
    id: 'commercial_data',
    name: '商务数据',
    aliases: ['报价', '单价', '合价', '综合单价', '预留金', '税率', '金额', '利润'],
    category: 'commercial',
    cardinality: 'multiple',
    derivationPolicy: 'forbidden',
    usagePolicy: 'do_not_use',
    confidencePolicy: { minForGeneration: 1, minForValidation: 1, allowPathOnly: false },
    conflictPolicy: 'ignore',
  },
  {
    id: 'rule_requirement',
    name: '规则要求',
    aliases: ['规则要求', '变更说明', '实施范围', '对象范围', '结构化数据范围'],
    category: 'compliance',
    cardinality: 'multiple',
    derivationPolicy: 'source_only',
    usagePolicy: 'use_if_relevant',
    confidencePolicy: { minForGeneration: 0.6, minForValidation: 0.7, allowPathOnly: false },
    conflictPolicy: 'allow_multiple',
  },
];

const COMMON_FORBIDDEN_PATTERNS = [/投标报价|报价明细|单价|合价|综合单价|预留金|暂列金额|税率|增值税|利润|结算/u];
const COMMON_DIAGNOSTIC_PATTERNS = [/OCR|识别错误|乱码|无法确认|疑似|不确定|绑定片段|兜底|知识库|提示词|后台|文件路径|PDF|DWG|Excel/u, /^#+\s*/u, /^见(?:招标|投标人|前附|补疑|图纸|清单|文件|资料|公告|须知)/u];
const COMMON_LOW_CONFIDENCE_PATTERNS = [/无法确认|疑似|不确定|需复核|文字模糊|语义断裂|识别错误|乱码/u];

export const DEFAULT_DOCUMENT_DOMAIN_PROFILE: DocumentDomainProfile = {
  id: 'default_general_document',
  name: '通用文档',
  factFields: DEFAULT_FACT_FIELDS,
  forbiddenValuePatterns: COMMON_FORBIDDEN_PATTERNS,
  diagnosticValuePatterns: COMMON_DIAGNOSTIC_PATTERNS,
  lowConfidenceValuePatterns: COMMON_LOW_CONFIDENCE_PATTERNS,
};

export const CONSTRUCTION_ORGANIZATION_PROFILE: DocumentDomainProfile = {
  ...DEFAULT_DOCUMENT_DOMAIN_PROFILE,
  id: 'construction_organization_design',
  name: '施工组织设计',
};

export function resolveDocumentDomainProfile(template?: Pick<DocumentTemplate, 'id' | 'name' | 'category' | 'description' | 'outputTitle'>, requirement = ''): DocumentDomainProfile {
  const text = `${template?.id || ''} ${template?.name || ''} ${template?.category || ''} ${template?.description || ''} ${template?.outputTitle || ''} ${requirement}`;
  if (/施工组织设计|施工方案|危大工程|人、材、机|安全文明施工/u.test(text)) return CONSTRUCTION_ORGANIZATION_PROFILE;
  return DEFAULT_DOCUMENT_DOMAIN_PROFILE;
}

export function factFieldForLabel(profile: DocumentDomainProfile, label: string): FactFieldProfile | undefined {
  return profile.factFields.find(field => field.name === label || field.aliases.some(alias => label.includes(alias) || alias.includes(label)));
}

export function fieldMatchesCategory(profile: DocumentDomainProfile, label: string, category: FactCategory) {
  const field = factFieldForLabel(profile, label);
  return field?.category === category;
}

export function isForbiddenFactValue(profile: DocumentDomainProfile, value: string) {
  return profile.forbiddenValuePatterns.some(pattern => pattern.test(value));
}

export function isDiagnosticFactValue(profile: DocumentDomainProfile, value: string) {
  return profile.diagnosticValuePatterns.some(pattern => pattern.test(value));
}

export function isLowConfidenceFactValue(profile: DocumentDomainProfile, value: string) {
  return profile.lowConfidenceValuePatterns.some(pattern => pattern.test(value));
}
