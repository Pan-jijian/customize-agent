import type { QualityRepairType, RoleExecutionNode } from '../types';

/** 文档草稿与角色产物缓存 TTL。 */
export const DOCUMENT_CACHE_TTL_MS = Math.max(1, Number(process.env.DOCUMENT_CACHE_TTL_DAYS ?? 14)) * 24 * 60 * 60 * 1000;

/** 角色输出类型推断规则，按顺序匹配。 */
export const ROLE_OUTPUT_TYPE_RULES: Array<{ outputType: RoleExecutionNode['outputType']; pattern: RegExp }> = [
  { outputType: 'template_requirements', pattern: /模板|范本|章节|目录|输出要求|编制要求|template|requirement/u },
  { outputType: 'bill_facts', pattern: /表格|列表|明细|数量|数据|table|sheet|quantity|data/u },
  { outputType: 'drawing_facts', pattern: /设计|方案|说明|图像|地图|drawing|image|map|design/u },
  { outputType: 'technical_facts', pattern: /规范|标准|规则|参数|技术|spec|standard|technical|rule/u },
  { outputType: 'project_facts', pattern: /项目|任务|范围|事实|fact|scope/u },
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

/** 章节缓存命中后仍需阻断复用的问题。 */
export const BLOCKING_CHAPTER_CACHE_ISSUE_RE = /正文缺少章节标题|缺少配置小节|正文篇幅明显低于目标|后台流程话术|重复 token|退化输出/u;

/** 可通过局部 LLM 修复的质量问题。 */
export const REPAIRABLE_QUALITY_ISSUE_RE = /阻断|错误|正文缺少|缺少配置小节|缺少必要的正式表格|事实一致性|其他项目|项目编号|项目名称|结构化精确参数使用不足|正文未体现结构化数据资料|正文未体现设计\/方案\/说明类资料|二级小节少于|三级小节|目录|量化|数值|单位|图片|重复 token|退化输出/u;

/** 修复问题分类规则，按顺序匹配。 */
export const QUALITY_REPAIR_TYPE_RULES: Array<{ type: QualityRepairType; pattern: RegExp }> = [
  { type: 'missing_structure', pattern: /缺少配置小节|二级小节少于|三级小节|目录|章节|结构/u },
  { type: 'loop_closure', pattern: /闭环|责任|检查|验收|整改|风险|安全|质量|进度/u },
  { type: 'fact_conflict', pattern: /事实一致性|其他项目|项目编号|项目名称|冲突|污染|requiredFacts/u },
  { type: 'terminology', pattern: /术语|名称不一致|前后不一致/u },
  { type: 'table_numeric', pattern: /表格|量化|数值|单位|参数|结构化|数据/u },
  { type: 'placeholder', pattern: /占位|空泛|后台流程|提示词|泄露|图片/u },
];

/** 不同质量修复类别对应的提示词策略。 */
export const QUALITY_REPAIR_INSTRUCTIONS: Record<QualityRepairType, string> = {
  missing_structure: '修复重点：补齐缺失小节、修正标题层级和目录相关结构；只在相关位置追加必要正文，不重排一级章节。',
  loop_closure: '修复重点：补齐对象、责任、措施、检查、验收、整改和记录闭环；不得编造具体数据。',
  fact_conflict: '修复重点：删除或改正与证据冲突的项目名称、编号、范围、参数；不确定内容改为基于资料的表述，不得新增无来源事实。',
  terminology: '修复重点：统一同一对象的术语、简称和称谓，保持前后一致，不改变事实含义。',
  table_numeric: '修复重点：补足表格前后说明、单位、参数来源和量化表达；资料不足时不得编造精确数值。',
  placeholder: '修复重点：移除占位话术、后台流程话术、提示词痕迹和不允许的图片语法，替换为正式业务表述。',
  generic: '修复重点：仅针对列出问题做最小必要修改，避免全文重写。',
};

/** 项目基础事实抽取字段规则。 */
export const PROJECT_BASIC_FACT_FIELDS: Array<{ key: string; patterns: RegExp[]; chapterHint: RegExp }> = [
  { key: '项目名称', patterns: [/(?:项目名称|任务名称|文档名称|项目简称|标的名称)\s*[:：]?\s*([^\n；;。]{3,100})/u], chapterHint: /项目|任务|名称|概况|总述|背景/u },
  { key: '项目编号', patterns: [/(?:项目编号|任务编号|文档编号|合同编号|订单编号|编号)\s*[:：]?\s*([^\n；;。]{3,80})/u], chapterHint: /编号|概况|总述|背景/u },
  { key: '责任主体', patterns: [/(?:责任主体|委托人|客户|甲方|乙方|需求方|服务方|执行方|负责人)\s*[:：]?\s*([^\n；;。]{2,100})/u], chapterHint: /主体|客户|负责人|概况|背景/u },
  { key: '实施地点', patterns: [/(?:项目地点|实施地点|服务地点|交付地点|项目地址|执行地点)\s*[:：]?\s*([^\n；;。]{2,120})/u], chapterHint: /地点|地址|现场|概况|部署/u },
  { key: '项目规模', patterns: [/(?:项目规模|服务规模|采购规模|业务规模|处理规模)\s*[:：]?\s*([^\n；;。]{2,180})/u], chapterHint: /规模|概况|范围|数量/u },
  { key: '实施范围', patterns: [/(?:服务范围|采购范围|实施范围|工作范围|业务范围|适用范围)\s*[:：]?\s*([^\n。]{5,300})/u], chapterHint: /范围|内容|任务|概况|部署/u },
  { key: '周期要求', patterns: [/(?:服务期限|交付周期|实施周期|完成期限|执行周期|时间要求)\s*[:：]?\s*([^\n；;。]{2,120})/u], chapterHint: /周期|进度|计划|时间|部署/u },
  { key: '质量标准', patterns: [/(?:质量标准|质量要求|验收标准|验收要求|交付标准|评价标准)\s*[:：]?\s*([^\n；;。]{2,140})/u], chapterHint: /质量|验收|标准|评价/u },
  { key: '资金预算', patterns: [/(?:资金来源|资金落实情况|预算金额|最高限价|合同金额|投资金额|费用预算)\s*[:：]?\s*([^\n；;。]{2,120})/u], chapterHint: /资金|预算|费用|投资|商务/u },
  { key: '分组批次', patterns: [/(?:分组划分|批次划分|包件划分|合同包|阶段划分)\s*[:：]?\s*([^\n；;。]{2,120})/u], chapterHint: /分组|批次|阶段|范围|概况/u },
  { key: '关键日期', patterns: [/(?:开始日期|完成日期|截止日期|交付日期|完成时间|关键日期)\s*[:：]?\s*([^\n；;。]{2,120})/u], chapterHint: /日期|时间|进度|计划/u },
];
