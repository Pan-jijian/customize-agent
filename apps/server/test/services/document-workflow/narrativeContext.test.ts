/**
 * narrativeContext 单测（C0-8 检测校准）：叙述语境共享单源的边界样本——
 * 反样本（词表/参数串/目录聚簇行/标题行不得构成证据）+ 正样本守护（多短句叙述行、
 * 表格行、列表行、短结构句不得被误伤——r28l/s28l 实测校准门槛为该口径的边界依据）。
 * 本模块是评分三端（命中单元/专业分四维/危大应急结构证据）的单一真源，口径变更必须在此先行校准。
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/services/document-workflow/semanticSimilarity', () => ({
  SEMANTIC_COVERAGE_THRESHOLD: 0.6,
  buildSemanticSimilarity: async () => (left: string, right: string) => (left.includes(right.slice(0, 6)) ? 1 : 0),
  getLocalSemanticProvider: () => ({
    embedDocuments: async (texts: string[]) => texts.map(() => [0, 0]),
  }),
}));

import {
  extractContextualTokens, isListingText, isNarrativeLine, isTocClusterLine,
  narrativeSentences, sentenceHasCommitmentContext, stripHeadingLines,
} from '@/services/document-workflow/narrativeContext';

describe('isTocClusterLine：目录聚簇行判定边界', () => {
  it('多章节/编号条目堆叠且无句读 → 目录聚簇行', () => {
    expect(isTocClusterLine('第一章 工程概况 1.1 编制说明与工程概况 1.2 编制依据 1.3 工程范围')).toBe(true);
  });

  it('含句读 → 非目录聚簇行（章节内叙述引用不误伤）', () => {
    expect(isTocClusterLine('第一章工程概况说明。1.1 编制说明 1.2 编制依据')).toBe(false);
  });

  it('单章节标记行 → 非目录聚簇行', () => {
    expect(isTocClusterLine('第六章 确保工程质量的技术组织措施')).toBe(false);
  });
});

describe('isListingText：罗列串判定边界（误伤校准）', () => {
  it('词表堆叠（10 段均 3.7 字）→ 罗列', () => {
    expect(isListingText('质量标准 计划工期 日历天 缺陷责任期 保修 安全目标 文明施工目标 项目经理 项目负责人')).toBe(true);
  });

  it('参数串（逗号分隔短 token）→ 罗列', () => {
    expect(isListingText('C30，C25，C35，M5.0，M7.5，HRB400，HRB335，Q235，Q345，QTZ80，SC200，12000m²')).toBe(true);
  });

  it('多短句叙述行（8 段均 9.4 字）→ 非罗列（C0 门槛校准防误伤）', () => {
    const line = '总则明确，应急组织机构与应急小组到位，风险分析完成，应急物资与通讯保障齐全，专项应急预案已编制，应急响应流程明确，后期处置与事故调查责任落实，应急演练按计划开展';
    expect(isListingText(line)).toBe(false);
    expect(isNarrativeLine(line)).toBe(true);
  });

  it('少段短句（<8 段）→ 非罗列', () => {
    expect(isListingText('应急组织机构，风险分析，物资保障，通讯保障')).toBe(false);
  });
});

describe('narrativeSentences：叙述句池边界', () => {
  it('标题/表格/列表/目录条目行不入句池，正文句保留', () => {
    const markdown = [
      '# 标题行不构成正文',
      '| 表格 | 行 |',
      '- 列表项内容超过十二个字的正文行仍排除',
      '第六章 确保工程质量的技术组织措施',
      '基坑工程开挖深度8m，属超危大范围，已组织专家论证。',
    ].join('\n');
    expect(narrativeSentences(markdown)).toEqual(['基坑工程开挖深度8m，属超危大范围，已组织专家论证']);
  });

  it('短句（<12 字）不入叙述句池（由 stripHeadingLines 承接结构证据）', () => {
    expect(narrativeSentences('基坑工程施工方案已编制。')).toEqual([]);
  });
});

describe('stripHeadingLines：结构证据文本（危大两步/应急八部分专用）', () => {
  it('标题行/目录行剥离 → 空壳标题与目录不得构成结构证据', () => {
    const markdown = [
      '#### 7.1.3 生产安全事故应急预案与应急演练',
      '',
      '第七章 应急预案 7.1 应急组织 7.2 应急响应 7.3 演练安排',
      '第六章 确保工程质量的技术组织措施',
    ].join('\n');
    expect(stripHeadingLines(markdown)).toBe('');
  });

  it('表格/列表/短正文行保留（危大清单表与短句是合法证据）', () => {
    const markdown = [
      '## 危大工程清单',
      '| 序号 | 类别 | 参数 |',
      '| 1 | 基坑 | 开挖深度8m |',
      '- 已组织专家论证并履行审批程序',
      '基坑工程施工方案已编制。',
    ].join('\n');
    const output = stripHeadingLines(markdown);
    expect(output).not.toContain('## 危大工程清单');
    expect(output).toContain('| 1 | 基坑 | 开挖深度8m |');
    expect(output).toContain('- 已组织专家论证并履行审批程序');
    expect(output).toContain('基坑工程施工方案已编制。');
  });
});

describe('extractContextualTokens / sentenceHasCommitmentContext：语境内提取与承诺语境', () => {
  it('token 仅从叙述句提取（参数串行内 token 不计）', () => {
    const markdown = [
      'C30，C25，C35，M5.0，M7.5，HRB400，HRB335，Q235，Q345，QTZ80，SC200',
      '主体结构混凝土强度等级采用C30，钢筋采用HRB400级。',
    ].join('\n');
    const tokens = extractContextualTokens(markdown, /C\d{2}|HRB\d{3}/gu);
    expect([...tokens].sort()).toEqual(['C30', 'HRB400']);
  });

  it('承诺语境判定：量化数字/响应动词为语境，「负责」岗位词不算', () => {
    expect(sentenceHasCommitmentContext('本工程质量标准为合格，计划工期420日历天。')).toBe(true);
    expect(sentenceHasCommitmentContext('响应招标文件全部实质性要求并承诺履约')).toBe(true);
    expect(sentenceHasCommitmentContext('项目经理 项目负责人')).toBe(false);
  });
});
