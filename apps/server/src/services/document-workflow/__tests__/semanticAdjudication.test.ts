/**
 * S5 语义判定层单测：三态裁决 / 批次分割 / 缓存命中 / 失败显式化（不兜底为 consistent）。
 * 全部经 invokeJson 注入锁定（无网络依赖），缓存经 resetCitationAdjudicationCache 跨用例隔离。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  adjudicateCitationCandidates,
  buildCitationSentenceContext,
  CITATION_ADJUDICATION_BATCH_SIZE,
  rationaleNegatesConflict,
  resetCitationAdjudicationCache,
} from '../semanticAdjudication';
import type { CitationAdjudicationCandidate } from '../semanticAdjudication';

function candidate(id: string, overrides: Partial<CitationAdjudicationCandidate> = {}): CitationAdjudicationCandidate {
  return {
    id,
    kind: 'quantity',
    subject: '级配碎石',
    value: 18949.52,
    unit: 'm²',
    authority: 20931.02,
    sentence: '道路工程主要工程量包括级配碎石18949.52m²。',
    ...overrides,
  };
}

/** 从判定 prompt 提取候选 id（模型输出按输入候选对齐） */
function idsFromPrompt(prompt: string): string[] {
  return [...prompt.matchAll(/"id":"([^"]+)"/gu)].map(match => match[1]!);
}

function judgeAll(conclusion: 'consistent' | 'conflict' | 'uncertain', rationale = '测试依据') {
  return vi.fn(async (_system: string, prompt: string) => ({
    judgments: idsFromPrompt(prompt).map(id => ({ id, conclusion, rationale })),
  }));
}

beforeEach(() => resetCitationAdjudicationCache());

describe('adjudicateCitationCandidates：三态裁决与记录', () => {
  it('空候选 → 空 records 且零调用', async () => {
    const invokeJson = vi.fn();
    const outcome = await adjudicateCitationCandidates([], { invokeJson });
    expect(outcome.records.size).toBe(0);
    expect(outcome.unavailable).toBeUndefined();
    expect(invokeJson).not.toHaveBeenCalled();
  });

  it('三态逐条落记录（rationale 保留模型输出）', async () => {
    const conclusions = ['consistent', 'conflict', 'uncertain'] as const;
    const invokeJson = vi.fn(async (_system: string, prompt: string) => ({
      judgments: idsFromPrompt(prompt).map((id, index) => ({ id, conclusion: conclusions[index % 3], rationale: `依据-${id}` })),
    }));
    const outcome = await adjudicateCitationCandidates([candidate('a'), candidate('b'), candidate('c')], { invokeJson });
    expect(outcome.unavailable).toBeUndefined();
    expect(outcome.records.get('a')).toMatchObject({ id: 'a', conclusion: 'consistent', rationale: '依据-a' });
    expect(outcome.records.get('b')).toMatchObject({ id: 'b', conclusion: 'conflict', rationale: '依据-b' });
    expect(outcome.records.get('c')).toMatchObject({ id: 'c', conclusion: 'uncertain', rationale: '依据-c' });
  });

  it('缓存命中：同内容候选（仅 id 不同）二次调用零 invoke，id 重映射为新候选', async () => {
    const invokeJson = judgeAll('conflict', '以项目级口径陈述且与权威不一致');
    const first = await adjudicateCitationCandidates([candidate('a')], { invokeJson });
    const second = await adjudicateCitationCandidates([candidate('b')], { invokeJson });
    expect(invokeJson).toHaveBeenCalledTimes(1);
    expect(first.records.get('a')).toMatchObject({ conclusion: 'conflict' });
    expect(second.records.get('b')).toMatchObject({ id: 'b', conclusion: 'conflict', rationale: '以项目级口径陈述且与权威不一致' });
  });

  it('缓存键含上下文：句不同 → 不命中 → 二次调用', async () => {
    const invokeJson = judgeAll('consistent');
    await adjudicateCitationCandidates([candidate('a')], { invokeJson });
    await adjudicateCitationCandidates([candidate('b', { sentence: '另一句上下文。' })], { invokeJson });
    expect(invokeJson).toHaveBeenCalledTimes(2);
  });
});

describe('adjudicateCitationCandidates：失败显式化（不兜底）', () => {
  it('调用异常 → 整批 uncertain 且 unavailable 携带原因', async () => {
    const invokeJson = vi.fn(async () => {
      throw new Error('模型未配置');
    });
    const outcome = await adjudicateCitationCandidates([candidate('a'), candidate('b', { value: 100 })], { invokeJson });
    expect(outcome.unavailable).toContain('模型未配置');
    expect(outcome.records.get('a')).toMatchObject({ conclusion: 'uncertain' });
    expect(outcome.records.get('b')).toMatchObject({ conclusion: 'uncertain' });
  });

  it('输出无 judgments → 整批 uncertain + 「未返回有效 JSON」', async () => {
    const outcome = await adjudicateCitationCandidates([candidate('a')], { invokeJson: async () => ({ raw: 'text' }) });
    expect(outcome.unavailable).toContain('未返回有效 JSON');
    expect(outcome.records.get('a')?.conclusion).toBe('uncertain');
  });

  it('非法 conclusion 值 → uncertain（rationale 保留模型输出）', async () => {
    const invokeJson = vi.fn(async (_system: string, prompt: string) => ({
      judgments: idsFromPrompt(prompt).map(id => ({ id, conclusion: 'maybe', rationale: '模棱两可' })),
    }));
    const outcome = await adjudicateCitationCandidates([candidate('a')], { invokeJson });
    expect(outcome.records.get('a')).toMatchObject({ conclusion: 'uncertain', rationale: '模棱两可' });
  });

  it('模型漏掉候选 → uncertain + 缺记录依据', async () => {
    const invokeJson = vi.fn(async (_system: string, prompt: string) => ({
      judgments: idsFromPrompt(prompt)
        .filter(id => id !== 'b')
        .map(id => ({ id, conclusion: 'consistent', rationale: '非项目级口径' })),
    }));
    const outcome = await adjudicateCitationCandidates([candidate('a'), candidate('b', { value: 100 })], { invokeJson });
    expect(outcome.records.get('a')?.conclusion).toBe('consistent');
    expect(outcome.records.get('b')?.conclusion).toBe('uncertain');
    expect(outcome.records.get('b')?.rationale).toContain('缺少');
  });

  it('失败批次不缓存：二轮重试再次调用（失败记录不污染缓存）', async () => {
    const invokeJson = vi.fn(async () => {
      throw new Error('临时故障');
    });
    await adjudicateCitationCandidates([candidate('a')], { invokeJson });
    await adjudicateCitationCandidates([candidate('b')], { invokeJson });
    expect(invokeJson).toHaveBeenCalledTimes(2);
  });
});

describe('adjudicateCitationCandidates：批次分割', () => {
  it(`超批次上限：${'41'} 候选 → 2 次调用（${40}+1），全记录`, async () => {
    const invokeJson = judgeAll('conflict');
    const candidates = Array.from({ length: CITATION_ADJUDICATION_BATCH_SIZE + 1 }, (_, index) => candidate(`c${index}`, {
      value: 100 + index,
      sentence: `第 ${index} 条：级配碎石${100 + index}m²。`,
    }));
    const outcome = await adjudicateCitationCandidates(candidates, { invokeJson });
    expect(invokeJson).toHaveBeenCalledTimes(2);
    expect(outcome.records.size).toBe(CITATION_ADJUDICATION_BATCH_SIZE + 1);
    expect(outcome.records.get('c40')?.conclusion).toBe('conflict');
    expect(outcome.records.get(`c${CITATION_ADJUDICATION_BATCH_SIZE}`)?.conclusion).toBe('conflict');
  });
});

describe('buildCitationSentenceContext：判定上下文切片', () => {
  it('含数值所在句，不跨下一段', () => {
    const markdown = '第一句。作业对象为单座公厕，主要工程量为级配碎石18949.52m²。\n\n下一段文字。';
    const at = markdown.indexOf('18949.52');
    const context = buildCitationSentenceContext(markdown, at, '18949.52'.length);
    expect(context).toContain('作业对象为单座公厕');
    expect(context).toContain('18949.52m²');
    expect(context).not.toContain('下一段文字');
  });

  it('段首边界：不回溯前一段（paraFrom 截断）', () => {
    const markdown = '前段文字。\n\n主要工程量为级配碎石18949.52m²。';
    const at = markdown.indexOf('18949.52');
    const context = buildCitationSentenceContext(markdown, at, '18949.52'.length);
    expect(context).toContain('主要工程量为级配碎石18949.52m²');
    expect(context).not.toContain('前段文字');
  });
});

describe('rationaleNegatesConflict：结论-依据自否校正（r22 实测归因）', () => {
  it('依据明确否定冲突（机动工期实况复刻）→ conflict 降级 consistent', async () => {
    const invokeJson = vi.fn(async (_system: string, prompt: string) => ({
      judgments: idsFromPrompt(prompt).map(id => ({
        id,
        conclusion: 'conflict',
        rationale: '该句以项目总工期口径陈述90日历天，与权威值一致，但机动工期1天为工期管理阈值，非总工期数值，故不冲突。',
      })),
    }));
    const outcome = await adjudicateCitationCandidates([candidate('a')], { invokeJson });
    expect(outcome.records.get('a')?.conclusion).toBe('consistent');
    expect(outcome.records.get('a')?.rationale).toContain('不冲突');
  });

  it('真冲突依据（含肯定不一致表述）不降级', async () => {
    const invokeJson = judgeAll('conflict', '以项目级口径陈述且与权威不一致');
    const outcome = await adjudicateCitationCandidates([candidate('a')], { invokeJson });
    expect(outcome.records.get('a')?.conclusion).toBe('conflict');
  });

  it('否定与肯定并存的自相矛盾依据 → 保守不降级', async () => {
    const invokeJson = judgeAll('conflict', '非项目级口径陈述，但与权威值不一致');
    const outcome = await adjudicateCitationCandidates([candidate('a')], { invokeJson });
    expect(outcome.records.get('a')?.conclusion).toBe('conflict');
  });

  it('函数边界：无否定短语不降级，纯自否短语降级', () => {
    expect(rationaleNegatesConflict('以项目级口径陈述且与权威不一致')).toBe(false);
    expect(rationaleNegatesConflict('机动工期为管理阈值，故不冲突')).toBe(true);
    expect(rationaleNegatesConflict('非项目级数值，不予冲突表述')).toBe(true);
  });

  it('r24 B6 动宾否定族：「未构成…冲突」实测复刻 → conflict 降级 consistent', async () => {
    const invokeJson = judgeAll('conflict', '句中明确以项目级口径陈述20个自然村，与权威值一致；但2个自然村与20个自然村两套口径的表述未构成对权威值的冲突。');
    const outcome = await adjudicateCitationCandidates([candidate('a')], { invokeJson });
    expect(outcome.records.get('a')?.conclusion).toBe('consistent');
  });

  it('r24 B6 函数边界：动宾否定族降级，真冲突/并存/非判定动词保守不降级', () => {
    expect(rationaleNegatesConflict('两套口径的表述未构成对权威值的冲突')).toBe(true);
    expect(rationaleNegatesConflict('未发现与权威值不一致的表述')).toBe(true);
    expect(rationaleNegatesConflict('未识别到冲突')).toBe(true);
    expect(rationaleNegatesConflict('以项目级口径陈述且与权威不一致')).toBe(false);
    expect(rationaleNegatesConflict('未构成冲突，但两处数值不一致')).toBe(false);
    expect(rationaleNegatesConflict('未达到冲突判定阈值')).toBe(false);
  });
});
