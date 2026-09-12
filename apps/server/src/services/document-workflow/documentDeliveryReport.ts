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
  const facts = [
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
  ];
  // V5 P6 run1 实测：正文引用事实的常见形态不带字段名前缀（写「45日历天」而非「计划工期 45日历天」），
  // 每条事实同时产出「字段名+值」整行与纯值行两个候选片段，避免整段匹配对无前缀引用全失配
  return facts.flatMap(fact => {
    const line = normalizedFactValue(fact);
    const valueLine = normalizeEngineeringTextForFactMatch(stringifyFactValue(fact.value));
    return valueLine && valueLine !== line ? [line, valueLine] : [line];
  }).join('\n');
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
  // V5 P6 run1 实测：事实模型完全为空（生成端无任何事实可用）时保留「未使用X事实」降级告警；
  // 单个维度桶为空（如安全/资源桶无该类事实）时该维度不可评估——正文无从引用不存在的事实，跳过不报
  const modelEmpty = [factsModel.project, factsModel.schedule, factsModel.quality, factsModel.safety, factsModel.resources, factsModel.preciseFacts, factsModel.bills, factsModel.drawings, factsModel.rules, factsModel.specifications].every(list => list.length === 0);
  const issues: ValidationIssue[] = [];
  for (const section of sections) {
    if (!section.required.test(markdown)) continue;
    const facts = [...new Set(section.corpus.split('\n').map(line => line.replace(/\s+/gu, '')).filter(Boolean))];
    if (facts.length === 0 && !modelEmpty) continue;
    const matched = facts.filter(fact => {
      if (fact.length < 6) return false;
      if (markdownCompact.includes(fact.slice(0, 24))) return true;
      // V5 P6 分片兜底（run1 实测：corpus 整行为「字段名+值」，正文引用无字段名前缀时工程量维度
      // 89 条清单事实全失配）：长行前 12 字或数值+单位分片命中即视为已使用
      if (fact.length > 24 && markdownCompact.includes(fact.slice(0, 12))) return true;
      const numericParts = fact.match(/\d+(?:\.\d+)?(?:m2|hm2|m3|l|ml|mm|cm|km|m|kg|g|t|万元|亿元|元|天|工作天|月|年|h|min|%|permille|mpa|kpa|pa|kn|kw|mw|w|kv|v|ma|a|hz|℃|台|套|件|个|根|只|组|项|处|座|栋|层|间|批|次|人|工日|人日|亩)/gu) || [];
      return numericParts.some(part => part.length >= 3 && markdownCompact.includes(part));
    });
    if (matched.length === 0) issues.push({ level: 'warning', message: `证据使用覆盖率偏低：正文中未明显使用${section.label}相关事实`, suggestion: `请在相应章节中引用至少一项${section.label}事实，避免只写通用表述。` });
  }
  return issues;
}

export async function paragraphGenericIssues(markdown: string, classifier: ProfessionalDepthClassifier): Promise<ValidationIssue[]> {
  const paragraphs = markdown.split(/\n\s*\n/gu).map(item => item.trim()).filter(Boolean);
  const genericPattern = /(?:加强组织领导|严格执行规范|落实责任制度|确保工程质量|强化过程管理|提高思想认识|完善管理体系|形成闭环管理|统筹推进|全面落实)/gu;
  const issues: ValidationIssue[] = [];
  for (const paragraph of paragraphs) {
    if (documentTextLength(paragraph) < 120) continue;
    const genericMatches = paragraph.match(genericPattern) || [];
    if (genericMatches.length < 2) continue;
    // 语义路径（round-14）：是否绑定具体对象/控制点/闭环由 bge 嵌入判定（本地语义模型恒可用）
    const analysis = await classifier.analyze(paragraph);
    // 空文本返回 undefined（输入边界：无内容可分析，判定不了就不判），不得用全 false 替身报空泛
    if (!analysis) continue;
    if (!analysis.concrete) {
      issues.push({ level: 'warning', message: `段落存在空泛表述：${paragraph.slice(0, 48)}...`, suggestion: '请补充该段对应的对象、动作、控制点或验收闭环，避免只保留管理性套话。' });
    }
  }
  return issues;
}

export function chapterDependencyIssues(chapters: Array<Pick<DocumentDraftChapter, 'title' | 'content'>>, analyses?: Map<string, ProfessionalDepthAnalysis>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  // 调用方未提供语义分析时跳过（生成中间阶段无章节内容可分析；最终校验恒提供）：
  // 章节依赖支撑关系必须由 bge 嵌入判定
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
