/**
 * 4.31 丰乐镇 v6 悬起整改批（90 条清单）确定性修复器行为锁定：
 * #63/64 阶段名连写拆分（fixPhaseLaborValues ambiguity 扩展）、#70 基础信息表重复合并、
 * #86/87 兜底话术表行删除、#3 埋深槽位数值删除、
 * #90 标题工程类别未覆盖改名——每个 fixer 与其锚定检测器同源（检测定位=修复定位），
 * 用例独立断言行为，不迎合实现。
 * 4.32 续：G 组 #59 配置禁用词清洗（注册即生效）；
 * I 组 #57/#58 泛类规则适用面收窄（布置类/劳动力专章证据豁免）。
 */
import { describe, expect, it } from 'vitest';
import { fixDuplicateBasicInfoTables, fixFallbackPlaceholderRows, fixForbiddenConfigurationTerms, fixHeadingUncoveredItems, fixPhaseLaborValues, fixSlotDepthValue } from '@/services/document-workflow/documentIntegrityChecks';
import { SURFACE_FIX_STEPS } from '@/services/document-workflow/deterministicFixChains';
import { professionalContentIssues } from '@/services/document-workflow/qualityValidation';
import type { ProfessionalDepthAnalysis } from '@/services/document-workflow/professionalDepthClassifier';

const PHASE_AUTHORITIES = [
  { phase: '施工准备与清杂拆除', value: 168 },
  { phase: '污水管网工程', value: 85 },
  { phase: '道路铺装工程', value: 216 },
  { phase: '景观与绿化工程', value: 216 },
  { phase: '亮化与收尾工程', value: 43 },
];

describe('A fixPhaseLaborValues 阶段名连写拆分（v6 #63/64）', () => {
  it('「景观与绿化亮化与收尾工程阶段43人」确定性拆分两阶段并各取权威值', () => {
    const markdown = '本工程劳动力安排以90日历天总工期为控制基准。各阶段同时在场人数按锚点口径锁定：施工准备与清杂拆除阶段168人，污水管网工程阶段85人，道路铺装工程阶段216人，景观与绿化亮化与收尾工程阶段43人。';
    const result = fixPhaseLaborValues(markdown, PHASE_AUTHORITIES);
    expect(result.markdown).toContain('景观与绿化工程阶段216人，亮化与收尾工程阶段43人');
    expect(result.markdown).not.toContain('景观与绿化亮化与收尾工程');
    expect(result.markdown).toContain('污水管网工程阶段85人');
    expect(result.fixedCount).toBeGreaterThanOrEqual(1);
    expect(result.residualCount).toBe(0);
  });

  it('数值型 claim 与拆分类 ambiguity 并存时同轮收敛', () => {
    const markdown = '各阶段同时在场人数：施工准备与清杂拆除阶段150人，景观与绿化亮化与收尾工程阶段43人。';
    const result = fixPhaseLaborValues(markdown, PHASE_AUTHORITIES);
    expect(result.markdown).toContain('施工准备与清杂拆除阶段168人');
    expect(result.markdown).toContain('景观与绿化工程阶段216人，亮化与收尾工程阶段43人');
    expect(result.residualCount).toBe(0);
  });

  it('已正确拆分的句子保持不动（幂等）', () => {
    const markdown = '景观与绿化工程阶段216人，亮化与收尾工程阶段43人。';
    const result = fixPhaseLaborValues(markdown, PHASE_AUTHORITIES);
    expect(result.fixedCount).toBe(0);
    expect(result.markdown).toBe(markdown);
  });
});

describe('B fixDuplicateBasicInfoTables 基础信息表重复合并（v6 #70）', () => {
  const markdown = [
    '#### 项目基本信息表',
    '',
    '| 信息项 | 内容 |',
    '| --- | --- |',
    '| 项目名称 | 2026年度丰乐镇20个美丽宜居自然村建设项目 |',
    '| 建设地点 | 安徽省合肥市肥西县 |',
    '| 计划工期 | 90日历天 |',
    '',
    '正文段落一。',
    '',
    '为便于现场管理与对外协调，项目部将上述项目基础信息与建设边界汇总成表，作为施工部署、资源配置和进度控制的统一口径。',
    '',
    '| 信息项 | 内容 |',
    '| --- | --- |',
    '| 项目名称 | 2026年度丰乐镇20个美丽宜居自然村建设项目 |',
    '| 招标人 | 肥西县丰乐镇人民政府 |',
    '| 施工图出图时间 | 资料未明确 |',
    '',
    '后续正文。',
  ].join('\n');

  it('后续重复表独有字段并入第一张表，重复块与引导句删除，兜底值行不并入', () => {
    const result = fixDuplicateBasicInfoTables(markdown);
    expect(result.fixedCount).toBe(1);
    expect((result.markdown.match(/\|\s*信息项\s*\|\s*内容\s*\|/gu) || []).length).toBe(1);
    expect(result.markdown).toContain('| 招标人 | 肥西县丰乐镇人民政府 |');
    expect(result.markdown).not.toContain('资料未明确');
    expect(result.markdown).not.toContain('汇总成表');
    expect(result.markdown).toContain('正文段落一。');
    expect(result.markdown).toContain('后续正文。');
  });

  it('仅一张基础信息表时不动（幂等）', () => {
    const single = ['| 信息项 | 内容 |', '| --- | --- |', '| 项目名称 | 某项目 |', '', '正文。'].join('\n');
    const result = fixDuplicateBasicInfoTables(single);
    expect(result.fixedCount).toBe(0);
    expect(result.markdown).toBe(single);
  });
});

describe('C fixFallbackPlaceholderRows 兜底话术表行删除（v6 #86/87）', () => {
  it('「资料未明确」数据行删除，其余行保留', () => {
    const markdown = ['| 信息项 | 内容 |', '| --- | --- |', '| 项目名称 | 某项目 |', '| 施工图页数 | 资料未明确 |'].join('\n');
    const result = fixFallbackPlaceholderRows(markdown);
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).not.toContain('资料未明确');
    expect(result.markdown).toContain('| 项目名称 | 某项目 |');
  });

  it('块内数据行全命中时保守放弃（防删空表）', () => {
    const markdown = ['| A | B |', '| --- | --- |', '| x | 资料未明确 |'].join('\n');
    const result = fixFallbackPlaceholderRows(markdown);
    expect(result.fixedCount).toBe(0);
    expect(result.markdown).toBe(markdown);
  });
});

describe('E fixSlotDepthValue 埋深槽位数值错位删除（v6 #3）', () => {
  it('「埋深不小于 23.45m」（长度口径误塞）整段删除，残标点收敛', () => {
    const markdown = '接地母线沿基础外侧敷设，埋深不小于 23.45m，回填土为素土并分层夯实。';
    const result = fixSlotDepthValue(markdown);
    expect(result.markdown).toBe('接地母线沿基础外侧敷设，回填土为素土并分层夯实。');
    expect(result.fixedCount).toBe(1);
  });

  it('物理合理埋深（≤10m）不动', () => {
    const markdown = '管道埋深不小于 0.8m，覆土厚度约 1.2m。';
    const result = fixSlotDepthValue(markdown);
    expect(result.fixedCount).toBe(0);
    expect(result.markdown).toBe(markdown);
  });
});

describe('F fixHeadingUncoveredItems 标题工程类别未覆盖改名（v6 #90）', () => {
  it('「给排水、采暖、燃气工程」正文仅覆盖给排水 → 标题收窄为「给排水工程」', () => {
    const markdown = [
      '#### 2.11.4 给排水、采暖、燃气工程',
      '',
      '本小节包括给、排水附（配）件安装、管道敷设及消防器具安装。',
      '',
      '#### 2.11.5 通风空调工程',
      '',
      '风管制作与安装。',
    ].join('\n');
    const result = fixHeadingUncoveredItems(markdown);
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toContain('#### 2.11.4 给排水工程');
    expect(result.markdown).not.toContain('采暖、燃气');
  });

  it('正文覆盖全部词段时标题不动（幂等）', () => {
    const markdown = [
      '#### 2.11.4 给排水、采暖工程',
      '',
      '给排水管道敷设与采暖管道安装均按设计实施。',
      '',
      '#### 2.11.5 其他工程',
      '',
      '正文。',
    ].join('\n');
    const result = fixHeadingUncoveredItems(markdown);
    expect(result.fixedCount).toBe(0);
    expect(result.markdown).toBe(markdown);
  });
});

describe('G fixForbiddenConfigurationTerms 配置禁用词清洗（v6 #59，注册即生效）', () => {
  it('「按设计要求确定」留白改写为「按施工图设计文件确定」（2 处）', () => {
    const markdown = '隔离高度按设计要求确定，分段长度按设计要求确定。';
    const result = fixForbiddenConfigurationTerms(markdown);
    expect(result.fixedCount).toBe(2);
    expect(result.markdown).toBe('隔离高度按施工图设计文件确定，分段长度按施工图设计文件确定。');
  });

  it('表格数据行「详见图纸」改写；「见图纸目录」交叉引用豁免', () => {
    const markdown = '| 檐口高度 | 详见图纸 |\n| 索引 | 见图纸目录 |';
    const result = fixForbiddenConfigurationTerms(markdown);
    expect(result.markdown).toContain('| 檐口高度 | 详见施工图设计文件 |');
    expect(result.markdown).toContain('| 索引 | 见图纸目录 |');
  });

  it('已洁净文本不动（幂等）', () => {
    const markdown = '隔离高度按施工图设计文件确定。';
    const result = fixForbiddenConfigurationTerms(markdown);
    expect(result.fixedCount).toBe(0);
    expect(result.markdown).toBe(markdown);
  });

  it('已注册到 SURFACE_FIX_STEPS 且 stage5/round2 双链启用（#59 根因：修复器存在但未接线）', () => {
    const step = SURFACE_FIX_STEPS.find(item => item.key === 'forbidden-configuration');
    expect(step?.stage5).toBe(true);
    expect(step?.round2).toBe(true);
  });
});

describe('I professionalContentIssues 泛类规则适用面收窄（v6 #57/#58）', () => {
  const emptyNeeds: ProfessionalDepthAnalysis = {
    dimensions: { factuality: true, structure: true, depth: true, executable: true, specificity: true, consistency: true },
    contentNeeds: { schedule: true, quality: true, safety: true, resource: false, construction: false },
    concrete: true,
    closedLoop: true,
  };
  const laborBody = '劳务人员进场当日完成实名核验，用工峰值调配与跨村组轮转按计划执行。'.repeat(30);
  const plainBody = '现场管理按制度执行，各作业面协同推进。'.repeat(40);

  it('#58 布置类章节（施工总平面布置图）不被 construction 泛类规则审理', () => {
    const issues = professionalContentIssues([{ title: '施工总平面布置图', content: laborBody }], new Map([['施工总平面布置图', emptyNeeds]]));
    expect(issues.filter(issue => issue.message.includes('施工技术章节缺少'))).toHaveLength(0);
  });

  it('#58 常规施工技术章仍按 construction 判定（豁免不外溢）', () => {
    const issues = professionalContentIssues([{ title: '主要施工方法', content: laborBody }], new Map([['主要施工方法', emptyNeeds]]));
    expect(issues.filter(issue => issue.message.includes('施工技术章节缺少'))).toHaveLength(1);
  });

  it('#57 劳动力专章含进场/调配证据时豁免；无证据仍报（真缺保留）', () => {
    const withEvidence = professionalContentIssues([{ title: '劳动力安排计划', content: laborBody }], new Map([['劳动力安排计划', emptyNeeds]]));
    expect(withEvidence.filter(issue => issue.message.includes('资源章节缺少'))).toHaveLength(0);
    const withoutEvidence = professionalContentIssues([{ title: '劳动力安排计划', content: plainBody }], new Map([['劳动力安排计划', emptyNeeds]]));
    expect(withoutEvidence.filter(issue => issue.message.includes('资源章节缺少'))).toHaveLength(1);
  });

  it('#57 含「资源/材料/设备」的宽口径章节仍按 resource 规则判定（豁免不外溢）', () => {
    const issues = professionalContentIssues([{ title: '资源配置计划', content: laborBody }], new Map([['资源配置计划', emptyNeeds]]));
    expect(issues.filter(issue => issue.message.includes('资源章节缺少'))).toHaveLength(1);
  });
});

// ── J. 进度章字面要素对兜底（4.44 #38 根治：4.43 实测「确保工期的技术组织措施」要素齐全仍被判缺） ──

describe('J professionalContentIssues 进度章字面要素对兜底（4.44 #38）', () => {
  const scheduleNeeds: ProfessionalDepthAnalysis = {
    dimensions: { factuality: true, structure: true, depth: true, executable: true, specificity: true, consistency: true },
    contentNeeds: { schedule: false, quality: true, safety: true, resource: true, construction: true },
    concrete: true,
    closedLoop: true,
  };
  const title = '确保工期的技术组织措施';
  const scheduleIssues = (content: string) => professionalContentIssues([{ title, content }], new Map([[title, scheduleNeeds]]))
    .filter(issue => issue.message.includes('进度工期章节缺少'));

  it('#38 修复：语义判缺 + 关键线路与纠偏要素字面同现 → 兜底判覆盖不报（4.43 实测句）', () => {
    const content = '项目部按里程碑节点倒排施工总进度计划，重点检查污水管网管道安装、道路混凝土浇筑、绿化苗木栽植三条关键线路的实际进度，偏差超过1日的节点当日启动纠偏程序，整改完成后由质检员复查确认销项。'.repeat(15);
    expect(scheduleIssues(content)).toHaveLength(0);
  });

  it('#38 对照：仅「关键线路」单词命中（无纠偏类）→ 仍报（要素对不单侧放行）', () => {
    const content = '项目部按里程碑节点倒排施工总进度计划，重点检查三条关键线路的实际进度，偏差超过1日的节点当日启动管理程序，整改完成后由质检员复查确认销项。'.repeat(15);
    expect(scheduleIssues(content)).toHaveLength(1);
  });

  it('#38 对照：仅「纠偏」单词命中（无关键线路）→ 仍报（要素对不单侧放行）', () => {
    const content = '项目部按里程碑节点倒排施工总进度计划，各节点偏差超过1日的当日启动纠偏程序，整改完成后由质检员复查确认销项。'.repeat(15);
    expect(scheduleIssues(content)).toHaveLength(1);
  });
});

// ── K. 资源章字面要素对兜底（r28f B3 根治：r28e 实测「拟投入的主要施工机械、设备计划」要素齐全仍被判缺） ──

describe('K professionalContentIssues 资源章字面要素对兜底（r28f B3）', () => {
  const resourceNeeds: ProfessionalDepthAnalysis = {
    dimensions: { factuality: true, structure: true, depth: true, executable: true, specificity: true, consistency: true },
    contentNeeds: { schedule: true, quality: true, safety: true, resource: false, construction: true },
    concrete: true,
    closedLoop: true,
  };
  const title = '拟投入的主要施工机械、设备计划';
  const resourceIssues = (content: string) => professionalContentIssues([{ title, content }], new Map([[title, resourceNeeds]]))
    .filter(issue => issue.message.includes('资源章节缺少'));

  it('B3 修复：语义判缺 + 资源对象进场与调度机制字面同现 → 兜底判覆盖不报（r28e 实测句）', () => {
    const content = '机械进场时间按施工准备阶段第1日至第7日分批组织，首批挖掘机、自卸汽车在开工令下发后按进度计划进场。设备调度由项目部机械员统一负责，按先满足开挖面、再保障碾压面的原则调配机具。'.repeat(15);
    expect(resourceIssues(content)).toHaveLength(0);
  });

  it('B3 对照：仅资源对象进场（无调度/保管类机制）→ 仍报（要素对不单侧放行）', () => {
    const content = '机械进场时间按施工准备阶段第1日至第7日分批组织，首批挖掘机、自卸汽车按进度计划进场。现场管理按制度执行，各作业面协同推进。'.repeat(15);
    expect(resourceIssues(content)).toHaveLength(1);
  });

  it('B3 对照：泛主体「人员进场+调配」薄内容不兜底（防关键词罗列段）', () => {
    const content = '劳务人员进场当日完成实名核验，用工峰值调配与跨村组轮转按计划执行。'.repeat(30);
    expect(resourceIssues(content)).toHaveLength(1);
  });
});
