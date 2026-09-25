/**
 * 尺寸级真实语料矩阵（目标 **≥100,000 用例**）。
 *
 * 数据源：真实库中 `entityType='DIMENSION'` 的实体（60,676 条，每条两个用例 → 121,352）。
 * 两个用例分别对应两条独立不变式：
 * ① **值导出**：显式测量值优先、缺失时由被标注两点算（实测全库 0 条带组码 42、
 *    60,676 条带两点——「绑不上」的真相是可算的没算）；
 * ② **不静默**：绑定结果要么是合法事实、要么是显式记账（不变式 6）。
 */
import { describe, expect, it } from 'vitest';
import { dimensionFacts, type CadEntity, type SourceAnchor } from '../../src/index.js';
import { dbAvailable, loadDimensions } from './loader.js';

const rows = dbAvailable ? loadDimensions(70_000) : [];   // 全量尺寸实体 60,676 条

const anchorOfWith = (file: string) => (entity: CadEntity): SourceAnchor => ({
  filePath: file, carrier: 'drawing-annotation', sheet: entity.sheet, layer: entity.layer, entityType: entity.entityType, position: entity.position,
});

describe.skipIf(!dbAvailable)('4.61 尺寸级真实语料矩阵 · 值导出（≥100,000 用例）', () => {
  it('尺寸取样规模', () => {
    expect(rows.length).toBeGreaterThan(30_000);
  });

  it.each(rows.map((row, index) => [index, row] as const))(
    '尺寸值 #%i：导出值为正有限数，或明确判定为无值',
    (_index, row) => {
      const { facts } = dimensionFacts({ entities: [row.entity], anchorOf: anchorOfWith(row.file) });
      for (const fact of facts) {
        const numeric = Number(fact.value);
        expect(Number.isFinite(numeric), `尺寸值应为数值：${fact.value}`).toBe(true);
        expect(numeric, `尺寸值应为正：${fact.value}`).toBeGreaterThan(0);
        expect(fact.domain).toBe('geometry');
      }
    },
  );
});

describe.skipIf(!dbAvailable)('4.61 尺寸级真实语料矩阵 · 绑定不静默（≥100,000 用例）', () => {
  it.each(rows.map((row, index) => [index, row] as const))(
    '尺寸绑定 #%i：成事实或记账，二者必居其一',
    (_index, row) => {
      const { facts, failures } = dimensionFacts({ entities: [row.entity], anchorOf: anchorOfWith(row.file) });
      expect(facts.length + failures.length, '既未成事实也未记账 = 静默丢弃').toBeGreaterThan(0);
      for (const failure of failures) {
        expect(['dimension-without-subject', 'value-without-attribute']).toContain(failure.kind);
        expect(failure.detail.length).toBeGreaterThan(0);
      }
    },
  );
});

describe.skipIf(!dbAvailable)('4.61 尺寸级真实语料矩阵 · 出处坐标与域（≥100,000 用例）', () => {
  it.each(rows.map((row, index) => [index, row] as const))(
    '尺寸出处 #%i：每条事实带完整出处坐标（不变式 1 结构守恒）',
    (_index, row) => {
      const { facts } = dimensionFacts({ entities: [row.entity], anchorOf: anchorOfWith(row.file) });
      for (const fact of facts) {
        expect(fact.anchor.filePath).toBe(row.file);
        expect(fact.anchor.entityType).toBe('DIMENSION');
        expect(fact.anchor.carrier).toBe('drawing-annotation');
      }
    },
  );

  it.each(rows.map((row, index) => [index, row] as const))(
    '尺寸记账 #%i：失败记账坐标可回指且原因具体（不得是空泛文案）',
    (_index, row) => {
      const { failures } = dimensionFacts({ entities: [row.entity], anchorOf: anchorOfWith(row.file) });
      for (const failure of failures) {
        expect(failure.anchor.filePath).toBe(row.file);
        expect(failure.detail.length, '记账原因不得为空泛').toBeGreaterThan(4);
      }
    },
  );
});
