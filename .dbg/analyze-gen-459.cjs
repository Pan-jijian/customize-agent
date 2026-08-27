#!/usr/bin/env node
// 生成文档画像分析：复刻 referenceQualityProfile.ts 同口径算法（纯计算，无 IO 依赖）
const fs = require('fs');
const HOME = process.env.HOME;
const GEN = `${HOME}/.customize-agent/projects/3c3f04667c69/generatedDocuments/assets/徽光阁施工组织设计-doc-1787799803603-efb05e1d.md`;
const refs = JSON.parse(fs.readFileSync(`${HOME}/.customize-agent/template-references/references.json`, 'utf8'));

// ── 同口径复刻（referenceQualityProfile.ts） ──
const PARAM_HIT_RE = /(?:\d+(?:\.\d+)?\s*(?:mm|cm|m|㎡|m²|m2|m3|m³|kg|t|MPa|kPa|kN|V|KV|kV|A|天|%)(?![a-zA-Z\u4e00-\u9fa5])|\d+(?:\.\d+)?\s*(?:米|厘米|毫米|吨|千克|公斤|平方米|立方米)(?!\d)|(?:养护|搭接长度|试验压力|间距|偏差|坡度|含水率|压实度|强度等级|标号|厚度|宽度|高度|深度|直径|桩长|桩径))/gu;
const ARROW_CHAIN_RE = /→|->/u;
const TABLE_MARK_RE = /^(?:[一二三四五六七八九十\d]+[、.．]?\s*)?[\u4e00-\u9fa5（）()、，A-Za-z0-9+\-·\s]{2,28}(?:表|清单)(?:[:：]|\s*$)/mu;
function textSegments(text) {
  return text.split(/\n+/u).map(l => l.replace(/\s+/gu, ' ').trim()).filter(l => l.length >= 16 && /[\u4e00-\u9fa5]/u.test(l));
}
function segmentSkeleton(s) { return s.replace(/[\d\s，。、；：""''（）()%…—\-·]/gu, ''); }
function cleanHeadingLine(l) {
  return l.replace(/^\s*#+\s*/u, '').replace(/[\u00a0\u3000]/gu, ' ').trim();
}
function countTables(text) {
  let count = 0;
  for (const rawLine of text.split(/\n+/u)) {
    const line = cleanHeadingLine(rawLine);
    if (!line) continue;
    if (TABLE_MARK_RE.test(line) || /^┌─/u.test(line) || /^\|.*\|.*\|$/u.test(line)) count += 1;
  }
  return count;
}
function buildProfile(text) {
  const wordCount = text.replace(/\s/gu, '').length;
  const segments = textSegments(text);
  const effectiveWordCount = segments.reduce((s, x) => s + x.replace(/\s/gu, '').length, 0);
  const paramCount = (text.match(PARAM_HIT_RE) || []).length;
  const arrowChainSegmentCount = segments.filter(s => ARROW_CHAIN_RE.test(s)).length;
  const sk = new Map();
  for (const seg of segments) {
    const k = segmentSkeleton(seg);
    if (k.length < 8) continue;
    sk.set(k, (sk.get(k) || 0) + 1);
  }
  let dup = 0;
  for (const c of sk.values()) if (c > 1) dup += c;
  return {
    wordCount, effectiveWordCount,
    paramDensity: effectiveWordCount > 0 ? paramCount * 1000 / effectiveWordCount : 0,
    paramCount,
    arrowChainCoverage: segments.length > 0 ? arrowChainSegmentCount / segments.length : 0,
    duplicationRate: segments.length > 0 ? dup / segments.length : 0,
    tableCount: countTables(text),
    segmentCount: segments.length, arrowChainSegmentCount, duplicatedSegmentCount: dup,
  };
}

// ── 生成文档画像 ──
const gen = buildProfile(fs.readFileSync(GEN, 'utf8'));
console.log('=== 生成文档画像（系统同口径）===');
for (const [k, v] of Object.entries(gen)) console.log(`  ${k} = ${typeof v === 'number' ? v.toFixed(3) : v}`);

// ── 分类路径验证（suggestProjectType 复刻）──
const md = fs.readFileSync(GEN, 'utf8');
const strongPower = /变电站|输电线路|配电|GIS设备|电缆|架空线路|铁塔|箱变/gu;
const strongHouse = /产业园|标准厂房|安置房|住宅小区|保障房|卫生院|门诊楼|办公楼/gu;
const denseHouse = /房建|建筑|住宅|楼|结构|砌体|基坑|地下室|主体|层高|户型|公共建筑|产业园|厂房/gu;
const denseDeco = /装饰|装修|幕墙/gu;
const densePower = /电力|供配电|电压|电缆/gu;
const countOf = re => { re.lastIndex = 0; return (md.match(re) || []).length; };
console.log('\n=== suggestProjectType 分类路径 ===');
console.log(`  电力强判别词(配电等): ${countOf(strongPower)} 次`);
console.log(`  房建强判别词(产业园/办公楼等): ${countOf(strongHouse)} 次`);
console.log(`  房建密度词(建筑/结构等): ${countOf(denseHouse)} 次`);
console.log(`  装饰装修密度词(装饰/装修等): ${countOf(denseDeco)} 次`);
console.log(`  电力密度词(供配电/电缆等): ${countOf(densePower)} 次`);

// ── 参考文件对比 ──
console.log('\n=== 参考库画像对比（房建 + 主对标）===');
const head = ['file', 'words', 'effWords', 'paramDensity', 'arrow%', 'dup%', 'tables', 'sections', 'subs', 'subitems', 'avgSecWords'];
const rows = [];
for (const r of refs) {
  const p = r.qualityProfile;
  rows.push([`${r.projectType}·${r.fileName.slice(0, 16)}`, p.wordCount, p.effectiveWordCount, p.paramDensity.toFixed(2), (p.arrowChainCoverage * 100).toFixed(1), (p.duplicationRate * 100).toFixed(1), p.tableCount, p.sectionCount, p.subsectionCount, p.subitemCount || 0, p.avgSectionWords]);
}
rows.push(['生成·徽光阁(本次)', gen.wordCount, gen.effectiveWordCount, gen.paramDensity.toFixed(2), (gen.arrowChainCoverage * 100).toFixed(1), (gen.duplicationRate * 100).toFixed(1), gen.tableCount, 3, '-', '-', Math.round(gen.effectiveWordCount / 3)]);
console.log(head.join('\t'));
for (const r of rows) console.log(r.join('\t'));

// ── 房建基准重算对标分（benchmarkQuality.ts 公式）──
const house = refs.filter(r => r.projectType === '房建' && r.qualityProfile);
const hw = house.reduce((s, r) => s + r.qualityProfile.effectiveWordCount, 0);
const refParamDensity = house.reduce((s, r) => s + r.qualityProfile.paramCount, 0) * 1000 / hw;
const refArrow = house.reduce((s, r) => s + (r.qualityProfile.arrowChainSegmentCount || 0), 0) / house.reduce((s, r) => s + (r.qualityProfile.segmentCount || 0), 0);
const refDup = house.reduce((s, r) => s + (r.qualityProfile.duplicatedSegmentCount || 0), 0) / house.reduce((s, r) => s + (r.qualityProfile.segmentCount || 0), 0);
const refTables = house.reduce((s, r) => s + r.qualityProfile.tableCount, 0) / house.length;
const refSections = house.reduce((s, r) => s + r.qualityProfile.sectionCount, 0) / house.length;
const arrowTarget = Math.max(refArrow, 0.08);
const ratioScore = (g, r) => r > 0 ? Math.min(120, Math.round(g / r * 100)) : 100;
const duplicationScore = (g, r) => {
  const ratio = r > 0 ? g / r : 1;
  if (ratio <= 1) return 100;
  if (ratio <= 2) return 100 - (ratio - 1) * 40;
  return Math.max(0, 60 - (ratio - 2) * 30);
};
const items = [
  ['参数密度', gen.paramDensity, refParamDensity * 0.8, ratioScore(gen.paramDensity, refParamDensity * 0.8), 0.3],
  ['工序链覆盖率', gen.arrowChainCoverage, arrowTarget, ratioScore(gen.arrowChainCoverage, arrowTarget), 0.2],
  ['段落重复率', gen.duplicationRate, refDup, duplicationScore(gen.duplicationRate, refDup), 0.2],
  ['表格数量', gen.tableCount, refTables * 0.6, ratioScore(gen.tableCount, refTables * 0.6), 0.15],
  ['章节结构', 3, refSections, 3 >= refSections * 0.4 ? 100 : ratioScore(3, refSections), 0.15],
];
console.log('\n=== 房建基准（2 样本加权）重算对标 ===');
console.log(`  基准: 参数密度 ${refParamDensity.toFixed(2)} | 工序链 ${(refArrow * 100).toFixed(1)}% | 重复率 ${(refDup * 100).toFixed(1)}% | 表格 ${refTables.toFixed(1)} | 章节 ${refSections.toFixed(1)}`);
let total = 0;
for (const [label, g, r, score, w] of items) {
  total += score * w;
  console.log(`  ${label}: 生成 ${typeof g === 'number' ? g.toFixed(2) : g} vs 达标线 ${r.toFixed(2)} → ${score} 分 ${score >= 80 ? '✓' : '✗ 未达标'}`);
}
console.log(`  === 房建正确基准总分: ${Math.round(total)}/100（系统当前按电力误分类算得 93）===`);
