/**
 * mergeTableLineBreaks 组合矩阵（4.12.7 前补齐）：
 * 断行识别口径锁定——「含 ≥2 个竖线且不以 | 开头的行」才判断行（≥2 竖线约束是既有设计：
 * 单竖线/无竖线残行无法与正文区分，由 exportGate 表格列数检测收口）。
 * 矩阵覆盖：分隔行后断行转表格行（列数 × 断行单元格数）、数据行后断行合并回上一行、
 * 合法表格/正文恒等不变、单竖线与无竖线残行原样保留、连续断行内容零丢失。
 */
import { describe, expect, it } from 'vitest';
import { mergeTableLineBreaks } from '@/services/document-workflow/markdownComposer';

/** 分隔行后断行（≥2 竖线）转表格行矩阵：列数 3-6 × 断行单元格数 cols-1/cols */
const DIVIDER_AFTER_CASES: Array<{ cols: number; parts: string[] }> = [];
const CELL_POOL = ['第一列内容', '第二列内容', '第三列内容', '第四列内容', '第五列内容', '第六列内容'];
for (const cols of [3, 4, 5, 6]) {
  // take 至少 3：断行须含 ≥2 个竖线才触发断行识别（take-1 ≥ 2）；Set 去重避免 cols=3 重复
  for (const take of new Set([Math.max(3, cols - 1), cols])) {
    DIVIDER_AFTER_CASES.push({ cols, parts: CELL_POOL.slice(0, take) });
  }
}

function buildDividerMd(cols: number): string {
  return `| ${Array.from({ length: cols }, () => '---').join(' | ')} |`;
}

describe('mergeTableLineBreaks 分隔行后断行转表格行矩阵（列数 3-6 × 断行 ≥2 竖线）', () => {
  it.each(DIVIDER_AFTER_CASES as Array<{ cols: number; parts: string[] }>)('列数 %s、断行 %s 格：内容零丢失', ({ cols, parts }) => {
    const header = `| ${Array.from({ length: cols }, (_, i) => `表头${i + 1}`).join(' | ')} |`;
    const md = `${header}\n${buildDividerMd(cols)}\n${parts.join(' | ')}`;
    const result = mergeTableLineBreaks(md);
    // 分隔行必须原样保留
    expect(result).toContain(buildDividerMd(cols));
    // 断行补首尾竖线转表格行，全部单元格内容零丢失
    expect(result).toContain(`| ${parts.join(' | ')} |`);
    for (const part of parts) {
      expect(result).toContain(part);
    }
  });
});

describe('mergeTableLineBreaks 分隔行后低竖线残行原样保留矩阵（<2 竖线不触发断行合并）', () => {
  it.each([
    ['第一列内容'],
    ['第一列内容 |'],
    ['第一列内容 | 第二列内容'],
  ])('原样 #%#：%s', (brokenLine) => {
    const md = `| 项目 | 内容 | 备注 |\n${buildDividerMd(3)}\n${brokenLine}`;
    const result = mergeTableLineBreaks(md);
    // <2 竖线的残行无法与正文区分，保守原样保留，由 exportGate 列数检测报告修复
    expect(result).toContain(brokenLine);
    expect(result).toContain(buildDividerMd(3));
  });
});

describe('mergeTableLineBreaks 数据行后断行合并矩阵（≥2 竖线断行并入上一行）', () => {
  it.each([
    ['总监理工程师审查签字并加盖执业印章 | 组织不少于5名专家论证 | 并报专家库'],
    ['续表：第二页内容 | 补充说明 | 尾部单元格'],
    ['（注：单元格内换行）| 尾部内容 | 末列内容'],
    ['断行单元格一 | 断行单元格二 | 断行单元格三'],
    ['超危大工程专项方案由施工单位组织论证 | 专家人数不少于5人 | 论证结论留档'],
  ])('合并 #%#：%s', (brokenLine) => {
    const md = `| 危大工程名称 | 工程参数 | 危大类别 | 专项方案审批 |
| --- | --- | --- | --- |
| 基坑土方开挖与支护 | 地下1层，开挖深度超过5m，采用放坡喷锚支护 | 超过一定规模危大工程 | 施工单位技术负责人审核签字并加盖单位公章， |
${brokenLine}`;
    const result = mergeTableLineBreaks(md);
    const parts = brokenLine.split('|').map(cell => cell.trim());
    // 首段并入上一行尾单元格、其余段以分号连接追加，全部内容零丢失
    for (const part of parts) {
      expect(result).toContain(part);
    }
    expect(result).toContain(`；${parts.slice(1).join('；')} |`);
    // 合并后表格总行数收敛为 3 行（表头+分隔行+合并数据行）
    expect(result.split('\n')).toHaveLength(3);
  });
});

describe('mergeTableLineBreaks 合法表格与正文恒等矩阵（不误合并）', () => {
  it.each([
    '正文段落。\n\n| 项目 | 内容 |\n| --- | --- |\n| 名称 | 徽光阁 |',
    '本工程采用流水施工。\n\n| 项目 | 内容 |\n| --- | --- |\n| 名称 | 徽光阁 |',
    '| 项目 | 内容 |\n| --- | --- |\n\n正文段落。',
    '| 项目 | 内容 |\n| --- | --- |\n| 名称 | 徽光阁 |\n\n段落与表格互不影响。',
    '## 标题\n\n正文第一段。\n\n正文第二段。\n\n| 项目 | 内容 |\n| --- | --- |\n| 名称 | 徽光阁 |',
    '| 项目 | 内容 |\n| --- | --- |\n| 名称 | 徽光阁 |\n| 地点 | 合肥市 |',
    '| 项目 | 内容 |\n| --- | --- |',
    '正文不含任何竖线。',
  ])('恒等 #%#', (md) => {
    expect(mergeTableLineBreaks(md)).toBe(md);
  });
});

describe('mergeTableLineBreaks 连续断行与内容零丢失矩阵', () => {
  it('连续两条 ≥2 竖线断行均正确处理（不丢失任何内容）', () => {
    const md = `| 项目 | 内容 | 备注 |
| --- | --- | --- |
| 名称 | 第一行， |
断行一 | 断行二 | 断行三 |
断行四 | 断行五 | 断行六 |`;
    const result = mergeTableLineBreaks(md);
    for (const part of ['断行一', '断行二', '断行三', '断行四', '断行五', '断行六']) {
      expect(result).toContain(part);
    }
  });

  it('数据行断行后再跟断行（第二条紧跟合并后的表格行）内容零丢失', () => {
    const md = `| 项目 | 内容 | 备注 |
| --- | --- | --- |
| 名称 | 第一行尾， |
续行一 | 续行二 | 续行三 |`;
    const result = mergeTableLineBreaks(md);
    expect(result).toContain('续行一');
    expect(result).toContain('续行二');
    expect(result).toContain('续行三');
  });
});
