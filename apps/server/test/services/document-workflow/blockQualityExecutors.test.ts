/**
 * 方案 2.2 块级质量执行器单测（六类：结构/密度/模板化/归因量化/数值/格式）：
 * 密度比例口径与材料门控、模板化占比/模糊双线、归因量化双达标率、格式词表命中、量化参数去重计数。
 * 语义通道 mock（与 tenderBidChecks.test.ts 同源模式：buildSemanticSimilarity + 共享 provider）；
 * 确定性判定用真实实现（检测⊆写作单源）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/document-workflow/semanticSimilarity', () => ({
  buildSemanticSimilarity: vi.fn(),
  SEMANTIC_COVERAGE_THRESHOLD: 0.6,
  // 模糊应答 gate 用共享 provider 嵌入：模糊词根 [1,0]、合法语境词（对称/上游）[0,1]、其余 [0,0]
  //（与 tenderBidChecks.test.ts 同模式：正例分必须严格大于负例分才判定命中）
  getLocalSemanticProvider: () => ({
    embedDocuments: async (texts: string[]) => texts.map(text => {
      const vague = /力争|基本|大致|原则上|大概|左右|尽可能|尽量/u.test(text);
      const legal = /对称|上游/u.test(text);
      return [vague && !legal ? 1 : 0, legal ? 1 : 0];
    }),
  }),
}));

import { buildSemanticSimilarity } from '@/services/document-workflow/semanticSimilarity';
import {
  assessBlockFactDensity,
  attributionBlockingOf,
  backstageFallbackHits,
  factDensityVerdict,
  quantifiedParamCount,
  requiresAttributionQuantification,
  scanAttributionQuantification,
  scanBlockTemplating,
  templatingBlockingOf,
} from '@/services/document-workflow/blockQualityExecutors';

const buildSimilarityMock = vi.mocked(buildSemanticSimilarity);

describe('② 密度执行器（比例口径 ≥1.5/千字 + 材料门控）', () => {
  it('quantifiedParamCount：不同量化参数去重计数（同参数反复堆砌不凑数）', () => {
    expect(quantifiedParamCount('浇筑 3 台泵车，另配 3 台泵车，共 120 m³ 混凝土，工期 90 天。')).toBe(3);
  });

  it('factDensityVerdict：required = ceil(字数/1000×1.5)，params 与 gap 联动', () => {
    const verdict = factDensityVerdict(`施工段共 5 层，浇筑 320 m³ 混凝土，控制坡度 2%。${'好'.repeat(2000)}`);
    expect(verdict.params).toBe(3);
    expect(verdict.required).toBe(Math.ceil((verdict.chars / 1000) * 1.5));
    expect(verdict.gap).toBe(true);
  });

  it('材料无参数（证据/专属事实为空）→ 不阻断（材料参数不足时以全部参数落位为准，不得借参数凑数）', () => {
    const assessment = assessBlockFactDensity(`${'好'.repeat(2000)}无任何参数。`, '');
    expect(assessment.verdict.gap).toBe(true);
    expect(assessment.materialParams).toBe(0);
    expect(assessment.blocking).toBe(false);
  });

  it('材料存在足量可落位参数且正文缺口 → 阻断（材料中仍有未落位参数才构成打回理由）', () => {
    const assessment = assessBlockFactDensity(`${'好'.repeat(2000)}无任何参数。`, '钢筋 120 t，模板 800 ㎡，混凝土 320 m³，工期 90 天。');
    expect(assessment.materialParams).toBeGreaterThanOrEqual(assessment.verdict.required);
    expect(assessment.blocking).toBe(true);
  });

  it('正文参数达标 → 不阻断（材料参数再多也放行）', () => {
    const assessment = assessBlockFactDensity('本段落实 3 台设备、120 m³ 混凝土、90 天工期，满足 5 层需要。', ['1 t', '2 台', '3 个', '4 层', '5 天', '6 m'].join('\n'));
    expect(assessment.verdict.gap).toBe(false);
    expect(assessment.blocking).toBe(false);
  });
});

describe('③ 模板化执行器（套话占比 >10% 或模糊句式 ≥3 处/块）', () => {
  beforeEach(() => {
    buildSimilarityMock.mockReset();
  });

  it('语义套话占比超线 → 阻断；命中句原文去重供定向重写', async () => {
    // 句级判定按文本区分：口径句 0.9（≥0.80 阈值命中）、过程句 0.1（不命中）
    buildSimilarityMock.mockResolvedValue(((left: string) => (/精心组织|严格执行/u.test(left) ? 0.9 : 0.1)) as (left: string, right: string) => number);
    const verdict = await scanBlockTemplating('精心组织科学管理确保工程质量。\n严格执行相关规范和设计要求。\n混凝土浇筑后洒水养护并形成记录。');
    expect(verdict.totalSentences).toBe(3);
    expect(verdict.fillerSentences).toBe(2);
    expect(verdict.fillerRatio).toBeCloseTo(2 / 3, 6);
    expect(templatingBlockingOf(verdict)).toBe(true);
    expect(verdict.fillerDetails).toHaveLength(2);
  });

  it('模糊应答词面命中经语义复核计入（力争句），占比 10% 恰好不阻断', async () => {
    buildSimilarityMock.mockResolvedValue(() => 0.1);
    const verdict = await scanBlockTemplating([
      '混凝土浇筑后洒水养护并形成记录。',
      '钢筋进场按批次见证取样复试合格后使用。',
      '模板支架搭设完成后经检查验收进入下道工序。',
      '施工缝位置按专项方案留设并做防水处理。',
      '砌体材料进场验收合格后分类堆放并标识。',
      '防水卷材铺贴前基层含水率检测合格。',
      '回填土分层夯实并做好压实度检测记录。',
      '外墙保温板粘贴牢固并做锚固件拉拔试验。',
      '屋面找坡层按设计坡度施工并检查排水。',
      '本工程力争在合同工期内完成全部施工内容。',
    ].join('\n'));
    expect(verdict.totalSentences).toBe(10);
    expect(verdict.vagueCount).toBe(1);
    expect(verdict.fillerRatio).toBeCloseTo(0.1, 6);
    expect(templatingBlockingOf(verdict)).toBe(false);
  });

  it('templatingBlockingOf 判定边界：占比 >10% 阻断、模糊 ≥3 处阻断', () => {
    const verdictOf = (fillerSentences: number, totalSentences: number, vagueCount = 0) => ({ fillerSentences, totalSentences, fillerRatio: totalSentences > 0 ? fillerSentences / totalSentences : 0, vagueCount, fillerDetails: [] });
    expect(templatingBlockingOf(verdictOf(1, 10))).toBe(false);
    expect(templatingBlockingOf(verdictOf(2, 10))).toBe(true);
    expect(templatingBlockingOf(verdictOf(1, 10, 3))).toBe(true);
    expect(templatingBlockingOf(verdictOf(0, 10, 2))).toBe(false);
  });
});

describe('④ 归因量化执行器（重难点类章，双达标率 <50% 阻断）', () => {
  beforeEach(() => {
    buildSimilarityMock.mockReset();
  });

  it('requiresAttributionQuantification：重难点/工程特点类标题命中，普通标题不命中', () => {
    expect(requiresAttributionQuantification('项目特点、重点、难点分析')).toBe(true);
    expect(requiresAttributionQuantification('工程特点与难点应对')).toBe(true);
    expect(requiresAttributionQuantification('施工进度计划')).toBe(false);
  });

  it('无归因且无量化 → 双达标率 0 → 阻断，未达标条目供反馈', async () => {
    buildSimilarityMock.mockResolvedValue(() => 0.1);
    const verdict = await scanAttributionQuantification('施工场地狭窄，材料堆放空间与作业面严重受限，转运效率低。\n\n雨季施工周期长，土方作业与混凝土浇筑受天气影响明显。');
    expect(verdict.entries).toBe(2);
    expect(verdict.bothRatio).toBe(0);
    expect(attributionBlockingOf(verdict)).toBe(true);
    expect(verdict.missing).toHaveLength(2);
  });

  it('归因链 + 量化目标双达标 → 不阻断', async () => {
    buildSimilarityMock.mockResolvedValue(() => 0.9);
    const verdict = await scanAttributionQuantification('难点成因：场地狭窄导致材料转运受限，为此采用分层转运，效率提升 30%。\n\n风险来源：雨季影响土方作业，采取排水与覆盖措施，工期影响控制在 3 天内。');
    expect(verdict.entries).toBe(2);
    expect(verdict.bothRatio).toBe(1);
    expect(attributionBlockingOf(verdict)).toBe(false);
  });

  it('无条目（短文本）→ 不阻断（无条目无判定）', async () => {
    buildSimilarityMock.mockResolvedValue(() => 0.9);
    const verdict = await scanAttributionQuantification('短句。');
    expect(verdict.entries).toBe(0);
    expect(attributionBlockingOf(verdict)).toBe(false);
  });
});

describe('⑥ 格式执行器（后台/兜底话术硬约束）', () => {
  it('后台/兜底话术行命中并限 5 条原文', () => {
    const hits = backstageFallbackHits([
      '## 施工部署',
      '本工程系统暂未从知识库确认相关做法。',
      '混凝土强度等级待确认。',
      '正常内容行不命中。',
      '资料未明确具体规格。',
      '不适用本工程。',
      '以本项目招标文件明确内容为准。',
      '第 7 行待资料复核。',
    ].join('\n'));
    expect(hits).toHaveLength(5);
    expect(hits[0]).toContain('系统暂未');
  });

  it('正式表述零命中', () => {
    expect(backstageFallbackHits('混凝土浇筑后洒水养护不少于 7 天。')).toEqual([]);
  });
});
