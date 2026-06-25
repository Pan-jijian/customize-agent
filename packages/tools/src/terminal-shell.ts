import { SandboxExecutor, type SandboxMode } from './sandbox-executor.js';

/** 终端工具 — 命令执行入口，内部委托 SandboxExecutor 做内核级隔离 */
export class TerminalTool {
  private sandbox: SandboxExecutor;

  constructor(cwd: string, mode: SandboxMode = 'workspace-write') {
    this.sandbox = new SandboxExecutor(mode, cwd);
  }

  /**
   * 安全执行终端命令。
   * 返回值包含 stdout、stderr 与退出码，由 Agent 自行判断成败。
   */
  async executeCommand(command: string): Promise<{ stdout: string; stderr: string; code: number }> {
    return this.sandbox.execute(command);
  }
}
