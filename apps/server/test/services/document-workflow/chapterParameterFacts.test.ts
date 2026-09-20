/**
 * C-T6 可靠参数按章使用单测：按章相关性选择（双字子词扩展）/ 写作注入快照 / 使用归因（used/
 * 相关而遗漏/不相关遗漏）/ 义务满足率审计 / 修复链缺失池与目标章分配。全部为 L2 确定性纯函数，
 * 无 LLM 与语义通道。商务零写入断言覆盖：单价/保证金/税率/增值税/预留金类事实零进入注入与义务集。
 */
import { describe, expect, it } from 'vitest';
import {
  assignMissingParameterChapters, buildParameterUsageAudit, classifyParameterUsage,
  missingRelevantParameterTokens, renderChapterParameterLines, selectChapterParameterFacts,
} from '@/services/document-workflow/chapterParameterFacts';
import type { ParameterFactsSource } from '@/services/document-workflow/chapterParameterFacts';
import type { DocumentFact } from '@/services/document-workflow/types';

const fact = (over: Partial<DocumentFact>): DocumentFact => ({
  key: '',
  value: '',
  sourceFile: '资料.pdf',
  roleId: 'spec',
  confidence: 0.9,
  ...over,
});

const modelOf = (parameterFacts: DocumentFact[]): ParameterFactsSource => ({ factIndex: { parameterFacts } });

const CHAPTERS = [
  { title: '第一章 工程概况', sections: ['建设规模', '项目基本情况'] },
  { title: '第五章 主要施工方法', sections: ['排水工程'] },
];

describe('selectChapterParameterFacts（按章相关性选择）', () => {
  const pool = [
    fact({ key: '排水管道', fieldName: '管径', value: 'DN400 120m' }),
    fact({ key: '路灯', value: '100W 9套' }),
  ];

  it('本章相关参数被选中，无词面交集参数排除', () => {
    const picked = selectChapterParameterFacts(modelOf(pool), CHAPTERS[1]!.title, { sections: CHAPTERS[1]!.sections });
    expect(picked.map(item => item.key)).toEqual(['排水管道']);
    // 同一参数与「工程概况」章无词面交集 → 不注入该章
    expect(selectChapterParameterFacts(modelOf(pool), CHAPTERS[0]!.title, { sections: CHAPTERS[0]!.sections })).toEqual([]);
  });

  it('双字子词扩展命中（参数文本只含章节词部分字面）', () => {
    // 「排水工程」小节展开出「排水」子词，条目「混凝土排水沟浇筑」不含整词仍命中
    const subwordPool = [fact({ key: '混凝土排水沟浇筑', value: '120m3' })];
    const picked = selectChapterParameterFacts(modelOf(subwordPool), CHAPTERS[1]!.title, { sections: CHAPTERS[1]!.sections });
    expect(picked).toHaveLength(1);
  });

  it('factIndex 缺失时回退 preciseFacts 池（与检测端同源兜底）', () => {
    const picked = selectChapterParameterFacts({ preciseFacts: [pool[0]!] }, CHAPTERS[1]!.title, { sections: CHAPTERS[1]!.sections });
    expect(picked.map(item => item.key)).toEqual(['排水管道']);
  });

  it('maxEntries 截断且排序可复现（相关分降序、键字典序兜底）', () => {
    const many = [
      fact({ key: '排水管C', value: 'DN500' }),
      fact({ key: '排水管A', value: 'DN300' }),
      fact({ key: '排水管B', value: 'DN400' }),
    ];
    const picked = selectChapterParameterFacts(modelOf(many), CHAPTERS[1]!.title, { sections: CHAPTERS[1]!.sections, maxEntries: 2 });
    expect(picked.map(item => item.key)).toEqual(['排水管A', '排水管B']);
  });
});

describe('renderChapterParameterLines（写作注入）', () => {
  it('注入快照：header 声明逐项落位义务 + 条目行保持原值原形态', () => {
    const lines = renderChapterParameterLines(
      modelOf([fact({ key: '排水管道', fieldName: '管径', value: 'DN400 120m' })]),
      CHAPTERS[1]!.title,
      { sections: CHAPTERS[1]!.sections },
    );
    expect(lines).toEqual([
      '【本章可靠参数清单（资料事实链参数索引：1 项与本章相关的规格/参数/数量/时间/比例/标准编号，须逐项在正文对应位置自然写入，保持原值原形态（数字、单位、编号中的连字符与年份不得改写、拆分或省略）；商务金额/单价/税率/预留金类数据一律不得写入正文）】',
      '- 排水管道（管径）：DN400 120m',
    ]);
  });

  it('无相关参数返回空数组（不注入空清单）', () => {
    const lines = renderChapterParameterLines(modelOf([fact({ key: '路灯', value: '100W 9套' })]), CHAPTERS[1]!.title, { sections: CHAPTERS[1]!.sections });
    expect(lines).toEqual([]);
  });

  it('商务类零写入：单价/保证金/税率/增值税/预留金类事实不出现在注入清单', () => {
    const mixed = [
      fact({ key: '排水管道', value: 'DN400 120m' }),
      fact({ key: '综合单价', value: '45元/m' }),
      fact({ key: '投标保证金', value: '5万元' }),
      fact({ key: '增值税税率', value: '9%' }),
      fact({ key: '预留金', value: '30万元' }),
    ];
    const lines = renderChapterParameterLines(modelOf(mixed), CHAPTERS[1]!.title, { sections: CHAPTERS[1]!.sections });
    const dataLines = lines.slice(1);
    expect(dataLines.some(line => line.includes('DN400'))).toBe(true);
    expect(dataLines.join('\n')).not.toMatch(/单价|保证金|税率|增值税|预留金/u);
  });

  it('合同估算价类项目公开信息按单源口径保留（与商务检测器词面负例保护一致）', () => {
    const lines = renderChapterParameterLines(
      modelOf([fact({ key: '工程估算价', value: '1200万元' })]),
      CHAPTERS[0]!.title,
      { sections: CHAPTERS[0]!.sections },
    );
    expect(lines.slice(1)).toEqual(['- 工程估算价：1200万元']);
  });
});

describe('classifyParameterUsage / buildParameterUsageAudit（使用归因 + 义务口径）', () => {
  const model = modelOf([
    fact({ key: '排水管道', value: 'DN400' }),
    fact({ key: '道路工程', value: '1.2km' }),
    fact({ key: '灯具型号', value: 'LED-60W' }),
  ]);
  const markdown = '本工程排水管道采用 DN400 混凝土管，管径符合设计要求。';

  it('三分类：used / 相关而遗漏（义务集）/ 不相关遗漏（仅登记）', () => {
    const breakdown = classifyParameterUsage(markdown, model, CHAPTERS);
    expect(breakdown.totalParams).toBe(3);
    expect(breakdown.used.map(item => item.key)).toEqual(['排水管道']);
    expect(breakdown.relevantMissed.map(item => item.key)).toEqual(['道路工程']);
    expect(breakdown.irrelevantMissed.map(item => item.key)).toEqual(['灯具型号']);
  });

  it('audit：义务满足率 = used/(used+相关而遗漏)，明细含键值且不相关项仅计数', () => {
    const audit = buildParameterUsageAudit({ markdown, factsModel: model, chapters: CHAPTERS });
    expect(audit).toEqual({
      totalParams: 3,
      usedParams: 1,
      relevantMissedCount: 1,
      relevantMissed: ['道路工程：1.2km'],
      irrelevantMissedCount: 1,
      rate: 0.5,
    });
  });

  it('使用判定双端归一（30 日历天 ↔ 30天 等价命中）', () => {
    const normalized = classifyParameterUsage('本工程计划工期 30 日历天。', modelOf([fact({ key: '工期', value: '30天' })]), CHAPTERS);
    expect(normalized.used).toHaveLength(1);
  });

  it('无参数池返回 undefined；章集缺失时义务口径不可判定（rate null）', () => {
    expect(buildParameterUsageAudit({ markdown, factsModel: { preciseFacts: [] }, chapters: CHAPTERS })).toBeUndefined();
    const noChapters = buildParameterUsageAudit({ markdown, factsModel: model, chapters: [] });
    expect(noChapters?.rate).toBeNull();
  });

  it('噪声/商务条目不进入池（不注入、不计义务、不补写）', () => {
    const noisy = modelOf([
      fact({ key: '排水管OCR残留', value: 'DN300' }),
      fact({ key: '预留金', value: '30万元' }),
      fact({ key: '排水管道', value: 'DN400' }),
    ]);
    const audit = buildParameterUsageAudit({ markdown, factsModel: noisy, chapters: CHAPTERS });
    expect(audit?.totalParams).toBe(1);
    expect(audit?.usedParams).toBe(1);
  });
});

describe('missingRelevantParameterTokens / assignMissingParameterChapters（修复链）', () => {
  const model = modelOf([
    fact({ key: '排水管道', value: 'DN400' }),
    fact({ key: '道路工程', value: '1.2km' }),
    fact({ key: '灯具型号', value: 'LED-60W' }),
  ]);
  const markdown = '本工程排水管道采用 DN400 混凝土管，管径符合设计要求。';

  it('只返回相关而遗漏的参数值（不相关遗漏与已使用不返回）', () => {
    expect(missingRelevantParameterTokens(markdown, model, CHAPTERS)).toEqual(['1.2km']);
  });

  it('目标章分配：最相关章优先，同分取大纲靠前章', () => {
    // 「道路工程」与两章均经「工程」子词各命中 1 分 → 同分取靠前章
    const assignment = assignMissingParameterChapters(markdown, model, CHAPTERS);
    expect([...assignment.entries()]).toEqual([[0, ['1.2km']]]);
  });

  it('专业相关参数分配到专业小节所在章（排水类 → 排水工程小节章）', () => {
    const drainage = modelOf([fact({ key: '排水检查井', value: 'Φ1250' })]);
    const assignment = assignMissingParameterChapters('本工程无相关参数。', drainage, CHAPTERS);
    expect([...assignment.entries()]).toEqual([[1, ['Φ1250']]]);
  });

  it('商务/噪声遗漏不进入补写池；逐章限额生效', () => {
    const noisy = modelOf([
      fact({ key: '综合单价', value: '45元/m' }),
      fact({ key: '排水管OCR残留', value: 'DN300' }),
    ]);
    expect(assignMissingParameterChapters(markdown, noisy, CHAPTERS).size).toBe(0);
    const many = modelOf([
      fact({ key: '排水管A', value: 'DN300' }),
      fact({ key: '排水管B', value: 'DN400' }),
      fact({ key: '排水管C', value: 'DN500' }),
    ]);
    const limited = assignMissingParameterChapters('本工程无相关参数。', many, CHAPTERS, { maxPerChapter: 2 });
    expect(limited.get(1)).toHaveLength(2);
  });
});
