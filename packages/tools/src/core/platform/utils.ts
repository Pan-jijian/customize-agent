// @customize-agent/tools — 平台工具函数（零依赖）

import * as os from 'os';
import * as path from 'path';
import type { Platform } from './types.js';

/** 当前平台标识 */
export function platform(): Platform {
  return process.platform as Platform;
}

export function isWindows(): boolean {
  return process.platform === 'win32';
}

export function isMacOS(): boolean {
  return process.platform === 'darwin';
}

export function isLinux(): boolean {
  return process.platform === 'linux';
}

/** 获取家目录（Windows 上优先使用 USERPROFILE） */
export function getHomeDir(): string {
  return os.homedir();
}

/** 获取临时目录（Windows 上优先使用 TEMP/TMP） */
export function getTempDir(): string {
  return os.tmpdir();
}

/**
 * 将路径分隔符规范化为当前平台格式。
 * Windows：正斜杠转为反斜杠
 * Unix：反斜杠转为正斜杠
 */
export function normalizePath(input: string): string {
  if (isWindows()) {
    return input.replace(/\//g, path.sep);
  }
  return input.replace(/\\/g, path.sep);
}

/**
 * 检查路径是否为绝对路径（考虑 Windows 驱动器号）。
 */
export function isAbsolutePath(input: string): boolean {
  if (isWindows()) {
    return /^[a-zA-Z]:[/\\]/.test(input) || input.startsWith('\\\\');
  }
  return input.startsWith('/');
}

/**
 * 解析命令名，在 Windows 上包含合适的扩展名。
 * 例如：'npx' → 'npx.cmd'、'python' → 'python.exe'（如有需要）。
 */
export function resolveWindowsCommand(command: string): string {
  if (!isWindows()) return command;
  // 已有扩展名的命令直接返回
  if (/\.(exe|cmd|bat|ps1)$/i.test(command)) return command;
  // 基于 Node 的 CLI 通常为 .cmd 文件
  const nodeCmds = new Set(['npx', 'tsc', 'tsx', 'pnpm', 'npm', 'yarn']);
  if (nodeCmds.has(command)) return command + '.cmd';
  return command;
}

/** 获取当前平台的空设备路径 */
export function nullDevice(): string {
  return isWindows() ? 'NUL' : '/dev/null';
}

/**
 * 转义字符串以安全用于 shell 命令。
 * 不同的 Shell 有不同的转义规则 — 此函数提供保守的基准实现。
 */
export function shellEscape(arg: string): string {
  // 用双引号包裹，转义内部双引号
  const escaped = arg.replace(/"/g, '""');
  return `"${escaped}"`;
}

/** 生成当前平台的环境变量分隔命令（如 '&&' vs ';'） */
export function commandSeparator(): string {
  return isWindows() ? '&&' : ';';
}
