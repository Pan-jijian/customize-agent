import type { MaterialRole } from './projectMaterialService';

export interface KeywordRule<T extends string = string> {
  id: string;
  label: string;
  patterns: RegExp[];
  output: T[];
}

export const DOCUMENT_TYPE_RULES: KeywordRule[] = [
  { id: 'bid', label: '投标文件', patterns: [/投标|标书|技术标|商务标/iu], output: ['投标文件'] },
  { id: 'construction', label: '施工组织设计', patterns: [/施工组织|施工方案|施工部署|施工方法/iu], output: ['施工组织设计'] },
  { id: 'report', label: '报告', patterns: [/报告|调研|分析|评估|研究/iu], output: ['报告'] },
  { id: 'plan', label: '实施方案', patterns: [/方案|规划|计划|预案/iu], output: ['实施方案'] },
];

export const FACT_RULES: KeywordRule[] = [
  { id: 'tender', label: '招投标资料', patterns: [/招标|投标|标书|补遗|补疑|答疑|澄清/iu], output: ['招标编号', '招标文件要求', '补遗答疑要求'] },
  { id: 'scope', label: '工程范围', patterns: [/施工|工程|改造|建设|装修|安装|专业|范围|工作内容/iu], output: ['施工范围', '专业工程范围'] },
  { id: 'quantity', label: '清单图纸', patterns: [/清单|工程量|图纸|图号|平面|系统图|设计说明/iu], output: ['工程量清单范围', '图纸范围'] },
  { id: 'quality', label: '质量验收', patterns: [/质量|验收|合格|标准|规范/iu], output: ['质量要求'] },
  { id: 'schedule', label: '工期进度', patterns: [/工期|进度|计划|节点|里程碑/iu], output: ['工期要求', '进度节点要求'] },
  { id: 'safety', label: '安全环保', patterns: [/安全|文明|环保|绿色|扬尘|消防|应急/iu], output: ['安全要求', '安全文明要求', '环保绿色施工要求'] },
  { id: 'materials', label: '材料设备', patterns: [/材料|设备|品牌|采购|供应|厂家/iu], output: ['材料设备要求', '推荐品牌要求'] },
  { id: 'risk', label: '风险约束', patterns: [/风险|重点|难点|约束|限制|现场|交通|场地/iu], output: ['重点难点约束'] },
  { id: 'analysis', label: '分析结论', patterns: [/报告|调研|分析|评估|研究|建议/iu], output: ['背景依据', '分析结论', '风险建议'] },
];

export const CHAPTER_FACT_RULES: KeywordRule[] = [
  { id: 'overview', label: '概况章节', patterns: [/概况|背景|理解|说明|总则/iu], output: ['项目名称', '项目资料范围', '施工范围'] },
  { id: 'implementation', label: '实施章节', patterns: [/施工|方法|部署|实施|范围|组织/iu], output: ['施工范围', '专业工程范围', '工程量清单范围', '图纸范围'] },
  { id: 'controls', label: '控制章节', patterns: [/质量|工期|进度|安全|文明|环保|验收/iu], output: ['质量要求', '工期要求', '安全要求', '安全文明要求'] },
  { id: 'materials', label: '材料章节', patterns: [/材料|设备|品牌|采购|供应/iu], output: ['材料设备要求', '推荐品牌要求'] },
  { id: 'risk', label: '风险章节', patterns: [/风险|重点|难点|约束|应急/iu], output: ['重点难点约束', '风险建议'] },
];

export const MATERIAL_ROLE_RULES: KeywordRule<MaterialRole>[] = [
  { id: 'tender', label: '招标文件', patterns: [/招标|招标文件|示范文本|tender/iu], output: ['tender_document'] },
  { id: 'addendum', label: '补遗答疑', patterns: [/补遗|补疑|答疑|澄清|变更|addendum/iu], output: ['addendum'] },
  { id: 'boq', label: '工程量清单', patterns: [/工程量清单|清单|分部分项|boq/iu], output: ['bill_of_quantities'] },
  { id: 'control-price', label: '最高限价', patterns: [/最高投标限价|控制价|限价|control\s*price/iu], output: ['control_price'] },
  { id: 'drawing', label: '图纸', patterns: [/图纸|图号|平面图|系统图|设计说明|\.dwg$|drawing/iu], output: ['drawings'] },
  { id: 'brand', label: '品牌材料', patterns: [/推荐品牌|品牌|材料设备|设备|采购/iu], output: ['brand_recommendation'] },
  { id: 'schedule-quality-safety', label: '工期质量安全', patterns: [/质量|工期|安全|文明|验收|环保|应急/iu], output: ['schedule_quality_safety'] },
  { id: 'scope', label: '范围专业', patterns: [/施工范围|改造|建设|安装|装饰|专业|工作内容/iu], output: ['construction_scope'] },
  { id: 'technical', label: '技术规范', patterns: [/技术规范|技术要求|规范|标准|规程/iu], output: ['technical_specification'] },
  { id: 'risk', label: '风险约束', patterns: [/风险|重点|难点|约束|限制|现场|交通|场地/iu], output: ['risk_constraints'] },
];

export function applyKeywordRules<T extends string>(text: string, rules: KeywordRule<T>[]) {
  const outputs = new Set<T>();
  for (const rule of rules) {
    if (rule.patterns.some(pattern => pattern.test(text))) {
      for (const output of rule.output) outputs.add(output);
    }
  }
  return [...outputs];
}

export function firstKeywordRuleOutput(text: string, rules: KeywordRule[]) {
  for (const rule of rules) {
    if (rule.patterns.some(pattern => pattern.test(text))) return rule.output[0];
  }
  return undefined;
}
