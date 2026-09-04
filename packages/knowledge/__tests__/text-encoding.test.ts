import { describe, expect, it } from 'vitest';
import { decodeTextBuffer, filterOcrGraphicNoiseLines, hasForeignScriptGarbledText, normalizeSymbolicPua } from '../src/extraction/text-encoding.js';

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

  it('Wingdings 菱形项目符号映射为 ◆，空白字形剔除', () => {
    expect(normalizeSymbolicPua('\uf0d8外观：每套信号灯由红、黄、绿三个几何位置分立单元组成')).toBe('◆外观：每套信号灯由红、黄、绿三个几何位置分立单元组成');
    expect(normalizeSymbolicPua('参保险种□养老保险□医疗保险\uf020')).toBe('参保险种□养老保险□医疗保险');
  });

  it('未收录的私用区字符直接剔除，不保留乱码', () => {
    expect(normalizeSymbolicPua('信号灯\uf123工作电压：AC220V')).toBe('信号灯工作电压：AC220V');
    expect(normalizeSymbolicPua('\ue100\ue101')).toBe('');
  });

  it('无私用区字符的文本原样返回', () => {
    const text = '普通文本 φ δ Φ ● □ 123';
    expect(normalizeSymbolicPua(text)).toBe(text);
  });
});

describe('hasForeignScriptGarbledText', () => {
  it('CID 字体缺 ToUnicode 的封面标题乱码（泰文/南亚/西里尔混排）判定为乱码', () => {
    // 真实提取产物：梅河东路交通信控工程 PDF 第 1 页标题
    expect(hasForeignScriptGarbledText('㡈ค৵ค䭽ࣕ㜳⍱࣑૷䍞ᨆॽжᵕ亯ⴤऎሕ䇴䇗ᙱᢵऻ')).toBe(true);
  });

  it('CID 字体缺 ToUnicode 的图签标题乱码判定为乱码', () => {
    // 真实提取产物：同一 PDF 第 78 页图签
    expect(hasForeignScriptGarbledText('Ӛ䙐ᢁӋ\nᔰ䇴ঋփ\n㚊㌱⭫䈓')).toBe(true);
  });

  it('正常中文工程页不误判', () => {
    const text = '梅河东路与龙津大道信号灯工程设计总说明\n本次交通工程设计主要包括梅河东路（龙眠路-城东路）12 个交叉口的交通信号控制系统设计。';
    expect(hasForeignScriptGarbledText(text)).toBe(false);
  });

  it('含希腊字母/工程符号的合法文本不误判', () => {
    expect(hasForeignScriptGarbledText('钢筋直径Φ=12mm，±0.5%误差，截面面积 3.14㎡')).toBe(false);
  });

  it('外来字母低于 3 个或占比极低时不判定为乱码', () => {
    expect(hasForeignScriptGarbledText('本工程采用Φ钢管,详见详图')).toBe(false);
  });
});

describe('filterOcrGraphicNoiseLines', () => {
  it('LOGO 图形误识别行（符号混排）被剔除', () => {
    const text = '< ] 人人 AL 已忌 | | 三 | ra | \\ 几 L AN';
    expect(filterOcrGraphicNoiseLines(text)).toBe('');
  });

  it('LOGO 下划线/星号误识别行被剔除', () => {
    const text = ['了上线和 已器 折了 L_ mL、', 'YE *', '机乌 CR 乌要 骂短 坚 "9 15 15 13'].join('\n');
    expect(filterOcrGraphicNoiseLines(text)).toBe('');
  });

  it('图框线误识别行被剔除', () => {
    const text = ['物幅 | 。 一 | 4', '[CT 0 0', '司 |', '| 川放 | 让国 1 交 ) 用手 7'].join('\n');
    expect(filterOcrGraphicNoiseLines(text)).toBe('');
  });

  it('正常工程标注行不受影响', () => {
    const text = ['(1) 系统组成', 'φ25 钢筋 @200', '梅河东路与龙津大道信号灯工程', '(1)~(5) 号机柜', 'N1 箱变 基础'].join('\n');
    expect(filterOcrGraphicNoiseLines(text)).toBe(text);
  });

  it('含中文句读或领域信号的行即使有符号也保留', () => {
    const text = '详见附表(三)：| 工程量清单 |';
    expect(filterOcrGraphicNoiseLines(text)).toBe(text);
  });

  it('空行保留', () => {
    expect(filterOcrGraphicNoiseLines('第一行\n\n第二行')).toBe('第一行\n\n第二行');
  });
});
