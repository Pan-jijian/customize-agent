/**
 * 章级供给面度量防回归。
 *
 * 历史缺陷：供给面只数蓝图 `requiredParams`（仅由清单工作包的 quantities 生成），
 * 于是凡不是清单驱动工作包的章（工程概况、物资计划、质量/安全/工期措施…）恒为 0，
 * 丰乐镇实测 9/10 章被判「可用量化参数 0 个」并标红——而同一套蓝图产出的成稿实测
 * 每千字 2.5 个量化参数（专业评分「事实落位率」）、2.2 个工艺参数，两者不可能同时成立。
 * 正文的量化参数来自多路供给，只数一路即把「本项目正常」误报成「要不到料」。
 */
import { describe, expect, it } from 'vitest';
import { assessChapterSupplyDemand, collectChapterParameterSupply } from '@/services/document-workflow/integratedBlueprint/capacity';

describe('collectChapterParameterSupply', () => {
  it('三通道按归一化 token 去重合并（同一参数在多路出现只计一次）', () => {
    const channels = collectChapterParameterSupply({
      blueprintParams: ['C30'],
      billSpecs: ['C30', 'DN200'],
      evidenceTokens: ['dn200', ' 100W '],
    });
    // 各通道各自去重：blueprint {c30}、bill {c30, dn200}、evidence {dn200, 100w}
    expect(channels.blueprint).toBe(1);
    expect(channels.bill).toBe(2);
    expect(channels.evidence).toBe(2);
    // 并集 {c30, dn200, 100w} = 3 —— C30 与 dn200 跨通道重复只计一次
    expect(channels.total).toBe(3);
  });

  it('大小写与空白归一后再比对（DN200 / dn200 / DN 200 视为同一参数）', () => {
    const channels = collectChapterParameterSupply({
      billSpecs: ['DN200'],
      evidenceTokens: ['dn200', 'DN 200'],
    });
    expect(channels.total).toBe(1);
  });

  it('本章需求解析事实通道参与去重（写作端 factsForChapterNeeds 那一路）', () => {
    const channels = collectChapterParameterSupply({
      billSpecs: ['DN200'],
      factValues: ['DN200', 'C30', '1:50'],
    });
    expect(channels.bill).toBe(1);
    expect(channels.factNeeds).toBe(3);
    // DN200 跨通道重复只计一次 → 并集 {dn200, c30, 1:50} = 3
    expect(channels.total).toBe(3);
  });

  it('空通道不报错，全空时 total = 0', () => {
    expect(collectChapterParameterSupply({})).toEqual({ blueprint: 0, bill: 0, evidence: 0, factNeeds: 0, total: 0 });
    expect(collectChapterParameterSupply({ blueprintParams: ['', '   '] }).total).toBe(0);
  });
});

describe('assessChapterSupplyDemand', () => {
  it('达标判定：可用参数 ≥ 目标字数×1.5/千字 即充足', () => {
    const ok = assessChapterSupplyDemand({ chapterTitle: '工程概况', targetWords: 2000, availableParameters: 3 });
    expect(ok.requiredParameters).toBe(3);
    expect(ok.sufficient).toBe(true);
    expect(ok.remediation).toEqual([]);
  });

  it('不足时给出分通道计数（说明「可用量化参数 N 个」是怎么数出来的）', () => {
    const supply = collectChapterParameterSupply({ billSpecs: ['DN200'], evidenceTokens: ['C30'] });
    const bad = assessChapterSupplyDemand({ chapterTitle: '拟投入的主要物资计划', targetWords: 3000, availableParameters: supply.total, supplyChannels: supply });
    expect(bad.sufficient).toBe(false);
    expect(bad.requiredParameters).toBe(5);
    expect(bad.parameterShortfall).toBe(3);
    const joined = bad.remediation.join('\n');
    expect(joined).toContain('可用参数来源');
    expect(joined).toContain('本章责任清单行规格 1 个');
    expect(joined).toContain('本章证据精确 token 1 个');
    expect(joined).toContain('本章需求解析事实值');
    // 不得再宣称与检测端同源（检测端量的是正文，不是供给通道）
    expect(joined).not.toContain('检测端同源密度线');
    expect(joined).toContain('与块质检/构造审计同值');
  });

  it('未提供分通道明细时不追加来源行（历史调用方消息逐字兼容）', () => {
    const bad = assessChapterSupplyDemand({ chapterTitle: '工程概况', targetWords: 3000, availableParameters: 0 });
    expect(bad.remediation.join('\n')).not.toContain('可用参数来源');
  });

  it('回归一：非清单驱动章（蓝图 0 参数）有证据供给时不再被误报为「要不到料」', () => {
    // 丰乐镇形态：工程概况无蓝图 requiredParams，但证据里有精确参数
    const supply = collectChapterParameterSupply({
      blueprintParams: [],
      billSpecs: [],
      evidenceTokens: ['C30', 'DN200', '100W', '1:50'],
    });
    const assessment = assessChapterSupplyDemand({ chapterTitle: '工程概况', targetWords: 2331, availableParameters: supply.total, supplyChannels: supply });
    expect(supply.blueprint).toBe(0); // 蓝图确实一个参数都没声明
    expect(assessment.sufficient).toBe(true); // 但供给充足，不标红
  });

  it('回归二：物资计划类章（无证据 token）靠「本章需求解析事实」供数，不再被误判不足', () => {
    // 实跑形态：只数清单行得 0.90/千字被判不足；写作端同一章还从 factsForChapterNeeds 拿到参数
    const onlyBill = collectChapterParameterSupply({ billSpecs: ['DN200', 'C30', 'Φ110', '1:50', 'M7.5'] });
    expect(assessChapterSupplyDemand({ chapterTitle: '拟投入的主要物资计划', targetWords: 5556, availableParameters: onlyBill.total, supplyChannels: onlyBill }).sufficient).toBe(false);

    const withFacts = collectChapterParameterSupply({
      billSpecs: ['DN200', 'C30', 'Φ110', '1:50', 'M7.5'],
      factValues: ['C25', 'HRB400', 'DN300', '100W', '2.5m', '30cm'],
    });
    const assessment = assessChapterSupplyDemand({ chapterTitle: '拟投入的主要物资计划', targetWords: 5556, availableParameters: withFacts.total, supplyChannels: withFacts });
    expect(withFacts.factNeeds).toBe(6);
    expect(withFacts.total).toBe(11);
    expect(assessment.sufficient).toBe(true);
  });
});
