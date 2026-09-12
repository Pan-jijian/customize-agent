import type { DocumentTemplateChapter, PlannedTablePlan } from './types';
import type { PlannedTableRequest } from './promptRuleExtraction';

function normalizeText(text: string) {
  return text.replace(/\s+/gu, '').toLowerCase();
}

function unique<T>(items: T[]) {
  return [...new Set(items)];
}

/** 二字滑窗重叠率：标题语义重合度判定（容忍“劳动力动态投入”与“劳动力投入计划”等表述差异） */
function bigramOverlap(left: string, right: string) {
  const bigrams = (text: string) => {
    const set = new Set<string>();
    for (let index = 0; index < text.length - 1; index += 1) set.add(text.slice(index, index + 2));
    return set;
  };
  const target = bigrams(normalizeText(right));
  const source = [...bigrams(normalizeText(left))];
  if (source.length === 0) return 0;
  return source.filter(pair => target.has(pair)).length / source.length;
}

/** 提示词声明必需表格 → 章节匹配评分（表名与章标题/小节标题的包含关系与滑窗重叠，取最高） */
function requiredTableMatchScore(title: string, chapter: DocumentTemplateChapter) {
  const norm = normalizeText(title).replace(/表$/u, '');
  if (!norm) return 0;
  let best = 0;
  for (const haystack of [chapter.title, ...(chapter.sections || [])]) {
    const normalized = normalizeText(haystack);
    if (!normalized) continue;
    if (normalized.includes(norm) || norm.includes(normalized)) { best = Math.max(best, 1); continue; }
    best = Math.max(best, bigramOverlap(norm, normalized));
  }
  return best;
}

/**
 * 规划表格计划构建：表格来源 = 提示词声明的必需表格（用户声明层，必写）+ LLM 章节规划的表格需求
 * （按章按节产出）。无静态目录匹配、无系统创作——规划没有的表不出现。
 * 提示词声明的必需表格逐表全章评分归属最高分章；无归属（评分 < 0.3）的显性返回，
 * 交由最终门禁的必需表格兜底链（markdownComposer.insertRequiredTable）处理并供进度消息展示。
 */
export function buildPlannedTablePlans(input: {
  chapters: DocumentTemplateChapter[];
  plannedTables: Map<string, PlannedTableRequest[]>;
  requiredTables?: string[];
}): { chapters: DocumentTemplateChapter[]; unattachedRequiredTables: string[] } {
  const plansByChapterId = new Map<string, PlannedTablePlan[]>();
  const addPlan = (chapterId: string, request: { title: string; fields: string[]; section?: string; required: boolean; reason: string }) => {
    const title = request.title.trim();
    if (!title) return;
    const plans = plansByChapterId.get(chapterId) || [];
    if (plans.some(plan => plan.title === title || plan.title.includes(title) || title.includes(plan.title))) return;
    plans.push({
      id: `planned-table-${chapterId}-${plans.length + 1}`,
      title,
      chapterTitle: '',
      section: request.section || '',
      required: request.required,
      reason: request.reason,
      fields: request.fields.filter(Boolean).map(name => ({ name })).slice(0, 12),
    });
    plansByChapterId.set(chapterId, plans);
  };
  for (const chapter of input.chapters) {
    for (const request of input.plannedTables.get(chapter.id) || []) {
      addPlan(chapter.id, { title: request.title, fields: request.fields, required: false, reason: '本章小节规划产出的表格需求（按章按节规划）。' });
    }
  }
  const unattachedRequiredTables: string[] = [];
  for (const rawTitle of input.requiredTables || []) {
    const title = rawTitle.trim();
    if (!title) continue;
    let bestChapter: DocumentTemplateChapter | undefined;
    let bestScore = 0;
    for (const chapter of input.chapters) {
      const score = requiredTableMatchScore(title, chapter);
      if (score > bestScore) { bestScore = score; bestChapter = chapter; }
    }
    if (!bestChapter || bestScore < 0.3) { unattachedRequiredTables.push(title); continue; }
    addPlan(bestChapter.id, { title, fields: [], required: true, reason: '用户提示词声明的必需表格。' });
  }
  const chapters = input.chapters.map(chapter => {
    const plans = plansByChapterId.get(chapter.id);
    if (!plans?.length) return chapter;
    return {
      ...chapter,
      tableSections: unique([...(chapter.tableSections || []), ...plans.map(plan => plan.title)]),
      tableRequirements: unique([
        ...(chapter.tableRequirements || []),
        ...plans.filter(plan => plan.required).map(plan => `${plan.title}：用户提示词声明的必需表格，必须真实输出为 markdown 表格，表头与行数据必须与本章内容一致。`),
      ]),
      tablePlans: plans.map(plan => ({ ...plan, chapterTitle: chapter.title })),
    };
  });
  return { chapters, unattachedRequiredTables };
}

/** 按小节标题把章节表格计划分配到具体小节（小节级成稿链路使用，保证表格指令到达 Writer） */
export function sectionTablePlans(chapter: DocumentTemplateChapter, sectionTitle: string): PlannedTablePlan[] {
  const plans = chapter.tablePlans || [];
  if (plans.length === 0) return [];
  const norm = normalizeText(sectionTitle || '');
  if (!norm) return plans;
  return plans.filter(plan => {
    // 规划归属小节直接命中
    const sectionNorm = normalizeText(plan.section || '');
    if (sectionNorm && (norm.includes(sectionNorm) || sectionNorm.includes(norm))) return true;
    const titleNorm = normalizeText(plan.title);
    if (titleNorm && (norm.includes(titleNorm) || titleNorm.includes(norm))) return true;
    // 表名去掉“表”后缀后与小节标题互相包含（如“劳动力投入计划”小节承接“劳动力动态投入计划表”）
    const plainTitle = titleNorm.replace(/表$/u, '');
    if (plainTitle && (norm.includes(plainTitle) || plainTitle.includes(norm))) return true;
    // 二字滑窗重叠率兜底：小节标题与表名语义高度重合（≥60%）视为承接，避免表述差异导致表格丢失
    if (plainTitle && bigramOverlap(norm, plainTitle) >= 0.6) return true;
    return false;
  });
}

/** 章节内没有被任何小节承接的表格计划（兜底挂到最匹配的承载小节，防止表格因小节标题不匹配而丢失） */
export function unassignedSectionTablePlans(chapter: DocumentTemplateChapter, sectionTitles: string[]): PlannedTablePlan[] {
  const plans = chapter.tablePlans || [];
  if (plans.length === 0) return [];
  return plans.filter(plan => !sectionTitles.some(title => sectionTablePlans(chapter, title).some(assigned => assigned.id === plan.id)));
}

/** 组级表格计划过滤：组级成稿链路（主题块并发）每组只注入本组小节承接的表计划，
 * 末组额外承接全章未分配表（allSectionTitles 传全章小节标题时计算未分配表并入），
 * 避免每组都看到全章表计划导致跨组重复输出同一张表或归属错位 */
export function groupTablePlansForSections(chapter: DocumentTemplateChapter, groupSectionTitles: string[], allSectionTitles: string[]): PlannedTablePlan[] {
  const plans = chapter.tablePlans || [];
  if (plans.length === 0) return plans;
  const matchedIds = new Set<string>();
  const matched: PlannedTablePlan[] = [];
  for (const title of groupSectionTitles) {
    for (const plan of sectionTablePlans(chapter, title)) {
      if (!matchedIds.has(plan.id)) {
        matchedIds.add(plan.id);
        matched.push(plan);
      }
    }
  }
  if (allSectionTitles.length > 0) {
    for (const plan of unassignedSectionTablePlans(chapter, allSectionTitles)) {
      if (!matchedIds.has(plan.id)) {
        matchedIds.add(plan.id);
        matched.push(plan);
      }
    }
  }
  return matched;
}

/** 文档中的 markdown 表格数量（分隔行计数） */
function markdownTableCount(markdown: string) {
  let count = 0;
  for (const line of markdown.split(/\r?\n/u)) {
    if (/^\s*\|?\s*:?-{3,}:?/u.test(line) && line.includes('|')) count += 1;
  }
  return count;
}

export interface TablePlanExecutionGap {
  chapterTitle: string;
  planned: number;
  actual: number;
  plans: PlannedTablePlan[];
}

/** 表格执行率确定性核验：规划应输出的表格必须真实落为 markdown 表格；执行率显著不足（<60% 且缺≥2 张）时返回缺口清单供定向补表 */
export function tablePlanExecutionGaps(chapters: DocumentTemplateChapter[], drafts: Array<{ title: string; content: string; sections?: string[] }>): TablePlanExecutionGap[] {
  const gaps: TablePlanExecutionGap[] = [];
  for (const chapter of chapters) {
    const plans = chapter.tablePlans || [];
    if (plans.length === 0) continue;
    const draft = drafts.find(item => item.title === chapter.title) || drafts.find(item => chapter.title.includes(item.title) || item.title.includes(chapter.title));
    if (!draft) continue;
    const actual = markdownTableCount(draft.content);
    if (actual >= plans.length * 0.6 || plans.length - actual < 2) continue;
    gaps.push({ chapterTitle: chapter.title, planned: plans.length, actual, plans });
  }
  return gaps;
}

/** 表格排版与字段填写约束（章级/小节级 prompt 共用） */
const TABLE_FORMAT_RULES = [
  '【表格排版硬约束】每个 markdown 表格必须独立成行：表头行必须以“|”开头单独占一行，下一行紧跟“|---|”分隔行，数据行逐行以“|”开头；严禁把表头接在正文段落同一行（如“正文……。| 表头1 | 表头2 |”），输出表格前必须先换行。',
  '每个表格前必须写 1～2 句引导叙述（说明该表的作用、数据口径与关键结论），表格不能替代所在小节全部正文；表格输出后还应围绕表中关键节点、责任分工与纠偏措施展开至少一段实施性正文。',
  '只输出表格/清单本体和用户提示词明确要求的文字；不得输出系统来源说明、后台溯源列、固定表前后说明或占位话术。',
  '【字段填写约束】项目特有数字、日期、工程量、规格必须来自项目资料或项目图谱，不得编造；人数、台班、进度时间等计划类数值必须原样引用蓝图权威锚点（劳动力峰值、工种构成、分阶段投入、机械台数、总工期节点），不得基于工程量或定额自行推算另设，不得留空、不得写“按需配置”“根据进度灵活调配”等空话。',
];

function tablePlanLines(plan: PlannedTablePlan, index: number) {
  return [
    `${index + 1}. ${plan.required ? '必写' : '应写'}：${plan.title}`,
    plan.fields.length ? `   - 表头必须为：${plan.fields.map(field => field.name).join(' | ')}（不得擅自改字段、删字段或增加后台溯源列）` : '',
    plan.section ? `   - 归属小节：${plan.section}` : '',
    `   - 来源：${plan.reason}`,
  ].filter(Boolean).join('\n');
}

export function tablePlansPrompt(chapter: DocumentTemplateChapter) {
  const plans = chapter.tablePlans || [];
  if (plans.length === 0) return '';
  return [
    '【本章表格/清单结构化生成要求（硬性验收项）】',
    '以下表格来自用户提示词声明与本章小节规划，不得按数量机械增减；每个应输出的表格都必须真实输出为 markdown 表格；输出后按本清单逐表自检，缺失即视为正文不足。',
    ...TABLE_FORMAT_RULES,
    ...plans.map((plan, index) => tablePlanLines(plan, index)),
  ].filter(Boolean).join('\n');
}

/** 小节级表格指令：把分配给小节的表格计划转成 Writer prompt 片段（小节级成稿链路使用） */
export function sectionTablePlansPrompt(plans: PlannedTablePlan[], sectionTitle: string) {
  if (!plans.length) return '';
  return [
    `【本节“${sectionTitle}”必须输出的表格（硬性验收项）】`,
    '以下表格归属于本节，必须真实输出为 markdown 表格（紧跟相关三级小节）；输出后逐表自检，缺失即视为正文不足。',
    ...TABLE_FORMAT_RULES,
    ...plans.map((plan, index) => tablePlanLines(plan, index)),
  ].filter(Boolean).join('\n');
}
