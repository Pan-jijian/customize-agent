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

const vendorDir = resolve(destDir, 'vendor');
rmSync(vendorDir, { recursive: true, force: true });
cpSync(resolve(destDir, 'node_modules'), vendorDir, { recursive: true, dereference: true });
materializePnpmEntrypoints(vendorDir);
fixPdfjsWorker(vendorDir);

// Ensure OCR/Canvas packages (only dynamically imported, excluded by Next.js standalone)
const monorepoRoot = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..');
const rootPnpm = resolve(monorepoRoot, 'node_modules', '.pnpm');
ensureVendorPackage(vendorDir, 'tesseract.js', rootPnpm);
ensureVendorPackage(vendorDir, '@napi-rs/canvas', rootPnpm);

rmSync(resolve(destDir, 'node_modules'), { recursive: true, force: true });

const bundledServerDir = resolve(destDir, 'apps', 'server');
const serverEntry = resolve(bundledServerDir, 'server.js');
if (existsSync(serverEntry)) {
  const content = readFileSync(serverEntry, 'utf-8');
  writeFileSync(serverEntry, `const __caPath = require('path')\nconst __caModule = require('module')\nconst __caVendorNodePath = __caPath.join(__dirname, '..', '..', 'vendor')\nconst __caResolveFilename = __caModule._resolveFilename
__caModule._resolveFilename = function(request, parent, isMain, options) {
  if (!request.startsWith('.') && !__caPath.isAbsolute(request)) {
    try { return __caResolveFilename.call(this, __caPath.join(__caVendorNodePath, request), parent, isMain, options) } catch {}
  }
  return __caResolveFilename.call(this, request, parent, isMain, options)
}
${content}`);
}
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
