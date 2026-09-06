import { describe, expect, it } from 'vitest';
import { collapseRepeatedWords, mergeTableLineResidues, repeatedWordIssues, REPEATED_WORD_RE, stripDuplicateTables } from '../../../src/services/document-workflow/documentIntegrityChecks';

describe('B6 确定性表面修复', () => {
  it('叠词检测豁免分部分项术语', () => {
    const md = '本项目涵盖道路硬化等全部分部分项内容。执行执行应改为执行。';
    const issues = repeatedWordIssues(md);
    expect(issues.length).toBe(1);
    expect(issues[0]!.message).toContain('执行执行');
    expect(REPEATED_WORD_RE.test('分部分项')).toBe(false);
    expect(REPEATED_WORD_RE.test('执行执行')).toBe(true);
  });

  it('叠词收敛不破坏分部分项', () => {
    const md = '全部分部分项内容。执行执行改为执行。';
    expect(collapseRepeatedWords(md)).toBe('全部分部分项内容。执行改为执行。');
  });

  it('表格断行残片合并回上一行末单元格', () => {
    const md = [
      '| 施工准备与清理清表 | 第90日 | 32人 | 增开清表作业面， |',
      '延长有效作业时间 |',
      '| 道路路基工程 | 第30日 | 86人 | 增加碾压设备 |',
    ].join('\n');
    const result = mergeTableLineResidues(md);
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toContain('| 施工准备与清理清表 | 第90日 | 32人 | 增开清表作业面，延长有效作业时间 |');
    expect(result.markdown).not.toContain('\n延长有效作业时间 |');
  });

  it('非表格正文行不误合并', () => {
    const md = '普通正文段落无表格。\n安全措施到位 |\n下一段正文。';
    const result = mergeTableLineResidues(md);
    expect(result.fixedCount).toBe(0);
  });

  it('同章重复工程概况表全文级删除', () => {
    const md = [
      '| 工程名称 | 建设地点 | 建设规模 |',
      '| --- | --- | --- |',
      '| 丰乐镇项目 | 肥西县 | 覆盖20个村 |',
      '',
      '| 工程名称 | 建设地点 | 建设规模 |',
      '| --- | --- | --- |',
      '| 丰乐镇项目 | 肥西县 | 覆盖20个村 |',
    ].join('\n');
    const result = stripDuplicateTables(md);
    expect(result.removedCount).toBeGreaterThan(0);
    expect(result.markdown.match(/\| 丰乐镇项目/g)!.length).toBe(1);
  });
});
