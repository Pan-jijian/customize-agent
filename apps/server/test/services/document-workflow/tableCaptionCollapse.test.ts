/**
 * 4.58 R9-e 题注链两处根治（全部取自 `doc-1790168542563-ea526b1b` 实测原文）。
 *
 * 实测该文档 12 个题注行中有 **1 处连续双题注**（`表1-34-1` / `表1-3`）、
 * **4 张表格无题注**（其中 1 张是"题注存在但与表格被正文隔开"形态）。
 */
import { describe, expect, it } from 'vitest';
import {
  collapseDuplicateTableCaptions,
  relocateDetachedTableCaptions,
} from '@/services/document-workflow/constructionOrgTablePlan';

describe('4.58 R9-e 连续多题注收敛', () => {
  it('实测回放：模型按小节号与文档表序各写一次题注 → 只保留第一行', () => {
    const markdown = [
      '#### 1.34.5 编制依据',
      '本工程编制依据由法律法规、条例办法、施工验收规范、地方性法规规章及招标文件引用法规五类构成，各类条目名称与编号如下表所列。',
      '表1-34-1 本工程编制依据文件一览表',
      '表1-3 依据文件一览表',
      '',
      '| 类别 | 名称与文号 |',
      '| --- | --- |',
      '| 国家法律 | 《中华人民共和国建筑法》 |',
    ].join('\n');
    const out = collapseDuplicateTableCaptions(markdown);
    expect(out).toContain('表1-34-1 本工程编制依据文件一览表');
    expect(out).not.toContain('表1-3 依据文件一览表');
    // 引导句与表体不得被动到
    expect(out).toContain('如下表所列。');
    expect(out).toContain('| 类别 | 名称与文号 |');
  });

  it('**防误删**：两张不同的表各有题注（中间隔表体）→ 原样保留', () => {
    const markdown = [
      '表1-1 第一张表',
      '',
      '| A | B |',
      '| --- | --- |',
      '| 1 | 2 |',
      '',
      '表1-2 第二张表',
      '',
      '| C | D |',
      '| --- | --- |',
      '| 3 | 4 |',
    ].join('\n');
    expect(collapseDuplicateTableCaptions(markdown)).toBe(markdown);
  });

  it('**防误删**：连续两行题注但后面不是表格 → 不动（可能是正文里的表格清单）', () => {
    const markdown = ['表1-1 第一张表', '表1-2 第二张表', '本段为表格清单说明。'].join('\n');
    expect(collapseDuplicateTableCaptions(markdown)).toBe(markdown);
  });
});

describe('4.58 R9-e 脱位题注归位', () => {
  it('实测回放：题注与表格之间夹着正文 → 题注下移到紧邻表格，正文保持原位', () => {
    const markdown = [
      '3. 安装完成的支吊架逐组编号登记，与管线综合图对应，形成可追溯的安装台账。',
      '表1-2 可追溯的安装台账',
      '抗震支吊架安装完成后，由质检员会同专业工程师按不少于10%比例抽检锚栓扭矩与斜撑角度，发现松动的当日登记并限期整改。',
      '',
      '| 工序节点 | 前置条件 | 完成时限 |',
      '| --- | --- | --- |',
      '| 支吊架安装 | 管道就位 | 当日 |',
    ].join('\n');
    const out = relocateDetachedTableCaptions(markdown);
    const lines = out.split('\n');
    const captionAt = lines.indexOf('表1-2 可追溯的安装台账');
    const tableAt = lines.findIndex(line => line.startsWith('| 工序节点'));
    // 题注紧邻表格（插到表格行之前，中间不留空行——题注属表格，紧邻才不会被再次判为脱位）
    expect(captionAt).toBe(tableAt - 1);
    // 正文行仍在题注之前（未被移动）
    expect(lines[0]).toContain('安装完成的支吊架逐组编号登记');
    expect(lines[1]).toContain('抗震支吊架安装完成后');
  });

  it('**防误移**：题注与表格之间有 3 行以上正文 → 视为题注属别处，不动', () => {
    const markdown = [
      '表1-2 可追溯的安装台账',
      '第一段正文。',
      '第二段正文。',
      '第三段正文。',
      '',
      '| A | B |',
      '| --- | --- |',
      '| 1 | 2 |',
    ].join('\n');
    expect(relocateDetachedTableCaptions(markdown)).toBe(markdown);
  });

  it('**防误移**：题注与表格之间隔着下一个标题 → 不动（题注属上一节）', () => {
    const markdown = ['表1-2 可追溯的安装台账', '### 3.2 下一小节', '', '| A | B |', '| --- | --- |', '| 1 | 2 |'].join('\n');
    expect(relocateDetachedTableCaptions(markdown)).toBe(markdown);
  });

  it('已就位的题注（紧邻表格）零改动', () => {
    const markdown = ['表1-2 可追溯的安装台账', '', '| A | B |', '| --- | --- |', '| 1 | 2 |'].join('\n');
    expect(relocateDetachedTableCaptions(markdown)).toBe(markdown);
  });
});
