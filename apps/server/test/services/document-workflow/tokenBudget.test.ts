/**
 * tokenBudget 单测：token 预算估算/段落与句子边界截断/评分选择包装。
 */
import { describe, expect, it } from 'vitest';
import { estimateTokens, selectForTokenBudget, truncateToTokenBudget } from '@/services/document-workflow/tokenBudget';

describe('estimateTokens', () => {
  it('中文按 1.5 字符/token 估算', () => {
    expect(estimateTokens('施工组织设计')).toBe(4);
    expect(estimateTokens('')).toBe(0);
  });

  it('英文按 4 字符/token 估算', () => {
    expect(estimateTokens('abcdefgh')).toBe(2);
  });

  it('中英混合分别估算', () => {
    // 2 中文 /1.5 + 2 英文 /4 = 1.333 + 0.5 → ceil 2
    expect(estimateTokens('你好ab')).toBe(2);
  });
});

describe('truncateToTokenBudget', () => {
  it('预算内原样返回且无丢弃日志', () => {
    const result = truncateToTokenBudget('你好世界', 10);
    expect(result.truncated).toBe('你好世界');
    expect(result.droppedChars).toBe(0);
    expect(result.droppedLog).toBe('');
  });

  it('优先段落边界截断', () => {
    // '第一段内容。' 7 中文字 → 5 tokens；两段共 10 tokens，预算 5 → 第二段整段丢弃
    const text = '第一段内容。\n\n第二段内容。';
    const result = truncateToTokenBudget(text, 5);
    expect(result.truncated).toBe('第一段内容。');
    expect(result.droppedChars).toBe(text.length - result.truncated.length);
    expect(result.droppedLog).toContain('[token-budget]');
  });

  it('段落内句子边界截断', () => {
    // 段1 '第一段内容。' → 5 tokens；段2 '这是第二段。超出部分。' 11 字 → 8 tokens
    // 预算 10：段2 整段超支（5+8>10）→ 句子级：'这是第二段。' 4 tokens 命中（5+4=9），'超出部分。' 5 字丢弃
    const text = '第一段内容。\n\n这是第二段。超出部分。';
    const result = truncateToTokenBudget(text, 10);
    expect(result.truncated).toBe('第一段内容。\n\n这是第二段。');
    expect(result.droppedChars).toBe(5);
  });
});

describe('selectForTokenBudget', () => {
  it('预算充足全选并汇总 token', () => {
    const result = selectForTokenBudget(['aaa', 'bbbbbb'], () => 1, 100);
    expect(result.selected).toEqual(['aaa', 'bbbbbb']);
    expect(result.dropped).toHaveLength(0);
    expect(result.totalTokens).toBe(estimateTokens('aaa') + estimateTokens('bbbbbb'));
  });

  it('预算不足时丢弃低分项', () => {
    // maxChars = maxTokens*2 = 2；每项 2 tokens → 只选 1 项
    const result = selectForTokenBudget(['一二三', '四五六'], () => 1, 1);
    expect(result.selected).toEqual(['一二三']);
    expect(result.dropped).toEqual(['四五六']);
    expect(result.totalTokens).toBe(2);
  });

  it('按分数降序优先保留高分项', () => {
    const items = [{ t: '短', score: 1 }, { t: '长内容', score: 10 }];
    const result = selectForTokenBudget(items, item => item.score, 1, item => item.t);
    // maxChars = 2；'长内容' 3 字 → 2 tokens 选中，'短' 1 token 但预算已满 → 丢弃
    expect(result.selected).toEqual([{ t: '长内容', score: 10 }]);
    expect(result.dropped).toEqual([{ t: '短', score: 1 }]);
  });
});
