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

import { buildTenderBidScores, buildTenderBidTemplatingReport, duplicateSentenceStats, FORBIDDEN_EMPTY_PHRASES, FORBIDDEN_PROMPT_PHRASES, splitScoringBlocks } from '@/services/document-workflow/tenderBidScoring';
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

describe('splitScoringBlocks 评分判定单元（C0-1 内容级判定 + 4.55.29 实质节标题承接）', () => {
  it('空壳标题（无实质正文）不构成判定单元（标题党封堵）', () => {
    // C0 基线：r28l 仅标题块命中 14/19、6 强制模块全部靠标题单独命中；
    // 「#### 9.1.2 扬尘污染防治措施」类空壳标题不得单独命中模块查询
    const blocks = splitScoringBlocks(['#### 9.1.2 扬尘污染防治措施', '#### 9.1.3 建筑工人实名制管理'].join('\n'));
    expect(blocks).toEqual([]);
  });

  it('单元=实质节标题 + 正文窗口（4.55.29：标题承接不得被长正文均值池化稀释）', () => {
    const blocks = splitScoringBlocks(['#### 7.1.1 扬尘污染防治措施', '现场设置围挡并定期洒水降尘，出入口配置车辆冲洗设施。'].join('\n'));
    expect(blocks).toEqual(['扬尘污染防治措施', '现场设置围挡并定期洒水降尘，出入口配置车辆冲洗设施。']);
  });

  it('正文不足 12 字（口水句）不构成实质正文 → 无单元（标题一并不产出）', () => {
    const blocks = splitScoringBlocks(['#### 7.1.4 生产安全事故应急预案与应急演练', '', '正文段落。'].join('\n'));
    expect(blocks).toEqual([]);
  });

  it('目录聚簇行剔除（多章节/编号条目堆叠且无句读）', () => {
    const tocline = '第一章 工程概况 1.1 编制说明与工程概况 1.2 编制依据 1.3 工程范围';
    const markdown = ['## 施工部署', tocline, '按施工段组织流水作业，主体结构与装饰装修分阶段穿插施工。'].join('\n');
    const blocks = splitScoringBlocks(markdown);
    expect(blocks).toEqual(['施工部署', '按施工段组织流水作业，主体结构与装饰装修分阶段穿插施工。']);
    expect(blocks.join('\n')).not.toContain('第一章 工程概况');
  });

  it('R13 回归：6 小节单换行串联 → 每小节 1 标题单元 + 1 正文单元（超窗才切分）', () => {
    const sections = Array.from({ length: 6 }, (_, i) => [
      `#### 7.1.${i + 1} 小节标题第${i + 1}部分内容说明`,
      `本小节正文内容用于验证切分粒度，段落编号 ${i + 1}。`,
    ].join('\n'));
    const blocks = splitScoringBlocks(sections.join('\n'));
    expect(blocks).toHaveLength(12);
    expect(blocks.filter(block => block.startsWith('本小节正文内容'))).toHaveLength(6);
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

  it('4.19.7 回归：category=structure 污染消息（评分项响应）不计编制规范性', async () => {
    // classifyValidationIssue 兜底把合规类 error 标成 structure，消息无结构特征时必须剔除
    const scores = await buildTenderBidScores({
      markdown: '',
      chapters: [],
      template: null,
      factTraces: [],
      issues: [
        { level: 'error', category: 'structure', message: '评分项要求未响应：前附表响应条款在正文中零命中' },
        { level: 'error', category: 'structure', message: '属地创优目标缺失：正文未提及省市级优质工程' },
        { level: 'error', category: 'structure', message: '工伤保险表述缺失：正文未提及工伤保险缴纳' },
      ],
    });
    expect(scores.normalization).toBe(100);
  });

  it('4.19.7 回归：category=structure 结构类消息（小节只有标题）仍计分', async () => {
    const scores = await buildTenderBidScores({
      markdown: '',
      chapters: [],
      template: null,
      factTraces: [],
      issues: [
        { level: 'error', category: 'structure', message: '拟投入的主要物资计划 小节只有标题或表格无正文：成品保护措施' },
        { level: 'error', category: 'structure', message: '主要施工方法 缺少规划小节：周边环境保护' },
      ],
    });
    expect(scores.normalization).toBe(84);
  });

  it('4.19.7 回归：category=table/format 直接计分', async () => {
    const scores = await buildTenderBidScores({
      markdown: '',
      chapters: [],
      template: null,
      factTraces: [],
      issues: [
        { level: 'warning', category: 'table', message: '同主题表格重复堆叠：1 组相同表头出现 3 次及以上' },
        { level: 'warning', category: 'format', message: '正式正文仍包含后台内部术语“工作包”' },
      ],
    });
    expect(scores.normalization).toBe(94);
  });

  it('4.19.7 回归：无 category 事实落位消息（含「图纸目录」）不计编制规范性', async () => {
    const scores = await buildTenderBidScores({
      markdown: '',
      chapters: [],
      template: null,
      factTraces: [],
      issues: [
        { level: 'warning', message: '已确认事实未在正文中落位：招标人=R3C1建设项目招标图纸目录：' },
      ],
    });
    expect(scores.normalization).toBe(100);
  });

  it('C8-U 禁用词按语义确认短语种类 ×4 扣分（词面命中但语境正常不计）', async () => {
    const clean = [
      '基坑开挖深度8m采用排桩加内支撑围护体系。',
      '混凝土浇筑完成后12小时内覆盖养护并测温记录。',
      '脚手架立杆纵距1.5m横距0.9m步距1.8m搭设。',
      '塔式起重机安装后经检测机构验收合格投入使用。',
      '钢筋进场按批次见证取样送检力学性能合格。',
      '防水卷材搭接宽度不小于100mm热熔法施工。',
      '临时用电采用三级配电两级漏电保护装置。',
      '模板拆除时混凝土强度达到设计值75%以上。',
      '基坑监测数据每日汇总分析并报监理单位备案。',
    ];
    const scores = await buildTenderBidScores({
      // 口号句去除模糊应答词根（基本/力争等）以隔离禁用词分量——vague 分量单独由其他用例覆盖
      markdown: ['本项目按精心组织、科学管理原则推进各项施工工作。', ...clean].join('\n'),
      chapters: [],
      template: null,
      factTraces: [],
      issues: [],
    });
    // 口号句判 filler（套话占比 1/10 未超 10% 线）→ 精心组织+科学管理 2 种 ×4 = 8 分
    expect(scores.uniqueness).toBe(92);
  });

  it("C8-U 防误伤：规范引用/量化措施语境短语词面命中不扣分（s28m' 实机句复刻）", async () => {
    const markdown = [
      '工程质量标准必须符合现行国家有关工程施工质量验收规范和标准的要求并精心组织施工。',
      '基坑周边每2小时巡视一次，发现渗漏立即封堵并及时处理隐患部位。',
    ].join('\n');
    const scores = await buildTenderBidScores({ markdown, chapters: [], template: null, factTraces: [], issues: [] });
    expect(scores.uniqueness).toBe(100);
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

  it('C0-4 长度归一：长文档重复句按每万字 1 条摊薄，超预算每条扣 1 分', async () => {
    const base = Array.from({ length: 2000 }, (_, i) => `第${i + 1}段控制要点采用盘扣式脚手架支撑体系，立杆间距900mm，验收合格后进入下道工序。`);
    const markdown = [...base, ...base.slice(0, 17)].join('\n');
    // 重复实例 17，预算 max(10, ceil(≈7.4 万/10000)=8) = 10 → 超 7 → 扣 7（旧比例口径仅扣 0.5）
    expect(duplicateSentenceStats(markdown).duplicateInstances).toBe(17);
    const scores = await buildTenderBidScores({ markdown, chapters: [], template: null, factTraces: [], issues: [] });
    expect(scores.uniqueness).toBe(93);
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

  it('归因半项退出判定：量化达标即不判重度（归因语义经实测无分辨力）', async () => {
    // 实测依据（巢湖终稿，真实 bge 余弦）：同一查询下「字面写着成因/风险源于的段落」14 段得 0.530~0.565、
    // 「不含成因的段落」9 段得 0.53~0.57——两类同区间，阈值 0.6 下几乎全不过；而纯列名的短表头行反得 0.643 通过。
    // 截断归一化（120/200/300 字）亦无法分离两类。该度量实际测「长度+主题词」而非「有无归因」，
    // 且它同时污染模板化等级与修复轮收敛判据（假重度 → 修复轮空转多轮）。
    // 现口径：量化目标（QUANTIFIED_TARGET_RE 结构判定）为唯一判据，归因半项降为观测字段。
    const markdown = ['## 重点难点分析', '', '基坑工程难点：该条目仅复述现象未给出归因分析，控制要求按50mm执行。'].join('\n');
    const report = await buildTenderBidTemplatingReport(markdown);
    expect(report.difficultyCountermeasures).toBe(1);
    expect(report.difficultyBothCount).toBe(0);
    expect(report.difficultyCountermeasureRatio).toBe(0);
    // 量化目标存在（50mm）→ 量化达标数 1，占比 100% → 不判重度
    expect(report.difficultyQuantifiedCount).toBe(1);
    expect(report.difficultyHeavyTemplated).toBe(false);
  });

  it('量化目标也缺失 → 判重度（可测半项确实在起作用）', async () => {
    const markdown = ['## 重点难点分析', '', '基坑工程难点：该条目仅复述现象未给出归因分析，也未给出任何控制要求。'].join('\n');
    const report = await buildTenderBidTemplatingReport(markdown);
    expect(report.difficultyQuantifiedCount).toBe(0);
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
