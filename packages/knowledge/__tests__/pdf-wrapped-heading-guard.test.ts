/**
 * PDF 行级 markdown 化护栏（isPdfWrappedClauseLike）测试：折行半句不标题化——
 * 字号/首行/长度兜底标题化规则只对结构标题生效。丰乐镇门禁链根因
 * （折行半句被标 ### → 下游切分器假标题吞字 + 裸续行成孤立碎片）的第一道防线。
 */
import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ContentExtractor, isPdfWrappedClauseLike } from '../src/extraction/content-extractor.js';
import { FileClassifier } from '../src/classification/classifier.js';

describe('isPdfWrappedClauseLike 折行半句判定', () => {
  it('整句收尾与中段句末标点：正文句不是标题', () => {
    expect(isPdfWrappedClauseLike('认使用时限。')).toBe(true);
    expect(isPdfWrappedClauseLike('城乡建设局）规定执行。中标后承包人按上述文件规定办')).toBe(true);
  });

  it('行尾句内标点（句子被折行裁断）：逗号/顿号/冒号结尾', () => {
    expect(isPdfWrappedClauseLike('使用时限的电子证书无效，需重新下载电子证书并再次确')).toBe(true);
    expect(isPdfWrappedClauseLike('投标人应按招标文件规定的格式填写并提交以下资料：')).toBe(true);
    expect(isPdfWrappedClauseLike('中标人须在合同签订后十日内提交履约担保、')).toBe(true);
  });

  it('长行特征：长逗号句/长括注行/长名值行/超长行不是标题', () => {
    expect(isPdfWrappedClauseLike('2.6 建设规模：本项目总建筑面积约5000平方米，包含配套基础')).toBe(true);
    expect(isPdfWrappedClauseLike('开标时间及地点：2026年9月1日肥西县公共资源交易中心')).toBe(true);
    expect(isPdfWrappedClauseLike('投标文件格式中的“招标项目名称”请填写“2026年度丰乐')).toBe(true);
  });

  it('结构标题与目录/附录/附件题保持标题化（豁免折行判定）', () => {
    expect(isPdfWrappedClauseLike('第一章 招标公告')).toBe(false);
    expect(isPdfWrappedClauseLike('1.5合同文件的优先顺序')).toBe(false);
    expect(isPdfWrappedClauseLike('目录')).toBe(false);
    expect(isPdfWrappedClauseLike('附录2资格审查条件（财务最低要求）')).toBe(false);
    expect(isPdfWrappedClauseLike('附件2工程量清单和最高投标限价（招标控制价）编制费收费标准')).toBe(false);
    expect(isPdfWrappedClauseLike('PDF 第 12 页')).toBe(false);
  });
});

describe('PDF 提取护栏（折行半句不标题化，全链生效）', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-pdf-guard-'));

  afterAll(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 清理 */ }
  });

  /** 与 upload-pipeline 测试一致风格的最小单页 PDF：Helvetica 字号 24（=标题字号），多行文本流。
   *  行宽需 ≤ 页面可用宽度（24pt 下约 54 字符），超出会被 pdfjs 按页框裁剪。 */
  function createMinimalPdf(lines: string[]): Buffer {
    const ops = lines.map((line, index) => `${index === 0 ? '72 720 Td' : '0 -30 Td'} (${line}) Tj`).join(' ');
    const content = `BT /F1 24 Tf ${ops} ET`;
    return Buffer.from(`%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length ${content.length}>>stream
${content}
endstream
endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
xref
0 6
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000241 00000 n 
0000000348 00000 n 
trailer<</Size 6/Root 1 0 R>>
startxref
425
%%EOF
`);
  }

  it('单页折行半句（大字号 + 无句末标点/整句收尾）：输出保留正文行且不误标 # 标题', async () => {
    const relPath = '文档资料/wrapped-guard.pdf';
    const abs = path.join(tmpDir, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const line1 = 'The certificate becomes invalid after usage time, th';
    const line2 = 'erefore download the electronic version again.';
    const line3 = 'Bidders shall keep the downloaded cert valid.';
    fs.writeFileSync(abs, createMinimalPdf([line1, line2, line3]));
    const file = new FileClassifier().classify(abs, relPath, fs.statSync(abs));
    const result = await new ContentExtractor().extract(file);
    expect(String(result.metadata.extractionMode)).toContain('pdf_text');
    expect(result.text).toContain('## PDF 第 1 页');
    expect(result.text).toContain(line1);
    expect(result.text).toContain(line2);
    expect(result.text).toContain(line3);
    expect(result.text).not.toContain('# The certificate');
    expect(result.text).not.toContain('# erefore');
    expect(result.text).not.toContain('# Bidders');
  });
});
