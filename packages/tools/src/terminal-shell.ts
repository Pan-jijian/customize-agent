import { SandboxExecutor, type SandboxMode } from './sandbox-executor.js';

/** 终端工具 — 命令执行入口，内部委托 SandboxExecutor 做内核级隔离 */
export class TerminalTool {
  private sandbox: SandboxExecutor;

  constructor(cwd: string, mode: SandboxMode = 'vfs-guard') {
    this.sandbox = new SandboxExecutor(mode, cwd);
  }

  /**
   * 安全执行终端命令。
   * @param approved 用户已审批 → VFS-Guard 不拦截
   */
  async executeCommand(command: string, approved?: boolean, signal?: AbortSignal): Promise<{ stdout: string; stderr: string; code: number }> {
    return this.sandbox.execute(command, undefined, approved, signal);
  }
}
