/**
 * repairRounds · 交付结构收口轮（delivery-structure-closure）：
 * D-T6 ①③（r28f 门禁 #1「目录 29 节 vs 正文 28 节」+ 终检长段归因）——fixTocFromBody
 * 原调用点在 postReviewSurface（链中段），其后各 draft-mutating 轮 rebuild 可改变正文 H3
 * 结构（目录漂移）；>380 字符超长段落写作期切分（splitLongParagraphs）覆盖不到链尾
 * rebuild/补写句拼接引入的长行。本测试锁定：
 * 1. 接线：FINALIZE 声明表（section-alignment-sweep 之后、stageFinalGate 之前）+
 *    documentPipeline 调用位置（最后净变更点之后、stageFinalGate 之前）；
 * 2. 轮行为（markdown-only 零 LLM）：超长段落切分 / 目录按正文实际结构重建 / 零改动核对通过；
 * 3. 切分器矩阵（splitOverlengthBodyParagraphs 直测）：M11 行级化——块内单换行保真
 *    （长行切分不吞标题行）/混合块长正文行切分+表格行逐行原样/不可切分长行零 churn/
 *    表格行原样/目录区行保留/幂等/正文零丢失。
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/document-workflow/semanticSimilarity', () => ({
  buildSemanticSimilarity: vi.fn(async () => () => 0),
  snapshotEmbedCacheStats: vi.fn(() => ({ embedCacheHits: 0, embedCacheMisses: 0 })),
  getLocalSemanticProvider: vi.fn(() => ({ embedDocuments: vi.fn(async (texts: string[]) => texts.map(() => [0, 0])) })),
  SEMANTIC_COVERAGE_THRESHOLD: 0.6,
  clearEmbedCacheForTest: vi.fn(),
}));

import { FINALIZE_REPAIR_ROUNDS } from '@/services/document-workflow/detectorFixerRegistry';
import { stageDeliveryStructureClosure } from '@/services/document-workflow/finalize/repairRounds/deliveryStructureClosure';
import { replaySurfacePunctuationClosure } from '@/services/document-workflow/finalize/repairRounds/postReviewSurface';
import { splitOverlengthBodyParagraphs } from '@/services/document-workflow/helpers/markdownCleanup';
import type { FinalizeSession } from '@/services/document-workflow/finalize/finalizeSession';

const SRC_DIR = path.resolve(__dirname, '../../../src/services/document-workflow');

/** 超长段落构造：19 字短句 × 25 = 475 字符单行（>380 触发切分，切后各段 ≤360+单句） */
const LONG_PARAGRAPH = '本工程各分项工序按既定流程逐项落实到位。'.repeat(25);

/** 目录漂移形态：目录列 1.2 项目概况（正文无此节），正文实际有 2.1 总体部署（目录缺） */
const TOC_DRIFT_MARKDOWN = [
  '## 目录',
  '',
  '第一章 工程概况',
  '  1.1 编制依据',
  '  1.2 项目概况',
  '',
  '## 第一章 工程概况',
  '',
  '### 1.1 编制依据',
  '依据正文。',
  '',
  '## 第二章 施工部署',
  '',
  '### 2.1 总体部署',
  '部署正文。',
].join('\n');

interface StageLike { roleId?: string; status?: string; message?: string; details?: string[] }

function stageOf(stages: StageLike[], roleId: string): StageLike | undefined {
  return stages.find(stage => stage.roleId === roleId);
}

function makeSession(markdown: string) {
  return {
    finalChapterDrafts: [],
    progressStages: [] as StageLike[],
    finalGateRepairStages: [] as StageLike[],
    finalMarkdown: markdown,
    emitProgress: vi.fn(),
    recomputeFinalValidationBundle: vi.fn(async () => {}),
  } as unknown as FinalizeSession;
}

describe('delivery-structure-closure 接线（防「修复器存在但未接线」回归）', () => {
  it('FINALIZE 声明表：位于 section-alignment-sweep 之后（链尾 markdown-only 收口）', () => {
    const rounds = [...FINALIZE_REPAIR_ROUNDS];
    const alignIndex = rounds.indexOf('section-alignment-sweep');
    const closureIndex = rounds.indexOf('delivery-structure-closure');
    expect(closureIndex).toBeGreaterThan(alignIndex);
    expect(closureIndex).toBe(rounds.length - 1);
  });

  it('documentPipeline.ts 在最后净变更点之后、stageFinalGate 之前调用', () => {
    const source = readFileSync(path.join(SRC_DIR, 'documentPipeline.ts'), 'utf8');
    const tailClosureIndex = source.indexOf('await replayRequirementTailClosure(session);');
    const closureIndex = source.indexOf('await stageDeliveryStructureClosure(session);');
    const gateIndex = source.indexOf('await stageFinalGate(session);');
    expect(tailClosureIndex).toBeGreaterThan(-1);
    expect(closureIndex).toBeGreaterThan(tailClosureIndex);
    expect(gateIndex).toBeGreaterThan(closureIndex);
  });

  it('r28h M3：链尾标点终局收口位于交付结构收口之后、stageFinalGate 之前', () => {
    const source = readFileSync(path.join(SRC_DIR, 'documentPipeline.ts'), 'utf8');
    const closureIndex = source.indexOf('await stageDeliveryStructureClosure(session);');
    const punctuationIndex = source.indexOf('await replaySurfacePunctuationClosure(session);');
    const gateIndex = source.indexOf('await stageFinalGate(session);');
    expect(punctuationIndex).toBeGreaterThan(closureIndex);
    expect(gateIndex).toBeGreaterThan(punctuationIndex);
  });
});

describe('delivery-structure-closure 行为矩阵', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('超长段落切分：>380 单行切句重组 + recompute + 明细', async () => {
    const session = makeSession(LONG_PARAGRAPH);
    await stageDeliveryStructureClosure(session);
    const lines = session.finalMarkdown.split('\n');
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every(line => line.length <= 380)).toBe(true);
    // 正文零丢失：去除全部空白字符后与原文一致（切分只增段界）
    expect(session.finalMarkdown.replace(/\s/gu, '')).toBe(LONG_PARAGRAPH.replace(/\s/gu, ''));
    expect(session.recomputeFinalValidationBundle).toHaveBeenCalledTimes(1);
    const stage = stageOf(session.progressStages, 'delivery-structure-closure');
    expect(stage?.status).toBe('success');
    expect(stage?.message).toContain('超长段落切分：消除 >380 字符段落 1 处');
    expect(stageOf(session.finalGateRepairStages, 'delivery-structure-closure')?.status).toBe('success');
  });

  it('目录按正文实际结构重建：漂移条目清除、正文新增小节补入', async () => {
    const session = makeSession(TOC_DRIFT_MARKDOWN);
    await stageDeliveryStructureClosure(session);
    expect(session.finalMarkdown).toContain('第二章 施工部署\n  2.1 总体部署');
    expect(session.finalMarkdown).not.toContain('1.2 项目概况');
    expect(session.finalMarkdown).toContain('  1.1 编制依据');
    expect(session.recomputeFinalValidationBundle).toHaveBeenCalledTimes(1);
    expect(stageOf(session.progressStages, 'delivery-structure-closure')?.message).toContain('目录按正文 H2/H3 实际结构重建');
  });

  it('零改动形态：核对通过（无 recompute）', async () => {
    const clean = '## 第一章 工程概况\n\n### 1.1 编制依据\n依据正文。';
    const session = makeSession(clean);
    await stageDeliveryStructureClosure(session);
    expect(session.finalMarkdown).toBe(clean);
    expect(session.recomputeFinalValidationBundle).not.toHaveBeenCalled();
    const stage = stageOf(session.progressStages, 'delivery-structure-closure');
    expect(stage?.status).toBe('success');
    expect(stage?.message).toBe('交付结构收口核对通过：目录与正文一致、无超长段落');
  });
});

describe('splitOverlengthBodyParagraphs 切分器矩阵（D-T6 ③）', () => {
  it('超长段落切句重组：切后无 >380 行、正文零丢失、幂等', () => {
    const result = splitOverlengthBodyParagraphs(LONG_PARAGRAPH);
    expect(result.splitCount).toBe(1);
    const lines = result.markdown.split('\n');
    expect(lines.every(line => line.length <= 380)).toBe(true);
    expect(result.markdown.replace(/\s/gu, '')).toBe(LONG_PARAGRAPH.replace(/\s/gu, ''));
    // 幂等：复跑零变更
    const again = splitOverlengthBodyParagraphs(result.markdown);
    expect(again.splitCount).toBe(0);
    expect(again.markdown).toBe(result.markdown);
  });

  it('表格行块首：>380 表行整体跳过（表格结构零风险）', () => {
    const tableLine = `| ${'甲'.repeat(190)} | ${'乙'.repeat(190)} |`;
    expect(tableLine.length).toBeGreaterThan(380);
    const result = splitOverlengthBodyParagraphs(tableLine);
    expect(result.splitCount).toBe(0);
    expect(result.markdown).toBe(tableLine);
  });

  it('M11 块内换行保真：长正文行切分不吞块内单换行——H4/H2 标题行保持独占行（r28i 行内标题粘连根因）', () => {
    // r28i 形态复现：「正文。\n#### 标题」「依据。\n## 第九章」由单换行连接，\n{2,} 不分割 → 同一块
    const markdown = [
      '合格标准。',
      '#### 8.1.1 进度计划与关键线路',
      LONG_PARAGRAPH,
      '依据。',
      '## 第九章 确保文明施工的技术组织措施',
      LONG_PARAGRAPH,
    ].join('\n');
    const result = splitOverlengthBodyParagraphs(markdown);
    // 两条长正文行被切分（行级：仅超长行处理，旧块级版会把标题行并入正文行）
    expect(result.splitCount).toBe(2);
    expect(result.markdown.split('\n').every(line => line.length <= 380)).toBe(true);
    // 标题行未被并入相邻正文行（终检按 ^ 行首匹配标题的前提）
    expect(result.markdown).toContain('合格标准。\n#### 8.1.1 进度计划与关键线路\n');
    expect(result.markdown).toContain('依据。\n## 第九章 确保文明施工的技术组织措施\n');
    expect(result.markdown).not.toMatch(/[^#\n]#{2,4} /u);
    // 正文零丢失
    expect(result.markdown.replace(/\s/gu, '')).toBe(markdown.replace(/\s/gu, ''));
    // 幂等
    const again = splitOverlengthBodyParagraphs(result.markdown);
    expect(again.splitCount).toBe(0);
    expect(again.markdown).toBe(result.markdown);
  });

  it('M11 混合块：长正文行被切分、表格行逐行原样（旧版整块跳过导致长行残留）', () => {
    const block = [LONG_PARAGRAPH, '| 项目 | 状态 |', '| 甲 | 乙 |'].join('\n');
    const result = splitOverlengthBodyParagraphs(block);
    expect(result.splitCount).toBe(1);
    expect(result.markdown).toContain('\n| 项目 | 状态 |\n| 甲 | 乙 |');
    expect(result.markdown.split('\n').every(line => line.length <= 380)).toBe(true);
    expect(result.markdown.replace(/\s/gu, '')).toBe(block.replace(/\s/gu, ''));
  });

  it('不可切分长行：无句读标点超长行零 churn 原样返回（切句兜底失效时不破坏原文）', () => {
    const block = [`正文引导句${'内'.repeat(380)}`, '| 项目 | 状态 |'].join('\n');
    const result = splitOverlengthBodyParagraphs(block);
    expect(result.splitCount).toBe(0);
    expect(result.markdown).toBe(block);
  });

  it('目录区行保留：区内超长行不切分（目录结构行零风险）', () => {
    const markdown = ['## 目录', '', `  第一章 ${'名'.repeat(380)}`, '', '## 第一章 工程概况', '正文。'].join('\n');
    const result = splitOverlengthBodyParagraphs(markdown);
    expect(result.splitCount).toBe(0);
    expect(result.markdown).toBe(markdown);
  });
});

describe('r28h M3 链尾标点终局收口（replaySurfacePunctuationClosure）', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('含标点残留：修复 + recompute + 双写事件（终门禁所检=交付所存）', async () => {
    const session = makeSession('宽度按3m、、、、等设计路幅控制。');
    await replaySurfacePunctuationClosure(session);
    expect(session.finalMarkdown).not.toContain('、、');
    expect(session.finalMarkdown).toContain('宽度按3m、等设计路幅控制。');
    expect(session.recomputeFinalValidationBundle).toHaveBeenCalledTimes(1);
    const stage = stageOf(session.progressStages, 'surface-punctuation-closure');
    expect(stage?.status).toBe('success');
    expect(stage?.message).toContain('链尾表面终局收口');
    expect(stageOf(session.finalGateRepairStages, 'surface-punctuation-closure')?.status).toBe('success');
  });

  it('零残留：零成本静默（不 recompute、不记事件、幂等可重放）', async () => {
    const clean = makeSession('正常正文，无标点残留。');
    await replaySurfacePunctuationClosure(clean);
    expect(clean.finalMarkdown).toBe('正常正文，无标点残留。');
    expect(clean.recomputeFinalValidationBundle).not.toHaveBeenCalled();
    expect(stageOf(clean.progressStages, 'surface-punctuation-closure')).toBeUndefined();
  });

  it('r28j 扩围：叠词/零长区间同轮触发修复 + 明细并入事件（链尾表面终局收口链）', async () => {
    const session = makeSession('本项目工程工程量按清单计量。预留开工后第360日至第360日作为联调复验与移交缓冲。');
    await replaySurfacePunctuationClosure(session);
    expect(session.finalMarkdown).not.toContain('工程工程');
    expect(session.finalMarkdown).toContain('本项目工程量按清单计量');
    expect(session.finalMarkdown).not.toContain('第360日至第360日');
    expect(session.finalMarkdown).toContain('预留开工后第360日作为联调复验与移交缓冲');
    expect(session.recomputeFinalValidationBundle).toHaveBeenCalledTimes(1);
    const stage = stageOf(session.progressStages, 'surface-punctuation-closure');
    expect(stage?.message).toContain('叠词重复收敛');
    expect(stage?.message).toContain('同日零长区间收敛');
    expect(stageOf(session.finalGateRepairStages, 'surface-punctuation-closure')?.status).toBe('success');
  });

  it('r28j 扩围：多块混合一轮只 recompute 一次 + 收敛后幂等重放静默', async () => {
    const session = makeSession('宽度按3m、、、、等路幅控制。本项目工程工程量按清单计量。');
    await replaySurfacePunctuationClosure(session);
    expect(session.finalMarkdown).not.toContain('、、');
    expect(session.finalMarkdown).not.toContain('工程工程');
    expect(session.recomputeFinalValidationBundle).toHaveBeenCalledTimes(1);
    const stage = stageOf(session.progressStages, 'surface-punctuation-closure');
    expect(stage?.message).toContain('标点叠用收敛');
    expect(stage?.message).toContain('叠词重复收敛');
    // 幂等重放：修复后成稿再跑一次 → 全链零变化静默
    const settled = makeSession(session.finalMarkdown);
    await replaySurfacePunctuationClosure(settled);
    expect(settled.recomputeFinalValidationBundle).not.toHaveBeenCalled();
    expect(stageOf(settled.progressStages, 'surface-punctuation-closure')).toBeUndefined();
  });
});
