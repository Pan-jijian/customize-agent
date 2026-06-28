import * as fs from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import * as path from 'path';
import { DiffEngine } from './diff.js';
import { TerminalTool } from './terminal-shell.js';
import { execa } from 'execa';
import { UnifiedSyntaxValidator } from './syntax-validator.js';

// ── .gitignore 匹配器 ──
const IGNORE_CACHE = new Map<string, RegExp[]>();

function loadGitignorePatterns(rootDir: string): RegExp[] {
  const cached = IGNORE_CACHE.get(rootDir);
  if (cached) return cached;

  const patterns: RegExp[] = [];
  const gitignorePath = path.join(rootDir, '.gitignore');
  if (!existsSync(gitignorePath)) {
    IGNORE_CACHE.set(rootDir, patterns);
    return patterns;
  }

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

      const GLOBSTAR = '\x01'; // 临时占位符，避免 ** 和 * 替换顺序冲突
      let re = p
        .replace(/[.+^${}()|[\\]/g, '\\$&')
        .replace(/\*\*/g, GLOBSTAR)
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '[^/]')
        .replace(new RegExp(GLOBSTAR, 'g'), '.*');

      if (anchored) re = '^' + re;
      else re = '(^|.*/)' + re;

      if (dirOnly) re += '(/.*)?$';
      else re += '$';

      patterns.push(new RegExp(re));
    }
  } catch {
    // ignore read errors
  }

  IGNORE_CACHE.set(rootDir, patterns);
  return patterns;
}

function isGitignored(rootDir: string, relativePath: string): boolean {
  const patterns = loadGitignorePatterns(rootDir);
  for (const re of patterns) {
    if (re.test(relativePath)) return true;
  }
  return false;
}

/**
 * ToolKit — Agent 工具集，提供文件读写、代码修改、语法验证等全部工具能力。
 * 所有文件操作通过 resolveSafe() 做路径沙箱保护，防止逃逸出项目根目录。
 * .gitignore 规则自动阻止读取被忽略的文件。
 */
export class ToolKit {
  private cwd: string;
  public terminal: TerminalTool;
  private syntaxValidator: UnifiedSyntaxValidator;
  constructor(cwd: string = process.cwd()) {
    this.cwd = cwd;
    this.terminal = new TerminalTool(cwd);
    this.syntaxValidator = new UnifiedSyntaxValidator();
  }

  /** 安全路径解析 — 确保 LLM 提供的相对路径不会逃逸出项目根目录 */
  private resolveSafe(relativePath: string): string {
    const resolved = path.resolve(this.cwd, relativePath);
    const root = path.resolve(this.cwd);
    if (!resolved.startsWith(root + path.sep) && resolved !== root) {
      throw new Error(`文件路径 ${resolved} 超出项目边界`);
    }
    return resolved;
  }

  /** 检查路径是否被 .gitignore 忽略 */
  private checkGitignore(relativePath: string): void {
    if (isGitignored(this.cwd, relativePath)) {
      throw new Error(`文件 ${relativePath} 被 .gitignore 忽略，不允许读取或修改`);
    }
  }

  /** 列出当前目录下的文件（隐藏目录和 node_modules 自动过滤） */
  async listFiles(): Promise<string[]> {
    const entries = await fs.readdir(this.cwd, { withFileTypes: true });
    return entries.flatMap(entry => {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') {
        return [];
      }
      // 也过滤 .gitignore 匹配的目录
      const rel = entry.name;
      if (isGitignored(this.cwd, rel)) return [];
      const prefix = entry.isDirectory() ? '[DIR]' : '[FILE]';
      return [`${prefix} ${entry.name}`];
    });
  }

  /** 读取指定文件内容（路径自动做安全解析 + .gitignore 检查） */
  async readFile(relativeFilePath: string): Promise<string> {
    this.checkGitignore(relativeFilePath);
    const fullPath = this.resolveSafe(relativeFilePath);
    try {
      return await fs.readFile(fullPath, 'utf-8');
    } catch (error) {
      throw new Error(`无法读取文件 ${relativeFilePath}: ${(error as Error).message}`, { cause: error });
    }
  }

  /** 创建或覆盖文件（带备份，失败回滚） */
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
      this.validateSyntaxMultiLang(fullPath, content);
      if (backupPath) await fs.unlink(backupPath);
    } catch (error) {
      if (backupPath) {
        try { await fs.cp(backupPath, fullPath); await fs.unlink(backupPath); } catch { /* */ }
      }
      throw new Error(`写文件失败: ${(error as Error).message}`, { cause: error });
    }
  }

  /** 多语言语法验证（内部委托给 tree-sitter 统一验证器） */
  validateSyntaxMultiLang(filePath: string, content: string): void {
    const result = this.syntaxValidator.validate(filePath, content);
    if (!result.valid) {
      throw new Error(UnifiedSyntaxValidator.formatErrors(result));
    }
  }

  /**
   * 通过 SEARCH/REPLACE 协议修改文件。
   * 流程：gitignore 检查 → 备份 → 解析补丁 → 应用 → 语法验证 → 写入 → 清理备份。
   * 任何一步失败自动回滚到原始内容。
   * 返回修改前后的 Unified Diff 预览。
   */
  async modifyFileWithDiff(relativeFilePath: string, llmDiffOutput: string): Promise<{ success: boolean; preview: string }> {
    this.checkGitignore(relativeFilePath);
    const fullPath = this.resolveSafe(relativeFilePath);
    const originalContent = await fs.readFile(fullPath, 'utf-8');

    // 备份原始文件，失败时回滚用
    const backupPath = fullPath + '.agent-backup';
    await fs.writeFile(backupPath, originalContent, 'utf-8');

    try {
      const blocks = DiffEngine.parseBlocks(llmDiffOutput);
      if (blocks.length === 0) {
        throw new Error('没有找到任何修改块');
      }
      let newContent = originalContent;
      for (const block of blocks) {
        newContent = DiffEngine.applyPatch(newContent, block);
      }

      // tree-sitter 多语言语法检查
      this.validateSyntaxMultiLang(fullPath, newContent);

      // 生成 Diff 预览
      const preview = DiffEngine.generateUnifiedDiff(relativeFilePath, originalContent, newContent);

      // 写入新内容
      await fs.writeFile(fullPath, newContent, 'utf-8');

      // 成功后清理备份
      await fs.unlink(backupPath);
      return { success: true, preview };
    } catch (error) {
      // 失败回滚：恢复原始内容
      await fs.writeFile(fullPath, originalContent, 'utf-8');
      await fs.unlink(backupPath).catch(() => {});
      throw new Error(
        `修改失败，已自动回滚到原始内容:\n${(error as Error).message}`,
        { cause: error },
      );
    }
  }

  /** Git 提交 */
  async commitAll(message: string): Promise<string> {
    try {
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
