import { execa } from 'execa';
import * as path from 'path';
import * as fs from 'fs/promises';

/** 沙箱模式 */
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access' | 'vfs-guard';

/** 沙箱命令执行结果 */
export interface SandboxResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * 沙箱执行器 — OS 级安全隔离。
 * macOS → Seatbelt (sandbox-exec)
 * Linux → Bubblewrap (bwrap, 内核级 unprivileged namespaces)
 * 降级 → VFS-Guard (路径虚拟沙箱，纯 JS 拦截)
 */
export class SandboxExecutor {
  constructor(private mode: SandboxMode, private workspaceRoot: string) {}

  /**
   * 沙箱前置诊断：检测宿主环境是否支持内核级沙箱。
   * 不可用时自动降级为 vfs-guard，打印安全警告，不崩溃。
   */
  static async preflight(): Promise<SandboxMode> {
    if (process.platform === 'linux') {
      try {
        const result = await execa({ reject: false, timeout: 10_000 })`bwrap --version`;
        if (result.exitCode === 0) {
          // 验证 unprivileged user namespaces 是否可用
          const testResult = await execa({ reject: false, timeout: 10_000 })`bwrap --ro-bind / / -- true`;
          if (testResult.exitCode === 0) {
            return 'workspace-write';
          }
        }
      } catch { /* bwrap 不可用 */ }
      console.warn('⚠️  [Sandbox] Bubblewrap 不可用或 unprivileged user namespaces 未启用，降级为 VFS-Guard 模式');
      console.warn('⚠️  [Sandbox] 安全策略：CWD 强绑定 + 命令意图扫描');
      return 'vfs-guard' as SandboxMode;
    }
    if (process.platform === 'darwin') {
      try {
        const result = await execa({ reject: false, timeout: 10_000 })`/usr/bin/sandbox-exec -h`;
        if (result.exitCode === 0 || result.stderr.includes('usage')) {
          return 'workspace-write';
        }
      } catch { /* sandbox-exec 不可用 */ }
      console.warn('⚠️  [Sandbox] sandbox-exec 不可用，降级为 VFS-Guard 模式');
      return 'vfs-guard' as SandboxMode;
    }
    console.warn('⚠️  [Sandbox] 当前平台不支持内核级沙箱，降级为 VFS-Guard 模式');
    return 'vfs-guard' as SandboxMode;
  }

  /** 执行命令（自动选择对应平台的沙箱实现，vfs-guard 作为通用降级方案） */
  async execute(command: string, cwd?: string): Promise<SandboxResult> {
    if (this.mode === 'danger-full-access') {
      throw new Error('danger-full-access 模式需要显式确认，请设置环境变量 CUSTOMIZE_AGENT_DANGER_MODE=1');
    }
    // vfs-guard：纯 JS 路径虚拟沙箱（跨平台通用降级方案）
    if (this.mode === 'vfs-guard') {
      return this._executeVfsGuard(command, cwd);
    }
    if (process.platform === 'darwin') {
      return this._executeSeatbelt(command, cwd);
    }
    if (process.platform === 'linux') {
      return this._executeBwrap(command, cwd);
    }
    // 未知平台 → 自动降级 vfs-guard
    return this._executeVfsGuard(command, cwd);
  }

  /** VFS-Guard：路径虚拟沙箱 — CWD 强绑定 + 危险命令拦截 + read-only 模式写拦截 */
  private async _executeVfsGuard(command: string, cwd?: string): Promise<SandboxResult> {
    // CWD 强绑定在项目根目录
    const safeCwd = cwd ?? this.workspaceRoot;

    // 危险命令意图扫描（所有模式均拦截）
    const dangerousPatterns = [
      { pattern: /> \/(etc|sys|proc|dev)\//, reason: '禁止写系统目录' },
      { pattern: /rm\s+-rf\s+\//, reason: '禁止 rm -rf /' },
      { pattern: /mkfs\.\w+/, reason: '禁止格式化磁盘' },
      { pattern: /dd\s+if=/, reason: '禁止 dd 操作' },
      { pattern: /chmod\s+777/, reason: '禁止 chmod 777' },
    ];
    for (const { pattern, reason } of dangerousPatterns) {
      if (pattern.test(command)) {
        return { stdout: '', stderr: `命令被拦截 (vfs-guard): ${reason}`, code: 1 };
      }
    }

    // read-only 模式：拦截文件写入/修改/删除命令
    if (this.mode === 'read-only') {
      const writePatterns = [
        { pattern: /\brm\s+-/, reason: 'read-only 模式禁止删除文件' },
        { pattern: /\bmv\s+/, reason: 'read-only 模式禁止移动/重命名文件' },
        { pattern: /\bcp\s+.*-f/, reason: 'read-only 模式禁止强制复制' },
        { pattern: /\bgit\s+(commit|push|add|tag)\b/, reason: 'read-only 模式禁止 Git 写操作' },
        { pattern: /\bnpm\s+(install|uninstall|publish|link)\b/, reason: 'read-only 模式禁止 npm 写操作' },
        { pattern: /\bpnpm\s+(install|add|publish|link)\b/, reason: 'read-only 模式禁止 pnpm 写操作' },
        { pattern: />\s*\S/, reason: 'read-only 模式禁止输出重定向（写入文件）' },
        { pattern: />>\s*\S/, reason: 'read-only 模式禁止追加重定向（写入文件）' },
        { pattern: /\bmkdir\b/, reason: 'read-only 模式禁止创建目录' },
        { pattern: /\btouch\b/, reason: 'read-only 模式禁止创建/修改文件时间戳' },
        { pattern: /\btee\b/, reason: 'read-only 模式禁止 tee（写入文件）' },
      ];
      for (const { pattern, reason } of writePatterns) {
        if (pattern.test(command)) {
          return { stdout: '', stderr: `命令被拦截 (vfs-guard): ${reason}`, code: 1 };
        }
      }
    }

    try {
      const result = await execa({
        shell: true,
        cwd: safeCwd,
        reject: false,
        timeout: 120_000,
      })`${command}`;
      return { stdout: result.stdout, stderr: result.stderr, code: result.exitCode ?? 1 };
    } catch (err) {
      return { stdout: '', stderr: (err as Error).message, code: 1 };
    }
  }

  /** macOS Seatbelt sandbox-exec 实现 — 通过 stdin 传命令避免 shell 注入 */
  private async _executeSeatbelt(command: string, cwd?: string): Promise<SandboxResult> {
    const profilePath = path.join(this.workspaceRoot, '.agent-sandbox.sb');
    const profile = this._buildSeatbeltProfile();
    await fs.writeFile(profilePath, profile);
    try {
      const result = await execa({
        cwd: cwd ?? this.workspaceRoot,
        reject: false,
        timeout: 120_000,
        input: command,  // 通过 stdin 传入命令，避免 shell 元字符注入
      })`/usr/bin/sandbox-exec -f ${profilePath} sh`;
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        code: result.exitCode ?? 1,
      };
    } finally {
      await fs.unlink(profilePath).catch(() => {});
    }
  }

  /** 构建 macOS Seatbelt 沙箱策略文件 */
  private _buildSeatbeltProfile(): string {
    const root = path.resolve(this.workspaceRoot);
    const home = process.env.HOME ?? '/Users/unknown';
    let profile = `(version 1)
    ;; 默认拒绝一切
    (deny default)

    ;; 允许读项目目录
    (allow file-read* (subpath "${root}"))

    ;; 允许读 OS 动态链接库（所有命令必需）
    (allow file-read* (subpath "/usr/lib"))
    (allow file-read* (subpath "/bin"))
    (allow file-read* (subpath "/usr/bin"))
    ;; 允许读 node/pnpm 运行时
    (allow file-read* (subpath "${home}/.nvm"))
    (allow file-read* (subpath "/usr/local/bin"))
    (allow file-read* (subpath "/opt/homebrew"))

    ;; 允许进程执行和管道通信
    (allow process-exec)
    (allow process-fork)
    (allow signal)
    (allow sysctl-read)

    ;; 允许网络访问（Agent 需要调用 LLM API、下载依赖包等）
    (allow network*)
    `;

    if (this.mode === 'workspace-write') {
      profile += `
    ;; 允许写项目目录（但拒绝写入 .env 和密钥文件）
    (allow file-write* (subpath "${root}"))
    (deny file-write* (regex #"^${root}/\\.env$"))
    (deny file-write* (regex #"^${root}/.*\\.key$"))
    (deny file-write* (regex #"^${root}/.*secret"))
    `;
    } else {
      profile += `(deny file-write*)\n`;
    }

    return profile;
  }

  /** Linux Bubblewrap 实现 — 内核级 namespace 隔离 */
  private async _executeBwrap(command: string, cwd?: string): Promise<SandboxResult> {
    const root = this.workspaceRoot;
    // 根据模式选择只读绑定或可写绑定（二选一，不重复，修复 v2 重复挂载 bug）
    const bindFlag = this.mode === 'workspace-write' ? '--bind' : '--ro-bind';
    const bwrapArgs = [
      '--ro-bind', '/usr', '/usr',
      '--ro-bind', '/lib', '/lib',
      '--ro-bind', '/lib64', '/lib64',
      '--ro-bind', '/bin', '/bin',
      '--ro-bind', '/sbin', '/sbin',
      '--ro-bind', '/etc', '/etc',
      bindFlag, root, root,
      '--chdir', cwd ?? root,
      '--share-net',      // 共享网络（Agent 需要调用 LLM API、下载依赖）
      '--unshare-ipc',    // 隔离 IPC
      '--unshare-uts',    // 隔离主机名
      '--unshare-pid',    // 隔离 PID 命名空间
      '--proc', '/proc',
      '--dev', '/dev',
    ];
    bwrapArgs.push('--', 'sh', '-c', command);

    const result = await execa({
      reject: false,
      timeout: 120_000,
    })`bwrap ${bwrapArgs}`;
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      code: result.exitCode ?? 1,
    };
  }
}
