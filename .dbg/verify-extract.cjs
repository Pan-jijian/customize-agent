// 验证 extractSectionFuzzy 提取行为：当前逻辑 vs 修复后逻辑（H3 向下包含 H4 + comparable 去连接词）
const fs = require('fs');
const content = fs.readFileSync('/tmp/ch1-content.md', 'utf8');

function sectionHeadingTitleText(line) {
  return line
    .replace(/^\s*#{2,4}\s*/u, '')
    .replace(/^\s*(?:\d+(?:\.\d+)*|[一二三四五六七八九十]+)(?:[、.．]|\s+)\s*/u, '')
    .trim();
}
const comparableCurrent = (value) =>
  sectionHeadingTitleText(value).replace(/\s+/gu, '').toLowerCase()
    .replace(/施工(?=方案|流程|方法)/gu, '')
    .replace(/专项(?=方案)/gu, '')
    .replace(/项目|工程|主要|重点|技术/gu, '');
const comparableFixed = (value) =>
  comparableCurrent(value)
    .replace(/[、，,；;·．.／/]+/gu, '')
    .replace(/与|及|和|暨/gu, '');

function extractFuzzy(content, sectionTitle, comparableFn, h3IncludeH4) {
  const lines = content.split('\n');
  const normalizedTitle = sectionHeadingTitleText(sectionTitle).replace(/\s+/gu, '').toLowerCase();
  const comparableTitle = comparableFn(sectionTitle);
  const matches = [];
  let start = -1;
  let startLevel = 0;
  let startWorkPackage = false;
  const flush = (end) => {
    if (start < 0) return;
    const body = lines.slice(start, end).join('\n').trim();
    if (body) matches.push(body);
    start = -1;
    startLevel = 0;
    startWorkPackage = false;
  };
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^\s*#{2,4}\s+/u.test(lines[index])) continue;
    const level = (/^\s*(#{2,4})\s+/u.exec(lines[index])?.[1].length) || 3;
    if (start >= 0 && (startWorkPackage || (h3IncludeH4 && startLevel === 3)) && level === 4) continue;
    flush(index);
    const normalizedHeading = sectionHeadingTitleText(lines[index]).replace(/\s+/gu, '').toLowerCase();
    const comparableHeading = comparableFn(lines[index]);
    if (normalizedHeading === normalizedTitle || normalizedHeading.includes(normalizedTitle) || normalizedTitle.includes(normalizedHeading) || comparableHeading === comparableTitle || comparableHeading.includes(comparableTitle) || comparableTitle.includes(comparableHeading)) {
      start = index + 1;
      startLevel = level;
      startWorkPackage = level <= 4 && /项目主要施工内容|主要分部分项工程施工方案|主要施工方法/u.test(lines[index]);
    }
  }
  flush(lines.length);
  return matches.sort((a, b) => (b.replace(/\s/gu, '').length) - (a.replace(/\s/gu, '').length))[0] || '';
}

const len = (s) => s.replace(/\s/gu, '').length;
const tests = ['危大工程专项施工方案审批流程', '项目特点、重点、难点分析', '项目主要施工内容', '工程特点与重点难点分析'];
console.log('== 当前逻辑（无 H3 包含 H4、comparable 不去连接词）==');
for (const t of tests) {
  const body = extractFuzzy(content, t, comparableCurrent, false);
  console.log(`  ${t} -> ${len(body)} 字`);
}
console.log('== 修复后（H3 包含 H4 + comparable 去连接词）==');
for (const t of tests) {
  const body = extractFuzzy(content, t, comparableFixed, true);
  console.log(`  ${t} -> ${len(body)} 字`);
}
