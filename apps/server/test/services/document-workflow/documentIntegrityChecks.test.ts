/**
 * documentIntegrityChecks W2/P1 改造单测：
 * 六个百分百与本地适配三项的纯语义判定——本地 bge 恒可用（本地 ONNX 推理），判定语义全权由 bge 负责，
 * 无不可用降级路径。语义通道全部 mock（避免测试加载 Transformers.js 重依赖）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { missingPlannedSections, promotePlannedSectionHeadings } from '@/services/document-workflow/chapterPostProcessing';
import { blueprintValuePlacementIssues, danglingConjunctionIssues, hazardParameterBindingIssues, hollowTableCellIssues, scheduleDurationOverrunIssues } from '@/services/document-workflow/qualityValidation';
import { resolveEffectiveTotalDays } from '@/services/document-workflow/integratedBlueprint';
import { cleanInlineFactValue } from '@/services/document-workflow/helpers/projectBasicInfo';
import { ambiguousEitherOrIssues, scanSpecLocationMismatchHits, applyNumericConsistencyDeterministicFixes, basicInfoScheduleFieldIssues, bidderQualificationSectionIssues, bodySentencesForSemantic, crossSectionNumericConflictIssues, duplicateParagraphIssues, duplicateTableIssues, excavationDepthLockIssues, invertedDateRangeIssues, paragraphTailRepeatIssues, scanParagraphTailRepeats, collisionNumberedHeadingIssues, extractAssemblyRateAuthority, extractGreeningMaintenanceAuthority, extractProjectScaleSummary, extractScheduleAuthority, extractStreetLightAuthority, fabricatedAwardIssues, fixAdjacentPhraseDuplication, fixInvertedDateRanges, fixZeroLengthDayRanges, fixParagraphOpeningRepeats, fixParagraphTailRepeats, fixCollisionNumberedHeadings, fixEmbeddedHeadingLines, fixPlaceholderTableCells, fixTruncatedSentenceArtifacts, foundationFormResidueIssues, greeningMaintenanceMismatchIssues, localAdaptationKeywordIssues, nodeScheduleConsistencyIssues, resourceConsistencyIssues, resourceTriadSectionHierarchyIssues, selfUnderminingCandidateIssues, sixHundredPercentCoverageIssues, specLocationMismatchIssues, streetLightCountMismatchIssues, stripDuplicateParagraphs, stripDuplicateTables, fixQuantityAuthorityConflicts } from '@/services/document-workflow/documentIntegrityChecks';
import { markdownTableQualityIssues } from '@/services/document-workflow/qualityValidation';
import { normalizeTableTitleInHeaders, repairTableBlockLines } from '@/services/document-workflow/tableRepairHelpers';
import { scanStructureDefects } from '@/services/document-workflow/structureIntegrityRules';
import { splitMarkdownTableLine, stripTableCellInvisibleChars } from '@/services/document-workflow/helpers/markdownCleanup';
import type { DocumentFactsModel, SpecAuthorityMap, TenderRequirementModel } from '@/services/document-workflow/types';
import type { QuantityConflictAnchor } from '@/services/document-workflow/integratedBlueprint';
import { fixtureIndex } from './authorityFixture';

vi.mock('@/services/document-workflow/semanticSimilarity', () => ({ buildSemanticSimilarity: vi.fn(), SEMANTIC_COVERAGE_THRESHOLD: 0.6 }));

import { buildSemanticSimilarity } from '@/services/document-workflow/semanticSimilarity';

const buildSimilarityMock = vi.mocked(buildSemanticSimilarity);

type SimilarityFn = (left: string, right: string) => number;

function mockSimilarity(score: number): void {
  buildSimilarityMock.mockResolvedValue((() => score) as SimilarityFn);
}

/** 六项全部覆盖的正文（每项语义 query 与正文句高度同义） */
const FULL_SIX = [
  '施工工地周边设置围挡封闭管理，实现工地周边100%围挡。',
  '物料堆放覆盖防尘，实现物料堆放100%覆盖。',
  '出入车辆冲洗设施清洗出场，实现出入车辆100%冲洗。',
  '施工现场场地地面硬化，实现施工现场地面100%硬化。',
  '湿法作业洒水降尘，实现拆迁工地100%湿法作业。',
  '渣土车辆密闭运输防止遗撒，实现渣土车辆100%密闭运输。',
].join('\n');

describe('sixHundredPercentCoverageIssues（W2 纯语义判定）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('六项覆盖 → 无缺陷', async () => {
    mockSimilarity(0.85);
    const issues = await sixHundredPercentCoverageIssues(`环保措施\n${FULL_SIX}`);
    expect(issues).toEqual([]);
  });

  it('缺项 → 报缺陷', async () => {
    mockSimilarity(0.1);
    const issues = await sixHundredPercentCoverageIssues('环保措施\n施工现场加强环保管理。');
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('扬尘治理六个百分百');
  });

  it('后部扬尘句被均匀采样跳过时也不漏判（4.19.3 真实回归：6.2.2 小节「物料堆放100%覆盖」5/6 误报）', async () => {
    // 按 query/候选句内容成对返回相似度：同主题对高、异主题对低（模拟真实 bge 语义区分）
    buildSimilarityMock.mockResolvedValue(((left: string, right: string) => {
      for (const word of ['围挡', '物料堆放', '冲洗', '硬化', '湿法', '密闭']) {
        if (left.includes(word) && right.includes(word)) return 0.85;
      }
      return 0.1;
    }) as SimilarityFn);
    // 450 句无关内容 + 六项句：总句数 456 → 均匀采样 stride=2 跳过奇数 index（物料句在末位 455 被跳过，修复前必报缺失）
    const filler = Array.from({ length: 450 }, (_, index) => `第${index + 1}项安全管理制度要求作业人员持证上岗并完成三级安全教育。`).join('\n');
    const markdown = `环保措施\n${filler}\n施工工地周边设置围挡封闭管理，实现工地周边100%围挡。\n出入车辆冲洗设施清洗出场，实现出入车辆100%冲洗。\n施工现场场地地面硬化，实现施工现场地面100%硬化。\n湿法作业洒水降尘，实现拆迁工地100%湿法作业。\n渣土车辆密闭运输防止遗撒，实现渣土车辆100%密闭运输。\n物料堆放覆盖防尘，实现物料堆放100%覆盖。`;
    const issues = await sixHundredPercentCoverageIssues(markdown);
    expect(issues).toEqual([]);
  });

  it('非施组类文档（无扬尘内容）→ 不检测', async () => {
    mockSimilarity(0.1);
    const issues = await sixHundredPercentCoverageIssues('本项目为办公室装饰工程。');
    expect(issues).toEqual([]);
    expect(buildSimilarityMock).not.toHaveBeenCalled();
  });

  it('D2 拆迁工地豁免：正文显式说明无拆迁工程时不判该项缺失', async () => {
    mockSimilarity(0.1);
    const issues = await sixHundredPercentCoverageIssues('环保措施\n本项目无拆迁工程，不涉及拆迁工地湿法作业。');
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('缺少【');
    expect(issues[0].message).not.toContain('拆迁工地100%湿法作业');
  });

  it('D2 拆迁工地豁免：未说明无拆迁时该项照常判缺失', async () => {
    mockSimilarity(0.1);
    const issues = await sixHundredPercentCoverageIssues('环保措施\n施工现场加强环保管理。');
    expect(issues[0].message).toContain('拆迁工地100%湿法作业');
  });

  it('D2 豁免主语限定：无主语短语「临时设施不涉及拆迁」不得豁免拆迁项', async () => {
    // 任意语境出现「不涉及拆迁」不代表项目整体无拆迁工程——误豁免会漏拦截拆迁项缺失
    mockSimilarity(0.1);
    const issues = await sixHundredPercentCoverageIssues('环保措施\n施工场地狭小，临时设施布置不涉及拆迁补偿。');
    expect(issues[0].message).toContain('拆迁工地100%湿法作业');
  });

  it('D2 豁免主语变体：本工程短距否定「无房屋拆除」同样豁免', async () => {
    mockSimilarity(0.1);
    const issues = await sixHundredPercentCoverageIssues('环保措施\n本工程为新建工程，建设范围内无房屋拆除。');
    expect(issues.length).toBe(1);
    expect(issues[0].message).not.toContain('拆迁工地100%湿法作业');
  });

  it('D2 豁免主语变体：该工程/本标段等主语集均豁免', async () => {
    mockSimilarity(0.1);
    for (const body of ['该工程为新建工程，无拆迁内容。', '本标段建设范围内不涉及拆迁。', '本施工项目无拆迁工程。']) {
      const issues = await sixHundredPercentCoverageIssues(`环保措施\n${body}`);
      expect(issues[0].message).not.toContain('拆迁工地100%湿法作业');
    }
  });

  it('D2 豁免窗口限定：主语与否定词间隔超过 30 字不得豁免', async () => {
    // 主语短距窗口 30 字：否定词超出窗口即视为非本项目整体豁免声明，不得漏拦截
    mockSimilarity(0.1);
    const body = '本项目位于合肥市瑶海区龙岗路与大众路交口，周边现状复杂场地狭小，施工组织需充分考虑周边环境协调与扬尘控制，不涉及拆迁。';
    const issues = await sixHundredPercentCoverageIssues(`环保措施\n${body}`);
    expect(issues[0].message).toContain('拆迁工地100%湿法作业');
  });

  it('D2 豁免断句边界：否定词与主语在同一句内（句号前）→ 豁免成立', async () => {
    mockSimilarity(0.1);
    const issues = await sixHundredPercentCoverageIssues('环保措施\n本项目不涉及拆迁。');
    expect(issues[0].message).not.toContain('拆迁工地100%湿法作业');
  });

  it('D1 口径收窄：土方开挖湿法作业句不再命中拆迁工地项', async () => {
    // 只有拆迁工地 query 与含拆迁工地语义的正文句配对才命中；泛化「土方湿法作业」句不得掩盖拆迁项缺失
    buildSimilarityMock.mockResolvedValue(((left: string, right: string) => (left.includes('拆迁工地') && right.includes('拆迁工地') ? 0.85 : 0.1)) as SimilarityFn);
    const markdown = [
      '环保措施',
      '施工工地周边设置围挡封闭管理。',
      '物料堆放覆盖防尘。',
      '出入车辆冲洗设施清洗出场。',
      '施工现场场地地面硬化。',
      '土方开挖湿法作业洒水降尘。',
      '渣土车辆密闭运输防止遗撒。',
    ].join('\n');
    const issues = await sixHundredPercentCoverageIssues(markdown);
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('拆迁工地100%湿法作业');
  });
});

describe('selfUnderminingCandidateIssues（R9 正向句豁免扩围）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('分项验收归档正向句不进自伤候选（语义恒高也不召回）', async () => {
    // 语义通道恒高分：所有句都与自伤原型相似 → 豁免正则必须拦截，否则误报
    mockSimilarity(0.9);
    const markdown = '景观工程各分项完成后由技术负责人组织分项验收，验收记录经监理工程师签字确认后归档，作为竣工移交依据。';
    const issues = await selfUnderminingCandidateIssues(markdown);
    expect(issues).toEqual([]);
  });

  it('R9 分包否定式自述句（无豁免词面）仍被召回归入候选', async () => {
    mockSimilarity(0.9);
    const markdown = '本招标项目不允许分包。本工程不进行分包，全部施工内容由我方自行组织完成。';
    const issues = await selfUnderminingCandidateIssues(markdown);
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('本工程不进行分包');
  });

  it('r16c 准入校验句豁免：「复审未完成前不得继续上岗」人员证书管控句不进自伤候选', async () => {
    // 「未完成→不得→上岗」是持证上岗前置条件校验（r16c 丰乐镇 B2 误报归因），非投标短板自述
    mockSimilarity(0.9);
    const markdown = '安全员在证书到期前30日提醒作业人员办理复审，复审未完成前不得继续上岗。';
    const issues = await selfUnderminingCandidateIssues(markdown);
    expect(issues).toEqual([]);
  });

  it('r16c 真伤护栏：无准入结构的事实自述句照常召回', async () => {
    mockSimilarity(0.9);
    const markdown = '专项设计文件尚未完成，待后续补充。';
    const issues = await selfUnderminingCandidateIssues(markdown);
    expect(issues.length).toBe(1);
  });
});

describe('localAdaptationKeywordIssues（W2 纯语义判定）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const hefeiFacts = { project: [{ fieldName: '建设地点', key: '建设地点', value: '合肥市瑶海区' }] } as unknown as DocumentFactsModel;

  it('合肥项目且创优目标/绿色量化/工伤保险均覆盖 → 无缺陷', async () => {
    mockSimilarity(0.85);
    const markdown = '质量目标：争创市级优质工程奖、安全文明标准化工地。绿色施工：非传统水源利用率、废弃物回收率等绿色施工量化指标明确。劳务管理：按规定为作业人员办理工伤保险。';
    const issues = await localAdaptationKeywordIssues(markdown, hefeiFacts);
    expect(issues).toEqual([]);
  });

  it('合肥项目缺创优目标 → 报缺陷', async () => {
    mockSimilarity(0.1);
    const issues = await localAdaptationKeywordIssues('质量目标：确保工程合格。', hefeiFacts);
    expect(issues.some(issue => /属地创优目标缺失/u.test(issue.message))).toBe(true);
  });
});

describe('resourceConsistencyIssues（h7 劳动力数据一致性 5 模式）', () => {
  const laborTable = (rows: string[]) => ['| 施工阶段 | 阶段高峰人数 |', '| --- | --- |', ...rows].join('\n');

  it('模式 1：正文两处高峰值相差 >30% → 报互斥', () => {
    // 两个峰值均无阶段限定（同总口径）：150 vs 80 相差 46.7% 互斥。
    //（若一个带阶段限定则走「总口径 ≥ 阶段峰值属正常关系」豁免，见下条总口径用例）
    const issues = resourceConsistencyIssues('施工高峰期投入150人组织流水作业。施工高峰期约80人连续施工。');
    expect(issues.some(issue => /劳动力数据矛盾/u.test(issue.message) && /互斥/u.test(issue.message))).toBe(true);
  });

  it('模式 1：正文峰值相近 → 不报', () => {
    expect(resourceConsistencyIssues('施工高峰期投入150人组织流水作业。主体结构施工高峰期约140人连续施工。')).toEqual([]);
  });

  it('模式 1：不同施工阶段的峰值不互斥（地下结构 220 vs 室外工程 90，真实生成误报回归）', () => {
    const markdown = '地下结构阶段投入钢筋工60人、木工80人、混凝土工40人、架子工20人，高峰人数约220人；室外工程阶段投入铺装工30人、绿化工20人、管网工25人，高峰人数约90人。各阶段劳动力峰值表述统一为：地下结构阶段220人、室外工程阶段90人。';
    expect(resourceConsistencyIssues(markdown)).toEqual([]);
  });

  it('模式 1：总口径人数 ≥ 阶段峰值属正常关系（总配置 180 vs 室外工程 90）→ 不报', () => {
    const markdown = '劳动力保障方面，按施工高峰配置总人数约180人。室外工程阶段投入铺装工30人、管网工25人，高峰人数约90人。';
    expect(resourceConsistencyIssues(markdown)).toEqual([]);
  });

  it('模式 1：总口径人数低于阶段峰值 10% 以上 → 报互斥', () => {
    const markdown = '按施工高峰配置总人数约90人。主体结构阶段投入钢筋工60人、木工80人，高峰人数约220人。';
    const issues = resourceConsistencyIssues(markdown);
    expect(issues.some(issue => /劳动力数据矛盾/u.test(issue.message) && /互斥/u.test(issue.message))).toBe(true);
  });

  it('模式 2：两张劳动力表峰值相差 >30% → 报互斥', () => {
    // 表格块间以空行分隔（Markdown 表格语义：无空行会被聚合为同一表格块）
    const markdown = [laborTable(['| 基础阶段 | 120 |', '| 主体阶段 | 80 |']), laborTable(['| 装修阶段 | 300 |'])].join('\n\n');
    const issues = resourceConsistencyIssues(markdown);
    expect(issues.some(issue => /劳动力数据矛盾/u.test(issue.message) && /另一劳动力表峰值/u.test(issue.message))).toBe(true);
  });

  it('模式 2：分工种人数明细表（无高峰列）与阶段峰值表不互查（60 vs 230 真实生成误报回归）', () => {
    const byTradeTable = ['| 施工阶段 | 工种 | 人数 | 主要工作内容 |', '| --- | --- | --- | --- |', '| 主体结构 | 钢筋工、木工 | 60 | 现浇结构 |'].join('\n');
    const markdown = [byTradeTable, laborTable(['| 主体结构 | 230 |'])].join('\n\n');
    expect(resourceConsistencyIssues(markdown)).toEqual([]);
  });

  it('高峰列优先：平均/高峰人数并存时表峰值取高峰列（不取平均列 120 误报正文 230）', () => {
    const avgPeakTable = ['| 施工阶段 | 阶段平均人数 | 阶段高峰人数 |', '| --- | --- | --- |', '| 主体结构 | 120 | 230 |'].join('\n');
    const markdown = `${avgPeakTable}\n\n主体结构阶段高峰人数约230人。`;
    expect(resourceConsistencyIssues(markdown)).toEqual([]);
  });

  it('模式 3：正文峰值显著超过表峰值 → 报（保留原口径）', () => {
    const markdown = [laborTable(['| 基础阶段 | 100 |', '| 主体阶段 | 120 |']), '施工高峰期投入300人组织流水作业。'].join('\n');
    const issues = resourceConsistencyIssues(markdown);
    expect(issues.some(issue => /超出/u.test(issue.message))).toBe(true);
  });

  it('模式 4：合计行与明细行之和差 >10% → 报不符', () => {
    const markdown = laborTable(['| 基础阶段 | 50 |', '| 主体阶段 | 80 |', '| 合计 | 200 |']);
    const issues = resourceConsistencyIssues(markdown);
    expect(issues.some(issue => /合计行 200 人与明细行之和 130 人/u.test(issue.message))).toBe(true);
  });

  it('模式 4：合计与明细一致 → 不报', () => {
    const markdown = laborTable(['| 基础阶段 | 50 |', '| 主体阶段 | 80 |', '| 合计 | 130 |']);
    expect(resourceConsistencyIssues(markdown)).toEqual([]);
  });

  it('模式 5：总工日超过峰值×工期算术上限 → 报', () => {
    const markdown = '本工程总工期540日历天，施工高峰期投入120人。总用工量约90000个工日。';
    const issues = resourceConsistencyIssues(markdown);
    expect(issues.some(issue => /总工日/u.test(issue.message) && /算术上限/u.test(issue.message))).toBe(true);
  });

  it('模式 5：总工日量级自洽 → 不报', () => {
    const markdown = '本工程总工期540日历天，施工高峰期投入120人。总用工量约30000个工日。';
    expect(resourceConsistencyIssues(markdown)).toEqual([]);
  });

  it('模式 6：控制上限 260 与阶段高峰 300/350 并存 → 报不自洽（真实生成回归：峰值差值 <30% 仍须拦截）', () => {
    const markdown = '施工高峰期总人数控制在260人。基础及地下室施工阶段高峰投入约220人；主体结构及装配式施工阶段高峰投入约300人；装饰装修及机电安装阶段高峰投入约350人。';
    const issues = resourceConsistencyIssues(markdown);
    expect(issues.some(issue => /劳动力数据矛盾/u.test(issue.message) && /控制上限/u.test(issue.message))).toBe(true);
  });

  it('模式 6：控制上限高于全部峰值 → 不报', () => {
    const markdown = '施工高峰期总人数控制在400人。主体结构及装配式施工阶段高峰投入约300人；装饰装修及机电安装阶段高峰投入约350人。';
    expect(resourceConsistencyIssues(markdown)).toEqual([]);
  });

  it('岗位配置表（岗位+职责+持证）不视为劳动力表：与分阶段表并存不报假矛盾', () => {
    // 岗位定员（施工员3人）与劳动力峰值（95人）是两个口径，不得互查
    const staffTable = ['| 岗位 | 人数 | 主要职责 | 持证要求 |', '| --- | --- | --- | --- |', '| 项目经理 | 1 | 全面负责 | 建造师证 |', '| 施工员 | 3 | 工序组织 | 岗位证书 |'].join('\n');
    const markdown = [laborTable(['| 基础阶段 | 95 |', '| 主体阶段 | 80 |']), staffTable].join('\n\n');
    expect(resourceConsistencyIssues(markdown)).toEqual([]);
  });

  it('排除岗位表后两张真实劳动力表峰值矛盾仍报（检测能力不削弱）', () => {
    const markdown = [laborTable(['| 基础阶段 | 95 |']), laborTable(['| 装修阶段 | 26 |'])].join('\n\n');
    const issues = resourceConsistencyIssues(markdown);
    expect(issues.some(issue => /劳动力数据矛盾/u.test(issue.message) && /另一劳动力表峰值/u.test(issue.message))).toBe(true);
  });

  it('r16 丰乐镇 B1 跨顿号工种列举继承阶段词：「阶段+工种列举+合计N人」不假互斥（实况复刻）', () => {
    // 修复前：末顿号无条件截断使「污水管网工程阶段管道工、普工合计56人」阶段词被切掉，
    // 56 与 262 两阶段值解析为空阶段互判同口径（假矛盾 79%）；修复后含工种词的列举段
    // 不截断（与 laborPeakStageOf 条件截断同源），阶段词跨列举继承后各阶段隔离
    const markdown = '分阶段投入计划中，施工准备与清杂拆除阶段普工、绿化工合计137人，污水管网工程阶段管道工、普工合计56人，道路铺装工程阶段混凝土工、普工、瓦工合计262人，景观与绿化工程阶段绿化工、普工合计262人。';
    expect(resourceConsistencyIssues(markdown)).toEqual([]);
  });

  it('r16 B1 反例：纯「投入N人」列举段仍条件截断，总口径峰值不继承前段阶段（防误放行）', () => {
    // 「施工准备阶段投入22人，高峰期199人」的 199 是总口径峰值（前段无工种词不继承阶段），
    // 与另一处「高峰期95人」相差 >30% 仍判互斥（检测能力不削弱）
    const markdown = '施工准备阶段投入22人，高峰期199人组织流水作业。雨季施工高峰期95人。';
    const issues = resourceConsistencyIssues(markdown);
    expect(issues.some(issue => /劳动力数据矛盾/u.test(issue.message) && /互斥/u.test(issue.message))).toBe(true);
  });
});

describe('nodeScheduleConsistencyIssues（h13 节点工期口径互查）', () => {
  it('同节点两套口径（正序完成式 60 vs 表格式 75）→ 报互斥', () => {
    const markdown = '第60日完成基坑支护及土方外运。进度计划表：基坑支护及土方外运完成 | 开工后第75天。';
    const issues = nodeScheduleConsistencyIssues(markdown);
    expect(issues.some(issue => /节点工期口径矛盾/u.test(issue.message) && /60日 与 75日/u.test(issue.message))).toBe(true);
  });

  it('倒序锁定式与正序口径矛盾（封顶 300 vs 210）→ 报', () => {
    const markdown = '第300日完成主体结构封顶。主体封顶节点锁定在开工后第210日。';
    const issues = nodeScheduleConsistencyIssues(markdown);
    expect(issues.some(issue => /主体结构封顶/u.test(issue.message) && /300日 与 210日/u.test(issue.message))).toBe(true);
  });

  it('「开工后第N日」倒序式（绝对日）不因节点名后「后」排除被误杀', () => {
    const markdown = '主体封顶节点锁定在开工后第210日。第300日完成主体结构封顶。';
    const issues = nodeScheduleConsistencyIssues(markdown);
    expect(issues.some(issue => /主体结构封顶/u.test(issue.message) && /300日 与 210日/u.test(issue.message))).toBe(true);
  });

  it('「封顶后第10日」相对量句（节点名后紧跟「后」）不采为节点日期', () => {
    const markdown = '第300日完成主体结构封顶。主体结构封顶后第10日拆除模板。';
    expect(nodeScheduleConsistencyIssues(markdown)).toEqual([]);
  });

  it('设备表行「主体封顶 | 商品混凝土泵送 | 开工后第158日进场」不采为节点日期', () => {
    const markdown = '第300日完成主体结构封顶。主体封顶 | 商品混凝土泵送 | 开工后第158日进场。';
    expect(nodeScheduleConsistencyIssues(markdown)).toEqual([]);
  });

  it('准备阶段句（场地清表施工准备）不误采为节点', () => {
    const markdown = '第15日完成场地清表、临建搭设和基坑支护施工准备。第60日完成基坑支护及土方外运。';
    expect(nodeScheduleConsistencyIssues(markdown)).toEqual([]);
  });

  it('同节点两套口径相差 2 天 → 报（不同数值即矛盾）', () => {
    const markdown = '第60日完成主体结构封顶。进度计划表：主体结构封顶完成 | 开工后第62天。';
    expect(nodeScheduleConsistencyIssues(markdown)).toHaveLength(1);
  });
});

describe('crossSectionNumericConflictIssues（h13 跨节数值口径冲突）', () => {
  it('XPS 厚度 30mm vs 130mm（>20% 差异）→ 报数量矛盾', () => {
    const markdown = '挤塑聚苯乙烯泡沫塑料板（XPS）30mm。屋面采用130mm厚挤塑聚苯板。';
    const issues = crossSectionNumericConflictIssues(markdown);
    // 数值顺序不敏感：未标注部位值后注入部位组（Set 插入序在后）
    expect(issues.some(issue => /挤塑聚苯板/u.test(issue.message) && /30mm/u.test(issue.message) && /130mm/u.test(issue.message))).toBe(true);
  });

  it('垫层混凝土 C15 vs C20（标号类直接互斥）→ 报参数矛盾', () => {
    const markdown = '垫层混凝土采用C15。基础垫层采用C20混凝土浇筑。';
    const issues = crossSectionNumericConflictIssues(markdown);
    expect(issues.some(issue => /垫层混凝土强度等级/u.test(issue.message) && /C15C标号 与 C20C标号/u.test(issue.message))).toBe(true);
  });

  it('并列枚举（50mm/70mm 多规格）→ 豁免不报', () => {
    const markdown = '挤塑聚苯板（XPS）厚度50mm/70mm两种规格选用。';
    expect(crossSectionNumericConflictIssues(markdown)).toEqual([]);
  });

  // 巢湖实测：答疑澄清把计划工期由 365 改为 330，正文如实并列两值属唯一正解，非矛盾
  it('变更记录句（「365日历天，现变更修改为330日历天」）→ 豁免不报', () => {
    const markdown = '本工程计划工期365日历天，现变更修改为330日历天，总进度计划据此编排各阶段节点与资源投入。';
    expect(crossSectionNumericConflictIssues(markdown).filter(issue => /总工期|计划总工期/u.test(issue.message))).toEqual([]);
  });

  it('对照：无变更连接语的两套工期口径 → 仍报矛盾（豁免未过宽）', () => {
    const markdown = '本工程计划工期365日历天。本合同段总工期330日历天，按此组织施工。';
    expect(crossSectionNumericConflictIssues(markdown).some(issue => /365/u.test(issue.message) && /330/u.test(issue.message))).toBe(true);
  });

  it('r25 资源共享表块豁免：表块邻域声明共用调配时表内专项用途列数值不入互斥池（通用形态）', () => {
    const markdown = [
      '机械设备按分项共用调配，不再单独增配大型设备。', '',
      '**表4-1 机械设备配置**', '',
      '| 设备名称 | 规格 | 数量 | 用途 |',
      '| 挖掘机 | 按设计断面 | 5台 | 路床土方开挖、沟槽开挖 |', '',
      '**表4-2 管网设备**', '',
      '| 设备名称 | 规格 | 数量 | 用途 |',
      '| 挖掘机 | 0.6m³ | 1台 | 池体土方开挖、格栅井沟槽开挖 |',
    ].join('\n');
    expect(crossSectionNumericConflictIssues(markdown)).toEqual([]);
  });

  it('r25 共享语境豁免不越界：无共享声明的表块与正文行照常互斥检出', () => {
    const tableCase = [
      '**表4-1 机械设备配置**', '',
      '| 设备名称 | 规格 | 数量 | 用途 |',
      '| 挖掘机 | 按设计断面 | 5台 | 沟槽开挖 |', '',
      '沟槽作业另配挖掘机1台。',
    ].join('\n');
    expect(crossSectionNumericConflictIssues(tableCase).length).toBeGreaterThan(0);
    const proseCase = '沟槽开挖配置挖掘机5台。沟槽回填另配挖掘机1台。共用调配不再单独增配。';
    expect(crossSectionNumericConflictIssues(proseCase).length).toBeGreaterThan(0);
  });

  it('r28f B1 分对象配置表分池：两表挖掘机各归用途部位池不互比（r28e 实测误报收口）', () => {
    // r28e 实机阻断（表4-1 道路施工机械 vs 表4-2 生态池设备）：两表是分施工对象的配置口径——
    // 挖掘机「5台｜路槽开挖」与「1台｜生态池基坑开挖」因用途列部位词（路槽/基坑）不在部位词表
    // 同入未标注池误报互斥；补词后两行各归其位、各池单值不互比
    const markdown = [
      '表4-1 主要道路施工机械投入计划', '',
      '| 机械名称 | 规格型号 | 数量 | 用途 |',
      '| --- | --- | --- | --- |',
      '| 挖掘机 | 按设计选型 | 5台 | 路槽开挖、土方装运 |',
      '| 自卸汽车 | 按设计选型 | 5台 | 土方及碎石运输 |', '',
      '表4-2 生态池施工设备投入计划表', '',
      '| 设备名称 | 规格型号 | 数量 | 用途 |',
      '| --- | --- | --- | --- |',
      '| 挖掘机 | 按设计选型 | 1台 | 生态池基坑开挖 |',
    ].join('\n');
    expect(crossSectionNumericConflictIssues(markdown)).toEqual([]);
  });

  it('r28f B1 边界：用途列同部位词时两表数值仍互斥照报（分池不放松同部位口径检查）', () => {
    const markdown = [
      '表4-1 主要道路施工机械投入计划', '',
      '| 机械名称 | 规格型号 | 数量 | 用途 |',
      '| --- | --- | --- | --- |',
      '| 挖掘机 | 按设计选型 | 5台 | 路槽开挖 |', '',
      '表4-2 生态池施工设备投入计划表', '',
      '| 设备名称 | 规格型号 | 数量 | 用途 |',
      '| --- | --- | --- | --- |',
      '| 挖掘机 | 按设计选型 | 3台 | 路槽开挖、土方装运 |',
    ].join('\n');
    const issues = crossSectionNumericConflictIssues(markdown);
    expect(issues.some(issue => /挖掘机/u.test(issue.message) && /路槽/u.test(issue.message))).toBe(true);
  });

  it('同锚点相邻数值差异也报（无差异阈值豁免，十五版机械四套数字 5 vs 4 形态）', () => {
    const markdown = '潜水泵8台。现场配置潜水泵7台。';
    expect(crossSectionNumericConflictIssues(markdown).some(issue => /潜水泵/u.test(issue.message) && /8台/u.test(issue.message) && /7台/u.test(issue.message))).toBe(true);
  });

  it('枚举误采豁免：「施工电梯2台、汽车吊1台」不把 2 误采为汽车吊数量（真实生成误报回归）', () => {
    const markdown = '主体结构阶段配置塔吊1台、施工电梯2台、汽车吊1台用于装配式构件吊装。';
    expect(crossSectionNumericConflictIssues(markdown)).toEqual([]);
  });

  it('否定声明句豁免：不再出现“汽车吊2台”的引用值不计入口径池（真实生成误报回归）', () => {
    const markdown = '现场垂直运输设备统一配置1台汽车起重机。本章及后续章节不再出现“汽车吊2台”“1台8t汽车吊”等与施工部署不一致的数量表述。';
    expect(crossSectionNumericConflictIssues(markdown)).toEqual([]);
  });

  it('施工电梯与施工升降机异名同口径：2台 vs 1台 矛盾检出（真实生成漏检回归）', () => {
    const markdown = '主体结构阶段配置施工电梯2台。资源保障方面配置施工电梯1台。';
    const issues = crossSectionNumericConflictIssues(markdown);
    expect(issues.some(issue => /施工升降机/u.test(issue.message))).toBe(true);
  });

  it('反向模式型号字符形态仍检出：「4台SC200/200施工升降机」与「施工电梯2台」矛盾', () => {
    const markdown = '装饰装修阶段配置4台SC200/200施工升降机。主体结构阶段配置施工电梯2台。';
    const issues = crossSectionNumericConflictIssues(markdown);
    expect(issues.some(issue => /施工升降机/u.test(issue.message))).toBe(true);
  });

  it('4.17.2 总工期口径矛盾：「45日历天」与「210日历天」并存检出（庐江实测跨项目串染）', () => {
    const markdown = '工期控制以45日历天为唯一基准。关键节点按210日历天总工期倒排。';
    const issues = crossSectionNumericConflictIssues(markdown);
    expect(issues.some(issue => /计划总工期/u.test(issue.message) && /45日历天 与 210日历天/u.test(issue.message))).toBe(true);
  });

  it('4.17.2 工期顺延口径不入池：「顺延不超过30日历天」与总工期 210 并存不误报', () => {
    const markdown = '如遇不可抗力，工期相应顺延不超过30日历天。计划工期210日历天。';
    expect(crossSectionNumericConflictIssues(markdown)).toEqual([]);
  });

  it('r16c 管理程序时限豁免：「确保60日历天内完成响应闭环」与计划工期 90 日历天并存不互斥', () => {
    // 60日历天是合同管理程序时限（响应闭环期限），与计划总工期不同口径（r16c 丰乐镇 B1 误报归因）
    const markdown = '我方应在收到书面技术要求后组织编制实施方法，报发包人审核认可后交底执行，资料员同步归档审核记录，确保60日历天内完成响应闭环。计划工期90日历天。';
    expect(crossSectionNumericConflictIssues(markdown)).toEqual([]);
  });

  it('r16c 程序句不误伤：管理时限句并存两套真实工期，真实工期矛盾照常检出', () => {
    // 豁免仅作用于程序词所在句（响应闭环），90 与 210 两条真实工期照常互查互斥
    const markdown = '资料员同步归档审核记录，确保60日历天内完成响应闭环。计划工期90日历天。关键节点按210日历天总工期倒排。';
    const issues = crossSectionNumericConflictIssues(markdown);
    expect(issues.some(issue => /计划总工期/u.test(issue.message) && /90日历天 与 210日历天/u.test(issue.message))).toBe(true);
  });

  it('r28 扩围 增量配置豁免：「增配1具」不与他处 6具 误判互斥（r27b 实况复刻）', () => {
    // r27b 实机阻断：应急物资表「每作业面不少于2具干粉灭火器…生态池工区增配1具」（1具为基准外
    // 局部增补）与另处「灭火器 4kg 6具」同部位组报互斥——“不少于2具”由既有保障线下限豁免收口，
    // 剩“增配1具”入池；增配/增补/追加类增量动词前导的数值是相对既有配置的追加量非总量口径，不入池
    const markdown = [
      '| 灭火器 | 4kg | 6具 | 停放区 |',
      '| 灭火器 | 规格按消防器材配置标准选用，生态池工区增配1具 | 停放区 |',
    ].join('\n');
    expect(crossSectionNumericConflictIssues(markdown)).toEqual([]);
  });

  it('r28 增量豁免不越界：「增加至X具」类总数表述不含增量动词 → 真矛盾照报', () => {
    // “增加至10具”是配置总数的新口径宣称（不含增配/增补等增量动词）——与 6具 并存照常互斥
    const markdown = [
      '| 灭火器 | 4kg | 6具 | 停放区 |',
      '| 灭火器 | 后续增加至10具 | 停放区 |',
    ].join('\n');
    const issues = crossSectionNumericConflictIssues(markdown);
    expect(issues.some(issue => /灭火器/u.test(issue.message) && /6具/u.test(issue.message) && /10具/u.test(issue.message))).toBe(true);
  });

  it('4.17.2 项目编号矛盾：50062 与 50112 并存检出（庐江实测）', () => {
    const markdown = '项目编号 2026ANNGZ50062。本工程招标项目编号为2026ANNGZ50112。';
    const issues = crossSectionNumericConflictIssues(markdown);
    expect(issues.some(issue => /项目编号/u.test(issue.message) && /50062/u.test(issue.message) && /50112/u.test(issue.message))).toBe(true);
  });

  it('4.17.2 不邻接标签的编号不采：业绩项目编号不与本项目编号误比', () => {
    const markdown = '项目经理同类业绩项目2020ANNGZ11223已竣工验收。本项目编号为2026ANNGZ50112。';
    expect(crossSectionNumericConflictIssues(markdown)).toEqual([]);
  });

  it('4.17.3 外部权威裁决：45/210 两套体系各带表格时，factsModel 锁定工期 210 为准确定性替换权威（庐江实测修复节点 failed 根因）', () => {
    // 第四章 45 天体系（含 45 天进度表）+ 其他章 210 天体系（含 210 天计划表）：
    // 表格口径不唯一 → 旧实现零产出 → LLM 修复无法裁决 → 修复节点 failed
    const markdown = [
      '工期控制以45日历天为唯一基准。',
      '| 施工阶段 | 开始 | 结束 |',
      '| --- | --- | --- |',
      '| 竣工清理 | 第44日 | 第45日 |',
      '关键节点按210日历天总工期倒排。',
      '| 计划工期 | 210日历天 |',
    ].join('\n');
    const fix = applyNumericConsistencyDeterministicFixes(markdown, { scheduleAuthority: 210 });
    expect(fix.fixedCount).toBeGreaterThan(0);
    expect(fix.markdown).toContain('工期控制以210日历天为唯一基准');
    expect(fix.markdown).not.toContain('45日历天');
    expect(fix.details.some(detail => detail.includes('以绑定资料计划工期为准'))).toBe(true);
  });

  it('4.17.3 无外部权威时保持旧行为：表格唯一值仍为权威（表格210 + 正文45 → 45改210）', () => {
    const markdown = '工期控制以45日历天为唯一基准。\n| 计划工期 | 210日历天 |';
    const fix = applyNumericConsistencyDeterministicFixes(markdown);
    expect(fix.fixedCount).toBeGreaterThan(0);
    expect(fix.markdown).toContain('工期控制以210日历天为唯一基准');
  });

  it('4.17.3 extractScheduleAuthority：计划工期事实卡提取日历天数值', () => {
    const factsModel = {
      schedule: [{ key: '计划工期', fieldId: 'schedule_requirement', value: '计划工期：以开工令下发之日起计算，210日历天' }],
    } as unknown as DocumentFactsModel;
    expect(extractScheduleAuthority(factsModel)).toBe(210);
  });

  it('4.17.3 extractScheduleAuthority：事实卡缺工期字段时返回 undefined', () => {
    const factsModel = {
      schedule: [{ key: '开工日期', fieldId: 'schedule_requirement', value: '2026年9月23日' }],
    } as unknown as DocumentFactsModel;
    expect(extractScheduleAuthority(factsModel)).toBeUndefined();
  });

  it('4.17.4 extractAssemblyRateAuthority：装配率事实卡提取百分比', () => {
    const factsModel = {
      project: [{ key: '装配率', fieldId: 'assembly_rate', value: '30%' }],
    } as unknown as DocumentFactsModel;
    expect(extractAssemblyRateAuthority(factsModel)).toBe(30);
  });

  it('4.17.4 extractProjectScaleSummary：面积+层数摘要', () => {
    const factsModel = {
      project: [{ key: '单体建筑面积', fieldName: '单体建筑面积', value: '单体建筑面积28570.36平方米' }],
      drawings: [{ key: '设计说明', fieldName: '', value: '地上6层，地下1层，建筑消防高度28.90米' }],
    } as unknown as DocumentFactsModel;
    expect(extractProjectScaleSummary(factsModel)).toBe('建筑面积28570.36平方米、地上6层、地下1层');
  });

  it('4.17.4 fixNodeScheduleConflicts：365 节点体系统一缩放到总工期 540 体系', () => {
    const markdown = [
      '## 总工期控制基准与阶段划分',
      '| 施工阶段 | 开始时间 | 结束时间 | 持续时间 |',
      '| --- | --- | --- | --- |',
      '| 施工准备与临时设施 | 开工令下发后第1日 | 开工令下发后第15日 | 15日 |',
      '| 土方开挖与基础施工 | 开工令下发后第16日 | 开工令下发后第75日 | 60日 |',
      '| 主体结构施工 | 开工令下发后第76日 | 开工令下发后第210日 | 135日 |',
      '| 竣工验收合格 | 开工令下发后第356日 | 开工令下发后第365日 | 10日 |',
      '计划工期：开工之日起，540个日历天。',
      '项目部按竣工验收合格（第365日）的节点组织施工。',
    ].join('\n');
    const fix = applyNumericConsistencyDeterministicFixes(markdown, { scheduleAuthority: 540 });
    expect(fix.markdown).toContain('第540日');
    expect(fix.markdown).toContain('竣工验收合格（第540日）');
    expect(fix.markdown).not.toContain('第365日');
    // 三列表链式自洽：持续列=结束-开始+1
    const row = fix.markdown.match(/\| 主体结构施工 \| 开工令下发后第(\d+)日 \| 开工令下发后第(\d+)日 \| (\d+)日 \|/u);
    expect(row).not.toBeNull();
    expect(Number(row![3])).toBe(Number(row![2]) - Number(row![1]) + 1);
  });

  it('4.17.4 fixNodeScheduleConflicts：非权威表节点日期对齐权威表', () => {
    const markdown = [
      '## 总工期控制基准与阶段划分',
      '| 施工阶段 | 开始时间 | 结束时间 | 持续时间 |',
      '| --- | --- | --- | --- |',
      '| 土方开挖与基础施工 | 开工令下发后第16日 | 开工令下发后第75日 | 60日 |',
      '| 主体结构施工 | 开工令下发后第76日 | 开工令下发后第210日 | 135日 |',
      '| 竣工验收合格 | 开工令下发后第356日 | 开工令下发后第365日 | 10日 |',
      '### 关键施工节点控制计划表',
      '| 关键节点 | 计划完成时间 |',
      '| --- | --- |',
      '| 基坑开挖与支护完成 | 开工后第45日 |',
      '| 基础结构完成 | 开工后第90日 |',
      '| 主体结构封顶 | 开工后第180日 |',
      '| 竣工验收合格 | 开工后第330日 |',
    ].join('\n');
    const fix = applyNumericConsistencyDeterministicFixes(markdown, { scheduleAuthority: 365 });
    expect(fix.markdown).toContain('| 基坑开挖与支护完成 | 开工后第75日 |');
    expect(fix.markdown).toContain('| 基础结构完成 | 开工后第75日 |');
    expect(fix.markdown).toContain('| 主体结构封顶 | 开工后第210日 |');
    expect(fix.markdown).toContain('| 竣工验收合格 | 开工后第365日 |');
  });

  it('4.17.4 fixCrossSectionNumericConflicts：装配率 38.4% 回退为招标锁定 30%', () => {
    const markdown = '本工程装配率不低于30%，实际装配率为38.4%，满足装配率38.4%的要求。';
    const fix = applyNumericConsistencyDeterministicFixes(markdown, { assemblyRateAuthority: 30 });
    expect(fix.fixedCount).toBeGreaterThan(0);
    expect(fix.markdown).not.toContain('38.4%');
  });

  it('4.17.4 fixCrossSectionNumericConflicts：塔吊多表 2台 vs 1台 多值冲突不再取保守台数（V2 批1-4 零兜底写入）→ 不修复', () => {
    const markdown = [
      '| 关键节点 | 投入资源 |',
      '| --- | --- |',
      '| 主体结构封顶 | 塔式起重机2台、施工升降机2台 |',
      '| 主体结构封顶 | 塔吊1台、施工升降机2台 |',
      '主体施工阶段投入塔式起重机2台。',
    ].join('\n');
    const fix = applyNumericConsistencyDeterministicFixes(markdown);
    expect(fix.fixedCount).toBe(0);
    expect(fix.markdown).toBe(markdown);
  });

  it('4.17.4 fixNodeScheduleConflicts：形态A不跨「）→（」节点分隔误采（施工准备22日保持）', () => {
    // 合肥师范实测错位源：第22日（施工准备行）跨「）→…完成…→」误采为封顶工期 22→311
    const markdown = [
      '## 总进度计划表',
      '| 施工阶段 | 完成日 |',
      '| --- | --- |',
      '| 主体结构封顶 | 第311日 |',
      '| 竣工验收合格 | 开工令下发后第540日 |',
      '项目部按“施工准备与临时设施完成（开工令下发后第22日）→土方开挖与基础施工完成（第75日）→主体结构封顶（第210日）→砌体与二次结构完成（第255日）”的节点组织施工。',
    ].join('\n');
    const fix = applyNumericConsistencyDeterministicFixes(markdown, { scheduleAuthority: 540 });
    expect(fix.markdown).toContain('开工令下发后第22日');
    expect(fix.markdown).toContain('主体结构封顶（第311日）');
    expect(fix.markdown).not.toContain('开工令下发后第311日');
  });

  it('4.17.4 fixNodeScheduleConflicts：形态D竣工验收节点倒序式 365→540', () => {
    const markdown = [
      '## 总进度计划表',
      '| 施工阶段 | 完成日 |',
      '| --- | --- |',
      '| 竣工验收 | 第540日 |',
      '主体结构封顶节点第311日与竣工验收节点第365日为刚性控制点，滞后超过3日即启动纠偏。',
    ].join('\n');
    const fix = applyNumericConsistencyDeterministicFixes(markdown, { scheduleAuthority: 540 });
    expect(fix.markdown).toContain('竣工验收节点第540日');
    expect(fix.markdown).toContain('主体结构封顶节点第311日');
    expect(fix.markdown).not.toContain('竣工验收节点第365日');
  });

  it('4.17.4 fixCrossSectionNumericConflicts：装配率长窗口「计算为38.4%」回退 30%', () => {
    const markdown = '装配率按安徽省《装配式建筑评价技术标准》DB34/T 3830-2025计算为38.4%。';
    const fix = applyNumericConsistencyDeterministicFixes(markdown, { assemblyRateAuthority: 30 });
    expect(fix.fixedCount).toBeGreaterThan(0);
    expect(fix.markdown).not.toContain('38.4%');
    expect(fix.markdown).toContain('计算为30%');
  });

  it('4.17.4 fixCrossSectionNumericConflicts：反向模式不误伤独立指标54.0%', () => {
    const markdown = '内隔墙非砌筑比例达到54.0%，装配率按安徽省《装配式建筑评价技术标准》DB34/T 3830-2025计算为38.4%。';
    const fix = applyNumericConsistencyDeterministicFixes(markdown, { assemblyRateAuthority: 30 });
    expect(fix.markdown).not.toContain('38.4%');
    expect(fix.markdown).toContain('54.0%');
  });

  it('4.17.4 fixAdjacentPhraseDuplication：数字短短语（第311日）双现/抗渗等级P8，地）不折叠', () => {
    const markdown = '项目部按“施工准备与临时设施完成（开工令下发后第311日）→主体结构封顶（第311日）”组织施工。底板、外墙混凝土抗渗等级P8，地下室顶板混凝土标号C35、抗渗等级P8，地上各层顶板C30，墙C35，柱C50。';
    const fix = fixAdjacentPhraseDuplication(markdown);
    expect((fix.markdown.match(/第311日/g) || []).length).toBe(2);
    expect((fix.markdown.match(/抗渗等级P8/g) || []).length).toBe(2);
    expect(fix.markdown).toContain('地上各层顶板C30');
  });

  it('4.17.4 fixAdjacentPhraseDuplication：热负荷三连粘连折叠', () => {
    const markdown = '中央空调夏季冷负荷182.5kW，冬季热负荷71.2kW182.5kW，冬季热负荷71.2kW182.5kW，冬季热负荷71.2kW。';
    const fix = fixAdjacentPhraseDuplication(markdown);
    expect(fix.markdown).toBe('中央空调夏季冷负荷182.5kW，冬季热负荷71.2kW。');
  });

  it('P2.3 fixCrossSectionNumericConflicts：垫层 C30 回退清单锁定 C20（异名人行道/基础垫层保持）', () => {
    const markdown = '垫层采用C30素混凝土浇筑。人行道混凝土垫层采用C25素砼。基础垫层采用C15素砼。';
    const fix = applyNumericConsistencyDeterministicFixes(markdown, { authorityIndex: fixtureIndex({ specs: [{ anchor: 'cushion', value: 'C20' }] }) });
    expect(fix.fixedCount).toBeGreaterThan(0);
    expect(fix.markdown).toContain('垫层采用C20素混凝土浇筑');
    expect(fix.markdown).toContain('人行道混凝土垫层采用C25素砼');
    expect(fix.markdown).toContain('基础垫层采用C15素砼');
    expect(fix.markdown).not.toContain('C30');
  });

  it('P2.3 fixCrossSectionNumericConflicts：潜水泵/提升泵同物异名 6台/12台 统一为锁定 4台', () => {
    const markdown = '泵房配置潜水泵6台，备用提升泵12台。';
    const fix = applyNumericConsistencyDeterministicFixes(markdown, { authorityIndex: fixtureIndex({ equipment: [{ label: '潜水泵', value: 4 }] }) });
    expect(fix.fixedCount).toBeGreaterThan(0);
    expect(fix.markdown).toContain('潜水泵4台');
    expect(fix.markdown).toContain('提升泵4台');
    expect(fix.markdown).not.toContain('潜水泵6台');
    expect(fix.markdown).not.toContain('提升泵12台');
  });

  it('P2.3 fixCrossSectionNumericConflicts：机动工期 预留7天 回退为锁定 2天', () => {
    const markdown = '总工期90日历天，其中预留7天机动工期用于工序衔接与验收缓冲。';
    const fix = applyNumericConsistencyDeterministicFixes(markdown, { authorityIndex: fixtureIndex({ slackDays: 2 }) });
    expect(fix.fixedCount).toBeGreaterThan(0);
    expect(fix.markdown).toContain('预留2天机动工期');
    expect(fix.markdown).not.toContain('预留7天');
  });

  it('P2.4 fixCrossSectionNumericConflicts：残留 9个自然村 统一为 20（自然村分组口径不参与）', () => {
    const markdown = '本项目9个自然村分散施工。清单按3个自然村分组编制。';
    const fix = applyNumericConsistencyDeterministicFixes(markdown, { authorityIndex: fixtureIndex({ villageCount: 20 }) });
    expect(fix.fixedCount).toBeGreaterThan(0);
    expect(fix.markdown).toContain('本项目20个自然村分散施工');
    expect(fix.markdown).not.toContain('9个自然村');
    expect(fix.markdown).toContain('按3个自然村分组');
  });

  it('r28m M24a A1：「9个自然村作业面核对」的数值是作业组织单元口径 → 不入互斥池', () => {
    // r28k 实机归因：「施工员每日按9个自然村作业面核对…」与覆盖村数并存时被误判村数矛盾——
    // 数字后 12 字窗口含组织单元词（作业面/施工点/施工段）即跳过，与 citation.ts villageRe 负向排除同源
    const markdown = '施工员每日按9个自然村作业面核对现场进度与人员到岗情况。本项目覆盖20个自然村。';
    expect(crossSectionNumericConflictIssues(markdown)).toEqual([]);
  });

  it('r28m M24a A1 边界：真覆盖村数异值（无组织单元词尾随）→ 照常互斥', () => {
    const markdown = '本项目覆盖9个自然村，共20个自然村分散施工。';
    const issues = crossSectionNumericConflictIssues(markdown);
    expect(issues.some(issue => /自然村/u.test(issue.message) && /9个自然村 与 20个自然村/u.test(issue.message))).toBe(true);
  });

  it('4.17.4 fixAdjacentPhraseDuplication：应急人员句隔位重复折叠', () => {
    const markdown = '应急抢险人员按主体结构与装饰装修穿插施工阶段高峰阶段应急抢险人员按主体结构与装饰装修穿插施工阶段高峰人数186人的16%配置，不少于30人的16%配置，不少于30人。';
    const fix = fixAdjacentPhraseDuplication(markdown);
    expect((fix.markdown.match(/不少于30人/g) || []).length).toBeLessThanOrEqual(2);
    expect((fix.markdown.match(/按主体结构与装饰装修穿插施工阶段高峰/g) || []).length).toBe(1);
  });

  it('4.17.4 fixPlaceholderTableCells：6.1 一览表套话填充 factsModel 数据', () => {
    const markdown = '| 工程名称 | 建设地点 | 建设规模 | 计划工期 |\n| --- | --- | --- | --- |\n| 某项目 | 某地 | 按施工图设计文件确定 | 按合同约定工期执行 |';
    const fix = fixPlaceholderTableCells(markdown, { areaSummary: '建筑面积28570.36平方米、地上6层、地下1层', scheduleDays: 540 });
    expect(fix.markdown).toContain('建筑面积28570.36平方米、地上6层、地下1层');
    expect(fix.markdown).toContain('540个日历天');
    expect(fix.markdown).not.toContain('按施工图设计文件确定');
  });

});

describe('foundationFormResidueIssues（h13 桩基表述残留）', () => {
  it('地基与基础无桩基工序但全文残留 ≥2 处桩基表述 → 报', () => {
    const markdown = '### 1.3 地基与基础\n基础垫层采用C15混凝土，底板钢筋绑扎后浇筑C30混凝土。\n\n## 进度计划\n桩基施工阶段投入桩机2台。\n桩基钢筋笼验收按规范执行。';
    const issues = foundationFormResidueIssues(markdown);
    expect(issues.some(issue => /桩基表述残留/u.test(issue.message))).toBe(true);
  });

  it('地基与基础小节含桩基工序词 → 不报', () => {
    const markdown = '### 1.3 地基与基础\n本工程基础采用钻孔灌注桩，桩基施工投入桩机2台。';
    expect(foundationFormResidueIssues(markdown)).toEqual([]);
  });

  it('全文桩基表述 <2 处 → 不报', () => {
    const markdown = '### 1.3 地基与基础\n基础垫层采用C15混凝土。\n\n桩基钢筋笼按规范验收。';
    expect(foundationFormResidueIssues(markdown)).toEqual([]);
  });
});

describe('basicInfoScheduleFieldIssues（h13d 信息表计划工期字段校验）', () => {
  it('计划工期行填违约条款文字 → 报错填', () => {
    const markdown = '| 信息项 | 内容 |\n| --- | --- |\n| 计划工期 | 工期延误56天以上发包人可切除剩余工程量 |';
    const issues = basicInfoScheduleFieldIssues(markdown);
    expect(issues.some(issue => /计划工期.*错填/u.test(issue.message))).toBe(true);
  });

  it('计划工期行填日历天数值 → 不报', () => {
    const markdown = '| 信息项 | 内容 |\n| --- | --- |\n| 计划工期 | 540个日历天 |';
    expect(basicInfoScheduleFieldIssues(markdown)).toEqual([]);
  });
});

describe('bodySentencesForSemantic（h11b-1 均匀采样）', () => {
  it('超 400 句长文均匀采样，首尾句均保留（尾部语义覆盖不丢失）', () => {
    const sentences = Array.from({ length: 401 }, (_, index) => `第${index + 1}条施工措施明确了现场管理要求并落实到岗位责任。`);
    const markdown = sentences.join('\n');
    const sampled = bodySentencesForSemantic(markdown);
    expect(sampled.length).toBeLessThanOrEqual(400);
    expect(sampled.length).toBeGreaterThan(100);
    expect(sampled[0]).toContain('第1条');
    expect(sampled[sampled.length - 1]).toContain('第401条');
  });

  it('≤400 句短文全量保留', () => {
    const sentences = Array.from({ length: 30 }, (_, index) => `第${index + 1}条施工措施明确了现场管理要求并落实到岗位责任。`);
    const sampled = bodySentencesForSemantic(sentences.join('\n'));
    expect(sampled.length).toBe(30);
  });
});

describe('ambiguousEitherOrIssues（h14 两可表述阻断）', () => {
  it('斜杠并列两可「采用支护桩/放坡」→ 报阻断', () => {
    const issues = ambiguousEitherOrIssues('基坑支护采用支护桩/放坡开挖方式，坑内降水配合明排。');
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('支护桩/放坡');
  });

  it('括号悬置「桩基（或独立基础/筏板基础按图纸实施）」→ 报阻断', () => {
    const issues = ambiguousEitherOrIssues('本工程基础形式为桩基（或独立基础/筏板基础按图纸实施）。');
    expect(issues.length).toBe(1);
    expect(issues[0].category).toBe('fact_consistency');
  });

  it('职业枚举「主体结构木工/钢筋工」→ 不误报', () => {
    expect(ambiguousEitherOrIssues('主体结构施工阶段投入木工/钢筋工等专业班组，各班组持证上岗。')).toEqual([]);
  });

  it('数字单位枚举「50mm/70mm」→ 不误报', () => {
    expect(ambiguousEitherOrIssues('基层厚度采用50mm/70mm两种规格，按设计图纸选用。')).toEqual([]);
  });

  it('确定的支护决策表述 → 不报', () => {
    expect(ambiguousEitherOrIssues('基坑支护采用放坡+喷锚，坡面挂网喷护。')).toEqual([]);
  });

  it('「A或B」直陈两可「按专项方案放坡或支护」→ 报阻断（外部评审 P1）', () => {
    const issues = ambiguousEitherOrIssues('应急处理：按专项方案放坡或支护，分层开挖。');
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('放坡或支护');
  });

  it('决策词被左组吞并「采用钢板桩或排桩」→ 仍报阻断', () => {
    const issues = ambiguousEitherOrIssues('基坑支护采用钢板桩或排桩，垂直开挖。');
    expect(issues.length).toBe(1);
  });

  it('「土钉墙或支护桩」两可 → 报阻断', () => {
    const issues = ambiguousEitherOrIssues('本工程拟采用土钉墙或支护桩方案。');
    expect(issues.length).toBe(1);
  });

  it('无决策词并列工序「土方开挖或回填前」→ 不误报', () => {
    expect(ambiguousEitherOrIssues('土方开挖或回填前应设置临边防护。')).toEqual([]);
  });

  it('词族外枚举「集水井或排水沟」→ 不误报', () => {
    expect(ambiguousEitherOrIssues('坑底设置集水井或排水沟，明排降水。')).toEqual([]);
  });

  it('无决策词并列「基坑支护或开挖施工顺序」→ 不误报', () => {
    expect(ambiguousEitherOrIssues('本工程基坑支护或开挖施工顺序按现场进度调整。')).toEqual([]);
  });

  it('管线保护措施「钢板桩或槽钢挡护」→ 不误报（4.19.3 真实回归：非主支护体系决策）', () => {
    expect(ambiguousEitherOrIssues('对平行于基坑边的管线，采用钢板桩或槽钢挡护，挡护高度超出管线顶面不少于300mm。')).toEqual([]);
  });

  it('管线保护措施「钢板桩/槽钢」斜杠形态 → 不误报', () => {
    expect(ambiguousEitherOrIssues('对平行于基坑边的管线，采用钢板桩/槽钢挡护。')).toEqual([]);
  });
});

describe('excavationDepthLockIssues（h14 基坑深度数值锁定）', () => {
  it('有基坑支护内容但无深度数值 → 报阻断', () => {
    const markdown = '基坑支护采用放坡开挖，坑内降水配合明排。\n土方开挖分层进行，支护随挖随撑。\n基坑周边设置防护栏杆与排水沟。';
    const issues = excavationDepthLockIssues(markdown);
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('基坑深度数值未锁定');
  });

  it('有「开挖深度 5.85m」表述 → 不报', () => {
    const markdown = '基坑开挖深度5.85m，支护采用放坡喷锚。\n土方开挖分层进行，支护随挖随撑。\n基坑周边设置防护栏杆。';
    expect(excavationDepthLockIssues(markdown)).toEqual([]);
  });

  it('比较式阈值/按图式/倍数式不视为锁定（4.12.12 真实生成回归）→ 报阻断', () => {
    const markdown = '基坑开挖深度超过3m后观测频次调整为每日1次。\n单次开挖深度不大于1.5m，支护随挖随撑。\n开挖深度按基坑支护设计图纸确定。\n调查范围按基坑开挖深度2倍距离控制。';
    const issues = excavationDepthLockIssues(markdown);
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('基坑深度数值未锁定');
  });

  it('「深度约5.85m」「标高-2.500m」确定式 → 不报', () => {
    const markdown = '基坑开挖深度约5.85m，支护采用放坡喷锚。\n槽底标高-2.500m，土方开挖分层进行。\n基坑周边设置防护栏杆。';
    expect(excavationDepthLockIssues(markdown)).toEqual([]);
  });

  it('「标高以上300mm」「坑底标高以下200mm」相对量表述不视为锁定（4.19 真实生成回归：清底厚度曾被误判为深度）→ 报阻断', () => {
    const markdown = '基坑采用放坡开挖，分层分段开挖至设计标高以上300mm，人工清底。\n基坑周边设置防护栏杆与排水沟，支护随挖随撑。';
    const issues = excavationDepthLockIssues(markdown);
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('基坑深度数值未锁定');
    const markdownBelow = '基坑采用放坡开挖，机械开挖至坑底标高以下200mm，人工清底。\n基坑周边设置防护栏杆，支护随挖随撑。';
    expect(excavationDepthLockIssues(markdownBelow).length).toBe(1);
  });

  it('偏差句「标高偏差控制在±5」「基底标高偏差0～-50mm」不视为锁定（4.19.3 真实回归：质控允许值被误判为深度）→ 报阻断', () => {
    const markdown = '基坑采用放坡开挖，支护随挖随撑。\n标高偏差控制在±5，基底标高偏差0～-50mm，无扰动土。\n基坑周边设置防护栏杆与排水沟。';
    const issues = excavationDepthLockIssues(markdown);
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('基坑深度数值未锁定');
  });

  it('偏差句与确定式深度共存 → 不报（偏差不干扰真实锁定）', () => {
    const markdown = '基坑开挖深度5.15m，支护采用放坡喷锚。\n标高偏差控制在±5，基底标高偏差0～-50mm。\n土方开挖分层进行，支护随挖随撑。';
    expect(excavationDepthLockIssues(markdown)).toEqual([]);
  });

  it('时间数形态「坑底标高后24h内完成垫层」不视为锁定（4.19.3 真实回归：垫层时限被误判为深度）→ 报阻断', () => {
    const markdown = '基坑采用放坡开挖，支护随挖随撑。\n土方分层开挖，开挖至坑底标高后24h内完成垫层封闭。\n基坑周边设置防护栏杆与排水沟。';
    const issues = excavationDepthLockIssues(markdown);
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('基坑深度数值未锁定');
  });

  it('时间数形态与确定式深度共存 → 不报（时间句不干扰真实锁定）', () => {
    const markdown = '基坑开挖深度5.15m，支护采用放坡喷锚。\n开挖至坑底标高后24h内完成垫层封闭。\n土方开挖分层进行，支护随挖随撑。';
    expect(excavationDepthLockIssues(markdown)).toEqual([]);
  });

  it('零标高基准句「现状地面标高与设计±0.000对应绝对标高」不视为锁定（4.19.3 真实回归）→ 报阻断', () => {
    const markdown = '基坑采用放坡开挖，支护随挖随撑。\n现状地面标高与设计±0.000对应绝对标高存在局部差异。\n基坑周边设置防护栏杆与排水沟。';
    const issues = excavationDepthLockIssues(markdown);
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('基坑深度数值未锁定');
  });

  it('零标高基准句与确定式深度共存 → 不报（基准句不干扰真实锁定）', () => {
    const markdown = '基坑开挖深度5.15m，支护采用放坡喷锚。\n现状地面标高与设计±0.000对应绝对标高存在局部差异。\n土方开挖分层进行，支护随挖随撑。';
    expect(excavationDepthLockIssues(markdown)).toEqual([]);
  });

  it('水位相对句「标高低于水池最低水位500mm」不视为锁定（4.19.5 真实回归：降水井水位控制值被误判为深度）→ 报阻断', () => {
    const markdown = '基坑采用放坡开挖，支护随挖随撑。\n降水井运行期间观测井内标高低于水池最低水位500mm。\n基坑周边设置防护栏杆与排水沟。';
    const issues = excavationDepthLockIssues(markdown);
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('基坑深度数值未锁定');
  });

  it('水位相对句与确定式深度共存 → 不报（水位句不干扰真实锁定）', () => {
    const markdown = '基坑开挖深度5.15m，支护采用放坡喷锚。\n降水井运行期间观测井内标高低于水池最低水位500mm。\n土方开挖分层进行，支护随挖随撑。';
    expect(excavationDepthLockIssues(markdown)).toEqual([]);
  });

  it('无基坑工程内容 → 不检测', () => {
    expect(excavationDepthLockIssues('本工程为装饰装修项目，主要内容为室内装修与外立面翻新。')).toEqual([]);
  });
});

describe('fabricatedAwardIssues（h14 奖项白名单）', () => {
  const factsModel = (qualityValues: string[]) => ({
    project: [], schedule: [], quality: qualityValues.map(value => ({ key: '质量标准', value, sourceFile: '/proj/tender.txt', roleId: 'specification', confidence: 0.9 })),
    safety: [], resources: [], tables: [], bills: [], drawings: [], rules: [], specifications: [], schemaFacts: {}, factIndex: {}, missing: [], conflicts: [], preciseFacts: [],
  }) as unknown as DocumentFactsModel;

  it('正文奖项在白名单外（资料无该奖项）→ 报杜撰', () => {
    const issues = fabricatedAwardIssues('质量目标：确保获得鲁班奖。', factsModel(['质量标准：合格，确保黄山杯']));
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('鲁班奖');
  });

  it('正文奖项与白名单一致 → 不报', () => {
    expect(fabricatedAwardIssues('质量目标：确保黄山杯。', factsModel(['质量标准：合格，确保黄山杯']))).toEqual([]);
  });

  it('通用目标表述（省优/优质工程）→ 不报杜撰', () => {
    expect(fabricatedAwardIssues('质量目标：创省优工程。', factsModel(['质量标准：合格，确保黄山杯']))).toEqual([]);
  });

  it('白名单为空（提取失败）→ 不报（无基准不阻断）', () => {
    expect(fabricatedAwardIssues('质量目标：确保鲁班奖。', factsModel([]))).toEqual([]);
  });

  it('评分项要求提取的奖项进入白名单', () => {
    const requirements: TenderRequirementModel = {
      entries: [{ text: '创优目标：确保黄山杯', coreTerms: [], sources: [{ file: '招标文件.pdf' }], category: '质量创优', policy: 'respond' }],
      excluded: [],
      reconciliation: { clauseCount: 1, entryCount: 1, excludedCount: 0, undecidedCount: 0, mergedCount: 0, batchCount: 1, retriedBatches: 0 },
      extracted: true,
    };
    expect(fabricatedAwardIssues('质量目标：确保黄山杯。', factsModel([]), requirements)).toEqual([]);
  });

  it('奖惩管理词汇不误报为奖项（4.12.13 真实生成回归：奖励/奖金/奖惩/不奖励）', () => {
    const markdown = [
      '技术负责人每月25日前编制创优资金使用台账，逐笔登记奖励发放、整改投入、检测费用与资料制作支出。',
      '合同约定创优奖励300万元，该金额作为项目创优专项激励资金。',
      '班组自检记录完整且一次验收合格奖励200元/周；漏检每次扣100元。',
      '创优目标实现奖励项目创优奖金的20%；未实现扣减绩效工资的30%。',
      '项目部将该条款作为创优管理的合同刚性约束，建立与合同奖惩挂钩的内部考核体系。',
      '承包人提出的合理化建议降低了合同价格的，按合同约定不奖励。',
    ].join('\n');
    expect(fabricatedAwardIssues(markdown, factsModel(['质量标准：合格，确保黄山杯']))).toEqual([]);
  });

  it('奖惩词汇与真杜撰奖项并存时只报真杜撰', () => {
    const markdown = '逐笔登记奖励发放，确保获得鲁班奖。';
    const issues = fabricatedAwardIssues(markdown, factsModel(['质量标准：合格，确保黄山杯']));
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('鲁班奖');
  });

  it('通用词“奖项”不误报为具名奖项（4.12.13：创优目标与奖项申报）', () => {
    const markdown = '创优目标与奖项申报路径一致，确保获得黄山杯。';
    expect(fabricatedAwardIssues(markdown, factsModel(['质量标准：合格，确保黄山杯']))).toEqual([]);
  });
});

describe('resourceConsistencyIssues（h14 反向劳动力口径）', () => {
  it('「投入劳动力110人」与「劳动力高峰180人」跨口径矛盾 → 报', () => {
    const markdown = '主体阶段投入劳动力约110人。\n劳动力高峰150～180人。';
    const issues = resourceConsistencyIssues(markdown);
    expect(issues.some(issue => /劳动力数据矛盾/u.test(issue.message))).toBe(true);
  });

  it('两处劳动力数值不同 → 报互斥（无容差）', () => {
    const issues = resourceConsistencyIssues('主体阶段投入劳动力约110人，装饰阶段投入劳动力约105人。');
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('互斥');
  });
});

describe('duplicateTableIssues / stripDuplicateTables（h15 表格重复）', () => {
  const tableA = ['| 序号 | 设备名称 | 数量 |', '| --- | --- | --- |', '| 1 | 塔式起重机 | 2 |', '| 2 | 施工升降机 | 3 |'].join('\n');
  const tableB = ['| 序号 | 设备名称 | 数量 |', '| --- | --- | --- |', '| 1 | 塔式起重机 | 2 |'].join('\n');

  it('两张表头完全相同的表格 → 报重复', () => {
    const issues = duplicateTableIssues(`第一章\n${tableA}\n\n正文。\n${tableB}`);
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].message).toContain('表格重复');
  });

  it('相邻完全一致的表格（连续复制粘贴）→ 报（生成系统无分页渲染场景）', () => {
    // 连排无空行是真实缺陷形态：第二张表直接接在第一张表后，块内切分为两张后判定重复
    const issues = duplicateTableIssues(`\n${tableA}\n${tableA}\n`);
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it('连排表第二张缺分隔行（青天实测：机械表重复两次）→ 块内切分后报重复', () => {
    const deviceHeaderA = ['| 设备名称 | 规格型号 | 数量 | 使用阶段 | 用途 | 进退场时间 |', '| --- | --- | --- | --- | --- | --- |'].join('\n');
    const deviceRows = ['| 塔式起重机 | TC6015 | 2台 | 主体结构 | 吊装 | 开工后第15日进场 |', '| 施工升降机 | SC200/200 | 4台 | 装饰与机电 | 垂直运输 | 主体施工至6层进场 |'].join('\n');
    const deviceHeaderB = '| 设备名称 | 规格型号 | 数量 | 使用阶段 | 主要用途 | 进退场时间 |';
    // 第二张表 header 后无分隔行（复制粘贴残留），数据行与第一张完全一致
    const markdown = `${deviceHeaderA}\n${deviceRows}\n${deviceHeaderB}\n${deviceRows}`;
    const issues = duplicateTableIssues(markdown);
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].message).toContain('表格重复');
  });

  it('同主题不同表头结构（青天实测：分阶段劳动力计划表出现两次，删减版子表）→ 报重复', () => {
    // 真实形态：区间版原表（信息全、含调配原则列）与删减版子表（表头结构不同、区间值拆为平均/高峰单值列），
    // 表头相似仅 ~0.25 但首列同批阶段、文本 cell 双向覆盖度 100% → 第三条「首列 ≥0.6 且文本覆盖 ≥0.6」命中
    //（互补表形态如「统计表 vs 投入计划表」共享纯数字但文本 cell 大量独有，双向覆盖 <0.6 不命中）
    const laborA = ['| 施工阶段 | 工种 | 人数 | 主要工作内容 | 调配原则 |', '| --- | --- | --- | --- | --- |', '| 基坑与基础 | 土方工、钢筋工、混凝土工 | 85～120 | 土方开挖、钢筋绑扎 | 按工序流水调配 |', '| 主体结构 | 钢筋工、木工、混凝土工 | 160～220 | 现浇结构、构件吊装 | 两班倒作业 |', '| 二次结构与砌体 | 砌筑工、抹灰工 | 90～130 | 砌体施工、构造柱 | 与主体穿插 |', '| 装饰装修 | 抹灰工、油漆工 | 120～160 | 抹灰、幕墙安装 | 多楼层平行 |', '| 机电安装 | 电工、管道工 | 70～100 | 机电管线安装 | 跟随土建进度 |'].join('\n');
    const laborB = ['| 施工阶段 | 主要工种 | 阶段平均人数 | 阶段高峰人数 | 主要工作内容 |', '| --- | --- | --- | --- | --- |', '| 基坑与基础 | 土方工、钢筋工、混凝土工 | 85 | 120 | 土方开挖、钢筋绑扎 |', '| 主体结构 | 钢筋工、木工、混凝土工 | 160 | 220 | 现浇结构、构件吊装 |', '| 装饰装修 | 抹灰工、油漆工 | 120 | 160 | 抹灰、幕墙安装 |', '| 机电安装 | 电工、管道工 | 70 | 100 | 机电管线安装 |'].join('\n');
    const issues = duplicateTableIssues(`${laborA}\n\n${laborB}`);
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].message).toContain('表格重复');
  });

  it('同表头不同内容的表（不同章各列不同对象）→ 不误报', () => {
    const tableC = ['| 保护对象 | 位置关系 | 风险影响 |', '| --- | --- | --- |', '| 地铁隧道 | 南侧 12m | 沉降风险 |'].join('\n');
    const tableD = ['| 保护对象 | 位置关系 | 风险影响 |', '| --- | --- | --- |', '| 高压燃气管 | 北侧 8m | 泄漏风险 |'].join('\n');
    expect(duplicateTableIssues(`${tableC}\n\n${tableD}`)).toEqual([]);
  });

  it('stripDuplicateTables 保留信息量大者并删除另一张', () => {
    const { markdown, removedCount } = stripDuplicateTables(`\n${tableA}\n\n正文段落。\n${tableB}\n`);
    expect(removedCount).toBeGreaterThan(0);
    // 数据行更多（bodyChars 更大）的 tableA 保留；tableB 为 tableA 子集，删除后该数据行只出现 1 次
    expect(markdown).toContain('| 2 | 施工升降机 | 3 |');
    expect(markdown.split('| 1 | 塔式起重机 | 2 |').length - 1).toBe(1);
    // 正文段落不受影响
    expect(markdown).toContain('正文段落。');
  });
});

describe('duplicateParagraphIssues / stripDuplicateParagraphs（h15 段落完全重复）', () => {
  const longParagraph = '危险源辨识覆盖基坑支护、装配式构件吊装、脚手架搭设、临时用电、高处作业等全部作业活动，并按作业活动逐项明确风险等级与控制措施。';

  it('同一长段落（≥40 字）出现 2 次 → 报完全重复', () => {
    const issues = duplicateParagraphIssues(`${longParagraph}\n\n${longParagraph}`);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('段落完全重复');
  });

  it('标题行与表格行重复不入池 → 不误报', () => {
    const markdown = ['## 施工部署', '## 施工部署', '| a | b |', '| - | - |', '| a | b |'].join('\n');
    expect(duplicateParagraphIssues(markdown)).toEqual([]);
  });

  it('stripDuplicateParagraphs 保留首次出现删除后续完全重复段落', () => {
    const { markdown, removedCount } = stripDuplicateParagraphs(`段落开头。\n\n${longParagraph}\n\n中间句。\n\n${longParagraph}\n\n结尾句。`);
    expect(removedCount).toBeGreaterThan(0);
    expect(markdown.split(longParagraph).length - 1).toBe(1);
    expect(markdown).toContain('中间句。');
    expect(markdown).toContain('结尾句。');
  });
});

describe('resourceTriadSectionHierarchyIssues（h16 人材机三合一章结构层级）', () => {
  const triadChapter = [
    '## 第五章 确保人、材、机的保障体系与措施',
    '### 5.1 确保人的保障体系与措施',
    '正文内容。',
    '### 5.2 确保材的保障体系与措施',
    '正文内容。',
    '### 5.3 确保机的保障体系与措施',
    '正文内容。',
    '## 第六章 其他',
  ].join('\n');

  it('人/材/机三个二级小节齐整 → 零缺陷', () => {
    expect(resourceTriadSectionHierarchyIssues(triadChapter)).toEqual([]);
  });

  it('材/机保障体系降级为 H4 挂在「人的保障体系」下 → 报层级错位 blocker', () => {
    const markdown = [
      '## 第五章 确保人、材、机的保障体系与措施',
      '### 5.1 确保人的保障体系与措施',
      '#### 5.1.1 材的保障体系与措施',
      '#### 5.1.2 机的保障体系与措施',
      '正文内容。',
    ].join('\n');
    const issues = resourceTriadSectionHierarchyIssues(markdown);
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues.some(issue => /层级错位/u.test(issue.message) && issue.severity === 'blocker')).toBe(true);
  });

  it('仅 1 个二级小节 → 报结构不完整 blocker', () => {
    const markdown = ['## 第五章 确保人、材、机的保障体系与措施', '### 5.1 确保人的保障体系与措施', '正文内容。'].join('\n');
    const issues = resourceTriadSectionHierarchyIssues(markdown);
    expect(issues.some(issue => /结构不完整/u.test(issue.message) && issue.severity === 'blocker')).toBe(true);
  });

  it('非三合一形态章不受影响', () => {
    const markdown = ['## 第三章 确保质量的保障体系与措施', '### 3.1 质量目标与验收标准', '正文内容。'].join('\n');
    expect(resourceTriadSectionHierarchyIssues(markdown)).toEqual([]);
  });

  it('H4 主语与父 H3 主语一致（如劳动力配置）→ 不误报', () => {
    const markdown = [
      '## 第五章 确保人、材、机的保障体系与措施',
      '### 5.1 确保人的保障体系与措施',
      '#### 5.1.1 劳动力配置与实名制管理',
      '### 5.2 确保材的保障体系与措施',
      '#### 5.2.1 材料进场验收与检测',
      '### 5.3 确保机的保障体系与措施',
      '#### 5.3.1 机械设备进场与维护保养',
    ].join('\n');
    expect(resourceTriadSectionHierarchyIssues(markdown)).toEqual([]);
  });
});

describe('bidderQualificationSectionIssues（h17 投标人资格内容串章）', () => {
  it('6.6/6.7 资格小节（营业执照/资质证书）→ 报 blocker', () => {
    const markdown = [
      '## 第六章 确保安全文明生产的管理体系与措施',
      '### 6.5 扬尘治理与环境保护措施',
      '正文内容。',
      '### 6.6 具备有效的营业执照',
      '我公司持有市场监督管理部门核发的有效营业执照。',
      '### 6.7 具备有效的资质证书、具备有效的安全生产许可证',
      '资质证书、安全生产许可证的现场核验管理。',
    ].join('\n');
    const issues = bidderQualificationSectionIssues(markdown);
    expect(issues.length).toBe(1);
    expect(issues[0].severity).toBe('blocker');
    expect(issues[0].message).toContain('具备有效的营业执照');
    expect(issues[0].message).toContain('具备有效的资质证书');
  });

  it('施工管理口径的证照表述（持证上岗）→ 不报', () => {
    const markdown = [
      '## 第六章 确保安全文明生产的管理体系与措施',
      '### 6.1 安全生产管理与教育培训',
      '特种作业人员必须持证上岗，安全生产许可证按国家规定办理并在现场公示。',
    ].join('\n');
    expect(bidderQualificationSectionIssues(markdown)).toEqual([]);
  });

  it('财务状况类资格小节标题 → 报 blocker', () => {
    const markdown = [
      '## 第二章 针对工程项目整体理解',
      '### 2.1 项目概况与整体理解',
      '正文内容。',
      '### 2.2 财务状况证明',
      '我公司近三年财务状况良好。',
    ].join('\n');
    const issues = bidderQualificationSectionIssues(markdown);
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('财务状况证明');
  });

  it('材料成本控制小节（含技术语境词）→ 不报', () => {
    const markdown = [
      '## 第五章 确保人、材、机的保障体系与措施',
      '### 5.1 材料成本控制措施',
      '加强材料核算与成本控制。',
    ].join('\n');
    expect(bidderQualificationSectionIssues(markdown)).toEqual([]);
  });

  it('无资格内容 → 不报', () => {
    expect(bidderQualificationSectionIssues('## 第一章 工程概况\n正文内容。')).toEqual([]);
  });
});

// ═══════ F14 同物多规格按部位口径（crossSectionNumericConflictIssues 部位豁免） ═══════
// 历史实现「不同标号直接互斥」逼 LLM 修复轮把多规格归一成一种（用户实锤：全文只用一种规格）；
// 改造后仅同一部位语境（或无部位标注）出现多值才判互斥，跨部位差异（垫层 C15/主体 C35）合法。

describe('crossSectionNumericConflictIssues 部位语境豁免（F14）', () => {
  it('不同部位不同标号（垫层 C15 + 主体 C35）→ 0 冲突（跨部位合法）', () => {
    const markdown = '垫层混凝土强度等级为C15。主体结构梁板柱混凝土强度等级为C35。';
    expect(crossSectionNumericConflictIssues(markdown)).toEqual([]);
  });

  it('同一部位两套标号（垫层 C15 + 垫层 C20）→ 1 blocker（同部位互斥）', () => {
    const markdown = '垫层混凝土强度等级为C15。垫层部位混凝土强度等级为C20。';
    const issues = crossSectionNumericConflictIssues(markdown);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.level).toBe('error');
    expect(issues[0]?.message).toContain('混凝土强度等级');
    // 修复建议不再要求全文单一口径，而是限定同一部位
    expect(issues[0]?.suggestion).toContain('不同部位允许不同规格');
  });

  it('4.19.7 回归：垫层 C20 后「再浇筑C30」属后续工序，不误判为垫层两套口径（F14c）', () => {
    // 丰乐镇第三轮实测：「垫层，再浇筑C30、垫层采用100厚C20」——C30 是垫层之上构件的
    // 混凝土，20 字窗口无法区分工序，旧逻辑把 C30 误绑为垫层口径与 C20 互斥
    const markdown = '垫层采用100厚C20混凝土浇筑，垫层，再浇筑C30混凝土。';
    expect(crossSectionNumericConflictIssues(markdown)).toEqual([]);
  });

  it('4.19.7 回归：垫层本部位两套标号仍报（工序豁免不放过真矛盾）', () => {
    const markdown = '垫层采用100厚C20混凝土浇筑。垫层混凝土强度等级为C25。';
    const issues = crossSectionNumericConflictIssues(markdown);
    expect(issues.some(issue => /垫层混凝土强度等级/u.test(issue.message))).toBe(true);
  });

  it('外墙 A5.0 + 内墙 A3.5（砌块）→ 0 冲突（内外墙部位区分，长词优先命中）', () => {
    const markdown = '外墙砌块强度等级为A5.0。内墙砌块强度等级为A3.5。';
    expect(crossSectionNumericConflictIssues(markdown)).toEqual([]);
  });

  it('外墙 A5.0 + 外墙 A3.5 → 1 blocker（同部位互斥）', () => {
    const markdown = '外墙砌块强度等级为A5.0。外墙砌块强度等级为A3.5。';
    expect(crossSectionNumericConflictIssues(markdown)).toHaveLength(1);
  });

  it('XPS 屋面 50mm + 墙面 130mm → 0 冲突（number 类跨部位豁免）', () => {
    const markdown = '屋面采用50mm厚挤塑聚苯板。墙面采用130mm厚挤塑聚苯板。';
    expect(crossSectionNumericConflictIssues(markdown)).toEqual([]);
  });

  it('XPS 屋面 50mm + 屋面 130mm → 1 blocker（number 类同部位互斥）', () => {
    const markdown = '屋面采用50mm厚挤塑聚苯板。屋面另采用130mm厚挤塑聚苯板。';
    expect(crossSectionNumericConflictIssues(markdown)).toHaveLength(1);
  });

  it('灭火器总量 40具（无部位）+ 办公区 4具/库房 2具 → 0 冲突（总量与分区配置属不同口径，F5）', () => {
    // 三句分行：部位词窗口仅扫本行前 16 字符，不分行会让「办公区」串进「库房」窗口
    const markdown = '现场配置干粉灭火器40具。\n办公区配置干粉灭火器4具。\n库房配置干粉灭火器2具。';
    expect(crossSectionNumericConflictIssues(markdown)).toEqual([]);
  });

  it('无部位标注的灭火器 40具 vs 4具 → 1 blocker（同组互斥）', () => {
    const markdown = '现场配置干粉灭火器40具。另配置干粉灭火器4具。';
    expect(crossSectionNumericConflictIssues(markdown)).toHaveLength(1);
  });

  it('灭火器型号 MF/ABC4（型号数字无数词「具」）→ 不采池，不产生虚假冲突（F5）', () => {
    const markdown = '现场配置干粉灭火器40具，型号为MF/ABC4。';
    expect(crossSectionNumericConflictIssues(markdown)).toEqual([]);
  });

  it('并列枚举「50mm/70mm」→ 不判冲突（同句多规格正常枚举，ENUMERATION_VALUE_RE 豁免）', () => {
    const markdown = '屋面采用50mm/70mm厚挤塑聚苯板。';
    expect(crossSectionNumericConflictIssues(markdown)).toEqual([]);
  });

  it('否定声明句豁免：一致性声明句内数值不入口径池', () => {
    const markdown = '现场统一配置40具干粉灭火器，本章不再出现“灭火器4具”等不一致表述。';
    expect(crossSectionNumericConflictIssues(markdown)).toEqual([]);
  });
});

// ═══════ F14 规格写错部位检测（specLocationMismatchIssues） ═══════

describe('specLocationMismatchIssues 规格错位检测（F14）', () => {
  function authorityMap(): SpecAuthorityMap {
    return {
      混凝土强度等级: [
        { location: '垫层', spec: 'C15', quantity: '125.80m3', sourceFile: '清单.xls' },
        { location: '基础', spec: 'C30', quantity: '86.40m3', sourceFile: '清单.xls' },
        { location: '梁板柱', spec: 'C35', quantity: '300m3', sourceFile: '清单.xls' },
      ],
    };
  }

  it('正文「垫层 C35」vs 权威 C15 → 1 blocker（规格写错部位）', () => {
    const markdown = '垫层采用C35商品混凝土浇筑，浇筑完成后及时养护。';
    const issues = specLocationMismatchIssues(markdown, authorityMap());
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('规格错位');
    expect(issues[0]?.message).toContain('C35');
  });

  it('正文「垫层 C15」与权威一致 → 0', () => {
    const markdown = '垫层采用C15商品混凝土浇筑，浇筑完成后及时养护。';
    expect(specLocationMismatchIssues(markdown, authorityMap())).toEqual([]);
  });

  it('正文「基础 C30」「梁板柱 C35」与权威一致 → 0', () => {
    const markdown = '基础采用C30商品混凝土浇筑。梁板柱采用C35商品混凝土浇筑。';
    expect(specLocationMismatchIssues(markdown, authorityMap())).toEqual([]);
  });

  it('权威映射缺失（无清单项目）→ 静默跳过不误伤', () => {
    expect(specLocationMismatchIssues('垫层采用C15商品混凝土。', undefined)).toEqual([]);
  });

  it('单 placement 维度 → 跳过（无多规格对照价值）', () => {
    const map: SpecAuthorityMap = {
      混凝土强度等级: [{ location: '垫层', spec: 'C15', quantity: '', sourceFile: '清单.xls' }],
    };
    expect(specLocationMismatchIssues('垫层采用C35商品混凝土。', map)).toEqual([]);
  });

  it('规格类型不可推导（「商品混凝土」非 C/M/P 型）→ 跳过', () => {
    const map: SpecAuthorityMap = {
      混凝土种类: [
        { location: '垫层', spec: '商品混凝土', quantity: '', sourceFile: '清单.xls' },
        { location: '基础', spec: '防水混凝土', quantity: '', sourceFile: '清单.xls' },
      ],
    };
    expect(specLocationMismatchIssues('垫层采用水下混凝土。', map)).toEqual([]);
  });

  it('类型隔离：混凝土维度只比对 C 标号，不误报「垫层…HRB400 钢筋」', () => {
    const markdown = '垫层内配置HRB400钢筋，混凝土强度等级为C15。';
    expect(specLocationMismatchIssues(markdown, authorityMap())).toEqual([]);
  });

  function thicknessMap(): SpecAuthorityMap {
    return {
      厚度规格: [
        { location: '有梁板', spec: '120mm', quantity: '300m2', sourceFile: '清单.xls' },
        { location: '栏板', spec: '150mm', quantity: '', sourceFile: '清单.xls' },
        { location: '栏板', spec: '200mm', quantity: '', sourceFile: '清单.xls' },
        { location: '垫层', spec: '200mm', quantity: '', sourceFile: '清单.xls' },
        { location: '人工清底', spec: '300mm', quantity: '', sourceFile: '清单.xls' },
      ],
      混凝土强度等级: [
        { location: '垫层', spec: 'C20', quantity: '', sourceFile: '清单.xls' },
        { location: '基础', spec: 'C30', quantity: '', sourceFile: '清单.xls' },
      ],
    };
  }

  it('4.19.7 回归：垫层「再浇筑C30」属后续工序，不判垫层规格错位（F14c 同步）', () => {
    // 丰乐镇第三轮实测：「铺设级配碎石垫层，再浇筑C30水泥混凝土基层」——C30 是基层的
    // 混凝土，40 字窗口无法区分工序，旧逻辑误判为垫层口径与权威 C20 不一致
    const markdown = '先完成场地清理，铺设级配碎石垫层，再浇筑C30水泥混凝土基层。';
    expect(specLocationMismatchIssues(markdown, thicknessMap())).toEqual([]);
  });

  it('4.19.7 回归：浇筑分层厚度500mm是工艺参数，不判有梁板/栏板厚度错位（F14d）', () => {
    // 「浇筑时分层厚度不大于500mm」的 500mm 是浇筑分层厚度工艺参数，非构件厚度规格
    const markdown = '独立基础、有梁板及栏板均采用C30商品砼，浇筑时分层厚度不大于500mm，插入式振捣棒快插慢拔。';
    expect(specLocationMismatchIssues(markdown, thicknessMap())).toEqual([]);
  });

  it('4.19.7 回归：焊缝高度4mm是焊接参数，不判栏板厚度错位（F14d）', () => {
    const markdown = '栏板与立柱采用焊接连接，焊缝高度不小于4mm，焊后清除焊渣并涂刷防锈漆两遍。';
    expect(specLocationMismatchIssues(markdown, thicknessMap())).toEqual([]);
  });

  it('4.19.7 回归：两侧各200mm工作宽度是作业空间，不判人工清底厚度错位（F14e）', () => {
    const markdown = '沟槽开挖采用挖掘机配合人工清底，槽底宽度按管外径加两侧各200mm工作宽度控制。';
    expect(specLocationMismatchIssues(markdown, thicknessMap())).toEqual([]);
  });

  it('4.19.7 回归：有梁板厚度分别为200mm、150mm是多部位枚举，不判错位（F14d）', () => {
    const markdown = '有梁板厚度分别为200mm、150mm、200mm，栏板厚度150mm及200mm。';
    expect(specLocationMismatchIssues(markdown, thicknessMap())).toEqual([]);
  });

  it('4.19.7 回归：有梁板单一厚度200mm 与权威120mm 不符仍报（豁免不放过真错位）', () => {
    const markdown = '有梁板厚度为200mm，模板体系采用木胶合板模板。';
    const issues = specLocationMismatchIssues(markdown, thicknessMap());
    expect(issues.some(issue => /有梁板/u.test(issue.message))).toBe(true);
  });

  it('4.19.7 回归：同维度混装不同类型 placement → pattern 按本 placement 推导，不跨类型误比对', () => {
    // 丰乐镇第三轮验收实测：「有梁板」权威 120mm（板厚）与 C 标号维度混装时，
    // 旧逻辑用维度首 placement 的 C 标号 pattern 扫描「有梁板」附近正文，
    // 把强度等级 C30 误判为与权威 120mm 不一致（实为两类规格，本无矛盾）
    const map: SpecAuthorityMap = {
      混凝土强度等级: [
        { location: '垫层', spec: 'C20', quantity: '', sourceFile: '清单.xls' },
        { location: '有梁板', spec: '120mm', quantity: '', sourceFile: '清单.xls' },
        { location: '栏板', spec: '150mm', quantity: '', sourceFile: '清单.xls' },
      ],
    };
    const markdown = '有梁板采用C30混凝土浇筑，板厚120mm。';
    expect(specLocationMismatchIssues(markdown, map)).toEqual([]);
  });

  it('4.19.7 回归：同类型规格错位仍报（C 标号写错部位检测不受影响）', () => {
    const map: SpecAuthorityMap = {
      混凝土强度等级: [
        { location: '垫层', spec: 'C20', quantity: '', sourceFile: '清单.xls' },
        { location: '有梁板', spec: '120mm', quantity: '', sourceFile: '清单.xls' },
      ],
    };
    // 垫层权威 C20，正文写 C25 → 同类型错位仍报
    const markdown = '垫层采用C25商品混凝土。';
    const issues = specLocationMismatchIssues(markdown, map);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('规格错位');
  });

  it('4.19.9 回归：「分别用于」前文枚举声明，后文窗口等级标号不判垫层错位（F14d 前文回溯）', () => {
    // 丰乐镇第五轮实测：「水泥混凝土按C30、C25、C20三个强度等级分别用于道路面层、涵头及管道基础、
    // 垫层部位，质检员逐车核查发货单标注强度等级与浇筑部位对应关系，C30混凝土坍落度按1…」
    // 的 C30 在「垫层」后 40 字窗口内，但「分别用于」声明在前文——后文等级标号属部位对应关系说明
    const markdown = '水泥混凝土按C30、C25、C20三个强度等级分别用于道路面层、涵头及管道基础、垫层部位，质检员逐车核查发货单标注强度等级与浇筑部位对应关系，C30混凝土坍落度按10~30mm控制。';
    expect(specLocationMismatchIssues(markdown, thicknessMap())).toEqual([]);
  });

  it('4.19.9 回归：槽底预留200mm厚土体是工序工艺参数，不判人工清底规格错位（F14d 预留）', () => {
    // 丰乐镇第五轮实测：「沟槽开挖采用挖掘机配合人工清底，槽底预留200mm厚土体由人工修整至设计标高」
    // 的 200mm 是预留土层厚度工序参数，与清单权威 300mm 清底规格属不同概念
    // 丰乐镇第五轮实测：厚度维度多个 placement（有梁板 120/栏板 150/垫层 200/人工清底 300），
    // 正文「槽底预留200mm」被通用 mm pattern 捕获（found=200 ∉ 权威 {300}），若无「预留」豁免
    // 将误报——单 placement fixture 会因「维度少于 2 个 placement 直接跳过」而假绿，故多 placement 复现
    const map: SpecAuthorityMap = {
      厚度规格: [
        { location: '有梁板', spec: '120mm', quantity: '', sourceFile: '清单.xls' },
        { location: '栏板', spec: '150mm', quantity: '', sourceFile: '清单.xls' },
        { location: '垫层', spec: '200mm', quantity: '', sourceFile: '清单.xls' },
        { location: '人工清底', spec: '300mm', quantity: '', sourceFile: '清单.xls' },
      ],
    };
    const markdown = '沟槽开挖采用0.6～1.0m³挖掘机配合人工清底，槽底预留200mm厚土体由人工修整至设计标高。';
    expect(specLocationMismatchIssues(markdown, map)).toEqual([]);
  });

  it('r28c 回归：栏板「固定件间距不大于500mm」是排布间距参数，不判栏板厚度错位（间距豁免）', () => {
    // 第四轮审计唯一 blocker 原文：「…固定横杆与栏板…横杆水平度偏差不超过5mm，栏板固定件
    // 间距不大于500mm」——500mm 是固定件排布间距（构件间关系参数），清单「栏板」权威为板厚
    // 150mm/200mm，间距与规格属不同概念，40 字窗口误绑必须豁免（前句 5mm 偏差值由 r12 公差豁免）
    const markdown = '立杆安装完成后固定横杆与栏板，横杆水平度偏差不超过5mm，栏板固定件间距不大于500mm，最后对围栏整体线形进行调整。';
    expect(specLocationMismatchIssues(markdown, thicknessMap())).toEqual([]);
  });

  it('r28c 回归：间距词族（中心距/间距为）与多间距词并列（间距、排距均）均豁免', () => {
    // 间距概念词族覆盖紧凑连接词形态；并列取最后一个间距词（「排距」）仍豁免（词间顿号不阻断）
    const markdown = '栏板中心距不大于500mm；栏板间距为500mm，栏板固定件间距、排距均不大于500mm。';
    expect(specLocationMismatchIssues(markdown, thicknessMap())).toEqual([]);
  });

  it('r28c 回归：真错位「栏板厚度500mm」不因间距豁免放过（豁免边界守护）', () => {
    // 无间距概念词时的板材规格错位仍报（「栏板」权威 150mm/200mm，正文写 500mm 属真错位）
    const markdown = '栏板厚度500mm，采用C30商品砼浇筑。';
    const issues = specLocationMismatchIssues(markdown, thicknessMap());
    expect(issues.some(issue => /栏板/u.test(issue.message))).toBe(true);
  });
});

// ═══════ F6 劳动力口径隔离（resourceConsistencyIssues） ═══════
// 历史缺陷：管理口径（18人）与全员峰值（286人）、不同工种（钢筋工60/木工80）被当同口径互斥误报；
// 改造后仅同组互查：管理 vs 管理、同工种 vs 同工种、峰值 vs 峰值。

describe('resourceConsistencyIssues 管理/全员/工种口径隔离（F6）', () => {
  it('管理人员 18人 vs 高峰期 286人 → 0 冲突（管理 vs 全员不同口径）', () => {
    const markdown = '项目部管理人员及施工人员约18人。施工高峰期投入全员286人。';
    expect(resourceConsistencyIssues(markdown)).toEqual([]);
  });

  it('钢筋工 60人 vs 木工 80人 → 0 冲突（不同工种不同口径）', () => {
    const markdown = '劳动力配置钢筋工60人。劳动力配置木工80人。';
    expect(resourceConsistencyIssues(markdown)).toEqual([]);
  });

  it('钢筋工 60人 vs 钢筋工 90人 → 1 blocker（同工种两套口径互斥）', () => {
    const markdown = '劳动力配置钢筋工60人。劳动力配置钢筋工90人。';
    const issues = resourceConsistencyIssues(markdown);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('劳动力数据矛盾');
  });

  it('管理人员 18人 vs 管理人员 40人 → 1 blocker（管理组内同口径互查）', () => {
    const markdown = '项目部管理人员及施工人员约18人。项目部管理人员及施工人员约40人。';
    expect(resourceConsistencyIssues(markdown)).toHaveLength(1);
  });

  it('无阶段限定总峰值 180人 vs 阶段峰值 90人 → 0（总人数 ≥ 阶段峰值正常关系，非 F6 场景回归）', () => {
    const markdown = '按施工高峰配置总人数约180人。室外工程阶段高峰90人。';
    expect(resourceConsistencyIssues(markdown)).toEqual([]);
  });

  it('无阶段限定峰值 180人 vs 286人 → 1 blocker（同组同口径互斥，非 F6 场景回归）', () => {
    const markdown = '施工高峰期投入约180人。施工高峰时段达286人。';
    expect(resourceConsistencyIssues(markdown)).toHaveLength(1);
  });
});

// ═══════ F15 修复器不跨部位归一（applyNumericConsistencyDeterministicFixes） ═══════

describe('applyNumericConsistencyDeterministicFixes 部位豁免（F15）', () => {
  it('分区配置 4具/2具与总量 40具 均不与权威 40 矛盾 → 零修复（不把分区归一成总量）', () => {
    const markdown = '办公区配置干粉灭火器4具。\n生活区配置干粉灭火器2具。\n全场合计配置灭火器40具。';
    const result = applyNumericConsistencyDeterministicFixes(markdown, { authorityIndex: fixtureIndex({ equipment: [{ label: '干粉灭火器', value: 40 }] }) });
    expect(result.fixedCount).toBe(0);
    expect(result.markdown).toContain('办公区配置干粉灭火器4具');
    expect(result.markdown).toContain('生活区配置干粉灭火器2具');
  });

  it('无部位标注的 30具 与权威 40 矛盾 → 仅替换无部位值，分区 4具 保留', () => {
    const markdown = '全场配置灭火器30具，办公区配置灭火器4具。';
    const result = applyNumericConsistencyDeterministicFixes(markdown, { authorityIndex: fixtureIndex({ equipment: [{ label: '干粉灭火器', value: 40 }] }) });
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toContain('全场配置灭火器40具');
    expect(result.markdown).toContain('办公区配置灭火器4具');
  });

  it('权威缺失 → 零修复', () => {
    const markdown = '全场配置灭火器30具。';
    const result = applyNumericConsistencyDeterministicFixes(markdown, {});
    expect(result.fixedCount).toBe(0);
  });
});

// ═══════ P1 劳动力矛盾检测回归（评分报告「20人 vs 86人」漏检根因治理） ═══════

describe('resourceConsistencyIssues 评分报告 P1 回归', () => {
  it('「按高峰期总人数20人配置专职安全员2名」的 20 入 peak 组（安全员属后一个数字，不再误划管理组）', () => {
    const markdown = '按高峰期总人数20人配置专职安全员2名。施工高峰期投入86人。';
    const issues = resourceConsistencyIssues(markdown);
    expect(issues.some(issue => issue.message.includes('劳动力数据矛盾') && issue.message.includes('互斥'))).toBe(true);
  });

  it('箭头链「32人→86人→48人」只取链上峰值 86，链内低峰阶段值不互相误报', () => {
    expect(resourceConsistencyIssues('劳动力按32人→86人→48人分阶段投入。')).toEqual([]);
  });

  it('箭头链峰值 86 vs 正文总人数 20 → 报互斥（评分报告 P1 核心矛盾）', () => {
    const markdown = '按施工高峰配置总人数约20人。劳动力按32人→86人→48人分阶段投入。';
    const issues = resourceConsistencyIssues(markdown);
    expect(issues.some(issue => issue.message.includes('互斥'))).toBe(true);
  });

  it('语境词前的管理口径不参与链计算（18 入管理组 + 箭头链峰值 86 入 peak 组）', () => {
    const markdown = '项目部管理人员及施工人员18人，劳动力按32人→86人→48人分阶段投入。项目部管理人员及施工人员约40人。';
    const issues = resourceConsistencyIssues(markdown);
    // 管理组 18 vs 40 互查命中（若 18 被链吞掉则漏报）
    expect(issues.some(issue => issue.message.includes('18') && issue.message.includes('40'))).toBe(true);
  });

  it('P1 多链同行：同一行两条阶段链独立入池（第二链峰值与同阶段宣称冲突可报）', () => {
    const markdown = '地下结构阶段劳动力按32人→86人→48人分阶段投入；装饰装修阶段20人→50人→30人分阶段投入。\n装饰装修阶段高峰人数约30人。';
    const issues = resourceConsistencyIssues(markdown);
    // 装饰装修阶段链峰值 50 与同阶段宣称 30 互斥（仅处理首链则第二链静默漏检）
    expect(issues.some(issue => issue.message.includes('50') && issue.message.includes('30') && /互斥/u.test(issue.message))).toBe(true);
  });

  it('阶段劳动力形态（无高峰词）提取入池：跨阶段 20 vs 300 → 不报', () => {
    expect(resourceConsistencyIssues('装饰装修阶段投入20人。主体结构阶段约300人。')).toEqual([]);
  });

  it('阶段劳动力形态同阶段互斥：装饰装修 20 vs 300 → 报', () => {
    const issues = resourceConsistencyIssues('装饰装修阶段投入20人。装饰装修阶段高峰期约300人。');
    expect(issues.some(issue => /互斥/u.test(issue.message))).toBe(true);
  });

  it('模式 7：宣称总人数 20 与班组加总算式 27 同句自相矛盾 → 报', () => {
    const markdown = '道路浇筑班组投入20人，班组加总道路浇筑8＋铺装6＋排水沟砌筑5＋机动2×4=27人。';
    const issues = resourceConsistencyIssues(markdown);
    expect(issues.some(issue => issue.message.includes('班组加总'))).toBe(true);
  });

  it('模式 7：算式左侧求和 ≠ 结果 → 报（算术层确定性）', () => {
    const markdown = '班组人数按道路浇筑8＋铺装6＋排水沟砌筑5=21人配置。';
    const issues = resourceConsistencyIssues(markdown);
    expect(issues.some(issue => issue.message.includes('左侧求和'))).toBe(true);
  });

  it('模式 7：算式自洽且无宣称冲突 → 零报告', () => {
    expect(resourceConsistencyIssues('班组加总道路浇筑8＋铺装6＋排水沟砌筑5＋机动2×4=27人。')).toEqual([]);
  });

  it('模式 7：近似措辞（约）宣称口径宽容不计入比较', () => {
    expect(resourceConsistencyIssues('投入约20人，班组加总8＋6＋5＋8=27人。')).toEqual([]);
  });

  it('模式 7：算式左侧各项带“人”字仍参与求和（修复静默漏检）', () => {
    const markdown = '道路浇筑班组投入30人，班组加总道路浇筑8人＋铺装6人＋排水沟砌筑5人=19人。';
    const issues = resourceConsistencyIssues(markdown);
    // 左侧各项以“人”结尾时原实现取不到末位数字 → 整条算式静默漏检（宣称 30 vs 加总 19 矛盾漏报）
    expect(issues.some(issue => issue.message.includes('班组加总'))).toBe(true);
  });
});

describe('清单红线权威比对（丰乐镇第五版实测 P1 养护期 / P3 路灯）', () => {
  const model = (bills: Array<{ key?: string; fieldName?: string; value: string }> = [], billItemFacts: Array<{ key?: string; fieldName?: string; value: string }> = []) => ({
    project: [], schedule: [], quality: [], safety: [], resources: [], tables: [], bills,
    drawings: [], rules: [], specifications: [], schemaFacts: {}, factIndex: {}, missing: [], conflicts: [], preciseFacts: [], billItemFacts,
  }) as unknown as DocumentFactsModel;

  describe('extractGreeningMaintenanceAuthority（清单养护期权威提取）', () => {
    it('清单条目「二级养护，养护两年」→ 2', () => {
      expect(extractGreeningMaintenanceAuthority(model([{ fieldName: '喷播植草（灌木）籽', value: '二级养护，养护两年' }]))).toBe(2);
    });

    it('阿拉伯数字「养护2年」→ 2', () => {
      expect(extractGreeningMaintenanceAuthority(model([{ fieldName: '草坪养护', value: '养护2年' }]))).toBe(2);
    });

    it('label 含完整短语（绿化养护期两年）→ 2', () => {
      expect(extractGreeningMaintenanceAuthority(model([{ fieldName: '绿化养护期两年', value: '按规范执行' }]))).toBe(2);
    });

    it('清单行级条目（billItemFacts）特征描述「养护两年｜工程量」→ 2（数据源补齐）', () => {
      expect(extractGreeningMaintenanceAuthority(model([], [{ key: '清单条目：喷播植草（灌木）籽', fieldName: '清单条目', value: '二级养护，养护两年｜工程量：2860m2' }]))).toBe(2);
    });

    it('天单位养护（混凝土养护14天）不采 → undefined', () => {
      expect(extractGreeningMaintenanceAuthority(model([{ fieldName: '混凝土', value: '养护14天' }]))).toBeUndefined();
    });

    it('无养护期事实 → undefined', () => {
      expect(extractGreeningMaintenanceAuthority(model([]))).toBeUndefined();
    });

    it('混合口径频率投票：两年 3 条 vs 一年 1 条 → 2（丰乐镇实测红花酢浆草一年为个别条目，不得升格为全文权威）', () => {
      const facts = [
        { fieldName: '喷播植草（灌木）籽', value: '二级养护，养护两年' },
        { fieldName: '紫花地丁', value: '二级养护，养护两年' },
        { fieldName: '白三叶', value: '二级养护，养护两年' },
        { fieldName: '红花酢浆草', value: '二级养护，养护一年' },
      ];
      expect(extractGreeningMaintenanceAuthority(model(facts))).toBe(2);
    });

    it('混合口径并列时取大值（两年与一年各 1 条 → 2，投标口径更安全）', () => {
      const facts = [
        { fieldName: '红花酢浆草', value: '二级养护，养护一年' },
        { fieldName: '喷播植草（灌木）籽', value: '二级养护，养护两年' },
      ];
      expect(extractGreeningMaintenanceAuthority(model(facts))).toBe(2);
    });

    it('同一条事实含多处养护期描述全部计入投票', () => {
      const facts = [{ fieldName: '绿化养护汇总', value: '红花酢浆草养护一年，其余苗木养护两年，草籽养护两年' }];
      expect(extractGreeningMaintenanceAuthority(model(facts))).toBe(2);
    });

    it('跨源优先级保留：bills 命中即权威（不采 billItemFacts 更晚值）', () => {
      const facts = model(
        [{ fieldName: '绿化养护', value: '二级养护，养护两年' }],
        [{ key: '清单条目：红花酢浆草', fieldName: '清单条目', value: '二级养护，养护一年｜工程量：90m2' }],
      );
      expect(extractGreeningMaintenanceAuthority(facts)).toBe(2);
    });

    it('清单行级条目源内投票：两年 3 条 vs 一年 1 条 → 2（丰乐镇清单条目分布）', () => {
      const itemFacts = [
        { key: '清单条目：喷播植草（灌木）籽', fieldName: '清单条目', value: '二级养护，养护两年｜工程量：19400m2' },
        { key: '清单条目：红花酢浆草', fieldName: '清单条目', value: '二级养护，养护一年｜工程量：90m2' },
        { key: '清单条目：紫花地丁', fieldName: '清单条目', value: '二级养护，养护两年｜工程量：5000m2' },
        { key: '清单条目：白三叶', fieldName: '清单条目', value: '二级养护，养护两年｜工程量：3000m2' },
      ];
      expect(extractGreeningMaintenanceAuthority(model([], itemFacts))).toBe(2);
    });
  });

  describe('greeningMaintenanceMismatchIssues（正文 vs 清单红线）', () => {
    it('清单养护两年 × 正文二级养护一年 → blocker（评分报告 P1）', () => {
      const issues = greeningMaintenanceMismatchIssues('绿化工程二级养护一年，养护期满后移交。', model([{ fieldName: '喷播植草（灌木）籽', value: '二级养护，养护两年' }]));
      expect(issues).toHaveLength(1);
      expect(issues[0]?.severity).toBe('blocker');
      expect(issues[0]?.message).toContain('绿化养护期');
    });

    it('正文养护两年与清单一致 → 零报告', () => {
      expect(greeningMaintenanceMismatchIssues('绿化工程二级养护两年。', model([{ fieldName: '喷播植草（灌木）籽', value: '二级养护，养护两年' }]))).toEqual([]);
    });

    it('无清单养护期事实 → 零报告（不误伤无清单项目）', () => {
      expect(greeningMaintenanceMismatchIssues('绿化工程二级养护一年。', model([]))).toEqual([]);
    });

    it('正文无养护期表述 → 零报告', () => {
      expect(greeningMaintenanceMismatchIssues('绿化工程按设计施工。', model([{ fieldName: '喷播植草（灌木）籽', value: '二级养护，养护两年' }]))).toEqual([]);
    });

    it('否定声明句豁免：修复轮「统一为两年，不再出现养护一年」→ 零报告（防死循环）', () => {
      expect(greeningMaintenanceMismatchIssues('绿化养护期统一为两年，本章不再出现养护一年等矛盾表述。', model([{ fieldName: '喷播植草（灌木）籽', value: '二级养护，养护两年' }]))).toEqual([]);
    });
  });

  describe('extractStreetLightAuthority（清单路灯数量权威提取）', () => {
    it('清单路灯多行 103套+15套 → 118', () => {
      expect(extractStreetLightAuthority(model([
        { fieldName: '太阳能路灯', value: '103套' },
        { fieldName: '太阳能路灯', value: '15套' },
      ]))).toBe(118);
    });

    it('清单单位「盏」→ 118（照明工程标准单位兑底）', () => {
      expect(extractStreetLightAuthority(model([
        { fieldName: '太阳能路灯', value: '103盏' },
        { fieldName: '太阳能路灯', value: '15盏' },
      ]))).toBe(118);
    });

    it('行级条目「｜工程量：103套」段提取，特征描述「套」字样不误采 → 103', () => {
      expect(extractStreetLightAuthority(model([], [
        { key: '清单条目：太阳能路灯', fieldName: '清单条目', value: '1.灯杆高4.5m，含基础，防护等级IP65｜工程量：103套' },
      ]))).toBe(103);
    });

    it('行级条目与散装事实同源重复 → 分层取用只计一次（118 非 236）', () => {
      expect(extractStreetLightAuthority(
        model(
          [{ fieldName: '太阳能路灯', value: '103套' }, { fieldName: '太阳能路灯', value: '15套' }],
          [{ key: '清单条目：太阳能路灯', fieldName: '清单条目', value: '1.灯杆高4.5m｜工程量：103套' }, { key: '清单条目：太阳能路灯', fieldName: '清单条目', value: '1.灯杆高6m｜工程量：15套' }],
        ),
      )).toBe(118);
    });

    it('无路灯条目 → undefined', () => {
      expect(extractStreetLightAuthority(model([{ fieldName: '道路铺装', value: '3800平方米' }]))).toBeUndefined();
    });
  });

  describe('streetLightCountMismatchIssues（正文 vs 清单红线）', () => {
    it('清单 118 套 × 正文分型号 17套+3套 → blocker（评分报告 P3）', () => {
      const issues = streetLightCountMismatchIssues('路灯采用100W LED 共17套、120W LED 共3套。', model([
        { fieldName: '太阳能路灯', value: '103套' },
        { fieldName: '太阳能路灯', value: '15套' },
      ]));
      expect(issues).toHaveLength(1);
      expect(issues[0]?.severity).toBe('blocker');
      expect(issues[0]?.message).toContain('路灯数量');
    });

    it('正文分型号 103+15 与清单一致 → 零报告', () => {
      expect(streetLightCountMismatchIssues('路灯共103套、庭院路灯15套。', model([
        { fieldName: '太阳能路灯', value: '103套' },
        { fieldName: '太阳能路灯', value: '15套' },
      ]))).toEqual([]);
    });

    it('正文单值 118 套 → 零报告', () => {
      expect(streetLightCountMismatchIssues('路灯共118套。', model([{ fieldName: '太阳能路灯', value: '118套' }]))).toEqual([]);
    });

    it('清单单位盏 × 正文套一致 → 零报告（跨单位同口径）', () => {
      expect(streetLightCountMismatchIssues('路灯共118套。', model([
        { fieldName: '太阳能路灯', value: '103盏' },
        { fieldName: '太阳能路灯', value: '15盏' },
      ]))).toEqual([]);
    });

    it('「分批/每批 X 套」批次口径跳过 → 零报告（评分报告正文 366 行形态防误报）', () => {
      expect(streetLightCountMismatchIssues('路灯分2批进场，每批10套。', model([
        { fieldName: '太阳能路灯', value: '103套' },
        { fieldName: '太阳能路灯', value: '15套' },
      ]))).toEqual([]);
    });

    it('否定声明句豁免：修复轮「不再出现路灯17套」→ 零报告（防死循环）', () => {
      expect(streetLightCountMismatchIssues('路灯配置统一按清单执行，不再出现路灯17套等矛盾表述。', model([
        { fieldName: '太阳能路灯', value: '103套' },
        { fieldName: '太阳能路灯', value: '15套' },
      ]))).toEqual([]);
    });

    it('无清单路灯条目 → 零报告', () => {
      expect(streetLightCountMismatchIssues('路灯共17套。', model([]))).toEqual([]);
    });
  });
});

describe('fixQuantityAuthorityConflicts（S5 判定层锚点直连：豁免全废，只做坐标替换）', () => {
  /** 锚点构造：按正文字面值定位坐标（生产由判定层裁决产出；值 == 权威不入候选） */
  function anchorAt(markdown: string, name: string, value: number, authorityValue: number, unit = ''): QuantityConflictAnchor {
    const at = markdown.indexOf(String(value));
    return { name, value, unit, authorityValue, start: at, end: at + String(value).length };
  }

  it('锚点冲突值 → 替换为清单汇总值；未裁决条目不在锚点内 → 不动', () => {
    const markdown = '道路工程主要工程量包括级配碎石基层18949.52m²、水泥混凝土面层18799.52m²。';
    const result = fixQuantityAuthorityConflicts(markdown, [anchorAt(markdown, '级配碎石', 18949.52, 20931.02, 'm²')]);
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toContain('级配碎石基层20931.02m²');
    expect(result.markdown).toContain('水泥混凝土面层18799.52m²');
  });

  it('微漂移（4190.5 vs 4187.38）与大幅漂移（633 vs 2134）均锚点直连校正', () => {
    const micro = '挖一般土方4190.5m³。';
    expect(fixQuantityAuthorityConflicts(micro, [anchorAt(micro, '挖一般土方', 4190.5, 4187.38, 'm³')]).markdown).toContain('挖一般土方4187.38m³');
    const macro = '拆除路面633m²。';
    expect(fixQuantityAuthorityConflicts(macro, [anchorAt(macro, '拆除路面', 633, 2134, 'm²')]).markdown).toContain('拆除路面2134m²');
  });

  it('修复层零豁免：村名/规格前置/表格行/部位语境锚点照常替换（裁决在判定层）', () => {
    const village = '马老郢村路床（槽）碾压检验18429.52m²。';
    expect(fixQuantityAuthorityConflicts(village, [anchorAt(village, '路床(槽)碾压检验', 18429.52, 19930.52, 'm²')]).markdown).toContain('路床（槽）碾压检验19930.52m²');
    const spec = '污水管网包含直径450塑料检查井40座。';
    expect(fixQuantityAuthorityConflicts(spec, [anchorAt(spec, '塑料检查井', 40, 555, '座')]).markdown).toContain('直径450塑料检查井555座');
    const table = '| 方岗段 | 道路、铺装 | 路床碾压1436.4m² |';
    const at = table.indexOf('1436.4');
    expect(fixQuantityAuthorityConflicts(table, [{ name: '路床(槽)碾压检验', value: 1436.4, unit: 'm²', authorityValue: 19930.52, start: at, end: at + '1436.4'.length }]).markdown).toContain('19930.52');
    const part = '生态池外围栽植色带90m²，配套金属扶手、栏杆、栏板224m。';
    expect(fixQuantityAuthorityConflicts(part, [anchorAt(part, '栽植色带', 90, 552, 'm²')]).markdown).toContain('栽植色带552m²');
  });

  it('名称后其他单位数值不受影响（级配碎石基层（厚度15cm）共18949.52m²）', () => {
    const markdown = '级配碎石基层（厚度15cm）共18949.52m²。';
    const result = fixQuantityAuthorityConflicts(markdown, [anchorAt(markdown, '级配碎石', 18949.52, 20931.02, 'm²')]);
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toContain('厚度15cm');
    expect(result.markdown).toContain('共20931.02m²');
  });

  it('锚点名称与正文无关也照替换（名称仅作修复说明，无名称弹性匹配）', () => {
    const markdown = '本分项工程量为：塑料管铺设8205.53m。';
    const result = fixQuantityAuthorityConflicts(markdown, [anchorAt(markdown, '塑料管', 8205.53, 7525.01, 'm')]);
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toContain('塑料管铺设7525.01m');
    expect(result.details[0]).toContain('塑料管 ');
  });

  it('无锚点/空锚点 → 零改动零统计', () => {
    const markdown = '级配碎石基层18949.52m²。';
    expect(fixQuantityAuthorityConflicts(markdown, [])).toEqual({ markdown, fixedCount: 0, details: [] });
    expect(fixQuantityAuthorityConflicts(markdown).markdown).toBe(markdown);
  });
});

describe('fixParagraphOpeningRepeats（B1 段首机械重复确定性修复）', () => {
  it('同构段首句重复 4 段 → 首现保留、后续剥离公共前缀到冒号边界', () => {
    const opening = '招标要求响应（前附表响应条款）：计划开工日期：';
    const markdown = [
      `${opening}2026年9月1日，计划竣工日期：2027年3月31日。`,
      `${opening}2026年9月2日，计划竣工日期：2027年4月30日。`,
      `${opening}2026年9月3日，计划竣工日期：2027年5月31日。`,
      `${opening}2026年9月4日，计划竣工日期：2027年6月30日。`,
    ].join('\n');
    const result = fixParagraphOpeningRepeats(markdown);
    expect(result.fixedCount).toBe(3);
    // 固定开场前缀只剩首现段一处
    expect((result.markdown.match(/招标要求响应（前附表响应条款）：/gu) || []).length).toBe(1);
    // 后续段保留差异化正文
    expect(result.markdown).toContain('2026年9月2日，计划竣工日期：2027年4月30日。');
    expect(result.markdown).toContain('2026年9月4日，计划竣工日期：2027年6月30日。');
  });

  it('段首句完全相同（剥离后无差异正文）→ 零改动', () => {
    const sentence = '本工程严格按照施工组织设计组织施工，确保工程质量合格。';
    const markdown = Array.from({ length: 4 }, () => sentence).join('\n');
    const result = fixParagraphOpeningRepeats(markdown);
    expect(result.fixedCount).toBe(0);
    expect(result.markdown).toBe(markdown);
  });

  it('同构段首句仅 2 段 → 不触发（重复组阈值 3）', () => {
    const opening = '招标要求响应（前附表响应条款）：计划开工日期：';
    const markdown = [
      `${opening}2026年9月1日，计划竣工日期：2027年3月31日。`,
      `${opening}2026年9月2日，计划竣工日期：2027年4月30日。`,
    ].join('\n');
    const result = fixParagraphOpeningRepeats(markdown);
    expect(result.fixedCount).toBe(0);
  });

  it('短句（不足 18 字）不参与提取 → 不动', () => {
    const markdown = [
      '本工程按期开工。',
      '本工程按期开工。',
      '本工程按期开工。',
    ].join('\n');
    const result = fixParagraphOpeningRepeats(markdown);
    expect(result.fixedCount).toBe(0);
  });
});

describe('fixTruncatedSentenceArtifacts（B2 截断句残留确定性修复）', () => {
  it('列表引导句双重冒号与列表项行尾冒号残留收敛', () => {
    const markdown = [
      '**编制依据**：招标文件与补疑补遗按以下类别列出： ：',
      '- 招标文件及补疑补遗：招标文件、答疑纪要、补疑补遗文件；：',
      '施工方案。：详见施工组织设计。',
    ].join('\n');
    const result = fixTruncatedSentenceArtifacts(markdown);
    expect(result.fixedCount).toBe(3);
    expect(result.markdown).not.toContain('： ：');
    expect(result.markdown).not.toContain('；：');
    expect(result.markdown).not.toContain('。：');
    expect(result.markdown).not.toContain('：：');
    expect(result.markdown).toContain('按以下类别列出：');
    expect(result.markdown).toContain('补疑补遗文件；');
  });

  it('无残留 → 零改动', () => {
    const markdown = ['编制依据：招标文件。', '- 招标文件及补疑补遗：招标文件。'].join('\n');
    const result = fixTruncatedSentenceArtifacts(markdown);
    expect(result).toEqual({ markdown, fixedCount: 0, details: [] });
  });

  it('句号+分号/逗号叠用（十度实测「销项。；污水」形态）→ 收敛为句号', () => {
    const markdown = '整改结果由项目经理复查确认后闭合。；污水管网工程阶段同时安排土方开挖。；。；';
    const result = fixTruncatedSentenceArtifacts(markdown);
    expect(result.markdown).not.toContain('。；');
    expect(result.markdown).not.toContain('；。');
    expect(result.fixedCount).toBeGreaterThan(0);
  });

  it('连续句号（省略号误写形态）→ 收敛为省略号', () => {
    const markdown = '复查并销项。。。踏勘发现，各自然村内部道路宽度普遍在2.5m左右。';
    const result = fixTruncatedSentenceArtifacts(markdown);
    expect(result.markdown).toContain('销项……踏勘发现');
    expect(result.markdown).not.toContain('。。');
  });

  it('r15 丰乐镇 B2：段落行尾分号 + 下一行列表项 → 分号改句号（softWrapped 未豁免形态，实况复刻）', () => {
    // r15 实机阻断：土方工程段落行尾「…土壤类别按综合类处理；」+ 下一行「1. 机械开挖…」
    // 被检测器判截断句 blocker（软换行豁免要求下一行为普通正文）；确定性收敛为句号
    const markdown = [
      '土方工程贯穿道路、污水、景观各专业。回填采用分层夯实，每层虚铺厚度不超过0.3m。工序按开挖深度，土壤类别按综合类处理；',
      '1. 机械开挖配合人工清底，槽底预留300mm人工清底；',
      '2. 原土打夯并检测压实度；',
    ].join('\n');
    const result = fixTruncatedSentenceArtifacts(markdown);
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toContain('土壤类别按综合类处理。\n1. 机械开挖');
    // 列表行自身分号收尾属合法形态不被改动
    expect(result.markdown).toContain('槽底预留300mm人工清底；');
  });

  it('r15 B2 边界：行尾分号 + 下一行普通正文（软换行）/下一行标题 均零改动', () => {
    const markdown = [
      '回填采用分层夯实，每层虚铺厚度不超过0.3m；',
      '下一行仍是普通正文续写，不属于列表承启形态。',
      '仅以分号结尾但下一行是小节标题；',
      '###  后续小节',
    ].join('\n');
    const result = fixTruncatedSentenceArtifacts(markdown);
    expect(result.fixedCount).toBe(0);
  });

  it('r28h 归因：并列数值删除残留「、、、、」叠用 → 收敛为单个顿号（r28h2 实测形态）', () => {
    // r28h2 实测「宽度按3m、、、、等设计路幅控制」：并列数值删除后连续顿号直坠终门禁
    //（punctuationArtifactIssues blocker）；收敛为单顿号并幂等（第二遍零命中）
    const markdown = '宽度按3m、、、、等设计路幅控制。';
    const result = fixTruncatedSentenceArtifacts(markdown);
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toContain('宽度按3m、等设计路幅控制。');
    expect(result.markdown).not.toContain('、、');
    expect(fixTruncatedSentenceArtifacts(result.markdown).fixedCount).toBe(0);
  });
});

describe('fixEmbeddedHeadingLines（r28h 行内嵌标题拆行）', () => {
  it('s28h2 实测：正文行尾粘连章标题 → 拆行恢复标题结构', () => {
    const result = fixEmbeddedHeadingLines('（9）发现脏、差，有缺损。## 第九章 确保文明施工的技术组织措施');
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toBe('（9）发现脏、差，有缺损。\n## 第九章 确保文明施工的技术组织措施');
  });

  it('r28h2 实测：段尾粘连 H4 小节标题 → 拆行', () => {
    const result = fixEmbeddedHeadingLines('避免影响村民夜间出行，做好照明设施维护记录。#### 10.2.3 施工便道与居民通行组织');
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toContain('维护记录。\n#### 10.2.3 施工便道与居民通行组织');
  });

  it('同一行多个粘连标题 → 全部拆行且幂等', () => {
    const result = fixEmbeddedHeadingLines('（9）发现脏、差。## 第九章 确保文明施工### 9.1 总体要求');
    expect(result.fixedCount).toBe(2);
    expect(result.markdown).toBe('（9）发现脏、差。\n## 第九章 确保文明施工\n### 9.1 总体要求');
    expect(fixEmbeddedHeadingLines(result.markdown).fixedCount).toBe(0);
  });

  it('零误伤：独立标题/表格行/单井号编号 → 零改动', () => {
    const markdown = [
      '## 第九章 确保文明施工的技术组织措施',
      '| 备注 | 编号#A1 |',
      '混凝土强度等级C30#柱顶标高4.200',
      '验收合格#2机组已并网',
    ].join('\n');
    const result = fixEmbeddedHeadingLines(markdown);
    expect(result).toEqual({ markdown, fixedCount: 0, details: [] });
  });
});

describe('markdownTableQualityIssues 规格型号列「—」豁免（丰乐镇实测：蛙式打夯机无型号，修复轮编造 HW-60）', () => {
  const table = (specValue: string, qtyValue = '1台') => [
    '| 道路工程机械名称 | 规格型号 | 数量 |',
    '| --- | --- | --- |',
    `| 挖掘机 | 0.6~1.0m³ | 1台 |`,
    `| 蛙式打夯机 | ${specValue} | ${qtyValue} |`,
  ].join('\n');

  // 4.55.22 用户口径收紧：**取消规格型号列的破折号豁免**。
  // 原口径（丰乐镇 r28g）：源资料不提供型号时强填会诱导修复轮编造（实测编造出 HW-60），故豁免。
  // 现口径：机械设备由投标人自行选型，**选型结论本身就是必须写出的值**——
  // 且实测该豁免是终稿里唯一的占位来源（巢湖成稿 4 处「—」全在「规格型号」列）。
  it('规格型号列「—」判占位符（用户口径：每格必须有内容且有值）', () => {
    const issues = markdownTableQualityIssues(table('—'));
    expect(issues.some(issue => issue.message.includes('占位符'))).toBe(true);
  });

  it('非规格型号列「—」仍判占位符（如数量列）', () => {
    const issues = markdownTableQualityIssues(table('0.6~1.0m³', '—'));
    expect(issues.some(issue => issue.message.includes('占位符'))).toBe(true);
  });

  it('规格型号列「若干」仍判占位符（只有破折号豁免，模糊词不豁免）', () => {
    const issues = markdownTableQualityIssues(table('若干'));
    expect(issues.some(issue => issue.message.includes('占位符'))).toBe(true);
  });

  // r28g B7 归因（r28f 实测·9 列机械设备附表）：「额定功率/生产能力」同属设备出厂固有参数，
  // 源资料不提供、强填同类诱导编造——与规格型号列同豁免；其余列「—」仍按占位阻断。
  const wideTable = (powerValue: string, qtyValue = '2台') => [
    '| 设备名称 | 规格型号 | 数量 | 额定功率 | 生产能力 |',
    '| --- | --- | --- | --- | --- |',
    '| 挖掘机 | 0.6~1.0m³ | 1台 | 90kW | 120m³/台班 |',
    `| 蛙式打夯机 | — | ${qtyValue} | ${powerValue} | — |`,
  ].join('\n');

  // 4.55.22：额定功率/生产能力列同样取消豁免（与规格型号列同族口径）
  it('额定功率/生产能力列「—」判占位符（用户口径：不得留空）', () => {
    const issues = markdownTableQualityIssues(wideTable('—'));
    expect(issues.some(issue => issue.message.includes('占位符'))).toBe(true);
  });

  it('数量列「—」判占位符', () => {
    const issues = markdownTableQualityIssues(wideTable('90kW', '—'));
    expect(issues.some(issue => issue.message.includes('占位符'))).toBe(true);
  });

  it('额定功率列「若干」仍判占位符（破折号豁免不扩展到模糊词）', () => {
    const issues = markdownTableQualityIssues(wideTable('若干'));
    expect(issues.some(issue => issue.message.includes('占位符'))).toBe(true);
  });

  // D-T5 占位符清零：词形扩围「无」（—/无/待定 数据列全覆盖）+「规格/强度等级」类列破折号豁免锁定
  it('D-T5 扩围：非豁免列「无」判占位符（r28f #42 词形差归因：警告层有「无」而阻断层缺）', () => {
    const issues = markdownTableQualityIssues(table('0.6~1.0m³', '无'));
    expect(issues.some(issue => issue.message.includes('占位符'))).toBe(true);
  });

  it('规格型号列「无」判占位符（与「若干」同口径）', () => {
    const issues = markdownTableQualityIssues(table('无'));
    expect(issues.some(issue => issue.message.includes('占位符'))).toBe(true);
  });

  // 4.55.22：清单表「规格/强度等级」列的破折号同样不再豁免——规格必须写清单/图纸给出的具体值
  it('「规格/强度等级」列「—」判占位符（清单已给出规格，无留空理由）', () => {
    const table = [
      '| 物资名称 | 规格/强度等级 | 单位 | 数量 |',
      '| --- | --- | --- | --- |',
      '| 塑料检查井 | — | 座 | 555 |',
    ].join('\n');
    const issues = markdownTableQualityIssues(table);
    expect(issues.some(issue => issue.message.includes('占位符'))).toBe(true);
  });
});

describe('applyNumericConsistencyDeterministicFixes（D2 劳动力峰值零漂移豁免）', () => {
  it('微漂移 199 vs 176（11.6%）确定性替换（30% 豁免移除回归）', () => {
    const result = applyNumericConsistencyDeterministicFixes('施工高峰期投入199人。', { laborPeakAuthority: 176 });
    expect(result.fixedCount).toBeGreaterThan(0);
    expect(result.markdown).toContain('176人');
    expect(result.markdown).not.toContain('199人');
  });
  it('微漂移 180 vs 176（2.2%）同样替换', () => {
    const result = applyNumericConsistencyDeterministicFixes('高峰期约180人。', { laborPeakAuthority: 176 });
    expect(result.markdown).toContain('176人');
  });
  it('阶段限定明细（22人）不与权威互比，保留；峰值口径仍修复', () => {
    const result = applyNumericConsistencyDeterministicFixes('施工准备阶段投入22人，高峰期199人。', { laborPeakAuthority: 176 });
    expect(result.markdown).toContain('22人');
    expect(result.markdown).not.toContain('199人');
  });
});

describe('表格单元格不可见字符归一（十度实测缺陷：全角空格/零宽字符单元格三层全部漏网）', () => {
  it('检测层：全角空格 \u3000 单元格判空报 error（trim 不识别）', () => {
    const table = [
      '| 工序名称 | 检查内容 | 责任岗位 |',
      '| --- | --- | --- |',
      '| 土方开挖 | 标高检查 | \u3000 |',
    ].join('\n');
    const issues = markdownTableQualityIssues(table);
    expect(issues.some(issue => issue.message.includes('空单元格'))).toBe(true);
  });
  it('检测层：不换行空格 \u00a0 与零宽字符 \u200b 单元格同样判空报 error', () => {
    const table = [
      '| 工序名称 | 检查内容 | 责任岗位 |',
      '| --- | --- | --- |',
      '| 土方开挖 | 标高检查 | \u00a0\u200b |',
    ].join('\n');
    const issues = markdownTableQualityIssues(table);
    expect(issues.some(issue => issue.message.includes('空单元格'))).toBe(true);
  });
  it('检测层：普通空白 trim 可识别（历史行为保持）', () => {
    const table = [
      '| 工序名称 | 检查内容 | 责任岗位 |',
      '| --- | --- | --- |',
      '| 土方开挖 | 标高检查 |   |',
    ].join('\n');
    const issues = markdownTableQualityIssues(table);
    expect(issues.some(issue => issue.message.includes('空单元格'))).toBe(true);
  });
  // 4.55.22 用户红线「不得编造」：删除「空单元格按列就近非空值填充」——
  // 它把首行的 责任岗位/检查频次 复制到整列每一行，在正式标书里等于逐项声称同一责任人与同一频次，
  // 比留空更失真。空单元格现由交付门禁阻断 + LLM 定向修复按证据逐格修复。
  it('修复层：空单元格不再被同列值填充（禁止编造；留空交门禁+LLM 修复）', () => {
    const { lines } = repairTableBlockLines([
      '| 工序名称 | 检查内容 | 责任岗位 |',
      '| --- | --- | --- |',
      '| 土方开挖 | 标高检查 | \u3000 |',
      '| 回填夯实 | 压实度检测 | 试验员 |',
    ]);
    // 不删行、不复制（不出现「试验员」被填到土方开挖行）
    expect(lines.join('\n')).toContain('土方开挖');
    expect(lines.join('\n')).toContain('回填夯实');
    expect(lines.join('\n')).not.toContain('| 土方开挖 | 标高检查 | 试验员 |');
  });

  it('修复层：危险作业清单表空单元格不被上行值填充（r18 B3 形态，改为不编造）', () => {
    const { lines } = repairTableBlockLines([
      '| 危险作业类型 | 主要风险 | 管控责任岗位 | 管控频次 |',
      '| --- | --- | --- | --- |',
      '| 机械作业 | 机械倾覆伤害 | 安全员 | 每日巡查 |',
      '| 高处作业 | 坠落伤害 | \u3000 | \u200b |',
    ]);
    // 高处作业行的 责任岗位/频次 不得被机械作业行的值顶替
    expect(lines.join('\n')).not.toContain('| 高处作业 | 坠落伤害 | 安全员 | 每日巡查 |');
  });
  it('修复层：合计行全角空格单元格不再填「—」（V2 批1-4 零兜底写入：不伪造占位符）', () => {
    const { lines } = repairTableBlockLines([
      '| 项目 | 数量 | 备注 |',
      '| --- | --- | --- |',
      '| 土方开挖 | 1000 | 正常 |',
      '| 合计 | \u3000 | \u00a0 |',
    ]);
    expect(lines.join('\n')).not.toContain('—');
    expect(lines.join('\n')).toContain('合计');
  });
  it('清洗层：splitMarkdownTableLine 剥离全角空格/零宽字符', () => {
    const cells = splitMarkdownTableLine('| 土方开挖 | 标高检查 | \u3000\u200b |');
    expect(cells[2]).toBe('');
    expect(cells[0]).toBe('土方开挖');
  });
  it('清洗层：单元格中间全角空格也剥离（数字与单位间排版空格）', () => {
    expect(stripTableCellInvisibleChars('800\u3000米')).toBe('800米');
  });
});

describe('normalizeTableTitleInHeaders（4.44 写时表名混表头确定性归一）', () => {
  const plan = {
    id: 'planned-table-ch-1-1',
    title: '文明施工管控要点与检查频次表',
    chapterTitle: '文明施工',
    section: '',
    required: false,
    reason: '',
    fields: [{ name: '管 控分项' }, { name: '具体标准' }, { name: '责任岗位' }, { name: '检查频次' }, { name: '整改闭环要求' }],
  };
  it('4.43 实测形态：表名顶替首列名（与表计划表名一致）→ 表题独立成行 + 规划字段名归位（折行空格清洗）', () => {
    const markdown = [
      '| 文明施工管控要点与检查频次表 | 检查内容 | 责任岗位 | 检查频次 | 整改闭环 |',
      '| --- | --- | --- | --- | --- |',
      '| 围挡与警示设施 | 围挡稳固、警示标识齐全 | 安全员 | 每日1次 | 当日整改，复查销项 |',
      '| 道路保洁与洒水 | 施工便道无积尘、无遗撒 | 施工员 | 每日2次 | 2小时内清理复验 |',
    ].join('\n');
    const result = normalizeTableTitleInHeaders(markdown, [plan]);
    expect(result.normalized).toBe(1);
    expect(result.markdown).toContain('文明施工管控要点与检查频次表\n\n| 管控分项 | 检查内容 | 责任岗位 | 检查频次 | 整改闭环 |');
    expect(result.markdown).not.toContain('| 文明施工管控要点与检查频次表 |');
    // 归一后不再命中结构扫描阻断（检测定位与写时归一同源：检测到即能归一的形态不残留）
    expect(scanStructureDefects(result.markdown).blocking).toEqual([]);
    // 幂等：再跑一次零动作且内容不变
    const second = normalizeTableTitleInHeaders(result.markdown, [plan]);
    expect(second.normalized).toBe(0);
    expect(second.markdown).toBe(result.markdown);
  });
  it('表名占首格偏移形态（数据行末格全空）→ 表题独立成行 + 偏移列删除（无需表计划）', () => {
    const markdown = [
      '| 劳动力动态投入计划表 | 工种 | 峰值人数 | 进场时段 |',
      '| --- | --- | --- | --- |',
      '| 钢筋工 | 24人 | 第45日 |  |',
      '| 模板工 | 18人 | 第60日 |  |',
    ].join('\n');
    const result = normalizeTableTitleInHeaders(markdown);
    expect(result.normalized).toBe(1);
    expect(result.markdown).toContain('劳动力动态投入计划表\n\n| 工种 | 峰值人数 | 进场时段 |');
    expect(result.markdown).toContain('| 钢筋工 | 24人 | 第45日 |');
    expect(scanStructureDefects(result.markdown).blocking).toEqual([]);
  });
  it('表名顶替首列名但无表计划/计划未命中 → 不动作（列名无权威来源，交结构扫描阻断重写）', () => {
    const markdown = [
      '| 材料进场与工期匹配计划表 | 计划进场时间 | 责任人 |',
      '| --- | --- | --- |',
      '| 道牙石 | 第45日 | 张工 |',
    ].join('\n');
    const result = normalizeTableTitleInHeaders(markdown, [plan]);
    expect(result.normalized).toBe(0);
    expect(result.markdown).toBe(markdown);
    expect(scanStructureDefects(markdown).blocking.map(defect => defect.kind)).toEqual(['table-title-in-header']);
  });
  it('表题已独立成行（或已归一侧）→ 幂等护栏不再动作', () => {
    const markdown = [
      '文明施工管控要点与检查频次表',
      '',
      '| 管控分项 | 检查内容 | 责任岗位 | 检查频次 | 整改闭环 |',
      '| --- | --- | --- | --- | --- |',
      '| 围挡与警示设施 | 围挡稳固、警示标识齐全 | 安全员 | 每日1次 | 当日整改，复查销项 |',
    ].join('\n');
    const result = normalizeTableTitleInHeaders(markdown, [plan]);
    expect(result.normalized).toBe(0);
  });
  it('短词「报表」类首格（汉字数 <8）不动作（与扫描阈值同口径）', () => {
    const markdown = ['| 日进度报表 | 完成量 | 备注 |', '| --- | --- | --- |', '| 第1日 | 120米 | 正常 |'].join('\n');
    const result = normalizeTableTitleInHeaders(markdown, [plan]);
    expect(result.normalized).toBe(0);
  });
});


describe('paragraphTailRepeatIssues / fixParagraphTailRepeats（十五版报告段内句级复读）', () => {
  it('段内精确复读 → 检测并剥离复读句，首现保留', () => {
    const markdown = '道路铺装工程阶段，级配碎石按10cm厚单一规格组织运输，按路床碾压检验完成顺序分批进场。运输组织按以下顺序执行。级配碎石按10cm厚单一规格组织运输，按路床碾压检验完成顺序分批进场。';
    const issues = paragraphTailRepeatIssues(markdown);
    expect(issues.length).toBe(1);
    expect(issues[0]!.level).toBe('error');
    const r = fixParagraphTailRepeats(markdown);
    expect(r.fixedCount).toBe(1);
    expect((r.markdown.match(/级配碎石按10cm厚单一规格组织运输，按路床碾压检验完成顺序分批进场。/gu) || []).length).toBe(1);
    // 修复后检测清零（检测=修复同源闭环）
    expect(paragraphTailRepeatIssues(r.markdown)).toEqual([]);
  });

  it('段尾复读丢前缀（后缀包含规则）→ 检出并剥离（十五版 L442 形态）', () => {
    const markdown = '为此，项目部在丰乐镇域内设置1处中心材料周转场，储备不少于3天施工用量的级配碎石、中粗砂和水泥。当某一自然村施工段出现材料短缺时，材料员在1小时内向项目经理报告。在丰乐镇域内设置1处中心材料周转场，储备不少于3天施工用量的级配碎石、中粗砂和水泥。';
    const repeats = scanParagraphTailRepeats(markdown);
    expect(repeats.length).toBe(1);
    expect(repeats[0]!.count).toBe(2);
    const r = fixParagraphTailRepeats(markdown);
    expect(r.fixedCount).toBe(1);
    expect((r.markdown.match(/在丰乐镇域内设置1处中心材料周转场/gu) || []).length).toBe(1);
    expect(paragraphTailRepeatIssues(r.markdown)).toEqual([]);
  });

  it('标题行无空行紧贴正文 → 不因标题过滤漏检（十五版真实文件形态）', () => {
    const markdown = '### 3.5 主要物资运输与二次搬运组织方案\n施工准备与清杂拆除阶段，运输任务以清杂废弃物外运为主。级配碎石按10cm厚单一规格组织运输。级配碎石按10cm厚单一规格组织运输。';
    expect(paragraphTailRepeatIssues(markdown).length).toBe(1);
    const r = fixParagraphTailRepeats(markdown);
    expect(r.fixedCount).toBe(1);
    // 标题行保持原样
    expect(r.markdown).toContain('### 3.5 主要物资运输与二次搬运组织方案');
  });

  it('表格行夹杂 → 表格行不动，散文行仍去重', () => {
    const markdown = '材料员每周对应急物资储备情况进行1次盘点，发现数量低于储备标准时补充到位。\n| 应急物资名称 | 规格/型号 |\n| --- | --- |\n| 级配碎石 | 连续级配 |\n材料员每周对应急物资储备情况进行1次盘点，发现数量低于储备标准时补充到位。';
    const r = fixParagraphTailRepeats(markdown);
    expect(r.fixedCount).toBe(1);
    expect(r.markdown).toContain('| 应急物资名称 | 规格/型号 |');
    expect((r.markdown.match(/材料员每周对应急物资储备情况进行1次盘点，发现数量低于储备标准时补充到位。/gu) || []).length).toBe(1);
  });

  it('空行分隔的不同段落含相同句 → 不误报（跨位置整段重复由 duplicateParagraphIssues 负责）', () => {
    const markdown = '第一段：施工员每日巡查沟槽临边防护。\n\n第二段：施工员每日巡查沟槽临边防护。';
    expect(paragraphTailRepeatIssues(markdown)).toEqual([]);
  });

  it('短句（<15 字）重复不判复读', () => {
    const markdown = '压实度满足设计要求。压实度满足设计要求。';
    expect(paragraphTailRepeatIssues(markdown)).toEqual([]);
  });
});

describe('collisionNumberedHeadingIssues / fixCollisionNumberedHeadings（防撞名编号后缀标题）', () => {
  it('「公厕（1）」切块防撞名 → error/blocker 且按块内 H4 主题域重命名', () => {
    const markdown = '### 公厕（1）\n\n#### 土石方工程\n\n土石方开挖按设计要求施工。\n\n### 公厕（2）\n\n#### 楼地面装饰工程\n\n地面铺贴按工艺要求施工。';
    const issues = collisionNumberedHeadingIssues(markdown);
    expect(issues.length).toBe(2);
    expect(issues[0]!.level).toBe('error');
    const r = fixCollisionNumberedHeadings(markdown);
    expect(r.fixedCount).toBe(2);
    expect(r.markdown).toContain('### 公厕结构与基础工程');
    expect(r.markdown).toContain('### 公厕装饰装修工程');
    expect(r.markdown).not.toContain('公厕（1）');
    expect(collisionNumberedHeadingIssues(r.markdown)).toEqual([]);
  });

  it('「公厕（1）（二）」拆半变体 → 与同基线 H3 合并（整行删除）', () => {
    const markdown = '### 公厕（1）\n\n#### 土石方工程\n\n土石方开挖按设计要求施工。\n\n### 公厕（1）（二）\n\n#### 砌筑工程\n\n砌体施工按工艺要求施工。';
    const r = fixCollisionNumberedHeadings(markdown);
    expect(r.fixedCount).toBe(2);
    // 「公厕（1）」按域重命名、「公厕（1）（二）」合并进同一小节
    expect(r.markdown).toContain('### 公厕结构与基础工程');
    expect((r.markdown.match(/^### /gmu) || []).length).toBe(1);
    expect(r.markdown).toContain('#### 砌筑工程');
  });

  it('正常标题不误报（图纸名「建筑设计总说明（二）」不是 H3 不触发；H3 无编号后缀不触发）', () => {
    const markdown = '### 道路工程\n\n正文。\n\n### 排水工程\n\n正文。\n\n建筑设计总说明（二）图名在正文行。';
    expect(collisionNumberedHeadingIssues(markdown)).toEqual([]);
    expect(fixCollisionNumberedHeadings(markdown).fixedCount).toBe(0);
  });

  it('块内无 H4 的编号后缀 H3 → 检测仍报，修复保持原样不破坏正文', () => {
    const markdown = '### 公厕（1）\n\n无四级标题的概述正文。';
    expect(collisionNumberedHeadingIssues(markdown).length).toBe(1);
    const r = fixCollisionNumberedHeadings(markdown);
    expect(r.markdown).toBe(markdown);
  });
});

describe('invertedDateRangeIssues / fixInvertedDateRanges（十五版报告时间区间倒挂）', () => {
  it('「第90日至第3日」倒挂 → error/blocker 并确定性修复为仅保留终点', () => {
    const markdown = '各自然村施工组在开工令下发后第90日至第3日完成本村施工区围挡布设。';
    const issues = invertedDateRangeIssues(markdown);
    expect(issues.length).toBe(1);
    expect(issues[0]!.level).toBe('error');
    expect(issues[0]!.severity).toBe('blocker');
    const r = fixInvertedDateRanges(markdown);
    expect(r.fixedCount).toBe(1);
    expect(r.markdown).toBe('各自然村施工组在开工令下发后第3日完成本村施工区围挡布设。');
    expect(invertedDateRangeIssues(r.markdown)).toEqual([]);
  });

  it('正常区间「第1日～第7日」不报', () => {
    const markdown = '施工准备与清杂拆除阶段（第1日～第7日）完成临时设施布设。';
    expect(invertedDateRangeIssues(markdown)).toEqual([]);
  });

  it('波浪线连接符「第120日～第3日」同样修复（检测器五连接符同源，V5 P6 run1 实测残留根因）', () => {
    const markdown = '阶段性资料移交节点为开工令下发后第120日～第3日完成归档。';
    expect(invertedDateRangeIssues(markdown).length).toBe(1);
    const r = fixInvertedDateRanges(markdown);
    expect(r.fixedCount).toBe(1);
    expect(r.markdown).toBe('阶段性资料移交节点为开工令下发后第3日完成归档。');
    expect(invertedDateRangeIssues(r.markdown)).toEqual([]);
  });

  it('多处倒挂全部修复（十五版真实文档 2 处）', () => {
    const markdown = '段落一：开工令下发后第90日至第3日完成围挡布设。段落二：开工令下发后第90日至第3日完成警示设施布设。';
    const r = fixInvertedDateRanges(markdown);
    expect(r.fixedCount).toBe(2);
    expect(r.markdown).not.toContain('第90日至');
  });
});

describe('r28j fixZeroLengthDayRanges（同日零长区间收敛 · M15）', () => {
  it('「第360日至第360日」→ 收敛为「第360日」（s28i 实机归因形态）', () => {
    const markdown = '预留开工后第360日至第360日作为联调复验与移交缓冲。';
    const r = fixZeroLengthDayRanges(markdown);
    expect(r.fixedCount).toBe(1);
    expect(r.markdown).toBe('预留开工后第360日作为联调复验与移交缓冲。');
  });

  it('波浪线连接符「第120日～第120日」同源收敛（与检测器字符类同源）', () => {
    const markdown = '资料归档节点定在第120日～第120日完成移交。';
    const r = fixZeroLengthDayRanges(markdown);
    expect(r.fixedCount).toBe(1);
    expect(r.markdown).toBe('资料归档节点定在第120日完成移交。');
  });

  it('非零长区间不动 + 收敛后幂等（零命中静默）', () => {
    const normal = '施工准备与清杂拆除阶段（第1日～第7日）完成临时设施布设。';
    expect(fixZeroLengthDayRanges(normal).fixedCount).toBe(0);
    expect(fixZeroLengthDayRanges(normal).markdown).toBe(normal);
    const fixed = fixZeroLengthDayRanges('预留开工后第360日至第360日作为联调复验与移交缓冲。').markdown;
    expect(fixZeroLengthDayRanges(fixed).fixedCount).toBe(0);
  });

  it('同句多处零长区间全部收敛', () => {
    const markdown = '第30日至第30日完成基础验收，第60日至第60日完成主体结构封顶。';
    const r = fixZeroLengthDayRanges(markdown);
    expect(r.fixedCount).toBe(2);
    expect(r.markdown).toBe('第30日完成基础验收，第60日完成主体结构封顶。');
  });
});

describe('r28j crossSectionNumericConflictIssues XPS 几何构造参数豁免（M16）', () => {
  it('几何半径与真厚度混排不报（s28i 实机：「倒角成圆弧形，半径10mm」）', () => {
    const markdown = '屋面节能构造按设计层次组织施工：上铺155厚挤塑聚苯乙烯泡沫塑料，阴角处用水泥砂浆倒角成圆弧形，半径10mm。';
    expect(crossSectionNumericConflictIssues(markdown)).toEqual([]);
  });

  it('数值前置几何半径「半径为10mm的XPS板」不入池（pattern2 绝对位置取窗）', () => {
    const markdown = '半径为10mm的XPS板搭接铺设，搭接缝处密封处理。';
    expect(crossSectionNumericConflictIssues(markdown)).toEqual([]);
  });

  it('真厚度值仍互斥：50mm vs 130mm 照常报（机制守护）', () => {
    const markdown = 'XPS板厚50mm铺设。屋面挤塑聚苯板厚度130mm。';
    const issues = crossSectionNumericConflictIssues(markdown);
    expect(issues.some(issue => /XPS|挤塑聚苯/u.test(issue.message) && /50/u.test(issue.message) && /130/u.test(issue.message))).toBe(true);
  });

  it('几何构造句与真厚度共句：真厚度照常入池互斥（「圆弧转角处XPS板厚50mm」前 6 字无完整几何词）', () => {
    const markdown = '圆弧转角处XPS板厚50mm铺设。屋面挤塑聚苯板厚度130mm。';
    const issues = crossSectionNumericConflictIssues(markdown);
    expect(issues.some(issue => /XPS|挤塑聚苯/u.test(issue.message))).toBe(true);
  });
});

describe('crossSectionNumericConflictIssues 机械/土方锚点（十五版报告四套数字）', () => {
  it('挖掘机 5台 vs 4台 → 报数量矛盾', () => {
    const markdown = '施工机械配置挖掘机（0.6~1.0m³）5台。沟塘清淤配置挖掘机（0.6~1.0m³）4台。';
    const issues = crossSectionNumericConflictIssues(markdown);
    expect(issues.some(issue => /挖掘机数量/u.test(issue.message) && /5台/u.test(issue.message) && /4台/u.test(issue.message))).toBe(true);
  });

  it('自卸汽车 5台 vs 6台 → 报数量矛盾', () => {
    const markdown = '土方运输配置自卸汽车（8t）5台。清淤外运配置自卸汽车（8t）6台。';
    expect(crossSectionNumericConflictIssues(markdown).some(issue => /自卸汽车数量/u.test(issue.message))).toBe(true);
  });

  it('压路机 5台 vs 2台 → 报数量矛盾', () => {
    const markdown = '道路工程配置压路机（8~12t）5台。景观铺装配置压路机2台。';
    expect(crossSectionNumericConflictIssues(markdown).some(issue => /压路机数量/u.test(issue.message))).toBe(true);
  });

  it('蛙式打夯机 5台 vs 6台 → 报数量矛盾', () => {
    const markdown = '沟塘回填配置蛙式打夯机5台。道路路肩配置蛙式打夯机6台。';
    expect(crossSectionNumericConflictIssues(markdown).some(issue => /蛙式打夯机数量/u.test(issue.message))).toBe(true);
  });

  it('混凝土搅拌运输车 2台 vs 3台 → 报数量矛盾', () => {
    const markdown = '道路面层浇筑配置混凝土搅拌运输车2台。基础浇筑配置混凝土搅拌运输车3台。';
    expect(crossSectionNumericConflictIssues(markdown).some(issue => /混凝土搅拌运输车数量/u.test(issue.message))).toBe(true);
  });

  it('洒水车 5台 vs 2台 → 报数量矛盾', () => {
    const markdown = '扬尘治理配置洒水车5台。绿化养护配置洒水车2台。';
    expect(crossSectionNumericConflictIssues(markdown).some(issue => /洒水车数量/u.test(issue.message))).toBe(true);
  });

  it('高空作业车 3台 vs 1台 → 报数量矛盾', () => {
    const markdown = '路灯安装配置高空作业车3台。附属设施配置高空作业车1台。';
    expect(crossSectionNumericConflictIssues(markdown).some(issue => /高空作业车数量/u.test(issue.message))).toBe(true);
  });

  it('沟塘回填方 4270m³ vs 15481.48m³ → 报双口径（十五版 B③）', () => {
    const markdown = '本分项主要工程量为：砌筑渠道4800m，挖淤泥、流砂21273m³，回填方4270m³。回填方总量15481.48m³，采用素土分层回填。';
    const issues = crossSectionNumericConflictIssues(markdown);
    expect(issues.some(issue => /沟塘回填方量/u.test(issue.message) && /4270/u.test(issue.message) && /15481\.48/u.test(issue.message))).toBe(true);
  });

  it('槽底预留 200mm vs 300mm → 报矛盾（十五版 A⑤）', () => {
    const markdown = '沟槽开挖采用挖掘机分段开挖，槽底预留200mm人工清底。管道沟槽开挖按设计图纸控制，槽底预留300mm人工清底。';
    expect(crossSectionNumericConflictIssues(markdown).some(issue => /槽底人工清底/u.test(issue.message) && /200mm/u.test(issue.message) && /300mm/u.test(issue.message))).toBe(true);
  });

  it('距房屋 3m vs 2m 人工开挖 → 报矛盾（十五版 A⑤）', () => {
    const markdown = '村民住宅保护按距房屋3m内采用人工开挖、禁止机械强挖的顺序执行。开挖振动导致墙体开裂风险段距房屋2m范围内采用人工开挖，控制机械振动。';
    expect(crossSectionNumericConflictIssues(markdown).some(issue => /距房屋人工开挖/u.test(issue.message) && /3m/u.test(issue.message) && /2m/u.test(issue.message))).toBe(true);
  });

  it('「沟槽开挖边线外1.5m范围内人工开挖」非房屋距离 → 不串锚不报', () => {
    const markdown = '沟槽开挖边线外1.5m范围内采用人工开挖，禁止机械强挖。';
    expect(crossSectionNumericConflictIssues(markdown)).toEqual([]);
  });

  it('同锚点同值一致 → 不报', () => {
    const markdown = '施工机械配置挖掘机5台。沟塘清淤配置挖掘机5台。';
    expect(crossSectionNumericConflictIssues(markdown)).toEqual([]);
  });
});

describe('4.55.12 规格错位多义权威：限定词自洽消歧（巢湖实测）', () => {
  const 涂料Map = (): SpecAuthorityMap => ({
    厚度规格: [
      { location: '防火涂料', spec: '40mm', quantity: '26494.190m2', sourceFile: '清单.xls' },
      { location: '防火涂料', spec: '6mm', quantity: '54083.530m2', sourceFile: '清单.xls' },
    ],
  } as unknown as SpecAuthorityMap);

  const 正文 = [
    '钢柱及柱间支撑采用非膨胀型防火涂料，厚度40mm，耐火极限2.5小时；',
    '钢梁及屋面支撑采用膨胀型防火涂料，厚度6mm，耐火极限1.5小时；',
    '其他钢构件膨胀型防火涂料厚度6mm，耐火极限1.0小时。',
    '防火涂装按构件耐火极限分级实施，钢柱及柱间支撑耐火极限2.5小时、非膨胀型防火涂料厚度40mm，钢梁及屋面支撑耐火极限1.5小时、膨胀型防火涂料厚度3mm。',
  ].join('');

  it('权威双值（40mm/6mm）时，正文同限定词一致绑定 → 确定性给出目标值（6mm）', () => {
    const hits = scanSpecLocationMismatchHits(正文, 涂料Map());
    expect(hits).toHaveLength(1);
    expect(hits[0]!.issue.message).toContain('3mm');
    expect(hits[0]!.replacement?.replacement).toBe('6mm');
  });

  it('对照：限定词「非膨胀型」不被「膨胀型」串味（40mm 侧自洽仍成立）', () => {
    const md = '钢柱及柱间支撑采用非膨胀型防火涂料，厚度40mm；其他钢构件膨胀型防火涂料厚度6mm。非膨胀型防火涂料厚度70mm。';
    const hits = scanSpecLocationMismatchHits(md, 涂料Map());
    expect(hits).toHaveLength(1);
    expect(hits[0]!.issue.message).toContain('70mm');
    expect(hits[0]!.replacement?.replacement).toBe('40mm');
  });

  it('对照：限定词在正文中无权威配对（无法自洽）→ 不硬替换，交 LLM', () => {
    const md = '钢梁及屋面支撑采用膨胀型防火涂料，厚度3mm。其他钢构件膨胀型防火涂料厚度3mm。';
    const hits = scanSpecLocationMismatchHits(md, 涂料Map());
    expect(hits).toHaveLength(2);
    expect(hits.every(hit => hit.replacement === undefined)).toBe(true);
  });
});

// ═══ 4.55.14 章级规划小节落位（巢湖实测：OUTLINE 固定小节被降级/漏写） ═══

describe('promotePlannedSectionHeadings / missingPlannedSections（章级小节落位收口）', () => {
  it('同名 H4 降级形态 → 就地提升为 H3（巢湖「#### 5 工程概况」）', () => {
    const content = ['### 1.1 室外安装工程', '', '正文。', '', '#### 5 工程概况', '', '本工程为…'].join('\n');
    const result = promotePlannedSectionHeadings(['工程概况', '编制依据与说明'], content);
    expect(result.promoted).toEqual(['工程概况']);
    expect(result.markdown).toContain('### 工程概况');
    expect(result.markdown).not.toContain('#### 5 工程概况');
    expect(result.missing).toEqual(['编制依据与说明']);
  });

  it('整节漏写 → 记入 missing（供终检报出，不静默）', () => {
    const result = promotePlannedSectionHeadings(['工程概况', '编制依据与说明'], '### 1.1 基础工程\n\n正文。');
    expect(result.promoted).toEqual([]);
    expect(result.missing).toEqual(['工程概况', '编制依据与说明']);
  });

  it('已是 H3 → 幂等零改动', () => {
    const content = '### 1.1 编制依据与说明\n\n正文。\n\n### 1.2 工程概况\n\n正文。';
    const result = promotePlannedSectionHeadings(['编制依据与说明', '工程概况'], content);
    expect(result.markdown).toBe(content);
    expect(result.missing).toEqual([]);
  });

  it('不同名 H4（工作包）不受影响（零误伤）', () => {
    const content = '### 1.1 主要施工内容\n\n#### 土石方工程\n\n正文。\n\n#### 桩基工程\n\n正文。';
    const result = promotePlannedSectionHeadings(['主要施工内容'], content);
    expect(result.markdown).toBe(content);
    expect(result.promoted).toEqual([]);
  });
});

// ═══ 4.55.16 表格空话单元格（巢湖实测：工程量列 6 格全写「按清单工程量」） ═══

describe('hollowTableCellIssues（表格空话检测，按表×列聚合）', () => {
  it('工程量列写「按清单工程量」→ 报空话（同列多格聚合为一条）', () => {
    const md = [
      '| 分项部位 | 工程量 | 控制指标 |',
      '| --- | --- | --- |',
      '| 平整场地 | 按清单工程量 | 碾压至设计标高 |',
      '| 挖一般土方 | 按清单工程量 | 机械开挖至设计标高 |',
      '| 挖沟槽土方 | 12792.800m3 | 槽底标高偏差±20mm |',
    ].join('\n');
    const issues = hollowTableCellIssues(md);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain('工程量');
    expect(issues[0]!.message).toContain('按清单工程量');
  });

  it('具体数值/可追溯来源不误伤', () => {
    const md = [
      '| 分项部位 | 工程量 | 交叉净距控制 |',
      '| --- | --- | --- |',
      '| 平整场地 | 1200m2 | 按施工图结施-03 基础平面图 |',
      '| 挖沟槽土方 | 12792.800m3 | 净距不小于0.5m |',
    ].join('\n');
    expect(hollowTableCellIssues(md)).toEqual([]);
  });

  it('含数字的单元格一律不判（避免把「按3m控制」类误伤）', () => {
    const md = ['| 项目 | 要求 |', '| --- | --- |', '| 沟槽 | 按3m分层开挖 |'].join('\n');
    expect(hollowTableCellIssues(md)).toEqual([]);
  });
});

describe('4.55.16 孤立尾括号清洗（项目编号「2026AFMGZ50828））」）', () => {
  it('尾部孤立右括号删除；配平括号保留', () => {
    expect(cleanInlineFactValue('2026AFMGZ50828）')).toBe('2026AFMGZ50828');
    expect(cleanInlineFactValue('巢湖市（居巢经开区）')).toBe('巢湖市（居巢经开区）');
  });
});

// ═══ 4.55.17 工期变更后口径（招标 365 / 答疑 330） ═══

describe('resolveEffectiveTotalDays（答疑变更后口径优先）', () => {
  it('「365日历天，现变更修改为:330日历天」→ 330（变更后生效口径）', () => {
    expect(resolveEffectiveTotalDays('计划工期365日历天，现变更修改为:330日历天。')).toBe(330);
  });
  it('「工期由365日历天调整为330日历天」→ 330', () => {
    expect(resolveEffectiveTotalDays('本工程工期由365日历天调整为330日历天。')).toBe(330);
  });
  it('无变更形态 → 首个工期口径', () => {
    expect(resolveEffectiveTotalDays('本工程计划工期330日历天，质量标准合格。')).toBe(330);
  });
  it('变更标记后无「数字+日历天」不误取（「工期330日历天，如需变更须报批」→ 330）', () => {
    expect(resolveEffectiveTotalDays('本工程计划工期330日历天，如需变更须报批。')).toBe(330);
  });
});

describe('scheduleDurationOverrunIssues(进度计划超声明工期)', () => {
  it('声明 330、进度排到 348 → 报超出（巢湖实测形态）', () => {
    const md = [
      '本工程总工期330日历天，按此倒排各阶段节点。',
      '| 工序 | 持续天数 | 起止天序 |',
      '| --- | --- | --- |',
      '| 施工准备 | 29 | 第1～29天 |',
      '| 安装与收尾工程 | 28 | 第321～348天 |',
    ].join('\n');
    const issues = scheduleDurationOverrunIssues(md);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain('330');
    expect(issues[0]!.message).toContain('348');
  });

  it('声明 330、进度排到第 330 天（余量内）→ 不报', () => {
    const md = '本工程总工期330日历天。\n\n| 工序 | 起止天序 |\n| --- | --- |\n| 收尾 | 第302～330天 |';
    expect(scheduleDurationOverrunIssues(md)).toEqual([]);
  });

  it('无声明工期或无天序 → 静默（不误伤无进度章文档）', () => {
    expect(scheduleDurationOverrunIssues('| 工序 | 起止天序 |\n| --- | --- |\n| 收尾 | 第302～348天 |')).toEqual([]);
    expect(scheduleDurationOverrunIssues('本工程总工期330日历天。')).toEqual([]);
  });
});

// ═══ 4.55.19 危大工程参数—判定绑定（实测：只写规范阈值 3m，本项目 1.75m 未落位） ═══

describe('hazardParameterBindingIssues（危大须写本项目实参 + 阈值对照 + 结论）', () => {
  const truth = [
    { attribute: '基坑开挖深度', value: '1.75m' },
    { attribute: '合同金额', value: '22303.66万元' },
  ];

  it('只抄规范阈值、未写本项目实参 → 报缺口', () => {
    const md = '本项目涉及的危险性较大的分部分项工程包括：开挖深度超过3m的室外排水管道沟槽土方开挖工程。';
    const issues = hazardParameterBindingIssues(md, truth);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain('3m');
    expect(issues[0]!.message).toContain('不得只抄规范阈值');
  });

  it('写了本项目实参 + 阈值对照 → 不报', () => {
    const md = '本项目基坑开挖深度1.75m，对照开挖深度超过3m的危大阈值，判定本工程基坑不属于危大工程。';
    expect(hazardParameterBindingIssues(md, truth)).toEqual([]);
  });

  // 4.55.22 根修盲区：真值层无工程测量实参时，原实现 `return []` → **整条门禁静默失效**：
  // 只抄规范阈值、不落本项目实参的正文完全不受检（本用例原断言正是"静默"）。
  // 此时无法"判定"（没有可比对的实参），但可以也必须"报告"——按未核对处理，warning 不阻断。
  it('真值层无工程测量值但正文出现危大阈值断言 → 报「未核对」（不阻断）', () => {
    const issues = hazardParameterBindingIssues('开挖深度超过3m的沟槽土方开挖工程。', [{ attribute: '合同金额', value: '100万元' }]);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.level).toBe('warning');
    expect(issues[0]!.message).toContain('未能核对');
    expect(issues[0]!.message).toContain('无法判定');
  });

  it('真值层无工程测量值且正文无危大阈值断言 → 仍静默（不误伤无参数项目）', () => {
    expect(hazardParameterBindingIssues('本项目主要施工内容包括土方开挖与回填。', [{ attribute: '合同金额', value: '100万元' }])).toEqual([]);
  });
});

// ═══ 4.55.20 新发现缺陷（终稿复核）：蓝图权威值未落位 / 悬空连接词截断 ═══

describe('blueprintValuePlacementIssues（蓝图裁决值必须写具体数字）', () => {
  const blueprint = { resources: { labor: { peakValue: 168 }, equipment: [{ name: '挖掘机', count: 5 }] } };

  it('正文只写「按…控制」而无峰值人数 → 报未落位', () => {
    const md = '劳动力峰值按总进度计划控制，各阶段投入与总工期严格对应。';
    const issues = blueprintValuePlacementIssues(md, blueprint);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain('劳动力峰值 168 人');
    expect(issues[0]!.message).toContain('挖掘机 5 台');
  });

  it('写出具体数值 → 不报', () => {
    const md = '本工程劳动力峰值 168 人，配置挖掘机 5 台。';
    expect(blueprintValuePlacementIssues(md, blueprint)).toEqual([]);
  });

  it('无蓝图数据 → 静默（不误伤）', () => {
    expect(blueprintValuePlacementIssues('劳动力峰值按总进度计划控制。', undefined)).toEqual([]);
  });
});

describe('danglingConjunctionIssues（悬空连接词截断）', () => {
  it('「…探明既有管线的平面位置和。」→ 报截断', () => {
    const issues = danglingConjunctionIssues('施工前由施工员组织管线探测，采用物探与人工开挖探沟相结合的方式，探明既有管线的平面位置和。穿越道路段采用分段开挖。');
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain('悬空连接词');
  });

  it('完整句子不误伤（连接词在句中）', () => {
    expect(danglingConjunctionIssues('探明既有管线的平面位置和埋深，并形成探测记录。')).toEqual([]);
  });
});
