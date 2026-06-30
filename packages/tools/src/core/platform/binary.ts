// @customize-agent/tools — Cross-platform binary resolution
//
// On Windows, Node.js CLIs are typically installed as .cmd or .exe files.
// This module resolves command names to their platform-appropriate executable.

import { isWindows } from './utils.js';

/** Common command name → Windows extension mapping */
const KNOWN_WINDOWS_COMMANDS: Record<string, string> = {
  // Node.js / npm ecosystem (typically .cmd)
  'npx': 'npx.cmd',
  'tsc': 'tsc.cmd',
  'tsx': 'tsx.cmd',
  'pnpm': 'pnpm.cmd',
  'npm': 'npm.cmd',
  'yarn': 'yarn.cmd',
  'eslint': 'eslint.cmd',
  'prettier': 'prettier.cmd',

  // LSP servers available as npm packages
  'typescript-language-server': 'typescript-language-server.cmd',
  'vscode-json-languageserver': 'vscode-json-languageserver.cmd',
  'bash-language-server': 'bash-language-server.cmd',
  'yaml-language-server': 'yaml-language-server.cmd',

  // Built-in commands
  'node': 'node.exe',
};

/**
 * Resolve a command name to the platform-appropriate executable name.
 *
 * On Windows, tries: command.cmd → command.exe → command.bat → command
 * On Unix, returns the command as-is.
 */
export function resolveBinary(command: string): string {
  if (!isWindows()) return command;

  // Already has an extension
  if (/\.(exe|cmd|bat|ps1|com)$/i.test(command)) return command;

  // Check known mappings
  const known = KNOWN_WINDOWS_COMMANDS[command];
  if (known) return known;

  // For PowerShell commands, return as-is
  if (command === 'powershell' || command === 'pwsh' || command === 'cmd') {
    return command;
  }

  // Default: try .cmd first (most common for Node.js CLIs), then .exe
  return command;
}

/**
 * Resolve an LSP server command and its arguments for the current platform.
 *
 * On Windows:
 *   - Adds .cmd suffix to npm-based commands
 *   - Converts Unix-style path separators in args to backslashes
 * On Unix:
 *   - Returns as-is
 */
export function resolveLspCommand(
  command: string,
  args: string[],
): { command: string; args: string[] } {
  if (!isWindows()) return { command, args };

  // Resolve the command name
  const resolvedCommand = resolveBinary(command);

  // Convert Unix-style paths in args to Windows separators
  const resolvedArgs = args.map(arg => {
    // If arg looks like a path with forward slashes, convert
    if (arg.includes('/') && !arg.startsWith('--') && !arg.startsWith('-')) {
      return arg.replace(/\//g, '\\');
    }
    return arg;
  });

  return { command: resolvedCommand, args: resolvedArgs };
}

/**
 * Resolve a command with platform-appropriate arguments.
 * Shorthand for resolveLspCommand; works for any command.
 */
export function resolveCommand(
  command: string,
  args: string[] = [],
): { command: string; args: string[] } {
  return resolveLspCommand(command, args);
}
