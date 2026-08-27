import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callDocumentLlmJson } from '../src/services/document-workflow/llmClient';

vi.mock('../src/services/document-workflow/llmClient', () => ({
  callDocumentLlmJson: vi.fn(),
}));

// p3-s1：chapterPlanner 经 semanticSimilarity 依赖本地 bge-small 模型（@customize-agent/knowledge 的
// Transformers.js pipeline），vitest 无法运行真实模型，统一 mock 掉：默认返回 undefined（语义模型
// 不可用 → 聚类退化为域内顺序切块），单测可注入受控相似度函数验证语义聚类路径
vi.mock('../src/services/document-workflow/semanticSimilarity', () => ({
  buildSemanticSimilarity: vi.fn(),
}));

import { buildSemanticSimilarity } from '../src/services/document-workflow/semanticSimilarity';
import { planChapterStructure, planChapterStructureWithLlm, uncoveredPlannerSections } from '../src/services/document-workflow/chapterPlanner';
import type { DocumentGenerationDiagnostics, DocumentTemplate, DocumentTemplateChapter } from '../src/services/document-workflow/types';

function makeChapter(sections: string[]): DocumentTemplateChapter {
  return {
    id: 'ch-test',
    title: '第二章 施工部署',
    purpose: '',
    sections,
    queries: [],
    requiredFacts: [],
    tablePlans: [],
    pinnedEvidenceFilePaths: [],
  };
}

const BASE_SECTIONS = [
  '施工总体部署',
  '施工区段划分',
  '施工进度计划',
  '工期保证措施',
  '进度纠偏措施',
  '关键节点计划',
  '工序穿插安排',
  '进度预警机制',
  '季节性施工安排',
  '质量管理体系',
  '质量验收标准',
  '三检制度',
  '样板引路制度',
  '安全管理体系',
  '危大工程管控',
  '应急预案编制',
];

const EXTRA_SECTIONS = ['文明施工管理', '扬尘控制措施', '绿色施工措施', '劳务实名制管理'];

function makeTemplate(chapter: DocumentTemplateChapter): DocumentTemplate {
  return {
    id: 'tpl-test',
    name: '测试模板',
    description: '',
    category: 'test',
    outputTitle: '测试文档',
    chapters: [chapter],
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

/**
 * 万能单块计划：从单块调用的 prompt 中解析「输入细目清单」，逐条映射为独立 H4 要点（标题照抄），
 * 模拟 LLM 单块规划成功（sources 与块输入细目精确对齐，buildPlannedBlock 校验通过）
 */
function planFromPrompt(prompt: string) {
  const marker = '输入细目清单';
  const tail = prompt.slice(prompt.indexOf(marker));
  const listText = tail.split('：')[1]?.split('\n')[0] || '';
  const sections = listText.split('、').filter(Boolean);
  return { title: '规划主题块', subPoints: sections.map(section => ({ title: section, sources: [section] })), facts: [] };
}

function baseInput(sections: string[], diagnostics: DocumentGenerationDiagnostics) {
  const chapter = makeChapter(sections);
  return {
    template: makeTemplate(chapter),
    chapter,
    evidence: [],
    projectContext: '项目上下文',
    requirement: '编制施工组织设计',
    roleContext: '角色要求',
    targetWords: 20000,
    diagnostics,
  };
}

beforeEach(() => {
  vi.mocked(buildSemanticSimilarity).mockReset();
  vi.mocked(buildSemanticSimilarity).mockResolvedValue(undefined);
});

afterEach(() => {
  vi.mocked(callDocumentLlmJson).mockReset();
});

describe('planChapterStructureWithLlm 逐主题块小步规划（p3-s1）', () => {
  it('16 条：语义域聚类出 4 个块候选，逐块 LLM 命中时块间合并且细目 100% 承接', async () => {
    vi.mocked(callDocumentLlmJson).mockImplementation(async (_system, prompt) => planFromPrompt(prompt));
    const diagnostics = makeDiagnostics();
    const structure = await planChapterStructureWithLlm(baseInput(BASE_SECTIONS, diagnostics));
    expect(structure).toBeDefined();
    expect(structure!.llmPlanned).toBe(true);
    // 必查细目（危大工程管控/应急预案编制）并入语义域分组（不每条独立成块）：
    // 施工组织 4/工期进度 5/质量验收 4/安全风险 3 = 4 块
    expect(structure!.blocks.length).toBe(4);
    expect(callDocumentLlmJson).toHaveBeenCalledTimes(4);
    expect(uncoveredPlannerSections(BASE_SECTIONS, structure!)).toEqual([]);
    expect([...structure!.coveredSections, ...structure!.fallbackSections].sort()).toEqual([...BASE_SECTIONS].sort());
  });

  it('16 条：schema 校验失败时块级降级（失败块由确定性结构接管），原因可诊断', async () => {
    vi.mocked(callDocumentLlmJson).mockImplementation(async (_system, _prompt, options) => {
      // 模拟 llmClient 真实行为：失败原因经 outFailure 带出（与共享 lastError 解耦，无并发竞态）
      if (options?.outFailure) options.outFailure.value = 'JSON Schema 校验失败：缺失字段 $.subPoints';
      return undefined;
    });
    const diagnostics = makeDiagnostics();
    const structure = await planChapterStructureWithLlm(baseInput(BASE_SECTIONS, diagnostics));
    expect(structure).toBeDefined();
    expect(structure!.llmPlanned).toBe(false);
    expect(structure!.llmFailure).toContain('块级降级');
    expect(structure!.llmFailure).toContain('缺失字段');
    expect(structure!.blocks.length).toBeGreaterThan(0);
    expect(uncoveredPlannerSections(BASE_SECTIONS, structure!)).toEqual([]);
  });

  it('20 条：部分块命中、部分块校验失败时块级失败隔离，失败块细目被兜底（一批失败不影响另一批）', async () => {
    vi.mocked(callDocumentLlmJson).mockImplementation(async (_system, prompt, options) => {
      // 只让「工期进度」域块失败，其余 5 个块正常命中
      if (prompt.includes('工期保证措施')) {
        if (options?.outFailure) options.outFailure.value = 'JSON 解析失败：JSON 被截断（{ 未闭合 1 个）';
        return undefined;
      }
      return planFromPrompt(prompt);
    });
    const diagnostics = makeDiagnostics();
    const sections = [...BASE_SECTIONS, ...EXTRA_SECTIONS];
    const structure = await planChapterStructureWithLlm(baseInput(sections, diagnostics));
    expect(structure).toBeDefined();
    expect(structure!.llmPlanned).toBe(true);
    expect(uncoveredPlannerSections(sections, structure!)).toEqual([]);
    expect(structure!.llmFailure).toContain('块级降级');
    expect(structure!.llmFailure).toContain('JSON 被截断');
  });

  it('20 条：全部块失败时逐块确定性降级，整体仍产出全量覆盖结构', async () => {
    vi.mocked(callDocumentLlmJson).mockResolvedValue(undefined);
    const diagnostics = makeDiagnostics();
    const sections = [...BASE_SECTIONS, ...EXTRA_SECTIONS];
    const structure = await planChapterStructureWithLlm(baseInput(sections, diagnostics));
    expect(structure).toBeDefined();
    expect(structure!.blocks.length).toBeGreaterThan(0);
    expect(structure!.llmPlanned).toBe(false);
    expect(structure!.llmFailure).toContain('块级降级');
    expect(uncoveredPlannerSections(sections, structure!)).toEqual([]);
  });

  it('语义模型可用时按余弦相似度聚类：相似度 0 时细目不合并、逐条成块（块级调用数 = 细目数）', async () => {
    vi.mocked(buildSemanticSimilarity).mockResolvedValue((leftText, rightText) => (leftText === rightText ? 1 : 0));
    vi.mocked(callDocumentLlmJson).mockImplementation(async (_system, prompt) => planFromPrompt(prompt));
    const diagnostics = makeDiagnostics();
    const structure = await planChapterStructureWithLlm(baseInput(BASE_SECTIONS, diagnostics));
    expect(structure).toBeDefined();
    expect(structure!.llmPlanned).toBe(true);
    // 相似度全 0：域内每条独立成块（必查与普通细目同口径）→ 每块一次小调用（远离整章一次大 JSON）
    expect(callDocumentLlmJson).toHaveBeenCalledTimes(BASE_SECTIONS.length);
    expect(uncoveredPlannerSections(BASE_SECTIONS, structure!)).toEqual([]);
  });
});

describe('planChapterStructure 组合入口', () => {
  it('LLM 全程失败时仍产出确定性结构（永不回退逐小节路径）', async () => {
    vi.mocked(callDocumentLlmJson).mockResolvedValue(undefined);
    const diagnostics = makeDiagnostics();
    const structure = await planChapterStructure(baseInput(BASE_SECTIONS, diagnostics));
    expect(structure.blocks.length).toBeGreaterThan(0);
    expect(structure.llmPlanned).toBe(false);
    expect(uncoveredPlannerSections(BASE_SECTIONS, structure)).toEqual([]);
  });

  it('细目 ≤8 条时跳过 LLM 直接确定性分组', async () => {
    const diagnostics = makeDiagnostics();
    const structure = await planChapterStructure(baseInput(BASE_SECTIONS.slice(0, 8), diagnostics));
    expect(structure.blocks.length).toBeGreaterThan(0);
    expect(callDocumentLlmJson).not.toHaveBeenCalled();
  });
});
