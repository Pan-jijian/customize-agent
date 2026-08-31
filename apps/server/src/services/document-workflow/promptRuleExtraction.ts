import type { DocumentEvidence, DocumentGenerationDiagnostics, DocumentTemplate, DocumentTemplateChapter, PromptChapterStructuralRule, PromptDocumentRuleSet, RuleExtractionTrace, RuntimePromptRuleSet } from './types';
import { documentTextLength } from './budget';
import { buildEvidenceBundle, evidenceBundlePrompt, evidencePromptBudgetForTarget } from './evidence';
import { callDocumentLlmJson } from './llmClient';
import { displayChapterTitle } from './outline';
import { concatenatedSectionTitleFixes } from './constructionBidStructure';

/** 清单层小节标题清洗（确定性结构清洗）：
 * 1) 词尾等长严格重复去重（「要点要点」→「要点」，与成稿 H4 清洗同口径）；
 * 2) 必查小节正则候选词粘连回退（「现场踏勘施工条件现场条件」→「现场踏勘」，
 *    精确查表才回退，修复系统补挂 bug 产生或历史遗留的脏小节标题）。
 * 语义级粘连不属此处职责（交审校），本函数只做精确确定性修复。 */
const CONCATENATED_SECTION_TITLE_FIXES = concatenatedSectionTitleFixes();
export function cleanSectionTitleArtifacts(title: string) {
  const cleaned = title.replace(/(.*?)(.{2,4})\2$/u, '$1$2');
  return CONCATENATED_SECTION_TITLE_FIXES[cleaned] || cleaned;
}

export function professionalSectionTaskCard(chapterTitle: string, sectionTitle: string) {
  const joined = `${chapterTitle} ${sectionTitle}`;
  const points = [
    /概况|工程|项目/u.test(joined) ? '必须落入项目名称、范围、地点、规模、工期、质量目标等资料事实；说明编制边界。' : '',
    /部署|总体|组织/u.test(joined) ? '必须说明施工组织逻辑、施工段/专业接口、资源进场和管理闭环。' : '',
    /进度|工期/u.test(joined) ? '必须围绕总工期、关键线路、资源保障、穿插施工和纠偏机制展开。' : '',
    /质量/u.test(joined) ? '必须覆盖材料验收复验、过程检查、隐蔽验收、整改复验和质量资料归档。' : '',
    /安全|文明|风险|危大/u.test(joined) ? '必须覆盖风险识别、人员设备、临电消防、现场文明、检查整改和应急响应。' : '',
    /资源|材料|设备|劳动力/u.test(joined) ? '必须说明资源配置依据、进场验收、保管调配，并与工期和质量目标一致。' : '',
    /施工|工艺|技术|方案/u.test(joined) ? '必须写清施工准备、工艺流程、关键控制点、验收要求和资料依据；每个分项工程方案必须落位至少 4 个工艺参数（mm、MPa、间距、偏差、坡度、养护天数、试验压力、搭接长度等），参数来自绑定资料或行业通用规范值，不得编造；纯设备配置型内容必须写型号、规格、容量、数量参数。工序顺序表达：工艺流程必须有明确的工序顺序表达，形式由模型根据内容自然选择，不做统一要求——可用顺序词叙述（先进行基层清理，再放线定位，随后分层摊铺，然后碾压，最后压实度检测并验收）、编号步骤、有序/无序列表或箭头链，每个含方法叙述的三级小节方法段正文至少 1 处不少于 4 个环节的工序顺序表达，不得只在单独的流程行出现。' : '',
    /流程|顺序|工序|穿插|闭环|整改|演练|转运|三检|隐蔽|排查/u.test(joined) ? '流程/顺序型叙述必须有明确的工序顺序表达，形式由模型根据内容自然选择、不做统一要求（顺序词叙述、编号步骤、有序/无序列表或箭头链均可），每条序列不少于 3 个环节，把纯文字流程描述改写成顺序清晰的表达（如先发现问题并登记建档，再分析原因，随后整改落实，最后复查销号），正文中至少 2 处工序顺序表达。' : '',
  ].filter(Boolean);
  const arrowChainPoint = points.find(point => point.includes('工序顺序表达'));
  return ['【小节专业任务卡】', `任务对象：${sectionTitle}`, ...(points.length ? points : ['必须结合本项目资料明确事实说明对象范围、实施方法、控制要点、验收要求和资料闭环，避免泛化套话。']), ...(arrowChainPoint ? ['工序顺序表达是硬性格式要求：正文成稿必须实际出现工序顺序表达（顺序词叙述/编号步骤/有序无序列表/箭头链任一形式，形式由模型自然选择），评审将核验，未达标会被退回重写。'] : []), '禁止套话：不得使用“本小节围绕……展开”“结合绑定项目资料、施工组织安排和现场实施条件”“交底覆盖率按100%控制”等模板化开篇；不得只写“加强管理、严格把控、确保质量”式口号；每个三级小节必须写与本节标题对应的专属内容，不得与其他小节内容相同或近似。'].join('\n');
}

export function normalizePlannedSectionTitle(title: string) {
  return displayChapterTitle(title.replace(/\*+/gu, ''))
    .replace(/^第[一二三四五六七八九十百千万\d]+[章节篇部分、.．\s-]*/u, '')
    .replace(/^\d+(?:\.\d+)*(?:[.．、]|\s)+/u, '')
    .replace(/^[-—–]\s*/u, '')
    .replace(/[<>]/gu, '')
    .replace(/[：:。；;,.，]+$/gu, '')
    // 清理规划模型残留的英文括号注释（如 "(or use numbering consistent with the outline)"），避免注释进入目录与正文标题
    .replace(/\s*[（(][^（）()]{0,40}[a-zA-Z]{3,}[^（）()]{0,40}[)）]\s*$/u, '')
    .trim();
}

function isInstructionLikeSectionTitle(title: string) {
  const normalized = normalizePlannedSectionTitle(title).replace(/\s+/gu, '');
  if (!normalized) return true;
  if (/^(?:目录|章节|大纲|要求|说明|注意|输出|格式|示例|例如|写法|占位|提示)$/u.test(normalized)) return true;
  return /^(?:判断|判定|识别|确认)?是否(?:涉及|涉|需要|适用)|^(?:如|若|如果)(?:涉及|不涉及|适用|不适用)|(?:根据|结合).{0,12}(?:实际情况|项目情况|资料情况).{0,8}(?:判断|确定|编写|生成)|按需(?:生成|编写)|视情况|判断后|生成要求|编写要求|说明要求|注意事项/u.test(normalized);
}

export function isInvalidPlannedSectionTitle(title: string, chapterTitle: string) {
  const normalized = normalizePlannedSectionTitle(title);
  const normalizedChapter = normalizePlannedSectionTitle(chapterTitle);
  if (normalized.length < 4 || normalized.length > 60) return true;
  if (normalized === normalizedChapter) return true;
  if (isInstructionLikeSectionTitle(normalized)) return true;
  if (/^(?:目标与范围|资料依据|实施内容|质量控制|概述|总体要求)$/u.test(normalized)) return true;
  if (/^(?:雨季|冬季|高温|台风|大风等特殊气候|雨季、冬季、高温、台风、大风等特殊气候)$/u.test(normalized)) return true;
  if (/如需|应由|大模型|提示词|上下文|动态规划|OUTLINE|章节生成|按照.*明确指定|需求和资料|JSON|小节标题/u.test(normalized)) return true;
  if (/(.)\1/u.test(normalized)) return true;
  const tail = normalizedChapter.match(/[\p{L}\p{N}]{2,6}$/u)?.[0] || '';
  if (tail.length >= 2 && /^.{2,8}\p{L}$/u.test(normalized) && normalized.endsWith(tail.slice(-1)) && !normalized.includes(tail)) return true;
  return false;
}

function chineseOrdinalToNumber(value: string) {
  const digits: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (/^\d+$/u.test(value)) return Number(value);
  if (digits[value] !== undefined) return digits[value];
  if (value === '十') return 10;
  const tenMatch = /^(?:(一|二|两|三|四|五|六|七|八|九)?)十(?:(一|二|两|三|四|五|六|七|八|九))?$/u.exec(value);
  if (!tenMatch) return undefined;
  const tens = tenMatch[1] ? digits[tenMatch[1]] : 1;
  const ones = tenMatch[2] ? digits[tenMatch[2]] : 0;
  return tens * 10 + ones;
}

export function sectionTitleEquivalent(a: string, b: string) {
  const left = normalizePlannedSectionTitle(a).replace(/[\s()（）:：.。；;,，、-]/gu, '');
  const right = normalizePlannedSectionTitle(b).replace(/[\s()（）:：.。；;,，、-]/gu, '');
  if (!left || !right) return false;
  return left === right || left.includes(right) || right.includes(left);
}

function conditionalSectionRuleContext(text: string) {
  return /判断是否涉及|若涉及|若不涉及|如果涉及|如果不涉及|不涉及.*如实说明|根据项目所在地气候特征|根据计划施工周期|根据.*施工周期|按需|视情况|可设置|专项小节/u.test(text);
}

function cleanParsedSectionTitles(titles: string[], context = '') {
  const conditionalContext = conditionalSectionRuleContext(context);
  return Array.from(new Set(titles.map(normalizePlannedSectionTitle).filter(title => {
    if (title.length < 2 || title.length > 30) return false;
    if (isInstructionLikeSectionTitle(title)) return false;
    if (/必须|强制|排序|设置|输出|独立|之后|之前|小节|其他必要/u.test(title)) return false;
    if (conditionalContext && /^(?:雨季|冬季|高温|台风|大风等特殊气候|雨季、冬季、高温、台风、大风等特殊气候)$/u.test(title)) return false;
    return true;
  })));
}

function parseSectionListFromRuleText(text: string) {
  const topList = /(?:以下小节设置和排序|强制小节|必须小节)[：:]\s*([\s\S]*?)(?:\n\s*#{2,6}\s|\n\s*第[一二两三四五六七八九十\d]+章|$)/u.exec(text)?.[1];
  if (topList) {
    const titles = [...topList.matchAll(/(?:^|\n)\s*\d+[.．、]\s*([^——\-—：:。；;\n]{2,30})(?:[——\-—：:]|，|,|。|；|;|\n|$)/gu)].map(match => match[1]);
    const cleaned = cleanParsedSectionTitles(titles, text);
    if (cleaned.length > 0) return cleaned;
  }

  const titles: string[] = [];
  const afterRequiredPattern = /第[一二两三四五六七八九十\d]+章[^。；;\n]{0,50}(?:强制)?(?:包含|设置|输出|排序|挂靠)[^：:。；;\n]{0,20}[：:]\s*([^。；;\n]{2,120})/gu;
  for (const match of text.matchAll(afterRequiredPattern)) {
    for (const item of match[1].split(/[、,，/／及和与]/u)) titles.push(item);
  }
  const quotedSectionPattern = /[“"]([^”"]{2,30})[”"]\s*(?:二级)?小节/gu;
  for (const match of text.matchAll(quotedSectionPattern)) titles.push(match[1]);
  const namedPattern = /([\p{Script=Han}A-Za-z0-9（）()]{2,30})(?:——|—|-|：|:)\s*(?:独立的)?(?:二级)?小节/gu;
  for (const match of text.matchAll(namedPattern)) titles.push(match[1]);
  const afterSectionLabelPattern = /(?:必须|应当|需|需要|包含|设置|输出)[^。；;\n]{0,30}(?:独立的)?(?:二级)?小节[：:]\s*([^。；;\n]{2,80})/gu;
  for (const match of text.matchAll(afterSectionLabelPattern)) {
    for (const item of match[1].split(/[、,，/／及和与]/u)) titles.push(item);
  }
  return cleanParsedSectionTitles(titles, text);
}

function simpleHashText(text: string) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function extractOutlineHeadings(text: string) {
  const headings: string[] = [];
  const outline = /<OUTLINE>([\s\S]*?)<\/OUTLINE>/u.exec(text)?.[1] || '';
  for (const line of outline.split(/\r?\n/u)) {
    const title = line.replace(/^\s*(?:\d+[.、．]|[-*])\s*/u, '').trim();
    if (title.length >= 2 && title.length <= 80 && !isInstructionLikeSectionTitle(title)) headings.push(title);
  }
  return [...new Set(headings)];
}

function extractMinWords(text: string) {
  const match = /(?:不少于|至少|最低|必须生成不少于)\s*(\d+(?:\.\d+)?)\s*(万)?\s*字/u.exec(text);
  if (!match) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value * (match[2] ? 10000 : 1));
}

function splitExplicitRuleList(value: string) {
  return value
    .split(/[、,，/／]/u)
    .map(item => item.trim().replace(/["“”'‘’《》<>]/gu, ''))
    .filter(item => item.length >= 2 && item.length <= 24 && !/[。；;：:]/u.test(item));
}

function extractRequiredKeywordRules(text: string) {
  const keywords = new Set<string>();
  const patterns = [
    /(?:关键词|核心要点|必含关键词|必须包含的关键词)[：:]\s*([^。；;\n]+)/gu,
    /(?:必须|应当|需要|全文必须)包含(?:以下|如下)?(?:关键词|核心词|术语)[：:]\s*([^。；;\n]+)/gu,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      for (const keyword of splitExplicitRuleList(match[1] || '')) {
        if (!/表格|章节|小节|正文|目录|封面/u.test(keyword)) keywords.add(keyword);
      }
    }
  }
  return [...keywords].slice(0, 24);
}

function extractForbiddenPatternRules(text: string) {
  const patterns = new Set<string>();
  const forbidLinePatterns = [
    /(?:禁用词|禁止词|不得使用词|禁用表达|禁止表达)[：:]\s*([^。；;\n]+)/gu,
    /(?:禁止|不得|严禁|杜绝)出现(?:以下|如下)?(?:词语|用词|表达|话术)[：:]\s*([^。；;\n]+)/gu,
  ];
  for (const pattern of forbidLinePatterns) {
    for (const match of text.matchAll(pattern)) {
      for (const value of splitExplicitRuleList(match[1] || '')) patterns.add(value);
    }
  }
  return [...patterns].slice(0, 40);
}

function extractRequiredTableTitles(text: string) {
  const titles = new Set<string>();
  const patterns = [
    /(?:必须|应当|需要|全文必须|至少)输出(?:的)?表格[：:]\s*([^。；;\n]+)/gu,
    /(?:必须|应当|需要|全文必须|至少)包含(?:的)?表格[：:]\s*([^。；;\n]+)/gu,
    /(?:表格清单|表格要求)[：:]\s*([^。；;\n]+)/gu,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      for (const part of (match[1] || '').split(/[、,，/／及和与]/u)) {
        const title = /([\p{Script=Han}A-Za-z0-9（）()《》<>]{2,40}表)/u.exec(part.trim())?.[1];
        if (title) titles.add(title.replace(/[<>《》]/gu, ''));
      }
    }
  }
  for (const match of text.matchAll(/([\p{Script=Han}A-Za-z0-9（）()]{2,40}表)(?:必须|应当|需要|不得缺失|不可缺失)/gu)) titles.add(match[1]);
  if (/项目基本信息表/u.test(text)) titles.add('项目基本信息表');
  return [...titles];
}

function sentencesMatching(text: string, pattern: RegExp) {
  return text.split(/[。；;\n]/u).map(item => item.trim()).filter(item => item.length >= 4 && pattern.test(item)).slice(0, 24);
}

/** 在属性化提示词列表中搜索 matchedText，确定规则来源归属 */
function attributedMatch(
  attributedPrompts: Array<{ promptId: string; roleId: string; content: string }>,
  matchedText: string,
  patternSource: string,
): { promptId: string; roleId: string; pattern: string } {
  for (const p of attributedPrompts) {
    if (p.content.includes(matchedText)) return { promptId: p.promptId, roleId: p.roleId, pattern: patternSource };
  }
  return { promptId: 'system:generation-control', roleId: 'generation-control', pattern: patternSource };
}

export function buildRuntimePromptRules(input: {
  promptTexts: string;
  requirement?: string;
  template?: DocumentTemplate;
  rolePrompts?: Array<{ roleId: string; name: string; content: string }>;
  /** 属性化提示词列表，用于规则溯源 */
  attributedPrompts?: Array<{ promptId: string; roleId: string; name: string; content: string }>;
}): RuntimePromptRuleSet {
  const attributed = input.attributedPrompts || [];
  const normalizedText = [input.promptTexts, input.requirement || ''].filter(Boolean).join('\n\n').replace(/\\n/gu, '\n');
  const base = extractPromptDocumentRules(normalizedText);
  const requiredTables = [...new Set([...base.requiredTables, ...extractRequiredTableTitles(normalizedText)])];
  const requiredKeywords = extractRequiredKeywordRules(normalizedText);
  const forbiddenPatterns = extractForbiddenPatternRules(normalizedText);
  const exactHeadings = extractOutlineHeadings(normalizedText);
  // “后台”不单独作为禁止词：正文中的“后台权限设置/后台管理”等是智慧工地平台的正当专业术语，
  // 必须用“后台话术/后台流程”等复合词才能准确拦截提示词泄漏且不误伤正当用法。
  const backendTerms = ['知识库', '提示词', '建议补充', '资料库', 'OCR', '后台话术', '后台流程', '后台数据', '后台资料', '后台溯源', '绑定片段'];
  const commercialTerms = /技术标(?:正文)?(?:不得|禁止|严禁).*(?:商务|报价|单价|税率|利润|造价)/u.test(normalizedText) ? ['报价明细表'] : [];
  const forbiddenSubjects: string[] = [];
  const minWords = extractMinWords(normalizedText);
  const chapterRules = (input.template?.chapters || []).map(chapter => ({
    chapterTitle: chapter.title,
    mustInclude: sentencesMatching(normalizedText, new RegExp(`${chapter.title.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}|${chapter.title.slice(0, 6).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`, 'u')).slice(0, 8),
    mustNotInclude: sentencesMatching(normalizedText, /禁止|不得|严禁|杜绝/u).filter(item => item.includes(chapter.title)).slice(0, 8),
  })).filter(item => item.mustInclude.length > 0 || item.mustNotInclude.length > 0);
  const roleRules = (input.rolePrompts || []).map(prompt => ({
    roleId: prompt.roleId,
    focusAreas: sentencesMatching(prompt.content, /重点|关注|围绕|响应|体系|措施|质量|安全|工期|资源/u).slice(0, 8),
    mustDo: sentencesMatching(prompt.content, /必须|应当|需要|确保|严格/u).slice(0, 10),
    mustNotDo: sentencesMatching(prompt.content, /禁止|不得|严禁|杜绝/u).slice(0, 10),
  })).filter(item => item.focusAreas.length > 0 || item.mustDo.length > 0 || item.mustNotDo.length > 0);
  const executionSummary = [
    base.coverPolicy && base.coverPolicy !== 'unspecified' ? `已识别封面规则：${base.coverPolicy === 'required' ? '要求生成' : '禁止生成'}` : '',
    base.tocPolicy && base.tocPolicy !== 'unspecified' ? `已识别目录规则：${base.tocPolicy === 'required' ? '要求生成' : '禁止生成'}` : '',
    exactHeadings.length ? `已识别一级章节固定规则 ${exactHeadings.length} 条` : '',
    forbiddenSubjects.length ? `已识别禁用主体表达：${forbiddenSubjects.join('、')}` : '',
    base.forbiddenTerms.length ? `已识别禁用词 ${base.forbiddenTerms.length} 个` : '',
    requiredTables.length ? `已识别必需表格：${requiredTables.join('、')}` : '',
    requiredKeywords.length ? `已识别必含关键词：${requiredKeywords.join('、')}` : '',
    forbiddenPatterns.length ? `已识别禁止出现内容：${forbiddenPatterns.join('、')}` : '',
    minWords ? `已识别最低字数要求：${minWords} 字` : '',
    roleRules.length ? `已抽取角色执行规则 ${roleRules.length} 组` : '',
  ].filter(Boolean);
  // 构建规则溯源信息
  const extractionTrace: RuleExtractionTrace[] = [];
  const ruleSources: Record<string, Array<{ promptId: string; roleId: string; pattern: string; matchedText: string }>> = {};
  const addTrace = (key: string, rule: string, matchedText: string, pattern: string) => {
    const source = attributedMatch(attributed, matchedText, pattern);
    if (!ruleSources[key]) ruleSources[key] = [];
    if (ruleSources[key].length < 24) ruleSources[key].push({ ...source, matchedText });
    if (extractionTrace.length < 60) extractionTrace.push({ rule, source, matchedText });
  };
  if (base.coverPolicy && base.coverPolicy !== 'unspecified') addTrace('coverPolicy', `已识别封面规则：${base.coverPolicy}`, '封面', /封面|cover/u.source);
  if (base.tocPolicy && base.tocPolicy !== 'unspecified') addTrace('tocPolicy', `已识别目录规则：${base.tocPolicy}`, '目录', /目录|toc/u.source);
  for (const t of requiredTables) addTrace('requiredTables', `必需表格：${t}`, t, /全文必须输出|必须输出表格|项目基本信息表/u.source);
  for (const kw of requiredKeywords) addTrace('requiredKeywords', `必含关键词：${kw}`, kw, /必须包含|必须含|应包含|需要包含/u.source);
  for (const fp of forbiddenPatterns) addTrace('forbiddenPatterns', `禁止内容：${fp}`, fp, /禁止|不得|严禁|杜绝/u.source);
  for (const h of exactHeadings) addTrace('exactHeadings', `固定章节：${h}`, h, /第[一二三四五六七八九十百千\d]+章/u.source);
  if (minWords) addTrace('minWords', `最低字数：${minWords}`, String(minWords), /\d{3,}\s*字/u.source);
  return {
    ...base,
    requiredTables,
    requiredKeywords,
    forbiddenPatterns,
    sourceHash: simpleHashText(normalizedText),
    exactHeadings,
    forbidExtraHeadings: /不得合并|不得删除|不得改名|不得新增|严格按.*章节名称|一级章节.*不得/u.test(normalizedText) || exactHeadings.length > 0,
    requiredSubjects: /我公司/u.test(normalizedText) ? ['我公司', '项目部'] : [],
    forbiddenSubjects,
    backendTerms,
    commercialTerms,
    forbiddenTerms: [...new Set([...base.forbiddenTerms, ...backendTerms, ...commercialTerms, ...forbiddenSubjects])],
    forbidFabrication: /不得编造|严禁编造|不得擅自|资料未明确|系统暂未|事实真实性/u.test(normalizedText),
    requireEvidenceForQuantities: /量化|参数|数值|具体数据|具体参数|工程实体参数|资料中明确|不得空泛|不能空泛|泛泛而谈/u.test(normalizedText),
    preferProjectFacts: /事实优先|项目事实|真实性高于/u.test(normalizedText),
    minWords,
    minChars: minWords,
    chapterRules,
    roleRules,
    executionSummary,
    ruleSources: Object.keys(ruleSources).length > 0 ? ruleSources : undefined,
    extractionTrace: extractionTrace.length > 0 ? extractionTrace : undefined,
  };
}

export function runtimePromptRulesPrompt(rules: RuntimePromptRuleSet) {
  const lines = [
    `运行时规则版本：${rules.sourceHash}`,
    rules.coverPolicy === 'required' ? '用户要求输出封面时必须保留封面；未要求时不得由系统擅自决定。' : '',
    rules.tocPolicy === 'required' ? '用户要求输出目录时必须保留目录，并确保目录只来自最终合法正文标题。' : '',
    rules.forbidCover ? '用户明确禁止输出封面。' : '',
    rules.forbidToc ? '用户明确禁止输出目录、目录说明或导航页。' : '',
    rules.exactHeadings.length ? `一级章节必须严格使用：${rules.exactHeadings.join('；')}` : '',
    rules.forbidExtraHeadings ? '不得新增、删除、合并或改名一级章节。' : '',
    rules.requiredSubjects.length ? `正文主体优先使用：${rules.requiredSubjects.join('、')}` : '',
    rules.forbiddenSubjects.length ? `禁止主体表达：${rules.forbiddenSubjects.join('、')}` : '',
    rules.forbidFabrication ? '不得编造系统暂未从知识库确认的项目事实、工程实体参数、人名、联系方式或品牌；应通过扩大检索、事实补抽或落位修复解决。' : '',
    rules.requireEvidenceForQuantities ? '涉及数量、工期、质量标准目标、规格型号等项目专属参数时必须以绑定资料中的明确事实为准；通用标准规范编号与法规名称可依据现行有效版本直接引用。' : '',
    rules.commercialTerms.length ? `禁止输出商务敏感内容：${rules.commercialTerms.join('、')}` : '',
    rules.backendTerms.length ? `禁止输出系统内部话术：${rules.backendTerms.join('、')}` : '',
    rules.requiredTables.length ? `必须输出以下正式 Markdown 表格：${rules.requiredTables.join('、')}。表格必须包含表名、表头、分隔线和数据行。` : '',
    rules.requiredKeywords?.length ? `正文必须覆盖以下关键词或要点：${rules.requiredKeywords.join('、')}。` : '',
    rules.forbiddenPatterns?.length ? `正文禁止出现以下内容：${rules.forbiddenPatterns.join('、')}。` : '',
    rules.minWords ? `全文不少于 ${rules.minWords} 字。` : '',
  ].filter(Boolean);
  return `以下规则由系统运行时从用户绑定指令中自动抽取，不作为用户可编辑内容。生成、检查和修复必须共同遵守：\n${lines.map((line, index) => `${index + 1}. ${line}`).join('\n')}`;
}

function promptPolicy(text: string, subject: '封面' | '目录'): 'required' | 'forbidden' | 'unspecified' {
  const required = new RegExp(`(?:生成|包含|输出|需要|保留|设置|编制|制作)[^。；;\\n]{0,12}${subject}|${subject}[^。；;\\n]{0,12}(?:必须|应当|需要|保留|生成|输出|包含)`, 'u').test(text);
  const forbidden = new RegExp(`(?:不要|不需要|不允许|不得|禁止|严禁|不输出|不生成|无需)[^。；;\\n]{0,12}${subject}|${subject}[^。；;\\n]{0,12}(?:不要|不需要|不允许|不得|禁止|严禁|不输出|不生成|无需)`, 'u').test(text);
  if (forbidden) return 'forbidden';
  if (required) return 'required';
  return 'unspecified';
}

export function extractPromptDocumentRules(promptTexts: string): PromptDocumentRuleSet {
  const normalizedText = promptTexts.replace(/\\n/gu, '\n');
  const requiredTables = new Set<string>();
  const tableLine = /全文必须输出[：:]\s*([^。；;\n]+)/u.exec(normalizedText)?.[1] || /必须输出(?:的)?表格[：:]\s*([^。；;\n]+)/u.exec(normalizedText)?.[1] || '';
  for (const part of tableLine.split(/[、,，]/u)) {
    const title = /([\p{Script=Han}A-Za-z0-9（）()]{2,30}表)$/u.exec(part.trim())?.[1];
    if (title && title.length >= 4 && title.length <= 30) requiredTables.add(title);
  }
  if (/项目基本信息表/u.test(normalizedText)) requiredTables.add('项目基本信息表');
  // “后台”不单独作为禁止词：正文中的“后台权限设置/后台管理”等是智慧工地平台的正当专业术语，
  // 必须用“后台话术/后台流程”等复合词才能准确拦截提示词泄漏且不误伤正当用法。
  const forbiddenTerms = ['知识库', '提示词', '建议补充', '资料库', 'OCR', '后台话术', '后台流程', '后台数据', '后台资料', '后台溯源', '绑定片段'];
  if (/杜绝(?:套话|空话)|禁止(?:套话|空话)|不得(?:套话|空话)|严禁(?:套话|空话)/u.test(normalizedText)) forbiddenTerms.push('高度重视', '重中之重');
  if (/技术标(?:正文)?(?:不得|禁止|严禁).*(?:商务|报价|单价|税率|利润|造价)/u.test(normalizedText)) forbiddenTerms.push('报价明细表');
  const coverPolicy = promptPolicy(normalizedText, '封面');
  const tocPolicy = promptPolicy(normalizedText, '目录');
  return {
    coverPolicy,
    tocPolicy,
    forbidCover: coverPolicy === 'forbidden',
    forbidToc: tocPolicy === 'forbidden',
    forbiddenTerms: [...new Set(forbiddenTerms)],
    preferredTerms: [{ from: '高度重视', to: '严格落实' }, { from: '重中之重', to: '关键控制事项' }],
    requiredTables: [...requiredTables],
    requiredKeywords: extractRequiredKeywordRules(normalizedText),
    forbiddenPatterns: extractForbiddenPatternRules(normalizedText),
  };
}

export function extractPromptStructuralRules(promptTexts: string, chapters?: DocumentTemplateChapter[]): PromptChapterStructuralRule[] {
  const normalizedText = promptTexts.replace(/\\n/gu, '\n');
  const chapterRulePattern = /第([一二两三四五六七八九十\d]+)章[^\n。；;]{0,80}(?:强制|必须|挂靠|小节|排序|最先|之后|之前)/gu;
  const grouped = new Map<number, { blocks: string[]; titles: string[] }>();
  const matches = [...normalizedText.matchAll(chapterRulePattern)];
  for (const match of matches) {
    const chapterNumber = chineseOrdinalToNumber(match[1]);
    if (!chapterNumber) continue;
    const start = Math.max(0, match.index || 0);
    const next = matches.find(item => (item.index || 0) > start)?.index;
    const block = normalizedText.slice(start, Math.min(normalizedText.length, next ?? start + 1400));
    if (conditionalSectionRuleContext(block) && !/(强制小节|必须小节|以下小节设置和排序|必须设置独立的|必须包含独立的)/u.test(block)) continue;
    const titles = parseSectionListFromRuleText(block);
    if (titles.length === 0) continue;
    const item = grouped.get(chapterNumber) || { blocks: [], titles: [] };
    item.blocks.push(block);
    for (const title of titles) {
      if (!item.titles.some(existing => sectionTitleEquivalent(existing, title))) item.titles.push(title);
    }
    grouped.set(chapterNumber, item);
  }
  return [...grouped.entries()].map(([chapterNumber, item]) => {
    const chapter = chapters?.[chapterNumber - 1];
    return {
      chapterIndex: chapterNumber - 1,
      chapterTitle: chapter?.title,
      source: item.blocks[0]?.split('\n').find(line => line.trim())?.trim().slice(0, 120),
      requiredSections: item.titles.map((title, index) => ({ title, order: index + 1, required: true, source: item.blocks[0]?.slice(0, 240) })),
    };
  });
}

function structuralRulesForChapter(rules: PromptChapterStructuralRule[] | undefined, chapter: DocumentTemplateChapter, chapterIndex?: number) {
  return (rules || []).filter(rule => {
    if (rule.chapterIndex !== undefined && chapterIndex !== undefined && rule.chapterIndex === chapterIndex) return true;
    if (rule.chapterTitle && sectionTitleEquivalent(rule.chapterTitle, chapter.title)) return true;
    return false;
  });
}

export function normalizePlannedSections(sections: string[] = [], chapterTitle: string) {
  const result: string[] = [];
  for (const section of sections) {
    const title = cleanSectionTitleArtifacts(normalizePlannedSectionTitle(section));
    if (!title || isInvalidPlannedSectionTitle(title, chapterTitle)) continue;
    if (!result.some(item => sectionTitleEquivalent(item, title))) result.push(title);
  }
  return result;
}

function applyPromptStructuralRules(sections: string[], chapterTitle: string, rules: PromptChapterStructuralRule[]) {
  const locked = rules.flatMap(rule => rule.requiredSections).sort((a, b) => (a.order || 0) - (b.order || 0));
  const result = normalizePlannedSections(locked.map(rule => rule.title), chapterTitle);
  for (const section of normalizePlannedSections(sections, chapterTitle)) {
    if (!result.some(item => sectionTitleEquivalent(item, section))) result.push(section);
  }
  return result;
}

function compoundSectionSeeds(chapterTitle: string) {
  const title = normalizePlannedSectionTitle(chapterTitle);
  const seeds: string[] = [];
  const completeClause = /体系|措施|管理|保障|方案|要求|计划|控制|配置/u;
  const addAndGroup = (value: string) => {
    const match = /^(.*?)([^与和及、,，；;]+(?:[与和及][^与和及、,，；;]+)+)(的.+)$/u.exec(value);
    if (!match) return false;
    const prefix = match[1] || '';
    const suffix = match[3] || '';
    for (const item of match[2].split(/[与和及]/u)) seeds.push(normalizePlannedSectionTitle(`${prefix}${item}${suffix}`));
    return true;
  };
  const addCommaGroup = (value: string) => {
    const parts = value.split(/[、,，]/u).map(normalizePlannedSectionTitle).filter(Boolean);
    if (parts.length > 1 && parts.every(part => part.length >= 4 && completeClause.test(part))) {
      for (const part of parts) {
        if (!addAndGroup(part)) seeds.push(part);
      }
      return true;
    }
    const match = /^(.*?)([^、,，；;]+(?:[、,，][^、,，；;]+)+)(的.+)$/u.exec(value);
    if (!match) return false;
    const prefix = match[1] || '';
    const suffix = match[3] || '';
    for (const item of match[2].split(/[、,，]/u)) seeds.push(normalizePlannedSectionTitle(`${prefix}${item}${suffix}`));
    return true;
  };
  for (const part of title.split(/[；;]/u)) {
    if (addCommaGroup(part) || addAndGroup(part)) continue;
    const cleaned = normalizePlannedSectionTitle(part);
    if (cleaned && cleaned !== title) seeds.push(cleaned);
  }
  return Array.from(new Set(seeds)).filter(item => item.length >= 4 && item.length <= 60 && item !== title && !isInvalidPlannedSectionTitle(item, chapterTitle));
}

function evidenceParameterDensity(evidence: DocumentEvidence[]) {
  const text = evidence.map(item => `${item.sectionTitle || ''}\n${item.content}`).join('\n').slice(0, 30000);
  const matches = text.match(/\d+(?:\.\d+)?\s*(?:mm|cm|m|km|㎡|m²|m3|m³|kg|g|t|L|ml|MPa|kPa|℃|%|台|套|个|项|批|次|份|人|小时|分钟|日历天|天|周|月|年|万元|元)|DN\s*\d+|Φ\s*\d+|φ\s*\d+|C\d{2,}|HRB\d+|GB\/?T?\s*[\w.-]+|JGJ\s*[\w.-]+/giu) || [];
  return new Set(matches.map(item => item.replace(/\s+/gu, ''))).size;
}

export function minimumSectionCount(chapter: DocumentTemplateChapter, targetWords: number, evidence: DocumentEvidence[], lockedCount: number) {
  const title = chapter.title;
  const coreChapter = /质量|安全|工期|进度|物资|材料|机械|设备|劳动力|危大|专项|文明|总平面|施工方法|施工方案/u.test(title);
  let minimum = targetWords >= 14000 ? 6 : targetWords >= 8000 ? 5 : targetWords >= 5000 ? 4 : targetWords >= 3000 ? 4 : 3;
  if (coreChapter) minimum = Math.max(minimum, 4);
  const density = evidenceParameterDensity(evidence);
  if (density >= 20) minimum = Math.max(minimum, 5);
  else if (density >= 10) minimum = Math.max(minimum, 4);
  return Math.max(minimum, lockedCount);
}

export function fallbackSectionsForChapter(chapterTitle: string) {
  if (/质量/u.test(chapterTitle)) return ['质量目标与质量管理体系', '关键工序质量控制措施', '材料设备进场验收与检验', '质量检查试验与验收程序', '质量通病防治与整改闭环', '成品保护与资料管理'];
  if (/安全/u.test(chapterTitle)) return ['安全生产管理体系', '危险源辨识与分级管控', '现场安全防护措施', '临时用电与机械设备安全管理', '应急处置与安全检查整改', '安全教育培训与交底'];
  if (/工期|进度/u.test(chapterTitle)) return ['总工期目标与节点安排', '施工进度计划编制原则', '关键线路与工序穿插安排', '资源投入与工期保障措施', '进度偏差纠偏与动态调整', '工期风险识别与应对措施'];
  if (/物资|材料/u.test(chapterTitle)) return ['主要材料设备需求分析', '材料采购与进场计划', '材料验收复试与保管', '周转材料配置与使用管理', '材料供应风险与保障措施'];
  if (/机械|设备/u.test(chapterTitle)) return ['主要机械设备配置原则', '机械设备进退场计划', '机械设备调度与运行管理', '机械设备维护保养与安全检查', '关键设备保障措施'];
  if (/劳动力/u.test(chapterTitle)) return ['劳动力配置原则', '各阶段劳动力投入计划', '专业工种与特种作业人员配置', '劳动力动态调配措施', '劳务管理与教育交底'];
  if (/文明|环保/u.test(chapterTitle)) return ['现场封闭与场容场貌管理', '环境保护与污染防治措施', '材料设备定置化管理', '职业健康与消防文明管理', '文明施工检查与整改'];
  if (/总平面|平面布置/u.test(chapterTitle)) return ['施工总平面布置原则', '临时道路与材料堆场布置', '临时用水用电及排水布置', '办公生活与加工区域布置', '总平面动态调整与管理'];
  if (/危大|专项/u.test(chapterTitle)) return ['危大工程识别与清单管理', '专项施工方案编制与审批', '专家论证与技术交底', '现场实施监测与旁站管理', '应急处置与验收销项'];
  if (/施工方法|施工方案|主要/u.test(chapterTitle)) return ['总体施工部署与流程安排', '主要分部分项施工方法', '关键工序技术控制要点', '资源配置与穿插组织', '质量安全与成品保护措施'];
  return ['总体部署与责任分工', '实施流程与关键控制', '资源配置与资料依据', '质量安全与风险控制', '检查验收与闭环管理', '资料记录与成果移交'];
}

export async function planChapterSectionsWithLlm(input: { template: DocumentTemplate; chapter: DocumentTemplateChapter; chapterIndex?: number; evidence: DocumentEvidence[]; promptTexts: string; projectContext: string; requirement?: string; roleContext: string; targetWords: number; structuralRules?: PromptChapterStructuralRule[]; signal?: AbortSignal; diagnostics?: DocumentGenerationDiagnostics }) {
  const evidenceText = evidenceBundlePrompt(buildEvidenceBundle(input.chapter, input.evidence), { maxChars: evidencePromptBudgetForTarget(input.targetWords, 5000, 12000) });
  const chapterStructuralRules = structuralRulesForChapter(input.structuralRules, input.chapter, input.chapterIndex);
  const lockedSections = chapterStructuralRules.flatMap(rule => rule.requiredSections).sort((a, b) => (a.order || 0) - (b.order || 0)).map(rule => rule.title);
  const minSections = minimumSectionCount(input.chapter, input.targetWords, input.evidence, lockedSections.length);
  const maxSections = Math.max(minSections, Math.min(7, input.targetWords >= 8000 ? 7 : 6));
  // 改7：章节顺序规则——"编制说明与工程概况"类小节必须是第一章首节（用户明确要求）；
  // 指令引导 + 规划后核验反馈重规划实现，不做代码硬排（禁止确定性兜底）
  const overviewChapter = input.chapterIndex === 0 || /编制说明|工程概况|项目概况/u.test(input.chapter.title);
  const planOnce = async (orderFeedback: string) => {
    const result = await callDocumentLlmJson<{ sections?: string[] }>([
      '你是专业文档结构规划专家。',
      '只根据用户提示词、章节标题和真实绑定资料规划本章二级小节；不得使用"目标与范围、资料依据、实施内容、质量控制"等通用占位小节凑数。',
      '施工组织、技术措施、资源配置、质量、安全、工期、材料、设备、劳动力、危大工程等核心章节必须拆成足够的专业工作面，不得只输出两个泛化小节。',
      '不得把提示词条件句或短语碎片作为小节标题，例如"判断是否涉、是否涉及、如涉及、雨季、冬季、高温、台风、大风等特殊气候"。',
      '小节标题必须直接属于本章主题域：例如"人材机保障/资源配置"章只允许劳动力、材料、机械设备、周转类标题；投标/评标纪律、评标办法、商务报价、投标程序、评审澄清、中标公示类标题一律禁止（施工组织设计正文不写评标程序内容）。',
      overviewChapter ? '本章是全文第一章：若规划出"编制说明与工程概况"类小节，必须置于小节清单第一位，不得排在任何其他小节之后。' : '',
      '只返回 JSON。',
    ].filter(Boolean).join('\n'), [
      `文档模板：${input.template.name}`,
      `章节标题：${input.chapter.title}`,
      input.chapter.purpose && !isInvalidPlannedSectionTitle(input.chapter.purpose, input.chapter.title) ? `章节目的：${input.chapter.purpose}` : '',
      input.requirement ? `用户要求：${input.requirement}` : '',
      input.projectContext ? `上下文：\n${input.projectContext}` : '',
      input.roleContext,
      input.promptTexts ? `配置写作主控提示词：\n${input.promptTexts}` : '',
      lockedSections.length ? `系统已从提示词解析出本章强制二级小节，必须按此顺序置于本章小节最前，不得删除、改名或重排：${lockedSections.join('、')}` : '',
      evidenceText ? `真实绑定资料：\n${evidenceText}` : '',
      `请输出 ${minSections}-${maxSections} 个适合直接成稿的二级小节标题。标题必须具体、业务相关、能承载真实资料；每个标题控制在 16 个汉字以内，避免多个小节表达同一内容。核心章节不得只输出"总体部署与责任分工、实施流程与关键控制"两个泛化小节。`,
      orderFeedback,
      'JSON 格式：{"sections":["小节标题1","小节标题2"]}',
    ].filter(Boolean).join('\n\n'), { maxTokens: 1600, temperature: 0.1, signal: input.signal, diagnostics: input.diagnostics });
    const sections = Array.from(new Set(compoundSectionSeeds(input.chapter.title)));
    for (const title of (result?.sections || []).map(section => cleanSectionTitleArtifacts(normalizePlannedSectionTitle(section))).filter(title => !isInvalidPlannedSectionTitle(title, input.chapter.title))) {
      if (!sections.some(section => section.includes(title) || title.includes(section))) sections.push(title);
    }
    const fallbackSeeds = [input.chapter.title, ...(input.chapter.requiredFacts || []), ...(input.chapter.queries || [])]
      .flatMap(item => String(item || '').split(/[；;。\n]/u))
      .map(normalizePlannedSectionTitle)
      .filter(title => !isInvalidPlannedSectionTitle(title, input.chapter.title));
    const typedSeeds = fallbackSectionsForChapter(input.chapter.title)
      .filter(title => !isInvalidPlannedSectionTitle(title, input.chapter.title));
    for (const seed of [...fallbackSeeds, ...typedSeeds]) {
      if (sections.length >= minSections) break;
      if (!sections.some(section => section.includes(seed) || seed.includes(section))) sections.push(seed);
    }
    return applyPromptStructuralRules(sections, input.chapter.title, chapterStructuralRules).slice(0, Math.max(maxSections, lockedSections.length));
  };
  const planned = await planOnce('');
  if (!overviewChapter) return planned;
  const overviewIndex = planned.findIndex(section => /编制说明与工程概况|工程概况|项目概况/u.test(section));
  if (overviewIndex <= 0) return planned;
  // 规划结果核验失败：带位置反馈打回 LLM 重规划一轮（不硬排小节顺序）
  const retried = await planOnce(`上一轮规划位置错误：小节"${planned[overviewIndex]}"必须是本章小节清单的第一位（第一章首节），不得排在"${planned.slice(0, overviewIndex).join('、')}"等小节之后；请重新输出完整小节清单，将该项置于第一位，其余小节顺序可保持不变。`);
  const retriedIndex = retried.findIndex(section => /编制说明与工程概况|工程概况|项目概况/u.test(section));
  if (retriedIndex > 0) {
    console.error(`[plan] 章节小节顺序核验未通过（重规划后"${retried[retriedIndex]}"仍不在首位）：${input.chapter.title}，保留 LLM 规划顺序交由下游审校处理`);
  }
  return retried;
}

/** 提示词保存前预检结果：向用户展示系统运行时将从该提示词中执行的硬性规则 */
export interface PromptRulePreview {
  recognized: boolean;
  summary: string[];
  requiredTables: string[];
  requiredKeywords: string[];
  forbiddenPatterns: string[];
  exactHeadings: string[];
  minWords: number | undefined;
  coverPolicy: string;
  tocPolicy: string;
}

/** 提示词保存前预检：轻量复用运行时规则抽取（纯正则，无 LLM 调用） */
export function previewPromptRules(content: string): PromptRulePreview {
  const rules = buildRuntimePromptRules({ promptTexts: content });
  return {
    recognized: rules.executionSummary.length > 0,
    summary: rules.executionSummary,
    requiredTables: rules.requiredTables,
    requiredKeywords: rules.requiredKeywords || [],
    forbiddenPatterns: rules.forbiddenPatterns || [],
    exactHeadings: rules.exactHeadings || [],
    minWords: rules.minWords,
    coverPolicy: rules.coverPolicy || 'unspecified',
    tocPolicy: rules.tocPolicy || 'unspecified',
  };
}

/** 多提示词规则冲突检测：对比各提示词运行时抽取的硬性规则，识别相互矛盾的要求（模板校验时调用） */
export function detectPromptRuleConflicts(prompts: Array<{ promptId: string; name: string; roleId: string; content: string }>): Array<{ level: 'warning'; message: string }> {
  const conflicts: Array<{ level: 'warning'; message: string }> = [];
  const extracted = prompts
    .map(prompt => ({ prompt, rules: buildRuntimePromptRules({ promptTexts: prompt.content }) }))
    .filter(item => item.rules.executionSummary.length > 0);
  if (extracted.length < 2) return conflicts;
  for (let i = 0; i < extracted.length; i++) {
    for (let j = i + 1; j < extracted.length; j++) {
      const a = extracted[i];
      const b = extracted[j];
      const aName = `${a.prompt.name}(${a.prompt.roleId})`;
      const bName = `${b.prompt.name}(${b.prompt.roleId})`;
      // 必含关键词 vs 禁词/禁止内容：交叉冲突
      const crossHits: string[] = [];
      for (const kw of a.rules.requiredKeywords || []) {
        for (const fb of [...(b.rules.forbiddenTerms || []), ...(b.rules.forbiddenPatterns || [])]) {
          if (kw.includes(fb) || fb.includes(kw)) crossHits.push(`「${kw}」被要求必含（${aName}）但被禁止（${bName}：${fb}）`);
        }
      }
      for (const kw of b.rules.requiredKeywords || []) {
        for (const fa of [...(a.rules.forbiddenTerms || []), ...(a.rules.forbiddenPatterns || [])]) {
          if (kw.includes(fa) || fa.includes(kw)) crossHits.push(`「${kw}」被要求必含（${bName}）但被禁止（${aName}：${fa}）`);
        }
      }
      for (const hit of [...new Set(crossHits)].slice(0, 4)) conflicts.push({ level: 'warning', message: hit });
      // 固定一级章节列表冲突
      const aHeadings = a.rules.exactHeadings || [];
      const bHeadings = b.rules.exactHeadings || [];
      if (aHeadings.length > 0 && bHeadings.length > 0) {
        const bSet = new Set(bHeadings);
        const aSet = new Set(aHeadings);
        const diff = [...new Set([...aHeadings.filter(h => !bSet.has(h)), ...bHeadings.filter(h => !aSet.has(h))])];
        if (diff.length > 0) {
          conflicts.push({ level: 'warning', message: `固定一级章节列表不一致：${aName} 要求 ${aHeadings.length} 章，${bName} 要求 ${bHeadings.length} 章（差异：${diff.slice(0, 3).join('、')}）。生成时将合并去重。` });
        }
      }
      // 封面/目录策略冲突
      for (const policy of ['coverPolicy', 'tocPolicy'] as const) {
        const av = a.rules[policy];
        const bv = b.rules[policy];
        if (av && bv && av !== 'unspecified' && bv !== 'unspecified' && av !== bv) {
          conflicts.push({ level: 'warning', message: `${policy === 'coverPolicy' ? '封面' : '目录'}策略冲突：${aName} 要求「${av === 'required' ? '生成' : '禁止'}」，${bName} 要求「${bv === 'required' ? '生成' : '禁止'}」。生成时以禁止优先。` });
        }
      }
      // 最低字数冲突
      if (a.rules.minWords && b.rules.minWords && a.rules.minWords !== b.rules.minWords) {
        conflicts.push({ level: 'warning', message: `最低字数要求不一致：${aName} ${a.rules.minWords} 字 vs ${bName} ${b.rules.minWords} 字。生成时将取最大值 ${Math.max(a.rules.minWords, b.rules.minWords)} 字。` });
      }
    }
  }
  return conflicts;
}
