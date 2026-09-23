/**
 * C4「招标要求响应」用例矩阵（4.59 R-C4，真实招标条款逐字用例）。
 *
 * 背景：两份巢湖终稿各报 N 条「招标要求未响应/部分响应」blocker（ea380252 2 条、cfb0a0da 10 条，
 * 三轮报告 4/2/10）。逐条锚点解剖（见 `rc-class-diag.manual.ts` 的 [C4-解剖] 表）证明其中多数是
 * **锚点形态口径缺口**导致的误报，判定链本身（锚点全覆盖/分句/voice 三通道）并未放宽：
 *   ① 材料牌号被切成无意义碎片（`HPB300` → `HPB`+`300`）→ 正文写全牌号也命不中；
 *   ② 单体编号形态差：coreTerms 写 `1厂房`（招标原文），正文口径统一写 `1#厂房`（实测 79/53 处 vs 裸形 0 处）；
 *   ③ 空话值条款的名目锚点（「绿色建筑等级要求：按设计图纸要求」）——正文写实（基本级/二星级）却不回抄名目；
 *   ④ 名目清单条款（「施工组织措施的针对性、可行性」）的锚点全是评价维度词，正文必然 0 次；
 *   ⑤ 零值数量参数（OCR 残片「0.0个）」）——正文不存在「响应 0 个」的写法。
 *
 * 条款文本与 coreTerms **逐字取自真实招标要求模型缓存**
 * （~/.customize-agent/cache/document-workflow/<proj>/tender-requirements-cb2f6ff4….json，220 条），
 * 正文文本逐字取自两份真实终稿。四类覆盖：正向（真满足/真缺失两个方向）/
 * 反向（五类误报各自不得再报）/ 边界（阈值与形态边界）/ 不变（既有通道不得改变）。
 *
 * 零静默降级：⑤ 的处置是「无可用锚点 → 降 warning 并显性记录」（见用例 8），
 * 有锚点但缺锚点的条款仍照旧报 blocker（见用例 3/4/9）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/document-workflow/llmClient', async () => {
  const actual = (await vi.importActual('@/services/document-workflow/llmClient')) as typeof LlmClientModule;
  return { ...actual, callDocumentLlmJson: vi.fn() };
});
// 语义阈值随模块单源（本文件注入 () => 0 / () => 0.8，不依赖真实嵌入）
vi.mock('@/services/document-workflow/semanticSimilarity', () => ({ buildSemanticSimilarity: vi.fn(), SEMANTIC_COVERAGE_THRESHOLD: 0.6 }));

import type * as LlmClientModule from '@/services/document-workflow/llmClient';
import { callDocumentLlmJson } from '@/services/document-workflow/llmClient';
import { collectRequirementAnchors, requirementAcceptanceIssues, tenderRequirementResponseGaps } from '@/services/document-workflow/tenderRequirements';
import type { TenderRequirementEntry, TenderRequirementPolicy } from '@/services/document-workflow/types';

const entry = (text: string, coreTerms: string[], policy: TenderRequirementPolicy = 'respond', category = '其他要求'): TenderRequirementEntry => ({
  text,
  coreTerms,
  sources: [{ file: '招标文件.pdf' }],
  category,
  policy,
});

// ═══════════════════ 真实条款（缓存逐字：text / coreTerms 均为模型原始值） ═══════════════════

/** 材料要求（cache「7、本工程所使用的钢筋强度等级不应小于HPB300.HRB400。」） */
const CLAUSE_REBAR_GRADE = entry('7、本工程所使用的钢筋强度等级不应小于HPB300.HRB400。', ['HPB300', 'HRB400'], 'respond', '材料工艺与验收标准');

/** 材料工艺与验收标准（cache「7.4.1 钢筋:[-HPB300(270N/mm2), -HRB400(360N/mm2…」节选原文） */
const CLAUSE_REBAR_SPEC = entry(
  '7.4.1 钢筋:[-HPB300(270N/mm2), -HRB400(360N/mm2\n一～三级抗震等级的框架，所有楼梯的梯板、梯梁及梯柱采用带“E”编号的钢筋。\n钢筋的强度标准值应具有不小于95%的保证率。吊钩不得用冷拔钢筋。',
  ['HPB300', 'HRB400', '带E编号', '95%'],
  'respond',
  '材料工艺与验收标准',
);

/** 工程范围（cache「(一)、招标范围:…包括1厂房（建筑面积为 71807.64 平方米）、2门卫…」） */
const CLAUSE_SCOPE = entry(
  '(一)、招标范围:\n本工程为巢湖市光电新能源产业园项目-东区标准化厂房二标段项目,位于巢湖市居巢经开区义成路与南外环路交口北侧。建筑面积72062.84平方米。包括1厂房（建筑面积为 71807.64 平方米）、2门卫（建筑面积为 241.7平方米）、3门卫（建筑面积为 13.5平方米）以及厂区道路、景观绿化、围墙、电气、给排水等附属设施。',
  ['建筑面积72062.84平方米', '1厂房', '2门卫', '3门卫'],
  'respond',
  '工程范围',
);

/** 绿色施工（cache「关于建造要求：\n4 5.1.1 （1）绿色建筑等级要求：按设计图纸要求；」：空话值条款） */
const CLAUSE_GREEN_PLACEHOLDER = entry('关于建造要求：\n4 5.1.1 （1）绿色建筑等级要求：按设计图纸要求；', ['绿色建筑等级要求', '按设计图纸要求'], 'respond', '绿色施工');

/** 施工组织设计（cache「（6）施工组织措施的针对性、可行性；」：名目清单条款） */
const CLAUSE_EVALUATION_LABELS = entry('（6）施工组织措施的针对性、可行性；', ['施工组织措施的针对性', '可行性'], 'respond', '施工组织设计');

/** 技术文件编制（cache「（3）技术能力（如有）要求：须在技术文件“其他内容”」：名目之外含实词，不是名目清单） */
const CLAUSE_TECH_LABELS = entry('（3）技术能力（如有）要求：须在技术文件“其他内容”', ['技术能力', '其他内容'], 'respond', '技术文件编制');

/** 材料管理（cache「1、承包人在购置主要材料（如钢材等）和设备前必须书面报发包人确认…」） */
const CLAUSE_MAIN_MATERIAL = entry(
  '1、承包人在购置主要材料（如钢材等）和设备前必须书面报发包人确认，经发包人认可后方可采购，否则视为违约，发包人有权终止合同。',
  ['主要材料', '书面报发包人确认'],
  'respond',
  '材料管理',
);

/** 分包管理（cache「（6）为分包人提供标高、轴线、定位，隐蔽工程指引等。」） */
const CLAUSE_SUBCONTRACTOR = entry('（6）为分包人提供标高、轴线、定位，隐蔽工程指引等。', ['标高', '轴线', '定位', '隐蔽工程指引'], 'respond', '分包管理');

/** 材料工艺与验收标准（cache 雨水口/检查井条款，含 OCR 残片「0.0个坡百雨求井，带道理深0.b~0.9m」） */
const CLAUSE_ZERO_VALUE = entry(
  '井盖面上因具有地方标识和雨污标识。排水检查井应设防坠落网，承载能力大于100Kg。\n并满足《城镇检查井查安装管理技术规程》DB34T4289-2022的要求。\n执行道路雨水口采用砖雨水口设于有道牙处时采用380×680mm偏为式单算雨水口；无道牙处采用380×680mm平算式单算雨水口详见烷2015S209大样图，单个雨水口接出管采用DN200管，2个及2个以上雨水口接出管采用DN300管，\n0.0个坡百雨求井，带道理深0.b~0.9m',
  ['防坠落网', '承载能力大于100Kg', 'DB34T4289-2022', '380×680mm'],
  'respond',
  '材料工艺与验收标准',
);

/** 工期进度（cache「2.8计划工期：365日历天…」：comply 遵守类） */
const CLAUSE_SCHEDULE_COMPLY = entry('2.8计划工期：365日历天\n2.9招标范围：本次招标实施范围总建筑面积约7.2万平方米…', ['365日历天', '7.2万平方米', '71807.64平方米', '35.86米'], 'comply', '工期进度');

// ═══════════════════ 真实正文（assets/巢湖施工组织设计-doc-*，逐字） ═══════════════════

/** ea380252 正文写实段（材料牌号 + 单体编号 + 绿色建筑写实值） */
const DOC_EA_CHAPTER = [
  '## 第二章 工程概况',
  '本工程为巢湖市光电新能源产业园项目-东区标准化厂房二标段项目，总建筑面积72062.84平方米，包括1#厂房（建筑面积71807.64平方米）、2#门卫（建筑面积241.7平方米）、3#门卫（建筑面积13.5平方米）以及厂区道路、景观绿化、围墙、电气、给排水等附属设施。',
  '钢筋强度等级不应小于HPB300、HRB400，纵向受力钢筋采用带E编号的抗震钢筋，钢筋的强度标准值具有不小于95%的保证率。',
  '绿色建筑等级达到国标基本级，并按二星级标准预留提升条件。',
].join('\n');

beforeEach(() => {
  vi.resetAllMocks();
});

describe('C4 正向：真满足放行 / 真缺失照报（判据两个方向都不得走偏）', () => {
  it('材料牌号整词锚点：正文写出 HPB300、HRB400 → 已满足（不再拆成 HPB/300 碎片）', () => {
    const anchors = collectRequirementAnchors(CLAUSE_REBAR_GRADE);
    expect(anchors).toContain('HPB300');
    expect(anchors).toContain('HRB400');
    expect(anchors).not.toContain('HPB');
    expect(anchors).not.toContain('300');
    const gap = tenderRequirementResponseGaps([CLAUSE_REBAR_GRADE], DOC_EA_CHAPTER)[0]!;
    expect(gap.missing).toEqual([]);
    expect(gap.satisfied).toBe(true);
  });

  it('单体编号归一：正文写 1#厂房/2#门卫/3#门卫 → 已满足（修复前实机报「缺少 1厂房、2门卫、3门卫」）', () => {
    const gap = tenderRequirementResponseGaps([CLAUSE_SCOPE], DOC_EA_CHAPTER)[0]!;
    expect(gap.missing).toEqual([]);
    expect(gap.satisfied).toBe(true);
  });

  it('真缺失照报零命中 blocker（真条款「主要材料/书面报发包人确认」，正文两词皆 0 次）', async () => {
    const issues = await requirementAcceptanceIssues({ markdown: DOC_EA_CHAPTER, entries: [CLAUSE_MAIN_MATERIAL], semanticSimilarity: () => 0 });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe('blocker');
    expect(issues[0]?.message).toContain('零命中');
    expect(issues[0]?.message).toContain('主要材料');
  });

  it('部分响应定向缺口仍在：正文缺 2#/3#门卫 → 报部分响应且 missing 精确（经或选型判定非或选型）', async () => {
    vi.mocked(callDocumentLlmJson).mockResolvedValueOnce({ results: [{ index: 0, alternative: false }] });
    const markdown = ['## 第二章 工程概况', '本工程总建筑面积72062.84平方米，包括1#厂房及厂区道路、景观绿化等附属设施。'].join('\n');
    const issues = await requirementAcceptanceIssues({ markdown, entries: [CLAUSE_SCOPE], semanticSimilarity: () => 0 });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe('blocker');
    expect(issues[0]?.message).toContain('部分响应');
    expect(issues[0]?.message).toContain('缺少“2门卫、3门卫”'); // 1厂房 已命中，缺口只列真缺项
  });
});

describe('C4 反向：五类真实误报各自不得再报 blocker', () => {
  it('① 材料牌号条款不再产生碎片锚点（真 7.4.1 钢筋条款：HPB300/HRB400/带E编号/95%）', () => {
    const anchors = collectRequirementAnchors(CLAUSE_REBAR_SPEC);
    expect(anchors).toContain('HPB300');
    expect(anchors).toContain('HRB400');
    expect(anchors).not.toContain('HPB');
    expect(anchors).not.toContain('HRB');
    const gap = tenderRequirementResponseGaps([CLAUSE_REBAR_SPEC], DOC_EA_CHAPTER)[0]!;
    expect(gap.missing).toEqual([]);
    expect(gap.satisfied).toBe(true);
  });

  it('② 空话值条款（绿色建筑等级要求：按设计图纸要求）→ 无可用锚点 → 不产生 blocker', async () => {
    const anchors = collectRequirementAnchors(CLAUSE_GREEN_PLACEHOLDER);
    expect(anchors).toEqual([]); // 名目 + 空话都不可核验；正文写实值（基本级/二星级）无需回抄名目
    const issues = await requirementAcceptanceIssues({ markdown: DOC_EA_CHAPTER, entries: [CLAUSE_GREEN_PLACEHOLDER], semanticSimilarity: () => 0 });
    expect(issues.filter(issue => issue.severity === 'blocker')).toEqual([]);
  });

  it('③ 名目清单条款（施工组织措施的针对性、可行性）→ 锚点 ∅ → 不产生 blocker', async () => {
    expect(collectRequirementAnchors(CLAUSE_EVALUATION_LABELS)).toEqual([]);
    const issues = await requirementAcceptanceIssues({ markdown: DOC_EA_CHAPTER, entries: [CLAUSE_EVALUATION_LABELS], semanticSimilarity: () => 0 });
    expect(issues.filter(issue => issue.severity === 'blocker')).toEqual([]);
  });

  it('④ 零值数量参数（OCR 残片「0.0个」）不作锚点，非零参数（0.9m）照常作锚点', () => {
    const anchors = collectRequirementAnchors(CLAUSE_ZERO_VALUE);
    expect(anchors).not.toContain('0.0个');
    expect(anchors).toContain('0.9m');
    expect(anchors).toContain('防坠落网');
  });

  it('⑤ 真缺失的反向证据：隐蔽工程指引/白色热熔反光涂料标线 等真缺口仍判未满足（判据未被放宽）', () => {
    const reflections = entry('7.本工程机动车地面停车位皆采用划线停车位，划线采用白色热熔反光涂料标线，线宽150mm，车位标号采用冷漆喷涂标准阿拉伯数字.', ['白色热熔反光涂料标线', '线宽150mm', '冷漆喷涂'], 'respond', '材料工艺与验收标准');
    const gaps = tenderRequirementResponseGaps([CLAUSE_SUBCONTRACTOR, reflections], DOC_EA_CHAPTER);
    // 两份真实文档实测：隐蔽工程指引 0 次、白色热熔反光涂料标线 0 次 → 必须仍然判未满足
    expect(gaps[0]?.satisfied).toBe(false);
    expect(gaps[0]?.missing).toContain('隐蔽工程指引');
    expect(gaps[1]?.satisfied).toBe(false);
    expect(gaps[1]?.missing).toContain('白色热熔反光涂料标线');
  });
});

describe('C4 边界：判据阈值 ±1 与形态边界（不放水、不扩大）', () => {
  it('空话条款只要含可核验参数（二星级）→ 仍走 blocker 通道（零锚点降级不是空话豁免）', async () => {
    const withParam = entry('（1）绿色建筑等级要求：按设计图纸要求，达到国标二星级。', ['绿色建筑等级要求', '按设计图纸要求', '二星级'], 'respond', '绿色施工');
    // 值不是空话（含「二星级」参数）→ 名目词不作锚点的过滤不适用，条款照旧有可核验锚点
    expect(collectRequirementAnchors(withParam)).toContain('二星级');
    const issues = await requirementAcceptanceIssues({ markdown: '## 第七章 绿色施工\n本工程按设计图纸要求落实各项绿色施工措施。', entries: [withParam], semanticSimilarity: () => 0 });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe('blocker');
    expect(issues[0]?.message).toContain('零命中');
  });

  it('名目清单的形态边界：文本含名目之外的实词（「须在技术文件」）→ 不判清单 → 锚点仍为名目词', () => {
    // 该族残余（名目词锚点）不在判定层修复：口径收口在提取提示词（v10 coreTerms 规则），
    // 见 tenderRequirements.CLAUSE_JUDGE_PROMPT 与 TENDER_REQUIREMENTS_CACHE_VERSION 注释
    expect(collectRequirementAnchors(CLAUSE_TECH_LABELS)).toEqual(['技术能力', '其他内容']);
  });

  it('单体编号归一的边界：「1 厂房」（排版空格）仍命中；「1号厂房」不命中（变体通道不吞后缀差异）', () => {
    const spaced = tenderRequirementResponseGaps([CLAUSE_SCOPE], '本工程总建筑面积72062.84平方米，包括 1 厂房、2 门卫、3 门卫及附属设施。')[0]!;
    expect(spaced.missing).toEqual([]);
    const withSuffix = tenderRequirementResponseGaps([CLAUSE_SCOPE], '本工程总建筑面积72062.84平方米，包括1号厂房、2号门卫、3号门卫及附属设施。')[0]!;
    expect(withSuffix.satisfied).toBe(false);
    expect(withSuffix.missing).toContain('1厂房');
  });
});

describe('C4 不变：既有通道与既有豁免不得改变', () => {
  it('comply（遵守类）不做落位验收（真工期条款，数据一致性域核验）', async () => {
    const issues = await requirementAcceptanceIssues({ markdown: DOC_EA_CHAPTER, entries: [CLAUSE_SCHEDULE_COMPLY], semanticSimilarity: () => 0 });
    expect(issues).toEqual([]);
  });

  it('voice 抄写通道不变：条款原样抄写（承包人→我方）→ 已满足', () => {
    const markdown = '## 第二章 投标报价\n1、我方在购置主要材料（如钢材等）和设备前必须书面报发包人确认，经发包人认可后方可采购，否则视为违约，发包人有权终止合同。';
    expect(tenderRequirementResponseGaps([CLAUSE_MAIN_MATERIAL], markdown)[0]?.satisfied).toBe(true);
  });

  it('数字锚点既有守卫不变：「1.1项目」编号切片不产生锚点，「540个日历天」产生「540个」', () => {
    const anchors = collectRequirementAnchors({ text: '计划工期540个日历天，1.1项目名称：标准化厂房。', coreTerms: [] });
    expect(anchors).toContain('540个');
    expect(anchors).not.toContain('1.1项');
  });

  it('具名奖项通道不变：「确保黄山杯」剥离前导动词 → 锚点「黄山杯」，正文命中即满足', () => {
    const award = entry('本项目确保获得“黄山杯”。', ['黄山杯'], 'respond', '质量创优');
    expect(collectRequirementAnchors(award)).toContain('黄山杯');
    expect(tenderRequirementResponseGaps([award], '## 第五章 质量保证措施\n本工程确保获得黄山杯，周密策划创优工作。')[0]?.satisfied).toBe(true);
  });
});

describe('C4 零锚点条款的显性记录（零静默降级：降级必须可见）', () => {
  it('无可用锚点条款 → warning（非 blocker），报文说明不可核验原因并进建议项', async () => {
    const issues = await requirementAcceptanceIssues({ markdown: DOC_EA_CHAPTER, entries: [CLAUSE_GREEN_PLACEHOLDER, CLAUSE_EVALUATION_LABELS], semanticSimilarity: () => 0 });
    expect(issues).toHaveLength(2);
    for (const issue of issues) {
      expect(issue.severity).toBe('warning');
      expect(issue.level).toBe('warning');
      expect(issue.repairability).toBe('not_repair_needed');
      expect(issue.message).toContain('无法确定性核验');
      expect(issue.provenance?.detectorId).toBe('requirements-coverage');
    }
    expect(issues[0]?.message).toContain('绿色建筑等级要求');
  });
});
