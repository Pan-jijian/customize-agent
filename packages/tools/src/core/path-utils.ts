// @customize-agent/tools — 共享路径工具

import * as path from 'path';

/**
 * 路径安全解析：确保目标路径在工作区根目录内，防止路径遍历攻击。
 * 返回绝对路径，若路径逃逸则抛出异常。
 */
export function resolveSafe(relativePath: string, root: string): string {
  const absolute = path.resolve(root, relativePath);
  const sep = path.sep;
  if (!(absolute.startsWith(root + sep) || absolute === root)) {
    throw new Error(`Path traversal detected: "${relativePath}" escapes workspace "${root}"`);
  }
  return absolute;
}

/** 递归遍历目录树，跳过 SKIP_DIRS 中的目录和以点开头的文件 */
export async function walk(
  dir: string,
  skipDirs: Set<string>,
): Promise<string[]> {
  const fs = await import('fs/promises');
  const path = await import('path');
  const files: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) stack.push(fullPath);
      } else {
        files.push(fullPath);
      }
    }
  }
  return files;
}
