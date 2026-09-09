/**
 * 丰乐镇第 3 轮内容污染修复专项（用户评审三问题）：
 * 1. 本项目没有的工程出现在主要施工内容（清单章节套名「墙、柱面装饰与隔断、幕墙工程」照抄为标题）
 *    → headingUncoveredEngineeringItems 检测器（标题工程词必须在小节正文命中）
 * 2. 不能进入正文的内容进入正文（编制依据补充说明元话语块 + 资料未提供的图集编号引用）
 *    → supplementRequiredTexts 正式条目化（无「补充说明」标题/元话语）+ stripAtlasReferencePhrases 短语清洗
 * 3. 基本信息表污染（计划工期「90日历天2.9」编号粘连、质量标准「不流于形式、奖」残句、建设规模截断）
 *    → 事实值编号粘连截断 + rule 型 confidence 钳制 + 创优目标提取顿号排斥 + 规模类字段允许分号
 *
 * 原则：每条用例独立断言意义；真实实现行为一律锁定，不迎合用例改实现。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocumentEvidence, DocumentFact, DocumentTemplate } from '@/services/document-workflow/types';

vi.mock('@/services/document-workflow/qualityValidation', async importOriginal => {
  const actual = await importOriginal<typeof import('@/services/document-workflow/qualityValidation')>();
  return { ...actual, autoSpecGateRequiredTexts: vi.fn() };
});

import { supplementRequiredTexts } from '@/services/document-workflow/finalize/rebuildAndRecompute';
import { autoSpecGateRequiredTexts, headingUncoveredEngineeringItems } from '@/services/document-workflow/qualityValidation';
import { projectBasicInfoTableMarkdown, stripAtlasReferencePhrases } from '@/services/document-workflow/documentGeneratorHelpers';
import { buildCanonicalFacts } from '@/services/document-workflow/factGovernance';
import { extractStructuredFacts, fieldExtractionPattern } from '@/services/document-workflow/factsModel';

const mockedRequiredTexts = vi.mocked(autoSpecGateRequiredTexts);
const TEMPLATE = { id: 'tpl-round3', name: '施工组织设计', category: '房建', outputTitle: '', description: '' } as unknown as DocumentTemplate;

const fact = (extra: Partial<DocumentFact>): DocumentFact => ({
  key: 'k', value: 'v', sourceFile: '招标文件正文', roleId: 'r', confidence: 0.9, ...extra,
});

describe('A supplementRequiredTexts 术语补写正式条目化（丰乐镇第 3 轮）', () => {
  beforeEach(() => {
    mockedRequiredTexts.mockReset();
    mockedRequiredTexts.mockReturnValue([]);
  });

  it('「图纸设计说明」缺失：注入工程量清单及施工图纸正式条目，无补充说明块', () => {
    mockedRequiredTexts.mockReturnValue(['图纸设计说明']);
    const result = supplementRequiredTexts('正文内容。', TEMPLATE);
    expect(result).toContain('工程量清单及施工图纸：本项目分部分项工程量清单（项目特征、规格及工程量）与施工图纸设计说明');
    expect(result).not.toContain('编制依据补充说明');
    expect(result).not.toContain('以招标工程量清单及图纸设计说明为准');
  });

  it('多组术语缺失：条目全部注入且整块句号收束', () => {
    mockedRequiredTexts.mockReturnValue(['图纸设计说明', '劳动力计划']);
    const result = supplementRequiredTexts('正文内容。', TEMPLATE);
    expect(result).toContain('工程量清单及施工图纸：');
    expect(result).toContain('施工组织设计文件：本工程劳动力计划、主要施工材料与主要施工机械配置计划');
    expect(result).toContain('主要施工机械配置计划。');
    expect(result).not.toContain('主要施工机械配置计划；');
  });
});

describe('B stripAtlasReferencePhrases 图集/国标编号引用清洗（丰乐镇第 3 轮）', () => {
  it('「做法执行15D501图集」短语连同前置逗号删除，句子主体保留', () => {
    const markdown = '接闪带每隔1m以支撑卡固定，做法执行15D501图集。';
    const { markdown: result, fixedCount } = stripAtlasReferencePhrases(markdown);
    expect(result).toBe('接闪带每隔1m以支撑卡固定。');
    expect(fixedCount).toBe(1);
  });

  it('「做法参照国标11J900内墙18/H7」与「做法参照国标05J909内墙15A/NQ27」均删除', () => {
    const markdown = '内墙做法参照国标11J900内墙18/H7。外墙做法参照国标05J909内墙15A/NQ27。';
    const { markdown: result, fixedCount } = stripAtlasReferencePhrases(markdown);
    expect(result).toBe('内墙。外墙。');
    expect(fixedCount).toBe(2);
  });

  it('标题行/表格行豁免，无图集编号的「做法参照施工方案」类短语保留', () => {
    const markdown = '### 做法执行15D501图集\n| 列 | 做法执行15D501图集 |\n本工程做法参照施工方案执行，做法详见第5章。';
    const { markdown: result, fixedCount } = stripAtlasReferencePhrases(markdown);
    expect(result).toBe(markdown);
    expect(fixedCount).toBe(0);
  });
});

describe('C headingUncoveredEngineeringItems 标题工程存在性检测（丰乐镇第 3 轮）', () => {
  it('清单章节套名标题：小节正文未覆盖的词段全部报 error', () => {
    const markdown = [
      '### 2.15 墙、柱面装饰与隔断、幕墙工程',
      '#### 2.15.1 施工概况',
      '施工对象为公厕室内外墙面装饰工程，主要工程量为内墙乳胶漆53.12m²、面砖内墙面53.34m²、外墙真石漆102.25m²。',
      '### 2.16 天棚工程',
    ].join('\n');
    const issues = headingUncoveredEngineeringItems(markdown);
    expect(issues).toHaveLength(1);
    expect(issues[0].level).toBe('error');
    expect(issues[0].message).toContain('墙、柱面装饰与隔断、幕墙工程');
    expect(issues[0].message).toContain('柱面装饰');
    expect(issues[0].message).toContain('幕墙');
  });

  it('标题词段在小节正文命中：不报', () => {
    const markdown = [
      '### 2.10 土建与安装工程',
      '土建部分包括基础开挖与混凝土浇筑；安装工程包括给排水管道敷设。',
      '### 2.11 道路工程',
    ].join('\n');
    expect(headingUncoveredEngineeringItems(markdown)).toHaveLength(0);
  });

  it('无分隔词的标题（土石方工程）与 H4 边界外命中不参与判定', () => {
    const markdown = [
      '### 2.9 土石方工程',
      '土方开挖按1:0.5放坡。',
      '### 2.15 墙、柱面装饰与隔断、幕墙工程',
      '墙面装饰施工。',
      '### 2.16 天棚工程',
      '幕墙与隔断在天棚小节中出现不计入上一小节命中。',
    ].join('\n');
    const issues = headingUncoveredEngineeringItems(markdown);
    // 2.9 无分隔词不检测；2.15 小节正文只有「墙面装饰」，幕墙/隔断出现在 2.16 边界外
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('幕墙');
  });
});

describe('D 事实值编号粘连截断与规模类字段分号（丰乐镇第 3 轮）', () => {
  it('fieldExtractionPattern：规模类字段值含「；」多分句时完整捕获', () => {
    const pattern = fieldExtractionPattern('建设规模');
    const text = '建设规模：本项目建设范围覆盖20个自然村，重点实施以下配套基础设施工程：一是交通与照明设施；二是水环境治理；三是人居环境改善。';
    const match = pattern.exec(text);
    expect(match?.[1]).toBe('本项目建设范围覆盖20个自然村，重点实施以下配套基础设施工程：一是交通与照明设施；二是水环境治理；三是人居环境改善');
  });

  it('fieldExtractionPattern：非规模类字段仍在「；」处截断（既有行为不变）', () => {
    const pattern = fieldExtractionPattern('质量标准');
    const text = '质量标准：合格；工期：90日历天。';
    const match = pattern.exec(text);
    expect(match?.[1]).toBe('合格');
  });

  it('extractStructuredFacts：计划工期值尾部编号粘连「2.9」截断为「90日历天」', () => {
    const template = {
      id: 'tpl-round3-facts', name: '施工组织设计',
      chapters: [{ id: 'c1', title: '工程概况', requiredFacts: ['计划工期', '招标范围'] }],
    } as unknown as DocumentTemplate;
    const evidence = [{
      filePath: '招标文件.pdf', roleId: 'tender_document', processingType: 'rule', score: 1344.6, sectionTitle: '投标人须知前附表',
      content: '计划工期：90日历天2.9招标范围：本项目建设范围覆盖20个自然村，重点实施以下配套基础设施工程。',
    }] as unknown as DocumentEvidence[];
    const facts = extractStructuredFacts(evidence, template, undefined);
    const scheduleFact = facts.find(item => item.key === '计划工期');
    expect(scheduleFact?.value).toBe('90日历天');
  });
});

describe('E buildCanonicalFacts 得分型 rule confidence 钳制（丰乐镇第 3 轮）', () => {
  it('rule 得分型脏值（conf 1344）与 reference 概率型干净值（conf 0.99）并存：reference 胜', () => {
    const result = buildCanonicalFacts({
      facts: [
        fact({ fieldId: 'schedule_requirement', key: '计划工期', fieldName: '计划工期', value: '90日历天2.9', confidence: 1344.6, processingType: 'rule' }),
        fact({ fieldId: 'schedule_requirement', key: '计划工期', fieldName: '计划工期', value: '90日历天', confidence: 0.99, processingType: 'reference' }),
      ],
    });
    expect(result.get('schedule_requirement')?.value).toBe('90日历天');
  });

  it('仅 rule 候选时仍可兜底入选（不因钳制丢失事实）', () => {
    const result = buildCanonicalFacts({
      facts: [fact({ fieldId: 'schedule_requirement', key: '计划工期', fieldName: '计划工期', value: '90日历天', confidence: 1344.6, processingType: 'rule' })],
    });
    expect(result.get('schedule_requirement')?.value).toBe('90日历天');
  });
});

describe('F 质量标准行创优目标提取顿号排斥（丰乐镇第 3 轮）', () => {
  it('「确保创优目标不流于形式、奖惩承诺可追溯可执行」不再截成残句写入质量标准单元格', () => {
    const facts = [fact({ key: '质量标准', fieldName: '质量标准', value: '合格', confidence: 0.99 })];
    const markdown = '质量奖惩台账闭环管理，确保创优目标不流于形式、奖惩承诺可追溯可执行。';
    const table = projectBasicInfoTableMarkdown(facts, '', markdown);
    expect(table).toContain('| 质量标准 | 合格 |');
    expect(table).not.toContain('不流于形式');
  });

  it('明确创优目标（争创黄山杯）仍正常补全质量标准行', () => {
    const facts = [fact({ key: '质量标准', fieldName: '质量标准', value: '合格', confidence: 0.99 })];
    const markdown = '本项目争创黄山杯优质工程。';
    const table = projectBasicInfoTableMarkdown(facts, '', markdown);
    expect(table).toContain('| 质量标准 | 合格，争创黄山杯优质工程 |');
  });
});
