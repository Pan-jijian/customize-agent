// @customize-agent/tools — 工作区文件系统抽象
import * as fs from 'fs/promises';
import * as path from 'path';
import { resolveSafe } from './path-utils.js';

export class WorkspaceFs {
  constructor(private cwd: string = process.cwd()) {}

  resolveSafe(relativePath: string): string {
    return resolveSafe(relativePath, this.cwd);
  }

  async readText(relativePath: string): Promise<string> {
    return fs.readFile(this.resolveSafe(relativePath), 'utf-8');
  }

  async writeText(relativePath: string, content: string): Promise<void> {
    const full = this.resolveSafe(relativePath);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, 'utf-8');
  }

  async delete(relativePath: string): Promise<void> {
    await fs.rm(this.resolveSafe(relativePath), { recursive: true, force: true });
  }

  async move(from: string, to: string): Promise<void> {
    const src = this.resolveSafe(from);
    const dst = this.resolveSafe(to);
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.rename(src, dst);
  }

  async copy(from: string, to: string): Promise<void> {
    const src = this.resolveSafe(from);
    const dst = this.resolveSafe(to);
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.cp(src, dst, { recursive: true });
  }

  async mkdir(relativePath: string): Promise<void> {
    await fs.mkdir(this.resolveSafe(relativePath), { recursive: true });
  }
}
