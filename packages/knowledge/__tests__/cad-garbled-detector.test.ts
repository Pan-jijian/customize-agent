/**
 * CAD 乱码判定误杀回归。
 *
 * 缺陷背景：判定规则中曾有一条「汉字 >= 8 且无数字、无句读、不含工程关键词 → 判为二进制误读」。
 * 图纸里这类纯汉字短句极常见（材料名/设备名/设计说明短句），于是大量正常标注被整条丢弃。
 * 巢湖 21 张图纸实测该规则命中 888 处（去重 201 条），逐条核对全部是正常中文、无一条真乱码，
 * 其中 841 处属「只被它拦下」的纯粹误杀。现已移除该规则，本文件锁定这些真实样例不再被误杀。
 */
import { describe, expect, it, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ContentExtractor } from '../src/extraction/content-extractor.js';
import { FileClassifier } from '../src/classification/classifier.js';
import type { ClassifiedFile } from '../src/types.js';

const CRLF = '\r\n';

/** 实测被误杀的正常中文标注（去重后的真实样例，覆盖设备名/材料名/说明短句/公司名/表名） */
const LEGITIMATE_ANNOTATIONS = [
  '本图未盖出图章无效',
  '双门热风循环消毒柜',
  '单门热风循环消毒柜',
  '檐口支撑收边固定用自攻螺钉',
  '防火吊顶耐火极限不小于',
  '巢湖执珩建设投资有限公司',
  '一层防火分区示意图',
  '人员疏散宽度计算表',
  '常闭式乙级防火门',
  '铝合金通风防雨百叶窗',
  // 以下为「汉字自然重复」与「条款编号」两类误杀（第二批复核发现）
  '规定性指标 性能性指标',
  '电动伸缩门或电动移门',
  '一层平面图、屋顶平面图',
  '（地砖踢脚踢脚）',
  '一层照明平面图 一层电力平面图',
  '分层压实，素土回填分层压实。',
  '阀门(带阀门井)',
  '2.3)负荷等级为三级负荷',
  '7.1.5.1：生活给水泵出水管上安装速闭消声止回阀，或有阻尼装置的缓闭止回阀。',
  '12.2.2：金属及复合管给水管道系统在试验压力下观测10min，压力降不应大于0.02MPa，然后降到工作压力进行检查，应不渗不漏。',
  '2.3.3:灭火器应设置在位置明显和便于取用的地点，且不应影响人员安全疏散。',
];

/** 真实图纸数据：循环数字是尺寸/材料标注本身，不是二进制误读（曾与乱码循环一起被误杀） */
const DIMENSION_SPECS = [
  '800*800*800',
  '1000*1000*800/450',
  '700*800*800/450',
  '20*20*0.7',
];

/** 真乱码循环模式：无汉字、且重复片段非纯数字 —— 收窄后必须仍被拦下 */
const CYCLIC_GARBLED = [
  'Ml+Ml+Ml',
  'AM~AM~BM~BM',
  '2dA+2dA+2dA',
  '耀U耀W耀Y耀',
  '摁䭚摁譚摁譚摁',
];

function dxf(...pairs: Array<[string | number, string]>): string {
  return pairs.map(([code, value]) => `${String(code).padStart(3, ' ')}${CRLF}${value}`).join(CRLF) + CRLF;
}

describe('CAD 乱码判定不误杀正常中文标注', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-cad-garbled-'));
  const classifier = new FileClassifier();
  const extractor = new ContentExtractor();

  function makeDxfFile(relPath: string, content: string): ClassifiedFile {
    const abs = path.join(tmpDir, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
    const stat = fs.statSync(abs);
    return classifier.classify(abs, relPath, stat);
  }

  afterAll(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('无数字、无句读、不含工程关键词的整句中文仍进入提取结果', async () => {
    const raw = dxf(...LEGITIMATE_ANNOTATIONS.flatMap<[string | number, string]>(text => [
      [0, 'TEXT'], [8, 'PUB_TEXT'], [10, '100'], [20, '200'], [1, text],
    ]));
    const file = makeDxfFile('drawing/设计说明.dxf', raw);
    const result = await extractor.extract(file);
    const text = String(result.text ?? '');

    for (const annotation of LEGITIMATE_ANNOTATIONS) {
      expect(text, `应保留正常标注「${annotation}」`).toContain(annotation);
    }
    expect(result.metadata?.characterDataCount).toBeGreaterThanOrEqual(32);
  });

  it('真乱码仍被拦下（Latin-1 扩展字符密集行）', async () => {
    // 「VdA«UdA«UdANÒg」型：正常英文标注不用这些扩展字符，属二进制误读
    const garbled = 'VdA«UdA«UdANÒg';
    const raw = dxf(
      ...LEGITIMATE_ANNOTATIONS.flatMap<[string | number, string]>(text => [
        [0, 'TEXT'], [8, 'PUB_TEXT'], [1, text],
      ]),
      [0, 'TEXT'], [8, 'PUB_TEXT'], [1, garbled],
    );
    const file = makeDxfFile('drawing/混合.dxf', raw);
    const result = await extractor.extract(file);
    const text = String(result.text ?? '');

    expect(text).not.toContain(garbled);
    expect(text).toContain('本图未盖出图章无效');
  });

  it('循环数字的尺寸/材料标注是真实数据，不被当乱码丢弃', async () => {
    const raw = dxf(...DIMENSION_SPECS.flatMap<[string | number, string]>(text => [
      [0, 'TEXT'], [8, 'PUB_TEXT'], [10, '100'], [20, '200'], [1, text],
    ]));
    const file = makeDxfFile('drawing/尺寸标注.dxf', raw);
    const result = await extractor.extract(file);
    const text = String(result.text ?? '');

    for (const spec of DIMENSION_SPECS) {
      expect(text, `应保留尺寸标注「${spec}」`).toContain(spec);
    }
  });

  it('真乱码循环模式仍被拦下（无汉字 + 重复片段非纯数字）', async () => {
    const raw = dxf(
      ...LEGITIMATE_ANNOTATIONS.flatMap<[string | number, string]>(text => [
        [0, 'TEXT'], [8, 'PUB_TEXT'], [1, text],
      ]),
      ...CYCLIC_GARBLED.flatMap<[string | number, string]>(text => [
        [0, 'TEXT'], [8, 'PUB_TEXT'], [1, text],
      ]),
    );
    const file = makeDxfFile('drawing/循环乱码.dxf', raw);
    const result = await extractor.extract(file);
    const text = String(result.text ?? '');

    for (const garbled of CYCLIC_GARBLED) {
      expect(text, `应拦下乱码「${garbled}」`).not.toContain(garbled);
    }
    expect(text).toContain('本图未盖出图章无效');
  });
});
