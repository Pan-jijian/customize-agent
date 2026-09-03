// 离线验证：4.17.4 修复函数对第一轮 draft 的真实效果预检（不依赖服务）
import { applyNumericConsistencyDeterministicFixes, fixAdjacentPhraseDuplication, fixPlaceholderTableCells, fixQualityAssuranceCoverage } from '../apps/server/src/services/document-workflow/documentIntegrityChecks';
import fs from 'node:fs';

const d = JSON.parse(fs.readFileSync('/Users/pan/.customize-agent/projects/3c3f04667c69/generatedDocuments/drafts/doc-1788379016625-89aecd22.json', 'utf8')) as { markdown?: string };
const md: string = d.markdown || '';

const r1 = applyNumericConsistencyDeterministicFixes(md, { scheduleAuthority: 540, assemblyRateAuthority: 30 });
console.log('=== 数值修复 fixedCount:', r1.fixedCount);
console.log(r1.details.slice(0, 10).join('\n'));
const r2 = fixAdjacentPhraseDuplication(r1.markdown);
console.log('=== 粘连折叠 fixedCount:', r2.fixedCount);
console.log(r2.details.slice(0, 6).join('\n'));
const r3 = fixPlaceholderTableCells(r2.markdown, { areaSummary: '建筑面积28570.36平方米、地上6层、地下1层', scheduleDays: 540 });
console.log('=== 套话填充 fixedCount:', r3.fixedCount);
console.log(r3.details.join('\n'));
const r4 = fixQualityAssuranceCoverage(r3.markdown);
console.log('=== 质量覆盖 fixedCount:', r4.fixedCount);
console.log(r4.details.join('\n'));
const out = r4.markdown;
console.log('---');
console.log('第365日:', (out.match(/第365日/g) || []).length, ' 第540日:', (out.match(/第540日/g) || []).length);
console.log('38.4%:', (out.match(/38\.4%/g) || []).length, ' 塔式起重机2台:', (out.match(/塔式起重机2台/g) || []).length, ' 塔式起重机1台:', (out.match(/塔式起重机1台/g) || []).length);
console.log('按施工图设计文件确定:', (out.match(/按施工图设计文件确定/g) || []).length, ' 按合同约定工期执行:', (out.match(/按合同约定工期执行/g) || []).length);
console.log('冬季热负荷71.2kW:', (out.match(/冬季热负荷71\.2kW/g) || []).length, ' 三检制:', (out.match(/三检制/g) || []).length);
const i = out.indexOf('基坑开挖与支护完成 | 开工后第');
console.log('--- 2.2 关键节点表修复后:');
console.log(out.slice(Math.max(0, i - 20), i + 320).replace(/\n+/g, '\n'));
