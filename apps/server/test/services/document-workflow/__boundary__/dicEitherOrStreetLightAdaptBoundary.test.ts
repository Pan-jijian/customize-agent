/**
 * dicEitherOrStreetLightAdaptBoundary：第二十五批（BB 组）覆盖最浅导出深挖。
 * 与既有基线互补、不重复：
 *  - BB1 fixAmbiguousEitherOrCandidates：三规则顺序互作/多处计数/details 形态（基线 G1/K2 只测单规则命中）；
 *  - BB2 fixForbiddenConfigurationTerms：多处计数/邻接标点/空格变体/幂等（基线 H1/K3 只测单处命中）；
 *  - BB3 streetLightCountMismatchIssues：20% 容差另一侧精确边界/盏杆单位/负号吞入/多值求和/换行表格阻断
 *    （基线 H 段只测 79/80/120/121 四边界与批豁免）；
 *  - BB4 ambiguousEitherOrIssues：形态B 悬置词七谱系/截断/全角括号/形态C 左组非贪婪与右组吞并/三形态聚合
 *    （基线 S1 已测窗口边界与词族谱系，本组测未覆盖形态）；
 *  - BB5 localAdaptationKeywordIssues：label 七谱系/城市 16 谱系/语义逐 query 门控/绿色门与劳务门词谱系
 *    （基线 D4 只测建设地点 label 与合肥）；
 *  - BB6 stripCommercialDataSentences：商务词 9 谱系/税率 12 字窗口边界/！不分句连带删除/句后标题表格行保留
 *    （基线 E 段只测部分词与常规形态）。
 * 全部为确定性正则提取与词面判定，BB5 语义判定用恒值/门控模拟器锁定。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ambiguousEitherOrIssues, fixAmbiguousEitherOrCandidates, fixForbiddenConfigurationTerms,
  localAdaptationKeywordIssues, streetLightCountMismatchIssues, stripCommercialDataSentences,
} from '@/services/document-workflow/documentIntegrityChecks';
import { buildSemanticSimilarity } from '@/services/document-workflow/semanticSimilarity';
import type { DocumentFactsModel } from '@/services/document-workflow/types';
import { factOf, factsOf } from './boundaryKit';

vi.mock('@/services/document-workflow/semanticSimilarity', () => ({
  buildSemanticSimilarity: vi.fn(),
  SEMANTIC_COVERAGE_THRESHOLD: 0.6,
}));

/** 恒值语义模拟器：全部 query 对任意句返回同值 */
const CONST_SIM = (value: number) => async (_queries: unknown, _sentences: unknown) => (_left: string, _right: string): number => value;
/** 门控语义模拟器：按 query 文本（left）决定分值，精确锁定逐 query 判定 */
const GATED_SIM = (gate: (queryText: string) => number) => async (queries: string[], _sentences: unknown) => (left: string, _right: string): number => gate(left);

// ── BB1. fixAmbiguousEitherOrCandidates：三规则顺序互作与多处计数 ──

describe('BB1 fixAmbiguousEitherOr 规则互作与计数', () => {
  it('BB1 同规则多处（放坡或支护 ×2）计数与 details 处数', () => {
    const result = fixAmbiguousEitherOrCandidates('放坡或支护。放坡或支护。');
    expect(result.markdown).toBe('放坡支护。放坡支护。');
    expect(result.fixedCount).toBe(2);
    expect(result.details).toEqual(['放坡支护两可归一 2 处']);
  });
  it('BB1 规则1 同句两处（分号隔开）', () => {
    const result = fixAmbiguousEitherOrCandidates('钢板桩或型钢支撑支护；钢板桩或型钢支撑支护。');
    expect(result.markdown).toBe('钢板桩支护；钢板桩支护。');
    expect(result.fixedCount).toBe(2);
    expect(result.details).toEqual(['钢板桩型钢两可归一为钢板桩 2 处']);
  });
  it('BB1 规则2+3 同句各命中 → details 按规则表顺序', () => {
    const result = fixAmbiguousEitherOrCandidates('放坡或钢板桩支护；放坡或支护。');
    expect(result.markdown).toBe('1:0.5放坡加钢板桩支护；放坡支护。');
    expect(result.fixedCount).toBe(2);
    expect(result.details).toEqual(['放坡钢板桩两可归一为组合支护 1 处', '放坡支护两可归一 1 处']);
  });
  it('BB1 三规则全命中 → 三 details 顺序固定', () => {
    const result = fixAmbiguousEitherOrCandidates('钢板桩或型钢支撑支护。放坡或钢板桩支护。放坡或支护。');
    expect(result.markdown).toBe('钢板桩支护。1:0.5放坡加钢板桩支护。放坡支护。');
    expect(result.fixedCount).toBe(3);
    expect(result.details).toHaveLength(3);
  });
  it('BB1 规则2 产物不重匹配（1:0.5放坡加钢板桩支护 保持一次替换结果）', () => {
    const result = fixAmbiguousEitherOrCandidates('放坡或钢板桩支护。');
    expect(result.markdown).toBe('1:0.5放坡加钢板桩支护。');
    expect(result.fixedCount).toBe(1);
  });
  it('BB1 或字前置形态「或放坡支护」不命中', () => {
    expect(fixAmbiguousEitherOrCandidates('基坑或放坡支护。').fixedCount).toBe(0);
  });
  it('BB1 「放坡或钢板桩」无支护尾词不命中', () => {
    expect(fixAmbiguousEitherOrCandidates('基坑采用放坡或钢板桩。').fixedCount).toBe(0);
  });
  it('BB1 规则1 与规则3 邻接（逗号同段）各命中', () => {
    const result = fixAmbiguousEitherOrCandidates('钢板桩或型钢支撑支护，放坡或支护。');
    expect(result.markdown).toBe('钢板桩支护，放坡支护。');
    expect(result.fixedCount).toBe(2);
  });
  it('BB1 空串零命中', () => {
    const result = fixAmbiguousEitherOrCandidates('');
    expect(result).toEqual({ markdown: '', fixedCount: 0, details: [] });
  });
});

// ── BB2. fixForbiddenConfigurationTerms：多处计数与形态边界 ──

describe('BB2 fixForbiddenConfigurationTerms 形态边界', () => {
  it('BB2 同段两处 → 计数 2 处', () => {
    const result = fixForbiddenConfigurationTerms('，将报公共资源交易监督管理部门处理。处理，将报公共资源交易监督管理部门处理。');
    expect(result.fixedCount).toBe(2);
    expect(result.markdown).toBe('，由招标人按招标文件规定程序处理。处理，由招标人按招标文件规定程序处理。');
    expect(result.details).toEqual(['公共资源交易监督管理 2 处']);
  });
  it('BB2 句号邻接（无逗号前缀）不命中', () => {
    expect(fixForbiddenConfigurationTerms('。将报公共资源交易监督管理部门处理。').fixedCount).toBe(0);
  });
  it('BB2 中间空格变体不命中', () => {
    expect(fixForbiddenConfigurationTerms('，将报公共资源交易监督管理 部门处理。').fixedCount).toBe(0);
  });
  it('BB2 缺尾词「部门处理」不命中', () => {
    expect(fixForbiddenConfigurationTerms('，将报公共资源交易监督管理。').fixedCount).toBe(0);
  });
  it('BB2 替换产物幂等（二次运行零命中）', () => {
    const once = fixForbiddenConfigurationTerms('，将报公共资源交易监督管理部门处理。');
    const twice = fixForbiddenConfigurationTerms(once.markdown);
    expect(twice.fixedCount).toBe(0);
    expect(twice.markdown).toBe(once.markdown);
  });
  it('BB2 一处命中一处变体 → 只计 1 处', () => {
    const result = fixForbiddenConfigurationTerms('，将报公共资源交易监督管理部门处理；将报公共资源交易监督管理 部门处理。');
    expect(result.fixedCount).toBe(1);
    expect(result.details).toEqual(['公共资源交易监督管理 1 处']);
  });
});

// ── BB3. streetLightCountMismatchIssues：容差另一侧/单位谱系/求和口径 ──

describe('BB3 streetLightCountMismatch 容差与单位深挖', () => {
  const authorityOf = (count: number): DocumentFactsModel => factsOf({ billItemFacts: [factOf({ key: '路灯', value: `路灯｜工程量：${count}套` })] });
  it('BB3 authority=50 下界恰 20%（40套）→ 豁免', () => {
    expect(streetLightCountMismatchIssues('路灯40套。', authorityOf(50))).toEqual([]);
  });
  it('BB3 authority=50 下界突破（39套）→ 报', () => {
    expect(streetLightCountMismatchIssues('路灯39套。', authorityOf(50)).length).toBe(1);
  });
  it('BB3 authority=5 小数容差恰界（4套，差1≤1）→ 豁免', () => {
    expect(streetLightCountMismatchIssues('路灯4套。', authorityOf(5))).toEqual([]);
  });
  it('BB3 authority=5 突破（3套，差2>1）→ 报', () => {
    expect(streetLightCountMismatchIssues('路灯3套。', authorityOf(5)).length).toBe(1);
  });
  it('BB3 盏单位入池（15盏 vs 100）→ 报', () => {
    expect(streetLightCountMismatchIssues('路灯15盏。', authorityOf(100)).length).toBe(1);
  });
  it('BB3 杆单位入池（100杆 vs 100）→ 豁免', () => {
    expect(streetLightCountMismatchIssues('路灯100杆。', authorityOf(100))).toEqual([]);
  });
  it('BB3 三单位混合多值求和（17套+3盏+2杆=22）→ 报', () => {
    expect(streetLightCountMismatchIssues('路灯17套、路灯3盏、路灯2杆。', authorityOf(100)).length).toBe(1);
  });
  it('BB3 负号吞入窗口（路灯-5套 值取 5）→ 报', () => {
    expect(streetLightCountMismatchIssues('路灯-5套。', authorityOf(100)).length).toBe(1);
  });
  it('BB3 message 百分比（150 vs 100 → 50%）', () => {
    const issues = streetLightCountMismatchIssues('路灯150套。', authorityOf(100));
    expect(issues[0].message).toContain('相差 50%');
  });
  it('BB3 message 百分比下界突破（79 vs 100 → 21%）', () => {
    const issues = streetLightCountMismatchIssues('路灯79套。', authorityOf(100));
    expect(issues[0].message).toContain('相差 21%');
  });
  it('BB3 换行阻断不匹配 → 空', () => {
    expect(streetLightCountMismatchIssues('路灯\n10套。', authorityOf(100))).toEqual([]);
  });
  it('BB3 表格行阻断（竖线）不匹配 → 空', () => {
    expect(streetLightCountMismatchIssues('| 路灯 | 10套 |', authorityOf(100))).toEqual([]);
  });
  it('BB3 否定豁免词「取消」→ 空', () => {
    expect(streetLightCountMismatchIssues('原方案取消路灯50套。', authorityOf(100))).toEqual([]);
  });
  it('BB3 同一句两个口径求和（10+90=100 vs 100）→ 豁免', () => {
    expect(streetLightCountMismatchIssues('路灯10套与路灯90套。', authorityOf(100))).toEqual([]);
  });
  it('BB3 批豁免后不再取后续数值（分2批共80套 → 空）', () => {
    expect(streetLightCountMismatchIssues('路灯分2批进场共80套。', authorityOf(100))).toEqual([]);
  });
});

// ── BB4. ambiguousEitherOrIssues：悬置词谱系/非贪婪/三形态聚合 ──

describe('BB4 ambiguousEitherOr 形态B 悬置词七谱系', () => {
  const pendingWords = ['按实实施', '按图实施', '待定', '另行确定', '视现场情况而定', '根据实际情况调整'];
  it.each(pendingWords)('BB4 悬置词「%s」→ 报', (word) => {
    expect(ambiguousEitherOrIssues(`桩基（或${word}）。`).length).toBe(1);
  });
  it('BB4 形态B 全角括号仍命中', () => {
    expect(ambiguousEitherOrIssues('桩基（或按图纸实施）。').length).toBe(1);
  });
  it('BB4 形态B 悬置内容超 30 字符 → hits 截断 30 字', () => {
    const issues = ambiguousEitherOrIssues(`桩基（或${'暂'.repeat(30)}按图纸实施）。`);
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain(`（或${'暂'.repeat(28)}`);
    expect(issues[0].message).not.toContain('按图纸实施');
  });
  it('BB4 形态B 括号内无悬置词（或采用放坡）→ 不报', () => {
    expect(ambiguousEitherOrIssues('桩基（或采用放坡）。')).toEqual([]);
  });
  it('BB4 形态B 前窗无词族词（坑不在词族）→ 不报', () => {
    expect(ambiguousEitherOrIssues('基坑（或按图纸实施）。')).toEqual([]);
  });
});

describe('BB4 ambiguousEitherOr 形态C 非贪婪与窗口锁定', () => {
  it('BB4 左组非贪婪取最左侧词族（地下连续墙或排桩）', () => {
    const issues = ambiguousEitherOrIssues('基坑采用地下连续墙或排桩。');
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('地下连续墙或排桩');
  });
  it('BB4 决策词在右组吞并（支护桩或采用钢板桩）→ 不报', () => {
    expect(ambiguousEitherOrIssues('支护桩或采用钢板桩。')).toEqual([]);
  });
  it('BB4 决策词「为」在左组前窗（基坑为放坡或支护）→ 报', () => {
    expect(ambiguousEitherOrIssues('基坑为放坡或支护。').length).toBe(1);
  });
  it('BB4 右组命中词族（采用土方或放坡）→ 报', () => {
    expect(ambiguousEitherOrIssues('采用土方或放坡。').length).toBe(1);
  });
  it('BB4 并列工序豁免（土方开挖或回填前）→ 不报', () => {
    expect(ambiguousEitherOrIssues('土方开挖或回填前。')).toEqual([]);
  });
});

describe('BB4 ambiguousEitherOr 形态A 两侧与数值豁免', () => {
  it('BB4 右侧词族不必命中（采用放坡/甲甲）→ 报', () => {
    expect(ambiguousEitherOrIssues('采用放坡/甲甲。').length).toBe(1);
  });
  it('BB4 两侧均无词族（采用土方/机械）→ 不报', () => {
    expect(ambiguousEitherOrIssues('采用土方/机械。')).toEqual([]);
  });
  it('BB4 汉字数字枚举天然豁免（五十毫米/七十毫米）→ 不报', () => {
    expect(ambiguousEitherOrIssues('采用五十毫米/七十毫米。')).toEqual([]);
  });
  it('BB4 决策词「为」在后置语境（本工程支护桩/放坡为最佳方案）→ 报', () => {
    expect(ambiguousEitherOrIssues('本工程支护桩/放坡为最佳方案。').length).toBe(1);
  });
  it('BB4 多空白归一化后命中', () => {
    expect(ambiguousEitherOrIssues('采用     放坡或支护。').length).toBe(1);
  });
  it('BB4 三形态同句聚合为 1 条 message', () => {
    const issues = ambiguousEitherOrIssues('采用支护桩/放坡。桩基（或按图纸实施）。选用喷锚或土钉墙。');
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('支护桩/放坡');
    expect(issues[0].message).toContain('（或按图纸实施）');
    expect(issues[0].message).toContain('喷锚或土钉墙');
  });
});

// ── BB5. localAdaptationKeywordIssues：label 谱系/城市谱系/门控 ──

describe('BB5 localAdaptation label 七谱系与 key 拼接', () => {
  beforeEach(() => {
    vi.mocked(buildSemanticSimilarity).mockImplementation(CONST_SIM(0.1));
  });
  const labels = ['建设地点', '工程地点', '项目地点', '实施地点', '服务地点', '交付地点', '建设地址'];
  it.each(labels)('BB5 label「%s」值含合肥 → 判安徽报创优', async (label) => {
    const facts = factsOf({ project: [factOf({ fieldName: label, value: '合肥市' })] });
    const issues = await localAdaptationKeywordIssues('建立劳务用工管理制度。', facts);
    expect(issues.map(issue => issue.message).join('')).toContain('属地创优目标缺失');
  });
  it('BB5 key 参与拼接（fieldName 空、key=建设地点）→ 判安徽', async () => {
    const facts = factsOf({ project: [factOf({ key: '建设地点', value: '芜湖市' })] });
    const issues = await localAdaptationKeywordIssues('建立劳务用工管理制度。', facts);
    expect(issues.map(issue => issue.message).join('')).toContain('属地创优目标缺失');
  });
  it('BB5 值含省名「安徽」直接判属地', async () => {
    const facts = factsOf({ project: [factOf({ fieldName: '建设地点', value: '安徽省' })] });
    const issues = await localAdaptationKeywordIssues('建立劳务用工管理制度。', facts);
    expect(issues.map(issue => issue.message).join('')).toContain('属地创优目标缺失');
  });
});

describe('BB5 localAdaptation 省内城市 16 谱系', () => {
  beforeEach(() => {
    vi.mocked(buildSemanticSimilarity).mockImplementation(CONST_SIM(0.1));
  });
  const cities = ['安徽', '芜湖', '蚌埠', '淮南', '马鞍山', '淮北', '铜陵', '安庆', '黄山', '滁州', '阜阳', '宿州', '六安', '亳州', '池州', '宣城'];
  it.each(cities)('BB5 城市「%s」判安徽 → 报创优', async (city) => {
    const value = city === '安徽' ? '安徽省' : `${city}市`;
    const facts = factsOf({ project: [factOf({ fieldName: '建设地点', value })] });
    const issues = await localAdaptationKeywordIssues('建立劳务用工管理制度。', facts);
    expect(issues.map(issue => issue.message).join('')).toContain('属地创优目标缺失');
  });
  it('BB5 无 project facts → 非安徽（仅工伤 query）', async () => {
    const issues = await localAdaptationKeywordIssues('建立劳务用工管理制度。', factsOf({}));
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('工伤保险表述缺失');
  });
});

describe('BB5 localAdaptation 语义逐 query 门控', () => {
  beforeEach(() => {
    vi.mocked(buildSemanticSimilarity).mockImplementation(GATED_SIM((query) => {
      if (/创优|优质工程/u.test(query)) return 0.9;
      return 0.1;
    }));
  });
  it('BB5 award 命中、其余缺失 → 报四节一环保与工伤（有绿色词与劳务词）', async () => {
    const facts = factsOf({ project: [factOf({ fieldName: '建设地点', value: '合肥市' })] });
    const issues = await localAdaptationKeywordIssues('落实绿色施工要求。建立劳务用工管理制度。', facts);
    expect(issues.map(issue => issue.message).join('')).toContain('四节一环保量化指标缺失');
    expect(issues.map(issue => issue.message).join('')).toContain('工伤保险表述缺失');
    expect(issues.map(issue => issue.message).join('')).not.toContain('属地创优目标缺失');
  });
});

describe('BB5 localAdaptation 绿色门与劳务门词谱系', () => {
  beforeEach(() => {
    vi.mocked(buildSemanticSimilarity).mockImplementation(CONST_SIM(0.1));
  });
  const greenWords = ['四节一环保', '绿色施工', '节水', '节材', '节能'];
  it.each(greenWords)('BB5 绿色词「%s」+无量化语义 → 报四节一环保', async (word) => {
    const facts = factsOf({ project: [factOf({ fieldName: '建设地点', value: '合肥市' })] });
    const issues = await localAdaptationKeywordIssues(`落实${word}要求。`, facts);
    expect(issues.map(issue => issue.message).join('')).toContain('四节一环保量化指标缺失');
  });
  const laborWords = ['劳务人员备案管理规范。', '农民工工资按月发放。', '工资支付保障措施落实。'];
  it.each(laborWords)('BB5 劳务门句「%s」→ 报工伤（非安徽）', async (sentence) => {
    const facts = factsOf({ project: [factOf({ fieldName: '建设地点', value: '江苏省南京市' })] });
    const issues = await localAdaptationKeywordIssues(sentence, facts);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('工伤保险表述缺失');
  });
  it('BB5 绿色词在但非安徽 → 不报四节一环保', async () => {
    const facts = factsOf({ project: [factOf({ fieldName: '建设地点', value: '江苏省南京市' })] });
    const issues = await localAdaptationKeywordIssues('落实绿色施工要求。', facts);
    expect(issues.map(issue => issue.message).join('')).not.toContain('四节一环保');
  });
});

// ── BB6. stripCommercialDataSentences：词谱系/窗口/分句边界 ──

describe('BB6 stripCommercialDataSentences 商务词 9 谱系', () => {
  const terms = ['暂列金额', '暂估价', '报价明细', '综合单价', '清单合价', '预留金', '投标报价', '异常低价', '评标基准价'];
  it.each(terms)('BB6 商务词「%s」句删除', (term) => {
    expect(stripCommercialDataSentences(`本段含${term}10万元。`)).toBe('');
  });
});

describe('BB6 stripCommercialDataSentences 税率窗口与分句边界', () => {
  it('BB6 税率后 12 字到数字 → 删', () => {
    expect(stripCommercialDataSentences(`税率${'甲'.repeat(12)}3%。`)).toBe('');
  });
  it('BB6 税率后 13 字到数字 → 保留', () => {
    const md = `税率${'甲'.repeat(13)}3%。`;
    expect(stripCommercialDataSentences(md)).toBe(md);
  });
  it('BB6 增值税后 12 字到数字 → 删', () => {
    expect(stripCommercialDataSentences(`增值税${'甲'.repeat(12)}13%。`)).toBe('');
  });
  it('BB6 多 part 连续删除留尾部', () => {
    expect(stripCommercialDataSentences('暂列金额10万。暂估价5万。保留句。')).toBe('保留句。');
  });
  it('BB6 分号分句删除前半', () => {
    expect(stripCommercialDataSentences('暂列金额10万；保留句。')).toBe('保留句。');
  });
  it('BB6 词中间空格不命中 → 保留', () => {
    const md = '暂列 金额10万。';
    expect(stripCommercialDataSentences(md)).toBe(md);
  });
  it('BB6 叹号不分句 → 整 part 连带删除', () => {
    expect(stripCommercialDataSentences('暂列金额10万！保留句。')).toBe('');
  });
  it('BB6 句后表格行（换行被空白吞）保留', () => {
    expect(stripCommercialDataSentences('正文句。\n| 表头 | 内容 |')).toBe('正文句。| 表头 | 内容 |');
  });
  it('BB6 句后标题行保留', () => {
    expect(stripCommercialDataSentences('正文句。\n## 暂列金额明细')).toBe('正文句。## 暂列金额明细');
  });
  it('BB6 纯表格行原样保留', () => {
    const md = '| 表头 | 暂列金额 |';
    expect(stripCommercialDataSentences(md)).toBe(md);
  });
  it('BB6 空串 → 空串', () => {
    expect(stripCommercialDataSentences('')).toBe('');
  });
  it('BB6 无句尾标点整 part 删', () => {
    expect(stripCommercialDataSentences('本段含投标报价数据未加句号')).toBe('');
  });
});
