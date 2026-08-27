import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callDocumentLlm } from '../src/services/document-workflow/llmClient';

// buildPlannedChapterContent 内部经 buildLlmChapterContent → callDocumentLlm 成稿，
// 测试只 mock llmClient 一层（chapterGeneration 同时导入 getDocumentLlmMaxConcurrency 等，
// factory 必须完整导出，否则并发计算得到 NaN 导致块批次循环异常）
vi.mock('../src/services/document-workflow/llmClient', () => ({
  callDocumentLlm: vi.fn(),
  callDocumentLlmJson: vi.fn(),
  getDocumentLlmFailureStreak: vi.fn(() => 0),
  getDocumentLlmMaxConcurrency: vi.fn(() => 6),
}));

import { buildPlannedChapterContent } from '../src/services/document-workflow/chapterGeneration';
import type { PlannedChapterBlock, PlannedChapterStructure } from '../src/services/document-workflow/chapterPlanner';
import type { DocumentGenerationDiagnostics, DocumentTemplate, DocumentTemplateChapter } from '../src/services/document-workflow/types';

const FILL = '施工技术措施与质量控制要点。'; // 13 字/次，正文填充句

function makeBlock(title: string, subTitles: string[], targetWords = 800): PlannedChapterBlock {
  return { title, subPoints: subTitles.map(t => ({ title: t, sources: [t] })), facts: [], targetWords };
}

function makeStructure(blocks: PlannedChapterBlock[]): PlannedChapterStructure {
  return {
    blocks,
    coveredSections: blocks.flatMap(b => b.subPoints.map(p => p.sources[0]!)),
    fallbackSections: [],
    llmPlanned: true,
  };
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

function makeInput(onSectionProgress?: (event: { completed: number; total: number; sectionTitle?: string; phase: string; partialSections?: Array<string | undefined> }) => void) {
  const chapter: DocumentTemplateChapter = { id: 'ch-1', title: '第二章 施工部署', purpose: '', sections: [], queries: [], requiredFacts: [], tablePlans: [], pinnedEvidenceFilePaths: [] };
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
    onSectionProgress,
  };
}

/** 从块成稿 prompt 提取 coverageList 中的 H4 要点标题（`- #### 标题` 行） */
function h4TitlesFromPrompt(prompt: string): string[] {
  return [...prompt.matchAll(/- ####\s+([^\n（(]+)/gu)].map(match => match[1].trim());
}

/** 质检通过的块正文：全部 H4 标题 + 每节 ≥fillChars 字（removeUnwantedDrawingImages 不影响纯文本） */
function successContent(titles: string[], fillChars = 260): string {
  return titles.map(title => `### ${title}\n\n${FILL.repeat(Math.ceil(fillChars / 13))}`).join('\n\n');
}

/** 质检失败的块正文：字数足够但缺 H4 标题（触发针对性二轮反馈） */
function missingTitlesContent(titles: string[], omit: number): string {
  return successContent(titles.filter((_, index) => index !== omit));
}

/** 质检失败的短正文：全 H4 标题但总字数不足（触发二轮补足） */
function shortContent(titles: string[]): string {
  return titles.map(title => `### ${title}\n\n${FILL}`).join('\n\n');
}

beforeEach(() => {
  vi.mocked(callDocumentLlm).mockReset();
});

afterEach(() => {
  vi.mocked(callDocumentLlm).mockReset();
});

describe('buildPlannedChapterContent 块成稿质检与拆半自愈（p3-s2）', () => {
  it('单块一次成稿通过质检：返回章级 Markdown，块成稿调用 1 次', async () => {
    const titles = ['施工区段划分', '施工进度计划', '工期保证措施'];
    vi.mocked(callDocumentLlm).mockResolvedValue(successContent(titles));
    const content = await buildPlannedChapterContent(makeInput(), makeStructure([makeBlock('施工总体部署', titles)]));
    expect(content).toBeDefined();
    expect(content).toContain('## 第二章 施工部署');
    for (const title of titles) expect(content).toContain(`#### ${title}`);
    expect(callDocumentLlm).toHaveBeenCalledTimes(1);
  });

  it('首轮缺 H4 标题：二轮反馈针对性列出缺失标题并重试成功', async () => {
    const titles = ['施工区段划分', '施工进度计划', '工期保证措施'];
    vi.mocked(callDocumentLlm).mockImplementation(async (_system, prompt) => {
      // 二轮 prompt 携带「上一轮未通过质检」反馈 → 返回完整正文；首轮返回缺「工期保证措施」的正文
      if (prompt.includes('上一轮未通过质检')) {
        expect(prompt).toContain('工期保证措施');
        return successContent(titles);
      }
      return missingTitlesContent(titles, 2);
    });
    const content = await buildPlannedChapterContent(makeInput(), makeStructure([makeBlock('施工总体部署', titles)]));
    expect(content).toBeDefined();
    expect(content).toContain('#### 工期保证措施');
    expect(callDocumentLlm).toHaveBeenCalledTimes(2);
  });

  it('首轮字数不足（全 H4 但未达标）：二轮重试补足成功', async () => {
    const titles = ['施工区段划分', '施工进度计划', '工期保证措施'];
    vi.mocked(callDocumentLlm).mockImplementation(async (_system, prompt) => {
      if (prompt.includes('上一轮未通过质检')) return successContent(titles);
      return shortContent(titles);
    });
    const content = await buildPlannedChapterContent(makeInput(), makeStructure([makeBlock('施工总体部署', titles)]));
    expect(content).toBeDefined();
    expect(callDocumentLlm).toHaveBeenCalledTimes(2);
  });

  it('要点 ≥4 两次质检失败：拆半为两个子块并发成稿，全部 H4 归位（拆半优先于整章降级）', async () => {
    const titles = ['施工区段划分', '施工进度计划', '工期保证措施', '进度纠偏措施'];
    vi.mocked(callDocumentLlm).mockImplementation(async (_system, prompt) => {
      const h4 = h4TitlesFromPrompt(prompt);
      // 整块调用（4 个 H4 清单）始终质检失败；拆半子块（2 个 H4 清单）成稿成功
      if (h4.length >= 4) return shortContent(h4);
      return successContent(h4);
    });
    const content = await buildPlannedChapterContent(makeInput(), makeStructure([makeBlock('施工总体部署', titles)]));
    expect(content).toBeDefined();
    for (const title of titles) expect(content).toContain(`#### ${title}`);
    // 整块 2 次失败 + 2 个拆半子块各 1 次成功 = 4 次块成稿调用
    expect(callDocumentLlm).toHaveBeenCalledTimes(4);
  });

  it('拆半后子块仍失败：返回 undefined 交由上层整章单次生成兜底', async () => {
    const titles = ['施工区段划分', '施工进度计划', '工期保证措施', '进度纠偏措施'];
    vi.mocked(callDocumentLlm).mockImplementation(async (_system, prompt) => shortContent(h4TitlesFromPrompt(prompt)));
    const content = await buildPlannedChapterContent(makeInput(), makeStructure([makeBlock('施工总体部署', titles)]));
    expect(content).toBeUndefined();
    // 整块 2 次 + 两个子块各 2 次 = 6 次（子块要点 <4 不再递归拆半）
    expect(callDocumentLlm).toHaveBeenCalledTimes(6);
  });

  it('要点 <4 两次失败：不拆半（拆半无意义），返回 undefined 走整章兜底', async () => {
    const titles = ['施工区段划分', '施工进度计划', '工期保证措施'];
    vi.mocked(callDocumentLlm).mockImplementation(async (_system, prompt) => shortContent(h4TitlesFromPrompt(prompt)));
    const content = await buildPlannedChapterContent(makeInput(), makeStructure([makeBlock('施工总体部署', titles)]));
    expect(content).toBeUndefined();
    expect(callDocumentLlm).toHaveBeenCalledTimes(2);
  });

  it('块成稿完成即触发 checkpoint 进度回调（partialSections 按块序保留已完成正文）', async () => {
    const titles = ['施工区段划分', '施工进度计划'];
    const events: Array<{ phase: string; sectionTitle?: string; partialSections?: Array<string | undefined> }> = [];
    vi.mocked(callDocumentLlm).mockResolvedValue(successContent(titles));
    const content = await buildPlannedChapterContent(makeInput(event => events.push(event)), makeStructure([makeBlock('施工总体部署', titles)]));
    expect(content).toBeDefined();
    expect(events.length).toBe(1);
    expect(events[0].phase).toBe('complete');
    expect(events[0].sectionTitle).toBe('施工总体部署');
    expect(events[0].partialSections?.[0]).toBeDefined();
    expect(events[0].partialSections?.[0]).toContain('### 施工区段划分');
  });
});
