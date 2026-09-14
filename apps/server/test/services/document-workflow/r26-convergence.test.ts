import { describe, expect, it } from 'vitest';
import { buildChapterStructureFromBlueprint, fallbackStructureForSections } from '../../../src/services/document-workflow/integratedBlueprint';
import { extractAppendixTables, previewPromptRules } from '../../../src/services/document-workflow/promptRuleExtraction';
import { documentBudgetIssues, explicitLengthTargets } from '../../../src/services/document-workflow/budget';
import type { DocumentBudget } from '../../../src/services/document-workflow/budget';
import { appendTenderAppendixSections, composeTenderAppendixMarkdown } from '../../../src/services/document-workflow/composeAppendices';

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

describe('4.33 minimum 模式软上限告警（documentBudgetIssues）', () => {
  const minimumBudget = (): DocumentBudget => ({
    targetChars: 50000,
    minChars: 50000,
    charsPerPage: 900,
    chapterTargets: new Map(),
    source: 'explicit',
    mode: 'minimum',
    longformStrict: true,
  });

  it('5 万目标产出 10 万字（超 15%）触发 warning 且不阻断', () => {
    const issues = documentBudgetIssues(minimumBudget(), '正文内容。'.repeat(20000));
    expect(issues.some(issue => issue.level === 'warning' && issue.message.includes('超出目标字数'))).toBe(true);
    expect(issues.some(issue => issue.level === 'error')).toBe(false);
  });

  it('接近目标（超幅 5%）不触发', () => {
    const issues = documentBudgetIssues(minimumBudget(), '正文内容。'.repeat(10500));
    expect(issues.some(issue => issue.message.includes('超出目标字数'))).toBe(false);
  });
});

describe('4.33 文末附表区组装（composeTenderAppendixMarkdown / appendTenderAppendixSections）', () => {
  const bodyMarkdown = [
    '## 第三章 主要施工方案',
    '',
    '### 3.1 机械设备投入计划',
    '',
    '| 序号 | 设备名称 | 型号规格 | 数量 | 国别产地 | 制造年份 | 额定功率（kW） | 生产能力 | 用于施工部位 | 备注 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    '| 1 | 挖掘机 | PC200 | 2 | 中国 | 2022 | 110 | 良好 | 土方开挖 | 完好 |',
    '',
    '### 3.2 其它内容',
    '',
    '正文段落。',
  ].join('\n');

  it('表类附表从正文同类表格确定性归集；图类附表输出图位说明；无数据附表跳过（不造数据）', () => {
    const titles = ['附表一 拟投入本标段的主要施工设备表', '附表四 计划开、竣工日期和施工进度网络图', '附表六 临时用地表'];
    const section = composeTenderAppendixMarkdown(bodyMarkdown, titles);
    expect(section).toContain('## 附表一 拟投入本标段的主要施工设备表');
    expect(section).toContain('| 挖掘机 |');
    // 4.35：图类附表由编制人绘制后附，但标题与图件说明必须出现在文末附表区（招标六张附表全覆盖）
    expect(section).toContain('## 附表四 计划开、竣工日期和施工进度网络图');
    expect(section).toContain('图件');
    // 正文无同类表格（设施名称/选址位置/占地面积）的附表六跳过，不造数据
    expect(section).not.toContain('附表六');
  });

  it('append 幂等：重复追加不重复生成；无数据/无附表时不改动正文', () => {
    const titles = ['附表一 拟投入本标段的主要施工设备表'];
    const once = appendTenderAppendixSections(bodyMarkdown, { titles });
    expect(once.startsWith(bodyMarkdown)).toBe(true);
    expect(once).toContain('<div class="page-break"></div>');
    expect(appendTenderAppendixSections(once, { titles })).toBe(once);
    expect(appendTenderAppendixSections(bodyMarkdown, undefined)).toBe(bodyMarkdown);
    expect(appendTenderAppendixSections(bodyMarkdown, { titles: ['附表六 临时用地表'] })).toBe(bodyMarkdown);
  });

  it('4.35 多表归集：设备去重合并 / 仪器表 / 劳动力双表 / 临建列转换', () => {
    const markdown = [
      '## 第六章 施工设备计划',
      '',
      '| 设备名称 | 规格型号 | 数量 | 主要作业内容 | 投入阶段 |',
      '| --- | --- | --- | --- | --- |',
      '| 挖掘机 | PC200 | 3 | 土方开挖 | 基础阶段 |',
      '| 自卸汽车 | 15t | 6 | 土方运输 | 全过程 |',
      '',
      '## 第四章 测量与检测',
      '',
      '| 仪器设备名称 | 型号规格 | 数量 | 检测参数 | 使用工序 |',
      '| --- | --- | --- | --- | --- |',
      '| 全站仪 | TS09 | 2 | 坐标放样 | 测量放线 |',
      '| 水准仪 | DSZ2 | 3 | 高程控制 | 抄平 |',
      '',
      '现场配备回弹仪进行混凝土强度检测。',
      '',
      '## 第九章 机电安装',
      '',
      '| 机械设备名称 | 规格型号 | 数量 | 额定功率 | 使用部位 |',
      '| --- | --- | --- | --- | --- |',
      '| 挖掘机 | PC210 | 2 | 132kW | 电缆沟开挖 |',
      '| 汽车起重机 | QY25 | 1 | 162kW | 立杆吊装 |',
      '',
      '## 第五章 劳动力配置',
      '',
      '| 劳动力工种 | 配置人数 | 主要作业内容 |',
      '| --- | --- | --- |',
      '| 电工 | 32 | 强电安装 |',
      '',
      '| 施工阶段 | 计划用时 | 同时在场人数 | 主要投入工种 |',
      '| --- | --- | --- | --- |',
      '| 基础阶段 | 30天 | 86 | 普工、钢筋工 |',
      '',
      '## 第十章 临时设施',
      '',
      '| 设施名称 | 选址位置 | 占地面积 |',
      '| --- | --- | --- |',
      '| 办公区 | 场地东侧 | 300m² |',
      '| 材料堆场 | 随施工段移动布置 | 600m² |',
    ].join('\n');
    const section = composeTenderAppendixMarkdown(markdown, [
      '附表一 拟投入本标段的主要施工设备表',
      '附表二 拟配备本标段的试验和检测仪器设备表',
      '附表三 劳动力计划表',
      '附表六 临时用地表',
    ]);
    // 设备表：跨章两张表归集，同名设备去重且取首个非空属性（PC210 不覆盖 PC200）
    expect(section).toContain('| 序号 | 设备名称 | 型号规格 | 数量 | 国别产地 | 制造年份 | 额定功率（kW） | 生产能力 | 用于施工部位 | 备注 |');
    expect(section).toContain('| 挖掘机 | PC200 |');
    expect(section).toContain('| 汽车起重机 |');
    expect(section).not.toContain('| 挖掘机 | PC210 |');
    // 仪器表：正文仪器表格归集 + 白名单实词补充（回弹仪），数量不臆造
    expect(section).toContain('## 附表二 拟配备本标段的试验和检测仪器设备表');
    expect(section).toContain('| 序号 | 仪器设备名称 | 型号规格 | 数量 | 国别产地 | 制造年份 | 已使用台时数 | 用途 | 备注 |');
    expect(section).toContain('| 全站仪 | TS09 |');
    expect(section).toContain('| 回弹仪 |');
    // 劳动力：双表归档
    expect(section).toContain('**（一）劳动力工种配置**');
    expect(section).toContain('| 电工 | 32 |');
    expect(section).toContain('**（二）分阶段劳动力投入计划**');
    expect(section).toContain('| 基础阶段 | 30天 | 86 |');
    // 临建：列转换 + 需用时间语义判定
    expect(section).toContain('| 用途 | 面积（平方米） | 位置 | 需用时间 |');
    expect(section).toContain('| 办公区 | 300 | 场地东侧 | 施工全过程 |');
    expect(section).toContain('| 材料堆场 | 600 | 随施工段移动布置 | 随施工段使用 |');
  });

  it('4.35b 工程安装清单不入施工设备表 / 机械表仪器行分流附表二 / 断词空格清理', () => {
    const markdown = [
      '## 第三章 主要施工方案',
      '',
      '| 设备名称 | 规格型号 | 安装方式 | 安装高度或位置 | 数量 | 技术参数要求 |',
      '| --- | --- | --- | --- | --- | --- |',
      '| 高清网络球形摄像机 | 含云台功能 | 杆件抱箍安装 | 监控杆件上部 | 8台 | 全景水平视场角不小于190° |',
      '',
      '## 第九章 机电安装',
      '',
      '| 机械设备名称 | 规格型号 | 数量 | 额定功率 | 使用部位 |',
      '| --- | --- | --- | --- | --- |',
      '| 高空作业车 | 作业高度12m | 2台 | 55kW | 杆件顶部设备安装、信 号灯安装 |',
      '| 绝缘电阻测试仪 | ZC25-3 | 2台 | 0.01kW | 电缆、线路绝缘检测 |',
      '',
      '| 设备名称 | 规格型号 | 数量 | 主要作业内容 | 投入阶段 |',
      '| --- | --- | --- | --- | --- |',
      '| 挖掘机 | 0.6~1.0m³ | 5台 | 沟槽开挖、一般土方 开挖、清表 | 全过程 |',
      '',
      '## 第四章 测量与检测',
      '',
      '| 仪器设备名称 | 规格型号 | 数量 | 检测参数 | 使用工序 |',
      '| --- | --- | --- | --- | --- |',
      '| 全站仪 | TS09 | 1台 | 杆件垂直度、基础定位 | 监控杆件基础放样 |',
    ].join('\n');
    const section = composeTenderAppendixMarkdown(markdown, [
      '附表一 拟投入本标段的主要施工设备表',
      '附表二 拟配备本标段的试验和检测仪器设备表',
    ]);
    // 工程安装设备清单（摄像机）不入施工设备表；机械表仪器行（绝缘电阻测试仪）不入附表一
    expect(section).not.toContain('高清网络球形摄像机');
    const equipment = section.split('## 附表二')[0];
    expect(equipment).toContain('| 高空作业车 |');
    expect(equipment).toContain('| 挖掘机 | 0.6~1.0m³ |');
    expect(equipment).not.toContain('绝缘电阻测试仪');
    // 机械表混编仪器行带数据转入附表二（ZC25-3 型号不丢）
    const instrument = section.split('## 附表二')[1];
    expect(instrument).toContain('| 绝缘电阻测试仪 | ZC25-3 |');
    expect(instrument).toContain('| 全站仪 | TS09 |');
    // 断词空格清理（“信 号灯安装”“一般土方 开挖”等 CJK 语境空格）
    expect(section).toContain('信号灯安装');
    expect(section).toContain('一般土方开挖');
    expect(section).not.toContain('信 号灯');
    expect(section).not.toContain('土方 开挖');
  });
});

/**
 * 容量规划回归（替代 4.34 事后压缩）：要点不在写作后折叠/压缩——块数在规划层归并到
 * 章目标/1200 上限内、块预算 Σ 精确守恒于章目标、点配额随块预算下发（写作/检测/修复三层同源）。
 * 历史病灶：折叠后多源组又被 LLM 逐源展开导致超产仍在，且与写作/检测/修复口径互相冲突。
 */
describe('容量规划（替代 4.34 章结构容量压缩）', () => {
  it('接线：buildChapterStructureFromBlueprint 对 13 subSections/96 工作包的章容量守恒（归并/配额，无事后折叠）', () => {
    const workPackage = (name: string) => ({ name, kind: 'major' as const, quantities: {}, processChain: [], methods: [], params: [], acceptance: [], standards: [], source: 'boq' as const, coveredSeqs: [] });
    const subSections = Array.from({ length: 13 }, (_, sectionIndex) => ({
      id: `2.${sectionIndex + 1}`,
      title: `分部工程${sectionIndex + 1}`,
      requiredParams: [], scoredItems: [], tablePlans: [],
      workPackages: Array.from({ length: sectionIndex < 5 ? 8 : 7 }, (_, packageIndex) => workPackage(`工作包${sectionIndex + 1}-${packageIndex + 1}`)),
    }));
    const structure = buildChapterStructureFromBlueprint({ blueprintChapter: { id: '2', title: '主要施工方法', isActive: true, requiredParams: [], scoredItems: [], subSections }, inputSections: [], chapterTitle: '主要施工方法', targetWords: 16178 });
    // 块数归并到容量上限内、单块预算不超输出安全区、Σ 精确守恒于章目标
    expect(structure.blocks.length).toBeLessThanOrEqual(Math.floor(16178 / 1200));
    expect(structure.blocks.every(block => block.targetWords <= 4500)).toBe(true);
    const total = structure.blocks.reduce((sum, block) => sum + block.targetWords, 0);
    expect(total).toBe(16178);
    // 工作包原名零丢失（归并不丢点）+ 点配额随块预算下发
    const carried = new Set(structure.blocks.flatMap(block => block.subPoints.flatMap(point => [point.title, ...point.sources])));
    for (let sectionIndex = 1; sectionIndex <= 13; sectionIndex += 1) {
      for (let packageIndex = 1; packageIndex <= (sectionIndex <= 5 ? 8 : 7); packageIndex += 1) expect(carried.has(`工作包${sectionIndex}-${packageIndex}`)).toBe(true);
    }
    expect(structure.blocks.flatMap(block => block.subPoints).every(point => (point.quotaWords ?? 0) > 0)).toBe(true);
  });
});
