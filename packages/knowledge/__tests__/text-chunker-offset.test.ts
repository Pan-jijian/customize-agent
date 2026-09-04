import { describe, expect, it } from 'vitest';
import { TextChunker } from '../src/chunking/text-chunker.js';
import type { ClassifiedFile } from '../src/types.js';

/**
 * start_char 顺序锚定回归测试：
 * CAD 图纸/清单类文本存在大量重复标注行（如 "Φ10@200"、"C30" 反复出现），
 * 旧实现从头 indexOf(part 前缀) 会命中首次出现的相同文本，导致 start_char
 * 大幅跳变/回退、相邻块出现虚假间隙（曾出现在真实 DWG 索引：间隙 9725 字符）。
 * 修复后相邻块偏移应单调递增且间隙 ≤ 分隔符长度（无虚假跳变）。
 */
describe('TextChunker 重复文本顺序锚定', () => {
  const chunker = new TextChunker();

  function cadFile(): ClassifiedFile {
    return {
      relativePath: '图纸/test.dwg',
      category: 'cad',
      format: 'dwg',
      mimeType: 'application/acad',
      size: 0,
      extension: 'dwg',
    } as unknown as ClassifiedFile;
  }

  it('重复标注行场景：start_char 单调递增、无大幅跳变', () => {
    // 模拟 DWG 提取文本：多个布局重复出现相同的标注文本块（重复 12 次超过 maxChunkSize 触发多块）
    const layout = [
      '布局 T9-10',
      'Φ10@200 双层双向',
      'C30 混凝土强度等级',
      '钢筋 HPB300 HRB400',
      '标高 ±0.000',
    ].join('\n');
    const text = Array.from({ length: 12 }, () => layout).join('\n\n');
    const chunks = chunker.chunk(text, cadFile());
    expect(chunks.length).toBeGreaterThan(1);
    let prevEnd = 0;
    for (const chunk of chunks) {
      // 每块 startChar 不得回退到已消费区域（不允许 0 重复出现后突然跳变）
      expect(chunk.startChar).toBeGreaterThanOrEqual(prevEnd);
      expect(chunk.endChar).toBe(chunk.startChar + chunk.text.length);
      // 块间隙只允许分隔符级别（重复文本场景不允许出现 1000+ 字符跳变）
      if (prevEnd > 0) {
        expect(chunk.startChar - prevEnd).toBeLessThanOrEqual(64);
      }
      prevEnd = chunk.endChar;
    }
    // 总覆盖：最后一块必须覆盖到文本尾部附近（无遗漏无虚增）
    expect(prevEnd).toBeLessThanOrEqual(text.length);
    expect(prevEnd).toBeGreaterThan(text.length * 0.9);
  });

  it('段落重复正文（≥3 次）：偏移定位不受重复文本干扰', () => {
    const para = '本章验收标准：混凝土强度达到设计值的 100%，钢筋保护层厚度偏差不大于 5mm。';
    const text = Array.from({ length: 6 }, () => para).join('\n\n');
    const chunks = chunker.chunk(text, cadFile());
    let prevEnd = 0;
    for (const chunk of chunks) {
      expect(chunk.startChar).toBeGreaterThanOrEqual(prevEnd);
      prevEnd = chunk.endChar;
    }
    expect(prevEnd).toBeGreaterThanOrEqual(text.length - 2);
  });

  it('重叠切片窗口：start_char 连续不回退（overlap 场景）', () => {
    // 长行文本触发窗口拆分 + overlap；行内空格会触发词级切分（chunk 文本与原文不一致），
    // 此时偏移按“紧跟上一块”单调推进兑底，核心断言是：不允许大幅回退（旧实现曾回退 1455 字符）
    const line = '区域照明配电箱 AL-1 回路编号 WL1-WL8 导线规格 ZR-YJV-4x25+1x16 敷设方式 CT/SCE 详见系统图';
    const text = Array.from({ length: 200 }, (_, i) => `${line} 编号${i + 1}`).join('\n');
    const chunks = chunker.chunk(text, cadFile());
    expect(chunks.length).toBeGreaterThan(5);
    let prevEnd = -1;
    for (const chunk of chunks) {
      if (prevEnd >= 0) {
        // overlap 窗口允许 startChar 略回退（重叠长度上限 400 字符 + 定位余量），但不得大幅回退
        expect(prevEnd - chunk.startChar).toBeLessThanOrEqual(420);
      }
      prevEnd = chunk.endChar;
    }
  });
});
