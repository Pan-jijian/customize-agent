/**
 * 商业/支护/清单类检测器边界矩阵（P1 第 5 批）
 * 覆盖：extractSupportSystemAuthority+supportSystemConflictIssues+fixSupportSystemConflicts（支护体系裁决）/
 * dangerousListConsistencyIssues（危大清单一致性）/ stripCommercialDataSentences+stripCommercialDataBodyLines（商务句清洗）/
 * nodeScheduleConsistencyIssues（节点工期口径）/ extractGreeningMaintenanceAuthority+greeningMaintenanceMismatchIssues（绿化养护期）/
 * extractStreetLightAuthority+streetLightCountMismatchIssues（路灯数量）/
 * specLocationMismatchIssues（规格错位）/ fabricatedAwardIssues（编造奖项）/
 * bidderQualificationSectionIssues（资格章节串章）/ resourceTriadSectionHierarchyIssues（人材机章层级）/
 * extractScheduleAuthority+extractAssemblyRateAuthority+extractProjectScaleSummary（权威口径提取）
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bidderQualificationSectionIssues, dangerousListConsistencyIssues,
  extractAssemblyRateAuthority, extractGreeningMaintenanceAuthority,
  extractProjectScaleSummary, extractScheduleAuthority, extractStreetLightAuthority,
  extractSupportSystemAuthority, fabricatedAwardIssues, fixSupportSystemConflicts,
  greeningMaintenanceMismatchIssues, nodeScheduleConsistencyIssues,
  resourceTriadSectionHierarchyIssues, specLocationMismatchIssues,
  streetLightCountMismatchIssues, stripCommercialDataBodyLines,
  stripCommercialDataSentences, supportSystemConflictIssues,
} from '@/services/document-workflow/documentIntegrityChecks';
import { buildSemanticSimilarity } from '@/services/document-workflow/semanticSimilarity';
import type { SpecAuthorityMap } from '@/services/document-workflow/types';
import { factOf, factsOf } from './boundaryKit';

vi.mock('@/services/document-workflow/semanticSimilarity', () => ({ buildSemanticSimilarity: vi.fn(), SEMANTIC_COVERAGE_THRESHOLD: 0.6 }));

/** 词面模拟语义：slope query 命中坡族词、pile query 命中桩族词（与检测器词表同源） */
const SLOPE_LITERAL = /土钉|放坡|喷锚|挂网|锚杆|护坡/u;
const PILE_LITERAL = /钻孔灌注桩|高压旋喷桩|旋喷桩|搅拌桩|灌注桩|排桩|地下连续墙|咬合桩|支护桩/u;
const LEXICAL_SIM = async (_texts: string[], _queries: string[]) => (left: string, right: string): number => {
  if (right.includes('土钉墙喷锚')) return SLOPE_LITERAL.test(left) ? 0.9 : 0.1;
  if (right.includes('地下连续墙围护')) return PILE_LITERAL.test(left) ? 0.9 : 0.1;
  return 0.1;
};
/** 无条件高分（语义全命中，测词面预检拦截）：pile query 恒高分、slope query 按坡族词面 */
const PILE_UNCONDITIONAL_SIM = async (_texts: string[], _queries: string[]) => (left: string, right: string): number => {
  if (right.includes('地下连续墙围护')) return 0.9;
  if (right.includes('土钉墙喷锚')) return SLOPE_LITERAL.test(left) ? 0.9 : 0.1;
  return 0.1;
};

beforeEach(() => {
  vi.mocked(buildSemanticSimilarity).mockImplementation(LEXICAL_SIM);
});

// ── A. 支护体系权威提取（extractSupportSystemAuthority）──

describe('A1 extractSupportSystemAuthority 坡族词谱系', () => {
  const slopeWords = ['土钉墙', '放坡', '喷锚', '挂网', '锚杆', '护坡'];
  it.each(slopeWords)('A1 槽位值含“%s”→slope', (word) => {
    const model = factsOf({ canonical: { byKey: { foundation_support_form: { value: `基坑支护形式为${word}` } } } as never });
    expect(extractSupportSystemAuthority(model)).toBe('slope');
  });
});

describe('A2 extractSupportSystemAuthority 桩族词谱系', () => {
  const pileWords = ['钻孔灌注桩', '高压旋喷桩', '旋喷桩', '搅拌桩', '灌注桩', '排桩', '地下连续墙', '咬合桩', '支护桩'];
  it.each(pileWords)('A2 槽位值含“%s”→pile', (word) => {
    const model = factsOf({ canonical: { byKey: { foundation_support_form: { value: `基坑支护形式为${word}` } } } as never });
    expect(extractSupportSystemAuthority(model)).toBe('pile');
  });
  it('A2 两族并存（灌注桩+局部放坡）→undefined', () => {
    const model = factsOf({ canonical: { byKey: { foundation_support_form: { value: '灌注桩+局部放坡' } } } as never });
    expect(extractSupportSystemAuthority(model)).toBeUndefined();
  });
  it('A2 无槽位/空值 →undefined', () => {
    expect(extractSupportSystemAuthority(factsOf({}))).toBeUndefined();
    expect(extractSupportSystemAuthority(factsOf({ canonical: { byKey: { foundation_support_form: { value: '' } } } as never }))).toBeUndefined();
    expect(extractSupportSystemAuthority(undefined)).toBeUndefined();
  });
});

// ── B. 支护体系冲突检测（supportSystemConflictIssues）──

const SLOPE_BLOCK = '本基坑采用土钉墙加放坡的支护形式，坡面挂网喷锚，锚杆锁定坡体，整体稳定性满足深基坑安全要求。';
const PILE_BLOCK = '本基坑采用钻孔灌注桩与排桩的支护形式，桩间喷混凝土护壁，整体稳定性满足深基坑安全要求。';

describe('B1 supportSystemConflict 双族成段并存', () => {
  it('B1 坡块+桩块分块 → 报', async () => {
    const md = `${SLOPE_BLOCK}\n\n${PILE_BLOCK}`;
    const issues = await supportSystemConflictIssues(md);
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('放坡喷锚类 1 段、灌注桩排桩类 1 段');
  });
  it('B1 两坡块一桩块计数', async () => {
    const md = `${SLOPE_BLOCK}\n\n${PILE_BLOCK}\n\n${SLOPE_BLOCK}`;
    const issues = await supportSystemConflictIssues(md);
    expect(issues[0].message).toContain('放坡喷锚类 2 段、灌注桩排桩类 1 段');
  });
  it('B1 仅坡族 → 不报', async () => {
    expect(await supportSystemConflictIssues(`${SLOPE_BLOCK}\n\n${SLOPE_BLOCK}`)).toEqual([]);
  });
  it('B1 仅桩族 → 不报', async () => {
    expect(await supportSystemConflictIssues(`${PILE_BLOCK}\n\n${PILE_BLOCK}`)).toEqual([]);
  });
  it('B1 混合块（两族词同块）→ 不报', async () => {
    const mixed = '本基坑采用灌注桩排桩支护，坡顶局部放坡卸载，土钉墙加固坡面，整体稳定性满足深基坑安全要求。';
    expect(await supportSystemConflictIssues(mixed)).toEqual([]);
  });
  it('B1 块短于 30 字过滤 → 不报', async () => {
    expect(await supportSystemConflictIssues('采用土钉墙。\n\n采用灌注桩。')).toEqual([]);
  });
  it('B1 块 29/30 字门', async () => {
    const short = `土钉墙放坡。\n\n${'基'.repeat(29)}`;
    expect(await supportSystemConflictIssues(short)).toEqual([]);
    const edge = `${SLOPE_BLOCK}\n\n${PILE_BLOCK}`;
    expect((await supportSystemConflictIssues(edge)).length).toBe(1);
  });
});

describe('B2 supportSystemConflict 词面预检', () => {
  it('B2 桩块无桩族实义词（仅桩基施工泛化词）→ 预检拦截不报', async () => {
    vi.mocked(buildSemanticSimilarity).mockImplementation(PILE_UNCONDITIONAL_SIM);
    const pileish = '本基坑桩基施工安排按专项方案执行，桩基检验批报验流程明确，整体稳定性满足深基坑安全要求。';
    const md = `${SLOPE_BLOCK}\n\n${pileish}`;
    expect(await supportSystemConflictIssues(md)).toEqual([]);
  });
  it('B2 桩块含实义词（灌注桩）→ 报', async () => {
    vi.mocked(buildSemanticSimilarity).mockImplementation(PILE_UNCONDITIONAL_SIM);
    const md = `${SLOPE_BLOCK}\n\n${PILE_BLOCK}`;
    expect((await supportSystemConflictIssues(md)).length).toBe(1);
  });
});

describe('B3 supportSystemConflict 权威方向注入', () => {
  it('B3 authority 未注入 → message 无权威提示', async () => {
    const issues = await supportSystemConflictIssues(`${SLOPE_BLOCK}\n\n${PILE_BLOCK}`);
    expect(issues[0].message).not.toContain('权威体系判定');
  });
  it('B3 authority=slope → 删除灌注桩排桩类', async () => {
    const issues = await supportSystemConflictIssues(`${SLOPE_BLOCK}\n\n${PILE_BLOCK}`, 'slope');
    expect(issues[0].message).toContain('删除灌注桩排桩类表述');
  });
  it('B3 authority=pile → 删除放坡喷锚类', async () => {
    const issues = await supportSystemConflictIssues(`${SLOPE_BLOCK}\n\n${PILE_BLOCK}`, 'pile');
    expect(issues[0].message).toContain('删除放坡喷锚类独立成段表述');
  });
});

// ── C. 支护体系确定性裁决修复（fixSupportSystemConflicts）──

describe('C1 fixSupportSystem 权威方向门', () => {
  const pileSentence = '本基坑采用灌注桩支护。';
  it.each([undefined, null, 'pile'])('C1 authority=%s 不动', (authority) => {
    const result = fixSupportSystemConflicts(pileSentence, authority as never);
    expect(result.markdown).toBe(pileSentence);
    expect(result.fixedCount).toBe(0);
  });
  it('C1 authority=slope 才执行', () => {
    expect(fixSupportSystemConflicts(pileSentence, 'slope').fixedCount).toBeGreaterThan(0);
  });
});

describe('C2 fixSupportSystem 纯桩族句删除', () => {
  const pileSentences = ['采用钻孔灌注桩支护。', '采用高压旋喷桩支护。', '采用旋喷桩支护。', '采用搅拌桩支护。', '采用灌注桩支护。', '采用排桩支护。', '采用地下连续墙支护。', '采用咬合桩支护。', '采用支护桩支护。'];
  it.each(pileSentences)('C2 “%s”整句删', (sentence) => {
    const md = `${sentence}\n坡面采用土钉墙。`;
    const result = fixSupportSystemConflicts(md, 'slope');
    expect(result.markdown).not.toContain(sentence.replace('。', ''));
    expect(result.markdown).toContain('坡面采用土钉墙。');
  });
  it('C2 坡族句保留', () => {
    const md = '坡面采用土钉墙。\n基坑采用放坡开挖。';
    const result = fixSupportSystemConflicts(md, 'slope');
    expect(result.markdown).toBe(md);
    expect(result.fixedCount).toBe(0);
  });
});

describe('C3 fixSupportSystem 混句词级替换谱系', () => {
  const pairs: Array<[string, string]> = [
    ['高压旋喷桩', '土钉墙'], ['旋喷桩', '土钉墙'], ['钻孔灌注桩', '土钉墙'],
    ['咬合桩', '土钉墙'], ['地下连续墙', '土钉墙'], ['搅拌桩', '土钉墙'],
    ['灌注桩', '土钉墙'], ['支护桩', '土钉墙'], ['排桩', '土钉墙'],
  ];
  it.each(pairs)('C3 “%s”→"%s"（混句）', (word, replacement) => {
    const md = `基坑采用${word}，坡面挂网喷锚。`;
    const result = fixSupportSystemConflicts(md, 'slope');
    expect(result.markdown).toContain(`${replacement}，坡面挂网喷锚。`);
    expect(result.markdown).not.toContain(word);
  });
  it('C3 长词优先（高压旋喷桩整体替换不产生高压土钉墙）', () => {
    const md = '基坑采用高压旋喷桩，坡面挂网喷锚。';
    const result = fixSupportSystemConflicts(md, 'slope');
    expect(result.markdown).toContain('基坑采用土钉墙，坡面挂网喷锚。');
  });
  it('C3 冠梁特殊映射 → 坡顶（混句含桩族词触发）', () => {
    const md = '支护采用冠梁与灌注桩，坡面挂网喷锚。';
    expect(fixSupportSystemConflicts(md, 'slope').markdown).toContain('坡顶与土钉墙');
  });
  it('C3 多词混句逐词替换', () => {
    const md = '基坑采用钻孔灌注桩与支护桩组合，坡面挂网喷锚。';
    const result = fixSupportSystemConflicts(md, 'slope');
    expect(result.markdown).toContain('土钉墙与土钉墙组合');
  });
});

describe('C4 fixSupportSystem 机械逗号项删除', () => {
  const machines = ['高压旋喷桩机', '旋喷桩机', '搅拌桩机', '三轴搅拌', '成槽机', '灌注桩机'];
  it.each(machines)('C4 机械词“%s”逗号项整项删（行内需桩族实义词触发）', (machine) => {
    const md = `设备配置${machine}3台，基坑采用灌注桩，坡面挂网喷锚。`;
    const result = fixSupportSystemConflicts(md, 'slope');
    expect(result.markdown).not.toContain(machine);
    expect(result.markdown).toContain('土钉墙');
  });
  it('C4 无逗号机械词整句作为单一逗号项删除（行为锁定）', () => {
    const md = '采用高压旋喷桩机与土钉墙配合。';
    const result = fixSupportSystemConflicts(md, 'slope');
    expect(result.markdown).toBe('。');
    expect(result.fixedCount).toBe(1);
  });
});

describe('C5 fixSupportSystem 结构行与标点', () => {
  it('C5 标题行不动', () => {
    const md = '## 基坑支护方案\n本基坑采用灌注桩支护。';
    const result = fixSupportSystemConflicts(md, 'slope');
    expect(result.markdown).toContain('## 基坑支护方案');
    expect(result.markdown).not.toContain('灌注桩');
  });
  it('C5 表格行不动', () => {
    const md = '| 工序 | 支护 | 灌注桩 |\n本基坑采用灌注桩支护。';
    const result = fixSupportSystemConflicts(md, 'slope');
    expect(result.markdown).toContain('| 工序 | 支护 | 灌注桩 |');
  });
  it('C5 句尾标点随尾项删除时补回', () => {
    const md = '设备配置灌注桩机3台，坡面采用土钉墙。';
    const result = fixSupportSystemConflicts(md, 'slope');
    expect(result.markdown).toContain('坡面采用土钉墙。');
  });
  it('C5 分号句尾保留', () => {
    const md = '基坑采用灌注桩，坡面挂网喷锚；';
    const result = fixSupportSystemConflicts(md, 'slope');
    expect(result.markdown).toContain('基坑采用土钉墙，坡面挂网喷锚；');
  });
});

// ── D. 危大工程辨识清单一致性（dangerousListConsistencyIssues）──

describe('D1 dangerousList 标题谱系命中', () => {
  const titleVariants = ['危大工程清单', '危大工程辨识清单', '危大工程识别', '危大清单', '危大识别', '危大辨识', '危大工程及超危大清单', '危大及超危大识别', '危大工程辨识识别'];
  const levels = ['##', '###', '####'];
  it.each(titleVariants.flatMap(t => levels.map(l => [l, t])))('D1 %s %s 识别为清单标题', (level, title) => {
    const md = `${level} 3.1 ${title}\n1. 土方开挖\n2. 基坑支护\n${level} 3.2 ${title}\n1. 土方开挖\n2. 模板工程`;
    const issues = dangerousListConsistencyIssues(md);
    expect(issues.length).toBe(1);
  });
  it('D1 编号前缀可选（带/不带编号都命中）', () => {
    const withNumber = '## 3.1 危大工程辨识清单\n1. 甲\n2. 乙\n## 3.2 危大工程辨识清单\n1. 甲\n2. 丙';
    const withoutNumber = '## 危大工程辨识清单\n1. 甲\n2. 乙\n## 危大工程辨识清单\n1. 甲\n2. 丙';
    expect(dangerousListConsistencyIssues(withNumber).length).toBe(1);
    expect(dangerousListConsistencyIssues(withoutNumber).length).toBe(1);
  });
});

describe('D2 dangerousList 标题谱系不命中', () => {
  it.each(['# 危大工程清单', '##### 危大工程清单', '## 安全保证措施', '## 危大工程', '## 超危大工程方案'])('D2 “%s”不识别', (heading) => {
    const md = `${heading}\n1. 土方开挖\n2. 基坑支护`;
    expect(dangerousListConsistencyIssues(md)).toEqual([]);
  });
});

describe('D3 dangerousList 归一化谱系', () => {
  const numberings = ['1.', '1、', '1．', '1)', '-', '*', '•', ''];
  it.each(numberings)('D3 编号形态“%s”归一化后一致不报', (numbering) => {
    const md = `## 危大清单\n${numbering}${numbering ? ' ' : ''}基坑支护（含降水）施工\n2. 土方开挖\n## 危大清单\n1. 基坑支护\n2. 土方开挖`;
    expect(dangerousListConsistencyIssues(md)).toEqual([]);
  });
  it('D3 括号标注/施工尾缀/空白归一化', () => {
    const md = '## 危大清单\n1. 基坑支护（含降水）\n2. 土方开挖施工\n## 危大清单\n1. 基坑支护\n2. 土 方 开 挖';
    expect(dangerousListConsistencyIssues(md)).toEqual([]);
  });
});

describe('D4 dangerousList 条目提取门', () => {
  it('D4 裸单字行不采、编号单字行整行归一后采（行为锁定）', () => {
    const bare = '## 危大清单\n挖\n2. 支护\n## 危大清单\n挖\n2. 模板';
    expect(dangerousListConsistencyIssues(bare)).toEqual([]);
    const numbered = '## 危大清单\n1. 挖\n2. 支护\n## 危大清单\n1. 挖\n2. 模板';
    const issues = dangerousListConsistencyIssues(numbered);
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('前者独有【支护】');
    expect(issues[0].message).toContain('后者独有【模板】');
  });
  it('D4 含句号/分号/竖线行不采', () => {
    const md = '## 危大清单\n1. 土方开挖。\n2. 基坑支护\n## 危大清单\n1. 土方开挖\n2. 基坑支护';
    expect(dangerousListConsistencyIssues(md)).toEqual([]);
  });
  it('D4 40 字条目采、41 字不采', () => {
    const long40 = '甲'.repeat(40);
    const long41 = '乙'.repeat(41);
    const md = `## 危大清单\n1. ${long40}\n2. 基坑支护\n## 危大清单\n1. ${long40}\n2. ${long41}`;
    expect(dangerousListConsistencyIssues(md)).toEqual([]);
  });
});

describe('D5 dangerousList 窗口与数量门', () => {
  it('D5 第 30 行条目在窗口外', () => {
    const items = Array.from({ length: 29 }, (_, index) => `${index + 1}. 条目${index + 1}`);
    const md = `## 危大清单\n${items.join('\n')}\n30. 窗口外条目\n## 危大清单\n${items.join('\n')}\n30. 不同内容`;
    expect(dangerousListConsistencyIssues(md)).toEqual([]);
  });
  it('D5 标题截断窗口', () => {
    const md = '## 危大清单\n1. 土方开挖\n### 其他小节\n2. 基坑支护\n## 危大清单\n1. 土方开挖';
    expect(dangerousListConsistencyIssues(md)).toEqual([]);
  });
  it('D5 单份清单/单条目不报', () => {
    expect(dangerousListConsistencyIssues('## 危大清单\n1. 土方开挖\n2. 基坑支护')).toEqual([]);
    expect(dangerousListConsistencyIssues('## 危大清单\n1. 土方开挖\n## 危大清单\n2. 基坑支护')).toEqual([]);
  });
});

describe('D6 dangerousList 两两差异比较', () => {
  it('D6 完全一致不报', () => {
    const md = '## 危大清单\n1. 土方开挖\n2. 基坑支护\n## 危大清单\n1. 土方开挖\n2. 基坑支护';
    expect(dangerousListConsistencyIssues(md)).toEqual([]);
  });
  it('D6 单项差异报（onlyInA/onlyInB 落位）', () => {
    const md = '## 危大清单\n1. 土方开挖\n2. 基坑支护\n## 危大清单\n1. 土方开挖\n2. 模板工程';
    const issues = dangerousListConsistencyIssues(md);
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('前者独有【基坑支护】');
    expect(issues[0].message).toContain('后者独有【模板工程】');
  });
  it('D6 三份清单两两比较（3 组）', () => {
    const md = '## 危大清单\n1. 甲\n2. 乙\n## 危大清单\n1. 甲\n2. 丙\n## 危大清单\n1. 丁\n2. 乙';
    expect(dangerousListConsistencyIssues(md).length).toBe(3);
  });
  it('D6 四份清单两两 6 组只报 3（slice 3）', () => {
    const md = '## 危大清单\n1. 甲\n2. 乙\n## 危大清单\n1. 甲\n2. 丙\n## 危大清单\n1. 甲\n2. 丁\n## 危大清单\n1. 甲\n2. 戊';
    expect(dangerousListConsistencyIssues(md).length).toBe(3);
  });
  it('D6 清单内重复项 Set 去重后比较', () => {
    const md = '## 危大清单\n1. 土方开挖\n2. 土方开挖\n3. 基坑支护\n## 危大清单\n1. 土方开挖\n2. 基坑支护';
    expect(dangerousListConsistencyIssues(md)).toEqual([]);
  });
});

// ── E. 商务条款句清洗（stripCommercialDataSentences / BodyLines）──

describe('E1 stripCommercial 商务词谱系', () => {
  const terms = ['暂列金额', '暂估价', '报价明细', '综合单价', '清单合价', '预留金', '投标报价', '异常低价', '评标基准价'];
  it.each(terms)('E1 含“%s”句删除', (term) => {
    const md = `本项目${term}为100万元。\n保留句内容。`;
    const result = stripCommercialDataSentences(md);
    expect(result).not.toContain(term);
    expect(result).toContain('保留句内容。');
  });
});

describe('E2 stripCommercial 税率谱系', () => {
  it('E2 税率+12字内数字删', () => {
    const result = stripCommercialDataSentences('本项目税率3%。保留句。');
    expect(result).not.toContain('税率');
  });
  it('E2 增值税+数字删', () => {
    const result = stripCommercialDataSentences('增值税率按13%计取。保留句。');
    expect(result).not.toContain('增值税');
  });
  it('E2 税率后 13 字才有数字 → 不删', () => {
    const md = `税率${'甲'.repeat(13)}3。保留句。`;
    expect(stripCommercialDataSentences(md)).toContain('税率');
  });
  it('E2 税率无数字 → 不删', () => {
    expect(stripCommercialDataSentences('税率按合同约定执行。')).toContain('税率');
  });
});

describe('E3 stripCommercial 结构保留与行级行为', () => {
  it('E3 标题开头块整体保留（split 不按行切）', () => {
    const md = '## 商务条款\n本项目暂列金额100万元。';
    const result = stripCommercialDataSentences(md);
    expect(result).toContain('## 商务条款');
    expect(result).toContain('暂列金额');
  });
  it('E3 表格开头块整体保留（split 不按行切）', () => {
    const md = '| 名称 | 暂列金额 | 100万元 |\n正文暂估价50万元。';
    const result = stripCommercialDataSentences(md);
    expect(result).toContain('暂列金额');
    expect(result).toContain('暂估价');
  });
  it('E3 BodyLines 行内多句只删含词句', () => {
    const md = '第一句正常。第二句含暂列金额100万元。第三句正常。';
    const result = stripCommercialDataBodyLines(md);
    expect(result).toContain('第一句正常。');
    expect(result).not.toContain('暂列金额');
    expect(result).toContain('第三句正常。');
  });
  it('E3 BodyLines 标题/表格行保留', () => {
    const md = '## 报价明细\n| 项 | 综合单价 |\n正文句暂列金额50万元。';
    const result = stripCommercialDataBodyLines(md);
    expect(result).toContain('## 报价明细');
    expect(result).toContain('| 项 | 综合单价 |');
    expect(result).not.toContain('暂列金额');
  });
  it('E3 商务允许词（合同估算价/招标控制价）不误删', () => {
    const md = '本项目合同估算价1500万元。最高投标限价按招标控制价执行。';
    expect(stripCommercialDataSentences(md)).toContain('合同估算价');
    expect(stripCommercialDataBodyLines(md)).toContain('招标控制价');
  });
  it('E3 无商务词 Sentences 换行被吃、BodyLines 保原样（行为锁定）', () => {
    const md = '本段为施工组织设计正文。\n第二段内容正常。';
    expect(stripCommercialDataSentences(md)).toBe('本段为施工组织设计正文。第二段内容正常。');
    expect(stripCommercialDataBodyLines(md)).toBe(md);
  });
});

// ── F. 节点工期口径互查（nodeScheduleConsistencyIssues）──

const NODE_LABELS: Array<[string, string]> = [
  ['excavation', '基坑支护及土方外运'],
  ['zero', '地下结构出正负零'],
  ['topping', '主体结构封顶'],
  ['decoration', '装饰装修及幕墙'],
  ['mep', '机电安装及智能化调试'],
  ['completion', '室外工程及竣工验收'],
];

describe('F1 nodeSchedule 六锚点形态A双口径', () => {
  it.each(NODE_LABELS)('F1 “%s”60/75 两口径报', (_key, node) => {
    const md = `第60日完成${node}。第75日完成${node}。`;
    const issues = nodeScheduleConsistencyIssues(md);
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('60日');
    expect(issues[0].message).toContain('75日');
  });
});

describe('F2 nodeSchedule 阈值边界', () => {
  it('F2 差 4 天报（不同数值即矛盾）', () => {
    expect(nodeScheduleConsistencyIssues('第60日完成主体结构封顶。第64日完成主体结构封顶。').length).toBe(1);
  });
  it('F2 差 5 天报', () => {
    expect(nodeScheduleConsistencyIssues('第60日完成主体结构封顶。第65日完成主体结构封顶。').length).toBe(1);
  });
  it('F2 单口径不报', () => {
    expect(nodeScheduleConsistencyIssues('第60日完成主体结构封顶。')).toEqual([]);
  });
  it('F2 同口径两处不报', () => {
    expect(nodeScheduleConsistencyIssues('第60日完成主体结构封顶。第60日完成主体结构封顶。')).toEqual([]);
  });
});

describe('F3 nodeSchedule 形态B/C/D', () => {
  it('F3 形态B表格式（基坑支护完成|第75天）与形态A互查', () => {
    const md = '第60日完成基坑支护及土方外运。\n| 节点 | 基坑支护完成 | 第75天 |';
    expect(nodeScheduleConsistencyIssues(md).length).toBe(1);
  });
  it('F3 形态C倒序锁定（封顶锁定开工后第230日）', () => {
    const md = '第210日完成主体结构封顶。主体结构封顶节点锁定在开工后第230日。';
    const issues = nodeScheduleConsistencyIssues(md);
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('230日');
  });
  it('F3 形态D表行（开工后第N日）', () => {
    const md = '| 主体结构封顶 | 开工后第230日 |';
    expect(nodeScheduleConsistencyIssues(md)).toEqual([]);
    const conflict = '第210日完成主体结构封顶。\n| 主体结构封顶 | 开工后第230日 |';
    expect(nodeScheduleConsistencyIssues(conflict).length).toBe(1);
  });
  it('F3 形态B短词“封顶”归一为完整节点', () => {
    const md = '第210日完成主体结构封顶。\n| 节点 | 封顶完成 | 第230天 |';
    expect(nodeScheduleConsistencyIssues(md).length).toBe(1);
  });
});

describe('F4 nodeSchedule 防误采谱系', () => {
  it('F4 准备阶段句不误采（完成与节点名间枚举符）', () => {
    const md = '第15日完成清表，基坑支护及土方外运按计划推进。';
    expect(nodeScheduleConsistencyIssues(md)).toEqual([]);
  });
  it('F4 封顶后相对日不采（主体结构封顶后第10日）', () => {
    const md = '第210日完成主体结构封顶。主体结构封顶后第10日拆除脚手架。';
    expect(nodeScheduleConsistencyIssues(md)).toEqual([]);
  });
  it('F4 设备表行进场日不采', () => {
    const md = '| 塔吊 | 主体结构封顶 | 第30日进场 |';
    expect(nodeScheduleConsistencyIssues(md)).toEqual([]);
  });
  it('F4 跨节点不误采（正负零、第300日完成主体结构封顶）', () => {
    const md = '正负零、第300日完成主体结构封顶、第450日';
    expect(nodeScheduleConsistencyIssues(md)).toEqual([]);
  });
});

describe('F5 nodeSchedule 报障上限与去重', () => {
  it('F5 六节点全矛盾只报 4（slice 4）', () => {
    const lines = NODE_LABELS.map(([, node]) => `第60日完成${node}。第90日完成${node}。`);
    expect(nodeScheduleConsistencyIssues(lines.join('\n')).length).toBe(4);
  });
  it('F5 同一 raw 多形态重复扫描去重', () => {
    const md = '第60日完成主体结构封顶。第90日完成主体结构封顶。';
    const issues = nodeScheduleConsistencyIssues(md);
    expect(issues.length).toBe(1);
  });
  it('F5 日数超界（第9日/第3001日）不采', () => {
    expect(nodeScheduleConsistencyIssues('第9日完成主体结构封顶。')).toEqual([]);
    expect(nodeScheduleConsistencyIssues('第3001日完成主体结构封顶。')).toEqual([]);
  });
});

// ── G. 绿化养护期权威提取与红线（extractGreeningMaintenanceAuthority / greeningMaintenanceMismatchIssues）──

describe('G1 greeningAuthority 中文数字谱系', () => {
  const cnYears: Array<[string, number]> = [
    ['一', 1], ['二', 2], ['两', 2], ['三', 3], ['四', 4], ['五', 5], ['六', 6], ['七', 7], ['八', 8], ['九', 9], ['十', 10], ['十一', 11], ['二十', 20],
  ];
  it.each(cnYears)('G1 养护%s年→%d', (raw, expected) => {
    const model = factsOf({ bills: [factOf({ key: '绿化', value: `喷播植草籽，养护${raw}年` })] });
    expect(extractGreeningMaintenanceAuthority(model)).toBe(expected);
  });
});

describe('G2 greeningAuthority 阿拉伯与边界', () => {
  it.each(['1', '2', '10', '20'])('G2 养护%s年→%s', (raw) => {
    const model = factsOf({ bills: [factOf({ value: `养护${raw}年` })] });
    expect(extractGreeningMaintenanceAuthority(model)).toBe(Number(raw));
  });
  it('G2 养护21年超门不收', () => {
    expect(extractGreeningMaintenanceAuthority(factsOf({ bills: [factOf({ value: '养护21年' })] }))).toBeUndefined();
  });
  it('G2 养护0年不收', () => {
    expect(extractGreeningMaintenanceAuthority(factsOf({ bills: [factOf({ value: '养护0年' })] }))).toBeUndefined();
  });
  it('G2 天单位不收（混凝土养护14天）', () => {
    expect(extractGreeningMaintenanceAuthority(factsOf({ bills: [factOf({ value: '混凝土养护14天' })] }))).toBeUndefined();
  });
  it('G2 label 侧提取（value 无养护、label 有）', () => {
    const model = factsOf({ bills: [factOf({ fieldName: '绿化养护期两年', value: '按图纸' })] });
    expect(extractGreeningMaintenanceAuthority(model)).toBe(2);
  });
});

describe('G3 greeningAuthority 源优先级', () => {
  it('G3 bills 首命中即返回（billItemFacts 更晚值不采）', () => {
    const model = factsOf({
      bills: [factOf({ value: '养护两年' })],
      billItemFacts: [factOf({ value: '养护三年' })],
      preciseFacts: [factOf({ value: '养护四年' })],
      project: [factOf({ value: '养护五年' })],
    });
    expect(extractGreeningMaintenanceAuthority(model)).toBe(2);
  });
  it('G3 bills 无命中 → billItemFacts 兜底', () => {
    const model = factsOf({ bills: [factOf({ value: '无养护内容' })], billItemFacts: [factOf({ value: '养护三年' })] });
    expect(extractGreeningMaintenanceAuthority(model)).toBe(3);
  });
  it('G3 前源无命中 → preciseFacts → project 逐级兜底', () => {
    const model = factsOf({ bills: [], preciseFacts: [factOf({ value: '养护四年' })], project: [factOf({ value: '养护五年' })] });
    expect(extractGreeningMaintenanceAuthority(model)).toBe(4);
    const model2 = factsOf({ project: [factOf({ value: '养护五年' })] });
    expect(extractGreeningMaintenanceAuthority(model2)).toBe(5);
  });
  it('G3 全源无命中 → undefined', () => {
    expect(extractGreeningMaintenanceAuthority(factsOf({}))).toBeUndefined();
  });
});

describe('G4 greeningMismatch 红线判定', () => {
  it('G4 无权威 → 不检测', () => {
    expect(greeningMaintenanceMismatchIssues('正文养护一年。', factsOf({}))).toEqual([]);
  });
  it('G4 正文一致不报', () => {
    const model = factsOf({ bills: [factOf({ value: '养护两年' })] });
    expect(greeningMaintenanceMismatchIssues('绿化养护期两年。', model)).toEqual([]);
  });
  it('G4 正文中文数字转换后比对', () => {
    const model = factsOf({ bills: [factOf({ value: '养护一年' })] });
    expect(greeningMaintenanceMismatchIssues('正文养护两年。', model).length).toBe(1);
  });
  it('G4 差异 >20% 报', () => {
    const model = factsOf({ bills: [factOf({ value: '养护两年' })] });
    expect(greeningMaintenanceMismatchIssues('正文养护三年。', model).length).toBe(1);
  });
  it('G4 多口径一处差异只报差异值', () => {
    const model = factsOf({ bills: [factOf({ value: '养护两年' })] });
    const issues = greeningMaintenanceMismatchIssues('正文养护两年。另一处养护五年。', model);
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('5年');
    expect(issues[0].message).not.toContain('2年');
  });
});

describe('G5 greeningMismatch 阈值边界与豁免', () => {
  it.each([
    ['2', '3', true], ['2', '2', false], ['10', '13', true], ['10', '12', true], ['10', '8', true], ['10', '7', true], ['5', '6', true], ['5', '7', true],
  ] as const)('G5 权威%s 正文%s 报=%s', (authority, body, expectIssue) => {
    const model = factsOf({ bills: [factOf({ value: `养护${authority}年` })] });
    const issues = greeningMaintenanceMismatchIssues(`绿化养护期${body}年。`, model);
    expect(issues.length > 0).toBe(expectIssue);
  });
  it('G5 正文窗口 16 字内采集、17 字外不采', () => {
    const model = factsOf({ bills: [factOf({ value: '养护一年' })] });
    const within = `养护${'甲'.repeat(16)}三年`;
    const beyond = `养护${'甲'.repeat(17)}三年`;
    expect(greeningMaintenanceMismatchIssues(within, model).length).toBe(1);
    expect(greeningMaintenanceMismatchIssues(beyond, model)).toEqual([]);
  });
  it('G5 否定声明句豁免（不再出现）', () => {
    const model = factsOf({ bills: [factOf({ value: '养护两年' })] });
    expect(greeningMaintenanceMismatchIssues('统一为两年，不再出现养护一年。', model)).toEqual([]);
  });
  it('G5 否定豁免超行界不生效', () => {
    const model = factsOf({ bills: [factOf({ value: '养护两年' })] });
    const md = '本行声明不再出现矛盾口径。\n正文养护五年。';
    expect(greeningMaintenanceMismatchIssues(md, model).length).toBe(1);
  });
});

// ── H. 路灯数量权威提取与红线（extractStreetLightAuthority / streetLightCountMismatchIssues）──

describe('H1 streetLightAuthority 提取谱系', () => {
  it.each(['套', '盏', '杆'])('H1 单位“%s”提取', (unit) => {
    const model = factsOf({ billItemFacts: [factOf({ fieldName: '路灯', value: `路灯 | 特征｜工程量：10${unit}` })] });
    expect(extractStreetLightAuthority(model)).toBe(10);
  });
  it('H1 多行求和（103+15=118）', () => {
    const model = factsOf({ billItemFacts: [
      factOf({ fieldName: '路灯A型', value: '路灯A型 | 工程量：103套' }),
      factOf({ fieldName: '路灯B型', value: '路灯B型 | 工程量：15套' }),
    ] });
    expect(extractStreetLightAuthority(model)).toBe(118);
  });
  it('H1 行级条目特征描述含套字不误采（取工程量段）', () => {
    const model = factsOf({ billItemFacts: [factOf({ fieldName: '路灯', value: '路灯灯套配套安装｜工程量：8套' })] });
    expect(extractStreetLightAuthority(model)).toBe(8);
  });
  it('H1 无行级条目 → bills+preciseFacts 兑底', () => {
    const model = factsOf({ bills: [factOf({ fieldName: '路灯', value: '12盏' })], preciseFacts: [factOf({ fieldName: '路灯', value: '6盏' })] });
    expect(extractStreetLightAuthority(model)).toBe(18);
  });
  it('H1 兑底路径同对象引用去重（不重复求和）', () => {
    const shared = factOf({ fieldName: '路灯', value: '12盏' });
    const model = factsOf({ bills: [shared], preciseFacts: [shared] });
    expect(extractStreetLightAuthority(model)).toBe(12);
  });
  it('H1 标签无路灯不采', () => {
    const model = factsOf({ billItemFacts: [factOf({ fieldName: '庭院灯', value: '10套' })] });
    expect(extractStreetLightAuthority(model)).toBeUndefined();
  });
});

describe('H2 streetLightMismatch 红线判定', () => {
  it('H2 无权威 → 不检测', () => {
    expect(streetLightCountMismatchIssues('正文路灯10套。', factsOf({}))).toEqual([]);
  });
  it('H2 正文一致不报', () => {
    const model = factsOf({ billItemFacts: [factOf({ fieldName: '路灯', value: '工程量：100套' })] });
    expect(streetLightCountMismatchIssues('路灯共100套。', model)).toEqual([]);
  });
  it('H2 正文分型号多值求和比对（17+3=20 vs 权威30）', () => {
    const model = factsOf({ billItemFacts: [factOf({ fieldName: '路灯', value: '工程量：30套' })] });
    const issues = streetLightCountMismatchIssues('100W路灯17套，120W路灯3套。', model);
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('20 套');
  });
  it('H2 无容差：任何不同数值即报（authority=100）', () => {
    const model = factsOf({ billItemFacts: [factOf({ fieldName: '路灯', value: '工程量：100套' })] });
    expect(streetLightCountMismatchIssues('路灯80套。', model).length).toBe(1);
    expect(streetLightCountMismatchIssues('路灯79套。', model).length).toBe(1);
    expect(streetLightCountMismatchIssues('路灯120套。', model).length).toBe(1);
    expect(streetLightCountMismatchIssues('路灯121套。', model).length).toBe(1);
  });
});

describe('H3 streetLightMismatch 豁免谱系', () => {
  it('H3 分批语境豁免（2批每批10套）', () => {
    const model = factsOf({ billItemFacts: [factOf({ fieldName: '路灯', value: '工程量：118套' })] });
    expect(streetLightCountMismatchIssues('路灯分2批每批10套进场。', model)).toEqual([]);
  });
  it('H3 否定声明句豁免', () => {
    const model = factsOf({ billItemFacts: [factOf({ fieldName: '路灯', value: '工程量：118套' })] });
    expect(streetLightCountMismatchIssues('不再出现路灯17套的表述。', model)).toEqual([]);
  });
  it('H3 正文窗口 28 字内采集、29 字外不采', () => {
    const model = factsOf({ billItemFacts: [factOf({ fieldName: '路灯', value: '工程量：10套' })] });
    expect(streetLightCountMismatchIssues(`路灯${'甲'.repeat(28)}99套`, model).length).toBe(1);
    expect(streetLightCountMismatchIssues(`路灯${'甲'.repeat(29)}99套`, model)).toEqual([]);
  });
});

// ── I. 规格错位检测（specLocationMismatchIssues）──

function specMap(entries: Record<string, Array<[string, string]>>): SpecAuthorityMap {
  const map: SpecAuthorityMap = {};
  for (const [dimension, placements] of Object.entries(entries)) {
    map[dimension] = placements.map(([location, spec]) => ({ location, spec, sourceFile: '清单' }));
  }
  return map;
}

describe('I1 specLocation 类型谱系', () => {
  it('I1 C标号错位报（垫层C20 vs 权威C15）', () => {
    const map = specMap({ 混凝土强度等级: [['垫层', 'C15'], ['主体', 'C35']] });
    const issues = specLocationMismatchIssues('垫层采用C20混凝土。', map);
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('C20');
  });
  it('I1 权威命中不报', () => {
    const map = specMap({ 混凝土强度等级: [['垫层', 'C15'], ['主体', 'C35']] });
    expect(specLocationMismatchIssues('垫层采用C15混凝土。', map)).toEqual([]);
  });
  it('I1 mm 规格错位报', () => {
    const map = specMap({ 保温板厚度: [['屋面', '120mm'], ['外墙', '30mm']] });
    expect(specLocationMismatchIssues('屋面采用200mm保温板。', map).length).toBe(1);
  });
  it('I1 HRB 钢筋规格错位报', () => {
    const map = specMap({ 钢筋牌号: [['主体', 'HRB400'], ['箍筋', 'HPB300']] });
    expect(specLocationMismatchIssues('主体采用HRB335钢筋。', map).length).toBe(1);
  });
  it('I1 同类型过滤（垫层权威C15，正文mm不比对）', () => {
    const map = specMap({ 混凝土强度等级: [['垫层', 'C15']] });
    expect(specLocationMismatchIssues('垫层厚度200mm。', map)).toEqual([]);
  });
  it('I1 未知类型规格跳过（quantity 等不可推导）', () => {
    const map = specMap({ 特殊项: [['垫层', 'Q235']] });
    expect(specLocationMismatchIssues('垫层采用Q235。', map)).toEqual([]);
  });
});

describe('I2 specLocation 结构门', () => {
  it('I2 无 map 不检测', () => {
    expect(specLocationMismatchIssues('垫层采用C20混凝土。', undefined)).toEqual([]);
  });
  it('I2 单 placement 维度跳过', () => {
    const map = specMap({ 混凝土强度等级: [['垫层', 'C15']] });
    expect(specLocationMismatchIssues('垫层采用C20混凝土。', map)).toEqual([]);
  });
  it('I2 location 单字跳过', () => {
    const map = specMap({ 混凝土强度等级: [['垫', 'C15'], ['主体', 'C35']] });
    expect(specLocationMismatchIssues('垫采用C20混凝土。', map)).toEqual([]);
  });
  it('I2 窗口 40 字内采、41 字外不采', () => {
    const map = specMap({ 混凝土强度等级: [['垫层', 'C15'], ['主体', 'C35']] });
    expect(specLocationMismatchIssues(`垫层${'甲'.repeat(40)}C20`, map).length).toBe(1);
    expect(specLocationMismatchIssues(`垫层${'甲'.repeat(41)}C20`, map)).toEqual([]);
  });
});

describe('I3 specLocation 豁免谱系', () => {
  const map = specMap({ 混凝土强度等级: [['垫层', 'C15'], ['主体', 'C35']] });
  it('I3 跨工序切换豁免（再浇筑C30）', () => {
    expect(specLocationMismatchIssues('垫层完成后，再浇筑C30混凝土。', map)).toEqual([]);
  });
  it('I3 工艺参数豁免（分层浇筑C30）', () => {
    expect(specLocationMismatchIssues('垫层按分层浇筑工艺采用C30。', map)).toEqual([]);
  });
  it('I3 窗口枚举声明豁免（分别为）', () => {
    expect(specLocationMismatchIssues('垫层与主体分别为C15、C35。', map)).toEqual([]);
  });
  it('I3 前文枚举声明豁免（分别用于在40字前文）', () => {
    const md = '按C30、C25两个强度等级分别用于道路面层及垫层部位。垫层采用C30混凝土。';
    expect(specLocationMismatchIssues(md, map)).toEqual([]);
  });
  it('I3 偏差值豁免（标高偏差不超过±200mm）', () => {
    const mmMap = specMap({ 垫层厚度: [['垫层', '300mm'], ['主体', '500mm']] });
    expect(specLocationMismatchIssues('垫层槽底标高偏差不超过±200mm。', mmMap)).toEqual([]);
  });
  it('I3 范围内豁免', () => {
    const mmMap = specMap({ 垫层厚度: [['垫层', '300mm'], ['主体', '500mm']] });
    expect(specLocationMismatchIssues('垫层槽底200mm范围内人工清底。', mmMap)).toEqual([]);
  });
  it('I3 工作宽度豁免', () => {
    const mmMap = specMap({ 垫层厚度: [['垫层', '300mm'], ['主体', '500mm']] });
    expect(specLocationMismatchIssues('垫层两侧各200mm工作宽度。', mmMap)).toEqual([]);
  });
  it('I3 顿号枚举豁免（200mm、150mm）', () => {
    const mmMap = specMap({ 垫层厚度: [['垫层', '300mm'], ['主体', '500mm']] });
    expect(specLocationMismatchIssues('垫层厚度200mm、150mm。', mmMap)).toEqual([]);
  });
});

describe('I4 specLocation 报障上限', () => {
  it('I4 多错只报 8（slice 8）', () => {
    const map = specMap({ 混凝土强度等级: [['垫层', 'C15'], ['主体', 'C35']] });
    const lines = Array.from({ length: 10 }, () => '垫层采用C20混凝土。');
    expect(specLocationMismatchIssues(lines.join('\n'), map).length).toBe(8);
  });
});

// ── J. 编造奖项检测（fabricatedAwardIssues）──

describe('J1 fabricatedAward 白名单判定', () => {
  it('J1 白名单命中不报', () => {
    const model = factsOf({ quality: [factOf({ value: '确保黄山杯' })] });
    expect(fabricatedAwardIssues('创优目标：确保黄山杯。', model)).toEqual([]);
  });
  it('J1 白名单外奖项报', () => {
    const model = factsOf({ quality: [factOf({ value: '确保黄山杯' })] });
    const issues = fabricatedAwardIssues('创优目标：鲁班奖。', model);
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('鲁班奖');
  });
  it('J1 白名单空 → 不检测', () => {
    expect(fabricatedAwardIssues('创优目标：黄山杯。', factsOf({}))).toEqual([]);
  });
  it('J1 前缀剥离口径统一（确保获得黄山杯 vs 确保黄山杯）', () => {
    const model = factsOf({ quality: [factOf({ value: '确保黄山杯' })] });
    expect(fabricatedAwardIssues('创优目标：确保获得黄山杯。', model)).toEqual([]);
  });
  it('J1 贪婪 10 字窗口吞前文时不在白名单报（行为锁定）', () => {
    const model = factsOf({ quality: [factOf({ value: '确保黄山杯' })] });
    const issues = fabricatedAwardIssues('本工程质量目标为确保黄山杯。', model);
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('质量目标为确保黄山杯');
  });
});

describe('J2 fabricatedAward 白名单源谱系', () => {
  const md = '质量标准：黄山杯。';
  it.each(['project', 'schedule'] as const)('J2 factsModel.%s 事实卡入白名单', (source) => {
    const model = factsOf({ [source]: [factOf({ value: '确保黄山杯' })] });
    expect(fabricatedAwardIssues(md, model)).toEqual([]);
  });
  it('J2 tenderRequirements.awardObjectives 入白名单', () => {
    const model = factsOf({
      tenderRequirements: {
        awardObjectives: [{ text: '确保黄山杯', coreTerms: [] }],
        specialQualityStandards: [], awardClauses: [], systematicBenchmarks: [], prohibitionNotes: [],
        frontScheduleClauses: [], dateFabricationProhibited: false, extracted: true,
      },
    });
    expect(fabricatedAwardIssues(md, model)).toEqual([]);
  });
  it('J2 tenderRequirements.specialQualityStandards / awardClauses 入白名单', () => {
    const model = factsOf({
      tenderRequirements: {
        awardObjectives: [], specialQualityStandards: [{ text: '确保获得黄山杯', coreTerms: [] }],
        awardClauses: [], systematicBenchmarks: [], prohibitionNotes: [], frontScheduleClauses: [],
        dateFabricationProhibited: false, extracted: true,
      },
    });
    expect(fabricatedAwardIssues(md, model)).toEqual([]);
  });
  it('J2 tenderRequirements.extracted=false 不采白名单（无白名单不检测）', () => {
    const model = factsOf({ tenderRequirements: { awardObjectives: [{ text: '确保黄山杯', coreTerms: [] }] } as never });
    expect(fabricatedAwardIssues(md, model)).toEqual([]);
  });
});

describe('J3 fabricatedAward 通用目标豁免', () => {
  const generics = ['优质工程奖', '文明工地奖', '省优奖', '市优奖', '精品工程奖', '结构优质奖'];
  it.each(generics)('J3 “%s”通用目标不报', (award) => {
    const model = factsOf({ quality: [factOf({ value: '确保黄山杯' })] });
    expect(fabricatedAwardIssues(`创优目标为${award}。`, model)).toEqual([]);
  });
});

describe('J4 fabricatedAward 词面门', () => {
  it('J4 负向前瞻（奖励/奖金不匹配）', () => {
    const model = factsOf({ quality: [factOf({ value: '确保黄山杯' })] });
    expect(fabricatedAwardIssues('本工程设置奖励金。', model)).toEqual([]);
  });
  it('J4 多个杜撰奖项合并报告', () => {
    const model = factsOf({ quality: [factOf({ value: '确保黄山杯' })] });
    const issues = fabricatedAwardIssues('确保鲁班奖与詹天佑奖。', model);
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('鲁班奖');
    expect(issues[0].message).toContain('詹天佑奖');
  });
  it('J4 白名单词混在句中不误判（fact 值含奖项词）', () => {
    const model = factsOf({ project: [factOf({ value: '质量标准争创黄山杯' })] });
    expect(fabricatedAwardIssues('质量标准争创黄山杯。', model)).toEqual([]);
  });
});

// ── K. 资格章节串章检测（bidderQualificationSectionIssues）──

describe('K1 qualification 句式谱系', () => {
  const formA = ['具备有效的营业执照', '具备相应的资质证书', '具备满足要求的安全生产许可证'];
  it.each(formA)('K1 “%s”形态A命中', (title) => {
    expect(bidderQualificationSectionIssues(`## ${title}`).length).toBe(1);
  });
  it('K1 形态B 提供句命中', () => {
    expect(bidderQualificationSectionIssues('## 须提供有效的营业执照证明').length).toBe(1);
    expect(bidderQualificationSectionIssues('## 提供审计报告材料').length).toBe(1);
  });
  it('K1 编号前缀剥离（6.6 具备有效的…）', () => {
    expect(bidderQualificationSectionIssues('### 6.6 具备有效的营业执照').length).toBe(1);
  });
});

describe('K2 qualification 词表+技术语境豁免', () => {
  const qualificationWords = ['营业执照核验', '资质证书', '安全生产许可证', '资格预审', '资格审查', '资质审查', '财务状况说明', '业绩证明', '业绩要求', '银行资信', '审计报告', '信用记录', '信用评价', '不良行为记录', '联合体投标', '联合体协议'];
  it.each(qualificationWords)('K2 “%s”无技术语境命中', (title) => {
    expect(bidderQualificationSectionIssues(`## ${title}`).length).toBe(1);
  });
  it.each(['营业执照管理措施', '资质证书技术复核', '安全生产许可证施工应用', '审计报告编制流程', '信用评价管理体系'])('K2 “%s”技术语境豁免', (title) => {
    expect(bidderQualificationSectionIssues(`## ${title}`)).toEqual([]);
  });
});

describe('K3 qualification 标题层级与汇总', () => {
  it('K3 H2~H4 命中、H1/H5 不查', () => {
    expect(bidderQualificationSectionIssues('### 具备有效的营业执照').length).toBe(1);
    expect(bidderQualificationSectionIssues('# 具备有效的营业执照')).toEqual([]);
    expect(bidderQualificationSectionIssues('##### 具备有效的营业执照')).toEqual([]);
  });
  it('K3 多个资格标题去重合并、显示前三', () => {
    const md = '## 具备有效的营业执照\n### 具备有效的资质证书\n#### 具备有效的安全生产许可证\n### 具备有效的营业执照';
    const issues = bidderQualificationSectionIssues(md);
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('营业执照');
    expect(issues[0].message).toContain('资质证书');
    expect(issues[0].message).toContain('安全生产许可证');
  });
  it('K3 无资格小节不报', () => {
    expect(bidderQualificationSectionIssues('## 施工组织与部署\n### 施工方案')).toEqual([]);
  });
});

// ── L. 人材机章层级检测（resourceTriadSectionHierarchyIssues）──

describe('L1 resourceTriad 章标题谱系', () => {
  const chapterTitles = ['确保人、材、机的保障体系与措施', '人,材,机保障体系与措施', '人，材，机的保障体系与措施'];
  it.each(chapterTitles)('L1 章标题“%s”识别', (title) => {
    const md = `## ${title}\n### 确保人的保障体系与措施\n### 确保材的保障体系与措施\n### 确保机的保障体系与措施`;
    expect(resourceTriadSectionHierarchyIssues(md)).toEqual([]);
  });
  it('L1 非人材机章不检测', () => {
    const md = '## 施工组织与部署\n### 只有一个小节';
    expect(resourceTriadSectionHierarchyIssues(md)).toEqual([]);
  });
});

describe('L2 resourceTriad subject 提取谱系', () => {
  it('L2 标准形态（确保X的保障体系与措施）', () => {
    const md = '## 人、材、机保障\n### 确保人的保障体系与措施\n### 材的保障体系与措施\n### 确保机械的保障体系与措施';
    expect(resourceTriadSectionHierarchyIssues(md)).toEqual([]);
  });
  it('L2 带员/力/料/械/工后缀', () => {
    const md = '## 人、材、机保障\n### 人员的保障体系与措施\n### 材料的保障体系与措施\n### 机械的保障体系与措施';
    expect(resourceTriadSectionHierarchyIssues(md)).toEqual([]);
  });
  it('L2 退化形态词映射（劳动力→人、物资→材、设备→机）', () => {
    const md = '## 人、材、机保障\n### 劳动力配置\n### 物资供应\n### 设备选型';
    expect(resourceTriadSectionHierarchyIssues(md)).toEqual([]);
  });
  it('L2 无主语标题不计入三节', () => {
    const md = '## 人、材、机保障\n### 人的保障体系与措施\n### 材的保障体系与措施\n### 综合说明';
    expect(resourceTriadSectionHierarchyIssues(md).length).toBe(1);
  });
});

describe('L3 resourceTriad H4 挂错层级', () => {
  it('L3 材挂人下报（3×3 谱系）', () => {
    const md = '## 人、材、机保障\n### 确保人的保障体系与措施\n#### 材料的保障体系与措施\n### 确保材的保障体系与措施\n### 确保机的保障体系与措施';
    const issues = resourceTriadSectionHierarchyIssues(md);
    expect(issues.some(issue => issue.message.includes('层级错位'))).toBe(true);
  });
  it('L3 机挂材下报', () => {
    const md = '## 人、材、机保障\n### 确保人的保障体系与措施\n### 确保材的保障体系与措施\n#### 设备保障\n### 确保机的保障体系与措施';
    expect(resourceTriadSectionHierarchyIssues(md).some(issue => issue.message.includes('层级错位'))).toBe(true);
  });
  it('L3 H4 主语相同不报', () => {
    const md = '## 人、材、机保障\n### 确保人的保障体系与措施\n#### 人员配置细化\n### 确保材的保障体系与措施\n### 确保机的保障体系与措施';
    expect(resourceTriadSectionHierarchyIssues(md)).toEqual([]);
  });
  it('L3 H4 无 currentH3 subject 不报', () => {
    const md = '## 人、材、机保障\n#### 材料保障\n### 确保人的保障体系与措施\n### 确保材的保障体系与措施\n### 确保机的保障体系与措施';
    expect(resourceTriadSectionHierarchyIssues(md)).toEqual([]);
  });
});

describe('L4 resourceTriad 三节完整性', () => {
  it('L4 仅一节报不完整', () => {
    const md = '## 人、材、机保障\n### 确保人的保障体系与措施';
    const issues = resourceTriadSectionHierarchyIssues(md);
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('仅 1 个二级小节');
  });
  it('L4 缺机报不完整', () => {
    const md = '## 人、材、机保障\n### 确保人的保障体系与措施\n### 确保材的保障体系与措施';
    expect(resourceTriadSectionHierarchyIssues(md).length).toBe(1);
  });
  it('L4 章区间闭合（下一##截断）', () => {
    const md = '## 人、材、机保障\n### 确保人的保障体系与措施\n## 下一章\n### 确保材的保障体系与措施\n### 确保机的保障体系与措施';
    const issues = resourceTriadSectionHierarchyIssues(md);
    expect(issues.some(issue => issue.message.includes('仅 1 个'))).toBe(true);
  });
});

// ── M. 权威口径提取（extractScheduleAuthority / extractAssemblyRateAuthority / extractProjectScaleSummary）──

describe('M1 scheduleAuthority 提取谱系', () => {
  it('M1 事实卡混合口径长句取首个N日历天', () => {
    const model = factsOf({ schedule: [factOf({ fieldName: '计划工期', value: '开工日期2026年3月1日，计划工期210日历天' })] });
    expect(extractScheduleAuthority(model)).toBe(210);
  });
  it('M1 「个」可省略', () => {
    const model = factsOf({ schedule: [factOf({ fieldName: '工期', value: '540个日历天' })] });
    expect(extractScheduleAuthority(model)).toBe(540);
  });
  it('M1 label 不含工期/周期不采', () => {
    const model = factsOf({ schedule: [factOf({ fieldName: '其他说明', value: '45日历天' })] });
    expect(extractScheduleAuthority(model)).toBeUndefined();
  });
  it('M1 canonical.schedule 兜底', () => {
    const model = factsOf({ canonical: { schedule: { s: { label: '计划工期', value: '45日历天' } } } as never });
    expect(extractScheduleAuthority(model)).toBe(45);
  });
  it('M1 canonical 数组形态取 [0]', () => {
    const model = factsOf({ canonical: { schedule: { s: [{ label: '计划工期', value: '300日历天' }] } } as never });
    expect(extractScheduleAuthority(model)).toBe(300);
  });
  it('M1 全源无 → undefined', () => {
    expect(extractScheduleAuthority(factsOf({}))).toBeUndefined();
  });
});

describe('M2 assemblyRateAuthority 提取谱系', () => {
  it('M2 project/bills/preciseFacts 三源', () => {
    expect(extractAssemblyRateAuthority(factsOf({ project: [factOf({ fieldName: '装配率', value: '30%' })] }))).toBe(30);
    expect(extractAssemblyRateAuthority(factsOf({ bills: [factOf({ key: 'assembly_rate', value: '装配率38.4%' })] }))).toBe(38.4);
    expect(extractAssemblyRateAuthority(factsOf({ preciseFacts: [factOf({ fieldName: '装配率', value: '45%' })] }))).toBe(45);
  });
  it('M2 label 不含装配率不采（value 含率字也不采）', () => {
    expect(extractAssemblyRateAuthority(factsOf({ project: [factOf({ fieldName: '其他', value: '30%' })] }))).toBeUndefined();
    expect(extractAssemblyRateAuthority(factsOf({ project: [factOf({ value: '装配率45%' })] }))).toBeUndefined();
  });
  it('M2 tenderRequirements.assemblyRate.text 兜底', () => {
    const model = factsOf({ tenderRequirements: { assemblyRate: { text: '装配率不低于38.4%' } } as never });
    expect(extractAssemblyRateAuthority(model)).toBe(38.4);
  });
  it('M2 数值门（0/101 不收）', () => {
    expect(extractAssemblyRateAuthority(factsOf({ project: [factOf({ fieldName: '装配率', value: '0%' })] }))).toBeUndefined();
    expect(extractAssemblyRateAuthority(factsOf({ project: [factOf({ fieldName: '装配率', value: '101%' })] }))).toBeUndefined();
  });
});

describe('M3 projectScaleSummary 提取谱系', () => {
  it('M3 单体建筑面积+层数组合', () => {
    const model = factsOf({ project: [factOf({ fieldName: '单体建筑面积', value: '总建筑面积12345.67平方米，地上18层，地下2层' })] });
    expect(extractProjectScaleSummary(model)).toBe('建筑面积12345.67平方米、地上18层、地下2层');
  });
  it('M3 面积单位三态（㎡/m²/平方）', () => {
    expect(extractProjectScaleSummary(factsOf({ project: [factOf({ fieldName: '建设规模', value: '5000㎡' })] }))).toBe('建筑面积5000平方米');
    expect(extractProjectScaleSummary(factsOf({ project: [factOf({ fieldName: '建设规模', value: '6000m²' })] }))).toBe('建筑面积6000平方米');
    expect(extractProjectScaleSummary(factsOf({ project: [factOf({ fieldName: '建设规模', value: '7000平方' })] }))).toBe('建筑面积7000平方米');
  });
  it('M3 缺面积仅层数', () => {
    const model = factsOf({ project: [factOf({ fieldName: '其他', value: '地下2层' })] });
    expect(extractProjectScaleSummary(model)).toBe('地下2层');
  });
  it('M3 层数来自 drawings/tables 文本', () => {
    const model = factsOf({ drawings: [factOf({ value: '地上12层' })], tables: [] as never });
    expect(extractProjectScaleSummary(model)).toBe('地上12层');
  });
  it('M3 全缺 → undefined', () => {
    expect(extractProjectScaleSummary(factsOf({}))).toBeUndefined();
  });
});
