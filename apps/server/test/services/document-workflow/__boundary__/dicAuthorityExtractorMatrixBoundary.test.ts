/**
 * 边界矩阵（P1 第 33 批 · TT 组 · 权威口径提取器）
 * 断言按探测锁定的真实行为推导（probeTT/probeTT2 已删）。
 *  - T1 extractScheduleAuthority：schedule 卡与 canonical.schedule 双源谱系
 *  - T2 extractAssemblyRateAuthority：project/bills/preciseFacts 三源谱系
 *  - T3 extractProjectScaleSummary：面积卡 + 层数 JSON 全量提取谱系
 */
import { describe, expect, it } from 'vitest';
import { extractAssemblyRateAuthority, extractProjectScaleSummary, extractScheduleAuthority } from '@/services/document-workflow/documentIntegrityChecks';
import type { DocumentFactsModel } from '@/services/document-workflow/types';

const factOf = (key: string, value: string, fieldName = ''): any => ({ key, value, fieldName, fieldId: '', sourceFile: 's', roleId: 'r' });

// ── T1. extractScheduleAuthority 谱系 ──

describe('T1 工期权威提取：schedule 卡与 canonical 双源', () => {
  it.each([
    { label: '总工期', value: '540个日历天', expect: 540 },
    { label: '总工期', value: '540 个日历天', expect: 540 },
    { label: '总工期', value: '540日历天', expect: 540 },
    { label: '建设周期', value: '9999日历天', expect: 9999 },
    { label: '总工期', value: '5000日历天', expect: 5000 },
    { label: '总工期', value: '0日历天', expect: undefined },
    { label: '总工期', value: '540天', expect: undefined },
    { label: '总工期', value: '约540日历天', expect: 540 },
    { label: '开工日期', value: '540个日历天', expect: undefined },
  ] as const)('T1 schedule 卡 label「$label」+ value「$value」→ $expect', ({ label, value, expect: exp }) => {
    const model = { schedule: [factOf(label, value)], canonical: {} } as unknown as DocumentFactsModel;
    expect(extractScheduleAuthority(model)).toBe(exp as number | undefined);
  });
  it('T1 label 由 key+fieldName 拼接判定：key「总」+fieldName「工期」→ 命中', () => {
    const model = { schedule: [factOf('总', '540日历天', '工期')], canonical: {} } as unknown as DocumentFactsModel;
    expect(extractScheduleAuthority(model)).toBe(540);
  });
  it('T1 schedule 卡 label 不命中时回退 canonical.schedule 对象条目', () => {
    const model = { schedule: [factOf('开工日期', '540日历天')], canonical: { schedule: { gq: { label: '工期', value: '360日历天' } } } } as unknown as DocumentFactsModel;
    expect(extractScheduleAuthority(model)).toBe(360);
  });
  it('T1 schedule 卡命中时不读 canonical（优先级）', () => {
    const model = { schedule: [factOf('总工期', '540日历天')], canonical: { schedule: { gq: { label: '工期', value: '360日历天' } } } } as unknown as DocumentFactsModel;
    expect(extractScheduleAuthority(model)).toBe(540);
  });
  it.each([
    { label: '工期', value: '360日历天', expect: 360 },
    { label: '建设周期', value: '480个日历天', expect: 480 },
    { label: '说明', value: '360日历天', expect: undefined },
  ] as const)('T1 canonical 条目 label「$label」value「$value」→ $expect', ({ label, value, expect: exp }) => {
    const model = { schedule: [], canonical: { schedule: { e: { label, value } } } } as unknown as DocumentFactsModel;
    expect(extractScheduleAuthority(model)).toBe(exp as number | undefined);
  });
  it('T1 canonical 数组条目取 [0]', () => {
    const model = { schedule: [], canonical: { schedule: { arr: [{ label: '周期', value: '420日历天' }] } } } as unknown as DocumentFactsModel;
    expect(extractScheduleAuthority(model)).toBe(420);
  });
  it('T1 空模型 → undefined', () => {
    expect(extractScheduleAuthority({ canonical: {} } as unknown as DocumentFactsModel)).toBeUndefined();
  });
});

// ── T2. extractAssemblyRateAuthority 谱系 ──

describe('T2 装配率权威提取：事实卡三源', () => {
  it.each([
    { src: 'project', label: '装配率', value: '30%', expect: 30 },
    { src: 'bills', label: '装配率', value: '38.4%', expect: 38.4 },
    { src: 'preciseFacts', label: 'assembly', value: '45%', expect: 45 },
    { src: 'project', label: '装配率', value: '100%', expect: 100 },
    { src: 'project', label: '装配率', value: '0.5%', expect: 0.5 },
    { src: 'project', label: '装配率', value: '0%', expect: undefined },
    { src: 'project', label: '装配率', value: '101%', expect: undefined },
    { src: 'project', label: '装配率', value: '30', expect: undefined },
    { src: 'project', label: '预制率', value: '30%', expect: undefined },
  ] as const)('T2 $src 卡 label「$label」value「$value」→ $expect', ({ src, label, value, expect: exp }) => {
    const model = {
      project: src === 'project' ? [factOf(label, value)] : [],
      bills: src === 'bills' ? [factOf(label, value)] : [],
      preciseFacts: src === 'preciseFacts' ? [factOf(label, value)] : [],
    } as unknown as DocumentFactsModel;
    expect(extractAssemblyRateAuthority(model)).toBe(exp as number | undefined);
  });
  it('T2 value 文本内嵌百分比「装配率30.5%以上」→ 30.5', () => {
    const model = { project: [factOf('装配率', '装配率30.5%以上')], bills: [], preciseFacts: [] } as unknown as DocumentFactsModel;
    expect(extractAssemblyRateAuthority(model)).toBe(30.5);
  });
  it('T2 fieldId=assembly_rate 拼接命中', () => {
    const model = { project: [factOf('', '60%', '', )], bills: [], preciseFacts: [] } as unknown as DocumentFactsModel;
    model.project[0].fieldId = 'assembly_rate';
    expect(extractAssemblyRateAuthority(model)).toBe(60);
  });
});

// ── T3. extractProjectScaleSummary 谱系 ──

describe('T3 工程规模摘要提取：面积卡 + 层数全量提取', () => {
  it.each([
    { label: '单体建筑面积', value: '12345.6㎡', expect: '建筑面积12345.6平方米' },
    { label: '建设规模', value: '9876平方米', expect: '建筑面积9876平方米' },
    { label: '单体建筑面积', value: '12345 m²', expect: '建筑面积12345平方米' },
    { label: '单体建筑面积', value: '0.5㎡', expect: '建筑面积0.5平方米' },
    { label: '单体建筑面积', value: '12345m2', expect: undefined },
    { label: '单体建筑面积', value: '12,345㎡', expect: '建筑面积345平方米' },
    { label: '其他', value: '12345㎡', expect: undefined },
  ] as const)('T3 卡 label「$label」value「$value」→ $expect', ({ label, value, expect: exp }) => {
    const model = { project: [factOf(label, value)], drawings: [], tables: [] } as unknown as DocumentFactsModel;
    expect(extractProjectScaleSummary(model)).toBe(exp as string | undefined);
  });
  it('T3 面积卡 + drawings 层数 → 三段组合', () => {
    const model = { project: [factOf('单体建筑面积', '12345㎡')], drawings: [factOf('d', '地上6层、地下1层')], tables: [] } as unknown as DocumentFactsModel;
    expect(extractProjectScaleSummary(model)).toBe('建筑面积12345平方米、地上6层、地下1层');
  });
  it('T3 只层数（drawings 双值）→ 地上地下组合', () => {
    const model = { project: [factOf('其他', 'x')], drawings: [factOf('d', '地上3层、地下2层')], tables: [] } as unknown as DocumentFactsModel;
    expect(extractProjectScaleSummary(model)).toBe('地上3层、地下2层');
  });
  it('T3 只地下层 → 仅地下段', () => {
    const model = { project: [factOf('其他', 'x')], drawings: [factOf('d', '地下1层')], tables: [] } as unknown as DocumentFactsModel;
    expect(extractProjectScaleSummary(model)).toBe('地下1层');
  });
  it('T3 只地上层 → 仅地上段', () => {
    const model = { project: [factOf('其他', 'x')], drawings: [factOf('d', '地上8层')], tables: [] } as unknown as DocumentFactsModel;
    expect(extractProjectScaleSummary(model)).toBe('地上8层');
  });
  it('T3 tables 层数参与全量提取', () => {
    const model = { project: [factOf('单体建筑面积', '111㎡')], drawings: [], tables: [factOf('t', '地上2层')] } as unknown as DocumentFactsModel;
    expect(extractProjectScaleSummary(model)).toBe('建筑面积111平方米、地上2层');
  });
  it('T3 全无 → undefined', () => {
    expect(extractProjectScaleSummary({ project: [factOf('其他', 'x')], drawings: [], tables: [] } as unknown as DocumentFactsModel)).toBeUndefined();
  });
  it('T3 多面积卡取首张', () => {
    const model = { project: [factOf('单体建筑面积', '1000㎡'), factOf('建设规模', '2000㎡')], drawings: [], tables: [] } as unknown as DocumentFactsModel;
    expect(extractProjectScaleSummary(model)).toBe('建筑面积1000平方米');
  });
});
