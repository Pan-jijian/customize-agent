import * as fs from 'fs/promises';
import { existsSync } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createHash } from 'crypto';
import { reportNonFatalError } from '@customize-agent/types';
import { SKIP_DIRS } from './constants.js';
import { resolveSafe, walk } from './path-utils.js';

/** 单个快照文件大小上限（25MB） */
const SNAPSHOT_MAX_FILE_SIZE = 25_000_000;
/** 快照总大小上限（250MB） */
const SNAPSHOT_MAX_TOTAL_SIZE = 250_000_000;

/** 工作区快照类型：文件相对路径 → Buffer 映射 */
export type WorkspaceSnapshot = Map<string, Buffer>;
/** 序列化后的快照类型：路径 + Base64 编码内容 */
export type SerializedWorkspaceSnapshot = Array<[string, string]>;

/** 检查点清单中的单个文件条目 */
type SnapshotEntry = { path: string; file: string; size: number; mtimeMs: number; mode: number };
/** 检查点清单元数据（版本 2） */
type SnapshotManifest = { version: 2; name: string; createdAt: string; files: SnapshotEntry[]; skipped: Array<{ path: string; reason: string }> };

/**
 * 工作区快照服务 — 创建、列出、恢复和删除代码库检查点。
 * 基于文件系统的增量快照系统，通过 manifest + 文件副本实现精确恢复。
 */
export class WorkspaceSnapshotService {
  constructor(private cwd: string = process.cwd()) {}

  /** 路径安全解析 */
  private _resolveSafe(relativePath: string): string {
    return resolveSafe(relativePath, this.cwd);
  }

  /** 快照存储目录（~/.customize-agent/snapshots） */
  snapshotDir(): string {
    return path.join(os.homedir(), '.customize-agent', 'snapshots');
  }

  /** 快照 JSON 文件路径 */
  snapshotFile(name: string): string {
    return path.join(this.snapshotDir(), `${name}.json`);
  }

  /** 检查点目录（包含 manifest + files/ 子目录） */
  checkpointDir(name: string): string {
    return path.join(this.snapshotDir(), name);
  }

  /** 检查点清单文件路径 */
  checkpointManifestFile(name: string): string {
    return path.join(this.checkpointDir(name), 'manifest.json');
  }

  /** 扫描工作区并创建内存快照（包含所有文件内容） */
  async takeSnapshot(): Promise<WorkspaceSnapshot> {
    const snapshot: WorkspaceSnapshot = new Map();
    for (const rel of await walk(this.cwd, SKIP_DIRS)) {
      const full = this._resolveSafe(rel);
      const stat = await fs.stat(full);
      if (stat.size <= SNAPSHOT_MAX_FILE_SIZE) snapshot.set(rel, await fs.readFile(full));
    }
    return snapshot;
  }

  /** 将快照序列化为 Base64 编码的可传输格式 */
  serialize(snapshot: WorkspaceSnapshot): SerializedWorkspaceSnapshot {
    return [...snapshot.entries()].map(([rel, content]) => [rel, content.toString('base64')]);
  }

  /** 从序列化数据反序列化为快照 */
  deserialize(data: SerializedWorkspaceSnapshot): WorkspaceSnapshot {
    return new Map(data.map(([rel, content]) => [rel, Buffer.from(content, 'base64')]));
  }

  /** 将快照保存为 JSON 文件 */
  async saveSerialized(name: string, snapshot: WorkspaceSnapshot): Promise<void> {
    await fs.mkdir(this.snapshotDir(), { recursive: true });
    await fs.writeFile(this.snapshotFile(name), JSON.stringify(this.serialize(snapshot)), 'utf-8');
  }

  /** 从 JSON 文件加载序列化快照，不存在则返回 null */
  async loadSerialized(name: string): Promise<WorkspaceSnapshot | null> {
    try {
      const raw = await fs.readFile(this.snapshotFile(name), 'utf-8');
      return this.deserialize(JSON.parse(raw) as SerializedWorkspaceSnapshot);
    } catch {
      return null;
    }
  }

  /** 恢复快照：删除快照中不存在的文件，写入或覆盖快照中的文件 */
  async restoreSnapshot(snapshot: WorkspaceSnapshot): Promise<void> {
    const current = await this.takeSnapshot();
    for (const [rel] of current) {
      if (!snapshot.has(rel)) await fs.rm(this._resolveSafe(rel), { force: true });
    }
    for (const [rel, content] of snapshot) {
      const full = this._resolveSafe(rel);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, content);
    }
  }

  /** 创建命名检查点：遍历工作区，复制文件到检查点目录，生成 manifest */
  async createCheckpoint(name: string): Promise<SnapshotManifest> {
    const dir = this.checkpointDir(name);
    const filesDir = path.join(dir, 'files');
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(filesDir, { recursive: true });

    const manifest: SnapshotManifest = { version: 2, name, createdAt: new Date().toISOString(), files: [], skipped: [] };
    let totalSize = 0;
    for (const rel of await walk(this.cwd, SKIP_DIRS)) {
      const full = this._resolveSafe(rel);
      const stat = await fs.stat(full);
      if (stat.size > SNAPSHOT_MAX_FILE_SIZE) {
        manifest.skipped.push({ path: rel, reason: `file too large (${stat.size} bytes)` });
        continue;
      }
      if (totalSize + stat.size > SNAPSHOT_MAX_TOTAL_SIZE) {
        manifest.skipped.push({ path: rel, reason: 'snapshot total size limit reached' });
        continue;
      }
      const file = createHash('sha256').update(rel).digest('hex');
      await fs.copyFile(full, path.join(filesDir, file));
      manifest.files.push({ path: rel, file, size: stat.size, mtimeMs: stat.mtimeMs, mode: stat.mode });
      totalSize += stat.size;
    }

    await fs.writeFile(this.checkpointManifestFile(name), JSON.stringify(manifest, null, 2), 'utf-8');
    return manifest;
  }

  /** 列出所有检查点名称（同时扫描目录和 JSON 文件格式） */
  async listCheckpoints(): Promise<string[]> {
    await fs.mkdir(this.snapshotDir(), { recursive: true });
    const entries = await fs.readdir(this.snapshotDir(), { withFileTypes: true });
    const names = entries
      .filter(entry => entry.isDirectory() || entry.name.endsWith('.json'))
      .map(entry => entry.isDirectory() ? entry.name : entry.name.replace(/\.json$/, ''));
    return [...new Set(names)];
  }

  /** 恢复检查点：优先使用基于 manifest + 文件副本的方式，否则尝试旧版 JSON 快照 */
  async restoreCheckpoint(name: string): Promise<{ name: string; files: number }> {
    if (existsSync(this.checkpointManifestFile(name))) {
      const manifest = JSON.parse(await fs.readFile(this.checkpointManifestFile(name), 'utf-8')) as SnapshotManifest;
      await this.restoreManifestSnapshot(manifest, this.checkpointDir(name));
      return { name, files: manifest.files.length };
    }
    const snapshot = await this.loadSerialized(name);
    if (!snapshot) throw new Error(`Checkpoint not found: ${name}`);
    await this.restoreSnapshot(snapshot);
    return { name, files: snapshot.size };
  }

  /** 删除检查点（同时清理目录和旧版 JSON 文件） */
  async deleteCheckpoint(name: string): Promise<void> {
    await fs.rm(this.checkpointDir(name), { recursive: true, force: true });
    await fs.rm(this.snapshotFile(name), { force: true });
  }

  /** 基于 manifest 恢复检查点：删除不在清单中的文件，恢复清单中的文件及权限 */
  private async restoreManifestSnapshot(manifest: SnapshotManifest, checkpointDir: string): Promise<void> {
    const keep = new Set(manifest.files.map(file => file.path));
    for (const rel of await walk(this.cwd, SKIP_DIRS)) {
      if (!keep.has(rel)) await fs.rm(this._resolveSafe(rel), { force: true });
    }
    for (const entry of manifest.files) {
      const full = this._resolveSafe(entry.path);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.copyFile(path.join(checkpointDir, 'files', entry.file), full);
      await fs.chmod(full, entry.mode).catch(err => {
        reportNonFatalError({
          source: 'workspace_snapshot.restore_chmod',
          error: err,
          details: { path: entry.path, mode: entry.mode },
        });
      });
    }
  }
}
