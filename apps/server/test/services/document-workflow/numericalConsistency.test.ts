import { describe, expect, it } from 'vitest';
import { extractNumericTokens, reconcileContentNumbers, renderNumericFeedback } from '@/services/document-workflow/numericalConsistency';

describe('numericalConsistency 数值一致性核验公共模块', () => {
  describe('extractNumericTokens', () => {
    it('提取数值+单位、规范编号、中文单位 token', () => {
      const tokens = extractNumericTokens('本工程计划工期 540日历天，C30 混凝土 20mm 厚，按 GB 50204-2015 验收，配置 3台 挖掘机');
      expect(tokens).toContain('540日历天');
      expect(tokens).toContain('C30');
      expect(tokens).toContain('20mm');
      expect(tokens).toContain('GB 50204-2015');
      expect(tokens).toContain('3台');
    });

    it('无数值文本返回空数组', () => {
      expect(extractNumericTokens('施工现场应加强安全管理，落实各项防护措施')).toEqual([]);
    });
  });

  describe('reconcileContentNumbers', () => {
    it('正文数值在证据中命中 → confirmed', () => {
      const content = '本工程计划工期 540日历天，主体结构采用 C30 混凝土。';
      const evidence = '计划工期 540日历天；主体结构 C30 混凝土。';
      const result = reconcileContentNumbers(content, evidence);
      expect(result.confirmed).toContain('540日历天');
      expect(result.confirmed).toContain('C30');
      expect(result.mismatched).toEqual([]);
      expect(result.unsourced).toEqual([]);
    });

    it('同位置不同值（上下文命中但数值不符）→ mismatched', () => {
      const content = '本工程垫层采用 C25 混凝土，主体采用 C35。';
      const evidence = '本工程垫层采用 C15 混凝土，主体采用 C35 混凝土。';
      const result = reconcileContentNumbers(content, evidence);
      expect(result.mismatched.length).toBeGreaterThan(0);
      expect(result.mismatched[0].found).toBe('C25');
      expect(result.mismatched[0].expected).toBe('C15');
      // C35 命中证据应为 confirmed
      expect(result.confirmed).toContain('C35');
    });

    it('完全无源数值 → unsourced（不阻断只标记）', () => {
      const content = '本工程采用 C60 超高强混凝土。';
      const evidence = '本工程主体采用 C35 混凝土。';
      const result = reconcileContentNumbers(content, evidence);
      // C60 数值核心 60 不在证据中；与 C35 同签名但上下文仅重合"采用"2 字（<3 连续汉字阈值）→ unsourced
      expect(result.unsourced).toContain('C60');
      expect(result.mismatched).toEqual([]);
    });

    it('完整证据池兜底：注入证据缺失但证据池命中 → confirmed', () => {
      const content = '基坑底标高 15.65m。';
      const injected = '本工程基坑开挖深度 4.5m。';
      const pool = '基坑底标高 15.65m，开挖深度 4.5m。';
      const result = reconcileContentNumbers(content, injected, pool);
      expect(result.confirmed).toContain('15.65m');
    });

    it('同一签名不同上下文 → 不误判 mismatched（保守口径）', () => {
      const content = '混凝土养护 28 天，模板拆除 14 天。';
      const evidence = '混凝土养护 28 天，砌体养护 7 天。';
      const result = reconcileContentNumbers(content, evidence);
      // "14 天" 与证据 "7 天" 同签名（#天），但上下文（模板拆除 vs 砌体养护）无共同汉字 → 不得判 mismatched
      expect(result.mismatched).toEqual([]);
      expect(result.unsourced).toContain('14 天');
    });
  });

  describe('renderNumericFeedback', () => {
    it('错误数值 → 修正指令；正确数值 → 保留清单', () => {
      const feedback = renderNumericFeedback({ confirmed: ['C30', '20mm'], mismatched: [{ found: 'C25', expected: 'C15' }], unsourced: [] });
      expect(feedback).toContain('C25→C15');
      expect(feedback).toContain('C30');
      expect(feedback).toContain('原样保留');
    });

    it('无错误时返回空串', () => {
      expect(renderNumericFeedback({ confirmed: [], mismatched: [], unsourced: [] })).toBe('');
    });
  });
});
