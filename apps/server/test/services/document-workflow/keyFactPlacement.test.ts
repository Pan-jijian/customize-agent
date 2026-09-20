/**
 * keyFactPlacement 单测（C-T7）：关键事实落位审计——须落位清单收集（基础 8 项规格过滤 / 清洗链 /
 * 占位与坏值剔除 / BOQ 守卫 / 去重）与落位判定（factValueAppears 命中率；#4 名称+编号拆分、
 * #50 标签前缀剥离均为验收口径用例）。
 */
import { describe, expect, it } from 'vitest';
import {
  buildKeyFactPlacementAudit, collectKeyPlacementFacts, KEY_FACT_PLACEMENT_SPEC_KEYS,
} from '@/services/document-workflow/keyFactPlacement';
import type { DocumentFact } from '@/services/document-workflow/types';

/** 关键事实 fixture：fieldId 命中 PROJECT_BASIC_FIELD_SPECS（key 直接相等）；机构类字段传中文 fieldName 以命中坏值守卫 */
function keyFact(fieldId: string, value: string, extra: Partial<DocumentFact> = {}): DocumentFact {
  return {
    key: fieldId,
    fieldId,
    fieldName: fieldId,
    value,
    sourceFile: '资料/招标文件.pdf',
    roleId: 'project_basic',
    confidence: 90,
    ...extra,
  };
}

describe('collectKeyPlacementFacts 须落位清单收集（C-T7）', () => {
  it('仅保留基础 8 项规格；P2 治理扩围字段不入基础清单', () => {
    const pool = collectKeyPlacementFacts([
      keyFact('project_name', '某镇宜居自然村建设项目'),
      keyFact('owner', '某镇人民政府', { fieldName: '招标人' }),
      keyFact('labor_peak', '120人', { fieldName: '劳动力高峰人数' }),
      keyFact('assembly_rate', '30%', { fieldName: '装配率' }),
    ]);
    expect(pool.map(item => item.key)).toEqual(['project_name', 'owner']);
    expect(KEY_FACT_PLACEMENT_SPEC_KEYS).toHaveLength(8);
  });

  it('值清洗链单源：标签前缀剥离（#50）+ 名称编号连读拆分（#4）', () => {
    const pool = collectKeyPlacementFacts([
      keyFact('owner', '招标人：某镇人民政府', { fieldName: '招标人' }),
      keyFact('project_name', '某镇宜居自然村建设项目2.2招标项目编号：2026AEEGZ50048'),
    ]);
    expect(pool).toEqual([
      { key: 'owner', label: '招标人', value: '某镇人民政府' },
      { key: 'project_name', label: '项目名称', value: '某镇宜居自然村建设项目' },
    ]);
  });

  it('占位值与坏值剔除（不构成须落位义务）', () => {
    const pool = collectKeyPlacementFacts([
      keyFact('owner', '资料未明确', { fieldName: '招标人' }),
      keyFact('quality_standard', '无', { fieldName: '质量标准' }),
      keyFact('owner', '将报公共资源交易监督管理部门', { fieldName: '招标人' }),
    ]);
    expect(pool).toEqual([]);
  });

  it('清单表「项目名称」列值（table 来源）不作落位候选（与 fact-coverage 同口径）', () => {
    const pool = collectKeyPlacementFacts([
      keyFact('project_name', '土方开挖', { fieldName: '工程名称', processingType: 'table' }),
      keyFact('project_name', '某镇宜居自然村建设项目'),
    ]);
    expect(pool.map(item => item.value)).toEqual(['某镇宜居自然村建设项目']);
  });

  it('同规格同清洗值去重；空池与空条目安全', () => {
    const duplicated = [
      keyFact('owner', '某镇人民政府', { fieldName: '招标人' }),
      keyFact('owner', '招标人：某镇人民政府', { fieldName: '招标人' }),
    ];
    expect(collectKeyPlacementFacts(duplicated)).toHaveLength(1);
    expect(collectKeyPlacementFacts([])).toEqual([]);
    expect(collectKeyPlacementFacts(undefined)).toEqual([]);
    expect(collectKeyPlacementFacts(null)).toEqual([]);
    expect(collectKeyPlacementFacts([null, undefined])).toEqual([]);
  });
});

describe('buildKeyFactPlacementAudit 落位判定（C-T7 验收口径）', () => {
  it('全部关键事实落位：rate=1（C-T7 验收判据）', () => {
    const facts = [
      keyFact('project_name', '某镇宜居自然村建设项目'),
      keyFact('project_code', '2026AEEGZ50048', { fieldName: '项目编号' }),
      keyFact('owner', '某镇人民政府', { fieldName: '招标人' }),
    ];
    const markdown = '本工程为某镇宜居自然村建设项目，项目编号2026AEEGZ50048，招标人为某镇人民政府。';
    const audit = buildKeyFactPlacementAudit(markdown, facts);
    expect(audit).toEqual({ specs: 3, placed: 3, unplaced: [], rate: 1 });
  });

  it('未落位明细按规格声明序输出（标签：值），rate 为已落位占比', () => {
    const facts = [
      keyFact('project_name', '某镇宜居自然村建设项目'),
      keyFact('owner', '某镇人民政府', { fieldName: '招标人' }),
      keyFact('quality_standard', '合格', { fieldName: '质量标准' }),
    ];
    const audit = buildKeyFactPlacementAudit('本工程为某镇宜居自然村建设项目。', facts);
    expect(audit?.specs).toBe(3);
    expect(audit?.placed).toBe(1);
    expect(audit?.unplaced).toEqual(['招标人：某镇人民政府', '质量标准：合格']);
    expect(audit?.rate).toBeCloseTo(1 / 3);
  });

  it('#4 名称+编号连读值拆分后判定落位（尾部编号粘连不误报）', () => {
    const facts = [keyFact('project_name', '某镇宜居自然村建设项目2.2招标项目编号：2026AEEGZ50048')];
    const audit = buildKeyFactPlacementAudit('本工程为某镇宜居自然村建设项目。', facts);
    expect(audit).toEqual({ specs: 1, placed: 1, unplaced: [], rate: 1 });
  });

  it('#50 标签前缀混入值按纯值判定落位（基本信息表行口径）', () => {
    const facts = [keyFact('owner', '招标人：某镇人民政府', { fieldName: '招标人' })];
    const audit = buildKeyFactPlacementAudit('本工程接受建设单位管理，建设单位为某镇人民政府。', facts);
    expect(audit).toEqual({ specs: 1, placed: 1, unplaced: [], rate: 1 });
  });

  it('空池显式降级：无有值关键事实时返回 undefined', () => {
    expect(buildKeyFactPlacementAudit('# 正文', [])).toBeUndefined();
    expect(buildKeyFactPlacementAudit('# 正文', undefined)).toBeUndefined();
    expect(buildKeyFactPlacementAudit('# 正文', [keyFact('owner', '资料未明确', { fieldName: '招标人' })])).toBeUndefined();
  });
});
