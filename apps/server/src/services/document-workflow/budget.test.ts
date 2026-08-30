/**
 * budget 单测：篇幅预算纯逻辑链路（中文数字解析/显式长度目标/模板与 spec 回退/篇幅告警口径），
 * 无 LLM/DB 依赖。
 */
import { describe, expect, it } from 'vitest';
import {
  buildDocumentBudget,
  chapterBudgetWeight,
  charsPerPageForSettings,
  documentBudgetIssues,
  documentBudgetStatus,
  documentTextLength,
  estimateDocumentPages,
  explicitLengthTargets,
  pageTargetIssues,
  parseChineseNumber,
  type DocumentBudget,
} from './budget';
import type { AutoDocumentSpecPackage } from '../document-core/autoDocumentSpecTypes';
import type { DocumentTemplate, DocumentTemplateChapter } from './types';

function makeChapter(overrides: Partial<DocumentTemplateChapter> = {}): DocumentTemplateChapter {
  return { id: 'c1', title: '第一章', purpose: '', queries: [], requiredFacts: [], ...overrides };
}

function makeTemplate(overrides: Partial<DocumentTemplate> = {}): DocumentTemplate {
  return {
    id: 't1',
    name: '测试模板',
    description: '',
    category: '施工组织设计',
    outputTitle: '施工组织设计',
    chapters: [makeChapter()],
    ...overrides,
  };
}

function makeBudget(overrides: Partial<DocumentBudget> = {}): DocumentBudget {
  return {
    charsPerPage: 900,
    chapterTargets: new Map(),
    source: 'explicit',
    mode: 'exact',
    longformStrict: false,
    ...overrides,
  };
}

describe('parseChineseNumber', () => {
  it('阿拉伯数字（含小数）', () => {
    expect(parseChineseNumber('10')).toBe(10);
    expect(parseChineseNumber('3.5')).toBe(3.5);
  });

  it('中文数字连写形式', () => {
    expect(parseChineseNumber('十')).toBe(10);
    expect(parseChineseNumber('二十三')).toBe(23);
    expect(parseChineseNumber('三十')).toBe(30);
    expect(parseChineseNumber('十五')).toBe(15);
  });

  it('非数字返回 undefined', () => {
    expect(parseChineseNumber('两')).toBeUndefined();
    expect(parseChineseNumber('一百')).toBeUndefined();
    expect(parseChineseNumber('abc')).toBeUndefined();
  });
});

describe('explicitLengthTargets', () => {
  it('不少于/以上 → minimum 口径', () => {
    expect(explicitLengthTargets('不少于40页')).toEqual({
      targetPages: 40,
      pageMode: 'minimum',
      targetChars: undefined,
      charMode: undefined,
    });
    expect(explicitLengthTargets('共10万字以上')).toEqual({
      targetPages: undefined,
      pageMode: undefined,
      targetChars: 100000,
      charMode: 'minimum',
    });
  });

  it('约/左右 → approximate 口径', () => {
    expect(explicitLengthTargets('约三十页左右')).toEqual({
      targetPages: 30,
      pageMode: 'approximate',
      targetChars: undefined,
      charMode: undefined,
    });
  });

  it('多个匹配取最后一个', () => {
    const result = explicitLengthTargets('不少于20页，约30页');
    expect(result.targetPages).toBe(30);
    expect(result.pageMode).toBe('approximate');
  });

  it('页与字目标可同时提取', () => {
    const result = explicitLengthTargets('不少于40页，且不少于2万字');
    expect(result.targetPages).toBe(40);
    expect(result.pageMode).toBe('minimum');
    expect(result.targetChars).toBe(20000);
    expect(result.charMode).toBe('minimum');
  });

  it('无目标文本返回空', () => {
    const result = explicitLengthTargets('正文内容按需展开');
    expect(result.targetPages).toBeUndefined();
    expect(result.pageMode).toBeUndefined();
    expect(result.targetChars).toBeUndefined();
    expect(result.charMode).toBeUndefined();
  });
});

describe('documentTextLength / charsPerPageForSettings / estimateDocumentPages', () => {
  it('正文长度剔除 HTML 标签与空白', () => {
    expect(documentTextLength('<p>你好</p> 世界')).toBe(4);
    expect(documentTextLength('')).toBe(0);
  });

  it('每页字符数按字体大小/行高分档', () => {
    expect(charsPerPageForSettings()).toBe(900);
    expect(charsPerPageForSettings({ typography: { bodySize: '16px', lineHeight: '24px' } })).toBe(900);
    expect(charsPerPageForSettings({ typography: { bodySize: '12pt', lineHeight: '1.5em' } })).toBe(1050);
    // generationSettings 无 typography 字段 → 默认档
    expect(charsPerPageForSettings({ targetPages: { target: 10 } })).toBe(900);
  });

  it('估算页数向上取整', () => {
    expect(estimateDocumentPages('字'.repeat(500))).toBe(1);
    expect(estimateDocumentPages('字'.repeat(1000))).toBe(2);
  });
});

describe('chapterBudgetWeight', () => {
  it('方案/措施类章节加权 1.3', () => {
    expect(chapterBudgetWeight(makeChapter({ title: '施工方案' }))).toBe(1.3);
    expect(chapterBudgetWeight(makeChapter({ title: '质量保证措施' }))).toBe(1.3);
    expect(chapterBudgetWeight(makeChapter({ title: '第一章', purpose: '安全技术交底' }))).toBe(1.3);
  });

  it('概况/结语/附录类降权 0.75', () => {
    expect(chapterBudgetWeight(makeChapter({ title: '工程概况' }))).toBe(0.75);
    expect(chapterBudgetWeight(makeChapter({ title: '结语' }))).toBe(0.75);
  });

  it('普通章节权重 1', () => {
    expect(chapterBudgetWeight(makeChapter({ title: '其他说明' }))).toBe(1);
  });
});

describe('buildDocumentBudget', () => {
  it('explicit（不少于40页）→ minimum 口径与章节加权分配', () => {
    const template = makeTemplate({
      exportSettings: { typography: { bodySize: '16px', lineHeight: '24px' } },
    });
    const chapters = [
      makeChapter({ id: 'c1', title: '施工方案' }),
      makeChapter({ id: 'c2', title: '工程概况' }),
    ];
    const budget = buildDocumentBudget({ requirement: '不少于40页', promptTexts: '', template, chapters });
    expect(budget.source).toBe('explicit');
    expect(budget.mode).toBe('minimum');
    expect(budget.targetPages).toBe(40);
    expect(budget.minPages).toBe(40);
    expect(budget.maxPages).toBeUndefined();
    expect(budget.targetChars).toBe(36000);
    expect(budget.minChars).toBe(36000);
    expect(budget.maxChars).toBeUndefined();
    expect(budget.charsPerPage).toBe(900);
    expect(budget.longformStrict).toBe(false);
    // 权重 1.3/0.75，总权重 2.05：round(36000*1.3/2.05)=22829、round(36000*0.75/2.05)=13171
    expect(budget.chapterTargets.get('c1')).toBe(22829);
    expect(budget.chapterTargets.get('c2')).toBe(13171);
  });

  it('template 目标页数 → template 来源与 min/max 推导', () => {
    const template = makeTemplate({ exportSettings: { targetPages: { target: 30 } } });
    const budget = buildDocumentBudget({ requirement: '', promptTexts: '', template, chapters: [makeChapter()] });
    expect(budget.source).toBe('template');
    expect(budget.mode).toBe('exact');
    expect(budget.targetPages).toBe(30);
    expect(budget.minPages).toBe(28);
    expect(budget.maxPages).toBeUndefined();
    expect(budget.targetChars).toBe(27000);
    expect(budget.minChars).toBe(24300);
    expect(budget.maxChars).toBe(29161);
    expect(budget.longformStrict).toBe(false);
  });

  it('spec 章节字数下限 → spec 来源与章节下限', () => {
    const spec = {
      chapterRules: [{ id: 'c1', title: '第一章', minWords: 1500 }],
      dynamicChapterRule: { minWordsPerChapter: 100 },
    } as unknown as AutoDocumentSpecPackage;
    const chapters = [makeChapter({ id: 'c1' }), makeChapter({ id: 'c2', title: '第二章' })];
    const budget = buildDocumentBudget({ requirement: '', promptTexts: '', template: makeTemplate(), chapters, spec });
    expect(budget.source).toBe('spec');
    expect(budget.mode).toBe('exact');
    expect(budget.targetChars).toBeUndefined();
    expect(budget.chapterTargets.get('c1')).toBe(1500);
    expect(budget.chapterTargets.get('c2')).toBe(1200);
  });

  it('无任何目标 → default 来源与统一 1200 下限', () => {
    const chapters = [makeChapter({ id: 'c1' }), makeChapter({ id: 'c2', title: '第二章' })];
    const budget = buildDocumentBudget({ requirement: '', promptTexts: '', template: makeTemplate(), chapters });
    expect(budget.source).toBe('default');
    expect(budget.mode).toBe('exact');
    expect(budget.targetChars).toBeUndefined();
    expect(budget.minChars).toBeUndefined();
    expect(budget.maxChars).toBeUndefined();
    expect(budget.chapterTargets.get('c1')).toBe(1200);
    expect(budget.chapterTargets.get('c2')).toBe(1200);
  });

  it('explicit（约2万字）→ approximate 放宽区间', () => {
    const budget = buildDocumentBudget({
      requirement: '约2万字',
      promptTexts: '',
      template: makeTemplate(),
      chapters: [makeChapter()],
    });
    expect(budget.source).toBe('explicit');
    expect(budget.mode).toBe('approximate');
    expect(budget.targetChars).toBe(20000);
    expect(budget.minChars).toBe(18000);
    expect(budget.maxChars).toBe(23000);
    expect(budget.targetPages).toBeUndefined();
    expect(budget.longformStrict).toBe(false);
  });

  it('explicit（不少于5万字）→ 长文严格口径', () => {
    const budget = buildDocumentBudget({
      requirement: '不少于5万字',
      promptTexts: '',
      template: makeTemplate(),
      chapters: [makeChapter()],
    });
    expect(budget.mode).toBe('minimum');
    expect(budget.targetChars).toBe(50000);
    expect(budget.minChars).toBe(50000);
    expect(budget.longformStrict).toBe(true);
  });
});

describe('pageTargetIssues', () => {
  it('无目标页数设置 → 不告警', () => {
    expect(pageTargetIssues({ targetPages: {} }, '字'.repeat(9000))).toEqual([]);
    expect(pageTargetIssues(undefined, '字'.repeat(9000))).toEqual([]);
  });

  it('低于目标页数 → warning', () => {
    const issues = pageTargetIssues({ targetPages: { target: 10 } }, '字'.repeat(1800));
    expect(issues).toHaveLength(1);
    expect(issues[0].level).toBe('warning');
    expect(issues[0].message).toContain('低于目标页数');
  });

  it('超过目标页数 + 4 页容差 → warning', () => {
    const issues = pageTargetIssues({ targetPages: { target: 10 } }, '字'.repeat(900 * 15));
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('超过目标页数');
  });

  it('落在 min/max 区间内 → 不告警', () => {
    expect(pageTargetIssues({ targetPages: { min: 5, max: 20 } }, '字'.repeat(9000))).toEqual([]);
  });
});

describe('documentBudgetIssues', () => {
  it('低于字数与页数下限 → 双 warning', () => {
    const budget = makeBudget({ minChars: 10000, maxChars: 20000, minPages: 5, maxPages: 20 });
    const issues = documentBudgetIssues(budget, '字'.repeat(2000));
    expect(issues).toHaveLength(2);
    expect(issues.every(issue => issue.level === 'warning')).toBe(true);
    expect(issues.some(issue => issue.message.includes('低于目标字数'))).toBe(true);
    expect(issues.some(issue => issue.message.includes('低于目标页数'))).toBe(true);
  });

  it('超过 maxChars 未超 12% 容差 → warning', () => {
    const budget = makeBudget({ minChars: 10000, maxChars: 20000 });
    const issues = documentBudgetIssues(budget, '字'.repeat(21000));
    expect(issues.some(issue => issue.level === 'warning' && issue.message.includes('超过目标字数'))).toBe(true);
  });

  it('超过 maxChars*1.12 → error', () => {
    const budget = makeBudget({ minChars: 10000, maxChars: 20000 });
    const issues = documentBudgetIssues(budget, '字'.repeat(24000));
    expect(issues.some(issue => issue.level === 'error' && issue.message.includes('超过目标字数'))).toBe(true);
  });

  it('篇幅达标 → 不告警', () => {
    const budget = makeBudget({ minChars: 1000, maxChars: 5000 });
    expect(documentBudgetIssues(budget, '字'.repeat(2000))).toEqual([]);
  });
});

describe('documentBudgetStatus', () => {
  it('按 charsPerPage 计算字数与页数', () => {
    const budget = makeBudget({ charsPerPage: 900 });
    expect(documentBudgetStatus(budget, '字'.repeat(1800))).toEqual({ currentChars: 1800, estimatedPages: 2 });
  });
});
