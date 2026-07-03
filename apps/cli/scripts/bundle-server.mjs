import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliDir = resolve(__dirname, '..');
const serverDir = resolve(cliDir, '..', 'server');
const standaloneDir = resolve(serverDir, '.next', 'standalone');
const staticDir = resolve(serverDir, '.next', 'static');
const publicDir = resolve(serverDir, 'public');

// Bundle server files to dist/server-bundle/ (NOT dist/server/)
// postinstall copies them to ~/.customize-agent/server/ outside the npm package dir
// This prevents Windows EBUSY: npm upgrades never touch the running server's directory
const destDir = resolve(cliDir, 'dist', 'server-bundle');

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
  if (existsSync(destDir)) return;
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

  let targetVersion = '';
  if (existsSync(pnpmDir)) {
    for (const entry of readdirSync(pnpmDir)) {
      if (entry.startsWith('pdfjs-dist@')) { targetVersion = entry; break; }
    }
  }

  function tryCopyFrom(pnpmRoot) {
    if (!existsSync(pnpmRoot)) return false;
    try {
      const entries = readdirSync(pnpmRoot).filter(e => e.startsWith('pdfjs-dist@'));
      entries.sort((a, b) => {
        if (a === targetVersion) return -1;
        if (b === targetVersion) return 1;
        return b.localeCompare(a);
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

  const monorepoRoot = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..');
  const candidates = [pnpmDir, resolve(monorepoRoot, 'node_modules', '.pnpm')];
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

// Copy workspace packages (pure JS, cross-platform) to packages/
const monorepoPackagesDir = resolve(monorepoRoot, 'packages');
const destPackagesDir = resolve(destDir, 'packages');
if (existsSync(destPackagesDir)) rmSync(destPackagesDir, { recursive: true, force: true });
mkdirSync(destPackagesDir, { recursive: true });
for (const pkgName of ['knowledge', 'llm', 'runtime', 'types']) {
  const src = resolve(monorepoPackagesDir, pkgName);
  if (!existsSync(src)) continue;
  cpSync(src, resolve(destPackagesDir, pkgName), { recursive: true, dereference: true });
  console.log('[bundle-server] Packaged @customize-agent/' + pkgName);
}

// Keep Next standalone node_modules in the bundle so npm install does not need
// to run server setup scripts and the copied server can resolve page runtime deps.
// Next standalone does not always trace page-level UI dependencies, so copy the
// server package runtime deps into the bundle node_modules as well.
const bundleVendorModules = resolve(destDir, 'vendor_modules');
const rootNodeModules = resolve(serverDir, 'node_modules');
const serverPkg = JSON.parse(readFileSync(resolve(serverDir, 'package.json'), 'utf-8'));
for (const depName of Object.keys(serverPkg.dependencies ?? {})) {
  const src = resolve(rootNodeModules, depName);
  const dest = resolve(bundleVendorModules, depName);
  if (!existsSync(src) || existsSync(dest)) continue;
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest, { recursive: true, dereference: true });
  console.log('[bundle-server] Bundled web runtime dependency ' + depName);
}
ensureVendorPackage(bundleVendorModules, 'styled-jsx', resolve(monorepoRoot, 'node_modules', '.pnpm'));

// Generate package.json with all runtime dependencies
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
  console.log('[bundle-server] Generated server package.json with ' + Object.keys(allDeps).length + ' dependencies');
}
generateServerPackageJson(destDir);

// Sanitize workspace:* protocols in all bundled package.json files
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
        if (modified && Object.keys(deps).length === 0) delete pkg[field];
      }
      if (modified) {
        writeFileSync(filePath, JSON.stringify(pkg, null, 2) + '\n');
        console.log('[bundle-server] Sanitized workspace:* in ' + relative(destDir, filePath));
      }
    } catch {}
  }

  sanitizeDir(destDir);
}

// Generate setup.js for postinstall
// Copies server bundle to ~/.customize-agent/server/ (outside npm dir, prevents EBUSY)
// Then installs npm deps and links workspace packages
const setupJs = [
  'const { existsSync, mkdirSync, cpSync, rmSync, readdirSync, lstatSync, readFileSync } = require(\'fs\');',
  'const { resolve, join } = require(\'path\');',
  'const { homedir } = require(\'os\');',
  '',
  'const bundleDir = __dirname;',
  'const targetDir = join(homedir(), \'.customize-agent\', \'server\');',
  '',
  '// Only copy if server version (BUILD_ID) changed',
  'let needCopy = true;',
  'try {',
  '  const bundleBuildId = readFileSync(resolve(bundleDir, \'apps\', \'server\', \'.next\', \'BUILD_ID\'), \'utf8\').trim();',
  '  const targetBuildIdPath = resolve(targetDir, \'apps\', \'server\', \'.next\', \'BUILD_ID\');',
  '  if (existsSync(targetBuildIdPath)) {',
  '    const targetBuildId = readFileSync(targetBuildIdPath, \'utf8\').trim();',
  '    needCopy = (bundleBuildId !== targetBuildId);',
  '  }',
  '} catch {}',
  '',
  'if (needCopy) {',
  '  console.log(\'[customize-agent] Installing server to \' + targetDir + \'...\');',
  '  if (existsSync(targetDir)) rmSync(targetDir, { recursive: true, force: true });',
  '  mkdirSync(targetDir, { recursive: true });',
  '  cpSync(bundleDir, targetDir, { recursive: true, dereference: true });',
  '  console.log(\'[customize-agent] Server files copied.\');',
  '} else {',
  '  console.log(\'[customize-agent] Server already up to date.\');',
  '}',
  '',
  'const packagesDir = resolve(targetDir, \'packages\');',
  'const scopeDir = resolve(targetDir, \'node_modules\', \'@customize-agent\');',
  '',
  'console.log(\'[customize-agent] Linking workspace packages...\');',
  'if (existsSync(scopeDir)) rmSync(scopeDir, { recursive: true, force: true });',
  'mkdirSync(scopeDir, { recursive: true });',
  'for (const pkgName of readdirSync(packagesDir)) {',
  '  const src = resolve(packagesDir, pkgName);',
  '  if (!lstatSync(src).isDirectory()) continue;',
  '  const dest = resolve(scopeDir, pkgName);',
  '  cpSync(src, dest, { recursive: true, dereference: true });',
  '  console.log(\'[customize-agent]   Linked @customize-agent/\' + pkgName);',
  '}',
  'console.log(\'[customize-agent] Server setup complete. (\' + targetDir + \')\');',
].join('\n');

writeFileSync(resolve(destDir, 'setup.js'), setupJs);
console.log('[bundle-server] Generated setup.js (target: ~/.customize-agent/server/)');

// Copy static files and public dir
const bundledServerDir = resolve(destDir, 'apps', 'server');
if (existsSync(staticDir)) {
  mkdirSync(resolve(bundledServerDir, '.next'), { recursive: true });
  cpSync(staticDir, resolve(bundledServerDir, '.next', 'static'), { recursive: true, dereference: true });
}
if (existsSync(publicDir)) {
  cpSync(publicDir, resolve(bundledServerDir, 'public'), { recursive: true, dereference: true });
}

// Patch server.js: remove process.chdir(__dirname) to prevent file locking
const serverEntryPath = resolve(bundledServerDir, 'server.js');
if (existsSync(serverEntryPath)) {
  let content = readFileSync(serverEntryPath, 'utf-8');
  content = content.replace(
    /process\.chdir\(__dirname\)[;]?/g,
    '// process.chdir removed by bundle-server to prevent file locking'
  );
  writeFileSync(serverEntryPath, content);
  console.log('[bundle-server] Patched server.js (removed process.chdir)');
}

// Marker file for findDashboardServerDir detection
writeFileSync(resolve(destDir, '.dashboard-bundled'), '');

console.log('[bundle-server] Server bundle ready: dist/server-bundle/');
console.log('[bundle-server] first CLI run will install to ~/.customize-agent/server/');
