// 修复 SearchReplace 破坏的正则换行转义（两处），并验证写入结果
const fs = require('fs');
const p = '/Users/pan/Desktop/codeing/customize-agent/apps/server/src/services/document-workflow/documentGeneratorHelpers.ts';
let t = fs.readFileSync(p, 'utf8');

const old1 = [
  '    const namedProjectBasicTitle = /(?:\\*\\*[^',
  ']*项目基本信息表[^',
  ']*\\*\\*|####\\s+[^',
  ']*项目基本信息表[^',
  ']*|###\\s+[^',
  ']*项目基本信息表[^',
  ']*)/u.test(line);',
].join('\n');
const new1 = '    const namedProjectBasicTitle = /(?:\\*\\*[^\\n]*项目基本信息表[^\\n]*\\*\\*|####\\s+[^\\n]*项目基本信息表[^\\n]*|###\\s+[^\\n]*项目基本信息表[^\\n]*)/u.test(line);';

const old2 = [
  '    .replace(/该小节围绕“[^”]+”进行补充说明[^',
  ']*(?:',
  '',
  '该小节围绕“[^”]+”进行补充说明[^',
  ']*)*/gu, \'\')',
].join('\n');
const new2 = '    .replace(/该小节围绕“[^”]+”进行补充说明[^\\n]*(?:\\n\\n该小节围绕“[^”]+”进行补充说明[^\\n]*)*/gu, \'\')';

let applied = 0;
for (const [old, nw, label] of [[old1, new1, 'namedProjectBasicTitle'], [old2, new2, '该小节围绕']]) {
  const count = t.split(old).length - 1;
  if (count !== 1) {
    console.error(`[FAIL] ${label}: 期望出现 1 次，实际 ${count} 次`);
    process.exit(1);
  }
  t = t.replace(old, nw);
  applied += 1;
}
fs.writeFileSync(p, t);
console.log(`[OK] 修复 ${applied} 处正则换行转义，文件已写回`);

// 验证：文件中不应再有孤立的 "[^" 后紧跟换行的坏形态
const check = fs.readFileSync(p, 'utf8');
const badPattern = /\[\^\n\]/u;
if (badPattern.test(check)) {
  console.error('[FAIL] 仍有坏形态 [^\\n] 未修复');
  process.exit(1);
}
console.log('[OK] 验证通过：无残留破坏形态');
