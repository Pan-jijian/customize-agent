import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Globals = { __kbIndexRecords?: unknown[]; __kbRegistryRows?: unknown[] };

// better-sqlite3：注册表查询从 globalThis 注入行数据；
// knowledge 包：IndexStateStore 从 globalThis 注入索引记录，getProjectKbPath 指向自建临时目录。
vi.mock('better-sqlite3', () => ({
  default: class MockDatabase {
    prepare() {
      return { all: () => (globalThis as Globals).__kbRegistryRows ?? [] };
    }
    close() {}
  },
}));
vi.mock('@customize-agent/knowledge', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { default: Database } = await import('better-sqlite3');
  let kbDataDir = '';
  class FakeIndexStateStore {
    listRecords() { return (globalThis as Globals).__kbIndexRecords ?? []; }
    close() {}
  }
  class FakeMultiProjectManager {
    constructor(_storageRoot: string) {}
    search = vi.fn(async () => ({ results: [] as Array<{ filePath: string; score: number }>, debug: undefined }));
    getProject = vi.fn(async () => ({ listFiles: () => [] as string[], listChunks: () => [] }));
    shutdown = vi.fn(async () => {});
  }
  return {
    computeProjectId: vi.fn((root: string) => `proj-${root.replace(/[^a-zA-Z0-9]/gu, '-')}`),
    getProjectKbPath: vi.fn(() => {
      if (!kbDataDir) kbDataDir = mkdtempSync(join('/tmp', 'ca-kbservice-test-'));
      return kbDataDir;
    }),
    IndexStateStore: FakeIndexStateStore,
    MultiProjectManager: FakeMultiProjectManager,
    loadBetterSqlite3: () => Database,
  };
});
vi.mock('os', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { join } = await import('node:path');
  let fixedDir = '';
  const mockOs = {
    homedir: () => {
      if (!fixedDir) fixedDir = mkdtempSync(join('/tmp', 'ca-kbsvc-home-'));
      return fixedDir;
    },
    tmpdir: () => '/tmp',
  };
  return { ...mockOs, default: mockOs };
});

import { computeProjectId, getProjectKbPath } from '@customize-agent/knowledge';
import {
  discoverKnowledgeFiles,
  getKnownProjectRoots,
  getMultiProjectManager,
  getProjectKbRoot,
  getProjectRoot,
  getStorageRoot,
  listKnowledgeFiles,
  resolveProjectRoot,
  shutdownKbService,
} from '@/services/knowledge/kbService';

/** 在 mock 知识库根目录下搭建标准目录树，返回根路径 */
function seedKbTree(): string {
  const kbRoot = getProjectKbPath('/seed');
  fs.mkdirSync(path.join(kbRoot, '文档资料'), { recursive: true });
  fs.mkdirSync(path.join(kbRoot, '表格数据'), { recursive: true });
  fs.mkdirSync(path.join(kbRoot, '图片素材'), { recursive: true });
  fs.mkdirSync(path.join(kbRoot, '图纸文件'), { recursive: true });
  fs.writeFileSync(path.join(kbRoot, '文档资料', '招标文件.PDF'), 'x');
  fs.writeFileSync(path.join(kbRoot, '表格数据', '清单.xlsx'), 'x');
  fs.writeFileSync(path.join(kbRoot, '图片素材', '平面.png'), 'x');
  fs.writeFileSync(path.join(kbRoot, '图纸文件', '结构.dwg'), 'x');
  fs.writeFileSync(path.join(kbRoot, '杂项.txt'), 'x');
  fs.writeFileSync(path.join(kbRoot, '草稿.source.txt'), 'x');
  return kbRoot;
}

beforeEach(() => {
  fs.rmSync(path.join(os.homedir(), '.customize-agent'), { recursive: true, force: true });
  fs.rmSync(getProjectKbPath('/seed'), { recursive: true, force: true });
  delete (globalThis as Globals).__kbIndexRecords;
  delete (globalThis as Globals).__kbRegistryRows;
  delete process.env.CUSTOMIZE_PROJECT_ROOT;
  delete process.env.INIT_CWD;
});

afterAll(() => {
  fs.rmSync(os.homedir(), { recursive: true, force: true });
  fs.rmSync(getProjectKbPath('/seed'), { recursive: true, force: true });
});

describe('路径与单例', () => {
  it('getStorageRoot 落在用户目录', () => {
    expect(getStorageRoot()).toBe(path.join(os.homedir(), '.customize-agent'));
  });

  it('getProjectKbRoot 解析绝对路径后交给知识包', () => {
    const root = getProjectKbRoot('rel/proj');
    expect(getProjectKbPath).toHaveBeenCalledWith(path.resolve('rel/proj'));
    expect(root).toBe(getProjectKbPath('/seed'));
  });

  it('getMultiProjectManager 单例；shutdown 后重建', async () => {
    const m1 = getMultiProjectManager();
    expect(getMultiProjectManager()).toBe(m1);
    await shutdownKbService();
    expect(vi.mocked(m1.shutdown)).toHaveBeenCalled();
    expect(getMultiProjectManager()).not.toBe(m1);
  });
});

describe('getProjectRoot / resolveProjectRoot', () => {
  it('CUSTOMIZE_PROJECT_ROOT 指向存在的目录时优先返回', () => {
    const envDir = path.join(os.homedir(), 'env-proj');
    fs.mkdirSync(envDir, { recursive: true });
    process.env.CUSTOMIZE_PROJECT_ROOT = envDir;
    expect(getProjectRoot()).toBe(path.resolve(envDir));
  });

  it('env 目录不存在时回退到工作区根', () => {
    process.env.CUSTOMIZE_PROJECT_ROOT = path.join(os.homedir(), 'ghost-proj');
    expect(getProjectRoot()).toBe(path.resolve(process.cwd(), '../..'));
  });

  it('INIT_CWD 存在且合法时作为项目根', () => {
    const initDir = path.join(os.homedir(), 'init-proj');
    fs.mkdirSync(initDir, { recursive: true });
    process.env.INIT_CWD = initDir;
    expect(getProjectRoot()).toBe(path.resolve(initDir));
  });

  it('注册表存在时回退到最近打开的项目', () => {
    const registryDir = path.join(os.homedir(), '.customize-agent', 'projects');
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(path.join(registryDir, 'registry.db'), '');
    (globalThis as Globals).__kbRegistryRows = [{ project_root: '/known/proj' }];
    expect(getProjectRoot()).toBe(path.resolve('/known/proj'));
    expect(getKnownProjectRoots()).toEqual(['/known/proj']);
  });

  it('内部残留项目被过滤', () => {
    // 位于用户数据目录下 → 拒绝
    const internalDir = path.join(os.homedir(), '.customize-agent', 'projects', 'x');
    fs.mkdirSync(internalDir, { recursive: true });
    expect(resolveProjectRoot(internalDir)).toBeNull();
    // 以 apps/server 结尾 → 拒绝
    const serverDir = path.join(os.homedir(), 'some', 'apps', 'server');
    fs.mkdirSync(serverDir, { recursive: true });
    expect(resolveProjectRoot(serverDir)).toBeNull();
    // 含 pnpm-workspace.yaml 与 apps/server 的 monorepo → 保留
    const monoDir = path.join(os.homedir(), 'mono');
    fs.mkdirSync(path.join(monoDir, 'apps', 'server'), { recursive: true });
    fs.writeFileSync(path.join(monoDir, 'pnpm-workspace.yaml'), '');
    expect(resolveProjectRoot(monoDir)).toBe(path.resolve(monoDir));
    // 不存在的路径 → null
    expect(resolveProjectRoot(path.join(os.homedir(), 'ghost'))).toBeNull();
  });

  it('resolveProjectRoot 无参数时走 getProjectRoot', () => {
    const envDir = path.join(os.homedir(), 'env-proj-2');
    fs.mkdirSync(envDir, { recursive: true });
    process.env.CUSTOMIZE_PROJECT_ROOT = envDir;
    expect(resolveProjectRoot()).toBe(path.resolve(envDir));
  });
});

describe('listKnowledgeFiles', () => {
  it('扫描磁盘：目录分类/扩展名格式/噪声文件跳过', () => {
    seedKbTree();
    const files = listKnowledgeFiles('/proj-scan');
    expect(files).toHaveLength(5);
    const byPath = new Map(files.map(file => [file.relativePath, file]));
    expect(byPath.get('文档资料/招标文件.PDF')?.category).toBe('document');
    expect(byPath.get('文档资料/招标文件.PDF')?.format).toBe('pdf');
    expect(byPath.get('表格数据/清单.xlsx')?.category).toBe('spreadsheet');
    expect(byPath.get('图片素材/平面.png')?.category).toBe('image');
    expect(byPath.get('图纸文件/结构.dwg')?.category).toBe('cad');
    expect(byPath.get('杂项.txt')?.category).toBe('other');
    expect(byPath.get('杂项.txt')?.format).toBe('txt');
    // .source.txt 被跳过
    expect(byPath.has('草稿.source.txt')).toBe(false);
    expect(files.every(file => file.matchedBy === 'disk' && file.status === 'disk')).toBe(true);
  });

  it('category 过滤与 mtime 倒序排序', () => {
    const kbRoot = seedKbTree();
    const old = new Date(500);
    fs.utimesSync(path.join(kbRoot, '表格数据', '清单.xlsx'), old, old);
    fs.utimesSync(path.join(kbRoot, '图片素材', '平面.png'), old, old);
    fs.utimesSync(path.join(kbRoot, '图纸文件', '结构.dwg'), old, old);
    fs.utimesSync(path.join(kbRoot, '杂项.txt'), new Date(1000), new Date(1000));
    fs.utimesSync(path.join(kbRoot, '文档资料', '招标文件.PDF'), new Date(2000), new Date(2000));
    const all = listKnowledgeFiles('/proj-scan');
    expect(all[0]!.relativePath).toBe('文档资料/招标文件.PDF');
    expect(listKnowledgeFiles('/proj-scan', { category: 'document' }).map(file => file.relativePath)).toEqual(['文档资料/招标文件.PDF']);
  });

  it('索引记录与磁盘扫描合并：尺寸/mtime 取磁盘值，其余保留索引值', () => {
    seedKbTree();
    // 需要 kb.db 存在才会读取索引记录（目录名与实现一致地动态计算）
    const dbPath = path.join(os.homedir(), '.customize-agent', 'projects', computeProjectId(path.resolve('/proj-scan')), 'kb.db');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.writeFileSync(dbPath, '');
    (globalThis as Globals).__kbIndexRecords = [{
      relativePath: '文档资料/招标文件.PDF', category: 'document', format: 'pdf', contentHash: 'h1',
      fileSize: 999, mtime: 1, chunkCount: 7, collectionName: 'c', indexedAt: 123, lastVerifiedAt: 456,
      status: 'active', matchedBy: 'metadata',
    }];
    const files = listKnowledgeFiles('/proj-scan');
    const merged = files.find(file => file.relativePath === '文档资料/招标文件.PDF');
    expect(merged?.matchedBy).toBe('metadata');
    expect(merged?.fileSize).toBe(1);
    expect(merged?.mtime).toBeGreaterThan(1);
    expect(merged?.chunkCount).toBe(7);
    expect(merged?.status).toBe('active');
    expect(merged?.indexedAt).toBe(123);
  });

  it('知识库根目录不存在时返回空列表', () => {
    expect(listKnowledgeFiles('/proj-empty')).toEqual([]);
  });
});

describe('discoverKnowledgeFiles', () => {
  it('query 过滤并标记 matchedBy=path；limit 截断保留 total', async () => {
    seedKbTree();
    const result = await discoverKnowledgeFiles('/proj-scan', { query: '招标' });
    expect(result.files.map(file => file.relativePath)).toEqual(['文档资料/招标文件.PDF']);
    expect(result.files[0]!.matchedBy).toBe('path');
    expect(result.total).toBe(1);

    const limited = await discoverKnowledgeFiles('/proj-scan', { limit: 2 });
    expect(limited.files).toHaveLength(2);
    expect(limited.total).toBe(5);
  });

  it('内容检索结果合并：matchedBy=content 优先排序并保留 score', async () => {
    seedKbTree();
    const manager = getMultiProjectManager();
    vi.mocked(manager.search).mockResolvedValue({
      results: [
        { filePath: '内容文件.pdf', score: 0.9, content: '正文', sectionTitle: '' },
        { filePath: '文档资料/招标文件.PDF', score: 0.7, content: '', sectionTitle: '' },
      ],
      debug: 'd',
    } as never);
    const result = await discoverKnowledgeFiles('/proj-scan', { query: '关键词' });
    expect(result.files[0]!.matchedBy).toBe('content');
    expect(result.files[0]!.relativePath).toBe('内容文件.pdf');
    expect(result.files[0]!.score).toBe(0.9);
    expect(result.files[0]!.category).toBe('content');
    // 已存在的文件合并后保留原属性、覆盖 matchedBy 与 score
    const merged = result.files.find(file => file.relativePath === '文档资料/招标文件.PDF');
    expect(merged?.matchedBy).toBe('content');
    expect(merged?.category).toBe('document');
    expect(merged?.score).toBe(0.7);
  });

  it('内容索引抛错时仍返回文件名/磁盘匹配结果', async () => {
    seedKbTree();
    const manager = getMultiProjectManager();
    vi.mocked(manager.search).mockRejectedValue(new Error('索引不可用'));
    const result = await discoverKnowledgeFiles('/proj-scan', { query: '招标' });
    expect(result.files.map(file => file.relativePath)).toEqual(['文档资料/招标文件.PDF']);
  });

  it('includeContent=false 时不触发内容检索', async () => {
    seedKbTree();
    const manager = getMultiProjectManager();
    vi.mocked(manager.search).mockClear();
    const result = await discoverKnowledgeFiles('/proj-scan', { query: '招标', includeContent: false });
    expect(manager.search).not.toHaveBeenCalled();
    expect(result.files.map(file => file.relativePath)).toEqual(['文档资料/招标文件.PDF']);
  });
});
