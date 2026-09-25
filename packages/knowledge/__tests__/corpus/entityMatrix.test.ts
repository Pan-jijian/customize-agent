/**
 * 实体级真实语料矩阵（目标 **≥100,000 用例**；用户定的基本原则：**每类各自十万加**）。
 *
 * 数据源：真实知识库 `kb_material_entities` 的 CAD 实体（全量 504,002 条，本文件取前 100,000 条）。
 * 每条实体一个用例，断言归一层的核心不变式——失败信息自带数据坐标（哪条实体、哪个文件），
 * 这是聚合断言做不到的（聚合失败只说"有不满足的"，不说"是哪条"）。
 */
import { describe, expect, it } from 'vitest';
import { annotationFacts, factKey, type CadEntity, type SourceAnchor } from '../../src/index.js';
import { dbAvailable, loadEntities } from './loader.js';

const ENTITY_CASES = 504_500;   // 全量实体（真实库 504,002 条）
const rows = dbAvailable ? loadEntities(ENTITY_CASES) : [];

describe.skipIf(!dbAvailable)('4.61 实体级真实语料矩阵（全量 504,002 条实体）', () => {
  it('实体取样规模（空集会令下方全部用例空过——故这条自检必须存在）', () => {
    expect(rows.length).toBeGreaterThan(400_000);
  });

  it.each(rows.map((row, index) => [index, row] as const))(
    '实体 #%i：标注归一事实满足不变式（键含域 / 主体与值非空 / 关系合法 / 记账不静默）',
    (_index, row) => {
      const anchorOf = (entity: CadEntity): SourceAnchor => ({
        filePath: row.file,
        carrier: 'drawing-annotation',
        sheet: entity.sheet,
        layer: entity.layer,
        entityType: entity.entityType,
        position: entity.position,
      });
      const { facts, failures } = annotationFacts({ entities: [row.entity], anchorOf });
      for (const fact of facts) {
        expect(fact.subject.length, '主体不得为空').toBeGreaterThan(0);
        expect(fact.value.length, '值不得为空').toBeGreaterThan(0);
        expect(fact.key, '裁决键必须含域前缀（跨域禁比的实现基础）').toContain('\u0000');
        expect(fact.key).toBe(factKey(fact.domain, fact.subject, fact.attribute));
        expect(['=', '>=', '<=', 'range', 'enum', 'text']).toContain(fact.relation);
      }
      // 不变式 6：绑定失败必须记账，不得静默吞掉
      for (const failure of failures) expect(failure.detail.length).toBeGreaterThan(0);
    },
  );
});
