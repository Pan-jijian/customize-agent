/**
 * documentIntegrityChecks W2/P1 改造单测：
 * 六个百分百与本地适配三项的纯语义判定——本地 bge 恒可用（本地 ONNX 推理），判定语义全权由 bge 负责，
 * 无不可用降级路径。语义通道全部 mock（避免测试加载 Transformers.js 重依赖）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ambiguousEitherOrIssues, basicInfoScheduleFieldIssues, bidderQualificationSectionIssues, bodySentencesForSemantic, crossSectionNumericConflictIssues, duplicateParagraphIssues, duplicateTableIssues, excavationDepthLockIssues, fabricatedAwardIssues, foundationFormResidueIssues, localAdaptationKeywordIssues, nodeScheduleConsistencyIssues, resourceConsistencyIssues, resourceTriadSectionHierarchyIssues, sixHundredPercentCoverageIssues, stripDuplicateParagraphs, stripDuplicateTables } from './documentIntegrityChecks';
import type { DocumentFactsModel, TenderRequirementModel } from './types';

vi.mock('./semanticSimilarity', () => ({ buildSemanticSimilarity: vi.fn(), SEMANTIC_COVERAGE_THRESHOLD: 0.6 }));

import { buildSemanticSimilarity } from './semanticSimilarity';

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

  it('模式 5：总工日与峰值×工期不自洽 → 报', () => {
    const markdown = '本工程总工期540日历天，施工高峰期投入120人。总用工量约90000个工日。';
    const issues = resourceConsistencyIssues(markdown);
    expect(issues.some(issue => /总工日/u.test(issue.message) && /不自洽/u.test(issue.message))).toBe(true);
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

  it('准备阶段句（场地清表施工准备）不误采为节点', () => {
    const markdown = '第15日完成场地清表、临建搭设和基坑支护施工准备。第60日完成基坑支护及土方外运。';
    expect(nodeScheduleConsistencyIssues(markdown)).toEqual([]);
  });

  it('同节点两套口径相差 <5 天（取整允许差）→ 不报', () => {
    const markdown = '第60日完成主体结构封顶。进度计划表：主体结构封顶完成 | 开工后第62天。';
    expect(nodeScheduleConsistencyIssues(markdown)).toEqual([]);
  });
});

describe('crossSectionNumericConflictIssues（h13 跨节数值口径冲突）', () => {
  it('XPS 厚度 30mm vs 130mm（>20% 差异）→ 报数量矛盾', () => {
    const markdown = '挤塑聚苯乙烯泡沫塑料板（XPS）30mm。屋面采用130mm厚挤塑聚苯板。';
    const issues = crossSectionNumericConflictIssues(markdown);
    expect(issues.some(issue => /挤塑聚苯板/u.test(issue.message) && /30mm 与 130mm/u.test(issue.message))).toBe(true);
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

  it('同锚点数值差异 ≤20% → 不报', () => {
    const markdown = '潜水泵8台。现场配置潜水泵7台。';
    expect(crossSectionNumericConflictIssues(markdown)).toEqual([]);
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
    const requirements = { extracted: true, awardObjectives: [{ text: '创优目标：确保黄山杯', coreTerms: [] }], awardClauses: [], specialQualityStandards: [] } as unknown as TenderRequirementModel;
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

  it('单一口径无矛盾 → 不报', () => {
    const issues = resourceConsistencyIssues('主体阶段投入劳动力约110人，装饰阶段投入劳动力约105人。');
    expect(issues).toEqual([]);
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
