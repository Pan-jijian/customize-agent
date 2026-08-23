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
  if (table.id === 'labor-plan') return graph.resources.some(item => item.type === 'labor');
  if (table.id === 'progress-milestones') return graph.schedule.length > 0;
  if (table.id === 'risk-grade-control') return graph.risks.length > 0;
  if (table.id === 'pipeline-protection') return graph.siteConditions.some(item => /管线|道路|居民|学校|医院|商业|既有|周边/u.test(`${item.condition}${item.impact}`));
  if (table.id === 'bim-smart-site') return graph.requirements.some(item => /BIM|智慧|数字|监测|视频|实名制/u.test(`${item.category}${item.detail}`));
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
  const triggered = graphTriggersTable(table, graphTextIndex, graph);
  if (/危大|安全|进度|工期|质量|资源|人材机|机械|劳动力|材料/u.test(text) && triggered) return 'should';
  if (triggered) return 'conditional';
  return 'reference';
}

function tableFillability(table: ConstructionOrgTableDefinition, graph?: ProjectGraph, canonical?: CanonicalFactModel) {
  const requiredFields = table.fields.filter(field => field.required);
  const missingProjectFactFields = table.fields
    .filter(field => field.required && field.fallbackPolicy === 'projectFactOnly' && !graphDomainHasData(field.sourceDomain, graph, canonical))
    .map(field => field.name);
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
  if (necessity === 'must') return { shouldOutput: true, outputType: fillability.fallbackPolicy === 'convert_to_text' ? 'checklist' : 'markdown_table', decisionReason: '章节必要管控表，按项目资料和图谱事实输出。' };
  if (necessity === 'should') return { shouldOutput: true, outputType: fillability.fallbackPolicy === 'convert_to_text' ? 'checklist' : 'markdown_table', decisionReason: '项目图谱和章节语义均触发，按资料内容输出。' };
  if (necessity === 'conditional' && fillability.confirmedFieldCount > 0) return { shouldOutput: true, outputType: 'checklist', decisionReason: '资料已触发该结构，按已有事实表达。' };
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
      .filter(table => tableBelongsToChapter(table, chapter) && graphTriggersTable(table, combinedGraphTextIndex, input.projectGraph))
      .map<ProjectGraphTablePlan>(table => {
        const sourceDomains = unique(table.fields.map(field => field.sourceDomain));
        const necessity = tableNecessity(table, chapter, combinedGraphTextIndex, input.projectGraph);
        const fillability = tableFillability(table, input.projectGraph, input.canonicalFacts);
        const outputDecision = tableOutputDecision(necessity, fillability);
        return {
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
      });

    const existingPlanMap = new Map((chapter.tablePlans || []).map(plan => [plan.id, plan]));
    for (const plan of generatedPlans) existingPlanMap.set(plan.id, plan);
    const plans = [...existingPlanMap.values()];
    const tableSections = unique([...(chapter.tableSections || []), ...plans.map(plan => plan.title)]);
    const tableRequirements = unique([
      ...(chapter.tableRequirements || []),
      ...plans.map(plan => `${plan.title}：表头必须为“${plan.fields.map(field => field.name).join('、')}”；${plan.fields.some(field => field.fallbackPolicy === 'projectFactOnly') ? '项目特有数字、日期、工程量、规格必须来自资料或项目图谱，不得编造。' : '可按施工组织设计标准流程填写。'}`),
    ]);

    return {
      ...chapter,
      tableSections,
      tableRequirements,
      tablePlans: plans,
    };
  });
}

export function tablePlansPrompt(chapter: DocumentTemplateChapter) {
  const plans = chapter.tablePlans || [];
  if (plans.length === 0) return '';
  return [
    '【本章表格/清单结构化生成要求】',
    '以下表格来自项目图谱、事实主权模型与施工组织设计标准表格库的治理决策；不得按数量机械增减，必须按必要性、章节归属、证据可填性和输出形态执行。',
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
      `   - 约束：${plan.fields.some(field => field.fallbackPolicy === 'projectFactOnly') ? 'projectFactOnly 字段必须来自项目资料、项目图谱或可信事实；不得编造，不得写占位话术。' : '可按标准施工组织流程填写，但必须贴合本章和项目场景。'}`,
    ].filter(Boolean).join('\n')),
  ].join('\n');
}
