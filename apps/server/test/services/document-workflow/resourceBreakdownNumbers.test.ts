/**
 * A3 资源章数值拆分一致性单源单测（4.27.0）：
 * - scanResourceBreakdownClaims：三类模式（工种构成/机械台数/材料拆分）检出与豁免口径；
 *   阶段部署子窗口豁免（基线「亮化与收尾工程阶段投入43人…普工25人…混凝土工10人…管道工5人…绿化工3人」，
 *   25+10+5+3=43 恰为该阶段总人数属退场期部署非全项目构成漂移；该段位于劳动力总说明混合大块末段，
 *   整块合计因混有 168/85/216 阶段说明而失配，故按 [阶段匹配, 下一阶段匹配或块尾) 子窗口判定）；
 *   机械分配语境不误采（基线「其中3台」「1台转入」由 12 字无锚定搜索误采，锚定「名称后 ≤2 桥接字」后不误采）。
 * - fixResourceBreakdownNumbers：定点硬替换 + 复检（复检残留整体回滚）；幂等零残留。
 */
import { describe, expect, it } from 'vitest';
import { buildResourceBreakdownAuthority, fixResourceBreakdownNumbers, scanResourceBreakdownClaims } from '@/services/document-workflow/resourceBreakdownNumbers';
import type { BlueprintData } from '@/services/document-workflow/integratedBlueprint';

function blueprint(labor: unknown, equipment: unknown[] = [], materialsPlan: unknown[] = []): BlueprintData {
  return { resources: { labor, equipment }, materialsPlan } as unknown as BlueprintData;
}

function authorityOf(labor: unknown, equipment: unknown[] = [], materialsPlan: unknown[] = []) {
  const authority = buildResourceBreakdownAuthority(blueprint(labor, equipment, materialsPlan));
  if (!authority) throw new Error('authority 构造失败');
  return authority;
}

describe('scanResourceBreakdownClaims 阶段部署子窗口豁免（A3 基线形态）', () => {
  it('退场期部署段（25+10+5+3=43=阶段总数）→ 整段豁免零检出', () => {
    const authority = authorityOf({ composition: [
      { trade: '普工', count: 45, basis: '' },
      { trade: '混凝土工', count: 88, basis: '' },
      { trade: '管道工', count: 34, basis: '' },
      { trade: '绿化工', count: 48, basis: '' },
    ] });
    const markdown = '亮化与收尾工程阶段投入43人，为退场收口期。普工25人负责收尾整修，混凝土工10人负责零星构件，管道工5人配合排查，绿化工3人进行场地恢复。';
    expect(scanResourceBreakdownClaims(markdown, authority)).toEqual([]);
  });

  it('阶段总数与工种合计不等 → 不豁免、照常检出', () => {
    const authority = authorityOf({ composition: [
      { trade: '普工', count: 45, basis: '' },
      { trade: '混凝土工', count: 88, basis: '' },
    ] });
    const markdown = '亮化与收尾工程阶段投入43人，为退场收口期。普工25人负责收尾整修，混凝土工10人负责零星构件。';
    const claims = scanResourceBreakdownClaims(markdown, authority);
    expect(claims.map(claim => claim.actual).sort((left, right) => left - right)).toEqual([10, 25]);
  });

  it('无阶段词的构成漂移 → 检出（豁免层不扩大）', () => {
    const authority = authorityOf({ composition: [{ trade: '混凝土工', count: 88, basis: '' }] });
    const claims = scanResourceBreakdownClaims('主体结构施工高峰期投入混凝土工10人。', authority);
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ kind: 'trade', actual: 10, expected: 88 });
  });

  it('混合大块（基线形态）：多阶段说明 + 末段 43 人部署明细 → 仅部署子窗口豁免', () => {
    const authority = authorityOf({ composition: [
      { trade: '普工', count: 45, basis: '' },
      { trade: '混凝土工', count: 88, basis: '' },
      { trade: '管道工', count: 34, basis: '' },
      { trade: '绿化工', count: 48, basis: '' },
    ] });
    const markdown = '施工准备与清杂拆除阶段投入168人，其中普工45人全部进场，承担场地清杂；混凝土工投入60人，提前介入拆除路面。亮化与收尾工程阶段投入43人，为退场收口期。普工25人负责收尾整修；混凝土工10人负责零星构件；管道工5人配合排查；绿化工3人进行场地恢复。第88日完成转段清点。';
    expect(scanResourceBreakdownClaims(markdown, authority)).toEqual([]);
  });

  it('混合大块：阶段子窗口合计不匹配 → 不豁免，真实漂移照常检出（防借阶段词漏修）', () => {
    const authority = authorityOf({ composition: [{ trade: '混凝土工', count: 88, basis: '' }] });
    const markdown = '施工准备与清杂拆除阶段投入168人，其中混凝土工45人全部进场。亮化与收尾工程阶段投入43人，为退场收口期。普工25人负责收尾整修。';
    const claims = scanResourceBreakdownClaims(markdown, authority);
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ kind: 'trade', actual: 45, expected: 88 });
  });
});

describe('scanResourceBreakdownClaims 机械分配语境（A3 基线误采回归）', () => {
  it('「其中3台」「1台转入」分配语境 → 不误采', () => {
    const authority = authorityOf({ composition: [] }, [{ name: '挖掘机', quantity: 5, spec: '' }]);
    const markdown = '施工准备与清杂拆除阶段投入全部5台挖掘机，其中3台用于房前屋后整理与清杂，2台用于拆除路面及基层。污水管网工程阶段保留5台挖掘机用于沟槽开挖，1台转入沟塘清淤与淤泥流砂开挖。';
    expect(scanResourceBreakdownClaims(markdown, authority)).toEqual([]);
  });

  it('机械台数漂移锚定检出（名称后紧邻台数）', () => {
    const authority = authorityOf({ composition: [] }, [{ name: '挖掘机', quantity: 5, spec: '' }]);
    const claims = scanResourceBreakdownClaims('土方阶段配置挖掘机3台。', authority);
    expect(claims).toHaveLength(1);
    expect(claims[0]?.message).toContain('挖掘机 正文 3 台，蓝图权威 5 台');
  });

  it('「挖掘机共3台」桥接词白名单内 → 检出', () => {
    const authority = authorityOf({ composition: [] }, [{ name: '挖掘机', quantity: 5, spec: '' }]);
    expect(scanResourceBreakdownClaims('现场挖掘机共3台投入使用。', authority)).toHaveLength(1);
  });

  it('「挖掘机其中3台」桥接词白名单外 → 不误采', () => {
    const authority = authorityOf({ composition: [] }, [{ name: '挖掘机', quantity: 5, spec: '' }]);
    expect(scanResourceBreakdownClaims('现场挖掘机其中3台投入使用。', authority)).toEqual([]);
  });
});

describe('fixResourceBreakdownNumbers 定点修复与复检', () => {
  it('工种构成漂移 → 硬替换为蓝图权威 + 零残留', () => {
    const authority = authorityOf({ composition: [{ trade: '混凝土工', count: 88, basis: '' }] });
    const result = fixResourceBreakdownNumbers('主体结构施工高峰期投入混凝土工10人。', authority);
    expect(result.fixedCount).toBe(1);
    expect(result.residualCount).toBe(0);
    expect(result.markdown).toBe('主体结构施工高峰期投入混凝土工88人。');
    expect(result.details).toEqual(['工种构成 混凝土工 10→88']);
  });

  it('同工种多处偏离一轮全部收敛（不再首条 break）', () => {
    const authority = authorityOf({ composition: [{ trade: '混凝土工', count: 88, basis: '' }] });
    const result = fixResourceBreakdownNumbers('投入混凝土工10人。\n\n另处混凝土工12人。', authority);
    expect(result.fixedCount).toBe(2);
    expect(result.markdown).toBe('投入混凝土工88人。\n\n另处混凝土工88人。');
  });

  it('机械多规格语境定点修复（只改偏离规格）', () => {
    const authority = authorityOf({ composition: [] }, [{ name: '挖掘机', quantity: 2, spec: '0.6m³' }, { name: '挖掘机', quantity: 1, spec: '1.0m³' }]);
    const result = fixResourceBreakdownNumbers('配置挖掘机（0.6m³）3台、挖掘机（1.0m³）1台。', authority);
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toBe('配置挖掘机（0.6m³）2台、挖掘机（1.0m³）1台。');
  });

  it('材料拆分漂移 → 逐规格硬替换（合计行豁免不修）', () => {
    const authority = authorityOf({ composition: [] }, [], [
      { name: '一般路灯', spec: '100W', quantity: 109, unit: '套', basis: '' },
      { name: '一般路灯', spec: '120W', quantity: 9, unit: '套', basis: '' },
    ]);
    const result = fixResourceBreakdownNumbers('一般路灯 100W 111套 + 120W 7套。\n| 合计 | 一般路灯 100W+120W | 118套 |', authority);
    expect(result.fixedCount).toBe(2);
    expect(result.markdown).toContain('一般路灯 100W 109套 + 120W 9套。');
    expect(result.markdown).toContain('| 合计 | 一般路灯 100W+120W | 118套 |');
    expect(result.residualCount).toBe(0);
  });

  it('幂等：修复后重跑零命中', () => {
    const authority = authorityOf({ composition: [{ trade: '混凝土工', count: 88, basis: '' }] });
    const first = fixResourceBreakdownNumbers('投入混凝土工10人。', authority);
    const second = fixResourceBreakdownNumbers(first.markdown, authority);
    expect(second.fixedCount).toBe(0);
    expect(second.markdown).toBe(first.markdown);
  });

  it('无蓝图 → 静默零改动', () => {
    expect(buildResourceBreakdownAuthority(undefined)).toBeUndefined();
    expect(fixResourceBreakdownNumbers('混凝土工10人。')).toEqual({ markdown: '混凝土工10人。', fixedCount: 0, details: [], residualCount: 0 });
  });
});
