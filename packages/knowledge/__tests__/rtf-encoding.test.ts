/**
 * RTF 中文正文提取回归。
 *
 * 缺陷背景：`extractRtf` 把 `\'hh` 转义**直接替换成空格**。中文 Word/写字板写出的 RTF
 * 以 `\ansicpg936` + `\'hh` 表示全部非 ASCII 字符，于是中文正文 100% 丢失；且提取结果
 * 仍含字体表等 ASCII 内容（实测只剩 `"SimSun;"`），非空 → 连「未提取到正文」的告警都不触发，
 * 整类格式静默失效。
 *
 * 修复：按 `\ansicpg<nnn>` 声明的代码页还原连续 `\'hh` 序列（必须整段还原，逐字节解码会把
 * GBK 双字节字拆成两个替换符），并同口径支持现代 Word 优先写出的 `\uNNNN?` Unicode 转义。
 */
import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ContentExtractor } from '../src/extraction/content-extractor.js';
import { FileClassifier } from '../src/classification/classifier.js';
import type { ClassifiedFile } from '../src/types.js';

/** GBK 字节 → RTF `\'hh` 转义串（python: s.encode('gbk') 后逐字节转义） */
const GBK_ESCAPE = {
  施工组织设计: "\\'ca\\'a9\\'b9\\'a4\\'d7\\'e9\\'d6\\'af\\'c9\\'e8\\'bc\\'c6",
  投标响应句: "\\'cd\\'b6\\'b1\\'ea\\'ce\\'c4\\'bc\\'fe\\'d3\\'a6\\'b5\\'b1\\'b6\\'d4\\'d5\\'d0\\'b1\\'ea\\'ce\\'c4\\'bc\\'fe\\'cc\\'e1\\'b3\\'f6\\'b5\\'c4\\'ca\\'b5\\'d6\\'ca\\'d0\\'d4\\'d2\\'aa\\'c7\\'f3\\'d7\\'f7\\'b3\\'f6\\'cf\\'ec\\'d3\\'a6",
};

describe('RTF 提取（GBK 代码页）', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-rtf-'));
  const extractor = new ContentExtractor();
  afterAll(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  async function extractRtf(body: string): Promise<{ text: string; metadata: Record<string, unknown> }> {
    const abs = path.join(tmpDir, `sample-${Math.random().toString(36).slice(2)}.rtf`);
    fs.writeFileSync(abs, body, 'utf8');
    const stat = fs.statSync(abs);
    const file: ClassifiedFile = new FileClassifier().classify(abs, 'sample.rtf', stat);
    return await extractor.extract(file) as unknown as { text: string; metadata: Record<string, unknown> };
  }

  it('\\ansicpg936 的 \\\'hh 转义还原为中文，不再被替换成空格', async () => {
    const rtf = `{\\rtf1\\ansi\\ansicpg936\\deff0{\\fonttbl{\\f0\\fnil\\fcharset134 SimSun;}}\n`
      + `{\\f0 ${GBK_ESCAPE.施工组织设计}${GBK_ESCAPE.投标响应句}\\par}}`;
    const result = await extractRtf(rtf);
    const text = String(result.text ?? '');

    expect(text).toContain('施工组织设计');
    expect(text).toContain('投标文件应当对招标文件提出的实质性要求作出响应');
    // 修复前这两句全部消失，只剩字体表里的 "SimSun;"
    expect(result.metadata.rtfCodePage).toBe(936);
  });

  it('连续 \\\'hh 整段还原：GBK 双字节字不被拆成两个替换符', async () => {
    const rtf = `{\\rtf1\\ansi\\ansicpg936{\\f0 ${GBK_ESCAPE.施工组织设计}}}`;
    const text = String((await extractRtf(rtf)).text ?? '');
    expect(text).not.toContain('�');
    expect(text).toBe('施工组织设计');
  });

  it('\\uNNNN? Unicode 转义同样还原（现代 Word 优先形态）', async () => {
    const rtf = '{\\rtf1\\ansi\\ansicpg936{\\f0 \\u26045?\\u24037?\\u32452?\\u32455?\\u35774?\\u35745?}}';
    const text = String((await extractRtf(rtf)).text ?? '');
    expect(text).toBe('施工组织设计');
  });

  it('未声明代码页时回落到通用编码探测（UTF-8 → GBK）', async () => {
    const rtf = `{\\rtf1\\ansi{\\f0 ${GBK_ESCAPE.施工组织设计}}}`;
    expect(String((await extractRtf(rtf)).text ?? '')).toContain('施工组织设计');
  });

  it('纯 ASCII 的 RTF 不受影响', async () => {
    const rtf = '{\\rtf1\\ansi\\ansicpg1252{\\f0 Scope of Works\\par}}';
    expect(String((await extractRtf(rtf)).text ?? '')).toContain('Scope of Works');
  });
});
