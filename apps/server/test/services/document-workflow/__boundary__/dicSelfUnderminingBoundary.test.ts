/**
 * dicSelfUnderminingBoundary：自伤表述程序性豁免正则（SELF_UNDERMINING_PROCEDURAL_EXEMPT_RE）
 * 深挖（S 组）——r27 扩围⑭「监测统计→偏差/隐患→纠偏动作→目标保障」四段式分支。
 * 覆盖维度（与 dicConvergenceHazardBoundary Z5 全通道矩阵互补，不重复）：
 *  - S1 ⑭ 分支正样本：统计-纠偏-保障句豁免、监测词/纠偏词谱系变体同构命中；
 *  - S1 条件边界：缺目标保障尾段不豁免（正则以完整四段式为豁免前提）；
 *  - S1 真伤护栏：待补充类/缺口类/分包否定式均保持召回；
 *  - S1 旧分支回归：⑬ 条件-调配-保障三段式仍豁免；
 *  - S2 集成：vi.mock 语义恒值 0.9，经 selfUnderminingCandidateIssues 全通道验证
 *    ⑭ 在语义召回通道被程序性豁免滤除、缺尾段句保持召回。全部为通用工程形态，无项目专名。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSemanticSimilarity } from '@/services/document-workflow/semanticSimilarity';
import { selfUnderminingCandidateIssues } from '@/services/document-workflow/documentIntegrityChecks';
import { SELF_UNDERMINING_PROCEDURAL_EXEMPT_RE } from '@/services/document-workflow/integrity/detectors/detectors';

vi.mock('@/services/document-workflow/semanticSimilarity', () => ({ buildSemanticSimilarity: vi.fn(), SEMANTIC_COVERAGE_THRESHOLD: 0.6 }));

/** 恒值语义模拟器：锁定语义判定通道的阈值边界（与 Z5 同源） */
const CONST_SIM = (value: number) => async (_leftTexts: string[], _rightTexts: string[]) => (_l: string, _r: string): number => value;

/** ⑭ 正样本：监测统计（统计）→ 偏差（未完成/损失）→ 纠偏（组织/补充/加密）→ 保障（确保…不受突破） */
const MONITOR_CORRECT_SENTENCE = '每次恶劣天气结束后，施工员在2小时内统计受影响作业面、损失工时与未完成工序，项目经理对照总控线路判断是否触发滞后预警，触发后按既定纠偏流程组织资源补充与作业面加密，确保90日历天总工期不受突破';

describe('S1 SELF_UNDERMINING_PROCEDURAL_EXEMPT_RE ⑭ 监测-纠偏-保障分支', () => {
  it('S1-1 ⑭ 正样本豁免（统计→损失/未完成→组织/补充/加密→确保…不受突破）', () => {
    expect(SELF_UNDERMINING_PROCEDURAL_EXEMPT_RE.test(MONITOR_CORRECT_SENTENCE)).toBe(true);
  });
  it('S1-2 监测词（汇总）与纠偏词（调拨）谱系变体同构句豁免', () => {
    expect(SELF_UNDERMINING_PROCEDURAL_EXEMPT_RE.test('施工员每日汇总各作业面未完成工程量与损失工时，项目经理调拨班组补位，确保节点工期不超期')).toBe(true);
  });
  it('S1-3 条件边界：缺「确保/保障/保证」目标保障尾段不豁免', () => {
    expect(SELF_UNDERMINING_PROCEDURAL_EXEMPT_RE.test('每次降雨后施工员统计未完成工序与损失工时，项目经理组织资源补充')).toBe(false);
  });
  it('S1-4 真伤护栏：待补充类/缺口类/分包否定式均保持召回', () => {
    for (const sentence of ['专项设计文件尚未完成，待后续补充', '评分指标存在缺口尚未明确', '本工程不进行分包']) {
      expect(SELF_UNDERMINING_PROCEDURAL_EXEMPT_RE.test(sentence)).toBe(false);
    }
  });
  it('S1-5 旧分支回归：⑬ 条件-调配-保障三段式仍豁免', () => {
    expect(SELF_UNDERMINING_PROCEDURAL_EXEMPT_RE.test('对连续3日未完成计划的区段，负责人当日调整班组配置，从已完成区段调拨人员补位，确保工期不突破')).toBe(true);
  });
});

describe('S2 selfUnderminingCandidateIssues 全通道集成（语义恒值 0.9）', () => {
  beforeEach(() => {
    vi.mocked(buildSemanticSimilarity).mockImplementation(CONST_SIM(0.9));
  });
  it('S2-1 ⑭ 监测-纠偏-保障句经全通道豁免 → 零候选', async () => {
    expect(await selfUnderminingCandidateIssues(MONITOR_CORRECT_SENTENCE)).toEqual([]);
  });
  it('S2-2 缺保障尾段的同构句经全通道保持召回 → 1 条候选', async () => {
    const issues = await selfUnderminingCandidateIssues('每次降雨后施工员统计未完成工序与损失工时，项目经理组织资源补充。');
    expect(issues).toHaveLength(1);
  });
  it('S2-3 真伤句全通道召回（待补充类）', async () => {
    const issues = await selfUnderminingCandidateIssues('专项设计文件尚未完成，相关内容待后续补充。');
    expect(issues).toHaveLength(1);
  });
});

describe('S3 SELF_UNDERMINING_PROCEDURAL_EXEMPT_RE r28g 扩围（⑮⑯⑰）', () => {
  it('S3-1 ⑮ 未完成变更前不办理开工令签发（禁办动作）豁免', () => {
    expect(SELF_UNDERMINING_PROCEDURAL_EXEMPT_RE.test('项目经理未完成变更前，项目部不办理开工令签发')).toBe(true);
  });
  it('S3-2 ⑯ 人员准入：未完成信息登记的人员一律不得进入作业面豁免', () => {
    expect(SELF_UNDERMINING_PROCEDURAL_EXEMPT_RE.test('临时作业人员未完成信息登记与安全教育，一律不得进入作业面')).toBe(true);
  });
  it('S3-3 ⑯ 起始词扩围：未取得特种作业资格证不得从事电气焊作业豁免', () => {
    expect(SELF_UNDERMINING_PROCEDURAL_EXEMPT_RE.test('未取得特种作业资格证的人员不得从事电气焊作业')).toBe(true);
  });
  it('S3-4 ⑰ 即时处置：应急物资缺失或过期的当日补充更换豁免', () => {
    expect(SELF_UNDERMINING_PROCEDURAL_EXEMPT_RE.test('应急物资出现缺失或过期的，当日补充更换并登记')).toBe(true);
  });
  it('S3-5 真伤护栏：待补充/缺口类无禁办或处置链保持召回', () => {
    for (const sentence of ['专项设计文件尚未完成，待后续补充', '评分指标存在缺口尚未明确']) {
      expect(SELF_UNDERMINING_PROCEDURAL_EXEMPT_RE.test(sentence)).toBe(false);
    }
  });
});

describe('S4 r28f 门禁自伤候选逐字原文回归（豁免不漏网）', () => {
  // 舞台 r28f 门禁 8 项之 4/5/6 逐字原文（实机正文复刻）：S3 变体句与逐字句存在措辞差异
  //（如「未接受三级安全教育和岗前技术交底」vs 变体「与安全教育」），本组锁逐字形态防豁免覆盖退化
  const VERBATIM = [
    ['S4-1 #4 到岗管控（含尾段履约承诺）', '项目经理未完成变更前，项目部不办理开工令签发，确保项目经理在本项目全面履约'],
    ['S4-2 #5 人员准入（信息登记+三级安全教育+岗前技术交底）', '未完成信息登记、未接受三级安全教育和岗前技术交底的人员，一律不得进入作业面'],
    ['S4-3 #6 即时处置（长前置描述+缺失过期当日补充更换）', '应急物资按方案配置，急救箱、担架、应急照明灯等由材料员每月盘点不少于1次，缺失或过期的当日补充更换'],
  ] as const;
  it.each(VERBATIM)('%s 正则豁免', (_label, sentence) => {
    expect(SELF_UNDERMINING_PROCEDURAL_EXEMPT_RE.test(sentence)).toBe(true);
  });
  it('S4-4 三句逐字全文经全通道零候选（语义恒值 0.9）', async () => {
    vi.mocked(buildSemanticSimilarity).mockImplementation(CONST_SIM(0.9));
    for (const [, sentence] of VERBATIM) {
      expect(await selfUnderminingCandidateIssues(sentence)).toEqual([]);
    }
  });
});
