import { beforeEach, describe, expect, it, vi } from 'vitest';
import { callDocumentLlm } from '../src/services/document-workflow/llmClient';

// buildPlannedChapterContent 内部经 buildLlmChapterContent → callDocumentLlm 成稿，
// 测试只 mock llmClient 一层（factory 必须完整导出，否则并发计算得到 NaN）
vi.mock('../src/services/document-workflow/llmClient', () => ({
  callDocumentLlm: vi.fn(),
  callDocumentLlmJson: vi.fn(),
  getDocumentLlmFailureStreak: vi.fn(() => 0),
  getDocumentLlmMaxConcurrency: vi.fn(() => 6),
}));

import { dedupeRepeatedSubsections, findDuplicateH4Titles, normalizeSubsectionTitleForDedup } from '../src/services/document-workflow/utils';
import { finalizeFinalMarkdownStructure } from '../src/services/document-workflow/documentGeneratorHelpers';
import { dedupeCrossBlockOverlaps } from '../src/services/document-workflow/chapterPlanner';
import { buildPlannedChapterContent } from '../src/services/document-workflow/chapterGeneration';
import type { PlannedChapterBlock, PlannedChapterStructure } from '../src/services/document-workflow/chapterPlanner';
import type { DocumentGenerationDiagnostics, DocumentTemplate, DocumentTemplateChapter } from '../src/services/document-workflow/types';

const FILL = '施工技术措施与质量控制要点。'; // 13 字/次，正文填充句

describe('normalizeSubsectionTitleForDedup', () => {
  it('剥离编号前缀、括号标注与空白标点后比较', () => {
    expect(normalizeSubsectionTitleForDedup('1.3.12 室外雨污分流改造')).toBe('室外雨污分流改造');
    expect(normalizeSubsectionTitleForDedup('危大工程辨识依据与范围（含辨识清单）')).toBe('危大工程辨识依据与范围');
    expect(normalizeSubsectionTitleForDedup('拆除工程：主体结构拆除')).toBe('拆除工程主体结构拆除');
  });
});

describe('findDuplicateH4Titles', () => {
  it('同 H3 内同题不同号的 H4 识别为重复（实测 1.3 节三轮相同改造项）', () => {
    const markdown = `### 1.3 项目改造内容
#### 1.3.2 室外雨污分流改造
正文一。
#### 1.3.3 外立面真石漆翻新
正文二。
#### 1.3.12 室外雨污分流改造
正文三。
#### 1.3.22 室外雨污分流改造
正文四。`;
    expect(findDuplicateH4Titles(markdown)).toEqual(['1.3.12 室外雨污分流改造', '1.3.22 室外雨污分流改造']);
  });

  it('跨 H3 的同名 H4 不误判（各分项工程下常见“施工准备”）', () => {
    const markdown = `### 2.1 土方工程
#### 施工准备
土方准备内容。
### 2.2 基础工程
#### 施工准备
基础准备内容。`;
    expect(findDuplicateH4Titles(markdown)).toEqual([]);
  });

  it('括号标注剥离后比较（实测 1.6 节危大工程三连形态）', () => {
    const markdown = `### 1.6 危大工程管理
#### 1.6.3 危大工程辨识依据与范围
依据一。
#### 1.6.4 危大工程辨识依据与范围（含辨识清单）
依据二。
#### 1.6.5 危大工程辨识依据与范围
依据三。`;
    expect(findDuplicateH4Titles(markdown)).toHaveLength(2);
  });

  it('无重复时返回空数组', () => {
    const markdown = `### 1.3 项目改造内容
#### 1.3.1 室内地坪修复
正文。
#### 1.3.2 外立面真石漆翻新
正文。`;
    expect(findDuplicateH4Titles(markdown)).toEqual([]);
  });
});

describe('dedupeRepeatedSubsections', () => {
  it('同 H3 内重复 H4 保留首个、删除后续重复标题及正文整块（三轮重复实测形态）', () => {
    const content = `### 1.3 项目改造内容
#### 1.3.2 室外雨污分流改造
第一轮正文。
#### 1.3.3 外立面真石漆翻新
第一轮正文二。
#### 1.3.12 室外雨污分流改造
第二轮正文。
#### 1.3.13 外立面真石漆翻新
第二轮正文二。
#### 1.3.22 室外雨污分流改造
第三轮正文。`;
    const result = dedupeRepeatedSubsections(content);
    expect(result).toContain('1.3.2 室外雨污分流改造');
    expect(result).not.toContain('1.3.12 室外雨污分流改造');
    expect(result).not.toContain('1.3.22 室外雨污分流改造');
    expect(result).not.toContain('1.3.13 外立面真石漆翻新');
    expect(result).not.toContain('第二轮正文');
    expect(result).not.toContain('第三轮正文');
    // 首个出现的小节及正文保留
    expect(result).toContain('1.3.3 外立面真石漆翻新');
    expect(result).toContain('第一轮正文');
  });

  it('跨 H3 的同名 H4 全部保留（合法结构）', () => {
    const content = `### 2.1 土方工程
#### 施工准备
土方准备内容。
### 2.2 基础工程
#### 施工准备
基础准备内容。`;
    expect(dedupeRepeatedSubsections(content)).toBe(content);
  });

  it('无重复时原样返回', () => {
    const content = `### 1.3 项目改造内容
#### 1.3.1 室内地坪修复
正文。
### 1.4 项目特点
后文。`;
    expect(dedupeRepeatedSubsections(content)).toBe(content);
  });
});

describe('finalizeFinalMarkdownStructure 空壳与重复兜底（最终组装路径）', () => {
  it('删除零正文空壳 H3（实测 1.1.2 项目基本信息空壳）', () => {
    const markdown = `## 第一章 工程概况
### 1.1.1 项目概况
项目位于……

### 1.1.2 项目基本信息
### 1.2 编制依据
依据如下。`;
    const result = finalizeFinalMarkdownStructure(markdown);
    expect(result).not.toContain('1.1.2 项目基本信息');
    expect(result).toContain('### 1.1.1 项目概况');
    expect(result).toContain('### 1.2 编制依据');
  });

  it('H3 后紧跟 H4 子小节时不算空壳（正文由子层展开）', () => {
    const markdown = `### 1.2 编制依据
#### 1.2.1 法律法规
建筑法等。`;
    const result = finalizeFinalMarkdownStructure(markdown);
    expect(result).toContain('### 1.2 编制依据');
    expect(result).toContain('#### 1.2.1 法律法规');
  });

  it('删除零正文空壳 H4（后跟同级或上级标题时）', () => {
    const markdown = `### 1.2 编制依据
#### 1.2.1 法律法规
建筑法。

#### 1.2.2 技术标准
### 1.3 工程特点`;
    const result = finalizeFinalMarkdownStructure(markdown);
    expect(result).not.toContain('1.2.2 技术标准');
    expect(result).toContain('1.2.1 法律法规');
  });

  it('工作包型小节标题豁免（标题后以同级 H4 工作包展开）', () => {
    const markdown = `### 1.4 项目主要施工内容
#### 1.4.1 结构加固改造工程
施工概况：改造面积约4368平方米。`;
    const result = finalizeFinalMarkdownStructure(markdown);
    expect(result).toContain('### 1.4 项目主要施工内容');
  });

  it('重复 H4 与空壳同时清理（复合场景）', () => {
    const markdown = `### 1.6 危大工程管理
#### 1.6.1 危大工程辨识依据与范围
依据一。

#### 1.6.2 危大工程辨识依据与范围
依据二。

### 1.7 空壳小节
### 1.8 应急预案
预案内容。`;
    const result = finalizeFinalMarkdownStructure(markdown);
    expect(result).not.toContain('1.6.2 危大工程辨识依据与范围');
    expect(result).not.toContain('依据二');
    expect(result).not.toContain('1.7 空壳小节');
    expect(result).toContain('1.8 应急预案');
  });
});

describe('dedupeCrossBlockOverlaps 规划层跨块重叠去重', () => {
  function makeStructure(blocks: PlannedChapterBlock[]): PlannedChapterStructure {
    return {
      blocks,
      coveredSections: blocks.flatMap(block => block.subPoints.flatMap(point => point.sources)),
      fallbackSections: [],
      llmPlanned: true,
    };
  }

  it('同一细目被两个块映射时仅保留首个块引用，重复 H4 整点删除', () => {
    const structure = makeStructure([
      {
        title: '施工部署与流水组织', targetWords: 1600, facts: [],
        subPoints: [
          { title: '施工部署与流水组织', sources: ['施工部署与流水组织', '施工区段划分'] },
        ],
      },
      {
        title: '施工组织措施', targetWords: 1600, facts: [],
        subPoints: [
          { title: '施工部署与流水组织', sources: ['施工部署与流水组织'] },
          { title: '施工进度计划', sources: ['施工进度计划'] },
        ],
      },
    ]);
    const deduped = dedupeCrossBlockOverlaps(structure);
    expect(deduped.blocks[0].subPoints[0].sources).toEqual(['施工部署与流水组织', '施工区段划分']);
    // 第二个块的重复 H4 被整点删除，独立 H4 保留
    expect(deduped.blocks[1].subPoints).toHaveLength(1);
    expect(deduped.blocks[1].subPoints[0].title).toBe('施工进度计划');
  });

  it('部分重叠时仅剥离重复 source，保留独有 source 的 H4 不删', () => {
    const structure = makeStructure([
      {
        title: '施工部署', targetWords: 1600, facts: [],
        subPoints: [{ title: '施工总体部署', sources: ['施工总体部署'] }],
      },
      {
        title: '施工组织措施', targetWords: 1600, facts: [],
        subPoints: [{ title: '组织措施', sources: ['施工总体部署', '施工进度计划'] }],
      },
    ]);
    const deduped = dedupeCrossBlockOverlaps(structure);
    expect(deduped.blocks[0].subPoints[0].sources).toEqual(['施工总体部署']);
    // 后续块的 H4 保留但 sources 剥离重复细目
    expect(deduped.blocks[1].subPoints).toHaveLength(1);
    expect(deduped.blocks[1].subPoints[0].sources).toEqual(['施工进度计划']);
  });

  it('无跨块重叠时结构不变', () => {
    const structure = makeStructure([
      {
        title: '施工部署', targetWords: 1600, facts: [],
        subPoints: [{ title: '施工区段划分', sources: ['施工区段划分'] }],
      },
      {
        title: '施工进度', targetWords: 1600, facts: [],
        subPoints: [{ title: '施工进度计划', sources: ['施工进度计划'] }],
      },
    ]);
    expect(dedupeCrossBlockOverlaps(structure)).toEqual(structure);
  });
});

// ---- 块成稿质检重复拦截（writeBlock 源头防御） ----

function makeBlock(title: string, subTitles: string[], targetWords = 1200): PlannedChapterBlock {
  return { title, subPoints: subTitles.map(title => ({ title, sources: [title] })), facts: [], targetWords };
}

function makeDiagnostics(): DocumentGenerationDiagnostics {
  return {
    strategy: { mode: 'balanced' },
    metrics: [],
    llm: { calls: 0, failures: 0, maxActive: 0, retries: 0, failureStreak: 0, schemaFailures: 0 },
    evidence: { raw: 0, used: 0, filteredNoise: 0, budgetDropped: 0, avgNoiseScore: 0, avgFactDensity: 0, searchQueries: 0, searchMs: 0, contextChars: 0 },
    quality: { blockingCount: 0, importantCount: 0, minorCount: 0, repairedCount: 0 },
  } as unknown as DocumentGenerationDiagnostics;
}

function makeInput() {
  const chapter: DocumentTemplateChapter = { id: 'ch-1', title: '第一章 项目改造内容', purpose: '', sections: [], queries: [], requiredFacts: [], tablePlans: [], pinnedEvidenceFilePaths: [] };
  const template: DocumentTemplate = { id: 'tpl-1', name: '测试模板', description: '', category: 'test', outputTitle: '测试文档', chapters: [chapter] };
  return {
    template,
    chapter,
    evidence: [],
    missingFacts: [],
    promptTexts: '测试提示词',
    projectContext: '项目上下文',
    roleContext: '角色要求',
    targetWords: 2400,
    forbidDrawingImages: false,
    diagnostics: makeDiagnostics(),
  };
}

/** 质检通过的块正文：全部 H4 标题各展开一次，无重复 */
function cleanContent(titles: string[]): string {
  return titles.map(title => `#### ${title}\n\n${FILL.repeat(30)}`).join('\n\n');
}

/** 质检失败的块正文：同一批 H4 重复展开三轮（同题不同号，字数充足，唯一失败原因是重复） */
function repeatedRoundsContent(titles: string[]): string {
  const rounds = 3;
  let out = '';
  for (let round = 0; round < rounds; round += 1) {
    out += titles.map((title, index) => `#### 1.3.${round * titles.length + index + 2} ${title}\n\n${FILL.repeat(15)}`).join('\n\n');
    if (round < rounds - 1) out += '\n\n';
  }
  return out;
}

beforeEach(() => {
  vi.mocked(callDocumentLlm).mockReset();
});

describe('buildPlannedChapterContent 块成稿质检拦截同 H4 重复展开', () => {
  it('首轮三轮重复（字数足、无缺失）→ 质检按重复拦截 → 二轮反馈列出重复标题 → 重试无重复通过', async () => {
    const titles = ['室外雨污分流改造', '外立面真石漆翻新'];
    vi.mocked(callDocumentLlm).mockImplementation(async (_system, prompt) => {
      if (prompt.includes('上一轮未通过质检')) {
        // 二轮反馈必须针对性列出重复 H4 标题
        expect(prompt).toContain('重复展开的 H4 要点标题');
        expect(prompt).toContain('室外雨污分流改造');
        expect(prompt).toContain('外立面真石漆翻新');
        return cleanContent(titles);
      }
      return repeatedRoundsContent(titles);
    });
    const content = await buildPlannedChapterContent(makeInput(), { blocks: [makeBlock('项目改造内容', titles)], coveredSections: titles, fallbackSections: [], llmPlanned: true });
    expect(content).toBeDefined();
    expect(callDocumentLlm).toHaveBeenCalledTimes(2);
    // 最终正文只保留一轮展开（重复轮次被质检拦截后由二轮干净稿替换）
    expect(content).not.toContain('1.3.4 室外雨污分流改造');
    expect(content).not.toContain('1.3.6 室外雨污分流改造');
  });

  it('二轮仍重复且要点 <4：质检不通过返回 undefined，交由整章兜底（不放过重复稿）', async () => {
    const titles = ['室外雨污分流改造', '外立面真石漆翻新'];
    vi.mocked(callDocumentLlm).mockImplementation(async (_system, prompt) => {
      if (prompt.includes('上一轮未通过质检')) return repeatedRoundsContent(titles);
      return repeatedRoundsContent(titles);
    });
    const content = await buildPlannedChapterContent(makeInput(), { blocks: [makeBlock('项目改造内容', titles)], coveredSections: titles, fallbackSections: [], llmPlanned: true });
    expect(content).toBeUndefined();
    expect(callDocumentLlm).toHaveBeenCalledTimes(2);
  });
});
