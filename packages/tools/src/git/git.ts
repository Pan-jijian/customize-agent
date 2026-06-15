import { TerminalTool } from '../terminal/shell.js';

/** Git 工具 — 封装通用 Git 操作供 Agent 调用 */
export class GitTool {
  private terminal: TerminalTool;

  constructor(cwd: string) {
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

  /** 自动暂存全部改动并提交（注入防止 shell 注入的转义） */
  async commitAll(message: string): Promise<string> {
    const escaped = message.replace(/'/g, "\\'");
    await this.terminal.executeCommand('git add .');
    const res = await this.terminal.executeCommand(`git commit -m "${escaped}"`);
    if (res.code === 0) {
      return `代码提交成功！Commit Message: ${escaped}`;
    }
    return `提交失败：${res.stderr || res.stdout}`;
  }
}
