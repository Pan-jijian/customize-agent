// @customize-agent/tools — 共享路径工具

import * as path from 'path';

const IS_WINDOWS = process.platform === 'win32';

/**
 * 路径安全解析：确保目标路径在工作区根目录内，防止路径遍历攻击。
 * 返回绝对路径，若路径逃逸则抛出异常。
 *
 * Windows 注意事项：
 *   - NTFS 大小写不敏感 → 比较时统一转小写
 *   - 驱动器号边界 → 规范化后再比较前缀
 *   - UNC 路径 → resolve 后已自动处理
 */
export function resolveSafe(relativePath: string, root: string): string {
  const absolute = path.resolve(root, relativePath);
  const normalizedRoot = path.normalize(root) + path.sep;
  const normalizedAbsolute = path.normalize(absolute);

  // Windows: case-insensitive comparison
  const rootCompare = IS_WINDOWS ? normalizedRoot.toLowerCase() : normalizedRoot;
  const absCompare = IS_WINDOWS ? normalizedAbsolute.toLowerCase() : normalizedAbsolute;

  // Must either be exactly the root, or start with root + separator
  // Using normalize + sep ensures "C:\project" doesn't match "C:\project-other"
  if (!(absCompare === rootCompare.slice(0, -path.sep.length) || absCompare.startsWith(rootCompare))) {
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
    try {
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
    } catch {
      // 跳过无权限访问的目录（跨平台兼容：EPERM/EACCES，如 macOS ~/Library/Accounts）
      continue;
    }
  }
  return files;
}
