/**
 * 一次性诊断：验证正常图纸（有真实标注）不被误杀 + DXF 文本标注正常提取
 */
import { ContentExtractor } from './dist/index.js';
import { FileClassifier } from './dist/index.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SOURCE_ROOT = '/Users/pan/Desktop/新建文件夹 (5)';
const targets = [
  '8.4徽光阁项目施工/图纸/审图通过版CAD图汇总/主体工程/徽光阁项目建施260709（出图打印)改_t3.dwg',
  '8.4徽光阁项目施工/图纸/审图通过版CAD图汇总/主体工程/【结构】城隍庙徽光阁结构加固图0710 - 审图修改版.dwg',
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
  // 抽样展示含中文的文本行
  const lines = result.text.split('\n').filter(line => /[\p{Script=Han}]/u.test(line));
  console.log('--- 中文文本行抽样（前 12 行 + 含 C1 控制字符检查）---');
  lines.slice(0, 12).forEach((line, i) => console.log(`${String(i).padStart(3)} ${line.slice(0, 110)}`));
  const c1 = lines.filter(line => /[\u0080-\u009F\uFFFD]/u.test(line)).length;
  console.log(`含 C1/替换符行数: ${c1} / ${lines.length}`);
  console.log();
}
