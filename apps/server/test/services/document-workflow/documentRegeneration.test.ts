/**
 * documentRegeneration 单测：regenerateDocumentChapter 编排链——模板/章节/证据前置校验、
 * 检索→作用域过滤→证据优化→missingFacts 计算与 content 组装。kbService 与全部子模块 mock。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getMultiProjectManagerMock: vi.fn(),
  getProjectRootMock: vi.fn(),
  getDocumentTemplateMock: vi.fn(),
  evidenceLineMock: vi.fn(),
  displayChapterTitleMock: vi.fn(),
  evidenceMatchesFactMock: vi.fn(),
  evidenceInScopeMock: vi.fn(),
  buildProjectMaterialProfileMock: vi.fn(),
  expandProjectMaterialBindingsMock: vi.fn(),
  materialKindMapsMock: vi.fn(),
  materialRoleIdMock: vi.fn(),
  assertEvidenceInProjectScopeMock: vi.fn(),
  createProjectMaterialScopeMock: vi.fn(),
  filterEvidenceByProjectScopeMock: vi.fn(),
  compactChapterQueriesMock: vi.fn(),
  optimizeChapterEvidenceMock: vi.fn(),
  qualityFirstEvidenceItemLimitMock: vi.fn(),
  qualityFirstSearchQueryLimitMock: vi.fn(),
  resolveDocumentGenerationEvidenceLimitMock: vi.fn(),
}));
vi.mock('@/services/knowledge/kbService', () => ({
  getMultiProjectManager: mocks.getMultiProjectManagerMock,
  getProjectRoot: mocks.getProjectRootMock,
}));
vi.mock('@/services/document-workflow/templateStore', () => ({ getDocumentTemplate: mocks.getDocumentTemplateMock }));
vi.mock('@/services/document-workflow/evidence', () => ({ evidenceLine: mocks.evidenceLineMock }));
vi.mock('@/services/document-workflow/outline', () => ({ displayChapterTitle: mocks.displayChapterTitleMock }));
vi.mock('@/services/document-workflow/factMatching', () => ({ evidenceMatchesFact: mocks.evidenceMatchesFactMock }));
vi.mock('@/services/document-workflow/rolePipeline', () => ({ evidenceInScope: mocks.evidenceInScopeMock }));
vi.mock('@/services/document-workflow/projectMaterialProfile', () => ({
  buildProjectMaterialProfile: mocks.buildProjectMaterialProfileMock,
  expandProjectMaterialBindings: mocks.expandProjectMaterialBindingsMock,
  materialKindMaps: mocks.materialKindMapsMock,
  materialRoleId: mocks.materialRoleIdMock,
}));
vi.mock('@/services/document-workflow/projectMaterialScope', () => ({
  assertEvidenceInProjectScope: mocks.assertEvidenceInProjectScopeMock,
  createProjectMaterialScope: mocks.createProjectMaterialScopeMock,
  filterEvidenceByProjectScope: mocks.filterEvidenceByProjectScopeMock,
}));
vi.mock('@/services/document-workflow/documentGeneratorHelpers', () => ({
  compactChapterQueries: mocks.compactChapterQueriesMock,
  optimizeChapterEvidence: mocks.optimizeChapterEvidenceMock,
  qualityFirstEvidenceItemLimit: mocks.qualityFirstEvidenceItemLimitMock,
  qualityFirstSearchQueryLimit: mocks.qualityFirstSearchQueryLimitMock,
  resolveDocumentGenerationEvidenceLimit: mocks.resolveDocumentGenerationEvidenceLimitMock,
}));

import { regenerateDocumentChapter } from '@/services/document-workflow/documentRegeneration';
import type { DocumentEvidence, DocumentTemplate, DocumentTemplateChapter } from '@/services/document-workflow/types';

const CHAPTER: DocumentTemplateChapter = {
  id: 'c1', title: '土方开挖工程', purpose: '展开土方开挖施工方法',
  queries: ['基坑开挖'], requiredFacts: ['开挖深度', '支护形式'],
};

const TEMPLATE: DocumentTemplate = {
  id: 'tpl-1', name: '施工组织设计', description: '', category: 'construction', outputTitle: '施组',
  chapters: [CHAPTER],
};

function makeEvidence(content: string): DocumentEvidence {
  return { chapterId: 'c1', filePath: '/proj/a.pdf', score: 0.8, content };
}

function setupHappyPath(overrides: { template?: DocumentTemplate; chapter?: DocumentTemplateChapter; evidence?: DocumentEvidence[] } = {}) {
  const template = overrides.template ?? TEMPLATE;
  const chapter = overrides.chapter ?? CHAPTER;
  mocks.getDocumentTemplateMock.mockReturnValue(template);
  mocks.displayChapterTitleMock.mockImplementation((title: string) => title);
  mocks.expandProjectMaterialBindingsMock.mockReturnValue(['/proj/a.pdf']);
  mocks.buildProjectMaterialProfileMock.mockReturnValue({});
  mocks.materialKindMapsMock.mockReturnValue({ kindByPath: new Map(), processingByPath: new Map() });
  mocks.createProjectMaterialScopeMock.mockReturnValue({});
  const project = { id: 'p1' };
  const manager = { getProject: vi.fn().mockResolvedValue(project), search: vi.fn() };
  mocks.getMultiProjectManagerMock.mockReturnValue(manager);
  mocks.resolveDocumentGenerationEvidenceLimitMock.mockReturnValue(8);
  mocks.compactChapterQueriesMock.mockReturnValue(chapter.queries);
  mocks.qualityFirstSearchQueryLimitMock.mockReturnValue(1);
  mocks.qualityFirstEvidenceItemLimitMock.mockReturnValue(6);
  const evidence = overrides.evidence ?? [makeEvidence('基坑开挖深度约 12 米。')];
  manager.search.mockResolvedValue({
    results: evidence.map(item => ({ filePath: item.filePath, score: item.score, content: item.content, sectionTitle: item.sectionTitle, source: item.source })),
  });
  mocks.evidenceInScopeMock.mockReturnValue(true);
  mocks.filterEvidenceByProjectScopeMock.mockReturnValue(evidence);
  mocks.optimizeChapterEvidenceMock.mockReturnValue(evidence);
  mocks.evidenceMatchesFactMock.mockReturnValue(false);
  mocks.evidenceLineMock.mockImplementation((item: DocumentEvidence) => `- 资料行：${item.content}`);
  return { manager };
}

describe('regenerateDocumentChapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('模板不存在抛错', async () => {
    mocks.getDocumentTemplateMock.mockReturnValue(undefined);
    await expect(regenerateDocumentChapter({ templateId: 'missing', chapterId: 'c1' }))
      .rejects.toThrow('Document template not found');
  });

  it('章节不存在抛错', async () => {
    mocks.getDocumentTemplateMock.mockReturnValue(TEMPLATE);
    await expect(regenerateDocumentChapter({ templateId: 'tpl-1', chapterId: 'missing' }))
      .rejects.toThrow('Document chapter not found');
  });

  it('检索后证据为空抛错（含章节展示标题）', async () => {
    setupHappyPath({ evidence: [] });
    await expect(regenerateDocumentChapter({ templateId: 'tpl-1', chapterId: 'c1', projectRoot: '/proj' }))
      .rejects.toThrow('土方开挖工程 缺少可支撑正文的项目资料证据');
  });

  it('正常路径：content 含章节标题/生成要求/上下文摘要/资料依据与证据行', async () => {
    setupHappyPath();
    const result = await regenerateDocumentChapter({
      templateId: 'tpl-1', chapterId: 'c1', projectRoot: '/proj',
      requirement: '重点写开挖分层', currentMarkdown: '## 旧内容',
    });
    expect(result.id).toBe('c1');
    expect(result.title).toBe('土方开挖工程');
    expect(result.content).toContain('## 土方开挖工程');
    expect(result.content).toContain('> 生成要求：重点写开挖分层');
    expect(result.content).toContain('> 当前文档上下文摘要：## 旧内容');
    expect(result.content).toContain('本章依据已锁定项目资料围绕“展开土方开挖施工方法”重新整理');
    expect(result.content).toContain('### 资料依据');
    expect(result.content).toContain('- 资料行：基坑开挖深度约 12 米。');
  });

  it('无 requirement/currentMarkdown 时对应行省略', async () => {
    setupHappyPath();
    const result = await regenerateDocumentChapter({ templateId: 'tpl-1', chapterId: 'c1', projectRoot: '/proj' });
    expect(result.content).not.toContain('> 生成要求');
    expect(result.content).not.toContain('当前文档上下文摘要');
  });

  it('missingFacts：既有事实集与证据匹配可豁免，其余保留', async () => {
    setupHappyPath();
    mocks.evidenceMatchesFactMock.mockImplementation((_item: DocumentEvidence, fact: string) => fact === '开挖深度');
    const result = await regenerateDocumentChapter({
      templateId: 'tpl-1', chapterId: 'c1', projectRoot: '/proj',
      existingFacts: ['支护形式'],
    });
    expect(result.missingFacts).toEqual([]);
  });

  it('missingFacts：无豁免渠道时全部 requiredFacts 保留', async () => {
    setupHappyPath();
    const result = await regenerateDocumentChapter({ templateId: 'tpl-1', chapterId: 'c1', projectRoot: '/proj' });
    expect(result.missingFacts).toEqual(['开挖深度', '支护形式']);
  });

  it('检索结果经作用域与项目范围双重过滤', async () => {
    const { manager } = setupHappyPath();
    const result = await regenerateDocumentChapter({ templateId: 'tpl-1', chapterId: 'c1', projectRoot: '/proj' });
    expect(result.evidence).toHaveLength(1);
    // search 传入查询与文件范围过滤
    expect(manager.search).toHaveBeenCalledWith('/proj', '基坑开挖', expect.objectContaining({ filters: { filePaths: ['/proj/a.pdf'] } }));
    expect(mocks.assertEvidenceInProjectScopeMock).toHaveBeenCalled();
  });
});
