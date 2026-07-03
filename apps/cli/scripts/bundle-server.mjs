import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliDir = resolve(__dirname, '..');
const serverDir = resolve(cliDir, '..', 'server');
const standaloneDir = resolve(serverDir, '.next', 'standalone');
const staticDir = resolve(serverDir, '.next', 'static');
const publicDir = resolve(serverDir, 'public');
const destDir = resolve(cliDir, 'dist', 'server');

function materializeSymlinks(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) {
      const real = realpathSync(full);
      rmSync(full, { recursive: true, force: true });
      cpSync(real, full, { recursive: true, dereference: true });
      if (lstatSync(full).isDirectory()) materializeSymlinks(full);
      continue;
    }
    if (stat.isDirectory()) materializeSymlinks(full);
  }
}

function ensureVendorPackage(vendorDir, pkgName, rootPnpmDir) {
  const destDir = resolve(vendorDir, pkgName);
  if (existsSync(destDir)) return; // already present

  // Find in root .pnpm (fallback for packages not included by Next.js standalone)
  if (!existsSync(rootPnpmDir)) return;
  try {
    for (const entry of readdirSync(rootPnpmDir)) {
      if (!entry.startsWith(pkgName.replace('/', '+') + '@')) continue;
      const srcDir = resolve(rootPnpmDir, entry, 'node_modules', pkgName);
      if (existsSync(srcDir)) {
        cpSync(srcDir, destDir, { recursive: true, dereference: true });
        console.log('[bundle-server] Copied ' + pkgName + ' from root .pnpm');
        return;
      }
    }
  } catch {}
  console.log('[bundle-server] WARNING: ' + pkgName + ' not found in root .pnpm');
}

function fixPdfjsWorker(vendorDir) {
  const pnpmDir = resolve(vendorDir, '.pnpm');
  const destBuildDir = resolve(vendorDir, 'pdfjs-dist', 'legacy', 'build');
  const destFile = resolve(destBuildDir, 'pdf.worker.mjs');
  if (existsSync(destFile)) return;

  // Determine the expected version from vendor .pnpm (there should be exactly one)
  let targetVersion = '';
  if (existsSync(pnpmDir)) {
    for (const entry of readdirSync(pnpmDir)) {
      if (entry.startsWith('pdfjs-dist@')) { targetVersion = entry; break; }
    }
  }

  function tryCopyFrom(pnpmRoot) {
    if (!existsSync(pnpmRoot)) return false;
    try {
      // Prefer matching version, then any version
      const entries = readdirSync(pnpmRoot).filter(e => e.startsWith('pdfjs-dist@'));
      // Sort: matching version first, then newest version
      entries.sort((a, b) => {
        if (a === targetVersion) return -1;
        if (b === targetVersion) return 1;
        return b.localeCompare(a); // newest first
      });
      for (const entry of entries) {
        const srcFile = resolve(pnpmRoot, entry, 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.worker.mjs');
        if (existsSync(srcFile)) {
          mkdirSync(destBuildDir, { recursive: true });
          cpSync(srcFile, destFile);
          console.log('[bundle-server] Copied pdf.worker.mjs (' + entry + ')');
          return true;
        }
      }
    } catch {}
    return false;
  }

  // Search: vendor .pnpm → monorepo root .pnpm
  const monorepoRoot = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..');
  const candidates = [
    pnpmDir,  // vendor's own .pnpm
    resolve(monorepoRoot, 'node_modules', '.pnpm'),
  ];
  for (const root of candidates) {
    if (tryCopyFrom(root)) return;
  }
  console.log('[bundle-server] WARNING: pdf.worker.mjs not found, PDF extraction may use OCR fallback');
}

function materializePnpmEntrypoints(vendorDir) {
  const pnpmDir = resolve(vendorDir, '.pnpm');
  if (!existsSync(pnpmDir)) return;
  for (const storeEntry of readdirSync(pnpmDir)) {
    const nodeModulesDir = resolve(pnpmDir, storeEntry, 'node_modules');
    if (!existsSync(nodeModulesDir)) continue;
    for (const packageEntry of readdirSync(nodeModulesDir)) {
      const source = resolve(nodeModulesDir, packageEntry);
      if (!lstatSync(source).isDirectory()) continue;
      if (packageEntry.startsWith('@')) {
        const scopeDir = resolve(vendorDir, packageEntry);
        mkdirSync(scopeDir, { recursive: true });
        for (const scopedPackage of readdirSync(source)) {
          const scopedSource = resolve(source, scopedPackage);
          const scopedDest = resolve(scopeDir, scopedPackage);
          if (!existsSync(scopedDest) && lstatSync(scopedSource).isDirectory()) {
            cpSync(scopedSource, scopedDest, { recursive: true, dereference: true });
          }
        }
        continue;
      }
      const dest = resolve(vendorDir, packageEntry);
      if (!existsSync(dest)) cpSync(source, dest, { recursive: true, dereference: true });
    }
  }
}

if (!existsSync(standaloneDir)) {
  console.log('[bundle-server] Standalone output not found, skipping (server not built)');
  process.exit(0);
}

// Clean and copy
if (existsSync(destDir)) rmSync(destDir, { recursive: true });
mkdirSync(destDir, { recursive: true });
cpSync(standaloneDir, destDir, { recursive: true, dereference: true });

// 将 workspace packages/ 目录链接到 node_modules/@customize-agent/ scope
// Next.js standalone 将 workspace 包放在顶层 packages/ 而非 node_modules scope 下，
// 导致 require('@customize-agent/knowledge') 找不到包
function linkWorkspacePackages(destDir) {
  const packagesDir = resolve(destDir, 'packages');
  const scopeDir = resolve(destDir, 'node_modules', '@customize-agent');
  if (!existsSync(packagesDir)) return;
  mkdirSync(scopeDir, { recursive: true });
  for (const pkgName of readdirSync(packagesDir)) {
    const pkgDir = resolve(packagesDir, pkgName);
    if (!lstatSync(pkgDir).isDirectory()) continue;
    const destLink = resolve(scopeDir, pkgName);
    if (existsSync(destLink)) rmSync(destLink, { recursive: true, force: true });
    cpSync(pkgDir, destLink, { recursive: true, dereference: true });
    console.log(`[bundle-server] Linked @customize-agent/${pkgName}`);
  }
}
linkWorkspacePackages(destDir);
materializeSymlinks(resolve(destDir, 'node_modules'));

// 展开 pnpm store 到 node_modules（使 CJS 和 ESM 都能解析）
materializePnpmEntrypoints(resolve(destDir, 'node_modules'));

// 自动打包所有 workspace 包的外部依赖（包括 Next.js 静态分析遗漏的动态 import 依赖）
const monorepoRoot = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..');
const rootPnpm = resolve(monorepoRoot, 'node_modules', '.pnpm');

function ensureWorkspaceDeps(packageDir, nodeModulesDir, rootPnpm) {
  const pkgJsonPath = resolve(packageDir, 'package.json');
  if (!existsSync(pkgJsonPath)) return;
  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
  const deps = Object.keys(pkg.dependencies ?? {});
  for (const dep of deps) {
    if (dep.startsWith('@customize-agent/')) continue;
    ensureVendorPackage(nodeModulesDir, dep, rootPnpm);
  }
}

const packagesDir = resolve(monorepoRoot, 'packages');
const nodeModulesDir = resolve(destDir, 'node_modules');
ensureWorkspaceDeps(resolve(packagesDir, 'knowledge'), nodeModulesDir, rootPnpm);
ensureWorkspaceDeps(resolve(packagesDir, 'search'), nodeModulesDir, rootPnpm);
ensureWorkspaceDeps(resolve(packagesDir, 'tools'), nodeModulesDir, rootPnpm);
ensureVendorPackage(nodeModulesDir, 'chromadb', rootPnpm);

// 修复 pdfjs-dist 的 worker 文件
fixPdfjsWorker(nodeModulesDir);

// 生成 dist/server/package.json，供 postinstall 的 npm rebuild 使用
// 收集 server + workspace 包的所有外部依赖
function generateServerPackageJson(destDir) {
  const serverPkg = JSON.parse(readFileSync(resolve(serverDir, 'package.json'), 'utf-8'));
  const allDeps = {};
  const pkgFiles = [
    resolve(serverDir, 'package.json'),
    resolve(monorepoRoot, 'packages', 'knowledge', 'package.json'),
    resolve(monorepoRoot, 'packages', 'search', 'package.json'),
    resolve(monorepoRoot, 'packages', 'tools', 'package.json'),
    resolve(monorepoRoot, 'packages', 'llm', 'package.json'),
    resolve(monorepoRoot, 'packages', 'engine', 'package.json'),
    resolve(monorepoRoot, 'packages', 'runtime', 'package.json'),
  ];
  for (const pkgFile of pkgFiles) {
    if (!existsSync(pkgFile)) continue;
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf-8'));
    for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
      if (name.startsWith('@customize-agent/')) continue;
      if (!allDeps[name]) allDeps[name] = version;
    }
  }
  const serverPackageJson = {
    name: 'customize-agent-server',
    private: true,
    description: 'Bundled server runtime for customize-agent',
    dependencies: allDeps,
  };
  writeFileSync(resolve(destDir, 'package.json'), JSON.stringify(serverPackageJson, null, 2));
  console.log(`[bundle-server] Generated server package.json with ${Object.keys(allDeps).length} dependencies`);
}
generateServerPackageJson(destDir);

// 不再删除 node_modules！保留它让 Node.js 原生 CJS+ESM 解析器都能找到依赖。
// 之前的 vendor+monkey-patch 方案只对 CJS require() 有效，ESM import 失败。
// node_modules 位于 dist/server/node_modules/，server.js (cwd=apps/server/)
// 的 Node.js 向上查找 ../../node_modules/ 即可自然解析。
// 跨平台: postinstall 执行 npm rebuild 会自动为目标平台重新编译原生模块。
const bundledServerDir = resolve(destDir, 'apps', 'server');
if (existsSync(staticDir)) {
  mkdirSync(resolve(bundledServerDir, '.next'), { recursive: true });
  cpSync(staticDir, resolve(bundledServerDir, '.next', 'static'), { recursive: true, dereference: true });
}
if (existsSync(publicDir)) {
  cpSync(publicDir, resolve(bundledServerDir, 'public'), { recursive: true, dereference: true });
}

// Create marker file for findDashboardServerDir detection
writeFileSync(resolve(destDir, '.dashboard-bundled'), '');

console.log('[bundle-server] Server bundled into dist/server/');
