/**
 * templating-tail-replay 行为矩阵（C8 S6 修复轮永久固化）：
 * 1. 前缀句确定性删除：零信息前缀句（词首命中 TEMPLATE_PREFIX_HEAD_RE + 零信息硬闸通过）整行删除；
 *    数字锚点/岗位锚点句硬闸拒删（targetCount 与删除数分离——审计透明，与合成样本探针蓝本等价）；
 * 2. 章内重复段落去重：≥40 字指纹完全重复段保首次删后续（章内作用域）；跨章复用段不删
 *    （seen 随章调用新建——跨章重复由终检报告兜底，与 templating-sweep 同口径）；
 * 3. 头区与防误伤：首个 `## ` 前头区不参与；无章界文档整函数早退零变更；H3 前缀形态标题行与
 *    列表行不入句池（isFillerPoolExcludedLine 单源排除，不针对标题字面量硬编码）；
 * 4. 组合与幂等：前缀删除+段落去重双通道同轮落地；重放零变更（无目标/已删净时零成本）；
 * 5. stage 接线：有落地时写回 finalMarkdown + 复算、零变更时原样；进度双数组 upsert。
 * 断言按源码实现推导，真实行为锁定，不修改实现迎合用例。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  replayTemplatingOnMarkdown,
  stageTemplatingTailReplay,
} from '@/services/document-workflow/finalize/repairRounds/templatingTailReplay';
import type { FinalizeSession } from '@/services/document-workflow/finalize/finalizeSession';

/** 零信息前缀句（词首命中 + 硬闸全通 → 确定性删除） */
const PREFIX_CLEAN = '本节将从施工准备、资源配置、进度安排等方面进行总体说明。';
const PREFIX_CLEAN_RAW = PREFIX_CLEAN.slice(0, -1);
/** 数字锚点前缀句（硬闸拒删：含阿拉伯数字） */
const PREFIX_NUMBERED = '本章主要介绍基础工程与主体结构施工的流水段划分，共分2个作业面组织实施。';
/** 岗位锚点前缀句（硬闸拒删：含「项目技术负责人」） */
const PREFIX_POSITION = '以下将就质量控制要点进行说明，由项目技术负责人组织开展验收记录留存。';
/** ≥40 字段落（章内完全重复 → 保首次删后续；跨章复用保留） */
const PARAGRAPH = '危险源辨识覆盖基坑支护、装配式构件吊装、高处作业、临时用电及有限空间作业等全部环节，逐项明确控制措施、责任岗位与检查频次。';

const PREFIX_MD = [
  '## 第一章 施工方案',
  '',
  PREFIX_CLEAN,
  PREFIX_NUMBERED,
  PREFIX_POSITION,
  '测量放线按测绘院交桩点位布设控制网并复核闭合差。',
].join('\n');

const PARAGRAPH_MD = [
  '## 第二章 安全保证措施',
  '',
  PARAGRAPH,
  '',
  '其他内容段。',
  '',
  PARAGRAPH,
].join('\n');

const COMBINED_MD = `${PREFIX_MD}\n\n${PARAGRAPH_MD}`;

const COMBINED_EXPECTED = [
  '## 第一章 施工方案',
  '',
  PREFIX_NUMBERED,
  PREFIX_POSITION,
  '测量放线按测绘院交桩点位布设控制网并复核闭合差。',
  '',
  '## 第二章 安全保证措施',
  '',
  PARAGRAPH,
  '',
  '其他内容段。',
  '',
].join('\n');

const CROSS_CHAPTER_MD = [
  '## 第三章 质量保证措施',
  '',
  PARAGRAPH,
  '',
  '## 第四章 环境保护措施',
  '',
  PARAGRAPH,
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

describe('replayTemplatingOnMarkdown · 前缀句确定性删除（零信息硬闸）', () => {
  it('正样本：零信息前缀句整行删除；数字锚点/岗位锚点句硬闸拒删（锚点数与删除数分离）', () => {
    const result = replayTemplatingOnMarkdown(PREFIX_MD);
    expect(result.prefixRemoved).toBe(1);
    expect(result.prefixSentences).toEqual([PREFIX_CLEAN_RAW]);
    expect(result.targetCount).toBe(3);
    expect(result.paragraphRemoved).toBe(0);
    expect(result.markdown).toBe(
      ['## 第一章 施工方案', '', PREFIX_NUMBERED, PREFIX_POSITION, '测量放线按测绘院交桩点位布设控制网并复核闭合差。'].join('\n'),
    );
  });

  it('反样本：数字/岗位锚点句全部拒删 → 零变更且锚点数 > 0（审计透明）', () => {
    const markdown = ['## 第一章 施工部署', '', PREFIX_NUMBERED, PREFIX_POSITION].join('\n');
    const result = replayTemplatingOnMarkdown(markdown);
    expect(result.prefixRemoved).toBe(0);
    expect(result.targetCount).toBe(2);
    expect(result.prefixSentences).toEqual([]);
    expect(result.markdown).toBe(markdown);
  });
});

describe('replayTemplatingOnMarkdown · 章内重复段落去重（≥40 字指纹）', () => {
  it('章内完全重复段：保首次删后续（行级删除 + 计数）', () => {
    const result = replayTemplatingOnMarkdown(PARAGRAPH_MD);
    expect(result.paragraphRemoved).toBe(1);
    expect(result.prefixRemoved).toBe(0);
    expect(result.markdown).toBe(
      ['## 第二章 安全保证措施', '', PARAGRAPH, '', '其他内容段。', ''].join('\n'),
    );
  });

  it('跨章复用段不删：章内作用域（seen 随章调用新建）——合理跨章重申保留', () => {
    const result = replayTemplatingOnMarkdown(CROSS_CHAPTER_MD);
    expect(result.paragraphRemoved).toBe(0);
    expect(result.prefixRemoved).toBe(0);
    expect(result.markdown).toBe(CROSS_CHAPTER_MD);
  });
});

describe('replayTemplatingOnMarkdown · 头区与防误伤', () => {
  it('头区不参与：首个「## 」前内容含前缀句形态亦零处理', () => {
    const markdown = [
      '封面说明文字。本节将进行总体概述。',
      '',
      '## 第五章 施工部署',
      '',
      '场地平整与测量放线按交桩点位组织实施。',
    ].join('\n');
    const result = replayTemplatingOnMarkdown(markdown);
    expect(result.prefixRemoved).toBe(0);
    expect(result.targetCount).toBe(0);
    expect(result.markdown).toBe(markdown);
  });

  it('无章界文档：整函数早退零变更（含前缀句形态亦不处理）', () => {
    const markdown = '本节将从总体部署、资源配置、进度安排等方面进行说明。\n\n正文段落无章界结构。';
    expect(replayTemplatingOnMarkdown(markdown)).toEqual({
      markdown,
      prefixRemoved: 0,
      prefixSentences: [],
      paragraphRemoved: 0,
      targetCount: 0,
    });
  });

  it('H3 前缀形态标题行与列表行不入句池：零删除且原样返回', () => {
    const markdown = [
      '## 第六章 保障措施',
      '',
      '### 本节将说明质量目标',
      '',
      '- 本章将围绕安全生产展开说明。',
      '',
      '正常正文内容行。',
    ].join('\n');
    const result = replayTemplatingOnMarkdown(markdown);
    expect(result.prefixRemoved).toBe(0);
    expect(result.paragraphRemoved).toBe(0);
    expect(result.markdown).toBe(markdown);
  });
});

describe('replayTemplatingOnMarkdown · 组合与幂等', () => {
  it('双通道同轮落地：前缀句删除 + 章内重复段去重拼接为同一成稿', () => {
    const result = replayTemplatingOnMarkdown(COMBINED_MD);
    expect(result.prefixRemoved).toBe(1);
    expect(result.paragraphRemoved).toBe(1);
    expect(result.prefixSentences).toEqual([PREFIX_CLEAN_RAW]);
    expect(result.markdown).toBe(COMBINED_EXPECTED);
  });

  it('幂等：对收口后成稿重放零变更（拒删锚点保留、无重复段残留）', () => {
    const first = replayTemplatingOnMarkdown(COMBINED_MD);
    const second = replayTemplatingOnMarkdown(first.markdown);
    expect(second.prefixRemoved).toBe(0);
    expect(second.paragraphRemoved).toBe(0);
    expect(second.markdown).toBe(first.markdown);
  });
});

describe('stageTemplatingTailReplay · 接线（写回/复算/进度）', () => {
  it('有落地：finalMarkdown 写回收口稿 + recompute 复算 + message 构成计数 + details 明细', async () => {
    const session = makeSession(COMBINED_MD);
    await stageTemplatingTailReplay(session);
    expect(session.finalMarkdown).toBe(COMBINED_EXPECTED);
    expect(session.recomputeFinalValidationBundle).toHaveBeenCalledTimes(1);
    const stage = stageOf(session.progressStages, 'templating-tail-replay');
    expect(stage?.status).toBe('success');
    expect(stage?.message).toBe('模板化链尾重放（markdown）：零信息前缀句删除 1 处、重复段落去重 1 处');
    expect(stage?.details).toEqual([`前缀句删除：「${PREFIX_CLEAN_RAW}」`]);
    expect(stageOf(session.finalGateRepairStages, 'templating-tail-replay')).toBeDefined();
    expect(session.emitProgress).toHaveBeenCalledTimes(1);
  });

  it('零变更：通过 message（不写回、不复算、无 details）', async () => {
    const session = makeSession(CROSS_CHAPTER_MD);
    await stageTemplatingTailReplay(session);
    expect(session.finalMarkdown).toBe(CROSS_CHAPTER_MD);
    expect(session.recomputeFinalValidationBundle).not.toHaveBeenCalled();
    const stage = stageOf(session.progressStages, 'templating-tail-replay');
    expect(stage?.message).toBe('模板化链尾重放核对通过：无零信息前缀句与重复段落残留');
    expect(stage?.details).toBeUndefined();
    expect(stageOf(session.finalGateRepairStages, 'templating-tail-replay')).toBeDefined();
    expect(session.emitProgress).toHaveBeenCalledTimes(1);
  });
});
