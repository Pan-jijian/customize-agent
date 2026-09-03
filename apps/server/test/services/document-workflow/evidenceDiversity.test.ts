import { describe, expect, it } from 'vitest';
import { buildDeepRetrievalQueries, shouldTriggerDeepRetrieval } from '@/services/document-workflow/documentEvidenceRetrieval';

const lowRiskBase = {
  scopedFileCount: 40,
  evidenceCount: 10,
  evidenceFileCount: 6,
  suggestedStrategy: 'balanced',
  highRisk: false,
  missingFactsCount: 0,
  requiredMissingNeedsCount: 0,
  riskLevel: 'low',
};

describe('shouldTriggerDeepRetrieval 文件多样性兜底', () => {
  it('证据被单一文件占满时强制深召回（基坑支护图等关键参数文件需被检索）', () => {
    expect(shouldTriggerDeepRetrieval({ ...lowRiskBase, evidenceFileCount: 1 })).toBe(true);
    expect(shouldTriggerDeepRetrieval({ ...lowRiskBase, evidenceFileCount: 2 })).toBe(true);
  });

  it('证据覆盖 ≥3 个文件且低风险时不强制深召回', () => {
    expect(shouldTriggerDeepRetrieval({ ...lowRiskBase, evidenceFileCount: 3 })).toBe(false);
    expect(shouldTriggerDeepRetrieval(lowRiskBase)).toBe(false);
  });

  it('高危/缺失事实/必需事实缺口仍触发深召回', () => {
    expect(shouldTriggerDeepRetrieval({ ...lowRiskBase, highRisk: true })).toBe(true);
    expect(shouldTriggerDeepRetrieval({ ...lowRiskBase, missingFactsCount: 1 })).toBe(true);
    expect(shouldTriggerDeepRetrieval({ ...lowRiskBase, requiredMissingNeedsCount: 1 })).toBe(true);
  });

  it('证据条数 <8 且非低风险时触发深召回', () => {
    expect(shouldTriggerDeepRetrieval({ ...lowRiskBase, evidenceCount: 5, evidenceFileCount: 3, riskLevel: 'medium' })).toBe(true);
    expect(shouldTriggerDeepRetrieval({ ...lowRiskBase, evidenceCount: 5, evidenceFileCount: 3 })).toBe(false);
  });

  it('大资料池（>80 文件）：证据单文件占满仍强制深召回，多文件低风险则不触发', () => {
    expect(shouldTriggerDeepRetrieval({ ...lowRiskBase, scopedFileCount: 99, evidenceFileCount: 1 })).toBe(true);
    expect(shouldTriggerDeepRetrieval({ ...lowRiskBase, scopedFileCount: 99, evidenceFileCount: 6 })).toBe(false);
  });
});

describe('buildDeepRetrievalQueries 危大章节基坑专项词扩展', () => {
  const dangerChapter = { id: 'c1', title: '工程重点难点及危大工程的保障体系', purpose: '', queries: [], sections: ['安全管理、风险分级与危大工程管控', '资源配置计划'], requiredFacts: ['危大工程清单'] };
  it('安全/危大章节查询覆盖基坑专项术语', () => {
    const queries = buildDeepRetrievalQueries(dangerChapter).join(' ');
    for (const term of ['基坑支护', '基坑开挖', '基坑底标高', '坡率', '支护形式', '开挖深度']) {
      expect(queries).toContain(term);
    }
  });

  it('非安全/危大章节不注入基坑专项词（防误扩）', () => {
    const qualityChapter = { id: 'c2', title: '确保工程质量的保障体系与措施', purpose: '', queries: [], sections: ['质量保证体系'], requiredFacts: [] };
    const queries = buildDeepRetrievalQueries(qualityChapter).join(' ');
    expect(queries).not.toContain('基坑底标高');
    expect(queries).toContain('质量标准');
  });
});
