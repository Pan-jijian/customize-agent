/**
 * scaleConsistency round-21 S6 单测：「建设规模」混合口径（占地+建筑）六层修复回归保护：
 * 1) factsModel.splitMixedScaleFacts 拆分混合事实（占地/建筑两口径互不污染）；
 * 2) qualityValidation 期望口径解析：混合口径取“建筑面积”数值，占地是独立口径不参与比对；
 * 3) 确定性修复器只改建筑面积口径数值、绝不误伤占地面积数值；
 * 4) factGovernance canonical project_scale 净化（只保留建筑面积段）；
 * 5) fieldExtractionPattern 规模字段长窗口（“，”不再截断混合口径值）；
 * 6) expectedScale 可解析校验 + resolveScaleExpectation 占地语境不回退首个数值（截断占地事实兜底）。
 * 历史缺陷：正文 9 处“总建筑面积 10970㎡”+修复器反向改错 18/16 处 28570.36→10970
 * （建设规模混合字段值“项目总占地面积约10970平方米，单体建筑面积28570.36平方米”中
 * 首个数值 10970 是占地面积，被修复器误当作建筑总量期望口径）。
 */
import { describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { buildFactsModel, detectFactConflicts, fieldExtractionPattern } from './factsModel';
import { buildCanonicalFactModel, detectNumericScopeConflicts } from './factGovernance';
import { applyDeterministicConsistencyFixesToMarkdown, crossChapterConsistencyIssues } from './qualityValidation';
import type { CanonicalFact, DocumentFact } from './types';

vi.mock('@customize-agent/knowledge', () => {
  class LocalTransformersEmbeddingProvider {}
  return { LocalTransformersEmbeddingProvider };
});

const MIXED_SCALE = '项目总占地面积约10970平方米，单体建筑面积28570.36平方米（其中地上24783.39平方米、地下3786.97平方米）';

/**
 * 阶段五语义扩围注入的确定性嵌入（GAP 语义 gate）：
 * 子项/专项口径词面（配套用房/占地面积/分项指标/暂列金额/人工费等）→ [1,0] 命中正例原型；
 * 总量口径词面（总建筑面积/建设规模/合同估算价等）→ [0,1] 命中负例原型（放行）；
 * 其余 → [0,0] 不触发语义扩围（词面确定性路径照旧）。
 */
const embedDocuments = async (texts: string[]) => texts.map(text => {
  const gapLike = /配套用房|附属用房|占地面积|绿化面积|分项指标|分项费用|暂列金额|人工费|材料费/u.test(text);
  const totalLike = /总建筑面积|建设规模|总体规模|总金额|合同估算价|投资估算/u.test(text);
  return [gapLike ? 1 : 0, totalLike ? 1 : 0];
});

function scaleFact(value: string): DocumentFact {
  return { key: '建设规模', fieldName: '建设规模', value, sourceFile: '招标文件.pdf', roleId: 'project_basic', confidence: 90 };
}

async function scaleIssues(markdown: string, model: Awaited<ReturnType<typeof buildFactsModel>>) {
  const issues = await crossChapterConsistencyIssues(markdown, model, undefined, undefined, embedDocuments);
  return issues.filter(issue => issue.message.includes('建设规模'));
}

describe('splitMixedScaleFacts（factsModel 写作侧拆分）', () => {
  it('混合口径事实拆成「总占地面积」「单体建筑面积」两条独立事实', async () => {
    const model = await buildFactsModel([scaleFact(MIXED_SCALE)]);
    const siteFact = model.project.find(fact => fact.key === '总占地面积');
    const buildFact = model.project.find(fact => fact.key === '单体建筑面积');
    expect(siteFact).toBeDefined();
    expect(siteFact?.value).toContain('10970');
    expect(siteFact?.value).not.toContain('建筑面积');
    expect(buildFact).toBeDefined();
    expect(buildFact?.value).toContain('28570.36');
    // 不再存在同含两口径数值的混合事实
    const mixed = model.project.filter(fact => fact.key === '建设规模' && /10970/u.test(fact.value) && /28570\.36/u.test(fact.value));
    expect(mixed).toHaveLength(0);
  });

  it('纯建筑面积口径事实不拆分', async () => {
    const model = await buildFactsModel([scaleFact('建设规模：总建筑面积28570.36平方米')]);
    expect(model.project.filter(fact => fact.key === '建设规模')).toHaveLength(1);
    expect(model.project.find(fact => fact.key === '总占地面积')).toBeUndefined();
  });
});

describe('crossChapterConsistencyIssues 期望口径解析（检测侧）', () => {
  it('混合口径资料：正文误写占地数值 10970 作建筑面积 → 报冲突', async () => {
    const model = await buildFactsModel([scaleFact(MIXED_SCALE)]);
    const issues = await scaleIssues('本项目总建筑面积 10970㎡，单体建筑面积 10970 平方米。', model);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].message).toContain('10970');
    expect(issues[0].suggestion).toContain('28570.36');
  });

  it('混合口径资料：正文用建筑总量 28570.36 → 零冲突', async () => {
    const model = await buildFactsModel([scaleFact(MIXED_SCALE)]);
    expect(await scaleIssues('本项目总建筑面积28570.36㎡。', model)).toHaveLength(0);
  });

  it('占地面积是独立口径：正文同时写占地 10970 与建筑面积 28570.36 → 零误报', async () => {
    const model = await buildFactsModel([scaleFact(MIXED_SCALE)]);
    expect(await scaleIssues('本项目总占地面积约10970平方米，总建筑面积28570.36㎡。', model)).toHaveLength(0);
  });

  it('纯建筑面积口径资料：保持首个匹配语义，10970 误写仍报冲突', async () => {
    const model = await buildFactsModel([scaleFact('建设规模：总建筑面积28570.36平方米')]);
    const issues = await scaleIssues('本项目总建筑面积 10970㎡。', model);
    expect(issues).toHaveLength(1);
    expect(issues[0].suggestion).toContain('28570.36');
  });
});

describe('applyDeterministicConsistencyFixesToMarkdown（修复侧）', () => {
  it('正文败选数值 10970 → 确定性修复为 28570.36（单位保留原样）', async () => {
    const model = await buildFactsModel([scaleFact(MIXED_SCALE)]);
    const fixed = await applyDeterministicConsistencyFixesToMarkdown('本项目总建筑面积 10970㎡，单体建筑面积 10970 平方米。', model, undefined, embedDocuments);
    expect(fixed.fixedCount).toBeGreaterThanOrEqual(2);
    expect(fixed.markdown).not.toContain('10970');
    expect(fixed.markdown).toContain('28570.36');
  });

  it('占地数值是独立口径：修复器不得把 10970 占地面积改成建筑面积值', async () => {
    const model = await buildFactsModel([scaleFact(MIXED_SCALE)]);
    const fixed = await applyDeterministicConsistencyFixesToMarkdown('本项目总占地面积约10970平方米，总建筑面积28570.36㎡。', model, undefined, embedDocuments);
    expect(fixed.fixedCount).toBe(0);
    expect(fixed.markdown).toContain('10970');
  });

  it('正文已用正确建筑总量：零修复', async () => {
    const model = await buildFactsModel([scaleFact(MIXED_SCALE)]);
    const fixed = await applyDeterministicConsistencyFixesToMarkdown('本项目总建筑面积28570.36㎡。', model, undefined, embedDocuments);
    expect(fixed.fixedCount).toBe(0);
  });
});

describe('buildCanonicalFactModel project_scale 净化（canonical 侧）', () => {
  it('混合口径 scale 只保留建筑面积段，占地数值不进 scale', () => {
    const canonical = buildCanonicalFactModel({
      facts: [scaleFact(MIXED_SCALE)],
      projectRoot: path.join(os.tmpdir(), `scale-canonical-test-${Date.now()}`),
      requirement: '合肥师范附属小学综合楼施工组织设计',
      templateId: 'tpl-scale-test',
    });
    expect(canonical.projectScope.scale).toBeDefined();
    const scale = canonical.projectScope.scale as CanonicalFact;
    expect(Array.isArray(scale)).toBe(false);
    expect(scale.value).toContain('28570.36');
    expect(scale.value).not.toContain('10970');
  });
});

describe('detectNumericScopeConflicts 异口径隔离（裁决池侧，round-21 S6）', () => {
  const mixedScaleFact = (sourceFile: string): DocumentFact => ({
    key: '建设规模',
    fieldId: 'project_scale',
    fieldName: '建设规模',
    value: MIXED_SCALE,
    sourceFile,
    roleId: 'project_basic',
    confidence: 90,
  });

  it('混合口径“建设规模”中的占地数值 10970 不得进入 area 裁决候选', () => {
    const conflicts = detectNumericScopeConflicts([
      mixedScaleFact('招标文件.pdf'),
      // 另一文件给出与建筑面积段不一致的建筑总量 → 若 10970 混入裁决池会被误判冲突/胜出
      { key: '建设规模', fieldId: 'project_scale', fieldName: '建设规模', value: '总建筑面积28570.36m2', sourceFile: '工程量清单.xls', roleId: 'project_basic', confidence: 90 },
      { key: '建设规模', fieldId: 'project_scale', fieldName: '建设规模', value: '总建筑面积28571平方米', sourceFile: '补疑.pdf', roleId: 'project_basic', confidence: 90 },
    ]);
    const area = conflicts.filter(conflict => conflict.kind === 'area');
    // 任何 area 冲突的候选值与裁决值都不得含占地数值 10970
    for (const conflict of area) {
      expect(conflict.values.map(value => value.value).join('、')).not.toContain('10970');
      if (conflict.resolution) expect(conflict.resolution).not.toContain('10970');
    }
  });

  it('占地数值只在“总占地”语境出现：不产生 area 冲突', () => {
    const conflicts = detectNumericScopeConflicts([
      mixedScaleFact('招标文件.pdf'),
      { key: '建设规模', fieldId: 'project_scale', fieldName: '建设规模', value: '总建筑面积28570.36m2', sourceFile: '工程量清单.xls', roleId: 'project_basic', confidence: 90 },
    ]);
    // 招标文件混合口径的建筑段 28570.36 与清单 28570.36 同值 → 无冲突；
    // 占地 10970 被异口径隔离，不得单独形成“建设规模 10970 vs 28570.36”的伪冲突
    const area = conflicts.filter(conflict => conflict.kind === 'area');
    for (const conflict of area) {
      expect(conflict.values.map(value => value.value).join('、')).not.toContain('10970');
      if (conflict.resolution) expect(conflict.resolution).not.toContain('10970');
    }
  });
});

describe('splitMixedScaleFacts fieldId 处置（canonical 串位防护）', () => {
  it('拆分后占地事实不再携带“建设规模”fieldId，建筑侧保留', async () => {
    const fact: DocumentFact = { key: '建设规模', fieldId: 'project_scale', fieldName: '建设规模', value: MIXED_SCALE, sourceFile: '招标文件.pdf', roleId: 'project_basic', confidence: 90 };
    const model = await buildFactsModel([fact]);
    const siteFact = model.project.find(item => item.key === '总占地面积');
    const buildFact = model.project.find(item => item.key === '单体建筑面积');
    expect(siteFact).toBeDefined();
    expect(siteFact?.fieldId).toBeUndefined();
    expect(buildFact?.fieldId).toBe('project_scale');
  });
});

describe('fieldExtractionPattern 规模字段长窗口（round-21 S6 截断根因）', () => {
  it('“建设规模”混合口径值不以“，”截断，保留建筑总量段', () => {
    // round-21 S6 实测：extractStructuredFacts 用“，”终止符把“建设规模：项目总占地面积约10970平方米，
    // 单体建筑面积28570.36平方米”截成纯占地口径“项目总占地面积约10970平方米”进入事实主表首位，
    // 确定性修复器以之为建筑总量期望口径反向改错正文 16 处
    const match = '建设规模：项目总占地面积约10970平方米，单体建筑面积28570.36平方米。本工程有装配式技术要求。'.match(fieldExtractionPattern('建设规模'));
    expect(match?.[1]).toContain('10970');
    expect(match?.[1]).toContain('28570.36');
  });

  it('非规模字段仍以“，”截断（避免长值污染其他字段）', () => {
    const match = '质量标准：合格，详见招标文件。'.match(fieldExtractionPattern('质量标准'));
    expect(match?.[1]).toBe('合格');
  });
});

describe('截断占地事实兜底（round-21 S6 第三轮真实数据复现）', () => {
  // 第三轮生成实测事实主表：截断版（fieldExtractionPattern 旧口径）排在混合版与图纸版之前，
  // expectedScale find 首个命中截断版 → resolveScaleExpectation 单条目返回 10970 → 反向改错
  const truncatedFacts = (): DocumentFact[] => [
    { key: '建设规模', fieldId: '建设规模', fieldName: '建设规模', value: '项目总占地面积约10970平方米', sourceFile: '招标文件.pdf', roleId: 'tender_document', confidence: 90 },
    { key: '建设规模', fieldId: 'project_scale', fieldName: '建设规模', value: '项目总占地面积约10970平方米，单体建筑面积28570.36平方', sourceFile: '招标文件.pdf', roleId: 'tender_document', confidence: 90 },
    { key: '建设规模', fieldId: 'project_scale', fieldName: '建设规模', value: '建筑面积 28570.36m2', sourceFile: '甲类公共建筑节能设计一览表表式.doc', roleId: 'drawing', confidence: 90 },
  ];

  it('首条截断占地事实不参与期望口径：正文正确 28570.36 零冲突', async () => {
    const model = await buildFactsModel(truncatedFacts());
    expect(await scaleIssues('本项目总建筑面积28570.36㎡。', model)).toHaveLength(0);
  });

  it('修复器不得把正文 28570.36 反向改成 10970', async () => {
    const model = await buildFactsModel(truncatedFacts());
    const fixed = await applyDeterministicConsistencyFixesToMarkdown('本项目总建筑面积28570.36㎡，地上建筑面积24783.39㎡。', model, undefined, embedDocuments);
    expect(fixed.fixedCount).toBe(0);
    expect(fixed.markdown).toContain('28570.36');
    expect(fixed.markdown).not.toContain('10970');
  });

  it('正文误写 10970 时以图纸版建筑总量兜底修复为 28570.36', async () => {
    const model = await buildFactsModel(truncatedFacts());
    const fixed = await applyDeterministicConsistencyFixesToMarkdown('本项目总建筑面积 10970㎡。', model, undefined, embedDocuments);
    expect(fixed.fixedCount).toBeGreaterThanOrEqual(1);
    expect(fixed.markdown).not.toContain('10970');
    expect(fixed.markdown).toContain('28570.36');
  });

  it('仅截断占地事实且无建筑口径条目：不确定期望口径，零比对零修复', async () => {
    const model = await buildFactsModel([{ key: '建设规模', fieldId: '建设规模', fieldName: '建设规模', value: '项目总占地面积约10970平方米', sourceFile: '招标文件.pdf', roleId: 'tender_document', confidence: 90 }]);
    expect(await scaleIssues('本项目总建筑面积28570.36㎡。', model)).toHaveLength(0);
    const fixed = await applyDeterministicConsistencyFixesToMarkdown('本项目总建筑面积28570.36㎡。', model, undefined, embedDocuments);
    expect(fixed.fixedCount).toBe(0);
  });
});

describe('阶段五语义扩围：GAP 词面未命中由语义 gate 承接（检测与修复双侧同口径）', () => {
  // 「配套用房」不在 SCALE_GAP_WORDS_RE 词表（词表含附属/辅助/办公等，不含配套）——
  // 旧实现会误把配套用房 240 与建筑总量 28570.36 混比（误报冲突/反向改错）；
  // 语义扩围后「配套用房…建筑面积」上下文由 gate 判定为子项口径 → skip 比对与修复
  it('检测侧：配套用房建筑面积 240 语义判定为子项口径，不与建筑总量混比', async () => {
    const model = await buildFactsModel([scaleFact(MIXED_SCALE)]);
    const issues = await scaleIssues('本项目配套用房建筑面积240㎡，总建筑面积28570.36㎡。', model);
    expect(issues).toHaveLength(0);
  });

  it('修复侧：修复器不得把配套用房 240 语义跳过数值改成建筑总量', async () => {
    const model = await buildFactsModel([scaleFact(MIXED_SCALE)]);
    const fixed = await applyDeterministicConsistencyFixesToMarkdown('本项目配套用房建筑面积240㎡，总建筑面积28570.36㎡。', model, undefined, embedDocuments);
    expect(fixed.fixedCount).toBe(0);
    expect(fixed.markdown).toContain('240');
  });

  it('总量口径上下文语义判定为负例：败选数值仍正常报冲突（零误放）', async () => {
    const model = await buildFactsModel([scaleFact(MIXED_SCALE)]);
    const issues = await scaleIssues('本项目总建筑面积 10970㎡。', model);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].message).toContain('10970');
  });
});

describe('scopeReForKind(area) 子项口径隔离（裁决池侧）', () => {
  it('地上/地下建筑面积分层数值不得混入 area 裁决组', () => {
    const conflicts = detectNumericScopeConflicts([
      { key: '建设规模', fieldId: 'project_scale', fieldName: '建设规模', value: MIXED_SCALE, sourceFile: '招标文件.pdf', roleId: 'project_basic', confidence: 90 },
      { key: '建设规模', fieldId: 'project_scale', fieldName: '建设规模', value: '总建筑面积28570平方米', sourceFile: '补疑.pdf', roleId: 'project_basic', confidence: 90 },
    ]);
    const area = conflicts.filter(conflict => conflict.kind === 'area');
    for (const conflict of area) {
      expect(conflict.values.map(value => value.value).join('、')).not.toContain('24783.39');
      expect(conflict.values.map(value => value.value).join('、')).not.toContain('3786.97');
    }
  });
});

describe('detectFactConflicts 程序性语义复核（h5 事实候选过滤）', () => {
  // 单测注入嵌入实现：以「评标委员会」为程序性特征——原型与程序性候选共享该特征时余弦 1（生产环境为 bge 真实嵌入）
  const proceduralEmbedDocuments = (texts: string[]) => Promise.resolve(texts.map(text => [text.includes('评标委员会') ? 1 : 0]));

  it('程序性短语（评标办法/评标委员会信息）经 bge 语义复核过滤，不产生伪冲突', async () => {
    const conflicts = await detectFactConflicts(
      [
        { key: '质量标准', fieldName: '质量标准', value: '评标办法：综合评估法，评标委员会 5 人组成', sourceFile: '招标文件.pdf', roleId: 'tender_document', confidence: 90 },
        { key: '质量标准', fieldName: '质量标准', value: '评标办法：经评审最低价法，评标委员会 7 人组成', sourceFile: '补疑.pdf', roleId: 'tender_document', confidence: 90 },
      ],
      undefined,
      undefined,
      proceduralEmbedDocuments,
    );
    expect(conflicts).toHaveLength(0);
  });

  it('实质条款值不触发程序性过滤：不同来源值仍报冲突（零误伤回归）', async () => {
    const conflicts = await detectFactConflicts(
      [
        { key: '绿色建筑等级', fieldName: '绿色建筑等级', value: '绿色建筑等级：二星级', sourceFile: '招标文件.pdf', roleId: 'tender_document', confidence: 90 },
        { key: '绿色建筑等级', fieldName: '绿色建筑等级', value: '绿色建筑等级：一星级', sourceFile: '图纸.pdf', roleId: 'tender_document', confidence: 90 },
      ],
      undefined,
      undefined,
      proceduralEmbedDocuments,
    );
    expect(conflicts.length).toBeGreaterThan(0);
    expect(conflicts[0]).toContain('绿色建筑等级');
  });
});
