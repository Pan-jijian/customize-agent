import * as fs from 'fs/promises';
import { existsSync } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createHash } from 'crypto';

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'target', '.next', '.turbo', '.cache']);
const SNAPSHOT_MAX_FILE_SIZE = 25_000_000;
const SNAPSHOT_MAX_TOTAL_SIZE = 250_000_000;

export type WorkspaceSnapshot = Map<string, Buffer>;
export type SerializedWorkspaceSnapshot = Array<[string, string]>;

type SnapshotEntry = { path: string; file: string; size: number; mtimeMs: number; mode: number };
type SnapshotManifest = { version: 2; name: string; createdAt: string; files: SnapshotEntry[]; skipped: Array<{ path: string; reason: string }> };

export class WorkspaceSnapshotService {
  constructor(private cwd: string = process.cwd()) {}

  private resolveSafe(relativePath: string): string {
    const resolved = path.resolve(this.cwd, relativePath || '.');
    const root = path.resolve(this.cwd);
    if (!resolved.startsWith(root + path.sep) && resolved !== root) throw new Error(`Path escapes project root: ${relativePath}`);
    return resolved;
  }

  snapshotDir(): string {
    return path.join(os.homedir(), '.customize-agent', 'snapshots');
  }

  snapshotFile(name: string): string {
    return path.join(this.snapshotDir(), `${name}.json`);
  }

  checkpointDir(name: string): string {
    return path.join(this.snapshotDir(), name);
  }

  checkpointManifestFile(name: string): string {
    return path.join(this.checkpointDir(name), 'manifest.json');
  }

  async walk(dir = this.cwd, files: string[] = []): Promise<string[]> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(this.cwd, full);
      if (entry.isDirectory()) await this.walk(full, files);
      else if (entry.isFile()) files.push(rel);
    }
    return files;
  }

  async takeSnapshot(): Promise<WorkspaceSnapshot> {
    const snapshot: WorkspaceSnapshot = new Map();
    for (const rel of await this.walk()) {
      const full = this.resolveSafe(rel);
      const stat = await fs.stat(full);
      if (stat.size <= SNAPSHOT_MAX_FILE_SIZE) snapshot.set(rel, await fs.readFile(full));
    }
    return snapshot;
  }

  serialize(snapshot: WorkspaceSnapshot): SerializedWorkspaceSnapshot {
    return [...snapshot.entries()].map(([rel, content]) => [rel, content.toString('base64')]);
  }

  deserialize(data: SerializedWorkspaceSnapshot): WorkspaceSnapshot {
    return new Map(data.map(([rel, content]) => [rel, Buffer.from(content, 'base64')]));
  }

  async saveSerialized(name: string, snapshot: WorkspaceSnapshot): Promise<void> {
    await fs.mkdir(this.snapshotDir(), { recursive: true });
    await fs.writeFile(this.snapshotFile(name), JSON.stringify(this.serialize(snapshot)), 'utf-8');
  }

  async loadSerialized(name: string): Promise<WorkspaceSnapshot | null> {
    try {
      const raw = await fs.readFile(this.snapshotFile(name), 'utf-8');
      return this.deserialize(JSON.parse(raw) as SerializedWorkspaceSnapshot);
    } catch {
      return null;
    }
  }

  async restoreSnapshot(snapshot: WorkspaceSnapshot): Promise<void> {
    const current = await this.takeSnapshot();
    for (const [rel] of current) {
      if (!snapshot.has(rel)) await fs.rm(this.resolveSafe(rel), { force: true });
    }
    for (const [rel, content] of snapshot) {
      const full = this.resolveSafe(rel);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, content);
    }
  }

  async createCheckpoint(name: string): Promise<SnapshotManifest> {
    const dir = this.checkpointDir(name);
    const filesDir = path.join(dir, 'files');
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(filesDir, { recursive: true });

    const manifest: SnapshotManifest = { version: 2, name, createdAt: new Date().toISOString(), files: [], skipped: [] };
    let totalSize = 0;
    for (const rel of await this.walk()) {
      const full = this.resolveSafe(rel);
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

  async listCheckpoints(): Promise<string[]> {
    await fs.mkdir(this.snapshotDir(), { recursive: true });
    const entries = await fs.readdir(this.snapshotDir(), { withFileTypes: true });
    const names = entries
      .filter(entry => entry.isDirectory() || entry.name.endsWith('.json'))
      .map(entry => entry.isDirectory() ? entry.name : entry.name.replace(/\.json$/, ''));
    return [...new Set(names)];
  }

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

  async deleteCheckpoint(name: string): Promise<void> {
    await fs.rm(this.checkpointDir(name), { recursive: true, force: true });
    await fs.rm(this.snapshotFile(name), { force: true });
  }

  private async restoreManifestSnapshot(manifest: SnapshotManifest, checkpointDir: string): Promise<void> {
    const keep = new Set(manifest.files.map(file => file.path));
    for (const rel of await this.walk()) {
      if (!keep.has(rel)) await fs.rm(this.resolveSafe(rel), { force: true });
    }
    for (const entry of manifest.files) {
      const full = this.resolveSafe(entry.path);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.copyFile(path.join(checkpointDir, 'files', entry.file), full);
      await fs.chmod(full, entry.mode).catch(() => undefined);
    }
  }
}
