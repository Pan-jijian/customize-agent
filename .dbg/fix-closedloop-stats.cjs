// 一次性修复脚本：tenderBidScoring.ts 抽取 closedLoopBlockStats 公共函数（可落地性评分口径同源化）。
// 背景：SearchReplace 会破坏含反斜杠转义的正则行，故用脚本做 str.replace + 计数校验 + 写盘。
const fs = require('fs');
const path = '/Users/pan/Desktop/codeing/customize-agent/apps/server/src/services/document-workflow/tenderBidScoring.ts';
const src = fs.readFileSync(path, 'utf8');

const oldBlock = [
  '/** 可落地性：管控闭环句式密度（责任岗位+检查频次+整改闭环），每 1500 字至少 1 段闭环句式 */',
  'function executabilityScore(markdown: string) {',
  '  const blocks = markdown.split(/\\n{2,}/u).filter(block => block.trim().length >= 30);',
  '  const closedLoopBlocks = blocks.filter(block =>',
  '    CLOSED_LOOP_ROLE_RE.test(block) && CLOSED_LOOP_FREQUENCY_RE.test(block) && CLOSED_LOOP_CLOSURE_RE.test(block),',
  '  ).length;',
  '  const target = Math.max(6, Math.ceil(documentTextLength(markdown) / 1500));',
  '  return Math.round(Math.min(1, closedLoopBlocks / target) * 100);',
  '}',
].join('\n');

const newBlock = [
  '/** 闭环句式分块统计（与可落地性评分同口径）：按空行分块（≥30 字），同一块内三要素齐全才算闭环块 */',
  'export function closedLoopBlockStats(markdown: string) {',
  '  const blocks = markdown.split(/\\n{2,}/u).filter(block => block.trim().length >= 30);',
  '  const closedLoopBlocks = blocks.filter(block =>',
  '    CLOSED_LOOP_ROLE_RE.test(block) && CLOSED_LOOP_FREQUENCY_RE.test(block) && CLOSED_LOOP_CLOSURE_RE.test(block),',
  '  ).length;',
  '  return { blocks: blocks.length, closedLoopBlocks };',
  '}',
  '',
  '/** 可落地性：管控闭环句式密度（责任岗位+检查频次+整改闭环），每 1500 字至少 1 段闭环句式 */',
  'function executabilityScore(markdown: string) {',
  '  const { closedLoopBlocks } = closedLoopBlockStats(markdown);',
  '  const target = Math.max(6, Math.ceil(documentTextLength(markdown) / 1500));',
  '  return Math.round(Math.min(1, closedLoopBlocks / target) * 100);',
  '}',
].join('\n');

const count = src.split(oldBlock).length - 1;
if (count !== 1) {
  console.error(`FAIL: expected oldBlock 1 occurrence, found ${count}`);
  process.exit(1);
}
const out = src.replace(oldBlock, newBlock);
if (!out.includes('export function closedLoopBlockStats')) {
  console.error('FAIL: newBlock not present after replace');
  process.exit(1);
}
// 校验原正则行未被破坏（/\\n{2,}/u 仍为转义形态而非真实换行）
if (!out.includes('split(/\\n{2,}/u)')) {
  console.error('FAIL: regex escape broken');
  process.exit(1);
}
fs.writeFileSync(path, out);
console.log('OK: closedLoopBlockStats extracted, executabilityScore reuses it');
