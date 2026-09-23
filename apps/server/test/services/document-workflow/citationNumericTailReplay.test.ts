/**
 * 4.55.35 链尾蓝图引用数值**最终消费**单测（巢湖 doc-1790132484476 实机归因：终检只检不修）。
 *
 * 实机形态：三条真冲突（工厂灯 1179→1222／A型应急照明集中 1→4／等电位端子箱、测试板 1→27，
 * 均为单条清单行量而非专业小计）在链尾 markdown-only 收口（超长段落切分/句模剥离/复读坍塌/
 * 编制依据引用回补）之后才被重新判定为 conflict，其锚点只在最后一次 recompute 的终检里生成，
 * 无任何修复器再消费——门禁报 blocker 而交付物零改动。根因：判定层结论随判定输入（候选所在句
 * 上下文，缓存键含其稳定哈希）而变，单轮「判定→锚点→替换」只对当轮输入成立。
 *
 * 用例成对覆盖：正例（真冲突收敛到条目权威值，数字本体替换、句式不动）/ 收敛环（替换本身改写
 * 上下文后重判出的新冲突在同一重放内二次消费——单轮重放必漏）/ 反例（检测放过时零锚点 → 零替换、
 * 零 recompute、零事件）/ 幂等（二次重放零变更）/ 接线守护（documentPipeline 真正链尾位置）。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { blueprintCitationVerdict } from '@/services/document-workflow/integratedBlueprint/citation';
import type { BlueprintData, BlueprintQuantity } from '@/services/document-workflow/integratedBlueprint/types';
import type { CitationAdjudicator, CitationAdjudicationCandidate } from '@/services/document-workflow/semanticAdjudication';
import { replayBlueprintCitationNumericFixes } from '@/services/document-workflow/finalize/repairRounds/postReviewSurface';
import type { FinalizeSession } from '@/services/document-workflow/finalize/finalizeSession';

const SRC_DIR = path.resolve(__dirname, '../../../src/services/document-workflow');

const conflictAll: CitationAdjudicator = async (candidates: CitationAdjudicationCandidate[]) => ({
  records: new Map(candidates.map(candidate => [candidate.id, { id: candidate.id, conclusion: 'conflict' as const, rationale: '用例注入：全部视为冲突（隔离结构层判定）' }])),
});

/** 4.55.33 实机形态（巢湖 doc-1790132484476 蓝图 quantities 原值）：
 *  工厂灯 1#厂房安装工程=1222（== 项目级合计）；A型应急照明集中 =4；等电位端子箱、测试板
 *  1#厂房=21／2#门卫=4／3#门卫=2（项目级合计 27）——实机正文引用的 1179／1／1 均非专业小计。 */
function professionShape(): BlueprintData {
  const quantities: Record<string, BlueprintQuantity> = {
    '等电位端子箱、测试板': {
      value: 27,
      unit: '套',
      groups: [
        { group: '1#厂房安装工程', value: 21 },
        { group: '2#门卫安装工程', value: 4 },
        { group: '3#门卫安装工程', value: 2 },
      ],
    },
    '工厂灯': { value: 1222, unit: '套', groups: [{ group: '1#厂房安装工程', value: 1222 }] },
    'A型应急照明集中': { value: 4, unit: '台', groups: [{ group: '1#厂房安装工程', value: 4 }] },
  };
  return {
    quantities,
    redLineFacts: [],
    resources: { labor: { peakValue: 0 } },
    contract: { totalDays: 0 },
    project: { scope: '' },
  } as unknown as BlueprintData;
}

function sessionOf(overrides: Record<string, unknown>): FinalizeSession {
  return {
    blueprintData: professionShape(),
    finalMarkdown: '',
    generationDiagnostics: { quality: { repairedCount: 0 }, llm: { lastInfo: '' } },
    progressStages: [],
    finalGateRepairStages: [],
    recomputeFinalValidationBundle: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as FinalizeSession;
}

/** 对象作用域句（「1#厂房」小节：合法承载本工程专业小计，未登记值仍须报出） */
const scopedSection = (body: string) => `#### 1.4.6 1#厂房\n\n${body}`;

describe('4.55.35 链尾蓝图引用数值最终消费：正例（真冲突收敛到条目权威值）', () => {
  it('实机三条：单轮重放即收敛（数字本体替换，句式结构逐字不动）', async () => {
    const markdown = scopedSection('安装工程含工厂灯1179.000套、A型应急照明集中1.000台、等电位端子箱、测试板1.000套。');
    const session = sessionOf({ finalMarkdown: markdown });
    await replayBlueprintCitationNumericFixes(session, { adjudicate: conflictAll });
    // 收敛方向 = 条目权威值（1222／4／27）；除数字本体外全句逐字不变（无句式改写、无相似度猜值）
    expect(session.finalMarkdown).toBe(scopedSection('安装工程含工厂灯1222套、A型应急照明集中4台、等电位端子箱、测试板27套。'));
    expect(session.recomputeFinalValidationBundle).toHaveBeenCalledTimes(1);
    expect(session.progressStages).toHaveLength(1);
    expect(session.finalGateRepairStages).toHaveLength(1);
    expect(session.progressStages[0]).toMatchObject({ roleId: 'citation-numeric-replay', status: 'success' });
    expect(session.progressStages[0]?.message).toContain('3 处');
    expect(session.progressStages[0]?.message).toContain('工厂灯');
    // 终门禁所检 = 交付所存：对交付成稿同源判定（与门禁检测器同函数）零冲突零锚点
    const delivered = await blueprintCitationVerdict(session.finalMarkdown, session.blueprintData!, { adjudicate: conflictAll });
    expect(delivered.issues).toEqual([]);
    expect(delivered.anchors).toEqual([]);
  });

  it('收敛环：替换改写句上下文后重判出的新冲突在同一重放内被二次消费（单轮重放必漏）', async () => {
    // 判定漂移 stub：A型在同句仍含未修复的 1179 时判 consistent（模型向邻近错误值锚定），
    // 首轮替换工厂灯后同处重判 → conflict（与实机「链尾文本变动击穿判定缓存 → 重判」同机制）
    const driftAdjudicator: CitationAdjudicator = async (candidates: CitationAdjudicationCandidate[]) => ({
      records: new Map(candidates.map(candidate => [candidate.id, candidate.subject === '工厂灯'
        ? { id: candidate.id, conclusion: 'conflict' as const, rationale: '首轮即报冲突' }
        : {
            id: candidate.id,
            conclusion: (candidate.sentence.includes('1179') ? 'consistent' : 'conflict') as 'consistent' | 'conflict',
            rationale: '判定漂移 stub：原句上下文判一致，替换后同处重判冲突',
          }])),
    });
    const session = sessionOf({ finalMarkdown: scopedSection('安装工程含工厂灯1179.000套、A型应急照明集中1.000台。') });
    await replayBlueprintCitationNumericFixes(session, { adjudicate: driftAdjudicator });
    expect(session.finalMarkdown).toBe(scopedSection('安装工程含工厂灯1222套、A型应急照明集中4台。'));
    expect(session.progressStages).toHaveLength(1);
    expect(session.progressStages[0]?.message).toContain('2 处');
    expect(session.recomputeFinalValidationBundle).toHaveBeenCalledTimes(1);
  });
});

describe('4.55.35 链尾蓝图引用数值最终消费：反例（检测放过 → 零替换）与幂等', () => {
  it('检测放过时零锚点零替换（值 == 权威 / 已登记专业小计放行；注入「全判冲突」裁决器仍不动）', async () => {
    const markdown = scopedSection('安装工程含工厂灯1222.000套，等电位端子箱、测试板21.000套。');
    const session = sessionOf({ finalMarkdown: markdown });
    await replayBlueprintCitationNumericFixes(session, { adjudicate: conflictAll });
    expect(session.finalMarkdown).toBe(markdown);
    expect(session.recomputeFinalValidationBundle).not.toHaveBeenCalled();
    expect(session.progressStages).toHaveLength(0);
    expect(session.finalGateRepairStages).toHaveLength(0);
  });

  it('幂等：同会话二次重放零变更（不追加 stage、不重复 recompute）', async () => {
    const session = sessionOf({ finalMarkdown: scopedSection('安装工程含工厂灯1179.000套。') });
    await replayBlueprintCitationNumericFixes(session, { adjudicate: conflictAll });
    expect(session.finalMarkdown).toContain('工厂灯1222套');
    await replayBlueprintCitationNumericFixes(session, { adjudicate: conflictAll });
    expect(session.finalMarkdown).toBe(scopedSection('安装工程含工厂灯1222套。'));
    expect(session.recomputeFinalValidationBundle).toHaveBeenCalledTimes(1);
    expect(session.progressStages).toHaveLength(1);
  });

  it('无蓝图：短路静默（零成本零事件）', async () => {
    const session = sessionOf({ blueprintData: null, finalMarkdown: '工厂灯1179.000套。' });
    await expect(replayBlueprintCitationNumericFixes(session)).resolves.toBeUndefined();
    expect(session.finalMarkdown).toBe('工厂灯1179.000套。');
    expect(session.recomputeFinalValidationBundle).not.toHaveBeenCalled();
    expect(session.progressStages).toHaveLength(0);
  });
});

describe('4.55.35 接线守护：链尾最终消费点位置与同源收敛环', () => {
  it('documentPipeline：最终消费点在编制依据回补之后、stageFinalGate 之前，且其后无任何正文改写', () => {
    const source = readFileSync(path.join(SRC_DIR, 'documentPipeline.ts'), 'utf8');
    const needle = 'await replayBlueprintCitationNumericFixes(session);';
    const tailIndex = source.lastIndexOf(needle);
    const gateIndex = source.indexOf('await stageFinalGate(session);');
    expect(tailIndex).toBeGreaterThan(source.indexOf('const citationReplay = replayTailStrippedBasisCitations(session);'));
    expect(tailIndex).toBeGreaterThan(source.indexOf('const basisBackfill = backfillUsedNotDeclared(session);'));
    expect(tailIndex).toBeLessThan(gateIndex);
    // 最终消费点与终门禁之间不得夹带任何改写正文的语句（若新增链尾轮，须整体评估重放顺序）
    // ——终门禁所检 = 交付所存：判定输入必须就是交付成稿
    const betweenTailAndGate = source.slice(tailIndex + needle.length, gateIndex);
    expect(betweenTailAndGate).not.toMatch(/finalMarkdown\s*=[^=]/u);
    expect(betweenTailAndGate).not.toMatch(/await (?:stage|replay|backfill)\w*\(session/u);
    // 上游重放点保留（既有接线守护依赖首次出现位置）
    expect(source.indexOf(needle)).toBeLessThan(tailIndex);
  });

  it('postReviewSurface：判定-替换为同源收敛环（同裁决器同输入，上限封顶，无相似度猜值）', () => {
    const source = readFileSync(path.join(SRC_DIR, 'finalize/repairRounds/postReviewSurface.ts'), 'utf8');
    expect(source).toContain('const CITATION_REPLAY_MAX_PASSES = 3;');
    expect(source).toContain('for (let pass = 0; pass < CITATION_REPLAY_MAX_PASSES; pass += 1) {');
    // 替换素材唯一来源 = 判定层锚点（检测放过 → 零锚点 → 零替换）
    expect(source).toContain('quantityAnchors: citationReplayVerdict.anchors');
    // 同源判定：默认裁决器缺省即终检检测器所用裁决器（测试可注入，生产不注入）
    expect(source).toContain('...(options.adjudicate ? { adjudicate: options.adjudicate } : {})');
  });
});
