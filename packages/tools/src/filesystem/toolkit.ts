import * as fs from 'fs/promises';
import * as path from 'path';
import { DiffEngine } from '@code-agent/diff';
import { TerminalTool } from '../terminal/shell.js';
import { GitTool } from '../git/git.js';
import { UnifiedSyntaxValidator } from '../validator/syntax.js';

/**
 * ToolKit — Agent 工具集，提供文件读写、代码修改、语法验证等全部工具能力。
 * 所有文件操作通过 resolveSafe() 做路径沙箱保护，防止逃逸出项目根目录。
 */
export class ToolKit {
  private cwd: string;
  public terminal: TerminalTool;
  public git: GitTool;
  private syntaxValidator: UnifiedSyntaxValidator;

  constructor(cwd: string = process.cwd()) {
    this.cwd = cwd;
    this.terminal = new TerminalTool(cwd);
    this.git = new GitTool(cwd);
    this.syntaxValidator = new UnifiedSyntaxValidator();
  }

  /**
   * 安全路径解析 — 确保 LLM 提供的相对路径不会逃逸出项目根目录。
   * 这是 Agent 文件系统的物理边界。
   */
  private resolveSafe(relativePath: string): string {
    const resolved = path.resolve(this.cwd, relativePath);
    const root = path.resolve(this.cwd);
    if (!resolved.startsWith(root + path.sep) && resolved !== root) {
      throw new Error(`文件路径 ${resolved} 超出项目边界`);
    }
    return resolved;
  }

  /** 列出当前目录下的文件（隐藏目录和 node_modules 自动过滤） */
  async listFiles(): Promise<string[]> {
    const entries = await fs.readdir(this.cwd, { withFileTypes: true });
    return entries.flatMap(entry => {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') {
        return [];
      }
      const prefix = entry.isDirectory() ? '[DIR]' : '[FILE]';
      return [`${prefix} ${entry.name}`];
    });
  }

  /** 读取指定文件内容（路径自动做安全解析） */
  async readFile(relativeFilePath: string): Promise<string> {
    const fullPath = this.resolveSafe(relativeFilePath);
    try {
      return await fs.readFile(fullPath, 'utf-8');
    } catch (error) {
      throw new Error(`无法读取文件 ${relativeFilePath}: ${(error as Error).message}`, { cause: error });
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
   * 流程：备份 → 解析补丁 → 应用 → 语法验证 → 写入 → 清理备份。
   * 任何一步失败自动回滚到原始内容。
   * 返回修改前后的 Unified Diff 预览。
   */
  async modifyFileWithDiff(relativeFilePath: string, llmDiffOutput: string): Promise<{ success: boolean; preview: string }> {
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
}
