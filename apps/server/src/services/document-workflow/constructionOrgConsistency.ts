import type { DocumentDraftChapter, DocumentFactsModel, ValidationIssue } from './types';
import { equipmentNameAtEndOf, scanEquipmentCountClaims } from './resourceBreakdownNumbers';

interface ConsistencyRule {
  label: string;
  factGroups: Array<keyof DocumentFactsModel>;
  patterns?: RegExp[];
  locations: string;
  /** C-T4 机械数量型号专用通道：通用抽取 + 资料事实域判定（见 equipmentCountConsistencyIssues） */
  kind?: 'equipment-counts';
}

const CONSISTENCY_RULES: ConsistencyRule[] = [
  { label: '工程名称', factGroups: ['project'], patterns: [/工程名称\s*[：:]\s*([^\n|]+)/u], locations: '封面、工程概况、页眉页脚、专项方案、表格标题' },
  { label: '建设地点', factGroups: ['project'], patterns: [/建设地点\s*[：:]\s*([^\n|]+)/u, /工程地点\s*[：:]\s*([^\n|]+)/u], locations: '工程概况、周边环境、扬尘噪声、交通导改、属地化措施' },
  { label: '总工期', factGroups: ['schedule'], patterns: [/总工期\s*[：:]\s*([^\n|]+)/u, /计划工期\s*[：:]\s*([^\n|]+)/u, /工期目标\s*[：:]\s*([^\n|]+)/u], locations: '工程概况、进度计划、横道图、资源计划、纠偏措施' },
  { label: '建设规模', factGroups: ['project', 'preciseFacts'], patterns: [/建设规模\s*[：:]\s*([^|\n]+)/u, /建筑面积\s*[：:]\s*([^|\n]+)/u, /道路长度\s*[：:]\s*([^|\n]+)/u, /管线长度\s*[：:]\s*([^|\n]+)/u], locations: '工程概况、工程量表、施工部署、资源配置' },
  // C-T4：旧实现三条缺陷（贪婪 12 字桥接捕获「洒水车为主力机」类垃圾名、捕获组仅名称数字不参与
  // 对账、资料事实无机械条目时把正文全部机械名死报——r28f 实测 resources 仅管理规则条目 →
  // 提升泵/自卸汽车/压路机/蛙式打夯机 全量误报）——改为通用抽取 + 资料事实域判定：
  // 名称归一（虚词截断）后逐项对账（名称命中 + 台数与事实一致），无对账依据时静默
  // （正文口径互斥由跨章机械矩阵 qualityValidation 承担）
  { label: '机械数量型号', factGroups: ['resources'], locations: '机械表、平面布置、进度保障、安全专项方案', kind: 'equipment-counts' },
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

/** 资料事实中的机械条目索引：短值即机械名的（「塔式起重机」）与含「名称+数字+台/套/辆」宣称的
 * 都可作对账依据；无任何机械条目时调用方跳过对账（消除「事实非机械域 → 正文机械名死报」） */
function equipmentFactIndex(factsModel: DocumentFactsModel, groups: Array<keyof DocumentFactsModel>) {
  const names: string[] = [];
  const counts = new Map<string, number>();
  const addName = (name: string) => {
    if (!names.includes(name)) names.push(name);
  };
  for (const group of groups) {
    const items = factsModel[group];
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      if (!item || typeof item !== 'object' || !('value' in item) || typeof item.value !== 'string') continue;
      for (const claim of scanEquipmentCountClaims(item.value)) {
        addName(claim.name);
        if (!counts.has(claim.name)) counts.set(claim.name, claim.count);
      }
      const normalized = normalizeValue(item.value);
      if (normalized.length > 12 || /\d/u.test(normalized)) continue;
      const nameOnly = equipmentNameAtEndOf(normalized);
      if (nameOnly) addName(nameOnly);
    }
  }
  return { names, counts };
}

/** C-T4 机械数量型号一致性：仅当资料事实存在可对账的机械条目时执行——
 * ①同实体台数两口径并存（正文 vs 事实）逐项报差；②事实机械清单外的非通用机械名报名。
 * 名称归一与跨章机械矩阵（qualityValidation）同源单源，避免检测口径漂移 */
function equipmentCountConsistencyIssues(markdown: string, factsModel: DocumentFactsModel, rule: ConsistencyRule): ValidationIssue[] {
  const claims = scanEquipmentCountClaims(markdown);
  if (claims.length === 0) return [];
  const { names: factNames, counts: factCounts } = equipmentFactIndex(factsModel, rule.factGroups);
  if (factNames.length === 0) return [];
  const issues: ValidationIssue[] = [];
  const nameConflicts = new Map<string, string>();
  const countConflicts: string[] = [];
  const seenCounts = new Set<string>();
  for (const claim of claims) {
    const matchedFact = factNames.find(factName => hasCompatibleFact(claim.name, [factName]));
    if (matchedFact) {
      const factCount = factCounts.get(matchedFact);
      if (factCount === undefined || factCount === claim.count) continue;
      const key = `${claim.name}:${[claim.count, factCount].sort((left, right) => left - right).join('-')}`;
      if (seenCounts.has(key)) continue;
      seenCounts.add(key);
      countConflicts.push(`${claim.name}：正文 ${claim.count} 台、资料 ${factCount} 台`);
      continue;
    }
    if (GENERIC_TERMS_RE.test(claim.name)) continue;
    const current = nameConflicts.get(claim.name);
    if (!current || claim.raw.length < current.length) nameConflicts.set(claim.name, claim.raw);
  }
  if (nameConflicts.size > 0) {
    const conflicting = [...nameConflicts].map(([name, raw]) => (raw.length - name.length <= 1 ? raw : name)).slice(0, 5);
    issues.push({
      level: 'warning',
      message: `施组数据一致性风险：机械数量型号 可能与项目图谱/事实不一致（${conflicting.join('、')}）`,
      suggestion: `请核对机械数量型号在${rule.locations}中的表述，统一以招标文件、项目图谱和可信事实为准。`,
    });
  }
  if (countConflicts.length > 0) {
    issues.push({
      level: 'warning',
      message: `施组数据一致性风险：机械数量型号 正文台数与项目图谱/事实不一致（${countConflicts.slice(0, 5).join('；')}）`,
      suggestion: `同一机械台数全文档只允许一套口径：请以资料事实/项目图谱中的机械配置为准统一${rule.locations}中的台数表述（正文与资料并存时以资料为准）。`,
    });
  }
  return issues;
}

export function constructionOrgConsistencyIssues(markdown: string, factsModel: DocumentFactsModel): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!/施工组织设计|施工组织|施组|质量|安全|文明施工/u.test(markdown)) return issues;
  for (const rule of CONSISTENCY_RULES) {
    if (rule.kind === 'equipment-counts') {
      issues.push(...equipmentCountConsistencyIssues(markdown, factsModel, rule));
      continue;
    }
    const facts = factValues(factsModel, rule.factGroups);
    const generated = markdownValues(markdown, rule.patterns ?? []);
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
