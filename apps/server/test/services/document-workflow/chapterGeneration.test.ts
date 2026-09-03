import { describe, expect, it } from 'vitest';
import { capFactCoverageContext } from '@/services/document-workflow/chapterGeneration';

describe('capFactCoverageContext', () => {
  it('短文本不截断，原样返回', () => {
    const text = '【本章事实覆盖与参数落位要求】\n- 事实 A\n- 事实 B';
    expect(capFactCoverageContext(text)).toBe(text);
  });

  it('超长文本按行完整截断到默认预算（26000 字符），并附加截断提示', () => {
    const line = `- 事实条目：${'内容'.repeat(100)}`;
    const lines = Array.from({ length: 1000 }, (_, index) => `${line}${index}`).join('\n');
    expect(lines.length).toBeGreaterThan(26000);
    const capped = capFactCoverageContext(lines);
    expect(capped.length).toBeLessThanOrEqual(26100);
    // 按行完整截断：保留行均为完整行，且行号连续
    const kept = capped.split('\n').filter(item => item.startsWith('- 事实条目'));
    expect(kept.length).toBeGreaterThan(0);
    expect(kept[0]?.endsWith('0')).toBe(true);
    const lastKept = kept[kept.length - 1];
    const lastIndex = Number(lastKept?.match(/(\d+)$/u)?.[1]);
    const firstDropped = kept.length;
    expect(lastIndex).toBe(firstDropped - 1);
    // 截断提示存在（尾部一行，非事实行）
    expect(capped).toContain('本章事实索引过长已截断');
  });

  it('空输入与空字符串原样返回', () => {
    expect(capFactCoverageContext('')).toBe('');
  });

  it('DOCUMENT_FACT_COVERAGE_CAP 自定义预算生效', () => {
    process.env.DOCUMENT_FACT_COVERAGE_CAP = '500';
    try {
      const lines = Array.from({ length: 50 }, (_, index) => `- 条目 ${index}：${'长内容'.repeat(50)}`).join('\n');
      const capped = capFactCoverageContext(lines);
      expect(capped.length).toBeLessThanOrEqual(600);
      expect(capped).toContain('本章事实索引过长已截断');
    } finally {
      delete process.env.DOCUMENT_FACT_COVERAGE_CAP;
    }
  });

  it('DOCUMENT_FACT_COVERAGE_CAP=0 关闭封顶，原样返回', () => {
    process.env.DOCUMENT_FACT_COVERAGE_CAP = '0';
    try {
      const lines = Array.from({ length: 1000 }, (_, index) => `- 条目 ${index}：${'长内容'.repeat(100)}`).join('\n');
      expect(lines.length).toBeGreaterThan(26000);
      expect(capFactCoverageContext(lines)).toBe(lines);
    } finally {
      delete process.env.DOCUMENT_FACT_COVERAGE_CAP;
    }
  });
});
