/**
 * W1 项目类型一致性防回归。
 *
 * 实测缺陷（巢湖）：光电新能源产业园标准化厂房项目被判乡村市政策略 → 蓝图产出
 * 「8 个自然村分组（1#厂房土建工程、1#厂房安装工程…）」（把单位工程当成自然村）→
 * 正文出现「自然村」10 处、「村内/村庄」9 处、「多村并行」7 处，与项目类型完全矛盾，
 * 而三层评分均未察觉。
 *
 * 根因：策略选择短路——「有清单分组 && 清单含 管网/道路/绿化/路灯 ≥3 类」即判乡村市政，
 * 而**任何带室外附属的园区/房建项目都必然满足**，且「有分组」只要清单按工作表分组就恒成立。
 */
import { describe, expect, it } from 'vitest';
import { resolveDerivationStrategy } from '@/services/document-workflow/blueprintDerivationStrategies';
import { projectTypeConsistencyIssues } from '@/services/document-workflow/documentIntegrityChecks';
import { parseBillOfQuantities } from '@/services/document-workflow/billOfQuantitiesParser';
import type { BillOfQuantitiesResult } from '@/services/document-workflow/billOfQuantitiesParser';

/** 构造清单：按「工程名称」分组（与真实清单同形态），条目覆盖管网/道路/绿化/照明四类信号 */
function boqWith(projectLabel: string, groups: string[]): BillOfQuantitiesResult {
  const chunks = groups.map((group, index) => ({
    chunkIndex: index,
    sectionTitle: '表格数据',
    content: [
      `工作表：1.1 E.1 分部分项工程量清单计价表｜表标题：E.1 分部分项工程量清单计价表 工程名称：${group} 标段： 第1页 共1页`,
      '| 序号 | 项目编码 | 项目名称 | 项目特征描述 | 计量单位 | 工程量 |',
      `| 1 | 040101001001 | 塑料管铺设 | 1．管径：DN200 | m | 100 |`,
      `| 2 | 040202001001 | 道路基层 | 1．厚度：20cm | m2 | 200 |`,
      `| 3 | 050102001001 | 栽植灌木 | 1．种类：栀子花 | 株 | 30 |`,
      `| 4 | 030412001001 | 一般路灯 | 1．规格：100W | 套 | 5 |`,
      '第1页 共1页',
    ].join('\n'),
  }));
  return parseBillOfQuantities({ chunks: chunks as never, sourceFile: `${projectLabel}.xls` });
}

describe('策略选型 · 乡村守卫', () => {
  it('产业园标准化厂房（含管网/道路/绿化/照明室外附属）→ 判房建，不得判乡村市政', () => {
    const boq = boqWith('巢湖', ['1#厂房土建工程', '1#厂房安装工程', '2#门卫土建工程', '室外附属工程', '室外安装工程']);
    const strategy = resolveDerivationStrategy({
      templateName: '巢湖市光电新能源产业园项目一东区标准化厂房二标段施工',
      basicFacts: '项目名称：巢湖市光电新能源产业园项目一东区标准化厂房二标段施工',
      chapterTitles: [],
      boq,
    });
    expect(strategy.id).not.toBe('village-municipal');
  });

  it('美丽宜居自然村建设项目 → 仍判乡村市政（回归：不得被守卫误伤）', () => {
    const boq = boqWith('丰乐镇', ['马老郢', '马圩', '白水塘', '双塘']);
    const strategy = resolveDerivationStrategy({
      templateName: '2026年度丰乐镇20个美丽宜居自然村建设项目',
      basicFacts: '项目名称：2026年度丰乐镇20个美丽宜居自然村建设项目',
      chapterTitles: [],
      boq,
    });
    expect(strategy.id).toBe('village-municipal');
  });

  it('分组称谓由策略提供：乡村=自然村分组，房建=单位工程', () => {
    const village = resolveDerivationStrategy({
      templateName: '某镇美丽宜居自然村建设项目', basicFacts: '自然村', chapterTitles: [],
      boq: boqWith('村', ['甲村', '乙村']),
    });
    expect(village.groupLabel).toBe('自然村分组');
    expect(village.villageOriented).toBe(true);
    const urban = resolveDerivationStrategy({
      templateName: '某产业园标准化厂房项目', basicFacts: '标准化厂房', chapterTitles: [],
      boq: boqWith('厂', ['1#厂房', '2#厂房']),
    });
    expect(urban.groupLabel).toBe('单位工程');
    expect(urban.villageOriented).toBeUndefined();
  });
});

describe('projectTypeConsistencyIssues · 类型一致性安全网', () => {
  it('非乡村项目出现乡村专有表述 → 阻断级问题（含逐词计数）', () => {
    const issues = projectTypeConsistencyIssues('本项目按8个自然村分组组织多村平行施工，村内流水作业，各村同步展开。', {
      projectName: '巢湖市光电新能源产业园项目一东区标准化厂房二标段施工',
      blueprintStrategyId: 'building',
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe('blocker');
    expect(issues[0]!.message).toContain('自然村');
    expect(issues[0]!.message).toContain('项目类型与正文用词矛盾');
  });

  it('乡村项目不受影响（策略乡村 或 项目名含乡村特征词）', () => {
    const text = '本项目按20个自然村分组组织多村平行施工。';
    expect(projectTypeConsistencyIssues(text, { projectName: '丰乐镇20个美丽宜居自然村建设项目', blueprintStrategyId: 'village-municipal' })).toHaveLength(0);
    expect(projectTypeConsistencyIssues(text, { projectName: '某县美丽宜居自然村建设项目', blueprintStrategyId: 'building' })).toHaveLength(0);
  });

  it('非乡村项目且无乡村表述 → 无问题（不误报）', () => {
    const issues = projectTypeConsistencyIssues('本项目按8个单位工程分组组织平行施工，室外附属工程同步展开。', {
      projectName: '巢湖市光电新能源产业园项目', blueprintStrategyId: 'building',
    });
    expect(issues).toHaveLength(0);
  });

  it('"村道"等中性词不误伤（仅多字乡村专有词判定）', () => {
    const issues = projectTypeConsistencyIssues('施工便道与村道路面恢复须同步完成。', {
      projectName: '某产业园项目', blueprintStrategyId: 'building',
    });
    expect(issues).toHaveLength(0);
  });
});

describe('安全目标承诺句兜底（W4）', () => {
  it('安全生产章未写安全目标 → 章首补入承诺句（写作侧要求已注入但模型未遵循）', async () => {
    const { ensureSafetyTargetStatement } = await import('@/services/document-workflow/documentIntegrityChecks');
    const chapters = [
      { title: '工程概况', content: '## 第一章 工程概况\n\n本项目位于……' },
      { title: '确保安全生产的技术组织措施', content: '## 第七章 确保安全生产的技术组织措施\n\n### 7.1 危险源辨识\n\n风险分级管控……' },
    ];
    const result = ensureSafetyTargetStatement(chapters);
    expect(result.insertedIn).toBe('确保安全生产的技术组织措施');
    const inserted = result.chapters[1]!.content;
    expect(inserted).toMatch(/安全(?:生产)?(?:管理)?目标/u);
    expect(inserted).toMatch(/杜绝/u); // 承诺语境词（评标响应度按「响应词 + 承诺语境同句」核验）
    // 插在章标题之后（章首开篇位置），原内容完整保留
    expect(inserted.split('\n')[0]).toContain('第七章');
    expect(inserted).toContain('7.1 危险源辨识');
  });

  it('已写安全目标 → 不重复插入（幂等）', async () => {
    const { ensureSafetyTargetStatement } = await import('@/services/document-workflow/documentIntegrityChecks');
    const chapters = [{ title: '确保安全生产的技术组织措施', content: '## 第七章\n\n本工程安全生产目标：杜绝重伤及以上事故。\n\n### 7.1 ……' }];
    expect(ensureSafetyTargetStatement(chapters).insertedIn).toBeUndefined();
  });

  it('无安全章 → 不改动任何章节', async () => {
    const { ensureSafetyTargetStatement } = await import('@/services/document-workflow/documentIntegrityChecks');
    const chapters = [{ title: '工程概况', content: '内容' }];
    const result = ensureSafetyTargetStatement(chapters);
    expect(result.insertedIn).toBeUndefined();
    expect(result.chapters[0]!.content).toBe('内容');
  });
});
