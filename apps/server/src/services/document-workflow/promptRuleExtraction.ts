import type { DocumentEvidence, DocumentGenerationDiagnostics, DocumentTemplate, DocumentTemplateChapter, PromptChapterStructuralRule, PromptDocumentRuleSet, RuleExtractionTrace, RuntimePromptRuleSet } from './types';
import { documentTextLength } from './budget';
import { buildEvidenceBundle, evidenceBundlePrompt, evidencePromptBudgetForTarget } from './evidence';
import { callDocumentLlmJson } from './llmClient';
import { displayChapterTitle, isFragmentLikeSectionTitle, normalizePlannedSectionTitle } from './outline';
import { docSystemPrefix } from './markdownComposer';
import { isStructuralLabelTitle } from './templatingGovernance';
import { isDegenerateSectionTitle } from './sectionNamingGovernance';
import { DIVERSITY_PLANNING_TEMPERATURE } from './diversityProfile';

/** 清单层小节标题清洗（确定性结构清洗）：词尾等长严格重复去重（「要点要点」→「要点」，与成稿 H4 清洗同口径）。
 * 语义级粘连不属此处职责（交治理器与审校）。 */
export function cleanSectionTitleArtifacts(title: string) {
  return title.replace(/(.*?)(.{2,4})\2$/u, '$1$2');
}

export function professionalSectionTaskCard(chapterTitle: string, sectionTitle: string) {
  const joined = `${chapterTitle} ${sectionTitle}`;
  const points = [
    /项目主要施工内容/u.test(joined) ? '每个施工工作包（#### 工作包名）必须逐包覆盖三方面要素：①作业对象与工程量（本项目部位、规模、系统边界，工程量数值与工程量清单汇总值一致）、②工序顺序（先后清晰，至少 1 处不少于 4 个环节的工序顺序表达）、③施工方法（工具机具、工艺参数、验收闭环）；只写流程不写概况、或只列方法不写流程的工作包会被退回重写；每个专业工程单独一个小节，不得把所有专业工程合并；不得使用 Markdown 表格，严禁出现“分部小计/本页小计/合计/按实/暂估/综合单价/措施项目费/规费/税金”等清单计价表内部口径词（“措施项目”作为专业工程类别名称可用，不得与“清单/计价/费”连用）。' : '',
    // F1 组合规则（丰乐镇第五轮实测：劳动力安排计划章缺「资源配置计划」小节——LLM 判该小节与劳动力
    // 主题弱相关，返回空泛内容被节级质检拒，小节留空 → 章节节点 failed「缺少规划小节」）
    /劳动力/u.test(chapterTitle) && /资源配置/u.test(sectionTitle) ? '本节是劳动力章内的资源配置计划：只写劳动力资源，不得写机械设备、材料物资（由物资/机械章承担）——必须展开①工种结构与人数（钢筋工/木工/瓦工/普工等各工种人数，来自绑定资料，无资料时按本项目工程量与总工期推导并写明推导依据）②分阶段劳动力投入计划（施工准备/主体/收尾各阶段进退场人数与班组数，可用表格）③作业面/施工段配员与班组划分④劳动力来源、组织与工资保障措施。每个数值必须可溯源（资料事实或推导说明），禁止只写“合理配置劳动力”“满足施工需要”等空泛表述。' : '',
    /工程特点|施工条件|重难点|难点/u.test(joined) ? '必须写出本工程的重难点分析：每条重难点按“名称＋形成原因（归因）＋影响范围＋专项措施＋量化控制目标（数值＋单位，如控制率%/偏差mm/频次每日1次）”展开，可附「重难点识别表」（表头：重难点|形成原因|影响范围|专项措施|责任岗位，数据行至少3条，每条必须写形成原因）；禁止只写“本项目存在XX难点”而不写原因与对策。' : '',
    /概况|工程|项目/u.test(joined) ? '必须落入项目名称、范围、地点、规模、工期、质量目标等资料事实；说明编制边界。' : '',
    /部署|总体|组织/u.test(joined) ? '必须说明施工组织逻辑、施工段/专业接口、资源进场和管理闭环。' : '',
    /进度|工期/u.test(joined) ? '必须围绕总工期、关键线路、资源保障、穿插施工和纠偏机制展开。' : '',
    /质量/u.test(joined) ? '必须覆盖材料验收复验、过程检查、隐蔽验收、整改复验和质量资料归档。' : '',
    /安全|文明|风险|危大/u.test(joined) ? '必须覆盖风险识别、人员设备、临电消防、现场文明、检查整改和应急响应。' : '',
    /资源|材料|设备|劳动力/u.test(joined) ? '必须说明资源配置依据、进场验收、保管调配，并与工期和质量目标一致。' : '',
    // R9 写入侧（舒城第二轮实测）：劳资小节必须写入工伤保险参保与农民工工资支付合规要求，
    // 避免终检「工伤保险表述缺失」blocker；触发口径与最终校验词面门控一致（劳务/农民工/用工/工资）
    /劳务|农民工|用工|工资/u.test(joined) ? '劳务用工/工资类内容必须写入政策合规硬项：按规定为全体作业人员办理工伤保险（保险费用由企业承担并计入投标报价，进场前完成参保并留存缴费凭证）；农民工工资实行专用账户与总包代发、按月足额支付，写清实名制用工与进场登记。不得只写“依法用工”“按时发放工资”等无落实细节的表述。' : '',
    /施工|工艺|技术|方案/u.test(joined) ? '必须写清施工准备、工艺流程、关键控制点、验收要求和资料依据；每个分项工程方案必须落位至少 4 个工艺参数（mm、MPa、间距、偏差、坡度、养护天数、试验压力、搭接长度等），参数来自绑定资料或行业通用规范值，不得编造；纯设备配置型内容必须写型号、规格、容量、数量参数。工序顺序表达：工艺流程必须有明确的工序顺序表达，形式按小节序号轮换使用（顺序词叙述、编号步骤、有序列表、箭头链；系统已为各小节指定形式，禁止相邻小节同一形式、禁止通篇同一形式），每个含方法叙述的三级小节方法段正文至少 1 处不少于 4 个环节的工序顺序表达，不得只在单独的流程行出现。' : '',
    /流程|顺序|工序|穿插|闭环|整改|演练|转运|三检|隐蔽|排查/u.test(joined) ? '流程/顺序型叙述必须有明确的工序顺序表达，形式按小节序号轮换使用（顺序词叙述、编号步骤、有序列表、箭头链，禁止相邻小节同一形式、禁止通篇同一形式），每条序列不少于 3 个环节，把纯文字流程描述改写成顺序清晰的表达（如先发现问题并登记建档，再分析原因，随后整改落实，最后复查销号），正文中至少 2 处工序顺序表达。' : '',
  ].filter(Boolean);
  const arrowChainPoint = points.find(point => point.includes('工序顺序表达'));
  return ['【小节专业任务卡】', `任务对象：${sectionTitle}`, ...(points.length ? points : ['必须结合本项目资料明确事实说明对象范围、实施方法、控制要点、验收要求和资料闭环，避免泛化套话。']), ...(arrowChainPoint ? ['工序顺序表达是硬性内容要求：正文成稿必须实际出现工序顺序表达，形式按小节序号轮换使用（顺序词叙述、编号步骤、有序列表、箭头链，系统已为各小节指定形式），评审将核验，未达标会被退回重写。'] : []), '禁止套话：不得使用“本小节围绕……展开”“结合绑定项目资料、施工组织安排和现场实施条件”“交底覆盖率按100%控制”等模板化开篇；不得只写“加强管理、严格把控、确保质量”式口号；每个三级小节必须写与本节标题对应的专属内容，不得与其他小节内容相同或近似；每个句子必须携带至少一个信息载体（数值、部位、材料、工序、岗位、时限其一），无信息载体的空泛句不得出现（如“加强过程管控”应改为“施工员每日检查不少于2次，发现问题当日整改销项”）。'].join('\n');
}

function isInstructionLikeSectionTitle(title: string) {
  const normalized = normalizePlannedSectionTitle(title).replace(/\s+/gu, '');
  if (!normalized) return true;
  if (/^(?:目录|章节|大纲|要求|说明|注意|输出|格式|示例|例如|写法|占位|提示)$/u.test(normalized)) return true;
  // 指令泄漏核心句式（条件句开头）；历史宽泛句式正则（"根据/结合...判断"、"注意事项"裸词等）已随治理器收口删除
  return /^(?:判断|判定|识别|确认)?是否(?:涉及|涉|需要|适用)|^(?:如|若|如果)(?:涉及|不涉及|适用|不适用)/u.test(normalized);
}

export function isInvalidPlannedSectionTitle(title: string, chapterTitle: string) {
  const normalized = normalizePlannedSectionTitle(title);
  const normalizedChapter = normalizePlannedSectionTitle(chapterTitle);
  if (normalized.length < 4 || normalized.length > 60) return true;
  if (normalized === normalizedChapter) return true;
  if (isInstructionLikeSectionTitle(normalized)) return true;
  if (/^(?:目标与范围|资料依据|实施内容|质量控制|概述|总体要求)$/u.test(normalized)) return true;
  // WS1 结构标签独立成题黑名单（与终检 templatedLabelIssues 同源判定）：规划出的「施工概况/施工流程/施工方法」
  // 等标签小节名一律拒收——结构入后台、表达回前台（历史缺陷：分项章被三段标签统治，段首标签 40 处 + 同名标签 H4 三组）
  if (isStructuralLabelTitle(normalized)) return true;
  if (/^(?:雨季|冬季|高温|台风|大风等特殊气候|雨季、冬季、高温、台风、大风等特殊气候)$/u.test(normalized)) return true;
  if (/如需|应由|大模型|提示词|上下文|动态规划|OUTLINE|章节生成|按照.*明确指定|需求和资料|JSON|小节标题/u.test(normalized)) return true;
  if (/(.)\1/u.test(normalized)) return true;
  // 退化标题单源检测（治理器）：整体重复（「装饰装饰」）与相邻重复同口径（历史此处仅相邻重复）
  if (isDegenerateSectionTitle(normalized)) return true;
  // 条款碎片/指令泄漏型标题（与规划器 planDocument 同口径剔除）
  if (isFragmentLikeSectionTitle(normalized)) return true;
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

/** 规划小节归一去重（E-1 规划卫生）：归一化标题（去编号/空白/标点）等价者只保留首次出现，
 * 防「基坑开挖与支护/基坑开挖及支护」等近名小节重复落位造成正文碎片化 */
export function dedupePlannedSections(sections: string[]) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const section of sections) {
    const key = normalizePlannedSectionTitle(section).replace(/[\s()（）:：.。；;,，、\-—]/gu, '');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(section);
  }
  return out;
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

export function normalizePlannedSections(sections: string[] = [], chapterTitle: string) {
  const result: string[] = [];
  for (const section of sections) {
    const title = cleanSectionTitleArtifacts(normalizePlannedSectionTitle(section));
    if (!title || isInvalidPlannedSectionTitle(title, chapterTitle)) continue;
    if (!result.some(item => sectionTitleEquivalent(item, title))) result.push(title);
  }
  return result;
}

/** 每章小节总数上限：锁定小节（用户声明：提示词强制/模板或 OUTLINE 已提供）不受截断，上限只约束 LLM 规划增量 */
export const MAX_CHAPTER_SECTIONS = 12;

/** LLM 规划产出的表格需求项：表名 + 表头字段（字段可为空，写作时按表名与所在小节内容确定） */
export interface PlannedTableRequest {
  title: string;
  fields: string[];
}

function evidenceParameterDensity(evidence: DocumentEvidence[]) {
  const text = evidence.map(item => `${item.sectionTitle || ''}\n${item.content}`).join('\n').slice(0, 30000);
  const matches = text.match(/\d+(?:\.\d+)?\s*(?:mm|cm|m|km|㎡|m²|m3|m³|kg|g|t|L|ml|MPa|kPa|℃|%|台|套|个|项|批|次|份|人|小时|分钟|日历天|天|周|月|年|万元|元)|DN\s*\d+|Φ\s*\d+|φ\s*\d+|C\d{2,}|HRB\d+|GB\/?T?\s*[\w.-]+|JGJ\s*[\w.-]+/giu) || [];
  return new Set(matches.map(item => item.replace(/\s+/gu, ''))).size;
}

/** 小节数规划目标建议（仅用于规划提示词的目标参数）：按目标字数与证据参数密度给出建议数量，
 * 不再作为确定性补位下限——小节结构只来自用户声明与 LLM 规划，系统不生成任何小节 */
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


/**
 * 统一融合小节规划（所有章同一条路）：locked（用户声明：提示词强制小节 + 模板/OUTLINE 已提供小节）
 * 置前锁定，LLM 基于提示词、项目资料与图谱全量规划专业工作面，融合去重后输出；同时规划本章需要的
 * 表格需求（表名+表头字段，写作期按此注入表格硬性要求）。小节结构只来自用户声明与 LLM 规划，
 * 系统不生成任何小节：LLM 失败时保留锁定结构继续；无锁定结构且规划失败/无产出即显性失败（throw），不凑数补位。
 */
export async function planChapterSectionsWithLlm(input: { template: DocumentTemplate; chapter: DocumentTemplateChapter; chapterIndex?: number; evidence: DocumentEvidence[]; promptTexts: string; projectContext: string; requirement?: string; roleContext: string; targetWords: number; projectGraphSummary?: string; lockedSections?: string[]; signal?: AbortSignal; diagnostics?: DocumentGenerationDiagnostics; diversity?: { directive: string; avoidSections?: string[]; overlapCheck?: (sections: string[]) => string[] } }): Promise<{ sections: string[]; tables: PlannedTableRequest[]; diversity?: { retried: boolean; remainingCollisions: number } }> {
  const locked = normalizePlannedSections(input.lockedSections || [], input.chapter.title);
  const evidenceText = evidenceBundlePrompt(buildEvidenceBundle(input.chapter, input.evidence), { maxChars: evidencePromptBudgetForTarget(input.targetWords, 5000, 12000), diagnostics: input.diagnostics });
  const minSections = minimumSectionCount(input.chapter, input.targetWords, input.evidence, locked.length);
  const maxSections = Math.max(minSections, Math.min(7, input.targetWords >= 8000 ? 7 : 6));
  // 编排约定：章节顺序只靠提示词指令引导，不做代码硬排与重规划反馈（禁止确定性兜底）
  const overviewChapter = input.chapterIndex === 0 || /编制说明|工程概况|项目概况/u.test(input.chapter.title);
  const planOnce = async (verificationFeedback = '') => {
    const result = await callDocumentLlmJson<{ sections?: string[]; tables?: Array<{ title?: string; fields?: string[] }> }>([
      docSystemPrefix('你是专业文档结构规划专家。'),
      '只根据用户提示词、章节标题和真实绑定资料规划本章二级小节。',
      '施工组织、技术措施、资源配置、质量、安全、工期、材料、设备、劳动力、危大工程等核心章节必须拆成足够的专业工作面，不得只输出两个泛化小节。',
      '危大工程判定、危险性分级、专家论证要求等危大内容只允许落位在危大工程专项章节或基坑支护相关小节，其他章节不得规划危大清单/危大判定类小节，避免分级结论散落多处产生口径矛盾；危大清单表格只列资料参数确认达到判定阈值的类别，不得列入正文声明“本工程无/未涉及”的类别，防止清单与排除声明自相矛盾。',
      '小节标题必须直接属于本章主题域：例如“人材机保障/资源配置”章只允许劳动力、材料、机械设备、周转类标题；不得规划本章主题域之外的内容小节。',
      locked.length ? `本章锁定二级小节（提示词强制要求/模板或 OUTLINE 已提供，必须按此顺序置于小节清单最前，不得删除、改名或重排）：${locked.join('、')}` : '',
      overviewChapter ? '本章是全文第一章：若规划出“编制说明与工程概况”类小节，必须置于小节清单第一位，不得排在任何其他小节之后。' : '',
      input.diversity?.directive || '',
      '只返回 JSON。',
    ].filter(Boolean).join('\n'), [
      `文档模板：${input.template.name}`,
      `章节标题：${input.chapter.title}`,
      input.chapter.purpose && !isInvalidPlannedSectionTitle(input.chapter.purpose, input.chapter.title) ? `章节目的：${input.chapter.purpose}` : '',
      input.requirement ? `用户要求：${input.requirement}` : '',
      input.projectContext ? `上下文：\n${input.projectContext}` : '',
      input.projectGraphSummary ? `本项目专业工程与资源图谱：\n${input.projectGraphSummary}` : '',
      input.roleContext,
      input.diversity?.avoidSections?.length ? `以下小节标题已在历史文档中使用，本次命名必须避开相同或高度近似的表达（等价内容换角度、换词面，不得只调整语序或添加“工作/内容”尾词）：\n${input.diversity.avoidSections.slice(0, 60).map(title => `- ${title}`).join('\n')}` : '',
      input.promptTexts ? `配置写作主控提示词：\n${input.promptTexts}` : '',
      evidenceText ? `真实绑定资料：\n${evidenceText}` : '',
      `请输出 ${minSections}-${maxSections} 个适合直接成稿的二级小节标题。标题必须具体、业务相关、能承载真实资料；每个标题控制在 16 个汉字以内，避免多个小节表达同一内容。`,
      '如本章需要输出管理表格或清单（投入计划表、控制要点表、验收清单、管控台账、检查记录表等），必须在 tables 中逐表给出表名与表头字段（字段名必须具体、可填）；不需要表格时 tables 返回空数组。',
      verificationFeedback ? `上一轮规划存在以下必须修正的问题：\n${verificationFeedback}` : '',
      'JSON 格式：{"sections":["小节标题1","小节标题2"],"tables":[{"title":"表名","fields":["字段1","字段2"]}]}',
    ].filter(Boolean).join('\n\n'), { maxTokens: 2400, temperature: DIVERSITY_PLANNING_TEMPERATURE, signal: input.signal, diagnostics: input.diagnostics });
    const plannedItems: string[] = [];
    for (const raw of result?.sections || []) {
      const title = cleanSectionTitleArtifacts(normalizePlannedSectionTitle(String(raw)));
      if (!title || isInvalidPlannedSectionTitle(title, input.chapter.title)) continue;
      if (!plannedItems.some(item => sectionTitleEquivalent(item, title))) plannedItems.push(title);
    }
    // 融合：锁定小节置前（用户声明结构不可删改），LLM 规划增量去重并入；
    // E-1 规划卫生：归一化标题等价者只保留首次出现；上限只约束 LLM 增量，锁定小节不被截断
    const merged = [...locked];
    for (const title of plannedItems) {
      if (!merged.some(item => sectionTitleEquivalent(item, title))) merged.push(title);
    }
    const sections = dedupePlannedSections(merged).slice(0, Math.max(MAX_CHAPTER_SECTIONS, locked.length));
    const tables: PlannedTableRequest[] = [];
    for (const item of result?.tables || []) {
      const title = cleanSectionTitleArtifacts(normalizePlannedSectionTitle(String(item?.title || '')));
      if (!title || isInvalidPlannedSectionTitle(title, input.chapter.title)) continue;
      if (tables.some(existing => sectionTitleEquivalent(existing.title, title))) continue;
      tables.push({ title, fields: (item?.fields || []).map(field => String(field).trim()).filter(Boolean).slice(0, 12) });
    }
    return { sections, tables };
  };
  let planned: { sections: string[]; tables: PlannedTableRequest[] };
  try {
    planned = await planOnce();
  } catch (error) {
    if (locked.length > 0) {
      console.error(`[plan] 小节规划 LLM 调用失败（保留锁定小节 ${locked.length} 个继续）：${input.chapter.title}，${error instanceof Error ? error.message : String(error)}`);
      return { sections: locked, tables: [] };
    }
    throw error;
  }
  // 统一核验-反馈框架（上限 1 轮）：首章概况小节置首核验 + 指纹撞名核验合并为一次反馈，
  // 第二轮一次性消化全部核验问题；二次核验未清零不阻断（多样性是软质量，不能让生成失败）
  const verifyPlan = (titles: string[]) => {
    const feedback: string[] = [];
    if (overviewChapter && titles.length > 0 && !/编制说明|工程概况|项目概况/u.test(titles[0]!)) {
      const overviewIndex = titles.findIndex(title => /编制说明|工程概况|项目概况/u.test(title));
      // 条件语义与提示词一致：仅“规划出但未置首”才反馈；完全未规划该类小节不强制补（不臆造结构）
      if (overviewIndex > 0) feedback.push(`本章是全文第一章，“编制说明与工程概况”类小节必须置于小节清单第一位（当前排在第 ${overviewIndex + 1} 位）。`);
    }
    const collisions = input.diversity?.overlapCheck ? input.diversity.overlapCheck(titles) : [];
    if (collisions.length > 0) feedback.push(`以下小节标题与历史文档高度近似，必须换角度、换表述重新命名（不得只调整语序或添加“工作/内容”尾词）：${collisions.slice(0, 8).join('；')}。`);
    return { feedback, collisions };
  };
  const firstCheck = verifyPlan(planned.sections);
  if (firstCheck.feedback.length === 0) return planned;
  let diversity: { retried: boolean; remainingCollisions: number } = { retried: true, remainingCollisions: firstCheck.collisions.length };
  try {
    planned = await planOnce(firstCheck.feedback.join('\n'));
  } catch (error) {
    console.warn(`[plan] 核验反馈重规划失败（保留首轮结果）：${input.chapter.title}，${error instanceof Error ? error.message : String(error)}`);
    return { ...planned, diversity };
  }
  const secondCheck = verifyPlan(planned.sections);
  diversity = { retried: true, remainingCollisions: secondCheck.collisions.length };
  if (secondCheck.collisions.length > 0) console.warn(`[plan] 二次核验仍存在历史撞名（接受，不阻断）：${input.chapter.title}，${secondCheck.collisions.slice(0, 4).join('；')}`);
  if (secondCheck.feedback.some(item => item.includes('第一位'))) console.error(`[plan] 二次核验首章概况小节仍未置于首位：${input.chapter.title}`);
  return { ...planned, diversity };
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

/** 提示词保存前预检：轻量复用运行时规则抽取（纯正则，无 LLM 调用）；同步展示按章识别到的强制小节（写入提示词即可见的锁定结构） */
export function previewPromptRules(content: string): PromptRulePreview {
  const rules = buildRuntimePromptRules({ promptTexts: content });
  const structuralRules = extractPromptStructuralRules(content);
  const lockedSectionLines = structuralRules
    .filter(rule => rule.requiredSections.length > 0)
    .map(rule => `第${(rule.chapterIndex ?? 0) + 1}章${rule.chapterTitle ? `（${rule.chapterTitle}）` : ''}强制小节（按序锁定）：${rule.requiredSections.slice().sort((a, b) => (a.order || 0) - (b.order || 0)).map(section => section.title).join('、')}`);
  return {
    recognized: rules.executionSummary.length > 0 || lockedSectionLines.length > 0,
    summary: [...rules.executionSummary, ...lockedSectionLines],
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
