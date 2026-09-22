import { describe, expect, it } from 'vitest';
import { appendixEntryCarried, appendTenderAppendixSections, cleanAppendixInternalPhrases, composeEnhancedCoverMarkdown, composeTenderAppendixMarkdown } from '@/services/document-workflow/composeAppendices';
import type { BidAppendixEntry } from '@/services/document-workflow/bidComposition';
import type { BlueprintData } from '@/services/document-workflow/integratedBlueprint';

describe('composeEnhancedCoverMarkdown（标准封面）', () => {
  it('无 facts 时仅输出标题并回落工程名称', () => {
    const cover = composeEnhancedCoverMarkdown('某工程施工组织设计');
    expect(cover).toContain('# 某工程施工组织设计');
    expect(cover).toContain('| 项目 | 内容 |');
    expect(cover).toContain('| 工程名称 | 某工程施工组织设计 |');
  });

  it('完整 facts 填充封面信息表', () => {
    const facts = { '工程名称': 'A工程', '建设单位': 'B公司', '施工单位': 'C公司', '建设地点': '合肥市', '建设规模': '10000㎡', '计划工期': '540日历天', '质量标准': '合格' };
    const cover = composeEnhancedCoverMarkdown('标题', facts);
    expect(cover).toContain('| 工程名称 | A工程 |');
    expect(cover).toContain('| 建设单位 | B公司 |');
    expect(cover).toContain('| 编制单位 | C公司 |');
    expect(cover).toContain('| 建设地点 | 合肥市 |');
    expect(cover).toContain('| 计划工期 | 540日历天 |');
    expect(cover).toContain('| 质量标准 | 合格 |');
  });

  it('无施工单位时编制单位回落建设单位', () => {
    const cover = composeEnhancedCoverMarkdown('标题', { '工程名称': 'A工程', '建设单位': 'B公司' });
    expect(cover).toContain('| 编制单位 | B公司 |');
  });

  it('竖线替换与来源标注截断', () => {
    const cover = composeEnhancedCoverMarkdown('标题', { '工程名称': 'A|B工程（来源: 招标文件）' });
    expect(cover).toContain('| 工程名称 | A／B工程 |');
  });
});

describe('composeTenderAppendixMarkdown（appendixPlan 蓝图直出）', () => {
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
        { name: '自卸汽车', spec: '15t', quantity: 4, basis: '施工方案推导' },
      ],
      labor: {
        peak: { min: 80, max: 90 },
        peakValue: 85,
        peakBasis: '阶段工程量',
        byPhase: [{ phase: '基础阶段', min: 80, max: 90, basis: '阶段工程量' }, { phase: '主体阶段', min: 60, max: 60, basis: '阶段工程量' }],
        byTrade: [],
        composition: [{ trade: '电工', count: 32, basis: '工种工程量比例' }],
      },
    },
    testInstruments: [
      { name: '水准仪', spec: 'DS3', quantity: 2, purpose: '高程控制测量与标高复核', basis: '检定合格后投入使用' },
      { name: '全站仪', spec: '2″级', quantity: 1, purpose: '平面控制测量与施工放样', basis: '检定合格后投入使用' },
    ],
    tempLand: [
      { purpose: '项目部办公区', area: 60, location: '现场出入口附近', duration: '施工全过程', note: '办公与会议用房', basis: '施工总平面布置规划' },
      { purpose: '材料堆放场', area: 800, location: '场内运输道路旁', duration: '施工全过程', note: '分类堆放并分区标识', basis: '施工总平面布置规划' },
    ],
    schedule: [
      { seq: 1, label: '施工准备', duration: 20, startDay: 1, endDay: 20, critical: false, basis: '前导工作，与主体施工穿插进行' },
      { seq: 2, label: '主体施工', duration: 180, startDay: 21, endDay: 200, critical: true, basis: '按里程碑顺序衔接' },
    ],
  });

  // 4.55.22 用户口径：表格单元格不得为空、不得用「—」占位。无权威来源的列（国别产地/制造年份/
  // 额定功率/生产能力/用于施工部位）**整列不出**（BlueprintEquipmentItem 里根本没有这些字段），
  // 出的列必须每格有值——数量口径（quantity 优先、min-max 区间）不变。
  it('设备表：数量口径（quantity 优先、min-max 区间）+ 无源列整列不出 + 依据备注列', () => {
    const section = composeTenderAppendixMarkdown([entry({ title: '附表一 拟投入本标段的主要施工设备表', dataSource: 'blueprint.equipment' })], blueprintData);
    expect(section).toContain('## 附表一 拟投入本标段的主要施工设备表');
    expect(section).toContain('| 序号 | 设备名称 | 型号规格 | 数量 | 备注 |');
    expect(section).not.toContain('国别产地');
    expect(section).toContain('| 1 | 挖掘机 | PC200 | 2 |');
    expect(section).toContain('| 2 | 汽车起重机 | QY25 | 1-2 |');
    expect(section).toContain('| 3 | 自卸汽车 | 15t | 4 |');
    expect(section).toContain('| 工程量清单 |');
    expect(section).not.toMatch(/\|\s*[—-]\s*\|/u);
  });

  it('劳动力表：工种配置 + 分阶段投入两小节（min===max 收敛单值）', () => {
    const section = composeTenderAppendixMarkdown([entry({ no: '三', title: '附表三 劳动力计划表', dataSource: 'blueprint.labor' })], blueprintData);
    expect(section).toContain('**（一）劳动力工种配置**');
    expect(section).toContain('| 电工 | 32 |');
    expect(section).toContain('**（二）分阶段劳动力投入计划**');
    expect(section).toContain('| 基础阶段 | 80-90 |');
    expect(section).toContain('| 主体阶段 | 60 |');
  });

  it('试验仪器/临时用地：蓝图数据源为空 → 招标表头骨架 + 显性缺口标注（不造数据）', () => {
    const plan = [
      entry({ no: '二', title: '附表二 拟配备本标段的试验和检测仪器设备表', dataSource: 'blueprint.testInstruments' }),
      entry({ no: '六', title: '附表六 临时用地表', dataSource: 'blueprint.tempLand' }),
    ];
    const section = composeTenderAppendixMarkdown(plan, bp({}));
    expect(section).toContain('## 附表二 拟配备本标段的试验和检测仪器设备表');
    expect(section).toContain('> 本表为试验检测仪器配置，按招标文件规定的表头格式编制。');
    expect(section).toContain('| 序号 | 仪器设备名称 | 型号规格 | 数量 | 国别产地 | 制造年份 | 已使用台时数 | 用途 | 备注 |');
    expect(section).toContain('## 附表六 临时用地表');
    expect(section).toContain('> 本表为临时用地规划，按招标文件规定的表头格式编制。');
    expect(section).toContain('| 用途 | 面积（平方米） | 位置 | 需用时间 |');
    expect(section).not.toMatch(/\| 1 \|/u);
  });

  it('C2 三源数据化：仪器/进度/临时用地直出（产地/年份/台时数如实留空；图类附表表格化）', () => {
    const plan = [
      entry({ no: '二', title: '附表二 拟配备本标段的试验和检测仪器设备表', dataSource: 'blueprint.testInstruments' }),
      entry({ no: '四', title: '附表四 计划开、竣工日期和施工进度网络图', kind: 'figure', dataSource: 'blueprint.schedule' }),
      entry({ no: '五', title: '附表五 施工总平面图', kind: 'figure', dataSource: 'blueprint.tempLand' }),
      entry({ no: '六', title: '附表六 临时用地表', dataSource: 'blueprint.tempLand' }),
    ];
    const section = composeTenderAppendixMarkdown(plan, blueprintData);
    // 附表二：仪器直出行（无源列整列不出，不再有「—」占位）
    expect(section).toContain('| 1 | 水准仪 | DS3 | 2 | 高程控制测量与标高复核 |');
    // 附表四：图件说明 + 工序数据表（起止天序 + 关键线路）
    expect(section).toContain('| 工序 | 持续天数 | 起止天序 | 关键线路 | 说明 |');
    expect(section).toContain('| 主体施工 | 180 | 第21～200天 | 关键线路 |');
    expect(section).toContain('| 施工准备 | 20 | 第1～20天 | 非关键线路 |');
    expect(section).toContain('**图件说明**');
    // 附表五：设施数据表（面积/位置/说明）
    expect(section).toContain('| 设施 | 面积（平方米） | 位置 | 说明 |');
    expect(section).toContain('| 材料堆放场 | 800 |');
    // 附表六：临时用地表（需用时间列）
    expect(section).toContain('| 用途 | 面积（平方米） | 位置 | 需用时间 |');
    expect(section).toContain('| 项目部办公区 | 60 |');
    expect(section).not.toContain('本表为试验检测仪器配置');
  });

  it('图类附表：图件说明；manual 表类：按招标格式编制标注（不猜表头）', () => {
    const plan = [
      entry({ no: '四', title: '附表四 计划开、竣工日期和施工进度网络图', kind: 'figure' }),
      entry({ no: '五', title: '附表五 施工总平面图', kind: 'figure' }),
      entry({ no: '七', title: '附表七 拟分包项目情况表', dataSource: 'manual' }),
    ];
    const section = composeTenderAppendixMarkdown(plan, blueprintData);
    expect(section).toContain('## 附表四 计划开、竣工日期和施工进度网络图');
    expect(section).toContain('图件');
    expect(section).toContain('施工总平面布置图');
    expect(section).toContain('> 本附表按招标文件规定的格式与内容要求编制。');
  });

  it('设备数据缺失：输出骨架 + 缺口标注，不编造数据行', () => {
    const empty = bp({ resources: { equipment: [], labor: { peak: { min: 0, max: 0 }, peakValue: 0, peakBasis: '', byPhase: [], byTrade: [], composition: [] } } });
    const section = composeTenderAppendixMarkdown([entry({ title: '附表一 拟投入本标段的主要施工设备表', dataSource: 'blueprint.equipment' })], empty);
    expect(section).toContain('> 本表为施工设备配置，按招标文件规定的表头格式编制。');
    expect(section).toContain('| 序号 | 设备名称 | 型号规格 | 数量 |');
    expect(section).not.toMatch(/\| 1 \|/u);
  });

  it('F-T2 话术合规：附表区说明块零内部流程话术', () => {
    const plan = [
      entry({ no: '一', title: '附表一 拟投入本标段的主要施工设备表', dataSource: 'blueprint.equipment' }),
      entry({ no: '二', title: '附表二 拟配备本标段的试验和检测仪器设备表', dataSource: 'blueprint.testInstruments' }),
      entry({ no: '三', title: '附表三 劳动力计划表', dataSource: 'blueprint.labor' }),
      entry({ no: '四', title: '附表四 计划开、竣工日期和施工进度网络图', kind: 'figure', dataSource: 'blueprint.schedule' }),
      entry({ no: '五', title: '附表五 施工总平面图', kind: 'figure', dataSource: 'blueprint.tempLand' }),
      entry({ no: '六', title: '附表六 临时用地表', dataSource: 'blueprint.tempLand' }),
      entry({ no: '七', title: '附表七 拟分包项目情况表', dataSource: 'manual' }),
    ];
    const empty = bp({ resources: { equipment: [], labor: { peak: { min: 0, max: 0 }, peakValue: 0, peakBasis: '', byPhase: [], byTrade: [], composition: [] } } });
    const notes = (data: BlueprintData) => composeTenderAppendixMarkdown(plan, data).split('\n').filter(line => line.startsWith('>'));
    // 数据齐备：仅图类附表四/五（图件说明）与 manual 附表七输出说明块
    expect(notes(blueprintData)).toHaveLength(3);
    // 数据全空：七个附表全部输出说明块/骨架说明
    expect(notes(empty)).toHaveLength(7);
    for (const note of [...notes(blueprintData), ...notes(empty)]) {
      expect(note).not.toMatch(/编制人|绘制后附|补充填报|一体化蓝图|数据源|骨架/u);
    }
  });

  it('C2 D1 承载判定收紧：≥2 真实数据行进计；骨架/纯图件说明/单数据行/仅标题不计', () => {
    const md = [
      '## 附表一 拟投入本标段的主要施工设备表', '',
      '| 序号 | 设备名称 |', '| --- | --- |', '| 1 | 挖掘机 |', '| 2 | 自卸汽车 |', '',
      // 反样本：表格骨架（缺口说明 + 空表头）不计承载
      '## 附表二 拟配备本标段的试验和检测仪器设备表', '',
      '> 本表为试验检测仪器配置，按招标文件规定的表头格式编制。', '',
      '| 序号 | 仪器设备名称 |', '| --- | --- |', '',
      // 反样本：单数据行（<2）不计承载
      '## 附表三 劳动力计划表', '',
      '| 工种 | 人数 |', '| --- | --- |', '| 电工 | 32 |', '',
      // 反样本：图类纯图件说明（无数据化内容）不计承载
      '## 附表四 计划开、竣工日期和施工进度网络图', '',
      '> **图件说明**：本附表以施工进度网络图形式表达。', '',
      // 正样本：图类数据化（图件说明 + 2 条数据行）计入承载
      '## 附表五 施工总平面图', '',
      '> **图件说明**：本附表为施工总平面布置图。', '',
      '| 设施 | 面积（平方米） |', '| --- | --- |', '| 材料堆放场 | 800 |', '| 项目部办公区 | 60 |', '',
      '## 附表八 仅有标题的表', '',
      '## 附表九 说明块表', '> 本附表按招标文件规定的格式与内容要求编制。',
    ].join('\n');
    expect(appendixEntryCarried(md, entry({ title: '附表一 拟投入本标段的主要施工设备表' }))).toBe(true);
    expect(appendixEntryCarried(md, entry({ no: '二', title: '附表二 拟配备本标段的试验和检测仪器设备表' }))).toBe(false);
    expect(appendixEntryCarried(md, entry({ no: '三', title: '附表三 劳动力计划表' }))).toBe(false);
    expect(appendixEntryCarried(md, entry({ no: '四', title: '附表四 计划开、竣工日期和施工进度网络图' }))).toBe(false);
    expect(appendixEntryCarried(md, entry({ no: '五', title: '附表五 施工总平面图' }))).toBe(true);
    expect(appendixEntryCarried(md, entry({ no: '八', title: '附表八 仅有标题的表' }))).toBe(false);
    expect(appendixEntryCarried(md, entry({ no: '九', title: '附表九 说明块表' }))).toBe(false);
    expect(appendixEntryCarried(md, entry({ no: '十', title: '附表十 未落位的表' }))).toBe(false);
  });

  it('F-T2 清单映射：appendixPlan 数据源绑定项逐项承载（终稿追加后复核）；manual 不猜表头不计承载', () => {
    const plan = [
      entry({ no: '一', title: '附表一 拟投入本标段的主要施工设备表', dataSource: 'blueprint.equipment' }),
      entry({ no: '二', title: '附表二 拟配备本标段的试验和检测仪器设备表', dataSource: 'blueprint.testInstruments' }),
      entry({ no: '三', title: '附表三 劳动力计划表', dataSource: 'blueprint.labor' }),
      entry({ no: '四', title: '附表四 计划开、竣工日期和施工进度网络图', kind: 'figure', dataSource: 'blueprint.schedule' }),
      entry({ no: '五', title: '附表五 施工总平面图', kind: 'figure', dataSource: 'blueprint.tempLand' }),
      entry({ no: '六', title: '附表六 临时用地表', dataSource: 'blueprint.tempLand' }),
    ];
    const section = composeTenderAppendixMarkdown(plan, blueprintData);
    for (const item of plan) expect(appendixEntryCarried(section, item)).toBe(true);
    const final = appendTenderAppendixSections('## 第一章 编制说明\n\n正文段落。', { plan, blueprintData });
    for (const item of plan) expect(appendixEntryCarried(final, item)).toBe(true);
    const manualEntry = entry({ no: '七', title: '附表七 拟分包项目情况表', dataSource: 'manual' });
    const manualSection = composeTenderAppendixMarkdown([manualEntry], blueprintData);
    expect(appendixEntryCarried(manualSection, manualEntry)).toBe(false);
  });
});

describe('appendTenderAppendixSections（幂等追加）', () => {
  const plan: BidAppendixEntry[] = [{ no: '一', title: '附表一 拟投入本标段的主要施工设备表', kind: 'table', dataSource: 'blueprint.equipment' }];
  const blueprintData = { resources: { equipment: [{ name: '挖掘机', spec: 'PC200', quantity: 2, basis: '工程量清单' }] } } as unknown as BlueprintData;
  const body = '## 第三章 主要施工方案\n\n正文段落。';

  it('追加 page-break 分隔与附表区；重复追加幂等', () => {
    const once = appendTenderAppendixSections(body, { plan, blueprintData });
    expect(once.startsWith(body)).toBe(true);
    expect(once).toContain('<div class="page-break"></div>');
    expect(once).toContain('## 附表一 拟投入本标段的主要施工设备表');
    expect(appendTenderAppendixSections(once, { plan, blueprintData })).toBe(once);
  });

  it('空清单/未定义时不改动正文', () => {
    expect(appendTenderAppendixSections(body, undefined)).toBe(body);
    expect(appendTenderAppendixSections(body, { plan: [] })).toBe(body);
  });
});

describe('cleanAppendixInternalPhrases（C2 D4 附表区话术中性化）', () => {
  it('内部推导话术中性化 + 岗位频次管理句移除；附表区外零改动；幂等', () => {
    const md = [
      '## 第一章 编制说明',
      '正文里的 工种构成唯一口径：按工种工程量区间中值比例收敛（合计恒等于峰值 80 人） 不动。',
      '',
      '## 附表三 劳动力计划表',
      '',
      '| 工种 | 人数 | 备注 |',
      '| --- | --- | --- |',
      '| 电工 | 32 | 工种构成唯一口径：按工种工程量区间中值比例收敛（合计恒等于峰值 85 人） |',
      '| 普工 | 53 | 阶段条目工程量约 17389 × 经验工效区间 ÷ 阶段 29 天（同时在场人数按峰值 85 人封顶） |',
      '',
      '## 附表一 拟投入本标段的主要施工设备表',
      '',
      '| 序号 | 设备名称 | 备注 |',
      '| --- | --- | --- |',
      '| 1 | 挖掘机 | 人机配合开挖（清单特征）；相关条目工程量合计约 37112m3 |',
      '',
      '## 附表四 计划开、竣工日期和施工进度网络图',
      '',
      '> **图件说明**：本附表以施工进度网络图形式表达，工序逻辑与工期安排与本施工组织设计进度计划一致。相关内容纳入施工组织设计与作业流程管理，资料员每日更新记录、测量员每周复核数据。',
    ].join('\n');
    const cleaned = cleanAppendixInternalPhrases(md);
    // 附表区外零改动
    expect(cleaned).toContain('正文里的 工种构成唯一口径');
    // 单元格中性化
    expect(cleaned).toContain('| 电工 | 32 | 按工种工程量比例配置 |');
    expect(cleaned).toContain('| 普工 | 53 | 按本阶段工程量及劳动力需用量测算 |');
    expect(cleaned).toContain('| 1 | 挖掘机 | 人机配合开挖 |');
    // 岗位+频次管理句移除，图件说明本句保留
    expect(cleaned).not.toContain('资料员每日更新记录');
    expect(cleaned).toContain('与本施工组织设计进度计划一致。');
    // 幂等
    expect(cleanAppendixInternalPhrases(cleaned)).toBe(cleaned);
    // 无附表区时原样返回
    expect(cleanAppendixInternalPhrases('## 第一章\n\n正文段落。')).toBe('## 第一章\n\n正文段落。');
  });

  it('C2 断词空格形态（s28l 实测）：归一口径后话术仍全清（「相关 条目」「（清单特征 ）」「天 （」）', () => {
    const md = [
      '## 附表一 拟投入本标段的主要施工设备表',
      '',
      '| 序号 | 设备名称 | 备注 |',
      '| --- | --- | --- |',
      '| 1 | 挖掘机 | 人机配合开挖（清单特征 ）； 相关条目工程量合计约 37112m3 |',
      '| 2 | 插入式振捣器 | 混凝土浇筑（清单条目）；相关 条目工程量合计约 390m3 |',
      '',
      '## 附表三 劳动力计划表',
      '',
      '| 施工阶段 | 人数 | 备注 |',
      '| --- | --- | --- |',
      '| 道路铺装工程 | 201-278 | 阶段条目工程量约 22104×经验工效区间 ÷ 阶段 168 天 （同时在场人数按峰值 278 人封顶） |',
    ].join('\n');
    const cleaned = cleanAppendixInternalPhrases(md);
    expect(cleaned).not.toMatch(/清单特征|清单条目|相关\s*条目工程量合计约|经验工效区间|唯一口径/u);
    expect(cleaned).toContain('| 1 | 挖掘机 | 人机配合开挖 |');
    expect(cleaned).toContain('| 2 | 插入式振捣器 | 混凝土浇筑 |');
    expect(cleaned).toContain('| 道路铺装工程 | 201-278 | 按本阶段工程量及劳动力需用量测算 |');
    expect(cleanAppendixInternalPhrases(cleaned)).toBe(cleaned);
  });
});
