/**
 * V5 P5 无主数值审计器测试（M6 闭环）：扫描 → 登记豁免 → 权威匹配 → 无主语境分流。
 *
 * 分流契约：资源/劳动力/机械/进度语境 → 推导缺口（收编清单）；工艺语境 → 工艺缺口（收编清单）；
 * 其余 → 未登记（疑似编造，验收口径「0 未登记项」= unregisteredCount 为 0）。
 */
import { describe, expect, it } from 'vitest';
import { auditAuthorityCoverage, authorityAuditDetails, authorityAuditSummary } from '@/services/document-workflow/authorityAudit';
import type { BlueprintData } from '@/services/document-workflow/integratedBlueprint';

/** 全字段填充 fixture：与 authorityIndex 契约测试同源结构（覆盖全部数值叶子） */
function makeBlueprintData(): BlueprintData {
  return {
    project: { name: '舒城县美丽宜居自然村建设项目', scope: '9 个自然村市政配套', works: ['道路工程', '排水工程'], location: '六安市舒城县' },
    contract: { totalDays: 240, qualityStandard: '合格', pricingFile: '安徽省 2018 版计价定额', estimatedAmount: 1200 },
    climate: { rainySeason: '6-7月梅雨', highTemp: '7-8月高温', winter: '冬季施工' },
    milestones: [
      { key: 'prep', label: '施工准备', duration: 20, basis: '推导' },
      { key: 'main', label: '主体施工', duration: 180, basis: '推导' },
    ],
    resources: {
      labor: {
        peak: { min: 160, max: 200 },
        peakValue: 180,
        peakBasis: '造价锚定',
        byPhase: [
          { phase: '施工准备阶段', min: 20, max: 30, basis: '推导' },
          { phase: '主体施工阶段', min: 120, max: 140, basis: '推导' },
        ],
        byTrade: [{ trade: '钢筋工', min: 10, max: 16, basis: '推导' }],
        composition: [{ trade: '普工', count: 60, basis: '推导' }],
      },
      equipment: [
        { name: '挖掘机', spec: '0.8m³', min: 2, max: 4, basis: '推导' },
        { name: '自卸汽车', quantity: 6, basis: '推导' },
      ],
    },
    materialsPlan: [
      { name: '一般路灯', quantity: 118, unit: '套', spec: '100W', basis: '清单汇总' },
      { name: '级配碎石', quantity: 3200, unit: 'm³', basis: '清单汇总' },
    ],
    fundPlan: { wageRule: '按月足额', usagePlan: '专款专用' },
    testPlan: [{ scope: '混凝土试块', count: 12, basis: '推导' }],
    earthworkBalance: { excavation: 10000, backfill: 8000, disposal: 2000, basis: '清单汇总' },
    tempUtilities: { powerLoad: '200kW', waterUsage: '50m³/天' },
    redLineFacts: [
      { key: '自然村数量', value: '9 个自然村', source: '招标文件' },
      { key: '绿化养护期', value: '2 年', source: '清单特征' },
      { key: '合同估算价', value: '1200 万元', source: '招标文件', amount: true },
    ],
    amountRule: '金额类数据禁入正文（合同估算价例外）',
    decisionLock: { entries: [{ id: 'method', label: '施工方法', values: ['机械开挖'] }] },
    quantities: {
      挖沟槽土方: {
        value: 20420.39, unit: 'm³', sourceFile: '清单.pdf', seq: 1,
        groups: [
          { group: '白鸥观澜公厕', value: 838.81 },
          { group: '青青家园', value: 213.99 },
        ],
      },
      塑料检查井: { value: 555, unit: '座', sourceFile: '清单.pdf', seq: 2 },
    },
    specAuthorities: { 垫层: 'C20' },
    inspectionBatches: [{ scope: '排水管道', planDesc: '按检查井分段' }],
    standardBlocks: [{ id: 'dust', title: '扬尘治理', source: '参考.docx', items: ['六个百分百'], gap: false }],
    constructionDeployment: { sections: [{ name: '第一施工段', basis: '推导' }], sequence: '先地下后地上', sequenceBasis: '推导', flow: '分区流水' },
    keyDifficulties: [{ name: '交通导改', measure: '分段围挡', basis: '推导' }],
    basisRegulations: ['《中华人民共和国安全生产法》'],
    drawingNote: '图纸与清单不一致时以清单为准',
  };
}

describe('V5 P5 无主数值审计（M6）', () => {
  it('一致：数值核心命中权威条目值/分工程明细/规格内嵌数字', () => {
    const markdown = '本工程总工期 240 日历天，劳动力峰值 180 人。挖沟槽土方 20420.39m³（其中白鸥观澜公厕 838.81m³、青青家园 213.99m³），塑料检查井 555 座，一般路灯 118 套。';
    const report = auditAuthorityCoverage(markdown, makeBlueprintData());
    expect(report.scanned).toBe(7);
    expect(report.matched).toBe(7);
    expect(report.unregisteredCount).toBe(0);
    expect([...report.derivationGaps, ...report.processGaps, ...report.unattributed]).toEqual([]);
    // 撞核观测：权威值但语境属资源桶（工期/劳动力）→ 记入 contextualMatches
    expect(report.contextualMatches.map(finding => finding.token)).toEqual(expect.arrayContaining(['240 日历天', '180 人']));
  });

  it('登记豁免：规范编号与法规年代不产生发现（固定形态登记表）', () => {
    const markdown = '全文依据《建筑工程施工质量验收统一标准》（GB 50300-2013）执行，相关法规自 2020年 起施行。';
    const report = auditAuthorityCoverage(markdown, makeBlueprintData());
    expect(report.scanned).toBe(2);
    expect(report.registered).toBe(2);
    expect(report.matched).toBe(0);
    expect(report.unregisteredCount).toBe(0);
  });

  it('登记豁免：招标项目编号（E+长数字）不产生未登记项（第三轮收编）', () => {
    const markdown = '本工程为舒城县提升工程，项目编号E341523001005057001，招标人为舒城县住建局。';
    const report = auditAuthorityCoverage(markdown, makeBlueprintData());
    expect(report.registered).toBe(1);
    expect(report.unregisteredCount).toBe(0);
  });

  it('第三轮收编：安装器材/桩号/苗木规格语境未命中归推导缺口', () => {
    const markdown = '其中K1+186至K1+284段98m；双绞线缆194.05m、配线37741m；亚栎（胸径18cm、高度650cm）；拆除人行道4791.33m²。';
    const report = auditAuthorityCoverage(markdown, makeBlueprintData());
    expect(report.unregisteredCount).toBe(0);
    const tokens = report.derivationGaps.map(finding => finding.token);
    // 提取器对 m² 单位以 m 截断（m 分支先于 m² 且 ² 为词边界），与真实文档审计同口径
    expect(tokens).toEqual(expect.arrayContaining(['98m', '194.05m', '37741m', '650cm', '4791.33m']));
  });

  it('第三轮收编：安全文明与专项试验语境未命中归工艺缺口', () => {
    const markdown = '施工现场围挡设置，场区道路硬化100%；淋水压力不低于0.16MPa；脚手架横距不大于1.05m；作业风速达到10.8m/s停止吊装。';
    const report = auditAuthorityCoverage(markdown, makeBlueprintData());
    expect(report.unregisteredCount).toBe(0);
    const tokens = report.processGaps.map(finding => finding.token);
    expect(tokens).toEqual(expect.arrayContaining(['0.16MPa', '1.05m', '10.8m']));
  });

  it('推导缺口：资源/劳动力/机械语境未命中进收编清单', () => {
    const markdown = '高峰期投入劳动力 58 人，配置挖掘机 3 台，材料运输车辆 7 台。';
    const report = auditAuthorityCoverage(markdown, makeBlueprintData());
    // 3 台命中权威（挖掘机 midValue(2,4)=3）；58 人 / 7 台 未命中且属资源语境
    expect(report.matched).toBe(1);
    expect(report.derivationGaps.map(finding => finding.token)).toEqual(['58 人', '7 台']);
    expect(report.derivationGaps[0]?.value).toBe('58');
    expect(report.unregisteredCount).toBe(0);
  });

  it('工艺缺口：工艺/验收参数语境未命中进收编清单', () => {
    const markdown = '混凝土浇筑完成 12 小时，随后开始养护 7 天；压实度不低于 93%，砂浆强度等级为 M7.5。';
    const report = auditAuthorityCoverage(markdown, makeBlueprintData());
    // 12 小时命中权威（试验计划 count=12）；7 天 / 93% / M7.5 未命中且属工艺语境
    expect(report.matched).toBe(1);
    expect(report.processGaps.map(finding => finding.token)).toEqual(['7 天', '93%', 'M7.5']);
    expect(report.derivationGaps).toEqual([]);
    expect(report.unregisteredCount).toBe(0);
    // 12 小时值命中权威但语境属工艺桶（浇筑）→ contextualMatches
    expect(report.contextualMatches.map(finding => finding.token)).toEqual(['12 小时']);
  });

  it('撞核藏值观测：值命中无关条目权威核但语境属工艺桶 → contextualMatches 而非缺口', () => {
    const markdown = '回填方 118m³，随挖随填。';
    const report = auditAuthorityCoverage(markdown, makeBlueprintData());
    // 118 是「一般路灯」权威值核（撞核）；语境属工艺桶（回填）→ 计 matched 但记录 contextualMatches
    expect(report.matched).toBe(1);
    expect(report.processGaps).toEqual([]);
    expect(report.contextualMatches.map(finding => finding.token)).toEqual(['118m']);
  });

  it('未登记项：无语境归属的未命中值计入 unattributed（疑似编造）', () => {
    const markdown = '走廊净宽 2.4m，门洞宽度 0.9m 处设装饰条。';
    const report = auditAuthorityCoverage(markdown, makeBlueprintData());
    expect(report.unattributed.map(finding => finding.token)).toEqual(['2.4m', '0.9m']);
    expect(report.unregisteredCount).toBe(2);
    expect(report.derivationGaps).toEqual([]);
    expect(report.processGaps).toEqual([]);
  });

  it('无蓝图数据边界：全部未命中仍按语境分流（推导语境暴露投影层未接管）', () => {
    const report = auditAuthorityCoverage('总工期 240 日历天。', undefined);
    expect(report.scanned).toBe(1);
    expect(report.matched).toBe(0);
    expect(report.derivationGaps.map(finding => finding.token)).toEqual(['240 日历天']);
  });

  it('token 去重：同值重复出现聚为单条并统计出现次数', () => {
    const markdown = '投入劳动力 58 人。\n\n各阶段共需 58 人，其中高峰期 58 人。';
    const report = auditAuthorityCoverage(markdown, makeBlueprintData());
    expect(report.scanned).toBe(1);
    expect(report.derivationGaps).toHaveLength(1);
    expect(report.derivationGaps[0]?.occurrences).toBe(3);
  });

  it('报告文案：摘要/明细反映三分类计数与验收口径', () => {
    const dirty = auditAuthorityCoverage('走廊净宽 2.4m。', makeBlueprintData());
    expect(authorityAuditSummary(dirty)).toContain('未登记 1');
    expect(authorityAuditSummary(dirty)).toContain('须核查');
    expect(authorityAuditDetails(dirty)[0]).toContain('未登记（疑似编造');
    const clean = auditAuthorityCoverage('总工期 240 日历天。', makeBlueprintData());
    expect(authorityAuditSummary(clean)).not.toContain('须核查');
    expect(authorityAuditDetails(clean)).toEqual(['全部数值命中权威索引或登记表，无未登记项。']);
  });
});
