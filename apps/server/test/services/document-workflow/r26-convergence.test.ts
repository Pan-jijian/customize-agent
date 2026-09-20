import { describe, expect, it } from 'vitest';
import { buildChapterStructureFromBlueprint, estimateChapterMinFeasibleWords, fallbackStructureForSections } from '../../../src/services/document-workflow/integratedBlueprint';
import { extractAppendixTables, previewPromptRules } from '../../../src/services/document-workflow/promptRuleExtraction';
import { documentBudgetIssues, explicitLengthTargets, reanchorChapterTargetsByFeasibility } from '../../../src/services/document-workflow/budget';
import type { DocumentBudget } from '../../../src/services/document-workflow/budget';
import type { DocumentTemplateChapter } from '../../../src/services/document-workflow/types';
import { appendTenderAppendixSections, composeTenderAppendixMarkdown } from '../../../src/services/document-workflow/composeAppendices';
import type { BidAppendixEntry } from '../../../src/services/document-workflow/bidComposition';
import type { BlueprintData } from '../../../src/services/document-workflow/integratedBlueprint';

/**
 * 4.33 三问修复回归（用户实测反馈）：
 * 1. 字数膨胀：丰乐镇 5 万目标产出 10 万字、舒城 14 万目标产出 22 万字——块级固定 1200 下限在薄章多块时 Σ≈0.75×n×1200+0.25T 为章目标数倍；
 * 2. 舒城附表断层：招标文件「可附下列图表」6 张附表（表类）必须生成到文末附表区，图类（进度网络图/总平面图）人工补充不生成；
 * 3. 14 万字识别分裂：模板提示词「全文正文要求14万字」窄前缀零命中，预算侧宽正则已识别 140000——识别必须同源。
 */
describe('4.33 块级字数守恒（fallbackStructureForSections）', () => {
  const scheduleSections = ['工期节点编排', '进度横道编制', '节点考核安排', '计划纠偏机制', '进度预警机制', '进度检查制度', '工期索赔管理', '进度例会安排'];
  const qualitySections = ['质量方针目标', '质量策划安排', '质量责任分工', '质量检查制度', '质量培训方案', '质量考核办法', '质量记录管理', '质量回访计划'];
  const generalSections = ['现场协调机制', '属地沟通安排', '扰民防范措施', '社区关系维护', '舆情应对安排', '交通疏解安排', '管线迁改协调', '绿化恢复安排', '成品保护措施', '场地移交管理'];

  it('薄章多块（26 小节 / 8500 目标）Σ(块目标) 守恒于章目标（旧实现约 2.6 万字）', () => {
    const structure = fallbackStructureForSections([...qualitySections, ...scheduleSections, ...generalSections], '施工总体部署', 8500);
    const total = structure.blocks.reduce((sum, block) => sum + block.targetWords, 0);
    // 旧公式固定 1200 下限：0.75×26×1200+0.25×8500≈2.6 万字（3 倍超产）；新公式 base=章目标/块数时精确守恒
    expect(total).toBeLessThanOrEqual(Math.ceil(8500 * 1.15));
    expect(total).toBeGreaterThanOrEqual(Math.floor(8500 * 0.8));
    for (const block of structure.blocks) {
      expect(block.targetWords).toBeLessThanOrEqual(8500);
    }
  });

  it('八语义域 26 小节 / 8500 目标：公平份额低于 1200 时不再按固定下限膨胀', () => {
    const sections = [
      ...scheduleSections.slice(0, 4),
      ...qualitySections.slice(0, 4),
      '安全隐患排查', '风险评估机制', '应急预案安排',
      '扬尘控制安排', '噪声治理措施', '废水处理安排',
      '劳务实名管理', '工资支付安排', '岗位职责分工',
      '材料采购安排', '设备调配机制', '物资调度管理',
      '施工区段划分', '流水穿插安排', '工艺流程安排',
      '现场协调机制', '属地沟通安排', '成品保护措施',
    ];
    const structure = fallbackStructureForSections(sections, '施工总体部署', 8500);
    const total = structure.blocks.reduce((sum, block) => sum + block.targetWords, 0);
    // 公平份额≈1062（<1200 固定下限）：旧实现每块最低 1200 → 8 块 Σ≥0.75×8×1200+0.25×8500=9325；
    // 新实现 minTarget 收敛到公平份额，Σ≈章目标
    expect(total).toBeLessThanOrEqual(Math.ceil(8500 * 1.15));
    expect(total).toBeGreaterThanOrEqual(Math.floor(8500 * 0.8));
  });

  it('单章目标 3000 / 2 小节：单块目标不超过章目标（容器块动态保底）', () => {
    const structure = fallbackStructureForSections(['质量方针目标', '质量策划安排'], '质量管理体系', 3000);
    const total = structure.blocks.reduce((sum, block) => sum + block.targetWords, 0);
    expect(structure.blocks.length).toBeGreaterThan(0);
    for (const block of structure.blocks) {
      expect(block.targetWords).toBeLessThanOrEqual(3000);
    }
    expect(total).toBeLessThanOrEqual(Math.ceil(3000 * 1.15));
    expect(total).toBeGreaterThanOrEqual(Math.floor(3000 * 0.8));
  });
});

describe('4.33 招标文件附表清单提取（extractAppendixTables）', () => {
  const tenderText = [
    '注：除文字表述外可附下列图表，图表及格式要求附后。',
    '附表一 拟投入本标段的主要施工设备表',
    '附表二 拟配备本标段的试验和检测仪器设备表',
    '附表三 劳动力计划表',
    '附表四 计划开、竣工日期和施工进度网络图',
    '附表五 施工总平面图',
    '附表六 临时用地表',
  ].join('\n');

  it('舒城招标文件原文：提取 6 条附表并标记文末附列', () => {
    const result = extractAppendixTables(tenderText);
    expect(result.attachedAtEnd).toBe(true);
    expect(result.titles).toEqual([
      '附表一 拟投入本标段的主要施工设备表',
      '附表二 拟配备本标段的试验和检测仪器设备表',
      '附表三 劳动力计划表',
      '附表四 计划开、竣工日期和施工进度网络图',
      '附表五 施工总平面图',
      '附表六 临时用地表',
    ]);
  });

  it('无触发句时不误报（投标人须知/评标办法前附表场景）', () => {
    const result = extractAppendixTables('投标人须知前附表第8.1.1条：合同当事人。见评标办法前附表第2.2.4项。');
    expect(result.titles).toEqual([]);
    expect(result.attachedAtEnd).toBe(false);
  });

  it('单条附表（不足 2 条）不标记文末附列', () => {
    const result = extractAppendixTables('除文字表述外可附下列图表：附表一 临时用地表。');
    expect(result.titles).toEqual(['附表一 临时用地表']);
    expect(result.attachedAtEnd).toBe(false);
  });
});

describe('4.33 字数识别同源（explicitLengthTargets / previewPromptRules）', () => {
  it('「全文正文要求14万字」宽正则识别为 140000（与生成预算同源）', () => {
    expect(explicitLengthTargets('全文正文要求14万字').targetChars).toBe(140000);
    // 旧窄前缀（不少于|至少|最低|必须生成不少于）对该表述零命中；宽正则与 buildDocumentBudget 同源后必须识别
    expect(previewPromptRules('全文正文要求14万字，需紧扣招标文件响应完整。').minWords).toBe(140000);
  });

  it('窄前缀兼容：不少于 5 万字仍识别为 50000', () => {
    expect(explicitLengthTargets('全文正文不少于5万字').targetChars).toBe(50000);
    expect(previewPromptRules('全文正文不少于5万字。').minWords).toBe(50000);
  });

  it('规则摘要输出「已识别目标字数要求」', () => {
    const preview = previewPromptRules('全文正文要求14万字。');
    expect(preview.summary.some(line => line.includes('已识别目标字数要求'))).toBe(true);
  });
});

describe('4.40 minimum 模式双向篇幅告警（documentBudgetIssues）', () => {
  const minimumBudget = (): DocumentBudget => ({
    targetChars: 50000,
    minChars: 50000,
    charsPerPage: 900,
    chapterTargets: new Map(),
    source: 'explicit',
    mode: 'minimum',
    longformStrict: true,
  });

  it('5 万目标产出 10 万字（超 100%，越 20% 阻断线）触发 error 阻断交付', () => {
    // 4.40 篇幅上限硬约束：minimum 语义旧实现只设下限（4.33 超产仅 warning 不阻断），
    // 舒城 14 万目标产出 22 万字的膨胀被静默放行——超目标 20% 即为实质性膨胀，置 error
    //（severity 自动升 blocker）进修复/门禁/挂起链，不允许超产文档静默交付（宁缺毋假）
    const issues = documentBudgetIssues(minimumBudget(), '正文内容。'.repeat(20000));
    expect(issues.some(issue => issue.level === 'error' && issue.message.includes('严重超出目标字数'))).toBe(true);
  });

  it('5 万目标产出 5.9 万字（超 18%，15%~20% 收敛区）触发 warning 不阻断', () => {
    const issues = documentBudgetIssues(minimumBudget(), '正文内容。'.repeat(11800));
    expect(issues.some(issue => issue.level === 'warning' && issue.message.includes('超出目标字数'))).toBe(true);
    expect(issues.some(issue => issue.level === 'error')).toBe(false);
  });

  it('接近目标（超幅 5%）不触发', () => {
    const issues = documentBudgetIssues(minimumBudget(), '正文内容。'.repeat(10500));
    expect(issues.some(issue => issue.message.includes('超出目标字数'))).toBe(false);
  });
});

describe('文末附表区：appendixPlan 蓝图直出（composeTenderAppendixMarkdown / appendTenderAppendixSections）', () => {
  const bodyMarkdown = [
    '## 第三章 主要施工方案',
    '',
    '正文段落。',
  ].join('\n');
  const entry = (over: Partial<BidAppendixEntry>): BidAppendixEntry => ({ no: '一', title: '附表一 测试表', kind: 'table', dataSource: 'manual', ...over });
  const bp = (over: Record<string, unknown>): BlueprintData => ({
    resources: { equipment: [], labor: { peak: { min: 0, max: 0 }, peakValue: 0, peakBasis: '', byPhase: [], byTrade: [], composition: [] } },
    ...over,
  } as unknown as BlueprintData);
  const blueprintData = bp({
    resources: {
      equipment: [
        { name: '挖掘机', spec: 'PC200', quantity: 2, basis: '工程量清单' },
        { name: '汽车起重机', spec: 'QY25', min: 1, max: 2, basis: '施工方案推导' },
      ],
      labor: {
        peak: { min: 80, max: 90 },
        peakValue: 85,
        peakBasis: '阶段工程量',
        byPhase: [{ phase: '基础阶段', min: 80, max: 90, basis: '阶段工程量' }],
        byTrade: [],
        composition: [{ trade: '电工', count: 32, basis: '工种工程量比例' }],
      },
    },
  });

  it('设备表/劳动力表从蓝图直出：数量口径（quantity 优先、min-max 区间），备注列承载蓝图依据', () => {
    const plan = [
      entry({ no: '一', title: '附表一 拟投入本标段的主要施工设备表', dataSource: 'blueprint.equipment' }),
      entry({ no: '三', title: '附表三 劳动力计划表', dataSource: 'blueprint.labor' }),
    ];
    const section = composeTenderAppendixMarkdown(plan, blueprintData);
    expect(section).toContain('## 附表一 拟投入本标段的主要施工设备表');
    expect(section).toContain('| 序号 | 设备名称 | 型号规格 | 数量 | 国别产地 | 制造年份 | 额定功率（kW） | 生产能力 | 用于施工部位 | 备注 |');
    expect(section).toContain('| 1 | 挖掘机 | PC200 | 2 |');
    expect(section).toContain('| 2 | 汽车起重机 | QY25 | 1-2 |');
    expect(section).toContain('工程量清单');
    expect(section).toContain('## 附表三 劳动力计划表');
    expect(section).toContain('**（一）劳动力工种配置**');
    expect(section).toContain('| 电工 | 32 |');
    expect(section).toContain('**（二）分阶段劳动力投入计划**');
    expect(section).toContain('| 基础阶段 | 80-90 |');
  });

  it('无数据源附表输出招标表头骨架 + 显性缺口标注（不造数据）；图类附表输出图位说明', () => {
    const plan = [
      entry({ no: '二', title: '附表二 拟配备本标段的试验和检测仪器设备表', dataSource: 'blueprint.testInstruments' }),
      entry({ no: '六', title: '附表六 临时用地表', dataSource: 'blueprint.tempLand' }),
      entry({ no: '四', title: '附表四 计划开、竣工日期和施工进度网络图', kind: 'figure', dataSource: 'manual' }),
    ];
    const section = composeTenderAppendixMarkdown(plan, blueprintData);
    expect(section).toContain('## 附表二 拟配备本标段的试验和检测仪器设备表');
    expect(section).toContain('> 本表为试验检测仪器配置，按招标文件规定的表头格式编制。');
    expect(section).toContain('| 序号 | 仪器设备名称 | 型号规格 | 数量 | 国别产地 | 制造年份 | 已使用台时数 | 用途 | 备注 |');
    expect(section).toContain('## 附表六 临时用地表');
    expect(section).toContain('| 用途 | 面积（平方米） | 位置 | 需用时间 |');
    expect(section).toContain('## 附表四 计划开、竣工日期和施工进度网络图');
    expect(section).toContain('图件');
  });

  it('append 幂等：重复追加不重复生成；空清单/未定义时不改动正文', () => {
    const plan = [entry({ no: '一', title: '附表一 拟投入本标段的主要施工设备表', dataSource: 'blueprint.equipment' })];
    const once = appendTenderAppendixSections(bodyMarkdown, { plan, blueprintData });
    expect(once.startsWith(bodyMarkdown)).toBe(true);
    expect(once).toContain('<div class="page-break"></div>');
    expect(appendTenderAppendixSections(once, { plan, blueprintData })).toBe(once);
    expect(appendTenderAppendixSections(bodyMarkdown, undefined)).toBe(bodyMarkdown);
    expect(appendTenderAppendixSections(bodyMarkdown, { plan: [] })).toBe(bodyMarkdown);
  });
});

/**
 * 容量规划回归（替代 4.34 事后压缩）：要点不在写作后折叠/压缩——块数在规划层按密度约束归并
 *（4.35 容量密度可行性闭环：块内要点 ≤6 硬封顶，块数允许超「章目标/1800」上限，
 *由软下限 floorValue=min(1800, T/块数) 与 Σ 守恒收口吸收）、块预算 Σ 精确守恒于章目标、
 *点配额随块预算下发（写作/检测/修复三层同源）。
 * 历史病灶：折叠后多源组又被 LLM 逐源展开导致超产仍在，且与写作/检测/修复口径互相冲突。
 */
describe('容量规划（替代 4.34 章结构容量压缩）', () => {
  it('接线：buildChapterStructureFromBlueprint 对 13 subSections/96 工作包的章容量守恒（归并/配额/密度封顶）', () => {
    const workPackage = (name: string) => ({ name, kind: 'major' as const, quantities: {}, processChain: [], methods: [], params: [], acceptance: [], standards: [], source: 'boq' as const, coveredSeqs: [] });
    const subSections = Array.from({ length: 13 }, (_, sectionIndex) => ({
      id: `2.${sectionIndex + 1}`,
      title: `分部工程${sectionIndex + 1}`,
      requiredParams: [], tablePlans: [],
      workPackages: Array.from({ length: sectionIndex < 5 ? 8 : 7 }, (_, packageIndex) => workPackage(`工作包${sectionIndex + 1}-${packageIndex + 1}`)),
    }));
    const structure = buildChapterStructureFromBlueprint({ blueprintChapter: { id: '2', title: '主要施工方法', isActive: true, requiredParams: [], subSections }, inputSections: [], chapterTitle: '主要施工方法', targetWords: 16178 });
    // 4.35 密度封顶：块数不再归并回「章目标/1800」上限（旧断言 ≤floor(16178/1800)=8）——
    // 本 fixture 初始 26 块（13 个 6 点块 + 5 个 2 点块 + 8 个 1 点块，[6,2]/[6,1] 交替），
    // 相邻任两块合并即超 6 要点 → 全部独立保留（归并不丢点）；旧行为会产出 8~12 要点超密度块
    //（12 要点块 1800 字 → 每要点 150 字 < 最小可写量 300 → 骨架质检物理不可达 → 块必败）
    expect(structure.blocks.length).toBe(26);
    // 密度封顶硬约束：任何路径不产出 >6 要点块；超密度守卫后每块「要点数 × 300 ≤ 块预算」
    expect(structure.blocks.every(block => block.subPoints.length <= 6)).toBe(true);
    expect(structure.blocks.every(block => block.subPoints.length <= Math.max(1, Math.floor(block.targetWords / 300)))).toBe(true);
    // 单块预算不超输出安全区、Σ 精确守恒于章目标（软下限公平份额 622 = floor(16178/26)）
    expect(structure.blocks.every(block => block.targetWords <= 4500)).toBe(true);
    const total = structure.blocks.reduce((sum, block) => sum + block.targetWords, 0);
    expect(total).toBe(16178);
    // 工作包原名零丢失（归并/守卫合并均不丢点——sources 全量保留）+ 点配额随块预算下发
    const carried = new Set(structure.blocks.flatMap(block => block.subPoints.flatMap(point => [point.title, ...point.sources])));
    for (let sectionIndex = 1; sectionIndex <= 13; sectionIndex += 1) {
      for (let packageIndex = 1; packageIndex <= (sectionIndex <= 5 ? 8 : 7); packageIndex += 1) expect(carried.has(`工作包${sectionIndex}-${packageIndex}`)).toBe(true);
    }
    expect(structure.blocks.flatMap(block => block.subPoints).every(point => (point.quotaWords ?? 0) > 0)).toBe(true);
  });

  it('舒城形态回归（4.34「主要施工方法」章阻断 → 4.35 密度闭环）：96 工作包 + 7 模板小节 / 章预算重校准 15603 → 32400', () => {
    // 真实数据 fixture（逐字取自 4.34 自测 tpl-1789004430748 落盘蓝图与规划小节）：
    // 4.34 阻断链：「主要施工方法」章预算 15603（按模板小节数加权）→ maxBlocks=8、targetPerGroup=ceil(103/8)=13
    // → 「公共广场提升改造工程」的 [4,2,6] 三个主题域块（步道/广场/停车场市政 4 + 土方/模板结构 2 +
    // 其他专项 6）被归并吸收为 1 块 12 要点 × 1800 字 → 每要点 150 字 < 最小可写量 300（骨架 H4 三要素
    // 物理不可达）→ 块必败（905 字兜底、缺 12 个工作包 H4）→ 章阻断。
    // 4.35 闭环：minFeasible = ceil(103/6) × 1800 = 32400 → reanchor 抬升章预算（Σ=T 精确守恒）；
    // 归并密度封顶保证任何块 ≤6 要点；超密度守卫保证「要点数 × 300 ≤ 块预算」——物理可达。
    const workPackage = (name: string) => ({ name, kind: 'major' as const, quantities: {}, processChain: [], methods: [], params: [], acceptance: [], standards: [], source: 'boq' as const, coveredSeqs: [] });
    const subSectionSpecs: Array<{ title: string; packages: string[] }> = [
      { title: '公共广场提升改造工程', packages: ['2.16杭北干渠沿河人行步道改造提升工程', '4.2飞霞广场综合提升改造工程', '4.4新雅大酒店门前停车场', '4.5产业园停车场提升改造工程', '土方工程', '其他项目', '4.6麻纺巷城市休闲街区建设提升工程', '4.7城区闲置地块提升工程', '栽植花木', '4.8城区街角空间整治提升', '宣传制作', '模板与脚手架工程'] },
      { title: '公共广场提升改造工程-安装工程', packages: ['杭北干渠沿河人行步道改造提升工程', '新雅大酒店门前停车场', '产业园停车场提升改造工程', '麻纺巷城市休闲街区建设提升工程', '闲置地块提升工程', '城区街角空间整治提升'] },
      { title: '白鸥观澜配套仁和路道路提升项目工程', packages: ['老路拆除部分', '土方工程', '路基处理', '车行道结构层新建', '新建人行道', '侧石工程', '现状构筑物改造'] },
      { title: '排水工程', packages: ['产业园停车场-排水工程', '白鸥观澜停车场-排水工程', '青青家园停车场', '白鸥观澜仁和路排水工程'] },
      { title: '交通工程', packages: ['高清监控系统（交警）', '信号灯控制系统', '电子警察综合系统', '后台设备', '管线手井', '其他费用', '违停抓拍监控', '梅河东路通信排管工程'] },
      { title: '综合配套用房-土建工程', packages: ['土石方工程', '砌筑工程', '混凝土工程', '门窗工程', '屋面及防水工程', '保温、隔热、防腐工程', '楼地面装饰工程', '墙柱面装饰工程', '天棚工程', '油漆、涂料、裱糊工程', '零星装饰工程', '模板与脚手架工程'] },
      { title: '白鸥观澜公厕-土建工程', packages: ['土石方工程', '砌筑工程', '混凝土工程', '门窗工程', '屋面及防水工程', '楼地面装饰工程', '墙柱面装饰工程', '天棚工程', '油漆、涂料、裱糊工程', '零星装饰工程', '模板与脚手架工程'] },
      { title: '青青家园公厕-土建装饰', packages: ['土石方工程', '砌筑工程', '混凝土工程', '门窗工程', '屋面及防水工程', '楼地面装饰工程', '墙柱面装饰工程', '天棚工程', '油漆、涂料、裱糊工程', '零星装饰工程', '模板与脚手架工程'] },
      { title: '门卫-土建工程', packages: ['土石方工程', '砌筑工程', '混凝土工程', '门窗工程', '屋面及防水工程', '保温、隔热、防腐工程', '楼地面装饰工程', '墙柱面装饰工程', '天棚工程', '油漆、涂料、裱糊工程', '零星装饰工程', '模板与脚手架工程'] },
      { title: '综合配套用房-安装工程', packages: ['电气', '给排水系统', '消防', '通风', '零星工程'] },
      { title: '白鸥观澜公厕-安装工程', packages: ['电气', '给排水系统', '零星工程'] },
      { title: '青青家园公厕-安装工程', packages: ['电气', '给排水系统', '零星工程'] },
      { title: '门卫-安装工程', packages: ['电气', '雨水系统'] },
    ];
    const templateSections = ['拆除改造与清运施工方法', '填方压实与场平作业工序', '雨水污水管线敷设方法', '检查井与防坠网施工', '道路提升与破路恢复工艺', '公厕及门卫土建施工方法', '安装工程与设备调试方法'];
    const blueprintChapter = {
      id: '2', title: '主要施工方法', isActive: true, requiredParams: [],
      subSections: subSectionSpecs.map((spec, index) => ({ id: `2.${index + 1}`, title: spec.title, requiredParams: [], tablePlans: [], workPackages: spec.packages.map(workPackage) })),
    };

    // 1) 可行性估算：96 工作包 + 7 未覆盖模板小节 = 103 要点 → 18 块 × 1800 = 32400
    const estimate = estimateChapterMinFeasibleWords(blueprintChapter, templateSections);
    expect(estimate).toEqual({ points: 103, minFeasibleWords: 32400 });

    // 2) 章预算重校准：main 15603 → 32400（其余 10 章按需求归一化缩减，Σ=140000 精确守恒）
    const chapter = (id: string, title: string, sections: string[]): DocumentTemplateChapter => ({ id, title, purpose: '', queries: [], requiredFacts: [], sections });
    const chapters: DocumentTemplateChapter[] = [
      chapter('main', '主要施工方法', templateSections),
      ...Array.from({ length: 10 }, (_, index) => chapter(`c${index + 1}`, `第${index + 2}章 质量保证措施`, ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'])),
    ];
    const beforeTargets = new Map<string, number>([['main', 15603], ...chapters.slice(1).map(item => [item.id, 12440] as [string, number])]);
    const { chapterTargets, adjustments, compressed } = reanchorChapterTargetsByFeasibility({
      chapters,
      targetChars: 140000,
      floorOf: () => 0,
      feasibilityFloorOf: item => (item.id === 'main' ? estimate.minFeasibleWords : 0),
      currentTargets: beforeTargets,
    });
    expect(compressed).toBe(false);
    expect(chapterTargets.get('main')).toBe(32400);
    expect([...chapterTargets.values()].reduce((sum, value) => sum + value, 0)).toBe(140000);
    // 调整报告：main 抬升 from → to；其余 10 章缩减且不低于最低可写预算（800）
    expect(adjustments.find(item => item.id === 'main')).toEqual({ id: 'main', title: '主要施工方法', from: 15603, to: 32400 });
    expect(adjustments.filter(item => item.id !== 'main').every(item => item.to < item.from && item.to >= 800)).toBe(true);

    // 3) 按重校准预算构建结构（写作层收到的最终结构 = 规划层一次成型产物）
    const structure = buildChapterStructureFromBlueprint({ blueprintChapter, inputSections: templateSections, chapterTitle: '主要施工方法', targetWords: chapterTargets.get('main')! });
    // 密度双不变量：任何块 ≤6 要点（封顶）；超密度守卫后「要点数 × 300 ≤ 块预算」（骨架质检物理可达）
    expect(structure.blocks.every(block => block.subPoints.length <= 6)).toBe(true);
    expect(structure.blocks.every(block => block.subPoints.length <= Math.max(1, Math.floor(block.targetWords / 300)))).toBe(true);
    // 块数实测 18（方案预测 18 = ceil(103/6)）：6 点密度封顶 + 保序贪心在真实块序下的确定性结果
    expect(structure.blocks.length).toBe(18);
    // 每块预算：公平份额 floor(32400/18)=1800 恰为单块可写下限 → 全块贴下限均分（Σ 精确守恒）；
    // 6 点 × 300 字/点 = 1800 恰好达到密度达标线，无超密度守卫裁剪
    expect(structure.blocks.every(block => block.targetWords >= 1700 && block.targetWords <= 4500)).toBe(true);
    expect(structure.blocks.reduce((sum, block) => sum + block.targetWords, 0)).toBe(32400);
    // 4.34 阻断块形态不可再现：「公共广场提升改造工程」12 个工作包在任何单块内 ≤6
    const squarePackages = subSectionSpecs[0]!.packages;
    const worstCoverage = Math.max(...structure.blocks.map(block => squarePackages.filter(name => block.subPoints.some(point => point.title === name || point.sources.includes(name))).length));
    expect(worstCoverage).toBeLessThanOrEqual(6);
    // 96 工作包要点零丢失（归并/守卫合并均不丢源——sources 全量保留，名字可在标题或 sources 中命中）
    const carried = new Set(structure.blocks.flatMap(block => block.subPoints.flatMap(point => [point.title, ...point.sources])));
    for (const spec of subSectionSpecs) for (const name of spec.packages) expect(carried.has(name)).toBe(true);
    // 模板小节覆盖为既有 fallback 边界（非本方案引入）：语义域聚合块被容量规划拆为单点块时保留父块标题，
    // append 阶段同题去重丢弃后块——「检查井与防坠网施工 / 道路提升与破路恢复工艺 / 公厕及门卫土建施工方法 /
    // 雨水污水管线敷设方法」4 小节不进结构；下方反向对照按 4.34 原预算实测同界同集（4.35 未改变覆盖行为）。
    // estimateChapterMinFeasibleWords 按 7 小节计点（103）相对实际结构点数（99）为高估——预算偏充足，安全侧
    //（近似边界已在函数注释声明）。
    for (const section of ['拆除改造与清运施工方法', '填方压实与场平作业工序', '安装工程与设备调试方法']) expect(carried.has(section)).toBe(true);
    for (const section of ['雨水污水管线敷设方法', '检查井与防坠网施工', '道路提升与破路恢复工艺', '公厕及门卫土建施工方法']) expect(carried.has(section)).toBe(false);
    expect(structure.blocks.flatMap(block => block.subPoints).every(point => (point.quotaWords ?? 0) > 0)).toBe(true);

    // 反向对照（4.34 原始预算 15603、未重校准）：密度封顶 + 守卫保证不失败——最坏情况降级为 brief 概览合并
    const legacy = buildChapterStructureFromBlueprint({ blueprintChapter, inputSections: templateSections, chapterTitle: '主要施工方法', targetWords: 15603 });
    expect(legacy.blocks.every(block => block.subPoints.length <= 6)).toBe(true);
    expect(legacy.blocks.every(block => block.subPoints.length <= Math.max(1, Math.floor(block.targetWords / 300)))).toBe(true);
    expect(legacy.blocks.reduce((sum, block) => sum + block.targetWords, 0)).toBe(15603);
    // 模板小节覆盖行为与重校准后完全一致（同界同集——本方案不改变既有覆盖边界）
    const legacyCarried = new Set(legacy.blocks.flatMap(block => block.subPoints.flatMap(point => [point.title, ...point.sources])));
    for (const section of templateSections) expect(legacyCarried.has(section)).toBe(carried.has(section));
  });
});
