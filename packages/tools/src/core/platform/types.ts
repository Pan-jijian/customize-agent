// @customize-agent/tools — Platform abstraction types

export type Platform = 'win32' | 'darwin' | 'linux';

/** Shell detection result */
export interface ShellConfig {
  /** Shell executable path or name (e.g. 'powershell.exe', '/bin/zsh') */
  shell: string;
  /** Shell type identifier */
  type: 'pwsh' | 'powershell' | 'cmd' | 'sh' | 'bash' | 'zsh';
  /** Whether Unix commands need translation before execution */
  needsTranslation: boolean;
  /** Additional args to pass to the shell (e.g. ['-NoProfile', '-Command'] for PowerShell) */
  shellArgs: string[];
  /** Command separator (&& on cmd/pwsh, ; on Unix) */
  cmdSep: string;
  /** Path separator for this platform (: on Unix, ; on Windows) */
  pathSep: string;
}

/** Result of executing a command through the shell abstraction */
export interface ShellResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Minimal process reference for cross-platform kill */
export interface ProcessReference {
  pid?: number;
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  kill?: Function;
}
