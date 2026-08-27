import type { DocumentFactsModel, DocumentTemplateChapter, ProjectGraph, WritingTaskBrief, WritingTaskBriefChapter } from './types';
import { inferConstructionOrgProjectTypes } from './constructionOrgCatalog';

/**
 * L3 生成管线：施工组织设计写作任务书构建器。
 * 在章节生成前为每章生成结构化写作任务卡（写作目标/必覆盖/事实域/BOQ 目标/缺口），
 * 注入章节写作 roleContext，替代"章节自由发挥"式的叙述生成。
 */

const CHAPTER_FOCUS_RULES: Array<{ pattern: RegExp; goal: string; mustCover: string[] }> = [
  { pattern: /概况|总体|理解|说明|编制/u, goal: '以项目资料已确认的事实卡片展开工程概况与总体理解，不得空泛概述', mustCover: ['工程名称、建设地点、建设规模、计划工期、质量标准等资料已确认事实', '现场条件与招标范围边界', '编制依据与适用范围'] },
  { pattern: /主要施工内容/u, goal: '按工作包展开施工概况、施工流程、施工方法三段式卡片，落到工程量与工艺参数', mustCover: ['资料识别的工作包（不少于5个）', '每个工作包的施工概况/施工流程/施工方法', '工程量、材料设备规格、检测验收与资料闭环'] },
  // 分部分项专属规则：历史上“主要分部分项工程施工方案”章 12 条全部不匹配落默认 goal（概略根因之一），
  // 与 writingSpec 专项提示词同口径（每个分项方案三段式+4 参数+4 环节工序链）
  { pattern: /主要分部分项工程施工方案|主要施工方法/u, goal: '按分项工程方案展开施工概况、工艺流程、施工方法三段式，落到工艺参数与工序链', mustCover: ['资料明确的专业工程范围（逐项展开分项工程方案）', '每个分项方案的施工概况/工艺流程/施工方法', '每个分项方案不少于4个工艺参数与至少1条4环节箭头工序链', '工艺参数来自绑定材料或行业通用规范值，不得编造'] },
  { pattern: /重点|难点/u, goal: '识别项目重点难点并给出针对性对策，每项落到责任岗位与验收节点', mustCover: ['重点难点成因与影响范围', '对应施工内容与专项措施', '责任岗位、检查频次、整改闭环'] },
  { pattern: /部署|总体|流水|顺序/u, goal: '明确施工部署逻辑、流水段划分与资源调配机制', mustCover: ['施工区段与流水划分', '各阶段施工顺序与穿插关系', '资源动态调配机制'] },
  { pattern: /进度|工期/u, goal: '围绕总工期与关键节点展开进度保障', mustCover: ['总进度计划与关键节点', '周/日计划分解', '进度偏差识别与纠偏措施'] },
  { pattern: /质量/u, goal: '覆盖材料验收、过程控制、隐蔽验收、整改复验的质量闭环', mustCover: ['质量目标与验收依据', '三检制度与样板引路', '隐蔽工程验收与材料复试', '质量通病防治与闭环整改', '保修与缺陷责任期承诺'] },
  { pattern: /安全|危大|风险/u, goal: '覆盖风险识别、危大工程专项方案、检查整改与应急响应', mustCover: ['危险源辨识与风险分级', '危大工程清单与专项方案', '安全交底与隐患排查闭环'] },
  { pattern: /资源|材料|设备|劳动力|人材机/u, goal: '说明资源配置依据、进场验收与保管调配', mustCover: ['机械设备投入计划', '分阶段劳动力计划', '材料进场计划与验收'] },
  { pattern: /文明|绿色|环保|扬尘|噪声/u, goal: '覆盖扬尘噪声管控、四节一环保与智慧监测', mustCover: ['扬尘噪声分时段管控', '四节一环保措施', '监测预警与台账'] },
  { pattern: /应急|预案/u, goal: '覆盖应急组织、物资储备与专项预案', mustCover: ['应急组织架构', '应急物资储备', '专项预案与演练计划'] },
  { pattern: /竣工|验收|移交|保修/u, goal: '覆盖竣工清理、验收移交与保修响应', mustCover: ['竣工清理与垃圾外运', '缺陷修补与复查销项', '验收移交与保修响应'] },
  { pattern: /工资|劳务|实名/u, goal: '覆盖劳务实名制与农民工工资保障闭环', mustCover: ['劳务实名制管理', '工资专用账户与银行代发', '考勤与工资支付台账'] },
];

function chapterFocusRule(chapterTitle: string) {
  return CHAPTER_FOCUS_RULES.find(rule => rule.pattern.test(chapterTitle));
}

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
  const globalWritingFocus = [
    '正文必须落到本项目资料已确认的事实，不得使用模板化空话或跨小节复制段落',
    '措施类内容写成“责任岗位+执行动作+量化标准+检查频次+整改时限+复查销项”闭环句式：同一自然段内三要素（责任岗位+检查频次+整改闭环）须同时出现，全文每 1500 字至少 1 段闭环句式',
    '正文每 1000 字至少落位 6 处带单位量化工艺参数（mm/MPa/养护天数/间距/压实度等），施工流程与施工方法用“→”箭头工序链串联，每个分部分项方案至少 1 条 4 环节以上工序链',
    '工作包级小节按"施工概况/施工流程/施工方法"三段式展开',
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
      ? [...globalWritingFocus, '招标硬性要求必须逐项明确响应：质量标准、计划工期、缺陷责任期与保修、安全文明目标、项目经理及组织机构；工期/质量/保修类承诺可在概况与质量章节落位，不得遗漏', ...(canonicalLines.length ? [`项目可信基础事实（写作时必须优先落位）：${canonicalLines.slice(0, 10).join('；')}`] : [])]
      : globalWritingFocus.slice(0, 2),
    chapters,
  };
}
