import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { buildExportZip, mergeChunksToReadableText, trimChunkOverlap, txtEntryNameFor, txtFileNameFor, exportZipFileName } from './kbExportService';

const chunk = (content: string) => ({ content } as never);

describe('mergeChunksToReadableText', () => {
  it('按顺序拼接分块，块间以空行过渡', () => {
    const text = mergeChunksToReadableText([chunk('第一段内容。'), chunk('第二段内容。')]);
    expect(text).toBe('第一段内容。\n\n第二段内容。');
  });

  it('过滤空内容分块', () => {
    const text = mergeChunksToReadableText([chunk('   '), chunk('正文内容。'), chunk('')]);
    expect(text).toBe('正文内容。');
  });

  it('消除相邻分块之间的重叠文本（前块末尾带入后块开头）', () => {
    const overlap = '这是分块之间重复出现的重叠段落，长度足以触发去重。'.repeat(3);
    const prev = `前面的正文。\n${overlap}`;
    const next = `${overlap}\n后面的正文。`;
    const text = mergeChunksToReadableText([chunk(prev), chunk(next)]);
    // 重叠只出现一次，块间以空行过渡
    expect(text).toBe(`前面的正文。\n${overlap}\n\n后面的正文。`);
    expect(text.split(overlap).length - 1).toBe(1);
  });

  it('不误删无重叠的分块', () => {
    const text = mergeChunksToReadableText([chunk('第一节内容。'.repeat(20)), chunk('第二节内容。'.repeat(20))]);
    expect(text).toContain('第一节内容。');
    expect(text).toContain('第二节内容。');
  });

  it('保持分块内部的段落结构', () => {
    const text = mergeChunksToReadableText([chunk('标题\n\n第一段。\n第二段。')]);
    expect(text).toBe('标题\n\n第一段。\n第二段。');
  });
});

describe('trimChunkOverlap', () => {
  it('裁剪后一块开头与前一块结尾完全重复的部分', () => {
    const overlap = '甲乙丙丁戊己庚辛壬癸'.repeat(20); // 200 字符，超过阈值 16
    const prev = `前文。${overlap}`;
    const next = `${overlap}后文。`;
    expect(trimChunkOverlap(prev, next)).toBe('后文。');
  });

  it('裁剪后移除多余的前导换行', () => {
    const overlap = '重叠段落内容'.repeat(10);
    const prev = `前文。\n${overlap}`;
    const next = `${overlap}\n\n后文。`;
    expect(trimChunkOverlap(prev, next)).toBe('后文。');
  });

  it('重叠过短（低于阈值）不裁剪，避免误伤自然重复短句', () => {
    const prev = '前文。好的。';
    const next = '好的。后文。';
    expect(trimChunkOverlap(prev, next)).toBe('好的。后文。');
  });

  it('窗口范围之外的长重复不裁剪（重叠窗口有上限）', () => {
    const overlap = '长重复内容'.repeat(120); // 720 字符，超过 600 窗口
    const prev = `${overlap}前文。`;
    const next = `${overlap}后文。`;
    // prev 末尾 600 字符只是 overlap 的一部分，next 开头是完整 overlap，两者前缀不会完全匹配到尾
    expect(trimChunkOverlap(prev, next)).toBe(next);
  });
});

describe('txtEntryNameFor / txtFileNameFor', () => {
  it('保留目录结构并将扩展名替换为 .txt', () => {
    expect(txtEntryNameFor('文档资料/招标文件.pdf', new Set())).toBe('文档资料/招标文件.txt');
  });

  it('无扩展名文件直接追加 .txt', () => {
    expect(txtEntryNameFor('README', new Set())).toBe('README.txt');
  });

  it('隐藏文件不丢失文件名', () => {
    expect(txtEntryNameFor('.gitignore', new Set())).toBe('.gitignore.txt');
  });

  it('同目录重名时追加序号', () => {
    const used = new Set<string>();
    expect(txtEntryNameFor('资料/说明.pdf', used)).toBe('资料/说明.txt');
    expect(txtEntryNameFor('资料/说明.docx', used)).toBe('资料/说明-2.txt');
  });

  it('不同目录同名不冲突', () => {
    const used = new Set<string>();
    expect(txtEntryNameFor('a/说明.pdf', used)).toBe('a/说明.txt');
    expect(txtEntryNameFor('b/说明.pdf', used)).toBe('b/说明.txt');
  });

  it('单文件下载名不含目录', () => {
    expect(txtFileNameFor('文档资料/招标文件.pdf')).toBe('招标文件.txt');
  });
});

describe('buildExportZip', () => {
  it('将多个文件文本打包为 zip，保留目录结构且内容正确', async () => {
    const buffer = await buildExportZip([
      { relativePath: '文档资料/a.pdf', text: 'A 文件的解析内容' },
      { relativePath: '文档资料/子目录/b.docx', text: 'B 文件的解析内容' },
    ]);
    const zip = await JSZip.loadAsync(buffer);
    const names = Object.keys(zip.files);
    expect(names).toContain('文档资料/a.txt');
    expect(names).toContain('文档资料/子目录/b.txt');
    expect(await zip.file('文档资料/a.txt')!.async('string')).toBe('A 文件的解析内容');
    expect(await zip.file('文档资料/子目录/b.txt')!.async('string')).toBe('B 文件的解析内容');
  });

  it('打包后原始扩展名被替换为 .txt', async () => {
    const buffer = await buildExportZip([{ relativePath: '图纸文件/总平面图.dwg', text: '图纸元数据' }]);
    const zip = await JSZip.loadAsync(buffer);
    expect(Object.keys(zip.files)).toContain('图纸文件/总平面图.txt');
  });
});

describe('exportZipFileName', () => {
  it('生成带时间戳的压缩包文件名', () => {
    expect(exportZipFileName()).toMatch(/^知识库解析内容-\d{8}-\d{6}\.zip$/u);
  });
});
