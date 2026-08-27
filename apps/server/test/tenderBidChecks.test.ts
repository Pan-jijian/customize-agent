import { describe, expect, it } from 'vitest';
import {
  VAGUE_RESPONSE_PHRASES,
  vagueResponseHits,
  fillerDensityReport,
  fiveElementBlockStats,
  extractKeyDifficultySection,
  difficultyCountermeasureReport,
  fourNewTechCheck,
  dangerousTwoStepCheck,
  emergencyStructureCheck,
  EMERGENCY_EIGHT_PARTS,
  EMERGENCY_COMMON_PLANS,
  greenBenchmarkCheck,
  GREEN_BENCHMARK_CHECKS,
  crossProjectResidueHits,
} from '../src/services/document-workflow/tenderBidChecks';
import { buildTenderBidTemplatingReport } from '../src/services/document-workflow/tenderBidScoring';

// 五要素齐全的闭合块：方案＋流程＋责任人＋时间节点＋验收标准（同块 ≥4 项即闭合）
const FIVE_ELEMENT_BLOCK = '项目经理每日组织质量巡查，严格执行质量管理制度，按巡查流程分步骤实施，发现偏差当场责令整改，由质检员复查确认后销项闭环，资料员归档台账备查。';
// 双达标重难点条目：归因＋量化控制目标
const ATTRIBUTED_ENTRY = '由于基坑临近既有地铁隧道，主要风险来源于地层变形，控制目标为地表沉降不超过8mm。';
// 无归因无量化条目
const GENERIC_ENTRY = '本工程重难点较多，需加强现场管理与组织协调工作，确保各环节有序推进。';

describe('vagueResponseHits（附录一第 3 类模糊应答词，零出现要求）', () => {
  it('命中明细含词与出现次数', () => {
    const hits = vagueResponseHits('施工方案基本满足招标要求，工程进度力争提前完成。');
    expect(hits.map(h => h.phrase)).toEqual(['基本满足', '力争']);
    expect(hits[0]?.count).toBe(1);
  });

  it('同一词多次出现正确计数', () => {
    const hits = vagueResponseHits('原则上按此执行，原则上不再变更，尽可能满足要求。');
    const principle = hits.find(h => h.phrase === '原则上');
    expect(principle?.count).toBe(2);
  });

  it('无模糊词返回空数组', () => {
    expect(vagueResponseHits('基坑开挖深度为7.5米，采用灌注桩加内支撑支护体系。')).toEqual([]);
  });

  it('词表全部为短语级，避免单字误伤', () => {
    expect(VAGUE_RESPONSE_PHRASES.every(phrase => phrase.length >= 2)).toBe(true);
  });
});

describe('fillerDensityReport（docx L23 模板化三档：≥40% 重度 / 20%-40% 中度 / <20% 轻度）', () => {
  const FILLER = '项目部精心组织施工资源调配，全力保障工程进度节点按期完成。';
  const NORMAL = '本工程基坑开挖深度为7.5米，采用灌注桩加内支撑支护体系。';

  it('套话占比 ≥40% 判重度', () => {
    const markdown = [FILLER, FILLER, FILLER, FILLER, NORMAL].join('\n');
    const report = fillerDensityReport(markdown);
    expect(report.ratio).toBeCloseTo(0.8);
    expect(report.level).toBe('heavy');
    expect(report.totalSentences).toBe(5);
  });

  it('20%-40% 判中度（含 20% 边界）', () => {
    const markdown = [FILLER, NORMAL, NORMAL, NORMAL, NORMAL].join('\n');
    const report = fillerDensityReport(markdown);
    expect(report.ratio).toBeCloseTo(0.2);
    expect(report.level).toBe('medium');
  });

  it('<20% 判轻度', () => {
    const markdown = [FILLER, NORMAL, NORMAL, NORMAL, NORMAL, NORMAL, NORMAL, NORMAL, NORMAL, NORMAL].join('\n');
    const report = fillerDensityReport(markdown);
    expect(report.ratio).toBeCloseTo(0.1);
    expect(report.level).toBe('light');
  });

  it('无正文句时 ratio 为 0 且判轻度', () => {
    const report = fillerDensityReport('');
    expect(report).toMatchObject({ totalSentences: 0, ratio: 0, level: 'light' });
  });

  it('通用模板句式（视情况而定）计入套话', () => {
    const markdown = '现场临时设施布置视情况而定，适当调整围挡范围，满足甲方管理要求。';
    const report = fillerDensityReport(markdown);
    expect(report.fillerSentences).toBe(1);
  });

  it('不足 12 字的短句不计入分母', () => {
    const report = fillerDensityReport('精心组织施工。');
    expect(report.totalSentences).toBe(0);
  });
});

describe('fiveElementBlockStats（docx L93 措施五要素闭合）', () => {
  it('五要素齐全块计入 completeBlocks', () => {
    const stats = fiveElementBlockStats(FIVE_ELEMENT_BLOCK);
    expect(stats.completeBlocks).toBe(1);
    expect(stats.incompleteBlocks).toBe(0);
  });

  it('缺责任人或时间节点的块计入 incompleteBlocks', () => {
    const noRole = '施工班组按巡查制度每日执行检查工作，发现问题责令整改并复查销项。';
    const stats = fiveElementBlockStats(noRole);
    expect(stats.completeBlocks).toBe(0);
    expect(stats.incompleteBlocks).toBe(1);
  });

  it('不足 30 字的块不计入统计', () => {
    const stats = fiveElementBlockStats('项目经理每日整改。');
    expect(stats.blocks).toBe(0);
  });

  it('多块混合统计正确', () => {
    const markdown = [FIVE_ELEMENT_BLOCK, '', '施工员负责现场施工与质量控制工作，并做好相关施工记录的整理。'].join('\n');
    const stats = fiveElementBlockStats(markdown);
    expect(stats.blocks).toBe(2);
    expect(stats.completeBlocks).toBe(1);
  });
});

describe('extractKeyDifficultySection / difficultyCountermeasureReport（docx L94/L156 重难点对策）', () => {
  const SECTION = `## 工程重难点分析\n\n${ATTRIBUTED_ENTRY}\n\n${ATTRIBUTED_ENTRY}\n\n${GENERIC_ENTRY}\n\n${GENERIC_ENTRY}\n\n${GENERIC_ENTRY}\n\n## 施工部署`;

  it('提取重难点标题段落到下一同级标题', () => {
    const section = extractKeyDifficultySection(SECTION);
    expect(section).toContain('由于基坑临近既有地铁隧道');
    expect(section).not.toContain('施工部署');
  });

  it('无重难点标题返回空串', () => {
    expect(extractKeyDifficultySection('# 编制说明\n\n无相关内容。')).toBe('');
  });

  it('归因＋量化双达标占比 <50% 判重度模板化', () => {
    const report = difficultyCountermeasureReport(SECTION);
    expect(report.countermeasures).toBe(5);
    expect(report.bothCount).toBe(2);
    expect(report.ratio).toBeCloseTo(0.4);
    expect(report.heavyTemplated).toBe(true);
  });

  it('双达标占比 ≥50% 不判重度模板化', () => {
    const markdown = `## 工程重难点分析\n\n${ATTRIBUTED_ENTRY}\n\n${ATTRIBUTED_ENTRY}\n\n${ATTRIBUTED_ENTRY}\n\n${GENERIC_ENTRY}\n\n${GENERIC_ENTRY}`;
    const report = difficultyCountermeasureReport(markdown);
    expect(report.ratio).toBeCloseTo(0.6);
    expect(report.heavyTemplated).toBe(false);
  });

  it('重难点章节为空时不判重度模板化', () => {
    const report = difficultyCountermeasureReport('# 编制说明\n\n无重难点章节。');
    expect(report.countermeasures).toBe(0);
    expect(report.heavyTemplated).toBe(false);
  });
});

describe('fourNewTechCheck（docx L77 三标尺满足任意两项）', () => {
  it('无四新技术时 effective 为 false', () => {
    expect(fourNewTechCheck('本工程采用常规施工工艺组织施工。').effective).toBe(false);
  });

  it('名称命中且三标尺满足两项判有效', () => {
    const markdown = '本工程采用BIM技术辅助施工管理，依据建筑业10项新技术要求，较传统做法显著缩短工期、降低损耗。';
    const report = fourNewTechCheck(markdown);
    expect(report.found).toContain('BIM');
    expect(report.catalogCited).toBe(true);
    expect(report.effective).toBe(true);
  });

  it('仅满足一项标尺判无效', () => {
    const markdown = '本工程采用BIM技术辅助施工管理，可提升现场管理效率。';
    const report = fourNewTechCheck(markdown);
    expect(report.found).toContain('BIM');
    expect(report.effective).toBe(false);
  });

  it('无名称命中即使标尺表述存在也判无效', () => {
    const markdown = '依据建筑业10项新技术要求，本工程较传统工艺显著缩短工期。';
    expect(fourNewTechCheck(markdown).effective).toBe(false);
  });
});

describe('dangerousTwoStepCheck（docx L82 危大两步确认法）', () => {
  it('类别＋分级＋参数齐全判两步确认完成', () => {
    const markdown = '本工程基坑属超危大工程，开挖深度8.5米，需组织专家论证。';
    const report = dangerousTwoStepCheck(markdown);
    expect(report.categories.length).toBeGreaterThan(0);
    expect(report.graded).toBe(true);
    expect(report.paramMatched).toBe(true);
    expect(report.twoStepComplete).toBe(true);
  });

  it('缺分级参数未完成两步确认', () => {
    const markdown = '本工程基坑属超危大工程，需组织专家论证并严格按方案施工。';
    const report = dangerousTwoStepCheck(markdown);
    expect(report.graded).toBe(true);
    expect(report.paramMatched).toBe(false);
    expect(report.twoStepComplete).toBe(false);
  });

  it('无危大内容时类别为空且未完成', () => {
    const report = dangerousTwoStepCheck('本工程主体结构采用现浇混凝土框架施工。');
    expect(report.categories).toEqual([]);
    expect(report.twoStepComplete).toBe(false);
  });
});

describe('emergencyStructureCheck（docx L103 应急预案八部分）', () => {
  const FULL = '总则：应急组织机构及职责明确，风险分析与危险源辨识完整，应急物资设备与通讯保障到位，专项应急预案齐全，应急响应流程清晰，后期处置与事故调查安排明确，定期组织培训演练。';

  it('八部分齐全时覆盖率 100%', () => {
    const report = emergencyStructureCheck(FULL);
    expect(report.coverage).toBe(1);
    expect(report.missingParts).toEqual([]);
    expect(report.coveredParts).toHaveLength(EMERGENCY_EIGHT_PARTS.length);
  });

  it('缺部分结构时覆盖率按缺失比例扣减', () => {
    const report = emergencyStructureCheck('总则与应急组织机构及职责明确，应急响应流程清晰。');
    expect(report.coverage).toBeCloseTo(3 / EMERGENCY_EIGHT_PARTS.length);
    expect(report.missingParts.length).toBeGreaterThan(0);
  });

  it('常用专项预案命中计数', () => {
    const markdown = `${FULL} 专项预案覆盖高处坠落、物体打击、坍塌、触电、火灾等场景。`;
    const report = emergencyStructureCheck(markdown);
    expect(report.planHits).toEqual(expect.arrayContaining(['高处坠落', '坍塌', '火灾']));
    expect(EMERGENCY_COMMON_PLANS.length).toBeGreaterThanOrEqual(8);
  });
});

describe('greenBenchmarkCheck（附录八四节一环保量化基准值）', () => {
  it('基准值全部命中时覆盖率 100%', () => {
    const markdown = [
      '施工用电损耗率≤5%，节能灯具占比100%。',
      '场内土方平衡率≥70%，非传统水源利用率满足要求，模板周转次数≥8次。',
      '扬尘管控落实六个百分百，废水经三级沉淀后排放。',
    ].join('\n');
    expect(greenBenchmarkCheck(markdown).coverage).toBe(1);
  });

  it('部分命中按基准项比例计覆盖率', () => {
    const report = greenBenchmarkCheck('施工用电损耗率≤5%，废水经三级沉淀后排放。');
    expect(report.coverage).toBeCloseTo(2 / GREEN_BENCHMARK_CHECKS.length);
    expect(report.hits.length).toBe(2);
  });

  it('无命中时覆盖率 0', () => {
    const report = greenBenchmarkCheck('本工程注重文明施工与现场环境管理。');
    expect(report.coverage).toBe(0);
  });
});

describe('crossProjectResidueHits（docx L151 跨项目残留零容忍）', () => {
  it('命中其他项目表述', () => {
    expect(crossProjectResidueHits('本方案参考其他项目经验编制。').length).toBeGreaterThan(0);
  });

  it('无残留返回空数组', () => {
    expect(crossProjectResidueHits('本工程基坑开挖深度为7.5米，采用灌注桩支护。')).toEqual([]);
  });
});

describe('buildTenderBidTemplatingReport（模板化降档定级）', () => {
  it('重难点对策重度模板化直接判 heavy，无视套话密度', () => {
    const markdown = `## 工程重难点分析\n\n${GENERIC_ENTRY}\n\n${GENERIC_ENTRY}\n\n${GENERIC_ENTRY}`;
    const report = buildTenderBidTemplatingReport(markdown);
    expect(report.difficultyHeavyTemplated).toBe(true);
    expect(report.level).toBe('heavy');
  });

  it('重难点正常时按套话密度三档定级', () => {
    const FILLER = '项目部精心组织施工资源调配，全力保障工程进度节点按期完成。';
    const markdown = `## 工程重难点分析\n\n${ATTRIBUTED_ENTRY}\n\n${ATTRIBUTED_ENTRY}\n\n${GENERIC_ENTRY}\n\n## 施工部署\n\n${FILLER}\n\n${FILLER}\n\n${FILLER}\n\n${FILLER}`;
    const report = buildTenderBidTemplatingReport(markdown);
    expect(report.difficultyHeavyTemplated).toBe(false);
    expect(report.level).toBe('heavy');
    expect(report.fillerRatio).toBeGreaterThanOrEqual(0.4);
  });

  it('聚合模糊应答词命中次数与跨项目残留明细', () => {
    const markdown = '施工方案基本满足招标要求，原则上按此执行。本方案参考其他项目经验编制。';
    const report = buildTenderBidTemplatingReport(markdown);
    expect(report.vagueHitCount).toBe(2);
    expect(report.vaguePhrases).toEqual(expect.arrayContaining(['基本满足', '原则上']));
    expect(report.crossProjectResidue.length).toBeGreaterThan(0);
  });

  it('干净文本判 light 且各项为 0', () => {
    const markdown = `${FIVE_ELEMENT_BLOCK}\n\n${ATTRIBUTED_ENTRY}`;
    const report = buildTenderBidTemplatingReport(markdown);
    expect(report.level).toBe('light');
    expect(report.vagueHitCount).toBe(0);
    expect(report.crossProjectResidue).toEqual([]);
  });
});
