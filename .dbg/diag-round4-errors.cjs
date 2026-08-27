// 诊断四度实测最终 markdown 的 error 级校验（sourcePhrase + 粗体表名 + 关键小节深度 + 污染）
const fs = require('fs');
const d = JSON.parse(fs.readFileSync('/tmp/round4-doc.json', 'utf8'));
const md = (d.document || d).markdown || '';
const SRC = /(?:项目部|本项目|本工程)?(?:根据|依据|结合|按照|以)?(?:本项目|项目|[^。；;\n]{0,30}?)?(?:招标文件|补疑澄清文件|补遗澄清文件|补疑补遗|答疑(?:回复)?文件|答疑修正口径|补充答疑修正口径|澄清文件|工程量清单|设计图纸|施工图纸|图纸资料|设计修改通知单)(?:[、,，及和与\s]*(?:招标文件|补疑澄清文件|补遗澄清文件|补疑补遗|答疑(?:回复)?文件|答疑修正口径|补充答疑修正口径|澄清文件|工程量清单|设计图纸|施工图纸|图纸资料|设计修改通知单|现行规范|规范)){1,}(?:[^。；;\n]{0,80})?[，,]/u;
const BASIS = /编制依据|依据文件/u;
let inBasis = false;
const lines = md.split('\n');
let found = 0;
for (let i = 0; i < lines.length; i++) {
  const t = lines[i].trim();
  const h = /^#{2,4}\s+/u.exec(t);
  if (h) { inBasis = BASIS.test(t.replace(h[0], '')); continue; }
  if (/^\s*\|/u.test(t)) continue;
  if (SRC.test(lines[i]) && !inBasis) { console.log('SOURCE_PHRASE L' + (i + 1) + ': ' + lines[i].slice(0, 90)); found++; }
}
for (let i = 0; i < lines.length; i++) {
  if (/^\s*\*\*[^*]{2,40}表\*\*\s*$/u.test(lines[i])) { console.log('BOLD_TABLE L' + (i + 1) + ': ' + lines[i]); found++; }
}
// 污染检查：常见跨项目词
const CONTAM = /合肥|城隍庙|徽光阁|招标人|招标范围/u;
// 关键小节深度（exact 模拟：H3 标题 + 至下一同级/上级）
function exactSection(mdText, title) {
  const ls = mdText.split('\n');
  const start = ls.findIndex(l => /^###\s+(?:\d+(?:\.\d+)*\s+)?/u.test(l.trim()) && l.includes(title));
  if (start < 0) return '';
  const startLevel = 3;
  let end = ls.length;
  for (let j = start + 1; j < ls.length; j++) {
    const hh = /^(#{2,6})\s+/u.exec(ls[j].trim());
    if (hh && hh[1].length <= startLevel) { end = j; break; }
  }
  return ls.slice(start, end).join('\n');
}
const criticalRules = [
  ['项目特点、重点、难点分析', 1800, null],
  ['项目主要施工内容', 2200, null],
  ['主要分部分项工程施工方案', 1200, 800],
  ['主要施工方法', 2200, null],
  ['危大工程专项施工方案审批流程', 500, 250],
  ['原材料进场复试与见证取样', 600, 300],
];
for (const [title, minChars, blockerMin] of criticalRules) {
  let body = exactSection(md, title);
  const chars = body.replace(/\s/gu, '').length;
  if (!body || chars >= minChars) continue;
  const line = blockerMin || Math.floor(minChars * 0.8);
  if (chars < line) console.log(`DEPTH_ERROR: ${title} 当前 ${chars} 字 < ${line} 字`);
  else console.log(`DEPTH_WARN: ${title} 当前 ${chars} 字（目标 ${minChars}）`);
}
console.log('found =', found);
