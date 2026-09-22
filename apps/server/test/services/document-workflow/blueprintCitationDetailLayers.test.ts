import { describe, expect, it } from 'vitest';
import { blueprintCitationVerdict, collectBlueprintCitationCandidates } from '@/services/document-workflow/integratedBlueprint/citation';
import type { BlueprintData, BlueprintQuantity } from '@/services/document-workflow/integratedBlueprint/types';
import type { CitationAdjudicator, CitationAdjudicationCandidate } from '@/services/document-workflow/semanticAdjudication';
import { fixQuantityAuthorityConflicts } from '@/services/document-workflow/integrity/fixers/fixers';

/**
 * 口径分层放行（4.55.30 实机归因：巢湖 doc-f00280f9「蓝图引用冲突」5 条）——引用值命中该条目在蓝图
 * 权威中已登记的分层值（规格-数量拆分小计 / 分工程明细值且标题限定到该单体）时不入候选；未登记值
 * （单条清单行的规格量）照常入候选并经锚点修复链收敛。正反例成对，真冲突仍必须报出。
 */
const conflictAll: CitationAdjudicator = async (candidates: CitationAdjudicationCandidate[]) => ({
  records: new Map(candidates.map(candidate => [candidate.id, { id: candidate.id, conclusion: 'conflict' as const, rationale: '正反例注入：全部视为冲突' }])),
});

/** 真实形态 fixture（巢湖 f00280f9 蓝图 quantities 原值） */
function realShape(): BlueprintData {
  const quantities: Record<string, BlueprintQuantity> = {
    // 单工程明细 == 合计：不承载分层信息（金属窗规格层未被蓝图投影 → 引用值无分层出处）
    '金属窗': { value: 2645.7, unit: 'm2', groups: [{ group: '1#厂房土建工程', value: 2645.7 }] },
    // 规格层（900mm/Φ30/1100mm 小计）+ 单体层（1#/2#/3# 门卫），且规格小计和 820.58 ≠ 合计 410.29（蓝图自身不自洽）
    '金属栏杆': {
      value: 410.29,
      unit: 'm',
      groups: [
        { group: '1#厂房土建工程', value: 316.63 },
        { group: '2#门卫土建工程', value: 78.7 },
        { group: '3#门卫土建工程', value: 14.96 },
      ],
      specBreakdown: [{ spec: '900mm', value: 247.99 }, { spec: 'Φ30', value: 162.3 }, { spec: '1100mm', value: 93.66 }],
    },
    // 无规格层（Q235B/Q355B 同特征行未拆分 → 单条清单行值 182.513 在权威层无出处）
    '钢支撑': { value: 415.525, unit: 't', groups: [{ group: '1#厂房土建工程', value: 415.525 }] },
    '钢天沟': { value: 38.095, unit: 't', groups: [{ group: '1#厂房土建工程', value: 38.095 }], specBreakdown: [{ spec: '1.2mm', value: 31.845 }, { spec: '3mm', value: 3.482 }] },
    '防火涂料': { value: 143188.74, unit: 'm2', groups: [{ group: '1#厂房土建工程', value: 143188.74 }], specBreakdown: [{ spec: '6mm', value: 116694.55 }, { spec: '40mm', value: 26494.19 }] },
    // 规格小计和 262.78 ≠ 合计 147.66：旧「干净切分门」下 2.520/128.870 会被判 conflict 并改写成合计（R20 禁止方向）
    '直形墙': {
      value: 147.66,
      unit: 'm3',
      groups: [{ group: '室外附属工程', value: 131.39 }, { group: '1#厂房土建工程', value: 9.26 }],
      specBreakdown: [{ spec: 'C25', value: 131.39 }, { spec: '150mm', value: 128.87 }, { spec: '100mm', value: 2.52 }],
    },
  };
  return {
    quantities,
    redLineFacts: [],
    resources: { labor: { peakValue: 0 } },
    contract: { totalDays: 0 },
    project: { scope: '' },
  } as unknown as BlueprintData;
}

const subjects = (markdown: string) => collectBlueprintCitationCandidates(markdown, realShape()).candidates.map(candidate => `${candidate.subject} ${candidate.value}${candidate.unit}`);

describe('口径分层放行：规格-数量拆分小计（R20 合法值，反向改写即规格错位缺陷复活）', () => {
  it('规格小计引用不入候选（金属栏杆 247.990m／钢天沟 31.845t／防火涂料 26494.190m² 实机形态）', () => {
    expect(collectBlueprintCitationCandidates('金属栏杆247.990m。', realShape()).candidates).toEqual([]);
    expect(collectBlueprintCitationCandidates('钢天沟31.845t。', realShape()).candidates).toEqual([]);
    expect(collectBlueprintCitationCandidates('防火涂料26494.190m²。', realShape()).candidates).toEqual([]);
  });

  it('规格 token 邻接但小计和≠合计（直形墙 100mm规格2.520m³／150mm规格128.870m³）：以「值 ∈ 已登记分层值集」放行', () => {
    expect(collectBlueprintCitationCandidates('直形墙100mm规格2.520m³。', realShape()).candidates).toEqual([]);
    expect(collectBlueprintCitationCandidates('直形墙150mm规格128.870m³。', realShape()).candidates).toEqual([]);
  });

  it('反例：未登记值仍入候选（改写成合计才是正确修复方向）', () => {
    expect(subjects('金属栏杆400m。')).toEqual(['金属栏杆 400m']);
    expect(subjects('防火涂料30000m²。')).toEqual(['防火涂料 30000m2']);
  });
});

describe('口径分层放行：分工程明细值（对象/单体维度——明细值只在所属对象作用域内合法）', () => {
  it('单体范围句内引用本单体明细值不入候选（标题限定到该单体）', () => {
    expect(collectBlueprintCitationCandidates('#### 1.25.1 1#厂房\n\n金属栏杆316.630m。', realShape()).candidates).toEqual([]);
    expect(collectBlueprintCitationCandidates('#### 1.25.3 3#门卫\n\n金属栏杆14.960m。', realShape()).candidates).toEqual([]);
    // 上位标题链判定：紧邻子标题无单体名时向上逐级标题（「#### 1.25.1 1#厂房」命中）
    expect(collectBlueprintCitationCandidates('#### 1.25.1 1#厂房\n\n##### 1.25.1.2 主要工程量\n\n金属栏杆316.630m。', realShape()).candidates).toEqual([]);
  });

  it('反例：单体作用域错位（2#门卫小节写 1#厂房值）仍入候选', () => {
    expect(subjects('#### 1.25.2 2#门卫\n\n金属栏杆316.630m。')).toEqual(['金属栏杆 316.63m']);
    // 兄弟小节不构成上位作用域：1.25.1 的单体标题不给 1.25.4 的引用授予单体内口径
    const siblings = '#### 1.25.1 1#厂房\n\n金属栏杆316.630m。\n\n#### 1.25.4 室外附属工程\n\n金属栏杆316.630m。';
    const siblingCollection = collectBlueprintCitationCandidates(siblings, realShape());
    expect(siblingCollection.candidates.map(candidate => `${candidate.subject} ${candidate.value}`)).toEqual(['金属栏杆 316.63']);
    expect(siblingCollection.entries.get(siblingCollection.candidates[0]!.id)!.start).toBeGreaterThan(siblings.indexOf('1.25.4'));
  });

  it('反例：项目级语境（无单体限定标题）引用单体明细值仍入候选', () => {
    expect(subjects('本标段金属栏杆316.630m。')).toEqual(['金属栏杆 316.63m']);
  });
});

describe('口径分层放行不吞真缺陷：未登记值产 blocker 并由锚点修复链收敛', () => {
  it('金属窗 334.840m²／钢支撑 182.513t（蓝图权威无该分层）→ 候选 + blocker + 锚点收敛', async () => {
    const data = realShape();
    expect(subjects('金属窗334.840m²。')).toEqual(['金属窗 334.84m2']);
    expect(subjects('钢支撑182.513t。')).toEqual(['钢支撑 182.513t']);
    const markdown = '#### 1.25.1 1#厂房\n\n主要工程量：金属门11.000m²，金属窗334.840m²，金属栏杆247.990m，散水按分部分项计量，钢支撑182.513t，钢天沟31.845t，防火涂料26494.190m²。';
    const verdict = await blueprintCitationVerdict(markdown, data, { adjudicate: conflictAll });
    const blockers = verdict.issues.filter(issue => issue.level === 'error');
    expect(blockers).toHaveLength(2);
    expect(blockers.map(issue => issue.message)).toEqual([
      expect.stringContaining('工程量 金属窗 334.84m2'),
      expect.stringContaining('工程量 钢支撑 182.513t'),
    ]);
    expect(verdict.anchors.map(anchor => `${anchor.name} ${anchor.value}→${anchor.authorityValue}`)).toEqual(['金属窗 334.84→2645.7', '钢支撑 182.513→415.525']);
    // 消费点：判定层锚点 → fixQuantityAuthorityConflicts（citation-numeric-replay 同链），未登记值收敛到条目合计
    const fixed = fixQuantityAuthorityConflicts(markdown, verdict.anchors);
    expect(fixed.fixedCount).toBe(2);
    expect(fixed.markdown).toContain('金属窗2645.7m²');
    expect(fixed.markdown).toContain('钢支撑415.525t');
    expect(fixed.markdown).not.toContain('334.840');
    expect(fixed.markdown).not.toContain('182.513');
    // R20：己方分层值不被改写（放行的明细值原样保留，无锚点进入修复器）
    expect(fixed.markdown).toContain('金属栏杆247.990m');
    expect(fixed.markdown).toContain('钢天沟31.845t');
    expect(fixed.markdown).toContain('防火涂料26494.190m²');
  });

  it('反例：分层值不跨条目互认（防火涂料的规格小计不能放行钢天沟的同值引用）', () => {
    expect(subjects('钢天沟26494.190t。')).toEqual(['钢天沟 26494.19t']);
    expect(collectBlueprintCitationCandidates('防火涂料26494.190m²。', realShape()).candidates).toEqual([]);
  });

  it('回归：值 == 条目权威仍不入候选', () => {
    expect(collectBlueprintCitationCandidates('金属栏杆410.290m。', realShape()).candidates).toEqual([]);
    expect(collectBlueprintCitationCandidates('防火涂料143188.740m²。', realShape()).candidates).toEqual([]);
  });
});
