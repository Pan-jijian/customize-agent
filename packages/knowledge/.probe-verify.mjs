import { ContentExtractor } from './dist/index.js';
import { FileClassifier } from './dist/index.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SOURCE_ROOT = '/Users/pan/Desktop/新建文件夹 (5)';
const targets = [
  '8.4徽光阁项目施工/图纸/审图通过版CAD图汇总/主体工程/2026-0709-徽光阁电气审图修改版_t3_t3.dwg',
  '8.4徽光阁项目施工/图纸/审图通过版CAD图汇总/装饰工程/电气/电施_00_封面_A2.dwg',
  '8.4徽光阁项目施工/图纸/审图通过版CAD图汇总/主体工程/2026-0703-徽光阁（智能化平面图+系统图）.dwg',
  '8.4徽光阁项目施工/图纸/审图通过版CAD图汇总/装饰工程/电气/电施_07_一层照明平面图_A1.dwg',
];

const classifier = new FileClassifier();
const extractor = new ContentExtractor();

for (const rel of targets) {
  const abs = path.join(SOURCE_ROOT, rel);
  if (!fs.existsSync(abs)) { console.log('SKIP 不存在:', rel); continue; }
  const stat = fs.statSync(abs);
  const file = classifier.classify(abs, rel, stat);
  const result = await extractor.extract(file);
  console.log('='.repeat(80));
  console.log('文件:', rel.slice(0, 70));
  console.log('mode:', result.metadata.extractionMode, '| coverage:', result.metadata.contentCoverage);
  console.log('characterDataCount:', result.metadata.characterDataCount, '| text 总长度:', result.text.length);
  // 检查残留乱码
  const badLines = result.text.split('\n').filter(line => {
    const hasBadLatinExt = /[\u00C0-\u00FF]/u.test(line) && /[\u00C0-\u00FF]/u.test(line.replace(/[°±×÷·µ²³¹½¼¾Ø]/g, ''));
    const hasRareCjk = /[\u3400-\u4DBF\u{20000}-\u{2FA1F}]/u.test(line);
    const hasReplacement = /[\uFFFD\u0080-\u009F]/u.test(line);
    return hasBadLatinExt || hasRareCjk || hasReplacement;
  });
  console.log('残留乱码行数:', badLines.length);
  badLines.slice(0, 8).forEach(line => console.log('   BAD:', line.slice(0, 100)));
  console.log();
}
