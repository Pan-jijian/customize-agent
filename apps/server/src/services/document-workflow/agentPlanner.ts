import type { AgentWorkflowContext, AgentWorkflowNode } from './agentWorkflow';
import type { DocumentEvidence, DocumentFact, DocumentTemplate, DocumentTemplateChapter, ProjectGraph, ValidationIssue } from './types';
import type { PlannedChapterStructure } from './integratedBlueprint';
import { BID_DISCIPLINE_PHRASES, stableHash, stringifyFactValue } from './utils';
import { buildSemanticSimilarity } from './semanticSimilarity';
import { isFragmentLikeSectionTitle, isInstructionLikeOutlineTitle } from './outline';
import { cleanSectionTitleArtifacts } from './promptRuleExtraction';

export interface AgentSectionPlan {
  title: string;
  objective: string;
  requiredFacts: string[];
  requiredGraphNodes: string[];
  evidenceQueries: string[];
  forbiddenPhrases: string[];
  minChars: number;
}

export interface AgentChapterPlan {
  chapterId: string;
  title: string;
  purpose: string;
  requiredFacts: string[];
  requiredGraphNodes: string[];
  evidenceQueries: string[];
  qualityRules: string[];
  forbiddenPhrases: string[];
  sections: AgentSectionPlan[];
}

export interface AgentDocumentPlan {
  planId: string;
  title: string;
  chapters: AgentChapterPlan[];
  requiredGlobalFacts: string[];
  forbiddenPhrases: string[];
  qualityRules: string[];
}

export interface AgentSectionTask extends AgentSectionPlan {
  factIds: string[];
  evidenceIds: string[];
  graphNodeIds: string[];
  ready: boolean;
  issues: ValidationIssue[];
}

export interface AgentChapterTask {
  taskId: string;
  chapterId: string;
  title: string;
  facts: DocumentFact[];
  evidence: DocumentEvidence[];
  graphContext: string;
  sections: AgentSectionTask[];
  ready: boolean;
  issues: ValidationIssue[];
}

export const FORMAL_FORBIDDEN_PHRASES = [
  '知识库', '系统暂未', '项目资料暂未', '资料未明确', '暂未明确', '待确认', '待资料复核', '待系统', '未检索到', '资料不足', '无法确认', '建议补充', '不适用', 'COL', '可核验信息',
  // 内部术语（词面标记）：术语合法性属语义判断，这里只做确定性 flag 触发 Repairer 按上下文语义改写，
  // 不做词面替换（“工作包”按语境应改写为“拆除工程/专业工程”等，逐词替换必然产生语义错误）
  '工作包',
  // 商务投标函内容（投标/评标纪律、廉洁承诺类）：属商务文件内容，技术标出现既降专业性又属评标敏感表述，
  // 必须整句删除移入商务文件（评分报告问题2），技术标只保留技术与管理承诺；词表与 utils 单一来源同口径
  ...BID_DISCIPLINE_PHRASES,
];

function normalizeText(value: string) {
  return value.replace(/\s+/gu, '').toLowerCase();
}

function factText(fact: DocumentFact) {
  return `${fact.fieldId || ''} ${fact.fieldName || ''} ${fact.key} ${stringifyFactValue(fact.value)}`.replace(/\s+/gu, ' ').trim();
}

function factValue(fact: DocumentFact) {
  return stringifyFactValue(fact.value).replace(/\s+/gu, ' ').trim();
}

function factMatches(fact: DocumentFact, query: string) {
  const text = normalizeText(factText(fact));
  return query.split(/[\s、，,；;：:（）()【】[-]+/u).filter(token => token.length >= 2).some(token => text.includes(normalizeText(token)));
}

function evidenceMatches(evidence: DocumentEvidence, query: string) {
  const text = normalizeText(`${evidence.sectionTitle || ''} ${evidence.content || ''} ${evidence.filePath || ''}`);
  return query.split(/[\s、，,；;：:（）()【】[-]+/u).filter(token => token.length >= 2).some(token => text.includes(normalizeText(token)));
}

function graphNodeSummary(graph: ProjectGraph, query: string) {
  const nodes = [
    ...graph.works.map(item => `工程：${item.name} ${item.scope}`),
    ...graph.methods.map(item => `工法：${item.name} ${(item.applicableWorks || []).join('、')}`),
    ...graph.resources.map(item => `资源：${item.name} ${item.spec} ${item.quantity}${item.unit}`),
    ...graph.schedule.map(item => `工期：${item.milestone} ${item.duration}`),
    ...graph.standards.map(item => `标准：${item.code} ${item.description}`),
    ...graph.risks.map(item => `风险：${item.risk} ${item.mitigation}`),
    ...graph.requirements.map(item => `要求：${item.category} ${item.detail}`),
    ...graph.siteConditions.map(item => `现场：${item.condition} ${item.impact}`),
  ];
  const normalizedQuery = normalizeText(query);
  return nodes.filter(node => normalizeText(node).includes(normalizedQuery) || query.split(/[\s、，,；;：:（）()【】[-]+/u).filter(token => token.length >= 2).some(token => normalizeText(node).includes(normalizeText(token))));
}

/** 语义查询扩展类别：keywords 为附加检索查询词（领域知识），prototype 为类别语义原型（供 bge 嵌入判别）。 */
const QUERY_EXPANSION_CATEGORIES = [
  { keywords: '安全 文明 危大 风险 应急 临边 洞口 消防 临电 高处 起重 吊装 基坑 脚手架 模板 支护 图纸 施工说明 审查意见', prototype: '安全生产 文明施工 危大工程 应急预案 风险管控' },
  { keywords: '工期 日历天 节点 进度 计划 开工 竣工 关键线路', prototype: '施工工期 进度计划 关键节点 开工时间 竣工时间' },
  { keywords: '质量 验收 合格 标准 规范 检验批 隐蔽 复试 样板', prototype: '质量验收 质量目标 检验批 隐蔽工程 材料复试' },
  { keywords: '清单 工程量 材料 设备 机械 劳动力 规格 型号 数量 单位', prototype: '人材机资源 劳动力配置 材料供应 设备机械 工程量清单' },
  { keywords: '工程名称 项目名称 建设地点 建筑面积 建设规模 招标范围 施工范围', prototype: '工程概况 项目概况 建设地点 建设规模 招标范围' },
  { keywords: '施工 组织 部署 区段 流水 作业面 工序 穿插 图纸 清单', prototype: '施工部署 流水施工 施工区段 工序穿插' },
];

/** 语义类别判定阈值：标题嵌入与类别原型嵌入的余弦 ≥ 此值即附加该类查询词（多挂查询词仅拓宽检索面，漏挂由退化小节兜底保护） */
const QUERY_EXPANSION_CATEGORY_THRESHOLD = 0.35;



/**
 * 标题 → 查询类别语义分类（bge 嵌入余弦判别，正则仅作降级兜底）：
 * 标题形态不可枚举（「确保人、材、机的保障体系与措施」「人机料保障体系」等），
 * 正则枚举必然滞后于新形态；语义模型按类别原型判别，新形态标题只要语义属于资源/工期/质量等类别即附加对应查询词。
 * 嵌入失败/模型不可用返回空 Map（调用方回退确定性正则）；标题嵌入复用全局 LRU 缓存。
 */
async function classifyQueryExpansionTitles(titles: string[], embedDocuments?: (texts: string[]) => Promise<number[][]>): Promise<Map<string, string[]>> {
  const classified = new Map<string, string[]>();
  if (titles.length === 0) return classified;
  const prototypes = QUERY_EXPANSION_CATEGORIES.map(category => category.prototype);
  let similarity: (leftText: string, rightText: string) => number;
  try {
    similarity = await buildSemanticSimilarity(titles, prototypes, embedDocuments);
  } catch {
    return classified;
  }
  for (const title of titles) {
    const matched: string[] = [];
    for (const category of QUERY_EXPANSION_CATEGORIES) {
      if (similarity(title, category.prototype) >= QUERY_EXPANSION_CATEGORY_THRESHOLD) matched.push(category.keywords);
    }
    if (matched.length > 0) classified.set(title, matched);
  }
  return classified;
}

/** 确定性查询扩展（降级兜底）：正则命中标题关键词时附加类别查询词。
 * 仅作语义分类失败/关闭时的兜底，不作为主判据（标题形态不可枚举，正则只能覆盖已知形态）。 */
function semanticQueryExpansions(title: string) {
  const queries: string[] = [];
  if (/重点|难点|危大|风险|安全|应急/u.test(title)) queries.push('安全 文明 危大 风险 应急 临边 洞口 消防 临电 高处 起重 吊装 基坑 脚手架 模板 支护 图纸 施工说明 审查意见');
  if (/工期|进度|节点|计划/u.test(title)) queries.push('工期 日历天 节点 进度 计划 开工 竣工 关键线路');
  if (/质量|验收|标准|实测|通病/u.test(title)) queries.push('质量 验收 合格 标准 规范 检验批 隐蔽 复试 样板');
  // 「人、材、机」顿号形态兼容：/人材机/ 匹配连续字符，标题常用顿号分隔，兜底不得漏
  if (/资源|材料|机械|设备|人材机|人[、,，]材[、,，]机/u.test(title)) queries.push('清单 工程量 材料 设备 机械 劳动力 规格 型号 数量 单位');
  if (/概况|说明|依据|范围/u.test(title)) queries.push('工程名称 项目名称 建设地点 建筑面积 建设规模 招标范围 施工范围');
  if (/部署|施工|流水|区段|组织/u.test(title)) queries.push('施工 组织 部署 区段 流水 作业面 工序 穿插 图纸 清单');
  return queries;
}

function sectionQueries(chapter: DocumentTemplateChapter, sectionTitle: string, chapterExpansions: string[], sectionExpansions: string[]) {
  // 语义分类与确定性正则取并集：语义负责新形态标题，正则负责模型不可用时的兜底
  const regexChapterExpansions = semanticQueryExpansions(chapter.title);
  const regexSectionExpansions = semanticQueryExpansions(sectionTitle);
  return [...new Set([
    chapter.title,
    sectionTitle,
    ...chapterExpansions,
    ...sectionExpansions,
    ...regexChapterExpansions.filter(query => !chapterExpansions.includes(query)),
    ...regexSectionExpansions.filter(query => !sectionExpansions.includes(query)),
    ...(chapter.queries || []),
    ...(chapter.requiredFacts || []),
  ].filter(Boolean))];
}

function sectionObjective(title: string) {
  if (/项目特点.*重点.*难点|重点.*难点.*分析/u.test(title)) return '系统识别本项目特点、施工重点、施工难点、形成原因、影响范围和应对措施，必须落位项目规模、结构形式、工期、专业范围、现场约束等具体事实，并为“项目主要施工内容”提供逐项对应依据。';
  if (/项目主要施工内容/u.test(title)) return '按专业工程和关键工序展开施工内容，必须逐项响应“项目特点、重点、难点分析”中的重点难点，说明施工范围、实施内容、控制措施、验收节点和资料闭环。';
  if (/工期|进度|节点|计划/u.test(title)) return '使用项目工期、节点和资源事实说明进度组织要求。';
  if (/质量|验收|标准|实测/u.test(title)) return '使用项目质量目标、验收标准和工序事实说明质量控制要求。';
  if (/安全|危大|风险|应急/u.test(title)) return '使用项目风险、危大工程和安全文明事实说明安全管控要求。';
  if (/资源|材料|机械|人材机/u.test(title)) return '使用清单、材料、设备和劳动力事实说明资源配置要求。';
  if (/概况|说明|依据/u.test(title)) return '使用项目基础事实说明编制边界和工程概况。';
  return '使用已确认项目事实形成正式施工组织内容。';
}

function sectionMinChars(title: string) {
  if (/项目特点.*重点.*难点|重点.*难点.*分析/u.test(title)) return 1800;
  if (/项目主要施工内容|主要分部分项工程施工方案|主要施工方法/u.test(title)) return 2200;
  if (/原材料进场复试|见证取样|危大工程专项施工方案审批流程/u.test(title)) return 800;
  if (/施工部署|施工流水|主要施工机械|劳动力|材料进场|资源动态|质量控制点|危大工程|安全隐患|临时用水|临时用电/u.test(title)) return 760;
  if (/概况|说明|依据/u.test(title)) return 260;
  return 420;
}

export async function planDocument(input: { template: DocumentTemplate; context: AgentWorkflowContext; title?: string; embedDocuments?: (texts: string[]) => Promise<number[][]> }): Promise<{ plan: AgentDocumentPlan; node: AgentWorkflowNode }> {
  const startedAt = Date.now();
  const chapterShapes = input.template.chapters.map(chapter => {
    // 大纲出口最终清洗（4.12.12）：补挂/校准注入的脏小节（条款碎片、截断残留、数字参数列）
    // 在此确定性剔除——粘连修复 + 碎片判别同口径，剔除后为空的章节退化回章节标题小节
    const sectionTitles = (chapter.sections?.length ? chapter.sections : [chapter.title])
      .map(title => cleanSectionTitleArtifacts(title))
      .filter(title => title.trim().length > 0 && !isInstructionLikeOutlineTitle(title) && !isFragmentLikeSectionTitle(title));
    return {
      chapter,
      sectionTitles: sectionTitles.length > 0 ? sectionTitles : [chapter.title],
      requiredFacts: [...new Set([...(chapter.requiredFacts || []), chapter.title])],
      evidenceQueries: [...new Set([chapter.title, ...(chapter.queries || []), ...(chapter.requiredFacts || [])])],
    };
  });
  // 语义查询类别分类：章节标题 + 小节标题一次性批量嵌入判别（复用全局 LRU 缓存），失败回退确定性正则
  const classificationTitles = [...new Set([...chapterShapes.map(item => item.chapter.title), ...chapterShapes.flatMap(item => item.sectionTitles)])];
  const semanticExpansions = await classifyQueryExpansionTitles(classificationTitles, input.embedDocuments);
  const chapters = chapterShapes.map(({ chapter, sectionTitles, requiredFacts, evidenceQueries }) => {
    const chapterExpansions = semanticExpansions.get(chapter.title) || [];
    return {
      chapterId: chapter.id,
      title: chapter.title,
      purpose: chapter.purpose || sectionObjective(chapter.title),
      requiredFacts,
      requiredGraphNodes: [chapter.title],
      evidenceQueries,
      qualityRules: ['项目专属事实必须来自锁定资料范围，不得混入其他项目名称', '法规规范名称与编号等公共知识不受锁定范围限制，但任何数值/规格/型号/参数必须来自锁定资料', '不得出现后台话术和兜底措辞', '章节必须覆盖规划小节'],
      forbiddenPhrases: FORMAL_FORBIDDEN_PHRASES,
      sections: sectionTitles.map(sectionTitle => ({
        title: sectionTitle,
        objective: sectionObjective(sectionTitle),
        requiredFacts: [...new Set([sectionTitle, ...(chapter.requiredFacts || [])])],
        requiredGraphNodes: [sectionTitle],
        evidenceQueries: sectionQueries(chapter, sectionTitle, chapterExpansions, semanticExpansions.get(sectionTitle) || []),
        forbiddenPhrases: FORMAL_FORBIDDEN_PHRASES,
        minChars: sectionMinChars(sectionTitle),
      })),
    };
  });
  const plan = {
    planId: `plan-${stableHash({ templateId: input.template.id, scope: input.context.materialScope.scopeHash, chapters: chapters.map(item => item.title) }).slice(0, 10)}`,
    title: input.title || input.template.name,
    chapters,
    requiredGlobalFacts: ['项目名称', '工期', '质量标准', '招标范围'],
    forbiddenPhrases: FORMAL_FORBIDDEN_PHRASES,
    qualityRules: ['资料范围先锁定', '基础图谱必跑', '章节任务先于正文', 'Reviewer 通过后才能导出'],
  };
  return {
    plan,
    node: { id: 'document-planner', type: 'document_planner', status: 'completed', startedAt, completedAt: Date.now(), outputSummary: `${chapters.length} 章、${chapters.reduce((sum, item) => sum + item.sections.length, 0)} 条细目任务`, metrics: { chapters: chapters.length } },
  };
}

export function planChapterTask(input: { plan: AgentDocumentPlan; chapter: DocumentTemplateChapter; context: AgentWorkflowContext; evidence: DocumentEvidence[] }): { task: AgentChapterTask; node: AgentWorkflowNode } {
  const startedAt = Date.now();
  const chapterPlan = input.plan.chapters.find(item => item.chapterId === input.chapter.id) || input.plan.chapters.find(item => item.title === input.chapter.title);
  if (!chapterPlan) throw new Error(`缺少章节计划：${input.chapter.title}`);
  const facts = input.context.facts.filter(fact => chapterPlan.evidenceQueries.some(query => factMatches(fact, query)) || chapterPlan.requiredFacts.some(query => factMatches(fact, query)));
  // 任务小节以 chapter.sections（融合规划产物，含大纲要求校准新增小节）为准，
  // 不得沿用 plan 内旧小节（历史遗漏：章节任务提示词强制输出旧小节名，与最终写入小节冲突）
  const sectionTitles = (input.chapter.sections?.length ? input.chapter.sections : chapterPlan.sections.map(section => section.title)).filter(title => Boolean(title) && title.trim().length > 0);
  const sections = sectionTitles.map(title => {
    const planSection = chapterPlan.sections.find(section => section.title === title);
    // 校准新增小节（plan 中无对应元数据）用章节级泛型元数据兜底，与 planDocument 同口径生成
    const base: AgentSectionPlan = planSection || {
      title,
      objective: sectionObjective(title),
      requiredFacts: [...new Set([title, ...(input.chapter.requiredFacts || [])])],
      requiredGraphNodes: [title],
      evidenceQueries: sectionQueries(input.chapter, title, [], []),
      forbiddenPhrases: FORMAL_FORBIDDEN_PHRASES,
      minChars: sectionMinChars(title),
    };
    // 退化小节兜底（真实生成回归）：模板无预设小节的章节，planDocument 用章节标题充当唯一小节；
    // 概括性标题（如「确保人、材、机的保障体系与措施」）token 化后几乎不可能与证据/图谱文本词面命中，
    // 但章节级证据/图谱上下文天然属于该小节（章=节），不得因词面未命中而判「缺少事实、图谱或证据支撑」。
    // 人材机三合一章结构补挂的三小节同理：人/材/机保障体系小节词面可能无法命中证据/图谱，
    // 但该章证据天然属于三个保障体系小节，不得因词面未命中而判未就绪（否则结构补挂反而阻断章节任务）
    const degradedSection = (sectionTitles.length === 1 && title === input.chapter.title)
      || (/人[、,，]材[、,，]机/u.test(input.chapter.title) && /^(?:确保\s*)?[人材机](?:员|力|料|械|工)?\s*的保障体系与措施$/u.test(title));
    const sectionFacts = input.context.facts.filter(fact => base.evidenceQueries.some(query => factMatches(fact, query)) || base.requiredFacts.some(query => factMatches(fact, query))).slice(0, 24);
    let sectionEvidence = input.evidence.filter(item => base.evidenceQueries.some(query => evidenceMatches(item, query))).slice(0, 24);
    let graphNodes = base.requiredGraphNodes.flatMap(query => graphNodeSummary(input.context.baseProjectGraph, query)).slice(0, 12);
    if (degradedSection) {
      if (sectionEvidence.length === 0) sectionEvidence = input.evidence.slice(0, 24);
      if (graphNodes.length === 0) graphNodes = graphNodeSummary(input.context.baseProjectGraph, input.chapter.title).slice(0, 12);
    }
    const issues: ValidationIssue[] = [];
    const isPublicKnowledgeSection = /法律法规|法规|规章|规范标准|标准规范|行业标准|现行规范|编制依据/u.test(title);
    if (!isPublicKnowledgeSection && sectionEvidence.length === 0 && sectionFacts.length === 0 && graphNodes.length === 0) issues.push({ level: 'error', severity: 'blocker', category: 'evidence_coverage', owner: 'system', message: `${title} 缺少事实、图谱或证据支撑`, suggestion: '应先定向检索和抽取事实，不能生成占位正文。' });
    return { ...base, title, factIds: sectionFacts.map(fact => stableHash({ key: fact.key, value: stringifyFactValue(fact.value), sourceFile: fact.sourceFile }).slice(0, 12)), evidenceIds: sectionEvidence.map(item => stableHash({ filePath: item.filePath, content: item.content.slice(0, 160), score: item.score }).slice(0, 12)), graphNodeIds: graphNodes.map(node => stableHash(node).slice(0, 12)), ready: issues.length === 0, issues };
  });
  const issues = sections.flatMap(section => section.issues);
  const task = {
    taskId: `chapter-task-${stableHash({ plan: input.plan.planId, chapter: input.chapter.id, evidence: input.evidence.map(item => stableHash({ filePath: item.filePath, content: item.content.slice(0, 120), score: item.score })) }).slice(0, 10)}`,
    chapterId: input.chapter.id,
    title: input.chapter.title,
    facts: facts.slice(0, 48),
    evidence: input.evidence.slice(0, 48),
    graphContext: graphNodeSummary(input.context.baseProjectGraph, input.chapter.title).slice(0, 20).join('\n'),
    sections,
    ready: issues.length === 0,
    issues,
  };
  return {
    task,
    node: { id: `chapter-task-${input.chapter.id}`, type: 'chapter_task_planner', status: task.ready ? 'completed' : 'failed', startedAt, completedAt: Date.now(), outputSummary: `${task.sections.filter(item => item.ready).length}/${task.sections.length} 条细目任务就绪`, metrics: { facts: task.facts.length, evidence: task.evidence.length, issues: issues.length }, issues },
  };
}

/**
 * 规划驱动模式的章节任务提示：章级 Planner 已把细目重排为「三级主题块 + 语义合并后的 H4 要点」，
 * 成稿必须遵循主题块结构，不得为每条输入细目单独开设标题（否则会重新碎片化）。
 */
export function chapterTaskPromptForPlannedStructure(task: AgentChapterTask, structure: PlannedChapterStructure) {
  const factLines = task.facts.slice(0, 18).map(fact => `- ${fact.key}：${factValue(fact)}${fact.sourceFile ? `（来源：${fact.sourceFile}）` : ''}`).join('\n');
  const blockLines = structure.blocks.map((block, blockIndex) => {
    const pointLines = block.subPoints.map(point => (point.sources.length > 1
      ? `  - #### ${point.title}（覆盖评分细目：${point.sources.join('、')}）`
      : `  - #### ${point.title}`)).join('\n');
    return `${blockIndex + 1}. 必须输出三级标题：### ${block.title}\n${pointLines}`;
  }).join('\n');
  return [
    '【Agent 章节任务】（主题块成稿模式）',
    `任务ID：${task.taskId}`,
    `章节：${task.title}`,
    task.graphContext ? `图谱上下文：\n${task.graphContext}` : '',
    factLines ? `事实卡：\n${factLines}` : '',
    `主题块与 H4 要点（必须严格按此两层结构成稿）：\n${blockLines}`,
    '写作要求：必须严格按“主题块→H4 要点”两层结构输出，三级标题与 H4 要点标题必须与给定标题完全一致，不得改名、合并或遗漏 H4 要点；每个 H4 要点必须覆盖其标注的全部评分细目内容，但不得为这些评分细目单独开设小节标题；项目专属事实只使用事实卡、图谱上下文和绑定证据；法律法规、标准规范名称与编号等公共知识可直接引用，但任何数值/规格/型号/参数必须来自事实卡、图谱上下文或绑定证据，禁止以行业惯例或公共知识为由虚构；不得输出后台话术、兜底措辞、待确认、不适用；缺少项目事实的小节不得编造。',
  ].filter(Boolean).join('\n\n');
}
