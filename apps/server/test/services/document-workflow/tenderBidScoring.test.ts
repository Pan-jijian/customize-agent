/**
 * tenderBidScoring 单测：六维评标评分（资料完整性/方案针对性/合规性/可落地性/编制规范性/低雷同性）、
 * 模板化套用专项检测报告（套话三档/模糊应答词/重复句式/跨项目残留/重难点双达标）。
 * 本地语义模型 mock 为「6 字符前缀子串」语义（不加载 ONNX 模型）：正文复述锚点原型文本即判语义命中，
 * 结果确定可控；危大两步确认、应急预案八部分等确定性标尺走真实正则。
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/services/document-workflow/semanticSimilarity', () => ({
  SEMANTIC_COVERAGE_THRESHOLD: 0.6,
  buildSemanticSimilarity: async () => (left: string, right: string) => (left.includes(right.slice(0, 6)) ? 1 : 0),
  // 模糊应答语义 gate（semanticGate 统一入口）用共享 provider 嵌入：含模糊词根 [1,0]、含合法语境词 [0,1]、其余 [0,0]
  getLocalSemanticProvider: () => ({
    embedDocuments: async (texts: string[]) => texts.map(text => {
      const vague = /力争|基本|大致|原则上|大概|左右|尽可能|尽量/u.test(text);
      const legal = /对称|上游/u.test(text);
      return [vague && !legal ? 1 : 0, legal ? 1 : 0];
    }),
  }),
}));

import { buildTenderBidScores, buildTenderBidTemplatingReport, FORBIDDEN_EMPTY_PHRASES, FORBIDDEN_PROMPT_PHRASES } from '@/services/document-workflow/tenderBidScoring';
import type { DocumentDraftChapter, DocumentFactTrace, DocumentTemplate } from '@/services/document-workflow/types';

const draftChapter = (title: string, content: string): DocumentDraftChapter => ({ id: `d-${title}`, title, content, evidence: [], missingFacts: [] });

const trace = (overrides: Partial<DocumentFactTrace> = {}): DocumentFactTrace => ({ label: '总工期', value: '420日历天', sourceFile: '招标文件.docx', status: 'used', confidence: 1, ...overrides });

const template: DocumentTemplate = {
  id: 't1',
  name: '施工组织设计',
  description: '',
  category: '施工组织设计',
  outputTitle: '合肥某项目施工组织设计',
  chapters: [
    { id: 'c1', title: '工程概况', purpose: '', queries: [], requiredFacts: [] },
    { id: 'c2', title: '施工部署', purpose: '', queries: [], requiredFacts: [] },
  ],
};

/** 六模块 + 十三合规项 + 危大两步 + 应急预案八部分全覆盖正文 */
const FULL_MARKDOWN = [
  '# 工程概况',
  '',
  '## 施工部署',
  '',
  '本工程危险性较大的分部分项工程安全管理严格执行，并落实专项方案论证与验收程序。',
  '',
  '扬尘污染防治措施落实到位，建筑工人实名制管理到位，农民工工资专用账户与工资支付保障已建立，生产安全事故应急预案与应急演练已组织，绿色施工与四节一环保措施已实施。',
  '',
  '危险源辨识与风险识别评估完成后，编制专项施工方案并组织专家论证并履行审批程序，对作业人员进行安全技术交底，施工过程监测与监控量测同步开展，分部分项工程验收合格。',
  '',
  '现场采用三级配电系统，配置两级漏电保护装置，漏电保护器与接地保护齐全，实名制考勤与人员管理规范，农民工工资专用账户银行代发按月执行，应急预案编制与响应到位，绿色施工措施与评价达标。',
  '',
  '基坑工程开挖深度8m，属超危大范围，已组织专家论证。',
  '',
  '总则明确，应急组织机构与应急小组到位，风险分析完成，应急物资与通讯保障齐全，专项应急预案已编制，应急响应流程明确，后期处置与事故调查责任落实，应急演练按计划开展。',
  '',
  '总工期420日历天。',
].join('\n');

describe('禁用词库', () => {
  it('评分扣分词库不含语境敏感词（定期检查/系统性）', () => {
    expect(FORBIDDEN_EMPTY_PHRASES).not.toContain('定期检查');
    expect(FORBIDDEN_EMPTY_PHRASES).not.toContain('系统性');
    expect(FORBIDDEN_EMPTY_PHRASES).toContain('精心组织');
  });

  it('生成侧禁写词库 = 评分词库 + 语境敏感词', () => {
    expect(FORBIDDEN_PROMPT_PHRASES).toEqual([...FORBIDDEN_EMPTY_PHRASES, '定期检查', '系统性']);
  });
});

describe('buildTenderBidScores 资料完整性与合规性', () => {
  it('模板章节标题全部命中 + 六强制模块语义全覆盖 → completeness 100', async () => {
    const scores = await buildTenderBidScores({
      markdown: FULL_MARKDOWN,
      chapters: [],
      template,
      factTraces: [],
      issues: [],
    });
    expect(scores.completeness).toBe(100);
  });

  it('强制模块缺失 → completeness 按 0.55/0.45 加权扣分', async () => {
    const markdown = ['## 工程概况', '', '## 施工部署', '', '本工程危险性较大的分部分项工程安全管理严格执行，并落实专项方案论证与验收程序。'].join('\n');
    const scores = await buildTenderBidScores({
      markdown,
      chapters: [],
      template,
      factTraces: [],
      issues: [],
    });
    // chapterHitRate 1、moduleRate 1/6 → (0.55 + 1/6*0.45)*100 = 62.5 → 63
    expect(scores.completeness).toBe(63);
  });

  it('无模板无章节 → 章节齐全度满分兜底', async () => {
    const scores = await buildTenderBidScores({
      markdown: '普通正文段落，没有任何标题与模块语。',
      chapters: [],
      template: null,
      factTraces: [],
      issues: [],
    });
    // chapterHitRate 1（无模板章节兜底）、moduleRate 0 → 55
    expect(scores.completeness).toBe(55);
  });

  it('合规十三项 + 危大两步确认 + 应急预案八部分全覆盖 → compliance 100', async () => {
    const scores = await buildTenderBidScores({
      markdown: FULL_MARKDOWN,
      chapters: [],
      template: null,
      factTraces: [],
      issues: [],
    });
    expect(scores.compliance).toBe(100);
  });

  it('危大两步未完成 → 按 0.3/0.6 分级扣分', async () => {
    const markdown = ['基坑工程施工方案已编制。'].join('\n');
    const scores = await buildTenderBidScores({
      markdown,
      chapters: [],
      template: null,
      factTraces: [],
      issues: [],
    });
    // base 0、dangerous：类别命中无分级无参数 → 0.3 → (0 + 0.3*0.1 + 0)*100 = 3
    expect(scores.compliance).toBe(3);
  });
});

describe('buildTenderBidScores 方案针对性与可落地性', () => {
  it('可落位事实已用且跨章分布 → specificity 100', async () => {
    const chapters = [
      draftChapter('工程概况', '本工程总工期420日历天。'),
      draftChapter('施工部署', '按总工期420日历天组织流水施工。'),
    ];
    const scores = await buildTenderBidScores({
      markdown: '',
      chapters,
      template: null,
      factTraces: [trace()],
      issues: [],
    });
    expect(scores.specificity).toBe(100);
  });

  it('可落位事实未用 → usedRate 0 → specificity 45 分封底（分布率兜底）', async () => {
    const scores = await buildTenderBidScores({
      markdown: '',
      chapters: [draftChapter('工程概况', '无事实正文。')],
      template: null,
      factTraces: [trace({ status: 'unplaced' })],
      issues: [],
    });
    // usedTraces 空 → usedValues 空 → distribution 兜底 1 → (0*0.55 + 1*0.45)*100 = 45
    expect(scores.specificity).toBe(45);
  });

  it('指向性事实（见招标公告类）不进入落位评分池', async () => {
    const pointingTrace = trace({ label: '质量标准', value: '见招标公告前附表', status: 'unplaced' });
    const scores = await buildTenderBidScores({
      markdown: '',
      chapters: [draftChapter('工程概况', '正文无。')],
      template: null,
      factTraces: [pointingTrace],
      issues: [],
    });
    expect(scores.specificity).toBe(100); // 无 actionable 事实 → usedRate/distribution 兜底 1
  });

  it('五要素词面齐全块 → executability 42 分（1 块密度 1/6 标尺）', async () => {
    const markdown = '制定专项施工方案与管理制度，明确技术措施；施工工序流程与工艺步骤顺序已明确；由项目经理、技术负责人牵头，每周检查一次，经检查验收合格后整改销项闭环。';
    const scores = await buildTenderBidScores({
      markdown,
      chapters: [],
      template: null,
      factTraces: [],
      issues: [],
    });
    // blocks 1、completeBlocks 1、target max(6, ceil(len/1500)) = 6 → density 1/6、fiveElementRate 1
    // round((1/6*0.7 + 1*0.3)*100) = round(41.67) = 42
    expect(scores.executability).toBe(42);
  });

  it('无五要素块 → executability 0', async () => {
    const scores = await buildTenderBidScores({
      markdown: '普通段落没有岗位没有频次没有闭环。',
      chapters: [],
      template: null,
      factTraces: [],
      issues: [],
    });
    expect(scores.executability).toBe(0);
  });
});

describe('buildTenderBidScores 编制规范性与低雷同性', () => {
  it('目录类 error 与表格类 warning 按 8/3 扣分', async () => {
    const scores = await buildTenderBidScores({
      markdown: '',
      chapters: [],
      template: null,
      factTraces: [],
      issues: [
        { level: 'error', message: '目录层级缺失' },
        { level: 'warning', message: '表格表头不规范' },
      ],
    });
    expect(scores.normalization).toBe(89);
  });

  it('warning 扣分 30 分封顶', async () => {
    const issues = Array.from({ length: 12 }, (_, index) => ({ level: 'warning' as const, message: `表格编号错误${index}` }));
    const scores = await buildTenderBidScores({
      markdown: '',
      chapters: [],
      template: null,
      factTraces: [],
      issues,
    });
    expect(scores.normalization).toBe(70);
  });

  it('禁用词命中按词数 ×4 扣分', async () => {
    const scores = await buildTenderBidScores({
      markdown: '我单位精心组织施工。',
      chapters: [],
      template: null,
      factTraces: [],
      issues: [],
    });
    expect(scores.uniqueness).toBe(96);
  });

  it('重复句式率按比例 ×60 扣分', async () => {
    const repeated = '本工程主体结构施工采用分层浇筑的方式组织流水作业。';
    const scores = await buildTenderBidScores({
      markdown: [repeated, repeated].join('\n'),
      chapters: [],
      template: null,
      factTraces: [],
      issues: [],
    });
    // duplicateRate 0.5 → -30 → 70
    expect(scores.uniqueness).toBe(70);
  });

  it('干净正文 → uniqueness 100', async () => {
    const scores = await buildTenderBidScores({
      markdown: '主体结构采用盘扣式脚手架支撑体系，立杆间距900mm，验收合格后进入下道工序。',
      chapters: [],
      template: null,
      factTraces: [],
      issues: [],
    });
    expect(scores.uniqueness).toBe(100);
  });
});

describe('buildTenderBidTemplatingReport', () => {
  it('空正文 → 0 句、0 占比、light 等级', async () => {
    const report = await buildTenderBidTemplatingReport('');
    expect(report.totalSentences).toBe(0);
    expect(report.fillerRatio).toBe(0);
    expect(report.level).toBe('light');
    expect(report.vagueHitCount).toBe(0);
    expect(report.crossProjectResidue).toEqual([]);
  });

  it('套话语义原型命中 → 套话句计数与占比', async () => {
    const markdown = '我单位精心组织、科学管理，确保工程质量合格。';
    const report = await buildTenderBidTemplatingReport(markdown);
    expect(report.fillerSentences).toBe(1);
    expect(report.totalSentences).toBe(1);
    expect(report.fillerRatio).toBe(1);
    expect(report.level).toBe('heavy');
  });

  it('模糊应答词命中计入 vagueHitCount 与 vaguePhrases', async () => {
    const report = await buildTenderBidTemplatingReport('本工程力争在合同工期内完成全部施工内容。');
    expect(report.vagueHitCount).toBe(1);
    expect(report.vaguePhrases).toContain('力争');
  });

  it('重复句式率统计（去标点后同句去重）', async () => {
    const repeated = '本工程主体结构施工采用分层浇筑的方式组织流水作业。';
    const report = await buildTenderBidTemplatingReport([repeated, repeated].join('\n'));
    expect(report.duplicateSentenceRate).toBe(0.5);
  });

  it('跨项目内容残留命中', async () => {
    const report = await buildTenderBidTemplatingReport('本工程管理要求参照其他项目执行同一标准体系。');
    expect(report.crossProjectResidue.length).toBeGreaterThan(0);
  });

  it('重难点条目未双达标 → 占比 0 → heavyTemplated 并升级 heavy', async () => {
    const markdown = ['## 重点难点分析', '', '基坑工程难点：该条目仅复述现象未给出归因分析，控制要求按50mm执行。'].join('\n');
    const report = await buildTenderBidTemplatingReport(markdown);
    expect(report.difficultyCountermeasures).toBe(1);
    expect(report.difficultyBothCount).toBe(0);
    expect(report.difficultyCountermeasureRatio).toBe(0);
    expect(report.difficultyHeavyTemplated).toBe(true);
    expect(report.level).toBe('heavy');
  });

  it('重难点条目归因+量化双达标 → 不判重度模板化', async () => {
    const markdown = ['## 重点难点分析', '', '基坑工程难点：分析该工程难点的成因与风险来源，控制目标按50mm执行。'].join('\n');
    const report = await buildTenderBidTemplatingReport(markdown);
    expect(report.difficultyBothCount).toBe(1);
    expect(report.difficultyCountermeasureRatio).toBe(1);
    expect(report.difficultyHeavyTemplated).toBe(false);
  });

  it('套话占比 20% → medium 档（边界含）', async () => {
    const sentences = ['普通正文句子内容甲乙丙丁戊己庚辛壬癸。', '普通正文句子内容子丑寅卯辰巳午未申酉。', '普通正文句子内容一二三四五六七八九十。', '普通正文句子内容上中下前后内外侧。', '我单位精心组织、科学管理，确保工程质量合格。'];
    const report = await buildTenderBidTemplatingReport(sentences.join('\n'));
    expect(report.fillerRatio).toBe(0.2);
    expect(report.level).toBe('medium');
  });
});
