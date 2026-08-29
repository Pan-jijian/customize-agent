/**
 * dataConsistencyReview（h7 L3.5 数据一致性 LLM 审查层）单测：
 * 数值句提取（L1 确定性结构提取）/ 矛盾转交付阻断 issue / 矛盾数值签名 / LLM 批量审查。
 * LLM 通道全部 mock（避免真实网络调用）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { callDocumentLlmJson } from './llmClient';
import type * as LlmClientModule from './llmClient';
import { conflictNumericKey, dataConsistencyConflictIssue, numericSentencesForReview, reviewDataConsistency, type DataConsistencyConflict } from './dataConsistencyReview';

vi.mock('./llmClient', async () => {
  const actual = await vi.importActual<typeof LlmClientModule>('./llmClient');
  return { ...actual, callDocumentLlmJson: vi.fn() };
});

const llmMock = vi.mocked(callDocumentLlmJson);

function conflict(partial: Partial<DataConsistencyConflict>): DataConsistencyConflict {
  return { kind: 'labor', itemA: '高峰期80人', itemB: '高峰期120人', description: '劳动力峰值两处不一致', confidence: 0.9, ...partial };
}

describe('numericSentencesForReview（L1 数值句提取）', () => {
  it('表格行整行收录、正文含数字句收录、标题行跳过', () => {
    const markdown = [
      '### 劳动力配置',
      '| 阶段 | 人数 |',
      '| --- | --- |',
      '| 基础 | 50人 |',
      '高峰期投入120人组织施工。',
      '本段无任何数字内容。',
    ].join('\n');
    const lines = numericSentencesForReview(markdown);
    expect(lines).toContain('| 基础 | 50人 |');
    expect(lines).toContain('高峰期投入120人组织施工。');
    expect(lines.some(line => line.includes('###'))).toBe(false);
    expect(lines.some(line => line.includes('无任何数字'))).toBe(false);
  });

  it('重复行去重', () => {
    const repeated = Array.from({ length: 30 }, () => '高峰期投入120人。').join('\n');
    expect(numericSentencesForReview(repeated)).toHaveLength(1);
  });
});

describe('conflictNumericKey（矛盾数值签名）', () => {
  it('提取全部数字 token 排序拼接', () => {
    const message = '数据一致性矛盾（labor）：峰值80人与120人不符（原文 A：“高峰期80人” ↔ 原文 B：“高峰期120人”）';
    expect(conflictNumericKey(message)).toBe('80|120');
  });

  it('无数字 token → 空串（去重时跳过）', () => {
    expect(conflictNumericKey('数据一致性矛盾（other）：表述口径不一致。')).toBe('');
  });
});

describe('reviewDataConsistency（LLM 批量审查）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('数值句不足 2 条 → 不调用 LLM', async () => {
    const result = await reviewDataConsistency('本段无任何数字。');
    expect(result).toEqual([]);
    expect(llmMock).not.toHaveBeenCalled();
  });

  it('低置信度与无效条目过滤，只保留确定矛盾', async () => {
    llmMock.mockResolvedValue({
      conflicts: [
        conflict({ kind: 'labor', confidence: 0.9 }),
        conflict({ kind: 'area', itemA: '', confidence: 0.9 }),
        conflict({ kind: 'duration', confidence: 0.4 }),
      ],
    });
    const result = await reviewDataConsistency('高峰期投入80人。\n高峰期投入120人。');
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('labor');
  });

  it('LLM 返回空清单 → 空数组', async () => {
    llmMock.mockResolvedValue({ conflicts: [] });
    const result = await reviewDataConsistency('高峰期投入80人。\n高峰期投入120人。');
    expect(result).toEqual([]);
  });

  it('最多保留 6 条', async () => {
    llmMock.mockResolvedValue({ conflicts: Array.from({ length: 8 }, (_, index) => conflict({ description: `矛盾${index}`, confidence: 0.9 })) });
    const result = await reviewDataConsistency('高峰期投入80人。\n高峰期投入120人。');
    expect(result).toHaveLength(6);
  });
});

describe('dataConsistencyConflictIssue（转交付阻断 issue）', () => {
  it('消息携带矛盾数值对原文供修复指令精确定位', () => {
    const issue = dataConsistencyConflictIssue(conflict({ kind: 'labor', itemA: '高峰期80人', itemB: '高峰期120人', description: '劳动力峰值两处不一致' }));
    expect(issue.level).toBe('error');
    expect(issue.severity).toBe('blocker');
    expect(issue.category).toBe('fact_consistency');
    expect(issue.message).toContain('数据一致性矛盾（labor）');
    expect(issue.message).toContain('“高峰期80人”');
    expect(issue.message).toContain('“高峰期120人”');
    expect(issue.suggestion).toContain('数据口径必须唯一');
  });
});
