/**
 * 4.55.24：图纸文字层「相邻重复标注」折叠。
 *
 * 实测依据（巢湖 KB 8,395 块，其中 dwg/dxf 1,169 块；抽样 400 块）：
 * 重复行占比 ≥50% 的 96 块、20~50% 的 49 块（约 36%）。DXF 中同一标注存在两条实体
 * （TEXT/MTEXT/ATTRIB 叠放，DWG→DXF 转换产物），坐标重建后整行双写。
 *
 * 本文件锁定折叠行为，并明确**不做删除式治理**：折叠后信息仍出现一次；
 * 判据收窄到「相邻 + 完全同文本 + 长度 ≥2」，合法的重复标注与单字符重建不受影响。
 */
import { describe, it, expect } from 'vitest';
import { layoutCadAnnotations, collapseAdjacentRepeatedLines } from '../src/extraction/content-extractor.js';

describe('4.55.24 CAD 相邻重复标注折叠', () => {
  it('行内相邻同文本折叠（实测形态 JL2JL2）', () => {
    const text = layoutCadAnnotations([
      { text: 'JL2', x: 0, y: 100 },
      { text: 'JL2', x: 2, y: 100 },
    ]).join('\n');
    expect(text).toBe('JL2');
    expect(text).not.toContain('JL2JL2');
  });

  it('比例尺双写归一（1:1001:100 → 1:100，该库 14 块命中）', () => {
    const text = layoutCadAnnotations([
      { text: '1:100', x: 0, y: 100 },
      { text: '1:100', x: 1, y: 100 },
    ]).join('\n');
    expect(text).toBe('1:100');
    expect(text).not.toContain('1:1001:100');
  });

  it('整行双写折叠（实测样本：换填地基承载力条文）', () => {
    const phrase = 'e.换填地基承载力特征值不小于65KPa。';
    const text = layoutCadAnnotations([
      { text: phrase, x: 0, y: 100 },
      { text: phrase, x: 1, y: 100 },
      { text: '5：本工程基础下做100厚碎石垫层，100厚C15混凝土垫层。', x: 0, y: 90 },
      { text: '5：本工程基础下做100厚碎石垫层，100厚C15混凝土垫层。', x: 1, y: 90 },
    ]).join('\n');
    expect(text.split(phrase).length - 1).toBe(1);
    expect(text.split('100厚碎石垫层').length - 1).toBe(1);
  });

  it('相邻重复行折叠但非相邻重复保留（不误伤图纸合法重复标注）', () => {
    const lines = collapseAdjacentRepeatedLines(['KZ1', 'KZ1', 'KL2', 'KZ1']);
    expect(lines).toEqual(['KZ1', 'KL2', 'KZ1']);
  });

  it('单字符不入判据（保护逐字符重建）', () => {
    const lines = collapseAdjacentRepeatedLines(['N', 'N', 'G']);
    expect(lines).toEqual(['N', 'N', 'G']);
  });

  it('空行视作分隔：被空行隔开的同文本行保留（保守不误删）', () => {
    const lines = collapseAdjacentRepeatedLines(['部位：D4', '  ', '部位：D4']);
    expect(lines.filter(line => line.trim()).length).toBe(2);
  });
});
