import type { ChapterFactMatcher, FactCategoryRule } from '../types/engineeringTechnicalFactTypes';

/** 默认不内置行业专业词库，避免通用文档生成被特定行业语料污染；行业词库应由外部配置或模板提供。 */
export const DISCIPLINE_PATTERNS: Array<[string, RegExp]> = [];

/** 通用结构化参数正则：只抽取数字、单位、型号、比例、时间、金额、标准号等跨行业事实。 */
export const PARAMETER_RE = /(?:[A-Z]{1,8}[\w.-]*\d[\w.-]*|\d+(?:\.\d+)?\s*(?:mm|cm|m|km|㎡|m²|m3|kg|g|t|L|ml|MPa|kPa|℃|%|小时|h|分钟|min|秒|s|天|日|周|月|年|台|套|个|项|批|人|次|页|份|万元|元)|\d+\s*[×xX]\s*\d+(?:\s*[×xX]\s*\d+)?|\d+\s*@\s*\d+)/giu;
export const QUANTITY_RE = /\d+(?:\.\d+)?\s*(?:个|项|批|次|人|台|套|件|份|页|条|类|组|小时|天|周|月|年|元|万元|%|㎡|m²|m3|kg|g|t|L|ml|m|km)/giu;
export const SCHEDULE_RE = /\d+(?:\.\d+)?\s*(?:小时内|小时|h|分钟|min|秒|s|日内|天内|天|周|个月|月|年)|(?:每日|每天|每周|每月|每季度|每年|定期|实时|按时|阶段性)/giu;
export const COST_RE = /\d+(?:\.\d+)?\s*(?:万元|元|%\/天|‰|%|费用|金额|预算|报价|合同价|单价|总价)/giu;
export const FREQUENCY_RE = /(?:每日|每天|每周|每月|每季度|每年|每次|不少于\d+次|\d+次|\d+%|100%|全数|全部|一次性|定期|实时)/giu;
export const RESOURCE_RE = /\d+(?:\.\d+)?\s*(?:人|名|台|套|辆|个|组|团队|角色|岗位)|(?:负责人|管理员|专员|工程师|经理|小组|团队)/giu;
export const STANDARD_RE = /\b(?:GB|GB\/T|ISO|IEC|IEEE|RFC|API|DB\d*|T\/[A-Z]+)\s*[\w.-]+\b/giu;

/** 通用过程动作词，默认保持为空；具体行业动词应通过配置或模板注入，避免跨类型文档污染。 */
export const PROCESS_WORDS: string[] = [];
export const INSPECTION_WORDS: string[] = [];
export const QUALITY_WORDS: string[] = [];
export const RISK_WORDS: string[] = [];
export const DANGEROUS_WORK_WORDS: string[] = [];
export const SUBDIVISION_WORDS: string[] = [];
export const DEFAULT_GENERIC_PHRASES: string[] = [];

/** 通用事实对象候选词，默认不内置具体业务分项。 */
export const WORK_ITEM_CANDIDATES: string[] = [];

/** 触发结构化事实保留的通用正则集合。 */
export const FACT_KEEP_PATTERNS = [PARAMETER_RE, QUANTITY_RE, SCHEDULE_RE, COST_RE, FREQUENCY_RE, RESOURCE_RE, STANDARD_RE] as const;

/** 触发结构化事实保留的词表集合；默认为空，由模板/配置扩展。 */
export const FACT_KEEP_WORD_GROUPS = [PROCESS_WORDS, INSPECTION_WORDS, QUALITY_WORDS, RISK_WORDS, DANGEROUS_WORK_WORDS, SUBDIVISION_WORDS] as const;

/** 结构化事实短句拆分规则。 */
export const FACT_SENTENCE_SPLIT_RE = /[。；;\n]/u;

/** 文本空白归一化规则。 */
export const FACT_WHITESPACE_RE = /\s+/gu;

/** 结构化事实去重时用于抹平数字的规则。 */
export const FACT_DEDUPE_NUMBER_RE = /\d+/gu;

/** Markdown 表格竖线转义规则。 */
export const MARKDOWN_TABLE_PIPE_RE = /\|/gu;


/** 覆盖校验对象标签最小长度。 */
export const COVERAGE_LABEL_MIN_LENGTH = 2;

/** 默认不启用任何行业模板匹配；是否启用由配置文件 technicalDetailGate.templateMatchers 决定。 */
export const DEFAULT_ENGINEERING_TEMPLATE_MATCHERS: string[] = [];

/** 通用方法/流程类章节标题识别规则。 */
export const METHOD_CHAPTER_TITLE_RE = /方法|流程|方案|步骤|实施|执行/u;

/** 结构化事实分类规则，按顺序命中，只依赖通用字段，不含行业硬编码。 */
export const FACT_CATEGORY_RULES: FactCategoryRule[] = [
  { category: 'cost_commitment', match: input => input.costValues.length > 0 },
  { category: 'risk_response', match: input => input.scheduleValues.length > 0 && input.riskControl.length > 0 },
  { category: 'schedule_milestone', match: input => input.scheduleValues.length > 0 },
  { category: 'inspection_ratio', match: input => input.frequencyValues.length > 0 && input.inspection.length > 0 },
  { category: 'management_frequency', match: input => input.frequencyValues.length > 0 },
  { category: 'resource_allocation', match: input => input.resourceValues.length > 0 },
  { category: 'engineering_quantity', match: input => input.quantities.length > 0 },
  { category: 'standard_requirement', match: input => input.standards.length > 0 },
];

/** 章节与结构化事实匹配策略，保持通用语义，不内置特定行业业务词。 */
export const CHAPTER_FACT_MATCHERS: ChapterFactMatcher[] = [
  { pattern: /质量|验收|检查|审核|评审|测试/u, match: fact => Boolean(fact.qualityControl?.length || fact.inspection?.length || fact.standard?.length || ['inspection_ratio', 'standard_requirement'].includes(fact.category)) },
  { pattern: /进度|计划|周期|时间|节点|里程碑/u, match: fact => ['schedule_milestone', 'management_frequency'].includes(fact.category) || Boolean(fact.scheduleValues?.length || fact.frequencyValues?.length) },
  { pattern: /资源|人员|设备|材料|配置|投入/u, match: fact => ['resource_allocation', 'engineering_quantity'].includes(fact.category) || Boolean(fact.resourceValues?.length || fact.quantities?.length) },
  { pattern: /费用|成本|预算|报价|金额/u, match: fact => fact.category === 'cost_commitment' || Boolean(fact.costValues?.length) },
  { pattern: /风险|安全|应急|合规|控制/u, match: fact => fact.category === 'risk_response' || Boolean(fact.riskControl?.length) },
  { pattern: /重点|难点|关键/u, match: fact => fact.confidence >= 0.65 },
];
