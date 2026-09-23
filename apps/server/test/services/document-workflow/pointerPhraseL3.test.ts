/**
 * 图集/图纸指向短语清洗器（`stripDrawingPointerPhrases`）的 §L3-8/§L3-9/§L3-10 规则单测。
 *
 * 该清洗器同时是 §L3-11 接线检测器 `atlas-reference-phrase` 的判据单源（检测定位=修复定位），
 * 故两侧一起被本文件钉住：改了清洗器就同时改了检测判据，反之亦然。
 *
 * 三类规则的正/负例：
 *  - §L3-8  ASCII 尖括号 `<…>` 与书名号《…》等价（实测漏网：真文档用的是 `<混凝土排水管道基础及接口>23S5166/21页`）；
 *  - §L3-9  逗号容忍（`做法，详见《…》` 这类插入逗号的话术不得漏网）——但逗号必须分隔两个指向动词，
 *           否则「按建设单位要求，采用《…》20S515/29 的做法」这类正常句会被吞掉正文（内容损失红线）；
 *  - §L3-10 规范/法规引用负向保护（书名号内是规范名，或标题后紧跟 GB/JGJ/CJJ 代号 → 不删）——
 *           历史事故：`按《绿色建筑评价标准》（GB/T 50378-2019）执行` 整句被删，正文数据丢失。
 *
 * 不变式：删除只作用于指向小句（原文其余信息零丢失）、幂等（二次清洗 removed=0）。
 */
import { describe, expect, it } from 'vitest';
import { atlasPointerPhraseHits, drawingPointerPhraseHits, stripDrawingPointerPhrases } from '@/services/document-workflow/materialResidue';

describe('§L3-8 ASCII 尖括号等价书名号', () => {
  const text = '排水管道雨、污水管及雨水口连接管道基础为180°中粗砂基础。具体详见<混凝土排水管道基础及接口>23S5166/21页。';

  it('ASCII 尖括号形态被检出（atlas 族）', () => {
    const hits = drawingPointerPhraseHits(text);
    expect(hits.some(hit => hit.family === 'atlas' && hit.sample.includes('23S5166'))).toBe(true);
    expect(atlasPointerPhraseHits(text).length).toBeGreaterThan(0);
  });

  it('指向小句被删除，基础构造做法原样保留', () => {
    const out = stripDrawingPointerPhrases(text);
    expect(out.removed).toBeGreaterThan(0);
    expect(out.text).toContain('180°中粗砂基础');
    expect(out.text).not.toContain('23S5166');
  });
});

describe('§L3-9 逗号容忍与反例（内容不可吞）', () => {
  it('「做法，详见《…》20S515/29」形态被收敛', () => {
    const out = stripDrawingPointerPhrases('管道基础做法，详见《钢筋混凝土及砖砌排水检查井》20S515/29。');
    expect(out.removed).toBeGreaterThan(0);
    expect(out.text).not.toContain('20S515');
  });

  it('逗号分隔的不是指向动词时（正常句）不判指向', () => {
    const text = '本工程按建设单位要求，采用《钢筋混凝土及砖砌排水检查井》20S515/29 的做法组织施工。';
    const out = stripDrawingPointerPhrases(text);
    expect(out.removed).toBe(0);
    expect(out.text).toBe(text);
  });
});

describe('§L3-10 规范/法规引用负向保护（历史事故形态）', () => {
  const protectedCases: readonly string[] = [
    '按《绿色建筑评价标准》（GB/T 50378-2019）执行。',
    '本工程按《建设工程安全生产管理条例》及有关规定的配备专职安全生产管理人员。',
    '按《危险性较大的分部分项工程安全管理规定》住建部令第37号执行。',
    '本工程执行《混凝土结构工程施工质量验收规范》的相关规定。',
    '基础下做100厚碎石垫层，100厚C15混凝土垫层；执行《混凝土结构工程施工质量验收规范》GB50204-2015。',
  ];

  for (const text of protectedCases) {
    it(`不删：${text.slice(0, 22)}…`, () => {
      const out = stripDrawingPointerPhrases(text);
      expect(out.removed).toBe(0);
      expect(out.text).toBe(text);
      expect(atlasPointerPhraseHits(text)).toEqual([]);
    });
  }
});

describe('不变式：删除只作用于指向小句（原文信息零丢失）+ 幂等', () => {
  it('同句中的数据主句保留，只损失指向话术', () => {
    const text = '管道基础采用C20混凝土浇筑，具体做法参见《钢筋混凝土及砖砌排水检查井》20S515/29，管座与管基同步施工。';
    const out = stripDrawingPointerPhrases(text);
    expect(out.removed).toBeGreaterThan(0);
    expect(out.text).toContain('管道基础采用C20混凝土浇筑');
    expect(out.text).toContain('管座与管基同步施工');
    expect(out.text).not.toContain('20S515');
  });

  it('幂等：二次清洗 removed=0 且文本不再变化', () => {
    const text = '雨水口按皖2015S209/93~94页设置加固。具体详见<混凝土排水管道基础及接口>23S5166/21页。垫层厚度150mm。';
    const first = stripDrawingPointerPhrases(text);
    const second = stripDrawingPointerPhrases(first.text);
    expect(second.removed).toBe(0);
    expect(second.text).toBe(first.text);
    expect(first.text).toContain('垫层厚度150mm');
  });

  it('图纸指向族归既有 drawing-pointer-phrase 检测器（atlas 检测器不重复报出）', () => {
    const text = '管道位置按设计图纸要求控制，标高以图纸为准。';
    expect(atlasPointerPhraseHits(text)).toEqual([]);
    expect(drawingPointerPhraseHits(text).length).toBeGreaterThan(0);
  });
});
