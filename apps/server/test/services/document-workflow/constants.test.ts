/**
 * constants 单测：CAD 实体/文件名/中文数字正则口径。
 * 注：FILE_NAME_RE / CAD_ENTITY_TOKEN_RE 带 g 标志，连续 test() 有 lastIndex 残留，统一用 match 判定。
 */
import { describe, expect, it } from 'vitest';
import { CAD_ENTITY_TOKEN_RE, CN_NUMERAL_RE, FILE_NAME_RE } from '@/services/document-workflow/constants';

describe('CAD_ENTITY_TOKEN_RE', () => {
  it('匹配 CAD 实体名', () => {
    expect('包含 TDbPipe 与 BlockReference 实体'.match(CAD_ENTITY_TOKEN_RE)).toEqual(['TDbPipe', 'BlockReference']);
    expect('Polyline、Layer、Hatch'.match(CAD_ENTITY_TOKEN_RE)).toEqual(['Polyline', 'Layer', 'Hatch']);
    expect('普通文本无实体'.match(CAD_ENTITY_TOKEN_RE)).toBeNull();
  });
});

describe('FILE_NAME_RE', () => {
  it('匹配常见图纸/文档文件名', () => {
    expect('图纸：基坑支护设计图.pdf、技术标.docx'.match(FILE_NAME_RE)).toEqual(['基坑支护设计图.pdf', '技术标.docx']);
  });

  it('中文/数字/括号文件名', () => {
    // 真行为（M1 组真实缺陷修复后）：文件名字符类不含全角/半角括号——括号会让图片语法
    // 「![总平面图](p.png)」被吞成畸形串。带括号文件名两种形态：
    // 1) 扩展名前有 '）'（文件名在括号内）→ 无法匹配（null）；
    // 2) 扩展名后接 '）'（扩展名紧跟闭括号，\b 边界成立）→ 从括号内内容开始匹配
    expect('文件（修订版_2）.dwg'.match(FILE_NAME_RE)).toBeNull();
    expect('文件（修订版_2.dwg）'.match(FILE_NAME_RE)?.[0]).toBe('修订版_2.dwg');
    expect('材料清单.xlsx'.match(FILE_NAME_RE)?.[0]).toBe('材料清单.xlsx');
  });

  it('不匹配非文件串', () => {
    expect('普通描述文字'.match(FILE_NAME_RE)).toBeNull();
  });
});

describe('CN_NUMERAL_RE', () => {
  it('中文数字串匹配', () => {
    const re = new RegExp(CN_NUMERAL_RE, 'u');
    expect(re.test('一百二十三')).toBe(true);
    expect(re.test('零〇两万')).toBe(true);
    expect(re.test('abc')).toBe(false);
  });
});
