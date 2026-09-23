/**
 * R9 表达质量族单测：R9-a 短语级套话（判定粒度下沉）/ R9-b 条款体复述 / R9-d 表格内容泄漏成散文。
 *
 * 用例**逐字取自实测文档** doc-1790168542563-ea526b1b（巢湖施工组织设计，68113 字）：
 * - 行 90  短语级套话（引号显式括起的「精心组织施工」嵌在实质句中，整句未被既有三层拦住）
 * - 行 623 条款体复述（202 字来自招标文件条款、零本项目信息）
 * - 行 557 表格内容泄漏（编制依据表条目倒成散文段，末尾规范号年份被切掉）
 * 每个族都配「防过度」反向断言：正常技术句/承诺句/结构载体一律不得判。
 *
 * 语义通道 mock（理由同 tenderBidChecks.test.ts）：单测不加载本地 bge 模型，
 * 用可控余弦值验证「阈值单源」与「整句判定语义不变」；确定性通道（零信息短语 /
 * 条款复述 / 表格泄漏）不依赖语义，直接用真实判据断言。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLAUSE_OBLIGATION_RE,
  CLAUSE_RECITATION_SEMANTIC_PROTOTYPES,
  FILLER_PHRASE_MIN_CHARS,
  FILLER_SEMANTIC_QUERIES,
  FILLER_SENTENCE_THRESHOLD,
  FORBIDDEN_EMPTY_PHRASES,
  TABLE_LEAK_MIN_BOOK_CITATIONS,
  TABLE_LEAK_RESIDUAL_RATIO_LIMIT,
  isClauseRecitationSentence,
  isTableLeakParagraph,
  judgeClauseRecitations,
  judgeFillerPhrases,
  judgeFillerSentences,
  scanClauseRecitationSentences,
  scanFillerPhrases,
  scanTableLeakParagraphs,
  splitFillerPhrases,
} from '@/services/document-workflow/tenderBidChecks';

vi.mock('@/services/document-workflow/semanticSimilarity', () => ({
  buildSemanticSimilarity: vi.fn(),
  SEMANTIC_COVERAGE_THRESHOLD: 0.6,
  getLocalSemanticProvider: () => ({
    embedDocuments: async (texts: string[]) => texts.map(() => [0, 0]),
  }),
}));

import { buildSemanticSimilarity } from '@/services/document-workflow/semanticSimilarity';

const buildSimilarityMock = vi.mocked(buildSemanticSimilarity);

type SimilarityFn = (left: string, right: string) => number;

function mockSimilarity(score: number): void {
  buildSimilarityMock.mockResolvedValue((() => score) as SimilarityFn);
}

/** 实测行 90（逐字）：短语级套话嵌在实质句中——整句主题是“垫层/级配碎石验收” */
const MEASURED_LINE90_SENTENCE =
  '室外附属工程含沥青道路、人行道、侧石、围墙、绿化及雨污水管网，塘渣石垫层、水泥稳定碎（砾）石各分项施工质量验收统一以“精心组织施工”为总控目标，检验批验收逐级对照核验';

/** 实测行 623 第 1 句（逐字）：条款体复述——义务词 + 零本项目信息 */
const MEASURED_LINE623_CLAUSE_SENTENCE =
  '我方在任何时候都应采取各种合理的预防措施，防止其员工发生任何违法、违禁、暴力或妨碍治安的行为，保持项目的安定，并保护好现场和周围的人员和财产安全';

/** 实测行 557（逐字）：编制依据表条目倒成散文段（仅书名号枚举、无主谓） */
const MEASURED_LINE557_LEAK_PARAGRAPH =
  '《建筑桩基技术规范》（JGJ 94-2008）、《建筑机电工程抗震设计规范》（GB 50981-2014）、《建筑给水排水及采暖工程施工质量验收规范》（GB50242-2002）、《混凝土结构工程施工质量验收规范》（GB 50204-2015）、《给水排水构筑物工程施工及验收规范》（GB 50141-2008）、《建筑工程施工现场消防安全技术规范》（GB50720-2011）、《建筑工程冬期施工规程》（JGJ/T 104）';

describe('R9-a 短语级套话：子句切分口径（单源下沉，不改整句语义）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('引号显式短语优先取出：得到正确改写锚点「精心组织施工」，而非带框架词的残段', () => {
    expect(splitFillerPhrases('统一以“精心组织施工”为总控目标')).toEqual(['精心组织施工']);
  });

  it('子句按顿号/逗号切分，且不产出残段（框架词“统一以/为总控目标”均短于下限被滤掉）', () => {
    const phrases = splitFillerPhrases(MEASURED_LINE90_SENTENCE);
    expect(phrases).toContain('精心组织施工');
    expect(phrases.every(phrase => phrase.length >= FILLER_PHRASE_MIN_CHARS)).toBe(true);
    // 不含被切碎的半截框架词（否则修复端拿到改不动的锚点）
    expect(phrases.some(phrase => phrase.startsWith('统一以'))).toBe(false);
  });

  it('子句长度下限 6 字：4 字合法短短语（满足要求/符合规范）不产出——“防误伤”的粒度边界', () => {
    expect(FILLER_PHRASE_MIN_CHARS).toBe(6);
    expect(splitFillerPhrases('满足要求，符合规范')).toEqual([]);
    // 恰好 6 字（实测缺陷短语的长度）在下限之内
    expect(splitFillerPhrases('确保工程质量')).toEqual(['确保工程质量']);
  });

  it('整句判定语义不变：短语层命中不把整句判为套话（删除判定仍归整句通道）', async () => {
    mockSimilarity(0.1);
    const judgements = await judgeFillerSentences([MEASURED_LINE90_SENTENCE]);
    expect(judgements[0]).toMatchObject({ semantic: false, filler: false });
  });
});

describe('R9-a 短语级套话：命中产出与判据单源', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('实测行 90：命中「精心组织施工」并回带所属整句（改写锚点 = 短语，不删整句）', async () => {
    mockSimilarity(0.1);
    const hits = await judgeFillerPhrases([MEASURED_LINE90_SENTENCE]);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      phrase: '精心组织施工',
      sentence: MEASURED_LINE90_SENTENCE,
      channel: 'zero-info',
    });
    // 短语确实短于整句：证明是“定点改写该短语”而非“整句即套话”
    expect(hits[0].phrase.length).toBeLessThan(hits[0].sentence.length);
  });

  it('阈值单源：语义通道复用 FILLER_SENTENCE_THRESHOLD（0.80 命中 / 0.79 不命中）', async () => {
    mockSimilarity(FILLER_SENTENCE_THRESHOLD);
    const atThreshold = await judgeFillerPhrases(['本工程实行标准化作业管理']);
    expect(atThreshold).toHaveLength(1);
    expect(atThreshold[0].channel).toBe('semantic');
    expect(atThreshold[0].similarity).toBe(FILLER_SENTENCE_THRESHOLD);
    mockSimilarity(FILLER_SENTENCE_THRESHOLD - 0.01);
    await expect(judgeFillerPhrases(['本工程实行标准化作业管理'])).resolves.toEqual([]);
  });

  it('原型库单源：短语级扫描向嵌入器传入的正是 FILLER_SEMANTIC_QUERIES（不另造原型库）', async () => {
    mockSimilarity(0.1);
    await judgeFillerPhrases([MEASURED_LINE90_SENTENCE]);
    expect(buildSimilarityMock).toHaveBeenCalledTimes(1);
    const [, queries] = buildSimilarityMock.mock.calls[0];
    expect(queries).toEqual([...FILLER_SEMANTIC_QUERIES]);
  });

  it('零信息通道词表单源：命中短语必含 FORBIDDEN_EMPTY_PHRASES 词（不另造词表）', async () => {
    mockSimilarity(0.1);
    const hits = await judgeFillerPhrases([MEASURED_LINE90_SENTENCE]);
    const zeroInfo = hits.filter(hit => hit.channel === 'zero-info');
    expect(zeroInfo.length).toBeGreaterThan(0);
    expect(zeroInfo.every(hit => FORBIDDEN_EMPTY_PHRASES.some(word => hit.phrase.includes(word)))).toBe(true);
  });

  it('markdown 级扫描：句池单源（标题行/表格行不进池），短语命中带原句', async () => {
    mockSimilarity(0.1);
    const markdown = [
      '## 精心组织施工管理措施',
      '| 精心组织施工 | 说明 |',
      '塘渣石垫层施工质量验收统一以“精心组织施工”为总控目标。',
    ].join('\n');
    const hits = await scanFillerPhrases(markdown);
    expect(hits.map(hit => hit.phrase)).toEqual(['精心组织施工']);
  });
});

describe('R9-a 防过度：正常技术句/规则句不得判短语级套话', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('程度修饰保护：规则句“按最高标准执行”因含“高标准”子串被词面召回 → 不计', async () => {
    mockSimilarity(0.1);
    await expect(judgeFillerPhrases(['标准之间要求不一致时按最高标准执行'])).resolves.toEqual([]);
  });

  it('技术措施句（含专业做法）不判：混凝土浇筑养护句', async () => {
    mockSimilarity(0.1);
    await expect(judgeFillerPhrases(['混凝土浇筑完成后应及时覆盖并浇水养护'])).resolves.toEqual([]);
  });

  it('“相应”类合法子串句不判：含“精心组织”词面但不构成套话短语', async () => {
    mockSimilarity(0.1);
    const sentence = '室外埋地敷设的电力线缆、控制线缆和智能化线缆采用护套线、电缆或光缆，并采取相应的保护措施';
    await expect(judgeFillerPhrases([sentence])).resolves.toEqual([]);
  });

  it('带量化信息的措施短语不判：数字/频次/岗位锚点使零信息判据失效', async () => {
    mockSimilarity(0.1);
    await expect(judgeFillerPhrases(['基坑周边每2小时巡视一次', '由项目经理精心组织'])).resolves.toEqual([]);
  });

  it('纯口号整句仍由整句通道承接（短语层不重复计分）', async () => {
    mockSimilarity(0.9);
    const hits = await judgeFillerPhrases(['精心组织施工力量']);
    expect(hits.map(hit => hit.channel)).toEqual(['semantic']);
  });
});

describe('R9-b 条款体复述：正判（实测句式 + 零项目信息义务句）', () => {
  it('实测行 623 第 1 句判“条款复述”', () => {
    expect(isClauseRecitationSentence(MEASURED_LINE623_CLAUSE_SENTENCE)).toBe(true);
  });

  it('规则句式正样本：义务词 ∧ 无本项目实体 ∧ 无承诺/自指/岗位/手续/做法', () => {
    expect(isClauseRecitationSentence('我方在工程实施过程中用工行为，必须严格执行国家及地方政府的有关规定')).toBe(true);
    expect(isClauseRecitationSentence('必须严格执行国家及地方政府的有关规定')).toBe(true);
  });

  it('防过度优先于召回：“承担…责任/义务”类承诺句放行（漏判代价低于误删承诺实质）', () => {
    // 该句与原型库中的条款体原型同形，但确定性判据按“可核查承诺”闸放行——
    // 两个通道本就不同源：原型库是观测/校准通道，开火判据是确定性闸（见 R9-b 原型库用例）。
    expect(isClauseRecitationSentence('我方应遵守招标文件的规定并承担相应责任')).toBe(false);
  });

  it('markdown 级扫描命中实测条款句（句池单源：按 。；; 切句）', () => {
    const markdown = [
      '## 治安保卫管理',
      `我方在任何时候都应采取各种合理的预防措施，防止其员工发生任何违法、违禁、暴力或妨碍治安的行为，保持项目的安定，并保护好现场和周围的人员和财产安全；现场配备专职安全生产管理人员，专职负责所有员工的安全和治安保卫工作及预防事故的发生。`,
    ].join('\n');
    const hits = scanClauseRecitationSentences(markdown);
    expect(hits).toContain(MEASURED_LINE623_CLAUSE_SENTENCE);
  });
});

describe('R9-b 防过度：实体/承诺/锚点任一命中即不判复述', () => {
  it('可核查承诺（规格边界样例）：承担安全保卫费用 → 不判', () => {
    expect(isClauseRecitationSentence('我方承担整个工程的安全保卫等的费用')).toBe(false);
  });

  it('含本项目单体的技术句 → 不判：本工程 2#门卫、3#门卫为框架结构', () => {
    expect(isClauseRecitationSentence('本工程2#门卫、3#门卫为框架结构，抗震设防烈度7度')).toBe(false);
  });

  it('含量化参数（数字+单位）的进度句 → 不判', () => {
    expect(isClauseRecitationSentence('承包人必须按批准的施工总进度计划组织施工，每周五17时前报送周进度报表')).toBe(false);
  });

  it('材料牌号（C30）属量化参数 → 不判', () => {
    expect(isClauseRecitationSentence('给水排水构筑物底板砼强度等级应采用C30')).toBe(false);
  });

  it('岗位锚点（项目经理/安全员）承载项目组织机构 → 不判', () => {
    expect(isClauseRecitationSentence('项目部编制生产安全事故应急救援预案，成立应急领导小组，项目经理任组长，安全员负责日常应急管理')).toBe(false);
  });

  it('手续锚点（登记领证/核验）属可核查做法 → 不判', () => {
    expect(isClauseRecitationSentence('外来人员进入现场须登记领证，由门卫值守人员核验后放行')).toBe(false);
  });

  it('专业做法锚点（夯实/浇筑/养护）的技术句 → 不判', () => {
    expect(isClauseRecitationSentence('填土夯实应夯夯相连，不得漏夯')).toBe(false);
    expect(isClauseRecitationSentence('混凝土浇筑完成后应及时覆盖并浇水养护')).toBe(false);
  });

  it('项目自指（本设计/本工程）含项目信息 → 不判', () => {
    expect(isClauseRecitationSentence('本设计中未考虑冬季、雨季的施工措施，施工单位应根据有关施工验收规范采取相应措施')).toBe(false);
  });

  it('义务词边界：“相应/应急/应用”类合法子串不构成义务表述 → 不判', () => {
    expect(isClauseRecitationSentence('室外埋地敷设的电力线缆、控制线缆和智能化线缆采用护套线、电缆或光缆，并采取相应的保护措施')).toBe(false);
    expect(isClauseRecitationSentence('应急物资按现场消防与卫生设施布置配置，包括急救箱、灭火器、应急照明、担架等')).toBe(false);
    expect(CLAUSE_OBLIGATION_RE.test('并采取相应的保护措施')).toBe(false);
    expect(CLAUSE_OBLIGATION_RE.test('响应时间不超过5min')).toBe(false);
    // 义务词边界修正不得伤及真正的义务词
    expect(CLAUSE_OBLIGATION_RE.test('我方应负责施工现场的安全管理')).toBe(true);
    expect(CLAUSE_OBLIGATION_RE.test('承包人必须服从监理人的管理')).toBe(true);
  });

  it('过短句（<12 字）不判：判据只针对成句的条款复述', () => {
    expect(isClauseRecitationSentence('应按规范执行')).toBe(false);
  });
});

describe('R9-b 条款体原型库：与口号体互补（观测通道，非开火判据）', () => {
  it('规格举例的三条条款体原型在库内', () => {
    expect(CLAUSE_RECITATION_SEMANTIC_PROTOTYPES).toContain('我方应按照招标文件及合同约定履行义务');
    expect(CLAUSE_RECITATION_SEMANTIC_PROTOTYPES).toContain('承包人必须服从发包人及监理人的管理');
    expect(CLAUSE_RECITATION_SEMANTIC_PROTOTYPES).toContain('应按国家现行规范标准执行');
  });

  it('互补性：条款体原型与口号体原型无一条重叠（覆盖不同语体）', () => {
    for (const prototype of CLAUSE_RECITATION_SEMANTIC_PROTOTYPES) {
      expect(FILLER_SEMANTIC_QUERIES as readonly string[]).not.toContain(prototype);
    }
  });

  it('语义相似度不作为开火判据：余弦 0.99 也不改变确定性判定结果', async () => {
    buildSimilarityMock.mockResolvedValue((() => 0.99) as SimilarityFn);
    const judgements = await judgeClauseRecitations([
      MEASURED_LINE623_CLAUSE_SENTENCE,
      '我方承担整个工程的安全保卫等的费用',
    ]);
    expect(judgements[0]).toMatchObject({ clauseRecitation: true, clauseSimilarity: 0.99 });
    expect(judgements[1]).toMatchObject({ clauseRecitation: false, clauseSimilarity: 0.99 });
  });
});

describe('R9-d 表格内容泄漏成散文：书名号枚举段判定', () => {
  it('实测行 557（编制依据表倒成散文段）判“表格内容泄漏”', () => {
    expect(isTableLeakParagraph(MEASURED_LINE557_LEAK_PARAGRAPH)).toBe(true);
  });

  it('扫描端命中实测段原文', () => {
    const hits = scanTableLeakParagraphs(MEASURED_LINE557_LEAK_PARAGRAPH);
    expect(hits).toEqual([MEASURED_LINE557_LEAK_PARAGRAPH]);
  });

  it('阈值自定值锁定：≥3 处书名号 + 非书名号残留占比 ≤0.35 + 残留无谓语', () => {
    expect(TABLE_LEAK_MIN_BOOK_CITATIONS).toBe(3);
    expect(TABLE_LEAK_RESIDUAL_RATIO_LIMIT).toBe(0.35);
    // 少于 3 处书名号 → 不判（不把正常单条引用当泄漏）
    expect(isTableLeakParagraph('依据《建筑桩基技术规范》（JGJ 94-2008）执行，低应变检测数量不少于总桩数的20%。')).toBe(false);
  });

  it('结构载体先剔除：表格行/列表项/标题行即使全是书名号枚举也不判', () => {
    const markdown = [
      '| 依据名称 | 编号 |',
      '| --- | --- |',
      `| 《建筑桩基技术规范》 | JGJ 94-2008 |`,
      '',
      '- 《建筑桩基技术规范》',
      '- 《建筑机电工程抗震设计规范》',
      '- 《建筑给水排水及采暖工程施工质量验收规范》',
    ].join('\n');
    expect(scanTableLeakParagraphs(markdown)).toEqual([]);
  });
});

describe('R9-d 防过度：含主谓的合法依据引用段不得判泄漏', () => {
  it('实测行 610 逐字（桩基检测依据引用 + 主谓）→ 不判', () => {
    const legit =
      '桩基检测按《建筑桩基检测技术规范》（JGJ 106-2014）及《建筑桩基技术规范》（JGJ 94-2008）执行，低应变检测桩身质量不少于总桩数的20%，且每只承台保证检测一根；单桩竖向承载力采用静荷载试验检测';
    expect(isTableLeakParagraph(legit)).toBe(false);
  });

  it('三处书名号但带谓语（执行/按…确定）→ 不判（“无主谓”是泄漏的判据本体）', () => {
    const legit =
      '施工及验收执行《混凝土结构工程施工质量验收规范》（GB 50204-2015）、《建筑地面工程施工质量验收规范》（GB 50209-2010）、《建筑装饰装修工程质量验收标准》（GB 50210-2018）的规定，检验批划分按楼层与施工段确定';
    expect(isTableLeakParagraph(legit)).toBe(false);
  });

  it('残留占比闸：书名号枚举段若补齐主谓（残留升高）→ 不判', () => {
    const withPredicate = `${MEASURED_LINE557_LEAK_PARAGRAPH}，以上标准为本工程施工及质量验收的编制依据，项目部按现行有效版本执行并动态更新。`;
    expect(isTableLeakParagraph(withPredicate)).toBe(false);
  });
});
