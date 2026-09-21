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
});
