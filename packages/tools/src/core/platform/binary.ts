// @customize-agent/tools — 跨平台二进制解析
//
// Windows 上 Node.js CLI 通常安装为 .cmd 或 .exe 文件。
// 本模块将命令名解析为对应平台的可执行文件。

import { isWindows } from './utils.js';

/** 常见命令名 → Windows 扩展名映射 */
const KNOWN_WINDOWS_COMMANDS: Record<string, string> = {
  // Node.js / npm 生态系统（通常为 .cmd）
  'npx': 'npx.cmd',
  'tsc': 'tsc.cmd',
  'tsx': 'tsx.cmd',
  'pnpm': 'pnpm.cmd',
  'npm': 'npm.cmd',
  'yarn': 'yarn.cmd',
  'eslint': 'eslint.cmd',
  'prettier': 'prettier.cmd',

  // 可通过 npm 包安装的 LSP 服务端
  'typescript-language-server': 'typescript-language-server.cmd',
  'vscode-json-languageserver': 'vscode-json-languageserver.cmd',
  'bash-language-server': 'bash-language-server.cmd',
  'yaml-language-server': 'yaml-language-server.cmd',

  // 内置系统命令
  'node': 'node.exe',
};

/**
 * 将命令名解析为当前平台对应的可执行文件名。
 *
 * Windows：依次尝试 command.cmd → command.exe → command.bat → command
 * Unix：直接返回原命令名
 */
export function resolveBinary(command: string): string {
  if (!isWindows()) return command;

  // 已有扩展名，直接返回
  if (/\.(exe|cmd|bat|ps1|com)$/i.test(command)) return command;

  // 查询已知映射表
  const known = KNOWN_WINDOWS_COMMANDS[command];
  if (known) return known;

  // PowerShell 命令保持原样
  if (command === 'powershell' || command === 'powershell.exe' || command === 'pwsh') {
    return command;
  }

  return command;
}

/**
 * 将 LSP 服务端命令及其参数解析为当前平台适用的格式。
 *
 * Windows：
 *   - 为 npm 安装的命令添加 .cmd 后缀
 *   - 将参数中的 Unix 风格路径分隔符转为反斜杠
 * Unix：
 *   - 直接返回原样
 */
export function resolveLspCommand(
  command: string,
  args: string[],
): { command: string; args: string[] } {
  if (!isWindows()) return { command, args };

  // 解析命令名
  const resolvedCommand = resolveBinary(command);

  // 将参数中的 Unix 路径分隔符转为 Windows 反斜杠
  const resolvedArgs = args.map(arg => {
    // 如果参数看起来像含斜杠的路径，进行转换
    if (arg.includes('/') && !arg.startsWith('--') && !arg.startsWith('-')) {
      return arg.replace(/\//g, '\\');
    }
    return arg;
  });

  return { command: resolvedCommand, args: resolvedArgs };
}

/**
 * 使用平台适配参数解析命令。
 * resolveLspCommand 的快捷函数，适用于所有命令。
 */
export function resolveCommand(
  command: string,
  args: string[] = [],
): { command: string; args: string[] } {
  return resolveLspCommand(command, args);
}
