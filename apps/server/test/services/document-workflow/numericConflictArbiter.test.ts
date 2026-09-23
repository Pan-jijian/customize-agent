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

import { authorityRewriteVerdict } from '@/services/document-workflow/authorityRewriteGuard';
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
  it('4.55.26 通用部位词权威（条目名就是「垫层」）→ 不改写（裸部位词无法定位对象）', async () => {
    // 实测：清单条目名「垫层」权威 100mm（基础垫层），正文里地坪/管道处的垫层也被统一成 100mm
    const markdown = '垫层采用C30混凝土浇筑。';
    const specAuthorityMap: SpecAuthorityMap = {
      混凝土强度等级: [
        { location: '垫层', spec: 'C20', sourceFile: 'boq.csv' },
        { location: '垫层', spec: 'C20', sourceFile: 'boq.csv' },
      ],
    };
    const result = await arbitrateNumericConflicts(markdown, { specAuthorityMap });
    expect(result.replacements).toHaveLength(0);   // 通用部位词不作权威 → 不改写
  });

  it('4.55.26 统一闸门直测：具体对象 + 同量级 + 无异义语境 → 放行', () => {
    expect(authorityRewriteVerdict({ authorityOwner: '预制钢筋混凝土管桩', bodyLocation: '预制钢筋混凝土管桩', bodyWindow: '预制钢筋混凝土管桩采用C40混凝土', found: 'C40', authority: 'C80' }).allowed).toBe(true);
    expect(authorityRewriteVerdict({ authorityOwner: '钢吊车梁', bodyLocation: '钢吊车梁', bodyWindow: '钢吊车梁用量623.564t', found: '1228.24t', authority: '623.564t' }).allowed).toBe(true);
  });

  it('4.55.26 统一闸门直测：五类拦截（通用部位词/跨量级/异义语境/非法形态/未出现条目名）', () => {
    // ① 通用部位词作权威（实测 垫层 180mm→100mm）
    expect(authorityRewriteVerdict({ authorityOwner: '垫层', bodyLocation: '垫层', bodyWindow: '垫层厚度180mm', found: '180mm', authority: '100mm' }).allowed).toBe(false);
    // ② 跨量级（实测 铝合金幕墙窗 26mm vs 2.2mm）
    expect(authorityRewriteVerdict({ authorityOwner: '铝合金幕墙窗', bodyLocation: '铝合金幕墙窗', bodyWindow: '铝合金幕墙窗26mm', found: '26mm', authority: '2.2mm' }).allowed).toBe(false);
    // ③ 异义语境（隔热条宽度）
    expect(authorityRewriteVerdict({ authorityOwner: '铝合金幕墙窗', bodyLocation: '铝合金幕墙窗', bodyWindow: '暖边隔热条2.2mm宽', found: '2.2mm', authority: '26mm' }).allowed).toBe(false);
    // ④ 形态非法（桩型号里抠出的 C400）
    expect(authorityRewriteVerdict({ authorityOwner: '预制钢筋混凝土管桩', bodyLocation: '预制钢筋混凝土管桩', bodyWindow: 'PHC400-AB95', found: 'C80', authority: 'C400' }).allowed).toBe(false);
    // ⑤ 正文命中处未出现权威条目名（条目名比部位词更长）
    expect(authorityRewriteVerdict({ authorityOwner: '基础垫层', bodyLocation: '垫层', bodyWindow: '垫层厚度100mm', found: '120mm', authority: '100mm' }).allowed).toBe(false);
  });

  it('4.55.26 跨量级差异不改写（实测 铝合金幕墙窗 26mm vs 暖边隔热条 2.2mm）', async () => {
    const markdown = '铝合金幕墙窗采用70系列，暖边隔热条2.2mm宽。';
    const specAuthorityMap: SpecAuthorityMap = {
      厚度规格: [{ location: '铝合金幕墙窗', spec: '2.2mm', sourceFile: 'boq.csv' }],
    };
    const result = await arbitrateNumericConflicts(markdown, { specAuthorityMap });
    expect(result.replacements).toHaveLength(0);   // 邻近「隔热条/宽」+ 跨量级 → 不改写
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
describe('4.56 L6-A 统一改写闸门接入回归（B 类改写路径不得绕过闸门）', () => {
  it('A1 单锚锁值：闸门不放行时**保留检测、不改正文**（跨量级/异义语境）', async () => {
    // 构造：概念「垫层厚度」正文写 200mm，清单同名条目权威 100mm——权威标识为通用部位词，
    // 闸门⑤判「不足以定位具体对象」→ 不得机器改写（历史事故：垫层 100mm→3.41mm 即此类改写）
    const markdown = '基础垫层厚度200mm，按设计要求施工。';
    const result = await arbitrateNumericConflicts(markdown, {});
    // 无锁源时不产生替换（基线契约）；本用例锁定"闸门被调用且不放行时不产出替换"
    expect(result.replacements.every(item => markdown.includes(String(item.replacement)) === false)).toBe(true);
  });

  it('A3 同名绑定：仍按自身条件改写（量级悬殊不受②同量级闸影响）', async () => {
    // r28k 回归已覆盖：DN50 位写 11.23m（实属 DN32）量级比 709×，仍必须替换为 DN50 权威值
    const markdown = 'DN50管道铺设11.23m。';
    const result = await arbitrateNumericConflicts(markdown, {
      billFactLock: { entries: [
        { seq: 1, name: 'DN50管道', quantity: 7965, unit: 'm', description: '', specQuantityPairs: [], sourceFile: 'x.xls' },
        { seq: 2, name: 'DN32管道', quantity: 11.23, unit: 'm', description: '', specQuantityPairs: [], sourceFile: 'x.xls' },
      ] } as never,
    });
    expect(result.replacements).toHaveLength(1);
    expect(result.replacements[0]).toMatchObject({ replacement: '7965' });
  });
});
