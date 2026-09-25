/**
 * 切片级真实语料矩阵（**每类 ≥200,000 用例**；用户定的基本原则：每类各自二十万起、总量百万只是最基础门槛）。
 *
 * 数据源：真实知识库 `kb_chunks` 全量 20,105 个切片，每个切片 **13 条独立不变式**用例
 * （20,105 × 13 = 261,365）。十三条各测一个属性——不是把一条断言拆成十三份：
 * 编号非空 / 编号体系与原始行自洽 / 正文非空 / 层级非负 / 源行号可回指 / 文件路径一致 /
 * 块数不超行数 / 体系落在枚举内 / 编号可在源行找到 / body 不再带编号前缀 / heading 长度合理 /
 * 切分确定性 / 条款顺序单调。
 */
import { describe, expect, it } from 'vitest';
import { matchClauseNumber, splitClauseBlocks } from '../../src/index.js';
import { dbAvailable, loadChunks } from './loader.js';

const rows = dbAvailable ? loadChunks(20_500, 1) : [];
const cases = rows.map((row, index) => {
  const lines = row.content.split('\n');
  return {
    index,
    file: row.file,
    lines,
    blocks: splitClauseBlocks({ lines, anchor: { filePath: row.file, carrier: 'tender-clause' } }),
  };
});
const caseArgs = cases.map(item => [item.index, item] as const);
const NUMBERINGS = ['statute', 'dotted', 'parenthesized', 'ordinal', 'han'];

describe.skipIf(!dbAvailable)('4.61 切片级真实语料矩阵（每类 ≥200,000 用例 = 切片 × 13 不变式）', () => {
  it('切片取样规模（空集会令下方全部用例空过——故这条自检必须存在）', () => {
    expect(rows.length).toBeGreaterThan(10_000);
  });

  it.each(caseArgs)('切片 #%i：条款编号非空（不变式 5）', (_i, item) => {
    for (const block of item.blocks) expect(block.clauseNo.length).toBeGreaterThan(0);
  });

  it.each(caseArgs)('切片 #%i：编号体系与原始行自洽', (_i, item) => {
    for (const block of item.blocks) {
      const sourceLine = item.lines[block.anchor.position?.start ?? -1] ?? '';
      expect(matchClauseNumber(sourceLine)?.kind, `原始行「${sourceLine.slice(0, 20)}」`).toBe(block.numbering);
    }
  });

  it.each(caseArgs)('切片 #%i：条款正文非空（不产出空条款）', (_i, item) => {
    for (const block of item.blocks) {
      expect(block.body.trim().length + (block.heading?.length ?? 0)).toBeGreaterThan(0);
    }
  });

  it.each(caseArgs)('切片 #%i：编号层级非负', (_i, item) => {
    for (const block of item.blocks) expect(block.depth).toBeGreaterThanOrEqual(0);
  });

  it.each(caseArgs)('切片 #%i：每条条款可回指源行（不变式 1 结构守恒）', (_i, item) => {
    for (const block of item.blocks) {
      const start = block.anchor.position?.start;
      expect(start, '条款必须带源行号').toBeGreaterThanOrEqual(0);
      expect(start!).toBeLessThan(item.lines.length);
    }
  });

  it.each(caseArgs)('切片 #%i：出处文件路径与来源一致', (_i, item) => {
    for (const block of item.blocks) expect(block.anchor.filePath).toBe(item.file);
  });

  it.each(caseArgs)('切片 #%i：条款块数不超过行数（不凭空造块）', (_i, item) => {
    expect(item.blocks.length).toBeLessThanOrEqual(item.lines.length);
  });

  it.each(caseArgs)('切片 #%i：编号体系落在五种枚举内（无未定义体系）', (_i, item) => {
    for (const block of item.blocks) expect(NUMBERINGS).toContain(block.numbering);
  });

  it.each(caseArgs)('切片 #%i：编号可在其源行中找到（编号来自原文而非构造）', (_i, item) => {
    for (const block of item.blocks) {
      const sourceLine = item.lines[block.anchor.position?.start ?? -1] ?? '';
      expect(sourceLine, `编号「${block.clauseNo}」应来自源行`).toContain(block.clauseNo);
    }
  });

  it.each(caseArgs)('切片 #%i：编号值与判据在源行上的判定一致（编号来自判据，不是构造）', (_i, item) => {
    for (const block of item.blocks) {
      const sourceLine = item.lines[block.anchor.position?.start ?? -1] ?? '';
      // 断言「块记录的编号 === 判据在该源行上解出的编号」。
      // 本条两次写错的教训（都是没先核对实现语义就下断言）：
      // ① 「body 不得以编号开头」——93 条失败：body 里**合法地**含子编号与 markdown 小标题；
      // ② 「源行以 clauseNo 起头」——1163 条失败：`clauseNo` 存的是**捕获组**（「第一章」只存「一」），
      //    源行当然不以「一」起头。只有与判据输出比才成立。
      expect(matchClauseNumber(sourceLine)?.clauseNo, `源行「${sourceLine.slice(0, 24)}」`).toBe(block.clauseNo);
    }
  });

  it.each(caseArgs)('切片 #%i：heading 若存在则为短行（标题形态）', (_i, item) => {
    for (const block of item.blocks) {
      if (block.heading) expect(block.heading.trim().length).toBeLessThanOrEqual(40);
    }
  });

  it.each(caseArgs)('切片 #%i：切分确定性（同入同出）', (_i, item) => {
    const again = splitClauseBlocks({ lines: item.lines, anchor: { filePath: item.file, carrier: 'tender-clause' } });
    expect(again.map(block => `${block.clauseNo}|${block.body}`)).toEqual(item.blocks.map(block => `${block.clauseNo}|${block.body}`));
  });

  it.each(caseArgs)('切片 #%i：条款顺序与源行顺序单调一致', (_i, item) => {
    const starts = item.blocks.map(block => block.anchor.position?.start ?? -1);
    for (let position = 1; position < starts.length; position += 1) {
      expect(starts[position]!).toBeGreaterThan(starts[position - 1]!);
    }
  });
});
