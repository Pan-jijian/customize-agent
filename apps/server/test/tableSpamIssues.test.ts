import { describe, expect, it } from 'vitest';
import { tableSpamIssues } from '../src/services/document-workflow/qualityValidation';

function table(header: string, rows: string[]) {
  return [header, '|---|---|', ...rows].join('\n');
}

const HEADER = '| 检查项目 | 检查要求 |';

describe('tableSpamIssues（表格凑数治理）', () => {
  it('同表头表格出现 3 次及以上时给 warning', () => {
    const block = table(HEADER, ['| 模板安装 | 偏差小于 5mm |', '| 钢筋绑扎 | 间距均匀 |']);
    const markdown = [block, '说明一。', block, '说明二。', block, '说明三。'].join('\n\n');
    const issues = tableSpamIssues(markdown);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('同主题表格重复堆叠');
  });

  it('同表头仅 2 次不告警（正常复用）', () => {
    const block = table(HEADER, ['| 模板安装 | 偏差小于 5mm |']);
    const markdown = [block, '说明一。', block, '说明二。'].join('\n\n');
    expect(tableSpamIssues(markdown)).toEqual([]);
  });

  it('相邻表格无正文分隔连续堆叠 2 处及以上时给 warning', () => {
    const markdown = [
      table('| A | B |', ['| 1 | 2 |']),
      table('| C | D |', ['| 3 | 4 |']),
      table('| E | F |', ['| 5 | 6 |']),
    ].join('\n');
    const issues = tableSpamIssues(markdown);
    expect(issues.some(issue => issue.message.includes('表格连续堆叠'))).toBe(true);
  });

  it('表格间有正文分隔时不告警', () => {
    const markdown = [
      table('| A | B |', ['| 1 | 2 |']),
      '',
      '表格后的引导叙述正文，说明数据结论。',
      '',
      table('| C | D |', ['| 3 | 4 |']),
    ].join('\n');
    expect(tableSpamIssues(markdown)).toEqual([]);
  });
});
