import { execa } from 'execa';
import { TerminalTool } from './terminal-shell.js';

/** Git 工具 — 封装通用 Git 操作供 Agent 调用 */
export class GitTool {
  private terminal: TerminalTool;
  private cwd: string;

  constructor(cwd: string) {
    this.cwd = cwd;
    this.terminal = new TerminalTool(cwd);
  }

  /** 获取当前工作区 Git 状态（简化输出） */
  async getStatus(): Promise<string> {
    const res = await this.terminal.executeCommand('git status -s');
    return res.stdout || '暂无任何文件改动';
  }

  /** 获取当前未暂存的 unified diff */
  async getDiff(): Promise<string> {
    const res = await this.terminal.executeCommand('git diff');
    return res.stdout || '暂无代码级 Diff 变动';
  }

  /** 自动暂存全部改动并提交（使用参数数组防止 shell 注入） */
  async commitAll(message: string): Promise<string> {
    await this.terminal.executeCommand('git add .');
    // 使用 execa 参数数组形式避免 shell 元字符注入
    const res = await execa({ cwd: this.cwd, reject: false })`git commit -m ${message}`;
    if (res.exitCode === 0) {
      return `代码提交成功！Commit Message: ${message}`;
    }
    return `提交失败：${res.stderr || res.stdout}`;
  }
}
