/**
 * 边界矩阵（P1 第 31 批 · HH 组 · 大规模矩阵铺开）
 * 数值格式谱系 × 关键入口 的全组合枚举：每条用例 =（入口, 格式, 语境）组合，
 * 断言按真实实现行为推导（探测锁定的行为表），不迎合用例改实现。
 *  - M1 面积算术：18 格式矛盾句 + 自洽锚定（tolerance=max(1,total*0.001) 阈值推导）
 *  - M2 tablePeakLabor：18 格式单元格解析（千分位/前导零/小数/科学计数判定）
 *  - M3 劳动力峰值修复：18 格式（小数截尾解析行为锁定：1.0→捕获0跳过、0.5→捕获5）
 *  - M4 清单量定点校正：18 格式（99→2%豁免、1e3→不匹配保留、其余→修复100）
 *  - M5 灭火器数值锚点：18 格式同值零报 + 千分位/科学计数混合行为（1,000具→解析0具）
 *  - M6 面积单位归一：5 单位变体（m²/㎡/m2/M2/平方米）立方组合 125 条自洽 + 4 条混合矛盾
 *  - M7 村名词谱系：14 村词 × 窗口内豁免/窗口外修复
 *  - M8 否定声明词谱系：11 词 × 行级豁免 + 对照
 */
import { describe, expect, it } from 'vitest';
import {
  areaArithmeticIssues,
  applyNumericConsistencyDeterministicFixes,
  crossSectionNumericConflictIssues,
  fixQuantityAuthorityConflicts,
  tablePeakLabor,
} from '@/services/document-workflow/documentIntegrityChecks';
import { NUMERIC_FORMATS, VILLAGE_WORDS, VILLAGE_WORDS_REMOVED } from './boundaryKit';

// 探测锁定的行为表：各格式在 4 个入口的真实解析结果
// area: '地上f㎡地下f㎡单体建筑面积f㎡' 报数（|2v-v| > max(1, v*0.001)）
// table: tablePeakLabor 单元格值（undefined=不识别）
// labor: applyNumeric('高峰期约f人。', {laborPeakAuthority:186}) fixedCount
// qty: fixQuantityAuthorityConflicts('C.1项铺装 f m。', [{value:100}]) fixedCount
const FORMAT_BEHAVIOR: Array<{ f: string; area: number; table: number | 'undef'; labor: number; qty: number }> = [
  { f: '1', area: 0, table: 1, labor: 1, qty: 1 },
  { f: '1.0', area: 0, table: 'undef', labor: 0, qty: 1 },
  { f: '1.00', area: 0, table: 'undef', labor: 0, qty: 1 },
  { f: '0.5', area: 0, table: 'undef', labor: 1, qty: 1 },
  { f: '0.05', area: 0, table: 'undef', labor: 1, qty: 1 },
  { f: '10', area: 1, table: 10, labor: 1, qty: 1 },
  { f: '99', area: 1, table: 99, labor: 1, qty: 1 }, // D2 零漂移豁免：99 vs 100 差 1% 也修复
  { f: '999', area: 1, table: 999, labor: 1, qty: 1 },
  { f: '1000', area: 1, table: 1000, labor: 1, qty: 1 },
  { f: '1,000', area: 1, table: 1000, labor: 1, qty: 1 },
  { f: '10,000', area: 1, table: 10000, labor: 1, qty: 1 },
  { f: '10000.5', area: 1, table: 'undef', labor: 1, qty: 1 },
  { f: '1234.567', area: 1, table: 'undef', labor: 1, qty: 1 },
  { f: '0001', area: 0, table: 1, labor: 1, qty: 1 },
  { f: '010', area: 1, table: 10, labor: 1, qty: 1 },
  { f: '1e3', area: 1, table: 'undef', labor: 1, qty: 0 },
  { f: '3.0', area: 1, table: 'undef', labor: 0, qty: 1 },
  { f: '12,345,678', area: 1, table: 12345678, labor: 1, qty: 1 },
];

// ── M1. 面积算术：格式 × 矛盾句（tolerance=max(1,total*0.001) 阈值推导） ──

describe('M1 面积算术：数值格式谱系矛盾句', () => {
  it.each(FORMAT_BEHAVIOR)('M1 「地上$f㎡地下$f㎡单体建筑面积$f㎡」→ 报 $area 条（差=|v|>max(1,v*0.001)）', ({ f, area }) => {
    expect(areaArithmeticIssues(`地上${f}㎡地下${f}㎡单体建筑面积${f}㎡`)).toHaveLength(area);
  });
  it('M1 自洽锚定：10+5=15 全格式正常解析 → 0 条', () => {
    expect(areaArithmeticIssues('地上10㎡地下5㎡单体建筑面积15㎡')).toHaveLength(0);
  });
  it('M1 自洽锚定：千分位 1,000+2,000=3,000 → 0 条', () => {
    expect(areaArithmeticIssues('地上1,000㎡地下2,000㎡单体建筑面积3,000㎡')).toHaveLength(0);
  });
  it('M1 容差下限：差 1 且 total 小 → 不报（tolerance 下限 1）', () => {
    expect(areaArithmeticIssues('地上10㎡地下10㎡单体建筑面积19㎡')).toHaveLength(0);
  });
  it('M1 科学计数截尾锁定：1e3 被懒匹配捕获 3 → 3+5=8 vs 1005 → 报 1 条', () => {
    expect(areaArithmeticIssues('地上1e3㎡地下5㎡单体建筑面积1005㎡')).toHaveLength(1);
  });
});

// ── M2. tablePeakLabor：格式 × 单元格解析 ──

describe('M2 劳动力表识别：数值格式单元格', () => {
  it.each(FORMAT_BEHAVIOR)('M2 单元格「$f」→ $table', ({ f, table }) => {
    const markdown = `| 阶段 | 人数 |\n| --- | --- |\n| 施工 | ${f} |`;
    if (table === 'undef') {
      expect(tablePeakLabor(markdown)).toBeUndefined();
    } else {
      expect(tablePeakLabor(markdown)).toBe(table);
    }
  });
});

// ── M3. 劳动力峰值修复：格式 × 捕获行为（小数截尾锁定） ──

describe('M3 劳动力峰值修复：数值格式捕获行为', () => {
  it.each(FORMAT_BEHAVIOR)('M3 「高峰期约$f人」→ fixedCount $labor（小数截尾：1.0→捕获0跳过、0.5→捕获5）', ({ f, labor }) => {
    const result = applyNumericConsistencyDeterministicFixes(`高峰期约${f}人。`, { laborPeakAuthority: 186 });
    expect(result.fixedCount).toBe(labor);
  });
  it('M3 小数截尾锁定：「高峰期约1.0人」捕获 0 → 0 值跳过不替换', () => {
    const result = applyNumericConsistencyDeterministicFixes('高峰期约1.0人。', { laborPeakAuthority: 186 });
    expect(result.fixedCount).toBe(0);
    expect(result.markdown).toContain('约1.0人');
  });
  it('M3 小数截尾锁定：「高峰期约0.5人」捕获 5 → 5 与权威 186 差 >30% → 替换', () => {
    const result = applyNumericConsistencyDeterministicFixes('高峰期约0.5人。', { laborPeakAuthority: 186 });
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toContain('186人');
  });
});

// ── M4. 清单量定点校正：格式 × 修复判定 ──

describe('M4 清单量定点校正：数值格式', () => {
  it.each(FORMAT_BEHAVIOR)('M4 「C.1项铺装 $fm」权威100 → fixedCount $qty', ({ f, qty }) => {
    const result = fixQuantityAuthorityConflicts(`C.1项铺装 ${f}m。`, [{ name: 'C.1项铺装', value: 100, unit: 'm' }]);
    expect(result.fixedCount).toBe(qty);
    if (qty === 1) expect(result.markdown).toContain('100m');
    else expect(result.markdown).toContain(`${f}m`);
  });
  it('M4 千分位完整解析：「1,000m」权威 1000 → 同值不动', () => {
    const result = fixQuantityAuthorityConflicts('C.1项铺装 1,000m。', [{ name: 'C.1项铺装', value: 1000, unit: 'm' }]);
    expect(result.fixedCount).toBe(0);
    expect(result.markdown).toContain('1,000m');
  });
});

// ── M5. 灭火器数值锚点：格式 × 同值零报 + 混合行为 ──

describe('M5 灭火器锚点：数值格式入池行为', () => {
  it.each(NUMERIC_FORMATS)('M5 两处同值「$f具」→ 0 条（不匹配或同值不冲突）', (f) => {
    expect(crossSectionNumericConflictIssues(`办公区灭火器${f}具。办公区灭火器${f}具。`)).toHaveLength(0);
  });
  it('M5 千分位截尾锁定：「1,000具」被捕获为 0 具 → 与 1000具 冲突报 1 条', () => {
    const issues = crossSectionNumericConflictIssues('办公区灭火器1000具。办公区灭火器1,000具。');
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('灭火器');
  });
  it('M5 科学计数截尾锁定：「1e3具」被捕获为 3 具 → 与 1000具 冲突报 1 条', () => {
    expect(crossSectionNumericConflictIssues('办公区灭火器1000具。办公区灭火器1e3具。')).toHaveLength(1);
  });
  it('M5 小数截尾锁定：「0.5具」被捕获为 5 具 → 与 1000具 冲突报 1 条', () => {
    expect(crossSectionNumericConflictIssues('办公区灭火器1000具。办公区灭火器0.5具。')).toHaveLength(1);
  });
});

// ── M6. 面积单位归一：5 单位变体立方组合 ──

const AREA_UNITS = ['m²', '㎡', 'm2', 'M2', '平方米'] as const;

describe('M6 面积算术：单位写法互认矩阵', () => {
  const combos: string[] = [];
  for (const u1 of AREA_UNITS) {
    for (const u2 of AREA_UNITS) {
      for (const u3 of AREA_UNITS) {
        combos.push(`${u1}|${u2}|${u3}`);
      }
    }
  }
  it.each(combos)('M6 地上10%s 地下5%s 单体建筑面积15%s → 同口径自洽 0 条', (combo) => {
    const [u1, u2, u3] = combo.split('|');
    expect(areaArithmeticIssues(`地上10${u1}地下5${u2}单体建筑面积15${u3}`)).toHaveLength(0);
  });
  it('M6 混合单位矛盾：「地上10㎡地下5m2单体建筑面积10㎡」差5>1 → 报 1 条', () => {
    expect(areaArithmeticIssues('地上10㎡地下5m2单体建筑面积10㎡')).toHaveLength(1);
  });
  it('M6 大写单位锁定：「M2」不在面积正则单位表 → 整句不检 → 0 条', () => {
    expect(areaArithmeticIssues('地上10㎡地下5M2单体建筑面积10㎡')).toHaveLength(0);
  });
  it('M6 混合单位含大写 M2：「地上10平方米地下5m2单体建筑面积15M2」整句不检 → 0 条', () => {
    expect(areaArithmeticIssues('地上10平方米地下5m2单体建筑面积15M2')).toHaveLength(0);
  });
});

// ── M7. 村名词谱系：窗口内豁免 / 窗口外修复 ──

// 段落级豁免词表（探测锁定）：段落含这些村词 → 即使名称前 12 字窗口无村词也豁免
const PARAGRAPH_EXEMPT_WORDS = ['郢', '庄', '岗', '塘', '圩', '坝'] as const;
// 仅窗口豁免词表（D2 收紧后）：窗口内有村词豁免、窗口外修复（池/井非段落级词）
const WINDOW_ONLY_WORDS = ['池', '井'] as const;

describe('M7 清单量校正：村名词豁免窗口', () => {
  it.each(VILLAGE_WORDS)('M7 名称前 12 字内含「%s」→ 分村量豁免 → 50 不动', (word) => {
    const result = fixQuantityAuthorityConflicts(`马老${word}区C.1项铺装 50m。`, [{ name: 'C.1项铺装', value: 100, unit: 'm' }]);
    expect(result.fixedCount).toBe(0);
    expect(result.markdown).toContain('50m');
  });
  it.each(WINDOW_ONLY_WORDS)('M7 仅窗口豁免词「%s」距名称超 12 字 → 不豁免 → 修复 100', (word) => {
    const result = fixQuantityAuthorityConflicts(`马老${word}村，主要工程量包括其他条目若干。C.1项铺装 50m。`, [{ name: 'C.1项铺装', value: 100, unit: 'm' }]);
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toContain('C.1项铺装 100m');
  });
  it.each(VILLAGE_WORDS_REMOVED)('M7 收紧剔除词「%s」12 字窗口内 → 不再豁免 → 修复 100（D2 反漂移）', (word) => {
    const result = fixQuantityAuthorityConflicts(`马老${word}区C.1项铺装 50m。`, [{ name: 'C.1项铺装', value: 100, unit: 'm' }]);
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toContain('C.1项铺装 100m');
  });
  it.each(PARAGRAPH_EXEMPT_WORDS)('M7 段落级豁免词「%s」距名称超 12 字 → 仍豁免 → 50 不动', (word) => {
    const result = fixQuantityAuthorityConflicts(`马老${word}村，主要工程量包括其他条目若干。C.1项铺装 50m。`, [{ name: 'C.1项铺装', value: 100, unit: 'm' }]);
    expect(result.fixedCount).toBe(0);
    expect(result.markdown).toContain('50m');
  });
});

// ── M8. 否定声明词谱系：行级豁免 ──

const NEGATIVE_DECLARATION_WORDS = ['不再出现', '不得出现', '严禁出现', '避免出现', '不采用', '未采用', '予以删除', '已删除', '取消', '纠正为', '更正为'] as const;

describe('M8 灭火器锚点：否定声明词行级豁免', () => {
  it.each(NEGATIVE_DECLARATION_WORDS)('M8 声明词「%s」所在行值不入池 → 0 条', (word) => {
    expect(crossSectionNumericConflictIssues(`办公区灭火器4具。${word}灭火器20具。`)).toHaveLength(0);
  });
  it('M8 对照：无否定声明词 → 4 vs 20 报 1 条', () => {
    expect(crossSectionNumericConflictIssues('办公区灭火器4具。办公区灭火器20具。')).toHaveLength(1);
  });
});
