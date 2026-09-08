/**
 * 边界矩阵（P1 第 31 批 · OO 组 · 中文数字/部位词/养护期/违约词谱系）
 * 断言按探测锁定的真实行为推导。
 *  - O1 中文数字谱系 × 养护期权威（二十→20、二十一→undefined、三十→>20 undefined）
 *  - O2 LOCATION_WORD_SOURCE 44 部位词 × unlabeled 并入唯一组互斥
 *  - O3 部位词两两跨组互斥（10 对方向）
 *  - O4 养护期 × 数值格式 18（小数截尾：0.5→5、3.0→undef、1e3→3）
 *  - O5 计划工期字段违约词谱系（违约金/逾期罚款报 1、合同类引用 0）
 */
import { describe, expect, it } from 'vitest';
import { basicInfoScheduleFieldIssues, crossSectionNumericConflictIssues, extractGreeningMaintenanceAuthority } from '@/services/document-workflow/documentIntegrityChecks';
import { factOf, factsOf } from './boundaryKit';

// ── O1. 中文数字谱系 × 养护期权威（cnNumberToArabic 形态全覆盖） ──

const CN_YEAR_TABLE: Array<{ cn: string; expected: number | 'undef' }> = [
  { cn: '一', expected: 1 },
  { cn: '两', expected: 2 },
  { cn: '二', expected: 2 },
  { cn: '三', expected: 3 },
  { cn: '九', expected: 9 },
  { cn: '十', expected: 10 },
  { cn: '十一', expected: 11 },
  { cn: '十二', expected: 12 },
  { cn: '十五', expected: 15 },
  { cn: '十九', expected: 19 },
  { cn: '二十', expected: 20 },
  { cn: '二十一', expected: 'undef' },
  { cn: '二十五', expected: 'undef' },
  { cn: '三十', expected: 'undef' },
  { cn: '九十九', expected: 'undef' },
  { cn: '15', expected: 15 },
  { cn: '20', expected: 20 },
  { cn: '21', expected: 'undef' },
  { cn: '99', expected: 'undef' },
];

describe('O1 养护期权威：中文数字谱系', () => {
  it.each(CN_YEAR_TABLE)('O1 「养护$cn年」→ $expected', ({ cn, expected }) => {
    const result = extractGreeningMaintenanceAuthority(factsOf({ bills: [factOf({ key: '喷播植草籽', value: `养护${cn}年` })] }));
    if (expected === 'undef') {
      expect(result).toBeUndefined();
    } else {
      expect(result).toBe(expected);
    }
  });
  it('O1 上限边界：「养护二十年」=20 保留', () => {
    expect(extractGreeningMaintenanceAuthority(factsOf({ bills: [factOf({ key: '喷播植草籽', value: '养护二十年' })] }))).toBe(20);
  });
  it('O1 上限边界：「养护二十一年」>20 → undefined', () => {
    expect(extractGreeningMaintenanceAuthority(factsOf({ bills: [factOf({ key: '喷播植草籽', value: '养护二十一年' })] }))).toBeUndefined();
  });
});

// ── O2. 部位词谱系 × unlabeled 并入唯一组互斥 ──

const LOCATION_WORDS = [
  '女儿墙', '外墙', '内墙', '隔墙', '地梁', '圈梁', '构造柱', '过梁', '垫层', '承台', '筏板', '底板', '基础', '主体', '梁', '柱', '墙', '楼板', '屋面', '地面', '楼面', '顶板',
  '楼梯', '阳台', '雨篷', '台阶', '散水', '坡道', '找坡', '找平', '保护层', '防水层', '保温层', '隔汽层', '地坪', '办公区', '生活区', '库房', '加工区', '堆放区', '驻地', '周转场', '停放区', '仓库', '材料库',
] as const;

describe('O2 灭火器锚点：部位词 × unlabeled 并入唯一组', () => {
  it.each(LOCATION_WORDS)('O2 部位「%s」+无部位 20 具 → 并入唯一组报互斥 1 条', (word) => {
    const issues = crossSectionNumericConflictIssues(`${word}灭火器4具。灭火器20具。`);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('灭火器');
  });
});

// ── O3. 部位词两两跨组互斥 ──

const LOCATION_PAIRS: Array<[string, string]> = [
  ['办公区', '库房'],
  ['生活区', '堆放区'],
  ['屋面', '外墙'],
  ['基础', '主体'],
  ['梁', '柱'],
  ['仓库', '驻地'],
  ['楼板', '顶板'],
  ['楼梯', '台阶'],
  ['散水', '坡道'],
  ['加工区', '周转场'],
];

describe('O3 灭火器锚点：跨组不同值不互斥（不同部位合法口径差异）', () => {
  it.each(LOCATION_PAIRS)('O3 「$0」4具 vs 「$1」20具 → 跨组不报 → 0 条', (a, b) => {
    const issues = crossSectionNumericConflictIssues(`${a}灭火器4具。${b}灭火器20具。`);
    expect(issues).toHaveLength(0);
  });
  it('O3 对照：同部位组内两值 4 vs 20 → 报 1 条', () => {
    expect(crossSectionNumericConflictIssues('办公区灭火器4具。办公区灭火器20具。')).toHaveLength(1);
  });
});

// ── O4. 养护期 × 数值格式谱系（探测锁定） ──

const GREEN_BEHAVIOR: Array<{ f: string; expected: number | 'undef' }> = [
  { f: '1', expected: 1 },
  { f: '1.0', expected: 'undef' },
  { f: '1.00', expected: 'undef' },
  { f: '0.5', expected: 5 },
  { f: '0.05', expected: 5 },
  { f: '10', expected: 10 },
  { f: '99', expected: 'undef' },
  { f: '999', expected: 'undef' },
  { f: '1000', expected: 'undef' },
  { f: '1,000', expected: 'undef' },
  { f: '10,000', expected: 'undef' },
  { f: '10000.5', expected: 5 },
  { f: '1234.567', expected: 'undef' },
  { f: '0001', expected: 1 },
  { f: '010', expected: 10 },
  { f: '1e3', expected: 3 },
  { f: '3.0', expected: 'undef' },
  { f: '12,345,678', expected: 'undef' },
];

describe('O4 养护期权威：数值格式谱系', () => {
  it.each(GREEN_BEHAVIOR)('O4 「养护$f年」→ $expected', ({ f, expected }) => {
    const result = extractGreeningMaintenanceAuthority(factsOf({ bills: [factOf({ key: '喷播植草籽', value: `养护${f}年` })] }));
    if (expected === 'undef') {
      expect(result).toBeUndefined();
    } else {
      expect(result).toBe(expected);
    }
  });
});

// ── O5. 计划工期字段违约词谱系（探测锁定） ──

const SCHEDULE_VIOLATION_WORDS: Array<{ v: string; issues: number }> = [
  { v: '逾期违约金1000元', issues: 1 },
  { v: '违约金按合同', issues: 1 },
  { v: '逾期罚款', issues: 1 },
  { v: '540个日历天，逾期按日罚款', issues: 1 },
  { v: '210日历天及违约金', issues: 1 },
  { v: '详见合同条款', issues: 0 },
  { v: '按合同执行', issues: 0 },
  { v: '210日历天', issues: 0 },
  { v: '540个日历天', issues: 0 },
  { v: '0日历天', issues: 0 },
  { v: '1,000日历天', issues: 0 },
  { v: '10000日历天', issues: 0 },
];

describe('O5 计划工期字段：违约词谱系', () => {
  it.each(SCHEDULE_VIOLATION_WORDS)('O5 字段值「$v」→ 报 $issues 条', ({ v, issues }) => {
    expect(basicInfoScheduleFieldIssues(`| 计划工期 | ${v} |`)).toHaveLength(issues);
  });
});
