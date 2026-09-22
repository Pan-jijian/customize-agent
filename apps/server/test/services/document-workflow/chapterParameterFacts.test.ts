/**
 * C-T6 可靠参数按章使用单测：按章相关性选择（双字子词扩展）/ 写作注入快照 / 使用归因（used/
 * 相关而遗漏/不相关遗漏）/ 义务满足率审计 / 修复链缺失池与目标章分配。全部为 L2 确定性纯函数，
 * 无 LLM 与语义通道。商务零写入断言覆盖：单价/保证金/税率/增值税/预留金类事实零进入注入与义务集。
 */
import { describe, expect, it } from 'vitest';
import {
  assignMissingParameterChapters, buildParameterUsageAudit, classifyParameterUsage,
  missingRelevantParameterTokens, PARAMETER_OBLIGATION_MIN_RATE, PARAMETER_OBLIGATION_MIN_TOTAL,
  parameterObligationUsageIssues, renderChapterParameterLines, selectChapterParameterFacts,
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

  it('上限治理：**不设条数上限**（原 maxEntries=60 让第 61 项起既不进提示词也不进落位义务）', () => {
    const many = [
      fact({ key: '排水管C', value: 'DN500' }),
      fact({ key: '排水管A', value: 'DN300' }),
      fact({ key: '排水管B', value: 'DN400' }),
    ];
    const picked = selectChapterParameterFacts(modelOf(many), CHAPTERS[1]!.title, { sections: CHAPTERS[1]!.sections });
    expect(picked).toHaveLength(3);
    expect(picked.map(item => item.key)).toEqual(['排水管A', '排水管B', '排水管C']);
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
      '【逐对象写实铁律】带对象前缀的条目（「对象｜属性=值」）必须写到**该对象**的正文处——**禁止把某对象的参数写到另一对象**；同一属性在不同对象下各有其值（如「基础垫层 100mm」与「地坪垫层 300mm」并列）是**正确**的，不得"统一"或只取其一。',
      '- 排水管道（管径）：DN400 120m',
    ]);
  });

  it('4.55.25 对象化注入：带对象锚点的值渲染为「对象｜属性=值」', () => {
    const lines = renderChapterParameterLines(
      modelOf([fact({ key: '排水管道', fieldName: '管径', value: 'DN400', objectName: '雨水管道' })]),
      CHAPTERS[1]!.title,
      { sections: CHAPTERS[1]!.sections },
    );
    expect(lines.some(line => line.includes('- 雨水管道｜排水管道（管径）=DN400'))).toBe(true);
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
    expect(lines.slice(2)).toEqual(['- 工程估算价：1200万元']);
    expect(lines[1]).toContain('逐对象写实铁律');
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
      noiseExcludedCount: 0,
      noiseExcluded: [],
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

  it('商务/噪声遗漏不进入补写池（池净化）', () => {
    const noisy = modelOf([
      fact({ key: '综合单价', value: '45元/m' }),
      fact({ key: '排水管OCR残留', value: 'DN300' }),
    ]);
    expect(assignMissingParameterChapters(markdown, noisy, CHAPTERS).size).toBe(0);
  });

  it('G 线 上限治理：分配层**不设任何限额**——每个遗漏参数都必须有主章（无截断丢失）', () => {
    // 历史实现有「每章 16 条 + 总量 96 条」两道限额：超出者**永不进入补写**，
    // 且所有章满额时该参数被整体丢弃（内层择优循环走完仍未分配）。
    // 当时的处置是「放宽限额」（6/24 → 16/96）而非去掉——把悬崖往后挪一格，
    // 项目数据量一大就复现。现口径：分配层不截断，指令大小由**渲染层按真实 prompt 预算**控制，
    // 剩余项由后续轮次继续消费（每轮基于当前正文重算 relevantMissed，已落位的自然退出）。
    const many = modelOf([
      fact({ key: '排水管A', value: 'DN300' }),
      fact({ key: '排水管B', value: 'DN400' }),
      fact({ key: '排水管C', value: 'DN500' }),
    ]);
    const assignment = assignMissingParameterChapters('本工程无相关参数。', many, CHAPTERS);
    const assigned = [...assignment.values()].flat();
    // 三条全部有主，一条不少
    expect(assigned.sort()).toEqual(['DN300', 'DN400', 'DN500']);
  });

  it('G 线 上限治理：超大批次（500 条）全部有主——不因数据量大而丢弃', () => {
    const bulk = modelOf(Array.from({ length: 500 }, (_, i) => fact({ key: `排水管${i}`, value: `DN${1000 + i}` })));
    const assignment = assignMissingParameterChapters('本工程无相关参数。', bulk, CHAPTERS);
    const assigned = [...assignment.values()].flat();
    expect(assigned).toHaveLength(500);
    expect(new Set(assigned).size).toBe(500);
  });
});

describe('parameterObligationUsageIssues（可靠参数义务满足率门禁）', () => {
  // 8 条相关且全部字面落位（义务满足率 1.0）的基线池
  const eight = ['DN400', 'DN500', 'Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6'];
  const eightMarkdown = `本工程排水管道采用 ${eight.join('、')} 混凝土管。`;
  const eightPool = eight.map((value, index) => fact({ key: `排水管道端点${index + 1}`, value }));

  it('正样本：义务满足率低于门槛 → 单条 error（category/owner/repairability/provenance 打点齐全）', () => {
    const pool = [
      fact({ key: '排水管道起点', value: 'DN400' }),
      fact({ key: '排水管道终点', value: 'DN500' }),
      ...['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7'].map((value, index) => fact({ key: `排水工程参数${index + 1}`, value })),
    ];
    const issues = parameterObligationUsageIssues('本工程排水管道采用 DN400 与 DN500 混凝土管。', modelOf(pool), CHAPTERS);
    expect(issues).toHaveLength(1);
    const [issue] = issues;
    expect(issue.level).toBe('error');
    expect(issue.category).toBe('fact_consistency');
    expect(issue.owner).toBe('llm');
    expect(issue.repairability).toBe('llm_repairable');
    expect(issue.message).toContain('可靠参数义务落位不足：2/9');
    expect(issue.message).toContain('相关而遗漏 7 项');
    expect(issue.message).toContain('缺失如 Q1');
    expect(issue.provenance?.detectorId).toBe('parameter-obligation-usage');
  });

  it('反样本：满足率达门槛边界（9/10=0.9）静默；义务集 < 最小值不判；章节缺失不判', () => {
    // 9 used + 1 missed = 9/10 = 0.9 → 静默（>= 门槛）
    const boundary = [
      ...['DN400', 'DN500', 'Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7'].map((value, index) => fact({ key: `排水管道端点${index + 1}`, value })),
      fact({ key: '排水工程参数末位', value: 'Q9' }),
    ];
    expect(parameterObligationUsageIssues(eightMarkdown.replace('Q6', 'Q6、Q7'), modelOf(boundary), CHAPTERS)).toEqual([]);
    // 义务集 5 < 8：全遗漏也不判（防小样本抖动）
    const small = modelOf(['Q1', 'Q2', 'Q3', 'Q4', 'Q5'].map((value, index) => fact({ key: `排水工程小样本${index + 1}`, value })));
    expect(parameterObligationUsageIssues('本工程无相关内容。', small, CHAPTERS)).toEqual([]);
    // 章节缺失：相关口径不可判定
    expect(parameterObligationUsageIssues('', small, [])).toEqual([]);
  });

  it('噪声/商务出池不计义务分母（D6 同源净化单源）：混入噪声与商务事实仍静默', () => {
    const pool = [
      ...eightPool,
      // 若入池则计入分母（8/13 触发）——出池不动分母即证明池净化单源（含 3 字符残片「12月」）
      fact({ key: '排水工程噪声1', value: 'R6C4项目特征描述' }),
      fact({ key: '排水工程噪声2', value: '2225111舒城县' }),
      fact({ key: '排水工程噪声3', value: '12月' }),
      fact({ key: '排水工程噪声4', value: '000L' }),
      fact({ key: '排水工程暂列金额', value: '50万元' }),
    ];
    expect(parameterObligationUsageIssues(eightMarkdown, modelOf(pool), CHAPTERS)).toEqual([]);
  });

  it('防误伤：与全部章无词面相关的遗漏只登记不计义务（8 相关全落位 + 3 条无关遗漏静默）', () => {
    const pool = [
      ...eightPool,
      fact({ key: '苗木养护规则', value: 'XZ-77' }),
      fact({ key: '路灯控制型号', value: 'LD-01' }),
      fact({ key: '绿化种植品种', value: 'LV-02' }),
    ];
    expect(parameterObligationUsageIssues(eightMarkdown, modelOf(pool), CHAPTERS)).toEqual([]);
  });

  it('门槛常量口径（检测端 export 单源）：0.9 / 8', () => {
    expect(PARAMETER_OBLIGATION_MIN_RATE).toBe(0.9);
    expect(PARAMETER_OBLIGATION_MIN_TOTAL).toBe(8);
  });
});
