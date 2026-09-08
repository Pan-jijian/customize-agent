/**
 * dicCommercialBodyHeaderPlaceholderBoundary：第二十二批（Y 组）。
 * 覆盖增量维度（与既有批次基线互补，不重复）：
 *  - Y1 commercialDataInBodyIssues（全新深挖，embedDocuments 注入确定性语义）：
 *    强词 9 词谱系纯句确定性杀、税率/增值税数字窗口 12 字符边界、标题行/表格行排除、
 *    分句拆分、同句多词、聚合 slice(0,4)、允许事实 7 词负例、变体词 5 词语义裁决
 *    （注入 score 1 报 / 0 不报）、混合句语义裁决；
 *  - Y2 fixHeaderlessTables（全新 boundary）：无表头表格补表头 2/3/4 列、正常表跳过、
 *    分隔行后无数据、前有表格行、colCount<2、多处补齐与 details；
 *  - Y3 fixPlaceholderTableCells（全新 boundary）：面积/工期套话替换、选项门控、
 *    多匹配计数、details 文案、无匹配原样；
 *  - Y4 stripCommercial 增量：分号分句、BodyLines 行内多句/标题表格行/税率窗口。
 * 语义判定通过注入 embedDocuments 完全确定化（buildSemanticGate 单测注入通道）。
 */
import { describe, expect, it } from 'vitest';
import {
  commercialDataInBodyIssues,
  fixHeaderlessTables,
  fixPlaceholderTableCells,
  stripCommercialDataBodyLines,
  stripCommercialDataSentences,
} from '@/services/document-workflow/documentIntegrityChecks';

// ── Y1. commercialDataInBodyIssues（全新深挖） ──

/** 语义 gate 注入：首次调用为 6 个原型（3 正例+3 负例）返回 [1,1,1,0,0,0]；
 * 后续调用为候选句返回 [score]×n（dot 非归一：1≥0.6 命中、0 不命中） */
const embedWith = (score: number) => async (texts: string[]): Promise<number[][]> =>
  texts.length === 6 ? texts.map((_, i) => [i < 3 ? 1 : 0]) : texts.map(() => [score]);

describe('Y1 商务条款：强词谱系纯句确定性杀', () => {
  const TERMS = ['暂列金额', '暂估价', '报价明细', '综合单价', '清单合价', '预留金', '投标报价', '异常低价', '评标基准价'] as const;
  it.each(TERMS)('Y1-1 正文句含“%s” → 报', async (term) => {
    const issues = await commercialDataInBodyIssues(`本项目${term}为100万元。`, embedWith(1));
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain(term);
  });
  it('Y1-2 强词纯句无需语义（candidates 空）→ 命中词入 message', async () => {
    const issues = await commercialDataInBodyIssues('本工程暂列金额60万元。', embedWith(0));
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('暂列金额');
  });
  it('Y1-3 分句拆分：正常句+商务句 → 只报商务词', async () => {
    const issues = await commercialDataInBodyIssues('施工部署说明。本项目暂列金额60万元。', embedWith(0));
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('暂列金额');
  });
  it('Y1-4 同一句两强词 → match 无 g 标志只收首个（真实行为锁定）', async () => {
    const issues = await commercialDataInBodyIssues('本项目暂列金额60万元、暂估价30万元。', embedWith(0));
    expect(issues[0].message).toContain('暂列金额');
    expect(issues[0].message).not.toContain('暂估价');
  });
  it('Y1-5 5 种强词 → unique slice(0,4) 只列 4 个', async () => {
    const md = '暂列金额。暂估价。报价明细。综合单价。清单合价。';
    const issues = await commercialDataInBodyIssues(md, embedWith(0));
    expect(issues).toHaveLength(1);
    const joined = issues[0].message.split('：')[1] ?? '';
    expect(joined.split('、').length).toBe(4);
  });
  it('Y1-6 标题行含强词 → 不报', async () => {
    expect(await commercialDataInBodyIssues('## 暂列金额说明\n正文内容。', embedWith(0))).toEqual([]);
  });
  it('Y1-7 表格行含强词（信息表落位）→ 不报', async () => {
    expect(await commercialDataInBodyIssues('| 暂列金额 | 60万元 |', embedWith(0))).toEqual([]);
  });
  it('Y1-8 分号分句：前句正常后句商务 → 报', async () => {
    const issues = await commercialDataInBodyIssues('施工部署说明；本项目综合单价850元每平方米。', embedWith(0));
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('综合单价');
  });
});

describe('Y1 商务条款：税率数字窗口', () => {
  it('Y1-9 税率+数字（0 距离）→ 报「税率/增值税」', async () => {
    const issues = await commercialDataInBodyIssues('本项目税率9%。', embedWith(0));
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('税率/增值税');
  });
  it('Y1-10 增值税+12 字内数字 → 报', async () => {
    const issues = await commercialDataInBodyIssues(`增值税${'甲'.repeat(11)}3%。`, embedWith(0));
    expect(issues).toHaveLength(1);
  });
  it('Y1-11 税率+13 字后数字（超窗口）→ 不报', async () => {
    expect(await commercialDataInBodyIssues(`税率${'甲'.repeat(13)}3。`, embedWith(0))).toEqual([]);
  });
  it('Y1-12 税率无数字 → 不报', async () => {
    expect(await commercialDataInBodyIssues('税率按合同约定执行。', embedWith(0))).toEqual([]);
  });
  it('Y1-13 税率数字跨句（句号阻断）→ 不报', async () => {
    expect(await commercialDataInBodyIssues('本项目税率。3%。', embedWith(0))).toEqual([]);
  });
  it('Y1-14 税率表格行 → 不报', async () => {
    expect(await commercialDataInBodyIssues('| 增值税 | 9% |', embedWith(0))).toEqual([]);
  });
  it('Y1-15 税率+强词同句 → 两类 hits 均入 message', async () => {
    const issues = await commercialDataInBodyIssues('本项目税率9%，暂列金额60万元。', embedWith(0));
    expect(issues[0].message).toContain('税率/增值税');
    expect(issues[0].message).toContain('暂列金额');
  });
});

describe('Y1 商务条款：允许事实负例', () => {
  const ALLOWED = ['合同估算价', '合同估算价格', '投资估算', '估算价格', '工程估算价', '最高投标限价', '招标控制价'] as const;
  it.each(ALLOWED)('Y1-16 允许词“%s”纯句 → 不报', async (term) => {
    expect(await commercialDataInBodyIssues(`本项目${term}8000万元。`, embedWith(1))).toEqual([]);
  });
  it('Y1-17 允许词+强词混合句 → 语义裁决（score 1 报）', async () => {
    const issues = await commercialDataInBodyIssues('暂列金额见合同估算价清单。', embedWith(1));
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('暂列金额');
  });
  it('Y1-18 允许词+强词混合句 → 语义裁决（score 0 不报）', async () => {
    expect(await commercialDataInBodyIssues('暂列金额见合同估算价清单。', embedWith(0))).toEqual([]);
  });
  it('Y1-19 允许词+强词混合句 → 语义裁决（score 0.5 <0.6 不报）', async () => {
    expect(await commercialDataInBodyIssues('暂列金额见合同估算价清单。', embedWith(0.5))).toEqual([]);
  });
});

describe('Y1 商务条款：变体词语义裁决', () => {
  const VARIANTS = ['材料价格', '商务报价', '投标总价', '合同总价', '工程总价'] as const;
  it.each(VARIANTS)('Y1-20 变体词“%s”纯句 → score 1 语义命中报', async (variant) => {
    const issues = await commercialDataInBodyIssues(`本段说明${variant}相关内容。`, embedWith(1));
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain(variant);
  });
  it('Y1-21 变体词纯句 → score 0 语义不命中不报', async () => {
    expect(await commercialDataInBodyIssues('本段说明材料价格波动应对措施。', embedWith(0))).toEqual([]);
  });
  it('Y1-22 变体词+强词混合句 → 语义裁决（score 1 报强词）', async () => {
    const issues = await commercialDataInBodyIssues('暂列金额与材料价格明细。', embedWith(1));
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('暂列金额');
  });
  it('Y1-22b 变体词+强词混合句 → 语义裁决（score 0 不报）', async () => {
    expect(await commercialDataInBodyIssues('暂列金额与材料价格明细。', embedWith(0))).toEqual([]);
  });
  it('Y1-23 变体词在标题行 → 不报', async () => {
    expect(await commercialDataInBodyIssues('### 材料价格管理\n正文。', embedWith(1))).toEqual([]);
  });
});

// ── Y2. fixHeaderlessTables（全新 boundary） ──

describe('Y2 无表头表格：补齐行为', () => {
  it('Y2-1 2 列无表头表格 → 补「| 项目 | 内容 |」', () => {
    const result = fixHeaderlessTables('| --- | --- |\n| 甲 | 乙 |');
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toBe('| 项目 | 内容 |\n| --- | --- |\n| 甲 | 乙 |');
  });
  it('Y2-2 3 列 → 补「| 项目 | 内容 | 备注 |」', () => {
    const result = fixHeaderlessTables('| --- | --- | --- |\n| 1 | 2 | 3 |');
    expect(result.fixedCount).toBe(1);
    expect(result.markdown.startsWith('| 项目 | 内容 | 备注 |')).toBe(true);
  });
  it('Y2-3 4 列 → 补「| 项目 | 内容 | 备注 | 备注 |」', () => {
    const result = fixHeaderlessTables('| --- | --- | --- | --- |\n| 1 | 2 | 3 | 4 |');
    expect(result.markdown.startsWith('| 项目 | 内容 | 备注 | 备注 |')).toBe(true);
  });
  it('Y2-4 正常表格（表头+分隔）→ 不补', () => {
    const md = '| 表头A | 表头B |\n| --- | --- |\n| 甲 | 乙 |';
    const result = fixHeaderlessTables(md);
    expect(result.fixedCount).toBe(0);
    expect(result.markdown).toBe(md);
  });
  it('Y2-5 分隔行后无数据行 → 不补', () => {
    const md = '| --- | --- |';
    const result = fixHeaderlessTables(md);
    expect(result.fixedCount).toBe(0);
  });
  it('Y2-6 分隔行前是数据行（表体中间）→ 跳过', () => {
    const md = '| 甲 | 乙 |\n| --- | --- |\n| 丙 | 丁 |';
    const result = fixHeaderlessTables(md);
    expect(result.fixedCount).toBe(0);
  });
  it('Y2-7 colCount=1 分隔行 → 跳过', () => {
    const result = fixHeaderlessTables('| --- |\n| 甲 |');
    expect(result.fixedCount).toBe(0);
  });
  it('Y2-8 2 处无表头表格 → fixedCount=2 且 details 计数', () => {
    const md = '| --- | --- |\n| 甲 | 乙 |\n\n| --- | --- |\n| 丙 | 丁 |';
    const result = fixHeaderlessTables(md);
    expect(result.fixedCount).toBe(2);
    expect(result.details).toEqual(['无表头表格补齐表头 2 处']);
  });
  it('Y2-9 补表头后 index 前移（新表头不被当作分隔行前数据行）', () => {
    const md = '| --- | --- | --- |\n| --- | --- |\n| 1 | 2 | 3 |';
    const result = fixHeaderlessTables(md);
    expect(result.fixedCount).toBe(1);
    expect(result.markdown.startsWith('| 项目 | 内容 | 备注 |')).toBe(true);
  });
  it('Y2-10 冒号对齐分隔行（:---）→ 识别', () => {
    const result = fixHeaderlessTables('| :--- | ---: |\n| 甲 | 乙 |');
    expect(result.fixedCount).toBe(1);
  });
  it('Y2-11 数据行无两侧竖线包边 → 不补', () => {
    const result = fixHeaderlessTables('| --- | --- |\n甲 | 乙');
    expect(result.fixedCount).toBe(0);
  });
});

// ── Y3. fixPlaceholderTableCells（全新 boundary） ──

describe('Y3 占位单元格：套话替换', () => {
  it('Y3-1 areaSummary 替换「按施工图设计文件确定」', () => {
    const result = fixPlaceholderTableCells('| 建设规模 | 按施工图设计文件确定 |', { areaSummary: '12.5万平方米' });
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toContain('| 12.5万平方米 |');
    expect(result.markdown).not.toContain('按施工图设计文件确定');
  });
  it('Y3-2 scheduleDays 替换「按合同约定工期执行」', () => {
    const result = fixPlaceholderTableCells('| 计划工期 | 按合同约定工期执行 |', { scheduleDays: 540 });
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toContain('| 540个日历天 |');
  });
  it('Y3-3 无 options → 原样返回', () => {
    const md = '| 建设规模 | 按施工图设计文件确定 |';
    const result = fixPlaceholderTableCells(md);
    expect(result.markdown).toBe(md);
    expect(result.fixedCount).toBe(0);
  });
  it('Y3-4 只传 areaSummary → 工期套话不换', () => {
    const md = '| 计划工期 | 按合同约定工期执行 |';
    const result = fixPlaceholderTableCells(md, { areaSummary: '12.5万平方米' });
    expect(result.markdown).toBe(md);
    expect(result.fixedCount).toBe(0);
  });
  it('Y3-5 scheduleDays=0 → 不换', () => {
    const md = '| 计划工期 | 按合同约定工期执行 |';
    const result = fixPlaceholderTableCells(md, { scheduleDays: 0 });
    expect(result.markdown).toBe(md);
    expect(result.fixedCount).toBe(0);
  });
  it('Y3-6 scheduleDays 未传（undefined）→ 不换', () => {
    const md = '| 计划工期 | 按合同约定工期执行 |';
    const result = fixPlaceholderTableCells(md, {});
    expect(result.markdown).toBe(md);
    expect(result.fixedCount).toBe(0);
  });
  it('Y3-7 两处面积套话 → fixedCount=2 全换', () => {
    const md = '| 建设规模 | 按施工图设计文件确定 |\n| 总建筑面积 | 按施工图设计文件确定 |';
    const result = fixPlaceholderTableCells(md, { areaSummary: '12.5万平方米' });
    expect(result.fixedCount).toBe(2);
    expect(result.markdown.split('12.5万平方米').length - 1).toBe(2);
  });
  it('Y3-8 混合文档两类套话 → 同时换 fixedCount=2', () => {
    const md = '| 建设规模 | 按施工图设计文件确定 |\n| 计划工期 | 按合同约定工期执行 |';
    const result = fixPlaceholderTableCells(md, { areaSummary: '12.5万平方米', scheduleDays: 540 });
    expect(result.fixedCount).toBe(2);
    expect(result.markdown).toContain('12.5万平方米');
    expect(result.markdown).toContain('540个日历天');
  });
  it('Y3-9 无匹配 → 原样 fixedCount=0 details 空', () => {
    const md = '| 建设规模 | 12万平方米 |';
    const result = fixPlaceholderTableCells(md, { areaSummary: '12.5万平方米' });
    expect(result.markdown).toBe(md);
    expect(result.fixedCount).toBe(0);
    expect(result.details).toEqual([]);
  });
  it('Y3-10 details 含替换描述', () => {
    const result = fixPlaceholderTableCells('| 建设规模 | 按施工图设计文件确定 |', { areaSummary: '12.5万平方米' });
    expect(result.details).toContain('工程概况一览表建设规模套话→“12.5万平方米”');
  });
  it('Y3-11 套话单元格带空格 → 匹配', () => {
    const result = fixPlaceholderTableCells('| 建设规模 |  按施工图设计文件确定  |', { areaSummary: '12.5万平方米' });
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toContain('12.5万平方米');
  });
  it('Y3-12 两处工期套话 → fixedCount=2', () => {
    const md = '| 计划工期 | 按合同约定工期执行 |\n| 工期 | 按合同约定工期执行 |';
    const result = fixPlaceholderTableCells(md, { scheduleDays: 540 });
    expect(result.fixedCount).toBe(2);
  });
});

// ── Y4. stripCommercial 增量 ──

describe('Y4 商务清洗：增量边界', () => {
  it('Y4-1 Sentences 分号分句：前句正常后句含词 → 只删后句', () => {
    const result = stripCommercialDataSentences('施工部署说明；本项目暂列金额60万元。');
    expect(result).toContain('施工部署说明');
    expect(result).not.toContain('暂列金额');
  });
  it('Y4-2 Sentences 税率无数字 → 保留', () => {
    expect(stripCommercialDataSentences('税率按合同约定执行。')).toContain('税率');
  });
  it('Y4-3 BodyLines 行内两句前句含词 → 删前句留后句', () => {
    const result = stripCommercialDataBodyLines('本项目暂列金额60万元。后续正常句。');
    expect(result).not.toContain('暂列金额');
    expect(result).toContain('后续正常句。');
  });
  it('Y4-4 BodyLines 表格行整行保留（含词）', () => {
    const result = stripCommercialDataBodyLines('| 名称 | 暂列金额 | 60万元 |');
    expect(result).toBe('| 名称 | 暂列金额 | 60万元 |');
  });
  it('Y4-5 BodyLines 标题行保留', () => {
    const result = stripCommercialDataBodyLines('## 暂列金额说明');
    expect(result).toBe('## 暂列金额说明');
  });
  it('Y4-6 BodyLines 空行保留', () => {
    const result = stripCommercialDataBodyLines('第一句正常。\n\n暂列金额60万元。');
    expect(result).toContain('\n\n');
    expect(result).not.toContain('暂列金额');
  });
  it('Y4-7 BodyLines 变体词不删（清洗只收强词+税率）', () => {
    expect(stripCommercialDataBodyLines('材料价格波动应对。')).toBe('材料价格波动应对。');
  });
});
