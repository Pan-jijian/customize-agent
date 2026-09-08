import { describe, expect, it } from 'vitest';
import { parseBillOfQuantities, pickBillOfQuantityFiles } from '../billOfQuantitiesParser';
import type { BillOfQuantitiesResult, BoqChunkRow } from '../billOfQuantitiesParser';
import type { DocumentEvidence, DocumentFact } from '../types';
import {
  alignChapterContentToBlueprint,
  blueprintCitationConsistencyIssues,
  blueprintPlanAuthorities,
  buildBlueprintData,
  buildBlueprintDecisionLock,
  buildBlueprintOutline,
  buildChapterStructureFromBlueprint,
  buildIntegratedBlueprint,
  decisionLockCategoryMeta,
  decisionMentionNegated,
  deriveEarthworkBalanceFromBoq,
  deriveLaborFromBoq,
  deriveMilestonesFromBoq,
  deriveSpecAuthoritiesFromBoq,
  extractContractFromFacts,
  extractDecisionLockEntries,
  extractRedLineFacts,
  extractVillageCount,
  fallbackWorkPackagesFromExisting,
  findBlueprintChapter,
  judgeHazardousWorks,
  renderBlueprintChapterSlice,
  renderBlueprintDataText,
  renderBlueprintMustCiteValues,
  resolveBillOfQuantities,
  splitSinglePointOversizedBlocks,
  validateBlueprint,
} from '../integratedBlueprint';
import type { BlueprintRedLineFact } from '../integratedBlueprint';
import { majorConstructionSkeletonNames, scopeEngineeringNames } from '../chapterPostProcessing';

/** 构造 markdown 表格清单 chunk fixture（马老郢村，工作表 1.1，共 3 页） */
function buildMarkdownChunks(): BoqChunkRow[] {
  const header = '工程名称：马老郢等 标段： 工作表：1.1 第1页 共3页\n| 序号 | 项目编码 | COL3 | 项目名称 | 项目特征描述 | 计量单位 | COL7 | 工程量 | 金额 |';
  const chunk1: BoqChunkRow = {
    chunkIndex: 0,
    sectionTitle: '表格数据',
    content: [
      header,
      '|  | 一 |  | 道路工程 |',
      '| 1 | 040101001001 |  | 挖一般土方 | 1．部位：村庄道路 2．土壤类别：三类土 | m3 |  | 120.5 |',
      '|  | 二 |  | 排水工程 |',
      '| 2 | 040801001001 |  | 混凝土管道DN200 | 1．规格：DN200 2．垫层：C20商品混凝土定型基础 | m |  | 50 |',
      '第2页 共3页',
    ].join('\n'),
  };
  const chunk2: BoqChunkRow = {
    chunkIndex: 1,
    sectionTitle: '表格数据',
    content: [
      '| 4 | 040101002001 |  | 挖沟槽土方 | 1．沟槽深度：1.5m以内 2．土壤类别：三类土 | m3 |  | 60 |',
      '|  | 三 |  | 绿化工程 |',
      '| 3 | 050102001001 |  | 绿化养护 | 1．养护等级：二级养护两年 2．洒水车养护 | m2 |  | 500 |',
      '| 5 | 000000000000 |  | 暂列金额 | 1．金额：10万元 | 项 |  | 1 |',
      '第3页 共3页',
    ].join('\n'),
  };
  return [chunk1, chunk2];
}

function parseFixture(): BillOfQuantitiesResult {
  return parseBillOfQuantities({ chunks: buildMarkdownChunks(), sourceFile: '丰乐镇工程量清单.xls' });
}

describe('清单解析完整性（阶段 0 数据源）', () => {
  it('markdown 主源全量解析：条目/编码/名称/特征/单位/工程量/分部归属', () => {
    const result = parseFixture();
    expect(result.totalEntries).toBe(5);
    expect(result.complete).toBe(true);
    expect(result.villages).toHaveLength(1);
    const village = result.villages[0]!;
    expect(village.villageGroup).toBe('马老郢等');
    expect(village.entrySeqMissing).toEqual([]);
    expect(village.pagesMissing).toEqual([]);
    expect(village.entriesWithoutCode).toBe(0);
    expect(village.entriesWithInvalidCode).toBe(0);
    const pipe = result.entries.find(entry => entry.name === '混凝土管道DN200');
    expect(pipe?.code).toBe('040801001001');
    expect(pipe?.unit).toBe('m');
    expect(pipe?.quantity).toBe(50);
    expect(pipe?.section).toBe('排水工程');
    const trench = result.entries.find(entry => entry.name === '挖沟槽土方');
    expect(trench?.section).toBe('排水工程');
    const green = result.entries.find(entry => entry.name === '绿化养护');
    expect(green?.section).toBe('绿化工程');
    expect(green?.description).toContain('二级养护两年');
  });

  it('跨 chunk 截断表格行拼接（无前导 | 的续行并入上一行）', () => {
    const chunks: BoqChunkRow[] = [
      {
        chunkIndex: 0,
        sectionTitle: '表格数据',
        content: '工程名称：马老郢等 标段： 工作表：1.1 第1页 共2页\n| 序号 | 项目编码 | COL3 | 项目名称 | 项目特征描述 | 计量单位 | COL7 | 工程量 | 金额 |\n|  | 一 |  | 道路工程 |\n| 1 | 040101001001 |  | 挖一般土方 | 1．部位：村庄道路，',
      },
      {
        chunkIndex: 1,
        sectionTitle: '表格数据',
        content: '土方类别：三类土 | m3 |  | 120.5 |\n第2页 共2页',
      },
    ];
    const result = parseBillOfQuantities({ chunks, sourceFile: '清单.xls' });
    expect(result.totalEntries).toBe(1);
    expect(result.diagnostics.droppedIncompleteRows).toBe(0);
    const entry = result.entries[0]!;
    expect(entry.name).toBe('挖一般土方');
    expect(entry.description).toBe('1．部位：村庄道路，土方类别：三类土');
    expect(entry.quantity).toBe(120.5);
    expect(result.complete).toBe(true);
  });

  it('声明格式补缺：markdown 缺页条目由 R{n}C{m} 声明兜底（序号连续 → 条目零丢失）', () => {
    const chunks: BoqChunkRow[] = [
      {
        chunkIndex: 0,
        sectionTitle: '表格数据',
        content: '工程名称：马老郢等 标段： 工作表：1.1 第1页 共3页\n| 序号 | 项目编码 | COL3 | 项目名称 | 项目特征描述 | 计量单位 | COL7 | 工程量 | 金额 |\n|  | 一 |  | 道路工程 |\n| 1 | 040101001001 |  | 挖一般土方 | 1．部位：村庄道路 | m3 |  | 120.5 |\n| 2 | 040103001001 |  | 余方弃置 | 1．运距：1km | m3 |  | 40 |\n第1页 共3页',
      },
      {
        chunkIndex: 1,
        sectionTitle: '表格路径声明',
        content: '工作表：1.1\nR1C1\n序号:\n3\nR1C2\n项目编码:\n040102001001\nR1C4\n项目名称:\n回填方\nR1C5\n项目特征描述:\n1．部位：沟槽回填\nR1C6\n单位:\nm3\nR1C8\n工程量:\n30',
      },
    ];
    const result = parseBillOfQuantities({ chunks, sourceFile: '清单.xls' });
    expect(result.totalEntries).toBe(3);
    expect(result.complete).toBe(true);
    expect(result.villages[0]!.entriesFromDeclaration).toBe(1);
    const backfill = result.entries.find(entry => entry.name === '回填方');
    expect(backfill?.sourceKind).toBe('declaration');
    expect(backfill?.quantity).toBe(30);
    // 分部归属回填：声明条目继承同村最近 markdown 条目（seq2 道路工程）的分部
    expect(backfill?.section).toBe('道路工程');
  });

  it('序号缺口 → 完整性校验失败（条目零丢失阻断信号）', () => {
    const chunks: BoqChunkRow[] = [
      {
        chunkIndex: 0,
        sectionTitle: '表格数据',
        content: '工程名称：马老郢等 标段： 工作表：1.1 第1页 共1页\n| 序号 | 项目编码 | COL3 | 项目名称 | 项目特征描述 | 计量单位 | COL7 | 工程量 | 金额 |\n| 1 | 040101001001 |  | 挖一般土方 | 1．部位：村庄道路 | m3 |  | 120.5 |\n| 3 | 040103001001 |  | 余方弃置 | 1．运距：1km | m3 |  | 40 |\n第1页 共1页',
      },
    ];
    const result = parseBillOfQuantities({ chunks, sourceFile: '清单.xls' });
    expect(result.complete).toBe(false);
    expect(result.villages[0]!.entrySeqMissing).toEqual([2]);
  });

  it('pickBillOfQuantityFiles：只识别绑定资料中的清单 xls（排除封面/编制说明/非清单）', () => {
    const picked = pickBillOfQuantityFiles([
      '招标文件.pdf',
      '丰乐镇工程量清单.xls',
      '工程量清单封面.xls',
      '工程量清单编制说明.xls',
      '补疑答复.docx',
      '工程量清单.xlsx',
    ]);
    expect(picked).toEqual(['丰乐镇工程量清单.xls']);
  });
});

describe('L1a 红线事实确定性提取', () => {
  it('养护期/暂列金额等红线事实从清单特征原文提取，金额条目带 amount 标记', () => {
    const facts = extractRedLineFacts(parseFixture());
    const care = facts.find(fact => fact.key === '绿化养护期');
    expect(care?.value).toContain('二级养护');
    expect(care?.source).toContain('清单条目');
    const provision = facts.find(fact => fact.key === '暂列金额');
    expect(provision?.value).toBe('10万元');
    expect(provision?.amount).toBe(true);
  });
});

describe('L2 计划推导（确定性区间，不硬锁具体值）', () => {
  it('劳动力：峰值区间表达（min ≤ max），唯一口径峰值 = 区间中值收敛', () => {
    const labor = deriveLaborFromBoq(parseFixture(), 360);
    expect(labor.peak.min).toBeGreaterThan(0);
    expect(labor.peak.min).toBeLessThanOrEqual(labor.peak.max);
    expect(labor.peakValue).toBeGreaterThanOrEqual(labor.peak.min);
    expect(labor.peakValue).toBeLessThanOrEqual(labor.peak.max);
    expect(labor.peakValue).toBe(Math.round((labor.peak.min + labor.peak.max) / 2));
    expect(labor.byTrade.length).toBeGreaterThan(0);
    for (const item of labor.byTrade) {
      expect((item.min || 0)).toBeLessThanOrEqual(item.max || 0);
    }
  });

  it('里程碑：分部工程量权重分配，总和 ≤ 总工期', () => {
    const milestones = deriveMilestonesFromBoq(parseFixture(), 360);
    expect(milestones.length).toBeGreaterThan(0);
    const sum = milestones.reduce((acc, item) => acc + (item.duration || 0), 0);
    expect(sum).toBeLessThanOrEqual(360);
    expect(sum).toBeGreaterThan(0);
  });

  it('土方平衡：弃方 = 挖方 − 填方（清单汇总口径）', () => {
    const balance = deriveEarthworkBalanceFromBoq(parseFixture());
    expect(balance.excavation).toBe(180.5);
    expect(balance.disposal).toBeGreaterThanOrEqual(0);
  });
});

describe('L1b 危大工程判定（37 号令阈值规则）', () => {
  it('证据给出开挖深度 4.5m → 判定危大工程（专项方案）', () => {
    const judgment = judgeHazardousWorks(parseFixture(), '沟槽开挖深度4.5m，放坡开挖');
    expect(judgment.gap).toBe(false);
    expect(judgment.conclusion).toContain('危大工程');
    expect(judgment.conclusion).toContain('4.5');
  });

  it('证据深度 ≥5m → 超过一定规模须专家论证', () => {
    const judgment = judgeHazardousWorks(parseFixture(), '基坑深度5.2m');
    expect(judgment.conclusion).toContain('专家论证');
  });

  it('无深度数据 → 标记待人工确认，不静默判定', () => {
    const judgment = judgeHazardousWorks(parseFixture(), '');
    expect(judgment.gap).toBe(true);
    expect(judgment.conclusion).toContain('待人工确认');
  });

  it('清单无开挖条目 → 判定不涉及', () => {
    const chunks: BoqChunkRow[] = [
      {
        chunkIndex: 0,
        sectionTitle: '表格数据',
        content: '工程名称：马老郢等 标段： 工作表：1.1 第1页 共1页\n| 序号 | 项目编码 | COL3 | 项目名称 | 项目特征描述 | 计量单位 | COL7 | 工程量 | 金额 |\n| 1 | 050102001001 |  | 绿化养护 | 1．养护等级：二级养护两年 | m2 |  | 500 |\n第1页 共1页',
      },
    ];
    const boq = parseBillOfQuantities({ chunks, sourceFile: '清单.xls' });
    const judgment = judgeHazardousWorks(boq, '');
    expect(judgment.gap).toBe(false);
    expect(judgment.conclusion).toContain('不涉及');
  });
});

describe('阶段 D 四道校验（蓝图冻结前门禁）', () => {
  const FULL_CHAPTER_TITLES = [
    '主要分部分项工程施工方案',
    '物资与机械劳动力配置计划',
    '质量保证措施',
    '安全保证措施',
    '工期保证措施',
    '文明施工与环境保护',
    '施工总平面布置',
    '重难点分析及保证措施',
  ];

  function buildValidatedBlueprint() {
    const boq = parseFixture();
    const { data } = buildBlueprintData({ boq, basicFacts: '项目名称：丰乐镇建设项目 工期：360日历天 质量标准：合格 计价依据：合造价〔2018〕13号文', projectName: '丰乐镇建设项目' });
    const outline = buildBlueprintOutline({ chapterTitles: FULL_CHAPTER_TITLES, boq, docType: '单位工程施工组织设计' });
    const blueprint = {
      meta: { version: '2.0.0', docType: '单位工程施工组织设计', createdAt: '2026-09-06', sourceMaterials: ['丰乐镇工程量清单.xls'] },
      data,
      outline,
      validation: { passed: false, checks: [] as Array<{ name: string; passed: boolean; message: string }> },
      diagnostics: {
        stage: '阶段 D', standardBlocksLoaded: 0, standardBlockGaps: [], laborDerivationBasis: '', llmCalls: 0, fallbackUsed: [], warnings: [], durationMs: 0,
      },
    };
    return { blueprint, boq };
  }

  it('全链路通过：Schema/事实锚定/覆盖（条目零丢失+十项评审承接）/内部一致性', () => {
    const { blueprint, boq } = buildValidatedBlueprint();
    const report = validateBlueprint(blueprint, boq);
    expect(report.passed).toBe(true);
    expect(report.checks.map(check => check.name)).toEqual([
      '1. Schema 校验',
      '2. 事实锚定校验',
      '3. 覆盖校验',
      '4. 内部一致性校验',
    ]);
  });

  it('覆盖校验：清单条目零丢失（删掉一个工作包的覆盖序号即判失败）', () => {
    const { blueprint, boq } = buildValidatedBlueprint();
    const firstPackage = blueprint.outline.chapters[0]!.subSections[0]!.workPackages[0]!;
    firstPackage.coveredSeqs = firstPackage.coveredSeqs.slice(1); // 人为丢 1 条
    const report = validateBlueprint(blueprint, boq);
    expect(report.passed).toBe(false);
    const coverage = report.checks.find(check => check.name === '3. 覆盖校验');
    expect(coverage?.passed).toBe(false);
    expect(coverage?.message).toContain('未被工作包覆盖');
  });

  it('Schema 校验：破坏必填结构即判失败', () => {
    const { blueprint, boq } = buildValidatedBlueprint();
    (blueprint.data as { milestones?: unknown }).milestones = undefined;
    const report = validateBlueprint(blueprint, boq);
    const schema = report.checks.find(check => check.name === '1. Schema 校验');
    expect(schema?.passed).toBe(false);
  });

  it('事实锚定校验：quantities 数值被篡改即判失败（L1 编造第一红线）', () => {
    const { blueprint, boq } = buildValidatedBlueprint();
    const firstKey = Object.keys(blueprint.data.quantities)[0]!;
    blueprint.data.quantities[firstKey] = { ...blueprint.data.quantities[firstKey]!, value: 99999 };
    const report = validateBlueprint(blueprint, boq);
    const facts = report.checks.find(check => check.name === '2. 事实锚定校验');
    expect(facts?.passed).toBe(false);
    expect(facts?.message).toContain('不一致');
  });
});

describe('回退路径（任何失败不阻断生成）', () => {
  it('绑定资料无清单文件 → resolveBillOfQuantities 返回警告而非异常', () => {
    const resolution = resolveBillOfQuantities({ projectRoot: '/tmp/nonexistent-project', boundFilePaths: ['招标文件.pdf'] });
    expect(resolution.boq).toBeUndefined();
    expect(resolution.warning).toContain('未识别到工程量清单');
  });

  it('buildIntegratedBlueprint 清单解析失败 → 降级空参数桶蓝图（不 throw，四道校验仍可运行）', () => {
    const blueprint = buildIntegratedBlueprint({
      projectRoot: '/tmp/nonexistent-project',
      boundFilePaths: ['招标文件.pdf'],
      chapterTitles: ['主要分部分项工程施工方案', '质量保证措施', '安全保证措施', '工期保证措施', '文明施工与环境保护', '施工总平面布置', '重难点分析及保证措施', '物资与机械劳动力配置计划'],
      templateName: '丰乐镇施组模板',
      basicFacts: '项目名称：丰乐镇建设项目 工期：360日历天 质量标准：合格',
    });
    expect(blueprint.meta.version).toBe('2.0.0');
    expect(blueprint.data.quantities).toEqual({});
    expect(blueprint.diagnostics.warnings.length).toBeGreaterThan(0);
    expect(blueprint.validation.checks).toHaveLength(4);
  });

  it('fallbackWorkPackagesFromExisting：无有效输入不 throw，返回数组', () => {
    const packages = fallbackWorkPackagesFromExisting('', []);
    expect(Array.isArray(packages)).toBe(true);
  });
});

describe('渲染函数（执行层输入）', () => {
  it('参数桶渲染：金额类红线事实只进「商务禁区」行，不进正文口径行', () => {
    const boq = parseFixture();
    const { data } = buildBlueprintData({ boq, basicFacts: '项目名称：丰乐镇建设项目 工期：360日历天 质量标准：合格', projectName: '丰乐镇建设项目' });
    const text = renderBlueprintDataText(data);
    expect(text).toContain('评审红线事实');
    expect(text).toContain('二级养护');
    // 金额禁区：暂列金额仅出现在禁区声明行（must_cite 行过滤掉 amount 条目）
    const nonAmountLine = text.split('\n').find(line => line.startsWith('- 评审红线事实'));
    expect(nonAmountLine).toBeDefined();
    expect(nonAmountLine).not.toContain('暂列金额');
    expect(text).toContain('金额类红线事实（商务禁区，不进正文）');
  });

  it('章切片渲染：must_cite 参数显性声明，工作包工序链/参数原样展开', () => {
    const boq = parseFixture();
    const outline = buildBlueprintOutline({ chapterTitles: ['主要分部分项工 程施工方案'], boq, docType: '单位工程施工组织设计' });
    const chapter = outline.chapters[0]!;
    expect(chapter.subSections.length).toBeGreaterThan(0);
    const slice = renderBlueprintChapterSlice(chapter);
    expect(slice).toContain('must_cite');
    expect(slice).toContain('工序链');
    const pipeSub = chapter.subSections.find(section => section.title === '排水工程');
    expect(pipeSub?.workPackages[0]?.processChain).toContain('混凝土管道DN200');
    expect(pipeSub?.workPackages[0]?.coveredSeqs).toEqual([2, 4]);
  });
});

describe('二期蓝图接管（执行层切换）', () => {
  function buildChapterSliceWithData() {
    const boq = parseFixture();
    const { data } = buildBlueprintData({ boq, basicFacts: '项目名称：丰乐镇建设项目 工期：360日历天 质量标准：合格', projectName: '丰乐镇建设项目' });
    const outline = buildBlueprintOutline({ chapterTitles: ['主要分部分项工程施工方案'], boq, docType: '单位工程施工组织设计' });
    const chapter = outline.chapters[0]!;
    // 人工修订口径：章级补挂总工期 must_cite（对齐函数对修订后蓝图同样生效）
    chapter.subSections[0]!.requiredParams.push({ path: 'data.contract.total_days', mode: 'must_cite', strict: true });
    return { chapter, data };
  }

  it('findBlueprintChapter：模板章标题精确匹配，含括号/序号差异时 includes 兜底', () => {
    const boq = parseFixture();
    const blueprint = { outline: buildBlueprintOutline({ chapterTitles: ['主要分部分项工程施工方案', '质量保证措施'], boq, docType: '单位工程施工组织设计' }) };
    expect(findBlueprintChapter(blueprint as never, '主要分部分项工程施工方案')?.title).toBe('主要分部分项工程施工方案');
    expect(findBlueprintChapter(blueprint as never, '质量保证措施（GB50300）')?.title).toBe('质量保证措施');
    expect(findBlueprintChapter(blueprint as never, '不存在的章')).toBeUndefined();
  });

  it('蓝图引用对齐：must_cite+strict 数值不一致时确定性回填（总工期/清单工程量）', () => {
    const { chapter, data } = buildChapterSliceWithData();
    const markdown = '## 主要分部分项工程施工方案\n\n### 排水工程\n\n混凝土管道DN200 总长 2400m，采用人机配合下管。\n\n本项目总工期为 300 日历天。';
    const aligned = alignChapterContentToBlueprint(markdown, chapter, data);
    expect(aligned.markdown).toContain('混凝土管道DN200 总长 50m');
    expect(aligned.markdown).toContain('总工期为 360 日历天');
    expect(aligned.fixed).toEqual(expect.arrayContaining([
      expect.objectContaining({ anchor: '混凝土管道DN200', from: '2400m', to: '50m' }),
      expect.objectContaining({ anchor: '总工期', from: '300天', to: '360天' }),
    ]));
  });

  it('蓝图引用对齐：DN200 规格内数字不误伤（名称后第一个数字是规格 200 而非工程量）', () => {
    const { chapter, data } = buildChapterSliceWithData();
    const markdown = '混凝土管道DN200 长度 50m。';
    const aligned = alignChapterContentToBlueprint(markdown, chapter, data);
    expect(aligned.markdown).toBe(markdown);
    expect(aligned.fixed).toHaveLength(0);
  });

  it('蓝图引用对齐：正文未引用 must_cite 数值 → missing 缺口报告（不阻断不回填）', () => {
    const { chapter, data } = buildChapterSliceWithData();
    const markdown = '### 道路工程\n\n村庄道路施工有序推进。';
    const aligned = alignChapterContentToBlueprint(markdown, chapter, data);
    expect(aligned.fixed).toHaveLength(0);
    expect(aligned.missing.length).toBeGreaterThan(0);
    expect(aligned.markdown).toBe(markdown);
  });

  it('renderBlueprintMustCiteValues：must_cite+strict 数值渲染为块质检反馈清单', () => {
    const { chapter, data } = buildChapterSliceWithData();
    const hint = renderBlueprintMustCiteValues(chapter, data);
    expect(hint).toContain('总工期 360 日历天');
    expect(hint).toContain('混凝土管道DN200 50m');
    expect(hint).toContain('挖一般土方 120.5m3');
  });

  it('蓝图参数桶渲染：取代主表口径的权威文本包含工期/劳动力峰值唯一口径/金额禁区声明', () => {
    const { data } = buildChapterSliceWithData();
    const text = renderBlueprintDataText(data);
    expect(text).toContain('总工期：360 日历天');
    expect(text).toContain('金额禁区');
    // 劳动力峰值不再渲染区间，只渲染唯一口径值
    const laborLine = text.split('\n').find(line => line.startsWith('- 劳动力峰值'));
    expect(laborLine).toBeDefined();
    expect(laborLine).not.toContain('~');
    expect(laborLine).toContain(`${data.resources.labor.peakValue} 人`);
  });
});

describe('三期收口：蓝图权威 / 章规划确定性转换 / 蓝图引用一致性 / 决策锁同源', () => {
  function buildData() {
    const boq = parseFixture();
    return buildBlueprintData({ boq, basicFacts: '项目名称：丰乐镇建设项目 工期：360日历天 质量标准：合格', projectName: '丰乐镇建设项目' }).data;
  }

  it('blueprintPlanAuthorities：里程碑→节点工期权威、机械→锚点键台数（区间取中值）', () => {
    const data = buildData();
    data.milestones = [{ key: 'm1', label: '管网施工完成', duration: 45, basis: '清单分部分项' }];
    data.resources.equipment = [
      { name: '塔式起重机', min: 1, max: 2, basis: '区间口径' },
      { name: '钢筋弯曲机', quantity: 3, basis: '区间口径' },
      { name: '挖掘机', min: 2, max: 3, basis: '区间口径' },
    ];
    const authorities = blueprintPlanAuthorities(data);
    expect(authorities.nodeAuthorities).toEqual([{ node: '管网施工完成', offset: '45 天' }]);
    expect(authorities.machineAuthorities.towerCrane).toBe(2); // round((1+2)/2)
    expect(authorities.machineAuthorities.rebarBender).toBe(3); // quantity 优先
    expect(authorities.machineAuthorities).not.toHaveProperty('excavator'); // 无锚点键映射的机械不注入
  });

  it('blueprintPlanAuthorities：清单条目 → quantityAuthorities（G3 工程量权威）', () => {
    const data = buildData();
    data.quantities = {
      '级配碎石': { value: 20931.02, unit: 'm²' },
      '挖一般土方': { value: 4187.38, unit: 'm³' },
      '公厕入口内墙涂料': { value: 5.2, unit: 'm²' },
      'LED 灯具': { value: 118, unit: '套' },
    };
    const authorities = blueprintPlanAuthorities(data);
    expect(authorities.quantityAuthorities).toEqual([
      { name: '级配碎石', value: 20931.02, unit: 'm²' },
      { name: '挖一般土方', value: 4187.38, unit: 'm³' },
    ]);
    // 值 <10 的零星量与台/套设备量不入工程量权威（设备走 machineAuthorities）
  });

  it('buildChapterStructureFromBlueprint：蓝图章切片 → 每 sub_section 一个主题块、工作包为 H4 要点', () => {
    const boq = parseFixture();
    const outline = buildBlueprintOutline({ chapterTitles: ['主要分部分项工程施工方案'], boq, docType: '单位工程施工组织设计' });
    const chapter = outline.chapters[0]!;
    const structure = buildChapterStructureFromBlueprint({ blueprintChapter: chapter, inputSections: ['道路工程', '排水工程', '绿化工程'], chapterTitle: '主要分部分项工程施工方案', targetWords: 6000 });
    expect(structure.llmPlanned).toBe(false);
    expect(structure.blocks.length).toBeGreaterThanOrEqual(chapter.subSections.length);
    expect(structure.blocks.flatMap(block => block.subPoints).map(point => point.title)).toContain('道路工程');
    expect(structure.blocks.every(block => block.targetWords >= 1200 && block.targetWords <= 4000)).toBe(true);
    // 输入细目与切片同名 → 全量覆盖、零回退
    expect(structure.coveredSections.length).toBe(3);
    expect(structure.fallbackSections).toEqual([]);
  });

  it('容器块骨架同源展开：关键施工容器块 H4 要点用骨架提取名铺开（块规划与写作骨架锁定同源）', () => {
    const structure = buildChapterStructureFromBlueprint({
      blueprintChapter: undefined,
      inputSections: ['编制说明与工程概况', '项目主要施工内容'],
      chapterTitle: '工程概况',
      targetWords: 8000,
      projectContext: '项目名称：丰乐镇建设项目。招标范围包括但不限于：道路工程、排水工程、绿化工程。',
      evidence: [],
    });
    // 块顺序保持 inputSections 原顺序（容器块不前置——第一章 1.1 应为「编制说明与工程概况」）
    expect(structure.blocks[0].title.startsWith('编制说明与工程概况')).toBe(true);
    expect(structure.blocks[1].title).toBe('项目主要施工内容');
    const container = structure.blocks.find(block => block.title === '项目主要施工内容');
    expect(container?.subPoints.map(point => point.title)).toEqual(expect.arrayContaining(['道路工程', '排水工程', '绿化工程']));
    // 骨架展开后容器块不再被拆半（halfFocus 与三要素硬要求冲突根因）
    const split = splitSinglePointOversizedBlocks(structure);
    expect(split.blocks.some(block => block.title.startsWith('项目主要施工内容（'))).toBe(false);
  });

  it('4.19.5 回归：分部章容器块不展开任何骨架名（保持单要点总述块，含中文编号形态骨架名）', () => {
    const structure = buildChapterStructureFromBlueprint({
      blueprintChapter: { id: '2', title: '主要施工方法', isActive: true, requiredParams: [], scoredItems: [], subSections: [{ id: '2.5', title: '绿化工程', requiredParams: [], scoredItems: [], tablePlans: [], workPackages: [{ name: '绿化工程', kind: 'major', quantities: {}, processChain: [], methods: [], params: [], acceptance: [], standards: [], skeleton: [], source: 'boq', coveredSeqs: [] }] }] },
      inputSections: ['绿化工程', '主要分部分项工程施工方案'],
      chapterTitle: '主要施工方法',
      targetWords: 6000,
      // 骨架名含「三、绿化工程」中文编号形态（normalizeSubsectionTitleForDedup 只剥数字编号）与
      // 子特征名（生态池——实为分部块内部工序粒度）：分部章容器块是全章总述小节，一律不展开——
      // 展开任何骨架名都会诱导 LLM 在容器块内复写分部方案（清单外+三要素重复）→ 章阻断
      projectContext: '施工工作包结构化数据： [{"name":"三、绿化工程","scope":"绿化施工范围"},{"name":"道路工程","scope":"道路范围"},{"name":"排水工程","scope":"排水范围"},{"name":"生态池","scope":"生态池范围"}]',
      evidence: [],
    });
    const container = structure.blocks.find(block => block.title === '主要分部分项工程施工方案');
    // 容器块保持单要点（同名要点由 H3 外壳直接承担），写作层对其下发总述提示词
    expect(container?.subPoints.map(point => point.title)).toEqual(['主要分部分项工程施工方案']);
  });

  it('splitSinglePointOversizedBlocks：关键施工容器块不拆半，普通单要点大块照常拆半', () => {
    const structure = splitSinglePointOversizedBlocks({
      blocks: [
        { title: '编制说明与工程概况', subPoints: [{ title: '编制说明与工程概况', sources: ['编制说明与工程概况'] }], facts: [], targetWords: 3600 },
        { title: '项目主要施工内容', subPoints: [{ title: '项目主要施工内容', sources: ['项目主要施工内容'] }], facts: [], targetWords: 3600 },
      ],
      coveredSections: [], fallbackSections: [], llmPlanned: false,
    });
    const container = structure.blocks.find(block => block.title === '项目主要施工内容');
    const plain = structure.blocks.find(block => block.title.startsWith('编制说明与工程概况（'));
    expect(container?.targetWords).toBe(3600);
    expect(plain?.targetWords).toBeLessThan(3600);
    expect(plain?.halfFocus).toBeDefined();
  });

  it('buildBlueprintOutline：机械章不再误挂清单分部（「主要施工」泛匹配串章根因）', () => {
    const boq = parseFixture();
    const outline = buildBlueprintOutline({ chapterTitles: ['主要施工方法', '拟投入的主要施工机械、设备计划'], boq, docType: '单位工程施工组织设计' });
    const method = outline.chapters.find(chapter => chapter.title === '主要施工方法');
    const machine = outline.chapters.find(chapter => chapter.title === '拟投入的主要施工机械、设备计划');
    expect(method?.subSections.length).toBeGreaterThan(0);
    expect(machine?.subSections.length).toBe(0);
  });

  it('buildChapterStructureFromBlueprint：切片未覆盖的模板小节语义域挂回（模板小节零丢失）', () => {
    const boq = parseFixture();
    const outline = buildBlueprintOutline({ chapterTitles: ['主要施工方法'], boq, docType: '单位工程施工组织设计' });
    const chapter = outline.chapters[0]!;
    const structure = buildChapterStructureFromBlueprint({ blueprintChapter: chapter, inputSections: ['市政工程专项施工工艺', '道路工程'], chapterTitle: '主要施工方法', targetWords: 6000 });
    expect(structure.fallbackSections).toEqual([]);
    expect(structure.blocks.some(block => block.subPoints.some(point => point.title.includes('市政工程专项施工工艺')))).toBe(true);
  });

  it('scopeEngineeringNames：招标答疑疑问句碎片与「及其他」叙述组合不入工作包名（三要素垃圾名根因）', () => {
    const context = '招标范围包括但不限于：道路工程、排水工程、是否考虑现场道路、水沟及其他所有构筑物拆除、绿化工程、景观工程。';
    const names = scopeEngineeringNames(context, []);
    expect(names).toEqual(expect.arrayContaining(['道路工程', '排水工程', '绿化工程', '景观工程']));
    expect(names.some(name => name.includes('是否'))).toBe(false);
    expect(names.some(name => name.includes('构筑物拆除'))).toBe(false);
  });

  it('majorConstructionSkeletonNames：列举尾巴清洗（等尾巴名还原为真工程名）', () => {
    const context = '招标范围包括但不限于：标识及其他项目等景观工程、生态处理等污水工程、绿化工程、道路工程、是否考虑现场道路。';
    const names = majorConstructionSkeletonNames(context, []);
    expect(names).toContain('景观工程');
    expect(names).toContain('污水工程');
    expect(names.some(name => name.includes('其他项目') || name.includes('是否'))).toBe(false);
  });

  it('buildChapterStructureFromBlueprint：无切片 → 语义域分组确定性兜底（llmPlanned=false）', () => {
    const structure = buildChapterStructureFromBlueprint({ blueprintChapter: undefined, inputSections: ['安全管理措施', '安全生产责任制', '质量验收标准', '实测实量要求', '工期纠偏措施'], chapterTitle: '安全质量保证措施', targetWords: 5000 });
    expect(structure.llmPlanned).toBe(false);
    expect(structure.blocks.length).toBeGreaterThanOrEqual(2); // 安全/质量/工期 至少三域
    expect(structure.blocks.flatMap(block => block.subPoints).map(point => point.title)).toEqual(expect.arrayContaining(['安全管理措施', '质量验收标准', '工期纠偏措施']));
    expect(structure.fallbackSections).toEqual([]);
  });

  it('blueprintCitationConsistencyIssues：工期/工程量与蓝图不一致 → error；红线事实缺失 → warning', () => {
    const data = buildData();
    const wrongDays = blueprintCitationConsistencyIssues('本项目总工期为 300 日历天。', data);
    expect(wrongDays.some(issue => issue.level === 'error' && issue.message.includes('蓝图引用冲突'))).toBe(true);
    const wrongQuantity = blueprintCitationConsistencyIssues('混凝土管道DN200 总长 240m。', data);
    expect(wrongQuantity.some(issue => issue.level === 'error' && issue.message.includes('工程量'))).toBe(true);
    // 一致口径零 error 冲突（红线事实缺失仍产生 warning 缺口观测）
    expect(blueprintCitationConsistencyIssues('本项目总工期为 360 日历天。', data).filter(issue => issue.level === 'error')).toEqual([]);
    // 非金额红线事实未体现 → warning（缺口观测不阻断）；金额类红线不参与
    const missing = blueprintCitationConsistencyIssues('村庄道路施工有序推进。', data);
    expect(missing.some(issue => issue.level === 'warning' && issue.message.includes('蓝图红线事实缺口'))).toBe(true);
  });

  it('buildBlueprintDecisionLock：数据口径条目锁定总工期/劳动力峰值/自然村数量/核心工程量', () => {
    const boq = parseFixture();
    const labor = deriveLaborFromBoq(boq, 360);
    const lock = buildBlueprintDecisionLock({ contract: { totalDays: 360, qualityStandard: '合格', pricingFile: '' }, labor, boq, villageCount: 20 });
    expect(lock.entries.find(entry => entry.id === 'contract_days')?.values).toEqual(['360 日历天']);
    expect(lock.entries.find(entry => entry.id === 'labor_peak')?.values).toEqual([`${labor.peakValue} 人`]);
    expect(lock.entries.find(entry => entry.id === 'village_count')?.values).toEqual(['20 个自然村']);
    expect(lock.entries.find(entry => entry.id === 'core_quantities')?.values).toEqual([
      '挖沟槽土方 60m3（排水工程）',
      '挖一般土方 120.5m3（道路工程）',
      '绿化养护 500m2（绿化工程）',
    ]);
  });

  it('P2.4 自然村数量入红线事实：项目名正则提取 20，事实值与村数一致', () => {
    expect(extractVillageCount('2026年度丰乐镇20个美丽宜居自然村建设项目', '工期：90日历天')).toBe(20);
    expect(extractVillageCount('普通道路工程', '无自然村表述')).toBe(0);
    const data = buildData();
    const villageFact = data.redLineFacts.find((fact: BlueprintRedLineFact) => fact.key === '自然村数量');
    expect(villageFact?.value).toBe('1 个自然村');
  });

  it('P2.3 蓝图引用一致性：正文村数与蓝图不符 → error，一致 → 零 error', () => {
    const data = buildData();
    const wrong = blueprintCitationConsistencyIssues('本项目涉及 9 个自然村，分散施工。', data);
    expect(wrong.some(issue => issue.level === 'error' && issue.message.includes('自然村数量'))).toBe(true);
    const consistent = blueprintCitationConsistencyIssues('本项目涉及 1 个自然村，村内流水施工。', data);
    expect(consistent.filter(issue => issue.level === 'error')).toEqual([]);
    // 「自然村分组」清单分组口径不参与村数校验
    const scoped = blueprintCitationConsistencyIssues('清单按 3 个自然村分组编制。', data);
    expect(scoped.filter(issue => issue.level === 'error')).toEqual([]);
  });

  it('P2.3 材料规格权威：同名「垫层」条目 C 标号众数锁定（异名人行道垫层不参与）', () => {
    const chunks: BoqChunkRow[] = [
      {
        chunkIndex: 0,
        sectionTitle: '表格数据',
        content: '工程名称：马老郢等 标段： 工作表：1.1 第1页 共1页\n| 序号 | 项目编码 | COL3 | 项目名称 | 项目特征描述 | 计量单位 | COL7 | 工程量 |\n| 1 | 010404001001 |  | 垫层 | 1．3:7灰土 2．满足验收要求 | m3 |  | 1 |\n| 2 | 010404001002 |  | 垫层 | 1．混凝土种类：商品砼 2．混凝土强度等级：C20 | m3 |  | 2 |\n| 3 | 010404001003 |  | 人行道混凝土垫层 | 1．材料品种：C25素砼垫层 | m3 |  | 3 |\n第1页 共1页',
      },
    ];
    const boq = parseBillOfQuantities({ chunks, sourceFile: '清单.xls' });
    const authorities = deriveSpecAuthoritiesFromBoq(boq);
    expect(authorities.cushion).toBe('C20');
  });

  it('P2.3 blueprintPlanAuthorities：机动工期 = 总工期 − 里程碑总和，自然村数量取红线事实', () => {
    const boq = parseFixture();
    const { data } = buildBlueprintData({ boq, basicFacts: '项目名称：丰乐镇建设项目 工期：360日历天 质量标准：合格', projectName: '丰乐镇建设项目' });
    const authorities = blueprintPlanAuthorities(data);
    const milestoneSum = data.milestones.reduce((sum, item) => sum + (item.duration || 0), 0);
    expect(authorities.slackDaysAuthority).toBe(360 - milestoneSum);
    expect(authorities.villageCountAuthority).toBe(1);
    expect(authorities.specAuthorities).toEqual({});
  });

  it('蓝图引用一致性：正文劳动力峰值与蓝图唯一口径不一致 → error，一致 → 零 error', () => {
    const data = buildData();
    const wrong = blueprintCitationConsistencyIssues(`劳动力峰值为 ${data.resources.labor.peakValue + 5} 人。`, data);
    expect(wrong.some(issue => issue.level === 'error' && issue.message.includes('劳动力峰值'))).toBe(true);
    const consistent = blueprintCitationConsistencyIssues(`本项目劳动力峰值为 ${data.resources.labor.peakValue} 人，各工种高峰期叠加控制在该峰值以内。`, data);
    expect(consistent.filter(issue => issue.level === 'error')).toEqual([]);
  });

  it('extractDecisionLockEntries：权威源提及锁定、否定句不计分、互斥类目唯一化', () => {
    const facts: DocumentFact[] = [
      { key: 'vertical_transport', value: '塔式起重机', sourceFile: '招标文件.docx', roleId: 'bid', confidence: 0.9 },
    ];
    const evidence: DocumentEvidence[] = [
      { chapterId: 'c1', filePath: '招标文件.docx', score: 0.9, content: '本工程垂直运输采用塔式起重机。' },
      { chapterId: 'c1', filePath: '招标文件.docx', score: 0.9, content: '本工程不采用自拌混凝土，混凝土采用商品混凝土供应。' },
    ];
    const entries = extractDecisionLockEntries({ facts, evidence });
    const vertical = entries.find(entry => entry.id === 'vertical_transport');
    expect(vertical?.values).toContain('塔式起重机');
    const concrete = entries.find(entry => entry.id === 'concrete_supply');
    expect(concrete?.values).toEqual(['商品混凝土（预拌）']); // 否定句“不采用自拌”不计分
    expect(concrete?.label).toBe('混凝土供应');
  });

  it('decisionLockCategoryMeta / decisionMentionNegated：检测器同源接口与锁构建单一事实源', () => {
    expect(decisionLockCategoryMeta('formwork')?.exclusive).toBe(true);
    expect(decisionLockCategoryMeta('vertical_transport')?.label).toBe('垂直运输方式');
    expect(decisionLockCategoryMeta('nonexistent')).toBeUndefined();
    expect(decisionMentionNegated('本工程不采用施工电梯，垂直运输采用塔式起重机。', /施工电梯|施工升降机/u)).toBe(true);
    expect(decisionMentionNegated('本工程施工电梯布置两台。', /施工电梯|施工升降机/u)).toBe(false);
  });

  it('buildBlueprintOutline：专项施工方案类文档失活总平面布置章（is_active 裁剪），施组类全激活', () => {
    const boq = parseFixture();
    const special = buildBlueprintOutline({ chapterTitles: ['主要分部分项工程施工方案', '施工总平面布置'], boq, docType: '专项施工方案' });
    const general = buildBlueprintOutline({ chapterTitles: ['主要分部分项工程施工方案', '施工总平面布置'], boq, docType: '单位工程施工组织设计' });
    expect(special.chapters.find(chapter => chapter.title === '施工总平面布置')?.isActive).toBe(false);
    expect(special.chapters.find(chapter => chapter.title === '主要分部分项工程施工方案')?.isActive).toBe(true);
    expect(general.chapters.every(chapter => chapter.isActive)).toBe(true);
  });
});

describe('P3.6 源头修复（A1 工期锚点 / A2 村数正则 / A3 序号前缀 / A4 区间不渲染 / A5 决策锁完备性）', () => {
  it('A1 总工期只从工期类锚点邻接收值：质保期 90 不误采、计划工期 210 正确采、阶段工期 90 不顶替', () => {
    const boq = parseFixture();
    const contract = extractContractFromFacts('本工程质保期为90日历天，计划工期为210日历天，质量要求：合格。', boq);
    expect(contract.totalDays).toBe(210);
    const staged = extractContractFromFacts('阶段工期：90日历天；总工期：300日历天；质量要求：合格。', boq);
    expect(staged.totalDays).toBe(300);
    const bare = extractContractFromFacts('工期：360日历天，质量标准：合格。', boq);
    expect(bare.totalDays).toBe(360); // 裸「工期：N日历天」兼容旧测试口径
  });

  it('A2 自然村数量：项目名无空格形态「丰乐镇20个」优先命中，不受基本事实串染', () => {
    expect(extractVillageCount('2026年度丰乐镇20个美丽宜居自然村建设项目', '基本事实中提及9个自然村分组')).toBe(20);
    expect(extractVillageCount('某镇12个自然村建设项目', '')).toBe(12);
    // 项目名缺失时才降级 basicFacts（跨项目串染隔离由 sanitizeFactPool 在事实池层负责）
    expect(extractVillageCount('无自然村数项目', '丰乐镇20个美丽宜居自然村')).toBe(20);
  });

  it('A3 项目名序号前缀剥离：basicFacts 项目名带「9.14--」前缀 → 蓝图项目名无前缀（跨项目通用）', () => {
    const blueprint = buildIntegratedBlueprint({
      projectRoot: '/tmp/nonexistent-project',
      boundFilePaths: ['招标文件.pdf'],
      chapterTitles: ['主要分部分项工程施工方案', '质量保证措施', '安全保证措施', '工期保证措施', '文明施工与环境保护', '施工总平面布置', '重难点分析及保证措施', '物资与机械劳动力配置计划'],
      templateName: '施组模板',
      // 「计划工期」边界词在「工期」前匹配，不得残留「计划」两字在项目名尾部
      basicFacts: '项目名称：9.14--2026年度丰乐镇20个美丽宜居自然村建设项目 计划工期：360日历天 质量标准：合格',
    });
    expect(blueprint.data.project.name).not.toContain('9.14');
    expect(blueprint.data.project.name).toBe('2026年度丰乐镇20个美丽宜居自然村建设项目');
  });

  it('A4 参数桶渲染不泄漏区间端点：工种配置渲染单值人数、机械台数只渲染单值', () => {
    const boq = parseFixture();
    const { data } = buildBlueprintData({ boq, basicFacts: '项目名称：丰乐镇建设项目 工期：360日历天 质量标准：合格', projectName: '丰乐镇建设项目' });
    const text = renderBlueprintDataText(data);
    const tradeLine = text.split('\n').find(line => line.includes('工种配置'))!;
    expect(tradeLine).toBeDefined();
    // D 组值化（丰乐镇第 3 轮）：工种配置行归一化单值人数（区间中值），不再只渲染名单
    expect(/[^\d]\d+\s*人/u.test(tradeLine.split('：')[1]!)).toBe(true); // 工种行含单值人数
    expect(/\d+\s*~\s*\d+\s*人/u.test(tradeLine)).toBe(false); // 人数不含区间端点
    expect(tradeLine).not.toContain('不另设工种数值');
    const machineLine = text.split('\n').find(line => line.includes('主要机械'))!;
    expect(machineLine).toBeDefined();
    expect(/\d+\s*~\s*\d+\s*台/u.test(machineLine)).toBe(false); // 台数不含区间端点
    expect(/\d+\s*台/u.test(machineLine)).toBe(true); // 台数为单值口径
  });

  it('A5 决策锁数据条目完备性硬检查：删掉 contract_days 锁条目 → 内部一致性校验失败（空壳锁根治）', () => {
    const boq = parseFixture();
    const { data } = buildBlueprintData({ boq, basicFacts: '项目名称：丰乐镇建设项目 工期：360日历天 质量标准：合格 计价依据：合造价〔2018〕13号文', projectName: '丰乐镇建设项目' });
    const outline = buildBlueprintOutline({ chapterTitles: ['主要分部分项工程施工方案', '质量保证措施', '安全保证措施', '工期保证措施', '文明施工与环境保护', '施工总平面布置', '重难点分析及保证措施', '物资与机械劳动力配置计划'], boq, docType: '单位工程施工组织设计' });
    const blueprint = {
      meta: { version: '2.0.0', docType: '单位工程施工组织设计', createdAt: '2026-09-06', sourceMaterials: ['丰乐镇工程量清单.xls'] },
      data: { ...data, decisionLock: { entries: data.decisionLock.entries.filter(entry => entry.id !== 'contract_days') } },
      outline,
      validation: { passed: false, checks: [] as Array<{ name: string; passed: boolean; message: string }> },
      diagnostics: { stage: '阶段 D', standardBlocksLoaded: 0, standardBlockGaps: [], laborDerivationBasis: '', llmCalls: 0, fallbackUsed: [], warnings: [], durationMs: 0 },
    };
    const report = validateBlueprint(blueprint, boq);
    const consistency = report.checks.find(check => check.name === '4. 内部一致性校验');
    expect(consistency?.passed).toBe(false);
    expect(consistency?.message).toContain('contract_days');
  });
});
