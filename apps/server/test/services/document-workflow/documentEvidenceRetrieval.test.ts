/**
 * documentEvidenceRetrieval 单测：检索覆盖风险判定、深召回触发决策、深召回查询构造、
 * 深召回执行（预算/来源标记/BOQ 加权）、检索覆盖报告与风险提示。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildDeepRetrievalQueries,
  buildRetrievalCoverageReport,
  retrievalCoverageIssues,
  retrievalCoverageRisk,
  retrieveDeepChapterEvidence,
  shouldTriggerDeepRetrieval,
} from '@/services/document-workflow/documentEvidenceRetrieval';
import type { DocumentEvidence, DocumentTemplateChapter } from '@/services/document-workflow/types';

const chapter = (title: string, overrides: Partial<DocumentTemplateChapter> = {}): DocumentTemplateChapter => ({
  id: `c-${title}`,
  title,
  purpose: `${title}写作目标`,
  queries: [`${title}资料查询`],
  requiredFacts: [`${title}关键事实`],
  ...overrides,
});

const evidence = (overrides: Partial<DocumentEvidence> = {}): DocumentEvidence => ({
  chapterId: 'c-工程概况',
  filePath: '/data/招标文件.docx',
  score: 10,
  content: '现场临时用电按三级配电系统布置。',
  ...overrides,
});

describe('retrievalCoverageRisk', () => {
  it('基本计算：omitted/loadedRatio', () => {
    const risk = retrievalCoverageRisk({ totalChunks: 100, loadedChunks: 60 });
    expect(risk.totalChunks).toBe(100);
    expect(risk.loadedChunks).toBe(60);
    expect(risk.omittedChunks).toBe(40);
    expect(risk.loadedRatio).toBe(0.6);
    expect(risk.highRisk).toBe(false);
    expect(risk.riskReason).toBeUndefined();
  });

  it('totalChunks 为 0 → ratio 兜底 1 且无风险', () => {
    const risk = retrievalCoverageRisk({ totalChunks: 0, loadedChunks: 0 });
    expect(risk.loadedRatio).toBe(1);
    expect(risk.highRisk).toBe(false);
  });

  it('负值与小数值安全夹取', () => {
    const risk = retrievalCoverageRisk({ totalChunks: -5, loadedChunks: 3.2 });
    expect(risk.totalChunks).toBe(0);
    expect(risk.loadedChunks).toBe(4);
  });

  it('大池（≥1000）预加载比例 <0.35 → 懒加载风险', () => {
    const risk = retrievalCoverageRisk({ totalChunks: 2000, loadedChunks: 300 });
    expect(risk.highRisk).toBe(true);
    expect(risk.riskReason).toContain('切片未完全预加载');
  });

  it('向量索引未就绪 → 召回质量风险', () => {
    const risk = retrievalCoverageRisk({ totalChunks: 100, loadedChunks: 100, vectorReady: false });
    expect(risk.highRisk).toBe(true);
    expect(risk.riskReason).toBe('向量索引未就绪');
  });

  it('双风险原因拼接', () => {
    const risk = retrievalCoverageRisk({ totalChunks: 2000, loadedChunks: 300, vectorReady: false });
    expect(risk.riskReason).toContain('切片未完全预加载');
    expect(risk.riskReason).toContain('向量索引未就绪');
  });
});

describe('shouldTriggerDeepRetrieval', () => {
  const base = { scopedFileCount: 10, evidenceCount: 10, evidenceFileCount: 5, suggestedStrategy: 'hybrid', highRisk: false, missingFactsCount: 0, requiredMissingNeedsCount: 0, riskLevel: 'low' };

  it('默认条件全不满足 → 不触发', () => {
    expect(shouldTriggerDeepRetrieval(base)).toBe(false);
  });

  it('策略建议 evidence_first → 触发', () => {
    expect(shouldTriggerDeepRetrieval({ ...base, suggestedStrategy: 'evidence_first' })).toBe(true);
  });

  it('高召回风险 → 触发', () => {
    expect(shouldTriggerDeepRetrieval({ ...base, highRisk: true })).toBe(true);
  });

  it('缺失事实或缺失需求 → 触发', () => {
    expect(shouldTriggerDeepRetrieval({ ...base, missingFactsCount: 1 })).toBe(true);
    expect(shouldTriggerDeepRetrieval({ ...base, requiredMissingNeedsCount: 1 })).toBe(true);
  });

  it('证据被 ≤2 个文件占满 → 强制触发（文件多样性兜底）', () => {
    expect(shouldTriggerDeepRetrieval({ ...base, evidenceFileCount: 2 })).toBe(true);
  });

  it('证据 <8 且风险非 low → 触发；low 时不触发', () => {
    expect(shouldTriggerDeepRetrieval({ ...base, evidenceCount: 5, riskLevel: 'medium' })).toBe(true);
    expect(shouldTriggerDeepRetrieval({ ...base, evidenceCount: 5, riskLevel: 'low' })).toBe(false);
  });

  it('大资料池（>80 文件）常规跳过深召回，但证据单文件占满仍强制', () => {
    expect(shouldTriggerDeepRetrieval({ ...base, scopedFileCount: 100 })).toBe(false);
    expect(shouldTriggerDeepRetrieval({ ...base, scopedFileCount: 100, evidenceFileCount: 2 })).toBe(true);
  });
});

describe('buildDeepRetrievalQueries', () => {
  it('查询包含章节标题与要点/事实组合且去重', () => {
    const queries = buildDeepRetrievalQueries(chapter('工程概况', { sections: ['建设规模', '建设地点'], requiredFacts: ['总建筑面积'] }));
    expect(queries.length).toBeGreaterThan(0);
    expect(new Set(queries).size).toBe(queries.length);
    expect(queries.some(query => query.startsWith('工程概况 '))).toBe(true);
    expect(queries.some(query => query.includes('总建筑面积'))).toBe(true);
  });

  it('进度章节注入工期领域提示词', () => {
    const queries = buildDeepRetrievalQueries(chapter('施工进度计划'));
    expect(queries.some(query => query.includes('合同工期'))).toBe(true);
    expect(queries.some(query => query.includes('关键线路'))).toBe(true);
  });

  it('安全章节注入危大基坑领域提示词', () => {
    const queries = buildDeepRetrievalQueries(chapter('危大工程安全管理'));
    expect(queries.some(query => query.includes('基坑底标高'))).toBe(true);
    expect(queries.some(query => query.includes('专项方案'))).toBe(true);
  });

  it('资源章节注入清单材料领域提示词', () => {
    const queries = buildDeepRetrievalQueries(chapter('主要材料设备配置'));
    expect(queries.some(query => query.includes('工程量清单'))).toBe(true);
    expect(queries.some(query => query.includes('规格型号'))).toBe(true);
  });

  it('复合标题拆分出子部分查询与领域扩充', () => {
    const queries = buildDeepRetrievalQueries(chapter('施工进度计划、质量保证措施'));
    expect(queries.some(query => query.startsWith('施工进度计划 '))).toBe(true);
    expect(queries.some(query => query.startsWith('质量保证措施 '))).toBe(true);
    expect(queries.some(query => query.includes('质量保证措施'))).toBe(true);
  });

  it('requiredNeeds 并入事实查询候选', () => {
    const queries = buildDeepRetrievalQueries(chapter('工程概况'), ['基坑底标高']);
    expect(queries.some(query => query.includes('基坑底标高'))).toBe(true);
  });
});

describe('retrieveDeepChapterEvidence', () => {
  const searchMock = vi.fn<(projectRoot: string, query: string, options: unknown) => Promise<{ results: Array<{ filePath: string; score: number; content: string; sectionTitle?: string; source?: string }> }>>();

  const manager = { search: searchMock };
  const scopedFiles = ['/data/招标文件.docx', '/data/工程量清单.xlsx'];
  const fileRoleByPath = new Map([['/data/招标文件.docx', 'role-tender']]);
  const fileProcessingByPath = new Map([['/data/工程量清单.xlsx', 'bill_of_quantities']]);

  beforeEach(() => {
    searchMock.mockReset();
  });

  it('scopedFilePaths 为空 → 直接返回空（不发起检索）', async () => {
    const result = await retrieveDeepChapterEvidence({
      manager,
      projectRoot: '/proj',
      chapter: chapter('工程概况'),
      scopedFilePaths: [],
      fileRoleByPath: new Map(),
      fileProcessingByPath: new Map(),
    });
    expect(result).toEqual([]);
    expect(searchMock).not.toHaveBeenCalled();
  });

  it('检索结果过滤范围外文件并标记来源与加权', async () => {
    searchMock.mockImplementation(async (_root, query, _options) => ({
      results: [
        { filePath: '/data/招标文件.docx', score: 1, content: '总工期420日历天' },
        { filePath: '/data/范围外文件.docx', score: 9, content: '不应被保留' },
      ],
    }));
    const result = await retrieveDeepChapterEvidence({
      manager,
      projectRoot: '/proj',
      chapter: chapter('工程概况'),
      scopedFilePaths: scopedFiles,
      fileRoleByPath,
      fileProcessingByPath,
    });
    expect(result.every(item => scopedFiles.includes(item.filePath))).toBe(true);
    expect(result.some(item => item.source === 'deep-retrieval')).toBe(true);
    // score 经 uniqueEvidence 质量因子重算，不锁定精确值，只断言高于原始基础分（有 boost 加权）
    const kept = result.find(item => item.filePath === '/data/招标文件.docx')!;
    expect(kept.score).toBeGreaterThan(1);
    expect(kept.roleId).toBe('role-tender');
  });

  it('requiredNeeds 生成精确查询并标记 required-fact-evidence', async () => {
    searchMock.mockImplementation(async (_root, query, _options) => ({
      results: [{ filePath: '/data/招标文件.docx', score: 1, content: `结果${query}` }],
    }));
    const result = await retrieveDeepChapterEvidence({
      manager,
      projectRoot: '/proj',
      // 章节带小节：精确 need 查询形态（标题+need+小节）与广谱查询不同，才能保留独立来源标记
      chapter: chapter('工程概况', { sections: ['建设规模'] }),
      scopedFilePaths: scopedFiles,
      fileRoleByPath,
      fileProcessingByPath,
      requiredNeeds: ['基坑底标高'],
    });
    expect(result.some(item => item.source === 'required-fact-evidence')).toBe(true);
  });

  it('BOQ 处理类型材料获得额外加权', async () => {
    searchMock.mockImplementation(async (_root, _query, _options) => ({
      results: [{ filePath: '/data/工程量清单.xlsx', score: 1, content: '清单项内容' }],
    }));
    const result = await retrieveDeepChapterEvidence({
      manager,
      projectRoot: '/proj',
      chapter: chapter('工程概况'),
      scopedFilePaths: scopedFiles,
      fileRoleByPath,
      fileProcessingByPath,
    });
    const boq = result.find(item => item.filePath === '/data/工程量清单.xlsx')!;
    // score 经 uniqueEvidence 质量因子重算，只断言来源标记与处理类型透传
    expect(boq.score).toBeGreaterThan(1);
    expect(boq.processingType).toBe('bill_of_quantities');
    expect(boq.source).toBe('deep-retrieval');
  });

  it('已中止信号 → 立即抛错', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      retrieveDeepChapterEvidence({
        manager,
        projectRoot: '/proj',
        chapter: chapter('工程概况'),
        scopedFilePaths: scopedFiles,
        fileRoleByPath,
        fileProcessingByPath,
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(searchMock).not.toHaveBeenCalled();
  });
});

describe('buildRetrievalCoverageReport', () => {
  it('小节与必需事实覆盖统计', () => {
    const risk = retrievalCoverageRisk({ totalChunks: 10, loadedChunks: 10 });
    const report = buildRetrievalCoverageReport({
      chapter: chapter('工程概况', { sections: ['建设规模', '建设地点'], requiredFacts: ['总建筑面积', '计划工期'] }),
      evidence: [
        evidence({ content: '建设规模为本工程总建筑面积12000m²。' }),
        evidence({ content: '计划工期420日历天。' }),
        evidence({ filePath: '/data/进度计划.docx' }),
      ],
      risk,
    });
    expect(report.chapterId).toBe('c-工程概况');
    expect(report.evidenceCount).toBe(3);
    expect(report.evidenceFiles).toBe(2);
    expect(report.sectionCovered).toBe(1); // 建设规模命中
    expect(report.sectionTotal).toBe(2);
    expect(report.requiredFactCovered).toBe(2); // 总建筑面积 + 计划工期均有证据命中
    expect(report.requiredFactTotal).toBe(2);
    expect(report.risk).toBe(risk);
  });

  it('sectionTitle 匹配也可覆盖小节', () => {
    const report = buildRetrievalCoverageReport({
      chapter: chapter('工程概况', { sections: ['建设地点'], requiredFacts: [] }),
      evidence: [evidence({ content: '普通内容', sectionTitle: '建设地点' })],
      risk: retrievalCoverageRisk({ totalChunks: 1, loadedChunks: 1 }),
    });
    expect(report.sectionCovered).toBe(1);
  });
});

describe('retrievalCoverageIssues', () => {
  it('高风险且必需事实未全覆盖 → 生成复核提示', () => {
    const risk = retrievalCoverageRisk({ totalChunks: 2000, loadedChunks: 300 });
    const report = buildRetrievalCoverageReport({
      chapter: chapter('工程概况', { requiredFacts: ['总建筑面积', '计划工期'] }),
      evidence: [evidence({ content: '计划工期420日历天。' })],
      risk,
    });
    const issues = retrievalCoverageIssues([report]);
    expect(issues).toHaveLength(1);
    expect(issues[0].level).toBe('warning');
    expect(issues[0].message).toContain('工程概况');
    expect(issues[0].suggestion).toContain('切片未完全预加载');
    expect(issues[0].suggestion).toContain('1/2');
  });

  it('无必需事实的高风险章节：证据 <8 条才提示', () => {
    const risk = retrievalCoverageRisk({ totalChunks: 2000, loadedChunks: 300 });
    const sparse = buildRetrievalCoverageReport({ chapter: chapter('工程概况', { requiredFacts: [] }), evidence: [evidence()], risk });
    const full = buildRetrievalCoverageReport({
      chapter: chapter('工程概况', { requiredFacts: [] }),
      evidence: Array.from({ length: 8 }, (_, index) => evidence({ filePath: `/data/f${index}.docx` })),
      risk,
    });
    expect(retrievalCoverageIssues([sparse])).toHaveLength(1);
    expect(retrievalCoverageIssues([full])).toHaveLength(0);
  });

  it('低风险章节不生成提示', () => {
    const report = buildRetrievalCoverageReport({
      chapter: chapter('工程概况', { requiredFacts: ['总建筑面积'] }),
      evidence: [],
      risk: retrievalCoverageRisk({ totalChunks: 10, loadedChunks: 10 }),
    });
    expect(retrievalCoverageIssues([report])).toHaveLength(0);
  });
});
