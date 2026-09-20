/**
 * 4.27.0 A1/A2 数值冲突裁决器单测：三分支裁决（双条目误报豁免/单锚锁值硬替换/无锚保留 LLM）+
 * A2 规格错位唯一权威硬替换 + 复检回滚（giveUpOnFailure 语义：宁可交 LLM 不做半吊子替换）。
 * 语义通道 mock（本地 bge 概念聚类由 embedDocuments mock 决定，与 parameterConceptConflicts.test 同口径）；
 * conceptConflictGroups 包裹式 mock：默认走真实扫描（集成口径），回滚用例按扫描序列注入残留组。
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ParameterConceptConflictsModule from '@/services/document-workflow/parameterConceptConflicts';
import type { ConceptConflictGroup, ConceptConflictScan } from '@/services/document-workflow/parameterConceptConflicts';
import type { BillFactLock, BillFactLockEntry } from '@/services/document-workflow/billFactLock';
import type { SpecAuthorityMap } from '@/services/document-workflow/types';
import type * as SemanticSimilarityModule from '@/services/document-workflow/semanticSimilarity';

const scanMock = vi.hoisted(() => vi.fn<(markdown: string) => Promise<ConceptConflictScan>>());
const embedMock = vi.hoisted(() => vi.fn<(texts: string[]) => Promise<number[][]>>());

vi.mock('@/services/document-workflow/semanticSimilarity', async (importOriginal) => {
  const actual = await importOriginal<typeof SemanticSimilarityModule>();
  return { ...actual, getLocalSemanticProvider: () => ({ embedDocuments: embedMock }) };
});

vi.mock('@/services/document-workflow/parameterConceptConflicts', async (importOriginal) => {
  const actual = await importOriginal<typeof ParameterConceptConflictsModule>();
  return { ...actual, conceptConflictGroups: scanMock };
});

import { arbitrateNumericConflicts } from '@/services/document-workflow/numericConflictArbiter';

let realGroups: typeof ParameterConceptConflictsModule.conceptConflictGroups;

beforeAll(async () => {
  const actual = await vi.importActual<typeof ParameterConceptConflictsModule>('@/services/document-workflow/parameterConceptConflicts');
  realGroups = actual.conceptConflictGroups;
});

beforeEach(() => {
  vi.clearAllMocks();
  embedMock.mockResolvedValue([]);
  scanMock.mockImplementation(realGroups);
});

function lockEntry(overrides: Pick<BillFactLockEntry, 'name' | 'quantity' | 'unit'> & Partial<BillFactLockEntry>): BillFactLockEntry {
  return { seq: 1, description: '', section: '', subsection: '', villageGroup: '', sourceFile: 'boq.csv', specQuantityPairs: [], ...overrides };
}

function billLock(entries: BillFactLockEntry[]): BillFactLock {
  return { entries, totalEntries: entries.length, sourceFile: 'boq.csv', complete: true };
}

describe('arbitrateNumericConflicts（A1 三分支）', () => {
  it('分支①：多值分别精确命中不同清单条目 → 误报组（不替换，交检测端降级）', async () => {
    // 聚类：塑料管铺设/塑料管同簇（实测误报形态——DN200 与 DN110 两个清单条目口径）
    embedMock.mockResolvedValue([[1, 0], [1, 0], [0, 0]]);
    const markdown = '塑料管铺设8205.53m。塑料管7525.01m。围挡高度2.5m。';
    const result = await arbitrateNumericConflicts(markdown, {
      billFactLock: billLock([
        lockEntry({ seq: 1, name: '塑料管铺设', quantity: 8205.53, unit: 'm' }),
        lockEntry({ seq: 2, name: '塑料管', quantity: 7525.01, unit: 'm' }),
      ]),
    });
    expect(result.replacements).toEqual([]);
    expect(result.falsePositiveGroups).toHaveLength(1);
    expect(result.falsePositiveGroups[0]).toContain('塑料管铺设');
    expect(result.falsePositiveGroups[0]).toContain('塑料管');
    expect(result.noAnchorGroups).toEqual([]);
  });

  it('分支②：单锚锁值 → 非锚值硬替换（位置精确到值文本，复检通过后保留）', async () => {
    embedMock.mockResolvedValue([[1, 0], [0, 0]]);
    const markdown = '普工25人。普工45人。围挡高度2.5m。';
    const result = await arbitrateNumericConflicts(markdown, {
      billFactLock: billLock([lockEntry({ name: '普工', quantity: 45, unit: '人' })]),
    });
    expect(result.replacements).toHaveLength(1);
    expect(result.replacements[0]).toMatchObject({ start: 2, end: 4, replacement: '45' });
    expect(result.details[0]).toContain('普工');
    expect(result.details[0]).toContain('以工程量清单条目「普工」锁定口径为准');
    expect(result.noAnchorGroups).toEqual([]);
  });

  it('分支③：无清单锁 → 无锚保留（不替换，交 LLM 定向修复）', async () => {
    embedMock.mockResolvedValue([[1, 0], [0, 0]]);
    const markdown = '普工25人。普工45人。围挡高度2.5m。';
    const result = await arbitrateNumericConflicts(markdown, {});
    expect(result.replacements).toEqual([]);
    expect(result.falsePositiveGroups).toEqual([]);
    expect(result.noAnchorGroups).toHaveLength(1);
    expect(result.noAnchorGroups[0]).toContain('普工');
  });

  it('复检未清零 → 该组替换整组回滚（giveUpOnFailure：宁可交 LLM 不做半吊子替换）', async () => {
    const group: ConceptConflictGroup = {
      concept: '普工',
      values: [
        { concept: '普工', value: 25, unit: '人', raw: '普工25人', occurrences: [{ matchIndex: 0, valueOffset: 2, valueText: '25' }] },
        { concept: '普工', value: 45, unit: '人', raw: '普工45人', occurrences: [{ matchIndex: 7, valueOffset: 2, valueText: '45' }] },
      ],
    };
    // 初始扫描与复检扫描均返回同一冲突组 → 替换后复检未清零 → 整组回滚
    scanMock.mockResolvedValueOnce({ groups: [group] }).mockResolvedValueOnce({ groups: [group] });
    const markdown = '普工25人。围挡高度2.5m。';
    const result = await arbitrateNumericConflicts(markdown, {
      billFactLock: billLock([lockEntry({ name: '普工', quantity: 45, unit: '人' })]),
    });
    expect(result.replacements).toEqual([]);
    expect(result.noAnchorGroups.some(message => /复检未清零/u.test(message))).toBe(true);
    expect(result.details).toEqual([]);
  });
});

describe('arbitrateNumericConflicts（A2 规格错位）', () => {
  it('权威规则唯一 → 确定性硬替换（同部位同型规格集 size=1），复检清零后保留', async () => {
    const markdown = '垫层采用C30混凝土浇筑。';
    const specAuthorityMap: SpecAuthorityMap = {
      混凝土强度等级: [
        { location: '垫层', spec: 'C20', sourceFile: 'boq.csv' },
        { location: '垫层', spec: 'C20', sourceFile: 'boq.csv' },
      ],
    };
    const result = await arbitrateNumericConflicts(markdown, { specAuthorityMap });
    expect(result.replacements).toHaveLength(1);
    expect(result.replacements[0]).toMatchObject({ start: 4, end: 7, replacement: 'C20' });
    expect(result.details[0]).toContain('垫层');
    expect(result.noAnchorGroups).toEqual([]);
  });

  it('权威规则多义（同部位同型多规格）→ 不裁决（无替换，留 LLM 定点修复）', async () => {
    const markdown = '垫层采用C30混凝土浇筑。';
    const specAuthorityMap: SpecAuthorityMap = {
      混凝土强度等级: [
        { location: '垫层', spec: 'C20', sourceFile: 'boq.csv' },
        { location: '垫层', spec: 'C25', sourceFile: 'boq.csv' },
      ],
    };
    const result = await arbitrateNumericConflicts(markdown, { specAuthorityMap });
    expect(result.replacements).toEqual([]);
  });
});

describe('arbitrateNumericConflicts（A3 名称-数值绑定裁决，M24b）', () => {
  it('分支②：值属他条目 + 本条目权威唯一 → 硬替换（过梁位写 3.07m3 实属管道垫层 3.06m3）', async () => {
    const markdown = '过梁现浇混凝土3.07m3，管道垫层混凝土3.06m3。';
    const result = await arbitrateNumericConflicts(markdown, {
      billFactLock: billLock([
        lockEntry({ seq: 1, name: '过梁', quantity: 4.5, unit: 'm3' }),
        lockEntry({ seq: 2, name: '管道垫层', quantity: 3.06, unit: 'm3' }),
      ]),
    });
    expect(result.replacements).toHaveLength(1);
    expect(result.replacements[0]).toMatchObject({ start: 7, end: 11, replacement: '4.5' });
    expect(result.details[0]).toContain('过梁');
    expect(result.details[0]).toContain('3.07m3→4.5m3');
    expect(result.noAnchorGroups).toEqual([]);
  });

  it('r28k 回归①：DN50 位写 11.23m（实属 DN32）→ 替换为 DN50 清单权威值', async () => {
    const markdown = 'DN50管道铺设11.23m。';
    const result = await arbitrateNumericConflicts(markdown, {
      billFactLock: billLock([
        lockEntry({ seq: 1, name: 'DN50管道', quantity: 7965, unit: 'm' }),
        lockEntry({ seq: 2, name: 'DN32管道', quantity: 11.23, unit: 'm' }),
      ]),
    });
    expect(result.replacements).toHaveLength(1);
    expect(result.replacements[0]).toMatchObject({ replacement: '7965' });
    expect(result.details[0]).toContain('DN50管道');
  });

  it('r28k 回归②：灭火器位写 2套（实属垃圾箱）→ 替换为灭火器清单权威值', async () => {
    const markdown = '现场配置灭火器2套。';
    const result = await arbitrateNumericConflicts(markdown, {
      billFactLock: billLock([
        lockEntry({ seq: 1, name: '灭火器', quantity: 30, unit: '套' }),
        lockEntry({ seq: 2, name: '垃圾箱', quantity: 2, unit: '套' }),
      ]),
    });
    expect(result.replacements).toHaveLength(1);
    expect(result.replacements[0]).toMatchObject({ replacement: '30' });
    expect(result.details[0]).toContain('灭火器');
  });

  it('分支①：值 ∈ 本条目量集（转写宽容截断）→ 一致（跳过，不替换）', async () => {
    const markdown = '过梁现浇混凝土4m3。';
    const result = await arbitrateNumericConflicts(markdown, {
      billFactLock: billLock([lockEntry({ seq: 1, name: '过梁', quantity: 4.5, unit: 'm3' })]),
    });
    expect(result.replacements).toEqual([]);
    expect(result.noAnchorGroups).toEqual([]);
  });

  it('分支③：同名多条无法裁决替换目标 → 无锚留 LLM（附全条目量清单）', async () => {
    const markdown = '过梁现浇混凝土3.07m3。';
    const result = await arbitrateNumericConflicts(markdown, {
      billFactLock: billLock([
        lockEntry({ seq: 1, name: '过梁', quantity: 4.5, unit: 'm3' }),
        lockEntry({ seq: 2, name: '过梁', quantity: 5.2, unit: 'm3' }),
        lockEntry({ seq: 3, name: '管道垫层', quantity: 3.06, unit: 'm3' }),
      ]),
    });
    expect(result.replacements).toEqual([]);
    expect(result.noAnchorGroups).toHaveLength(1);
    expect(result.noAnchorGroups[0]).toContain('过梁');
    expect(result.noAnchorGroups[0]).toContain('2 条');
  });

  it('单位不兼容：值属他条目但本条目权威单位不同 → 不动（不跨量纲替换）', async () => {
    const markdown = '灭火器配置2个。';
    const result = await arbitrateNumericConflicts(markdown, {
      billFactLock: billLock([
        lockEntry({ seq: 1, name: '灭火器', quantity: 30, unit: '套' }),
        lockEntry({ seq: 2, name: '垃圾箱', quantity: 2, unit: '个' }),
      ]),
    });
    expect(result.replacements).toEqual([]);
    expect(result.noAnchorGroups).toEqual([]);
  });

  it('替换后值撞他条目量集不误回滚（复检与候选同源：值 ∈ 本条目量集即收敛）', async () => {
    const markdown = '过梁现浇混凝土3.07m3。';
    const result = await arbitrateNumericConflicts(markdown, {
      billFactLock: billLock([
        lockEntry({ seq: 1, name: '过梁', quantity: 4.5, unit: 'm3' }),
        lockEntry({ seq: 2, name: '圈梁', quantity: 4.5, unit: 'm3' }),
        lockEntry({ seq: 3, name: '管道垫层', quantity: 3.06, unit: 'm3' }),
      ]),
    });
    expect(result.replacements).toHaveLength(1);
    expect(result.replacements[0]).toMatchObject({ replacement: '4.5' });
    expect(result.noAnchorGroups).toEqual([]);
  });

  it('槽位词豁免同源：名称后厚度类工艺参数不参与绑定裁决', async () => {
    const markdown = '过梁高度3.07m，管道垫层3.06m3。';
    const result = await arbitrateNumericConflicts(markdown, {
      billFactLock: billLock([
        lockEntry({ seq: 1, name: '过梁', quantity: 4.5, unit: 'm3' }),
        lockEntry({ seq: 2, name: '管道垫层', quantity: 3.06, unit: 'm3' }),
      ]),
    });
    expect(result.replacements).toEqual([]);
  });
});
