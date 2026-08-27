// 一次性修复脚本：referenceQualityProfile.ts countTables 管道表格按块计数（P2-6）。
// 背景：SearchReplace 会破坏含反斜杠转义的正则行，故用脚本做 str.replace + 计数校验 + 写盘。
const fs = require('fs');
const path = '/Users/pan/Desktop/codeing/customize-agent/apps/server/src/services/document-workflow/referenceQualityProfile.ts';
const src = fs.readFileSync(path, 'utf8');

const oldBlock = [
  '/** 统计表格标题数（"XX表/XX清单"结尾的标题行 + 框线/管道表格） */',
  'function countTables(text: string): number {',
  '  let count = 0;',
  '  for (const rawLine of text.split(/\\n+/u)) {',
  '    const line = cleanHeadingLine(rawLine);',
  '    if (!line) continue;',
  '    if (TABLE_MARK_RE.test(line) || /^┌─/u.test(line) || /^\\|.*\\|.*\\|$/u.test(line)) count += 1;',
  '  }',
  '  return count;',
  '}',
].join('\n');

const newBlock = [
  '/** 统计表格数量：表格标题行（"XX表/XX清单"结尾）每行 1 张；框线表格表首 ┌─ 计 1 张；',
  ' * markdown 管道表格按连续行块计数（整块 1 张），表块前 3 行内已有表格标题行时不再重复计。',
  ' * 历史口径按管道行逐行计数，20 行表虚高为 20 张，与参考库（PDF 按标题/框线计数）口径错位，对标失真 */',
  'function countTables(text: string): number {',
  '  let count = 0;',
  '  const lines = text.split(/\\n+/u);',
  '  for (let index = 0; index < lines.length; index += 1) {',
  '    const line = cleanHeadingLine(lines[index] || \'\');',
  '    if (!line) continue;',
  '    if (TABLE_MARK_RE.test(line) || /^┌─/u.test(line)) { count += 1; continue; }',
  '    if (/^\\|.*\\|.*\\|$/u.test(line)) {',
  '      let previous = \'\';',
  '      for (let back = index - 1; back >= 0 && back >= index - 3; back -= 1) {',
  '        const candidate = cleanHeadingLine(lines[back] || \'\');',
  '        if (candidate) { previous = candidate; break; }',
  '      }',
  '      if (!/^\\|.*\\|.*\\|$/u.test(previous) && !TABLE_MARK_RE.test(previous)) count += 1;',
  '    }',
  '  }',
  '  return count;',
  '}',
].join('\n');

const count = src.split(oldBlock).length - 1;
if (count !== 1) {
  console.error(`FAIL: expected oldBlock 1 occurrence, found ${count}`);
  process.exit(1);
}
const out = src.replace(oldBlock, newBlock);
if (!out.includes('markdown 管道表格按连续行块计数')) {
  console.error('FAIL: newBlock not present after replace');
  process.exit(1);
}
// 校验原正则行未被破坏（\\n+ 仍为转义形态而非真实换行）
if (!out.includes('text.split(/\\n+/u)')) {
  console.error('FAIL: regex escape broken');
  process.exit(1);
}
fs.writeFileSync(path, out);
console.log('OK: countTables block counting applied');
