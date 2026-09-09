import { describe, expect, it } from 'vitest';
import { deriveMaterialsPlanFromBoq, renderBlueprintChapterAuthorityCard } from '@/services/document-workflow/integratedBlueprint';
import type { BlueprintData, BlueprintChapter } from '@/services/document-workflow/integratedBlueprint';
import type { BillOfQuantitiesResult, BoqEntry } from '@/services/document-workflow/billOfQuantitiesParser';

/** 构造最小清单条目（路灯/检查井同形 fixture） */
function entry(overrides: Partial<BoqEntry> & { seq: number; name: string; description: string; quantity: number; unit: string }): BoqEntry {
  return {
    code: `03041200700${overrides.seq}`,
    section: '亮化工程',
    subsection: '',
    villageGroup: '村1',
    sourceFile: '清单.xls',
    chunkIndex: 1,
    sourceKind: 'markdown',
    ...overrides,
  };
}

function boq(entries: BoqEntry[]): BillOfQuantitiesResult {
  return {
    entries,
    villages: [],
    totalEntries: entries.length,
    sourceFile: '清单.xls',
    complete: true,
    diagnostics: { totalChunks: 0, markdownChunks: 0, declarationChunks: 0, skippedChunks: 0, droppedIncompleteRows: 0 },
  };
}

/** 路灯清单条目（丰乐镇真实形态：同名一般路灯、100W/120W 两条独立条目） */
function streetLampEntries(): BoqEntry[] {
  return [
    entry({ seq: 220, name: '一般路灯', description: '1．100W  LED，高4.5m，样式满足设计及建设单 位要求 2．含基础 5．其他：具体详见设计图纸', quantity: 18, unit: '套' }),
    entry({ seq: 221, name: '一般路灯', description: '1．120W  LED，高4.5m，样式满足设计及建设单 位要求 2．含基础 5．其他：具体详见设计图纸', quantity: 2, unit: '套' }),
  ];
}

describe('deriveMaterialsPlanFromBoq（丰乐镇十四版：同名多规格拆分数值零丢失）', () => {
  it('同名不同规格：按名称+规格拆分保留，逐项数量不聚合（路灯 100W/120W）', () => {
    const entries = [
      ...streetLampEntries(),
      entry({ seq: 300, name: '一般路灯', description: '1．100W LED，高4.5m，含基础', quantity: 91, unit: '套', villageGroup: '村2' }),
      entry({ seq: 301, name: '一般路灯', description: '1．120W LED，高4.5m，含基础', quantity: 7, unit: '套', villageGroup: '村2' }),
    ];
    const plan = deriveMaterialsPlanFromBoq(boq(entries));
    const lamps = plan.filter(item => item.name === '一般路灯');
    expect(lamps).toHaveLength(2);
    const w100 = lamps.find(item => item.spec === '100W');
    const w120 = lamps.find(item => item.spec === '120W');
    expect(w100?.quantity).toBe(109); // 18+91，清单权威拆分
    expect(w120?.quantity).toBe(9); // 2+7
  });

  it('同名同规格：数量聚合为单条（多村同规格合并）', () => {
    const entries = [
      entry({ seq: 220, name: '一般路灯', description: '1．100W LED，高4.5m，含基础', quantity: 18, unit: '套' }),
      entry({ seq: 300, name: '一般路灯', description: '1．100W LED，高4.5m，含基础', quantity: 91, unit: '套', villageGroup: '村2' }),
    ];
    const plan = deriveMaterialsPlanFromBoq(boq(entries));
    const lamps = plan.filter(item => item.name === '一般路灯');
    expect(lamps).toHaveLength(1);
    expect(lamps[0]?.quantity).toBe(109);
  });

  it('同名无规格可区分（塑料/砌筑检查井）：维持按名称聚合现状，不误拆', () => {
    const entries = [
      entry({ seq: 100, name: '检查井', description: '1．塑料检查井 2．具体详见设计图纸', quantity: 555, unit: '座' }),
      entry({ seq: 101, name: '检查井', description: '1．砖砌检查井 2．具体详见设计图纸', quantity: 2, unit: '座' }),
    ];
    const plan = deriveMaterialsPlanFromBoq(boq(entries));
    const wells = plan.filter(item => item.name === '检查井');
    expect(wells).toHaveLength(1);
    expect(wells[0]?.quantity).toBe(557); // 总数口径不变（报告已确认该口径正确）
  });
});

/** 最小 BlueprintData fixture（锚点卡渲染路径需 contract/resources 基础字段） */
function blueprintData(overrides: Partial<BlueprintData>): BlueprintData {
  return {
    contract: { totalDays: 0 },
    resources: { labor: { peakValue: 0, byPhase: [], composition: [] }, equipment: [] },
    materialsPlan: [],
    redLineFacts: [],
    ...overrides,
  } as BlueprintData;
}

describe('quantity_breakdown 章级数值锚点（拆分数值注入写作层）', () => {
  const chapter: BlueprintChapter = { id: 5, title: '亮化工程施工方法', subSections: [], workPackages: [] } as unknown as BlueprintChapter;

  it('亮化章节：注入路灯规格-数量拆分锚点行（逐项照抄口径）', () => {
    const data = blueprintData({
      materialsPlan: [
        { name: '一般路灯', spec: '100W', quantity: 109, unit: '套', basis: '清单汇总 + 进度匹配' },
        { name: '一般路灯', spec: '120W', quantity: 9, unit: '套', basis: '清单汇总 + 进度匹配' },
      ],
      redLineFacts: [{ key: '一般路灯', value: '一般路灯 100W LED 高4.5m 含基础', source: '清单条目', amount: false }],
    });
    const card = renderBlueprintChapterAuthorityCard(chapter, data);
    expect(card).toContain('一般路灯规格-数量拆分');
    expect(card).toContain('100W 109套');
    expect(card).toContain('120W 9套');
    expect(card).toContain('合计 118套');
    expect(card).toContain('不得自行分配/改动');
  });

  it('亮化章节：路灯红线事实同步注入（maintenance_redline chapterPattern 扩展）', () => {
    const data = blueprintData({
      redLineFacts: [{ key: '一般路灯', value: '一般路灯 100W LED 高4.5m 含基础', source: '清单条目', amount: false }],
    });
    const card = renderBlueprintChapterAuthorityCard(chapter, data);
    expect(card).toContain('一般路灯=一般路灯 100W LED 高4.5m 含基础');
  });

  it('同名单条材料（无拆分）：不注入拆分锚点行', () => {
    const data = blueprintData({
      materialsPlan: [{ name: '级配碎石', spec: '厚10cm', quantity: 500, unit: 'm2', basis: '清单汇总' }],
    });
    const card = renderBlueprintChapterAuthorityCard(chapter, data);
    expect(card).not.toContain('规格-数量拆分');
  });

  it('非命中章节（如安全技术组织措施章）：不注入拆分锚点', () => {
    const safetyChapter: BlueprintChapter = { id: 8, title: '安全技术组织措施', subSections: [], workPackages: [] } as unknown as BlueprintChapter;
    const data = blueprintData({
      materialsPlan: [
        { name: '一般路灯', spec: '100W', quantity: 109, unit: '套', basis: '清单汇总' },
        { name: '一般路灯', spec: '120W', quantity: 9, unit: '套', basis: '清单汇总' },
      ],
    });
    const card = renderBlueprintChapterAuthorityCard(safetyChapter, data);
    expect(card).toBe('');
  });
});
