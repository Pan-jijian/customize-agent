/**
 * 4.31 丰乐镇 v6 悬起整改批（90 条清单）确定性修复器行为锁定：
 * #63/64 阶段名连写拆分（fixPhaseLaborValues ambiguity 扩展）、#70 基础信息表重复合并、
 * #86/87 兜底话术表行删除、#71 编制依据地方性法规补写、#3 埋深槽位数值删除、
 * #90 标题工程类别未覆盖改名——每个 fixer 与其锚定检测器同源（检测定位=修复定位），
 * 用例独立断言行为，不迎合实现。
 * 4.32 续：D2 组 collectLocalBasisRegulations（v6 复测 #56 死结根治——蓝图时点证据池
 * 不含章级召回的地方条例，交付前从全量证据二次提取本地地方条目）；
 * G 组 #59 配置禁用词清洗（注册即生效）、H 组 #60 工伤保险缴纳表述补写；
 * I 组 #57/#58 泛类规则适用面收窄（布置类/劳动力专章证据豁免）。
 */
import { describe, expect, it } from 'vitest';
import { collectLocalBasisRegulations, fixBasisRegulationsRegion, fixDuplicateBasicInfoTables, fixFallbackPlaceholderRows, fixForbiddenConfigurationTerms, fixHeadingUncoveredItems, fixPhaseLaborValues, fixSlotDepthValue, fixWorkInjuryInsurance } from '@/services/document-workflow/documentIntegrityChecks';
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

describe('D fixBasisRegulationsRegion 编制依据地方性法规补写（v6 #71）', () => {
  const markdown = [
    '### 1.1 编制依据',
    '**编制依据**：本施工组织设计的编制依据按以下类别列出：',
    '- 招标文件及补疑补遗：本项目招标文件；',
    '- 国家法律法规：《中华人民共和国建筑法》、《建设工程质量管理条例》；',
    '- 国家/行业现行规范标准：《建筑工程施工质量验收统一标准》（GB 50300-2013）；',
    '- 地方法规规章：工程所在地现行地方性法规与政府规章；',
    '',
    '### 1.2 其他',
    '',
    '正文。',
  ].join('\n');

  it('蓝图地点类法规条目照抄进「地方法规规章」行（类别话术重写）', () => {
    const regulations = ['《中华人民共和国建筑法》', '《建设工程质量管理条例》', '《保障农民工工资支付条例》（国令第724号）', '《合肥市公共资源交易管理条例》'];
    const result = fixBasisRegulationsRegion(markdown, regulations);
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toContain('- 地方法规规章：《合肥市公共资源交易管理条例》及工程所在地现行其他地方性法规与政府规章；');
  });

  it('地方法规缺失时静默（无条目可写不新增行）', () => {
    const result = fixBasisRegulationsRegion(markdown, ['《中华人民共和国建筑法》']);
    expect(result.fixedCount).toBe(0);
    expect(result.markdown).toBe(markdown);
  });

  it('正文已含该书名条目时不动（幂等）', () => {
    const withBook = markdown.replace('工程所在地现行地方性法规与政府规章；', '《合肥市公共资源交易管理条例》；');
    const result = fixBasisRegulationsRegion(withBook, ['《合肥市公共资源交易管理条例》']);
    expect(result.fixedCount).toBe(0);
    expect(result.markdown).toBe(withBook);
  });
});

describe('D2 collectLocalBasisRegulations 交付前证据池本地地方法规补充（v6 #56 死结根治）', () => {
  const blueprintRegs = ['《中华人民共和国招标投标法》', '《中华人民共和国建筑法》', '《建设工程质量管理条例》', '《城镇道路路面设计规范》'];
  const evidence = [
    '### 1.3法律',
    '适用于合同的其他规范性文件：《中华人民共和国民法典》《中华人民共和国建筑法》',
    '《建设工程质量管理条例》《建设工程安全生产管理条例》《合肥市公共资源交易管理条例》等国家及工程所在地现行有效的法律法规和规章。',
    '根据《中华人民共和国建筑法》《合肥市公共资源交易管理条例》《电子招标投标办法》等有关规定制定本规程。',
  ].join('\n');

  it('章级召回的本地地方条目与蓝图清单合并（4.31 蓝图无地方条目→合并后有）', () => {
    const merged = collectLocalBasisRegulations(blueprintRegs, evidence, '安徽省合肥市肥西县');
    expect(merged).toContain('《合肥市公共资源交易管理条例》');
    expect(merged).toContain('《中华人民共和国招标投标法》');
    expect(merged).toHaveLength(blueprintRegs.length + 1);
  });

  it('其它地区/项目法规不得混入（地域过滤）', () => {
    const merged = collectLocalBasisRegulations(blueprintRegs, '依据《上海市城市道路管理条例》与《合肥市公共资源交易管理条例》执行。', '安徽省合肥市肥西县');
    expect(merged).toContain('《合肥市公共资源交易管理条例》');
    expect(merged).not.toContain('《上海市城市道路管理条例》');
  });

  it('蓝图已有同条目时不重复（去重）', () => {
    const merged = collectLocalBasisRegulations(['《合肥市公共资源交易管理条例》'], evidence, '安徽省合肥市肥西县');
    expect(merged.filter(entry => entry.includes('合肥市公共资源交易管理条例'))).toHaveLength(1);
  });

  it('地点无法解析时原样返回蓝图清单（不回退全量证据）', () => {
    expect(collectLocalBasisRegulations(blueprintRegs, evidence, '')).toEqual([...blueprintRegs]);
    expect(collectLocalBasisRegulations(undefined, evidence, '安徽省合肥市肥西县')).toEqual(['《合肥市公共资源交易管理条例》']);
  });

  it('端到端：合并清单喂 fixBasisRegulationsRegion，类别话术行重写为具体条例', () => {
    const md = '### 1.1 编制依据\n- 地方法规规章：工程所在地现行地方性法规与政府规章；\n\n### 1.2 其他\n正文。';
    const merged = collectLocalBasisRegulations(blueprintRegs, evidence, '安徽省合肥市肥西县');
    const result = fixBasisRegulationsRegion(md, merged);
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toContain('- 地方法规规章：《合肥市公共资源交易管理条例》及工程所在地现行其他地方性法规与政府规章；');
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

describe('H fixWorkInjuryInsurance 工伤保险缴纳表述补写（v6 #60）', () => {
  it('农民工工资专用账户段落尾补写，补写句逐字含检测查询短语', () => {
    const markdown = [
      '### 5.4 劳务用工实名制闭环',
      '',
      '项目部严格执行农民工工资专用账户制度，依法与招用的农民工签订劳动合同，并按规定及时足额支付工资。',
      '',
      '后续正文。',
    ].join('\n');
    const result = fixWorkInjuryInsurance(markdown);
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toContain('并按规定及时足额支付工资。项目部按规定为作业人员办理工伤保险，参保信息纳入实名制管理，发生工伤事故时按法定程序申报处理。');
    expect(result.markdown).toContain('后续正文。');
  });

  it('已含办理类表述时不动（幂等）', () => {
    const markdown = '项目部按规定为作业人员办理工伤保险，参保信息纳入实名制管理。';
    const result = fixWorkInjuryInsurance(markdown);
    expect(result.fixedCount).toBe(0);
  });

  it('编制依据仅引用《工伤保险条例》书名不构成缴纳表述，正文仍有劳资管理时补写', () => {
    const markdown = [
      '### 编制依据',
      '',
      '- 国家法律法规：《工伤保险条例》、《保障农民工工资支付条例》；',
      '',
      '实名制管理按劳务管理规定执行。',
    ].join('\n');
    const result = fixWorkInjuryInsurance(markdown);
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toContain('实名制管理按劳务管理规定执行。项目部按规定为作业人员办理工伤保险');
  });

  it('无劳资管理锚点时静默（不新增无关表述）', () => {
    const markdown = '### 一、总则\n\n本项目按施工图纸组织施工。';
    const result = fixWorkInjuryInsurance(markdown);
    expect(result.fixedCount).toBe(0);
    expect(result.markdown).toBe(markdown);
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
