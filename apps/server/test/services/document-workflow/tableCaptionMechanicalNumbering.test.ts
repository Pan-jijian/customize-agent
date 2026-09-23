/**
 * 4.59 R-B3（第二半）题注编号机械生成 —— 用例矩阵。
 *
 * 判据实现（单源）：`constructionOrgTablePlan.stripModelAuthoredCaptionNumbers`（三重门剥离）
 * + `finalizeTableCaptions`（题注链单一入口，剥离插在 ②-b 与 ③ 之间）。
 * 写作期一半（任务卡声明）见 `TABLE_CAPTION_MECHANICAL_RULE`，接线用例在 taskCardPromptExampleNumber.test.ts。
 *
 * 实测根因（4.59 交付物，编制依据章）：模型按**小节号**写 `表1-34-1 本工程编制依据文件一览表`、
 * 又按**文档表序**写 `表1-3 本工程编制依据文件一览表`，两行连续；收敛去重后留下 `表1-34-1 …`，
 * 而注入器的幂等判据（编号须数字收尾）与残缺判据（破折号后须非数字）对 `表1-34-1` **两条都不匹配**
 * → 再叠一层编号，产出「表1-3 表1-34-1 表名」。故编号所有权必须从模型手里收回：链尾剥离 → 注入器按章内表序重排。
 *
 * 用例文本均逐字取自实测形态（本仓硬标准：不用抽象样例）。
 */
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { finalizeTableCaptions, stripModelAuthoredCaptionNumbers } from '@/services/document-workflow/constructionOrgTablePlan';

const SRC_DIR = path.resolve(__dirname, '../../../src/services/document-workflow');

/** 递归收集 .ts 源文件（排除测试） */
function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) return [];
    return [full];
  });
}

const TABLE_BASIS = ['| 序号 | 文件名称 |', '| --- | --- |', '| 1 | 建筑桩基技术规范 |'];
const TABLE_LABOR = ['| 序号 | 工种 |', '| --- | --- |', '| 1 | 瓦工 |'];
const TABLE_MACHINE = ['| 序号 | 名称 |', '| --- | --- |', '| 1 | 塔式起重机 |'];

/** 章节骨架 + 给定行（首行恒为章标题，模拟真实章内 markdown） */
function chapterDoc(lines: string[]): string {
  return ['## 第一章 编制依据', '', ...lines].join('\n');
}

describe('R-B3 题注编号机械生成：链尾剥离判据（三重门）', () => {
  it('正向：实测双编号行（表1-34-1 本工程编制依据文件一览表）紧邻表格 → 剥离 1 处，残名保留', () => {
    const { markdown, stripped } = stripModelAuthoredCaptionNumbers(chapterDoc(['表1-34-1 本工程编制依据文件一览表', '', ...TABLE_BASIS]));
    expect(stripped).toBe(1);
    expect(markdown).toContain('本工程编制依据文件一览表');
    expect(markdown).not.toContain('表1-34-1');
  });

  it('正向：编号头叠加（表1-3 表1-34-1 表名）→ 循环剥离至无编号头（上限 3 轮）', () => {
    const { markdown, stripped } = stripModelAuthoredCaptionNumbers(chapterDoc(['表1-3 表1-34-1 本工程编制依据文件一览表', '', ...TABLE_BASIS]));
    expect(stripped).toBe(1);
    expect(markdown).not.toContain('表1-3 表1-34-1');
    expect(markdown).toContain('本工程编制依据文件一览表');
  });

  it('正向：编号头允许空格与全角冒号（表 1-3：劳动力投入计划表）→ 剥离后残名合法', () => {
    const { markdown, stripped } = stripModelAuthoredCaptionNumbers(chapterDoc(['表 1-3：劳动力投入计划表', '', ...TABLE_LABOR]));
    expect(stripped).toBe(1);
    expect(markdown).toContain('劳动力投入计划表');
  });

  it('反向（防剥离后无人认领）：无紧邻表格的悬挂题注不剥 —— 剥离只会把它变成游离正文', () => {
    const src = chapterDoc(['表1-34-1 本工程编制依据文件一览表', '', '本工程依据上述文件组织施工，逐项对照核验。', '', ...TABLE_BASIS]);
    const { markdown, stripped } = stripModelAuthoredCaptionNumbers(src);
    expect(stripped).toBe(0);
    expect(markdown).toBe(src);
  });

  it('反向（防剥离后无人认领）：全文无表格时编号保留（该题注由终检「题注悬空」族处置，不归本函数）', () => {
    const src = chapterDoc(['表1-3 本工程编制依据文件一览表', '', '本工程依据上述文件组织施工。']);
    expect(stripModelAuthoredCaptionNumbers(src)).toEqual({ markdown: src, stripped: 0 });
  });

  it('反向（防剥出非法残名）：残名不合法（表1-2 表）→ 不剥，原行原样保留', () => {
    const src = chapterDoc(['表1-2 表', '', ...TABLE_MACHINE]);
    expect(stripModelAuthoredCaptionNumbers(src)).toEqual({ markdown: src, stripped: 0 });
  });

  it('反向（引用不动）：正文行内引用（本工程劳动力投入见表1-3 所列）不是题注行 → 剥了会让引用指向失效', () => {
    const src = chapterDoc(['本工程劳动力投入见表1-3 所列，按周动态调整。', '', ...TABLE_LABOR]);
    expect(stripModelAuthoredCaptionNumbers(src)).toEqual({ markdown: src, stripped: 0 });
  });

  it('边界：附表区（## 附表N 之后）不参与剥离 —— 附表编号体系独立', () => {
    const src = chapterDoc(['## 附表1 拟投入本标段的主要施工设备表', '', '表附-9 拟投入主要施工设备表', '', ...TABLE_MACHINE]);
    expect(stripModelAuthoredCaptionNumbers(src)).toEqual({ markdown: src, stripped: 0 });
  });

  it('边界：标题行（## 表1-3 编制依据）与空输入不是题注行 → 计数 0、文本不变', () => {
    const heading = '## 表1-3 编制依据\n\n正文。';
    expect(stripModelAuthoredCaptionNumbers(heading)).toEqual({ markdown: heading, stripped: 0 });
    expect(stripModelAuthoredCaptionNumbers('')).toEqual({ markdown: '', stripped: 0 });
  });
});

describe('R-B3 判据单源：题注编号头只有一份口径（可执行的契约，不是注释约定）', () => {
  it('编号字符类碎片全仓只有一处定义（再抄一份字符类即红）', () => {
    const offenders = sourceFiles(SRC_DIR)
      .filter(file => /(?:const|let|var)\s+\w*CAPTION\w*DIGITS\w*\s*=/u.test(fs.readFileSync(file, 'utf8')))
      .map(file => path.relative(SRC_DIR, file));
    expect(offenders).toEqual(['constructionOrgTablePlan.ts']);
  });

  it('题注家族所在文件内不再出现手写编号字符类（变体必须由碎片拼装）', () => {
    const text = fs.readFileSync(path.join(SRC_DIR, 'constructionOrgTablePlan.ts'), 'utf8');
    // 命中字符类本体（`[\d一二三四五六七八九十]+`，含字符串转义写法 `[\\d…]`）
    const literalCopies = text.split('\n').filter(line => /\[\\*d一二三四五六七八九十\]\+/u.test(line));
    // 仅允许出现在碎片常量定义那一行；再出现即"第二份拷贝"（4.58 双编号根因：两套编号判据互不承认）
    expect(literalCopies).toHaveLength(1);
    expect(literalCopies[0]).toContain('TABLE_CAPTION_DIGITS');
  });
});

describe('R-B3 题注编号机械生成：单一入口链（剥离 → 注入 → 重排）', () => {
  it('正向：实测双题注（表1-34-1 + 表1-3）→ 收敛为一行，且不再出现双编号形态', () => {
    const out = finalizeTableCaptions(chapterDoc(['表1-34-1 本工程编制依据文件一览表', '表1-3 本工程编制依据文件一览表', '', ...TABLE_BASIS]));
    expect(out).not.toContain('表1-34-1');
    expect(out).not.toContain('表1-3 表1-34-1');
    expect(out).toContain('表1-1 依据文件一览表');
    // 表格本体零改动
    expect(out).toContain(TABLE_BASIS.join('\n'));
  });

  it('正向：模型编号与章内表序不齐（表1-7/表1-8 实为第 1、2 张表）→ 重排为表1-1/表1-2', () => {
    const out = finalizeTableCaptions(chapterDoc(['表1-7 主要施工机械设备配置表', '', ...TABLE_MACHINE, '', '表1-8 劳动力投入计划表', '', ...TABLE_LABOR]));
    expect(out).toContain('表1-1 主要施工机械设备配置表');
    expect(out).toContain('表1-2 劳动力投入计划表');
    expect(out).not.toContain('表1-7');
    expect(out).not.toContain('表1-8');
  });

  it('正向：粘连题注（表1-3 劳动力投入计划表上述措施…）→ 题注归为表1-1，粘连句回位表下（正文零丢失）', () => {
    const out = finalizeTableCaptions(chapterDoc(['表1-3 劳动力投入计划表上述措施落实到各作业班组并逐周考核。', '', ...TABLE_LABOR]));
    expect(out).toContain('表1-1 劳动力投入计划表');
    expect(out).toContain('上述措施落实到各作业班组并逐周考核。');
    expect(out).not.toContain('表1-3');
    // 粘连句必须落在表格之外（否则会被当成表体内容）
    const tableAt = out.indexOf(TABLE_LABOR[0]);
    expect(out.indexOf('上述措施落实到各作业班组并逐周考核。')).toBeGreaterThan(tableAt + TABLE_LABOR.length);
  });

  it('正向：悬挂题注经归位后即被剥离并重新认领（实测悬挂形态）', () => {
    const out = finalizeTableCaptions(chapterDoc(['表1-34-1 本工程编制依据文件一览表', '', '本工程依据上述文件组织施工，逐项对照核验。', '', ...TABLE_BASIS]));
    expect(out).not.toContain('表1-34-1');
    expect(out).toContain('表1-1 依据文件一览表');
    expect(out).toContain('本工程依据上述文件组织施工，逐项对照核验。');
  });

  it('零静默降级：发生剥离时必须留下可见记录（console.warn 含 R-B3 与剥离计数）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    finalizeTableCaptions(chapterDoc(['表1-34-1 本工程编制依据文件一览表', '', ...TABLE_BASIS]));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('4.59 R-B3');
    expect(String(warn.mock.calls[0][0])).toContain('剥离模型自写题注编号 1 处');
    warn.mockRestore();
  });

  it('零静默降级：无剥离时不产生噪声记录（仅编号写对/无编号的文档不报警）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    finalizeTableCaptions(chapterDoc(['本工程编制依据文件一览表', '', ...TABLE_BASIS]));
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('不变：编号本就写对（单一表格 = 表1-1）时输出与输入逐字节一致', () => {
    const src = chapterDoc(['表1-1 主要施工机械设备配置表', '', ...TABLE_MACHINE]);
    expect(finalizeTableCaptions(src)).toBe(src);
  });

  it('不变：无编号的纯表名题注（写作期约束生效后的模型输出形态）不受影响', () => {
    const out = finalizeTableCaptions(chapterDoc(['本工程编制依据文件一览表', '', ...TABLE_BASIS]));
    expect(out).toContain('本工程编制依据文件一览表');
    expect(out).toContain('表1-1 依据文件一览表');
    expect(out).toContain(TABLE_BASIS.join('\n'));
  });

  it('不变：正文段落与章节标题零改动，非题注内容不因剥离被吞', () => {
    const out = finalizeTableCaptions(chapterDoc(['本章依据下列文件编制。', '', '表1-34-1 本工程编制依据文件一览表', '', ...TABLE_BASIS]));
    expect(out).toContain('## 第一章 编制依据');
    expect(out).toContain('本章依据下列文件编制。');
    expect(out).toContain('表1-1 依据文件一览表');
  });

  it('不变：幂等 —— 连续两遍收口产出逐字节相同（修复轮反复调用不得漂移）', () => {
    const fixtures = [
      chapterDoc(['表1-34-1 本工程编制依据文件一览表', '表1-3 本工程编制依据文件一览表', '', ...TABLE_BASIS]),
      chapterDoc(['表1-34-1 本工程编制依据文件一览表', '', '本工程依据上述文件组织施工，逐项对照核验。', '', ...TABLE_BASIS]),
      chapterDoc(['表1-7 主要施工机械设备配置表', '', ...TABLE_MACHINE, '', '表1-8 劳动力投入计划表', '', ...TABLE_LABOR]),
      chapterDoc(['表1-3 劳动力投入计划表上述措施落实到各作业班组并逐周考核。', '', ...TABLE_LABOR]),
      chapterDoc(['本工程编制依据文件一览表', '', ...TABLE_BASIS]),
      chapterDoc(['表1-1 主要施工机械设备配置表', '', ...TABLE_MACHINE]),
      chapterDoc(['表1-2 表', '', ...TABLE_MACHINE]),
      chapterDoc(['表1-3 本工程编制依据文件一览表', '', '本工程依据上述文件组织施工。']),
      '',
    ];
    for (const src of fixtures) {
      const once = finalizeTableCaptions(src);
      expect(finalizeTableCaptions(once), `非幂等夹具：${JSON.stringify(src.slice(0, 60))}`).toBe(once);
    }
  });
});
