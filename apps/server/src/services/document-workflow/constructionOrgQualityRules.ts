import type { DocumentDraftChapter, DocumentFactsModel, DocumentTemplateChapter, ValidationIssue } from './types';
import { inferConstructionOrgProjectTypes, type ConstructionOrgProjectType } from './constructionOrgCatalog';
import { DIVISION_PROCESS_LABEL_RE, DIVISION_SECTION_QUALITY, DIVISION_SECTION_RE } from './writingSpec';
import { hasProcessSequenceExpression, workPackageContentElementsComplete } from './utils';
import { buildSemanticGate } from './semanticGate';

/** 空话词表：词面只做召回（短路优化），语义判定由语义 gate 复核完成（阶段五——"精心组织"类口号
 * 出现在具体措施语境（如"精心组织劳动力进场"）不得误报空泛套话） */
export const CONSTRUCTION_ORG_GENERIC_PHRASES = [
  '精心组织', '科学管理', '精益求精', '全力保障', '高效推进', '力争一流',
  '最大限度', '显著提升', '大力落实', '充分确保', '严格把控',
];

/** 空话词表合并召回正则 */
const CONSTRUCTION_ORG_GENERIC_LEXICAL_RE = new RegExp(CONSTRUCTION_ORG_GENERIC_PHRASES.join('|'), 'u');

/** 空泛套话语义原型（正例）：无实质动作的口号式表述基准（bge 余弦 ≥ 阈值判定空话） */
const CONSTRUCTION_ORG_GENERIC_SEMANTIC_PROTOTYPES = [
  '精心组织科学管理确保工程质量',
  '严格把控质量安全进度各项指标',
  '最大限度提升项目管理水平',
  '全力保障项目顺利推进',
  '大力落实各项管理措施',
] as const;

/** 具体措施语义原型（负例保护）：含空话词面但语义属落地动作不得误报 */
const CONSTRUCTION_ORG_GENERIC_LEGAL_PROTOTYPES = [
  '精心组织劳动力分批进场并登记交底',
  '每道工序完成后实测实量并记录数据',
  '混凝土浇筑后每天洒水养护不少于两次',
] as const;

/** 构建空话语义 gate：词面召回 + 语义复核（semanticGate 统一入口） */
async function buildGenericPhraseGate(embedDocuments?: (texts: string[]) => Promise<number[][]>): Promise<(texts: string[]) => Promise<boolean[]>> {
  return buildSemanticGate({
    prototypes: [...CONSTRUCTION_ORG_GENERIC_SEMANTIC_PROTOTYPES],
    negativePrototypes: [...CONSTRUCTION_ORG_GENERIC_LEGAL_PROTOTYPES],
    lexicalHints: CONSTRUCTION_ORG_GENERIC_LEXICAL_RE,
    embedDocuments,
  });
}

const CONTROL_LOOP_RULES: Array<{ pattern: RegExp; label: string; required: string[]; prompt: string }> = [
  { pattern: /质量|验收|隐蔽|样板|通病/u, label: '质量闭环', required: ['自检', '互检', '交接检', '整改', '复查', '归档'], prompt: '质量类内容必须形成“自检—互检—交接检—整改—复查—资料归档”闭环。' },
  { pattern: /安全|风险|危大|临电|消防|吊装|高处/u, label: '安全闭环', required: ['辨识', '交底', '检查', '整改', '复查', '销项'], prompt: '安全类内容必须形成“风险辨识—专项交底—现场检查—隐患整改—复查销项”闭环。' },
  { pattern: /进度|工期|节点|计划/u, label: '进度闭环', required: ['计划', '检查', '偏差', '纠偏', '复核'], prompt: '进度类内容必须形成“计划分解—日/周检查—偏差识别—资源纠偏—节点复核”闭环。' },
  { pattern: /文明|扬尘|噪声|绿色|环保|垃圾/u, label: '环保闭环', required: ['监测', '预警', '处置', '台账'], prompt: '文明环保类内容必须形成“监测—预警—联动处置—台账记录”闭环。' },
  { pattern: /工资|劳务|实名/u, label: '工资闭环', required: ['实名', '考勤', '核算', '公示', '代发', '归档'], prompt: '工资保障类内容必须形成“实名登记—考勤—核算—公示—银行代发—归档”闭环。' },
  { pattern: /应急|预案|救援|事故/u, label: '应急闭环', required: ['发现', '警戒', '疏散', '处置', '上报', '复盘'], prompt: '应急类内容必须形成“发现险情—警戒疏散—初期处置—救援上报—复盘整改”闭环。' },
];

const PROCESS_CHAINS: Record<Exclude<ConstructionOrgProjectType, 'general'>, { label: string; chain: string[]; forbidden: string[]; prompt: string }> = {
  building: {
    label: '房建工程',
    chain: ['施工准备', '土方/基础', '主体结构', '二次结构', '防水', '机电安装', '装饰装修', '室外工程', '竣工验收'],
    forbidden: ['管道闭水试验', '沥青摊铺', '水稳层', '交通导改'],
    prompt: '房建类章节应按“施工准备—基础—主体—二次结构—防水—机电—装饰—室外—验收”组织，不得混入市政道路工序。',
  },
  municipal: {
    label: '市政工程',
    chain: ['测量放线', '管线探测', '围挡导行', '沟槽/路基', '管道/结构', '回填', '水稳/沥青/铺装', '标线设施', '验收移交'],
    forbidden: ['主体结构', '二次结构', '塔吊', '外脚手架', '屋面防水'],
    prompt: '市政类章节应按“测量放线—管线探测—围挡导行—沟槽/路基—管道/结构—回填—路面恢复—验收移交”组织，不得写成房建主体结构逻辑。',
  },
  renovation: {
    label: '老旧小区改造',
    chain: ['居民沟通', '分区施工', '既有保护', '外墙/屋面/管网改造', '扰民控制', '竣工恢复'],
    forbidden: ['大面积深基坑', '高支模', '大体量主体结构', '长距离交通导改'],
    prompt: '老旧小区改造类章节必须体现“居民沟通—分区施工—既有保护—改造作业—扰民控制—竣工恢复”，不得忽略居民通行和既有设施保护。',
  },
  decoration: {
    label: '装饰装修工程',
    chain: ['基层处理', '防水闭水', '吊顶龙骨', '墙地面铺装', '细部收口', '成品保护', '空气质量验收'],
    forbidden: ['深基坑', '路基压实', '水稳层', '沥青摊铺', '大体量土方'],
    prompt: '装饰装修类章节应按“基层处理—防水闭水—吊顶墙面—地面铺装—细部收口—成品保护—空气质量验收”组织，不得混入基坑、路基等无关内容。',
  },
};

const BONUS_MODULES = [
  { title: '招标评分项响应索引', pattern: /技术标|施工组织设计|评分|响应/u, prompt: '设置招标评分项响应索引，逐项对应章节、响应内容和位置。' },
  { title: '主要工程量一览表', pattern: /工程量|清单|土方|钢筋|混凝土|管道|路面/u, prompt: '将主要工程量表格化，关联资源配置和进度节点。' },
  { title: '影像资料留存', pattern: /隐蔽|危大|整改|验收|样板/u, prompt: '隐蔽、危大、材料验收、样板和整改前后对比必须留存影像资料。' },
  { title: '变更签证管理', pattern: /改造|市政|工期紧|变更|签证/u, prompt: '改造、市政或工期紧项目应补充变更识别、技术核定、签证资料和影响跟踪。' },
  { title: '危险品专项管理', pattern: /装修|装饰|动火|油漆|稀释剂|氧气|乙炔/u, prompt: '涉及动火、油漆、稀释剂、氧气乙炔时应补充危险品分区存放与动火审批。' },
  { title: '材料损耗与周转控制', pattern: /钢筋|模板|周转|材料|大体量/u, prompt: '体量大或材料占比高时应补充钢筋翻样、模板周转、余料回收和限额领料。' },
  { title: '分户验收', pattern: /住宅|住户|交付|分户/u, prompt: '住宅项目应补充分户实测、问题清单、整改销项和交付资料。' },
];

function normalize(text: string) {
  return text.replace(/\s+/gu, '').toLowerCase();
}

function isConstructionOrgContext(text: string) {
  return /施工组织设计|施工组织|施组|技术标|施工方案|质量|安全|文明施工/u.test(text);
}

export function constructionOrgChapterRulePrompt(chapter: DocumentTemplateChapter) {
  const title = `${chapter.title} ${(chapter.sections || []).join(' ')}`;
  if (!isConstructionOrgContext(title)) return '';
  const loops = CONTROL_LOOP_RULES.filter(rule => rule.pattern.test(title)).map(rule => `- ${rule.prompt}`);
  const bonus = BONUS_MODULES.filter(bonusModule => bonusModule.pattern.test(title)).map(bonusModule => `- 高分补充：${bonusModule.prompt}`);
  return [
    '【施工组织设计专项写作规则】',
    '- 禁止空话套话：不要只写“加强管理、严格控制、确保质量、精心组织、科学管理”，必须写成“责任岗位+执行动作+量化标准+检查频次+整改时限+复查销项”。',
    '- 每项措施至少包含责任主体、执行标准、检查频次、整改闭环；项目特有数据必须来自资料或图谱。',
    ...loops,
    ...bonus,
  ].join('\n');
}

export function constructionOrgBlueprintRuleLines(chapter: DocumentTemplateChapter) {
  const prompt = constructionOrgChapterRulePrompt(chapter);
  return prompt ? prompt.split('\n').map(line => `   - ${line}`) : [];
}

export function constructionOrgProjectTypePrompt(input: { templateName: string; outputTitle?: string; requirement?: string; chapters: DocumentTemplateChapter[] }) {
  const projectTypes = inferConstructionOrgProjectTypes({ template: { id: 'runtime', name: input.templateName, outputTitle: input.outputTitle || '', description: '', category: '', chapters: input.chapters }, chapters: input.chapters, requirement: input.requirement });
  const prompts = projectTypes
    .filter((type): type is Exclude<ConstructionOrgProjectType, 'general'> => type !== 'general')
    .map(type => PROCESS_CHAINS[type].prompt);
  return prompts.length ? `【专业工序链约束】\n${prompts.map(prompt => `- ${prompt}`).join('\n')}` : '';
}

export async function constructionOrgGenericLanguageIssues(
  chapters: DocumentDraftChapter[],
  embedDocuments?: (texts: string[]) => Promise<number[][]>,
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const judge = await buildGenericPhraseGate(embedDocuments);
  for (const chapter of chapters) {
    const sentences = chapter.content.split(/[。；;\n]/u).map(sentence => sentence.trim()).filter(sentence => sentence.length >= 8);
    if (sentences.length === 0) continue;
    const flags = await judge(sentences);
    const hits = new Set<string>();
    sentences.forEach((sentence, index) => {
      if (!flags[index]) return;
      for (const phrase of CONSTRUCTION_ORG_GENERIC_PHRASES) {
        if (sentence.includes(phrase)) hits.add(phrase);
      }
    });
    if (hits.size > 0) {
      issues.push({
        level: 'warning',
        message: `${chapter.title} 存在施工组织设计空泛套话：${[...hits].slice(0, 8).join('、')}`,
        suggestion: '请按“责任岗位+执行动作+量化标准+检查频次+整改时限+复查销项”重写相关措施。',
      });
    }
  }
  return issues;
}

export function constructionOrgControlLoopIssues(chapters: DocumentDraftChapter[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const chapter of chapters) {
    const scope = `${chapter.title} ${(chapter.sections || []).join(' ')}`;
    for (const rule of CONTROL_LOOP_RULES) {
      if (!rule.pattern.test(scope)) continue;
      const missing = rule.required.filter(token => !chapter.content.includes(token));
      if (missing.length >= Math.ceil(rule.required.length / 2)) {
        issues.push({ level: 'warning', message: `${chapter.title} 缺少${rule.label}关键链条：${missing.join('、')}`, suggestion: rule.prompt });
      }
    }
  }
  return issues;
}

export function constructionOrgProfessionalChainIssues(input: { markdown: string; factsModel: DocumentFactsModel; chapters: DocumentDraftChapter[] }): ValidationIssue[] {
  const context = normalize(`${input.markdown} ${input.factsModel.project.map(fact => fact.value).join(' ')} ${input.factsModel.preciseFacts.map(fact => fact.value).join(' ')}`);
  const issues: ValidationIssue[] = [];
  for (const rule of Object.values(PROCESS_CHAINS)) {
    const chainHits = rule.chain.filter(token => context.includes(normalize(token)));
    const explicitlyMatched = new RegExp(rule.label, 'u').test(input.markdown) || chainHits.length >= 3;
    if (!explicitlyMatched) continue;
    const forbiddenHits = rule.forbidden.filter(token => context.includes(normalize(token)));
    if (forbiddenHits.length >= 2) {
      issues.push({ level: 'warning', message: `疑似${rule.label}内容混入不匹配工序：${forbiddenHits.join('、')}`, suggestion: rule.prompt });
    }
    if (chainHits.length < Math.min(3, rule.chain.length)) {
      issues.push({ level: 'warning', message: `${rule.label}工序链覆盖不足：仅识别到 ${chainHits.join('、') || '未识别到关键工序'}`, suggestion: rule.prompt });
    }
  }
  return issues;
}

export function constructionOrgBonusModulePrompt(chapter: DocumentTemplateChapter) {
  const text = `${chapter.title} ${(chapter.sections || []).join(' ')} ${(chapter.queries || []).join(' ')}`;
  const matched = BONUS_MODULES.filter(bonusModule => bonusModule.pattern.test(text));
  if (matched.length === 0) return '';
  return ['【隐藏高分模块触发】', ...matched.map(bonusModule => `- ${bonusModule.title}：${bonusModule.prompt}`)].join('\n');
}

function extractMajorConstructionSection(content: string) {
  const lines = content.split('\n');
  // 容忍标题内空格（十度实测：“项目主要施工 内容”带空格导致精确匹配落空误报缺失）；
  // 接受 H4 层级（十一度实测：正文产出“### 1.3 施工内容与现场条件保障 / #### 1.3.1 项目主要施工内容”，
  // 小节位于 H4 时仍应校验其内部专业工程块，标题块由 validateContent 剥离）
  let start = lines.findIndex(line => /^#{3,4}\s+(?:\d+(?:\.\d+)*\s+)?(?:项目主要施工\s*内容|主要施工\s*内容)\s*$/u.test(line.trim()));
  if (start < 0) {
    // 锚点标题被合并重写（真实生成缺陷：planner 输出“工程概况与主要施工内容”主题块，工作包缺失时
    // 精确匹配落空误报缺失）：仅当合并块内所有 #### 子块均为三要素齐全的工作包（4.17.9 内容要素判定，
    // 标签字面不再作为识别依据——Writer 自然成文时标签缺省不应导致兜底失效）且不少于 5 个时才认定为
    // 有效的主要施工内容；否则维持“小节缺失”语义，交由 Final Gate 追加
    // “### 项目主要施工内容”修复，避免把概况型子块误当工作包校验产生不可修复的硬阻断
    const mergedStart = lines.findIndex(line => /^###\s+(?:\d+(?:\.\d+)*\s+)?[^\n]*主要施工\s*内容[^\n]*$/u.test(line.trim()));
    if (mergedStart >= 0) {
      let mergedEnd = lines.length;
      for (let index = mergedStart + 1; index < lines.length; index += 1) {
        if (/^#{2,3}\s+/u.test(lines[index].trim())) {
          mergedEnd = index;
          break;
        }
      }
      const blocks = lines.slice(mergedStart, mergedEnd).join('\n').split(/^####\s+/gmu).slice(1).map(block => block.trim()).filter(Boolean);
      if (blocks.length >= 5 && blocks.every(workPackageContentElementsComplete)) {
        start = mergedStart;
      }
    }
    if (start < 0) return '';
  }
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^#{2,3}\s+/u.test(lines[index].trim())) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join('\n')
    .replace(/^\*\*([^*\n]{2,50})\*\*\s*$/gmu, '#### $1')
    .replace(/承包人法(?=[:：])/gu, '施工方法');
}

export function constructionOrgMajorContentIssues(chapters: DocumentDraftChapter[], markdown = ''): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const wholeText = markdown || chapters.map(chapter => `${chapter.title}\n${(chapter.sections || []).join('\n')}\n${chapter.content}`).join('\n\n');
  const candidateChapters = chapters.filter(chapter => /项目主要施工内容|主要施工内容/u.test(`${chapter.title} ${(chapter.sections || []).join(' ')}`));
  const shouldRequireMajorContent = /施工组织设计|施工组织|计划工期|质量标准|项目经理|工程概况/u.test(wholeText) && /施工/u.test(wholeText);

  const validateContent = (label: string, content: string) => {
    // H4 层级小节（#### 1.3.1 项目主要施工内容）：先剥离小节标题行再计数，避免小节标题块被当作内容要素不全的专业工程块误报
    const clean = content.replace(/^####\s+(?:\d+(?:\.\d+)*\s+)?(?:项目主要施工\s*内容|主要施工\s*内容)\s*\n+/mu, '');
    const packageCount = (clean.match(/^####\s+(?:\d+(?:\.\d+)*\s+)?[一二三四五六七八九十\d]*[、.．]?\s*\S+/gmu) || []).length
      || (clean.match(/^[一二三四五六七八九十]+、\S+/gmu) || []).length;
    const packageBlocks = clean.split(/^####\s+/gmu).slice(1).map(block => block.trim()).filter(Boolean);
    // 4.17.9 内容要素检查（呈现形式不限）：三要素判定统一走 utils.workPackageContentElementsComplete。
    // 不再按“施工概况/施工流程/施工方法”标签字面判定——无标签但写法正确的块不应被误判缺失（写作侧同样不再强制标签）
    const incompletePackages = packageBlocks.filter(block => !workPackageContentElementsComplete(block));
    const dirtyPackages = packageBlocks.filter(block => /资料内容事实|#{2,6}\s+|\*\*[^*]+\*\*|未尽事宜|专业施工内容统筹|招标范围还包含|具备有效的.*资质/u.test(block));
    const weakMethodPackages = packageBlocks.filter(block => {
      // 4.17.9 无标签形态（自然成文）：方法要素强弱由上方内容要素检查（workPackageContentElementsComplete）把关，
      // 本检查只针对“施工方法：”标签形态的方法段，避免空提取把无标签块恒判“过弱”
      if (!/施工方法[:：]/u.test(block)) return false;
      const method = block.match(/施工方法[:：]([\s\S]*?)(?=\n施工|$)/u)?.[1] || '';
      return method.length < 30 || ((method.match(/工程|维修|改造|安装|设备/gu) || []).length >= 4 && !/\d|㎡|m2|m²|mm|厚|验收|检测|调试|试验|复试|记录|报告/u.test(method));
    });
    const dirtyProcessPackages = packageBlocks.filter(block => {
      const process = block.match(/施工流程[:：]([\s\S]*?)(?=\n施工方法|$)/u)?.[1] || '';
      return /未尽事宜|本项目为|总建筑面积|保留现状|专业施工内容统筹|招标文件列明|招标范围/u.test(process);
    });
    // 重复专业工程检测（十一度实测缺陷：1.3.2~1.3.11 与 1.3.12~1.3.21 两套同名专业工程重复出现，标题仅差“工程”尾缀）：
    // 标题去编号、去“工程”尾缀归一化后重复的块判定为冗余小节，必须合并去重
    const normalizedTitles = packageBlocks.map(block => (block.split('\n')[0] || '').replace(/^\d+(?:\.\d+)*\s+/u, '').replace(/工程$/u, '').replace(/[、.．]/gu, '').trim());
    const duplicateTitles = [...new Set(normalizedTitles.filter((title, index) => title && normalizedTitles.indexOf(title) !== index))];
    if (duplicateTitles.length > 0) issues.push({ level: 'error', severity: 'blocker', message: `${label} 主要施工内容存在 ${duplicateTitles.length} 组重复专业工程小节：${duplicateTitles.slice(0, 5).join('、')}`, suggestion: '同一专业工程只保留一个小节，将重复小节的独有内容合并后删除冗余小节，避免专业工程重复铺陈。' });
    if (packageCount < 5) issues.push({ level: 'error', severity: 'blocker', message: `${label} 主要施工内容专业工程不足：当前 ${packageCount} 个，要求不少于 5 个`, suggestion: '按资料识别专业工程/分部分项工程，逐项写施工概况、施工流程、施工方法。' });
    if (incompletePackages.length > 0) issues.push({ level: 'warning', message: `${label} 主要施工内容存在 ${incompletePackages.length} 个专业工程内容要素不全（作业对象与工程量/工序顺序/施工方法至少缺一）`, suggestion: '每个专业工程需覆盖作业对象与工程量、工序安排、施工方法三方面要素，可分段用“施工概况/施工流程/施工方法”标签组织，也可自然成文，写法正确即可。' });
    if (dirtyPackages.length > 0) issues.push({ level: 'error', severity: 'blocker', message: `${label} 主要施工内容存在脏事实或标题污染`, suggestion: '清理“资料内容事实”、嵌入的 ### 标题、粗体伪标题、未尽事宜、招标范围罗列等污染内容，只保留可交付正文。' });
    if (weakMethodPackages.length > 0) issues.push({ level: 'error', severity: 'blocker', message: `${label} 主要施工内容存在 ${weakMethodPackages.length} 个专业工程施工方法过弱`, suggestion: '施工方法不能只是专业工程名称或专业范围罗列，必须写资料已确认的工程量、材料、检测、调试、验收或记录要求。' });
    if (dirtyProcessPackages.length > 0) issues.push({ level: 'error', severity: 'blocker', message: `${label} 主要施工内容存在 ${dirtyProcessPackages.length} 个专业工程流程污染`, suggestion: '施工流程只能写工序链条，不能混入项目概况、总建筑面积、招标范围、未尽事宜等说明性事实。' });
    if (!hasProcessSequenceExpression(content)) issues.push({ level: 'error', severity: 'blocker', message: `${label} 主要施工内容缺少工序顺序表达`, suggestion: '施工流程须有明确的工序顺序表达，形式由模型自然选择、不做统一要求：顺序词叙述（先测量放线，再基层处理，随后工序实施，然后检查验收，最后资料归档）、编号步骤、有序/无序列表或箭头链均可。' });
    const parameterCount = (content.match(/\d+(?:\.\d+)?\s*(?:㎡|m²|mm|cm|m|MPa|kPa|%|日历天|层|台|套|个|项|批|次|小时|年)/giu) || []).length;
    const factDetailCount = (content.match(/工程量|材料|设备|范围|流程|验收|检测|复试|调试|隐蔽|检验批|资料|记录|系统|部位|接口|规格|标准/gu) || []).length;
    if (parameterCount < 2 || factDetailCount < 12) issues.push({ level: 'error', severity: 'blocker', message: `${label} 主要施工内容事实细度不足：参数 ${parameterCount} 项、事实细节 ${factDetailCount} 项`, suggestion: '主要施工内容必须落到资料已确认的范围、工程量/材料、流程、验收和记录要求；资料未明确的工具、型号、参数不得编造。' });
    if (/^\s*\|.+\|\s*$/mu.test(content)) issues.push({ level: 'error', severity: 'blocker', message: `${label} 主要施工内容不应使用 Markdown 表格替代专业工程正文`, suggestion: '主要施工内容应采用三级小节和段落式专业工程写法，不使用表格承载主体内容。' });
  };

  if (candidateChapters.length === 0 && shouldRequireMajorContent) {
    const content = extractMajorConstructionSection(wholeText);
    if (!content) return [{ level: 'error', severity: 'blocker', message: '施工组织设计缺少“项目主要施工内容”小节', suggestion: '必须生成“### 项目主要施工内容”，并在该小节内部使用“#### 专业工程名称”逐项展开。' }];
    validateContent('全文', content);
    return issues;
  }

  for (const chapter of candidateChapters) {
    const content = extractMajorConstructionSection(chapter.content) || extractMajorConstructionSection(wholeText);
    if (!content) {
      issues.push({ level: 'error', severity: 'blocker', message: `${chapter.title} 主要施工内容小节缺失或标题结构异常`, suggestion: '必须生成“### 项目主要施工内容”，并在该小节内部使用“#### 专业工程名称”逐项展开。' });
      continue;
    }
    validateContent(chapter.title, content);
  }
  return issues;
}

export function constructionOrgBonusModuleIssues(chapters: DocumentDraftChapter[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const chapter of chapters) {
    const text = `${chapter.title} ${(chapter.sections || []).join(' ')} ${chapter.content}`;
    for (const bonusModule of BONUS_MODULES) {
      if (bonusModule.pattern.test(text) && !chapter.content.includes(bonusModule.title)) {
        // 隐藏高分模块是可加分建议而非缺陷，按 info 计入，避免污染缺陷计分
        issues.push({ level: 'info', message: `${chapter.title} 可补充隐藏高分模块：${bonusModule.title}`, suggestion: bonusModule.prompt });
      }
    }
  }
  return issues;
}

// ═══════ 分部分项专项验收器 ═══════
// 对标 constructionOrgMajorContentIssues（工作包≥5、内容要素、工序顺序表达、参数密度、脏事实检测），
// 针对“主要分部分项工程施工方案/主要施工方法”关键小节：历史上该小节曾错位到“新工艺”章节且写得概略，
// 终检无专项验收器把关导致问题直达交付（历史缺陷：分部分项错位+内容概略未被拦截）。
// 阈值与专项提示词同源（writingSpec.DIVISION_SECTION_QUALITY），保证“写作要求=验收标准”。

/** 提取“主要分部分项工程施工方案/主要施工方法”小节内容（### 标题到下一个同级标题为止） */
function extractDivisionSection(content: string) {
  const lines = content.split('\n');
  const start = lines.findIndex(line => /^###\s+(?:\d+(?:\.\d+)*\s+)?[^\n]*?(?:主要分部分项工程施工方案|主要施工方法)[^\n]*$/u.test(line.trim()));
  if (start < 0) return '';
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^#{2,3}\s+/u.test(lines[index].trim())) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

export function constructionOrgDivisionSectionIssues(chapters: DocumentDraftChapter[], markdown = ''): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const wholeText = markdown || chapters.map(chapter => `${chapter.title}\n${(chapter.sections || []).join('\n')}\n${chapter.content}`).join('\n\n');
  const candidateChapters = chapters.filter(chapter => DIVISION_SECTION_RE.test(`${chapter.title} ${(chapter.sections || []).join(' ')}`));
  if (candidateChapters.length === 0) return issues;

  const validateContent = (label: string, content: string) => {
    // 分项工程方案 = #### 小节（与 majorContent 工作包口径一致）；
    // 兼容粗体伪标题一段式：无 #### 小节时按“行首 **分项名**”切块（真实生成缺陷：LLM 用粗体行替代小节标题，
    // 历史验收器按 #### 切出 0 块只能报“分项不足”，无法定位各分项缺什么，粗体形态由此穿透门禁交付）
    let packageBlocks = content.split(/^####\s+/gmu).slice(1).map(block => block.trim()).filter(Boolean);
    if (packageBlocks.length === 0) {
      packageBlocks = [...content.matchAll(/^\*\*[^*]+\*\*[\s\S]*?(?=^\*\*[^*]+\*\*|\s*$)/gmu)].map(match => match[0].trim()).filter(Boolean);
    }
    const packageCount = packageBlocks.length;
    // 4.17.9 内容要素检查（呈现形式不限）：不再按“施工概况/工艺流程/施工方法”标签字面判定缺失
    const incompletePackages = packageBlocks.filter(block => {
      const hasScope = /(?:施工)?(?:概况|范围)[:：]\s*\S|工程量|作业对象|部位/u.test(block);
      const hasProcess = DIVISION_PROCESS_LABEL_RE.test(block) || hasProcessSequenceExpression(block);
      const hasMethod = /(?:施工)?方法[:：]\s*\S|工艺参数|验收标准|检测|试验|记录/u.test(block);
      return !hasScope || !hasProcess || !hasMethod;
    });
    // 脏事实：资料原文残留、嵌入标题、粗体伪标题、空话套话（与专项提示词禁止项同口径）
    const dirtyPackages = packageBlocks.filter(block => /资料内容事实|#{2,6}\s+|\*\*[^*]+\*\*|未尽事宜|按规范施工|结合实际执行|招标范围还包含/u.test(block));
    // 工序顺序表达检测：每个分项方案的施工方法段或流程段必须有工序顺序表达
    // （箭头链/编号步骤/有序无序列表/顺序词/连接线任一形式，不再强制“→”）
    const weakChainPackages = packageBlocks.filter(block => {
      // 粗体伪标签兼容：验收器直读最终 markdown，标签归一化虽已覆盖成稿链，双保险容忍粗体形态
      const method = block.match(/(?:\*\*)?施工方法(?:\*\*)?[:：]([\s\S]*?)(?=\n施工|$)/u)?.[1] || '';
      if (method.trim() && hasProcessSequenceExpression(method)) return false;
      const flow = block.match(/(?:\*\*)?(?:施工流程|工艺流程)(?:\*\*)?[:：]([\s\S]*?)(?=\n(?:施工|工艺)|$)/u)?.[1] || '';
      return !hasProcessSequenceExpression(flow);
    });
    // 参数密度：每个分项方案正文至少 4 个工艺参数（数字+单位，或“间距/偏差/坡度/养护”等工艺词+数字）；
    // 单位表含 N/颗/樘/扇：门窗维修类分项“启闭力不大于50N”“螺钉固定不少于2颗”属有效工艺参数（九度实测缺陷：正则漏判报参数不足）
    const paramRe = /\d+(?:\.\d+)?\s*(?:㎡|m²|m2|m3|m³|mm|cm|m|MPa|kPa|%|日历天|天|小时|层|台|套|个|次|kN|t|N|颗|樘|扇)/giu;
    const paramWordRe = /(?:间距|偏差|坡度|养护|搭接|试验压力|含水率|饱满度|压实度|厚度|饱满)[^\n]{0,10}\d/giu;
    const weakParamPackages = packageBlocks.filter(block => {
      const count = (block.match(paramRe) || []).length + (block.match(paramWordRe) || []).length;
      return count < DIVISION_SECTION_QUALITY.minParamsPerPackage;
    });
    if (packageCount < DIVISION_SECTION_QUALITY.blockerMinPackages) {
      issues.push({ level: 'error', severity: 'blocker', message: `${label} 分部分项工程施工方案分项不足：当前 ${packageCount} 个，要求不少于 ${DIVISION_SECTION_QUALITY.blockerMinPackages} 个`, suggestion: '按资料识别的专业工程/分部分项工程逐项展开，每项写施工概况、工艺流程、施工方法。' });
    } else if (packageCount < DIVISION_SECTION_QUALITY.minPackages) {
      issues.push({ level: 'warning', message: `${label} 分部分项工程施工方案建议扩充：当前 ${packageCount} 个分项方案，建议不少于 ${DIVISION_SECTION_QUALITY.minPackages} 个`, suggestion: '优先覆盖资料明确的专业工程范围（土方、基础、主体、装饰、安装、室外等）。' });
    }
    if (incompletePackages.length > 0) issues.push({ level: 'warning', message: `${label} 分部分项工程施工方案存在 ${incompletePackages.length} 个分项方案内容要素不全（作业对象与工程量/工序顺序/施工方法至少缺一）`, suggestion: '每个分项方案需覆盖作业对象与工程量、工序安排、施工方法三方面要素，可分段用“施工概况/工艺流程/施工方法”标签组织，也可自然成文，写法正确即可。' });
    if (dirtyPackages.length > 0) issues.push({ level: 'error', severity: 'blocker', message: `${label} 分部分项工程施工方案存在脏事实或空话污染`, suggestion: '清理“资料内容事实”、嵌入的 ### 标题、粗体伪标题、未尽事宜、“按规范施工/结合实际执行”式空话，只保留可交付正文。' });
    if (weakChainPackages.length > 0) issues.push({ level: 'error', severity: 'blocker', message: `${label} 分部分项工程施工方案存在 ${weakChainPackages.length} 个分项方案施工方法缺少工序顺序表达`, suggestion: '每个分项方案的施工方法段/施工流程段必须有明确的工序顺序表达，形式由模型自然选择（顺序词叙述、编号步骤、有序列表或箭头链均可，如“先进行基层清理，再放线定位，随后分层摊铺，然后碾压，最后做压实度检测并验收”），保证工序先后顺序清晰。' });
    if (weakParamPackages.length > 0) issues.push({ level: 'error', severity: 'blocker', message: `${label} 分部分项工程施工方案存在 ${weakParamPackages.length} 个分项方案工艺参数不足（少于 ${DIVISION_SECTION_QUALITY.minParamsPerPackage} 个）`, suggestion: '每个分项方案必须落位至少 4 个具体工艺参数（mm、MPa、间距、偏差、坡度、养护天数、试验压力、搭接长度等），参数来自绑定材料或行业通用规范值，不得编造。' });
    // 分项深度下限：门窗维修、立面修补等小分项常被一句话带过（真实生成缺陷：12 个分项中 2~3 个仅 40~80 字），
    // 每分项必须写足三方面要素正文（作业对象与工程量/工序安排/施工方法），过短按结构缺陷进入修复循环补写
    const shallowPackages = packageBlocks.filter(block => block.replace(/\s/gu, '').length < DIVISION_SECTION_QUALITY.minPackageChars);
    if (shallowPackages.length > 0) issues.push({ level: 'error', severity: 'blocker', message: `${label} 分部分项工程施工方案存在 ${shallowPackages.length} 个分项方案正文过短（少于 ${DIVISION_SECTION_QUALITY.minPackageChars} 字）`, suggestion: '每个分项方案都要写足作业对象与工程量、工序安排、施工方法三方面要素，门窗维修、立面修补等小分项同样需要展开，不得一句话带过。' });
    // 分项深度均衡：最短分项不足最长分项 balanceRatio 时给扩充建议（warning 不阻断，由质量报告引导后续优化）
    const packageLengths = packageBlocks.map(block => block.replace(/\s/gu, '').length);
    const imbalanced = packageLengths.length > 1 && Math.min(...packageLengths) > 0 && Math.min(...packageLengths) < Math.max(...packageLengths) * DIVISION_SECTION_QUALITY.balanceRatio;
    if (imbalanced) issues.push({ level: 'warning', message: `${label} 分部分项工程施工方案分项深度失衡：最短分项不足最长分项三分之一`, suggestion: '参照最长分项（如拆除、结构加固）的展开深度，为偏短分项补足机具、材料规格、工艺参数与验收标准。' });
  };

  for (const chapter of candidateChapters) {
    const content = extractDivisionSection(chapter.content) || extractDivisionSection(wholeText);
    if (!content) {
      issues.push({ level: 'error', severity: 'blocker', message: `${chapter.title} 分部分项工程施工方案小节缺失或标题结构异常`, suggestion: '必须生成“### 主要分部分项工程施工方案”，并在该小节内部使用“#### 分项工程方案”逐项展开。' });
      continue;
    }
    validateContent(chapter.title, content);
  }
  return issues;
}
