import { execa } from 'execa';
import * as path from 'path';
import * as fs from 'fs/promises';
import { reportNonFatalError } from '@customize-agent/types';
import { executeCommand } from '../core/platform/shell.js';
import { isWindows } from '../core/platform/utils.js';

/** 沙箱模式 */
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access' | 'vfs-guard' | 'docker';

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
      } catch (err) {
        reportNonFatalError({ source: 'sandbox.preflight_bwrap', error: err });
      }
      console.warn('[Sandbox] Bubblewrap unavailable or unprivileged user namespaces not enabled, falling back to VFS-Guard mode');
      console.warn('[Sandbox] Security policy: CWD binding + command intent scanning');
      return 'vfs-guard' as SandboxMode;
    }
    if (process.platform === 'darwin') {
      try {
        const result = await execa({ reject: false, timeout: 10_000 })`/usr/bin/sandbox-exec -h`;
        if (result.exitCode === 0 || result.stderr.includes('usage')) {
          return 'workspace-write';
        }
      } catch (err) {
        reportNonFatalError({ source: 'sandbox.preflight_seatbelt', error: err });
      }
      console.warn('[Sandbox] sandbox-exec unavailable, falling back to VFS-Guard mode');
      return 'vfs-guard' as SandboxMode;
    }
    console.warn('[Sandbox] Kernel-level sandbox unavailable on current platform, falling back to VFS-Guard mode');
    return 'vfs-guard' as SandboxMode;
  }

  /**
   * 执行命令（自动选择对应平台的沙箱实现，vfs-guard 作为通用降级方案）。
   * @param approved 用户已在上层审批通过 → VFS-Guard 跳过危险命令拦截
   */
  async execute(command: string, cwd?: string, approved?: boolean, signal?: AbortSignal): Promise<SandboxResult> {
    if (this.mode === 'danger-full-access') {
      throw new Error('danger-full-access mode requires explicit confirmation. Set CUSTOMIZE_AGENT_DANGER_MODE=1');
    }
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (this.mode === 'docker') {
      return this._executeDocker(command, cwd, signal);
    }
    if (this.mode === 'vfs-guard') {
      return this._executeVfsGuard(command, cwd, approved, signal);
    }
    if (process.platform === 'darwin') {
      return this._executeSeatbelt(command, cwd, signal);
    }
    if (process.platform === 'linux') {
      return this._executeBwrap(command, cwd, signal);
    }
    return this._executeVfsGuard(command, cwd, approved, signal);
  }

  /**
   * 将宿主机路径转换为 Docker 兼容路径。
   * Windows 上，C:\Users\me\project → /c/Users/me/project（Docker Desktop 规则）
   */
  private _dockerPath(hostPath: string): string {
    if (!isWindows()) return hostPath;
    // C:\Users\me\project → /c/Users/me/project（Docker Desktop 规则）
    const normalized = hostPath.replace(/\\/g, '/');
    const driveMatch = normalized.match(/^([a-zA-Z]):(.+)/);
    if (driveMatch) {
      return `/${driveMatch[1]!.toLowerCase()}${driveMatch[2]}`;
    }
    return normalized;
  }

  /** Docker 容器执行（不可用时自动降级 VFS） */
  private async _executeDocker(command: string, cwd?: string, signal?: AbortSignal): Promise<SandboxResult> {
    try {
      await execa({ reject: false, cancelSignal: signal })`docker version`;
    } catch (err) {
      if (signal?.aborted || (err as Error).name === 'AbortError') throw err;
      console.warn('[Sandbox] Docker 不可用，降级为 VFS-Guard');
      return this._executeVfsGuard(command, cwd, undefined, signal);
    }
    const workspace = cwd ?? this.workspaceRoot;
    const dockerWorkspace = this._dockerPath(workspace);
    try {
      const result = await execa({
        cwd: workspace,
        reject: false,
        timeout: 60_000,
        cancelSignal: signal,
      })`docker run --rm -i --network=none --memory=1g --cpus=2 -v ${dockerWorkspace}:/workspace -w /workspace python:3.11-slim sh -c ${command}`;
      return {
        stdout: result.stdout.slice(0, 10_000),
        stderr: result.stderr,
        code: result.exitCode ?? 0,
      };
    } catch (err) {
      if (signal?.aborted || (err as Error).name === 'AbortError') throw err;
      return { stdout: '', stderr: (err as Error).message, code: 1 };
    }
  }

  /** VFS-Guard：路径虚拟沙箱 — CWD 强绑定 + 危险命令拦截 + read-only 模式写拦截 */
  private async _executeVfsGuard(command: string, cwd?: string, approved?: boolean, signal?: AbortSignal): Promise<SandboxResult> {
    const safeCwd = cwd ?? this.workspaceRoot;

    // 危险命令扫描（已审批通过的命令跳过拦截，直接执行）
    if (!approved && this.mode !== 'read-only') {
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
    }

    // read-only 模式：写操作拦截
    if (!approved && this.mode === 'read-only') {
      const writePatterns = [
        { pattern: /\brm\s+-/, reason: 'read-only 模式禁止删除文件' },
        { pattern: /\bmv\s+/, reason: 'read-only 模式禁止移动/重命名文件' },
        { pattern: /\bgit\s+(commit|push|add|tag)\b/, reason: 'read-only 模式禁止 Git 写操作' },
        { pattern: /\bnpm\s+(install|uninstall|publish|link)\b/, reason: 'read-only 模式禁止 npm 写操作' },
        { pattern: /\bpnpm\s+(install|add|publish|link)\b/, reason: 'read-only 模式禁止 pnpm 写操作' },
        { pattern: />\s*\S/, reason: 'read-only 模式禁止输出重定向' },
        { pattern: /\bmkdir\b/, reason: 'read-only 模式禁止创建目录' },
        { pattern: /\btouch\b/, reason: 'read-only 模式禁止修改文件时间戳' },
      ];
      for (const { pattern, reason } of writePatterns) {
        if (pattern.test(command)) {
          return { stdout: '', stderr: `命令被拦截 (vfs-guard): ${reason}`, code: 1 };
        }
      }
    }

    try {
      const result = await executeCommand(command, {
        cwd: safeCwd,
        signal,
        timeout: 120_000,
      });
      return { stdout: result.stdout, stderr: result.stderr, code: result.code };
    } catch (err) {
      if (signal?.aborted || (err as Error).name === 'AbortError') throw err;
      return { stdout: '', stderr: (err as Error).message, code: 1 };
    }
  }

  /** macOS Seatbelt sandbox-exec 实现 — 通过 stdin 传命令避免 shell 注入 */
  private async _executeSeatbelt(command: string, cwd?: string, signal?: AbortSignal): Promise<SandboxResult> {
    const profilePath = path.join(this.workspaceRoot, '.agent-sandbox.sb');
    const profile = this._buildSeatbeltProfile();
    await fs.writeFile(profilePath, profile);
    try {
      const result = await execa({
        cwd: cwd ?? this.workspaceRoot,
        reject: false,
        timeout: 120_000,
        cancelSignal: signal,
        input: command,  // 通过 stdin 传入命令，避免 shell 元字符注入
      })`/usr/bin/sandbox-exec -f ${profilePath} sh`;
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        code: result.exitCode ?? 1,
      };
    } finally {
      await fs.unlink(profilePath).catch(err => {
        reportNonFatalError({
          source: 'sandbox_executor.unlink_profile',
          error: err,
          details: { profilePath },
        });
      });
    }
  }

  /** 构建 macOS Seatbelt 沙箱策略文件 */
  private _buildSeatbeltProfile(): string {
    const root = path.resolve(this.workspaceRoot);
    // 对齐 Claude Code / Codex CLI：写限制 + 读放开。OS 内核级 enforce，非静默拦截
    let profile = `(version 1)
    ;; ── 默认：读全部放开，进程/网络正常 ──
    (allow file-read*)
    (allow process-exec)
    (allow process-fork)
    (allow signal)
    (allow sysctl-read)
    (allow network*)
    `;

    if (this.mode === 'workspace-write') {
      profile += `
    ;; ── 写限制：仅工作目录和临时目录 ──
    (allow file-write* (subpath "${root}"))
    (allow file-write* (subpath "/tmp"))
    (allow file-write* (subpath "/private/tmp"))
    ;; 敏感文件拒绝写入（内核级 enforce → EPERM → 模型感知并报告）
    (deny file-write* (regex #"\\.env$"))
    (deny file-write* (regex #"\\.key$"))
    (deny file-write* (regex #"secret"))
    `;
    } else {
      profile += `(deny file-write*)\n`;
    }

    return profile;
  }

  /** Linux Bubblewrap 实现 — 内核级 namespace 隔离 */
  private async _executeBwrap(command: string, cwd?: string, signal?: AbortSignal): Promise<SandboxResult> {
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
      cancelSignal: signal,
    })`bwrap ${bwrapArgs}`;
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      code: result.exitCode ?? 1,
    };
  }
}
