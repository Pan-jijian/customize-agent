/**
 * 第十四批边界矩阵（P 组）：文字形态族。
 * 覆盖：叠词重复与去重（P1）、表格断行残片合并（P2）、段首开场重复（P3）、
 * 概况段跨章复述（P4）、修复收敛循环（P5）。
 */
import { describe, expect, it } from 'vitest';
import {
  collapseRepeatedWords,
  mergeTableLineResidues,
  overviewRecapCandidates,
  overviewRecapIssues,
  paragraphOpeningRepeatIssues,
  REPEATED_WORD_RE,
  repeatedWordIssues,
  runDeterministicChainUntilConverged,
  runFixUntilClean,
} from '@/services/document-workflow/documentIntegrityChecks';

describe('P1 叠词重复：repeatedWordIssues + collapseRepeatedWords + REPEATED_WORD_RE', () => {
  it('P1-1 「执行执行」报叠词', () => {
    const issues = repeatedWordIssues('现场执行执行方案。');
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('执行执行');
  });
  it.each(['进行进行', '配合配合', '组织组织', '检查检查'])('P1-2 叠词谱系：%s', word => {
    expect(repeatedWordIssues(`现场${word}工作。`)).toHaveLength(1);
  });
  it('P1-3 非紧邻重复不报：执行方案执行', () => {
    expect(repeatedWordIssues('执行方案执行。')).toHaveLength(0);
  });
  it('P1-4 「分部分项」术语保护：前有「分」不报', () => {
    expect(repeatedWordIssues('全部分部分项内容。')).toHaveLength(0);
  });
  it('P1-5 后跟「项」不报：部分部分项', () => {
    expect(repeatedWordIssues('部分部分项。')).toHaveLength(0);
  });
  it('P1-6 三连重复报：进行进行进行', () => {
    expect(repeatedWordIssues('进行进行进行。')).toHaveLength(1);
  });
  it('P1-7 多词去重聚合单条issue且最多列3个', () => {
    const issues = repeatedWordIssues('执行执行、进行进行、配合配合、组织组织。');
    expect(issues).toHaveLength(1);
    const names = [...issues[0].message.matchAll(/“([^”]+)”/gu)].map(match => match[1]);
    expect(names).toHaveLength(3);
  });
  it('P1-8 collapse收敛：执行执行→执行', () => {
    expect(collapseRepeatedWords('现场执行执行方案。')).toBe('现场执行方案。');
  });
  it('P1-9 collapse全量替换：两处重复均收敛', () => {
    expect(collapseRepeatedWords('执行执行。进行进行。')).toBe('执行。进行。');
  });
  it('P1-10 collapse不触碰分部分项', () => {
    expect(collapseRepeatedWords('全部分部分项内容。')).toBe('全部分部分项内容。');
  });
  it('P1-11 REPEATED_WORD_RE共享正则lastIndex语义：matchAll重复使用不串状态', () => {
    const first = [...'执行执行。'.matchAll(REPEATED_WORD_RE)].length;
    const second = [...'进行进行。'.matchAll(REPEATED_WORD_RE)].length;
    expect(first).toBe(1);
    expect(second).toBe(1);
  });
  it('P1-12 英文与数字不参与叠词判定', () => {
    expect(repeatedWordIssues('ABC ABC 123 123。')).toHaveLength(0);
  });
});

describe('P2 表格断行残片合并：mergeTableLineResidues', () => {
  it('P2-1 标准残行拼回上一行末单元格（中文标点结尾不加空格）', () => {
    const md = '| 工作内容 | 备注 |\n| 连续作业 | 增开清表作业面， |\n延长有效作业时间 |';
    const result = mergeTableLineResidues(md);
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toContain('增开清表作业面，延长有效作业时间 |');
  });
  it('P2-2 英文结尾加空格拼接', () => {
    const md = '| a | b |\nextended time |';
    const result = mergeTableLineResidues(md);
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toContain('| a | b extended time |');
  });
  it('P2-3 上一行非表格行不拼', () => {
    const result = mergeTableLineResidues('正文段落\n残行内容 |');
    expect(result.fixedCount).toBe(0);
  });
  it('P2-4 多竖线残行不拼', () => {
    const result = mergeTableLineResidues('| a | b |\nc | d |');
    expect(result.fixedCount).toBe(0);
  });
  it('P2-5 以竖线开头残行不拼', () => {
    const result = mergeTableLineResidues('| a | b |\n| 残行 |');
    expect(result.fixedCount).toBe(0);
  });
  it('P2-6 标题行残片不拼', () => {
    const result = mergeTableLineResidues('| a | b |\n# 标题 |');
    expect(result.fixedCount).toBe(0);
  });
  it('P2-7 空行不拼', () => {
    const result = mergeTableLineResidues('| a | b |\n |');
    expect(result.fixedCount).toBe(0);
  });
  it('P2-8 多处残行逐处合并', () => {
    const md = '| a | b |\n残片一 |\n| c | d |\n残片二 |';
    const result = mergeTableLineResidues(md);
    expect(result.fixedCount).toBe(2);
    expect(result.markdown).toContain('| a | b 残片一 |');
    expect(result.markdown).toContain('| c | d 残片二 |');
  });
  it('P2-9 上一行末单元格已有标点：不加空格', () => {
    const md = '| 措施 | 施工前检查。 |\n检查合格后作业 |';
    const result = mergeTableLineResidues(md);
    expect(result.markdown).toContain('施工前检查。检查合格后作业 |');
  });
  it('P2-10 无残行原文不变', () => {
    const result = mergeTableLineResidues('| a | b |\n普通正文。');
    expect(result.fixedCount).toBe(0);
    expect(result.markdown).toBe('| a | b |\n普通正文。');
  });
});

describe('P3 段首开场重复：paragraphOpeningRepeatIssues', () => {
  const opening = '本工程严格按照相关规范标准组织现场施工。';
  it('P3-1 同构开场3次报warning', () => {
    const md = `${opening}\n${opening}\n${opening}`;
    const issues = paragraphOpeningRepeatIssues(md);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('warning');
    expect(issues[0].message).toContain('3');
  });
  it('P3-2 2次不报（阈值3）', () => {
    const md = `${opening}\n${opening}`;
    expect(paragraphOpeningRepeatIssues(md)).toHaveLength(0);
  });
  it('P3-3 数字差异掩盖同构：面积数字不同仍判重复', () => {
    const md = '本工程总建筑面积为12345.67平方米。\n本工程总建筑面积为67890.12平方米。\n本工程总建筑面积为11111.11平方米。';
    expect(paragraphOpeningRepeatIssues(md)).toHaveLength(1);
  });
  it('P3-4 指纹去标点：百分号数字归一', () => {
    const md = '本工程装配率目标为30%且满足规范要求。\n本工程装配率目标为50%且满足规范要求。\n本工程装配率目标为20%且满足规范要求。';
    expect(paragraphOpeningRepeatIssues(md)).toHaveLength(1);
  });
  it('P3-5 指纹短于10字跳过（去数字后剩余不足10字）', () => {
    const line = '1234567890123456短。';
    const md = `${line}\n${line}\n${line}`;
    expect(paragraphOpeningRepeatIssues(md)).toHaveLength(0);
  });
  it('P3-6 标题行后的首句参与判定', () => {
    const md = `# 第一章\n${opening}\n## 第二章\n${opening}\n# 第三章\n${opening}`;
    expect(paragraphOpeningRepeatIssues(md)).toHaveLength(1);
  });
  it('P3-7 表格行不参与判定', () => {
    const md = `| ${opening} |\n| ${opening} |\n| ${opening} |`;
    expect(paragraphOpeningRepeatIssues(md)).toHaveLength(0);
  });
  it('P3-8 句长不足18字不匹配', () => {
    const md = '短句结束。\n短句结束。\n短句结束。';
    expect(paragraphOpeningRepeatIssues(md)).toHaveLength(0);
  });
  it('P3-9 不同开场指纹互不干扰', () => {
    const other = '项目部建立完善的质量安全管理体系。';
    const md = `${opening}\n${opening}\n${other}\n${other}`;
    expect(paragraphOpeningRepeatIssues(md)).toHaveLength(0);
  });
  it('P3-10 多指纹重复聚合：各自独立报出', () => {
    const other = '项目部建立完善的质量安全管理体系并持续运行。';
    const md = `${opening}\n${opening}\n${opening}\n${other}\n${other}\n${other}`;
    const issues = paragraphOpeningRepeatIssues(md);
    expect(issues).toHaveLength(2);
  });
});

describe('P4 概况段跨章复述：overviewRecapCandidates/Issues', () => {
  it('P4-1 概况区句子不入候选池', () => {
    const md = '## 工程概况\n本项目为某市市政道路改造工程。\n\n## 施工部署\n本章介绍施工组织。';
    const { overviewBody, sentences } = overviewRecapCandidates(md);
    expect(overviewBody).toContain('本项目为某市市政道路改造工程');
    expect(sentences).toHaveLength(0);
  });
  it('P4-2 概况区外复述句入候选池', () => {
    const md = '## 工程概况\n本项目为某市市政道路改造工程。\n\n## 施工部署\n本项目为某市市政道路改造工程。';
    const { sentences } = overviewRecapCandidates(md);
    expect(sentences).toHaveLength(1);
  });
  it.each(['本项目为', '本工程为', '该项目为', '该工程为'])('P4-3 开头形态谱系：%s', prefix => {
    const md = `## 工程概况\n本项目为某市市政道路改造工程。\n\n## 施工部署\n${prefix}某市市政道路改造工程。`;
    expect(overviewRecapCandidates(md).sentences).toHaveLength(1);
  });
  it('P4-4 复述句短于12字符不采', () => {
    const md = '## 工程概况\n本项目为某市市政道路改造工程。\n\n## 施工部署\n本项目为X。';
    expect(overviewRecapCandidates(md).sentences).toHaveLength(0);
  });
  it('P4-5 无概况区早退', () => {
    const md = '## 施工部署\n本项目为某市市政道路改造工程。';
    expect(overviewRecapCandidates(md).overviewBody).toBe('');
  });
  it('P4-6 同级标题终止概况区间', () => {
    const md = '### 工程概况\n本项目为某市市政道路改造工程。\n\n### 施工部署\n本项目为某市市政道路改造工程。';
    const { overviewBody, sentences } = overviewRecapCandidates(md);
    expect(overviewBody).toContain('工程概况');
    expect(sentences).toHaveLength(1);
  });
  it('P4-7 高级标题（H2）终止H3概况区间', () => {
    const md = '### 工程概况\n本项目为某市市政道路改造工程。\n\n## 正文\n本项目为某市市政道路改造工程。';
    const { overviewBody, sentences } = overviewRecapCandidates(md);
    expect(overviewBody).not.toContain('## 正文');
    expect(sentences).toHaveLength(1);
  });
  it('P4-8 项目名逐字搬用（≥8 汉字连续重合）→ 报', () => {
    const md = '## 工程概况\n本项目为舒城县公共广场空间改造提升工程，总工期360日历天。\n\n## 施工部署\n本项目为舒城县公共广场空间改造提升工程，按分区流水组织施工。';
    const issues = overviewRecapIssues(md);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('跨章复述');
  });
  it('P4-9 范围清单摘抄（≥2 项逐字重合）→ 报', () => {
    const md = '## 工程概况\n本工程主要施工内容包含公共广场改造、停车场改造、绿化工程等。\n\n## 施工部署\n本工程为综合改造工程，施工范围涉及公共广场、停车场、绿化工程等。';
    expect(overviewRecapIssues(md)).toHaveLength(1);
  });
  it('P4-10 无概况事实重合的总述句 → 不报', () => {
    const md = '## 工程概况\n本项目为某市市政道路改造工程，合同工期360日历天。\n\n## 施工部署\n本工程为多单体工程，各单体同步交叉施工。';
    expect(overviewRecapIssues(md)).toHaveLength(0);
  });
  it('P4-11 复述句最多计3处', () => {
    const md = '## 工程概况\n本项目为某市市政道路改造工程。\n\n## 一\n本项目为某市市政道路改造工程。\n## 二\n本项目为某市市政道路改造工程。\n## 三\n本项目为某市市政道路改造工程。\n## 四\n本项目为某市市政道路改造工程。';
    const issues = overviewRecapIssues(md);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('3 处');
  });
});

describe('P5 修复收敛循环：runFixUntilClean + runDeterministicChainUntilConverged', () => {
  it('P5-1 runFixUntilClean单轮清零收敛', () => {
    const fix = (md: string) => md.includes('执行执行') ? { markdown: md.replace('执行执行', '执行'), fixedCount: 1 } : { markdown: md, fixedCount: 0 };
    const result = runFixUntilClean(fix, '执行执行。');
    expect(result.markdown).toBe('执行。');
    expect(result.fixedCount).toBe(1);
  });
  it('P5-2 runFixUntilClean修复引入新命中多轮收敛', () => {
    // 每轮仅去除 2 字符（一组「执行」），连续 5 组需 5 轮才收敛到单组（修复引入新命中的多轮收敛形态）
    const fix = (md: string) => {
      const hit = md.match(/(?:执行){2,}/u);
      if (!hit) return { markdown: md, fixedCount: 0 };
      const collapsed = hit[0].length > 2 ? hit[0].slice(2) : '执行';
      return { markdown: md.replace(hit[0], collapsed), fixedCount: 1 };
    };
    const result = runFixUntilClean(fix, '执行执行执行执行执行。', 6);
    expect(result.markdown).toBe('执行。');
    expect(result.fixedCount).toBe(4);
  });
  it('P5-3 runFixUntilClean轮次上限保护：超限截断', () => {
    const fix = () => ({ markdown: '执行执行。', fixedCount: 1 });
    const result = runFixUntilClean(fix, '执行执行。', 2);
    expect(result.fixedCount).toBe(2);
    expect(result.markdown).toBe('执行执行。');
  });
  it('P5-4 runFixUntilClean零命中直接返回', () => {
    const fix = () => ({ markdown: '执行。', fixedCount: 0 });
    const result = runFixUntilClean(fix, '执行。');
    expect(result.fixedCount).toBe(0);
  });
  it('P5-5 链循环收敛：A修复后B新命中整链重跑', () => {
    const fixA = (md: string) => (md.includes('AA') ? { markdown: md.replace('AA', 'A'), fixedCount: 1 } : { markdown: md, fixedCount: 0 });
    const fixB = (md: string) => (md.includes('BB') ? { markdown: md.replace('BB', 'B'), fixedCount: 1 } : { markdown: md, fixedCount: 0 });
    const result = runDeterministicChainUntilConverged([fixA, fixB], 'AA BB');
    expect(result.markdown).toBe('A B');
    expect(result.fixedCount).toBe(2);
  });
  it('P5-6 链循环无进展即跳出', () => {
    const fixA = () => ({ markdown: '固定。', fixedCount: 0 });
    const result = runDeterministicChainUntilConverged([fixA], '固定。', 3);
    expect(result.fixedCount).toBe(0);
  });
  it('P5-7 链循环轮次上限保护', () => {
    const never = (md: string) => ({ markdown: md, fixedCount: 1 });
    const result = runDeterministicChainUntilConverged([never], 'X', 2);
    expect(result.fixedCount).toBe(2);
  });
  it('P5-8 链内多修复器同一轮累计fixedCount', () => {
    const fixA = (md: string) => (md.includes('A1') ? { markdown: md.replace('A1', 'A'), fixedCount: 1 } : { markdown: md, fixedCount: 0 });
    const fixB = (md: string) => (md.includes('B1') ? { markdown: md.replace('B1', 'B'), fixedCount: 1 } : { markdown: md, fixedCount: 0 });
    const result = runDeterministicChainUntilConverged([fixA, fixB], 'A1 B1');
    expect(result.markdown).toBe('A B');
    expect(result.fixedCount).toBe(2);
  });
});
