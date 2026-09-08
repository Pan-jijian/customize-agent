/**
 * 边界矩阵（P1 第 33 批 · TT 组 · 权威口径提取器 + 危大缺口修复器）
 * 断言按探测锁定的真实行为推导（probeTT/probeTT2 已删）。
 *  - T1 extractScheduleAuthority：schedule 卡与 canonical.schedule 双源谱系
 *  - T2 extractAssemblyRateAuthority：project/bills/preciseFacts + tenderRequirements 谱系
 *  - T3 extractProjectScaleSummary：面积卡 + 层数 JSON 全量提取谱系
 *  - T4 fixHazardIdentificationGaps：适用判定边界 × 辨识别名窗口 × 插入锚点谱系
 */
import { describe, expect, it } from 'vitest';
import { extractAssemblyRateAuthority, extractProjectScaleSummary, extractScheduleAuthority, fixHazardIdentificationGaps } from '@/services/document-workflow/documentIntegrityChecks';
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

describe('T2 装配率权威提取：事实卡三源 + 招标文本', () => {
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
  it('T2 tenderRequirements.assemblyRate.text「50%」→ 50', () => {
    const model = { project: [], bills: [], preciseFacts: [], tenderRequirements: { assemblyRate: { text: '50%' }, systematicBenchmarks: [], dateFabricationProhibited: false } } as unknown as DocumentFactsModel;
    expect(extractAssemblyRateAuthority(model)).toBe(50);
  });
  it('T2 tender 文本「装配率不小于55%」→ 55', () => {
    const model = { project: [], bills: [], preciseFacts: [], tenderRequirements: { assemblyRate: { text: '装配率不小于55%' }, systematicBenchmarks: [], dateFabricationProhibited: false } } as unknown as DocumentFactsModel;
    expect(extractAssemblyRateAuthority(model)).toBe(55);
  });
  it('T2 tender 文本无百分号 → undefined', () => {
    const model = { project: [], bills: [], preciseFacts: [], tenderRequirements: { assemblyRate: { text: '装配率不小于55' }, systematicBenchmarks: [], dateFabricationProhibited: false } } as unknown as DocumentFactsModel;
    expect(extractAssemblyRateAuthority(model)).toBeUndefined();
  });
  it('T2 project 卡命中时不读 tender（优先级）', () => {
    const model = { project: [factOf('装配率', '30%')], bills: [], preciseFacts: [], tenderRequirements: { assemblyRate: { text: '50%' }, systematicBenchmarks: [], dateFabricationProhibited: false } } as unknown as DocumentFactsModel;
    expect(extractAssemblyRateAuthority(model)).toBe(30);
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

// ── T4. fixHazardIdentificationGaps 谱系 ──
// 窗口语义：zone = 每个含「危大」行前后 6 行；前提词在窗口内时若与别名同词面即视为命中。

const gapBody = (premise: string): string => [
  premise,
  '', '', '', '', '', '', '', '',
  '## 危大工程辨识清单',
  '- 既有条目：',
].join('\n');

describe('T4 危大缺口补写：适用判定边界（前提在窗口外）', () => {
  it.each([
    { premise: '基坑开挖深度2.9m。', expect: 0 },
    { premise: '基坑开挖深度3.0m。', expect: 1 },
    { premise: '模板支撑搭设高度7.9m。', expect: 0 },
    { premise: '模板支撑搭设高度8.0m。', expect: 1 },
    { premise: '施工总荷载9.9kN。', expect: 0 },
    { premise: '施工总荷载10kN。', expect: 1 },
    { premise: '落地式钢管脚手架搭设高度14.9m。', expect: 0 },
    { premise: '落地式钢管脚手架搭设高度15m。', expect: 1 },
  ] as const)('T4 「$premise」→ 补 $expect 条', ({ premise, expect: exp }) => {
    const result = fixHazardIdentificationGaps(gapBody(premise));
    expect(result.fixedCount).toBe(exp as number);
  });
  it.each(['高支模方案编制', '高大模板专项论证', '悬挑式脚手架搭设', '塔吊基础施工', '吊篮进场验收', '拆除工程专项方案', '爆破拆除作业'])('T4 词面前提「%s」（窗口外）→ 补 1 条', (premise) => {
    expect(fixHazardIdentificationGaps(gapBody(premise)).fixedCount).toBe(1);
  });
  it('T4 前提词含别名同词面且词在窗口内 → 命中不补', () => {
    const markdown = ['本项目采用吊篮作业。', '## 危大工程辨识清单', '- 基坑支护与降水工程：'].join('\n');
    expect(fixHazardIdentificationGaps(markdown).fixedCount).toBe(0);
  });
  it('T4 基坑前提在窗口内但清单别名未列 → 仍补（前提词面非别名）', () => {
    const markdown = ['基坑开挖深度5m。', '## 危大工程辨识清单', '- 脚手架工程：'].join('\n');
    expect(fixHazardIdentificationGaps(markdown).fixedCount).toBe(1);
  });
});

describe('T4 危大缺口补写：窗口边界与锚点谱系', () => {
  it('T4 前提距「危大」行 6 行（窗口内含）→ 词面命中不补', () => {
    const markdown = ['吊篮进场验收。', '', '', '', '', '', '## 危大工程辨识清单', '- 既有条目：'].join('\n');
    expect(fixHazardIdentificationGaps(markdown).fixedCount).toBe(0);
  });
  it('T4 前提距「危大」行 7 行（窗口外）→ 补 1 条', () => {
    const markdown = ['吊篮进场验收。', '', '', '', '', '', '', '## 危大工程辨识清单', '- 既有条目：'].join('\n');
    expect(fixHazardIdentificationGaps(markdown).fixedCount).toBe(1);
  });
  it('T4 无「危大」字样 → 0 条', () => {
    expect(fixHazardIdentificationGaps('本项目采用吊篮作业。\n## 施工方案').fixedCount).toBe(0);
  });
  it('T4 无适用前提 → 0 条', () => {
    expect(fixHazardIdentificationGaps('## 危大工程辨识清单\n- 既有条目：').fixedCount).toBe(0);
  });
  it.each(['## 危大工程辨识', '### 危大清单', '#### 危大分部'])('T4 锚点 H2-H4 标题「%s」→ 补写插标题行后', (heading) => {
    const result = fixHazardIdentificationGaps(gapBody('基坑开挖深度5m。').replace('## 危大工程辨识清单', heading));
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toContain(`${heading}\n基坑支护与降水工程：`);
  });
  it('T4 H5 标题不算锚点 → 回退最后一个含「危大」正文行后插入', () => {
    const markdown = ['基坑开挖深度5m。', '', '', '', '', '', '', '', '##### 危大分部', '危大工程辨识清单如下。', '- 既有条目：'].join('\n');
    const result = fixHazardIdentificationGaps(markdown);
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toContain('危大工程辨识清单如下。\n基坑支护与降水工程：');
  });
  it('T4 H1 标题不算锚点 → 回退正文行', () => {
    const markdown = ['基坑开挖深度5m。', '', '', '', '', '', '', '', '# 危大分部', '危大工程辨识清单如下。'].join('\n');
    const result = fixHazardIdentificationGaps(markdown);
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toContain('危大工程辨识清单如下。\n基坑支护与降水工程：');
  });
  it('T4 多适用项全缺（前提全窗口外）→ 补 6 条按固定顺序', () => {
    const markdown = [
      '基坑开挖深度5m。支撑高度10m。',
      '脚手架搭设高度20m。塔吊。吊篮。拆除工程。',
      '', '', '', '', '', '',
      '## 危大工程辨识清单',
      '- 既有条目：',
    ].join('\n');
    const result = fixHazardIdentificationGaps(markdown);
    expect(result.fixedCount).toBe(6);
    expect(result.markdown).toContain('基坑支护与降水工程：');
    expect(result.markdown).toContain('高大模板支撑工程：');
    expect(result.markdown).toContain('脚手架工程：');
    expect(result.markdown).toContain('起重吊装及安装拆卸工程：');
    expect(result.markdown).toContain('吊篮作业工程：');
    expect(result.markdown).toContain('拆除工程：');
  });
  it('T4 部分别名命中 → 只补缺失项', () => {
    const markdown = [
      '基坑开挖深度5m。支撑高度10m。',
      '', '', '', '', '', '',
      '## 危大工程辨识清单',
      '- 基坑支护与降水工程：',
      '- 高大模板支撑工程：',
    ].join('\n');
    const result = fixHazardIdentificationGaps(markdown);
    expect(result.fixedCount).toBe(0);
  });
  it('T4 清单内列别名但前提在窗口外且别名不在清单 → 补 1 条', () => {
    const markdown = [
      '基坑开挖深度5m。',
      '', '', '', '', '', '', '',
      '## 危大工程辨识清单',
      '- 脚手架工程：',
    ].join('\n');
    const result = fixHazardIdentificationGaps(markdown);
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toContain('基坑支护与降水工程：');
  });
  it('T4 details 文案含缺失项名', () => {
    const result = fixHazardIdentificationGaps(gapBody('基坑开挖深度5m。'));
    expect(result.details[0]).toContain('基坑支护与降水工程');
  });
});
