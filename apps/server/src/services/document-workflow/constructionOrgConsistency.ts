import type { DocumentDraftChapter, DocumentFactsModel, ValidationIssue } from './types';

interface ConsistencyRule {
  label: string;
  factGroups: Array<keyof DocumentFactsModel>;
  patterns: RegExp[];
  locations: string;
}

const CONSISTENCY_RULES: ConsistencyRule[] = [
  { label: '工程名称', factGroups: ['project'], patterns: [/工程名称\s*[：:]\s*([^\n|]+)/u], locations: '封面、工程概况、页眉页脚、专项方案、表格标题' },
  { label: '建设地点', factGroups: ['project'], patterns: [/建设地点\s*[：:]\s*([^\n|]+)/u, /工程地点\s*[：:]\s*([^\n|]+)/u], locations: '工程概况、周边环境、扬尘噪声、交通导改、属地化措施' },
  { label: '总工期', factGroups: ['schedule'], patterns: [/总工期\s*[：:]\s*([^\n|]+)/u, /计划工期\s*[：:]\s*([^\n|]+)/u, /工期目标\s*[：:]\s*([^\n|]+)/u], locations: '工程概况、进度计划、横道图、资源计划、纠偏措施' },
  { label: '建设规模', factGroups: ['project', 'preciseFacts'], patterns: [/建设规模\s*[：:]\s*([^\n|]+)/u, /建筑面积\s*[：:]\s*([^\n|]+)/u, /道路长度\s*[：:]\s*([^\n|]+)/u, /管线长度\s*[：:]\s*([^\n|]+)/u], locations: '工程概况、工程量表、施工部署、资源配置' },
  { label: '机械数量型号', factGroups: ['resources'], patterns: [/([\p{Script=Han}A-Za-z0-9]+(?:机|吊|泵|车))\s*[^\n|]{0,12}(\d+)\s*(台|套|辆)/u], locations: '机械表、平面布置、进度保障、安全专项方案' },
  { label: '劳动力人数', factGroups: ['resources'], patterns: [/劳动力\s*[^\n|]{0,12}(\d+)\s*人/u, /班组\s*[^\n|]{0,12}(\d+)\s*人/u], locations: '劳动力计划、进度节点、抢工方案、工资保障台账' },
  { label: '危大工程清单', factGroups: ['safety', 'preciseFacts'], patterns: [/危大工程\s*[：:]\s*([^\n|]+)/u, /深基坑|高支模|起重吊装|脚手架/u], locations: '安全章节、专项方案、审批表、应急预案' },
  { label: '环保监测指标', factGroups: ['quality', 'safety', 'preciseFacts'], patterns: [/PM10|PM2\.5|TSP|噪声|扬尘在线监测/u], locations: '文明施工、扬尘噪声、智慧工地、应急联动' },
];

function normalizeValue(value: string) {
  return value.replace(/[\s，。；;：:|]/gu, '').trim();
}

/** 通用施工术语：施组常规做法中的设施/指标词，正文提及（无论带不带规格）不要求资料事实逐字支持，
 * 否则“不使用塔式起重机”“脚手架”“噪声、PM2.5”等合理表述会被误判为与项目图谱不一致 */
const GENERIC_TERMS_RE = /塔式起重机|履带吊|汽车吊|卷扬机|脚手架|扣件|钢管|模板|噪声|PM2\.5|PM10|TSP|扬尘在线监测|临电|消防|安全网|围挡|洗车台|沉淀池|雾炮/u;

/** 否定语境（“不使用塔式起重机”“无需大型吊装机械”）是合理技术决策，不是配置声明，不参与一致性核对 */
const NEGATION_CTX_RE = /不使用|不采用|不配置|无需|未采用|不得使用|禁止使用/u;

function factValues(factsModel: DocumentFactsModel, groups: Array<keyof DocumentFactsModel>) {
  const values: string[] = [];
  for (const group of groups) {
    const items = factsModel[group];
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      if (item && typeof item === 'object' && 'value' in item && typeof item.value === 'string') values.push(item.value);
    }
  }
  return values.map(normalizeValue).filter(Boolean);
}

function markdownValues(markdown: string, patterns: RegExp[]) {
  const values: string[] = [];
  for (const pattern of patterns) {
    const globalPattern = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
    for (const match of markdown.matchAll(globalPattern)) {
      const value = normalizeValue(match[1] || match[0] || '');
      if (NEGATION_CTX_RE.test(value)) continue;
      if (value.length >= 2 && value.length <= 80) values.push(value);
    }
  }
  return [...new Set(values)];
}

function hasCompatibleFact(value: string, facts: string[]) {
  if (facts.length === 0) return true;
  return facts.some(fact => fact.includes(value) || value.includes(fact) || (value.length >= 4 && fact.includes(value.slice(0, 4))));
}

export function constructionOrgConsistencyIssues(markdown: string, factsModel: DocumentFactsModel): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!/施工组织设计|施工组织|施组|质量|安全|文明施工/u.test(markdown)) return issues;
  for (const rule of CONSISTENCY_RULES) {
    const facts = factValues(factsModel, rule.factGroups);
    const generated = markdownValues(markdown, rule.patterns);
    const conflicting = generated.filter(value => !GENERIC_TERMS_RE.test(value) && !hasCompatibleFact(value, facts)).slice(0, 5);
    if (conflicting.length > 0) {
      issues.push({
        level: 'warning',
        message: `施组数据一致性风险：${rule.label} 可能与项目图谱/事实不一致（${conflicting.join('、')}）`,
        suggestion: `请核对${rule.label}在${rule.locations}中的表述，统一以招标文件、项目图谱和可信事实为准。`,
      });
    }
  }
  return issues;
}

export function constructionOrgChapterDataCoverageIssues(chapters: DocumentDraftChapter[], factsModel: DocumentFactsModel): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const projectFacts = factValues(factsModel, ['project', 'schedule', 'resources', 'quality', 'safety', 'preciseFacts']);
  if (projectFacts.length === 0) return issues;
  for (const chapter of chapters) {
    if (!/概况|进度|资源|质量|安全|文明|工资|应急/u.test(`${chapter.title} ${(chapter.sections || []).join(' ')}`)) continue;
    const hasProjectFact = projectFacts.some(fact => fact.length >= 3 && chapter.content.includes(fact.slice(0, Math.min(10, fact.length))));
    if (!hasProjectFact) issues.push({ level: 'warning', message: `${chapter.title} 缺少可识别的项目图谱事实支撑`, suggestion: '请至少引用工程名称、工期、工程量、资源、风险、质量安全目标等项目专属事实之一，避免纯模板化。' });
  }
  return issues;
}
