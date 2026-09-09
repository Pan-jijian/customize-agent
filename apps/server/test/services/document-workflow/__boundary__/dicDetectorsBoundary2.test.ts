/**
 * 检测器族边界矩阵（P1 第 8 批）
 * 覆盖：F 商务条款入正文检测（强词/税率/变体语义 gate）；G 跨章语义重复检测与 strip；
 * H 工程概况一览表套话填充；I 6.1 施工部署块质量保障补全。
 * 原则：每条用例独立断言意义；真实实现行为一律锁定（契约先行），不改实现迎合用例；
 * 语义类检测注入模拟嵌入器（正例词/负例词双维向量），不依赖本地 bge。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyNumericConsistencyDeterministicFixes, commercialDataInBodyIssues,
  crossChapterSemanticDuplicateIssues, fixPlaceholderTableCells,
  fixQualityAssuranceCoverage, stripCrossChapterSemanticDuplicateParagraphs,
} from '@/services/document-workflow/documentIntegrityChecks';
import { buildSemanticSimilarity } from '@/services/document-workflow/semanticSimilarity';
import type { DocumentDraftChapter } from '@/services/document-workflow/types';

vi.mock('@/services/document-workflow/semanticSimilarity', () => ({ buildSemanticSimilarity: vi.fn(), SEMANTIC_COVERAGE_THRESHOLD: 0.6 }));

/** 跨章语义重复模拟器：共享主题词「防水」即 0.9（≥0.82 命中） */
const DUP_THEME_WORD = '防水';
const DUP_SIM = async (_leftTexts: string[], _rightTexts: string[]) => (left: string, right: string): number => {
  if (left === right) return 1;
  return left.includes(DUP_THEME_WORD) && right.includes(DUP_THEME_WORD) ? 0.9 : 0.1;
};

beforeEach(() => {
  vi.mocked(buildSemanticSimilarity).mockImplementation(DUP_SIM);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** 构造完整 DocumentDraftChapter（补齐非关键字段） */
const chapterOf = (id: string, title: string, content: string): DocumentDraftChapter =>
  ({ id, title, content, evidence: [], missingFacts: [] });

// ── F. 商务条款数据入正文检测（commercialDataInBodyIssues）──
// 语义 gate 注入模拟嵌入器：正例词（报价/清单）与负例词（估算/限价/控制价/约束）双维向量，
// 与 COMMERCIAL_SEMANTIC_PROTOTYPES / COMMERCIAL_LEGAL_PROTOTYPES 原型词面同源。
const COMMERCIAL_POS = ['报价', '清单'] as const;
const COMMERCIAL_NEG = ['估算', '限价', '控制价', '约束'] as const;
const COMMERCIAL_EMBED = async (texts: string[]): Promise<number[][]> => texts.map(text => [
  COMMERCIAL_POS.some(word => text.includes(word)) ? 1 : 0,
  COMMERCIAL_NEG.some(word => text.includes(word)) ? 1 : 0,
]);
const commercialIssues = (markdown: string) => commercialDataInBodyIssues(markdown, COMMERCIAL_EMBED);

describe('F1 commercialDataInBodyIssues 强词直报', () => {
  const STRONG_WORDS = ['暂列金额', '暂估价', '报价明细', '综合单价', '清单合价', '预留金', '投标报价', '异常低价', '评标基准价'];
  it('F1 暂列金额入正文 → 报', async () => {
    const issues = await commercialIssues('本项目暂列金额为60万元。');
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].message).toContain('暂列金额');
    expect(issues[0].level).toBe('error');
    expect(issues[0].severity).toBe('blocker');
    expect(issues[0].category).toBe('style');
  });
  it.each(STRONG_WORDS)('F1 强词 %s 直报', async (word) => {
    const issues = await commercialIssues(`正文表述${word}相关内容。`);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].message).toContain(word);
  });
  it('F1 无商务内容 → 不报', async () => {
    expect(await commercialIssues('本项目施工组织设计编制依据充分。')).toEqual([]);
  });
});

describe('F2 commercialDataInBodyIssues 税率数字式', () => {
  it('F2 税率+数字 → 报税率/增值税', async () => {
    const issues = await commercialIssues('本项目增值税税率为9%。');
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].message).toContain('税率/增值税');
  });
  it('F2 增值税+近距数字 → 报', async () => {
    const issues = await commercialIssues('增值税按照9%执行。');
    expect(issues[0].message).toContain('税率/增值税');
  });
  it('F2 税率无数字 → 不报', async () => {
    expect(await commercialIssues('税率依据国家规定执行。')).toEqual([]);
  });
  it('F2 税率数字超12字窗口 → 不报', async () => {
    const padding = '字'.repeat(13);
    expect(await commercialIssues(`税率${padding}9%。`)).toEqual([]);
  });
  it('F2 税率+强词混合 → 双词同报', async () => {
    const issues = await commercialIssues('增值税税率为9%，暂列金额为60万元。');
    expect(issues[0].message).toContain('税率/增值税');
    expect(issues[0].message).toContain('暂列金额');
  });
});

describe('F3 commercialDataInBodyIssues 结构豁免', () => {
  it('F3 标题行豁免', async () => {
    expect(await commercialIssues('## 暂列金额使用说明')).toEqual([]);
  });
  it('F3 表格行豁免', async () => {
    expect(await commercialIssues('| 暂列金额 | 60万元 |')).toEqual([]);
  });
  it('F3 表格行内含税率豁免', async () => {
    expect(await commercialIssues('| 增值税税率 | 9% |')).toEqual([]);
  });
});

describe('F4 commercialDataInBodyIssues 允许事实负例保护', () => {
  it('F4 合同估算价句 → 不报', async () => {
    expect(await commercialIssues('本项目合同估算价为8000万元。')).toEqual([]);
  });
  it('F4 最高投标限价句 → 不报', async () => {
    expect(await commercialIssues('最高投标限价为8000万元，以招标文件为准。')).toEqual([]);
  });
  it('F4 允许词+强词混合句语义负例胜出 → 不报', async () => {
    const issues = await commercialIssues('合同估算价与暂列金额均在项目信息表中列明。');
    expect(issues).toEqual([]);
  });
});

describe('F5 commercialDataInBodyIssues 变体词语义 gate', () => {
  it('F5 变体词语义命中（首个变体词入报）→ 报', async () => {
    const issues = await commercialIssues('材料价格与商务报价详见招标文件。');
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].message).toContain('材料价格');
  });
  it('F5 变体词语义不命中（中性句）→ 不报', async () => {
    expect(await commercialIssues('材料价格按市场行情浮动。')).toEqual([]);
  });
  it('F5 变体+强词混合语义命中 → 报强词', async () => {
    const issues = await commercialIssues('材料价格与报价明细详见清单。');
    expect(issues[0].message).toContain('报价明细');
  });
  it('F5 变体词+负例词同现 → 不报', async () => {
    expect(await commercialIssues('材料价格以最高投标限价为准。')).toEqual([]);
  });
});

describe('F6 commercialDataInBodyIssues 截断与去重', () => {
  it('F6 超过4词截断 slice(0,4)', async () => {
    const md = '暂列金额。暂估价。报价明细。综合单价。清单合价。';
    const issues = await commercialIssues(md);
    expect(issues[0].message.split('、')).toHaveLength(4);
  });
  it('F6 同词多处去重', async () => {
    const issues = await commercialIssues('暂列金额为60万元。暂列金额详见附表。');
    expect(issues[0].message).toBe('正文出现商务条款数据：暂列金额');
  });
  it('F6 报障建议含商务口径表述', async () => {
    const issues = await commercialIssues('本项目暂列金额为60万元。');
    expect(issues[0].suggestion).toContain('商务数据');
  });
});

// ── G. 跨章语义重复（crossChapterSemanticDuplicateIssues + strip）──

const PARA_WATER_1 = '屋面防水工程采用自粘聚合物改性沥青防水卷材与聚氨酯防水涂料复合做法，基层清理干净后涂刷基层处理剂，阴阳角与管根部位增设附加层加强处理。';
const PARA_WATER_2 = '屋面防水施工时先进行基层处理并涂刷基层处理剂，自粘聚合物改性沥青卷材与聚氨酯涂料复合铺贴，阴阳角管根等节点部位按规范加设附加层。';
const PARA_NO_WATER = '混凝土浇筑前对模板支撑体系进行专项验收，钢筋绑扎间距符合设计图纸要求，浇筑过程连续进行并按规定留置同条件试块。';

describe('G1 crossChapterSemanticDuplicateIssues 检出', () => {
  it('G1 两章同主题措辞不同 → 报', async () => {
    const chapters = [
      chapterOf('c1', '第六章 主要施工方案', PARA_WATER_1),
      chapterOf('c2', '第七章 质量保证措施', PARA_WATER_2),
    ];
    const issues = await crossChapterSemanticDuplicateIssues(chapters);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].message).toContain('跨章语义重复');
    expect(issues[0].message).toContain('第六章 主要施工方案');
    expect(issues[0].message).toContain('第七章 质量保证措施');
    expect(issues[0].severity).toBe('blocker');
    expect(issues[0].category).toBe('structure');
  });
  it('G1 相似度低于阈值 → 不报', async () => {
    const chapters = [
      chapterOf('c1', '第六章 主要施工方案', PARA_WATER_1),
      chapterOf('c2', '第七章 质量保证措施', PARA_NO_WATER),
    ];
    expect(await crossChapterSemanticDuplicateIssues(chapters)).toEqual([]);
  });
  it('G1 章内语义重复 → 不报（章级治理）', async () => {
    const chapters = [
      chapterOf('c1', '第六章 主要施工方案', `${PARA_WATER_1}\n\n${PARA_WATER_2}`),
    ];
    expect(await crossChapterSemanticDuplicateIssues(chapters)).toEqual([]);
  });
  it('G1 逐字相等段落 → 不报（整段重复通道）', async () => {
    const chapters = [
      chapterOf('c1', '第六章 主要施工方案', PARA_WATER_1),
      chapterOf('c2', '第七章 质量保证措施', PARA_WATER_1),
    ];
    expect(await crossChapterSemanticDuplicateIssues(chapters)).toEqual([]);
  });
  it('G1 段落去空白<60字 → 不入池', async () => {
    const short = '屋面防水施工要点明确。'.padEnd(59, '垫');
    const chapters = [
      chapterOf('c1', '第六章 主要施工方案', short),
      chapterOf('c2', '第七章 质量保证措施', short.replace('明确', '清晰')),
    ];
    expect(await crossChapterSemanticDuplicateIssues(chapters)).toEqual([]);
  });
});

describe('G2 crossChapterSemanticDuplicateIssues 段落池结构门', () => {
  it('G2 标题行块不入池', async () => {
    const chapters = [
      chapterOf('c1', '第六章 主要施工方案', `## 屋面防水工程\n\n${PARA_WATER_1}`),
      chapterOf('c2', '第七章 质量保证措施', `## 屋面防水工程\n\n${PARA_WATER_2}`),
    ];
    // 标题块被排除后池内仅两段正文，仍按正文比对——标题行自身不参与
    const issues = await crossChapterSemanticDuplicateIssues(chapters);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].message).not.toContain('屋面防水工程”与');
  });
  it('G2 表格行块不入池', async () => {
    const chapters = [
      chapterOf('c1', '第六章 主要施工方案', `| 部位 | 做法 |\n| 屋面 | 防水卷材与聚氨酯涂料复合铺贴施工做法说明 |`),
      chapterOf('c2', '第七章 质量保证措施', `| 部位 | 做法 |\n| 屋面 | 防水卷材与聚氨酯涂料复合铺贴施工做法说明 |`),
    ];
    expect(await crossChapterSemanticDuplicateIssues(chapters)).toEqual([]);
  });
  it('G2 列表行块不入池', async () => {
    const chapters = [
      chapterOf('c1', '第六章 主要施工方案', `- 屋面防水卷材与聚氨酯涂料复合铺贴施工做法说明内容`),
      chapterOf('c2', '第七章 质量保证措施', `- 屋面防水卷材与聚氨酯涂料复合铺贴施工做法说明内容`),
    ];
    expect(await crossChapterSemanticDuplicateIssues(chapters)).toEqual([]);
  });
  it('G2 空内容章跳过', async () => {
    const chapters = [
      chapterOf('c1', '第六章 主要施工方案', PARA_WATER_1),
      chapterOf('c2', '第七章 质量保证措施', ''),
    ];
    expect(await crossChapterSemanticDuplicateIssues(chapters)).toEqual([]);
  });
});

describe('G3 crossChapterSemanticDuplicateIssues 保留规则', () => {
  it('G3 chapterId 指向 drop 章', async () => {
    const chapters = [
      chapterOf('c1', '第六章 主要施工方案', PARA_WATER_1),
      chapterOf('c2', '第七章 质量保证措施', PARA_WATER_2),
    ];
    const issues = await crossChapterSemanticDuplicateIssues(chapters);
    expect(issues[0].chapterId).toBe('c2');
  });
  it('G3 信息密度高者保留（数字段落胜出）', async () => {
    // 章1 含数字（密度高），章2 纯中文（密度低）→ drop 章2
    const dense = '屋面防水层厚度为3mm，卷材搭接宽度100mm，附加层宽度300mm。'.padEnd(60, '防水');
    const sparse = '屋面防水层按照设计规范施工，附加层设置符合要求。'.padEnd(60, '施工');
    const chapters = [
      chapterOf('c1', '第六章 主要施工方案', dense),
      chapterOf('c2', '第七章 质量保证措施', sparse),
    ];
    const issues = await crossChapterSemanticDuplicateIssues(chapters);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].chapterId).toBe('c2');
  });
  it('G3 同密度保留章序靠前', async () => {
    const chapters = [
      chapterOf('c1', '第六章 主要施工方案', PARA_WATER_1),
      chapterOf('c2', '第七章 质量保证措施', PARA_WATER_2),
    ];
    const issues = await crossChapterSemanticDuplicateIssues(chapters);
    expect(issues[0].chapterId).toBe('c2');
  });
  it('G3 多对跨章 → 多条报障', async () => {
    const chapters = [
      chapterOf('c1', '第六章 主要施工方案', PARA_WATER_1),
      chapterOf('c2', '第七章 质量保证措施', PARA_WATER_2),
      chapterOf('c3', '第八章 安全文明施工', '屋面防水施工过程严格执行施工方案要求，加强节点部位附加层处理与管根部位细部控制，基层处理剂涂刷均匀后铺贴卷材，并按规定留置验收记录。'),
    ];
    const issues = await crossChapterSemanticDuplicateIssues(chapters);
    expect(issues.length).toBe(2);
  });
});

describe('G4 crossChapterSemanticDuplicateIssues 开关与边界', () => {
  it('G4 单章单段 → 不报', async () => {
    const chapters = [chapterOf('c1', '第六章 主要施工方案', PARA_WATER_1)];
    expect(await crossChapterSemanticDuplicateIssues(chapters)).toEqual([]);
  });
  it('G4 空章数组 → 不报', async () => {
    expect(await crossChapterSemanticDuplicateIssues([])).toEqual([]);
  });
});

describe('G5 stripCrossChapterSemanticDuplicateParagraphs 删除', () => {
  it('G5 单对删除 → removed 1 + 原地改 drop 章', async () => {
    const chapters = [
      chapterOf('c1', '第六章 主要施工方案', PARA_WATER_1),
      chapterOf('c2', '第七章 质量保证措施', PARA_WATER_2),
    ];
    const removed = await stripCrossChapterSemanticDuplicateParagraphs(chapters);
    expect(removed).toBe(1);
    expect(chapters[1].content).not.toContain('防水');
    expect(chapters[0].content).toContain('防水');
  });
  it('G5 无对 → removed 0', async () => {
    const chapters = [
      chapterOf('c1', '第六章 主要施工方案', PARA_WATER_1),
      chapterOf('c2', '第七章 质量保证措施', PARA_NO_WATER),
    ];
    expect(await stripCrossChapterSemanticDuplicateParagraphs(chapters)).toBe(0);
  });
  it('G5 保留高密度段删除低密度段', async () => {
    const dense = '屋面防水层厚度为3mm，卷材搭接宽度100mm，附加层宽度300mm。'.padEnd(60, '防水');
    const sparse = '屋面防水层按照设计规范施工，附加层设置符合要求。'.padEnd(60, '施工');
    const chapters = [
      chapterOf('c1', '第六章 主要施工方案', dense),
      chapterOf('c2', '第七章 质量保证措施', sparse),
    ];
    await stripCrossChapterSemanticDuplicateParagraphs(chapters);
    expect(chapters[0].content).toContain('3mm');
    expect(chapters[1].content).not.toContain('防水');
  });
  it('G5 同章多段同轮降序删除', async () => {
    const chapters = [
      chapterOf('c1', '第六章 主要施工方案', PARA_WATER_1),
      chapterOf('c2', '第七章 质量保证措施', `${PARA_WATER_2}\n\n${'屋面防水施工全过程执行方案要求与节点部位细部处理控制措施。'.padEnd(60, '防水')}`),
    ];
    const removed = await stripCrossChapterSemanticDuplicateParagraphs(chapters);
    expect(removed).toBe(2);
    expect(chapters[1].content.trim()).toBe('');
  });
  it('G5 循环收敛（删除后新对继续删）', async () => {
    const chapters = [
      chapterOf('c1', '第六章 主要施工方案', PARA_WATER_1),
      chapterOf('c2', '第七章 质量保证措施', PARA_WATER_2),
      chapterOf('c3', '第八章 安全文明施工', '屋面防水施工过程严格执行施工方案要求，加强节点部位附加层处理与管根部位细部控制，基层处理剂涂刷均匀后铺贴卷材，并按规定留置验收记录。'),
    ];
    const removed = await stripCrossChapterSemanticDuplicateParagraphs(chapters);
    expect(removed).toBe(2);
    expect(chapters[1].content.trim()).toBe('');
    expect(chapters[2].content.trim()).toBe('');
  });
  it('G5 删除后保留章内容不变', async () => {
    const chapters = [
      chapterOf('c1', '第六章 主要施工方案', PARA_WATER_1),
      chapterOf('c2', '第七章 质量保证措施', PARA_WATER_2),
    ];
    await stripCrossChapterSemanticDuplicateParagraphs(chapters);
    expect(chapters[0].content).toBe(PARA_WATER_1);
  });
});

// ── J 组占位（applyNumericConsistencyDeterministicFixes 聚合器，第九批深读内部修复器后补全）──
describe('J0 applyNumericConsistencyDeterministicFixes 空走', () => {
  it('J0 无权威无矛盾 → 原样返回', () => {
    const md = '普通施工组织内容。';
    const result = applyNumericConsistencyDeterministicFixes(md);
    expect(result.markdown).toBe(md);
    expect(result.fixedCount).toBe(0);
    expect(result.details).toEqual([]);
  });
});

// ── H. 工程概况一览表套话填充（fixPlaceholderTableCells）──

describe('H1 fixPlaceholderTableCells 建设规模套话', () => {
  it('H1 套话单元格替换为 areaSummary', () => {
    const md = '| 建设规模 | 按施工图设计文件确定 |';
    const result = fixPlaceholderTableCells(md, { areaSummary: '建筑面积50000平方米、地上10层、地下1层' });
    expect(result.markdown).toBe('| 建设规模 | 建筑面积50000平方米、地上10层、地下1层 |');
    expect(result.fixedCount).toBe(1);
  });
  it('H1 details 记录替换内容', () => {
    const result = fixPlaceholderTableCells('| 建设规模 | 按施工图设计文件确定 |', { areaSummary: '建筑面积50000平方米' });
    expect(result.details[0]).toContain('建筑面积50000平方米');
  });
  it('H1 无 areaSummary → 不动', () => {
    const md = '| 建设规模 | 按施工图设计文件确定 |';
    const result = fixPlaceholderTableCells(md, {});
    expect(result.markdown).toBe(md);
    expect(result.fixedCount).toBe(0);
  });
  it('H1 非表格行裸文本不动', () => {
    const md = '建设规模按施工图设计文件确定。';
    expect(fixPlaceholderTableCells(md, { areaSummary: '建筑面积50000平方米' }).fixedCount).toBe(0);
  });
  it('H1 竖线不完整形态不动', () => {
    const md = '按施工图设计文件确定 |';
    expect(fixPlaceholderTableCells(md, { areaSummary: '建筑面积50000平方米' }).fixedCount).toBe(0);
  });
});

describe('H2 fixPlaceholderTableCells 工期套话', () => {
  it('H2 套话单元格替换为日历天', () => {
    const md = '| 计划工期 | 按合同约定工期执行 |';
    const result = fixPlaceholderTableCells(md, { scheduleDays: 450 });
    expect(result.markdown).toBe('| 计划工期 | 450个日历天 |');
    expect(result.fixedCount).toBe(1);
  });
  it('H2 scheduleDays=0 → 不动', () => {
    const md = '| 计划工期 | 按合同约定工期执行 |';
    expect(fixPlaceholderTableCells(md, { scheduleDays: 0 }).fixedCount).toBe(0);
  });
  it('H2 两种套话同表替换', () => {
    const md = '| 建设规模 | 按施工图设计文件确定 |\n| 计划工期 | 按合同约定工期执行 |';
    const result = fixPlaceholderTableCells(md, { areaSummary: '建筑面积50000平方米', scheduleDays: 450 });
    expect(result.markdown).toContain('| 建设规模 | 建筑面积50000平方米 |');
    expect(result.markdown).toContain('| 计划工期 | 450个日历天 |');
    expect(result.fixedCount).toBe(2);
  });
  it('H2 多处同套话依次替换', () => {
    const md = '| 计划工期 | 按合同约定工期执行 |\n| 工期 | 按合同约定工期执行 |';
    const result = fixPlaceholderTableCells(md, { scheduleDays: 450 });
    expect(result.fixedCount).toBe(2);
  });
  it('H2 无替换返回原引用', () => {
    const md = '| 计划工期 | 450个日历天 |';
    const result = fixPlaceholderTableCells(md, { scheduleDays: 450 });
    expect(result.markdown).toBe(md);
  });
});

// ── I. 6.1 施工部署块质量保障补全（fixQualityAssuranceCoverage）──

const QA_BLOCK_HEAD = '### 6.1 施工部署与施工流水组织';

describe('I1 fixQualityAssuranceCoverage 补全注入', () => {
  it('I1 缺全部核心术语 → 注入', () => {
    const md = `${QA_BLOCK_HEAD}\n本工程按流水段组织施工，合理划分施工区段。\n### 6.2 施工进度计划\n后续内容。`;
    const result = fixQualityAssuranceCoverage(md);
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toContain('质量保障体系与安全文明管理同频运行');
  });
  it('I1 注入段含全部核心术语（试块/报验与养护分置形态）', () => {
    const md = `${QA_BLOCK_HEAD}\n本工程按流水段组织施工。`;
    const result = fixQualityAssuranceCoverage(md);
    for (const term of ['三检', '样板引路', '隐蔽验收', '见证取样']) {
      expect(result.markdown).toContain(term);
    }
    expect(result.markdown).toContain('试块');
    expect(result.markdown).toContain('养护');
    expect(result.markdown).toContain('分部分项');
    expect(result.markdown).toContain('报验');
  });
  it('I1 注入位置在块尾（6.2 标题前）', () => {
    const md = `${QA_BLOCK_HEAD}\n本工程按流水段组织施工。\n### 6.2 施工进度计划\n后续内容。`;
    const result = fixQualityAssuranceCoverage(md);
    const injectedIndex = result.markdown.indexOf('质量保障体系');
    const nextHeadingIndex = result.markdown.indexOf('### 6.2');
    expect(injectedIndex).toBeGreaterThan(0);
    expect(injectedIndex).toBeLessThan(nextHeadingIndex);
  });
  it('I1 details 记录缺失数', () => {
    const md = `${QA_BLOCK_HEAD}\n本工程按流水段组织施工。`;
    const result = fixQualityAssuranceCoverage(md);
    expect(result.details[0]).toContain('6/6');
  });
});

describe('I2 fixQualityAssuranceCoverage 门槛与边界', () => {
  it('I2 命中3个核心术语 → 不动', () => {
    const md = `${QA_BLOCK_HEAD}\n执行三检制度与样板引路要求，隐蔽验收留存影像记录。`;
    expect(fixQualityAssuranceCoverage(md).fixedCount).toBe(0);
  });
  it('I2 命中2个核心术语 → 注入', () => {
    const md = `${QA_BLOCK_HEAD}\n执行三检制度与样板引路要求。`;
    expect(fixQualityAssuranceCoverage(md).fixedCount).toBe(1);
  });
  it('I2 无 6.1 块 → 不动', () => {
    expect(fixQualityAssuranceCoverage('本工程按流水段组织施工。').fixedCount).toBe(0);
  });
  it('I2 标题不完全匹配 → 不动', () => {
    expect(fixQualityAssuranceCoverage('### 6.1 施工部署\n本工程按流水段组织施工。').fixedCount).toBe(0);
  });
  it('I2 块到文档尾（$ 边界）→ 注入', () => {
    const md = `${QA_BLOCK_HEAD}\n本工程按流水段组织施工。`;
    const result = fixQualityAssuranceCoverage(md);
    expect(result.fixedCount).toBe(1);
    expect(result.markdown.startsWith(md)).toBe(true);
  });
  it('I2 第七章标题截断块区间', () => {
    const md = `${QA_BLOCK_HEAD}\n本工程按流水段组织施工。\n## 第七章 质量保证措施\n后续内容。`;
    const result = fixQualityAssuranceCoverage(md);
    expect(result.fixedCount).toBe(1);
    expect(result.markdown.indexOf('质量保障体系')).toBeLessThan(result.markdown.indexOf('## 第七章'));
  });
});
