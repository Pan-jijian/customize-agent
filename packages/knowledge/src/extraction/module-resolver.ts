/**
 * 模块解析工具。
 *
 * Next.js standalone / 打包 Server 中，ESM 动态 import(绝对路径) 被自定义
 * loader 拦截后可能失败。但 CJS require() 走 Module._resolveFilename
 * monkey-patch，能正确找到 pnpm store 和 vendor 目录中的包。
 *
 * 此模块统一使用 CJS require 加载依赖，确保在所有上下文中可靠工作。
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** 从 knowledge 包自身目录解析的 CJS require 函数 */
const localRequire = createRequire(import.meta.url);

/** knowledge 包所在的实际目录 */
const knowledgeDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * 在 .pnpm 目录中查找包的实际路径（处理 standalone 缺少顶层 symlink 的情况）。
 */
function findInPnpm(packageName: string): string | null {
  let dir = knowledgeDir;
  for (let i = 0; i < 10; i++) {
    const nodeModules = path.join(dir, 'node_modules');
    const pnpmDir = path.join(nodeModules, '.pnpm');
    if (fs.existsSync(pnpmDir)) {
      const pkgParts = packageName.split('/');
      const flatName = pkgParts.length > 1
        ? `${pkgParts[0]}+${pkgParts.slice(1).join('/')}`
        : packageName;
      try {
        for (const entry of fs.readdirSync(pnpmDir)) {
          if (entry.startsWith(flatName + '@')) {
            const pkgDir = path.join(pnpmDir, entry, 'node_modules', packageName);
            if (fs.existsSync(pkgDir)) return pkgDir;
          }
        }
      } catch { /* continue upward */ }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * 使用 CJS require 解析 npm 包为绝对路径。
 * 多层回退：CJS require.resolve → .pnpm 遍历。
 */
export function resolvePackage(specifier: string): string {
  try {
    return localRequire.resolve(specifier);
  } catch { /* fall through */ }

  const parts = specifier.split('/');
  let packageName: string;
  if (parts[0]?.startsWith('@')) {
    packageName = `${parts[0]}/${parts[1]}`;
  } else {
    packageName = parts[0] ?? specifier;
  }

  const pnpmRoot = findInPnpm(packageName);
  if (pnpmRoot) {
    const subPath = packageName === specifier ? '' : specifier.slice(packageName.length + 1);
    const fullPath = subPath ? path.join(pnpmRoot, subPath) : pnpmRoot;
    if (fs.existsSync(fullPath)) return fullPath;
  }

  throw new Error(`Cannot resolve package: ${specifier}`);
}

/**
 * 解析并加载一个 npm 包。
 * 使用 CJS require() 而非 ESM import()，确保在 Next.js standalone /
 * 打包 Server 上下文中也能正确加载（CJS 走 Module._resolveFilename
 * monkey-patch，不受 ESM 自定义 loader 影响）。
 */
export async function resolveAndImport<T = unknown>(specifier: string): Promise<T> {
  const resolvedPath = resolvePackage(specifier);
  // CJS require 能穿透 pnpm store 和 Next.js bundle，兼容性最好
  try {
    return localRequire(resolvedPath) as T;
  } catch {
    // 某些包可能是纯 ESM（如 pdfjs-dist v5），回退到 import()
    return import(resolvedPath) as Promise<T>;
  }
}

/**
 * 获取 node_modules 根目录路径（包含 .pnpm 的那个）。
 * 用于设置子进程 NODE_PATH，确保 OCR 等子进程能解析依赖。
 */
export function getNodeModulesRoot(): string | null {
  let dir = path.dirname(knowledgeDir);
  for (let i = 0; i < 10; i++) {
    // 开发环境: node_modules/.pnpm
    const nm = path.join(dir, 'node_modules');
    if (fs.existsSync(path.join(nm, '.pnpm'))) return nm;
    // 打包环境: vendor/.pnpm（bundle-server 把 node_modules 改名 vendor）
    const vendor = path.join(dir, 'vendor');
    if (fs.existsSync(path.join(vendor, '.pnpm'))) return vendor;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
