/**
 * V5 P5 无主数值审计器测试（M6 闭环；F-T4 审计 v2）：扫描 → 幽灵/表格/零值过滤 →
 * 登记豁免 → 权威核匹配（蓝图 + 全源补充核）→ C-T2 分类器豁免 → 无主语境分流。
 *
 * 分流契约：资源/劳动力/机械/进度语境 → 推导缺口（收编清单）；工艺语境 → 工艺缺口（收编清单）；
 * 其余 → 未登记（疑似编造，验收口径「0 未登记项」= unregisteredCount 为 0）。
 * F-T4：三桶任一非零 → authorityAuditIssues 产出 blocker（硬门禁，审计失败不可进交付）。
 */
import { describe, expect, it } from 'vitest';
import { auditAuthorityCoverage, authorityAuditDetails, authorityAuditIssues, authorityAuditSummary } from '@/services/document-workflow/authorityAudit';
import { buildBillFactLock, stripUnitCountPrefix } from '@/services/document-workflow/billFactLock';
import { namedTotalClosure, type NamedAuthorityValue } from '@/services/document-workflow/factReconciliation';
import { buildNumericAuthority } from '@/services/document-workflow/finalize/repairRounds/numericVerification';
import type { FinalizeSession } from '@/services/document-workflow/finalize/finalizeSession';
import type { BlueprintData } from '@/services/document-workflow/integratedBlueprint';

/** 全字段填充 fixture：与 authorityIndex 契约测试同源结构（覆盖全部数值叶子） */
function makeBlueprintData(): BlueprintData {
  return {
    strategyId: 'village-municipal',
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
        peakBasis: '清单工效推导',
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
    testInstruments: [{ name: '水准仪', spec: 'DS3', quantity: 2, purpose: '高程控制测量与标高复核', basis: '检定合格后投入使用' }],
    tempLand: [{ purpose: '材料堆放场', area: 800, location: '场内运输道路旁', duration: '施工全过程', note: '分类堆放并分区标识', basis: '施工总平面布置规划' }],
    schedule: [{ seq: 1, label: '施工准备', duration: 20, startDay: 1, endDay: 20, critical: false, basis: '前导工作，与主体施工穿插进行' }],
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
    // M24d D1 重排后 m² 单位整提不再以 m 截断（原「4791.33m」为截断漏网形态）
    expect(tokens).toEqual(expect.arrayContaining(['98m', '194.05m', '37741m', '650cm', '4791.33m²']));
  });

  it('第三轮收编：安全文明与专项试验语境未命中归工艺缺口（R9 压力参数豁免）', () => {
    const markdown = '施工现场围挡设置，场区道路硬化100%；淋水压力不低于0.16MPa；脚手架横距不大于1.05m；作业风速达到10.8m/s停止吊装。';
    const report = auditAuthorityCoverage(markdown, makeBlueprintData());
    expect(report.unregisteredCount).toBe(0);
    // F-T4：0.16MPa 命中 R9 工艺压力参数（淋水试验压力）→ 规范/管理豁免；100% 撞核权威 100W（一般路灯 spec）计入 matched
    expect(report.processGaps.map(finding => finding.token)).toEqual(['1.05m', '10.8m']);
    expect(report.conventionExempt).toBe(1);
    expect(report.matched).toBe(1);
    expect(report.scanned).toBe(4);
  });

  it('第四轮收编·边界严格定位：「1.5m」首现不落在「31.5mm」子串内（语境取真实出现处）', () => {
    const markdown = '防水涂膜厚度 31.5mm，搭接宽度符合要求。管顶覆土堆高按 1.5m 控制。';
    const report = auditAuthorityCoverage(markdown, makeBlueprintData());
    const finding = [...report.derivationGaps, ...report.processGaps].find(item => item.token === '1.5m');
    expect(finding).toBeDefined();
    expect(finding?.context).toContain('堆高');
    expect(finding?.context).not.toContain('涂膜');
  });

  it('第四轮收编·边界严格计数：「5.5m」出现次数不把「3245.5m³」子串计入', () => {
    const markdown = '土方开挖总量 3245.5m³。泵站提升泵设计扬程 H=5.5m，流量满足要求。';
    const report = auditAuthorityCoverage(markdown, makeBlueprintData());
    const finding = report.processGaps.find(item => item.token === '5.5m');
    expect(finding).toBeDefined();
    expect(finding?.occurrences).toBe(1);
    expect(finding?.context).toContain('提升泵');
  });

  it('第四轮收编：路灯套数/苗木冠丛/保勤人数语境未命中归推导缺口', () => {
    const markdown = '配置太阳能路灯 24 套；栽植金桂 8 株（冠丛高度 280cm）；实行保勤制度，出勤人数 172 人。';
    const report = auditAuthorityCoverage(markdown, makeBlueprintData());
    expect(report.unregisteredCount).toBe(0);
    const tokens = report.derivationGaps.map(item => item.token);
    expect(tokens).toEqual(expect.arrayContaining(['24 套', '280cm', '172 人']));
  });

  it('第四轮收编：降雨阈值/PPR 管系列/提升泵扬程语境未命中归工艺缺口（R12 管系列豁免）', () => {
    const markdown = '日降雨量达到 95mm 时暂停室外作业；冷热水系统采用 PPR 管 S3.2 系列；提升泵扬程 H=5.5m 复核合格。';
    const report = auditAuthorityCoverage(markdown, makeBlueprintData());
    expect(report.unregisteredCount).toBe(0);
    // F-T4：S3.2 命中 R12 管系列代号 → 规范/管理豁免，其余两项仍归工艺缺口
    expect(report.processGaps.map(item => item.token)).toEqual(['95mm', '5.5m']);
    expect(report.conventionExempt).toBe(1);
  });

  it('推导缺口：资源/劳动力/机械语境未命中进收编清单（M2b 组织配置豁免）', () => {
    const markdown = '高峰期投入劳动力 58 人，配置挖掘机 3 台，材料运输车辆 7 台。';
    const report = auditAuthorityCoverage(markdown, makeBlueprintData());
    // 3 台命中权威（挖掘机 midValue(2,4)=3）；58 人命中 M2b 组织配置（配置+材料语境）→ 规范/管理豁免；
    // 7 台 未命中且属资源语境 → 推导缺口
    expect(report.matched).toBe(1);
    expect(report.derivationGaps.map(finding => finding.token)).toEqual(['7 台']);
    expect(report.derivationGaps[0]?.value).toBe('7');
    expect(report.unregisteredCount).toBe(0);
    expect(report.conventionExempt).toBe(1);
  });

  it('工艺缺口：工艺/验收参数语境未命中进收编清单（R3/R7/R10 豁免）', () => {
    const markdown = '混凝土浇筑完成 12 小时，随后开始养护 7 天；压实度不低于 93%，砂浆强度等级为 M7.5。';
    const report = auditAuthorityCoverage(markdown, makeBlueprintData());
    // 12 小时命中权威（试验计划 count=12）；7 天 R3 养护龄期 / 93% R7 质量指标 / M7.5 R10 砂浆等级
    // 全部豁免 → 规范/管理豁免 3，工艺缺口清零
    expect(report.matched).toBe(1);
    expect(report.processGaps).toEqual([]);
    expect(report.derivationGaps).toEqual([]);
    expect(report.unregisteredCount).toBe(0);
    expect(report.conventionExempt).toBe(3);
    // 12 小时值命中权威但语境属工艺桶（浇筑）→ contextualMatches
    expect(report.contextualMatches.map(finding => finding.token)).toEqual(['12 小时']);
  });

  it('撞核藏值观测：值命中无关条目权威核但语境属工艺桶 → contextualMatches 而非缺口', () => {
    const markdown = '回填方 118m³，随挖随填。';
    const report = auditAuthorityCoverage(markdown, makeBlueprintData());
    // 118 是「一般路灯」权威值核（撞核）；语境属工艺桶（回填）→ 计 matched 但记录 contextualMatches
    // M24d D1 重排后 m³ 单位整提（原截断为 118m）
    expect(report.matched).toBe(1);
    expect(report.processGaps).toEqual([]);
    expect(report.contextualMatches.map(finding => finding.token)).toEqual(['118m³']);
  });

  it('未登记项：无语境归属的未命中值计入 unattributed（疑似编造）', () => {
    const markdown = '走廊净宽 2.4m，门洞宽度 0.9m 处设装饰条。';
    const report = auditAuthorityCoverage(markdown, makeBlueprintData());
    expect(report.unattributed.map(finding => finding.token)).toEqual(['2.4m', '0.9m']);
    expect(report.unregisteredCount).toBe(2);
    expect(report.derivationGaps).toEqual([]);
    expect(report.processGaps).toEqual([]);
  });

  it('r6 实机校准：避雷支撑卡/预留/配电箱语境未命中进收编清单（不落未登记）', () => {
    // r6 审计 3 项未登记（0.5m/0.35m/0.3m）归因：避雷带支撑卡（防雷安装）、基础预留宽度
    // （构造几何）归工艺语境；配电箱基础（设备器材）归推导缺口——词表扩充后同句同值
    // 全部收编，unregisteredCount 为 0
    const markdown = '配电箱底距地0.3m。避雷带支撑卡间距0.5m。基础预留0.35m。';
    const report = auditAuthorityCoverage(markdown, makeBlueprintData());
    expect(report.unregisteredCount).toBe(0);
    expect(report.unattributed).toEqual([]);
    expect(report.derivationGaps.map(finding => finding.token)).toEqual(expect.arrayContaining(['0.3m']));
    expect(report.processGaps.map(finding => finding.token)).toEqual(expect.arrayContaining(['0.5m', '0.35m']));
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

  // ═══ F-T4 审计 v2 矩阵（数值编造根治：提取修正 / 匹配扩容 / 豁免单源 / 硬门禁） ═══

  it('F-T4 提取修正：零值核心（E0 类符号截断形态）不进扫描', () => {
    const report = auditAuthorityCoverage('管井编号 E0。', makeBlueprintData());
    expect(report.scanned).toBe(0);
    expect(report.unregisteredCount).toBe(0);
  });

  it('F-T4 提取修正：表格行数值不做溯源反查（与 C-T2 scanNumericTrace 同口径）', () => {
    const markdown = '正文说明段落。\n\n| 项目 | 数量 |\n| --- | --- |\n| 临时便道 | 98765 座 |\n\n收尾段落。';
    const report = auditAuthorityCoverage(markdown, makeBlueprintData());
    expect(report.scanned).toBe(0);
    expect([...report.derivationGaps, ...report.processGaps, ...report.unattributed]).toEqual([]);
  });

  it('F-T4 匹配扩容：尾零规约双侧归一（0.80m ↔ 权威 0.8）', () => {
    const report = auditAuthorityCoverage('斗容 0.80m³ 的挖掘机进场。', makeBlueprintData());
    // 权威核 0.8（挖掘机 spec）与正文 0.80 归一后等价 → matched（语境属资源桶 → contextualMatches 观测）
    // M24d D1 重排后 m³ 单位整提（原截断为 0.80m）
    expect(report.matched).toBe(1);
    expect(report.unregisteredCount).toBe(0);
    expect(report.contextualMatches.map(finding => finding.token)).toEqual(['0.80m³']);
  });

  it('F-T4 匹配扩容：全源补充核（extraAuthorityTokens）不再误报投影缺口', () => {
    const report = auditAuthorityCoverage('场地平整 685.32m³。', makeBlueprintData(), new Set(['685.32m³']));
    // 685.32 来源在证据/清单而蓝图未投影：全源 token 转数值核心并入权威核 → matched
    expect(report.matched).toBe(1);
    expect(report.unregisteredCount).toBe(0);
    expect(report.processGaps).toEqual([]);
  });

  it('F-T4 工艺缺口路径保持：分类器未否决的构造参数仍落桶（豁免不放宽收编口径）', () => {
    const report = auditAuthorityCoverage('防水涂膜厚度 2.5mm，搭接宽度 35mm。', makeBlueprintData());
    // 2.5mm/35mm 为构造厚度参数（R8 仅豁免 偏差/公差/误差 语境）→ 仍归工艺缺口
    expect(report.processGaps.map(finding => finding.token)).toEqual(['2.5mm', '35mm']);
    expect(report.conventionExempt).toBe(0);
  });

  it('F-T4 硬门禁：三桶任一非零 → blocker（fact_consistency + llm_repairable 直通硬阻断）', () => {
    const clean = auditAuthorityCoverage('总工期 240 日历天。', makeBlueprintData());
    expect(authorityAuditIssues(clean)).toEqual([]);
    const unregistered = auditAuthorityCoverage('走廊净宽 2.4m，门洞宽度 0.9m 处设装饰条。', makeBlueprintData());
    const issues = authorityAuditIssues(unregistered);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ level: 'error', severity: 'blocker', category: 'fact_consistency', owner: 'llm', repairability: 'llm_repairable' });
    expect(issues[0].message).toContain('无主数值审计失败');
    expect(issues[0].message).toContain('疑似编造（未登记）2 项 2.4m、0.9m');
    // 收编缺口非零同样硬阻断（不只未登记桶）
    const gap = auditAuthorityCoverage('防水涂膜厚度 2.5mm，搭接宽度 35mm。', makeBlueprintData());
    expect(authorityAuditIssues(gap)[0]?.message).toContain('工艺库缺口 2 项 2.5mm、35mm');
  });

  it('F-T4 摘要：豁免计数入文案且不计缺口', () => {
    const report = auditAuthorityCoverage('养护 7 天；压实度不低于 93%。', makeBlueprintData());
    expect(report.conventionExempt).toBe(2);
    expect(authorityAuditSummary(report)).toContain('规范/管理豁免 2');
    expect(authorityAuditSummary(report)).not.toContain('须核查');
    expect(authorityAuditSummary(report)).not.toContain('须补齐');
  });

  // ═══ M24d D1 面积盲区根治（r28k/s28l 实机：m² 被截断为 m + ㎡ 标点形态漏提 → 假未登记） ═══

  it('M24d D1：正文「13.85m²」整提不截断，撞全源核即 matched（实机缺口根治形态）', () => {
    const report = auditAuthorityCoverage('门卫建筑面积13.85m²。', makeBlueprintData(), new Set(['13.85m2']));
    expect(report.scanned).toBe(1);
    expect(report.matched).toBe(1);
    expect(report.unregisteredCount).toBe(0);
    expect([...report.derivationGaps, ...report.processGaps, ...report.unattributed]).toEqual([]);
  });

  it('M24d D1：无核时「13.85m²」以完整形态落未登记（不再截断为「13.85m」的漏网形态）', () => {
    const report = auditAuthorityCoverage('门卫建筑面积13.85m²。', makeBlueprintData());
    expect(report.unattributed.map(finding => finding.token)).toEqual(['13.85m²']);
    expect(report.unregisteredCount).toBe(1);
  });

  it('M24d D1：非词形单位后接标点「937.72㎡；」不再漏提（尾部边界断言根治）', () => {
    const report = auditAuthorityCoverage('绿化用地937.72㎡；园路铺装另计。', makeBlueprintData(), new Set(['937.72㎡']));
    expect(report.scanned).toBe(1);
    expect(report.matched).toBe(1);
    expect(report.unregisteredCount).toBe(0);
  });

  // ═══ M24d D2 事实主表表格第 5 源（buildNumericAuthority → extraAuthorityTokens 传导） ═══

  it('M24d D2：表格三形态（连写/分列/中文单位）数值入核', () => {
    const session = {
      allEvidence: [],
      input: {},
      structuredFacts: [],
      factsModel: {
        tables: [
          // 连写形态（s28l 实机正文表格「工程量合计约 28792m2」同源）
          { rows: [['门卫', '建筑面积13.85m2'], ['综合配套用房', '774.11m2']] },
          // 分列形态（清单分列表「| 1436.400 | m2 |」：数字格×单位格跨格组合）
          { rows: [['绿化用地', '1436.400', 'm2']] },
          // 中文单位形态
          { rows: [['公共广场', '961.42平方米']] },
        ],
      },
    } as unknown as FinalizeSession;
    const authority = buildNumericAuthority(session);
    expect(authority.has('13.85m2')).toBe(true);
    expect(authority.has('774.11m2')).toBe(true);
    expect(authority.has('1436.400m2')).toBe(true);
    expect(authority.has('961.42平方米')).toBe(true);
  });

  it('M24d D2：正文 m² 形态撞表格核（数值核心规约尾零，单位形态无关）→ matched 不落未登记', () => {
    const session = {
      allEvidence: [],
      input: {},
      structuredFacts: [],
      factsModel: { tables: [{ rows: [['门卫', '13.85', 'm2']] }] },
    } as unknown as FinalizeSession;
    const authority = buildNumericAuthority(session);
    const report = auditAuthorityCoverage('门卫建筑面积13.85m²。', undefined, authority);
    expect(report.scanned).toBe(1);
    expect(report.matched).toBe(1);
    expect(report.unregisteredCount).toBe(0);
  });

  // ═══ L0-7 提取粘连/编号假 token 的豁免（实机成稿 doc-1790104980418；含/不含两侧） ═══

  const reportedTokens = (report: ReturnType<typeof auditAuthorityCoverage>): string[] =>
    [...report.derivationGaps, ...report.processGaps, ...report.unattributed].map(finding => finding.token);

  it('L0-7 规格粘连：型号/牌号与数量无分隔粘连（HRB4001.941t / HRB40025.851t / DN405m / Φ251.941t）不落任何缺口桶', () => {
    // 逐句单 token（scanned=1 证明该粘连形态确实进了扫描，豁免不是「没扫到」）
    for (const [markdown, glued] of [
      ['钢筋HRB4001.941t。', 'HRB4001.941t'],
      ['钢筋工程现浇构件钢筋HRB40025.851t。', 'HRB40025.851t'],
      ['DN405m；', 'DN405m'],
      ['Φ251.941t。', '251.941t'],
    ] as const) {
      const report = auditAuthorityCoverage(markdown);
      expect(report.scanned).toBe(1);
      expect(report.conventionExempt).toBe(1);
      expect(reportedTokens(report)).toEqual([]);
      expect(reportedTokens(report)).not.toContain(glued);
      // 豁免走 C-T2 分类器（conventionExempt），不是靠「放宽未登记桶」达成
      expect(report.unattributed).toEqual([]);
    }
  });

  it('L0-7 章节编号：目录/标题编号 token（1.22 周，邻号 1.23）不计缺口；同形无邻号的时量表述照报', () => {
    const numbering = auditAuthorityCoverage('总进度计划编制与图表管理 1.22 周月计划报送与纠偏 1.23');
    expect(numbering.scanned).toBe(1);
    expect(numbering.conventionExempt).toBe(1);
    expect(reportedTokens(numbering)).toEqual([]);
    const quantity = auditAuthorityCoverage('首段养护历时 1.22 周后进入下道工序。');
    expect(quantity.scanned).toBe(1);
    expect(quantity.conventionExempt).toBe(0);
    expect(reportedTokens(quantity)).toContain('1.22 周');
  });

  it('L0-7 型材语境扩容：板型型号（HV470B）按 R13 语境词族豁免，非按单个值开口子', () => {
    const report = auditAuthorityCoverage('屋面压型钢板，板型HV470B。');
    expect(report.scanned).toBe(1);
    expect(report.conventionExempt).toBe(1);
    expect(reportedTokens(report)).toEqual([]);
  });

  it('L0-7 反向守护：真缺口不得借豁免族静默——清单投影缺口与正文自算合计照常报出（427.000个 属缺口桶，不进未登记）', () => {
    for (const [markdown, token] of [
      ['配套混凝土管道接口427.000个口、砌筑检查井54座。', '427.000个'],
      ['室外排水塑料管424.2m，按设计坡度敷设。', '424.2m'],
      ['检验批总量6403.78m²，按分项工程划分。', '6403.78m²'],
    ] as const) {
      const report = auditAuthorityCoverage(markdown);
      expect(report.conventionExempt).toBe(0);
      expect(reportedTokens(report)).toContain(token);
      // 投影/推导缺口（须收编或改定性），不是编造信号桶
      expect(report.unattributed.map(finding => finding.token)).not.toContain(token);
    }
  });

  it('L0-7 反向守护：整数段带前导零的真实量值（Φ1000mm 的 1000mm、φ700人孔 的 700人）不被粘连族吞掉', () => {
    const report = auditAuthorityCoverage('Φ1000mm检查井井筒；φ700人孔井盖与路面齐平。');
    expect(report.conventionExempt).toBe(0);
    expect(reportedTokens(report)).toEqual(expect.arrayContaining(['1000mm', '700人']));
  });

  it('L0-7 反向守护：纯代号（无数量段，HRB400/DN40）不进粘连族豁免', () => {
    const report = auditAuthorityCoverage('钢筋HRB400，Φ16共364个。');
    expect(report.conventionExempt).toBe(0);
    expect(reportedTokens(report)).toEqual(expect.arrayContaining(['HRB400']));
  });

  // ═══ L0-7 收尾（doc-1790115927170 实测）：窗口截断 + 清单单位格数量污染 ═══

  it('L0-7 窗口截断根治：目录邻号被 ±16 字窗口从中间截半（1.23 → .23）时编号仍豁免，不进未登记桶', () => {
    // 逐行目录：token「1.24 项」「1.25 项」的窗口左界落在上一行编号「1.23」中间（截成「.23」）——
    // R17 同形邻号判据因缺整数段不成立 → 实机曾直落未登记桶（假编造 blocker）
    const markdown = '1.22 施工进度计划编制\n1.23 工伤保险与劳动保障\n1.24 项目管理机构与岗位职责\n1.25 项目主要施工内容';
    const report = auditAuthorityCoverage(markdown);
    expect(reportedTokens(report)).not.toContain('1.24 项');
    expect(reportedTokens(report)).not.toContain('1.25 项');
    expect(report.conventionExempt).toBeGreaterThanOrEqual(2);
    expect(report.unattributed).toEqual([]);
  });

  it('L0-7 单源防线：语境窗口仍被截断时（调用方自截），截断邻号「.23」同样成立', () => {
    // 审计侧已吸附边界，此处守的是「其他调用方传入被截断语境」的通道（判定在 C-T2 单源内）
    const report = auditAuthorityCoverage('总进度计划 1.24 项目管理机构与岗位职责');
    expect(report.unattributed).toEqual([]);
  });

  it('L0-7 清单单位格混写数量（实机「1个口」）：剥离数量前缀后工程量入权威核，正文 427.000个 不落缺口', () => {
    const boq = {
      entries: [{
        seq: 77, name: '混凝土管道接口', description: '1．管道类型、管道材质：采用钢筋混凝土承插口管(Ⅱ级) 3．管径：DN300',
        quantity: 427, unit: '1个口', section: '室外附属工程', subsection: '', villageGroup: '', sourceFile: '室外附属工程.xls',
      }],
      totalEntries: 1, sourceFile: '室外附属工程.xls', complete: true,
    } as unknown as Parameters<typeof buildBillFactLock>[0]['boq'];
    const lock = buildBillFactLock({ boq })!;
    expect(lock.entries[0].unit).toBe('个口');
    expect(lock.entries[0].unitRaw).toBe('1个口');
    expect(lock.entries[0].specQuantityPairs.map(pair => pair.quantity)).toContain('427个口');
    const session = {
      allEvidence: [], structuredFacts: [],
      input: { billFactLock: lock },
      factsModel: { tables: [] },
    } as unknown as FinalizeSession;
    const authority = buildNumericAuthority(session);
    expect(authority.has('427个')).toBe(true);
    const report = auditAuthorityCoverage('配套混凝土管道接口427.000个口。', undefined, authority);
    expect(report.matched).toBe(1);
    expect(reportedTokens(report)).toEqual([]);
    // 反向守护：剥离不清空闸门——清单里没有的同类数值照报
    const fabricated = auditAuthorityCoverage('配套混凝土管道接口999.000个口。', undefined, authority);
    expect(reportedTokens(fabricated)).toContain('999.000个');
  });

  it('L0-7 单位剥离边界：汉字量词混写才剥，ASCII 量纲/倍率单位（m2 / 10m / 100m3）一律不动', () => {
    expect(stripUnitCountPrefix('1个口')).toBe('个口');
    expect(stripUnitCountPrefix('2台班')).toBe('台班');
    expect(stripUnitCountPrefix('1.5个')).toBe('个');
    for (const unit of ['m2', '10m', '100m3', '个', '座', 'm', '棵', '㎡', 't', '项目']) {
      expect(stripUnitCountPrefix(unit)).toBe(unit);
    }
  });

  // ═══ 4.55.31 B1 章节编号扩形（实机 doc-1790125123717 的「3.8 周」） ═══

  it('4.55.31 B1：一位小数小节编号（3.8 周＝3.8 小节 + 标题首字周）按同形邻号豁免；真实时量无同形邻号照报', () => {
    // 实机目录：「3.7 现场设施与计量装置保护 / 3.8 周边管线与建筑保护措施 / 3.9 …」
    const numbering = auditAuthorityCoverage('3.7 现场设施与计量装置保护 3.8 周边管线与建筑保护措施 3.9 其他管理措施');
    expect(numbering.scanned).toBe(1);
    expect(numbering.conventionExempt).toBe(1);
    expect(reportedTokens(numbering)).toEqual([]);
    // 反例：真实时量「1.5 月」无同形邻号 → 不得被扩形吞掉（照落缺口）
    const duration = auditAuthorityCoverage('首段养护历时 1.5 月后进入下道工序。');
    expect(duration.scanned).toBe(1);
    expect(duration.conventionExempt).toBe(0);
    expect(reportedTokens(duration)).toContain('1.5 月');
  });

  // ═══ 4.55.31 B2 合计闭包（实机 doc-1790125123717 的 6403.78m² 归因） ═══

  const withQuantities = (quantities: BlueprintData['quantities']): BlueprintData => ({ ...makeBlueprintData(), quantities });

  it('4.55.31 B2：自称合计且可由具名权威分项闭合（总量6403.78m²＝墙面涂膜防水5764.81＋天棚涂膜防水638.97）→ 收编不落缺口', () => {
    const data = withQuantities({
      墙面涂膜防水: { value: 5764.81, unit: 'm2', sourceFile: '清单.xls' },
      天棚涂膜防水: { value: 638.97, unit: 'm2', sourceFile: '清单.xls' },
    });
    // 实机原文形态：归属名「防水」在数值前 31 字处（16 字分流窗口取不到，闭包窗口 ±40 字可见）
    const report = auditAuthorityCoverage('防水工程按施工段划分检验批并做蓄水（淋水）试验（总量6403.78m²）。', data);
    expect(report.totalClaimClosed?.map(finding => finding.token)).toEqual(['6403.78m²']);
    expect(report.totalClaimClosed?.[0]?.closure).toEqual(['墙面涂膜防水 5764.81m2', '天棚涂膜防水 638.97m2']);
    expect([...report.derivationGaps, ...report.processGaps, ...report.unattributed]).toEqual([]);
    expect(authorityAuditIssues(report)).toEqual([]);
    expect(authorityAuditSummary(report)).toContain('合计闭包 1');
    expect(authorityAuditDetails(report).join('\n')).toContain('合计闭包收编（权威分项和，不计缺口）');
  });

  it('4.55.31 B2 反例：凭空合计值（7777.77m²）无可闭合分项 → 照落缺口 + 硬门禁', () => {
    const data = withQuantities({
      墙面涂膜防水: { value: 5764.81, unit: 'm2', sourceFile: '清单.xls' },
      天棚涂膜防水: { value: 638.97, unit: 'm2', sourceFile: '清单.xls' },
    });
    const report = auditAuthorityCoverage('防水工程按施工段划分检验批并做蓄水（淋水）试验（总量7777.77m²）。', data);
    expect(report.totalClaimClosed ?? []).toEqual([]);
    expect(report.processGaps.map(finding => finding.token)).toEqual(['7777.77m²']);
    expect(authorityAuditIssues(report)[0]?.message).toContain('工艺库缺口 1 项 7777.77m²');
  });

  it('4.55.31 B2 反例：无名称锚定的凑数不成立（两项权威值和恰等于合计值也不闭合）', () => {
    // 3000 + 3403.78 = 6403.78，但分项名与合计句语境无任何 ≥2 字连续汉字关系 → 不构成分项和
    const data = withQuantities({
      甲类构件: { value: 3000, unit: 'm2', sourceFile: '清单.xls' },
      乙类构件: { value: 3403.78, unit: 'm2', sourceFile: '清单.xls' },
    });
    const report = auditAuthorityCoverage('防水工程按施工段划分检验批并做蓄水（淋水）试验（总量6403.78m²）。', data);
    expect(report.totalClaimClosed ?? []).toEqual([]);
    expect(reportedTokens(report)).toContain('6403.78m²');
  });

  it('4.55.31 B2 反例：非合计自称的分项值不收编（实机 424.2m 保持推导缺口，即使恰等于权威两项之和）', () => {
    // 350.6 + 73.6 = 424.2，且两名都在语境中——但「塑料管424.2m」是分项值列举，非自称合计
    const data = withQuantities({
      复合管: { value: 350.6, unit: 'm', sourceFile: '清单.xls' },
      塑料管: { value: 73.6, unit: 'm', sourceFile: '清单.xls' },
    });
    const report = auditAuthorityCoverage('作业对象为1#厂房室内给水系统，覆盖复合管350.6m、塑料管424.2m、管道消毒冲洗773.8m。', data);
    expect(report.totalClaimClosed ?? []).toEqual([]);
    expect(report.derivationGaps.map(finding => finding.token)).toContain('424.2m');
  });

  it('4.55.31 B2 单源：同名多值分项组和闭合（分村/分工程 groups），且同名组和只在同层聚合（防条目值与其明细重复计入）', () => {
    const values: NamedAuthorityValue[] = [
      { name: '挖淤泥', value: 838.81, unit: 'm3', kind: 'group' },
      { name: '挖淤泥', value: 213.99, unit: 'm3', kind: 'group' },
      { name: '挖淤泥', value: 1052.8, unit: 'm3', kind: 'entry' },
      { name: '流砂', value: 999, unit: 'm3', kind: 'entry' },
    ];
    expect(namedTotalClosure({ total: 1052.8, unit: 'm³', context: '挖淤泥、流砂合计', values })?.map(item => item.value)).toEqual([838.81, 213.99]);
    // 2×1052.8 = 条目值 + 其两组明细（跨层重复计入）→ 不闭合
    expect(namedTotalClosure({ total: 2105.6, unit: 'm³', context: '挖淤泥合计', values })).toBeNull();
    // 单位不同族 / 无名称锚定 → 不闭合
    expect(namedTotalClosure({ total: 1052.8, unit: 'm²', context: '挖淤泥合计', values })).toBeNull();
    expect(namedTotalClosure({ total: 1847.8, unit: 'm³', context: '土石方合计', values })).toBeNull();
  });
});
