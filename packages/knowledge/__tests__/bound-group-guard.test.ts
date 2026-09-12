import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { KnowledgeBaseManager } from '../src/core/knowledge-base-manager.js';

/**
 * 跨项目资料共库非破坏性回归测试（4.22.3）：
 * 历史 B1 守卫在生成启动时清除知识库中非绑定资料组的全部切片索引，多项目资料共库场景下
 * 其他项目的切片数据被整体清空（丰乐镇实测回归：库内徽光阁/合肥师范学院等资料组切片丢失）；
 * 且 bound_groups 持久化导致重新同步也无法恢复。现改为非破坏性口径隔离（生成链路
 * scopedFilePaths 过滤，不再触碰库内数据），本测试验证：
 * 1. 残留的 bound_groups metadata 在增量同步入口被幂等清除（组外文件不再被扫描过滤）
 * 2. 多项目资料组的磁盘文件全部正常入索引（不被清除）
 */

let tmpDir: string;
let storageRoot: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-bound-group-'));
  storageRoot = path.join(tmpDir, 'storage');
  fs.mkdirSync(storageRoot, { recursive: true });
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
});

const SAMPLE_TEXT = '施工组织设计编制说明。本项目位于安徽省肥西县丰乐镇，主要内容包括道路工程、排水工程、景观工程及公厕工程。'.repeat(4);

describe('跨项目资料共库非破坏性回归', () => {
  it('bound_groups 残留被幂等清除、多项目资料组全部入索引不被过滤', async () => {
    const manager = new KnowledgeBaseManager({ scope: 'global', storageRoot });
    manager.initialize();
    try {
      // 磁盘放两个项目资料组（多项目共库形态）
      fs.mkdirSync(path.join(manager.kbPath, '9.14--2026年度丰乐镇项目'), { recursive: true });
      fs.mkdirSync(path.join(manager.kbPath, '9.4合肥师范学院项目'), { recursive: true });
      fs.writeFileSync(path.join(manager.kbPath, '9.14--2026年度丰乐镇项目', '资料.txt'), SAMPLE_TEXT, 'utf8');
      fs.writeFileSync(path.join(manager.kbPath, '9.4合肥师范学院项目', '资料.txt'), SAMPLE_TEXT, 'utf8');
      // 模拟旧版本生成流程残留的绑定组元数据（会让组外文件永久无法入索引）
      manager.store.setMetadata('bound_groups', JSON.stringify(['9.14--2026年度丰乐镇项目']));
      await manager.incrementalIndex({ vectorMode: 'defer' });
      // 残留元数据被幂等清除
      expect(manager.store.getMetadata('bound_groups') || '').toBe('');
      // 两个资料组的切片均保留入索引（组外文件不再被扫描过滤/清除）
      expect(manager.store.countChunks({ relativePath: '9.14--2026年度丰乐镇项目/资料.txt' })).toBeGreaterThan(0);
      expect(manager.store.countChunks({ relativePath: '9.4合肥师范学院项目/资料.txt' })).toBeGreaterThan(0);
    } finally {
      manager.close();
    }
  });

  it('无残留时同步正常（不报错、不写入 bound_groups）', async () => {
    const manager = new KnowledgeBaseManager({ scope: 'global', storageRoot });
    manager.initialize();
    try {
      fs.mkdirSync(path.join(manager.kbPath, '9.14--2026年度丰乐镇项目'), { recursive: true });
      fs.writeFileSync(path.join(manager.kbPath, '9.14--2026年度丰乐镇项目', '资料.txt'), SAMPLE_TEXT, 'utf8');
      await manager.incrementalIndex({ vectorMode: 'defer' });
      expect(manager.store.getMetadata('bound_groups') || '').toBe('');
      expect(manager.store.countChunks({ relativePath: '9.14--2026年度丰乐镇项目/资料.txt' })).toBeGreaterThan(0);
    } finally {
      manager.close();
    }
  });

  it('损坏的 bound_groups 残留同样被幂等清除（不设限不报错）', async () => {
    const manager = new KnowledgeBaseManager({ scope: 'global', storageRoot });
    manager.initialize();
    try {
      fs.mkdirSync(path.join(manager.kbPath, '9.4合肥师范学院项目'), { recursive: true });
      fs.writeFileSync(path.join(manager.kbPath, '9.4合肥师范学院项目', '资料.txt'), SAMPLE_TEXT, 'utf8');
      manager.store.setMetadata('bound_groups', '{not-json');
      await manager.incrementalIndex({ vectorMode: 'defer' });
      expect(manager.store.getMetadata('bound_groups') || '').toBe('');
      expect(manager.store.countChunks({ relativePath: '9.4合肥师范学院项目/资料.txt' })).toBeGreaterThan(0);
    } finally {
      manager.close();
    }
  });
});
