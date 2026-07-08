// @customize-agent/tools — Shell 抽象层
//
// 检测各平台最佳可用 Shell，提供统一的命令执行接口。
// Windows 上支持 PowerShell/pwsh。

import { reportNonFatalError } from '@customize-agent/types';
import { execa } from 'execa';
import { isWindows, isMacOS } from './utils.js';
import type { ShellConfig, ShellResult } from './types.js';

// ── Shell 检测 ────────────────────────────────────────────────────────────────

/** 检测当前平台的最佳可用 Shell */
export async function detectShell(): Promise<ShellConfig> {
  if (isMacOS()) {
    // macOS：先试 zsh（Catalina 起默认），回退到 bash
    const zsh = await tryShell('/bin/zsh', ['-c']);
    if (zsh) return zsh;
    return { shell: '/bin/bash', type: 'bash', needsTranslation: false, shellArgs: ['-c'], cmdSep: ';', pathSep: ':' };
  }

  if (isWindows()) {
    const pwsh = await tryShell('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command']);
    if (pwsh) return pwsh;

    const ps = await tryShell('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command']);
    if (ps) return ps;

    throw new Error('PowerShell is required on Windows. Please install PowerShell 7 or enable Windows PowerShell.');
  }

  // Linux：bash → sh 回退
  const bash = await tryShell('/bin/bash', ['-c']);
  if (bash) return bash;
  return { shell: '/bin/sh', type: 'sh', needsTranslation: false, shellArgs: ['-c'], cmdSep: ';', pathSep: ':' };
}

async function tryShell(binary: string, args: string[]): Promise<ShellConfig | null> {
  try {
    const result = await execa(binary, [...args, 'echo __SHELL_OK__'], {
      reject: false,
      timeout: 5_000,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (result.exitCode === 0 && result.stdout.includes('__SHELL_OK__')) {
      const type = binary.includes('pwsh') ? 'pwsh' :
                   binary.includes('powershell') ? 'powershell' :
                   binary.includes('zsh') ? 'zsh' :
                   binary.includes('bash') ? 'bash' : 'sh';
      const needsTranslation = isWindows() && (type === 'powershell' || type === 'pwsh');
      const cmdSep = type === 'powershell' || type === 'pwsh' ? '&&' : ';';
      const pathSep = isWindows() ? ';' : ':';
      return { shell: binary, type, needsTranslation, shellArgs: args, cmdSep, pathSep };
    }
  } catch (err) {
    reportNonFatalError({ source: 'shell.detect', error: err, details: { binary } });
  }
  return null;
}

// ── 命令翻译 ───────────────────────────────────────────────────────────────────

/**
 * 将常见 Unix 风格命令和参数翻译为 PowerShell 等效命令。
 */
export function translateForPowerShell(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) return trimmed;

  if (trimmed.includes('&&')) {
    return trimmed
      .split('&&')
      .map(part => translateForPowerShell(part.trim()))
      .join('; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; ');
  }

  const spaceIdx = trimmed.search(/\s/);
  const cmdName = (spaceIdx > 0 ? trimmed.slice(0, spaceIdx) : trimmed).toLowerCase();
  const args = spaceIdx > 0 ? trimmed.slice(spaceIdx + 1).trim() : '';

  switch (cmdName) {
    case 'ls':
      if (!args) return 'Get-ChildItem';
      if (/^-[a-zA-Z]*[al][a-zA-Z]*\s*$/u.test(args) || /^-[a-zA-Z]*[al][a-zA-Z]*\s+/u.test(args)) {
        return `Get-ChildItem -Force ${args.replace(/^-[a-zA-Z]+\s*/u, '')}`.trim();
      }
      return `Get-ChildItem ${args}`;
    case 'rm':
      if (/^-r?f?\s+/u.test(args) || /^-f?r?\s+/u.test(args)) {
        return `Remove-Item -Recurse -Force ${args.replace(/^-\w+\s*/u, '')}`;
      }
      return `Remove-Item ${args}`;
    case 'cp':
      if (/^-[rR]\s+/u.test(args)) return `Copy-Item -Recurse -Force ${args.replace(/^-[rR]\s+/u, '')}`;
      return `Copy-Item ${args}`;
    case 'mv':
      return `Move-Item ${args}`;
    case 'mkdir':
      if (args.startsWith('-p ')) return `New-Item -ItemType Directory -Force ${args.slice(3)}`;
      return `New-Item -ItemType Directory ${args}`;
    case 'kill':
      if (args.startsWith('-9 ')) return `Stop-Process -Force -Id ${args.slice(3)}`;
      return `Stop-Process -Id ${args}`;
    case 'grep':
      return `Select-String ${args}`;
    case 'head':
      if (args.startsWith('-n ')) {
        const rest = args.slice(3).trim();
        const space = rest.search(/\s/);
        const n = space > 0 ? rest.slice(0, space) : rest;
        const file = space > 0 ? rest.slice(space + 1) : '';
        return file ? `Get-Content ${file} -TotalCount ${n}` : `Get-Content ${rest} -TotalCount 10`;
      }
      return `Get-Content ${args} -TotalCount 10`;
    case 'tail':
      if (args.startsWith('-n ')) {
        const rest = args.slice(3).trim();
        const space = rest.search(/\s/);
        const n = space > 0 ? rest.slice(0, space) : rest;
        const file = space > 0 ? rest.slice(space + 1) : '';
        return file ? `Get-Content ${file} -Tail ${n}` : `Get-Content ${rest} -Tail 10`;
      }
      return `Get-Content ${args} -Tail 10`;
    case 'wc':
      if (args.startsWith('-l ')) return `(Get-Content ${args.slice(3)}).Count`;
      return `Get-Content ${args} | Measure-Object -Line -Word -Character`;
    case 'which':
      return `Get-Command ${args}`;
    case 'killall':
      return `Stop-Process -Name ${args}`;
    case 'sed':
      return `Write-Error 'sed is not available in PowerShell. Use: (Get-Content file) -replace pattern,replacement'`;
    case 'awk':
      return `Write-Error 'awk is not available in PowerShell. Use PowerShell pipelines such as Get-Content file | ForEach-Object { ... }'`;
    case 'export':
      if (args.includes('=')) {
        const eq = args.indexOf('=');
        return `$env:${args.slice(0, eq)} = '${args.slice(eq + 1)}'`;
      }
      return `$env:${args}`;
    case 'unset':
      return `Remove-Item Env:${args}`;
    case 'source':
      return `. ${args}`;
    case 'chmod':
      return `Write-Host 'chmod is not applicable on Windows (use icacls for ACL management)'`;
    case 'chown':
      return `Write-Host 'chown is not applicable on Windows'`;
    case 'touch':
      return `New-Item -ItemType File -Force ${args}`;
    case 'nohup':
      return `Start-Process -NoNewWindow ${args}`;
    default:
      return trimmed;
  }
}

// ── Shell 抽象 ────────────────────────────────────────────────────────────────

let _cachedShellConfig: ShellConfig | null = null;

/** 获取已检测的 Shell 配置（首次调用后缓存） */
export async function getShellConfig(): Promise<ShellConfig> {
  if (!_cachedShellConfig) {
    _cachedShellConfig = await detectShell();
  }
  return _cachedShellConfig;
}

/** 重置缓存的 Shell 配置（用于测试） */
export function resetShellConfig(): void {
  _cachedShellConfig = null;
}

/**
 * 将命令翻译为当前 Shell 环境的格式。
 * 无需翻译时直接返回原命令。
 */
export async function translateCommand(command: string): Promise<string> {
  const config = await getShellConfig();
  if (!config.needsTranslation) return command;

  if (config.type === 'powershell' || config.type === 'pwsh') {
    return translateForPowerShell(command);
  }

  return command;
}

/**
 * 使用平台适配的 Shell 执行命令。
 * 在 Windows 上自动翻译 Unix 命令。
 */
export async function executeCommand(
  command: string,
  options?: {
    cwd?: string;
    signal?: AbortSignal;
    timeout?: number;
    env?: Record<string, string>;
  },
): Promise<ShellResult> {
  const config = await getShellConfig();
  const translatedCmd = await translateCommand(command);

  try {
    // execa 不接受分开的 `shell` + `shellArgs` 选项。
    // 必须将 shell 作为可执行文件传递，参数作为第一个参数。
    const result = await execa(config.shell, [...config.shellArgs, translatedCmd], {
      cwd: options?.cwd,
      reject: false,
      timeout: options?.timeout ?? 120_000,
      cancelSignal: options?.signal,
      env: options?.env,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });

    return {
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      code: result.exitCode ?? 0,
    };
  } catch (err) {
    if (options?.signal?.aborted || (err as Error).name === 'AbortError') {
      throw err;
    }
    return {
      stdout: '',
      stderr: (err as Error).message,
      code: 1,
    };
  }
}

/**
 * 使用默认平台 Shell 生成后台进程。
 * 返回子进程供调用方管理。
 */
export async function spawnBackground(
  command: string,
  options?: {
    cwd?: string;
  },
): Promise<ReturnType<typeof execa>> {
  const config = await getShellConfig();
  const translatedCmd = await translateCommand(command);
  return execa(config.shell, [...config.shellArgs, translatedCmd], {
    cwd: options?.cwd,
    reject: false,
    stdout: 'pipe',
    stderr: 'pipe',
  });
}
