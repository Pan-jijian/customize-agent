// @customize-agent/tools — 平台抽象类型定义

export type Platform = 'win32' | 'darwin' | 'linux';

/** Shell 检测结果 */
export interface ShellConfig {
  /** Shell 可执行文件路径或名称（如 'powershell.exe'、'/bin/zsh'） */
  shell: string;
  /** Shell 类型标识 */
  type: 'pwsh' | 'powershell' | 'sh' | 'bash' | 'zsh';
  /** Unix 命令是否需要在执行前翻译 */
  needsTranslation: boolean;
  /** 传给 Shell 的额外参数（如 PowerShell 的 ['-NoProfile', '-Command']） */
  shellArgs: string[];
  /** 命令分隔符（cmd/pwsh 用 &&，Unix 用 ;） */
  cmdSep: string;
  /** 当前平台的路径分隔符（Unix :，Windows ;） */
  pathSep: string;
}

/** 通过 Shell 抽象执行命令的结果 */
export interface ShellResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** 最小化进程引用，用于跨平台进程终止 */
export interface ProcessReference {
  pid?: number;
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  kill?: Function;
}
