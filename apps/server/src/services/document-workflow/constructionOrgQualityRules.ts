import type { DocumentDraftChapter, DocumentFactsModel, DocumentTemplateChapter, ValidationIssue } from './types';
import { CONSTRUCTION_ORG_PROJECT_TYPE_PATTERNS, inferConstructionOrgProjectTypes, type ConstructionOrgProjectType } from './constructionOrgProjectTypes';
import { DIVISION_SECTION_QUALITY, DIVISION_SECTION_RE, MAJOR_CONTENT_SECTION_RE } from './writingSpec';
import { hasProcessSequenceExpression, workPackageContentElementFlags, workPackageContentElementsComplete } from './utils';
import { buildSemanticGate } from './semanticGate';
import { stableHash } from './utils';

/** 切块截尾（4.31 丰乐镇 v6 根治）：块内进入 #/##/### 级嵌入标题（跨小节内容混入）时只取标题前正文，
 * 防止后续小节内容混入本块造成三要素判定/脏事实检测连带误报（实测：块尾吞并下级小节致多块误报）。 */
const cutAtEmbeddedHeading = (block: string): string => block.split(/\n(?=#{1,3}\s)/u)[0].trim();

/** 概括话术硬词表（r18 丰乐镇 B5 归因分层）：「按设计图纸执行/详见设计图纸」类整句留白——任意块命中直报 */
const HARD_REFERENCE_PHRASE_RE = /按设计图纸执行|按设计文件执行|详见设计图纸|按.{0,10}设计总说明执行|详见图纸|以设计图纸为准/u;

/** 概括话术软词表：「按设计确定」多为次要参数留白（r18 实测楼地面块含 9 个工艺参数仍命中）——
 * 仅当块内工艺参数不足（与 minParamsPerPackage 同阈值）时按概括话术报，防「以留白代方案」逃逸 */
const SOFT_REFERENCE_PHRASE_RE = /按设计确定/u;

/** 块内工艺参数计数（软词表联动判据；与分部分项 weakParamPackages 参数口径同源，含 N/颗/樘/扇/座 单位） */
const REFERENCE_PARAM_RE = /\d+(?:\.\d+)?\s*(?:㎡|m²|m2|m3|m³|mm|cm|m|MPa|kPa|%|日历天|天|小时|层|台|套|个|座|次|kN|t|N|颗|樘|扇)/giu;
const REFERENCE_PARAM_WORD_RE = /(?:间距|偏差|坡度|养护|搭接|试验压力|含水率|饱满度|压实度|厚度|饱满)[^\n]{0,10}\d/giu;

/** 概括话术命中判定（检测定位=修复定位同源）：硬词表命中直报；软词表命中且块内工艺参数不足才报 */
function genericReferenceHit(block: string, minParams: number): boolean {
  if (HARD_REFERENCE_PHRASE_RE.test(block)) return true;
  if (!SOFT_REFERENCE_PHRASE_RE.test(block)) return false;
  return (block.match(REFERENCE_PARAM_RE) || []).length + (block.match(REFERENCE_PARAM_WORD_RE) || []).length < minParams;
}

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

/**
 * 控制闭环规则表（D-T2 双轨判定）：
 * - ownerRe 存在（质量/进度/工资三链，评审关注链）= 主责章全要素判定——主责章取首个标题命中
 *   ownerRe 的章，正文须覆盖全部要素（缺任一即不成链，对齐「三类闭环链 100% 成链」验收判据），
 *   产出带 chapterId+provenance 的 warning 由 control-loop-repair 修复轮定向补写消费；
 *   r28f 归因：旧判定按 title+sections 宽 pattern 逐章命中，「拟投入的主要施工机械、设备计划」
 *   含「计划」被误判为进度链载体、「确保工程质量的技术组织措施」被误判为工资链载体，
 *   而真实主责章（确保工期的技术组织措施/劳动力安排计划）反而不报——主责章定位根治该误报族。
 * - ownerRe 缺省（安全/环保/应急链）= 通用宽松判定（pattern 命中章、缺半数才报，warning 无修复消费）。
 */
const CONTROL_LOOP_RULES: Array<{ pattern: RegExp; label: string; required: string[]; prompt: string; ownerRe?: RegExp }> = [
  { pattern: /质量|验收|隐蔽|样板|通病/u, label: '质量闭环', required: ['自检', '互检', '交接检', '整改', '复查', '归档'], prompt: '质量类内容必须形成“自检—互检—交接检—整改—复查—资料归档”闭环。', ownerRe: /质量/u },
  { pattern: /安全|风险|危大|临电|消防|吊装|高处/u, label: '安全闭环', required: ['辨识', '交底', '检查', '整改', '复查', '销项'], prompt: '安全类内容必须形成“风险辨识—专项交底—现场检查—隐患整改—复查销项”闭环。' },
  { pattern: /进度|工期|节点|计划/u, label: '进度闭环', required: ['计划', '检查', '偏差', '纠偏', '复核'], prompt: '进度类内容必须形成“计划分解—日/周检查—偏差识别—资源纠偏—节点复核”闭环。', ownerRe: /进度|工期/u },
  { pattern: /文明|扬尘|噪声|绿色|环保|垃圾/u, label: '环保闭环', required: ['监测', '预警', '处置', '台账'], prompt: '文明环保类内容必须形成“监测—预警—联动处置—台账记录”闭环。' },
  { pattern: /工资|劳务|实名/u, label: '工资闭环', required: ['实名', '考勤', '核算', '公示', '代发', '归档'], prompt: '工资保障类内容必须形成“实名登记—考勤—核算—公示—银行代发—归档”闭环。', ownerRe: /劳务|工资|劳动力|实名|用工/u },
  { pattern: /应急|预案|救援|事故/u, label: '应急闭环', required: ['发现', '警戒', '疏散', '处置', '上报', '复盘'], prompt: '应急类内容必须形成“发现险情—警戒疏散—初期处置—救援上报—复盘整改”闭环。' },
];

const PROCESS_CHAINS: Record<Exclude<ConstructionOrgProjectType, 'general'>, { label: string; chain: string[]; forbidden: string[]; prompt: string }> = {
  building: {
    label: '房建工程',
    chain: ['施工准备', '土方/基础', '主体结构', '二次结构/砌体', '防水', '机电安装', '装饰装修', '室外工程', '竣工验收'],
    forbidden: ['管道闭水试验', '沥青摊铺', '水稳层', '交通导改'],
    prompt: '房建类章节应按“施工准备—基础—主体—二次结构—防水—机电—装饰—室外—验收”组织，不得混入市政道路工序。',
  },
  municipal: {
    label: '市政工程',
    chain: ['测量放线', '管线探测', '围挡导行', '沟槽/路基', '管道/管涵/检查井', '回填', '水稳/沥青/铺装', '标线/标志/路灯', '验收移交'],
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
    chain: ['基层处理', '防水/闭水', '吊顶/龙骨', '墙地面/铺装', '收口/收边', '成品保护', '空气质量/环境检测'],
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

/** 链环节匹配（D-T9 等价簇，检测/修复/复检单源）：节点按「/」分等价词，任一命中即算
 *（「沟槽/路基」命中「沟槽」或「路基」；历史缺陷：「防水闭水」「吊顶龙骨」组合词全字面匹配为死节点，
 * 自然写作用词「防水」「龙骨」漏判—— r28f #31 词表偏差误报根因之一） */
function chainNodeHit(node: string, context: string): boolean {
  return node.split('/').some(term => context.includes(normalize(term)));
}

/** 链环节展示主词（簇首词：issue 文案/修复指令/复检同源展示） */
function chainNodeLabel(node: string): string {
  return node.split('/')[0];
}

/** D-T9 工序链缺陷（检测 issue / 修复轮指令 / 复检三角色共用）：章级定位 */
export interface ProfessionalChainDeficit {
  /** 缺陷定位章（mixed=节所在章；insufficient=文档级缺口归属章） */
  chapter: DocumentDraftChapter;
  /** mixed=节级域错位（工序组织节写成本域禁配工序）；insufficient=文档级链覆盖缺口 */
  kind: 'mixed' | 'insufficient';
  /** 缺陷领域 */
  domain: Exclude<ConstructionOrgProjectType, 'general'>;
  /** 域展示名（PROCESS_CHAINS.label 单源：检测 message/修复指令/复检展示） */
  label: string;
  /** mixed=命中的禁配工序词；insufficient=已命中的链环节（主词） */
  hits: string[];
  /** insufficient=缺失链环节（主词）；mixed 为空 */
  missing: string[];
  /** 域工序链组织要求（检测 suggestion / 修复指令同源文案） */
  prompt: string;
  /** mixed=节标题（章内定位）；insufficient=undefined */
  sectionTitle?: string;
}

/**
 * D-T9 工序链单源扫描（检测/修复/复检共用）：
 * 1. 节级 mixed（域错位）：章内容按 H3 嵌标题切节，节标题词面命中域 → 该域禁配工序词在节内命中 ≥2 即错位——
 *    r28f #30 归因：旧全文级判定把「质保承诺主体结构（法定话术）+ 公厕房建外脚手架（混合项目合法
 *    单位工程）」叠加成市政错位误报；节级判定把域约束绑定到具体工序组织节（「道路工程」节只按市政
 *    禁配检查），公厕/装饰节只受各自域约束，概况节无标题域不检查；
 * 2. 文档级 insufficient（链覆盖缺口）：全文链环节命中 < min(3, 链长) 即缺口；缺口归属到章
 *    （章内容链命中最多且 >0，供修复轮定向补写；无归属章不产出交终门禁复核）。
 */
export function professionalChainScan(input: { chapters: DocumentDraftChapter[]; documentText: string }): ProfessionalChainDeficit[] {
  const deficits: ProfessionalChainDeficit[] = [];
  // ① 节级 mixed：域约束绑定到工序组织节（节标题词面判域，声明序检查）
  for (const chapter of input.chapters) {
    const blocks = String(chapter.content || '').split(/(?=^#{3}\s)/mu);
    for (const block of blocks) {
      if (!block.trim()) continue;
      const headingMatch = block.match(/^#{1,6}\s*(.+)$/mu);
      if (!headingMatch) continue;
      const sectionTitle = headingMatch[1].trim().slice(0, 40);
      if (!sectionTitle) continue;
      const blockContext = normalize(block);
      for (const { type, pattern } of CONSTRUCTION_ORG_PROJECT_TYPE_PATTERNS) {
        if (!pattern.test(sectionTitle)) continue;
        const rule = PROCESS_CHAINS[type];
        const forbiddenHits = rule.forbidden.filter(token => blockContext.includes(normalize(token)));
        if (forbiddenHits.length >= 2) {
          deficits.push({ chapter, kind: 'mixed', domain: type, label: rule.label, sectionTitle, hits: [...forbiddenHits], missing: [], prompt: rule.prompt });
        }
      }
    }
  }
  // ② 文档级 insufficient：全文链覆盖缺口（归属到章供修复定位；词表簇化匹配）
  const context = normalize(input.documentText);
  for (const type of Object.keys(PROCESS_CHAINS) as Array<Exclude<ConstructionOrgProjectType, 'general'>>) {
    const rule = PROCESS_CHAINS[type];
    const chainHits = rule.chain.filter(node => chainNodeHit(node, context));
    const explicitlyMatched = new RegExp(rule.label, 'u').test(input.documentText) || chainHits.length >= 3;
    if (!explicitlyMatched) continue;
    if (chainHits.length >= Math.min(3, rule.chain.length)) continue;
    const owner = [...input.chapters]
      .map(chapter => ({ chapter, hits: rule.chain.filter(node => chainNodeHit(node, normalize(`${chapter.title} ${chapter.content || ''}`))).length }))
      .sort((left, right) => right.hits - left.hits)[0];
    if (!owner || owner.hits === 0) continue;
    deficits.push({
      chapter: owner.chapter,
      kind: 'insufficient',
      domain: type,
      label: rule.label,
      hits: chainHits.map(chainNodeLabel),
      missing: rule.chain.filter(node => !chainNodeHit(node, context)).map(chainNodeLabel),
      prompt: rule.prompt,
    });
  }
  return deficits;
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
    '- 禁止空话套话：不要只写“加强管理、严格控制、确保质量、精心组织、科学管理、周密部署、狠抓落实、统筹兼顾”等零信息口号（全文质检会按语义原型拦截并要求重写），必须写成“责任岗位+执行动作+量化标准+检查频次+整改时限+复查销项”。',
    '- 落地措施范例：“由质检员每周不少于1次对级配碎石层压实度抽检，不足95%的当日返工复验”——每句措施要能回答“谁、做什么、什么标准、多久一次、不达标怎么办”；项目特有数据必须来自资料或图谱。',
    ...loops,
    ...bonus,
  ].join('\n');
}

export function constructionOrgBlueprintRuleLines(chapter: DocumentTemplateChapter) {
  const prompt = constructionOrgChapterRulePrompt(chapter);
  return prompt ? prompt.split('\n').map(line => `   - ${line}`) : [];
}

export function constructionOrgProjectTypePrompt(input: { templateName: string; outputTitle?: string; requirement?: string; chapters: DocumentTemplateChapter[]; materialText?: string }) {
  const runtimeTemplate = { id: 'runtime', name: input.templateName, outputTitle: input.outputTitle || '', description: '', category: '', chapters: [] as DocumentTemplateChapter[] };
  // D-T9 两级判定（章级优先）：章标题+小节标题命中即按本章域注入（混合项目中「公厕装饰装修工程」章
  // 只受装饰约束、不得被项目级市政域约束误导）；章级无信号时回退项目级（模板/用户要求/资料文本——
  // 资料内容驱动，不依赖项目名称）
  const chapterScopedChapters = input.chapters.map(chapter => ({ ...chapter, title: `${chapter.title} ${(chapter.sections || []).join(' ')}`.trim() }));
  // 章级信号须为具体类型（infer 无命中时返回 ['general']——general 不构成章级信号，照常回退项目级）
  const chapterTypes = inferConstructionOrgProjectTypes({ template: { ...runtimeTemplate, name: '', outputTitle: '' }, chapters: chapterScopedChapters }).filter(type => type !== 'general');
  const projectTypes = chapterTypes.length
    ? chapterTypes
    : inferConstructionOrgProjectTypes({ template: runtimeTemplate, chapters: [], requirement: input.requirement, materialText: input.materialText });
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

/** 评审关注闭环链单链缺失素材（D-T2）：检测端 issue / 修复轮指令 / 复检三角色共用的链缺失描述 */
export interface ControlLoopChainDeficit {
  /** 链名（与检测端 issue label 同源） */
  label: string;
  /** 链条全要素（修复指令展示「A—B—C」成链形态） */
  required: string[];
  /** 当前缺失要素 */
  missing: string[];
  /** 链条语义描述（写作用 prompt 同源） */
  prompt: string;
}

/** 评审关注闭环链主责章缺失扫描（D-T2 检测/修复/复检单源）：对每条 ownerRe 链定位主责章
 *（首个标题命中 ownerRe 的章），返回主责章缺失要素；检测端（constructionOrgControlLoopIssues）
 * 与修复轮（stageControlLoopRepair 定位/迭代/复检）共用本函数，防两处判定漂移
 *（检测定位=修复定位=复检定位）。无主责章不返回（链无载体章时不得强加，防误报族）。 */
export function controlLoopChainScan(chapters: DocumentDraftChapter[]): Array<{ chapter: DocumentDraftChapter; deficit: ControlLoopChainDeficit }> {
  const results: Array<{ chapter: DocumentDraftChapter; deficit: ControlLoopChainDeficit }> = [];
  for (const rule of CONTROL_LOOP_RULES) {
    if (!rule.ownerRe) continue;
    const owner = chapters.find(chapter => rule.ownerRe!.test(chapter.title));
    if (!owner) continue;
    const missing = rule.required.filter(token => !owner.content.includes(token));
    if (missing.length === 0) continue;
    results.push({ chapter: owner, deficit: { label: rule.label, required: [...rule.required], missing, prompt: rule.prompt } });
  }
  return results;
}

export function constructionOrgControlLoopIssues(chapters: DocumentDraftChapter[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  // D-T2 评审关注三链（质量三检/进度纠偏/工资代发）：主责章（首个标题命中 ownerRe 的章）全要素判定——
  // 缺任一要素即不成链（controlLoopChainScan 单源扫描）；无主责章不检查（防「机械设备/物资计划」误报族）
  for (const { chapter, deficit } of controlLoopChainScan(chapters)) {
    issues.push({
      level: 'warning',
      severity: 'warning',
      category: 'control_loop',
      message: `${chapter.title} 缺少${deficit.label}关键链条：${deficit.missing.join('、')}`,
      suggestion: `${deficit.prompt}链条要素缺失须补写：在该章对应小节内自然融入缺失环节，保持既有内容与结构不变。`,
      chapterId: chapter.id,
      provenance: { detectorId: 'construction-org-control-loop', fingerprint: stableHash(`${deficit.label}\u0000${chapter.id}`) },
    });
  }
  // 其余链（安全/环保/应急）：通用宽松判定保留（pattern 命中章、缺半数才报，warning 无修复消费）
  for (const rule of CONTROL_LOOP_RULES) {
    if (rule.ownerRe) continue;
    for (const chapter of chapters) {
      const scope = `${chapter.title} ${(chapter.sections || []).join(' ')}`;
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
  const factsText = `${input.factsModel.project.map(fact => fact.value).join(' ')} ${input.factsModel.preciseFacts.map(fact => fact.value).join(' ')}`;
  const documentText = `${input.markdown} ${factsText}`;
  const issues: ValidationIssue[] = [];
  if (input.chapters.length > 0) {
    // D-T9 生产路径：单源扫描——节级域错位（章/节定位）+ 文档级链覆盖缺口（归属章）；
    // mixed 绑定「节标题域 × 节内禁配词≥2」（r28f #30 误报根治：质保法定话术/混合项目合法单位
    // 工程的域词不再跨节叠加成全文错位）；insufficient 词表簇化（#31 误报根治：组合词死节点）
    for (const deficit of professionalChainScan({ chapters: input.chapters, documentText })) {
      const rule = PROCESS_CHAINS[deficit.domain];
      if (deficit.kind === 'mixed') {
        issues.push({
          level: 'warning',
          severity: 'warning',
          category: 'professional_chain',
          message: `${deficit.chapter.title}「${deficit.sectionTitle}」疑似${rule.label}内容混入不匹配工序：${deficit.hits.join('、')}`,
          suggestion: rule.prompt,
          chapterId: deficit.chapter.id,
          provenance: { detectorId: 'construction-org-professional-chain', fingerprint: stableHash(`mixed\u0000${deficit.domain}\u0000${deficit.chapter.id}\u0000${deficit.sectionTitle}`) },
        });
      } else {
        issues.push({
          level: 'warning',
          severity: 'warning',
          category: 'professional_chain',
          message: `${rule.label}工序链覆盖不足：仅识别到 ${deficit.hits.join('、') || '未识别到关键工序'}`,
          suggestion: rule.prompt,
          chapterId: deficit.chapter.id,
          provenance: { detectorId: 'construction-org-professional-chain', fingerprint: stableHash(`insufficient\u0000${deficit.domain}\u0000${deficit.chapter.id}`) },
        });
      }
    }
    return issues;
  }
  // 上限治理 · 旧代码清理：原「无章结构回退（旧口径全文级判定，向后兼容）」整段已删除。
  // 理由：①**生产不可达**——唯一生产调用点 documentFinalValidation 恒传 input.chapters
  //（= finalChapterDrafts），而 documentPipeline 在 chapterDrafts 为空时已先行抛错；
  // ②它产出的 issue **既无 chapterId 也无 provenance**（对照上方生产分支带 provenance.detectorId），
  // 属于注册表里反复指认的「按 provenance 过滤的补写轮消费不到」的孤儿形态——
  // 留着它只会制造无人消费的问题。
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

/** 主要施工内容逐类缺陷扫描（检测器与残差细分口径单源：拆块与判定完全一致，防两处漂移） */
interface MajorContentDeficitScan {
  packageCount: number;
  packageBlocks: string[];
  incompletePackages: string[];
  duplicateTitles: string[];
  genericReferencePackages: string[];
  dirtyPackages: string[];
  weakMethodPackages: string[];
  dirtyProcessPackages: string[];
  missingProcessSequence: boolean;
  parameterCount: number;
  factDetailCount: number;
  tableCarried: boolean;
}

/** 拆块 + 逐类缺陷判定（原验收器内联逻辑单源化：H4 标题剥离 → #### 拆块 → 逐类过滤） */
function scanMajorContentDeficits(content: string): MajorContentDeficitScan {
  // H4 层级小节（#### 1.3.1 项目主要施工内容）：先剥离小节标题行再计数，避免小节标题块被当作内容要素不全的专业工程块误报
  const clean = content.replace(/^####\s+(?:\d+(?:\.\d+)*\s+)?(?:项目主要施工\s*内容|主要施工\s*内容)\s*\n+/mu, '');
  const packageCount = (clean.match(/^####\s+(?:\d+(?:\.\d+)*\s+)?[一二三四五六七八九十\d]*[、.．]?\s*\S+/gmu) || []).length
    || (clean.match(/^[一二三四五六七八九十]+、\S+/gmu) || []).length;
  const packageBlocks = clean.split(/^####\s+/gmu).slice(1).map(block => cutAtEmbeddedHeading(block)).filter(Boolean);
  // 4.17.9 内容要素检查（呈现形式不限）：三要素判定统一走 utils.workPackageContentElementsComplete。
  // 不再按“施工概况/施工流程/施工方法”标签字面判定——无标签但写法正确的块不应被误判缺失（写作侧同样不再强制标签）
  // r11 兜底块豁免（丰乐镇门禁 #9 归因）：「其他…施工要点/施工内容」是模型对未归类工程量的兜底汇总块
  //（标题即声明非单一专业工程），按专业工程三要素判定恒误报——标题以「其他/其它」开头的块不参与要素判定
  const incompletePackages = packageBlocks.filter(block => {
    const blockTitle = (block.split('\n')[0] || '').trim();
    if (/^[\d.．、\s]*(?:其他|其它)/u.test(blockTitle)) return false;
    return !workPackageContentElementsComplete(block);
  });
  // 粗体伪标题只认整行粗体（^**…**$ + m 旗）：行内强调用粗体是正常行文，不得误报脏事实（4.31）
  const dirtyPackages = packageBlocks.filter(block => /资料内容事实|#{2,6}\s+|^\*\*[^*]+\*\*$|未尽事宜|专业施工内容统筹|招标范围还包含|具备有效的.*资质/um.test(block));
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
  const genericReferencePackages = packageBlocks.filter(block => genericReferenceHit(block, DIVISION_SECTION_QUALITY.minParamsPerPackage));
  const missingProcessSequence = !hasProcessSequenceExpression(content);
  const parameterCount = (content.match(/\d+(?:\.\d+)?\s*(?:㎡|m²|mm|cm|m|MPa|kPa|%|日历天|层|台|套|个|座|项|批|次|小时|年)/giu) || []).length;
  const factDetailCount = (content.match(/工程量|材料|设备|范围|流程|验收|检测|复试|调试|隐蔽|检验批|资料|记录|系统|部位|接口|规格|标准/gu) || []).length;
  // 表格承载正文判定（表 ≥3 行且非表格实质文本 <50 字；段落叙述 + 数据附表是合规形态）
  const tableLines = content.split(/\r?\n/u).filter(line => /^\s*\|.+\|\s*$/u.test(line.trim()));
  const proseChars = content.split(/\r?\n/u).filter(line => !/^\s*\|.+\|\s*$/u.test(line.trim())).join('').replace(/[\s#*_`>-]/gu, '').length;
  return { packageCount, packageBlocks, incompletePackages, duplicateTitles, genericReferencePackages, dirtyPackages, weakMethodPackages, dirtyProcessPackages, missingProcessSequence, parameterCount, factDetailCount, tableCarried: tableLines.length >= 3 && proseChars < 50 };
}

/** 逐类缺陷项数（残差细分口径与检测器同源）：缺包按缺口数、其余各类按异常块/组数与布尔项求和 */
function majorContentScanDeficitTotal(scan: MajorContentDeficitScan): number {
  return Math.max(0, 3 - scan.packageCount)
    + scan.incompletePackages.length
    + scan.genericReferencePackages.length
    + scan.dirtyPackages.length
    + scan.weakMethodPackages.length
    + scan.dirtyProcessPackages.length
    + scan.duplicateTitles.length
    + (scan.missingProcessSequence ? 1 : 0)
    + (scan.parameterCount < 2 || scan.factDetailCount < 12 ? 1 : 0)
    + (scan.tableCarried ? 1 : 0);
}

/** 主要施工内容残差（章级细分口径，content-depth-repair 消费）：聚合条数口径下「3 个块不全 →
 * 2 个块不全」残差不变 → 修复轮误判「未下降」提前停止（r16c 丰乐镇实机归因：1191→1749 字
 * 真实补写被判未下降）；细分口径下任一实项修复即残差下降，收敛判定恢复灵敏度 */
export function majorContentDeficitCount(chapters: DocumentDraftChapter[], markdown = ''): number {
  const wholeText = markdown || chapters.map(chapter => `${chapter.title}\n${(chapter.sections || []).join('\n')}\n${chapter.content}`).join('\n\n');
  const candidateChapters = chapters.filter(chapter => /项目主要施工内容|主要施工内容/u.test(`${chapter.title} ${(chapter.sections || []).join(' ')}`));
  const shouldRequireMajorContent = /施工组织设计|施工组织|计划工期|质量标准|项目经理|工程概况/u.test(wholeText) && /施工/u.test(wholeText);
  let total = 0;
  if (candidateChapters.length === 0 && shouldRequireMajorContent) {
    const content = extractMajorConstructionSection(wholeText);
    if (!content) return 1;
    return majorContentScanDeficitTotal(scanMajorContentDeficits(content));
  }
  for (const chapter of candidateChapters) {
    const content = extractMajorConstructionSection(chapter.content) || extractMajorConstructionSection(wholeText);
    if (!content) { total += 1; continue; }
    total += majorContentScanDeficitTotal(scanMajorContentDeficits(content));
  }
  return total;
}

/** 要素不全块明细渲染（消息明细化：块名 + 缺维逐块点名，上限 8 个防消息过长；r16c 丰乐镇 B3 归因——
 * 聚合计数消息无法告诉修复轮「哪个块缺哪一维」，LLM 补写无靶点致残差高概率不下降） */
function describeIncompleteMajorPackages(packages: string[]): string {
  const entries = packages.slice(0, 8).map(block => {
    const flags = workPackageContentElementFlags(block);
    const missing = [!flags.scope && '作业对象与工程量', !flags.process && '工序顺序', !flags.method && '施工方法'].filter(Boolean).join('/');
    return `${divisionPackageName(block)}（缺${missing}）`;
  });
  return packages.length > 8 ? `${entries.join('、')} 等 ${packages.length} 个` : entries.join('、');
}

export function constructionOrgMajorContentIssues(chapters: DocumentDraftChapter[], markdown = ''): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const wholeText = markdown || chapters.map(chapter => `${chapter.title}\n${(chapter.sections || []).join('\n')}\n${chapter.content}`).join('\n\n');
  const candidateChapters = chapters.filter(chapter => /项目主要施工内容|主要施工内容/u.test(`${chapter.title} ${(chapter.sections || []).join(' ')}`));
  const shouldRequireMajorContent = /施工组织设计|施工组织|计划工期|质量标准|项目经理|工程概况/u.test(wholeText) && /施工/u.test(wholeText);

  // 章级 blocker 元数据包装（小节缺失类 issue 的定位锚点，与 validateContent 内 anchored 同口径）
  const anchoredContentIssue = (chapter: DocumentDraftChapter, issue: ValidationIssue): ValidationIssue => ({
    ...issue,
    chapterId: chapter.id,
    provenance: { detectorId: 'construction-org-major-content', fingerprint: stableHash(chapter.title) },
  });

  const validateContent = (label: string, content: string, chapterId?: string) => {
    // 内容深度补写轮（content-depth-repair）定位锚点：全部本函数 blocker 打 provenance
    // （detectorId 单源，修复轮按 provenance 精确过滤消费；r8 实机 #13 归因：概括话术此前无修复轮消费）
    const anchored = (issue: ValidationIssue): ValidationIssue => ({
      ...issue,
      chapterId,
      provenance: { detectorId: 'construction-org-major-content', fingerprint: stableHash(label) },
    });
    // 逐类缺陷扫描走单源（scanMajorContentDeficits）：与残差细分口径 majorContentDeficitCount 同一拆块与判定，防两处漂移
    const scan = scanMajorContentDeficits(content);
    const { packageCount, incompletePackages, duplicateTitles, genericReferencePackages, dirtyPackages, weakMethodPackages, dirtyProcessPackages } = scan;
    if (duplicateTitles.length > 0) issues.push(anchored({ level: 'error', severity: 'blocker', message: `${label} 主要施工内容存在 ${duplicateTitles.length} 组重复专业工程小节：${duplicateTitles.slice(0, 5).join('、')}`, suggestion: '同一专业工程只保留一个小节，将重复小节的独有内容合并后删除冗余小节，避免专业工程重复铺陈。' }));
    // 4.31 门槛校准：小型村组项目（如丰乐镇 3 大专业板块：景观/污水/绿化）3 个专业工程即达标，
    // 原硬编码 5 对真实小项目恒误报 blocker
    if (packageCount < 3) issues.push(anchored({ level: 'error', severity: 'blocker', message: `${label} 主要施工内容专业工程不足：当前 ${packageCount} 个，要求不少于 3 个`, suggestion: '按资料识别专业工程/分部分项工程逐项展开，每项覆盖作业对象与工程量、工序顺序、施工方法三方面要素（融入连贯叙述，不得以结构标签充当小节标题或段落开头引导）。' }));
    // r16c 丰乐镇 B3 归因：要素不全消息携带逐块明细（块名+缺维）——聚合计数消息无法告诉修复轮
    // 「哪个块缺哪一维」，LLM 补写无靶点；与分部分项检测 describeDivisionPackages 同口径
    if (incompletePackages.length > 0) issues.push(anchored({ level: 'error', severity: 'blocker', message: `${label} 主要施工内容存在 ${incompletePackages.length} 个专业工程内容要素不全（作业对象与工程量/工序顺序/施工方法至少缺一）：${describeIncompleteMajorPackages(incompletePackages)}`, suggestion: '每个专业工程需覆盖作业对象与工程量、工序安排、施工方法三方面要素，融入连贯段落叙述（禁止以“施工概况/施工流程/施工方法”等结构标签充当标题或段落开头引导）。' }));
    // 概括话术检测（4.18.6）：工作包正文出现“按设计图纸执行/详见设计图纸”式留白——
    // 清单特征描述与图纸说明中大量存在该字样，Writer 照抄导致正文无具体数值
    //（轮7 实测：2.1.2~2.1.5 全靠“按设计图纸执行”糊弄，清单真实工程量未落位）；
    // 工作包正文必须落到清单/图纸中的具体数值与参数，概括留白一律打回
    if (genericReferencePackages.length > 0) issues.push(anchored({ level: 'error', severity: 'blocker', message: `${label} 主要施工内容存在 ${genericReferencePackages.length} 个工作包正文含“按设计图纸执行”式概括话术`, suggestion: '工作包正文必须落到具体数值与参数：工程量、材料规格、设备型号等数量类数值优先取工程量清单数据，清单未覆盖的参数（标高、坡率、构造做法）取图纸具体数值；禁止“按设计图纸执行/详见设计图纸/按设计文件确定”式留白。' }));
    if (dirtyPackages.length > 0) issues.push(anchored({ level: 'error', severity: 'blocker', message: `${label} 主要施工内容存在脏事实或标题污染`, suggestion: '清理“资料内容事实”、嵌入的 ### 标题、粗体伪标题、未尽事宜、招标范围罗列等污染内容，只保留可交付正文。' }));
    if (weakMethodPackages.length > 0) issues.push(anchored({ level: 'error', severity: 'blocker', message: `${label} 主要施工内容存在 ${weakMethodPackages.length} 个专业工程施工方法过弱`, suggestion: '施工方法不能只是专业工程名称或专业范围罗列，必须写资料已确认的工程量、材料、检测、调试、验收或记录要求。' }));
    if (dirtyProcessPackages.length > 0) issues.push(anchored({ level: 'error', severity: 'blocker', message: `${label} 主要施工内容存在 ${dirtyProcessPackages.length} 个专业工程流程污染`, suggestion: '施工流程只能写工序链条，不能混入项目概况、总建筑面积、招标范围、未尽事宜等说明性事实。' }));
    if (scan.missingProcessSequence) issues.push(anchored({ level: 'error', severity: 'blocker', message: `${label} 主要施工内容缺少工序顺序表达`, suggestion: '施工流程须有明确的工序顺序表达，工序环节按先后顺序分步展开，相邻小节不得同句式开头、同一句式全文不得反复使用（禁止以固定句模复读）。' }));
    if (scan.parameterCount < 2 || scan.factDetailCount < 12) issues.push(anchored({ level: 'error', severity: 'blocker', message: `${label} 主要施工内容事实细度不足：参数 ${scan.parameterCount} 项、事实细节 ${scan.factDetailCount} 项`, suggestion: '主要施工内容必须落到资料已确认的范围、工程量/材料、流程、验收和记录要求；资料未明确的工具、型号、参数不得编造。' }));
    // 表格承载正文判定（V2 批1-4 起零兜底：机器拼段修复器已删除，检测阻断后交写作侧约束与 LLM 定向重写）：表格 ≥3 行且非表格实质文本 <50 字
    // 才属「以表格承载正文」；段落叙述 + 数据附表（工程量/参数汇总表）是合规形态（舒城第二轮实测误报校准）
    if (scan.tableCarried) issues.push(anchored({ level: 'error', severity: 'blocker', message: `${label} 主要施工内容不应使用 Markdown 表格替代专业工程正文`, suggestion: '主要施工内容应采用三级小节和段落式专业工程写法，不使用表格承载主体内容。' }));
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
      issues.push(anchoredContentIssue(chapter, { level: 'error', severity: 'blocker', message: `${chapter.title} 主要施工内容小节缺失或标题结构异常`, suggestion: '必须生成“### 项目主要施工内容”，并在该小节内部使用“#### 专业工程名称”逐项展开。' }));
      continue;
    }
    validateContent(chapter.title, content, chapter.id);
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

/** 提取分部分项方案内容（三级形态识别）：
 * 1) H3/H4 包装标题（「主要分部分项工程施工方案/主要施工方法」标题行）→ 到下一个 H2/H3 为止；
 * 2) 章-节两级新结构（统一融合规划产物）：H2 章标题（如「## 主要施工方法」）
 *    → 到下一个 H2 为止（章正文整体，其下 H3 小节即分项方案）；
 * 3) 直接传入章正文（无章标题行）→ 原样返回。 */
function extractDivisionSection(content: string) {
  const lines = content.split('\n');
  // 形态 1：包装标题（含「主要分部分项施工方案」变体，与候选过滤同源）
  const start = lines.findIndex(line => /^#{3,4}\s+(?:\d+(?:\.\d+)*\s+)?[^\n]*?(?:主要分部分项(?:工程)?施工方案|主要施工方法)[^\n]*$/u.test(line.trim()));
  if (start >= 0) {
    let end = lines.length;
    for (let index = start + 1; index < lines.length; index += 1) {
      if (/^#{2,3}\s+/u.test(lines[index].trim())) {
        end = index;
        break;
      }
    }
    return lines.slice(start + 1, end).join('\n');
  }
  // 形态 2：章-节两级结构——章标题行（如「## 主要施工方法」）到下一章为止；
  // 负向断言排除「## 主要分部分项工程施工方案」类章名：该形态下章正文无包装小节，
  // 提取结果为空，应由调用方报「小节缺失」（既有语义），不得假性取到空内容后按 0 分项误报
  const chapterStart = lines.findIndex(line => {
    const trimmed = line.trim();
    if (!/^##\s+/u.test(trimmed) || /主要分部分项(?:工程)?施工方案/u.test(trimmed)) return false;
    return /^##\s+(?:\d+(?:\.\d+)*\s+)?[^\n]*?主要施工方法[^\n]*$/u.test(trimmed);
  });
  if (chapterStart >= 0) {
    let end = lines.length;
    for (let index = chapterStart + 1; index < lines.length; index += 1) {
      if (/^##\s+/u.test(lines[index].trim())) {
        end = index;
        break;
      }
    }
    const body = lines.slice(chapterStart + 1, end).join('\n');
    // 章正文必须含二级子标题（H3/H4 小节）才是分项方案载体；纯段落正文视为结构缺失
    // （调用方报「小节缺失」blocker，与「## 主要分部分项工程施工方案 + 纯段落」同判）
    if (!/^#{3,4}\s+/mu.test(body)) return '';
    return body;
  }
  // 形态 3：直接传入的章正文（无顶层标题）——仅当含二级子标题（H3/H4 小节）时才算分项内容载体；
  // 无子标题的正文（段落/列表）不是分项方案结构，返回空避免误判（调用方候选过滤已保证章主题相关）
  if (!/^#{3,4}\s+/mu.test(content)) return '';
  return content.trim();
}

/** markdown 章体提取（r18 丰乐镇 B4/B6 归因）：终检以交付 markdown 为事实源——drafts 与 final markdown
 * 存在链尾修复残差（实测 drafts 2.5 节末尾「其他分部分项工程施工要点」块在 markdown 已删而 drafts 仍在），
 * 终检用 drafts 提取会报出交付文本中不存在的问题（假阳性阻断）。章标题双向包含匹配（markdown 标题含
 * 「第X章」编号变体：归一后与 chapter.title 任一方包含另一方且长度 ≥3 即命中）；未命中返回 null 由
 * 调用方回退 drafts（保持既有行为）。返回含章标题行的完整段落（extractDivisionSection 形态 2 依赖标题行锚定）。 */
function chapterSectionFromMarkdown(markdown: string, chapter: DocumentDraftChapter): string | null {
  if (!markdown) return null;
  const normalizeTitle = (text: string) => text.replace(/^第[一二三四五六七八九十百\d]+章[、.．:：\s]*/u, '').replace(/\s+/gu, '').trim();
  const target = normalizeTitle(chapter.title);
  if (target.length < 2) return null;
  const lines = markdown.split('\n');
  const start = lines.findIndex(line => {
    const trimmed = line.trim();
    if (!/^##\s+/u.test(trimmed)) return false;
    const title = normalizeTitle(trimmed.replace(/^##\s+/u, ''));
    if (title.length < 2) return false;
    if (title === target) return true;
    return title.length >= 3 && target.length >= 3 && (title.includes(target) || target.includes(title));
  });
  if (start < 0) return null;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s+/u.test(lines[index].trim())) { end = index; break; }
  }
  return lines.slice(start, end).join('\n');
}

/** 分项块名称提取（拆块首行=标题文本或粗体伪标题；消息明细化展示用） */
function divisionPackageName(block: string): string {
  const firstLine = (block.split('\n')[0] ?? '').trim();
  const bold = firstLine.match(/^\*\*([^*]+)\*\*/u);
  const name = (bold ? bold[1] : firstLine).replace(/[:：].*$/u, '').trim();
  return name.length > 24 ? `${name.slice(0, 24)}…` : name;
}

/** 分项名清单渲染（消息明细化：异常分项逐个点名，上限 10 个防消息过长；r9 实机 #10/#11 归因——
 * 聚合计数消息无法告诉修复轮「哪几个分项缺什么」，LLM 无从定向补写只能整体重写） */
function describeDivisionPackages(packages: string[]): string {
  const names = packages.map(divisionPackageName).filter(Boolean);
  const head = names.slice(0, 10).join('、');
  return names.length > 10 ? `${head} 等 ${names.length} 个` : head;
}

/** 分部分项逐分项缺陷扫描（检测器与残差计数单源：拆块与判定口径完全一致） */
interface DivisionDeficitScan {
  packageBlocks: string[];
  incompletePackages: string[];
  genericReferencePackages: string[];
  dirtyPackages: string[];
  weakChainPackages: string[];
  weakParamPackages: string[];
  shallowPackages: string[];
  imbalanced: boolean;
}

/** 拆块 + 逐类缺陷判定（原验收器内联逻辑单源化：H4 → 粗体伪标题 → H3 三级兼容拆块） */
function scanDivisionDeficits(content: string): DivisionDeficitScan {
  // 分项工程方案 = #### 小节（与 majorContent 工作包口径一致）；
  // 兼容粗体伪标题一段式：无 #### 小节时按“行首 **分项名**”切块（真实生成缺陷：LLM 用粗体行替代小节标题，
  // 历史验收器按 #### 切出 0 块只能报“分项不足”，无法定位各分项缺什么，粗体形态由此穿透门禁交付）
  let packageBlocks = content.split(/^####\s+/gmu).slice(1).map(block => cutAtEmbeddedHeading(block)).filter(Boolean);
  if (packageBlocks.length === 0) {
    packageBlocks = [...content.matchAll(/^\*\*[^*]+\*\*[\s\S]*?(?=^\*\*[^*]+\*\*|\s*$)/gmu)].map(match => cutAtEmbeddedHeading(match[0])).filter(Boolean);
  }
  // 章-节两级新结构（统一融合规划产物）：无 H4 工作包时，章下 H3 小节本身就是分项方案
  // （「### 2.1 场地平整与土方回填方法」= 一个分项）；H4 存在时仍按 H4 切块，保证与写作规格一致
  if (packageBlocks.length === 0) {
    packageBlocks = content.split(/^###\s+/gmu).slice(1).map(block => cutAtEmbeddedHeading(block)).filter(Boolean);
  }
  // 4.17.9/4.31 内容要素检查（呈现形式不限）：与主要施工内容同口径——三要素判定统一走
  // utils.workPackageContentElementsComplete（词表已覆盖「总量/共N」工程量表达与「检查/整改/养护」方法证据），
  // 不再按“施工概况/工艺流程/施工方法”标签字面判定缺失（历史缺陷：自然成文分项块被恒判要素不全）
  const incompletePackages = packageBlocks.filter(block => !workPackageContentElementsComplete(block));
  // 脏事实：资料原文残留、嵌入标题、粗体伪标题、空话套话（与专项提示词禁止项同口径）
  // 粗体伪标题只认整行粗体（4.31）：行内强调用粗体是正常行文；嵌入标题已由切块截尾消除，此处为防御
  const dirtyPackages = packageBlocks.filter(block => /资料内容事实|#{2,6}\s+|^\*\*[^*]+\*\*$|未尽事宜|按规范施工|结合实际执行|招标范围还包含/um.test(block));
  // 工序顺序表达检测：每个分项方案的施工方法段或流程段必须有工序顺序表达
  // （箭头链/编号步骤/有序无序列表/顺序词/连接线任一形式，不再强制“→”）
  const weakChainPackages = packageBlocks.filter(block => {
    // 粗体伪标签兼容：验收器直读最终 markdown，标签归一化虽已覆盖成稿链，双保险容忍粗体形态
    const method = block.match(/(?:\*\*)?施工方法(?:\*\*)?[:：]([\s\S]*?)(?=\n施工|$)/u)?.[1] || '';
    const flow = block.match(/(?:\*\*)?(?:施工流程|工艺流程)(?:\*\*)?[:：]([\s\S]*?)(?=\n(?:施工|工艺)|$)/u)?.[1] || '';
    // 4.31 无标签形态（自然成文）：方法/流程标签均不存在时按整块正文判定工序顺序表达——
    // 原逻辑空提取恒判“缺少工序顺序表达”（丰乐镇 v6 实测：17 个自然成文分项块全部误报弱链）
    const text = method.trim() || flow.trim() ? `${method}\n${flow}` : block;
    return !hasProcessSequenceExpression(text);
  });
  // 参数密度：每个分项方案正文至少 4 个工艺参数（数字+单位，或“间距/偏差/坡度/养护”等工艺词+数字）；
  // 单位表含 N/颗/樘/扇（门窗维修类分项“启闭力不大于50N”“螺钉固定不少于2颗”属有效工艺参数，九度实测缺陷：正则漏判报参数不足）；
  // r15 补「座」：检查井/化粪池等构筑物按“N座”计数是工程量自然形态（「砌筑检查井2座」漏判
  // 致 2.5 章其他分部分项工程施工要点块参数 3 个误报不足），与 N/颗/樘/扇 扩表同源；
  // r18：参数正则上移文件级（REFERENCE_PARAM_RE/REFERENCE_PARAM_WORD_RE），与概括话术软词表联动判据同源
  const paramRe = REFERENCE_PARAM_RE;
  const paramWordRe = REFERENCE_PARAM_WORD_RE;
  const weakParamPackages = packageBlocks.filter(block => {
    const count = (block.match(paramRe) || []).length + (block.match(paramWordRe) || []).length;
    return count < DIVISION_SECTION_QUALITY.minParamsPerPackage;
  });
  // 概括话术检测（4.18.6）：与主要施工内容同口径——分项方案正文“按设计图纸执行/详见设计图纸”式留白一律打回；
  // r18 B5 归因分层：硬词表直报，软词表「按设计确定」仅当块内工艺参数不足时报（次要参数留白豁免）
  const genericReferencePackages = packageBlocks.filter(block => genericReferenceHit(block, DIVISION_SECTION_QUALITY.minParamsPerPackage));
  // 分项深度下限：门窗维修、立面修补等小分项常被一句话带过（真实生成缺陷：12 个分项中 2~3 个仅 40~80 字），
  // 每分项必须写足三方面要素正文（作业对象与工程量/工序安排/施工方法），过短按结构缺陷进入修复循环补写
  const shallowPackages = packageBlocks.filter(block => block.replace(/\s/gu, '').length < DIVISION_SECTION_QUALITY.minPackageChars);
  // 分项深度均衡：最短分项不足最长分项 balanceRatio 时给扩充建议（warning 不阻断，由质量报告引导后续优化）
  const packageLengths = packageBlocks.map(block => block.replace(/\s/gu, '').length);
  const imbalanced = packageLengths.length > 1 && Math.min(...packageLengths) > 0 && Math.min(...packageLengths) < Math.max(...packageLengths) * DIVISION_SECTION_QUALITY.balanceRatio;
  return { packageBlocks, incompletePackages, genericReferencePackages, dirtyPackages, weakChainPackages, weakParamPackages, shallowPackages, imbalanced };
}

/** 逐分项缺陷项数（残差细分口径与检测器同源）：blocker 类缺陷逐项求和——
 * 分项数不足按缺口数、其余各类按异常分项个数（warning 类不计：扩充建议/深度均衡不阻断） */
function divisionScanDeficitTotal(scan: DivisionDeficitScan): number {
  const shortfall = Math.max(0, DIVISION_SECTION_QUALITY.blockerMinPackages - scan.packageBlocks.length);
  return shortfall
    + scan.incompletePackages.length
    + scan.genericReferencePackages.length
    + scan.dirtyPackages.length
    + scan.weakChainPackages.length
    + scan.weakParamPackages.length
    + scan.shallowPackages.length;
}

export function constructionOrgDivisionSectionIssues(chapters: DocumentDraftChapter[], markdown = ''): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const wholeText = markdown || chapters.map(chapter => `${chapter.title}\n${(chapter.sections || []).join('\n')}\n${chapter.content}`).join('\n\n');
  const candidateChapters = chapters.filter(chapter => DIVISION_SECTION_RE.test(`${chapter.title} ${(chapter.sections || []).join(' ')}`));

  const validateContent = (label: string, content: string, chapterId?: string) => {
    // 逐分项缺陷扫描走单源（scanDivisionDeficits）：与残差细分口径 divisionSectionDeficitCount 同一拆块与判定
    const scan = scanDivisionDeficits(content);
    const { packageBlocks, incompletePackages, genericReferencePackages, dirtyPackages, weakChainPackages, weakParamPackages, shallowPackages } = scan;
    // 内容深度补写轮（content-depth-repair）定位锚点：全部本函数 blocker 打 provenance
    // （detectorId 单源；r8 实机 #14/#15 归因：要素不全/工艺参数不足此前无修复轮消费）
    const anchored = (issue: ValidationIssue): ValidationIssue => ({
      ...issue,
      chapterId,
      provenance: { detectorId: 'construction-org-division-section', fingerprint: stableHash(label) },
    });
    const packageCount = packageBlocks.length;
    if (packageCount < DIVISION_SECTION_QUALITY.blockerMinPackages) {
      issues.push(anchored({ level: 'error', severity: 'blocker', message: `${label} 分部分项工程施工方案分项不足：当前 ${packageCount} 个，要求不少于 ${DIVISION_SECTION_QUALITY.blockerMinPackages} 个`, suggestion: '按资料识别的专业工程/分部分项工程逐项展开，每项覆盖作业对象与工程量、工序顺序、施工方法三方面要素（融入连贯叙述，不得以结构标签充当小节标题或段落开头引导）。' }));
    } else if (packageCount < DIVISION_SECTION_QUALITY.minPackages) {
      issues.push(anchored({ level: 'warning', message: `${label} 分部分项工程施工方案建议扩充：当前 ${packageCount} 个分项方案，建议不少于 ${DIVISION_SECTION_QUALITY.minPackages} 个`, suggestion: '优先覆盖资料明确的专业工程范围（土方、基础、主体、装饰、安装、室外等）。' }));
    }
    if (incompletePackages.length > 0) issues.push(anchored({ level: 'error', severity: 'blocker', message: `${label} 分部分项工程施工方案存在 ${incompletePackages.length} 个分项方案内容要素不全（作业对象与工程量/工序顺序/施工方法至少缺一）：${describeDivisionPackages(incompletePackages)}`, suggestion: '每个分项方案需覆盖作业对象与工程量、工序安排、施工方法三方面要素，融入连贯段落叙述（禁止以“施工概况/工艺流程/施工方法”等结构标签充当小节标题或段落开头引导）。' }));
    if (genericReferencePackages.length > 0) issues.push(anchored({ level: 'error', severity: 'blocker', message: `${label} 分部分项工程施工方案存在 ${genericReferencePackages.length} 个分项方案正文含“按设计图纸执行”式概括话术：${describeDivisionPackages(genericReferencePackages)}`, suggestion: '分项方案正文必须落到具体数值与参数：工程量、材料规格、设备型号等数量类数值优先取工程量清单数据，清单未覆盖的参数取图纸具体数值；禁止“按设计图纸执行/详见设计图纸/按设计文件确定”式留白。' }));
    if (dirtyPackages.length > 0) issues.push(anchored({ level: 'error', severity: 'blocker', message: `${label} 分部分项工程施工方案存在脏事实或空话污染：${describeDivisionPackages(dirtyPackages)}`, suggestion: '清理“资料内容事实”、嵌入的 ### 标题、粗体伪标题、未尽事宜、“按规范施工/结合实际执行”式空话，只保留可交付正文。' }));
    if (weakChainPackages.length > 0) issues.push(anchored({ level: 'error', severity: 'blocker', message: `${label} 分部分项工程施工方案存在 ${weakChainPackages.length} 个分项方案施工方法缺少工序顺序表达：${describeDivisionPackages(weakChainPackages)}`, suggestion: '每个分项方案的施工方法段/施工流程段必须有明确的工序顺序表达，工序环节按先后顺序逐步写清（相邻小节不得同句式开头、同一句式全文不得反复使用，禁止以固定句模复读），保证工序先后顺序清晰。' }));
    if (weakParamPackages.length > 0) issues.push(anchored({ level: 'error', severity: 'blocker', message: `${label} 分部分项工程施工方案存在 ${weakParamPackages.length} 个分项方案工艺参数不足（少于 ${DIVISION_SECTION_QUALITY.minParamsPerPackage} 个）：${describeDivisionPackages(weakParamPackages)}`, suggestion: '每个分项方案必须落位至少 4 个具体工艺参数（mm、MPa、间距、偏差、坡度、养护天数、试验压力、搭接长度等），参数来自绑定材料或行业通用规范值，不得编造。' }));
    if (shallowPackages.length > 0) issues.push(anchored({ level: 'error', severity: 'blocker', message: `${label} 分部分项工程施工方案存在 ${shallowPackages.length} 个分项方案正文过短（少于 ${DIVISION_SECTION_QUALITY.minPackageChars} 字）：${describeDivisionPackages(shallowPackages)}`, suggestion: '每个分项方案都要写足作业对象与工程量、工序安排、施工方法三方面要素，门窗维修、立面修补等小分项同样需要展开，不得一句话带过。' }));
    if (scan.imbalanced) issues.push(anchored({ level: 'warning', message: `${label} 分部分项工程施工方案分项深度失衡：最短分项不足最长分项三分之一`, suggestion: '参照最长分项（如拆除、结构加固）的展开深度，为偏短分项补足机具、材料规格、工艺参数与验收标准。' }));
  };

  if (candidateChapters.length === 0) {
    // 稳定版：关键小节以 H4 形态存在（planner 历史管线产物）时章 sections 无锚定词 → 候选为空，
    // 验收器整条跳过导致该小节无人把关（轮7 实测：5 个分项、缺 8 个骨架名、无任何报错）；
    // 全文兑底提取验证（与 majorContent 的 shouldRequireMajorContent 兑底同构）
    const content = extractDivisionSection(wholeText);
    if (!content) return issues;
    validateContent('全文', content);
    return issues;
  }

  for (const chapter of candidateChapters) {
    // 章内容前拼章标题行（幂等：内容已带标题头时不重复拼）——形态 2 靠「## 章标题」锚点
    // 限定提取范围到下一章为止（防止跨章污染）；候选章存在时不得回退全文
    // （其他章的标题会假性通过本章验证，本章真缺失即漏报 blocker）
    // r18 丰乐镇 B4/B6 归因：终检以交付 markdown 为事实源——markdown 命中本章标题时以 markdown 为唯一
    // 内容源（不再用 drafts 章 content 提取：drafts 残留已被链尾删除的块会报出交付文本中不存在的问题），
    // 未命中（标题变体超出匹配）回退 drafts（保持既有行为）
    const markdownSection = chapterSectionFromMarkdown(markdown, chapter);
    const content = markdownSection !== null
      ? extractDivisionSection(markdownSection)
      : extractDivisionSection(/^##\s+/mu.test(chapter.content) ? chapter.content : `## ${chapter.title}\n${chapter.content}`);
    if (!content) {
      issues.push({ level: 'error', severity: 'blocker', message: `${chapter.title} 分部分项工程施工方案小节缺失或标题结构异常`, suggestion: '主要施工方法章下必须逐项展开分项工程方案：既可用「### 主要分部分项工程施工方案」包装后在内部使用「#### 分项工程方案」，也可章下 H3 小节直接承载各分项方案。', chapterId: chapter.id, provenance: { detectorId: 'construction-org-division-section', fingerprint: stableHash(chapter.title) } });
      continue;
    }
    validateContent(chapter.title, content, chapter.id);
  }
  return issues;
}

/**
 * 链尾残差细分口径（content-depth-repair 收敛判定单源，r9 实机 #10/#11 归因）：
 * 与 constructionOrgDivisionSectionIssues 同源扫描（候选章/全文兜底 → 拆块 → 逐类缺陷），
 * 返回**逐分项缺陷项数之和**而非聚合 blocker 条数。聚合口径下「3 个要素不全 + 9 个参数不足」
 * 恒为 2：LLM 部分修复（如 9→8）残差不变 → 修复轮恒判「未下降」回滚丢弃全部进度 → 阻断直坠
 * 终门禁（r9 实证：主要施工方法章补写被整体回滚，终门禁照常报两条原阻断）。细分口径下任一
 * 实项修复即残差下降，收敛判定与回滚保护恢复灵敏度。小节缺失按 1 项缺陷计（与缺失 blocker
 * 同口径）；全文无分项结构且无候选章时返回 0（与检测器不报同构）。
 */
export function divisionSectionDeficitCount(chapters: DocumentDraftChapter[], markdown = ''): number {
  const wholeText = markdown || chapters.map(chapter => `${chapter.title}\n${(chapter.sections || []).join('\n')}\n${chapter.content}`).join('\n\n');
  const candidateChapters = chapters.filter(chapter => DIVISION_SECTION_RE.test(`${chapter.title} ${(chapter.sections || []).join(' ')}`));
  if (candidateChapters.length === 0) {
    const content = extractDivisionSection(wholeText);
    return content ? divisionScanDeficitTotal(scanDivisionDeficits(content)) : 0;
  }
  let total = 0;
  for (const chapter of candidateChapters) {
    const content = extractDivisionSection(/^##\s+/mu.test(chapter.content) ? chapter.content : `## ${chapter.title}\n${chapter.content}`);
    total += content ? divisionScanDeficitTotal(scanDivisionDeficits(content)) : 1;
  }
  return total;
}

// ═══════ 关键小节逐包三要素检测（G1，生成闭环确定性链挂载）═══════
// 丰乐镇第五轮实测：楼地面装饰工程/给排水采暖燃气工程只有「施工流程/施工方法」标签 H4、
// 缺「作业对象与工程量」；「项目主要施工内容」只有一个 H4 把全部专业工程混装。
// 现有评分侧验收器按 #### 切块判定，标签型 H4 被切为单维块恒报「要素不全」且无法给出缺维定位；
// 本检测器按「专业工程块」聚合判定：标签型 H4 归入父 H3 块整体判定（缺哪维报哪维），
// 专业工程型 H4 逐块判定，平铺式（无 H4）整块判定——与「呈现形式不限」口径一致。

/** 标签型 H4：三要素组织标签，本身只承担一维，不独立判定（如「#### 施工流程」） */
const ELEMENT_LABEL_H4_RE = /^####\s+(?:\d+(?:\.\d+)*\s+)?(?:施工概况|施工流程|施工方法|工艺流程)(?:[:：]|\s*$)/u;

/** 三要素缺维诊断文案（空串=齐全） */
function missingElementLabels(flags: { scope: boolean; process: boolean; method: boolean }): string {
  const missing: string[] = [];
  if (!flags.scope) missing.push('作业对象与工程量');
  if (!flags.process) missing.push('工序顺序');
  if (!flags.method) missing.push('施工方法');
  return missing.join('、');
}

/** 关键小节行范围（供 G1/G2/清单口径去词修复共用）：title + bodyLines 行区间 [startLine, endLine)；
 * 支持两种形态——
 * ①「### 1.2 项目主要施工内容」H3 关键小节（内部 H4 为专业工程，整节一块）；
 * ②「## 第二章 主要施工方法」H2 关键章（内部「### 分部」逐块，如 2.14 楼地面装饰工程）。 */
interface CriticalPackageSectionRange {
  title: string;
  startLine: number;
  endLine: number;
}

function criticalPackageSectionLineRanges(markdown: string): CriticalPackageSectionRange[] {
  const lines = markdown.split(/\r?\n/u);
  const ranges: CriticalPackageSectionRange[] = [];
  const nextHeadingAtOrAbove = (from: number, maxLevel: number): number => {
    for (let cursor = from; cursor < lines.length; cursor += 1) {
      const heading = /^(#{1,6})\s+/u.exec(lines[cursor].trim());
      if (heading && heading[1].length <= maxLevel) return cursor;
    }
    return lines.length;
  };
  for (let index = 0; index < lines.length; index += 1) {
    const h2 = /^##\s+(.+)$/u.exec(lines[index].trim());
    if (h2) {
      const title = h2[1].trim();
      if (!MAJOR_CONTENT_SECTION_RE.test(title) && !DIVISION_SECTION_RE.test(title)) continue;
      const chapterEnd = nextHeadingAtOrAbove(index + 1, 2);
      const h3Offsets: number[] = [];
      for (let cursor = index + 1; cursor < chapterEnd; cursor += 1) {
        if (/^###\s+/u.test(lines[cursor].trim())) h3Offsets.push(cursor);
      }
      if (h3Offsets.length === 0) {
        ranges.push({ title, startLine: index + 1, endLine: chapterEnd });
        continue;
      }
      for (let part = 0; part < h3Offsets.length; part += 1) {
        const start = h3Offsets[part];
        const end = part + 1 < h3Offsets.length ? h3Offsets[part + 1] : chapterEnd;
        ranges.push({ title: lines[start].trim().replace(/^###\s+/u, ''), startLine: start + 1, endLine: end });
      }
      continue;
    }
    const h3 = /^###\s+(.+)$/u.exec(lines[index].trim());
    if (h3) {
      const title = h3[1].trim();
      if (!MAJOR_CONTENT_SECTION_RE.test(title) && !DIVISION_SECTION_RE.test(title)) continue;
      const end = nextHeadingAtOrAbove(index + 1, 3);
      ranges.push({ title, startLine: index + 1, endLine: end });
    }
  }
  return ranges;
}

/** 提取关键小节块（供 G1/G2 共用）：基于行范围重建 bodyLines（与原逐行扫描逐字等价） */
function criticalPackageSectionBlocks(markdown: string): Array<{ title: string; bodyLines: string[] }> {
  const lines = markdown.split(/\r?\n/u);
  return criticalPackageSectionLineRanges(markdown).map(range => ({ title: range.title, bodyLines: lines.slice(range.startLine, range.endLine) }));
}

/** G1：关键小节逐专业工程三要素判定——缺哪维报哪维（error blocker，供修复循环定向补写） */
export function perPackageContentElementIssues(markdown: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const pushIssue = (title: string, pkgName: string, missing: string) => {
    const scopeHint = missing.includes('作业对象') ? '作业对象与工程量（本项目部位、规模/工程量、系统边界，工程量取工程量清单汇总值）' : '';
    const processHint = missing.includes('工序') ? '工序顺序（先后清晰，至少 1 处不少于 4 个环节的工序顺序表达）' : '';
    const methodHint = missing.includes('施工方法') ? '施工方法（工具机具、工艺参数、验收闭环）' : '';
    issues.push({
      level: 'error',
      severity: 'blocker',
      message: pkgName ? `「${title}」${pkgName}专业工程块缺少三要素：${missing}` : `「${title}」小节缺少三要素：${missing}`,
      suggestion: `请在「${pkgName || title}」补写缺失要素：${[scopeHint, processHint, methodHint].filter(Boolean).join('；')}。要素融入连贯段落叙述，禁止以“施工概况/施工流程/施工方法”等结构标签充当标题或段落开头引导。`,
    });
  };
  for (const block of criticalPackageSectionBlocks(markdown)) {
    const h4s = block.bodyLines
      .map((line, offset) => ({ line: line.trim(), offset }))
      .filter(item => /^####\s+/u.test(item.line));
    if (h4s.length === 0) {
      // 平铺式：整块判定（呈现形式不限——段落式三要素齐全即放行）
      const flags = workPackageContentElementFlags(block.bodyLines.join('\n'));
      const missing = missingElementLabels(flags);
      if (missing) pushIssue(block.title, '', missing);
      continue;
    }
    const labelOnly = h4s.every(item => ELEMENT_LABEL_H4_RE.test(item.line));
    if (labelOnly) {
      // 标签型组织（如 2.14 施工流程/施工方法 两 H4）：父块整体判定，缺维精确报出
      const flags = workPackageContentElementFlags(block.bodyLines.join('\n'));
      const missing = missingElementLabels(flags);
      if (missing) pushIssue(block.title, '', missing);
      continue;
    }
    // 专业工程型 H4：逐块判定；标签型 H4 跳过独立判定
    for (let index = 0; index < h4s.length; index += 1) {
      const startOffset = h4s[index].offset;
      const endOffset = index + 1 < h4s.length ? h4s[index + 1].offset : block.bodyLines.length;
      if (ELEMENT_LABEL_H4_RE.test(h4s[index].line)) continue;
      const pkgTitle = h4s[index].line.replace(/^####\s+(?:\d+(?:\.\d+)*\s+)?/u, '').replace(/[:：]\s*$/u, '');
      const body = block.bodyLines.slice(startOffset, endOffset).join('\n');
      const flags = workPackageContentElementFlags(body);
      const missing = missingElementLabels(flags);
      if (missing) pushIssue(block.title, pkgTitle, missing);
    }
  }
  return issues;
}

// ═══════ 主要施工内容清单口径治理（G2，生成闭环+评分侧同源挂载）═══════
// 丰乐镇第五轮实测：「项目主要施工内容」把整份工程量清单搬进正文（含「分部小计」「按实」等
// 清单计价表内部口径），制造跨章工程量口径漂移（2.1 道路工程 5 项数值与清单权威值不符）。
// 关键小节禁表格是既有硬规则（majorContent 提示词），此处补齐生成闭环的确定性拦截。

/** G2：关键小节清单口径治理——禁表格承载主体内容 + 禁清单内部口径词 */
export function majorContentGovernanceIssues(markdown: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const block of criticalPackageSectionBlocks(markdown)) {
    const body = block.bodyLines.join('\n');
    if (!body.trim()) continue;
    // 表格承载正文判定（V2 批1-4 起零兜底：机器拼段修复器已删除，检测阻断后交写作侧约束与 LLM 定向重写）：表格 ≥3 行且非表格实质文本 <50 字
    // 才属「以表格承载正文」；段落叙述 + 数据附表（工程量/参数汇总表）是合规形态（舒城第二轮实测误报校准）
    const bodyTableLines = body.split(/\r?\n/u).filter(line => /^\s*\|.+\|\s*$/u.test(line.trim()));
    const bodyProseChars = body.split(/\r?\n/u).filter(line => !/^\s*\|.+\|\s*$/u.test(line.trim())).join('').replace(/[\s#*_`>-]/gu, '').length;
    if (bodyTableLines.length >= 3 && bodyProseChars < 50) {
      issues.push({
        level: 'error',
        severity: 'blocker',
        message: `「${block.title}」小节不应使用 Markdown 表格承载专业工程正文`,
        suggestion: '主要施工内容/主要施工方法应采用三级小节与段落式专业工程写法：每个专业工程一个 #### 小节，覆盖作业对象与工程量、工序顺序、施工方法三方面要素；表格数据改写成连贯叙述。',
      });
    }
    // 4.31 “按实(?!际)”：「按实际需要留置」等正常规范句不含清单口径语义，原正则裸匹配“按实”误报（丰乐镇 v6 实测）
    const strongHits = [...new Set((body.match(/[^\n]{0,18}(?:分部小计|本页小计|按实(?!际)|暂估|综合单价|规费|税金)[^\n]{0,18}/gu) || []).map(item => item.trim()))];
    // 「措施项目」是工程类别名词的合法用法（2.18 措施项目小节、2.24 分部分项方案列举），
    // 仅当与清单计价语境共现（措施项目费 / 措施项目+清单/计价/费）才属清单内部口径（丰乐镇实测误报）
    const measureHits = [...new Set((body.match(/[^\n]{0,18}(?:措施项目费|措施项目[^\n]{0,8}(?:清单|计价|费率))[^\n]{0,18}/gu) || []).map(item => item.trim()))];
    const weakHits = [...new Set((body.match(/[^\n]{0,10}(?:合计|小计)[^\n]{0,16}(?:㎡|m²|m2|m³|m3|吨|t|项|处|座|樘)/gu) || []).map(item => item.trim()))];
    const jargonHits = [...new Set([...strongHits, ...measureHits, ...weakHits])];
    if (jargonHits.length > 0) {
      issues.push({
        level: 'error',
        severity: 'blocker',
        message: `「${block.title}」小节正文含工程量清单内部口径词：${jargonHits.slice(0, 6).join('；')}`,
        suggestion: '“分部小计/本页小计/合计/按实/暂估/综合单价/措施项目费/规费/税金”等清单计价表专用口径不得进入正式正文：工程量只写清单汇总的项目总量（数值与工程量清单一致），删除全部清单内部口径行。',
      });
    }
  }
  return issues;
}

// ═══════ 关键小节清单口径词确定性去词（r12 丰乐镇门禁 #10 归因） ═══════
// 「1.2 主要施工内容」正文「道路硬化及修复面积合计2783㎡」的「合计」属清单计价表内部口径词
//（weakHits 同源形态：合计/小计 + 16 字内单位），全稿 LLM 修复轮后仍残留——数值本身有权威
// 口径、无须改数，只确定性去掉「合计/小计」口径词（与 weakHits 同正则同源，复检恒清零）。
// 仅处理关键小节行范围内的非表格非标题正文行；无命中零变更（幂等）。

export interface ListingJargonFixResult {
  markdown: string;
  fixedCount: number;
  details: string[];
}

export function fixListingJargonInCriticalPackageSections(markdown: string): ListingJargonFixResult {
  const ranges = criticalPackageSectionLineRanges(markdown);
  if (ranges.length === 0) return { markdown, fixedCount: 0, details: [] };
  const lines = markdown.split(/\r?\n/u);
  const details: string[] = [];
  for (const range of ranges) {
    for (let index = range.startLine; index < Math.min(range.endLine, lines.length); index += 1) {
      const line = lines[index];
      if (!line || /^\s*\|.+\|\s*$/u.test(line.trim()) || /^#{1,6}\s+/u.test(line.trim())) continue;
      const replaced = line.replace(/(合计|小计)(?=[^\n]{0,16}(?:㎡|m²|m2|m³|m3|吨|t|项|处|座|樘))/gu, '');
      if (replaced !== line) {
        details.push(`「${line.trim().slice(0, 36)}」→「${replaced.trim().slice(0, 36)}」`);
        lines[index] = replaced;
      }
    }
  }
  if (details.length === 0) return { markdown, fixedCount: 0, details: [] };
  return { markdown: lines.join('\n'), fixedCount: details.length, details };
}
