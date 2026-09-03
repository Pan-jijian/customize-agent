/**
 * textMatch 单测：中文 token 匹配（滑动窗口/模糊匹配/安全截断），替代硬编码 slice(0,N)。
 */
import { describe, expect, it } from 'vitest';
import { chineseTokenMatch, chineseTokenMatchScore, chineseTokens, safeTruncate } from '@/services/document-workflow/textMatch';

describe('chineseTokens', () => {
  it('提取整段与 2 字滑动窗口 token', () => {
    const tokens = chineseTokens('混凝土浇筑，钢结构安装');
    expect(tokens).toHaveLength(10);
    expect(tokens).toEqual(expect.arrayContaining(['混凝土浇筑', '钢结构安装']));
    expect(tokens).toEqual(expect.arrayContaining(['浇筑', '安装', '结构']));
  });

  it('中文标点/数字/符号分割', () => {
    const tokens = chineseTokens('质量（合格），强度C30；安全"可控"');
    expect(tokens).toEqual(expect.arrayContaining(['质量', '合格', '强度', '安全', '可控']));
  });

  it('不足 2 字的分段不产生 token', () => {
    expect(chineseTokens('A、B')).toEqual([]);
  });
});

describe('chineseTokenMatchScore', () => {
  it('完全相同文本 → 1', () => {
    expect(chineseTokenMatchScore('混凝土浇筑', '混凝土浇筑')).toBe(1);
  });

  it('子串包含关系 → 模糊 0.5 计分', () => {
    // A 5 token：整段 + 4 个窗口；整段为 B 整段子串 → 0.5，其余 4 个窗口精确命中 → 4.5/5
    expect(chineseTokenMatchScore('混凝土浇筑', '混凝土浇筑施工')).toBe(0.9);
  });

  it('完全无关文本 → 0', () => {
    expect(chineseTokenMatchScore('质量', '安全')).toBe(0);
  });

  it('空文本 → 0', () => {
    expect(chineseTokenMatchScore('', '施工')).toBe(0);
    expect(chineseTokenMatchScore('施工', '')).toBe(0);
  });
});

describe('chineseTokenMatch', () => {
  it('默认阈值 0.3', () => {
    expect(chineseTokenMatch('混凝土浇筑', '混凝土浇筑施工')).toBe(true);
    expect(chineseTokenMatch('质量', '安全')).toBe(false);
  });

  it('自定义阈值', () => {
    expect(chineseTokenMatch('混凝土浇筑', '混凝土浇筑施工', 0.95)).toBe(false);
    expect(chineseTokenMatch('混凝土浇筑', '混凝土浇筑施工', 0.8)).toBe(true);
  });
});

describe('safeTruncate', () => {
  it('不超过上限时原样返回', () => {
    expect(safeTruncate('施工组织设计', 10)).toBe('施工组织设计');
  });

  it('超过上限按字符截断', () => {
    expect(safeTruncate('施工组织设计', 4)).toBe('施工组织');
  });
});
