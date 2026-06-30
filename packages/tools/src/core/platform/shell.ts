// @customize-agent/tools — Shell abstraction layer
//
// Detects the best available shell on each platform and provides a unified
// command execution interface. Translates Unix commands to Windows equivalents
// when running in cmd.exe.

import { reportNonFatalError } from '@customize-agent/types';
import { execa, execaCommand } from 'execa';
import { isWindows, isMacOS } from './utils.js';
import type { ShellConfig, ShellResult } from './types.js';

// ── Shell Detection ──────────────────────────────────────────────────────────

/** Detect the best available shell on the current platform */
export async function detectShell(): Promise<ShellConfig> {
  if (isMacOS()) {
    // macOS: try zsh (default since Catalina), fallback to bash
    const zsh = await tryShell('/bin/zsh', ['-c']);
    if (zsh) return zsh;
    return { shell: '/bin/bash', type: 'bash', needsTranslation: false, shellArgs: ['-c'], cmdSep: ';', pathSep: ':' };
  }

  if (isWindows()) {
    // Windows: try PowerShell Core first, then PowerShell 5, then cmd
    const pwsh = await tryShell('pwsh', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command']);
    if (pwsh) return pwsh;

    const ps = await tryShell('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command']);
    if (ps) return ps;

    // cmd.exe — always available, needs translation
    return { shell: 'cmd.exe', type: 'cmd', needsTranslation: true, shellArgs: ['/c'], cmdSep: '&&', pathSep: ';' };
  }

  // Linux: bash → sh
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
                   binary.includes('cmd') ? 'cmd' :
                   binary.includes('zsh') ? 'zsh' :
                   binary.includes('bash') ? 'bash' : 'sh';
      const needsTranslation = type === 'cmd';
      const cmdSep = type === 'cmd' || type === 'powershell' || type === 'pwsh' ? '&&' : ';';
      const pathSep = isWindows() ? ';' : ':';
      return { shell: binary, type, needsTranslation, shellArgs: args, cmdSep, pathSep };
    }
  } catch (err) {
    reportNonFatalError({ source: 'shell.detect', error: err, details: { binary } });
  }
  return null;
}

// ── Command Translation ──────────────────────────────────────────────────────

/**
 * Translation maps for converting Unix-style commands to Windows cmd.exe equivalents.
 * Each key is a command prefix pattern, and the value is a function that returns
 * the translated command string (or null if untranslatable).
 */
type TranslatorFn = ((args: string) => string | null) | null;

const CMD_TRANSLATORS: Record<string, TranslatorFn> = {
  // File listing
  'ls': (args) => {
    if (!args || args === '-la' || args === '-l' || args === '-al') return 'dir /b';
    if (args.includes('-la') || args.includes('-al')) return `dir /b ${args.replace(/-[al]+/g, '').trim()}`;
    return `dir /b ${args}`.trim();
  },

  // File content display
  'cat': (args) => args ? `type ${args}` : 'more',
  'head': (args) => {
    const m = args.match(/^-n\s*(\d+)\s+(.+)/);
    if (m) return `powershell -Command "Get-Content ${m[2]} -TotalCount ${m[1]}"`;
    return `powershell -Command "Get-Content ${args} -TotalCount 10"`;
  },
  'tail': (args) => {
    const m = args.match(/^-n\s*(\d+)\s+(.+)/);
    if (m) return `powershell -Command "Get-Content ${m[2]} -Tail ${m[1]}"`;
    return `powershell -Command "Get-Content ${args} -Tail 10"`;
  },

  // Grep
  'grep': (args) => {
    // grep -r pattern dir/ → findstr /s pattern dir\*
    if (args.startsWith('-r ') || args.startsWith('-ri ')) {
      const rest = args.replace(/^-r[i]?\s+/, '');
      return `findstr /s ${rest}`;
    }
    // grep -i pattern file → findstr /i pattern file
    if (args.startsWith('-i ')) {
      return `findstr /i ${args.slice(3)}`;
    }
    return `findstr ${args}`;
  },
  'egrep': (args) => `findstr ${args}`,
  'findstr': null, // already native

  // File operations
  'rm': (args) => {
    if (args.startsWith('-rf ') || args.startsWith('-r ')) {
      return `rmdir /s /q ${args.replace(/^-r[f]?\s+/, '')}`;
    }
    if (args.startsWith('-f ')) {
      return `del /f /q ${args.slice(3)}`;
    }
    if (args.startsWith('-')) {
      return `del /f /q ${args.replace(/^-[a-zA-Z]+\s*/, '')}`;
    }
    return `del /f /q ${args}`;
  },
  'rmdir': null, // native with /s /q
  'mv': (args) => `move /y ${args}`,
  'cp': (args) => {
    if (args.startsWith('-r ') || args.startsWith('-R ')) {
      return `xcopy /e /i /y ${args.replace(/^-[rR]\s+/, '')}`;
    }
    return `copy /y ${args}`;
  },
  'mkdir': (args) => {
    const converted = args.replace(/\//g, '\\');
    if (converted.startsWith('-p ')) return `md ${converted.slice(3)}`;
    return `md ${converted}`;
  },
  'touch': (args) => {
    // touch file → type nul > file
    const files = args.split(/\s+/).filter(Boolean);
    if (files.length === 1) return `type nul > ${files[0]}`;
    return files.map(f => `type nul > ${f}`).join(' && ');
  },
  'chmod': () => 'echo chmod is not applicable on Windows (file permissions are managed via ACLs/icacls)',
  'chown': () => 'echo chown is not applicable on Windows',

  // System info
  'pwd': () => 'cd',
  'which': (args) => args ? `where ${args}` : 'where',
  'env': () => 'set',
  'printenv': (args) => args ? `echo %${args}%` : 'set',
  'uname': () => 'ver',
  'hostname': () => 'hostname',
  'whoami': () => 'whoami',

  // Process management
  'ps': () => 'tasklist',
  'kill': (args) => {
    if (args.startsWith('-9 ')) return `taskkill /F /PID ${args.slice(3)}`;
    return `taskkill /PID ${args}`;
  },
  'killall': (args) => `taskkill /F /IM ${args}.exe`,
  'nohup': (args) => `start /b ${args}`,

  // Network
  'curl': null, // Windows 10+ has curl.exe
  'wget': (args) => `curl -o NUL ${args}`,

  // Text processing
  'wc': (args) => {
    if (args.startsWith('-l ')) {
      return `find /c /v "" ${args.slice(3)}`;
    }
    // General wc is complex, delegate to PowerShell
    return `powershell -Command "Get-Content ${args} | Measure-Object -Line -Word -Character"`;
  },
  'sort': null, // native
  'uniq': (args) => `powershell -Command "Get-Content ${args} | Get-Unique"`,
  'diff': (args) => `fc ${args}`,
  'sed': () => null,
  'awk': () => null,
  'tr': () => null,
  'cut': () => null,

  // Shell builtins
  'echo': null, // native
  'export': (args) => {
    const eq = args.indexOf('=');
    if (eq > 0) return `set ${args.slice(0, eq)}=${args.slice(eq + 1)}`;
    return `set ${args}`;
  },
  'unset': (args) => `set ${args}=`,
  'source': (args) => `call ${args}`,
  '.': (args) => `call ${args}`,

  // Redirection helpers
  'clear': () => 'cls',
  'history': () => 'doskey /history',

  // Package managers
  'apt-get': () => null,
  'apt': () => null,
  'brew': () => null,
  'dnf': () => null,
  'yum': () => null,
  'pacman': () => null,
};

/**
 * Commands that PowerShell has built-in aliases for.
 * These don't need translation when running in PowerShell.
 */
const POWERSHELL_ALIASES = new Set([
  'ls', 'dir', 'cat', 'type', 'rm', 'del', 'rmdir', 'rd',
  'cp', 'copy', 'mv', 'move', 'pwd', 'cd', 'echo', 'sort',
  'mkdir', 'md', 'clear', 'cls', 'ps', 'kill', 'curl', 'wget',
  'diff', 'compare', 'sleep', 'history', 'pushd', 'popd', 'tee',
  'write', 'select', 'where', 'foreach', 'group', 'measure',
  'gc', 'sc', 'fl', 'ft', 'gal', 'gcm', 'gm', 'gp', 'gpv',
]);

/**
 * Translate a Unix-style command for execution in cmd.exe.
 * Returns the translated command, or null if untranslatable.
 */
export function translateForCmd(command: string): string | null {
  const trimmed = command.trim();
  if (!trimmed) return null;

  // Extract command name (first word)
  const spaceIdx = trimmed.search(/\s/);
  const cmdName = (spaceIdx > 0 ? trimmed.slice(0, spaceIdx) : trimmed).toLowerCase();
  const args = spaceIdx > 0 ? trimmed.slice(spaceIdx + 1).trim() : '';

  // Check for piped commands — translate each segment
  if (trimmed.includes('|')) {
    const segments = trimmed.split('|').map(s => s.trim());
    const translated = segments.map(s => translateForCmd(s) ?? s);
    return translated.join(' | ');
  }

  // Check for command chaining (&& or ;)
  if (trimmed.includes('&&') || trimmed.includes(';')) {
    const sep = trimmed.includes('&&') ? '&&' : ';';
    const segments = trimmed.split(sep).map(s => s.trim());
    const translated = segments.map(s => translateForCmd(s) ?? s);
    return translated.join(' && ');
  }

  const translator = CMD_TRANSLATORS[cmdName];
  if (translator === undefined) {
    // Unknown command — pass through as-is (may be a Windows native command)
    return trimmed;
  }
  if (translator === null) {
    // Known command that's natively available on Windows cmd.exe
    return trimmed;
  }
  const result = translator(args);
  return result;
}

/**
 * Translate a Unix-style command for execution in PowerShell.
 * Most common commands have PS aliases and work directly.
 */
export function translateForPowerShell(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) return trimmed;

  const spaceIdx = trimmed.search(/\s/);
  const cmdName = (spaceIdx > 0 ? trimmed.slice(0, spaceIdx) : trimmed).toLowerCase();
  const args = spaceIdx > 0 ? trimmed.slice(spaceIdx + 1).trim() : '';

  // Commands with PS aliases — no translation needed
  if (POWERSHELL_ALIASES.has(cmdName)) return trimmed;

  // Specific translations for commands without PS aliases
  switch (cmdName) {
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
    case 'kill':
      return `Stop-Process -Id ${args}`;
    case 'killall':
      return `Stop-Process -Name ${args}`;
    case 'sed':
      return `# sed ${args} — use PowerShell: (Get-Content file) -replace 'pattern','replacement'`;
    case 'awk':
      return `# awk ${args} — use PowerShell: Get-Content file | ForEach-Object { $_.Split() }`;
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

// ── Shell Abstraction ────────────────────────────────────────────────────────

let _cachedShellConfig: ShellConfig | null = null;

/** Get the detected shell config (cached after first call) */
export async function getShellConfig(): Promise<ShellConfig> {
  if (!_cachedShellConfig) {
    _cachedShellConfig = await detectShell();
  }
  return _cachedShellConfig;
}

/** Reset cached shell config (useful for testing) */
export function resetShellConfig(): void {
  _cachedShellConfig = null;
}

/**
 * Translate a command for the current shell environment.
 * Returns the command as-is if no translation is needed.
 */
export async function translateCommand(command: string): Promise<string> {
  const config = await getShellConfig();
  if (!config.needsTranslation) return command;

  if (config.type === 'cmd') {
    const translated = translateForCmd(command);
    if (translated === null) {
      // Command cannot be translated — return an echo that explains the situation
      const cmdName = command.split(/\s/)[0] ?? command;
      return `echo Command "${cmdName}" is not available on Windows cmd.exe. Consider using PowerShell or a Node.js alternative.`;
    }
    return translated;
  }

  if (config.type === 'powershell' || config.type === 'pwsh') {
    return translateForPowerShell(command);
  }

  return command;
}

/**
 * Execute a command with the platform-appropriate shell.
 * Automatically translates Unix commands on Windows.
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
  const translatedCmd = config.needsTranslation
    ? (translateForCmd(command) ?? command)
    : command;

  try {
    // execa does NOT accept separate `shell` + `shellArgs` options.
    // We must pass the shell as the executable and args as first arguments.
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
 * Spawn a background process with the default platform shell.
 * Note: Does NOT auto-translate commands — caller should use translateCommand() first.
 * Returns the child process for the caller to manage.
 */
export function spawnBackground(
  command: string,
  options?: {
    cwd?: string;
  },
): ReturnType<typeof execaCommand> {
  return execaCommand(command, {
    cwd: options?.cwd,
    shell: true,
    reject: false,
    stdout: 'pipe',
    stderr: 'pipe',
  });
}
