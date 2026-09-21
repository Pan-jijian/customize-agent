/**
 * DOCX 段内文本框不得吞掉该段后半正文。
 *
 * 缺陷背景：段落提取用非贪婪正则 `<(w:p|w:tbl)[\s>][\s\S]*?<\/\1>`。段落内嵌文本框时
 * （`w:txbxContent` 里是完整的内层 `w:p`），匹配在**内层** `</w:p>` 处收尾 —— 外层段落被
 * 截断，`matchAll` 扫描指针跳过其后半段，**该段后半正文永久丢失**，且无任何告警。
 * 实测形态：`<w:p>前文甲…<w:txbxContent><w:p>框内乙</w:p></w:txbxContent>…后文丙</w:p>`
 * 旧实现只得到「前文甲框内乙」，「后文丙」消失。
 *
 * 修复：`extractTopLevelOoxmlElements` 按标签深度配平取完整外层元素。
 */
import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ContentExtractor, extractTopLevelOoxmlElements } from '../src/extraction/content-extractor.js';
import { FileClassifier } from '../src/classification/classifier.js';
import type { ClassifiedFile } from '../src/types.js';

const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

/** 段内文本框：外层段落 = 前文甲 … 文本框（框内乙）… 后文丙 */
const DOC_XML = `<?xml version="1.0" encoding="UTF-8"?>
<w:document ${W_NS}><w:body>
<w:p><w:r><w:t>前文甲</w:t></w:r><w:r><w:txbxContent><w:p><w:r><w:t>框内乙</w:t></w:r></w:p></w:txbxContent></w:r><w:r><w:t>后文丙</w:t></w:r></w:p>
<w:p><w:r><w:t>独立段落丁</w:t></w:r></w:p>
</w:body></w:document>`;

describe('extractTopLevelOoxmlElements', () => {
  it('段内嵌套 w:p（文本框）时取到完整外层段落，不提前收尾', () => {
    const elements = extractTopLevelOoxmlElements(DOC_XML);
    expect(elements).toHaveLength(2);
    // 外层段落必须包含「后文丙」——非贪婪正则会在此处截断
    const first = elements[0]!.xml;
    expect(first).toContain('前文甲');
    expect(first).toContain('框内乙');
    expect(first).toContain('后文丙');
    expect(first.trimEnd().endsWith('</w:p>')).toBe(true);
    expect(elements[1]!.xml).toContain('独立段落丁');
  });

  it('自闭合的 <w:p/> 视为完整元素，不吞掉后续内容', () => {
    const xml = '<w:body><w:p/><w:p><w:r><w:t>之后</w:t></w:r></w:p></w:body>';
    const elements = extractTopLevelOoxmlElements(xml);
    expect(elements).toHaveLength(2);
    expect(elements[1]!.xml).toContain('之后');
  });

  it('w:tbl 同样按深度配平（表格内嵌套 w:p 是常态）', () => {
    const xml = '<w:body><w:tbl><w:tr><w:tc><w:p><w:r><w:t>甲</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:t>尾</w:t></w:r></w:p></w:body>';
    const elements = extractTopLevelOoxmlElements(xml);
    expect(elements.map(e => e.tag)).toEqual(['w:tbl', 'w:p']);
    expect(elements[1]!.xml).toContain('尾');
  });
});

describe('DOCX 端到端（含文本框的真实文件结构）', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-docx-txbx-'));
  const extractor = new ContentExtractor();
  afterAll(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  async function makeDocx(name: string): Promise<ClassifiedFile | undefined> {
    let JSZip: { new (): { file: (p: string, d: string) => void; generateAsync: (o: { type: string }) => Promise<Buffer> } };
    try {
      const mod = await import('jszip') as unknown as { default?: unknown } & Record<string, unknown>;
      JSZip = (mod.default ?? mod) as typeof JSZip;
    } catch {
      return undefined;
    }
    const zip = new JSZip();
    zip.file('[Content_Types].xml',
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
    zip.file('word/document.xml', DOC_XML);
    const abs = path.join(tmpDir, name);
    fs.writeFileSync(abs, await zip.generateAsync({ type: 'nodebuffer' }));
    const stat = fs.statSync(abs);
    return new FileClassifier().classify(abs, name, stat);
  }

  it('文本框所在段落的后半正文进入提取结果', async () => {
    const file = await makeDocx('textbox.docx');
    if (!file) return;
    const result = await extractor.extract(file);
    const text = String(result.text ?? '');

    expect(text).toContain('前文甲');
    expect(text).toContain('框内乙');
    // 修复前「后文丙」被吞掉（段落被截断 + 扫描指针跳过）
    expect(text).toContain('后文丙');
    expect(text).toContain('独立段落丁');
  });
});
