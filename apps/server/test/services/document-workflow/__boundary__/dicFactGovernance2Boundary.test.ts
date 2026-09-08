/**
 * t3-mf FG2 组：数值口径冲突裁决族矩阵。
 * 覆盖：scopeReForKind / unitReForKind / detectNumericScopeConflicts（五口径×四语境分类/
 * 总字归一/异口径隔离/同文件不冲突/弱锚定降级）/ numericScopeResolutions（low 跳过）/
 * applyScopeOverridesToText / governEvidenceValues / renderScopeOverrideAnchors（三档措辞）/
 * applyScopeConflictResolutions（保单位改写）。
 * 全部断言按源码实现逐条推导，真实行为锁定（不修改实现迎合用例）。
 */
import { describe, expect, it } from 'vitest';
import {
  applyScopeConflictResolutions,
  applyScopeOverridesToText,
  detectNumericScopeConflicts,
  governEvidenceValues,
  numericScopeResolutions,
  renderScopeOverrideAnchors,
  scopeReForKind,
  unitReForKind,
} from '@/services/document-workflow/factGovernance';
import { DEFAULT_WORKFLOW_RULES } from '@/services/document-workflow/workflowRules';
import type { DocumentFact, NumericScopeConflict } from '@/services/document-workflow/types';

const fact = (value: string, sourceFile: string, extra: Partial<DocumentFact> = {}): DocumentFact => ({
  key: 'k', value, sourceFile, roleId: 'r', confidence: 0.9, ...extra,
});

// ═══════ Q1 scopeReForKind 口径词基础表 ═══════
describe('Q1 scopeReForKind 口径词基础表', () => {
  it('area 匹配总建筑面积/建筑面积/建设规模', () => {
    const re = scopeReForKind('area');
    expect(re.test('总建筑面积约4645㎡')).toBe(true);
    expect(re.test('建筑面积约为4645㎡')).toBe(true);
    expect(re.test('建设规模：4645平方米')).toBe(true);
  });

  it('area 不匹配占地面积/用地面积', () => {
    const re = scopeReForKind('area');
    expect(re.test('总占地面积约10970平方米')).toBe(false);
    expect(re.test('用地面积约5000平方米')).toBe(false);
  });

  it('area 字符级负向后顾排除地上/地下分层口径', () => {
    const re = scopeReForKind('area');
    expect(re.test('地上建筑面积24783.39平方米')).toBe(false);
    expect(re.test('地下建筑面积3786.97平方米')).toBe(false);
    expect(re.test('门卫室建筑面积60平方米')).toBe(false);
  });

  it('area 总建筑面积前的总字不属于黑名单仍匹配', () => {
    expect(scopeReForKind('area').test('总建筑面积5000㎡')).toBe(true);
  });

  it('cost 匹配六类金额口径词', () => {
    const re = scopeReForKind('cost');
    expect(re.test('合同估算价500万元')).toBe(true);
    expect(re.test('最高投标限价600万元')).toBe(true);
    expect(re.test('工程总投资2.8亿元')).toBe(true);
    expect(re.test('招标控制价510万元')).toBe(true);
    expect(re.test('工程造价约3000万元')).toBe(true);
  });

  it('floors 匹配总层数/地上层数/楼层数', () => {
    const re = scopeReForKind('floors');
    expect(re.test('总层数6层')).toBe(true);
    expect(re.test('地上层数6层')).toBe(true);
    expect(re.test('楼层数8层')).toBe(true);
  });

  it('parkingSpaces 匹配总车位/机动车位/车位数', () => {
    const re = scopeReForKind('parkingSpaces');
    expect(re.test('总车位200个')).toBe(true);
    expect(re.test('机动车位200个')).toBe(true);
    expect(re.test('车位数210个')).toBe(true);
  });

  it('duration 匹配计划工期/合同工期/施工周期', () => {
    const re = scopeReForKind('duration');
    expect(re.test('计划工期180日历天')).toBe(true);
    expect(re.test('合同工期150日历天')).toBe(true);
    expect(re.test('施工周期12个月')).toBe(true);
  });
});

// ═══════ Q2 unitReForKind 单位基础表 ═══════
describe('Q2 unitReForKind 单位基础表', () => {
  it('area 单位含万前缀变体', () => {
    const re = new RegExp(unitReForKind('area'), 'u');
    expect('4645㎡'.match(re)?.[0]).toBe('㎡');
    expect('3.5万㎡'.match(re)?.[0]).toBe('万㎡');
    expect('28570.36平方米'.match(re)?.[0]).toBe('平方米');
  });

  it('cost 单位含亿元/万元/元', () => {
    const re = new RegExp(unitReForKind('cost'), 'u');
    expect('2.8亿元'.match(re)?.[0]).toBe('亿元');
    expect('500万元'.match(re)?.[0]).toBe('万元');
    expect('3000元'.match(re)?.[0]).toBe('元');
  });

  it('floors 单位仅层', () => {
    expect(new RegExp(unitReForKind('floors'), 'u').test('6层')).toBe(true);
  });

  it('parkingSpaces 单位交替序：个 分支先于 个车位 命中', () => {
    const re = new RegExp(unitReForKind('parkingSpaces'), 'u');
    expect('200个'.match(re)?.[0]).toBe('个');
    expect('200个车位'.match(re)?.[0]).toBe('个');
  });

  it('duration 单位含日历天/天/个月/月', () => {
    const re = new RegExp(unitReForKind('duration'), 'u');
    expect('180日历天'.match(re)?.[0]).toBe('日历天');
    expect('12个月'.match(re)?.[0]).toBe('个月');
  });
});

// ═══════ Q3 detectNumericScopeConflicts ═══════
describe('Q3 detectNumericScopeConflicts', () => {
  it('空事实 → 无冲突', () => {
    expect(detectNumericScopeConflicts([], DEFAULT_WORKFLOW_RULES)).toEqual([]);
  });

  it('单值单文件 → 无冲突', () => {
    expect(detectNumericScopeConflicts([fact('总建筑面积约4645㎡', '招标文件正文')], DEFAULT_WORKFLOW_RULES)).toEqual([]);
  });

  it('area 跨文件不同值 → 冲突+按优先级裁决', () => {
    const conflicts = detectNumericScopeConflicts([
      fact('总建筑面积约4645㎡', '招标文件正文'),
      fact('总建筑面积约4646㎡', '补疑文件'),
    ], DEFAULT_WORKFLOW_RULES);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].kind).toBe('area');
    expect(conflicts[0].scope).toBe('建筑面积（面积口径）');
    expect(conflicts[0].resolution).toBe('4646㎡');
    expect(conflicts[0].confidence).toBe('medium');
    expect(conflicts[0].values).toHaveLength(2);
  });

  it('补疑修正语境 → amendment high', () => {
    const conflicts = detectNumericScopeConflicts([
      fact('总建筑面积约4645㎡', '招标文件正文'),
      fact('总建筑面积修正为4646㎡', '补疑文件'),
    ], DEFAULT_WORKFLOW_RULES);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].resolution).toBe('4646㎡');
    expect(conflicts[0].confidence).toBe('high');
  });

  it('总字归一：无总字与有总字同组', () => {
    const conflicts = detectNumericScopeConflicts([
      fact('建筑面积约为4645㎡', '招标文件正文'),
      fact('总建筑面积约4646㎡', '清单文件'),
    ], DEFAULT_WORKFLOW_RULES);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].scope).toBe('建筑面积（面积口径）');
  });

  it('同文件内不同值 → 不判冲突', () => {
    const conflicts = detectNumericScopeConflicts([
      fact('总建筑面积约4645㎡，规划总建筑面积约4646㎡', '招标文件正文'),
    ], DEFAULT_WORKFLOW_RULES);
    expect(conflicts).toEqual([]);
  });

  it('门槛型数值剔除（业绩要求不低于19000 不覆盖本体 20000）', () => {
    const conflicts = detectNumericScopeConflicts([
      fact('建筑规模20000㎡', '招标文件正文'),
      fact('业绩要求：建筑面积不低于19000㎡', '补疑文件'),
    ], DEFAULT_WORKFLOW_RULES);
    expect(conflicts).toEqual([]);
  });

  it('目标型数值剔除（拟建设约5000 不参与裁决）', () => {
    const conflicts = detectNumericScopeConflicts([
      fact('总建筑面积约5500㎡', '招标文件正文'),
      fact('拟建设总建筑面积约5000㎡', '清单文件'),
    ], DEFAULT_WORKFLOW_RULES);
    expect(conflicts).toEqual([]);
  });

  it('面积万㎡与㎡等价归一 → 不冲突', () => {
    const conflicts = detectNumericScopeConflicts([
      fact('总建筑面积3.5万㎡', '招标文件正文'),
      fact('总建筑面积35000㎡', '清单文件'),
    ], DEFAULT_WORKFLOW_RULES);
    expect(conflicts).toEqual([]);
  });

  it('金额万元与元换算 → 冲突（双重乘万真行为）', () => {
    // 真行为：万元分支 base*10000 后再 *10000（双重乘万），与元直值不可等价比较
    const conflicts = detectNumericScopeConflicts([
      fact('合同估算价500万元', '招标文件正文'),
      fact('合同估算价5000000元', '清单文件'),
    ], DEFAULT_WORKFLOW_RULES);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].kind).toBe('cost');
  });

  it('异口径隔离：占地数值不进入 area 裁决池', () => {
    const conflicts = detectNumericScopeConflicts([
      fact('建设规模：项目总占地面积约10970平方米，单体建筑面积28570.36平方米', '招标文件正文'),
      fact('总建筑面积28571平方米', '清单文件'),
    ], DEFAULT_WORKFLOW_RULES);
    expect(conflicts).toHaveLength(1);
    const values = conflicts[0].values.map(item => item.value);
    expect(values).toContain('28570.36');
    expect(values).not.toContain('10970');
    expect(conflicts[0].resolution).toBe('28570.36平方米');
  });

  it('floors 冲突：个位数数值允许', () => {
    const conflicts = detectNumericScopeConflicts([
      fact('地上层数6层', '招标文件正文'),
      fact('地上层数7层', '清单文件'),
    ], DEFAULT_WORKFLOW_RULES);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].kind).toBe('floors');
    expect(conflicts[0].resolution).toBe('6层');
  });

  it('parkingSpaces 冲突', () => {
    const conflicts = detectNumericScopeConflicts([
      fact('机动车位200个', '招标文件正文'),
      fact('机动车位210个', '清单文件'),
    ], DEFAULT_WORKFLOW_RULES);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].scope).toBe('机动车位（车位数口径）');
    expect(conflicts[0].resolution).toBe('200个');
  });

  it('不同口径词不归同组（计划工期 vs 合同工期）→ 无冲突', () => {
    const conflicts = detectNumericScopeConflicts([
      fact('计划工期180日历天', '招标文件正文'),
      fact('合同工期6个月', '清单文件'),
    ], DEFAULT_WORKFLOW_RULES);
    expect(conflicts).toEqual([]);
  });

  it('同口径词不同单位 → 冲突（天 vs 个月不可换算）', () => {
    const conflicts = detectNumericScopeConflicts([
      fact('计划工期180日历天', '招标文件正文'),
      fact('计划工期12个月', '清单文件'),
    ], DEFAULT_WORKFLOW_RULES);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].resolution).toBe('180日历天');
  });

  it('duration 单位数值（6个月）被两位降噪过滤不采', () => {
    const conflicts = detectNumericScopeConflicts([
      fact('计划工期180日历天', '招标文件正文'),
      fact('计划工期6个月', '清单文件'),
    ], DEFAULT_WORKFLOW_RULES);
    expect(conflicts).toEqual([]);
  });

  it('duration 同数值同单位 → 不冲突', () => {
    const conflicts = detectNumericScopeConflicts([
      fact('计划工期180日历天', '招标文件正文'),
      fact('合同工期180日历天', '清单文件'),
    ], DEFAULT_WORKFLOW_RULES);
    expect(conflicts).toEqual([]);
  });

  it('弱锚定（gap 超 9 字符）→ 本体胜出降级 low', () => {
    const conflicts = detectNumericScopeConflicts([
      fact('总建筑面积（以规划许可核定为准）4645㎡', '招标文件正文'),
      fact('总建筑面积4646㎡', '清单文件'),
    ], DEFAULT_WORKFLOW_RULES);
    expect(conflicts).toHaveLength(1);
    // 胜出方 gapLength 12 > 9 → ontological → low
    expect(conflicts[0].confidence).toBe('low');
  });

  it('五口径同时检测', () => {
    const conflicts = detectNumericScopeConflicts([
      fact('总建筑面积4645㎡ 合同估算价500万元 计划工期180日历天 总层数6层 机动车位200个', '招标文件正文'),
      fact('总建筑面积4646㎡ 合同估算价510万元 计划工期150日历天 总层数7层 机动车位210个', '清单文件'),
    ], DEFAULT_WORKFLOW_RULES);
    expect(conflicts.map(item => item.kind)).toEqual(['area', 'cost', 'duration', 'floors', 'parkingSpaces']);
  });

  it('同源同口径同值去重（seen key）', () => {
    const conflicts = detectNumericScopeConflicts([
      fact('总建筑面积4645㎡，另注总建筑面积4645㎡', '招标文件正文'),
      fact('总建筑面积4646㎡', '清单文件'),
    ], DEFAULT_WORKFLOW_RULES);
    expect(conflicts[0].values).toHaveLength(2);
  });

  it('同优先级双值无法裁决 → resolution undefined', () => {
    const conflicts = detectNumericScopeConflicts([
      fact('总建筑面积4645㎡', '招标公告'),
      fact('总建筑面积4646㎡', '投标人须知'),
    ], DEFAULT_WORKFLOW_RULES);
    // 两文件都命中「招标|公告」→ 同 priority 85，锚点评分相同 → 无法裁决
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].resolution).toBeUndefined();
  });

  it('子项口径负向后顾：地上/地下分层数值不进入裁决组', () => {
    const conflicts = detectNumericScopeConflicts([
      fact('地上建筑面积24783.39平方米，地下建筑面积3786.97平方米', '招标文件正文'),
      fact('总建筑面积28570.36平方米', '清单文件'),
    ], DEFAULT_WORKFLOW_RULES);
    expect(conflicts).toEqual([]);
  });

  it('工期含违约条款句也采（提取层不判语义）', () => {
    const conflicts = detectNumericScopeConflicts([
      fact('合同工期365日历天', '招标文件正文'),
      fact('计划工期365日历天', '清单文件'),
    ], DEFAULT_WORKFLOW_RULES);
    expect(conflicts).toEqual([]);
  });

  it('values 按 value+unit+sourceFile 去重保序', () => {
    const conflicts = detectNumericScopeConflicts([
      fact('总建筑面积4645㎡', '招标文件正文'),
      fact('总建筑面积4646㎡', '清单文件'),
      fact('总建筑面积4647㎡', '前附表'),
    ], DEFAULT_WORKFLOW_RULES);
    expect(conflicts[0].values.map(item => item.value)).toEqual(['4645', '4646', '4647']);
  });
});

// ═══════ Q4 numericScopeResolutions ═══════
describe('Q4 numericScopeResolutions', () => {
  it('空冲突 → 空 map', () => {
    expect(numericScopeResolutions([]).size).toBe(0);
  });

  it('medium 裁决收录 winnerNum 与 losers', () => {
    const conflicts: NumericScopeConflict[] = [{
      kind: 'area', scope: '建筑面积（面积口径）',
      values: [
        { value: '4645', unit: '㎡', sourceFile: '招标文件正文', priority: 85 },
        { value: '4646', unit: '㎡', sourceFile: '清单文件', priority: 75 },
      ],
      resolution: '4646㎡', confidence: 'medium',
    }];
    const res = numericScopeResolutions(conflicts);
    expect(res.has('area')).toBe(true);
    expect(res.get('area')).toEqual({ winnerNum: '4646', losers: [{ value: '4645', unit: '㎡' }] });
  });

  it('low 置信度跳过', () => {
    const conflicts: NumericScopeConflict[] = [{
      kind: 'area', scope: 's',
      values: [{ value: '4645', unit: '㎡', priority: 85 }, { value: '4646', unit: '㎡', priority: 75 }],
      resolution: '4646㎡', confidence: 'low',
    }];
    expect(numericScopeResolutions(conflicts).size).toBe(0);
  });

  it('无 resolution 跳过', () => {
    const conflicts: NumericScopeConflict[] = [{
      kind: 'area', scope: 's',
      values: [{ value: '4645', unit: '㎡', priority: 85 }, { value: '4646', unit: '㎡', priority: 85 }],
    }];
    expect(numericScopeResolutions(conflicts).size).toBe(0);
  });

  it('每 kind 只取首条', () => {
    const mk = (resolution: string): NumericScopeConflict => ({
      kind: 'area', scope: 's',
      values: [{ value: '1', unit: '㎡', priority: 85 }, { value: '2', unit: '㎡', priority: 75 }],
      resolution, confidence: 'medium',
    });
    const res = numericScopeResolutions([mk('2㎡'), mk('3㎡')]);
    expect(res.get('area')?.winnerNum).toBe('2');
  });

  it('败选值含千分位逗号 → winnerNum/losers 去逗号', () => {
    const conflicts: NumericScopeConflict[] = [{
      kind: 'cost', scope: 's',
      values: [{ value: '500', unit: '万元', priority: 85 }, { value: '5,000,000', unit: '元', priority: 75 }],
      resolution: '5,000,000元', confidence: 'medium',
    }];
    const res = numericScopeResolutions(conflicts);
    expect(res.get('cost')?.winnerNum).toBe('5000000');
    expect(res.get('cost')?.losers).toEqual([{ value: '500', unit: '万元' }]);
  });
});

// ═══════ Q5 applyScopeOverridesToText ═══════
describe('Q5 applyScopeOverridesToText', () => {
  const conflicts: NumericScopeConflict[] = [{
    kind: 'area', scope: 's',
    values: [{ value: '4645', unit: '㎡', priority: 85 }, { value: '4646', unit: '㎡', priority: 75 }],
    resolution: '4646㎡', confidence: 'medium',
  }];

  it('含单位败选值替换', () => {
    expect(applyScopeOverridesToText('总建筑面积约4645㎡', conflicts)).toBe('总建筑面积约4646㎡');
  });

  it('无单位败选值替换', () => {
    expect(applyScopeOverridesToText('面积约4645', conflicts)).toBe('面积约4646');
  });

  it('无败选值原样返回', () => {
    expect(applyScopeOverridesToText('总建筑面积约4600㎡', conflicts)).toBe('总建筑面积约4600㎡');
  });

  it('空冲突原样返回', () => {
    expect(applyScopeOverridesToText('总建筑面积约4645㎡', [])).toBe('总建筑面积约4645㎡');
  });

  it('败选值替换：精确匹配值+单位形态（单位不同的 平方米 不换）', () => {
    expect(applyScopeOverridesToText('4645㎡与4645平方米', conflicts)).toBe('4646㎡与4645平方米');
  });

  it('low 置信度裁决不参与改写', () => {
    const lowConflicts: NumericScopeConflict[] = [{ ...conflicts[0], confidence: 'low' }];
    expect(applyScopeOverridesToText('总建筑面积约4645㎡', lowConflicts)).toBe('总建筑面积约4645㎡');
  });
});

// ═══════ Q6 governEvidenceValues ═══════
describe('Q6 governEvidenceValues', () => {
  const conflicts: NumericScopeConflict[] = [{
    kind: 'area', scope: 's',
    values: [{ value: '4645', unit: '㎡', priority: 85 }, { value: '4646', unit: '㎡', priority: 75 }],
    resolution: '4646㎡', confidence: 'medium',
  }];

  it('无冲突 → 原引用返回', () => {
    const evidence = [{ content: 'a' }];
    expect(governEvidenceValues(evidence, [])).toBe(evidence);
  });

  it('有冲突但内容不变 → 元素原引用（数组为新引用）', () => {
    const evidence = [{ content: '无关内容' }];
    const result = governEvidenceValues(evidence, conflicts);
    expect(result[0]).toBe(evidence[0]);
  });

  it('内容含败选值 → 新对象', () => {
    const evidence = [{ content: '总建筑面积约4645㎡' }];
    const result = governEvidenceValues(evidence, conflicts);
    expect(result).not.toBe(evidence);
    expect(result[0].content).toBe('总建筑面积约4646㎡');
  });
});

// ═══════ Q7 renderScopeOverrideAnchors ═══════
describe('Q7 renderScopeOverrideAnchors', () => {
  const base = (confidence: NumericScopeConflict['confidence'], resolution?: string): NumericScopeConflict => ({
    kind: 'area', scope: '建筑面积（面积口径）',
    values: [{ value: '4645', unit: '㎡', priority: 85 }, { value: '4646', unit: '㎡', priority: 75 }],
    resolution, confidence,
  });

  it('无 resolution → 不产出锚点', () => {
    expect(renderScopeOverrideAnchors([base(undefined)])).toEqual([]);
  });

  it('high → 强制约束措辞', () => {
    const lines = renderScopeOverrideAnchors([base('high', '4646㎡')]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe('建筑面积（面积口径）必须统一为 4646㎡（补疑/答疑/澄清类修正文件权威最高；4645㎡ 已被修正，正文禁止出现）');
  });

  it('medium → 建议措辞', () => {
    const lines = renderScopeOverrideAnchors([base('medium', '4646㎡')]);
    expect(lines[0]).toBe('建筑面积（面积口径）应统一为 4646㎡（按资料来源优先级裁决；4645㎡ 为败选值，正文避免使用）');
  });

  it('low → 人工复核措辞', () => {
    const lines = renderScopeOverrideAnchors([base('low', '4646㎡')]);
    expect(lines[0]).toBe('建筑面积（面积口径）参考口径为 4646㎡（锚定较弱，请人工复核；4645㎡ 不参与自动改写）');
  });

  it('多败选值顿号连接', () => {
    const conflict: NumericScopeConflict = {
      kind: 'area', scope: 's', confidence: 'medium', resolution: '4647㎡',
      values: [
        { value: '4645', unit: '㎡', priority: 85 },
        { value: '4646', unit: '㎡', priority: 80 },
        { value: '4647', unit: '㎡', priority: 75 },
      ],
    };
    const lines = renderScopeOverrideAnchors([conflict]);
    expect(lines[0]).toContain('4645㎡、4646㎡ 为败选值');
  });

  it('多冲突逐条产出', () => {
    const second: NumericScopeConflict = {
      kind: 'cost', scope: '金额（金额口径）', confidence: 'high', resolution: '510万元',
      values: [{ value: '500', unit: '万元', priority: 85 }, { value: '510', unit: '万元', priority: 95 }],
    };
    const lines = renderScopeOverrideAnchors([base('high', '4646㎡'), second]);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('金额（金额口径）必须统一为 510万元');
  });
});

// ═══════ Q8 applyScopeConflictResolutions ═══════
describe('Q8 applyScopeConflictResolutions', () => {
  const conflicts: NumericScopeConflict[] = [{
    kind: 'area', scope: 's',
    values: [{ value: '4645', unit: '㎡', priority: 85 }, { value: '4646', unit: '㎡', priority: 75 }],
    resolution: '4646㎡', confidence: 'medium',
  }];

  it('无 resolutions → 原引用返回', () => {
    const facts = [fact('总建筑面积4645㎡', '招标文件正文')];
    expect(applyScopeConflictResolutions(facts, [])).toBe(facts);
  });

  it('area 匹配事实值 → 保单位改写', () => {
    const result = applyScopeConflictResolutions([
      fact('总建筑面积约4645㎡', '招标文件正文'),
      fact('总建筑面积约4645平方米', '招标文件正文'),
    ], conflicts);
    expect(result[0].value).toBe('总建筑面积约4646㎡');
    expect(result[1].value).toBe('总建筑面积约4646平方米');
  });

  it('key 命中（project_scale）也改写', () => {
    const result = applyScopeConflictResolutions([
      fact('4645㎡', '招标文件正文', { key: 'project_scale' }),
    ], conflicts);
    expect(result[0].value).toBe('4646㎡');
  });

  it('无关字段不变', () => {
    const result = applyScopeConflictResolutions([
      fact('计划工期180日历天', '招标文件正文', { key: 'schedule_requirement' }),
    ], conflicts);
    expect(result[0].value).toBe('计划工期180日历天');
  });

  it('low 裁决不改写', () => {
    const lowConflicts: NumericScopeConflict[] = [{ ...conflicts[0], confidence: 'low' }];
    const result = applyScopeConflictResolutions([fact('总建筑面积4645㎡', '招标文件正文')], lowConflicts);
    expect(result[0].value).toBe('总建筑面积4645㎡');
  });

  it('cost 口径按 kind 正则匹配改写', () => {
    const costConflicts: NumericScopeConflict[] = [{
      kind: 'cost', scope: 's',
      values: [{ value: '500', unit: '万元', priority: 85 }, { value: '510', unit: '万元', priority: 75 }],
      resolution: '510万元', confidence: 'medium',
    }];
    const result = applyScopeConflictResolutions([
      fact('合同估算价500万元', '招标文件正文'),
      fact('项目总投资约500万元', '招标文件正文', { key: 'project_cost' }),
    ], costConflicts);
    expect(result[0].value).toBe('合同估算价510万元');
    expect(result[1].value).toBe('项目总投资约510万元');
  });
});
