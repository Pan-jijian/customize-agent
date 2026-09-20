import { describe, expect, it } from 'vitest';
import { appendixEntryCarried, appendTenderAppendixSections, composeEnhancedCoverMarkdown, composeTenderAppendixMarkdown } from '@/services/document-workflow/composeAppendices';
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
        { name: '自卸汽车', basis: '施工方案推导' },
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
  });

  it('设备表：数量口径（quantity 优先、min-max 区间、无值 —）+ 依据备注列', () => {
    const section = composeTenderAppendixMarkdown([entry({ title: '附表一 拟投入本标段的主要施工设备表', dataSource: 'blueprint.equipment' })], blueprintData);
    expect(section).toContain('## 附表一 拟投入本标段的主要施工设备表');
    expect(section).toContain('| 序号 | 设备名称 | 型号规格 | 数量 | 国别产地 | 制造年份 | 额定功率（kW） | 生产能力 | 用于施工部位 | 备注 |');
    expect(section).toContain('| 1 | 挖掘机 | PC200 | 2 |');
    expect(section).toContain('| 2 | 汽车起重机 | QY25 | 1-2 |');
    expect(section).toContain('| 3 | 自卸汽车 | — | — |');
    expect(section).toContain('| 工程量清单 |');
  });

  it('劳动力表：工种配置 + 分阶段投入两小节（min===max 收敛单值）', () => {
    const section = composeTenderAppendixMarkdown([entry({ no: '三', title: '附表三 劳动力计划表', dataSource: 'blueprint.labor' })], blueprintData);
    expect(section).toContain('**（一）劳动力工种配置**');
    expect(section).toContain('| 电工 | 32 |');
    expect(section).toContain('**（二）分阶段劳动力投入计划**');
    expect(section).toContain('| 基础阶段 | 80-90 |');
    expect(section).toContain('| 主体阶段 | 60 |');
  });

  it('试验仪器/临时用地：蓝图无数据源 → 招标表头骨架 + 显性缺口标注（不造数据）', () => {
    const plan = [
      entry({ no: '二', title: '附表二 拟配备本标段的试验和检测仪器设备表', dataSource: 'blueprint.testInstruments' }),
      entry({ no: '六', title: '附表六 临时用地表', dataSource: 'blueprint.tempLand' }),
    ];
    const section = composeTenderAppendixMarkdown(plan, blueprintData);
    expect(section).toContain('## 附表二 拟配备本标段的试验和检测仪器设备表');
    expect(section).toContain('> 本表为试验检测仪器配置，按招标文件规定的表头格式编制。');
    expect(section).toContain('| 序号 | 仪器设备名称 | 型号规格 | 数量 | 国别产地 | 制造年份 | 已使用台时数 | 用途 | 备注 |');
    expect(section).toContain('## 附表六 临时用地表');
    expect(section).toContain('> 本表为临时用地规划，按招标文件规定的表头格式编制。');
    expect(section).toContain('| 用途 | 面积（平方米） | 位置 | 需用时间 |');
    expect(section).not.toMatch(/\| 1 \|/u);
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
      entry({ no: '四', title: '附表四 计划开、竣工日期和施工进度网络图', kind: 'figure' }),
      entry({ no: '五', title: '附表五 施工总平面图', kind: 'figure' }),
      entry({ no: '六', title: '附表六 临时用地表', dataSource: 'blueprint.tempLand' }),
      entry({ no: '七', title: '附表七 拟分包项目情况表', dataSource: 'manual' }),
    ];
    const empty = bp({ resources: { equipment: [], labor: { peak: { min: 0, max: 0 }, peakValue: 0, peakBasis: '', byPhase: [], byTrade: [], composition: [] } } });
    const notes = (data: BlueprintData) => composeTenderAppendixMarkdown(plan, data).split('\n').filter(line => line.startsWith('>'));
    expect(notes(blueprintData)).toHaveLength(5);
    expect(notes(empty)).toHaveLength(7);
    for (const note of [...notes(blueprintData), ...notes(empty)]) {
      expect(note).not.toMatch(/编制人|绘制后附|补充填报|一体化蓝图|数据源|骨架/u);
    }
  });

  it('F-T2 承载判定：标题落位 + 表格/说明块内容；仅标题或未落位不承载', () => {
    const md = [
      '## 附表一 拟投入本标段的主要施工设备表', '',
      '| 序号 | 设备名称 |', '| --- | --- |', '| 1 | 挖掘机 |', '',
      '## 附表八 仅有标题的表', '',
      '## 附表九 说明块表', '> 本附表按招标文件规定的格式与内容要求编制。',
    ].join('\n');
    expect(appendixEntryCarried(md, entry({ title: '附表一 拟投入本标段的主要施工设备表' }))).toBe(true);
    expect(appendixEntryCarried(md, entry({ no: '八', title: '附表八 仅有标题的表' }))).toBe(false);
    expect(appendixEntryCarried(md, entry({ no: '九', title: '附表九 说明块表' }))).toBe(true);
    expect(appendixEntryCarried(md, entry({ no: '十', title: '附表十 未落位的表' }))).toBe(false);
  });

  it('F-T2 清单映射：appendixPlan 逐项承载（终稿追加后复核）', () => {
    const plan = [
      entry({ no: '一', title: '附表一 拟投入本标段的主要施工设备表', dataSource: 'blueprint.equipment' }),
      entry({ no: '二', title: '附表二 拟配备本标段的试验和检测仪器设备表', dataSource: 'blueprint.testInstruments' }),
      entry({ no: '四', title: '附表四 计划开、竣工日期和施工进度网络图', kind: 'figure' }),
      entry({ no: '六', title: '附表六 临时用地表', dataSource: 'blueprint.tempLand' }),
      entry({ no: '七', title: '附表七 拟分包项目情况表', dataSource: 'manual' }),
    ];
    const section = composeTenderAppendixMarkdown(plan, blueprintData);
    for (const item of plan) expect(appendixEntryCarried(section, item)).toBe(true);
    const final = appendTenderAppendixSections('## 第一章 编制说明\n\n正文段落。', { plan, blueprintData });
    for (const item of plan) expect(appendixEntryCarried(final, item)).toBe(true);
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
