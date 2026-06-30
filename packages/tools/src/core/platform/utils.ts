// @customize-agent/tools — Platform utility functions (zero-dependency)

import * as os from 'os';
import * as path from 'path';
import type { Platform } from './types.js';

/** Current platform identifier */
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

/** Get home directory, respecting USERPROFILE on Windows */
export function getHomeDir(): string {
  return os.homedir();
}

/** Get temp directory, respecting TEMP/TMP on Windows */
export function getTempDir(): string {
  return os.tmpdir();
}

/**
 * Normalize path separators to the current platform.
 * On Windows, converts forward slashes to backslashes.
 * On Unix, converts backslashes to forward slashes.
 */
export function normalizePath(input: string): string {
  if (isWindows()) {
    return input.replace(/\//g, path.sep);
  }
  return input.replace(/\\/g, path.sep);
}

/**
 * Check if a path is absolute, accounting for Windows drive letters.
 */
export function isAbsolutePath(input: string): boolean {
  if (isWindows()) {
    return /^[a-zA-Z]:[/\\]/.test(input) || input.startsWith('\\\\');
  }
  return input.startsWith('/');
}

/**
 * Resolve a command name to include the appropriate extension on Windows.
 * e.g. 'npx' → 'npx.cmd', 'python' → 'python.exe' if needed.
 */
export function resolveWindowsCommand(command: string): string {
  if (!isWindows()) return command;
  // Commands that already have an extension
  if (/\.(exe|cmd|bat|ps1)$/i.test(command)) return command;
  // Node-based CLIs are typically .cmd files
  const nodeCmds = new Set(['npx', 'tsc', 'tsx', 'pnpm', 'npm', 'yarn']);
  if (nodeCmds.has(command)) return command + '.cmd';
  return command;
}

/** Get the platform-appropriate null device path */
export function nullDevice(): string {
  return isWindows() ? 'NUL' : '/dev/null';
}

/**
 * Escape a string for safe use in a shell command.
 * Different shells have different escaping rules — this provides a conservative base.
 */
export function shellEscape(arg: string): string {
  // Wrap in double quotes, escape internal double quotes
  const escaped = arg.replace(/"/g, '""');
  return `"${escaped}"`;
}

/** Generate the env sep command for current platform (e.g. '&&' vs ';') */
export function commandSeparator(): string {
  return isWindows() ? '&&' : ';';
}
