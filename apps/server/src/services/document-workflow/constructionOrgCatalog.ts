import type { DocumentTemplate, DocumentTemplateChapter } from './types';
import { displayChapterTitle } from './outline';

export type ConstructionOrgProjectType = 'building' | 'municipal' | 'renovation' | 'decoration' | 'general';

type ModuleCategory = 'setup' | 'technical' | 'assurance' | 'environment' | 'labor' | 'external' | 'seasonal' | 'emergency' | 'digital' | 'delivery';
type RequiredLevel = 'core' | 'mandatory' | 'conditional' | 'optional';

interface ConstructionOrgModule {
  id: string;
  title: string;
  aliases: string[];
  category: ModuleCategory;
  level: RequiredLevel;
  projectTypes?: ConstructionOrgProjectType[];
  sectionItems: string[];
  queries: string[];
  facts: string[];
  tableSections?: string[];
  attachHints: string[];
}

const CORE_MODULES: ConstructionOrgModule[] = [
  {
    id: 'basis-overview',
    title: '编制说明与工程概况',
    aliases: ['编制说明', '工程概况', '项目概况', '项目基本情况', '工程基本信息'],
    category: 'setup',
    level: 'core',
    sectionItems: ['编制依据', '项目主要施工内容', '项目特点、重点、难点分析'],
    queries: ['工程概况', '编制依据', '招标范围', '建设地点', '建设规模', '工期质量目标'],
    facts: ['工程名称', '建设地点', '建设规模', '招标范围', '计划工期', '质量目标'],
    tableSections: ['项目重难点识别表'],
    attachHints: ['概况', '项目', '工程', '说明', '总纲', '部署'],
  },
  {
    id: 'organization',
    title: '项目管理组织机构与职责',
    aliases: ['组织机构', '项目管理', '岗位职责', '管理机构', '管理人员'],
    category: 'setup',
    level: 'core',
    sectionItems: ['项目管理组织架构', '管理人员岗位职责', '内外部协调机制', '劳务实名制与人员管理'],
    queries: ['项目管理组织机构', '岗位职责', '项目经理', '技术负责人', '劳资员'],
    facts: ['项目管理人员', '岗位职责', '持证人员', '管理组织'],
    tableSections: ['项目管理人员岗位职责配置表', '内外协调沟通计划表'],
    attachHints: ['组织', '管理', '部署', '概况', '保障'],
  },
  {
    id: 'deployment',
    title: '施工部署与施工流水组织',
    aliases: ['施工部署', '总体部署', '流水组织', '施工组织', '流水段'],
    category: 'setup',
    level: 'core',
    sectionItems: ['施工总体部署', '施工区段与流水段划分', '各阶段施工顺序', '多工序穿插与交叉作业管理', '资源动态调配机制'],
    queries: ['施工部署', '流水段划分', '施工顺序', '工序穿插', '资源调配'],
    facts: ['施工范围', '施工阶段', '流水段', '工期节点', '资源配置'],
    tableSections: ['施工流水段划分一览表', '交叉作业安全管控清单'],
    attachHints: ['部署', '组织', '总体', '概况', '方案'],
  },
  {
    id: 'site-layout',
    title: '施工现场平面布置与临设管理',
    aliases: ['总平面布置', '现场平面', '平面布置', '临设', '临水临电', '人车分流'],
    category: 'setup',
    level: 'core',
    sectionItems: ['施工现场总平面布置', '办公区生活区加工区材料堆放区布置', '现场交通组织与人车分流', '临时用水布置', '临时用电三级配电两级保护', '材料场内转运路线'],
    queries: ['施工总平面', '临时用电', '临时用水', '材料堆放', '场内交通'],
    facts: ['施工现场条件', '临设布置', '临水临电', '材料堆场', '交通组织'],
    tableSections: ['现场总平面分区布置表', '场内交通导改组织计划表', '临时用电负荷统计表', '临时用水布置统计表', '材料场内转运路线规划表'],
    attachHints: ['部署', '平面', '现场', '临设', '组织'],
  },
  {
    id: 'progress',
    title: '进度计划与工期保障',
    aliases: ['进度计划', '工期保障', '工期计划', '节点控制', '进度控制'],
    category: 'setup',
    level: 'core',
    sectionItems: ['总进度计划', '关键节点控制计划', '周计划日计划分解机制', '进度偏差分析与纠偏措施', '工期风险预警机制'],
    queries: ['总工期', '进度计划', '关键节点', '工期保障', '进度纠偏'],
    facts: ['计划工期', '开竣工时间', '关键节点', '资源保障'],
    tableSections: ['关键施工节点控制计划表'],
    attachHints: ['进度', '工期', '部署', '资源', '保障'],
  },
  {
    id: 'resources',
    title: '资源配置计划',
    aliases: ['资源配置', '机械设备', '劳动力', '材料计划', '人材机'],
    category: 'setup',
    level: 'core',
    sectionItems: ['主要施工机械设备投入计划', '分阶段劳动力投入计划', '主要材料进场计划', '周转材料配置计划', '资源动态调配机制'],
    queries: ['机械设备投入', '劳动力计划', '材料进场计划', '周转材料', '资源配置'],
    facts: ['机械设备', '劳动力', '材料', '工程量', '施工阶段'],
    tableSections: ['主要施工机械设备投入计划表', '分阶段劳动力动态投入计划表', '主要材料进场验收管控表'],
    attachHints: ['资源', '部署', '进度', '保障', '组织'],
  },
  {
    id: 'main-methods',
    title: '主要分部分项工程施工方案',
    aliases: ['主要施工方案', '施工方案', '施工方法', '分部分项', '工艺方案', '技术措施'],
    category: 'technical',
    level: 'core',
    sectionItems: ['主要分部分项工程施工流程', '关键工序施工工艺', '质量控制点与验收要求', '施工重难点专项措施'],
    queries: ['分部分项工程', '施工工艺', '施工方法', '验收要求', '技术措施'],
    facts: ['施工内容', '工程量', '图纸做法', '技术标准', '验收规范'],
    tableSections: ['分项工程施工控制要点表', '主要工程量一览表'],
    attachHints: ['方案', '施工', '技术', '工艺', '措施'],
  },
  {
    id: 'quality',
    title: '质量管理体系与质量保证措施',
    aliases: ['质量管理', '质量保证', '质量控制', '质量措施', '验收管理'],
    category: 'assurance',
    level: 'core',
    sectionItems: ['质量管理目标', '三检制度', '样板引路制度', '隐蔽工程验收', '原材料进场复试与见证取样', '实测实量与质量通病治理', '成品保护专项措施', '质量问题闭环整改机制'],
    queries: ['质量保证措施', '三检制度', '样板引路', '隐蔽验收', '质量通病', '成品保护'],
    facts: ['质量目标', '验收标准', '材料复试', '质量控制点'],
    tableSections: ['隐蔽工程验收清单表', '分项工程质量控制要点表', '质量通病防治清单表', '样板引路实施计划表', '成品保护管控清单表'],
    attachHints: ['质量', '保障', '保证', '措施', '管理', '验收'],
  },
  {
    id: 'safety-risk',
    title: '安全管理、风险分级与危大工程管控',
    aliases: ['安全管理', '安全措施', '风险分级', '危大工程', '安全生产', '隐患排查'],
    category: 'assurance',
    level: 'core',
    sectionItems: ['安全管理目标', '危险源辨识与风险分级管控', '危大工程辨识清单', '危大工程专项施工方案审批流程', '安全技术逐级交底', '临边洞口高处作业起重吊装消防临电管理', '安全隐患排查与闭环整改', '应急救援组织与应急演练'],
    queries: ['安全管理', '风险分级管控', '危大工程', '安全技术交底', '临时用电', '消防安全'],
    facts: ['安全目标', '危大工程', '风险源', '安全标准', '应急要求'],
    tableSections: ['危险源辨识与风险分级管控清单', '危大工程全流程闭环管控表', '安全防护设施验收计划表', '交叉作业安全管控清单', '消防设施布置表'],
    attachHints: ['安全', '风险', '危大', '保障', '措施', '管理'],
  },
  {
    id: 'environment-green',
    title: '文明施工、扬尘、噪声与绿色施工',
    aliases: ['文明施工', '扬尘治理', '噪声管控', '绿色施工', '环保措施', '四节一环保', '建筑垃圾'],
    category: 'environment',
    level: 'core',
    sectionItems: ['文明施工目标', '扬尘污染专项管控', '噪声分时段管控', '施工废水沉淀处理', '建筑垃圾分类回收', '四节一环保措施', '智慧工地与在线监测'],
    queries: ['文明施工', '扬尘治理', '噪声管控', '绿色施工', '建筑垃圾分类', '四节一环保'],
    facts: ['文明施工目标', '扬尘要求', '噪声要求', '环保标准', '垃圾处置'],
    tableSections: ['环境污染物管控指标一览表', '建筑垃圾分类管理表', '噪声分级管控表'],
    attachHints: ['文明', '环保', '绿色', '扬尘', '噪声', '保障', '措施'],
  },
  {
    id: 'labor-wage',
    title: '农民工工资保障与劳务管理',
    aliases: ['农民工工资', '工资保障', '劳务管理', '实名制', '银行代发', '工资专户'],
    category: 'labor',
    level: 'mandatory',
    sectionItems: ['劳务实名制管理', '农民工工资专用账户', '银行代发制度', '工资按月足额发放', '考勤台账与工资支付台账', '工资保证金与劳资纠纷处置'],
    queries: ['农民工工资保障', '劳务实名制', '工资专用账户', '银行代发', '工资支付台账'],
    facts: ['劳务管理要求', '工资支付要求', '实名制要求'],
    tableSections: ['农民工工资管控台账表', '劳务实名制管理台账表'],
    attachHints: ['工资', '劳务', '实名', '保障', '措施', '管理'],
  },
  {
    id: 'external-protection',
    title: '周边环境、管线与既有建构筑物保护',
    aliases: ['周边环境', '管线保护', '地下管线', '既有建筑', '交通导行', '居民沟通'],
    category: 'external',
    level: 'conditional',
    sectionItems: ['周边道路居民区学校医院商业区识别', '既有地下管线探测与保护', '临近建构筑物沉降监测', '交通导行与公众安全保障', '居民沟通与投诉响应机制'],
    queries: ['地下管线保护', '周边环境保护', '交通导行', '居民沟通', '临近建筑沉降监测'],
    facts: ['周边环境', '地下管线', '交通条件', '居民区', '既有建筑'],
    tableSections: ['临近建筑地下管线保护清单表', '交通导改组织计划表'],
    attachHints: ['周边', '管线', '交通', '居民', '市政', '改造', '保护', '环境', '方案'],
  },
  {
    id: 'seasonal',
    title: '季节性施工保障',
    aliases: ['季节性施工', '雨季施工', '夏季高温', '冬季施工', '防汛', '大风天气'],
    category: 'seasonal',
    level: 'core',
    sectionItems: ['雨季施工措施', '夏季高温施工措施', '冬季施工措施', '防汛防雷大风天气应急措施'],
    queries: ['季节性施工', '雨季施工', '高温施工', '冬季施工', '防汛措施'],
    facts: ['施工季节', '当地气候', '工期节点', '防汛要求'],
    tableSections: ['季节性施工资源配置表'],
    attachHints: ['季节', '雨季', '高温', '冬季', '防汛', '保障', '措施'],
  },
  {
    id: 'emergency',
    title: '应急管理体系',
    aliases: ['应急管理', '应急预案', '应急救援', '事故处置', '演练计划'],
    category: 'emergency',
    level: 'core',
    sectionItems: ['应急组织架构', '应急物资储备', '高处坠落物体打击坍塌触电火灾暴雨大风高温中暑专项预案', '应急响应流程', '应急演练计划', '事故上报与复盘整改'],
    queries: ['应急预案', '应急组织', '应急物资', '应急演练', '事故上报'],
    facts: ['应急要求', '安全风险', '应急物资', '演练计划'],
    tableSections: ['应急物资储备清单表', '应急演练计划表'],
    attachHints: ['应急', '预案', '救援', '安全', '保障', '措施'],
  },
  {
    id: 'digital-bim',
    title: 'BIM、智慧工地与创新加分模块',
    aliases: ['BIM', '智慧工地', '数字化', '智能监测', '创新加分', 'AI视频识别'],
    category: 'digital',
    level: 'optional',
    sectionItems: ['BIM场地布置优化', 'BIM管线综合深化', '4D进度模拟', '智慧工地视频监控', '扬尘噪声实名制塔机黑匣子监测', 'AI视频识别与风险预警'],
    queries: ['BIM应用', '智慧工地', '数字化管控', '扬尘在线监测', '实名制管理'],
    facts: ['智慧工地要求', 'BIM要求', '监测设备', '信息化管理'],
    tableSections: ['BIM智慧工地应用点表', '智慧工地监测点位清单'],
    attachHints: ['BIM', '智慧', '数字', '创新', '加分', '保障', '措施'],
  },
  {
    id: 'delivery',
    title: '竣工清理、验收移交与保修',
    aliases: ['竣工验收', '竣工清理', '验收移交', '资料归档', '保修', '分户验收'],
    category: 'delivery',
    level: 'conditional',
    sectionItems: ['竣工清理与垃圾外运', '缺陷修补与复查销项', '竣工资料归档', '验收移交与保修响应'],
    queries: ['竣工验收', '资料归档', '验收移交', '保修响应', '竣工清理'],
    facts: ['竣工要求', '验收标准', '移交要求', '保修要求'],
    tableSections: ['竣工清理与移交计划表'],
    attachHints: ['竣工', '验收', '移交', '保修', '收尾'],
  },
];

const PROJECT_TYPE_MODULES: Record<Exclude<ConstructionOrgProjectType, 'general'>, ConstructionOrgModule[]> = {
  building: [
    {
      id: 'building-methods',
      title: '房建工程专项施工工艺',
      aliases: ['房建', '基础主体', '主体结构', '二次结构', '屋面防水', '多塔吊'],
      category: 'technical',
      level: 'conditional',
      projectTypes: ['building'],
      sectionItems: ['基坑开挖及支护', '基坑降水及沉降监测', '钢筋模板混凝土施工', '砌体及二次结构施工', '屋面与厨卫防水闭水试验', '机电预留预埋', '多塔吊作业防碰撞'],
      queries: ['房建工程施工', '主体结构', '二次结构', '屋面防水', '多塔防碰撞'],
      facts: ['建筑结构', '层数高度', '基础形式', '主体结构', '防水做法'],
      tableSections: ['多塔防碰撞管控表', '隐蔽工程验收清单表'],
      attachHints: ['方案', '施工', '技术', '工艺', '房建', '主体'],
    },
  ],
  municipal: [
    {
      id: 'municipal-methods',
      title: '市政工程专项施工工艺',
      aliases: ['市政', '道路', '管网', '沟槽', '交通导改', '雨污水'],
      category: 'technical',
      level: 'conditional',
      projectTypes: ['municipal'],
      sectionItems: ['全线现场踏勘与地下管线探测', '交通导改与占道施工', '沟槽开挖支护与降排水', '雨污水管道铺设与闭水试验', '路基分层碾压与压实度检测', '水稳基层与沥青面层施工', '新旧管网道路接驳与竣工移交'],
      queries: ['市政工程', '交通导改', '地下管线', '沟槽开挖', '管道闭水', '沥青摊铺'],
      facts: ['道路长度', '管线类型', '交通条件', '沟槽深度', '路面结构'],
      tableSections: ['既有管线保护管控表', '交通导改组织计划表'],
      attachHints: ['方案', '施工', '技术', '工艺', '市政', '道路', '管网'],
    },
  ],
  renovation: [
    {
      id: 'renovation-methods',
      title: '老旧小区改造专项施工组织',
      aliases: ['老旧小区', '小区改造', '改造工程', '飞线整治', '雨污分流'],
      category: 'technical',
      level: 'conditional',
      projectTypes: ['renovation'],
      sectionItems: ['居民沟通协调机制', '楼栋单元分区分段施工', '原有建构筑物与既有设施保护', '外墙空鼓铲除加固与屋面翻新防水', '雨污管网分流与飞线整治', '降噪防尘与不中断通行保障'],
      queries: ['老旧小区改造', '居民沟通', '分区施工', '既有保护', '飞线整治', '雨污分流'],
      facts: ['小区现状', '居民通行', '改造范围', '既有设施', '外墙屋面'],
      tableSections: ['居民沟通协调计划表', '既有成品保护清单表'],
      attachHints: ['方案', '施工', '技术', '工艺', '改造', '小区', '居民'],
    },
  ],
  decoration: [
    {
      id: 'decoration-methods',
      title: '装饰装修工程专项施工工艺',
      aliases: ['装饰装修', '装修', '精装修', '吊顶', '墙地面', '成品保护'],
      category: 'technical',
      level: 'conditional',
      projectTypes: ['decoration'],
      sectionItems: ['墙地面基层处理与挂网防开裂', '厨卫阳台分层防水与48小时闭水试验', '吊顶龙骨加固与木构件防火防腐', '墙地面铺装空鼓防控与阴阳角收口', '交叉施工工序优化', '室内空气质量管控与成品保护'],
      queries: ['装饰装修', '基层处理', '闭水试验', '吊顶龙骨', '成品保护', '室内空气质量'],
      facts: ['装修范围', '材料做法', '防水部位', '吊顶做法', '环保要求'],
      tableSections: ['成品保护管控清单表', '交叉施工工序优化表'],
      attachHints: ['方案', '施工', '技术', '工艺', '装饰', '装修'],
    },
  ],
};

export const CONSTRUCTION_ORG_CATALOG = [...CORE_MODULES, ...PROJECT_TYPE_MODULES.building, ...PROJECT_TYPE_MODULES.municipal, ...PROJECT_TYPE_MODULES.renovation, ...PROJECT_TYPE_MODULES.decoration];

function normalizeText(text: string) {
  return displayChapterTitle(text).replace(/\s+/gu, '').toLowerCase();
}

function uniqueAppend(base: string[] | undefined, additions: string[], limit?: number) {
  const seen = new Set<string>();
  const merged = [...(base || []), ...additions]
    .map(item => item.trim())
    .filter(item => item && !seen.has(item) && (seen.add(item), true));
  return typeof limit === 'number' ? merged.slice(0, limit) : merged;
}

function uniquePrepend(base: string[] | undefined, additions: string[], limit?: number) {
  const seen = new Set<string>();
  const merged = [...additions, ...(base || [])]
    .map(item => item.trim())
    .filter(item => item && !seen.has(item) && (seen.add(item), true));
  return typeof limit === 'number' ? merged.slice(0, limit) : merged;
}

function isConstructionOrgDocument(input: { template: DocumentTemplate; chapters: DocumentTemplateChapter[]; requirement?: string }) {
  const text = normalizeText(`${input.template.name} ${input.template.outputTitle || ''} ${input.requirement || ''} ${input.chapters.map(chapter => chapter.title).join(' ')}`);
  if (/施工组织设计|施工组织|施组|技术标|投标技术|施工方案/u.test(text)) return true;
  const hitCount = ['施工', '工程', '质量', '安全', '进度', '文明', '部署', '方案'].filter(token => text.includes(token)).length;
  return hitCount >= 3 && !/监理|可研|运维|维护|保养/u.test(text);
}

export function inferConstructionOrgProjectTypes(input: { template: DocumentTemplate; chapters: DocumentTemplateChapter[]; requirement?: string }): ConstructionOrgProjectType[] {
  const text = normalizeText(`${input.template.name} ${input.template.outputTitle || ''} ${input.requirement || ''} ${input.chapters.map(chapter => chapter.title).join(' ')}`);
  const types: ConstructionOrgProjectType[] = [];
  if (/市政|道路|管网|雨污|污水|给水|沟槽|交通导|沥青|水稳|检查井/u.test(text)) types.push('municipal');
  if (/老旧小区|小区改造|改造|修缮|飞线|居民|雨污分流/u.test(text)) types.push('renovation');
  if (/装饰|装修|精装|吊顶|墙地面|乳胶漆|瓷砖|石材|室内/u.test(text)) types.push('decoration');
  if (/房建|住宅|办公楼|厂房|主体结构|基础|屋面|二次结构|塔吊|建筑/u.test(text)) types.push('building');
  return types.length ? [...new Set(types)] : ['general'];
}

function moduleApplies(module: ConstructionOrgModule, projectTypes: ConstructionOrgProjectType[], text: string) {
  if (!module.projectTypes?.length) return true;
  if (module.projectTypes.some(type => projectTypes.includes(type))) return true;
  return module.aliases.some(alias => text.includes(normalizeText(alias))) || module.sectionItems.some(item => text.includes(normalizeText(item)));
}

function chapterModuleScore(chapterTitle: string, module: ConstructionOrgModule) {
  const title = normalizeText(chapterTitle);
  let score = 0;
  for (const hint of module.attachHints) if (title.includes(normalizeText(hint))) score += 5;
  for (const alias of module.aliases) {
    const normalized = normalizeText(alias);
    if (title.includes(normalized) || normalized.includes(title)) score += 12;
  }
  if (/概况|部署|组织|平面|资源|进度/u.test(title) && module.category === 'setup') score += 6;
  if (/方案|施工|技术|工艺|分部分项|方法/u.test(title) && module.category === 'technical') score += 8;
  if (/保障|保证|措施|管理/u.test(title) && ['assurance', 'environment', 'labor', 'seasonal', 'emergency', 'digital'].includes(module.category)) score += 6;
  if (/质量/u.test(title) && module.id === 'quality') score += 15;
  if (/安全|危大|风险/u.test(title) && module.id === 'safety-risk') score += 15;
  if (/文明|环保|扬尘|噪声|绿色/u.test(title) && module.id === 'environment-green') score += 15;
  if (/工资|劳务|实名/u.test(title) && module.id === 'labor-wage') score += 15;
  if (/应急|预案/u.test(title) && module.id === 'emergency') score += 15;
  if (/季节|雨季|冬季|高温|防汛/u.test(title) && module.id === 'seasonal') score += 15;
  if (/周边|管线|交通|居民|保护/u.test(title) && module.id === 'external-protection') score += 12;
  if (/BIM|智慧|数字|创新/iu.test(chapterTitle) && module.id === 'digital-bim') score += 15;
  if (/竣工|验收|移交|保修/u.test(title) && module.id === 'delivery') score += 15;
  return score;
}

function defaultTargetChapterIndex(module: ConstructionOrgModule, chapters: DocumentTemplateChapter[]) {
  let best = { index: 0, score: -1 };
  chapters.forEach((chapter, index) => {
    const score = chapterModuleScore(chapter.title, module);
    if (score > best.score) best = { index, score };
  });
  if (best.score > 0) return best.index;
  const categoryFallbacks: Record<ModuleCategory, RegExp> = {
    setup: /概况|部署|组织|资源|进度|总体/u,
    technical: /方案|施工|技术|工艺|措施/u,
    assurance: /保障|保证|措施|管理|质量|安全/u,
    environment: /保障|措施|文明|环保|绿色/u,
    labor: /保障|措施|劳务|工资/u,
    external: /方案|施工|周边|保护|交通/u,
    seasonal: /保障|措施|季节|雨季/u,
    emergency: /保障|措施|应急|安全/u,
    digital: /保障|措施|智慧|BIM|创新/u,
    delivery: /竣工|验收|移交|收尾/u,
  };
  const fallback = chapters.findIndex(chapter => categoryFallbacks[module.category].test(chapter.title));
  return fallback >= 0 ? fallback : Math.max(0, chapters.length - 1);
}

function isNarrowScopeChapterTitle(title: string) {
  return /雨季|冬季|高温|防汛|扬尘|噪声|工资|劳务|实名|应急|BIM|智慧|管线|交通导改|垃圾分类|多塔|成品保护/u.test(title);
}

function shouldAttachModule(catalogModule: ConstructionOrgModule, chapter: DocumentTemplateChapter, projectTypes: ConstructionOrgProjectType[], allText: string) {
  if (!moduleApplies(catalogModule, projectTypes, allText)) return false;
  const title = normalizeText(chapter.title);
  const inChapterScope = catalogModule.aliases.some(alias => title.includes(normalizeText(alias))) || catalogModule.sectionItems.some(item => title.includes(normalizeText(item)));
  if (inChapterScope) return true;
  if (isNarrowScopeChapterTitle(chapter.title)) return false;
  const score = chapterModuleScore(chapter.title, catalogModule);
  if (score >= 10) return true;
  if (catalogModule.level === 'optional') return score >= 12 || /BIM|智慧|数字|创新/iu.test(allText);
  if (catalogModule.level === 'conditional') return score >= 8 || catalogModule.projectTypes?.some(type => projectTypes.includes(type)) === true || catalogModule.aliases.some(alias => allText.includes(normalizeText(alias)));
  return score >= 6;
}

function moduleSectionTitle(catalogModule: ConstructionOrgModule, chapter: DocumentTemplateChapter) {
  const title = normalizeText(chapter.title);
  if (catalogModule.aliases.some(alias => title.includes(normalizeText(alias))) || title.includes(normalizeText(catalogModule.title))) return catalogModule.title;
  return catalogModule.title;
}

function hasBroadCarrierChapter(chapters: DocumentTemplateChapter[]) {
  return chapters.some(chapter => /概况|部署|总体|组织|主要施工方案|保障|保证|综合措施|管理体系/u.test(chapter.title) && !/雨季|冬季|高温|防汛|扬尘|噪声|工资|劳务|应急|BIM|智慧|管线|交通导改/u.test(chapter.title));
}

export function enrichConstructionOrgOutline(input: { template: DocumentTemplate; chapters: DocumentTemplateChapter[]; requirement?: string }) {
  if (!isConstructionOrgDocument(input)) return input.chapters;
  const projectTypes = inferConstructionOrgProjectTypes(input);
  const allText = normalizeText(`${input.template.name} ${input.template.outputTitle || ''} ${input.requirement || ''} ${input.chapters.map(chapter => `${chapter.title} ${(chapter.sections || []).join(' ')}`).join(' ')}`);
  const hasBroadCarrier = hasBroadCarrierChapter(input.chapters);
  const applicableModules = CONSTRUCTION_ORG_CATALOG.filter(catalogModule => moduleApplies(catalogModule, projectTypes, allText));
  const attached = new Set<string>();
  const enriched = input.chapters.map(chapter => ({ ...chapter, sections: [...(chapter.sections || [])], queries: [...(chapter.queries || [])], requiredFacts: [...(chapter.requiredFacts || [])], tableSections: [...(chapter.tableSections || [])] }));

  for (const catalogModule of applicableModules) {
    const matchingIndexes = enriched
      .map((chapter, index) => ({ index, score: chapterModuleScore(chapter.title, catalogModule), chapter }))
      .filter(item => shouldAttachModule(catalogModule, item.chapter, projectTypes, allText))
      .sort((a, b) => b.score - a.score);
    const targetIndex = matchingIndexes[0]?.index ?? ((hasBroadCarrier && (catalogModule.level === 'core' || catalogModule.level === 'mandatory')) ? defaultTargetChapterIndex(catalogModule, enriched) : -1);
    if (targetIndex < 0) continue;
    const target = enriched[targetIndex];
    const sectionTitle = moduleSectionTitle(catalogModule, target);
    target.sections = uniqueAppend(target.sections, [sectionTitle, ...catalogModule.sectionItems], 50);
    target.queries = uniqueAppend(target.queries, [catalogModule.title, ...catalogModule.queries], 30);
    target.requiredFacts = uniqueAppend(target.requiredFacts, catalogModule.facts, 30);
    target.tableSections = uniqueAppend(target.tableSections, catalogModule.tableSections || [], 20);
    target.purpose = `${target.purpose}；系统已按施工组织设计标准模块库自动挂靠“${catalogModule.title}”，仅在本章范围内展开与章节语义、项目类型和资料事实合理相关的内容，禁止机械塞入无关内容。`;
    attached.add(catalogModule.id);
  }

  const missingMandatory = hasBroadCarrier ? applicableModules.filter(catalogModule => (catalogModule.level === 'mandatory' || catalogModule.level === 'core') && !attached.has(catalogModule.id)) : [];
  for (const catalogModule of missingMandatory) {
    const targetIndex = defaultTargetChapterIndex(catalogModule, enriched);
    const target = enriched[targetIndex];
    target.sections = uniqueAppend(target.sections, [catalogModule.title, ...catalogModule.sectionItems], 50);
    target.queries = uniqueAppend(target.queries, [catalogModule.title, ...catalogModule.queries], 30);
    target.requiredFacts = uniqueAppend(target.requiredFacts, catalogModule.facts, 30);
    target.tableSections = uniqueAppend(target.tableSections, catalogModule.tableSections || [], 20);
    target.purpose = `${target.purpose}；系统已补足施工组织设计必备模块“${catalogModule.title}”，需以合理挂靠方式呈现，不改变用户一级章节。`;
  }

  const hasMajorConstructionContent = enriched.some(chapter => /项目主要施工内容|主要施工内容/u.test(`${chapter.title} ${(chapter.sections || []).join(' ')}`));
  if (!hasMajorConstructionContent) {
    const setupModule = CORE_MODULES.find(module => module.id === 'basis-overview');
    const targetIndex = enriched.findIndex(chapter => /概况|重点|难点|部署|总体|施工|保障/u.test(chapter.title));
    const target = enriched[targetIndex >= 0 ? targetIndex : 0];
    target.sections = uniquePrepend(target.sections, ['项目主要施工内容'], 50);
    target.queries = uniqueAppend(target.queries, ['项目主要施工内容', ...(setupModule?.queries || [])], 30);
    target.requiredFacts = uniqueAppend(target.requiredFacts, setupModule?.facts || ['施工内容', '工程量', '施工范围'], 30);
    target.purpose = `${target.purpose}；系统已补足施工组织设计必备小节“项目主要施工内容”，必须按工作包展开施工概况、施工流程、施工方法。`;
  }

  return enriched;
}
