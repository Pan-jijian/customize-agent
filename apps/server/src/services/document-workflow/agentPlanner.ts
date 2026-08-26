import type { AgentWorkflowContext, AgentWorkflowNode } from './agentWorkflow';
import type { DocumentDraftChapter, DocumentEvidence, DocumentFact, DocumentTemplate, DocumentTemplateChapter, ProjectGraph, ValidationIssue } from './types';
import type { PlannedChapterStructure } from './chapterPlanner';
import { extractSection, stableHash, stringifyFactValue } from './utils';
import { documentTextLength } from './budget';
import { DEVICE_SPEC_RE, PROCESS_PARAMETER_RE, QUANTIFIED_BODY_PARAM_RE } from './parameterPatterns';

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

export interface AgentReviewResult {
  issues: ValidationIssue[];
  supportedFacts: number;
  unsupportedSignals: string[];
  repairable: boolean;
}

const FORMAL_FORBIDDEN_PHRASES = [
  '知识库', '系统暂未', '项目资料暂未', '资料未明确', '暂未明确', '待确认', '待资料复核', '待系统', '未检索到', '资料不足', '无法确认', '建议补充', '不适用', 'COL', '可核验信息',
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

function semanticQueryExpansions(title: string) {
  const queries: string[] = [];
  if (/重点|难点|危大|风险|安全|应急/u.test(title)) queries.push('安全 文明 危大 风险 应急 临边 洞口 消防 临电 高处 起重 吊装 基坑 脚手架 模板 支护 图纸 施工说明 审查意见');
  if (/工期|进度|节点|计划/u.test(title)) queries.push('工期 日历天 节点 进度 计划 开工 竣工 关键线路');
  if (/质量|验收|标准|实测|通病/u.test(title)) queries.push('质量 验收 合格 标准 规范 检验批 隐蔽 复试 样板');
  if (/资源|材料|机械|人材机|设备/u.test(title)) queries.push('清单 工程量 材料 设备 机械 劳动力 规格 型号 数量 单位');
  if (/概况|说明|依据|范围/u.test(title)) queries.push('工程名称 项目名称 建设地点 建筑面积 建设规模 招标范围 施工范围');
  if (/部署|施工|流水|区段|组织/u.test(title)) queries.push('施工 组织 部署 区段 流水 作业面 工序 穿插 图纸 清单');
  return queries;
}

function sectionQueries(chapter: DocumentTemplateChapter, sectionTitle: string) {
  return [...new Set([
    chapter.title,
    sectionTitle,
    ...semanticQueryExpansions(chapter.title),
    ...semanticQueryExpansions(sectionTitle),
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

export function planDocument(input: { template: DocumentTemplate; context: AgentWorkflowContext; title?: string }): { plan: AgentDocumentPlan; node: AgentWorkflowNode } {
  const startedAt = Date.now();
  const chapters = input.template.chapters.map(chapter => {
    const sectionTitles = chapter.sections?.length ? chapter.sections : [chapter.title];
    return {
      chapterId: chapter.id,
      title: chapter.title,
      purpose: chapter.purpose || sectionObjective(chapter.title),
      requiredFacts: [...new Set([...(chapter.requiredFacts || []), chapter.title])],
      requiredGraphNodes: [chapter.title],
      evidenceQueries: [...new Set([chapter.title, ...(chapter.queries || []), ...(chapter.requiredFacts || [])])],
      qualityRules: ['项目专属事实必须来自锁定资料范围，不得混入其他项目名称', '法规规范等公共知识不受锁定范围限制', '不得出现后台话术和兜底措辞', '章节必须覆盖规划小节'],
      forbiddenPhrases: FORMAL_FORBIDDEN_PHRASES,
      sections: sectionTitles.map(sectionTitle => ({
        title: sectionTitle,
        objective: sectionObjective(sectionTitle),
        requiredFacts: [...new Set([sectionTitle, ...(chapter.requiredFacts || [])])],
        requiredGraphNodes: [sectionTitle],
        evidenceQueries: sectionQueries(chapter, sectionTitle),
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
  const sections = chapterPlan.sections.map(section => {
    const sectionFacts = input.context.facts.filter(fact => section.evidenceQueries.some(query => factMatches(fact, query)) || section.requiredFacts.some(query => factMatches(fact, query))).slice(0, 24);
    const sectionEvidence = input.evidence.filter(item => section.evidenceQueries.some(query => evidenceMatches(item, query))).slice(0, 24);
    const graphNodes = section.requiredGraphNodes.flatMap(query => graphNodeSummary(input.context.baseProjectGraph, query)).slice(0, 12);
    const issues: ValidationIssue[] = [];
    const isPublicKnowledgeSection = /法律法规|法规|规章|规范标准|标准规范|行业标准|现行规范|编制依据/u.test(section.title);
    if (!isPublicKnowledgeSection && sectionEvidence.length === 0 && sectionFacts.length === 0 && graphNodes.length === 0) issues.push({ level: 'error', severity: 'blocker', category: 'evidence_coverage', owner: 'system', message: `${section.title} 缺少事实、图谱或证据支撑`, suggestion: '应先定向检索和抽取事实，不能生成占位正文。' });
    return { ...section, factIds: sectionFacts.map(fact => stableHash({ key: fact.key, value: stringifyFactValue(fact.value), sourceFile: fact.sourceFile }).slice(0, 12)), evidenceIds: sectionEvidence.map(item => stableHash({ filePath: item.filePath, content: item.content.slice(0, 160), score: item.score }).slice(0, 12)), graphNodeIds: graphNodes.map(node => stableHash(node).slice(0, 12)), ready: issues.length === 0, issues };
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

export function chapterTaskPrompt(task: AgentChapterTask) {
  const factLines = task.facts.slice(0, 18).map(fact => `- ${fact.key}：${factValue(fact)}${fact.sourceFile ? `（来源：${fact.sourceFile}）` : ''}`).join('\n');
  const sectionLines = task.sections.map((section, index) => `${index + 1}. 必须输出三级标题：### ${section.title}\n   写作目标：${section.objective}\n   支撑情况：证据 ${section.evidenceIds.length}，事实 ${section.factIds.length}，图谱 ${section.graphNodeIds.length}\n   最小正文深度：${section.minChars} 字`).join('\n');
  return [
    '【Agent 章节任务】',
    `任务ID：${task.taskId}`,
    `章节：${task.title}`,
    task.graphContext ? `图谱上下文：\n${task.graphContext}` : '',
    factLines ? `事实卡：\n${factLines}` : '',
    `小节任务：\n${sectionLines}`,
    '写作要求：必须严格按“小节任务”逐项输出，每个任务都必须保留完全一致的三级标题“### 小节标题”；不得合并小节、不得改写小节标题、不得省略小节；项目专属事实只使用事实卡、图谱上下文和绑定证据，法律法规、标准规范等公共知识可直接引用；不得输出后台话术、兜底措辞、待确认、不适用；缺少项目事实的小节不得编造。',
  ].filter(Boolean).join('\n\n');
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
    '写作要求：必须严格按“主题块→H4 要点”两层结构输出，三级标题与 H4 要点标题必须与给定标题完全一致，不得改名、合并或遗漏 H4 要点；每个 H4 要点必须覆盖其标注的全部评分细目内容，但不得为这些评分细目单独开设小节标题；项目专属事实只使用事实卡、图谱上下文和绑定证据，法律法规、标准规范等公共知识可直接引用；不得输出后台话术、兜底措辞、待确认、不适用；缺少项目事实的小节不得编造。',
  ].filter(Boolean).join('\n\n');
}

function actionableReviewFact(fact: DocumentFact) {
  const value = factValue(fact);
  if (!value || value.length < 3) return false;
  if (/^(?:见|详见|按|执行|参见|依据).{0,16}(?:前附表|招标公告|招标文件|合同|协议书|通用条款|专用条款|图纸|清单|附件|资料)$/u.test(value)) return false;
  if (/^(?:合同协议书|通用条款|专用条款|招标文件|招标公告|投标人须知前附表|附件|资料)$/u.test(value.replace(/[（）()\d一二三四五六七八九十、.．\s]/gu, ''))) return false;
  return /项目|工程|编号|地点|规模|范围|工期|质量|安全|资源|材料|设备|验收|\d/u.test(factText(fact));
}


export function reviewChapterDraft(input: { task: AgentChapterTask; draft: DocumentDraftChapter; context: AgentWorkflowContext; plannedCoverage?: Record<string, string[]> }): AgentReviewResult {
  const issues: ValidationIssue[] = [];
  const content = input.draft.content || '';
  for (const phrase of FORMAL_FORBIDDEN_PHRASES) {
    if (content.includes(phrase)) issues.push({ level: 'error', severity: 'blocker', category: 'style', owner: 'system', message: `${input.draft.title} 正文包含禁止话术：${phrase}`, suggestion: '改为事实支撑的正式表达；缺失事实不得占位。' });
  }
  // P0-2：LLM 全故障时的证据骨架草稿必须被 Review 门禁拦截，不允许以模板拼接正文静默通过
  if (content.includes('[EVIDENCE_SKELETON]')) issues.push({ level: 'error', severity: 'blocker', category: 'evidence_coverage', owner: 'system', message: `${input.draft.title} 正文为 LLM 全故障后的证据骨架草稿，禁止作为正式正文通过`, suggestion: '必须由 Repairer 基于小节事实卡与证据完整重写为正式正文，并删除 [EVIDENCE_SKELETON] 标记；若 LLM 仍不可用，本章节保持 failed 阻断。' });
  const chapterLength = documentTextLength(content);
  // 规划驱动模式：细目按覆盖映射表定位承接的 H4 小节（标题可能已被语义重写），
  // 不再要求正文出现与细目同名的标题，避免把真合并误判为缺节并触发重新拆节
  const plannedCoverage = input.plannedCoverage;
  const sectionAnchor = (sectionTitle: string) => {
    const anchors = plannedCoverage?.[sectionTitle];
    return anchors && anchors.length > 0 ? anchors[0] : sectionTitle;
  };
  // 承接小节被多条细目共享才算语义合并（1:1 但标题重写不算），合并后单细目深度阈值按组内共享放宽
  const anchorSectionCount = new Map<string, number>();
  for (const anchors of Object.values(plannedCoverage || {})) {
    if (anchors.length > 0) anchorSectionCount.set(anchors[0], (anchorSectionCount.get(anchors[0]) || 0) + 1);
  }
  const mergedSection = (sectionTitle: string) => {
    const anchors = plannedCoverage?.[sectionTitle];
    if (!anchors || anchors.length === 0) return false;
    return (anchorSectionCount.get(anchors[0]) || 1) > 1;
  };
  // 同一承接小节被多条细目共享时，深度检查只做一次（按组内最大最小深度要求）
  const anchorDepthCheck = new Map<string, number>();
  const anchorDepthChecked = new Set<string>();
  for (const section of input.task.sections) {
    const anchor = sectionAnchor(section.title);
    const merged = mergedSection(section.title);
    const previous = anchorDepthCheck.get(anchor);
    anchorDepthCheck.set(anchor, previous === undefined ? section.minChars : Math.max(previous, section.minChars));
  }
  for (const section of input.task.sections) {
    const anchor = sectionAnchor(section.title);
    const merged = mergedSection(section.title);
    const body = extractSection(content, anchor, { fuzzy: true });
    if (body.includes('[WRITER_MISSING_SECTION]') || (!body && content.includes('[WRITER_MISSING_SECTION]'))) {
      // 同一承接小节被多条细目共享时只报一次（merged 组内重复修复指令会浪费 Repairer 轮次）
      if (!anchorDepthChecked.has(anchor)) {
        anchorDepthChecked.add(anchor);
        issues.push({ level: 'error', severity: 'blocker', category: 'structure', owner: 'system', message: merged ? `${anchor} Writer 未完成（承接 ${section.title}）` : `${section.title} Writer 未完成`, suggestion: 'Repairer 必须基于该小节事实卡和证据生成正式正文，并删除 WRITER_MISSING_SECTION 标记。' });
      }
    }
    else if (body && !anchorDepthChecked.has(anchor)) {
      anchorDepthChecked.add(anchor);
      const anchorMinChars = anchorDepthCheck.get(anchor) || section.minChars;
      const criticalDepth = /项目特点.*重点.*难点|重点.*难点.*分析|项目主要施工内容|主要分部分项工程施工方案|主要施工方法|危大工程专项施工方案审批流程|原材料进场复试|见证取样/u.test(section.title);
      // 语义合并后共享同一承接小节：单细目深度阈值放宽至 50%（整块字数由块级写手质检兜底）；
      // 但关键小节不放宽——Final Gate 的 criticalSectionDepthIssues 按原始 minChars 精确提取，
      // 若 Reviewer 用放宽口径放过，章节修复轮次结束后仍会被最终门禁以 minChars×0.8 阻断，修复机会浪费
      const threshold = merged && !criticalDepth ? Math.max(200, Math.floor(anchorMinChars * 0.5)) : anchorMinChars;
      // 容忍线与 Final Gate blocker 口径一致（minChars × 0.8）：低于该线必须触发深度修复，
      // 否则 0.7~0.8 之间的深度缺口会被 Reviewer 放过、被 Final Gate 阻断，修复机会浪费在最终门禁上
      const nearEnough = documentTextLength(body) >= Math.floor(threshold * 0.8);
      issues.push({ level: criticalDepth && !nearEnough ? 'error' : 'warning', severity: criticalDepth && !nearEnough ? 'blocker' : 'warning', category: 'structure', owner: 'system', message: merged ? `${anchor} 正文不足，未达到任务最小深度（承接 ${section.title}）` : `${section.title} 正文不足，未达到任务最小深度`, suggestion: criticalDepth ? '关键小节必须基于项目事实和对应关系重写补足；不得仅保留概述性文字。' : '应基于该小节事实卡和证据重新生成，不得使用标题占位。' });
    } else if (!body && !anchorDepthChecked.has(anchor)) {
      anchorDepthChecked.add(anchor);
      const criticalDepth = /项目特点.*重点.*难点|重点.*难点.*分析|项目主要施工内容|主要分部分项工程施工方案|主要施工方法|危大工程专项施工方案审批流程|原材料进场复试|见证取样/u.test(section.title);
      // 规划小节完全无正文时必须报告：之前章节正文足够长时空小节会被静默跳过，导致导出后出现只有标题的空小节；
      // 不依赖 sectionHasSemanticCoverage 兜底，因为相邻小节标题（如“主要分部分项工程施工流程”）会命中关键词造成误判。
      issues.push({ level: criticalDepth ? 'error' : 'warning', severity: criticalDepth ? 'blocker' : 'warning', category: 'structure', owner: 'system', message: criticalDepth ? `${section.title} 正文不足，未达到任务最小深度` : `${merged ? `承接小节 ${anchor} 缺失` : section.title} 未匹配到独立小节标题`, suggestion: criticalDepth ? '关键小节缺失正文，必须基于该小节事实卡和证据生成正式正文，不得以标题占位。' : '正文已成文但小节标题与规划标题不完全一致，建议后续按规划标题进一步规范结构。' });
    }
    if (!section.ready) issues.push(...section.issues.map(issue => ({ ...issue, level: 'warning' as const, severity: 'warning' as const })));
    // 施工方法类小节参数落位综合检查：工艺参数（mm/MPa/间距/偏差等）不足、或量化参数密度低于每千字 2 个时触发 Repairer 定向补写（设备型号规格参数同样计入）
    if (/主要分部分项工程施工方案|主要施工方法/u.test(section.title)) {
      const methodBody = extractSection(content, anchor, { fuzzy: true });
      const bodyChars = documentTextLength(methodBody);
      const paramCount = new Set([...(methodBody.match(PROCESS_PARAMETER_RE) || []), ...(methodBody.match(DEVICE_SPEC_RE) || [])]).size;
      const quantifiedCount = new Set(methodBody.match(QUANTIFIED_BODY_PARAM_RE) || []).size;
      const quantifiedDensity = bodyChars > 0 ? quantifiedCount / (bodyChars / 1000) : 0;
      if (documentTextLength(methodBody) >= 800 && (paramCount < 4 || quantifiedDensity < 2)) issues.push({ level: 'warning', severity: 'warning', category: 'professional_chain', owner: 'system', message: `${section.title} 参数落位不足：工艺参数 ${paramCount} 个（要求不少于 4 个），量化参数密度每千字 ${quantifiedDensity.toFixed(1)} 个（要求不少于 2 个）`, suggestion: '必须补充 mm/MPa/间距/偏差/坡度/试验压力等工艺参数（来自绑定资料或行业规范值）或设备型号规格参数，并提升量化参数（数量/规格/工期/面积等）落位密度；同一参数不得反复堆砌凑数。' });
    }
    // 工序链箭头密度：方法类/流程类小节必须用“→”串联工序链，避免纯文字流程叙述拉低整体箭头密度
    if (/主要分部分项工程施工方案|主要施工方法|项目主要施工内容|施工流程|施工顺序|多工序穿插|三检制度|隐蔽工程验收|闭环整改|应急演练|转运路线/u.test(section.title)) {
      const methodBody = extractSection(content, anchor, { fuzzy: true });
      const arrowCount = (methodBody.match(/→/gu) || []).length;
      if (documentTextLength(methodBody) >= 500 && arrowCount < 3) issues.push({ level: 'warning', severity: 'warning', category: 'professional_chain', owner: 'system', message: `${section.title} 工序链箭头缺失：当前 ${arrowCount} 个“→”，工序序列未按箭头链表达`, suggestion: '工艺流程与方法叙述中的连续工序必须用“→”串联（如“基层清理→放线定位→分层摊铺→碾压→压实度检测→验收”），每条链不少于 3 个环节，方法叙述中同样需要箭头链。' });
    }
  }
  const scopeRoots = input.context.materialScope.selectedRoots;
  for (const root of input.context.materialScope.rejectedRoots) {
    if (root && !scopeRoots.includes(root) && content.includes(root)) issues.push({ level: 'error', severity: 'blocker', category: 'evidence_coverage', owner: 'system', message: `${input.draft.title} 混入非当前资料组名称：${root}`, suggestion: '必须删除跨项目内容并重新检索当前资料组证据。' });
  }
  const actionableFacts = input.task.facts.filter(actionableReviewFact);
  const supportedFacts = actionableFacts.filter(fact => {
    const value = factValue(fact);
    return value.length >= 2 && content.includes(value.slice(0, Math.min(18, value.length)));
  }).length;
  if (actionableFacts.length >= 3 && supportedFacts === 0 && documentTextLength(content) < 1200) issues.push({ level: 'warning', severity: 'warning', category: 'evidence_coverage', owner: 'system', message: `${input.draft.title} 未明显落位章节事实卡`, suggestion: '建议将章节事实卡中的关键工程事实写入对应小节，但不因引用型或低可执行事实阻断。' });
  const blockingIssues = issues.filter(issue => issue.level === 'error' || issue.severity === 'blocker');
  const depthIssues = issues.filter(issue => /正文不足|未落位章节事实卡/u.test(issue.message));
  // 只要存在可定向修复的阻断问题（Writer 未完成/正文不足），就必须触发 Repairer：
  // 否则一个非深度类 blocker（如禁止话术）会让整个章节的 Repairer 停摆，连累可修复的正文不足小节。
  const hasFixableBlocking = blockingIssues.some(issue => /Writer 未完成|正文不足，未达到任务最小深度/u.test(issue.message));
  return { issues, supportedFacts, unsupportedSignals: issues.map(issue => issue.message), repairable: issues.length > 0 && (issues.length <= 6 || depthIssues.length === issues.length || blockingIssues.length === 0 || hasFixableBlocking) };
}

export function buildTargetedRepairInstruction(input: { task: AgentChapterTask; review: AgentReviewResult; plannedMode?: boolean }) {
  if (!input.review.repairable) return '';
  // 规划驱动模式：只修复列出的问题并保持主题块+H4 两层结构，不附「逐条 ### 输出细目」指令，防止修复时重新拆节
  const plannedConstraint = input.plannedMode
    ? '【结构约束】本章采用主题块成稿模式，必须保持现有三级主题块与 H4 要点标题不变；只修复列出的问题，不得新增小节、不得拆分或合并现有小节、不得把评分细目展开为独立标题。'
    : chapterTaskPrompt(input.task);
  return [
    '【Agent 定向修复任务】',
    `章节：${input.task.title}`,
    '只修复下列问题，不重写无关内容；如果问题是小节正文不足，必须按原小节标题完整补足该小节正式正文，每个小节不得少于任务最小深度：',
    ...input.review.issues.map(issue => `- ${issue.message}；${issue.suggestion || ''}`),
    plannedConstraint,
  ].join('\n');
}
