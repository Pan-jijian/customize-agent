import type { AutoDocumentSpecGateRule, GateRuleEvaluator } from '../document-core/autoDocumentSpecTypes';
import type { QualitySeverity, SpecGateRuleHandler } from '../types/qualityValidationTypes';

/** 导出阻断类校验问题匹配规则。 */
export const EXPORT_BLOCKING_ISSUE_RE = /用户要求不得|出现禁用文本|生成未完成|章节生成失败|大模型未能|重新生成|空小节|小节只有标题|只有标题或表格无正文|缺少必要表格|正文缺少章节标题|重复 token|退化输出|其他对象|其他文档|文档编号|明确事实污染|明确无来源编造|必需材料角色缺失|章节缺少证据|文档质量基准评分未达标/iu;

/** 导出门禁中用于判断结构化精确参数缺失的问题规则。 */
export const EXPORT_GATE_PRECISION_ISSUE_RE = /可靠精确参数使用不足/u;

/** 导出门禁中用于判断项目污染和事实冲突的问题规则。 */
export const EXPORT_GATE_PROJECT_CONTAMINATION_RE = /其他对象|其他文档|文档编号|对象名称|事实一致性冲突/iu;

/** 质量问题严重程度规则，按顺序命中。 */
export const QUALITY_SEVERITY_RULES: Array<{ severity: QualitySeverity; pattern: RegExp }> = [
  { severity: 'blocking', pattern: /阻断|空小节|小节只有标题|只有标题或表格无正文|缺少必要表格|正文缺少章节标题|章节生成失败|其他对象|其他文档|文档编号|后台流程|提示词|文档质量基准评分未达标/iu },
  { severity: 'important', pattern: /量化|数值|单位|事实|requiredFacts|闭环|安全|质量|工期|表格|三级小节|目录|术语|不一致/iu },
];

/** AutoSpec 旧规则类型到声明式 evaluator 的兼容映射。 */
export const FALLBACK_GATE_EVALUATORS: Record<string, (rule: AutoDocumentSpecGateRule) => GateRuleEvaluator> = {
  required_fact: rule => ({ subject: 'fact', operator: 'exists', target: rule.target }),
  required_chapter: rule => ({ subject: 'chapter', operator: 'exists', target: rule.target }),
  required_file_role: rule => ({ subject: 'file_role', operator: 'exists', target: rule.target }),
  required_prompt_role: rule => ({ subject: 'prompt_role', operator: 'exists', target: rule.target }),
  source_required: () => ({ subject: 'source', operator: 'all_have_source' }),
  forbidden_text: rule => ({ subject: 'document', operator: 'not_contains', value: rule.value }),
  min_chapter_length: rule => ({ subject: 'chapter', operator: 'min_length', target: rule.target, min: Number(rule.value) || undefined }),
  table_required: () => ({ subject: 'table', operator: 'min_count', min: 1 }),
};

/** AutoSpec 门禁规则处理器策略表，按顺序返回首个命中问题详情。 */
export const SPEC_GATE_RULE_HANDLERS: SpecGateRuleHandler[] = [
  ({ evaluator, target, factNames }) => evaluator.subject === 'fact' && evaluator.operator === 'exists' && target && !factNames.has(target) ? `缺少事实 ${target}` : undefined,
  ({ evaluator, target, chapterTitles }) => evaluator.subject === 'chapter' && evaluator.operator === 'exists' && target && !chapterTitles.has(target) ? `缺少章节 ${target}` : undefined,
  ({ evaluator, target, fileBindings }) => evaluator.subject === 'file_role' && evaluator.operator === 'exists' && target && !fileBindings.some(binding => binding.roleId === target) ? `缺少文件角色 ${target}` : undefined,
  ({ evaluator, target, promptBindings }) => evaluator.subject === 'prompt_role' && evaluator.operator === 'exists' && target && !promptBindings.some(binding => binding.roleId === target) ? `缺少提示词角色 ${target}` : undefined,
  ({ evaluator, value, markdown }) => evaluator.subject === 'document' && evaluator.operator === 'contains' && value && !markdown.includes(value) ? `全文必须包含 ${value}` : undefined,
  ({ evaluator, value, markdown }) => evaluator.subject === 'document' && evaluator.operator === 'not_contains' && value && markdown.includes(value) ? `出现禁用文本 ${value}` : undefined,
  ({ evaluator, value, regex, textScope }) => (evaluator.subject === 'document' || evaluator.subject === 'chapter') && evaluator.operator === 'regex_match' && value && (!regex || !regex.test(textScope)) ? `未匹配正则 ${value}` : undefined,
  ({ evaluator, value, regex, textScope }) => (evaluator.subject === 'document' || evaluator.subject === 'chapter') && evaluator.operator === 'regex_not_match' && regex?.test(textScope) ? `匹配到禁止正则 ${value}` : undefined,
  ({ evaluator, target, value, chapter }) => evaluator.subject === 'chapter' && evaluator.operator === 'contains' && target && value && (!chapter || !chapter.content.includes(value)) ? `章节 ${target} 必须包含 ${value}` : undefined,
  ({ evaluator, target, value, chapter }) => evaluator.subject === 'chapter' && evaluator.operator === 'not_contains' && chapter?.content.includes(value) ? `章节 ${target} 出现禁用文本 ${value}` : undefined,
  ({ evaluator, target, min, chapter }) => evaluator.subject === 'chapter' && evaluator.operator === 'min_length' && target && (!chapter || chapter.content.length < min) ? `章节 ${target} 低于 ${min} 字` : undefined,
  ({ evaluator, min, tableBlocks, factsModel }) => evaluator.subject === 'table' && evaluator.operator === 'min_count' && factsModel.tables.length + tableBlocks.length < min ? `表格数量少于 ${min}` : undefined,
  ({ evaluator, markdown, tableBlocks }) => evaluator.subject === 'table' && evaluator.operator === 'table_explanation_required' && hasMissingTableExplanation(markdown, tableBlocks) ? '存在缺少说明文字的表格' : undefined,
  ({ evaluator, min, imageRefs }) => evaluator.subject === 'image' && evaluator.operator === 'min_count' && imageRefs.length < min ? `图片数量少于 ${min}` : undefined,
  ({ evaluator, min, estimatedPages }) => evaluator.subject === 'page' && evaluator.operator === 'min_count' && estimatedPages < min ? `预计页数 ${estimatedPages} 少于 ${min}` : undefined,
  ({ evaluator, min, estimatedPages }) => evaluator.subject === 'page' && evaluator.operator === 'max_count' && estimatedPages > min ? `预计页数 ${estimatedPages} 超过 ${min}` : undefined,
  ({ evaluator, markdown, imageRefs }) => evaluator.subject === 'image' && evaluator.operator === 'image_caption_required' && hasMissingImageCaption(markdown, imageRefs) ? '存在缺少说明文字的图片' : undefined,
  ({ evaluator, allFacts }) => evaluator.subject === 'source' && evaluator.operator === 'all_have_source' && allFacts.some(fact => !fact.sourceFile) ? '存在无来源事实' : undefined,
  ({ evaluator, min, allFacts }) => evaluator.subject === 'source' && evaluator.operator === 'min_count' && sourceFileCount(allFacts) < min ? `来源数量少于 ${min}` : undefined,
];

/** Markdown 表格块分隔规则。 */
export const MARKDOWN_TABLE_BLOCK_SPLIT_RE = /\n{2,}/u;

/** Markdown 表格行识别规则。 */
export const MARKDOWN_TABLE_ROW_RE = /\|.+\|/u;

/** Markdown 表格分隔线识别规则。 */
export const MARKDOWN_TABLE_DIVIDER_RE = /\n\s*\|?\s*:?-{3,}:?/u;

/** Markdown 图片语法识别规则。 */
export const MARKDOWN_IMAGE_RE = /!\[([^\]]*)\]\(([^)]+)\)/gu;

/** Markdown 正文章节标题识别规则。 */
export const CHAPTER_HEADING_RE = /^##\s+第[一二三四五六七八九十百]+章\s+.+$/gmu;

/** 基础信息重复块识别规则。 */
export const DOCUMENT_BASIC_INFO_BLOCK_RE = /(?:文档|任务|对象)?基本信息表|资料(?:文档|任务|对象)?基本信息|^###\s*(?:文档|任务|对象)?基本信息\s*$/mu;

/** 基础信息表位置识别规则。 */
export const DOCUMENT_BASIC_INFO_TABLE_RE = /(?:文档|任务|对象)?基本信息表|资料(?:文档|任务|对象)?基本信息|\|\s*(?:字段|文档|任务|对象|内容)\s*\|/u;

/** Markdown 二级、三级标题清理规则。 */
export const MARKDOWN_SECTION_HEADING_RE = /^##\s+.+$|^###\s+.+$/gmu;

/** 基础信息表前不应重复逐项叙述的字段。 */
export const DOCUMENT_BASIC_INFO_FIELDS = ['对象名称', '对象编号', '文档名称', '文档编号', '任务名称', '任务编号', '地点', '责任主体', '范围', '周期要求', '计划周期', '质量标准'] as const;

/** 正文中应避免的模板化前缀和套话。 */
export const FORMAL_STYLE_FORBIDDEN_PHRASES = ['本节', '本章将', '以下从', '以下内容', '综上所述'] as const;

/** 目录块识别规则。 */
export const TOC_BLOCK_RE = /^##\s+目录\s*$([\s\S]*?)(?=\n<div class="page-break"><\/div>|\n##\s+)/mu;

/** 非空白字符识别规则。 */
export const NON_BLANK_RE = /\S/u;

/** 目录二级小节行识别规则。 */
export const TOC_SECTION_LINE_RE = /^\s*\d+\.\d+\s+\S/u;

/** 目录二级小节缩进行识别规则。 */
export const TOC_INDENTED_SECTION_LINE_RE = /^\s{2,}\d+\.\d+\s+\S/u;

/** 换行分隔规则。 */
export const LINE_SPLIT_RE = /\r?\n/u;

/** 空白归一化规则。 */
export const WHITESPACE_RE = /\s+/gu;

/** 结构化精确事实来源识别规则。 */
export const PRECISE_FACT_SOURCE_RE = /drawing|table|bill|boq|draw|data|sheet|spec|standard|record|report|表格|数据|规格|参数|标准|记录|报告/u;

/** 结构化资料中的精确参数 token 抽取规则。 */
export const PRECISE_FACT_TOKEN_RE = /(?:[A-Z]{1,8}[\w.-]*\d[\w.-]*|\d+(?:\.\d+)?\s*(?:mm|cm|m|km|㎡|m²|m3|kg|g|t|L|ml|MPa|kPa|℃|%|台|套|个|项|批|次|页|份|人|小时|分钟|天|周|月|年|万元|元)|\d+\s*[×xX]\s*\d+(?:\s*[×xX]\s*\d+)?|\b(?:GB|GB\/T|ISO|IEC|IEEE|RFC|API|DB\d*|T\/[A-Z]+)\s*[\w.-]+\b)/giu;

/** 触发精确参数覆盖率校验的最小 token 数。 */
export const PRECISE_FACT_MIN_TOKEN_COUNT = 20;

/** 结构化精确参数最低使用率。 */
export const PRECISE_FACT_MIN_USAGE_RATE = 0.28;

/** 正文必须体现结构化数据来源时使用的匹配规则。 */
export const STRUCTURED_DATA_CONTENT_RE = /表格|数据|列表|明细|参数|规格|数量|记录|报告|标准/u;

/** 正文必须体现设计/方案/说明类资料时使用的匹配规则。 */
export const SPECIFICATION_CONTENT_RE = /设计|方案|说明|节点|流程|步骤|尺寸|做法|配置|规则|标准/u;

/** 正文占位式表达检查规则。 */
export const FORMAL_PLACEHOLDER_PATTERNS = [
  /见(?:资料|文件|说明|方案|附件|相关文件)/u,
  /按(?:资料|文件|说明|方案|规范|标准|要求)/u,
  /满足(?:相关|有关)?要求/u,
  /\|\s*(?:[/—-]|无|暂无|待定|待补充|N\/?A)\s*\|/iu,
] as const;

/** AutoSpec 配置校验中不允许出现的 Markdown 一级标题。 */
export const MARKDOWN_TOP_HEADING_RE = /^#\s+/mu;

/** 提示词示例片段抽取规则，用于发现样例泄露。 */
export const PROMPT_EXAMPLE_BLOCK_RE = /(?:示例|样例|范例|例如|参考示例|示例数据|示例正文|示例目录|example|sample)\s*[:：]?\s*([\s\S]{20,800}?)(?=\n\s*\n|$)/giu;

function hasMissingTableExplanation(markdown: string, tableBlocks: string[]) {
  for (const block of tableBlocks) {
    const index = markdown.indexOf(block);
    if (index >= 0 && markdown.slice(index + block.length, index + block.length + 120).trim().length < 10) return true;
  }
  return false;
}

function hasMissingImageCaption(markdown: string, imageRefs: Array<{ alt: string; url: string; index: number }>) {
  for (const image of imageRefs) {
    if (!image.alt && markdown.slice(image.index + image.url.length, image.index + image.url.length + 120).trim().length < 10) return true;
  }
  return false;
}

function sourceFileCount(allFacts: Array<{ sourceFile?: string }>) {
  const sourceFiles = new Set<string>();
  for (const fact of allFacts) if (fact.sourceFile) sourceFiles.add(fact.sourceFile);
  return sourceFiles.size;
}
