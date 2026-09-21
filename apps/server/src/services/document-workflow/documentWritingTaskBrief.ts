import type { DocumentFactsModel, DocumentTemplateChapter, ProjectGraph, WritingTaskBrief, WritingTaskBriefChapter } from './types';
import { inferConstructionOrgProjectTypes } from './constructionOrgProjectTypes';

/**
 * L3 生成管线：施工组织设计写作任务书构建器。
 * 在章节生成前为每章生成结构化写作任务卡（写作目标/必覆盖/事实域/BOQ 目标/缺口），
 * 注入章节写作 roleContext，替代"章节自由发挥"式的叙述生成。
 */

const CHAPTER_FOCUS_RULES: Array<{ pattern: RegExp; goal: string; mustCover: string[] }> = [
  { pattern: /概况|总体|理解|说明|编制/u, goal: '以项目资料已确认的事实卡片展开工程概况与总体理解，不得空泛概述', mustCover: ['工程名称、建设地点、建设规模、计划工期、质量标准等资料已确认事实', '现场条件与招标范围边界', '编制依据与适用范围（按五类逐项列全：招标文件及补疑补遗、国家法律法规、国家/行业现行规范标准、地方法规规章、企业管理体系；地方法规规章必须结合工程所在地属地的现行地方性法规与政府规章，不得只写笼统一句话）', 'B5 专业工程清单：资料识别的专业工程逐个展开（不少于 5 个，每个专业工程写明作业对象与工程量、工序顺序、施工方法三方面要素，落到工程量与工艺参数）'] },
  { pattern: /主要施工内容/u, goal: '按专业工程展开作业对象与工程量、工序顺序、施工方法三方面要素（呈现形式不限），落到工程量与工艺参数', mustCover: ['资料识别的专业工程（不少于5个）', '每个专业工程的作业对象与工程量/工序顺序/施工方法三方面要素', '工程量、材料设备规格、检测验收与资料闭环'] },
  // 分部分项专属规则：历史上“主要分部分项工程施工方案”章 12 条全部不匹配落默认 goal（概略根因之一），
  // 与 writingSpec 专项提示词同口径（每个分项方案三要素+4 参数+工序顺序表达）
  { pattern: /主要分部分项工程施工方案|主要施工方法/u, goal: '按分项工程方案展开作业对象与工程量、工序顺序、施工方法三方面要素（呈现形式不限），落到工艺参数与工序顺序', mustCover: ['资料明确的专业工程范围（逐项展开分项工程方案）', '每个分项方案的作业对象与工程量/工序顺序/施工方法三方面要素', '每个分项方案不少于4个工艺参数与至少1处3环节以上工序顺序表达', '工艺参数来自绑定材料或行业通用规范值，不得编造'] },
  { pattern: /重点|难点/u, goal: '识别项目重点难点并给出针对性对策，每项落到责任岗位与验收节点', mustCover: ['重点难点成因与影响范围', '对应施工内容与专项措施', '责任岗位、检查频次、整改闭环'] },
  { pattern: /部署|总体|流水|顺序/u, goal: '明确施工部署逻辑、流水段划分与资源调配机制', mustCover: ['施工区段与流水划分', '各阶段施工顺序与穿插关系', '资源动态调配机制'] },
  { pattern: /进度|工期/u, goal: '围绕总工期与关键节点展开进度保障', mustCover: ['总进度计划与关键节点', '周/日计划分解', '进度偏差识别与纠偏措施'] },
  { pattern: /质量/u, goal: '覆盖材料验收、过程控制、隐蔽验收、整改复验的质量闭环', mustCover: ['质量目标与验收依据', '三检制度与样板引路', '隐蔽工程验收与材料复试', '见证取样送检、试块养护、分部分项报验等质量保障制度逐项落位', '质量通病防治与闭环整改', '保修与缺陷责任期承诺'] },
  { pattern: /安全|危大|风险/u, goal: '覆盖风险识别、危大工程专项方案、检查整改与应急响应', mustCover: ['危险源辨识与风险分级', '危大工程辨识清单逐项完整（按项目实际情况覆盖基坑支护与降水、模板支撑、脚手架、起重吊装、吊篮、拆除等适用项，逐项写明辨识依据，不得遗漏）', '危大工程专项方案编制与审批程序', '安全交底与隐患排查闭环', '施工现场临时用电三级配电两级保护：总配电箱/分配电箱/开关箱三级配电，两级漏电保护（总箱与开关箱各一级，漏电动作电流与动作时间参数落位），TN-S 接零保护系统，漏电保护器每周试跳 1 次', 'B5 生产安全事故应急预案与应急演练（八部分结构：总则、组织机构及职责、风险分析与危险源辨识、应急物资设备与通讯保障、专项应急预案、应急响应、后期处置、培训演练）：逐部分展开，演练频次量化（如每半年 1 次），物资储备清单化'] },
  { pattern: /资源|材料|设备|劳动力|人材机/u, goal: '说明资源配置依据、进场验收与保管调配', mustCover: ['机械设备投入计划', '分阶段劳动力计划', '材料进场计划与验收'] },
  { pattern: /文明|绿色|环保|扬尘|噪声/u, goal: '覆盖扬尘噪声管控、四节一环保与智慧监测', mustCover: ['扬尘治理六个百分百逐项落位（施工工地周边 100% 围挡、物料堆放 100% 覆盖、出入车辆 100% 冲洗、施工现场地面 100% 硬化、拆迁工地 100% 湿法作业、渣土车辆 100% 密闭运输；不涉及拆迁的写明豁免理由）', '扬尘噪声分时段管控', '监测预警与台账', '绿色施工与四节一环保措施：绿色施工按《绿色施工评价标准》GB/T 50640 分阶段评价（每阶段不少于 1 次，评价记录归档）', 'B5 四节一环保量化指标：节水（非传统水源利用率/用水量控制）、节材（材料损耗率/废弃物回收率）、节地（土方平衡率）、节能（能耗指标）各至少 1 项带单位量化指标，附录八基准对照项逐项量化响应'] },
  { pattern: /应急|预案/u, goal: '覆盖应急组织、物资储备与专项预案', mustCover: ['应急组织架构', '应急物资储备', '专项预案与演练计划'] },
  { pattern: /竣工|验收|移交|保修/u, goal: '覆盖竣工清理、验收移交与保修响应', mustCover: ['竣工清理与垃圾外运', '缺陷修补与复查销项', '验收移交与保修响应'] },
  { pattern: /工资|劳务|实名/u, goal: '覆盖劳务实名制与农民工工资保障闭环', mustCover: ['建筑工人实名制管理（实名登记率 100%、实名制管理平台考勤）', '农民工工资专用账户与银行代发（专用账户开设、按月足额代发、工资保证金）', '考勤与工资支付台账', '工伤保险办理与参保信息管理（作业人员工伤保险按项目参保、参保信息纳入实名制管理、工伤事故申报处置流程）'] },
];

/**
 * 章标题 → 该章的写作重点规则（G 线 P1-9 导出：写作端逐章注入 roleContext）。
 * 规则里承载的是**最稀缺的要求知识**（危大辨识清单逐项完整、应急预案八部分、扬尘六个百分百、
 * 四节一环保量化指标、农民工工资专用账户…），此前只进 UI 展示与事后审查，写作端看不到。
 */
export function chapterFocusRule(chapterTitle: string) {
  return CHAPTER_FOCUS_RULES.find(rule => rule.pattern.test(chapterTitle));
}

/**
 * V2 批1-5 写作侧红线约束（单源）：与 structureIntegrityRules 统一扫描源及 qualityValidation
 * 表格完整性/占位符口径同源——检测器能拦的结构与数据缺陷在写作提示词前置声明，让 LLM
 * 从源头不产出（重点在写时，检测与清理只作安全网）。
 * 消费方：①并入全局写作焦点（任务书单一事实源）；②逐章注入 stageChapterLoop roleContext（写作 prompt 实注入）。
 */
export const WRITING_INTEGRITY_CONSTRAINTS: readonly string[] = [
  '【结构完整性红线】有序列表编号必须从「1.」起连续、不得跳号或重号，小节内列表独立起编、不得继承父级编号；编号后必须紧跟实质内容（禁止孤立编号）；禁止双重冒号「：：」「；：」「。：」等行尾标点残留；禁止句子中途截断（行尾无终止标点）与整段重复行；每个小节必须有实质正文，禁止只写标题的空小节',
  '【表格规范红线】每张表只允许一个表头行（禁止重复表头），表名必须独立成行（禁止混入表头首格）；数据行不得留空单元格；禁止用「—/若干/约/待定/暂无/待补充」等占位或模糊表达代替具体数据（合计行的「—」与规格型号列「机具无型号」的「—」除外）；合计行数值必须可由明细行相加推导；列数与表头一致；说明性内容必须用段落承载，禁止用表格单元格堆砌正文',
  '【数据口径红线（宁缺毋假）】同一指标（劳动力总数、机械台数、工期阶段划分、班组人数等）全文档只允许一套口径，禁止在不同章节或表格中并列矛盾数值；禁止自行取平均值、保守值、众数等在多套口径中盲选统一；无法从资料锁定唯一数值时不得写具体数值（改用定性表述或显式标注待核），严禁编造数值或将候选值随手择一写入',
  '【禁止资料堆砌伪段落】禁止以「本项目主要施工内容包括：X的Y量为Z……」「经识别，本项目工程量为：……」式清单罗列句充当正文段落；禁止把资料条目用顿号/分号首尾相接拼成伪句子；每段必须是连贯的施工描述（含施工对象、工序逻辑、工艺做法、参数落位），工程量清单类明细如需呈现应使用规范表格，不得用罗列句复制表格内容',
  '【工期时序与分批口径红线】时间表述必须符合施工时序逻辑：前期准备动作（施工方案编制报审、图纸会审、交底、考察、封样、检测、培训演练、采购调查等）的完成时限必须落在施工准备阶段内，禁止出现「开工令下发后第 N 日内」且 N 达到或超过总工期的写法（等同于把前期动作排到竣工日）；机械、设备、劳动力分批进场表述（首批/剩余/补充进场）各批次数量必须能合计推导为进场总数且与资源配置表同口径，禁止分批数量与总数互相矛盾',
];

export function buildWritingTaskBrief(input: {
  chapters: DocumentTemplateChapter[];
  factsModel?: DocumentFactsModel;
  projectGraph?: ProjectGraph;
  requirement?: string;
  templateName?: string;
}): WritingTaskBrief {
  const projectTypes = inferConstructionOrgProjectTypes({ template: { id: 'runtime', name: input.templateName || '', outputTitle: '', description: '', category: '', chapters: input.chapters }, chapters: input.chapters, requirement: input.requirement });
  const isConstructionOrg = /施工组织设计|施工组织|施组|技术标/u.test(`${input.templateName || ''} ${input.requirement || ''} ${input.chapters.map(chapter => chapter.title).join(' ')}`) || projectTypes.length > 0;
  const canonicalLines = Object.values(input.factsModel?.canonical?.byKey || {}).map(fact => `${fact.label}=${fact.value}`);
  // 模块2：项目规模事实卡——将规模口径裁决值单独显化，写作 LLM 必须区分「总占地」与「建筑总量」，
  // 历史缺陷：正文把占地约10970㎡误当建筑规模写入（实际单体建筑面积 28570.36㎡），被反向改错 13 处
  const scaleFactLines = canonicalLines.filter(line => /建设规模|建筑面积|占地|用地面积|装配|层数|高度/u.test(line)).slice(0, 8);
  const globalWritingFocus = [
    '正文必须落到本项目资料已确认的事实，不得使用模板化空话或跨小节复制段落',
    '措施类内容写成“责任岗位+执行动作+量化标准+检查频次+整改时限+复查销项”闭环句式：同一自然段内三要素（责任岗位+检查频次+整改闭环）须同时出现，全文每 1500 字至少 1 段闭环句式；不得以固定句模复读，三要素分散融入叙述（相邻小节不得同句式开头，同一句式全文不得反复使用）',
    '措施类段落必须落位完整五要素链——方案（专项施工方案/技术措施）、流程（施工工序/工艺流程）、责任岗位（项目经理/技术负责人/安全员等）、检查频次（每周/每日不少于 N 次）、验收整改闭环（检查验收/整改/复查/销项）——五个要素词面每 1500 字至少 1 段完整覆盖',
    '【规范术语显性落位】凡涉及强制性管理制度的段落，小节标题与正文首句必须显性使用规范术语原词（如「建筑工人实名制管理」「农民工工资专用账户」「生产安全事故应急预案与应急演练」「危险性较大的分部分项工程」「扬尘污染防治措施」「绿色施工与四节一环保」「施工现场临时用电三级配电两级保护」），禁止只写近义改写（如把“实名制管理”写成“人员考勤登记”、把“应急预案”写成“处置办法”）；评审按规范术语原词做语义匹配，术语不显性即判内容缺失',
    '正文每 1000 字至少落位 6 处带单位量化工艺参数（mm/MPa/养护天数/间距/压实度等），施工流程与施工方法须有明确的工序顺序表达（相邻小节不得同句式开头，同一句式全文不得反复使用，禁止以固定句模复读），每个分部分项方案至少 1 处 3 环节以上工序顺序表达',
    '专业工程类小节必须覆盖作业对象与工程量、工序顺序、施工方法三方面要素（必须融入连贯段落叙述，禁止以"施工概况/施工流程/施工方法"等结构标签充当标题或段落开头引导），小节标题用专业工程正式名称（如"拆除工程"），禁止使用"工作包"等后台概念命名',
    '质量目标与创优目标必须使用招标文件原文的奖项名称逐字落位，禁止替换、降级或省略为其他奖项名称（如把招标文件指定奖项写成其他奖项）；招标文件"确保/达到"类等级要求不得弱化为"争创/争取"',
    'B5 属地创优目标（属地适配项）：招标文件未明确具体奖项时，正文必须提出不低于招标文件要求的属地创优目标（如“争创市级优质工程”“争创市级安全文明标准化工地”，市名须为工程所在地），并在质量与文明施工章节落位',
    'B5 表格数据一致性（实测缺陷：合计行与阶段明细之和不符、班组人数多值并存）：表格类内容（劳动力投入、材料配置、机械设备等）合计行数值必须与上方明细行数据一致、可由各行相加推导；各阶段人数与全项目峰值人数必须显式区分口径并保持一致（如写明“阶段高峰人数按阶段分别统计，合计行仅列全项目峰值口径”）；同一班组人数在配置表与进退场表中必须同值，不得多值并存',
    ...WRITING_INTEGRITY_CONSTRAINTS,
  ];
  const chapters: WritingTaskBriefChapter[] = input.chapters.map(chapter => {
    const rule = chapterFocusRule(chapter.title);
    const graphWorks = (input.projectGraph?.works || [])
      .filter(work => work.name && (chapter.title.includes(work.name.slice(0, 2)) || /概况|总体|施工内容|方案|施工/u.test(chapter.title)))
      .slice(0, 10);
    const boqTargets = (input.projectGraph?.resources || [])
      .filter(resource => resource.quantity && /概况|资源|总体|施工内容|方案/u.test(chapter.title))
      .slice(0, 12)
      .map(resource => ({ itemCode: '', itemName: resource.name, quantity: resource.quantity, unit: resource.unit }));
    return {
      chapterId: chapter.id,
      chapterTitle: chapter.title,
      writingGoal: rule?.goal || '结合本章标题与项目资料事实展开专业内容，避免泛化叙述',
      mustCover: [...(rule?.mustCover || []), ...(chapter.requiredFacts || []).slice(0, 6)],
      factDomains: [...(chapter.requiredFacts || []), ...graphWorks.map(work => work.name)].slice(0, 10),
      evidenceRefs: chapter.queries.slice(0, 6).map(query => ({ filePath: query, kind: 'query', priority: 'should' as const })),
      boqTargets,
      drawingTargets: [],
      gaps: [],
    };
  });
  return {
    documentType: isConstructionOrg ? '施工组织设计' : '专业文档',
    globalWritingFocus: isConstructionOrg
      ? [...globalWritingFocus, '招标硬性要求必须逐项明确响应：质量标准、计划工期、缺陷责任期与保修、安全文明目标、项目经理及组织机构；工期/质量/保修类承诺可在概况与质量章节落位，不得遗漏', ...(scaleFactLines.length ? [`项目规模事实卡（口径裁决值，正文引用规模数据必须与之一致，不得混淆总占地与建筑总量口径）：${scaleFactLines.join('；')}`] : []), ...(canonicalLines.length ? [`项目可信基础事实（写作时必须优先落位）：${canonicalLines.slice(0, 10).join('；')}`] : [])]
      : globalWritingFocus.slice(0, 2),
    chapters,
  };
}
