import type { CanonicalFactModel, DocumentTemplateChapter, GovernedTableFallbackPolicy, GovernedTableNecessity, GovernedTableOutputType, ProjectGraph, ProjectGraphTablePlan } from './types';
import { CONSTRUCTION_ORG_TABLE_CATALOG, type ConstructionOrgTableDefinition } from './constructionOrgTableCatalog';

function normalizeText(text: string) {
  return text.replace(/\s+/gu, '').toLowerCase();
}

function unique<T>(items: T[]) {
  return [...new Set(items)];
}

function graphText(graph?: ProjectGraph) {
  if (!graph) return '';
  return normalizeText([
    ...graph.works.flatMap(item => [item.name, item.scope, ...item.relatedItems]),
    ...graph.methods.flatMap(item => [item.name, ...item.steps, ...item.applicableWorks]),
    ...graph.resources.flatMap(item => [item.name, item.type, item.spec, item.quantity, item.unit]),
    ...graph.schedule.flatMap(item => [item.milestone, item.duration, item.startDate, item.endDate]),
    ...graph.standards.flatMap(item => [item.code, item.description]),
    ...graph.risks.flatMap(item => [item.risk, item.level, item.mitigation]),
    ...graph.requirements.flatMap(item => [item.category, item.detail]),
    ...graph.siteConditions.flatMap(item => [item.condition, item.impact]),
    ...graph.addendumChanges.flatMap(item => [item.originalPath, item.original, item.revised]),
    ...graph.gaps,
  ].join(' '));
}

function chapterText(chapter: DocumentTemplateChapter) {
  return normalizeText([
    chapter.title,
    chapter.purpose,
    ...(chapter.sections || []),
    ...(chapter.tableSections || []),
    ...(chapter.requiredFacts || []),
    ...(chapter.queries || []),
  ].join(' '));
}

function tableBelongsToChapter(table: ConstructionOrgTableDefinition, chapter: DocumentTemplateChapter) {
  const text = chapterText(chapter);
  if ((chapter.tableSections || []).some(section => section === table.title || table.title.includes(section) || section.includes(table.title))) return true;
  if (table.moduleTitles.some(moduleTitle => text.includes(normalizeText(moduleTitle)))) return true;
  if (table.triggerKeywords.some(keyword => text.includes(normalizeText(keyword)))) return true;
  return false;
}

function graphTriggersTable(table: ConstructionOrgTableDefinition, graphTextIndex: string, graph?: ProjectGraph) {
  if (!graph) return table.required;
  if (table.triggerKeywords.some(keyword => graphTextIndex.includes(normalizeText(keyword)))) return true;
  if (table.id === 'equipment-plan') return graph.resources.some(item => item.type === 'equipment');
  if (table.id === 'labor-plan' || table.id === 'labor-total-stat') return graph.resources.some(item => item.type === 'labor');
  if (table.id === 'progress-milestones' || table.id === 'master-schedule') return graph.schedule.length > 0 || graph.works.length > 0;
  if (table.id === 'risk-grade-control') return graph.risks.length > 0;
  if (table.id === 'pipeline-protection') return graph.siteConditions.some(item => /管线|道路|居民|学校|医院|商业|既有|周边/u.test(`${item.condition}${item.impact}`));
  if (table.id === 'bim-smart-site') return graph.requirements.some(item => /BIM|智慧|数字|监测|视频|实名制/u.test(`${item.category}${item.detail}`));
  // required 表是施工组织设计标准配置，图谱数据稀疏不影响输出决策（数据只影响行种子与可填性，不决定写不写）
  return table.required;
}

function tableReason(table: ConstructionOrgTableDefinition, graph?: ProjectGraph) {
  const graphHints: string[] = [];
  if (graph?.schedule.length && table.fields.some(field => field.sourceDomain === 'schedule')) graphHints.push('项目图谱包含工期与关键节点');
  if (graph?.resources.length && table.fields.some(field => field.sourceDomain === 'resources')) graphHints.push('项目图谱包含资源投入信息');
  if (graph?.risks.length && table.fields.some(field => field.sourceDomain === 'risks')) graphHints.push('项目图谱包含风险与管控要求');
  if (graph?.requirements.length && table.fields.some(field => field.sourceDomain === 'requirements')) graphHints.push('项目图谱包含招标/管理要求');
  if (graph?.siteConditions.length && table.fields.some(field => field.sourceDomain === 'siteConditions')) graphHints.push('项目图谱包含现场条件约束');
  return graphHints.length ? graphHints.join('；') : `章节包含“${table.moduleTitles.join('、')}”模块，按施工组织设计标准表格库生成。`;
}

function canonicalText(canonical?: CanonicalFactModel) {
  if (!canonical) return '';
  return normalizeText(Object.values(canonical.byKey || {}).map(fact => `${fact.label} ${fact.value}`).join(' '));
}

function graphDomainHasData(domain: ProjectGraphTablePlan['sourceDomains'][number], graph?: ProjectGraph, canonical?: CanonicalFactModel) {
  if (domain === 'factsModel') return Boolean(canonical && Object.keys(canonical.byKey || {}).length > 0);
  if (!graph) return false;
  if (domain === 'project') return Object.keys(canonical?.byKey || {}).length > 0 || graph.requirements.length > 0;
  if (domain === 'works') return graph.works.length > 0;
  if (domain === 'methods') return graph.methods.length > 0;
  if (domain === 'resources') return graph.resources.length > 0;
  if (domain === 'schedule') return graph.schedule.length > 0 || Boolean(canonical?.schedule.duration);
  if (domain === 'standards') return graph.standards.length > 0;
  if (domain === 'risks') return graph.risks.length > 0;
  if (domain === 'requirements') return graph.requirements.length > 0;
  if (domain === 'siteConditions') return graph.siteConditions.length > 0;
  return true;
}

function tableNecessity(table: ConstructionOrgTableDefinition, chapter: DocumentTemplateChapter, graphTextIndex: string, graph?: ProjectGraph): GovernedTableNecessity {
  const text = chapterText(chapter);
  if (table.required) return 'must';
  if ((chapter.tableSections || []).some(section => section === table.title || table.title.includes(section))) return 'must';
  // 章节语义命中（章节标题/小节含模块名或触发词）即视为触发：章节既然承接该模块，对应表格就应输出
  const chapterSemanticHit = table.moduleTitles.some(moduleTitle => text.includes(normalizeText(moduleTitle))) || table.triggerKeywords.some(keyword => text.includes(normalizeText(keyword)));
  const triggered = graphTriggersTable(table, graphTextIndex, graph) || chapterSemanticHit;
  if (/危大|安全|进度|工期|质量|资源|人材机|机械|劳动力|材料|新技术|新工艺/u.test(text) && triggered) return 'should';
  if (triggered) return 'conditional';
  return 'reference';
}

function tableFillability(table: ConstructionOrgTableDefinition, graph?: ProjectGraph, canonical?: CanonicalFactModel) {
  const requiredFields = table.fields.filter(field => field.required);
  const missingProjectFactFields = table.fields
    .filter(field => field.required && field.fallbackPolicy === 'projectFactOnly' && !graphDomainHasData(field.sourceDomain, graph, canonical))
    .map(field => field.name);
  // deriveFromProject/standardAllowed/deriveFromContext 字段属于投标人编制内容或标准做法，按可填计
  const confirmedFieldCount = table.fields.filter(field => field.fallbackPolicy !== 'projectFactOnly' || graphDomainHasData(field.sourceDomain, graph, canonical)).length;
  let fallbackPolicy: GovernedTableFallbackPolicy = 'generate_with_confirmed_facts';
  if (missingProjectFactFields.length > 0 && confirmedFieldCount > 0) fallbackPolicy = 'generate_with_review_notes';
  if (missingProjectFactFields.length === requiredFields.length && requiredFields.length > 0) fallbackPolicy = 'convert_to_text';
  if (confirmedFieldCount === 0) fallbackPolicy = 'skip_with_reason';
  return {
    requiredFieldCount: requiredFields.length,
    confirmedFieldCount,
    missingProjectFactFields,
    canGenerate: fallbackPolicy !== 'skip_with_reason',
    fallbackPolicy,
  };
}

function tableOutputDecision(necessity: GovernedTableNecessity, fillability: ReturnType<typeof tableFillability>): { shouldOutput: boolean; outputType: GovernedTableOutputType; decisionReason: string } {
  // must/should 一律按 markdown_table 输出：表格是硬性验收项，事实缺失只影响行级取值约束（review notes），不降级为清单或跳过
  if (necessity === 'must') return { shouldOutput: true, outputType: 'markdown_table', decisionReason: '章节必要管控表，按项目资料、图谱事实与投标人编制内容输出。' };
  if (necessity === 'should') return { shouldOutput: true, outputType: 'markdown_table', decisionReason: '项目图谱和章节语义均触发，按资料与编制推导输出。' };
  if (necessity === 'conditional' && fillability.confirmedFieldCount > 0) return { shouldOutput: true, outputType: 'markdown_table', decisionReason: '资料或章节语义已触发该结构，按已有事实表达。' };
  return { shouldOutput: false, outputType: 'skip', decisionReason: '非本章核心输出。' };
}

function tableRowSeeds(table: ConstructionOrgTableDefinition, graph?: ProjectGraph, canonical?: CanonicalFactModel): ProjectGraphTablePlan['rowSeeds'] {
  const seeds: ProjectGraphTablePlan['rowSeeds'] = [];
  const addSeed = (rowLabel: string, source: 'canonicalFact' | 'projectGraph' | 'boq' | 'standard', value: string, sourceRef?: string) => {
    const normalized = normalizeText(`${rowLabel}${value}`);
    if (!normalized || seeds.some(seed => normalizeText(seed.rowLabel) === normalizeText(rowLabel))) return;
    const confirmedFields = table.fields.filter(field => normalizeText(value).includes(normalizeText(field.name)) || field.fallbackPolicy !== 'projectFactOnly').map(field => field.name);
    const missingFields = table.fields.filter(field => field.required && !confirmedFields.includes(field.name) && field.fallbackPolicy === 'projectFactOnly').map(field => field.name);
    seeds.push({ rowLabel, source, confirmedFields, missingFields, sourceRef });
  };
  for (const fact of Object.values(canonical?.byKey || {})) {
    if (table.triggerKeywords.some(keyword => normalizeText(`${fact.label}${fact.value}`).includes(normalizeText(keyword)))) addSeed(fact.label, 'canonicalFact', fact.value, fact.sourceFile);
  }
  for (const resource of graph?.resources || []) {
    if (table.fields.some(field => field.sourceDomain === 'resources') || table.triggerKeywords.some(keyword => normalizeText(`${resource.name}${resource.type}`).includes(normalizeText(keyword)))) addSeed(resource.name, resource.type === 'equipment' || resource.type === 'material' || resource.type === 'labor' ? 'projectGraph' : 'standard', [resource.spec, resource.quantity, resource.unit].filter(Boolean).join(' '), resource.sourceFiles?.[0]);
  }
  for (const risk of graph?.risks || []) {
    if (table.fields.some(field => field.sourceDomain === 'risks') || table.triggerKeywords.some(keyword => normalizeText(risk.risk).includes(normalizeText(keyword)))) addSeed(risk.risk, 'projectGraph', [risk.level, risk.mitigation].filter(Boolean).join(' '), risk.sourceFiles?.[0]);
  }
  for (const milestone of graph?.schedule || []) {
    if (table.fields.some(field => field.sourceDomain === 'schedule')) addSeed(milestone.milestone, 'projectGraph', [milestone.duration, milestone.startDate, milestone.endDate].filter(Boolean).join(' '), milestone.sourceFiles?.[0]);
  }
  return seeds.slice(0, 24);
}

export function buildConstructionOrgTablePlans(input: { chapters: DocumentTemplateChapter[]; projectGraph?: ProjectGraph; canonicalFacts?: CanonicalFactModel }) {
  const graphTextIndex = graphText(input.projectGraph);
  return input.chapters.map(chapter => {
    const combinedGraphTextIndex = `${graphTextIndex} ${canonicalText(input.canonicalFacts)}`;
    const generatedPlans = CONSTRUCTION_ORG_TABLE_CATALOG
      .map(table => {
        if (!tableBelongsToChapter(table, chapter)) return null;
        const sourceDomains = unique(table.fields.map(field => field.sourceDomain));
        const necessity = tableNecessity(table, chapter, combinedGraphTextIndex, input.projectGraph);
        // 归属本章但必要性为 reference 的表不纳入计划；required 表永远 must，不会走到 reference
        if (necessity === 'reference') return null;
        const fillability = tableFillability(table, input.projectGraph, input.canonicalFacts);
        const outputDecision = tableOutputDecision(necessity, fillability);
        const plan: ProjectGraphTablePlan = {
          id: table.id,
          title: table.title,
          chapterTitle: chapter.title,
          moduleTitle: table.moduleTitles[0] || chapter.title,
          required: outputDecision.shouldOutput && (necessity === 'must' || table.required),
          reason: tableReason(table, input.projectGraph),
          fields: table.fields,
          sourceDomains,
          necessity,
          belongsToChapter: true,
          scopeExplanation: `表格归属于“${chapter.title}”中“${table.moduleTitles.join('、')}”相关管理对象。`,
          triggerFacts: Object.values(input.canonicalFacts?.byKey || {}).filter(fact => table.triggerKeywords.some(keyword => normalizeText(`${fact.label}${fact.value}`).includes(normalizeText(keyword)))).map(fact => `${fact.label}=${fact.value}`),
          triggerGraphNodes: table.triggerKeywords.filter(keyword => combinedGraphTextIndex.includes(normalizeText(keyword))),
          fillability,
          outputDecision,
          rowSeeds: tableRowSeeds(table, input.projectGraph, input.canonicalFacts),
        };
        return plan;
      })
      .filter((plan): plan is ProjectGraphTablePlan => Boolean(plan));

    const existingPlanMap = new Map((chapter.tablePlans || []).map(plan => [plan.id, plan]));
    for (const plan of generatedPlans) existingPlanMap.set(plan.id, plan);
    const plans = [...existingPlanMap.values()];
    const tableSections = unique([...(chapter.tableSections || []), ...plans.map(plan => plan.title)]);
    const tableRequirements = unique([
      ...(chapter.tableRequirements || []),
      ...plans.map(plan => {
        const deriveFields = plan.fields.filter(field => field.fallbackPolicy === 'deriveFromProject');
        const factFields = plan.fields.filter(field => field.fallbackPolicy === 'projectFactOnly');
        const deriveRule = deriveFields.length
          ? `表中“${deriveFields.map(field => field.name).join('、')}”属于投标人计划编制类字段，资料不会提供，必须基于项目工程量、工期与工序流水按定额工效推导具体数值，不得留空、不得写“按需配置”等占位话术。`
          : '';
        const factRule = factFields.length ? '项目特有数字、日期、工程量、规格必须来自资料或项目图谱，不得编造。' : '';
        return `${plan.title}：表头必须为“${plan.fields.map(field => field.name).join('、')}”；${[deriveRule, factRule].filter(Boolean).join('') || '可按施工组织设计标准流程填写。'}`;
      }),
    ]);

    return {
      ...chapter,
      tableSections,
      tableRequirements,
      tablePlans: plans,
    };
  });
}

/** 二字滑窗重叠率：小节标题与表名语义高度重合时视为承接（容忍“动态投入”与“投入”等表述差异） */
function bigramOverlap(sectionTitle: string, tableTitle: string) {
  const bigrams = (text: string) => {
    const set = new Set<string>();
    for (let index = 0; index < text.length - 1; index += 1) set.add(text.slice(index, index + 2));
    return set;
  };
  const target = bigrams(tableTitle);
  const source = [...bigrams(sectionTitle)];
  if (source.length === 0) return 0;
  return source.filter(pair => target.has(pair)).length / source.length;
}

/** 按小节标题把章节表格计划分配到具体小节（小节级成稿链路使用，保证表格指令到达 Writer） */
export function sectionTablePlans(chapter: DocumentTemplateChapter, sectionTitle: string): ProjectGraphTablePlan[] {
  const plans = (chapter.tablePlans || []).filter(plan => plan.outputDecision?.shouldOutput);
  if (plans.length === 0) return [];
  const norm = normalizeText(sectionTitle || '');
  if (!norm) return plans;
  return plans.filter(plan => {
    const moduleNorm = normalizeText(plan.moduleTitle || '');
    const titleNorm = normalizeText(plan.title);
    if (moduleNorm && (norm.includes(moduleNorm) || moduleNorm.includes(norm))) return true;
    if (titleNorm && (norm.includes(titleNorm) || titleNorm.includes(norm))) return true;
    // 表名去掉“表”后缀后与小节标题互相包含（如“劳动力投入计划”小节承接“劳动力动态投入计划表”）
    const plainTitle = titleNorm.replace(/表$/u, '');
    if (plainTitle && (norm.includes(plainTitle) || plainTitle.includes(norm))) return true;
    // 触发词命中：小节标题包含计划触发词（如“劳动力”小节承接劳动力表）
    if ((plan.triggerGraphNodes || []).some(keyword => norm.includes(normalizeText(keyword)))) return true;
    // 二字滑窗重叠率兜底：小节标题与表名语义高度重合（≥60%）视为承接，避免表述差异导致表格丢失
    if (plainTitle && bigramOverlap(norm, plainTitle) >= 0.6) return true;
    return false;
  });
}

/** 章节内没有被任何小节承接的必写表格计划（兜底挂到最匹配的承载小节，防止必写表因小节标题不匹配而丢失） */
export function unassignedSectionTablePlans(chapter: DocumentTemplateChapter, sectionTitles: string[]): ProjectGraphTablePlan[] {
  const plans = (chapter.tablePlans || []).filter(plan => plan.outputDecision?.shouldOutput);
  if (plans.length === 0) return [];
  return plans.filter(plan => !sectionTitles.some(title => sectionTablePlans(chapter, title).some(assigned => assigned.id === plan.id)));
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
  plans: ProjectGraphTablePlan[];
}

/** 表格执行率确定性核验：计划应输出的表格必须真实落为 markdown 表格；执行率显著不足（<60% 且缺≥2 张）时返回缺口清单供定向补表 */
export function tablePlanExecutionGaps(chapters: DocumentTemplateChapter[], drafts: Array<{ title: string; content: string; sections?: string[] }>): TablePlanExecutionGap[] {
  const gaps: TablePlanExecutionGap[] = [];
  for (const chapter of chapters) {
    const plans = (chapter.tablePlans || []).filter(plan => plan.outputDecision?.shouldOutput);
    if (plans.length === 0) continue;
    const draft = drafts.find(item => item.title === chapter.title) || drafts.find(item => chapter.title.includes(item.title) || item.title.includes(chapter.title));
    if (!draft) continue;
    const actual = markdownTableCount(draft.content);
    if (actual >= plans.length * 0.6 || plans.length - actual < 2) continue;
    gaps.push({ chapterTitle: chapter.title, planned: plans.length, actual, plans });
  }
  return gaps;
}

export function tablePlansPrompt(chapter: DocumentTemplateChapter) {
  const plans = chapter.tablePlans || [];
  if (plans.length === 0) return '';
  const derivedHint = plans.some(plan => plan.fields.some(field => field.fallbackPolicy === 'deriveFromProject'))
    ? '\n【投标人编制类字段授权】表中 fallbackPolicy=deriveFromProject 的字段（人数、台班、进度时间、进场时间等）资料不会提供具体数值，这是投标人自己的计划编制内容：必须基于项目工程量、总工期与工序流水，按定额工效推导并落到具体数字；不得留空、不得写“按需配置”“根据进度灵活调配”等空话。项目事实类字段（面积、工程量、规格、质量标准）仍必须来自资料，不得编造。'
    : '';
  return [
    '【本章表格/清单结构化生成要求（硬性验收项）】',
    '以下表格来自项目图谱、事实主权模型与施工组织设计标准表格库的治理决策；不得按数量机械增减，必须按必要性、章节归属、证据可填性和输出形态执行。',
    '每个应输出（必写/应写）的表格都必须真实输出为 markdown 表格；输出后按本清单逐表自检，缺失即视为正文不足。',
    '每个表格前必须写 1～2 句引导叙述（说明该表的作用、数据口径与关键结论），表格不能替代所在小节全部正文；表格输出后还应围绕表中关键节点、责任分工与纠偏措施展开至少一段实施性正文。',
    '只输出表格/清单本体和用户提示词明确要求的文字；不得输出系统来源说明、后台溯源列、固定表前后说明或占位话术。',
    ...plans.map((plan, index) => [
      `${index + 1}. ${plan.required ? '必写' : plan.outputDecision?.shouldOutput ? '应写' : '参考'}：${plan.title}`,
      `   - 必要性：${plan.necessity || (plan.required ? 'must' : 'conditional')}；输出形态：${plan.outputDecision?.outputType || 'markdown_table'}；决策：${plan.outputDecision?.decisionReason || '按章节内容需要输出。'}`,
      `   - 适用模块：${plan.moduleTitle}`,
      `   - 章节归属：${plan.scopeExplanation || `归属于${chapter.title}`}`,
      `   - 生成原因：${plan.reason}`,
      `   - 表头字段：${plan.fields.map(field => field.name).join(' | ')}`,
      `   - 字段来源：${plan.fields.map(field => `${field.name}←${field.sourceDomain}（${field.sourceHint}）`).join('；')}`,
      plan.fillability?.missingProjectFactFields.length ? `   - 字段约束：${plan.fillability.missingProjectFactFields.join('、')} 必须继续从项目图谱、可信事实和绑定资料中取值；不得写固定占位话术。` : `   - 可填性：已确认字段 ${plan.fillability?.confirmedFieldCount ?? plan.fields.length}/${plan.fields.length}。`,
      plan.rowSeeds?.length ? `   - 行级填充计划：${plan.rowSeeds.slice(0, 8).map(seed => `${seed.rowLabel}（${seed.source}${seed.missingFields.length ? `，字段待从资料补齐：${seed.missingFields.join('/')}` : ''}）`).join('；')}` : '',
      `   - 约束：${plan.fields.some(field => field.fallbackPolicy === 'projectFactOnly') ? 'projectFactOnly 字段必须来自项目资料、项目图谱或可信事实；不得编造，不得写占位话术。' : '可按标准施工组织流程填写，但必须贴合本章和项目场景。'}${plan.fields.some(field => field.fallbackPolicy === 'deriveFromProject') ? ' deriveFromProject 字段必须按上方“投标人编制类字段授权”推导具体数值。' : ''}`,
    ].filter(Boolean).join('\n')),
    derivedHint,
  ].filter(Boolean).join('\n');
}

/** 小节级表格指令：把分配给小节的表格计划转成 Writer prompt 片段（小节级成稿链路使用） */
export function sectionTablePlansPrompt(plans: ProjectGraphTablePlan[], sectionTitle: string) {
  if (!plans.length) return '';
  const derivedHint = plans.some(plan => plan.fields.some(field => field.fallbackPolicy === 'deriveFromProject'))
    ? '\n【投标人编制类字段授权】表中 fallbackPolicy=deriveFromProject 的字段（人数、台班、进度时间等）资料不会提供具体数值，这是投标人自己的计划编制内容：必须基于项目工程量、总工期与工序流水按定额工效推导并落到具体数字；不得留空、不得写“按需配置”“根据进度灵活调配”等空话。项目事实类字段仍必须来自资料，不得编造。'
    : '';
  return [
    `【本节“${sectionTitle}”必须输出的表格（硬性验收项）】`,
    '以下表格治理决策归属于本节，必须真实输出为 markdown 表格（紧跟相关三级小节）；输出后逐表自检，缺失即视为正文不足。',
    '每个表格前必须写 1～2 句引导叙述（说明该表的作用、数据口径与关键结论），表格不能替代本节全部正文；表格输出后还应围绕表中关键节点、责任分工与纠偏措施展开至少一段实施性正文。',
    ...plans.map((plan, index) => [
      `${index + 1}. ${plan.required ? '必写' : '应写'}：${plan.title}`,
      `   - 输出形态：${plan.outputDecision?.outputType || 'markdown_table'}；决策：${plan.outputDecision?.decisionReason || '按章节内容需要输出。'}`,
      `   - 表头字段：${plan.fields.map(field => field.name).join(' | ')}`,
      `   - 字段来源：${plan.fields.map(field => `${field.name}←${field.sourceDomain}（${field.sourceHint}）`).join('；')}`,
      plan.fillability?.missingProjectFactFields.length ? `   - 字段约束：${plan.fillability.missingProjectFactFields.join('、')} 必须继续从项目图谱、可信事实和绑定资料中取值；不得写固定占位话术。` : '',
      plan.rowSeeds?.length ? `   - 行级填充计划：${plan.rowSeeds.slice(0, 8).map(seed => `${seed.rowLabel}（${seed.source}${seed.missingFields.length ? `，字段待从资料补齐：${seed.missingFields.join('/')}` : ''}）`).join('；')}` : '',
      `   - 约束：${plan.fields.some(field => field.fallbackPolicy === 'projectFactOnly') ? 'projectFactOnly 字段必须来自项目资料、项目图谱或可信事实；不得编造。' : '可按标准施工组织流程填写，但必须贴合本章和项目场景。'}${plan.fields.some(field => field.fallbackPolicy === 'deriveFromProject') ? ' deriveFromProject 字段必须按下方“投标人编制类字段授权”推导具体数值。' : ''}`,
    ].filter(Boolean).join('\n')),
    derivedHint,
  ].filter(Boolean).join('\n');
}
