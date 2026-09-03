/**
 * sixHundredPercentCoverageIssues 拆迁工地豁免组合矩阵（4.12.7 前补齐）：
 * 主语集 × 否定词集全笛卡尔（豁免成立）、主语集边界（词表外主语不豁免）、
 * 30 字短距窗口边界、断句隔离边界、无主语短语不豁免矩阵。
 * 语义通道统一 mock（本地 bge 恒可用，判定语义全权由 bge 负责，测试只验豁免口径）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sixHundredPercentCoverageIssues } from '@/services/document-workflow/documentIntegrityChecks';

vi.mock('@/services/document-workflow/semanticSimilarity', () => ({ buildSemanticSimilarity: vi.fn(), SEMANTIC_COVERAGE_THRESHOLD: 0.6 }));

import { buildSemanticSimilarity } from '@/services/document-workflow/semanticSimilarity';

const buildSimilarityMock = vi.mocked(buildSemanticSimilarity);

/** 豁免句主语集（与实现词表一致：本项目/本工程/该工程/该项目/本标段/本施工项目） */
const SUBJECTS = ['本项目', '本工程', '该工程', '该项目', '本标段', '本施工项目'];
/** 否定词集（与实现词表一致） */
const NEGATIONS = ['无拆迁', '不涉及拆迁', '无房屋拆除', '无拆除'];

describe('sixHundredPercentCoverageIssues 豁免全笛卡尔矩阵（6 主语 × 4 否定词）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    buildSimilarityMock.mockResolvedValue(() => 0.1);
  });

  const cases: Array<[string]> = [];
  for (const subject of SUBJECTS) {
    for (const negation of NEGATIONS) {
      cases.push([`${subject}${negation}。`]);
    }
  }
  it.each(cases)('豁免成立 #%#：%s', async (body) => {
    const issues = await sixHundredPercentCoverageIssues(`环保措施\n${body}`);
    expect(issues[0].message).not.toContain('拆迁工地100%湿法作业');
  });

  it.each(cases)('豁免句带前缀定语仍成立 #%#：%s', async (body) => {
    // 前缀「经核实，」不改变主语+否定词的短距关系，豁免语义不变
    const issues = await sixHundredPercentCoverageIssues(`环保措施\n经核实，${body}`);
    expect(issues[0].message).not.toContain('拆迁工地100%湿法作业');
  });
});

describe('sixHundredPercentCoverageIssues 主语集边界矩阵（词表外主语不豁免）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    buildSimilarityMock.mockResolvedValue(() => 0.1);
  });

  it.each([
    '我方项目无拆迁工程。',
    '该地块无拆迁。',
    '工程现场无拆除。',
    '本标不涉及拆迁。',
    '此项目无房屋拆除。',
    '施工区域无拆迁内容。',
    '场区内不涉及拆迁。',
    '红线范围内无拆除工程。',
    '现场无拆迁。',
    '本场地不涉及拆迁。',
  ])('不豁免 #%#：%s', async (body) => {
    const issues = await sixHundredPercentCoverageIssues(`环保措施\n${body}`);
    expect(issues[0].message).toContain('拆迁工地100%湿法作业');
  });
});

describe('sixHundredPercentCoverageIssues 30 字窗口边界矩阵', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    buildSimilarityMock.mockResolvedValue(() => 0.1);
  });

  it.each([
    // 主语到否定词超过 30 字：中间插入长定语/环境描述
    '本项目位于合肥市瑶海区龙岗路与大众路交口，周边现状复杂场地狭小，施工组织需充分考虑周边环境协调与扬尘控制，不涉及拆迁。',
    '本工程地处城区中心繁华地段，周边道路狭窄车流密集，施工期间需重点做好交通疏导扬尘治理与噪声控制工作，无拆迁。',
    '该工程周边既有建筑密集，施工场地狭窄，材料堆放与机械布置均受限制，需精心组织施工总平面布置，不涉及拆迁。',
    '该项目红线范围内存在市政管线迁改与交通疏解等前期工作内容，待管线迁改完成后展开全面施工，无房屋拆除。',
    '本标段沿线地下管线复杂，涉及给水排水燃气电力通信等多专业管线保护，施工前需完成管线交底与保护方案，无拆除。',
    '本施工项目施工周期横跨雨季与高温季节，需做好季节性施工措施与防暑降温工作安排，同时加强进度计划动态调整，不涉及拆迁。',
  ])('超窗不豁免 #%#：%s', async (body) => {
    const issues = await sixHundredPercentCoverageIssues(`环保措施\n${body}`);
    expect(issues[0].message).toContain('拆迁工地100%湿法作业');
  });
});

describe('sixHundredPercentCoverageIssues 断句隔离矩阵（否定词脱离主语句不豁免）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    buildSimilarityMock.mockResolvedValue(() => 0.1);
  });

  it.each([
    '本项目为新建工程。建设范围内不涉及拆迁。',
    '本项目位于合肥市瑶海区。不涉及拆迁。',
    '本工程为框架结构。无拆迁内容。',
    '本项目周边环境良好。红线内无房屋拆除。',
    '该工程体量大。建设区域不涉及拆迁。',
  ])('断句不豁免 #%#：%s', async (body) => {
    const issues = await sixHundredPercentCoverageIssues(`环保措施\n${body}`);
    expect(issues[0].message).toContain('拆迁工地100%湿法作业');
  });

  it.each([
    '本项目不涉及拆迁。',
    '本工程无拆迁工程。',
    '该工程无房屋拆除，不涉及拆迁工地湿法作业。',
    '本标段无拆除。',
    '本施工项目不涉及拆迁，该段内容不适用。',
  ])('同句豁免 #%#：%s', async (body) => {
    const issues = await sixHundredPercentCoverageIssues(`环保措施\n${body}`);
    expect(issues[0].message).not.toContain('拆迁工地100%湿法作业');
  });
});

describe('sixHundredPercentCoverageIssues 无主语短语不豁免矩阵', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    buildSimilarityMock.mockResolvedValue(() => 0.1);
  });

  it.each([
    '施工场地狭小，临时设施布置不涉及拆迁补偿。',
    '相邻地块无拆迁工程。',
    '既有建筑物不存在拆迁。',
    '现场管线迁改不涉及拆迁。',
    '周边环境无房屋拆除。',
    '临建设施搭建区域无拆除工程。',
    '施工便道占用区域不涉及拆迁。',
    '地下障碍物清除不涉及拆迁补偿。',
  ])('短语不豁免 #%#：%s', async (body) => {
    const issues = await sixHundredPercentCoverageIssues(`环保措施\n${body}`);
    expect(issues[0].message).toContain('拆迁工地100%湿法作业');
  });
});
