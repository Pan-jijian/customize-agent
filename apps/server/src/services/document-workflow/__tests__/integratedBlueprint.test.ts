import { describe, expect, it } from 'vitest';
import { parseBillOfQuantities, pickBillOfQuantityFiles } from '../billOfQuantitiesParser';
import type { BillOfQuantitiesResult, BoqChunkRow, BoqEntry } from '../billOfQuantitiesParser';
import type { DocumentEvidence, DocumentFact } from '../types';
import {
  alignChapterContentToBlueprint,
  blueprintCitationConsistencyIssues,
  blueprintCitationVerdict,
  buildBlueprintData,
  buildBlueprintDecisionLock,
  buildBlueprintOutline,
  buildChapterStructureFromBlueprint,
  buildIntegratedBlueprint,
  buildWorkPackageFromBoqSection,
  collectBlueprintCitationCandidates,
  decisionLockCategoryMeta,
  decisionMentionNegated,
  deriveEarthworkBalanceFromBoq,
  deriveLaborFromBoq,
  deriveMaterialsPlanFromBoq,
  deriveMilestonesFromBoq,
  deriveSpecAuthoritiesFromBoq,
  estimateChapterMinFeasibleWords,
  extractBasisRegulations,
  extractContractFromFacts,
  extractDecisionLockEntries,
  extractLocationFromFacts,
  extractRedLineFacts,
  extractVillageCount,
  findBlueprintChapter,
  rebaseCitationAnchorsForChapters,
  renderBlueprintChapterAuthorityCard,
  renderBlueprintChapterSlice,
  renderBlueprintBlockSlice,
  renderBlueprintDataText,
  renderBlueprintMustCiteValues,
  resolveBillOfQuantities,
  validateBlueprint,
} from '../integratedBlueprint';
import type { BlueprintRedLineFact } from '../integratedBlueprint';
import type { AdjudicationConclusion, AdjudicationRecord, CitationAdjudicationCandidate, CitationAdjudicator } from '../semanticAdjudication';
import { buildAuthorityIndex } from '../authorityIndex';
import { deriveRepairAuthorities } from '../integrity/fixers/fixers';
import { majorConstructionSkeletonNames, scopeEngineeringNames } from '../chapterPostProcessing';
import { villageMunicipalStrategy } from '../blueprintDerivationStrategies';

/** S5 判定层 mock 记录构造（三态注入共用：调用方候选 → 判定记录表） */
function recordsFor(candidates: CitationAdjudicationCandidate[], conclusion: AdjudicationConclusion, rationale: string): Map<string, AdjudicationRecord> {
  const records = new Map<string, AdjudicationRecord>();
  for (const candidate of candidates) records.set(candidate.id, { id: candidate.id, conclusion, rationale });
  return records;
}

/** S5 判定层 mock：全部候选判 conflict（确以项目级口径陈述且与权威不一致） */
const conflictAll: CitationAdjudicator = async candidates => ({
  records: recordsFor(candidates, 'conflict', '以项目级口径陈述且与权威不一致'),
});

/** S5 判定层 mock：全部候选判 consistent（非项目级口径陈述：规格/分区/单体/分部量口径） */
const consistentAll: CitationAdjudicator = async candidates => ({
  records: recordsFor(candidates, 'consistent', '非项目级口径陈述'),
});

/** S5 判定层 mock：判定不可用（全 uncertain + unavailable 原因） */
const unavailableAll: CitationAdjudicator = async candidates => ({
  records: recordsFor(candidates, 'uncertain', '判定不可用'),
  unavailable: '模型未配置',
});

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

  it('清单三层结构识别：单位工程（2.3 公厕）独立为分部，其内部子分部（0101 土石方工程）降级为分节', () => {
    const chunks: BoqChunkRow[] = [
      {
        chunkIndex: 0,
        sectionTitle: '表格数据',
        content: [
          '工程名称：马老郢等 标段： 工作表：1.1 第1页 共1页',
          '| 序号 | 项目编码 | COL3 | 项目名称 | 项目特征描述 | 计量单位 | COL7 | 工程量 | 金额 |',
          '|  | 二 |  | 排水工程 |',
          '|  | 2.1 |  | 马老郢 |',
          '| 1 | 040101002002 |  | 挖沟槽土方 | 1．沟槽深度：1.5m以内 | m3 |  | 60 |',
          '|  | 2.3 |  | 公厕 |',
          '|  | 0101 |  | 土石方工程 |',
          '| 2 | 010101001001 |  | 平整场地 | 1．部位：公厕基础 | m2 |  | 120 |',
          '|  | 0104 |  | 砌筑工程 |',
          '| 3 | 010401001001 |  | 砖基础 | 1．砖品种：MU10 | m3 |  | 30 |',
          '第1页 共1页',
        ].join('\n'),
      },
    ];
    const result = parseBillOfQuantities({ chunks, sourceFile: '清单.xls' });
    const trench = result.entries.find(entry => entry.name === '挖沟槽土方');
    expect(trench?.section).toBe('排水工程');
    expect(trench?.subsection).toBe('马老郢');
    expect(trench?.sectionKind).toBe('plain');
    const leveling = result.entries.find(entry => entry.name === '平整场地');
    expect(leveling?.section).toBe('公厕');
    expect(leveling?.subsection).toBe('土石方工程');
    expect(leveling?.sectionKind).toBe('unit-project');
    const brick = result.entries.find(entry => entry.name === '砖基础');
    expect(brick?.section).toBe('公厕');
    expect(brick?.subsection).toBe('砌筑工程');
    expect(brick?.sectionKind).toBe('unit-project');
  });

  it('普通 x.y 子目链不误判单位工程（1.1 新建混凝土道路 后跟 1.2 而非纯数字编码）', () => {
    const chunks: BoqChunkRow[] = [
      {
        chunkIndex: 0,
        sectionTitle: '表格数据',
        content: [
          '工程名称：马老郢等 标段： 工作表：1.1 第1页 共1页',
          '| 序号 | 项目编码 | COL3 | 项目名称 | 项目特征描述 | 计量单位 | COL7 | 工程量 | 金额 |',
          '|  | 一 |  | 道路工程 |',
          '|  | 1.1 |  | 新建混凝土道路 |',
          '| 1 | 040101001001 |  | 挖一般土方 | 1．土壤类别：综合类 | m3 |  | 100 |',
          '|  | 1.2 |  | 入户路 |',
          '| 2 | 040203007002 |  | 水泥混凝土 | 1．厚度：10cm | m2 |  | 50 |',
          '第1页 共1页',
        ].join('\n'),
      },
    ];
    const result = parseBillOfQuantities({ chunks, sourceFile: '清单.xls' });
    const earth = result.entries.find(entry => entry.name === '挖一般土方');
    expect(earth?.section).toBe('道路工程');
    expect(earth?.subsection).toBe('新建混凝土道路');
    expect(earth?.sectionKind).toBe('plain');
    const concrete = result.entries.find(entry => entry.name === '水泥混凝土');
    expect(concrete?.section).toBe('道路工程');
    expect(concrete?.subsection).toBe('入户路');
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

  it('extractBasisRegulations：书名号法规提取去重，跨行截断残名清洗（换行/### 符号）', () => {
    const text = [
      '本招标项目依据《中华人民共和国招标投标法》《建设工程质量管理条例》组织。',
      '### 10.3 《保障农民工工资支付条例》（国令第724号）《工程建',
      '### 设领域农民工工资专用账户管理暂行办法》等有关法规。',
      '《中华人民共和国招标投标法实',
      '### 施条例》与《合肥市公共资源交易管理条例》共同适用。',
      '《关于优化进皖建设工程企业信息登记服务和管理有关工作的通知》不列入。',
      '《纳税人跨县（市、区）提供建筑服务增值税征收管理暂行办法》超长税务残名不列入。',
    ].join('\n');
    const regs = extractBasisRegulations(text);
    expect(regs).toContain('《中华人民共和国招标投标法》');
    expect(regs).toContain('《建设工程质量管理条例》');
    expect(regs).toContain('《保障农民工工资支付条例》（国令第724号）');
    expect(regs).toContain('《中华人民共和国招标投标法实施条例》');
    expect(regs).toContain('《合肥市公共资源交易管理条例》');
    expect(regs).not.toContain(expect.stringContaining('通知'));
    expect(regs).not.toContain(expect.stringContaining('工程建要求设'));
    expect(regs).not.toContain(expect.stringContaining('纳税人'));
  });

  it('章级锚点卡：编制依据域渲染招标文件提取法规与自写要求（工程概况章命中；十度治理后不再喂确定性清单）', () => {
    const boq = parseFixture();
    const { data } = buildBlueprintData({
      boq,
      basicFacts: '项目名称：丰乐镇建设项目 工期：360日历天 《建设工程质量管理条例》（国务院令第279号）',
      projectName: '丰乐镇建设项目',
      strategy: villageMunicipalStrategy,
    });
    const outline = buildBlueprintOutline({ chapterTitles: ['工程概况'], boq, docType: '单位工程施工组织设计' });
    const card = renderBlueprintChapterAuthorityCard(outline.chapters[0]!, data);
    // 招标文件提取法规（项目专属事实）仍注入照抄
    expect(card).toContain('《建设工程质量管理条例》（国务院令第279号）');
    // 写作要求提示注入（法规/条例/规范由写作模型自行列写，不得空写类别话术）
    expect(card).toContain('由写作模型自行列写');
    // 确定性规范清单不得注入（模型自写）
    expect(card).not.toContain('CJJ 1-2008');
    expect(card).not.toContain('GB 50268-2008');
    expect(card).not.toContain('CJJ 82-2012');
    expect(card).not.toContain('CJJ 89-2012');
    expect(card).not.toContain('GB 50300-2013');
  });

  it('章级锚点卡：编制依据域不注入国家/地方性法规确定性清单（十度治理：模型自行列写，交付前检测兑底）', () => {
    const boq = parseFixture();
    const { data } = buildBlueprintData({
      boq,
      basicFacts: '项目名称：丰乐镇建设项目 建设地点：安徽省合肥市肥西县 工期：360日历天',
      projectName: '丰乐镇建设项目',
      strategy: villageMunicipalStrategy,
    });
    const outline = buildBlueprintOutline({ chapterTitles: ['编制说明与工程概况'], boq, docType: '单位工程施工组织设计' });
    const card = renderBlueprintChapterAuthorityCard(outline.chapters[0]!, data);
    // 国家/地方性法规确定性清单不得注入（模型自写）
    expect(card).not.toContain('《中华人民共和国建筑法》');
    expect(card).not.toContain('《安徽省建筑市场管理条例》');
    expect(card).not.toContain('《合肥市城市绿化管理条例》');
    // 写作要求提示必须注入
    expect(card).toContain('由写作模型自行列写');
    expect(card).toContain('不得空写');
  });

  it('extractLocationFromFacts：建设地点提取（地方性法规匹配输入）', () => {
    expect(extractLocationFromFacts('项目名称：某项目 建设地点：安徽省合肥市肥西县 工期：90日历天')).toBe('安徽省合肥市肥西县');
    expect(extractLocationFromFacts('建设地点： 上海市浦东新区\n工期：30天')).toBe('上海市浦东新区');
    expect(extractLocationFromFacts('无地点事实')).toBe('');
  });
});

describe('L2 计划推导（确定性区间，不硬锁具体值）', () => {
  it('劳动力：峰值区间表达（min ≤ max），唯一口径峰值 = 区间中值收敛', () => {
    const labor = deriveLaborFromBoq(parseFixture(), 360, [], villageMunicipalStrategy);
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

  it('劳动力工种构成：合计恒等于峰值（写作层工种表唯一口径，不得自设构成）', () => {
    const labor = deriveLaborFromBoq(parseFixture(), 360, [], villageMunicipalStrategy);
    expect(labor.composition.length).toBeGreaterThan(0);
    const sum = labor.composition.reduce((acc, item) => acc + item.count, 0);
    expect(sum).toBe(labor.peakValue);
    for (const item of labor.composition) {
      expect(item.count).toBeGreaterThanOrEqual(1);
      expect(item.basis).toContain('唯一口径');
    }
  });

  it('劳动力分阶段投入：各阶段同时在场人数 ≤ 峰值；无工效条目阶段不产出（缺口显式化，不兜底不编造）', () => {
    const labor = deriveLaborFromBoq(parseFixture(), 360, [], villageMunicipalStrategy);
    expect(labor.byPhase.length).toBeGreaterThan(0);
    for (const item of labor.byPhase) {
      const mid = Math.round(((item.min ?? 0) + (item.max ?? item.min ?? 0)) / 2);
      expect(mid).toBeLessThanOrEqual(labor.peakValue); // 阶段人数不得超峰值
      expect((item.max ?? 0)).toBeLessThanOrEqual(labor.peakValue);
    }
    // 亮化分部无工效可推导条目 → 该阶段不产出（不编造人数）
    expect(labor.byPhase.some(item => item.phase.includes('亮化'))).toBe(false);
    const { data, diagnostics } = buildBlueprintData({
      boq: parseFixture(),
      basicFacts: '项目名称：马老郢村建设项目 计划工期：360日历天 质量标准：合格',
      projectName: '马老郢村建设项目',
      strategy: villageMunicipalStrategy,
    });
    // 本项目清单无亮化分部条目 → 该策略阶段整体不产出（不再发 2 天假工期），
    // 也不得报「分阶段劳动力缺…」——那是把「本项目没有的分部」误报成「劳动力资料不足」
    //（丰乐镇实测假告警：清单 904 条目中无任何亮化条目，却报劳动力行缺失）。
    expect(data.milestones.some(item => item.label.includes('亮化'))).toBe(false);
    expect(diagnostics.warnings.some(warning => warning.includes('分阶段劳动力缺「亮化与收尾工程」行'))).toBe(false);
    // 缺口仍显式暴露：改述为「策略阶段未命中清单，本阶段不产出」，并指向两个可查端点
    expect(diagnostics.warnings.some(warning => warning.includes('策略阶段未命中清单') && warning.includes('亮化与收尾工程'))).toBe(true);
    // 实际产出的阶段里，最后一个必须与劳动力分阶段行对齐（核对对象是产出而非策略模板）
    const tail = data.milestones[data.milestones.length - 1];
    expect(tail).toBeDefined();
    expect(labor.byPhase.some(item => item.phase === tail!.label)).toBe(true);
  });

  it('劳动力阶段封顶：推导超峰值的阶段收敛到峰值（丰乐镇景观绿化 1119 人荒谬值根因）', () => {
    const chunks: BoqChunkRow[] = [{
      chunkIndex: 0,
      sectionTitle: '表格数据',
      content: [
        '工程名称：马老郢等 标段： 工作表：1.1 第1页 共1页',
        '| 序号 | 项目编码 | COL3 | 项目名称 | 项目特征描述 | 计量单位 | COL7 | 工程量 | 金额 |',
        '|  | 三 |  | 绿化工程 |',
        '| 1 | 050102001001 |  | 绿化养护 | 1．养护等级：二级养护两年 | m2 |  | 5000000 |',
        '第1页 共1页',
      ].join('\n'),
    }];
    const boq = parseBillOfQuantities({ chunks, sourceFile: '清单.xls' });
    const labor = deriveLaborFromBoq(boq, 360, [], villageMunicipalStrategy);
    const landscape = labor.byPhase.find(item => item.phase.includes('景观'));
    expect(landscape).toBeDefined();
    expect(landscape!.max).toBe(labor.peakValue); // 封顶后阶段上限 = 峰值
    expect(landscape!.min).toBe(labor.peakValue);
  });

  it('里程碑：分部工程量权重分配，总和 ≤ 总工期', () => {
    const milestones = deriveMilestonesFromBoq(parseFixture(), 360, villageMunicipalStrategy);
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
    const { data } = buildBlueprintData({ boq, basicFacts: '项目名称：丰乐镇建设项目 工期：360日历天 质量标准：合格 计价依据：合造价〔2018〕13号文', projectName: '丰乐镇建设项目', strategy: villageMunicipalStrategy });
    const outline = buildBlueprintOutline({ chapterTitles: FULL_CHAPTER_TITLES, boq, docType: '单位工程施工组织设计' });
    const blueprint = {
      meta: { version: '2.0.0', docType: '单位工程施工组织设计', createdAt: '2026-09-06', sourceMaterials: ['丰乐镇工程量清单.xls'] },
      data,
      outline,
      validation: { passed: false, checks: [] as Array<{ name: string; passed: boolean; message: string }> },
      diagnostics: {
        stage: '阶段 D', laborDerivationBasis: '', llmCalls: 0, fallbackUsed: [], warnings: [], durationMs: 0,
      },
    };
    return { blueprint, boq };
  }

  it('全链路通过：四道阻断校验 + 规格承接审计（第 5 道恒 passed）', () => {
    const { blueprint, boq } = buildValidatedBlueprint();
    const report = validateBlueprint(blueprint, boq);
    expect(report.passed).toBe(true);
    expect(report.checks.map(check => check.name)).toEqual([
      // G 线 P0-6 新增第 0 道：清单源可用性（清单不可用即判失败，不以空参数桶冒充可用）
      '0. 清单源可用性',
      '1. Schema 校验',
      '2. 事实锚定校验',
      '3. 覆盖校验',
      '4. 内部一致性校验',
      '5. 标书编制规格承接',
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

  it('buildIntegratedBlueprint 清单解析失败 → 蓝图仍构建，但校验明确失败（P0-6：不以空参数桶冒充可用）', () => {
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
    // G 线 P0-6：清单不可用 → 蓝图校验**明确失败**。此前该路径产出「schema 合法、四项校验全绿、
    // authorityAvailability 全 true」的零权威骨架蓝图，下游据此认为权威齐备（blueprintActive=true），
    // 写作层拿不到任何权威值、正文数值只能由模型自产，而用户看不到任何缺口信号。
    expect(blueprint.validation.checks).toHaveLength(6);
    expect(blueprint.validation.passed).toBe(false);
    const boqCheck = blueprint.validation.checks.find(check => check.name === '0. 清单源可用性');
    expect(boqCheck?.passed).toBe(false);
    expect(String(boqCheck?.message)).toContain('工程量清单缺失');
  });

  // fallbackWorkPackagesFromExisting 已删除：休眠死代码（无生产调用点），且其为 `catch → []`
  // 的静默回退形态，与「失败必须显性」口径冲突。此处不再保留其用例。
});

describe('物资计划规格提取（材料型号规格是清单事实数据，丰乐镇材料表编造根因）', () => {
  it('清单条目明确的规格参数确定性提取（强度等级/管径/功率/厚度），无规格条目不编造', () => {
    const chunks: BoqChunkRow[] = [{
      chunkIndex: 0,
      sectionTitle: '表格数据',
      content: [
        '工程名称：马老郢等 标段： 工作表：1.1 第1页 共1页',
        '| 序号 | 项目编码 | COL3 | 项目名称 | 项目特征描述 | 计量单位 | COL7 | 工程量 | 金额 |',
        '| 1 | 040801001001 |  | 混凝土管道DN200 | 1．规格：DN200 2．垫层：C20商品混凝土定型基础 | m |  | 50 |',
        '| 2 | 040202001001 |  | 级配碎石垫层 | 1．厚度：10cm | m2 |  | 120 |',
        '| 3 | 040805001001 |  | LED路灯 | 1．功率：60W 2．灯杆高度：6m | 套 |  | 83 |',
        '| 4 | 011201001001 |  | 仿木护栏 | 1．预制混凝土仿木护栏 | m |  | 105 |',
        '第1页 共1页',
      ].join('\n'),
    }];
    const boq = parseBillOfQuantities({ chunks, sourceFile: '清单.xls' });
    const plan = deriveMaterialsPlanFromBoq(boq);
    const pipe = plan.find(item => item.name.includes('DN200'));
    expect(pipe?.spec).toContain('DN200');
    expect(pipe?.spec).toContain('C20');
    const gravel = plan.find(item => item.name.includes('级配碎石'));
    expect(gravel?.spec).toContain('10cm'); // 厚度：10cm
    const light = plan.find(item => item.name.includes('LED路灯'));
    expect(light?.spec).toContain('60W');
    const rail = plan.find(item => item.name.includes('仿木护栏'));
    expect(rail?.spec).toBeUndefined(); // 无规格条目不得编造
  });

  it('参数桶物资计划行携带规格：名称（规格）数量单位', () => {
    const boq = parseFixture();
    const { data } = buildBlueprintData({ boq, basicFacts: '项目名称：丰乐镇建设项目 工期：360日历天 质量标准：合格', projectName: '丰乐镇建设项目', strategy: villageMunicipalStrategy });
    const text = renderBlueprintDataText(data);
    const materialLine = text.split('\n').find(line => line.includes('物资计划'))!;
    expect(materialLine).toBeDefined();
    expect(materialLine).toContain('混凝土管道DN200（C20 DN200）');
  });
});

describe('工作包参数提取（清单特征留白不进入参数管线，舒城第二轮实测根因）', () => {
  const buildEntry = (description: string): BoqEntry => ({
    seq: 1,
    code: '011701003001',
    name: '建筑垂直运输',
    description,
    unit: 'm2',
    quantity: 975.95,
    section: '土石方工程',
    subsection: '',
    villageGroup: '舒城',
    sourceFile: '舒城工程量清单.xls',
    chunkIndex: 0,
    sourceKind: 'markdown',
  });

  it('「檐口高度、层数：详见图纸」留白值跳过，真实参数保留', () => {
    const workPackage = buildWorkPackageFromBoqSection('土石方工程', [
      buildEntry('1．建筑物檐口高度、层数：详见图纸\n2．运距：1km'),
    ]);
    expect(workPackage.params.some(param => /图纸/u.test(param.value))).toBe(false);
    expect(workPackage.params).toContainEqual({ key: '运距', value: '1km', source: 'boq' });
  });

  it('「详见设计图纸/按图纸/详见施工图纸」变体同样跳过，其余条款不受影响', () => {
    const workPackage = buildWorkPackageFromBoqSection('土石方工程', [
      buildEntry('1．基础做法：详见设计图纸\n2．边坡：按图纸\n3．长度：详见施工图纸\n4．土壤类别：三类土'),
    ]);
    expect(workPackage.params).toEqual([{ key: '土壤类别', value: '三类土', source: 'boq' }]);
  });

  it('含留白的做法条款不进入做法短语（避免留白照抄进正文）', () => {
    const workPackage = buildWorkPackageFromBoqSection('土石方工程', [
      buildEntry('1．做法：人机配合下管，详见图纸\n2．压实度：≥93%'),
    ]);
    expect(workPackage.methods.some(item => /图纸/u.test(item))).toBe(false);
    expect(workPackage.acceptance).toContain('≥93%');
  });
});

describe('渲染函数（执行层输入）', () => {
  it('参数桶渲染：金额类红线事实只进「商务禁区」行，不进正文口径行', () => {
    const boq = parseFixture();
    const { data } = buildBlueprintData({ boq, basicFacts: '项目名称：丰乐镇建设项目 工期：360日历天 质量标准：合格', projectName: '丰乐镇建设项目', strategy: villageMunicipalStrategy });
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

  it('章切片头部注入写作三源规则（与全局提示词共用同一份模板）', () => {
    const boq = parseFixture();
    const outline = buildBlueprintOutline({ chapterTitles: ['主要分部分项工 程施工方案'], boq, docType: '单位工程施工组织设计' });
    const slice = renderBlueprintChapterSlice(outline.chapters[0]!);
    expect(slice).toContain('【写作三源规则】');
    expect(slice).toContain('D·系统推导源');
    expect(slice).toContain('三源之外一律不得写入');
    // 三源规则紧随切片头部声明、先于小节正文（章切片最先注入的强约束）
    expect(slice.indexOf('蓝图切片')).toBeLessThan(slice.indexOf('【写作三源规则】'));
    expect(slice.indexOf('【写作三源规则】')).toBeLessThan(slice.indexOf('\n## '));
  });

  it('块级切片：章域锚点卡超封顶不被截断（编制依据法规清单必达写作层）', () => {
    const boq = parseFixture();
    const { data } = buildBlueprintData({ boq, basicFacts: '项目名称：丰乐镇建设项目 工期：360日历天 质量标准：合格', projectName: '丰乐镇建设项目', strategy: villageMunicipalStrategy });
    // 制造超长锚点卡（4.43 实测：工程概况章卡 10320 字符 > 6000 封顶，编制依据清单随卡末尾被截掉）
    for (let index = 0; index < 300; index += 1) {
      data.quantities[`测试分项工程量条目${index}`] = { value: 1000 + index, unit: 'm3' };
    }
    data.basisRegulations = ['《中华人民共和国招标投标法》', '《中华人民共和国建筑法》'];
    const chapter = { id: '1', title: '工程概况', isActive: true, requiredParams: [], subSections: [] };
    const slice = renderBlueprintBlockSlice(chapter, data, { blockTitle: '编制基准', subPointTitles: ['编制依据'] });
    expect(slice.length).toBeGreaterThan(6000);
    expect(slice).toContain('中华人民共和国招标投标法');
    expect(slice).toContain('编制依据小节必须列出法规名称及文号');
    expect(slice).not.toContain('已截断');
  });

  it('块级切片：工作包展开段超封顶按行截断加提示，恒定段完整保留', () => {
    const boq = parseFixture();
    const { data } = buildBlueprintData({ boq, basicFacts: '项目名称：丰乐镇建设项目 工期：360日历天 质量标准：合格', projectName: '丰乐镇建设项目', strategy: villageMunicipalStrategy });
    const subSections = Array.from({ length: 100 }, (_, index) => ({
      id: `2.${index + 1}`,
      title: `分部工程${index + 1}`,
      requiredParams: [],
      tablePlans: [],
      workPackages: [{
        name: `工作包${index + 1}`,
        kind: 'major' as const,
        quantities: { [`子项${index + 1}`]: { value: 100 + index, unit: 'm3' } },
        processChain: ['工序A', '工序B'],
        methods: ['清单特征原文做法'],
        params: [],
        acceptance: [],
        standards: [],
        source: 'boq' as const,
        coveredSeqs: [],
      }],
    }));
    const chapter = { id: '2', title: '主要施工方法', isActive: true, requiredParams: [], subSections };
    const slice = renderBlueprintBlockSlice(chapter, data, { blockTitle: '工作包', subPointTitles: ['工作包'] });
    expect(slice).toContain('已截断');
    expect(slice).toContain('【写作三源规则】');
  });

  it('施工方法章小节构建：单位工程（公厕）聚合子分部为子工作包，不再平铺独立小节', () => {
    const chunks: BoqChunkRow[] = [
      {
        chunkIndex: 0,
        sectionTitle: '表格数据',
        content: [
          '工程名称：马老郢等 标段： 工作表：1.1 第1页 共1页',
          '| 序号 | 项目编码 | COL3 | 项目名称 | 项目特征描述 | 计量单位 | COL7 | 工程量 | 金额 |',
          '|  | 一 |  | 道路工程 |',
          '| 1 | 040101001001 |  | 挖一般土方 | 1．土壤类别：综合类 | m3 |  | 100 |',
          '|  | 2.3 |  | 公厕 |',
          '|  | 0101 |  | 土石方工程 |',
          '| 2 | 010101001001 |  | 平整场地 | 1．部位：公厕基础 | m2 |  | 120 |',
          '|  | 0104 |  | 砌筑工程 |',
          '| 3 | 010401001001 |  | 砖基础 | 1．砖品种：MU10 | m3 |  | 30 |',
          '|  | 八 |  | 其他 |',
          '| 4 | 011201001001 |  | 墙面彩绘 | 1．原墙面水泥砂浆层铲除 | m2 |  | 40 |',
          '| 5 | 040205012002 |  | 仿木护栏 | 1．预制混凝土仿木护栏 | m |  | 105 |',
          '第1页 共1页',
        ].join('\n'),
      },
    ];
    const boq = parseBillOfQuantities({ chunks, sourceFile: '清单.xls' });
    const outline = buildBlueprintOutline({ chapterTitles: ['主要分部分项工程施工方案'], boq, docType: '单位工程施工组织设计' });
    const chapter = outline.chapters[0]!;
    // 小节 = 道路工程 + 公厕工程（单位工程聚合）+ 环境整治工程（「其他」更名），不再出现「土石方工程」等独立小节
    expect(chapter.subSections.map(section => section.title)).toEqual(['道路工程', '公厕', '环境整治工程']);
    const toilet = chapter.subSections.find(section => section.title === '公厕');
    expect(toilet?.workPackages.map(workPackage => workPackage.name)).toEqual(['土石方工程', '砌筑工程']);
    // 子工作包 coveredSeqs 记录各自条目
    const earthwork = toilet?.workPackages.find(workPackage => workPackage.name === '土石方工程');
    expect(earthwork?.coveredSeqs).toEqual([2]);
    const masonry = toilet?.workPackages.find(workPackage => workPackage.name === '砌筑工程');
    expect(masonry?.coveredSeqs).toEqual([3]);
    const env = chapter.subSections.find(section => section.title === '环境整治工程');
    expect(env?.workPackages[0]?.coveredSeqs).toEqual([4, 5]);
  });

  it('施工方法章子分部名规范化：措施项目/其他装饰工程/墙柱面装饰（round-27 清单计量口径名不进大纲）', () => {
    const chunks: BoqChunkRow[] = [
      {
        chunkIndex: 0,
        sectionTitle: '表格数据',
        content: [
          '工程名称：马老郢等 标段： 工作表：1.1 第1页 共1页',
          '| 序号 | 项目编码 | COL3 | 项目名称 | 项目特征描述 | 计量单位 | COL7 | 工程量 | 金额 |',
          '|  | 2.3 |  | 公厕 |',
          '|  | 0117 |  | 措施项目 |',
          '| 1 | 011701002001 |  | 外脚手架 | 1．搭设部位：外墙 | m2 |  | 122 |',
          '| 2 | 011703001001 |  | 整体化粪池 | 1．成品玻璃钢 | 座 |  | 2 |',
          '|  | 0114 |  | 其他装饰工程 |',
          '| 3 | 011406002001 |  | 洗漱台 | 1．大理石 | m2 |  | 0.56 |',
          '|  | 0112 |  | 墙、柱面装饰与隔断、幕墙工程 |',
          '| 4 | 011203001001 |  | 零星墙面抹灰 | 1．部位：内墙 | m2 |  | 53 |',
          '第1页 共1页',
        ].join('\n'),
      },
    ];
    const boq = parseBillOfQuantities({ chunks, sourceFile: '清单.xls' });
    const outline = buildBlueprintOutline({ chapterTitles: ['主要分部分项工程施工方案'], boq, docType: '单位工程施工组织设计' });
    const chapter = outline.chapters[0]!;
    const toilet = chapter.subSections.find(section => section.title === '公厕');
    expect(toilet?.workPackages.map(workPackage => workPackage.name)).toEqual(['模板、脚手架及化粪池安装工程', '零星装饰工程', '墙柱面装饰工程']);
  });

  it('施工方法章小节更名后覆盖校验仍通过（seq 全集判定不受小节名影响）', () => {
    const chunks: BoqChunkRow[] = [
      {
        chunkIndex: 0,
        sectionTitle: '表格数据',
        content: [
          '工程名称：马老郢等 标段： 工作表：1.1 第1页 共1页',
          '| 序号 | 项目编码 | COL3 | 项目名称 | 项目特征描述 | 计量单位 | COL7 | 工程量 | 金额 |',
          '|  | 八 |  | 其他 |',
          '| 1 | 011201001001 |  | 墙面彩绘 | 1．原墙面水泥砂浆层铲除 | m2 |  | 40 |',
          '第1页 共1页',
        ].join('\n'),
      },
    ];
    const boq = parseBillOfQuantities({ chunks, sourceFile: '清单.xls' });
    const { data } = buildBlueprintData({ boq, basicFacts: '项目名称：丰乐镇建设项目 工期：360日历天', projectName: '丰乐镇建设项目', strategy: villageMunicipalStrategy });
    const outline = buildBlueprintOutline({
      chapterTitles: ['主要分部分项工程施工方案', '物资与机械劳动力配置计划', '质量保证措施', '安全保证措施', '工期保证措施', '文明施工与环境保护', '施工总平面布置', '重难点分析及保证措施'],
      boq,
      docType: '单位工程施工组织设计',
    });
    const blueprint = {
      meta: { version: '2.0.0', docType: '单位工程施工组织设计', createdAt: '2026-09-06', sourceMaterials: [] },
      data,
      outline,
      validation: { passed: false, checks: [] },
      diagnostics: { stage: '阶段 D', laborDerivationBasis: '', llmCalls: 0, fallbackUsed: [], warnings: [], durationMs: 0 },
    };
    const report = validateBlueprint(blueprint, boq);
    const coverage = report.checks.find(check => check.name === '3. 覆盖校验');
    expect(coverage?.passed).toBe(true);
  });
});

describe('二期蓝图接管（执行层切换）', () => {
  function buildChapterSliceWithData() {
    const boq = parseFixture();
    const { data } = buildBlueprintData({ boq, basicFacts: '项目名称：丰乐镇建设项目 工期：360日历天 质量标准：合格', projectName: '丰乐镇建设项目', strategy: villageMunicipalStrategy });
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

  it('蓝图引用对齐：must_cite+strict 窄语境数值不一致时确定性回填（总工期）；工程量不写时直替', () => {
    const { chapter, data } = buildChapterSliceWithData();
    const markdown = '## 主要分部分项工程施工方案\n\n### 排水工程\n\n混凝土管道DN200 总长 2400m，采用人机配合下管。\n\n本项目总工期为 300 日历天。';
    const aligned = alignChapterContentToBlueprint(markdown, chapter, data);
    // 工程量引用不在写时直替（名称后首个「数值+单位」无法区分工程量/检测频次/分工程明细，
    // 实测频次被改破坏）——不一致引用交 S5 判定链统一裁决
    expect(aligned.markdown).toContain('混凝土管道DN200 总长 2400m');
    expect(aligned.markdown).toContain('总工期为 360 日历天');
    expect(aligned.fixed).toEqual([
      expect.objectContaining({ anchor: '总工期', from: '300天', to: '360天' }),
    ]);
  });

  it('蓝图引用对齐：工程量引用不做写时直替（DN200 规格数字与正文原样保留）', () => {
    const { chapter, data } = buildChapterSliceWithData();
    const markdown = '混凝土管道DN200 长度 50m。';
    const aligned = alignChapterContentToBlueprint(markdown, chapter, data);
    expect(aligned.markdown).toBe(markdown);
    expect(aligned.fixed).toHaveLength(0);
  });

  it('蓝图引用对齐：正文未引用窄语境 must_cite 数值 → missing 缺口报告（工程量已退出写时对齐）', () => {
    const { chapter, data } = buildChapterSliceWithData();
    const markdown = '### 道路工程\n\n村庄道路施工有序推进。';
    const aligned = alignChapterContentToBlueprint(markdown, chapter, data);
    expect(aligned.fixed).toHaveLength(0);
    expect(aligned.missing).toContain('总工期 360 日历天');
    expect(aligned.missing.some(item => item.includes('混凝土管道DN200'))).toBe(false);
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
    return buildBlueprintData({ boq, basicFacts: '项目名称：丰乐镇建设项目 工期：360日历天 质量标准：合格', projectName: '丰乐镇建设项目', strategy: villageMunicipalStrategy }).data;
  }

  it('修复权威派生（V5 P4）：里程碑→节点工期权威、设备实体词→锚点 key 台数（区间取中值）', () => {
    const data = buildData();
    data.milestones = [{ key: 'm1', label: '管网施工完成', duration: 45, basis: '清单分部分项' }];
    data.resources.equipment = [
      { name: '塔式起重机', min: 1, max: 2, basis: '区间口径' },
      { name: '钢筋弯曲机', quantity: 3, basis: '区间口径' },
      { name: '挖掘机', min: 2, max: 3, basis: '区间口径' },
    ];
    const plan = deriveRepairAuthorities(buildAuthorityIndex(data));
    expect(plan.nodeAuthorities).toEqual([{ node: '管网施工完成', offset: '第45日' }]);
    expect(plan.crossSectionAuthorities.towerCrane).toBe(2); // round((1+2)/2)
    expect(plan.crossSectionAuthorities.rebarBender).toBe(3); // quantity 优先
    // V5：实体词自动对接（20 个锚点实体词表），挖掘机不再依赖 key 白名单——自动获得修复通道
    expect(plan.crossSectionAuthorities.excavator).toBe(3); // round((2+3)/2)
  });

  it('buildChapterStructureFromBlueprint：蓝图章切片 → 每 sub_section 一个主题块、工作包为 H4 要点', () => {
    const boq = parseFixture();
    const outline = buildBlueprintOutline({ chapterTitles: ['主要分部分项工程施工方案'], boq, docType: '单位工程施工组织设计' });
    const chapter = outline.chapters[0]!;
    const structure = buildChapterStructureFromBlueprint({ blueprintChapter: chapter, inputSections: ['道路工程', '排水工程', '绿化工程'], chapterTitle: '主要分部分项工程施工方案', targetWords: 6000 });
    expect(structure.blocks.length).toBeGreaterThanOrEqual(chapter.subSections.length);
    expect(structure.blocks.flatMap(block => block.subPoints).map(point => point.title)).toContain('道路工程');
    // 容量规划守恒：Σ块预算 = 章目标（块预算一次成型，写作层无事后分配）；单块不超输出安全区
    expect(structure.blocks.reduce((sum, block) => sum + block.targetWords, 0)).toBe(6000);
    expect(structure.blocks.every(block => block.targetWords > 0 && block.targetWords <= 4500)).toBe(true);
    // 点配额下发：每个 H4 要点带 quotaWords（指令层详略），写作提示词按此展开
    expect(structure.blocks.flatMap(block => block.subPoints).every(point => (point.quotaWords ?? 0) > 0)).toBe(true);
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
    // 容量规划：容器块骨架展开与预算缩放同源（350 字/包），超安全区时规划层按要点拆块（共享父块标题）
    const containerPoints = structure.blocks.filter(block => block.title === '项目主要施工内容').flatMap(block => block.subPoints.map(point => point.title));
    expect(containerPoints).toEqual(expect.arrayContaining(['道路工程', '排水工程', '绿化工程']));
    expect(structure.blocks.reduce((sum, block) => sum + block.targetWords, 0)).toBe(8000);
    expect(structure.blocks.every(block => block.targetWords <= 4500)).toBe(true);
  });

  it('4.19.5 回归：分部章容器块不展开任何骨架名（保持单要点总述块，含中文编号形态骨架名）', () => {
    const structure = buildChapterStructureFromBlueprint({
      blueprintChapter: { id: '2', title: '主要施工方法', isActive: true, requiredParams: [], subSections: [{ id: '2.5', title: '绿化工程', requiredParams: [], tablePlans: [], workPackages: [{ name: '绿化工程', kind: 'major', quantities: {}, processChain: [], methods: [], params: [], acceptance: [], standards: [], source: 'boq', coveredSeqs: [] }] }] },
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

  it('容量规划：单块预算超输出安全区时规划层按要点拆块（守恒、无不可写预算）', () => {
    // 2 个域块各 3 个要点、章目标 12000：初始每块预算 6000 > 4500 → 规划层拆到每块 ≤4500，
    // Σ块预算仍 = 章目标（写作层收到的即最终结构，无事后拆半）
    const structure = buildChapterStructureFromBlueprint({
      blueprintChapter: undefined,
      inputSections: ['安全管理措施', '危大作业管控', '应急响应预案', '质量验收标准', '实测实量要求', '隐蔽验收规定'],
      chapterTitle: '安全质量保证措施',
      targetWords: 12000,
    });
    expect(structure.blocks.reduce((sum, block) => sum + block.targetWords, 0)).toBe(12000);
    expect(structure.blocks.every(block => block.targetWords <= 4500)).toBe(true);
    expect(structure.blocks.every(block => block.targetWords > 0)).toBe(true);
  });

  it('4.35 归并密度封顶：相邻块合并超 6 要点强制分块（块数允许超块数上限、Σ 守恒）', () => {
    // 6 个 subSection 各 6 工作包 → 初始 6 块各 6 点；章目标 3600（块数上限 floor(3600/1800)=2）
    // 旧行为：归并按点数均衡（targetPerGroup=18）产出 2 块 18 点（每块 1800 字 → 每要点 100 字，
    // 骨架质检物理不可达）；新行为：6+6 > 6 强制分块——6 块全部独立保留，块数超上限由软下限
    //（floorValue=min(1800, 3600/6)=600）与 Σ 守恒收口吸收
    const workPackage = (name: string) => ({ name, kind: 'major' as const, quantities: {}, processChain: [], methods: [], params: [], acceptance: [], standards: [], source: 'boq' as const, coveredSeqs: [] });
    const subSections = Array.from({ length: 6 }, (_, sectionIndex) => ({
      id: `3.${sectionIndex + 1}`,
      title: `分部工程${sectionIndex + 1}`,
      requiredParams: [], tablePlans: [],
      workPackages: Array.from({ length: 6 }, (_, packageIndex) => workPackage(`工作包${sectionIndex + 1}-${packageIndex + 1}`)),
    }));
    const structure = buildChapterStructureFromBlueprint({ blueprintChapter: { id: '3', title: '施工方案', isActive: true, requiredParams: [], subSections }, inputSections: [], chapterTitle: '施工方案', targetWords: 3600 });
    expect(structure.blocks.length).toBe(6);
    // 密度封顶（≤6 要点/块）+ 超密度守卫（要点数 × 300 ≤ 块预算）双不变量
    expect(structure.blocks.every(block => block.subPoints.length <= 6)).toBe(true);
    expect(structure.blocks.every(block => block.subPoints.length <= Math.max(1, Math.floor(block.targetWords / 300)))).toBe(true);
    expect(structure.blocks.reduce((sum, block) => sum + block.targetWords, 0)).toBe(3600);
    // 工作包原名零丢失（归并/守卫合并均保留 sources）
    const carried = new Set(structure.blocks.flatMap(block => block.subPoints.flatMap(point => [point.title, ...point.sources])));
    for (let sectionIndex = 1; sectionIndex <= 6; sectionIndex += 1) {
      for (let packageIndex = 1; packageIndex <= 6; packageIndex += 1) expect(carried.has(`工作包${sectionIndex}-${packageIndex}`)).toBe(true);
    }
  });

  it('4.35 块内超密度守卫：超密度要点合并为 brief 概览点（sources 全量保留、配额下发）', () => {
    // 6 工作包 / 章目标 1500：块预算 1500 < 6×300 → 保留前 cap-1=4 个详写要点，
    // 其余 2 个合并为「其他分部分项工程施工要点」概览点（tier=brief，sources 全量保留——
    // 覆盖校验/清单外白名单不受影响；复用容器块降级模式，不引入新语义）
    const workPackage = (name: string) => ({ name, kind: 'major' as const, quantities: {}, processChain: [], methods: [], params: [], acceptance: [], standards: [], source: 'boq' as const, coveredSeqs: [] });
    const packageNames = ['土方开挖与回填', '基础垫层浇筑', '砌体砌筑', '钢筋制作安装', '混凝土浇筑', '模板支设'];
    const structure = buildChapterStructureFromBlueprint({
      blueprintChapter: { id: '4', title: '施工方案', isActive: true, requiredParams: [], subSections: [{ id: '4.1', title: '主体结构施工', requiredParams: [], tablePlans: [], workPackages: packageNames.map(workPackage) }] },
      inputSections: [],
      chapterTitle: '施工方案',
      targetWords: 1500,
    });
    expect(structure.blocks.length).toBe(1);
    const points = structure.blocks[0]!.subPoints;
    expect(points.length).toBe(5);
    expect(points.slice(0, 4).map(point => point.title)).toEqual(packageNames.slice(0, 4));
    expect(points[4]!.title).toBe('其他分部分项工程施工要点');
    expect(points[4]!.sources).toEqual(packageNames.slice(4));
    expect(points[4]!.tier).toBe('brief');
    // 配额随块预算下发（合并点也参与点配额分配）
    expect(points.every(point => (point.quotaWords ?? 0) > 0)).toBe(true);
    expect(structure.blocks.reduce((sum, block) => sum + block.targetWords, 0)).toBe(1500);
  });

  it('4.35 estimateChapterMinFeasibleWords：要点数 = 工作包数 + 未覆盖模板小节数，下限 = ceil(点数/6)×1800', () => {
    const workPackage = (name: string) => ({ name, kind: 'major' as const, quantities: {}, processChain: [], methods: [], params: [], acceptance: [], standards: [], source: 'boq' as const, coveredSeqs: [] });
    const blueprintChapter = {
      id: '2', title: '主要施工方法', isActive: true, requiredParams: [],
      subSections: Array.from({ length: 13 }, (_, sectionIndex) => ({
        id: `2.${sectionIndex + 1}`,
        title: sectionIndex === 0 ? '公共广场提升改造工程' : `分部工程${sectionIndex + 1}`,
        requiredParams: [], tablePlans: [],
        workPackages: Array.from({ length: sectionIndex < 5 ? 8 : 7 }, (_, packageIndex) => workPackage(`工作包${sectionIndex + 1}-${packageIndex + 1}`)),
      })),
    };
    // 舒城形态：96 工作包 + 7 个未被蓝图覆盖的模板小节 → 103 点 → ceil(103/6)=18 块 × 1800 = 32400
    const uncoveredSections = ['市政工程专项施工工艺', '工期保障专项安排', '质量通病防治措施', '安全风险分级管控', '扬尘噪声控制措施', '劳务实名制管理', '材料设备调配计划'];
    const estimate = estimateChapterMinFeasibleWords(blueprintChapter, uncoveredSections);
    expect(estimate.points).toBe(103);
    expect(estimate.minFeasibleWords).toBe(32400);
    // 被蓝图覆盖的模板小节（subSection 标题/工作包名 去空白互相包含）不计入未覆盖数
    expect(estimateChapterMinFeasibleWords(blueprintChapter, ['公共广场提升改造工程']).points).toBe(96);
    // 无蓝图切片：全模板小节近似；空输入下限 0
    expect(estimateChapterMinFeasibleWords(undefined, ['a', 'b', 'c']).points).toBe(3);
    expect(estimateChapterMinFeasibleWords(undefined, []).minFeasibleWords).toBe(0);
    expect(estimateChapterMinFeasibleWords(blueprintChapter, []).points).toBe(96);
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

  it('buildChapterStructureFromBlueprint：无切片 → 语义域分组确定性兜底', () => {
    const structure = buildChapterStructureFromBlueprint({ blueprintChapter: undefined, inputSections: ['安全管理措施', '安全生产责任制', '质量验收标准', '实测实量要求', '工期纠偏措施'], chapterTitle: '安全质量保证措施', targetWords: 5000 });
    expect(structure.blocks.length).toBeGreaterThanOrEqual(2); // 安全/质量/工期 至少三域
    expect(structure.blocks.flatMap(block => block.subPoints).map(point => point.title)).toEqual(expect.arrayContaining(['安全管理措施', '质量验收标准', '工期纠偏措施']));
    expect(structure.fallbackSections).toEqual([]);
  });

  it('C1 收敛回归：章节小节数 0/1/2/5/30 → 规划结构恒非空（空章节整章单块兜底）', () => {
    // sectionCount=0（模板细目被主题过滤全部剔除 + 无蓝图切片）：退化为整章单块结构，不再阻断
    const empty = buildChapterStructureFromBlueprint({ blueprintChapter: undefined, inputSections: [], chapterTitle: '工程概况', targetWords: 5000 });
    expect(empty.blocks.length).toBe(1);
    expect(empty.blocks[0].title).toBe('工程概况');
    expect(empty.blocks[0].subPoints).toEqual([]);
    // 块目标=整章目标（封顶单块输出安全区 2800 字——模型自然输出区间上沿，4.35 校准）——单块成稿预算覆盖整章
    expect(empty.blocks[0].targetWords).toBe(2800);
    // 空要点块（无可拆单元）恒为单块：容量拆分的颗粒度是 H4 要点
    expect(empty.blocks.length).toBe(1);
    // sectionCount=1：单小节归并为一个主题块
    const single = buildChapterStructureFromBlueprint({ blueprintChapter: undefined, inputSections: ['编制说明与工程概况'], chapterTitle: '工程概况', targetWords: 3000 });
    expect(single.blocks.length).toBeGreaterThanOrEqual(1);
    expect(single.blocks.flatMap(block => block.subPoints.map(point => point.title))).toEqual(expect.arrayContaining(['编制说明与工程概况']));
    expect(single.coveredSections).toEqual(['编制说明与工程概况']);
    expect(single.fallbackSections).toEqual([]);
    // sectionCount=2/5：语义域分组确定性覆盖全部小节
    for (const sections of [
      ['安全管理措施', '质量验收标准'],
      ['安全管理措施', '安全生产责任制', '质量验收标准', '实测实量要求', '工期纠偏措施'],
    ]) {
      const structure = buildChapterStructureFromBlueprint({ blueprintChapter: undefined, inputSections: sections, chapterTitle: '安全质量保证措施', targetWords: 6000 });
      expect(structure.blocks.length).toBeGreaterThanOrEqual(1);
      expect(structure.coveredSections).toEqual(expect.arrayContaining(sections));
      expect(structure.fallbackSections).toEqual([]);
    }
    // sectionCount=30：大章全量成块、块目标不越界（1800~4500）
    const many = Array.from({ length: 30 }, (_, index) => `质量控制点位检查与验收要求第${'一二三四五六七八九十'[index % 10]}类`);
    const large = buildChapterStructureFromBlueprint({ blueprintChapter: undefined, inputSections: many, chapterTitle: '施工管理措施', targetWords: 12000 });
    expect(large.blocks.length).toBeGreaterThanOrEqual(1);
    expect(large.blocks.every(block => block.targetWords >= 1800 && block.targetWords <= 4500)).toBe(true);
    expect(large.coveredSections.length).toBe(30);
  });

  it('blueprintCitationConsistencyIssues：工期/工程量与蓝图不一致 → error；红线事实缺失 → warning', async () => {
    const data = buildData();
    const wrongDays = await blueprintCitationConsistencyIssues('本项目总工期为 300 日历天。', data, { adjudicate: conflictAll });
    expect(wrongDays.some(issue => issue.level === 'error' && issue.message.includes('蓝图引用冲突'))).toBe(true);
    const wrongQuantity = await blueprintCitationConsistencyIssues('混凝土管道DN200 总长 240m。', data, { adjudicate: conflictAll });
    expect(wrongQuantity.some(issue => issue.level === 'error' && issue.message.includes('工程量'))).toBe(true);
    // 一致口径零 error 冲突（红线事实缺失仍产生 warning 缺口观测）
    const consistent = await blueprintCitationConsistencyIssues('本项目总工期为 360 日历天。', data, { adjudicate: conflictAll });
    expect(consistent.filter(issue => issue.level === 'error')).toEqual([]);
    // 非金额红线事实未体现 → warning（缺口观测不阻断）；金额类红线不参与
    const missing = await blueprintCitationConsistencyIssues('村庄道路施工有序推进。', data);
    expect(missing.some(issue => issue.level === 'warning' && issue.message.includes('蓝图红线事实缺口'))).toBe(true);
  });

  it('D1 分项计划工期：收集层零豁免入候选，判定层 consistent 放行；「总工期」错值判定 conflict 仍拦', async () => {
    const data = buildData();
    const planText = '亮化工程安排在道路铺装工程完成、路基与面层强度形成后进行，计划工期2天。';
    // 收集层（词表豁免全废）：分项计划工期同样入候选，语义裁决交判定层
    expect(collectBlueprintCitationCandidates(planText, data).candidates.some(candidate => candidate.kind === 'total-days' && candidate.value === 2)).toBe(true);
    const planDays = await blueprintCitationConsistencyIssues(planText, data, { adjudicate: consistentAll });
    expect(planDays.filter(issue => issue.level === 'error')).toEqual([]);
    // 「总工期/施工工期/合同工期」显式前缀句：判定层 conflict → 错值仍拦
    expect((await blueprintCitationConsistencyIssues('计划总工期为 120 天。', data, { adjudicate: conflictAll })).some(issue => issue.level === 'error' && issue.message.includes('蓝图引用冲突'))).toBe(true);
    expect((await blueprintCitationConsistencyIssues('本项目总工期为 300 天。', data, { adjudicate: conflictAll })).some(issue => issue.level === 'error' && issue.message.includes('蓝图引用冲突'))).toBe(true);
  });

  it('buildBlueprintDecisionLock：数据口径条目锁定总工期/劳动力峰值/自然村数量/核心工程量', () => {
    const boq = parseFixture();
    const labor = deriveLaborFromBoq(boq, 360, [], villageMunicipalStrategy);
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

  it('P2.3 蓝图引用一致性：正文村数与蓝图不符 → error，一致 → 零 error', async () => {
    const data = buildData();
    const wrong = await blueprintCitationConsistencyIssues('本项目涉及 9 个自然村，分散施工。', data, { adjudicate: conflictAll });
    expect(wrong.some(issue => issue.level === 'error' && issue.message.includes('自然村数量'))).toBe(true);
    const consistent = await blueprintCitationConsistencyIssues('本项目涉及 1 个自然村，村内流水施工。', data, { adjudicate: conflictAll });
    expect(consistent.filter(issue => issue.level === 'error')).toEqual([]);
    // 「自然村分组」为作业组织概念（非村数陈述）→ 收集层不入候选（概念边界），判定层零调用
    const scoped = await blueprintCitationConsistencyIssues('清单按 3 个自然村分组编制。', data, { adjudicate: conflictAll });
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

  it('修复权威派生：机动工期 = 总工期 − 里程碑总和，自然村数量取红线事实', () => {
    const boq = parseFixture();
    const { data } = buildBlueprintData({ boq, basicFacts: '项目名称：丰乐镇建设项目 工期：360日历天 质量标准：合格', projectName: '丰乐镇建设项目', strategy: villageMunicipalStrategy });
    const plan = deriveRepairAuthorities(buildAuthorityIndex(data));
    const milestoneSum = data.milestones.reduce((sum, item) => sum + (item.duration || 0), 0);
    expect(plan.crossSectionAuthorities.slackDays).toBe(360 - milestoneSum);
    expect(plan.crossSectionAuthorities.villageCount).toBe(1);
    expect(plan.codeAuthorities).toEqual({});
  });

  it('蓝图引用一致性：正文劳动力峰值与蓝图唯一口径不一致 → error，一致 → 零 error', async () => {
    const data = buildData();
    const wrong = await blueprintCitationConsistencyIssues(`劳动力峰值为 ${data.resources.labor.peakValue + 5} 人。`, data, { adjudicate: conflictAll });
    expect(wrong.some(issue => issue.level === 'error' && issue.message.includes('劳动力峰值'))).toBe(true);
    const consistent = await blueprintCitationConsistencyIssues(`本项目劳动力峰值为 ${data.resources.labor.peakValue} 人，各工种高峰期叠加控制在该峰值以内。`, data, { adjudicate: conflictAll });
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

  it('A4 参数桶渲染不泄漏区间端点：工种构成渲染单值人数、机械台数只渲染单值', () => {
    const boq = parseFixture();
    const { data } = buildBlueprintData({ boq, basicFacts: '项目名称：丰乐镇建设项目 工期：360日历天 质量标准：合格', projectName: '丰乐镇建设项目', strategy: villageMunicipalStrategy });
    const text = renderBlueprintDataText(data);
    const tradeLine = text.split('\n').find(line => line.includes('工种构成'))!;
    expect(tradeLine).toBeDefined();
    // 丰乐镇第 4 轮：工种构成行 = composition 归一化单值人数（合计恒等于峰值），不再只渲染名单
    expect(/[^\d]\d+\s*人/u.test(tradeLine.split('：')[1]!)).toBe(true); // 工种行含单值人数
    expect(/\d+\s*~\s*\d+\s*人/u.test(tradeLine)).toBe(false); // 人数不含区间端点
    expect(tradeLine).toContain(`合计=${data.resources.labor.peakValue} 人`);
    expect(tradeLine).not.toContain('不另设工种数值');
    const machineLine = text.split('\n').find(line => line.includes('主要机械'))!;
    expect(machineLine).toBeDefined();
    expect(/\d+\s*~\s*\d+\s*台/u.test(machineLine)).toBe(false); // 台数不含区间端点
    expect(/\d+\s*台/u.test(machineLine)).toBe(true); // 台数为单值口径
  });

  it('A4b 章锚点卡：劳动力章注入工种构成锚点，物资章注入主要材料锚点（含规格）', () => {
    const boq = parseFixture();
    const { data } = buildBlueprintData({ boq, basicFacts: '项目名称：丰乐镇建设项目 工期：360日历天 质量标准：合格', projectName: '丰乐镇建设项目', strategy: villageMunicipalStrategy });
    const outline = buildBlueprintOutline({ chapterTitles: ['劳动力、机械设备及主要材料资源配置计划'], boq, docType: '单位工程施工组织设计' });
    const card = renderBlueprintChapterAuthorityCard(outline.chapters[0]!, data);
    expect(card).toContain('工种构成（合计=');
    expect(card).toContain('主要材料（');
    expect(card).toContain('DN200');
  });

  it('A5 决策锁数据条目完备性硬检查：删掉 contract_days 锁条目 → 内部一致性校验失败（空壳锁根治）', () => {
    const boq = parseFixture();
    const { data } = buildBlueprintData({ boq, basicFacts: '项目名称：丰乐镇建设项目 工期：360日历天 质量标准：合格 计价依据：合造价〔2018〕13号文', projectName: '丰乐镇建设项目', strategy: villageMunicipalStrategy });
    const outline = buildBlueprintOutline({ chapterTitles: ['主要分部分项工程施工方案', '质量保证措施', '安全保证措施', '工期保证措施', '文明施工与环境保护', '施工总平面布置', '重难点分析及保证措施', '物资与机械劳动力配置计划'], boq, docType: '单位工程施工组织设计' });
    const blueprint = {
      meta: { version: '2.0.0', docType: '单位工程施工组织设计', createdAt: '2026-09-06', sourceMaterials: ['丰乐镇工程量清单.xls'] },
      data: { ...data, decisionLock: { entries: data.decisionLock.entries.filter(entry => entry.id !== 'contract_days') } },
      outline,
      validation: { passed: false, checks: [] as Array<{ name: string; passed: boolean; message: string }> },
      diagnostics: { stage: '阶段 D', laborDerivationBasis: '', llmCalls: 0, fallbackUsed: [], warnings: [], durationMs: 0 },
    };
    const report = validateBlueprint(blueprint, boq);
    const consistency = report.checks.find(check => check.name === '4. 内部一致性校验');
    expect(consistency?.passed).toBe(false);
    expect(consistency?.message).toContain('contract_days');
  });
});

describe('blueprintCitationVerdict：蓝图引用一致性（S5 语义判定版，词表豁免全废）', () => {
  function citationData() {
    const boq = parseFixture();
    const data = buildBlueprintData({ boq, basicFacts: '项目名称：丰乐镇建设项目 工期：90日历天 质量标准：合格', projectName: '丰乐镇建设项目', strategy: villageMunicipalStrategy }).data;
    data.contract.totalDays = 90;
    data.resources.labor.peakValue = 176;
    data.redLineFacts = [{ key: '自然村数量', value: '20个', source: '清单' }];
    data.quantities = {
      '塑料管铺设': { value: 8205.53, unit: 'm' },
      '挖一般土方': { value: 4187.38, unit: 'm³' },
      '回填方': { value: 4270, unit: 'm³' },
      '级配碎石': { value: 20931.02, unit: 'm²' },
      '水泥混凝土': { value: 20872.82, unit: 'm²' },
      '人行道板安砌': { value: 264.8, unit: 'm²' },
      '塑料检查井': { value: 555, unit: '座' },
      '立柱': { value: 2400, unit: 'mm' },
    };
    return data;
  }
  it('收集层：值 == 权威的引用不入候选（判定层零调用）', async () => {
    let calls = 0;
    const spy: CitationAdjudicator = async candidates => {
      calls += 1;
      return { records: recordsFor(candidates, 'conflict', 'spy 不应被调用') };
    };
    expect(await blueprintCitationConsistencyIssues('施工高峰期投入176人。', citationData(), { adjudicate: spy })).toEqual([]);
    expect(await blueprintCitationConsistencyIssues('本项目总工期为 90 日历天。', citationData(), { adjudicate: spy })).toEqual([]);
    expect(await blueprintCitationConsistencyIssues('本项目涉及 20 个自然村。', citationData(), { adjudicate: spy })).toEqual([]);
    expect(await blueprintCitationConsistencyIssues('塑料管铺设 8205.53m。', citationData(), { adjudicate: spy })).toEqual([]);
    expect(calls).toBe(0);
  });

  it('值窗口不跨名字取数（#29 根因）：短名被长词前缀误命中不产假候选（防把对改成错）', async () => {
    const data = citationData();
    data.quantities = { ...data.quantities, '塑料管': { value: 7525.01, unit: 'm' } };
    let calls = 0;
    const spy: CitationAdjudicator = async candidates => {
      calls += 1;
      return { records: recordsFor(candidates, 'conflict', 'spy 不应被调用') };
    };
    // 4.43 实测句：「塑料管材」中的「塑料管」被误命中为条目引用，旧 40 字窗口跨越真正条目名
    // 「塑料管铺设」取到 8205.53 → 假候选 subject=塑料管 value=8205.53 authority=7525.01 →
    // 判定误判 conflict → 修复器把正确值改成错误值
    const sentence = '塑料管材断供风险集中在DN200塑料管铺设8205.53m与DN110塑料管7525.01m。';
    expect(await blueprintCitationConsistencyIssues(sentence, data, { adjudicate: spy })).toEqual([]);
    expect(calls).toBe(0);
    // 对照：真引用不一致仍产候选（窗口截断不吞真候选）
    const candidates = collectBlueprintCitationCandidates('DN200塑料管铺设9100m与DN110塑料管7525.01m。', data).candidates;
    expect(candidates.some(candidate => candidate.subject === '塑料管铺设' && candidate.value === 9100)).toBe(true);
  });

  it('收集层零豁免：规格/分区/单体/子集句全部入候选；概念边界与单位右边界在结构层排除', () => {
    const data = citationData();
    // 规格句（原词表豁免形态）：「围墙立柱间距不大于1200mm」
    const spec = collectBlueprintCitationCandidates('围墙立柱间距不大于1200mm。', data).candidates;
    expect(spec.some(candidate => candidate.kind === 'quantity' && candidate.subject === '立柱' && candidate.value === 1200 && candidate.authority === 2400)).toBe(true);
    // 分区数学句（原数学豁免形态）：「每个片区包含4个自然村」
    const division = collectBlueprintCitationCandidates('项目部将20个自然村划分为5个施工片区，每个片区包含4个自然村。', data).candidates;
    expect(division.some(candidate => candidate.kind === 'village-count' && candidate.value === 4 && candidate.authority === 20)).toBe(true);
    // 村名/单体语境句（原语境豁免形态）：「塑料管铺设7.8m」
    const entity = collectBlueprintCitationCandidates('公厕室外管网工程包括整体化粪池2座、砌筑检查井2座、塑料管铺设7.8m。', data).candidates;
    expect(entity.some(candidate => candidate.kind === 'quantity' && candidate.subject === '塑料管铺设' && candidate.value === 7.8)).toBe(true);
    // 子集拆分句（原锚点求和豁免形态）：句内一致条目不入候选、不一致条目全部入候选
    const subset = collectBlueprintCitationCandidates('主要工程量包括塑料管铺设8205.53m、级配碎石480.5m²、水泥混凝土572.3m²。', data).candidates.map(candidate => candidate.subject);
    expect(subset).toHaveLength(2);
    expect(new Set(subset)).toEqual(new Set(['级配碎石', '水泥混凝土']));
    // 概念边界（结构定位非豁免）：「自然村分组」为作业组织概念，不入村数候选
    expect(collectBlueprintCitationCandidates('清单按 3 个自然村分组编制。', data).candidates).toEqual([]);
    // 单位右边界：「公厕塑料管铺设直径不小于10mm」的 m 子串不误匹配
    expect(collectBlueprintCitationCandidates('公厕塑料管铺设直径不小于10mm。', data).candidates).toEqual([]);
  });

  it('收集层括号形态：半/全角互配、省略形态与防抢占（路床检验 / 生态池 T/D 条目对）', async () => {
    const data = citationData();
    data.quantities = {
      ...data.quantities,
      '路床(槽)碾压检验': { value: 19930.52, unit: 'm²' },
      '1#生态池（2T/D)': { value: 5, unit: '座' },
      '1#生态池（3T/D)': { value: 5, unit: '座' },
      '喷播植草（灌木）籽': { value: 19400, unit: 'm²' },
    };
    const subjects = (text: string) => collectBlueprintCitationCandidates(text, data).candidates.map(item => `${item.subject} ${item.value}${item.unit}`);
    // 全角写法（蓝图半角括号）互配
    expect(subjects('路床（槽）碾压检验 18000m²。')).toContain('路床(槽)碾压检验 18000m²');
    // 省略形态（去括号写法）
    expect(subjects('路床碾压检验 18000m²。')).toContain('路床(槽)碾压检验 18000m²');
    expect(subjects('喷播植草灌木籽 15000m²。')).toContain('喷播植草（灌木）籽 15000m²');
    // 省略形态不抢占同前缀兄弟条目全名：「1#生态池」前缀不能占「1#生态池（3T/D)」位置
    const pool = collectBlueprintCitationCandidates('1#生态池（3T/D）共计4座。', data).candidates;
    expect(pool).toHaveLength(1);
    expect(pool[0]!.subject).toBe('1#生态池（3T/D)');
    // 一致引用（含全角/省略形态）不入候选
    expect(collectBlueprintCitationCandidates('路床（槽）碾压检验 19930.52m²。', data).candidates).toEqual([]);
    expect(collectBlueprintCitationCandidates('路床碾压检验 19930.52m²。', data).candidates).toEqual([]);
    // 锚点坐标用实际匹配长度（省略写法与名称字面长度不等）：起点切片仍为数值本体
    const verdict = await blueprintCitationVerdict('路床碾压检验 18000m²。', data, { adjudicate: conflictAll });
    expect(verdict.anchors).toHaveLength(1);
    expect(verdict.anchors[0]!.name).toBe('路床(槽)碾压检验');
    expect('路床碾压检验 18000m²。'.slice(verdict.anchors[0]!.start, verdict.anchors[0]!.end)).toBe('18000');
  });

  it('判定 conflict：峰值/工期/村数报 error，工程量冲突同产修复锚点（坐标直连修复器）', async () => {
    const data = citationData();
    const peak = await blueprintCitationVerdict('施工高峰期投入199人。', data, { adjudicate: conflictAll });
    expect(peak.issues.some(item => item.level === 'error' && item.message.includes('劳动力峰值 199'))).toBe(true);
    const days = await blueprintCitationVerdict('总工期为7日历天。', data, { adjudicate: conflictAll });
    expect(days.issues.some(item => item.level === 'error' && item.message.includes('工期表述 7 日历天'))).toBe(true);
    const village = await blueprintCitationVerdict('本项目涉及9个自然村。', data, { adjudicate: conflictAll });
    expect(village.issues.some(item => item.level === 'error' && item.message.includes('自然村数量 9 个'))).toBe(true);
    const markdown = '本分项工程量为塑料管铺设7.8m。';
    const verdict = await blueprintCitationVerdict(markdown, data, { adjudicate: conflictAll });
    expect(verdict.issues.some(item => item.level === 'error' && item.message.includes('工程量 塑料管铺设 7.8m'))).toBe(true);
    expect(verdict.anchors).toHaveLength(1);
    expect(verdict.anchors[0]!.name).toBe('塑料管铺设');
    expect(markdown.slice(verdict.anchors[0]!.start, verdict.anchors[0]!.end)).toBe('7.8');
    expect(verdict.anchors[0]!.authorityValue).toBe(8205.53);
    expect(verdict.summary).toMatchObject({ total: 1, conflicts: 1, consistent: 0, uncertain: 0 });
  });

  it('判定 consistent：规格/分区/单体/子集/阶段细分句全部放行；同批句子 conflict 判定下全部拦下（豁免由判定层裁决）', async () => {
    const data = citationData();
    const sentences = [
      '围墙立柱间距不大于1200mm。',
      '项目部将20个自然村划分为5个施工片区，每个片区包含4个自然村。',
      '公厕室外管网工程包括整体化粪池2座、砌筑检查井2座、塑料管铺设7.8m。',
      '主要工程量包括塑料管铺设8205.53m、级配碎石480.5m²、水泥混凝土572.3m²。',
      '总工期按施工准备与清杂拆除7天、管网施工30天、道路面层施工20天。',
    ];
    for (const sentence of sentences) {
      const soft = await blueprintCitationConsistencyIssues(sentence, data, { adjudicate: consistentAll });
      expect(soft.filter(issue => issue.level === 'error')).toEqual([]);
      const strict = await blueprintCitationConsistencyIssues(sentence, data, { adjudicate: conflictAll });
      expect(strict.some(issue => issue.level === 'error')).toBe(true);
    }
  });

  it('判定不可用：候选按未决显式暴露（warning），不回退词表猜测', async () => {
    const issues = await blueprintCitationConsistencyIssues('本分项工程量为塑料管铺设7.8m。', citationData(), { adjudicate: unavailableAll });
    expect(issues.some(item => item.level === 'warning' && item.message.includes('蓝图引用未决'))).toBe(true);
    expect(issues.some(item => item.level === 'warning' && item.message.includes('蓝图引用语义判定不可用'))).toBe(true);
    expect(issues.filter(item => item.level === 'error')).toEqual([]);
  });

  it('判定 conflict 逐条上报：不同名称全部报工程量冲突（判定位去重只按同名）', async () => {
    const markdown = '景观工程主要工程量包括挖一般土方146.93m³、级配碎石480.5m²、水泥混凝土572.3m²、人行道板安砌114.8m²。';
    const issues = await blueprintCitationConsistencyIssues(markdown, citationData(), { adjudicate: conflictAll });
    expect(issues.filter(item => item.message.includes('工程量')).length).toBe(4);
  });

  it('rebaseCitationAnchorsForChapters：全文锚点按章重定位为章内坐标（与章拼装同源的段间偏移）', async () => {
    const markdown = ['第一章正文。', '塑料管铺设7.8m。'].join('\n\n');
    const verdict = await blueprintCitationVerdict(markdown, citationData(), { adjudicate: conflictAll });
    const batches = rebaseCitationAnchorsForChapters(verdict.anchors, ['第一章正文。', '塑料管铺设7.8m。']);
    expect(batches[0]).toEqual([]);
    expect(batches[1]).toHaveLength(1);
    expect(batches[1]![0]!.start).toBe('塑料管铺设'.length);
    expect('塑料管铺设7.8m。'.slice(batches[1]![0]!.start, batches[1]![0]!.end)).toBe('7.8');
    expect(batches[1]![0]!.authorityValue).toBe(8205.53);
  });
});

describe('4.55.14 章级规划小节不得被吸收/归并（巢湖实测：OUTLINE 固定小节消失）', () => {
  // 蓝图章切片用既有 fixture 构造器产出（真实形态），避免手写字面量偏离类型定义
  const blueprintChapter = (() => {
    const outline = buildBlueprintOutline({ chapterTitles: ['主要施工方法与技术措施'], boq: parseFixture(), docType: '单位工程施工组织设计' });
    return outline.chapters[0]!;
  })();
  const inputSections = ['编制依据与说明', '工程概况', '现场踏勘', '主要施工内容', '施工部署', '劳动力材料机械设备配置'];

  it('锁定/章级小节各自独立成块（H3），顺序置于最前', () => {
    const structure = buildChapterStructureFromBlueprint({ blueprintChapter, inputSections, chapterTitle: '主要施工方法与技术措施', targetWords: 20000 });
    const titles = structure.blocks.map(block => block.title);
    for (const section of inputSections) {
      expect(titles.some(title => title.includes(section) || section.includes(title))).toBe(true);
    }
    expect(titles[0]).toContain('编制依据与说明');
  });

  it('容量归并（块数超上限）时章级小节块不被相邻块吸收（归并屏障）', () => {
    const structure = buildChapterStructureFromBlueprint({ blueprintChapter, inputSections, chapterTitle: '主要施工方法与技术措施', targetWords: 4000 });
    const titles = structure.blocks.map(block => block.title);
    for (const section of ['编制依据与说明', '工程概况', '现场踏勘']) {
      expect(titles.some(title => title.includes(section) || section.includes(title))).toBe(true);
    }
  });
});
