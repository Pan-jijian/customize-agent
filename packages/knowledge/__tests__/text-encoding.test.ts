import { describe, expect, it } from 'vitest';
import { decodeTextBuffer, normalizeSymbolicPua } from '../src/extraction/text-encoding.js';

describe('decodeTextBuffer', () => {
  it('UTF-8 中文文本按 UTF-8 解码', () => {
    const buffer = Buffer.from('施工组织设计说明', 'utf8');
    expect(decodeTextBuffer(buffer)).toEqual({ text: '施工组织设计说明', encoding: 'utf-8' });
  });

  it('纯 ASCII 文本按 UTF-8 解码', () => {
    const buffer = Buffer.from('plain ascii content', 'utf8');
    expect(decodeTextBuffer(buffer)).toEqual({ text: 'plain ascii content', encoding: 'utf-8' });
  });

  it('GBK 编码中文文本自动识别为 GBK（UTF-8 读会产生大量替换符）', () => {
    // "格原校审" 的 GBK 字节序列：格=B8F1 原=D4AD 校=D0A3 审=C9F3
    const buffer = Buffer.from([0xB8, 0xF1, 0xD4, 0xAD, 0xD0, 0xA3, 0xC9, 0xF3]);
    const result = decodeTextBuffer(buffer);
    expect(result.encoding).toBe('gbk');
    expect(result.text).toBe('格原校审');
  });

  it('UTF-8 中文含少量非法字节时仍按 UTF-8 解码（不误转 GBK）', () => {
    const valid = Buffer.from('正文内容正常', 'utf8');
    const buffer = Buffer.concat([valid, Buffer.from([0xC0, 0xAF])]); // 尾部两个非法 UTF-8 字节
    const result = decodeTextBuffer(buffer);
    expect(result.encoding).toBe('utf-8');
    expect(result.text).toContain('正文内容正常');
  });

  it('带 BOM 的 UTF-16LE 文本正确解码', () => {
    const body = Buffer.from('中文内容', 'utf16le');
    const buffer = Buffer.concat([Buffer.from([0xFF, 0xFE]), body]);
    const result = decodeTextBuffer(buffer);
    expect(result.encoding).toBe('utf-16le');
    expect(result.text).toBe('中文内容');
  });
});

describe('normalizeSymbolicPua', () => {
  it('CAD SHX 直径符号私用区码位映射为 Φ', () => {
    expect(normalizeSymbolicPua('箍筋\ue00214@100')).toBe('箍筋Φ14@100');
    expect(normalizeSymbolicPua('\ue00020不锈钢板钢筋')).toBe('Φ20不锈钢板钢筋');
  });

  it('Wingdings 2 选项框/星级符号映射为 ● 和 □', () => {
    expect(normalizeSymbolicPua('\uf052不接受')).toBe('●不接受');
    expect(normalizeSymbolicPua('\uf0a3接受')).toBe('□接受');
  });

  it('无私用区字符的文本原样返回', () => {
    const text = '普通文本 φ δ Φ ● □ 123';
    expect(normalizeSymbolicPua(text)).toBe(text);
  });
});
