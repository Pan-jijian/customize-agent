// @customize-agent/tools — 文件操作工具
import * as fs from 'fs/promises';
import { createHash } from 'crypto';
import type { WorkspaceFs } from '../core/workspace-fs.js';
import { resolveSafe } from '../core/path-utils.js';

export class FileTools {
  constructor(
    private cwd: string,
    private workspaceFs: WorkspaceFs,
  ) {}

  async editFile(filePath: string, search: string, replace: string): Promise<string> {
    const original = await this.workspaceFs.readText(filePath);
    if (!original.includes(search)) throw new Error(`Search text not found in ${filePath}`);
    const updated = original.replace(search, replace);
    await this.workspaceFs.writeText(filePath, updated);
    return `Edited ${filePath}: ${original.length} -> ${updated.length} chars`;
  }

  async multiEdit(filePath: string, edits: Array<{ search: string; replace: string }>): Promise<string> {
    let content = await this.workspaceFs.readText(filePath);
    let count = 0;
    for (const edit of edits) {
      if (!content.includes(edit.search)) throw new Error(`Search text not found for edit ${count + 1}`);
      content = content.replace(edit.search, edit.replace);
      count++;
    }
    await this.workspaceFs.writeText(filePath, content);
    return `Applied ${count} edits to ${filePath}`;
  }

  async deleteFile(filePath: string): Promise<string> {
    await this.workspaceFs.delete(filePath);
    return `Deleted ${filePath}`;
  }

  async moveFile(from: string, to: string): Promise<string> {
    await this.workspaceFs.move(from, to);
    return `Moved ${from} -> ${to}`;
  }

  async copyFile(from: string, to: string): Promise<string> {
    await this.workspaceFs.copy(from, to);
    return `Copied ${from} -> ${to}`;
  }

  async mkdir(dir: string): Promise<string> {
    await this.workspaceFs.mkdir(dir);
    return `Created directory ${dir}`;
  }

  async statFile(filePath: string): Promise<string> {
    const full = resolveSafe(filePath, this.cwd);
    const stat = await fs.stat(full);
    return JSON.stringify({ path: filePath, size: stat.size, isFile: stat.isFile(), isDirectory: stat.isDirectory(), modified: stat.mtime.toISOString() }, null, 2);
  }

  async inspectFile(filePath: string): Promise<string> {
    const full = resolveSafe(filePath, this.cwd);
    const stat = await fs.stat(full);
    const buffer = stat.isFile() ? await fs.readFile(full) : Buffer.alloc(0);
    const hash = stat.isFile() ? createHash('sha256').update(buffer).digest('hex') : undefined;
    return JSON.stringify({ path: filePath, size: stat.size, isFile: stat.isFile(), isDirectory: stat.isDirectory(), sha256: hash, modified: stat.mtime.toISOString() }, null, 2);
  }
}
