/**
 * 内置工具二进制路径。
 * 所有二进制通过 npm 包随包分发（pnpm install 时自动拉对应平台版本），零运行时下载。
 *
 * 参考：
 *   - Claude Code  →  @vscode/ripgrep + vendor 目录
 *   - Codex CLI     →  codex-resources/rg
 */
import { rgPath } from '@vscode/ripgrep';
import fdFind from 'fd-find';

export const binaries = {
  rg: rgPath,
  fd: fdFind,
} as const;
