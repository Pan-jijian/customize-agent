import type { QualityRepairType, RoleExecutionNode } from '../types';

/** 角色输出类型推断规则，按顺序匹配。 */
export const ROLE_OUTPUT_TYPE_RULES: Array<{ outputType: RoleExecutionNode['outputType']; pattern: RegExp }> = [
  { outputType: 'template_requirements', pattern: /模板|范本|章节|目录|输出要求|编制要求|template|requirement/u },
  { outputType: 'bill_facts', pattern: /表格|列表|明细|数量|数据|table|sheet|quantity|data/u },
  { outputType: 'drawing_facts', pattern: /设计|方案|说明|图像|地图|drawing|image|map|design/u },
  { outputType: 'technical_facts', pattern: /规范|标准|规则|参数|技术|spec|standard|technical|rule/u },
  { outputType: 'reference_facts', pattern: /任务|范围|事实|fact|scope|reference/u },
];

/** 文件角色和提示词角色匹配加分规则。 */
export const PROMPT_EXECUTION_SCORE_RULES: Array<{ points: number; filePattern?: RegExp; promptPattern: RegExp }> = [
  { points: 5, promptPattern: /fact|抽取|读取|提取|理解|reference/u },
  { points: 1, promptPattern: /chapter_generation|章节生成|正文生成/u },
  { points: 6, filePattern: /requirement|rule|template|需求|规则|模板|范本/u, promptPattern: /requirement|rule|template|需求|规则|模板|范本|章节|目录|输出要求|编制要求/u },
  { points: 6, filePattern: /table|sheet|quantity|data|表格|列表|明细|数量|数据/u, promptPattern: /table|sheet|quantity|data|表格|列表|明细|数量|数据|字段/u },
  { points: 6, filePattern: /drawing|image|map|design|设计|方案|说明|图像|地图/u, promptPattern: /drawing|image|map|design|设计|方案|说明|文本|标注/u },
  { points: 6, filePattern: /material|equipment|brand|resource|材料|设备|品牌|资源/u, promptPattern: /material|equipment|brand|resource|材料|设备|品牌|资源|推荐/u },
  { points: 6, filePattern: /schedule|quality|safety|progress|周期|质量|安全|进度/u, promptPattern: /schedule|quality|safety|progress|周期|质量|安全|进度/u },
  { points: 6, filePattern: /risk|constraint|重点|难点|约束|风险/u, promptPattern: /risk|constraint|重点|难点|约束|风险/u },
];

/** 章节生成后必须阻断通过的问题。 */
export const BLOCKING_CHAPTER_ISSUE_RE = /正文缺少章节标题|空小节|小节只有标题|只有标题或表格无正文|后台流程话术|重复 token|退化输出/u;

/** 可通过局部 LLM 修复的质量问题。 */
export const REPAIRABLE_QUALITY_ISSUE_RE = /阻断|错误|正文缺少章节标题|空小节|小节只有标题|只有标题或表格无正文|小节生成未达标|生成未完成|生成后事实反查失败|不得出现|禁止词|禁用主体|正式表格不足|缺少必要的正式表格|事实一致性|跨章一致性|其他项目|项目编号|项目名称|后台流程|提示词|结构化精确参数使用不足|正文未体现结构化数据资料|正文未体现设计\/方案\/说明类资料|图片|重复 token|退化输出/u;

/** 修复问题分类规则，按顺序匹配。 */
export const QUALITY_REPAIR_TYPE_RULES: Array<{ type: QualityRepairType; pattern: RegExp }> = [
  { type: 'missing_structure', pattern: /二级小节少于|三级小节|目录|章节|结构/u },
  { type: 'loop_closure', pattern: /闭环|责任|检查|验收|整改|风险|安全|质量|进度/u },
  { type: 'fact_conflict', pattern: /事实一致性|其他项目|项目编号|项目名称|冲突|污染|requiredFacts/u },
  { type: 'terminology', pattern: /术语|名称不一致|前后不一致/u },
  { type: 'table_numeric', pattern: /表格|量化|数值|单位|参数|结构化|数据/u },
  { type: 'placeholder', pattern: /占位|空泛|后台流程|提示词|泄露|图片/u },
];

/** 不同质量修复类别对应的提示词策略。 */
export const QUALITY_REPAIR_INSTRUCTIONS: Record<QualityRepairType, string> = {
  missing_structure: '修复重点：补齐缺失小节、修正标题层级和目录相关结构；只在相关位置追加必要正文，不重排一级章节。',
  loop_closure: '修复重点：补齐与问题相关的责任、措施、检查、验收、整改或记录说明；不得编造具体数据。',
  fact_conflict: '修复重点：删除或改正与证据冲突的名称、编号、范围、参数；不确定内容改为基于材料的表述，不得新增无来源事实。',
  terminology: '修复重点：统一同一对象的术语、简称和称谓，保持前后一致，不改变事实含义。',
  table_numeric: '修复重点：补足表格前后说明、单位、参数来源和量化表达；材料不足时不得编造精确数值。',
  placeholder: '修复重点：移除占位话术、后台流程话术、提示词痕迹和不允许的图片语法，替换为正文表述。',
  generic: '修复重点：仅针对列出问题做最小必要修改，避免全文重写。',
};
