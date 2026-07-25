/** 结构化技术事实分类，用于生成、分配和质量门禁。 */
export type EngineeringFactCategory = 'technical_parameter' | 'engineering_quantity' | 'schedule_milestone' | 'cost_commitment' | 'resource_allocation' | 'inspection_ratio' | 'management_frequency' | 'risk_response' | 'standard_requirement' | 'subdivision_work' | 'dangerous_work';

/** 从证据中抽取的可核查结构化技术事实。 */
export interface EngineeringTechnicalFact {
  id: string;
  category: EngineeringFactCategory;
  discipline: string;
  workItem: string;
  location?: string;
  material?: string;
  equipment?: string;
  specification?: string;
  parameter?: string;
  quantities?: string[];
  scheduleValues?: string[];
  costValues?: string[];
  frequencyValues?: string[];
  resourceValues?: string[];
  commitmentValues?: string[];
  method?: string;
  process?: string[];
  qualityControl?: string[];
  inspection?: string[];
  standard?: string[];
  riskControl?: string[];
  sourceRole?: string;
  sourceFile?: string;
  text: string;
  confidence: number;
}

/** 章节维度的结构化技术事实分配结果。 */
export interface TechnicalFactAssignment {
  chapterId: string;
  chapterTitle: string;
  facts: EngineeringTechnicalFact[];
}

/** 结构化事实分类规则输入。 */
export interface FactCategoryInput {
  text: string;
  parameters: string[];
  quantities: string[];
  scheduleValues: string[];
  costValues: string[];
  frequencyValues: string[];
  resourceValues: string[];
  standards: string[];
  inspection: string[];
  riskControl: string[];
}

/** 结构化事实分类规则。 */
export interface FactCategoryRule {
  category: EngineeringFactCategory;
  match: (input: FactCategoryInput) => boolean;
}

/** 章节与结构化事实匹配规则。 */
export interface ChapterFactMatcher {
  pattern: RegExp;
  match: (fact: EngineeringTechnicalFact) => boolean;
}
