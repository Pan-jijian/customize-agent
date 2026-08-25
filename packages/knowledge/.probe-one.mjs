import { ContentExtractor } from './dist/index.js';
import { FileClassifier } from './dist/index.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SOURCE_ROOT = '/Users/pan/Desktop/新建文件夹 (5)';
const rel = process.argv[2];
const abs = path.join(SOURCE_ROOT, rel);
const stat = fs.statSync(abs);
const file = new FileClassifier().classify(abs, rel, stat);
const result = await new ContentExtractor().extract(file);
console.log('文件:', rel.slice(0, 70));
console.log('mode:', result.metadata.extractionMode, '| coverage:', result.metadata.contentCoverage);
console.log('characterDataCount:', result.metadata.characterDataCount, '| text 总长度:', result.text.length);
const badLines = result.text.split('\n').filter(line => {
  const hasBadLatinExt = /[\u00C0-\u00FF]/u.test(line) && /[\u00C0-\u00FF]/u.test(line.replace(/[°±×÷·µ²³¹½¼¾Ø]/g, ''));
  const hasRareCjk = /[\u3400-\u4DBF\u{20000}-\u{2FA1F}]/u.test(line);
  const hasReplacement = /[\uFFFD\u0080-\u009F]/u.test(line);
  return hasBadLatinExt || hasRareCjk || hasReplacement;
});
console.log('残留乱码行数:', badLines.length);
badLines.slice(0, 8).forEach(line => console.log('   BAD:', line.slice(0, 100)));
const lines = result.text.split('\n').filter(line => /[\p{Script=Han}]/u.test(line));
lines.slice(0, 6).forEach((line, i) => console.log(`${String(i).padStart(3)}`, line.slice(0, 100)));
