import { describe, expect, it } from 'vitest';
import { buildBillFactLockQueries } from '@/services/document-workflow/billFactLock';
import type { BillFactLock, BillFactLockEntry } from '@/services/document-workflow/billFactLock';

const entry = (over: Partial<BillFactLockEntry>): BillFactLockEntry => ({
  seq: 1,
  name: '',
  description: '',
  quantity: 0,
  unit: '',
  section: '',
  subsection: '',
  villageGroup: '',
  sourceFile: '清单.xls',
  specQuantityPairs: [],
  ...over,
});
const lockOf = (entries: BillFactLockEntry[]): BillFactLock => ({ entries, totalEntries: entries.length, sourceFile: '清单.xls', complete: true });

describe('buildBillFactLockQueries（D2 清单条目精确检索查询：分部轮询均衡）', () => {
  it('分部均衡：章 token 与条目分部名无词面交集时分部代表仍全部入选（历史缺陷：硬过滤整类丢弃）', () => {
    const lock = lockOf([
      entry({ seq: 1, name: '挖一般土方', quantity: 216, unit: 'm3', section: '道路工程', subsection: '新建混凝土道路' }),
      entry({ seq: 2, name: '一般路灯', description: '100W LED，高4.5m', quantity: 18, unit: '套', section: '亮化工程' }),
      entry({ seq: 3, name: '砌筑渠道', quantity: 30, unit: 'm', section: '排水工程' }),
    ]);
    const queries = buildBillFactLockQueries(lock, '主要施工方法', ['道路工程', '病害处置与凿毛分缝工艺']);
    expect(queries).toHaveLength(3);
    expect(queries.some(query => query.includes('一般路灯'))).toBe(true);
    expect(queries.some(query => query.includes('砌筑渠道'))).toBe(true);
  });

  it('章相关命中优先：命中章节 token 的分部组与组代表排在前面', () => {
    const lock = lockOf([
      entry({ seq: 1, name: '亮化支架', section: '亮化工程' }),
      entry({ seq: 2, name: '路基填筑', section: '道路工程' }),
    ]);
    const queries = buildBillFactLockQueries(lock, '道路工程', []);
    expect(queries[0]).toContain('路基填筑');
  });

  it('组内代表：含规格-数量对的条目（信息量）优先', () => {
    const lock = lockOf([
      entry({ seq: 1, name: '素土回填', quantity: 100, unit: 'm3', section: '道路工程' }),
      entry({ seq: 2, name: '水泥稳定碎石', description: 'C30', quantity: 50, unit: 'm2', section: '道路工程', specQuantityPairs: [{ spec: 'C30', quantity: '50m2' }] }),
    ]);
    const queries = buildBillFactLockQueries(lock, '道路工程', []);
    expect(queries[0]).toContain('水泥稳定碎石');
  });

  it('section 为空回退 subsection 分组', () => {
    const lock = lockOf([
      entry({ seq: 1, name: '条目一', section: '', subsection: '分节甲' }),
      entry({ seq: 2, name: '条目二', section: '', subsection: '分节乙' }),
    ]);
    const queries = buildBillFactLockQueries(lock, '综合说明', []);
    expect(queries.some(query => query.includes('条目一'))).toBe(true);
    expect(queries.some(query => query.includes('条目二'))).toBe(true);
  });

  it('覆盖优先：组数超出上限时第一轮每分部各占一条', () => {
    const entries = Array.from({ length: 20 }, (_, index) => entry({ seq: index + 1, name: `条目${index + 1}`, section: `分部${index + 1}` }));
    const queries = buildBillFactLockQueries(lockOf(entries), '主要施工方法', []);
    expect(queries).toHaveLength(18);
    expect(new Set(queries).size).toBe(18);
    expect(queries.some(query => query.includes('条目19'))).toBe(false);
  });

  it('轮询轮补位：名额有余时分部第 2 条代表入场', () => {
    const lock = lockOf([
      entry({ seq: 1, name: '甲一', section: '分部甲' }),
      entry({ seq: 2, name: '乙一', section: '分部乙' }),
      entry({ seq: 3, name: '甲二', section: '分部甲' }),
    ]);
    const queries = buildBillFactLockQueries(lock, '综合说明', []);
    expect(queries).toHaveLength(3);
    expect(queries[0]).toContain('甲一');
    expect(queries[1]).toContain('乙一');
    expect(queries[2]).toContain('甲二');
  });

  it('query 文本：名称+特征+数量单位且不超过 80 字符', () => {
    const lock = lockOf([entry({ seq: 1, name: '一般路灯', description: '100W LED，高4.5m', quantity: 18, unit: '套', section: '亮化工程' })]);
    const queries = buildBillFactLockQueries(lock, '主要施工方法', []);
    expect(queries[0]).toBe('一般路灯 100W LED，高4.5m 18套');
    expect(queries[0].length).toBeLessThanOrEqual(80);
  });

  it('空锁/空名条目不产生 query', () => {
    expect(buildBillFactLockQueries(lockOf([]), '主要施工方法', [])).toEqual([]);
    expect(buildBillFactLockQueries(lockOf([entry({ seq: 1, name: '' })]), '主要施工方法', [])).toEqual([]);
  });
});
