import fs from 'fs';
import path from 'path';
import os from 'os';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { __documentExportTest__ } from '../src/pages/api/documents/export';

describe('document docx export', () => {
  it('builds semantic Word parts for headings, toc, numbering and tables', async () => {
    const buffer = await __documentExportTest__.buildDocx('测试文档', [
      '## 目录',
      '',
      '第一章 文档概览',
      '',
      '  1.1 内容说明',
      '',
      '<div class="page-break"></div>',
      '',
      '## 第一章 文档概览',
      '',
      '### 1.1 内容说明',
      '正文内容完整。',
      '1. 有序事项',
      '',
      '| 名称 | 内容 |',
      '| --- | --- |',
      '| 条目 | 说明 |',
    ].join('\n'));
    const zip = await JSZip.loadAsync(buffer);
    const documentXml = await zip.file('word/document.xml')?.async('string');
    const stylesXml = await zip.file('word/styles.xml')?.async('string');
    const contentTypes = await zip.file('[Content_Types].xml')?.async('string');

    expect(zip.file('word/numbering.xml')).toBeTruthy();
    expect(zip.file('word/settings.xml')).toBeTruthy();
    expect(zip.file('word/fontTable.xml')).toBeTruthy();
    expect(zip.file('docProps/core.xml')).toBeTruthy();
    expect(zip.file('docProps/app.xml')).toBeTruthy();
    expect(documentXml).toContain('<w:pStyle w:val="Heading1"/>');
    expect(documentXml).toContain('<w:pStyle w:val="Heading2"/>');
    expect(documentXml).toContain('TOC \\o');
    expect(documentXml).toContain('<w:numPr>');
    expect(documentXml).toContain('<w:tblGrid>');
    expect(stylesXml).toContain('w:styleId="Heading3"');
    expect(contentTypes).toContain('/word/numbering.xml');
  });

  it('embeds local markdown images into docx media parts', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-export-'));
    const assetDir = path.join(projectRoot, 'knowledgeBase');
    fs.mkdirSync(assetDir, { recursive: true });
    fs.writeFileSync(path.join(assetDir, 'image.png'), Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100', 'hex'));

    const buffer = await __documentExportTest__.buildDocx('图片文档', ['## 第一章 图像内容', '![图像说明](image.png)'].join('\n'), undefined, undefined, projectRoot);
    const zip = await JSZip.loadAsync(buffer);
    const documentXml = await zip.file('word/document.xml')?.async('string');
    const relsXml = await zip.file('word/_rels/document.xml.rels')?.async('string');
    const contentTypes = await zip.file('[Content_Types].xml')?.async('string');

    expect(zip.file('word/media/image1.png')).toBeTruthy();
    expect(documentXml).toContain('<w:drawing>');
    expect(relsXml).toContain('Target="media/image1.png"');
    expect(contentTypes).toContain('Extension="png"');
  });

  it('preserves table cells when markdown tables have loose spacing and uneven columns', async () => {
    const { markdown } = __documentExportTest__.prepareExportMarkdown([
      '## 第一章 表格测试',
      '',
      '| 项目 | 内容 |',
      '',
      '| --- | --- |',
      '| 工程名称 | 智慧园区建设 | 额外说明 |',
      '| 管线内容 | 给水\\|排水系统 |',
      '',
      '裸表格：',
      '名称 | 数量',
      '钢筋 | 100t',
    ].join('\n'));

    expect(markdown).toContain('智慧园区建设');
    expect(markdown).toContain('给水\\|排水系统');
    expect(markdown).toContain('| 钢筋 | 100t |');

    const buffer = await __documentExportTest__.buildDocx('表格测试', markdown);
    const zip = await JSZip.loadAsync(buffer);
    const documentXml = await zip.file('word/document.xml')?.async('string');

    expect(documentXml).toContain('智慧园区建设');
    expect(documentXml).toContain('额外说明');
    expect(documentXml).toContain('给水|排水系统');
    expect(documentXml).toContain('钢筋');
    expect(documentXml).toContain('100t');
  });

  it('reports export preflight table risks without blocking build', () => {
    const issues = __documentExportTest__.validateExportMarkdown([
      '## 第一章 表格预检',
      '',
      '| 项 | 值 |',
      '| --- | --- |',
      '',
      '名称 | 数量',
      '钢筋 | 100t',
      '',
      '```',
      '未闭合代码块',
    ].join('\n'));

    expect(issues.some(issue => issue.includes('只有表头'))).toBe(true);
    expect(issues.some(issue => issue.includes('疑似裸表格'))).toBe(true);
    expect(issues.some(issue => issue.includes('未闭合代码块'))).toBe(true);
  });

  it('reports obvious export content issues without blocking build', () => {
    const issues = __documentExportTest__.validateExportMarkdown([
      '## 第一章 文档概览',
      '',
      '### 1.1 内容说明',
      '在',
      '本段内容包括',
      '',
      '### 1.2 内容说明',
    ].join('\n'));

    expect(issues.some(issue => issue.includes('孤立字'))).toBe(true);
    expect(issues.some(issue => issue.includes('疑似截断句'))).toBe(true);
    expect(issues.some(issue => issue.includes('重复标题'))).toBe(true);
  });
});
