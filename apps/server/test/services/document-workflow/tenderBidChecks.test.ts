/**
 * h13c fiveElementBlockStats 单测：L2 确定性三要素前置判定（岗位/频次/闭环词面封闭表）。
 * 语义通道全部 mock：验证词面命中即可确定要素存在，不依赖 bge 块级判定。
 * 另有阶段五模糊应答语义升级单测：词面命中仅召回，语义 gate 复核才计套话句（负例零误杀）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildVagueResponseGate, difficultyCountermeasureReport, fillerDensityReport, fiveElementBlockStats } from '@/services/document-workflow/tenderBidChecks';

vi.mock('@/services/document-workflow/semanticSimilarity', () => ({
  buildSemanticSimilarity: vi.fn(),
  SEMANTIC_COVERAGE_THRESHOLD: 0.6,
  // 模糊应答语义 gate 用共享 provider 嵌入：模糊词根 [1,0]、合法语境词 [0,1]、其余 [0,0]
  getLocalSemanticProvider: () => ({
    embedDocuments: async (texts: string[]) => texts.map(text => {
      const vague = /力争|基本|大致|原则上|大概|左右|尽可能|尽量/u.test(text);
      const legal = /对称|上游/u.test(text);
      return [vague && !legal ? 1 : 0, legal ? 1 : 0];
    }),
  }),
}));

import { buildSemanticSimilarity } from '@/services/document-workflow/semanticSimilarity';

const buildSimilarityMock = vi.mocked(buildSemanticSimilarity);

type SimilarityFn = (left: string, right: string) => number;

function mockSimilarity(score: number): void {
  buildSimilarityMock.mockResolvedValue((() => score) as SimilarityFn);
}

describe('fiveElementBlockStats 确定性三要素前置判定（h13c）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('词面三要素齐全的块在 bge 全低分下仍计入闭环块（确定性判定不依赖语义）', async () => {
    mockSimilarity(0.1);
    const markdown = '项目经理每周组织不少于1次节点核查会，质检员在3日内复查并销项，确保措施落地形成闭环记录。';
    const stats = await fiveElementBlockStats(markdown);
    expect(stats.closedLoopBlocks).toBe(1);
  });

  it('无岗位/频次/闭环词面的块在 bge 全高分下不计入闭环块（词面封闭表确定性否决）', async () => {
    mockSimilarity(0.85);
    const markdown = '施工现场加强安全管理，落实各项措施确保工程顺利进行并组织检查。';
    const stats = await fiveElementBlockStats(markdown);
    expect(stats.closedLoopBlocks).toBe(0);
  });

  it('词面频次缺失时确定性 false 压倒 bge 高分（不复用语义兜底）', async () => {
    mockSimilarity(0.85);
    const markdown = '项目经理负责落实整改措施，质检员复查销项形成闭环记录，确保问题当日处理完毕。';
    const stats = await fiveElementBlockStats(markdown);
    expect(stats.closedLoopBlocks).toBe(0);
  });
});

describe('buildVagueResponseGate 模糊应答语义判定（阶段五 5.2）', () => {
  it('词面命中且语义属模糊承诺判定 true', async () => {
    const judge = await buildVagueResponseGate();
    await expect(judge(['本工程力争在合同工期内完成全部施工内容'])).resolves.toEqual([true]);
  });

  it('词面变体（基本能够满足）经语义补漏判定 true', async () => {
    const judge = await buildVagueResponseGate();
    await expect(judge(['本方案基本能够满足招标文件的技术要求'])).resolves.toEqual([true]);
  });

  it('负例零误杀：力争上游不得判模糊应答', async () => {
    const judge = await buildVagueResponseGate();
    await expect(judge(['项目部发扬力争上游的企业精神'])).resolves.toEqual([false]);
  });

  it('负例零误杀：左右对称不得判模糊应答', async () => {
    const judge = await buildVagueResponseGate();
    await expect(judge(['建筑平面采用左右对称的布局形式'])).resolves.toEqual([false]);
  });

  it('词面未命中直接短路 false（不进入语义判定）', async () => {
    const judge = await buildVagueResponseGate();
    await expect(judge(['混凝土浇筑后按规定时间养护'])).resolves.toEqual([false]);
  });
});

describe('fillerDensityReport 模糊应答语义复核（阶段五 5.2）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('词面命中但语义合法（力争上游）不计套话句', async () => {
    mockSimilarity(0.1);
    const report = await fillerDensityReport('项目部发扬力争上游的企业精神持续推进各项工作。');
    expect(report.fillerSentences).toBe(0);
    expect(report.vagueCandidateSentences).toBe(1);
    expect(report.vagueSemanticSentences).toBe(0);
  });

  it('语义确认的模糊应答句计入套话句与扣分口径', async () => {
    mockSimilarity(0.1);
    const report = await fillerDensityReport('本工程力争在合同工期内完成全部施工内容。');
    expect(report.fillerSentences).toBe(1);
    expect(report.vagueSemanticSentences).toBe(1);
  });

  it('左右对称结构描述不计套话句（负例零误杀）', async () => {
    mockSimilarity(0.1);
    const report = await fillerDensityReport('建筑平面采用左右对称的布局形式组织功能分区。');
    expect(report.vagueSemanticSentences).toBe(0);
    expect(report.fillerSentences).toBe(0);
  });

  it('fillerSentenceDetails：命中句原文进入明细（模板化修复闭环锚点源），重复句去重', async () => {
    mockSimilarity(0.9);
    const report = await fillerDensityReport('精心组织科学管理确保工程质量。\n精心组织科学管理确保工程质量。\n严格执行相关规范和设计要求。');
    expect(report.fillerSentences).toBe(3);
    expect(report.fillerSentenceDetails).toContain('精心组织科学管理确保工程质量');
    expect(report.fillerSentenceDetails).toContain('严格执行相关规范和设计要求');
    expect(report.fillerSentenceDetails.filter(item => item === '精心组织科学管理确保工程质量')).toHaveLength(1);
    expect(report.fillerSentenceDetails.length).toBeLessThanOrEqual(40);
  });
});

describe('difficultyCountermeasureReport 条目明细（重难点修复锚点源）', () => {
  const KEY_DIFFICULTY_MARKDOWN = '### 工程重点难点分析\n\n基坑降水难度大因周边道路沉降风险高需控制变形在5mm以内。\n\n工期紧张需要多班组穿插且材料进场协调难度较大。';

  it('entries 带归因/量化双达标标志（检测定位=修复定位）', async () => {
    mockSimilarity(0.9);
    const report = await difficultyCountermeasureReport(KEY_DIFFICULTY_MARKDOWN);
    expect(report.entries).toHaveLength(2);
    expect(report.entries[0].attributed).toBe(true);
    expect(report.entries[0].quantified).toBe(true);
    expect(report.entries[1].attributed).toBe(true);
    expect(report.entries[1].quantified).toBe(false);
    expect(report.entries[1].text).toContain('工期紧张');
  });

  it('归因缺失条目 attributed=false（供修复指令区分缺归因/缺量化）', async () => {
    mockSimilarity(0.1);
    const report = await difficultyCountermeasureReport(KEY_DIFFICULTY_MARKDOWN);
    expect(report.entries[0].attributed).toBe(false);
    expect(report.entries[0].quantified).toBe(true);
  });

  // F2 重难点识别表回退（丰乐镇第五轮实测：重难点以表格形式承载于工程特点小节，
  // 无「重难点」标题小节 → 旧口径检测恒 0 条目、双达标 0% 假阴性）
  const KEY_DIFFICULTY_TABLE_MARKDOWN = `### 1.1 工程特点与施工条件分析

针对分散施工条件，项目部建立项目重难点识别表。
| 重难点 | 形成原因 | 影响范围 | 专项措施 | 责任岗位 |
| --- | --- | --- | --- | --- |
| 村内巷道狭窄，大型机械无法进入 | 部分巷道宽度不足2.0m | 道路硬化、管网开挖 | 采用小型挖掘机配合人工开挖，每日巡查2次 | 施工员 |
| 既有排水沟淤积量大 | 土质明沟沟底淤积厚约0.3m～0.5m | 沟渠清淤 | 分段导流、人工配合小型机械清淤，清淤后恢复过水断面 | 施工员 |
| 多村分散平行施工 | 20个自然村点位分散，工期90日历天 | 进度控制 | 分村分组配置班组，每日巡查复核 | 项目经理 |

### 1.2 其他小节

正文内容。`;

  it('表格载体回退：无重难点标题小节时提取识别表数据行（每行一条目）', async () => {
    mockSimilarity(0.9);
    const report = await difficultyCountermeasureReport(KEY_DIFFICULTY_TABLE_MARKDOWN);
    expect(report.entries).toHaveLength(3);
    expect(report.entries[0].text).toContain('村内巷道狭窄');
    expect(report.entries[2].text).toContain('多村分散平行施工');
    // 表格行含形成原因列 → 归因命中
    expect(report.entries[0].attributed).toBe(true);
  });

  it('表格载体：表头/分隔行不计入条目', async () => {
    mockSimilarity(0.1);
    const report = await difficultyCountermeasureReport(KEY_DIFFICULTY_TABLE_MARKDOWN);
    expect(report.entries.every(entry => !entry.text.includes('重难点 | 形成原因'))).toBe(true);
    expect(report.entries.every(entry => !entry.text.includes('---'))).toBe(true);
  });

  it('量化目标单位扩充：日历天/㎡/每日N次等新单位命中量化判定', async () => {
    mockSimilarity(0.9);
    // 「工期90日历天」「每日巡查2次」都在表格行内 → quantified=true
    const report = await difficultyCountermeasureReport(KEY_DIFFICULTY_TABLE_MARKDOWN);
    expect(report.entries[2].quantified).toBe(true);
    expect(report.entries[0].quantified).toBe(true);
  });

  it('无标题小节且无识别表：保持 0 条目（不误报）', async () => {
    mockSimilarity(0.9);
    const report = await difficultyCountermeasureReport('### 1.1 工程特点与施工条件分析\n\n本工程位于肥西县，共20个自然村。');
    expect(report.countermeasures).toBe(0);
    expect(report.entries).toHaveLength(0);
  });
});
