/**
 * duplicate-sentence-collapse 行为矩阵（C8 S5 修复轮永久固化）：
 * 1. 同章复读坍塌：完全重复句（比较键=去标点归一化、≥12 字）保首次删后续，行内吞前导空白与
 *    句末分隔符后 trim；标点变体同 key 同样判重（与 uniqueness/duplicateSentenceRate 单源同口径）；
 * 2. 跨章判定：仅首现句命中泛化归口帧（GENERALIZED_CLOSURE_SENTENCE_RE）者坍塌（s28m' 归因
 *    主体「上述要求纳入…」类），跨章业务句（合理重申，如标段划分）保留入 keptSentences；
 * 3. 幂等与单源：坍塌后重放零变更；出现明细 duplicateSentenceOccurrences 与删除定位逐字一致
 *    （检测定位=修复定位）；单行多组复读从后往前删不破坏索引；
 * 4. 防误伤：<12 字比较键不入池（「（9）发现脏、差，有缺损。」类）、标题/表格/目录聚簇行不入池、
 *    单次出现句零删除；
 * 5. stage 接线：removedCount>0 时写回 finalMarkdown 并复算、0 时零变更；进度双数组 upsert。
 * 断言按源码实现推导，真实行为锁定，不修改实现迎合用例。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  collapseDuplicateSentences,
  stageDuplicateSentenceCollapse,
} from '@/services/document-workflow/finalize/repairRounds/duplicateSentenceCollapse';
import { duplicateSentenceOccurrences } from '@/services/document-workflow/tenderBidScoring';
import { GENERALIZED_CLOSURE_SENTENCE_RE } from '@/services/document-workflow/templatingGovernance';
import type { FinalizeSession } from '@/services/document-workflow/finalize/finalizeSession';

/** 同章复读样本（≥12 字正文句；数字仅出现在句中不构成独立锚点） */
const DUP_SENTENCE = '基坑开挖前完成降水井施工并试运行合格，地下水位低于基底标高不少于0.5米。';
const DUP_RAW = DUP_SENTENCE.slice(0, -1);
const SAME_CHAPTER_MD = [
  '## 第一章 施工方案',
  '',
  DUP_SENTENCE,
  '本节其余内容按图纸执行。',
  DUP_SENTENCE,
].join('\n');

/** 跨章泛化归口帧样本（s28m' 归因主体形态） */
const CLOSURE_SENTENCE = '上述要求纳入每日检查、每周复核范围，由项目技术负责人组织实施并留存记录。';
const CLOSURE_RAW = CLOSURE_SENTENCE.slice(0, -1);
const GENERALIZED_MD = [
  '## 第一章 质量保证体系',
  '',
  CLOSURE_SENTENCE,
  '',
  '## 第二章 安全保证措施',
  '',
  CLOSURE_SENTENCE,
].join('\n');

/** 跨章业务句样本（合理重申：标段划分——不坍塌） */
const BUSINESS_SENTENCE = '本工程共划分两个施工标段，一标段为场地平整及基坑开挖，二标段为主体结构施工。';
const BUSINESS_RAW = BUSINESS_SENTENCE.slice(0, -1);
const BUSINESS_MD = [
  '## 第一章 施工部署',
  '',
  BUSINESS_SENTENCE,
  '',
  '## 第二章 施工进度计划',
  '',
  BUSINESS_SENTENCE,
].join('\n');

function makeSession(finalMarkdown: string) {
  const session = {
    finalMarkdown,
    finalChapterDrafts: [],
    progressStages: [] as Array<{ roleId?: string; status?: string; message?: string; details?: string[] }>,
    finalGateRepairStages: [] as Array<{ roleId?: string; status?: string; message?: string; details?: string[] }>,
    emitProgress: vi.fn(),
    recomputeFinalValidationBundle: vi.fn(async () => {}),
  };
  return session as unknown as FinalizeSession & typeof session;
}

function stageOf(stages: Array<{ roleId?: string }>, roleId: string) {
  return stages.find(stage => stage.roleId === roleId) as
    | { roleId?: string; status?: string; message?: string; details?: string[] }
    | undefined;
}

describe('collapseDuplicateSentences · 同章复读坍塌（保首次删后续）', () => {
  it('完全重复句：第二处整行删除（吞句末分隔符落空行），计数与明细逐项核对', () => {
    const result = collapseDuplicateSentences(SAME_CHAPTER_MD);
    expect(result.removedCount).toBe(1);
    expect(result.sameChapterRemoved).toBe(1);
    expect(result.generalizedRemoved).toBe(0);
    expect(result.removedSentences).toEqual([DUP_RAW]);
    expect(result.keptSentences).toEqual([]);
    expect(result.markdown).toBe(
      ['## 第一章 施工方案', '', DUP_SENTENCE, '本节其余内容按图纸执行。', ''].join('\n'),
    );
  });

  it('标点变体同 key：去标点归一化口径判重（与 uniqueness 统计单源），第二形态坍塌', () => {
    const CANON = '管道试压合格后填写记录并经监理签认后方可回填，记录一式三份归档留存。';
    const VARIANT = '管道试压合格后填写记录,并经监理签认后方可回填,记录一式三份归档留存。';
    const markdown = ['## 第一章 质量记录', '', CANON, VARIANT].join('\n');
    const result = collapseDuplicateSentences(markdown);
    expect(result.removedCount).toBe(1);
    expect(result.removedSentences).toEqual([VARIANT.slice(0, -1)]);
    expect(result.markdown).toBe(['## 第一章 质量记录', '', CANON, ''].join('\n'));
  });

  it('行内有后续内容：仅删复读句本体，前导空白与句末分隔符一并消化、行 trim 保留', () => {
    const HEAD = '首段复读句内容超过十二个字符以确保入池检测。';
    const TAIL = '尾部内容保持原样不被删除。';
    const markdown = ['## 第一章 施工准备', '', HEAD, `  ${HEAD}${TAIL}`].join('\n');
    const result = collapseDuplicateSentences(markdown);
    expect(result.removedCount).toBe(1);
    expect(result.markdown).toBe(['## 第一章 施工准备', '', HEAD, TAIL].join('\n'));
  });

  it('连续空行压缩：四连以上换行压为三连（三连以上空行合并）', () => {
    const DUP2 = '降水井封堵采用同强度等级混凝土并振捣密实。';
    const markdown = ['## 第一章 降水工程', '', DUP2, '', '', DUP2, ''].join('\n');
    const result = collapseDuplicateSentences(markdown);
    expect(result.removedCount).toBe(1);
    expect(result.markdown).toBe(`## 第一章 降水工程\n\n${DUP2}\n\n\n`);
  });
});

describe('collapseDuplicateSentences · 跨章判定（泛化归口坍塌 / 业务句保留）', () => {
  it('跨章泛化归口帧：首现句命中 GENERALIZED_CLOSURE_SENTENCE_RE 才坍塌', () => {
    expect(GENERALIZED_CLOSURE_SENTENCE_RE.test(CLOSURE_RAW)).toBe(true);
    const result = collapseDuplicateSentences(GENERALIZED_MD);
    expect(result.removedCount).toBe(1);
    expect(result.sameChapterRemoved).toBe(0);
    expect(result.generalizedRemoved).toBe(1);
    expect(result.removedSentences).toEqual([CLOSURE_RAW]);
    expect(result.markdown).toBe(
      ['## 第一章 质量保证体系', '', CLOSURE_SENTENCE, '', '## 第二章 安全保证措施', '', ''].join('\n'),
    );
  });

  it('跨章业务句复读：非泛化帧合理重申不坍塌，明细入 keptSentences 且零变更原样返回', () => {
    expect(GENERALIZED_CLOSURE_SENTENCE_RE.test(BUSINESS_RAW)).toBe(false);
    const result = collapseDuplicateSentences(BUSINESS_MD);
    expect(result.removedCount).toBe(0);
    expect(result.removedSentences).toEqual([]);
    expect(result.keptSentences).toEqual([BUSINESS_RAW]);
    expect(result.markdown).toBe(BUSINESS_MD);
  });
});

describe('collapseDuplicateSentences · 幂等与单源定位', () => {
  it('坍塌后重放零变更；检测端出现明细与删除定位逐字一致（检测定位=修复定位）', () => {
    const groups = duplicateSentenceOccurrences(SAME_CHAPTER_MD).filter(group => group.occurrences.length >= 2);
    expect(groups).toHaveLength(1);
    expect(groups[0].occurrences).toHaveLength(2);
    const lines = SAME_CHAPTER_MD.split('\n');
    for (const occurrence of groups[0].occurrences) {
      expect(lines[occurrence.lineIndex].slice(occurrence.start, occurrence.end)).toBe(DUP_RAW);
    }
    const first = collapseDuplicateSentences(SAME_CHAPTER_MD);
    const second = collapseDuplicateSentences(first.markdown);
    expect(second.removedCount).toBe(0);
    expect(second.markdown).toBe(first.markdown);
    expect(duplicateSentenceOccurrences(first.markdown).filter(group => group.occurrences.length >= 2)).toEqual([]);
  });

  it('单行多组复读：两删除区间从后往前消化，索引互不破坏、行内容精确剩余', () => {
    const S1 = '隧道初支喷射混凝土强度按C25控制并做试块检测。';
    const S2 = '二衬止水带搭接长度不小于100毫米并逐环检查。';
    const LINE = S1 + S2;
    const markdown = ['## 第一章 主体结构', '', LINE, LINE].join('\n');
    const result = collapseDuplicateSentences(markdown);
    expect(result.removedCount).toBe(2);
    expect(result.sameChapterRemoved).toBe(2);
    expect(result.markdown).toBe(['## 第一章 主体结构', '', LINE, ''].join('\n'));
  });
});

describe('collapseDuplicateSentences · 防误伤（不入池 / 单次出现）', () => {
  it('<12 字比较键不入池：（9）发现脏、差，有缺损。 双现零删除（S1 短条款同形样本）', () => {
    const SHORT = '（9）发现脏、差，有缺损。';
    const markdown = ['## 第一章 现场检查', '', SHORT + SHORT].join('\n');
    const result = collapseDuplicateSentences(markdown);
    expect(result.removedCount).toBe(0);
    expect(result.keptSentences).toEqual([]);
    expect(result.markdown).toBe(markdown);
  });

  it('排除行不入池：标题重复行 / 表格重复行 / 无句读目录聚簇行 → 零删除', () => {
    const ROW = '| 值班室节能按乙类公共建筑节能设计标准执行 |';
    const TOC = '工程概况 主要施工内容 第六章 保障措施 1.1 编制说明 1.2 编制目标';
    const markdown = [
      '## 第一章 节能设计',
      '',
      '## 第一章 节能设计',
      '',
      ROW,
      ROW,
      TOC,
      TOC,
    ].join('\n');
    const result = collapseDuplicateSentences(markdown);
    expect(result.removedCount).toBe(0);
    expect(result.markdown).toBe(markdown);
  });

  it('单次出现句零删除：≥12 字唯一正文句（含数字/单位）原样返回', () => {
    const markdown = [
      '## 第一章 测量放线',
      '',
      '场地平整后按测绘院交桩点位布设控制网并复核闭合差，精度满足二级导线要求。',
    ].join('\n');
    const result = collapseDuplicateSentences(markdown);
    expect(result.removedCount).toBe(0);
    expect(result.markdown).toBe(markdown);
  });
});

describe('stageDuplicateSentenceCollapse · 接线（写回/复算/进度）', () => {
  it('removedCount>0：finalMarkdown 写回成稿 + recompute 复算 + 双进度数组 upsert + 构成明细', async () => {
    const session = makeSession(SAME_CHAPTER_MD);
    await stageDuplicateSentenceCollapse(session);
    expect(session.finalMarkdown).toBe(
      ['## 第一章 施工方案', '', DUP_SENTENCE, '本节其余内容按图纸执行。', ''].join('\n'),
    );
    expect(session.recomputeFinalValidationBundle).toHaveBeenCalledTimes(1);
    const stage = stageOf(session.progressStages, 'duplicate-sentence-collapse');
    expect(stage?.status).toBe('success');
    expect(stage?.message).toContain('完全重复句保首次删后续 1 处');
    expect(stage?.message).toContain('同章复读 1 处');
    expect(stage?.message).toContain('跨章泛化归口复读 0 处');
    expect(stage?.details).toEqual([`复读坍塌：「${DUP_RAW}」`]);
    expect(stageOf(session.finalGateRepairStages, 'duplicate-sentence-collapse')).toBeDefined();
    expect(session.emitProgress).toHaveBeenCalledTimes(1);
  });

  it('removedCount=0：零变更通过（不写回、不复算），跨章业务保留入 details', async () => {
    const session = makeSession(BUSINESS_MD);
    await stageDuplicateSentenceCollapse(session);
    expect(session.finalMarkdown).toBe(BUSINESS_MD);
    expect(session.recomputeFinalValidationBundle).not.toHaveBeenCalled();
    const stage = stageOf(session.progressStages, 'duplicate-sentence-collapse');
    expect(stage?.message).toBe('句级复读核对通过：无完全重复句残留');
    expect(stage?.details).toEqual(['跨章业务复读保留 1 种（合理重申不坍塌）']);
    expect(stageOf(session.finalGateRepairStages, 'duplicate-sentence-collapse')).toBeDefined();
    expect(session.emitProgress).toHaveBeenCalledTimes(1);
  });
});
