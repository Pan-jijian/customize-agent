#!/usr/bin/env node
// 十度实测验收（4.8.4）：对比九度失败基线
// 验收点：任务成败、5 个 blocker（脏事实/缺链/参数不足/主要施工方法 360 字误报/危大 79 字误报）、
// 重复 H4 标题数、空壳小节数、三段式标签形态（粗体/重复标签残留）
// 用法：node .dbg/acceptance-round10.cjs /tmp/round10-final.json
const fs = require('fs');
const path = process.argv[2];
if (!path || !fs.existsSync(path)) { console.error('usage: node acceptance-round10.cjs <final.json>'); process.exit(2); }
const j = JSON.parse(fs.readFileSync(path, 'utf8'));
const d = j.document || j;

console.log('=== 十度实测验收（4.8.4）===');
console.log('status:', d.status, '| error:', d.error || 'null');

// 1. 执行阶段统计
const stages = d.executionStages || [];
const llmTotal = (d.llmCallStats || d.stats || {}).totalCalls;
console.log('executionStages:', stages.length, '| LLM 调用:', llmTotal ?? '?');
const failures = stages.filter(s => s.status === 'failed' || s.status === 'error');
console.log('阶段失败数:', failures.length);
for (const f of failures) console.log('  FAILED:', f.roleId, '-', (f.message || '').slice(0, 120));

// 2. 最终 markdown
const md = d.finalMarkdown || d.markdown || (d.content && d.content.markdown) || '';
console.log('\n=== 最终 markdown ===');
console.log('总字符数:', md.length);
if (!md) { console.log('!!! 无最终 markdown'); process.exit(0); }

// 3. 九度 5 个 blocker 证据复查
console.log('\n=== 九度 5 blocker 复查 ===');
const dirty = (md.match(/\*\*[^*]{2,}\*\*/g) || []);
const dupLabel = (md.match(/^\s*(施工概况|施工流程|施工方法)[:：]\s*\*\*(施工概况|施工流程|施工方法)\*\*[:：]/gmu) || []);
console.log('①粗体标签残留:', dirty.length, '| 重复标签形态:', dupLabel.length);
const chainRe = /[^\s→]{2,}(?:→[^\s→]{2,}){3,}/gu;
const chains = md.match(chainRe) || [];
console.log('②箭头工序链条数:', chains.length);
const paramRe = /\d+(?:\.\d+)?\s*(?:㎡|m²|m2|m3|m³|mm|cm|m|MPa|kPa|%|日历天|天|小时|层|台|套|个|次|kN|t|N|颗|樘|扇)/giu;
const params = md.match(paramRe) || [];
console.log('③工艺参数量:', params.length);

// ④ 主要施工方法小节
const mmIdx = md.indexOf('### 主要施工方法');
const mmAlt = md.match(/^#{2,4}\s*主要施工方法/mu);
if (mmIdx >= 0 || mmAlt) {
  const from = mmIdx >= 0 ? mmIdx : md.indexOf(mmAlt[0]);
  const seg = md.slice(from, from + 2000);
  const nextHeading = seg.match(/\n#{2,4}\s/mu);
  const len = nextHeading ? nextHeading.index : seg.length;
  console.log('④主要施工方法小节存在, 正文约', len, '字（九度基线: 0 处出现/4600 字稿丢失）');
} else {
  console.log('④主要施工方法小节缺失（与七度成功基线一致, fuzzy 不再误报）');
}
// ⑤ 危大
const wdIdx = md.indexOf('危大');
console.log('⑤危大关键词出现:', (md.match(/危大/g) || []).length, '处');

// 4. 结构质量
console.log('\n=== 结构质量 ===');
const h4s = md.match(/^####\s+.+$/gmu) || [];
const h4titles = h4s.map(h => h.replace(/^####\s*/, '').trim());
const dupH4 = h4titles.filter((t, i) => h4titles.indexOf(t) !== i);
console.log('H4 小节数:', h4s.length, '| 重复 H4 标题数:', dupH4.length);
for (const t of new Set(dupH4)) console.log('  DUP:', t);

// 5. 空壳小节（标题后无正文或正文极短）
const blocks = md.split(/\n(?=#{1,4}\s)/u);
const shells = blocks.filter(b => {
  const body = b.replace(/^#{1,4}\s+.+$/mu, '').trim();
  return body.length > 0 && body.length < 30 && /^#{1,4}\s/u.test(b);
});
console.log('空壳小节数（正文<30字）:', shells.length);
for (const s of shells.slice(0, 10)) console.log('  SHELL:', s.replace(/\n/g, '\\n').slice(0, 90));

// 6. 分部分项小节三段式抽查
const divIdx = md.indexOf('主要分部分项工程施工方案');
console.log('\n=== 分部分项小节 ===');
if (divIdx >= 0) {
  const seg = md.slice(divIdx, divIdx + 8000);
  const pkgCount = (seg.match(/^####\s+.+$/gmu) || []).length;
  console.log('分项 H4 数（前8000字内）:', pkgCount);
} else {
  console.log('!!! 主要分部分项工程施工方案 未找到');
}

// 7. blocker 相关验收消息（executionStages 中最后验收阶段）
const gate = stages.filter(s => /final|gate|验收|accept/i.test(s.roleId || ''));
console.log('\n=== 验收阶段消息 ===');
for (const g of gate.slice(-3)) {
  console.log('  [' + g.roleId + '/' + g.status + ']', (g.message || '').slice(0, 200));
}
