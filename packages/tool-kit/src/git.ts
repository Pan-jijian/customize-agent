import { TerminalTool } from './terminal'

export class GitTool {
  private terminal: TerminalTool;
  constructor(cwd: string) {
    this.terminal = new TerminalTool(cwd);

  }

  /**
   * 获取当前git status
   */
  async getStatus(): Promise<string> {
    const res = await this.terminal.executeCommand('git status -s');
    return res.stdout || "暂无任何文件改动";
  }

  /**
   * 获取当前暂存区/未暂存的diff
   */
  async getDiff(): Promise<string> {
    const res = await this.terminal.executeCommand('git diff');
    return res.stdout || "暂无代码级 Diff 变动";
  }

  /**
   * 自动生成并替吉奥代码
   */
  async commitAll(message: string): Promise<string> {
    //自动把所有改动加入暂存区并提交
    await this.terminal.executeCommand('git add .');
    const res = await this.terminal.executeCommand(`git commit -m "${message}"`);
    if (res.code === 0) {
      return `代码提交成功！Commit Message: ${message}`;
    }
    return `提交失败：${res.stderr || res.stdout}`;
  }
}