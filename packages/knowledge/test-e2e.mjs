import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const lr = createRequire(import.meta.url);
const { ContentExtractor } = await import('./dist/extraction/content-extractor.js');

const pdfPath = '/Users/pan/Desktop/codeing/customize-agent/包建发〔2025〕12号关于印发《合肥市包河建设发展投资有限公司房建项目工程建设样板引路管理规定》的通知.pdf';
const stat = fs.statSync(pdfPath);

const file = {
  absolutePath: pdfPath, relativePath: 'documents/pdf/包建发〔2025〕12号通知.pdf',
  category: 'document', format: 'pdf', mimeType: 'application/pdf',
  fileSize: stat.size, mtime: stat.mtimeMs,
};

const extractor = new ContentExtractor();
const t0 = Date.now();
const result = await extractor.extract(file);
console.log(`耗时: ${((Date.now()-t0)/1000).toFixed(1)}s | 模式: ${result.metadata.extractionMode} | OCR: ${result.metadata.ocrProvider || 'N/A'}`);
console.log(`文本: ${result.text.length}字符 | 中文: ${(result.text.match(/[\p{Script=Han}]/gu)||[]).length}`);
console.log(`警告: ${result.warnings.join('; ') || '无'}`);
console.log('');
console.log('─── 提取结果 ───');
console.log(result.text);
