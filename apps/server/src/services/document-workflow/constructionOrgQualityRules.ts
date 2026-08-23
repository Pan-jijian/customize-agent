import type { DocumentDraftChapter, DocumentFactsModel, DocumentTemplateChapter, ValidationIssue } from './types';
import { inferConstructionOrgProjectTypes, type ConstructionOrgProjectType } from './constructionOrgCatalog';

export const CONSTRUCTION_ORG_GENERIC_PHRASES = [
  '精心组织', '科学管理', '精益求精', '全力保障', '高效推进', '力争一流',
  '最大限度', '显著提升', '大力落实', '充分确保', '严格把控',
];

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

export function constructionOrgGenericLanguageIssues(chapters: DocumentDraftChapter[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const chapter of chapters) {
    const hits = CONSTRUCTION_ORG_GENERIC_PHRASES.filter(phrase => chapter.content.includes(phrase));
    if (hits.length > 0) {
      issues.push({
        level: 'warning',
        message: `${chapter.title} 存在施工组织设计空泛套话：${[...new Set(hits)].slice(0, 8).join('、')}`,
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
  const start = lines.findIndex(line => /^###\s+(?:\d+(?:\.\d+)*\s+)?(?:项目主要施工内容|主要施工内容)\s*$/u.test(line.trim()));
  if (start < 0) return '';
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
    const packageCount = (content.match(/^####\s+(?:\d+(?:\.\d+)*\s+)?[一二三四五六七八九十\d]*[、.．]?\s*\S+/gmu) || []).length
      || (content.match(/^[一二三四五六七八九十]+、\S+/gmu) || []).length;
    const packageBlocks = content.split(/^####\s+/gmu).slice(1).map(block => block.trim()).filter(Boolean);
    const incompletePackages = packageBlocks.filter(block => !block.includes('施工概况') || !block.includes('施工流程') || !block.includes('施工方法'));
    const dirtyPackages = packageBlocks.filter(block => /资料内容事实|#{2,6}\s+|\*\*[^*]+\*\*|未尽事宜|专业施工内容统筹|招标范围还包含|具备有效的.*资质/u.test(block));
    const weakMethodPackages = packageBlocks.filter(block => {
      const method = block.match(/施工方法[:：]([\s\S]*?)(?=\n施工|$)/u)?.[1] || '';
      return method.length < 30 || ((method.match(/工程|维修|改造|安装|设备/gu) || []).length >= 4 && !/\d|㎡|m2|m²|mm|厚|验收|检测|调试|试验|复试|记录|报告/u.test(method));
    });
    const dirtyProcessPackages = packageBlocks.filter(block => {
      const process = block.match(/施工流程[:：]([\s\S]*?)(?=\n施工方法|$)/u)?.[1] || '';
      return /未尽事宜|本项目为|总建筑面积|保留现状|专业施工内容统筹|招标文件列明|招标范围/u.test(process);
    });
    if (packageCount < 5) issues.push({ level: 'error', severity: 'blocker', message: `${label} 主要施工内容工作包不足：当前 ${packageCount} 个，要求不少于 5 个`, suggestion: '按资料识别专业工程/分部分项工作包，逐项写施工概况、施工流程、施工方法。' });
    if (incompletePackages.length > 0) issues.push({ level: 'error', severity: 'blocker', message: `${label} 主要施工内容存在 ${incompletePackages.length} 个工作包缺少施工概况/施工流程/施工方法`, suggestion: '每个工作包必须分别包含“施工概况、施工流程、施工方法”，不能只在整节中出现一次。' });
    if (dirtyPackages.length > 0) issues.push({ level: 'error', severity: 'blocker', message: `${label} 主要施工内容存在脏事实或标题污染`, suggestion: '清理“资料内容事实”、嵌入的 ### 标题、粗体伪标题、未尽事宜、招标范围罗列等污染内容，只保留可交付正文。' });
    if (weakMethodPackages.length > 0) issues.push({ level: 'error', severity: 'blocker', message: `${label} 主要施工内容存在 ${weakMethodPackages.length} 个工作包施工方法过弱`, suggestion: '施工方法不能只是工作包名称或专业范围罗列，必须写资料已确认的工程量、材料、检测、调试、验收或记录要求。' });
    if (dirtyProcessPackages.length > 0) issues.push({ level: 'error', severity: 'blocker', message: `${label} 主要施工内容存在 ${dirtyProcessPackages.length} 个工作包流程污染`, suggestion: '施工流程只能写工序链条，不能混入项目概况、总建筑面积、招标范围、未尽事宜等说明性事实。' });
    if (!/→|->/u.test(content)) issues.push({ level: 'error', severity: 'blocker', message: `${label} 主要施工内容缺少箭头式施工流程`, suggestion: '施工流程应写成“测量放线→基层处理→工序实施→检查验收→资料归档”等链条。' });
    const parameterCount = (content.match(/\d+(?:\.\d+)?\s*(?:㎡|m²|mm|cm|m|MPa|kPa|%|日历天|层|台|套|个|项|批|次|小时|年)/giu) || []).length;
    const factDetailCount = (content.match(/工程量|材料|设备|范围|流程|验收|检测|复试|调试|隐蔽|检验批|资料|记录|系统|部位|接口|规格|标准/gu) || []).length;
    if (parameterCount < 2 || factDetailCount < 12) issues.push({ level: 'error', severity: 'blocker', message: `${label} 主要施工内容事实细度不足：参数 ${parameterCount} 项、事实细节 ${factDetailCount} 项`, suggestion: '主要施工内容必须落到资料已确认的范围、工程量/材料、流程、验收和记录要求；资料未明确的工具、型号、参数不得编造。' });
    if (/^\s*\|.+\|\s*$/mu.test(content)) issues.push({ level: 'error', severity: 'blocker', message: `${label} 主要施工内容不应使用 Markdown 表格替代工作包正文`, suggestion: '主要施工内容应采用三级小节和段落式工作包写法，不使用表格承载主体内容。' });
  };

  if (candidateChapters.length === 0 && shouldRequireMajorContent) {
    const content = extractMajorConstructionSection(wholeText);
    if (!content) return [{ level: 'error', severity: 'blocker', message: '施工组织设计缺少“项目主要施工内容”小节', suggestion: '必须生成“### 项目主要施工内容”，并在该小节内部使用“#### 工作包名称”逐项展开。' }];
    validateContent('全文', content);
    return issues;
  }

  for (const chapter of candidateChapters) {
    const content = extractMajorConstructionSection(chapter.content) || extractMajorConstructionSection(wholeText);
    if (!content) {
      issues.push({ level: 'error', severity: 'blocker', message: `${chapter.title} 主要施工内容小节缺失或标题结构异常`, suggestion: '必须生成“### 项目主要施工内容”，并在该小节内部使用“#### 工作包名称”逐项展开。' });
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
        issues.push({ level: 'warning', message: `${chapter.title} 可补充隐藏高分模块：${bonusModule.title}`, suggestion: bonusModule.prompt });
      }
    }
  }
  return issues;
}
