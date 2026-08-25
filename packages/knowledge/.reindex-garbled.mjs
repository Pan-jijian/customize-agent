/**
 * 一次性脚本：重新索引知识库中的 CAD 与表格文件，验证乱码修复效果。
 * 用法：node .reindex-garbled.mjs
 */
import { KnowledgeBaseManager } from './dist/index.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

const manager = new KnowledgeBaseManager({
  scope: 'project',
  projectRoot: '/Users/pan/Desktop/codeing/customize-agent',
  projectId: '3c3f04667c69',
  kbPath: '/Users/pan/.customize-agent/projects/3c3f04667c69/kb',
  storageRoot: '/Users/pan/.customize-agent',
});

const SOURCE_ROOT = '/Users/pan/Desktop/新建文件夹 (5)';
const KB_ROOT = '/Users/pan/.customize-agent/projects/3c3f04667c69/kb';

const GARBLED_RE = /[罍眄簃锟鈉絙铖鋿]/gu;

manager.initialize();
const records = manager.store.listRecords();
const targets = records.filter(r => ['cad', 'spreadsheet'].includes(r.category));
console.log(`共 ${records.length} 条记录，待重索引 ${targets.length} 个（CAD + 表格）`);

const stats = { ok: 0, failed: 0, garbledFiles: 0, totalGarbled: 0 };
for (const record of targets) {
  try {
    // 1. 磁盘上的 kb 副本已丢失（kb 目录被清理过），先从源目录恢复文件
    const sourcePath = path.join(SOURCE_ROOT, record.relativePath);
    if (!fs.existsSync(sourcePath)) {
      console.error(`[SKIP] ${record.relativePath} | 源文件不存在: ${sourcePath}`);
      continue;
    }
    const kbFilePath = path.join(KB_ROOT, record.relativePath);
    fs.mkdirSync(path.dirname(kbFilePath), { recursive: true });
    fs.copyFileSync(sourcePath, kbFilePath);
    // 2. 重新索引（先删旧记录再重建 chunk）
    await manager.reindexFile(record.relativePath, { vectorMode: 'defer' });
    const detail = manager.getFileDetail(record.relativePath);
    const text = (detail.chunks ?? []).map(chunk => chunk.content).join('\n');
    const garbledCount = (text.match(GARBLED_RE) ?? []).length;
    const mode = (detail.chunks ?? []).map(chunk => {
      try { return JSON.parse(chunk.metadataJson ?? '{}').extractionMode; } catch { return ''; }
    }).filter(Boolean)[0] ?? '';
    if (garbledCount > 0) stats.garbledFiles++;
    stats.totalGarbled += garbledCount;
    stats.ok++;
    console.log(`[OK] ${record.relativePath} | mode=${mode} | chunks=${detail.chunks.length} | garbled=${garbledCount}`);
  } catch (error) {
    stats.failed++;
    console.error(`[FAIL] ${record.relativePath} | ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log('\n=== 重索引完成 ===');
console.log(`成功: ${stats.ok} | 失败: ${stats.failed} | 含乱码文件数: ${stats.garbledFiles} | 乱码字符串总数: ${stats.totalGarbled}`);
