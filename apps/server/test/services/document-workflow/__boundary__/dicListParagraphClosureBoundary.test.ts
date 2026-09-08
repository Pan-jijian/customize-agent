/**
 * dicListParagraphClosureBoundary：危大清单一致性（dangerousListConsistencyIssues）+
 * 段首机械重复（paragraphOpeningRepeatIssues）+ 闭环句式密度（closurePhraseDensityCapIssues）+
 * 概况跨章复述（overviewRecapCandidates/Issues/stripOverviewRecapBodyLines，注入确定性相似度）+
 * 投标人资格串章（bidderQualificationSectionIssues）增量深挖（W 组）。
 * 覆盖增量维度（与既有批次基线互补，不重复）：
 *  - W1 危大清单：标题 7 形态谱系、归一化三规则（括号/编号/尾缀）、条目编号 7 形态谱系、
 *    条目长度 1/2/40/41 字边界、30 行扫描上限、标题行 break、连续标题 lastIndex 回归、
 *    三/四清单两两矩阵与 slice(0,3)；
 *  - W2 段首重复：句长 18/19/60/61 边界、数字归一指纹（历史缺陷回归）、标题前缀、
 *    行中第二句不采、|/# 排除、指纹 <10 跳过、4 指纹 slice(0,3)；
 *  - W3 闭环密度：总字数 3000/2999 边界、密度 3.0/2.67 精确边界、四词谱系、max 词选择、
 *    并列密度取词表序、空白不计入总字数；
 *  - W4 概况复述：注入相似度 0.6/0.599 精确阈值、四开头词谱系、句长 12 边界、
 *    概况区间锚定与同级标题结束、H3 不结束 H2 区间、3 处截断、slice(0,36)、
 *    stripOverviewRecapBodyLines 删除/保留/短句保留；
 *  - W5 资格串章：形态A（具备有效）句式判别、词表 16 词谱系、技术语境豁免、
 *    形态B（提供+证明词）、编号前缀剥离、多标题聚合与「 等」、H2~H4 层级、H5 不收。
 * 全部为确定性正则/数值比较，无语义依赖（W4 相似度注入确定性函数）。
 */
import { describe, expect, it } from 'vitest';
import {
  bidderQualificationSectionIssues,
  closurePhraseDensityCapIssues,
  dangerousListConsistencyIssues,
  overviewRecapCandidates,
  overviewRecapIssues,
  paragraphOpeningRepeatIssues,
  stripOverviewRecapBodyLines,
} from '@/services/document-workflow/documentIntegrityChecks';

// ── W1. dangerousListConsistencyIssues：危大清单一致性 ──

describe('W1 危大清单：标题形态谱系', () => {
  const HEADINGS = [
    '危大工程辨识清单', '危大工程清单', '危大工程识别',
    '危大工程及超危大工程清单', '危大工程辨识', '1.2 危大工程清单', '危大清单',
  ] as const;
  it.each(HEADINGS)('W1-1 标题“%s”下两清单差异 → 报', (heading) => {
    const md = `## ${heading}\n1.深基坑工程\n2.模板工程\n## ${heading}\n1.深基坑工程\n2.脚手架工程`;
    expect(dangerousListConsistencyIssues(md)).toHaveLength(1);
  });
  it('W1-2 两清单完全相同 → 不报', () => {
    const md = '## 危大工程辨识清单\n1.深基坑工程\n2.模板工程\n## 危大工程辨识清单\n1.深基坑工程\n2.模板工程';
    expect(dangerousListConsistencyIssues(md)).toEqual([]);
  });
  it('W1-3 差异 message 含独有项', () => {
    const md = '## 危大工程辨识清单\n1.深基坑工程\n2.模板工程\n## 危大工程辨识清单\n1.深基坑工程\n2.脚手架工程';
    const issues = dangerousListConsistencyIssues(md);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('模板工程');
    expect(issues[0].message).toContain('脚手架工程');
  });
  it('W1-4 单清单 → 不报', () => {
    expect(dangerousListConsistencyIssues('## 危大工程辨识清单\n1.深基坑工程\n2.模板工程')).toEqual([]);
  });
});

describe('W1 危大清单：归一化三规则', () => {
  it('W1-5 括号标注+编号「1.（开挖深度超5米）深基坑工程」与「深基坑工程」归一化同 → 不报（历史缺陷回归）', () => {
    const md = '## 危大工程辨识清单\n1.（开挖深度超5米）深基坑工程\n2.模板工程\n## 危大工程辨识清单\n1.深基坑工程\n2.模板工程';
    expect(dangerousListConsistencyIssues(md)).toEqual([]);
  });
  it('W1-6 「土方开挖施工」尾缀剥离与「土方开挖」同 → 不报', () => {
    const md = '## 危大工程辨识清单\n1.土方开挖施工\n2.模板工程\n## 危大工程辨识清单\n1.土方开挖\n2.模板工程';
    expect(dangerousListConsistencyIssues(md)).toEqual([]);
  });
  it('W1-7 「土方开挖作业」尾缀剥离与「土方开挖」同 → 不报', () => {
    const md = '## 危大工程辨识清单\n1.土方开挖作业\n2.模板工程\n## 危大工程辨识清单\n1.土方开挖\n2.模板工程';
    expect(dangerousListConsistencyIssues(md)).toEqual([]);
  });
});

describe('W1 危大清单：条目编号形态谱系（归一化后同 → 不报）', () => {
  const NUM_PREFIXES = ['1.', '1、', '1．', '1)', '- ', '* ', '• '] as const;
  it.each(NUM_PREFIXES)('W1-8 编号“%s深基坑工程”与无编号「深基坑工程」同 → 不报', (prefix) => {
    const md = `## 危大工程辨识清单\n${prefix}深基坑工程\n2.模板工程\n## 危大工程辨识清单\n深基坑工程\n模板工程`;
    expect(dangerousListConsistencyIssues(md)).toEqual([]);
  });
});

describe('W1 危大清单：条目长度与格式边界', () => {
  it('W1-9 1字条目不收 → 两清单无差异 → 不报', () => {
    const md = '## 危大工程辨识清单\n塔\n2.模板工程\n## 危大工程辨识清单\n1.深基坑工程\n2.模板工程';
    expect(dangerousListConsistencyIssues(md)).toEqual([]);
  });
  it('W1-10 2字条目收 → 差异报', () => {
    const md = '## 危大工程辨识清单\n1.爆破\n2.模板工程\n## 危大工程辨识清单\n1.深基坑工程\n2.模板工程';
    expect(dangerousListConsistencyIssues(md)).toHaveLength(1);
  });
  it('W1-11 40字条目收 → 差异报', () => {
    const long = '工'.repeat(40);
    const md = `## 危大工程辨识清单\n1.${long}\n2.模板工程\n## 危大工程辨识清单\n1.深基坑工程\n2.模板工程`;
    expect(dangerousListConsistencyIssues(md)).toHaveLength(1);
  });
  it('W1-12 41字条目不收 → 无差异 → 不报', () => {
    const long = '工'.repeat(41);
    const md = `## 危大工程辨识清单\n1.${long}\n2.模板工程\n## 危大工程辨识清单\n1.深基坑工程\n2.模板工程`;
    expect(dangerousListConsistencyIssues(md)).toEqual([]);
  });
  it('W1-13 含句号条目不收 → 无差异 → 不报', () => {
    const md = '## 危大工程辨识清单\n1.深基坑工程（需专家论证）。\n2.模板工程\n## 危大工程辨识清单\n1.深基坑工程\n2.模板工程';
    expect(dangerousListConsistencyIssues(md)).toEqual([]);
  });
  it('W1-14 表格行（含|）不收 → 无差异 → 不报', () => {
    const md = '## 危大工程辨识清单\n| 深基坑工程 |\n2.模板工程\n## 危大工程辨识清单\n1.深基坑工程\n2.模板工程';
    expect(dangerousListConsistencyIssues(md)).toEqual([]);
  });
  it('W1-15 清单不足2项不入池 → 不报', () => {
    const md = '## 危大工程辨识清单\n1.深基坑工程\n## 危大工程辨识清单\n1.深基坑工程\n2.模板工程';
    expect(dangerousListConsistencyIssues(md)).toEqual([]);
  });
});

describe('W1 危大清单：扫描窗口与结构边界', () => {
  it('W1-16 30行扫描上限：第31行独有项不收 → 不报', () => {
    const lines = ['## 危大工程辨识清单', '1.深基坑工程', '2.模板工程', ...Array.from({ length: 27 }, () => '')];
    const a = ['## 危大工程辨识清单', '1.深基坑工程', '2.模板工程'];
    const md = [...a, ...lines.slice(1, 29), '3.脚手架工程', ...a].join('\n');
    expect(dangerousListConsistencyIssues(md)).toEqual([]);
  });
  it('W1-17 清单内标题行 break：其后独有项不收 → 不报', () => {
    const md = '## 危大工程辨识清单\n1.深基坑工程\n2.模板工程\n#### 其他小节\n3.脚手架工程\n## 危大工程辨识清单\n1.深基坑工程\n2.模板工程';
    expect(dangerousListConsistencyIssues(md)).toEqual([]);
  });
  it('W1-18 连续标题行（g标志lastIndex残留回归）→ 第二清单正常提取 → 报', () => {
    const md = '## 危大工程辨识清单\n1.深基坑工程\n2.模板工程\n## 危大工程辨识清单\n1.深基坑工程\n2.脚手架工程';
    expect(dangerousListConsistencyIssues(md)).toHaveLength(1);
  });
});

describe('W1 危大清单：多清单矩阵与截断', () => {
  it('W1-19 三清单两两差异 → 3 对全报', () => {
    const md = '## 危大工程辨识清单\n1.深基坑工程\n2.模板工程\n## 危大工程辨识清单\n1.深基坑工程\n2.脚手架工程\n## 危大工程辨识清单\n1.深基坑工程\n2.起重吊装工程';
    expect(dangerousListConsistencyIssues(md)).toHaveLength(3);
  });
  it('W1-20 四清单 6 对候选 → slice(0,3) 截断为 3 条', () => {
    const md = ['深基坑工程', '模板工程', '脚手架工程', '起重吊装工程'].map(
      (extra, i) => `## 危大工程辨识清单\n1.深基坑工程\n2.${extra}`,
    ).join('\n');
    expect(dangerousListConsistencyIssues(md)).toHaveLength(3);
  });
  it('W1-21 长标题 message 截断 title 前30字', () => {
    const longTitle = '危大工程辨识清单'.repeat(4);
    const md = `## ${longTitle}\n1.深基坑工程\n2.模板工程\n## ${longTitle}\n1.深基坑工程\n2.脚手架工程`;
    const issues = dangerousListConsistencyIssues(md);
    expect(issues).toHaveLength(1);
    // 截断精确验证：title 为整行（含 "## " 前缀），slice(0,30) = 前缀 3 字符 + 标题 27 字
    expect(issues[0].message).toContain(`“## ${longTitle.slice(0, 27)}”（2 项）`);
  });
});

// ── W2. paragraphOpeningRepeatIssues：段首机械重复 ──

describe('W2 段首重复：句长边界', () => {
  it('W2-1 句长18字（<19）不匹配 → 3段不报', () => {
    const md = Array.from({ length: 3 }, () => `${'施'.repeat(18)}。`).join('\n\n');
    expect(paragraphOpeningRepeatIssues(md)).toEqual([]);
  });
  it('W2-2 句长19字 → 3段报', () => {
    const md = Array.from({ length: 3 }, () => `${'施'.repeat(19)}。`).join('\n\n');
    const issues = paragraphOpeningRepeatIssues(md);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('机械重复 3 次');
  });
  it('W2-3 句长60字（上限）→ 3段报', () => {
    const md = Array.from({ length: 3 }, () => `${'施'.repeat(60)}。`).join('\n\n');
    expect(paragraphOpeningRepeatIssues(md)).toHaveLength(1);
  });
  it('W2-4 句长61字（真实上限：首字符+18~60=61）→ 3段报', () => {
    const md = Array.from({ length: 3 }, () => `${'施'.repeat(61)}。`).join('\n\n');
    expect(paragraphOpeningRepeatIssues(md)).toHaveLength(1);
  });
  it('W2-4b 句长62字（超真实上限）→ 不报', () => {
    const md = Array.from({ length: 3 }, () => `${'施'.repeat(62)}。`).join('\n\n');
    expect(paragraphOpeningRepeatIssues(md)).toEqual([]);
  });
});

describe('W2 段首重复：计数与指纹', () => {
  it('W2-5 2段同句式 → 不报；3段 → 报', () => {
    const two = Array.from({ length: 2 }, () => `${'施'.repeat(19)}。`).join('\n\n');
    expect(paragraphOpeningRepeatIssues(two)).toEqual([]);
    const three = Array.from({ length: 3 }, () => `${'施'.repeat(19)}。`).join('\n\n');
    expect(paragraphOpeningRepeatIssues(three)).toHaveLength(1);
  });
  it('W2-6 数字归一指纹：面积差异不掩盖同构句式（历史缺陷回归）', () => {
    const md = [
      '本工程建筑面积10000平方米，主体结构为框架。',
      '本工程建筑面积20000平方米，主体结构为框架。',
      '本工程建筑面积30000平方米，主体结构为框架。',
    ].join('\n\n');
    expect(paragraphOpeningRepeatIssues(md)).toHaveLength(1);
  });
  it('W2-7 指纹<10字跳过 → 3段不报', () => {
    const md = Array.from({ length: 3 }, () => `${'1234567890123456'}甲乙。`).join('\n\n');
    expect(paragraphOpeningRepeatIssues(md)).toEqual([]);
  });
  it('W2-8 4种指纹各3段 → slice(0,3) 截断为 3 条', () => {
    const make = (ch: string) => Array.from({ length: 3 }, () => `${ch.repeat(19)}。`).join('\n\n');
    const md = [make('施'), make('工'), make('安'), make('全')].join('\n\n');
    expect(paragraphOpeningRepeatIssues(md)).toHaveLength(3);
  });
});

describe('W2 段首重复：语境形态', () => {
  it('W2-9 标题前缀后段首句 → 报', () => {
    const para = `${'施'.repeat(19)}。`;
    const md = `## 第一节\n${para}\n\n## 第二节\n${para}\n\n## 第三节\n${para}`;
    expect(paragraphOpeningRepeatIssues(md)).toHaveLength(1);
  });
  it('W2-10 行中第二句（非段首）→ 不报', () => {
    const md = Array.from({ length: 3 }, () => `前文。${'施'.repeat(19)}。`).join('\n\n');
    expect(paragraphOpeningRepeatIssues(md)).toEqual([]);
  });
  it('W2-11 段首表格行（|）排除 → 不报', () => {
    const md = Array.from({ length: 3 }, () => `| ${'施'.repeat(19)}。`).join('\n\n');
    expect(paragraphOpeningRepeatIssues(md)).toEqual([]);
  });
  it('W2-12 段首标题行（#）排除 → 不报', () => {
    const md = Array.from({ length: 3 }, () => `## ${'施'.repeat(19)}。`).join('\n\n');
    expect(paragraphOpeningRepeatIssues(md)).toEqual([]);
  });
  it('W2-13 句尾「！」「？」变体同样匹配 → 报', () => {
    const md = `${'施'.repeat(19)}！\n\n${'施'.repeat(19)}！\n\n${'施'.repeat(19)}！`;
    expect(paragraphOpeningRepeatIssues(md)).toHaveLength(1);
  });
  it('W2-14 无标点句尾 → 不匹配不报', () => {
    const md = Array.from({ length: 3 }, () => '施'.repeat(19)).join('\n\n');
    expect(paragraphOpeningRepeatIssues(md)).toEqual([]);
  });
});

// ── W3. closurePhraseDensityCapIssues：闭环句式密度 ──

describe('W3 闭环密度：总字数与密度精确边界', () => {
  it('W3-1 总字数恰3000 + 销项9次（密度3.0）→ 报', () => {
    const md = `${'销项'.repeat(9)}${'中'.repeat(3000 - 18)}`;
    expect(closurePhraseDensityCapIssues(md)).toHaveLength(1);
  });
  it('W3-2 总字数3000 + 销项8次（密度2.67）→ 不报', () => {
    const md = `${'销项'.repeat(8)}${'中'.repeat(3000 - 16)}`;
    expect(closurePhraseDensityCapIssues(md)).toEqual([]);
  });
  it('W3-3 总字数2999（<3000 门控）→ 不报', () => {
    const md = `${'销项'.repeat(10)}${'中'.repeat(2999 - 20)}`;
    expect(closurePhraseDensityCapIssues(md)).toEqual([]);
  });
  it('W3-4 空白不计入总字数：正文3000字+10空格 → 密度3.0 报', () => {
    const md = `${'销项'.repeat(9)}${'中'.repeat(2982)}${' '.repeat(10)}`;
    expect(closurePhraseDensityCapIssues(md)).toHaveLength(1);
  });
});

describe('W3 闭环密度：词谱系与 max 选择', () => {
  const CLOSURE_WORDS = ['销项', '复查', '整改', '闭环'] as const;
  it.each(CLOSURE_WORDS)('W3-5 词“%s”密度3.0 → 报且 message 含该词', (word) => {
    const md = `${word.repeat(9)}${'中'.repeat(3000 - word.length * 9)}`;
    const issues = closurePhraseDensityCapIssues(md);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain(`“${word}”`);
  });
  it('W3-6 双词不同密度 → 取 max 词', () => {
    const md = `${'销项'.repeat(9)}${'闭环'.repeat(8)}${'中'.repeat(3000 - 18 - 16)}`;
    const issues = closurePhraseDensityCapIssues(md);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('“销项”');
  });
  it('W3-7 双词并列密度 → 取词表序第一个', () => {
    const md = `${'销项'.repeat(9)}${'复查'.repeat(9)}${'中'.repeat(3000 - 18 - 18)}`;
    const issues = closurePhraseDensityCapIssues(md);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('“销项”');
  });
  it('W3-8 四词全零 → 不报', () => {
    expect(closurePhraseDensityCapIssues('中'.repeat(3000))).toEqual([]);
  });
  it('W3-9 message 含密度值与「次/千字」', () => {
    const md = `${'销项'.repeat(9)}${'中'.repeat(2982)}`;
    const issues = closurePhraseDensityCapIssues(md);
    expect(issues[0].message).toContain('3.0 次/千字');
  });
});

// ── W4. overviewRecap：概况跨章复述（注入确定性相似度） ──

// 复述句 12 字恰阈值（"本项目为"4字+"某市安置小区项目"8字）
const RECAP_MD = '## 工程概况\n本项目为某市安置小区项目。\n## 施工组织\n本项目为某市安置小区项目。';

describe('W4 概况复述：注入相似度精确阈值', () => {
  it('W4-1 相似度0.6（恰阈值）→ 报', () => {
    const issues = overviewRecapIssues(RECAP_MD, { semanticSimilarity: () => 0.6 });
    expect(issues).toHaveLength(1);
  });
  it('W4-2 相似度0.599（<0.6）→ 不报', () => {
    expect(overviewRecapIssues(RECAP_MD, { semanticSimilarity: () => 0.599 })).toEqual([]);
  });
  it('W4-3 未注入相似度函数 → 不报', () => {
    expect(overviewRecapIssues(RECAP_MD)).toEqual([]);
  });
  it('W4-4 无概况区（overviewBody空）→ 不报', () => {
    const md = '## 施工组织\n本项目为某安置小区项目。';
    expect(overviewRecapIssues(md, { semanticSimilarity: () => 0.9 })).toEqual([]);
  });
  it('W4-5 概况区外无复述句 → 不报', () => {
    const md = '## 工程概况\n本项目为某安置小区项目。\n## 施工组织\n本章阐述施工部署。';
    expect(overviewRecapIssues(md, { semanticSimilarity: () => 0.9 })).toEqual([]);
  });
});

describe('W4 概况复述：开头词谱系与句长边界', () => {
  const OPENINGS = ['本项目为', '本工程为', '该项目为', '该工程为'] as const;
  it.each(OPENINGS)('W4-6 开头“%s”复述句 → 报', (opening) => {
    const md = `## 工程概况\n${opening}某市安置小区项目。\n## 施工组织\n${opening}某市安置小区项目。`;
    expect(overviewRecapIssues(md, { semanticSimilarity: () => 0.9 })).toHaveLength(1);
  });
  it('W4-7 句长11字（<12）不采 → 不报', () => {
    const md = '## 工程概况\n本项目为某安置小区项目。\n## 施工组织\n本项目为某安置小区项目。';
    expect(overviewRecapIssues(md, { semanticSimilarity: () => 0.9 })).toEqual([]);
  });
  it('W4-8 句长12字（恰阈值）→ 报', () => {
    const md = '## 工程概况\n本项目为某市安置小区项目。\n## 施工组织\n本项目为某市安置小区项目。';
    expect(overviewRecapIssues(md, { semanticSimilarity: () => 0.9 })).toHaveLength(1);
  });
});

describe('W4 概况复述：区间锚定与聚合', () => {
  it('W4-9 H3（非概况词）不结束 H2 概况区间 → 区间内复述句不采 → 不报', () => {
    const md = '## 工程概况\n正文内容。\n### 项目背景\n本项目为某市安置小区项目。';
    expect(overviewRecapIssues(md, { semanticSimilarity: () => 0.9 })).toEqual([]);
  });
  it('W4-9b 「### 基本信息」本身重置概况锚点 → 区间内复述句不采 → 不报', () => {
    const md = '## 工程概况\n正文内容。\n### 基本信息\n正文内容。\n本项目为某市安置小区项目。';
    expect(overviewRecapIssues(md, { semanticSimilarity: () => 0.9 })).toEqual([]);
  });
  it('W4-10 同级 H2 结束概况区间 → 区间外复述句报', () => {
    const md = '## 工程概况\n正文内容。\n## 施工部署\n本项目为某市安置小区项目。';
    expect(overviewRecapIssues(md, { semanticSimilarity: () => 0.9 })).toHaveLength(1);
  });
  it('W4-11 3 处复述句 → message 含 3 处', () => {
    const md = '## 工程概况\n本项目为某市安置小区项目。\n## 施工组织\n本项目为某市安置小区项目。\n## 安全文明\n本项目为某市安置小区项目。\n## 质量管理\n本项目为某市安置小区项目。';
    const issues = overviewRecapIssues(md, { semanticSimilarity: () => 0.9 });
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('3 处');
  });
  it('W4-12 4 处区间外复述句 → recaps 截断 3 处', () => {
    const md = '## 工程概况\n本项目为某市安置小区项目。\n## 施工组织\n本项目为某市安置小区项目。\n## 安全文明\n本项目为某市安置小区项目。\n## 质量管理\n本项目为某市安置小区项目。\n## 成本控制\n本项目为某市安置小区项目。';
    const issues = overviewRecapIssues(md, { semanticSimilarity: () => 0.9 });
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('3 处');
  });
  it('W4-13 复述句 message 截断 slice(0,36)', () => {
    const long = `本项目为某市安置小区项目${'，配套齐全'.repeat(12)}`;
    const md = `## 工程概况\n${long}。\n## 施工组织\n${long}。`;
    const issues = overviewRecapIssues(md, { semanticSimilarity: () => 0.9 });
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain(`${long.slice(0, 36)}…`);
  });
  it('W4-14 overviewRecapCandidates：概况区间外「本项目为」第二句不采', () => {
    const md = '## 工程概况\n正文。\n## 施工组织\n前置内容。本项目为某市安置小区项目。';
    const { sentences } = overviewRecapCandidates(md);
    expect(sentences).toHaveLength(1);
  });
});

describe('W4 概况复述：stripOverviewRecapBodyLines 行级清洗', () => {
  it('W4-15 相似度达标句删除 → 输出不含该句', () => {
    const out = stripOverviewRecapBodyLines(RECAP_MD, () => 0.9);
    expect(out).not.toContain('本项目为某安置小区项目。\n');
    expect(out).toContain('## 施工组织');
  });
  it('W4-16 相似度<0.6 保留', () => {
    expect(stripOverviewRecapBodyLines(RECAP_MD, () => 0.5)).toBe(RECAP_MD);
  });
  it('W4-17 句长<12 不删', () => {
    const md = '## 工程概况\n本项目为安置小区。\n## 施工组织\n本项目为安置小区。';
    expect(stripOverviewRecapBodyLines(md, () => 0.9)).toBe(md);
  });
});

// ── W5. bidderQualificationSectionIssues：投标人资格串章 ──

describe('W5 资格串章：形态A句式判别', () => {
  it('W5-1 「## 6.6 具备有效的营业执照」→ 报', () => {
    const issues = bidderQualificationSectionIssues('## 6.6 具备有效的营业执照\n正文。');
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('具备有效的营业执照');
  });
  it('W5-2 编号前缀剥离「6.6.1 具备有效…」→ 报', () => {
    expect(bidderQualificationSectionIssues('### 6.6.1 具备有效的资质证书\n正文。')).toHaveLength(1);
  });
  it('W5-3 无空格编号「6.6具备有效的…」→ 报', () => {
    expect(bidderQualificationSectionIssues('## 6.6具备有效的安全生产许可证\n正文。')).toHaveLength(1);
  });
});

describe('W5 资格串章：词表 16 词谱系', () => {
  const QUALIFICATION_WORDS = [
    '营业执照', '资质证书', '安全生产许可证', '资格预审', '资格审查', '资质审查',
    '财务状况', '业绩证明', '业绩要求', '银行资信', '审计报告', '信用记录',
    '信用评价', '不良行为记录', '联合体投标', '联合体协议',
  ] as const;
  it.each(QUALIFICATION_WORDS)('W5-4 标题“3.1 %s”无技术语境 → 报', (word) => {
    expect(bidderQualificationSectionIssues(`## 3.1 ${word}\n正文。`)).toHaveLength(1);
  });
});

describe('W5 资格串章：技术语境豁免', () => {
  it('W5-5 「安全生产许可证管理制度」（含管理）→ 技术语境豁免不报', () => {
    expect(bidderQualificationSectionIssues('## 3.1 安全生产许可证管理制度\n正文。')).toEqual([]);
  });
  it('W5-6 「资质证书使用管理」（含管理）→ 不报', () => {
    expect(bidderQualificationSectionIssues('## 3.1 资质证书使用管理\n正文。')).toEqual([]);
  });
  it('W5-7 「营业执照复印件」无技术词 → 报', () => {
    expect(bidderQualificationSectionIssues('## 3.1 营业执照复印件\n正文。')).toHaveLength(1);
  });
  it('W5-8 非资格标题「质量保证措施」→ 不报', () => {
    expect(bidderQualificationSectionIssues('## 3.1 质量保证措施\n正文。')).toEqual([]);
  });
});

describe('W5 资格串章：形态B提供句式', () => {
  it('W5-9 「提供相关证明文件」→ 报', () => {
    expect(bidderQualificationSectionIssues('## 3.2 提供相关证明文件\n正文。')).toHaveLength(1);
  });
  it('W5-10 「须提供审计报告」→ 报', () => {
    expect(bidderQualificationSectionIssues('## 3.2 须提供审计报告\n正文。')).toHaveLength(1);
  });
  it('W5-11 「提供财务报表」（证明词表外）→ 不报', () => {
    expect(bidderQualificationSectionIssues('## 3.2 提供财务报表\n正文。')).toEqual([]);
  });
});

describe('W5 资格串章：聚合与层级', () => {
  it('W5-12 3 标题聚合 → message 3 个', () => {
    const md = '## 3.1 具备有效的营业执照\n正文。\n## 3.2 具备有效的资质证书\n正文。\n## 3.3 具备有效的安全生产许可证\n正文。';
    const issues = bidderQualificationSectionIssues(md);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('具备有效的营业执照');
    expect(issues[0].message).toContain('具备有效的安全生产许可证');
  });
  it('W5-13 4 标题 → slice(0,3)+「 等」', () => {
    const md = '## 3.1 具备有效的营业执照\n正文。\n## 3.2 具备有效的资质证书\n正文。\n## 3.3 具备有效的安全生产许可证\n正文。\n## 3.4 具备有效的食品经营许可证\n正文。';
    const issues = bidderQualificationSectionIssues(md);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain(' 等');
    expect(issues[0].message).not.toContain('食品经营许可证');
  });
  it('W5-14 H2/H4 也收（#{2,4}）→ 报', () => {
    expect(bidderQualificationSectionIssues('#### 具备有效的营业执照\n正文。')).toHaveLength(1);
  });
  it('W5-15 H5 不收 → 不报', () => {
    expect(bidderQualificationSectionIssues('##### 具备有效的营业执照\n正文。')).toEqual([]);
  });
  it('W5-16 无标题 → 不报', () => {
    expect(bidderQualificationSectionIssues('正文提及营业执照等内容。')).toEqual([]);
  });
});
