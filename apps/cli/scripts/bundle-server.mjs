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

const monorepoRoot = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..');

// Clean and copy standalone output
if (existsSync(destDir)) rmSync(destDir, { recursive: true });
mkdirSync(destDir, { recursive: true });
cpSync(standaloneDir, destDir, { recursive: true, dereference: true });

// 保留 workspace 包（纯 JS，跨平台），移到 packages/ 目录
const monorepoPackagesDir = resolve(monorepoRoot, 'packages');
const destPackagesDir = resolve(destDir, 'packages');
if (existsSync(destPackagesDir)) rmSync(destPackagesDir, { recursive: true, force: true });
mkdirSync(destPackagesDir, { recursive: true });
for (const pkgName of ['knowledge', 'llm', 'runtime', 'types']) {
  const src = resolve(monorepoPackagesDir, pkgName);
  if (!existsSync(src)) continue;
  cpSync(src, resolve(destPackagesDir, pkgName), { recursive: true, dereference: true });
  console.log(`[bundle-server] Packaged @customize-agent/${pkgName}`);
}

// 删除第三方 node_modules — 不捆绑平台相关原生模块
// postinstall 时由 setup.js 通过 npm install 安装平台正确的依赖
const destNodeModules = resolve(destDir, 'node_modules');
if (existsSync(destNodeModules)) rmSync(destNodeModules, { recursive: true, force: true });

// 生成 dist/server/package.json（所有运行时依赖清单）
function generateServerPackageJson(destDir) {
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

// 清除所有子 package.json 中的 workspace:* 协议
// npm 安装时会扫描 tarball 中所有 package.json，遇到 workspace:* 报 EUNSUPPORTEDPROTOCOL
{
  const workspaceVersionMap = {};
  for (const entry of readdirSync(monorepoPackagesDir)) {
    const pkgJson = resolve(monorepoPackagesDir, entry, 'package.json');
    if (!existsSync(pkgJson)) continue;
    try {
      const pkg = JSON.parse(readFileSync(pkgJson, 'utf-8'));
      if (pkg.name && pkg.version) workspaceVersionMap[pkg.name] = pkg.version;
    } catch {}
  }

  function sanitizeDir(dir) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '.pnpm') continue;
      const full = resolve(dir, entry);
      try {
        const stat = lstatSync(full);
        if (stat.isDirectory()) {
          sanitizeDir(full);
        } else if (entry === 'package.json') {
          sanitizeFile(full);
        }
      } catch {}
    }
  }

  function sanitizeFile(filePath) {
    try {
      const pkg = JSON.parse(readFileSync(filePath, 'utf-8'));
      let modified = false;
      for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
        const deps = pkg[field];
        if (!deps) continue;
        for (const [name, version] of Object.entries(deps)) {
          if (typeof version === 'string' && version.startsWith('workspace:')) {
            const actualVersion = workspaceVersionMap[name];
            if (actualVersion) {
              deps[name] = '^' + actualVersion;
            } else {
              delete deps[name];
            }
            modified = true;
          }
        }
        // 清理空对象
        if (modified && Object.keys(deps).length === 0) delete pkg[field];
      }
      if (modified) {
        writeFileSync(filePath, JSON.stringify(pkg, null, 2) + '\n');
        const relPath = filePath.replace(destDir, '');
        console.log('[bundle-server] Sanitized workspace:* in dist/server' + relPath);
      }
    } catch {}
  }

  sanitizeDir(destDir);
}

// 生成 setup.js — postinstall 执行，安装依赖并链接 workspace 包
const setupJs = `
const { execSync } = require('child_process');
const { existsSync, mkdirSync, cpSync, rmSync, readdirSync, lstatSync } = require('fs');
const { resolve } = require('path');

const serverDir = __dirname;
const packagesDir = resolve(serverDir, 'packages');
const scopeDir = resolve(serverDir, 'node_modules', '@customize-agent');

console.log('[customize-agent] Installing server dependencies...');
try {
  execSync('npm install --omit=dev --no-audit --no-fund --legacy-peer-deps', { cwd: serverDir, stdio: 'inherit' });
} catch (e) {
  console.error('[customize-agent] Server dependency installation failed:', e.message);
  process.exit(1);
}

// 链接 workspace 包到 node_modules/@customize-agent/
console.log('[customize-agent] Linking workspace packages...');
if (existsSync(scopeDir)) rmSync(scopeDir, { recursive: true, force: true });
mkdirSync(scopeDir, { recursive: true });
for (const pkgName of readdirSync(packagesDir)) {
  const src = resolve(packagesDir, pkgName);
  if (!lstatSync(src).isDirectory()) continue;
  const dest = resolve(scopeDir, pkgName);
  cpSync(src, dest, { recursive: true, dereference: true });
  console.log('[customize-agent]   Linked @customize-agent/' + pkgName);
}
console.log('[customize-agent] Server setup complete.');
`;
writeFileSync(resolve(destDir, 'setup.js'), setupJs);
console.log('[bundle-server] Generated setup.js');

// 复制静态文件和 public 目录
const bundledServerDir = resolve(destDir, 'apps', 'server');
if (existsSync(staticDir)) {
  mkdirSync(resolve(bundledServerDir, '.next'), { recursive: true });
  cpSync(staticDir, resolve(bundledServerDir, '.next', 'static'), { recursive: true, dereference: true });
}
if (existsSync(publicDir)) {
  cpSync(publicDir, resolve(bundledServerDir, 'public'), { recursive: true, dereference: true });
}

// Patch server.js: 替换 process.chdir(__dirname) 为 chdir 到项目根目录
// 避免 Windows 上 server 进程锁定 dist/server/apps/server/ 导致 EBUSY
const serverEntryPath = resolve(bundledServerDir, 'server.js');
if (existsSync(serverEntryPath)) {
  let content = readFileSync(serverEntryPath, 'utf-8');
  // 移除 process.chdir(__dirname) — 由 spawn 的 cwd 控制工作目录
  content = content.replace(
    /process\.chdir\(__dirname\)[;]?/g,
    '// process.chdir removed by bundle-server to prevent Windows file locking'
  );
  writeFileSync(serverEntryPath, content);
  console.log('[bundle-server] Patched server.js (removed process.chdir for Windows EBUSY fix)');
}

// Marker 文件供 findDashboardServerDir 检测
writeFileSync(resolve(destDir, '.dashboard-bundled'), '');

console.log('[bundle-server] Server bundled into dist/server/ (deps installed via postinstall)');
