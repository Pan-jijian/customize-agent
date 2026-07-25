import type { MaterialRole } from './projectMaterialService';

export interface KeywordRule<T extends string = string> {
  id: string;
  label: string;
  patterns: RegExp[];
  output: T[];
}

export const DOCUMENT_TYPE_RULES: KeywordRule[] = [
  { id: 'report', label: '报告', patterns: [/报告|调研|分析|评估|研究|复盘|总结/iu], output: ['报告'] },
  { id: 'plan', label: '实施方案', patterns: [/方案|规划|计划|预案|路径|路线图/iu], output: ['实施方案'] },
  { id: 'standard', label: '规范说明', patterns: [/规范|标准|制度|规则|指南|手册/iu], output: ['规范说明'] },
  { id: 'proposal', label: '建议方案', patterns: [/建议|提案|需求|响应|说明书/iu], output: ['建议方案'] },
];

export const FACT_RULES: KeywordRule[] = [
  { id: 'requirement', label: '需求规则资料', patterns: [/需求|要求|规则|条款|约束|响应|澄清|变更/iu], output: ['需求约束', '规则要求', '变更说明'] },
  { id: 'scope', label: '范围资料', patterns: [/范围|内容|任务|目标|边界|对象|工作内容/iu], output: ['实施范围', '对象范围'] },
  { id: 'structured-data', label: '结构化数据资料', patterns: [/表格|列表|明细|数量|数据|字段|参数|规格|sheet|table|data/iu], output: ['结构化数据范围', '参数规格范围'] },
  { id: 'quality', label: '质量评价资料', patterns: [/质量|验收|审核|评审|评价|标准|规范|指标/iu], output: ['质量要求', '评价标准'] },
  { id: 'schedule', label: '时间进度资料', patterns: [/周期|期限|进度|计划|节点|里程碑|时间|日期/iu], output: ['周期要求', '进度节点要求'] },
  { id: 'safety', label: '安全合规资料', patterns: [/安全|合规|风险|应急|环保|隐私|审计|控制/iu], output: ['安全合规要求', '风险控制要求'] },
  { id: 'resource', label: '资源配置资料', patterns: [/资源|人员|设备|材料|品牌|采购|供应|配置/iu], output: ['资源配置要求'] },
  { id: 'analysis', label: '分析结论', patterns: [/报告|调研|分析|评估|研究|建议|结论/iu], output: ['背景依据', '分析结论', '风险建议'] },
];

export const CHAPTER_FACT_RULES: KeywordRule[] = [
  { id: 'overview', label: '概况章节', patterns: [/概况|背景|理解|说明|总则|摘要/iu], output: ['项目名称', '项目资料范围', '实施范围'] },
  { id: 'implementation', label: '实施章节', patterns: [/方法|部署|实施|范围|组织|流程|步骤/iu], output: ['实施范围', '对象范围', '结构化数据范围'] },
  { id: 'controls', label: '控制章节', patterns: [/质量|周期|进度|安全|合规|验收|审核|评价/iu], output: ['质量要求', '周期要求', '安全合规要求'] },
  { id: 'resources', label: '资源章节', patterns: [/资源|人员|设备|材料|品牌|采购|供应|配置/iu], output: ['资源配置要求'] },
  { id: 'risk', label: '风险章节', patterns: [/风险|重点|难点|约束|应急|合规/iu], output: ['风险控制要求', '风险建议'] },
];

export const MATERIAL_ROLE_RULES: KeywordRule<MaterialRole>[] = [
  { id: 'requirement', label: '需求规则资料', patterns: [/需求|要求|规则|条款|响应|requirement|rule/iu], output: ['requirement_document'] },
  { id: 'change', label: '变更澄清资料', patterns: [/补充|澄清|变更|修订|addendum|change/iu], output: ['addendum'] },
  { id: 'structured-data', label: '结构化数据资料', patterns: [/表格|列表|明细|数量|数据|字段|参数|规格|sheet|table|data/iu], output: ['structured_data'] },
  { id: 'budget', label: '预算费用资料', patterns: [/预算|费用|金额|报价|限价|成本|price|cost|budget/iu], output: ['budget_cost'] },
  { id: 'design', label: '设计方案资料', patterns: [/设计|方案|说明|图像|地图|附件|drawing|image|map|design/iu], output: ['design_specification'] },
  { id: 'resource', label: '资源配置资料', patterns: [/资源|人员|设备|材料|品牌|采购|供应|配置/iu], output: ['resource_recommendation'] },
  { id: 'schedule-quality-safety', label: '进度质量合规资料', patterns: [/质量|周期|进度|安全|合规|验收|审核|评价|环保|应急/iu], output: ['schedule_quality_safety'] },
  { id: 'scope', label: '范围任务资料', patterns: [/范围|内容|任务|目标|边界|对象|工作内容/iu], output: ['scope_description'] },
  { id: 'technical', label: '技术标准资料', patterns: [/技术|规范|标准|规程|指南|手册|参数|spec|standard/iu], output: ['technical_specification'] },
  { id: 'risk', label: '风险约束资料', patterns: [/风险|重点|难点|约束|限制|现场|条件|应急/iu], output: ['risk_constraints'] },
];

export function applyKeywordRules<T extends string>(text: string, rules: KeywordRule<T>[]) {
  const outputs = new Set<T>();
  for (const rule of rules) {
    for (const pattern of rule.patterns) {
      pattern.lastIndex = 0;
      if (!pattern.test(text)) continue;
      for (const output of rule.output) outputs.add(output);
      break;
    }
  }
  return [...outputs];
}

export function firstKeywordRuleOutput(text: string, rules: KeywordRule[]) {
  for (const rule of rules) {
    for (const pattern of rule.patterns) {
      pattern.lastIndex = 0;
      if (pattern.test(text)) return rule.output[0];
    }
  }
  return undefined;
}
