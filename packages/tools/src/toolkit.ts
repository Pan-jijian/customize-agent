// @customize-agent/tools — ToolKit（高质量文件操作 + .gitignore 感知）
import * as fs from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import * as path from 'path';
import { DiffEngine } from './editing/diff.js';
import { UnifiedSyntaxValidator } from './editing/syntax-validator.js';
import { SandboxExecutor } from './sandbox/sandbox-executor.js';
import { WorkspaceFs } from './core/workspace-fs.js';

// ── .gitignore 匹配器 ──
const IGNORE_CACHE = new Map<string, RegExp[]>();

function loadGitignorePatterns(rootDir: string): RegExp[] {
  const cached = IGNORE_CACHE.get(rootDir);
  if (cached) return cached;
  const patterns: RegExp[] = [];
  const gitignorePath = path.join(rootDir, '.gitignore');
  if (!existsSync(gitignorePath)) { IGNORE_CACHE.set(rootDir, patterns); return patterns; }
  try {
    const content = readFileSync(gitignorePath, 'utf-8');
    for (let line of content.split('\n')) {
      line = line.trim();
      if (!line || line.startsWith('#')) continue;
      const negate = line.startsWith('!');
      if (negate) line = line.slice(1);
      const dirOnly = line.endsWith('/');
      if (dirOnly) line = line.slice(0, -1);
      const anchored = line.startsWith('/');
      const p = anchored ? line.slice(1) : line;
      const GLOBSTAR = '\x01';
      let re = p.replace(/[.+^${}()|[\\]/g, '\\$&').replace(/\*\*/g, GLOBSTAR).replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(new RegExp(GLOBSTAR, 'g'), '.*');
      if (anchored) re = '^' + re; else re = '(^|.*/)' + re;
      if (dirOnly) re += '(/.*)?$'; else re += '$';
      patterns.push(new RegExp(re));
    }
  } catch { /* ignore read errors */ }
  IGNORE_CACHE.set(rootDir, patterns);
  return patterns;
}

function isGitignored(rootDir: string, relativePath: string): boolean {
  for (const re of loadGitignorePatterns(rootDir)) { if (re.test(relativePath)) return true; }
  return false;
}

/**
 * ToolKit — Agent 工具集，提供文件读写、代码修改、语法验证等全部工具能力。
 * 所有文件操作通过 resolveSafe() 做路径沙箱保护。
 * .gitignore 规则自动阻止读取被忽略的文件。
 */
export class ToolKit {
  private cwd: string;
  private sandbox: SandboxExecutor;
  private syntaxValidator: UnifiedSyntaxValidator;
  private workspaceFs: WorkspaceFs;

  constructor(cwd: string = process.cwd()) {
    this.cwd = cwd;
    this.sandbox = new SandboxExecutor('vfs-guard', cwd);
    this.syntaxValidator = new UnifiedSyntaxValidator();
    this.workspaceFs = new WorkspaceFs(cwd);
  }

  /** 快捷终端访问（向后兼容旧 API） */
  get terminal(): { executeCommand: (command: string, approved?: boolean, signal?: AbortSignal) => Promise<{ stdout: string; stderr: string; code: number }> } {
    return {
      executeCommand: (command: string, approved?: boolean, signal?: AbortSignal) =>
        this.sandbox.execute(command, undefined, approved, signal),
    };
  }

  private resolveSafe(relativePath: string): string {
    return this.workspaceFs.resolveSafe(relativePath);
  }

  private checkGitignore(relativePath: string): void {
    if (isGitignored(this.cwd, relativePath)) {
      throw new Error(`File "${relativePath}" is gitignored — cannot read or modify`);
    }
  }

  /** 列出当前目录下的文件 */
  async listFiles(): Promise<string[]> {
    const entries = await fs.readdir(this.cwd, { withFileTypes: true });
    return entries.flatMap(entry => {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') return [];
      if (isGitignored(this.cwd, entry.name)) return [];
      const prefix = entry.isDirectory() ? '[DIR]' : '[FILE]';
      return [`${prefix} ${entry.name}`];
    });
  }

  /** 读取文件内容（.gitignore 检查 + 路径安全） */
  async readFile(relativeFilePath: string): Promise<string> {
    this.checkGitignore(relativeFilePath);
    const fullPath = this.resolveSafe(relativeFilePath);
    try {
      return await fs.readFile(fullPath, 'utf-8');
    } catch (error) {
      throw new Error(`Unable to read file ${relativeFilePath}: ${(error as Error).message}`, { cause: error });
    }
  }

  /** 创建或覆盖文件（带备份，失败回滚 + 语法验证） */
  async writeFileWithBackup(relativeFilePath: string, content: string): Promise<void> {
    this.checkGitignore(relativeFilePath);
    const fullPath = this.resolveSafe(relativeFilePath);
    let backupPath: string | null = null;
    try {
      const exists = await fs.access(fullPath).then(() => true).catch(() => false);
      if (exists) {
        backupPath = fullPath + '.agent-backup';
        await fs.cp(fullPath, backupPath);
      }
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, content, 'utf-8');
      this.validateSyntax(fullPath, content);
      if (backupPath) await fs.unlink(backupPath);
    } catch (error) {
      if (backupPath) {
        try { await fs.cp(backupPath, fullPath); await fs.unlink(backupPath); } catch { /* best-effort */ }
      }
      throw new Error(`Write failed: ${(error as Error).message}`, { cause: error });
    }
  }

  /** 语法验证 */
  validateSyntax(filePath: string, content: string): void {
    const result = this.syntaxValidator.validate(filePath, content);
    if (!result.valid) {
      throw new Error(UnifiedSyntaxValidator.formatErrors(result));
    }
  }

  /**
   * 通过 SEARCH/REPLACE 协议修改文件。
   * 流程：gitignore 检查 → 备份 → 解析补丁 → 应用 → 语法验证 → 写入 → 清理备份。
   * 任何一步失败自动回滚。
   */
  async modifyFileWithDiff(relativeFilePath: string, llmDiffOutput: string): Promise<{ success: boolean; preview: string }> {
    this.checkGitignore(relativeFilePath);
    const fullPath = this.resolveSafe(relativeFilePath);
    const originalContent = await fs.readFile(fullPath, 'utf-8');
    const backupPath = fullPath + '.agent-backup';
    await fs.writeFile(backupPath, originalContent, 'utf-8');

    try {
      const blocks = DiffEngine.parseBlocks(llmDiffOutput);
      if (blocks.length === 0) throw new Error('No edit blocks found in SEARCH/REPLACE input');
      let newContent = originalContent;
      for (const block of blocks) { newContent = DiffEngine.applyPatch(newContent, block); }
      this.validateSyntax(fullPath, newContent);
      const preview = DiffEngine.generateUnifiedDiff(relativeFilePath, originalContent, newContent);
      await fs.writeFile(fullPath, newContent, 'utf-8');
      await fs.unlink(backupPath);
      return { success: true, preview };
    } catch (error) {
      await fs.writeFile(fullPath, originalContent, 'utf-8');
      await fs.unlink(backupPath).catch(() => undefined);
      throw new Error(`Modification failed, rolled back to original:\n${(error as Error).message}`, { cause: error });
    }
  }

  /** Git 提交 */
  async commitAll(message: string): Promise<string> {
    try {
      const { execa } = await import('execa');
      const v = await execa({ reject: false })`git --version`;
      if (v.exitCode !== 0) return 'Git not installed.';
      const check = await execa({ cwd: this.cwd, reject: false })`git rev-parse --git-dir`;
      if (check.exitCode !== 0) return 'Git not initialized in this directory.';
      await execa({ cwd: this.cwd, reject: false })`git add .`;
      const res = await execa({ cwd: this.cwd, reject: false })`git commit -m ${message}`;
      return res.exitCode === 0 ? `Committed: ${message}` : `Commit failed: ${res.stderr || res.stdout}`;
    } catch (err) {
      return `Git error: ${(err as Error).message}`;
    }
  }
}
