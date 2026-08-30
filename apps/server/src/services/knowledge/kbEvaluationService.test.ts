import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./kbService', () => ({
  getMultiProjectManager: vi.fn(),
}));

import { getMultiProjectManager } from './kbService';
import { buildAutoKbRetrievalEvalCases, evaluateKbRetrieval } from './kbEvaluationService';

function makeManager() {
  return {
    search: vi.fn(),
    getProject: vi.fn(),
  };
}

type FakeManager = ReturnType<typeof makeManager>;

let manager: FakeManager;

beforeEach(() => {
  manager = makeManager();
  vi.mocked(getMultiProjectManager).mockReturnValue(manager as never);
});

function searchItem(filePath: string, content: string, score = 0.9, sectionTitle = '') {
  return { filePath, content, score, sectionTitle };
}

describe('evaluateKbRetrieval', () => {
  it('完整命中：recall/precision/mrr/ndcg 全 1，pass95', async () => {
    manager.search.mockResolvedValue({
      results: [searchItem('投标/施工组织设计.pdf', '本项目位于滨湖新区')],
      debug: { pipeline: 'x' },
    });
    const report = await evaluateKbRetrieval({
      projectRoot: '/proj-eval',
      cases: [{ query: '滨湖新区', relevantFiles: ['施工组织设计.pdf'], expectedTerms: ['滨湖新区'] }],
    });
    expect(report.totalCases).toBe(1);
    expect(report.validCases).toBe(1);
    expect(report.invalidCases).toBe(0);
    expect(report.recallAtK).toBe(1);
    expect(report.precisionAtK).toBe(1);
    expect(report.mrr).toBe(1);
    expect(report.ndcgAtK).toBe(1);
    expect(report.pass95).toBe(true);

    const caseResult = report.cases[0]!;
    expect(caseResult.matchedFiles).toEqual(['施工组织设计.pdf']);
    expect(caseResult.matchedTerms).toEqual(['滨湖新区']);
    expect(caseResult.matchedSnippets).toEqual([]);
    expect(caseResult.firstHitRank).toBe(1);
    expect(caseResult.results[0]?.matchedBy).toContain('file');
    expect(caseResult.results[0]?.matchedBy).toContain('term');
    expect(caseResult.results[0]?.preview).toBe('本项目位于滨湖新区');
    expect(caseResult.debug).toEqual({ pipeline: 'x' });
  });

  it('部分命中：recall 加权、missingFiles/missingTerms 与 pass95', async () => {
    manager.search.mockResolvedValue({
      results: [searchItem('f1.pdf', '包含术语一')],
      debug: undefined,
    });
    const report = await evaluateKbRetrieval({
      projectRoot: '/proj-eval',
      cases: [{
        query: 'q',
        relevantFiles: ['f1.pdf', 'f2.pdf'],
        expectedTerms: ['术语一', '术语二'],
      }],
    });
    const caseResult = report.cases[0]!;
    expect(caseResult.matchedFiles).toEqual(['f1.pdf']);
    expect(caseResult.missingFiles).toEqual(['f2.pdf']);
    expect(caseResult.matchedTerms).toEqual(['术语一']);
    expect(caseResult.missingTerms).toEqual(['术语二']);
    expect(caseResult.recall).toBe(0.5);
    expect(caseResult.precision).toBe(1);
    expect(report.pass95).toBe(false);
  });

  it('首条不相关时 mrr 与 ndcg 反映排序质量', async () => {
    manager.search.mockResolvedValue({
      results: [searchItem('无关.pdf', '无关内容'), searchItem('目标.pdf', '目标内容')],
      debug: undefined,
    });
    const report = await evaluateKbRetrieval({
      projectRoot: '/proj-eval',
      cases: [{ query: 'q', relevantFiles: ['目标.pdf'] }],
    });
    const caseResult = report.cases[0]!;
    expect(caseResult.firstHitRank).toBe(2);
    expect(caseResult.mrr).toBe(0.5);
    expect(caseResult.ndcg).toBe(0.6309);
    expect(caseResult.results[0]?.relevant).toBe(false);
    expect(caseResult.results[1]?.relevant).toBe(true);
  });

  it('缺少 query 或目标单位 → invalid，多 case 平均', async () => {
    manager.search.mockResolvedValue({ results: [], debug: undefined });
    const report = await evaluateKbRetrieval({
      projectRoot: '/proj-eval',
      cases: [
        { id: 'c1', query: '', relevantFiles: ['a.pdf'] },
        { id: 'c2', query: '有词无目标' },
      ],
    });
    expect(report.totalCases).toBe(2);
    expect(report.validCases).toBe(0);
    expect(report.invalidCases).toBe(2);
    expect(report.invalid.map(item => item.id)).toEqual(['c1', 'c2']);
    expect(report.invalid[0]!.reason).toContain('评测用例必须包含 query');
    expect(report.pass95).toBe(false);
    expect(manager.search).not.toHaveBeenCalled();
  });

  it('filePathPrefixes 未匹配到文件 → invalid 且不检索', async () => {
    manager.getProject.mockResolvedValue({ listFiles: () => [] });
    const report = await evaluateKbRetrieval({
      projectRoot: '/proj-eval',
      filePathPrefixes: ['投标/'],
      cases: [{ query: 'q', relevantFiles: ['a.pdf'] }],
    });
    expect(report.invalidCases).toBe(1);
    expect(report.invalid[0]!.reason).toBe('filePathPrefixes 未匹配到任何已索引文件。');
    expect(manager.search).not.toHaveBeenCalled();
  });

  it('filePathPrefixes 匹配时带 filters 检索', async () => {
    manager.getProject.mockResolvedValue({ listFiles: () => [{ relativePath: '投标/施工组织设计.pdf' }] });
    manager.search.mockResolvedValue({
      results: [searchItem('投标/施工组织设计.pdf', '内容')],
      debug: undefined,
    });
    const report = await evaluateKbRetrieval({
      projectRoot: '/proj-eval',
      filePathPrefixes: ['投标'],
      cases: [{ query: 'q', relevantFiles: ['施工组织设计.pdf'] }],
    });
    expect(report.validCases).toBe(1);
    expect(manager.search).toHaveBeenCalledWith('/proj-eval', 'q', expect.objectContaining({
      filters: { filePaths: ['投标/施工组织设计.pdf'] },
    }));
  });

  it('compact 模式截断 results 且不返回 debug', async () => {
    manager.search.mockResolvedValue({
      results: [
        searchItem('f1.pdf', 'c1'), searchItem('f2.pdf', 'c2'),
        searchItem('f3.pdf', 'c3'), searchItem('f4.pdf', 'c4'),
      ],
      debug: { big: true },
    });
    const report = await evaluateKbRetrieval({
      projectRoot: '/proj-eval',
      compact: true,
      cases: [{ query: 'q', relevantFiles: ['f1.pdf'] }],
    });
    expect(report.cases[0]!.results).toHaveLength(3);
    expect(report.cases[0]!.debug).toBeUndefined();
  });

  it('topK 截断：input 级与 case 级覆盖', async () => {
    manager.search.mockResolvedValue({ results: [], debug: undefined });
    await evaluateKbRetrieval({
      projectRoot: '/proj-eval',
      topK: 5,
      cases: [
        { query: 'q', expectedTerms: ['t'] },
        { query: 'q2', expectedTerms: ['t'], topK: 3 },
      ],
    });
    expect(manager.search).toHaveBeenNthCalledWith(1, '/proj-eval', 'q', expect.objectContaining({ limit: 5 }));
    expect(manager.search).toHaveBeenNthCalledWith(2, '/proj-eval', 'q2', expect.objectContaining({ limit: 3 }));
  });
});

describe('buildAutoKbRetrievalEvalCases', () => {
  it('FACT_PATTERNS 抽取：项目名称/建设地点生成查询与期望词', async () => {
    manager.getProject.mockResolvedValue({
      listFiles: () => [{ relativePath: '招标文件.pdf' }],
      listChunks: () => [{ sectionTitle: '第一章', titlePath: '招标文件.pdf > 第一章', content: '项目名称：滨湖校区改造工程项目，建设地点：合肥市滨湖新区。' }],
    });
    const cases = await buildAutoKbRetrievalEvalCases({ projectRoot: '/proj-auto' });
    // 两个事实用例 + 一个句子用例
    expect(cases).toHaveLength(3);
    expect(cases[0]!.id).toBe('auto-1');
    expect(cases[0]!.query).toBe('滨湖校区改造工程项目，建设地点：合肥市滨湖新区 项目名称 工程名称');
    expect(cases[0]!.expectedTerms).toEqual(['滨湖校区改造工程项目，建设地点：合肥市滨湖新区']);
    expect(cases[0]!.relevantFiles).toEqual(['招标文件.pdf']);
    expect(cases[0]!.filePaths).toEqual(['招标文件.pdf']);
    expect(cases[0]!.topK).toBe(20);
    expect(cases[1]!.query).toBe('合肥市滨湖新区 建设地点 项目地点');
    expect(cases[2]!.query).toContain('第一章');
  });

  it('无用事实被过滤（占位符取值）', async () => {
    manager.getProject.mockResolvedValue({
      listFiles: () => [{ relativePath: '招标文件.pdf' }],
      listChunks: () => [{ sectionTitle: '', titlePath: '', content: '项目名称：详见。质量标准：优良。' }],
    });
    const cases = await buildAutoKbRetrievalEvalCases({ projectRoot: '/proj-auto' });
    // '详见' 被过滤，'优良' 因长度不足 2 位未匹配质量标准模式的最小长度要求而不产生值
    expect(cases).toEqual([]);
  });

  it('句子抽取：生成通用查询与期望词', async () => {
    manager.getProject.mockResolvedValue({
      listFiles: () => [{ relativePath: '招标文件.pdf' }],
      listChunks: () => [{ sectionTitle: '第一章 工程概况', titlePath: '招标文件.pdf', content: '本工程为滨湖校区改造工程，主要包括教学楼外立面翻新以及内部装修施工等内容。' }],
    });
    const cases = await buildAutoKbRetrievalEvalCases({ projectRoot: '/proj-auto' });
    expect(cases.length).toBeGreaterThan(0);
    const sentenceCase = cases.find(item => item.query.includes('本工程为滨湖校区改造工程'));
    expect(sentenceCase).toBeDefined();
    expect(sentenceCase?.expectedTerms?.length).toBeGreaterThan(0);
    expect(sentenceCase?.relevantFiles).toEqual(['招标文件.pdf']);
    // 标题词进入查询前缀
    expect(sentenceCase?.query.startsWith('第一章工程概况招标文件.pdf')).toBe(true);
  });

  it('重复事实去重（seen 键）', async () => {
    const chunk = { sectionTitle: '工程概况', titlePath: '', content: '项目名称：滨湖校区改造工程项目。' };
    manager.getProject.mockResolvedValue({
      listFiles: () => [{ relativePath: '招标文件.pdf' }],
      listChunks: () => [chunk, chunk],
    });
    const cases = await buildAutoKbRetrievalEvalCases({ projectRoot: '/proj-auto' });
    expect(cases).toHaveLength(1);
  });

  it('limit 与 perFileLimit 截断', async () => {
    const chunk = { sectionTitle: '', titlePath: '', content: '项目名称：滨湖校区改造工程项目。建设地点：合肥市滨湖新区。' };
    manager.getProject.mockResolvedValue({
      listFiles: () => [{ relativePath: '招标文件.pdf' }],
      listChunks: () => [chunk],
    });
    const limited = await buildAutoKbRetrievalEvalCases({ projectRoot: '/proj-auto', limit: 1 });
    expect(limited).toHaveLength(1);
    const perFile = await buildAutoKbRetrievalEvalCases({ projectRoot: '/proj-auto', perFileLimit: 1 });
    expect(perFile).toHaveLength(1);
  });

  it('fileLayer 过滤：cad 仅保留 dwg/dxf，document 排除图片', async () => {
    manager.getProject.mockResolvedValue({
      listFiles: () => [
        { relativePath: '图纸.dwg' },
        { relativePath: '文档.pdf' },
        { relativePath: '平面.png' },
        { relativePath: '矢量.dxf' },
      ],
      listChunks: () => [],
    });
    const cad = await buildAutoKbRetrievalEvalCases({ projectRoot: '/proj-auto', fileLayer: 'cad' });
    expect(cad).toEqual([]);
    expect(manager.getProject).toHaveBeenCalled();
    // document 层排除 dwg/png 等，仅剩 pdf
    const docCases = await buildAutoKbRetrievalEvalCases({ projectRoot: '/proj-auto', fileLayer: 'document' });
    expect(docCases).toEqual([]);
  });

  it('includeExtensions / excludeExtensions 过滤', async () => {
    manager.getProject.mockResolvedValue({
      listFiles: () => [{ relativePath: '文档.pdf' }, { relativePath: '图纸.dwg' }],
      listChunks: () => [{ sectionTitle: '', titlePath: '', content: '项目名称：滨湖校区改造工程项目，建设地点：合肥市滨湖新区。' }],
    });
    // 仅 pdf：dwg 被排除
    const pdfOnly = await buildAutoKbRetrievalEvalCases({ projectRoot: '/proj-auto', includeExtensions: ['.pdf'] });
    expect(pdfOnly.length).toBeGreaterThan(0);
    expect(pdfOnly.every(item => item.relevantFiles?.every(file => file.endsWith('.pdf')))).toBe(true);
    // 排除 dwg：pdf 保留
    const noDwg = await buildAutoKbRetrievalEvalCases({ projectRoot: '/proj-auto', excludeExtensions: ['dwg'] });
    expect(noDwg.length).toBeGreaterThan(0);
  });

  it('filePathPrefixes 限定扫描文件范围', async () => {
    manager.getProject.mockResolvedValue({
      listFiles: () => [{ relativePath: '投标/招标文件.pdf' }, { relativePath: '其他/文件.pdf' }],
      listChunks: () => [{ sectionTitle: '', titlePath: '', content: '项目名称：滨湖校区改造工程项目，建设地点：合肥市滨湖新区。' }],
    });
    const cases = await buildAutoKbRetrievalEvalCases({ projectRoot: '/proj-auto', filePathPrefixes: ['投标/'] });
    expect(cases.length).toBeGreaterThan(0);
    expect(cases.every(item => item.filePaths?.every(file => file.startsWith('投标/')))).toBe(true);
  });
});
