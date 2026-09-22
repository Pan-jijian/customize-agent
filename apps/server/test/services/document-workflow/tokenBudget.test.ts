/**
 * tokenBudget 单测：token 预算估算/段落与句子边界截断。
 */
import { describe, expect, it } from 'vitest';
import { estimateTokens, truncateToTokenBudget } from '@/services/document-workflow/tokenBudget';

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
