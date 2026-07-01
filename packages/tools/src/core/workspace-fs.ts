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
    this.ensureNotKnowledgeBase(relativePath);
    return fs.readFile(this.resolveSafe(relativePath), 'utf-8');
  }

  async writeText(relativePath: string, content: string): Promise<void> {
    this.ensureNotKnowledgeBase(relativePath);
    const full = this.resolveSafe(relativePath);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, 'utf-8');
  }

  async delete(relativePath: string): Promise<void> {
    this.ensureNotKnowledgeBase(relativePath);
    await fs.rm(this.resolveSafe(relativePath), { recursive: true, force: true });
  }

  async move(from: string, to: string): Promise<void> {
    this.ensureNotKnowledgeBase(from);
    this.ensureNotKnowledgeBase(to);
    const src = this.resolveSafe(from);
    const dst = this.resolveSafe(to);
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.rename(src, dst);
  }

  async copy(from: string, to: string): Promise<void> {
    this.ensureNotKnowledgeBase(from);
    this.ensureNotKnowledgeBase(to);
    const src = this.resolveSafe(from);
    const dst = this.resolveSafe(to);
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.cp(src, dst, { recursive: true });
  }

  async mkdir(relativePath: string): Promise<void> {
    this.ensureNotKnowledgeBase(relativePath);
    await fs.mkdir(this.resolveSafe(relativePath), { recursive: true });
  }

  private ensureNotKnowledgeBase(relativePath: string): void {
    if (relativePath.split(/[\\/]+/u).includes('knowledgeBase')) {
      throw new Error('knowledgeBase 是知识库原始文件投放目录，智能体工具不能直接读写，请通过知识库检索或 Web Dashboard 管理');
    }
  }
}
