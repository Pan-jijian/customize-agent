// @customize-agent/tools — 共享常量

/** 跳过遍历的目录名 */
export const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', 'target', '.next', '.turbo', '.cache',
]);
