/**
 * 一次性脚本：单文件重索引（每文件独立进程，避免批量索引时主进程内存压力
 * 导致 dwgdxf WASM 转换失败）。用法：node .reindex-one.mjs <relativePath>
 */
import { KnowledgeBaseManager } from './dist/index.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

const relativePath = process.argv[2];
if (!relativePath) {
  console.error('用法: node .reindex-one.mjs <relativePath>');
  process.exit(2);
}

const SOURCE_ROOT = '/Users/pan/Desktop/新建文件夹 (5)';
const KB_ROOT = '/Users/pan/.customize-agent/projects/3c3f04667c69/kb';
const GARBLED_RE = /[罍眄簃锟鈉絙铖鋿䱠䏳䵳䑿䵀\uFFFD\u0080-\u009F]/gu;
const RARE_CJK_RE = /[\u3400-\u4DBF\u{20000}-\u{2FA1F}]/gu;

const manager = new KnowledgeBaseManager({
  scope: 'project',
  projectRoot: '/Users/pan/Desktop/codeing/customize-agent',
  projectId: '3c3f04667c69',
  kbPath: KB_ROOT,
  storageRoot: '/Users/pan/.customize-agent',
});
manager.initialize();

try {
  const sourcePath = path.join(SOURCE_ROOT, relativePath);
  if (!fs.existsSync(sourcePath)) {
    console.log(`SKIP | ${relativePath} | 源文件不存在`);
    process.exit(0);
  }
  const kbFilePath = path.join(KB_ROOT, relativePath);
  fs.mkdirSync(path.dirname(kbFilePath), { recursive: true });
  fs.copyFileSync(sourcePath, kbFilePath);
  await manager.reindexFile(relativePath, { vectorMode: 'defer' });
  const detail = manager.getFileDetail(relativePath);
  const text = (detail.chunks ?? []).map(chunk => chunk.content).join('\n');
  const garbledCount = (text.match(GARBLED_RE) ?? []).length;
  const rareCjkCount = (text.match(RARE_CJK_RE) ?? []).length;
  // GBK 误读检测：Latin-1 扩展字符（排除合法工程符号 °±×÷·µ²³Ø；¼½¾¹ 属误读产物）
  const gbkMisreadLines = text.split('\n').filter(line => /[\u00C0-\u00FF]/u.test(line.replace(/[°±×÷·µ²³Ø]/g, ''))).length;
  const mode = (detail.chunks ?? []).map(chunk => {
    try { return JSON.parse(chunk.metadataJson ?? '{}').extractionMode; } catch { return ''; }
  }).filter(Boolean)[0] ?? '';
  console.log(`OK | ${relativePath} | mode=${mode} | chunks=${detail.chunks.length} | garbled=${garbledCount} rareCjk=${rareCjkCount} gbkLines=${gbkMisreadLines}`);
} catch (error) {
  console.error(`FAIL | ${relativePath} | ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
