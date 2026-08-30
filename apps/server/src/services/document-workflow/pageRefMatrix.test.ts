/**
 * 页码清洗批量边界矩阵（组合爆炸覆盖，4.12.7 前补齐）：
 * cleanInlineFactValue 完整引用归一全笛卡尔矩阵、normalizeTenderSourcePageRefs 同口径抽样、
 * 残片删除矩阵、formalContentIntegrityIssues 页码残留检测矩阵（报出与不误报双向）。
 *
 * 组合矩阵的期望由生成器依据「语义约定」独立推导（完整页码引用整体归一为“相关资料”、
 * 残片删除仅移除“PDF 第”保留其前后文本），不复制实现正则，保证断言独立性与实现变更可发现性。
 */
import { describe, expect, it } from 'vitest';
import { cleanInlineFactValue } from './documentGeneratorHelpers';
import { normalizeTenderSourcePageRefs } from './markdownComposer';
import { formalContentIntegrityIssues } from './qualityValidation';

/** 前缀集合：语义各异（校名/机构/日期/空/地址），均以拉丁字符或句尾收束，规避 Han 粘连歧义 */
const PREFIXES = ['招标文件', '合肥师范学院', '日期：2026年8月19日', '', '项目位于合肥市'];
/** PDF 与「第」之间分隔（含换行跨行形态） */
const SEP1 = ['', ' ', '\n'];
/** 「第」与页码之间分隔 */
const SEP2 = ['', ' ', '\n'];
/** 页码形态（1 位/2 位/3 位） */
const PAGES = ['3', '5', '120'];
/** 范围形态（无范围/短横线/带空格短横线/汉字「至」） */
const RANGES: Array<[string, string]> = [['', ''], ['-8', ''], [' - 8', ''], ['至8', '']];
/** 后缀形态（页 + 可选句末标点/后续从句），tail 为替换「…页」后保留的尾文本 */
const SUFFIXES: Array<[string, string]> = [['页', ''], ['页。', '。'], ['页，详见附件。', '，详见附件。']];

/** 全笛卡尔：5×3×3×3×4×3 = 1620 组合。
 *  期望推导：完整引用整体归一为“相关资料”+ tail。
 *  - cleanedExpected 用于 cleanInlineFactValue（其链尾会删除行尾句号/分号）；
 *  - rawExpected 用于 normalizeTenderSourcePageRefs（无行尾标点删除链，句号保留）。
 *  期望推导独立于实现正则，依据清洗链已锁定的语义约定。 */
function buildCompleteRefCases(): Array<[string, string, string]> {
  const cases: Array<[string, string, string]> = [];
  for (const prefix of PREFIXES) {
    for (const s1 of SEP1) {
      for (const s2 of SEP2) {
        for (const page of PAGES) {
          for (const [range] of RANGES) {
            for (const [suffix, tail] of SUFFIXES) {
              const input = `${prefix}PDF${s1}第${s2}${page}${range}${suffix}`;
              const cleanedTail = tail.replace(/[。；;]$/u, '');
              cases.push([input, `${prefix}相关资料${cleanedTail}`, `${prefix}相关资料${tail}`]);
            }
          }
        }
      }
    }
  }
  return cases;
}

const COMPLETE_REF_CASES = buildCompleteRefCases();

describe('cleanInlineFactValue 完整引用归一全笛卡尔矩阵（1620 组合）', () => {
  it.each(COMPLETE_REF_CASES.map(([input, cleaned]) => [input, cleaned] as const))('矩阵 #%#：%s', (input, expected) => {
    expect(cleanInlineFactValue(input)).toBe(expected);
  });
});

describe('normalizeTenderSourcePageRefs 完整引用同口径抽样矩阵（每 9 组取 1，含跨行组合）', () => {
  const sampled = COMPLETE_REF_CASES.filter((_, index) => index % 9 === 0).map(([input, , raw]) => [input, raw] as const);
  it.each(sampled)('抽样 #%#：%s', (input, expected) => {
    expect(normalizeTenderSourcePageRefs(input)).toBe(expected);
  });
});

describe('normalizeTenderSourcePageRefs 全角数字完整引用不误删矩阵（与 cleanInlineFactValue 同口径）', () => {
  it.each([
    ['招标文件PDF 第３页', '招标文件PDF 第３页'],
    ['招标文件PDF第３页', '招标文件PDF第３页'],
    ['招标文件PDF 第５页', '招标文件PDF 第５页'],
    ['PDF 第３页', 'PDF 第３页'],
    ['合肥师范学院PDF 第３页', '合肥师范学院PDF 第３页'],
  ])('全角形态保留：%s', (input, expected) => {
    expect(cleanInlineFactValue(input)).toBe(expected);
    expect(normalizeTenderSourcePageRefs(input)).toBe(expected);
  });
});

describe('cleanInlineFactValue 残片删除矩阵（大小写 × 空白形态 × 后跟文本 × 重复残片）', () => {
  it.each([
    ['招标文件封面PDF 第', '招标文件封面'],
    ['招标文件封面PDF第', '招标文件封面'],
    ['招标文件封面PDF  第', '招标文件封面'],
    ['招标文件封面PDF\t第', '招标文件封面'],
    ['招标文件封面PDF\n第', '招标文件封面'],
    ['招标文件封面pdf 第', '招标文件封面'],
    ['招标文件封面Pdf 第', '招标文件封面'],
    ['招标文件封面PDF 第。', '招标文件封面'],
    ['招标文件封面PDF 第；', '招标文件封面'],
    ['招标文件封面PDF 第，', '招标文件封面，'],
    ['招标文件封面PDF 第，2026年8月19日', '招标文件封面，2026年8月19日'],
    ['合肥师范学院PDF 第', '合肥师范学院'],
    ['招标代理：安徽省招标集团股份有限公司PDF 第', '招标代理：安徽省招标集团股份有限公司'],
    ['PDF 第', ''],
    ['PDF第', ''],
    ['pdf 第', ''],
    ['PDF 第（封面色）', '（封面色）'],
    ['招标文件PDF 第PDF 第', '招标文件'],
    ['招标文件PDF 第 PDF 第', '招标文件'],
    ['招标文件PDF 第PDF 第PDF 第', '招标文件'],
    ['PDF 第 PDF 第', ''],
    ['招标文件PDF 第 三页', '招标文件三页'],
    ['招标文件PDF 第 五页', '招标文件五页'],
    ['招标文件PDF 第 六页。', '招标文件六页'],
    ['2026年8月19日PDF 第', '2026年8月19日'],
    ['2026年8月19日PDF第', '2026年8月19日'],
    ['（招标文件）PDF 第', '（招标文件）'],
  ])('残片 #%#：%s', (input, expected) => {
    expect(cleanInlineFactValue(input)).toBe(expected);
  });
});

describe('normalizeTenderSourcePageRefs 残片删除矩阵（与 cleanInlineFactValue 同口径）', () => {
  it.each([
    ['日期：2026年8月19 日PDF 第', '日期：2026年8月19 日'],
    ['日期：2026年8月19日PDF 第', '日期：2026年8月19日'],
    ['合肥师范学院招标代理：安徽省招标集团股份有限公司日期：2026年8月19日PDF 第', '合肥师范学院招标代理：安徽省招标集团股份有限公司日期：2026年8月19日'],
    ['招标文件封面PDF第', '招标文件封面'],
    ['招标文件封面PDF 第。', '招标文件封面。'],
    ['PDF 第', ''],
    ['招标文件PDF 第PDF 第', '招标文件'],
    ['pdf 第', ''],
  ])('残片 #%#：%s', (input, expected) => {
    expect(normalizeTenderSourcePageRefs(input)).toBe(expected);
  });
});

describe('cleanInlineFactValue 日期与单位归一矩阵（空格粘连清理）', () => {
  it.each([
    ['开标日期：2026年8月19 日。', '开标日期：2026年8月19日'],
    ['2026年8月19 日。', '2026年8月19日'],
    ['2026年8月19日。', '2026年8月19日'],
    ['2026年8月19日', '2026年8月19日'],
    ['2026年8月19 日，', '2026年8月19日，'],
    ['2026年1月1 日', '2026年1月1日'],
    ['2026年12月31 日', '2026年12月31日'],
    ['计划工期：540 日历天。', '计划工期：540日历天'],
    ['计划工期：540 天。', '计划工期：540天'],
    ['计划工期：18 个月。', '计划工期：18个月'],
    ['计划工期：1.5 年。', '计划工期：1.5年'],
    ['合同估算价：1.2 万元', '合同估算价：1.2万元'],
    ['合同估算价：3800 元', '合同估算价：3800元'],
    ['单体建筑面积 28570.36 ㎡。', '单体建筑面积 28570.36㎡'],
    ['单体建筑面积 28570.36 平方米。', '单体建筑面积 28570.36平方米'],
    ['基坑深度 12 米。', '基坑深度 12米'],
    ['基坑深度 12 m。', '基坑深度 12m'],
    ['板厚 250 mm。', '板厚 250mm'],
    ['混凝土强度 C30 MPa。', '混凝土强度 C30MPa'],
    ['非传统水源利用率 8 %。', '非传统水源利用率 8%'],
    ['计划工期 540日历天。', '计划工期 540日历天'],
    ['合同 估算 价 1.2 万元', '合同估算价 1.2万元'],
    ['计划 工 期 540 天', '计划工期 540天'],
    ['质量 标 准：合格', '质量标准：合格'],
    ['合同 工 期：18 个月', '合同工期：18个月'],
  ])('日期单位 #%#：%s', (input, expected) => {
    expect(cleanInlineFactValue(input)).toBe(expected);
  });
});

describe('formalContentIntegrityIssues 页码残留检测矩阵（报出侧）', () => {
  const flag = /正文残留资料页码元信息/u;
  it.each([
    '详见招标文件PDF 第 3 页。',
    '详见招标文件PDF 第。',
    '详见招标文件PDF第。',
    '详见招标文件 pdf 第 5 页。',
    '详见招标文件PDF 第 5-8 页。',
    '详见招标文件PDF 第5至8页。',
    '详见招标文件PDF 第 5到8 页。',
    '招标文件PDF 第３页。',
    '详见工程量清单第 5 页。',
    '详见施工图设计文件第 5-8 页。',
    '详见施工图设计文件第5至8页。',
    '装饰工程施工图纸共 12 页。',
    '装饰工程施工图纸（共 12 页）。',
    '给排水专业图纸 8 页。',
    '详见图纸共10页。',
    '依据工程量清单 15 页。',
    '资料 4 页。',
    '依据图纸（5 页）。',
    '依据清单 3 页。',
    '详见施工图设计文件第 5 页至第 8 页。',
    '招标文件共120页。',
    '详见图纸多达 30 页。',
    '详见图纸约 20 页。',
    '详见相关图纸合计 40 页。',
  ])('报出 #%#：%s', (input) => {
    expect(formalContentIntegrityIssues(input).some(issue => flag.test(issue.message))).toBe(true);
  });
});

describe('formalContentIntegrityIssues 页码残留检测矩阵（不误报侧）', () => {
  const flag = /正文残留资料页码元信息/u;
  it.each([
    '详见招标文件、施工图设计文件、工程量清单及相关资料。',
    '依据工程量清单。',
    '按施工图纸施工。',
    '详见相关专业图纸。',
    '本工程包括装饰、土建、加固、给排水、电气、智能化、消防专业工程。',
    '混凝土养护时间不少于14天。',
    '第3章 施工方案。',
    '第一批次材料进场。',
    '施工现场周边设置围挡。',
    'PDF 文件资料。',
    '第 5 层混凝土浇筑完成。',
    '合同工期为540日历天。',
    '质量目标为合格。',
    '详见附件。',
    '共 10 项清单。',
    '按照规范要求取值。',
    '本工程位于合肥市瑶海区。',
    '2026年8月19日。',
  ])('不误报 #%#：%s', (input) => {
    expect(formalContentIntegrityIssues(input).some(issue => flag.test(issue.message))).toBe(false);
  });
});

describe('cleanInlineFactValue 不破坏矩阵（非清洗对象原样保留）', () => {
  it.each([
    '详见工程量清单第 5 页',
    '详见施工图设计文件第 5-8 页',
    '招标文件PDF 第３页',
    '招标文件PDF 第５页',
    '合肥市瑶海区龙岗路与大众路交口',
    '2026年8月19日',
    '共 10 页',
    '附件2：施工图纸清单',
    'PDF 文件',
    '第 5 层',
    '',
    '结构体系为框架剪力墙结构',
    '抗震设防烈度为7度',
    'A1# 楼',
    '±0.000',
  ])('原样 #%#：%s', (input) => {
    expect(cleanInlineFactValue(input)).toBe(input);
  });
});
