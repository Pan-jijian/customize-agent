/**
 * 检测器族边界矩阵（P1 第 8 批）
 * 覆盖：F 商务条款入正文检测（强词/税率/变体语义 gate）；
 * H 工程概况一览表套话填充；I 6.1 施工部署块质量保障补全。
 * 原则：每条用例独立断言意义；真实实现行为一律锁定（契约先行），不改实现迎合用例；
 * 语义类检测注入模拟嵌入器（正例词/负例词双维向量），不依赖本地 bge。
 */
import { describe, expect, it } from 'vitest';
import {
  applyNumericConsistencyDeterministicFixes, commercialDataInBodyIssues,
  fixPlaceholderTableCells,
} from '@/services/document-workflow/documentIntegrityChecks';

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

// ── F7. 商务句零豁免（4.40.0：豁免通道随商务全链清理删除，检测端与清洗端同口径无例外）──
describe('F7 commercialDataInBodyIssues 商务句零豁免', () => {
  it('F7 含商务词的定性句（无豁免通道，强词直杀）→ 报出', async () => {
    const md = '按招标文件约定：本工程暂列金额按规定计入费用计划并按规定计税。';
    const issues = await commercialIssues(md);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].message).toContain('暂列金额');
  });
  it('F7 「按招标文件要求：」条幅含商务数字 → 报出', async () => {
    const issues = await commercialIssues('按招标文件要求：暂列金额为10万元。');
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].message).toContain('暂列金额');
  });
  it('F7 「按招标文件要求：」条幅无商务数字 → 同样报出（零豁免）', async () => {
    const issues = await commercialIssues('按招标文件要求：暂列金额的使用按约定管理。');
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].message).toContain('暂列金额');
  });
  it('F7 无前缀污染句仍报（防御全线不放松）', async () => {
    const issues = await commercialIssues('本项目暂列金额为60万元。');
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].message).toContain('暂列金额');
  });
  it('F7 超 120 字受控句仍报（窗口无关，零豁免）', async () => {
    const md = `按招标文件约定：${'甲'.repeat(121)}暂列金额。`;
    const issues = await commercialIssues(md);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].message).toContain('暂列金额');
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
