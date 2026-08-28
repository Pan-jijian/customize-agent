import { documentTextLength } from './budget';
import type { DocumentDraftChapter, DocumentFact, DocumentFactsModel, ValidationIssue } from './types';
import { normalizeEngineeringTextForFactMatch } from './engineeringUnits';
import { stringifyFactValue } from './utils';
import { generatedFactVerificationIssues, professionalScoreIssues } from './qualityValidation';
import type { ProfessionalDepthAnalysis, ProfessionalDepthClassifier } from './professionalDepthClassifier';

function normalizedFactValue(fact: DocumentFact) {
  return normalizeEngineeringTextForFactMatch(`${fact.fieldName || fact.key} ${stringifyFactValue(fact.value)}`);
}

function trustedFactCorpus(factsModel: DocumentFactsModel) {
  return [
    ...factsModel.project,
    ...factsModel.schedule,
    ...factsModel.quality,
    ...factsModel.safety,
    ...factsModel.resources,
    ...factsModel.preciseFacts,
    ...factsModel.bills,
    ...factsModel.drawings,
    ...factsModel.rules,
    ...factsModel.specifications,
  ].map(normalizedFactValue).join('\n');
}

export function evidenceUsageCoverageIssues(markdown: string, factsModel: DocumentFactsModel): ValidationIssue[] {
  const sections: Array<{ label: string; corpus: string; required: RegExp }> = [
    { label: '工期', corpus: trustedFactCorpus({ ...factsModel, project: [], quality: [], safety: [], resources: [], preciseFacts: [], bills: [], drawings: [], rules: [], specifications: [] }), required: /工期|日历天|合同工期|计划工期/u },
    { label: '质量', corpus: trustedFactCorpus({ ...factsModel, project: [], schedule: [], safety: [], resources: [], preciseFacts: [], bills: [], drawings: [], rules: [], specifications: [] }), required: /质量目标|质量标准|验收|复验/u },
    { label: '安全', corpus: trustedFactCorpus({ ...factsModel, project: [], schedule: [], quality: [], resources: [], preciseFacts: [], bills: [], drawings: [], rules: [], specifications: [] }), required: /安全|文明|风险|应急/u },
    { label: '资源', corpus: trustedFactCorpus({ ...factsModel, project: [], schedule: [], quality: [], safety: [], preciseFacts: [], bills: [], drawings: [], rules: [], specifications: [] }), required: /资源|材料|设备|劳动力/u },
    { label: '工程量', corpus: trustedFactCorpus({ ...factsModel, project: [], schedule: [], quality: [], safety: [], resources: [], preciseFacts: [], drawings: [], rules: [], specifications: [] }), required: /工程量|清单|建筑面积|长度|吨|台|套|项/u },
  ];
  // corpus 行经 normalizeEngineeringTextForFactMatch 归一（日历天→天、平方米→m2），正文侧必须同口径归一，
  // 否则“45日历天”与“45天”这类同义写法会误判为未使用事实
  const markdownCompact = normalizeEngineeringTextForFactMatch(markdown.replace(/\s+/gu, ''));
  const issues: ValidationIssue[] = [];
  for (const section of sections) {
    if (!section.required.test(markdown)) continue;
    const facts = [...new Set(section.corpus.split('\n').map(line => line.replace(/\s+/gu, '').slice(0, 24)).filter(Boolean))];
    const matched = facts.filter(fact => fact.length >= 6 && markdownCompact.includes(fact));
    if (matched.length === 0) issues.push({ level: 'warning', message: `证据使用覆盖率偏低：正文中未明显使用${section.label}相关事实`, suggestion: `请在相应章节中引用至少一项${section.label}事实，避免只写通用表述。` });
  }
  return issues;
}

export async function paragraphGenericIssues(markdown: string, classifier?: ProfessionalDepthClassifier): Promise<ValidationIssue[]> {
  const paragraphs = markdown.split(/\n\s*\n/gu).map(item => item.trim()).filter(Boolean);
  const genericPattern = /(?:加强组织领导|严格执行规范|落实责任制度|确保工程质量|强化过程管理|提高思想认识|完善管理体系|形成闭环管理|统筹推进|全面落实)/gu;
  const issues: ValidationIssue[] = [];
  for (const paragraph of paragraphs) {
    if (documentTextLength(paragraph) < 120) continue;
    const genericMatches = paragraph.match(genericPattern) || [];
    if (genericMatches.length < 2) continue;
    // 语义路径（round-14）：是否绑定具体对象/控制点/闭环由 bge 嵌入判定；语义模型不可用时静默跳过（零误伤）
    if (!classifier) continue;
    const analysis = await classifier.analyze(paragraph);
    // 嵌入失败/空段落返回 undefined：判定不了就不判（零误伤），不得用全 false 替身报空泛
    if (!analysis) continue;
    if (!analysis.concrete) {
      issues.push({ level: 'warning', message: `段落存在空泛表述：${paragraph.slice(0, 48)}...`, suggestion: '请补充该段对应的对象、动作、控制点或验收闭环，避免只保留管理性套话。' });
    }
  }
  return issues;
}

export function chapterDependencyIssues(chapters: Array<Pick<DocumentDraftChapter, 'title' | 'content'>>, analyses?: Map<string, ProfessionalDepthAnalysis>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  // 语义模型不可用时静默跳过（零误伤）：章节依赖支撑关系必须由 bge 嵌入判定
  if (!analyses) return issues;
  const chapterText = chapters.map(chapter => `${chapter.title}\n${chapter.content}`).join('\n\n');
  // 进度↔资源支撑：语义路径由 bge 嵌入判定资源章节是否覆盖投入调配计划
  if (/进度|工期/u.test(chapterText) && /资源|材料|设备|劳动力/u.test(chapterText)) {
    const resourceChapter = chapters.find(chapter => /资源|材料|设备|劳动力/u.test(chapter.title));
    const analysis = resourceChapter ? analyses.get(resourceChapter.title) : undefined;
    if (!analysis?.contentNeeds.resource) {
      issues.push({ level: 'warning', message: '章节逻辑依赖不足：进度章节与资源章节之间缺少明显支撑关系', suggestion: '请在资源章节补充与工期目标相匹配的劳动力、材料、设备投入和调配计划。' });
    }
  }
  // 质量↔工艺支撑：语义路径由 bge 嵌入判定质量/施工章节是否覆盖工艺控制与验收衔接
  if (/质量/u.test(chapterText) && /施工|工艺|技术/u.test(chapterText)) {
    const supported = chapters.some(chapter => analyses.get(chapter.title)?.contentNeeds.quality || analyses.get(chapter.title)?.contentNeeds.construction);
    if (!supported) {
      issues.push({ level: 'warning', message: '章节逻辑依赖不足：质量章节未明显支撑施工工艺控制', suggestion: '请在施工技术和质量章节之间补齐工艺控制点、验收要求和整改复验闭环。' });
    }
  }
  // 安全↔应急支撑：语义路径由 bge 嵌入判定安全章节是否覆盖检查整改与应急闭环
  if (/安全|文明|风险/u.test(chapterText)) {
    const supported = chapters.some(chapter => analyses.get(chapter.title)?.contentNeeds.safety);
    if (!supported) {
      issues.push({ level: 'warning', message: '章节逻辑依赖不足：安全章节缺少检查整改和应急支撑', suggestion: '请补齐风险识别、检查整改、应急响应和演练闭环。' });
    }
  }
  return issues;
}

export function documentDeliveryScoreIssues(markdown: string, chapters: Array<Pick<DocumentDraftChapter, 'title' | 'content'>>, factsModel: DocumentFactsModel, analyses?: Map<string, ProfessionalDepthAnalysis>): ValidationIssue[] {
  const scoreParts = {
    factuality: generatedFactVerificationIssues(markdown, factsModel).some(issue => issue.level === 'error') ? 0 : 2,
    structure: chapters.length > 0 && chapters.every(chapter => markdown.includes(chapter.title) && documentTextLength(chapter.content) >= 600) ? 2 : 1,
    depth: professionalScoreIssues(chapters, analyses).length === 0 ? 2 : 1,
    executable: chapterDependencyIssues(chapters, analyses).length === 0 ? 2 : 1,
    evidence: evidenceUsageCoverageIssues(markdown, factsModel).length === 0 ? 2 : 1,
  };
  const total = scoreParts.factuality + scoreParts.structure + scoreParts.depth + scoreParts.executable + scoreParts.evidence;
  return [{
    // 交付评分汇总报告是元信息而非正文缺陷，按 info 计入，避免污染缺陷计分
    level: 'info',
    message: `文档交付评分报告：总分 ${total}/10，事实${scoreParts.factuality}，结构${scoreParts.structure}，专业${scoreParts.depth}，可执行${scoreParts.executable}，证据${scoreParts.evidence}`,
    suggestion: total >= 8 ? '可交付，但建议继续优化证据使用覆盖率和章节依赖链路。' : '建议优先修复低分维度后再导出。',
  }];
}
