/**
 * 一次性诊断：对真实 DWG 文件跑提取，检查乱码漏洞环节
 */
import { ContentExtractor } from './dist/index.js';
import { FileClassifier } from './dist/index.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SOURCE_ROOT = '/Users/pan/Desktop/新建文件夹 (5)';
const targets = [
  '8.4徽光阁项目施工/图纸/审图通过版CAD图汇总/装饰工程/电气/电施_00_封面_A2.dwg',
  '8.4徽光阁项目施工/图纸/审图通过版CAD图汇总/主体工程/2026-0703-徽光阁（智能化平面图+系统图）.dwg',
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
  console.log('文件:', rel);
  console.log('mode:', result.metadata.extractionMode, '| coverage:', result.metadata.contentCoverage);
  console.log('characterDataCount:', result.metadata.characterDataCount);
  console.log('text 总长度:', result.text.length);
  console.log('--- 提取文本行（前 60 行）---');
  const lines = result.text.split('\n');
  lines.slice(0, 60).forEach((line, i) => {
    const len = line.length;
    console.log(`${String(i).padStart(3)} [${len}] ${line.slice(0, 150)}`);
  });
  console.log();
}
