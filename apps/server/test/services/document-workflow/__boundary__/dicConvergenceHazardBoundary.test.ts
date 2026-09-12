/**
 * 第二十三批（Z 组）：覆盖最浅导出深挖——收敛循环全谱系 + 链回退 + 危大分级矩阵。
 *
 * 基线说明（comm 对比 + 提及计数）：runFixUntilClean（19 提及）/
 * runDeterministicChainUntilConverged（18）/ tablePeakLaborWithChainFallback（16）/
 * excavationHazardClassificationIssues（8）为 documentIntegrityChecks 全部导出中
 * 覆盖最浅的四者。本文件对未探分支做数据表边界枚举：
 * - Z1 runFixUntilClean：maxRounds 边界（0/1/2）、固定处数累计、假修复循环上限、异常传播
 * - Z2 runDeterministicChainUntilConverged：空链、互搏循环、多轮累计、第二轮无进展跳出
 * - Z3 tablePeakLaborWithChainFallback：链形态真实行为锁定（探针确认）、表优先级、阶段过滤
 * - Z4 excavationHazardClassificationIssues：3m/5m 双阈值边界、多事实源、比较式排除
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSemanticSimilarity } from '@/services/document-workflow/semanticSimilarity';
import {
  bodySentencesForSemantic, excavationHazardClassificationIssues,
  runDeterministicChainUntilConverged, runFixUntilClean,
  selfUnderminingCandidateIssues, sixHundredPercentCoverageIssues,
  tablePeakLaborWithChainFallback,
} from '@/services/document-workflow/documentIntegrityChecks';
import type { DeterministicFixOutcome } from '@/services/document-workflow/documentIntegrityChecks';
import { factOf, factsOf } from './boundaryKit';

vi.mock('@/services/document-workflow/semanticSimilarity', () => ({ buildSemanticSimilarity: vi.fn(), SEMANTIC_COVERAGE_THRESHOLD: 0.6 }));

/** 恒值语义模拟器：锁定语义判定通道的阈值边界 */
const CONST_SIM = (value: number) => async (_leftTexts: string[], _rightTexts: string[]) => (_l: string, _r: string): number => value;

type Fixer = (markdown: string) => DeterministicFixOutcome;

describe('Z1 runFixUntilClean 节点内闭环修复深挖', () => {
  const shrinkAA: Fixer = markdown => (markdown.includes('AA')
    ? { markdown: markdown.replace('AA', 'A'), fixedCount: 1 }
    : { markdown, fixedCount: 0 });

  it('Z1 maxRounds=0 → 不跑任何轮', () => {
    let calls = 0;
    const result = runFixUntilClean(md => { calls += 1; return shrinkAA(md); }, 'AAAA', 0);
    expect(result).toEqual({ markdown: 'AAAA', fixedCount: 0 });
    expect(calls).toBe(0);
  });
  it('Z1 maxRounds=1 → 只跑一轮', () => {
    expect(runFixUntilClean(shrinkAA, 'AAAA', 1)).toEqual({ markdown: 'AAA', fixedCount: 1 });
  });
  it('Z1 maxRounds=2 → 两轮截断', () => {
    expect(runFixUntilClean(shrinkAA, 'AAAA', 2)).toEqual({ markdown: 'AA', fixedCount: 2 });
  });
  it('Z1 每轮报告 2 处累计（total 累加语义）', () => {
    const twoPerRound: Fixer = md => (md.includes('AA')
      ? { markdown: md.replace('AA', 'A'), fixedCount: 2 }
      : { markdown: md, fixedCount: 0 });
    const result = runFixUntilClean(twoPerRound, 'AAAA', 3);
    expect(result.markdown).toBe('A');
    expect(result.fixedCount).toBe(6);
  });
  it('Z1 修复器改变长度后继续收敛', () => {
    const expand: Fixer = md => (md.includes('A')
      ? { markdown: md.replace('A', 'XAY'), fixedCount: 1 }
      : { markdown: md, fixedCount: 0 });
    const result = runFixUntilClean(expand, 'A', 3);
    expect(result.markdown).toBe('XXXAYYY');
    expect(result.fixedCount).toBe(3);
  });
  it('Z1 假修复（markdown 不变 fixedCount>0）循环到轮次上限', () => {
    const fake: Fixer = md => ({ markdown: md, fixedCount: 1 });
    const result = runFixUntilClean(fake, '原文', 3);
    expect(result).toEqual({ markdown: '原文', fixedCount: 3 });
  });
  it('Z1 修复器返回空 fixedCount 但 markdown 改变 → 不采纳该 markdown', () => {
    const mutateButZero: Fixer = () => ({ markdown: '篡改后文本', fixedCount: 0 });
    expect(runFixUntilClean(mutateButZero, '原文')).toEqual({ markdown: '原文', fixedCount: 0 });
  });
  it('Z1 修复器抛异常 → 原样传播', () => {
    const boom: Fixer = () => { throw new Error('fixer exploded'); };
    expect(() => runFixUntilClean(boom, '原文')).toThrow('fixer exploded');
  });
  it('Z1 轮次内既有命中又有残留（3 轮后残留）', () => {
    const result = runFixUntilClean(shrinkAA, 'AAAAAAAAAA', 3);
    expect(result.markdown).toBe('AAAAAAA');
    expect(result.fixedCount).toBe(3);
  });
});

describe('Z2 runDeterministicChainUntilConverged 链级收敛循环深挖', () => {
  it('Z2 空修复器链 → 原文不变零计数', () => {
    expect(runDeterministicChainUntilConverged([], '原文')).toEqual({ markdown: '原文', fixedCount: 0 });
  });
  it('Z2 maxRounds=0 → 不跑任何轮', () => {
    let calls = 0;
    const counting: Fixer = md => { calls += 1; return { markdown: md, fixedCount: 0 }; };
    expect(runDeterministicChainUntilConverged([counting], '原文', 0).fixedCount).toBe(0);
    expect(calls).toBe(0);
  });
  it('Z2 maxRounds=1 → 单轮截断', () => {
    const toB: Fixer = md => (md.includes('A') ? { markdown: md.replace('A', 'B'), fixedCount: 1 } : { markdown: md, fixedCount: 0 });
    const result = runDeterministicChainUntilConverged([toB], 'AAAA', 1);
    expect(result.markdown).toBe('BAAA');
    expect(result.fixedCount).toBe(1);
  });
  it('Z2 三修复器链序执行', () => {
    const s1: Fixer = md => (md.includes('1') ? { markdown: md.replaceAll('1', '2'), fixedCount: 1 } : { markdown: md, fixedCount: 0 });
    const s2: Fixer = md => (md.includes('2') ? { markdown: md.replaceAll('2', '3'), fixedCount: 1 } : { markdown: md, fixedCount: 0 });
    const s3: Fixer = md => (md.includes('3') ? { markdown: md.replaceAll('3', '4'), fixedCount: 1 } : { markdown: md, fixedCount: 0 });
    const result = runDeterministicChainUntilConverged([s1, s2, s3], '111');
    expect(result.markdown).toBe('444');
    expect(result.fixedCount).toBe(3);
  });
  it('Z2 多轮累计 total（每轮两修复器各命中）', () => {
    const toB: Fixer = md => (md.includes('A') ? { markdown: md.replace('A', 'B'), fixedCount: 1 } : { markdown: md, fixedCount: 0 });
    const toC: Fixer = md => (md.includes('B') ? { markdown: md.replace('B', 'C'), fixedCount: 1 } : { markdown: md, fixedCount: 0 });
    const result = runDeterministicChainUntilConverged([toB, toC], 'AAAA');
    expect(result.markdown).toBe('CCCA');
    expect(result.fixedCount).toBe(6);
  });
  it('Z2 互搏循环（A→B、B→A）跑到 maxRounds 上限', () => {
    const toB: Fixer = md => (md.includes('A') ? { markdown: md.replaceAll('A', 'B'), fixedCount: 1 } : { markdown: md, fixedCount: 0 });
    const toA: Fixer = md => (md.includes('B') ? { markdown: md.replaceAll('B', 'A'), fixedCount: 1 } : { markdown: md, fixedCount: 0 });
    const result = runDeterministicChainUntilConverged([toB, toA], 'AA', 3);
    expect(result.markdown).toBe('AA');
    expect(result.fixedCount).toBe(6);
  });
  it('Z2 第二轮整链无进展 → 立即跳出', () => {
    let firstRound = true;
    const once: Fixer = md => {
      if (firstRound) { firstRound = false; return { markdown: md.replace('A', 'B'), fixedCount: 1 }; }
      return { markdown: md, fixedCount: 0 };
    };
    const result = runDeterministicChainUntilConverged([once], 'AAAA', 5);
    expect(result.markdown).toBe('BAAA');
    expect(result.fixedCount).toBe(1);
  });
  it('Z2 单修复器链行为等价 runFixUntilClean', () => {
    const shrink: Fixer = md => (md.includes('AA') ? { markdown: md.replace('AA', 'A'), fixedCount: 1 } : { markdown: md, fixedCount: 0 });
    expect(runDeterministicChainUntilConverged([shrink], 'AAAAAA', 3)).toEqual({ markdown: 'AAA', fixedCount: 3 });
  });
  it('Z2 修复器大 fixedCount 累计', () => {
    const big: Fixer = md => (md.includes('A') ? { markdown: md.replace('A', 'B'), fixedCount: 7 } : { markdown: md, fixedCount: 0 });
    const result = runDeterministicChainUntilConverged([big], 'AAA', 1);
    expect(result.fixedCount).toBe(7);
  });
  it('Z2 前修复器输出供后修复器消费（单轮内链式）', () => {
    const toB: Fixer = md => (md.includes('A') ? { markdown: md.replaceAll('A', 'B'), fixedCount: 1 } : { markdown: md, fixedCount: 0 });
    const toC: Fixer = md => (md.includes('B') ? { markdown: md.replaceAll('B', 'C'), fixedCount: 1 } : { markdown: md, fixedCount: 0 });
    const result = runDeterministicChainUntilConverged([toB, toC], 'ABA', 1);
    expect(result.markdown).toBe('CCC');
    expect(result.fixedCount).toBe(2);
  });
});

describe('Z3 tablePeakLaborWithChainFallback 链回退深挖', () => {
  const table = (rows: string[]) => ['| 施工阶段 | 投入人数 |', '| --- | --- |', ...rows].join('\n');

  it('Z3 箭头链真实行为：只取高峰词后首值（22→35→45→68→30 → 22）', () => {
    // 探针锁定：PEAK_LABOR_RE 从「高峰」起非贪婪匹配首个数字，链上后续值无高峰前缀词不匹配；
    // 注释宣称「取链内最大值」的箭头链形态实际返回首值 22（真实实现行为锁定，不改实现）
    expect(tablePeakLaborWithChainFallback('高峰22人→35人→45人→68人→30人。')).toBe(22);
  });
  it('Z3 劳动力按链（无高峰前缀词）→ undefined', () => {
    expect(tablePeakLaborWithChainFallback('劳动力按32人→86人→48人分阶段投入。')).toBeUndefined();
  });
  it('Z3 链首值带阶段限定 → 全链过滤 undefined', () => {
    expect(tablePeakLaborWithChainFallback('主体结构阶段高峰22人→35人。')).toBeUndefined();
  });
  it('Z3 逗号分段：总口径链值保留、阶段限定值过滤', () => {
    expect(tablePeakLaborWithChainFallback('高峰22人→35人，装饰装修阶段高峰40人。')).toBe(22);
  });
  it('Z3 空表体表格（表头+分隔行无数据行）→ 链兜底', () => {
    expect(tablePeakLaborWithChainFallback(`${table([])}\n高峰期投入220人。`)).toBe(220);
  });
  it('Z3 分工种表不进全员峰值池 → 链兜底', () => {
    const tradeTable = ['| 工种 | 人数 |', '| --- | --- |', '| 普工 | 34 |', '高峰期投入220人。'].join('\n');
    expect(tablePeakLaborWithChainFallback(tradeTable)).toBe(220);
  });
  it('Z3 表峰值与链并存 → 表优先', () => {
    expect(tablePeakLaborWithChainFallback(`${table(['| 主体结构 | 186 |'])}\n高峰期投入220人。`)).toBe(186);
  });
  it('Z3 表峰值小于链峰值仍表优先', () => {
    expect(tablePeakLaborWithChainFallback(`${table(['| 主体结构 | 95 |'])}\n高峰期投入220人。`)).toBe(95);
  });
  it('Z3 约形态数值', () => {
    expect(tablePeakLaborWithChainFallback('高峰约220人。')).toBe(220);
  });
  it('Z3 峰值前缀形态', () => {
    expect(tablePeakLaborWithChainFallback('峰值260人。')).toBe(260);
  });
  it('Z3 负号被窗口吞入只提取正数部分（高峰约-5人 → 5）', () => {
    // 真实行为锁定：[\d,]+ 字符类不含负号，「-」落入前置窗口，5 被提取
    expect(tablePeakLaborWithChainFallback('高峰约-5人。')).toBe(5);
  });
  it('Z3 零值过滤 → undefined', () => {
    expect(tablePeakLaborWithChainFallback('高峰0人。')).toBeUndefined();
  });
  it('Z3 多值总口径取最大（220 vs 300 → 300）', () => {
    expect(tablePeakLaborWithChainFallback('高峰期220人。高峰期300人。')).toBe(300);
  });
  it('Z3 分号阻断窗口：两句独立取值取最大', () => {
    expect(tablePeakLaborWithChainFallback('高峰期投入220人；高峰期投入300人')).toBe(300);
  });
  it('Z3 混合口径只取总口径最大值', () => {
    expect(tablePeakLaborWithChainFallback('高峰期220人。装饰装修阶段高峰期90人。')).toBe(220);
  });
  it('Z3 全部峰值带阶段限定 → undefined', () => {
    expect(tablePeakLaborWithChainFallback('主体结构阶段高峰期220人。装饰装修阶段高峰期90人。')).toBeUndefined();
  });
  it('Z3 千分位数值', () => {
    expect(tablePeakLaborWithChainFallback('高峰期1,200人。')).toBe(1200);
  });
  it('Z3 多表取最大峰值', () => {
    const twoTables = `${table(['| 主体结构 | 186 |'])}\n正文说明。\n${table(['| 施工准备 | 95 |'])}`;
    expect(tablePeakLaborWithChainFallback(twoTables)).toBe(186);
  });
  it('Z3 无表无峰值 → undefined', () => {
    expect(tablePeakLaborWithChainFallback('施工管理规范。')).toBeUndefined();
  });
  it('Z3 20 字窗口内约形态仍提取', () => {
    expect(tablePeakLaborWithChainFallback('高峰期投入劳动力约220人。')).toBe(220);
  });
});

describe('Z4 excavationHazardClassificationIssues 危大分级矩阵', () => {
  const depthModel = (value: string) => factsOf({ canonical: { byKey: { excavation_depth: { value } } } as never });

  it('Z4 深度 2.99m → 早退 0 条', () => {
    expect(excavationHazardClassificationIssues('正文无标注。', depthModel('2.99m'))).toHaveLength(0);
  });
  it('Z4 深度恰 3.0m → 报危大 1 条', () => {
    const issues = excavationHazardClassificationIssues('正文无标注。', depthModel('3m'));
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('危大工程判定缺失');
  });
  it('Z4 深度 4.99m → 报危大 1 条（不报超危大）', () => {
    const issues = excavationHazardClassificationIssues('正文无标注。', depthModel('4.99m'));
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('危大工程判定缺失');
  });
  it('Z4 深度恰 5.0m → 报 2 条', () => {
    expect(excavationHazardClassificationIssues('正文无标注。', depthModel('5m'))).toHaveLength(2);
  });
  it('Z4 深度 5.85m 报 2 条且 message 注入数值', () => {
    const issues = excavationHazardClassificationIssues('正文无标注。', depthModel('5.85m'));
    expect(issues).toHaveLength(2);
    expect(issues[0].message).toContain('5.85');
    expect(issues[1].message).toContain('5.85');
  });
  it('Z4 3m 正文已有危大标注 → 0 条', () => {
    expect(excavationHazardClassificationIssues('本工程属危大工程。', depthModel('3m'))).toHaveLength(0);
  });
  it('Z4 5.5m 有危大无超危大 → 报 1 条超危大', () => {
    const issues = excavationHazardClassificationIssues('本工程属危大工程。', depthModel('5.5m'));
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('超过一定规模');
  });
  it('Z4 5.5m 有超危大无危大 → 报 1 条危大', () => {
    const issues = excavationHazardClassificationIssues('本工程属于超过一定规模需专家论证。', depthModel('5.5m'));
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('危大工程判定缺失');
  });
  it('Z4 深度来自 drawings 事实（关键词门命中）', () => {
    const model = factsOf({ drawings: [factOf({ fieldName: '基坑深度', value: '5.5m' })] });
    expect(excavationHazardClassificationIssues('正文无标注。', model)).toHaveLength(2);
  });
  it('Z4 深度来自 preciseFacts 事实', () => {
    const model = factsOf({ preciseFacts: [factOf({ fieldName: '基坑开挖深度', value: '4m' })] });
    expect(excavationHazardClassificationIssues('正文无标注。', model)).toHaveLength(1);
  });
  it('Z4 canonical 比较式条文排除（开挖深度16m及以上）→ 0 条', () => {
    const issues = excavationHazardClassificationIssues('正文无标注。', depthModel('开挖深度16m及以上'));
    expect(issues).toHaveLength(0);
  });
  it('Z4 空 factsModel → 0 条', () => {
    expect(excavationHazardClassificationIssues('正文无标注。', factsOf({}))).toHaveLength(0);
  });
  it('Z4 深度 0.5m 过小过滤 → 0 条', () => {
    expect(excavationHazardClassificationIssues('正文无标注。', depthModel('0.5m'))).toHaveLength(0);
  });
  it('Z4 深度 60m 过大过滤 → 0 条', () => {
    expect(excavationHazardClassificationIssues('正文无标注。', depthModel('60m'))).toHaveLength(0);
  });
  it('Z4 4m 正文已报超危大（过度标注）→ 仍报危大缺失', () => {
    const issues = excavationHazardClassificationIssues('本工程属于超过一定规模需专家论证。', depthModel('4m'));
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('危大工程判定缺失');
  });
});

describe('Z5 selfUnderminingCandidateIssues 自伤表述语义矩阵', () => {
  beforeEach(() => {
    vi.mocked(buildSemanticSimilarity).mockImplementation(CONST_SIM(0.9));
  });

  it('Z5 语义相似度 0.6 恰阈值 → 报候选', async () => {
    vi.mocked(buildSemanticSimilarity).mockImplementation(CONST_SIM(0.6));
    const issues = await selfUnderminingCandidateIssues('专项设计文件尚未完成，相关内容待后续补充。');
    expect(issues).toHaveLength(1);
  });
  it('Z5 语义相似度 0.59 低于阈值 → 不报', async () => {
    vi.mocked(buildSemanticSimilarity).mockImplementation(CONST_SIM(0.59));
    expect(await selfUnderminingCandidateIssues('专项设计文件尚未完成，相关内容待后续补充。')).toEqual([]);
  });
  it('Z5 12 字恰阈值句报出', async () => {
    // '专项设计文件尚未完成补充' = 12 字（长度门槛 >= 12）
    expect(await selfUnderminingCandidateIssues('专项设计文件尚未完成补充')).toHaveLength(1);
  });
  it('Z5 11 字句不报', async () => {
    // '专项设计文件尚未完成补' = 11 字 < 12 过滤
    expect(await selfUnderminingCandidateIssues('专项设计文件尚未完成补')).toEqual([]);
  });
  it('Z5 正向豁免三形态全谱系', async () => {
    const positiveForms = [
      '编制范围为招标文件所界定的全部施工内容。',
      '专项设计文件尚未完成的内容作为施工组织的控制性约束条件。',
      '分项验收，验收记录经监理工程师签字确认后归档。',
    ];
    for (const form of positiveForms) {
      expect(await selfUnderminingCandidateIssues(form)).toEqual([]);
    }
  });
  it('Z5 多行不同句各报（3 条）', async () => {
    const md = '专项设计文件尚未完成，待后续补充。\n评分指标存在缺口尚未明确。\n依据承诺函后续跟踪完善事项。';
    expect(await selfUnderminingCandidateIssues(md)).toHaveLength(3);
  });
  it('Z5 列表行排除（- * + 三前缀）', async () => {
    expect(await selfUnderminingCandidateIssues('- 专项设计文件尚未完成')).toEqual([]);
    expect(await selfUnderminingCandidateIssues('* 专项设计文件尚未完成')).toEqual([]);
    expect(await selfUnderminingCandidateIssues('+ 专项设计文件尚未完成')).toEqual([]);
  });
  it('Z5 引用行排除', async () => {
    expect(await selfUnderminingCandidateIssues('> 专项设计文件尚未完成')).toEqual([]);
  });
  it('Z5 句内多句：前句不命中后句命中 → 1 条', async () => {
    const issues = await selfUnderminingCandidateIssues('工程概况说明段落。专项设计文件尚未完成，待后续补充。');
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('尚未完成');
  });
  it('Z5 无标点整行整句判定', async () => {
    expect(await selfUnderminingCandidateIssues('专项设计文件尚未完成待后续补充')).toHaveLength(1);
  });
  it('Z5 message 含原文与 suggestion 正向指引', async () => {
    const issues = await selfUnderminingCandidateIssues('专项设计文件尚未完成，相关内容待后续补充。');
    expect(issues[0].message).toContain('专项设计文件尚未完成');
    expect(issues[0].suggestion).toContain('投标文件不得主动暴露');
  });
  it('Z5 空文档 → 0 条', async () => {
    expect(await selfUnderminingCandidateIssues('')).toEqual([]);
  });
  it('Z5 前导空白行跳过', async () => {
    const issues = await selfUnderminingCandidateIssues('   \n专项设计文件尚未完成，相关内容待后续补充。');
    expect(issues).toHaveLength(1);
  });
  it('Z5 超过 3 条截断 slice(0,3)', async () => {
    const md = '专项设计文件尚未完成，待后续补充。\n评分指标存在缺口尚未明确。\n依据承诺函后续跟踪完善事项。\n相关内容待后续补充完善。';
    expect(await selfUnderminingCandidateIssues(md)).toHaveLength(3);
  });
  it('Z5 相同句去重 → 1 条', async () => {
    const md = '专项设计文件尚未完成，相关内容待后续补充。\n专项设计文件尚未完成，相关内容待后续补充。';
    expect(await selfUnderminingCandidateIssues(md)).toHaveLength(1);
  });
  it('Z5 语义高分但正向豁免句混排 → 仅豁免句不报', async () => {
    const md = '编制范围为招标文件所界定的全部施工内容。\n评分指标存在缺口尚未明确。';
    expect(await selfUnderminingCandidateIssues(md)).toHaveLength(1);
  });
});

describe('Z6 sixHundredPercentCoverageIssues 词面全谱系矩阵', () => {
  const FIVE_STANDARD = '施工工地周边100%围挡。物料堆放100%覆盖。出入车辆100%冲洗。施工现场地面100%硬化。拆迁工地100%湿法作业。渣土车辆100%密闭运输。';
  const withMissing = (present: string) => `落实扬尘治理要求。${present}`;

  beforeEach(() => {
    vi.mocked(buildSemanticSimilarity).mockImplementation(CONST_SIM(0.1));
  });

  it.each([
    ['围挡标准形态', '施工工地周边100%围挡。'],
    ['围挡简形态', '现场周边100%围挡。'],
    ['覆盖标准形态', '物料堆放100%覆盖。'],
    ['覆盖密目网前置', '密目网全覆盖堆场。'],
    ['覆盖密目网后置', '堆场覆盖密目网。'],
    ['冲洗标准形态', '出入车辆100%冲洗。'],
    ['冲洗车辆短距', '车辆冲洗设施完备。'],
    ['冲洗反向形态', '冲洗设施清洗车辆。'],
    ['冲洗点形态', '出入口设置冲洗点。'],
    ['硬化标准形态', '施工现场地面100%硬化。'],
    ['硬化简形态', '现场地面100%硬化。'],
    ['湿法标准形态', '拆迁工地100%湿法作业。'],
    ['湿法短距形态', '拆迁区域湿法作业。'],
    ['湿法反向形态', '湿法作业覆盖拆迁区域。'],
    ['密闭标准形态', '渣土车辆100%密闭运输。'],
    ['密闭运输形态', '渣土车辆密闭运输。'],
    ['密闭式形态', '渣土车密闭式运输。'],
  ] as const)('Z6 词面命中：%s → 不报', async (_label, form) => {
    const md = withMissing(`${form}${FIVE_STANDARD.replace(`${form.split('。')[0]}。`, '')}`);
    expect(await sixHundredPercentCoverageIssues(md)).toEqual([]);
  });

  it('Z6 语义命中（无词面句）→ 六项不报', async () => {
    vi.mocked(buildSemanticSimilarity).mockImplementation(CONST_SIM(0.9));
    const md = '落实扬尘治理要求。现场四周设置连续围挡。材料堆场覆盖防尘网。出场车辆进行冲洗。场地地面全部硬化。拆迁区域湿法降尘。渣土车辆密闭运输。';
    expect(await sixHundredPercentCoverageIssues(md)).toEqual([]);
  });
  it('Z6 语义低分（无词面句）→ 词面兜底命中冲洗/密闭两项后报 2/6', async () => {
    // 真实行为锁定：'车辆…冲洗' 命中出入车辆词面兑底（车辆.{0,10}冲洗）、'密闭运输' 命中渣土密闭词面兑底
    const md = '落实扬尘治理要求。现场四周设置连续围挡。材料堆场覆盖防尘网。出场车辆进行冲洗。场地地面全部硬化。拆迁区域湿法降尘。渣土车辆密闭运输。';
    const issues = await sixHundredPercentCoverageIssues(md);
    expect(issues[0].message).toContain('2/6 项命中');
  });
  it('Z6 缺 3 项 → 报 3/6', async () => {
    const issues = await sixHundredPercentCoverageIssues(withMissing('施工工地周边100%围挡。物料堆放100%覆盖。出入车辆100%冲洗。'));
    expect(issues[0].message).toContain('3/6 项命中');
  });
  it('Z6 缺 5 项 → 报 1/6', async () => {
    const issues = await sixHundredPercentCoverageIssues(withMissing('施工工地周边100%围挡。'));
    expect(issues[0].message).toContain('1/6 项命中');
  });
  it('Z6 全缺 → 报 0/6', async () => {
    const issues = await sixHundredPercentCoverageIssues('落实扬尘治理要求。');
    expect(issues[0].message).toContain('0/6 项命中');
  });
  it.each(['无拆迁', '不涉及拆迁', '无房屋拆除', '无拆除'] as const)('Z6 拆迁豁免形态：%s', async (negation) => {
    const md = withMissing(`本项目${negation}。${FIVE_STANDARD.replace('拆迁工地100%湿法作业。', '')}`);
    expect(await sixHundredPercentCoverageIssues(md)).toEqual([]);
  });
  it.each(['本项目', '本工程', '该工程', '该项目', '本标段', '本施工项目'] as const)('Z6 豁免主语：%s', async (subject) => {
    const md = withMissing(`${subject}无拆迁。${FIVE_STANDARD.replace('拆迁工地100%湿法作业。', '')}`);
    expect(await sixHundredPercentCoverageIssues(md)).toEqual([]);
  });
  it('Z6 主语与否定词恰 30 字窗口内 → 豁免', async () => {
    const md = withMissing(`本项目${'占'.repeat(30)}无拆迁。${FIVE_STANDARD.replace('拆迁工地100%湿法作业。', '')}`);
    expect(await sixHundredPercentCoverageIssues(md)).toEqual([]);
  });
  it('Z6 主语与否定词 31 字超窗 → 不豁免', async () => {
    const md = withMissing(`本项目${'占'.repeat(31)}无拆迁。${FIVE_STANDARD.replace('拆迁工地100%湿法作业。', '')}`);
    const issues = await sixHundredPercentCoverageIssues(md);
    expect(issues[0].message).toContain('拆迁工地100%湿法作业');
  });
  it('Z6 6 字符扬尘句不入语义池（词面兑底失效）→ 报缺失', async () => {
    vi.mocked(buildSemanticSimilarity).mockImplementation(CONST_SIM(0.9));
    // '现场临时围挡' = 6 字符 <8 不入池，词面兑底判定同池 → 围挡项报缺失
    const md = '扬尘治理措施。\n现场临时围挡';
    const issues = await sixHundredPercentCoverageIssues(md);
    expect(issues[0].message).toContain('施工工地周边100%围挡');
  });
  it('Z6 8 字符扬尘句入语义池 → 语义命中不报', async () => {
    vi.mocked(buildSemanticSimilarity).mockImplementation(CONST_SIM(0.9));
    const md = withMissing(`现场设置围挡措施。${FIVE_STANDARD.replace('施工工地周边100%围挡。', '')}`);
    expect(await sixHundredPercentCoverageIssues(md)).toEqual([]);
  });
  it('Z6 120 字句入语义池 → 语义命中不报', async () => {
    vi.mocked(buildSemanticSimilarity).mockImplementation(CONST_SIM(0.9));
    const long = `围挡${'措施'.repeat(59)}。`; // 2 + 118 = 120 字
    const md = withMissing(`${long}${FIVE_STANDARD.replace('施工工地周边100%围挡。', '')}`);
    expect(await sixHundredPercentCoverageIssues(md)).toEqual([]);
  });
  it('Z6 121 字句不入语义池 → 报缺失', async () => {
    vi.mocked(buildSemanticSimilarity).mockImplementation(CONST_SIM(0.9));
    // '扬尘'+'措施'×59+'施' = 2+118+1 = 121 字，唯一句不入池 → dustSentences 空 → 六项全缺
    const long = `扬尘${'措施'.repeat(59)}施`;
    const issues = await sixHundredPercentCoverageIssues(long);
    expect(issues[0].message).toContain('0/6 项命中');
  });
  it('Z6 标题行不入语义池（词面兑底同池失效）→ 报缺失', async () => {
    const md = '扬尘治理措施。\n## 现场周边100%围挡';
    const issues = await sixHundredPercentCoverageIssues(md);
    expect(issues[0].message).toContain('施工工地周边100%围挡');
  });
  it('Z6 表格行不入语义池（词面兑底同池失效）→ 报缺失', async () => {
    const md = '扬尘治理措施。\n| 现场周边100%围挡 | 落实 |';
    const issues = await sixHundredPercentCoverageIssues(md);
    expect(issues[0].message).toContain('施工工地周边100%围挡');
  });
  it('Z6 行无预筛词面不入池（反向语义模拟器锁定）', async () => {
    // 喷淋句无预筛词面（围挡/覆盖/…/降尘）→ 不入池；若预筛失效喷淋句入池则反向 mock 高分全命中
    const inverted = async (_leftTexts: string[], _rightTexts: string[]) => (_left: string, right: string): number => (right.includes('喷淋') ? 0.9 : 0.1);
    vi.mocked(buildSemanticSimilarity).mockImplementation(inverted);
    const md = '扬尘治理措施。\n现场设置喷淋系统。';
    const issues = await sixHundredPercentCoverageIssues(md);
    expect(issues[0].message).toContain('0/6 项命中');
  });
  it('Z6 缺失项 message 按六项定义序排列', async () => {
    const issues = await sixHundredPercentCoverageIssues('落实扬尘治理要求。');
    const message = issues[0].message;
    const order = ['施工工地周边100%围挡', '物料堆放100%覆盖', '出入车辆100%冲洗', '施工现场地面100%硬化', '拆迁工地100%湿法作业', '渣土车辆100%密闭运输'];
    let lastIndex = -1;
    for (const item of order) {
      const index = message.indexOf(item);
      expect(index).toBeGreaterThan(lastIndex);
      lastIndex = index;
    }
  });
  it('Z6 无扬尘内容 → 不检测', async () => {
    expect(await sixHundredPercentCoverageIssues('本工程施工管理规范。')).toEqual([]);
  });
  it('Z6 扬尘词面行混入标题/表格 → 不误判', async () => {
    const md = `落实扬尘治理要求。\n## 扬尘治理措施\n| 项目 | 内容 |\n| --- | --- |\n| 围挡 | 100% |`;
    const issues = await sixHundredPercentCoverageIssues(md);
    expect(issues[0].message).toContain('0/6 项命中');
  });
});

describe('Z7 bodySentencesForSemantic 句采样边界', () => {
  const sentenceOf = (index: number) => `第${index}项施工管理措施落实到位。`;

  it('Z7 空文档 → 空数组', () => {
    expect(bodySentencesForSemantic('')).toEqual([]);
  });
  it('Z7 3 句全收', () => {
    const md = Array.from({ length: 3 }, (_, i) => sentenceOf(i)).join('\n');
    expect(bodySentencesForSemantic(md)).toHaveLength(3);
  });
  it('Z7 400 句全收', () => {
    const md = Array.from({ length: 400 }, (_, i) => sentenceOf(i)).join('\n');
    expect(bodySentencesForSemantic(md)).toHaveLength(400);
  });
  it('Z7 401 句 → stride 2 均匀采样 201 条', () => {
    const md = Array.from({ length: 401 }, (_, i) => sentenceOf(i)).join('\n');
    expect(bodySentencesForSemantic(md)).toHaveLength(201);
  });
  it('Z7 800 句 → stride 2 采样 400 条', () => {
    const md = Array.from({ length: 800 }, (_, i) => sentenceOf(i)).join('\n');
    expect(bodySentencesForSemantic(md)).toHaveLength(400);
  });
  it('Z7 801 句 → stride 3 采样 267 条', () => {
    const md = Array.from({ length: 801 }, (_, i) => sentenceOf(i)).join('\n');
    expect(bodySentencesForSemantic(md)).toHaveLength(267);
  });
  it('Z7 相同句去重', () => {
    expect(bodySentencesForSemantic('第一句措施落实到位。\n第一句措施落实到位。')).toHaveLength(1);
  });
  it('Z7 7 字句过滤', () => {
    expect(bodySentencesForSemantic('现场设置围挡板')).toEqual([]);
  });
  it('Z7 120 字句保留、121 字句过滤', () => {
    const at120 = '措施'.repeat(60); // 120 字
    const at121 = `${'措施'.repeat(60)}施`; // 121 字
    expect(bodySentencesForSemantic(at120)).toHaveLength(1);
    expect(bodySentencesForSemantic(at121)).toEqual([]);
  });
  it('Z7 标题行排除', () => {
    expect(bodySentencesForSemantic('## 第一句措施落实到位')).toEqual([]);
  });
  it('Z7 表格行排除', () => {
    expect(bodySentencesForSemantic('| 第一句措施落实到位 |')).toEqual([]);
  });
  it('Z7 分号分句', () => {
    expect(bodySentencesForSemantic('第一句措施落实到位；第二句措施落实到位。')).toHaveLength(2);
  });
  it('Z7 空行跳过', () => {
    expect(bodySentencesForSemantic('\n\n第一句措施落实到位。\n\n')).toHaveLength(1);
  });
  it('Z7 混合长度过滤', () => {
    const md = '短句。\n第一句措施落实到位。\n第二句措施落实到位。';
    expect(bodySentencesForSemantic(md)).toHaveLength(2);
  });
  it('Z7 采样含首条（均匀采样非尾部截断）', () => {
    const md = Array.from({ length: 401 }, (_, i) => sentenceOf(i)).join('\n');
    const sampled = bodySentencesForSemantic(md);
    expect(sampled[0]).toBe(sentenceOf(0));
  });
  it('Z7 采样含尾部句（历史缺陷：slice 只取前部致中后部句全在采样外）', () => {
    const md = Array.from({ length: 800 }, (_, i) => sentenceOf(i)).join('\n');
    const sampled = bodySentencesForSemantic(md);
    expect(sampled).toContain(sentenceOf(798));
  });
});
