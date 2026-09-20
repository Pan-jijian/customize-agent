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
});
