// 临时离线验证（4.17.4 修复对第一轮 draft 的真实效果），验证后删除
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { applyNumericConsistencyDeterministicFixes, fixAdjacentPhraseDuplication, fixPlaceholderTableCells, fixQualityAssuranceCoverage } from './documentIntegrityChecks';

function ctx(md: string, idx: number, before = 60, after = 100): string {
  return JSON.stringify(md.slice(Math.max(0, idx - before), idx + after));
}

describe('offline 4.17.4 real-draft verify', () => {
  it('对第一轮真实 draft 应用全部确定性修复', () => {
    const d = JSON.parse(fs.readFileSync('/Users/pan/.customize-agent/projects/3c3f04667c69/generatedDocuments/drafts/doc-1788379016625-89aecd22.json', 'utf8')) as { markdown?: string };
    const md = d.markdown || '';
    const r1 = applyNumericConsistencyDeterministicFixes(md, { scheduleAuthority: 540, assemblyRateAuthority: 30 });
    const r2 = fixAdjacentPhraseDuplication(r1.markdown);
    const r3 = fixPlaceholderTableCells(r2.markdown, { areaSummary: '建筑面积28570.36平方米、地上6层、地下1层', scheduleDays: 540 });
    const r4 = fixQualityAssuranceCoverage(r3.markdown);
    const out = r4.markdown;
    console.log('数值修复:', r1.fixedCount, ' 粘连折叠:', r2.fixedCount, ' 套话填充:', r3.fixedCount, ' 质量覆盖:', r4.fixedCount);
    console.log('第365日:', (out.match(/第365日/g) || []).length, ' 第540日:', (out.match(/第540日/g) || []).length);
    console.log('38.4%:', (out.match(/38\.4%/g) || []).length, ' 54.0%:', (out.match(/54\.0%/g) || []).length);
    console.log('塔式起重机2台:', (out.match(/塔式起重机2台/g) || []).length, ' 塔式起重机1台:', (out.match(/塔式起重机1台/g) || []).length);
    console.log('按施工图设计文件确定:', (out.match(/按施工图设计文件确定/g) || []).length, ' 按合同约定工期执行:', (out.match(/按合同约定工期执行/g) || []).length);
    console.log('冬季热负荷71.2kW:', (out.match(/冬季热负荷71\.2kW/g) || []).length, ' 三检制:', (out.match(/三检制/g) || []).length);
    // 节点句验证
    const i = out.indexOf('项目部按“施工准备与临时设施完成');
    console.log('节点句:', ctx(out, i));
    // 抗渗句验证
    const j = out.indexOf('地下室顶板混凝土标号C35、抗渗等级P8');
    console.log('抗渗句:', ctx(out, j));
    // 检查地上各层顶板完好
    console.log('地上各层顶板C30:', (out.match(/地上各层顶板C30/g) || []).length, ' 上各层顶板C30:', (out.match(/上各层顶板C30/g) || []).length);
    expect(r1.fixedCount).toBeGreaterThan(0);
  });
});
