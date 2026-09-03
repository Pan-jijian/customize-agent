import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import type { DocumentFact, NumericScopeConflict } from '@/services/document-workflow/types';
import {
  PROJECT_BASIC_FIELD_SPECS,
  applyScopeConflictResolutions,
  applyScopeOverridesToText,
  buildCanonicalFactModel,
  buildCanonicalFacts,
  collectMarkdownTableCandidates,
  collectStructuredFactCandidates,
  detectNumericScopeConflicts,
  fieldSpecForFact,
  governEvidenceValues,
  numericScopeResolutions,
  renderScopeOverrideAnchors,
  resolveCanonicalFacts,
  scopeReForKind,
  scoreFactCandidate,
  unitReForKind,
} from '@/services/document-workflow/factGovernance';

function factOf(overrides: Partial<DocumentFact> = {}): DocumentFact {
  return {
    key: '项目名称',
    fieldId: 'project_name',
    value: '合肥市某区安置房项目',
    sourceFile: '招标文件.pdf',
    roleId: 'project_basic',
    confidence: 0.9,
    ...overrides,
  };
}

function specOf(key: string) {
  const spec = PROJECT_BASIC_FIELD_SPECS.find(item => item.key === key);
  expect(spec).toBeDefined();
  return spec!;
}

describe('scoreFactCandidate 各字段类型评分/拒绝', () => {
  const base = { fieldKey: 'schedule_requirement', label: '计划工期', sourceType: 'structured_fact' as const, sourceName: '招标文件.pdf' };

  it('工期：明确数值+单位通过，来源文件可信加分', () => {
    const scored = scoreFactCandidate({ ...base, value: '540日历天' }, specOf('schedule_requirement'));
    expect(scored.rejected).toBe(false);
    expect(scored.confidence).toBeGreaterThan(50);
    expect(scored.reasons).toContain('包含明确工期数值和时间单位');
    expect(scored.reasons).toContain('来源文件可信');
  });

  it('工期：违约条款不是计划工期口径 → 拒绝', () => {
    const scored = scoreFactCandidate({ ...base, value: '工期延误56天以上发包人可切除剩余工程量' }, specOf('schedule_requirement'));
    expect(scored.rejected).toBe(true);
    expect(scored.reasons).toContain('命中工期违约条款而非计划工期');
  });

  it('金额：明确数值+单位通过；报价明细等商务词拒绝', () => {
    const ok = scoreFactCandidate({ ...base, fieldKey: 'project_investment_estimate', label: '合同估算价', value: '28570.36万元' }, specOf('project_investment_estimate'));
    expect(ok.rejected).toBe(false);
    const bad = scoreFactCandidate({ ...base, fieldKey: 'project_investment_estimate', label: '合同估算价', value: '报价明细表28570.36万元' }, specOf('project_investment_estimate'));
    expect(bad.rejected).toBe(true);
    expect(bad.reasons).toContain('命中非目标商务明细');
  });

  it('标准：合格类表达通过；混入工期词拒绝', () => {
    const ok = scoreFactCandidate({ ...base, fieldKey: 'quality_standard', label: '质量标准', value: '质量标准：合格，符合国家验收规范要求' }, specOf('quality_standard'));
    expect(ok.rejected).toBe(false);
    const bad = scoreFactCandidate({ ...base, fieldKey: 'quality_standard', label: '质量标准', value: '质量标准合格且工期540日历天' }, specOf('quality_standard'));
    expect(bad.rejected).toBe(true);
  });

  it('地点：具体地址特征通过；引用型弱值降权但不拒绝', () => {
    const ok = scoreFactCandidate({ ...base, fieldKey: 'project_location', label: '建设地点', value: '合肥市蜀山区' }, specOf('project_location'));
    expect(ok.rejected).toBe(false);
    expect(ok.reasons).toContain('包含具体地址特征');
    const weak = scoreFactCandidate({ ...base, fieldKey: 'project_location', label: '建设地点', value: '详见招标文件' }, specOf('project_location'));
    expect(weak.rejected).toBe(false);
    expect(weak.confidence).toBeLessThan(0);
    expect(weak.reasons).toContain('引用型地点弱值');
  });

  it('组织：组织特征通过；评标委员会角色串位拒绝', () => {
    const ok = scoreFactCandidate({ ...base, fieldKey: 'owner', label: '招标人', value: '合肥市重点工程建设管理局' }, specOf('owner'));
    expect(ok.rejected).toBe(false);
    const bad = scoreFactCandidate({ ...base, fieldKey: 'owner', label: '招标人', value: '评标委员会' }, specOf('owner'));
    expect(bad.rejected).toBe(true);
    expect(bad.reasons).toContain('组织字段角色串位');
  });

  it('编号：格式合法通过；量纲单位混入拒绝', () => {
    const ok = scoreFactCandidate({ ...base, fieldKey: 'project_code', label: '项目编号', value: 'HF-2026-001' }, specOf('project_code'));
    expect(ok.rejected).toBe(false);
    const bad = scoreFactCandidate({ ...base, fieldKey: 'project_code', label: '项目编号', value: '28570.36㎡' }, specOf('project_code'));
    expect(bad.rejected).toBe(true);
    expect(bad.reasons).toContain('编号格式不合法');
  });

  it('规模：数值+单位通过', () => {
    const scored = scoreFactCandidate({ ...base, fieldKey: 'project_scale', label: '建设规模', value: '总建筑面积28570.36㎡' }, specOf('project_scale'));
    expect(scored.rejected).toBe(false);
    expect(scored.reasons).toContain('包含规模数值或单位');
  });

  it('项目名称：工程特征通过；“不适用”等表头噪声拒绝', () => {
    const ok = scoreFactCandidate({ ...base, fieldKey: 'project_name', label: '项目名称', value: '合肥市某区安置房项目' }, specOf('project_name'));
    expect(ok.rejected).toBe(false);
    const bad = scoreFactCandidate({ ...base, fieldKey: 'project_name', label: '项目名称', value: '不适用' }, specOf('project_name'));
    expect(bad.rejected).toBe(true);
  });

  it('条款/大段噪声与空值拒绝', () => {
    const clause = scoreFactCandidate({ ...base, value: '投标有效期90天' }, specOf('schedule_requirement'));
    expect(clause.rejected).toBe(true);
    expect(clause.reasons).toContain('大段条款或 Markdown 噪声');
    const empty = scoreFactCandidate({ ...base, value: '  ' }, specOf('schedule_requirement'));
    expect(empty.rejected).toBe(true);
    expect(empty.reasons).toContain('空值或过长');
  });

  it('包含其他字段名疑似串位 → 降权并记录', () => {
    const scored = scoreFactCandidate({ ...base, fieldKey: 'project_name', label: '项目名称', value: '项目名称：合肥项目，建设地点：蜀山区' }, specOf('project_name'));
    expect(scored.reasons).toContain('包含其他字段名，疑似字段串位');
    expect(scored.confidence).toBeLessThan(50);
  });

  it('evidence 来源与补疑/澄清修正文件加分', () => {
    const evidenceScored = scoreFactCandidate({ ...base, value: '540日历天', sourceType: 'evidence', sourceName: undefined }, specOf('schedule_requirement'));
    expect(evidenceScored.reasons).toContain('来源为证据原文');
    const addendumScored = scoreFactCandidate({ ...base, value: '540日历天', sourceName: '补疑澄清文件.pdf' }, specOf('schedule_requirement'));
    expect(addendumScored.reasons).toContain('补疑/澄清类修正文件，权威最高');
    expect(addendumScored.confidence).toBeGreaterThan(evidenceScored.confidence);
  });
});

describe('fieldSpecForFact / collectStructuredFactCandidates', () => {
  it('按 fieldId/fieldName/别名命中字段规格', () => {
    // fieldId 精确命中要求 key/fieldName 文本不先行命中前置 spec 的别名（find 按数组顺序首个命中即返回）
    expect(fieldSpecForFact(factOf({ fieldId: 'project_scale', key: '建设规模' }))?.key).toBe('project_scale');
    expect(fieldSpecForFact(factOf({ fieldId: undefined, fieldName: '计划工期', key: '' }))?.key).toBe('schedule_requirement');
    expect(fieldSpecForFact(factOf({ fieldId: undefined, key: '未注册字段' }))).toBeUndefined();
  });

  it('现状锁定：key 文本先行命中前置 spec 别名时，fieldId 精确匹配被遮蔽', () => {
    // fact.key 默认“项目名称”排在 PROJECT_BASIC_FIELD_SPECS 首位，find 先命中 project_name 的别名
    expect(fieldSpecForFact(factOf({ fieldId: 'project_scale' }))?.key).toBe('project_name');
  });

  it('仅收集命中规格的事实候选并归一化值', () => {
    const candidates = collectStructuredFactCandidates([
      factOf({ fieldId: 'project_name', value: '  合肥市某区安置房项目  ' }),
      factOf({ fieldId: 'unregistered_field', key: '未知字段', value: '任意内容' }),
    ]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.fieldKey).toBe('project_name');
    expect(candidates[0]?.sourceType).toBe('structured_fact');
    expect(candidates[0]?.value).toBe('合肥市某区安置房项目');
  });
});

describe('collectMarkdownTableCandidates', () => {
  it('标签-值两列表格行提取候选', () => {
    const candidates = collectMarkdownTableCandidates('| 项目名称 | 合肥市某区安置房项目 |');
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.label).toBe('项目名称');
    expect(candidates[0]?.value).toBe('合肥市某区安置房项目');
    expect(candidates[0]?.sourceType).toBe('generated_markdown');
  });

  it('序号行取第 2/3/4 列为标签/值/来源', () => {
    const candidates = collectMarkdownTableCandidates('| 序号 | 项目名称 | 合肥市某区安置房项目 | 招标文件.pdf |');
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.label).toBe('项目名称');
    expect(candidates[0]?.value).toBe('合肥市某区安置房项目');
    expect(candidates[0]?.sourceName).toBe('招标文件.pdf');
  });

  it('分隔行、未明确占位值、未注册标签均跳过', () => {
    expect(collectMarkdownTableCandidates('|---|---|')).toHaveLength(0);
    expect(collectMarkdownTableCandidates('| 项目名称 | 资料未明确 |')).toHaveLength(0);
    expect(collectMarkdownTableCandidates('| 备注 | 无关内容 |')).toHaveLength(0);
  });
});

describe('resolveCanonicalFacts / buildCanonicalFacts', () => {
  const spec = () => specOf('project_name');

  it('同字段多候选按置信度选非拒绝最高分', () => {
    const good = scoreFactCandidate({ fieldKey: 'project_name', label: '项目名称', value: '合肥市某区安置房项目', sourceType: 'structured_fact', sourceName: '招标文件.pdf' }, spec());
    const weak = scoreFactCandidate({ fieldKey: 'project_name', label: '项目名称', value: '合肥市某区安置房项目', sourceType: 'generated_markdown' }, spec());
    const map = resolveCanonicalFacts([weak, good]);
    expect(map.get('project_name')?.source).toBe('招标文件.pdf');
    expect(map.get('project_name')?.candidates).toHaveLength(2);
    expect(map.get('project_name')?.selectedReason).toContain('来源文件可信');
  });

  it('全部候选被拒绝时不产出该字段', () => {
    const bad = scoreFactCandidate({ fieldKey: 'project_name', label: '项目名称', value: '不适用', sourceType: 'structured_fact' }, spec());
    expect(resolveCanonicalFacts([bad]).has('project_name')).toBe(false);
  });

  it('结构化事实与正文表格候选合并决议', () => {
    const map = buildCanonicalFacts({
      facts: [factOf({ fieldId: 'project_name', key: '项目名称', value: '合肥市某区安置房项目' })],
      markdown: '| 计划工期 | 540日历天 |\n|---|---|',
    });
    expect(map.get('project_name')?.value).toBe('合肥市某区安置房项目');
    expect(map.get('schedule_requirement')?.value).toBe('540日历天');
  });
});

describe('scopeReForKind / unitReForKind', () => {
  it('各口径词匹配与子项口径负向后顾排除', () => {
    expect(scopeReForKind('area').test('总建筑面积')).toBe(true);
    expect(scopeReForKind('area').test('建设规模')).toBe(true);
    // 地上/地下等分层口径不参与建筑总量裁决
    expect(scopeReForKind('area').test('地上建筑面积')).toBe(false);
    expect(scopeReForKind('cost').test('合同估算价')).toBe(true);
    expect(scopeReForKind('floors').test('地上层数')).toBe(true);
    expect(scopeReForKind('parkingSpaces').test('机动车位')).toBe(true);
    expect(scopeReForKind('duration').test('计划工期')).toBe(true);
  });

  it('单位基础表与各口径同源', () => {
    expect(new RegExp(unitReForKind('area'), 'u').test('㎡')).toBe(true);
    expect(new RegExp(unitReForKind('cost'), 'u').test('万元')).toBe(true);
    expect(new RegExp(unitReForKind('floors'), 'u').test('层')).toBe(true);
    expect(new RegExp(unitReForKind('parkingSpaces'), 'u').test('个')).toBe(true);
    expect(new RegExp(unitReForKind('duration'), 'u').test('日历天')).toBe(true);
  });
});

describe('detectNumericScopeConflicts 跨文件同口径裁决', () => {
  const scaleFact = (value: string, sourceFile: string): DocumentFact =>
    factOf({ key: '建设规模', fieldId: 'project_scale', fieldName: '建设规模', value, sourceFile });

  it('招标 vs 补疑不同面积数值 → 补疑胜出（medium）', () => {
    const conflicts = detectNumericScopeConflicts([
      scaleFact('总建筑面积4645㎡', '招标文件.pdf'),
      scaleFact('总建筑面积4646㎡', '补疑文件.pdf'),
    ]);
    const area = conflicts.find(conflict => conflict.kind === 'area');
    expect(area).toBeDefined();
    expect(area?.resolution).toBe('4646㎡');
    expect(area?.confidence).toBe('medium');
    expect(area?.values).toHaveLength(2);
  });

  it('补疑修正语境（调整为）→ high 置信度', () => {
    const conflicts = detectNumericScopeConflicts([
      scaleFact('总建筑面积4645㎡', '招标文件.pdf'),
      scaleFact('总建筑面积调整为4646㎡', '补疑文件.pdf'),
    ]);
    const area = conflicts.find(conflict => conflict.kind === 'area');
    expect(area?.resolution).toBe('4646㎡');
    expect(area?.confidence).toBe('high');
  });

  it('门槛型（不低于）数值剔除出裁决池，不产生冲突', () => {
    const conflicts = detectNumericScopeConflicts([
      scaleFact('总建筑面积20000㎡', '招标文件.pdf'),
      factOf({ key: '业绩要求', value: '项目经理业绩要求：建筑面积不低于19000㎡', sourceFile: '资格要求.pdf' }),
    ]);
    expect(conflicts.filter(conflict => conflict.kind === 'area')).toHaveLength(0);
  });

  it('目标型（拟建设）数值剔除出裁决池，不产生冲突', () => {
    const conflicts = detectNumericScopeConflicts([
      scaleFact('总建筑面积20000㎡', '招标文件.pdf'),
      factOf({ key: '规划', value: '拟建设总建筑面积约5000㎡', sourceFile: '规划说明.pdf' }),
    ]);
    expect(conflicts.filter(conflict => conflict.kind === 'area')).toHaveLength(0);
  });

  it('「总」字有无归一为同一总量口径组', () => {
    const conflicts = detectNumericScopeConflicts([
      scaleFact('建筑面积约为4645㎡', '招标文件.pdf'),
      scaleFact('总建筑面积约4646㎡', '补疑文件.pdf'),
    ]);
    const area = conflicts.find(conflict => conflict.kind === 'area');
    expect(area).toBeDefined();
    expect(area?.resolution).toBe('4646㎡');
  });

  it('同文件内多个数值不算跨文件冲突', () => {
    const conflicts = detectNumericScopeConflicts([
      factOf({ key: '建设规模', fieldId: 'project_scale', value: '总建筑面积4645㎡，另有单体建筑面积4646㎡', sourceFile: '招标文件.pdf' }),
    ]);
    expect(conflicts).toHaveLength(0);
  });

  it('工期/层数/车位数/金额口径各自检出（补疑胜出）', () => {
    const conflicts = detectNumericScopeConflicts([
      factOf({ key: '计划工期', fieldId: 'schedule_requirement', value: '计划工期540日历天', sourceFile: '招标文件.pdf' }),
      factOf({ key: '计划工期', fieldId: 'schedule_requirement', value: '计划工期600日历天', sourceFile: '补疑文件.pdf' }),
      factOf({ key: '层数', value: '地上层数6层', sourceFile: '招标文件.pdf' }),
      factOf({ key: '层数', value: '地上层数7层', sourceFile: '补疑文件.pdf' }),
      factOf({ key: '车位', value: '机动车位300个', sourceFile: '招标文件.pdf' }),
      factOf({ key: '车位', value: '机动车位320个', sourceFile: '补疑文件.pdf' }),
      factOf({ key: '估算价', value: '合同估算价500万元', sourceFile: '招标文件.pdf' }),
      factOf({ key: '估算价', value: '合同估算价520万元', sourceFile: '补疑文件.pdf' }),
    ]);
    const byKind = (kind: NumericScopeConflict['kind']) => conflicts.find(conflict => conflict.kind === kind);
    expect(byKind('duration')?.resolution).toBe('600日历天');
    expect(byKind('floors')?.resolution).toBe('7层');
    expect(byKind('parkingSpaces')?.resolution).toBe('320个');
    expect(byKind('cost')?.resolution).toBe('520万元');
  });

  it('无口径数值时返回空数组', () => {
    expect(detectNumericScopeConflicts([factOf({ value: '项目名称：合肥市某区安置房项目' })])).toEqual([]);
  });
});

describe('裁决结果应用（resolution/改写/锚点）', () => {
  const areaConflict: NumericScopeConflict = {
    kind: 'area',
    scope: '总建筑面积（面积口径）',
    values: [
      { value: '4646', unit: '㎡', sourceFile: '补疑文件.pdf', priority: 95 },
      { value: '4645', unit: '㎡', sourceFile: '招标文件.pdf', priority: 85 },
    ],
    resolution: '4646㎡',
    confidence: 'high',
  };

  it('numericScopeResolutions 解析胜出值与败选值（low 不参与）', () => {
    const resolutions = numericScopeResolutions([areaConflict]);
    expect(resolutions.get('area')).toEqual({ winnerNum: '4646', losers: [{ value: '4645', unit: '㎡' }] });
    const lowConflict: NumericScopeConflict = { ...areaConflict, kind: 'duration', scope: '计划工期（工期口径）', resolution: '600日历天', confidence: 'low' };
    expect(numericScopeResolutions([lowConflict]).size).toBe(0);
  });

  it('applyScopeOverridesToText 文本中败选数值替换为胜出值（每种单位形态一个败选条目）', () => {
    // 现状锁定：每个 loser 条目只执行一次替换（单位匹配优先），“4645㎡”与“4645平方米”
    // 是不同单位形态，需各自独立的 loser 条目才会被分别替换
    const dualUnitConflict: NumericScopeConflict = {
      ...areaConflict,
      values: [
        { value: '4646', unit: '㎡', sourceFile: '补疑文件.pdf', priority: 95 },
        { value: '4645', unit: '㎡', sourceFile: '招标文件.pdf', priority: 85 },
        { value: '4645', unit: '平方米', sourceFile: '设计说明.pdf', priority: 70 },
      ],
    };
    const result = applyScopeOverridesToText('本项目总建筑面积4645㎡，地下室建筑面积4645平方米。', [dualUnitConflict]);
    expect(result).toContain('4646㎡');
    expect(result).toContain('4646平方米');
    expect(result).not.toContain('4645');
  });

  it('governEvidenceValues 改写证据切片；无冲突时返回原引用', () => {
    const evidence = [{ content: '总建筑面积4645㎡的说明。' }, { content: '无关内容。' }];
    const governed = governEvidenceValues(evidence, [areaConflict]);
    expect(governed[0]?.content).toContain('4646㎡');
    expect(governed[1]?.content).toBe('无关内容。');
    expect(governEvidenceValues(evidence, [])).toBe(evidence);
  });

  it('renderScopeOverrideAnchors 按置信度分级措辞', () => {
    const high = renderScopeOverrideAnchors([areaConflict]);
    expect(high.some(line => line.includes('必须统一为 4646㎡'))).toBe(true);
    expect(high.some(line => line.includes('正文禁止出现'))).toBe(true);
    const medium = renderScopeOverrideAnchors([{ ...areaConflict, confidence: 'medium' }]);
    expect(medium.some(line => line.includes('应统一为 4646㎡'))).toBe(true);
    const low = renderScopeOverrideAnchors([{ ...areaConflict, confidence: 'low' }]);
    expect(low.some(line => line.includes('参考口径为 4646㎡'))).toBe(true);
    expect(low.some(line => line.includes('人工复核'))).toBe(true);
  });

  it('applyScopeConflictResolutions 主表事实败选值改写且保留单位；无关事实不变', () => {
    const facts = [
      factOf({ key: '建设规模', fieldId: 'project_scale', value: '总建筑面积4645㎡' }),
      factOf({ key: '计划工期', fieldId: 'schedule_requirement', value: '计划工期540日历天' }),
    ];
    const result = applyScopeConflictResolutions(facts, [areaConflict]);
    expect(result[0]?.value).toContain('4646㎡');
    expect(result[0]?.value).not.toContain('4645');
    expect(result[1]?.value).toContain('540日历天');
  });
});

describe('buildCanonicalFactModel 端到端', () => {
  it('主表字段落位、缺项进 gaps、裁决进 scopeConflicts', () => {
    const canonical = buildCanonicalFactModel({
      facts: [
        factOf({ key: '项目名称', fieldId: 'project_name', value: '合肥市某区安置房项目' }),
        factOf({ key: '计划工期', fieldId: 'schedule_requirement', value: '计划工期540日历天' }),
        factOf({ key: '质量标准', fieldId: 'quality_standard', value: '质量标准：合格' }),
      ],
      projectRoot: path.join(os.tmpdir(), `fact-governance-test-${Date.now()}-${Math.random()}`),
      requiredKeys: ['project_code'],
      templateId: 'tpl-governance-test',
    });
    expect(canonical.projectIdentity.projectName?.value).toContain('合肥市某区安置房项目');
    expect(canonical.byKey.duration?.value).toContain('540日历天');
    expect(canonical.byKey.quality_target?.value).toContain('合格');
    expect(canonical.gaps.some(gap => gap.key === 'project_code')).toBe(true);
    expect(Array.isArray(canonical.scopeConflicts)).toBe(true);
    // 现状锁定：canonical 表路径产出的 project_name sourceType=structured_fact（优先级 50）→ locked=false；
    // locked 仅在 pickFactsByPattern 直连路径（tender/contract 等来源优先级 ≥80）时为 true
    expect(canonical.byKey.project_name?.locked).toBe(false);
  });

  it('跨文件面积冲突经裁决后主表只见胜出值', () => {
    const canonical = buildCanonicalFactModel({
      facts: [
        factOf({ key: '建设规模', fieldId: 'project_scale', value: '总建筑面积4645㎡', sourceFile: '招标文件.pdf' }),
        factOf({ key: '建设规模', fieldId: 'project_scale', value: '总建筑面积4646㎡', sourceFile: '补疑文件.pdf' }),
      ],
      projectRoot: path.join(os.tmpdir(), `fact-governance-conflict-${Date.now()}-${Math.random()}`),
      templateId: 'tpl-governance-conflict',
    });
    expect(canonical.scopeConflicts.some(conflict => conflict.kind === 'area' && conflict.resolution === '4646㎡')).toBe(true);
    expect(canonical.projectScope.scale).toBeDefined();
    const scale = canonical.projectScope.scale as { value: string };
    expect(Array.isArray(scale)).toBe(false);
    expect(scale.value).not.toContain('4645');
  });
});
