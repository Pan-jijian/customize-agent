const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const nextDir = path.join(root, '.next');
const required = [
  path.join(nextDir, 'BUILD_ID'),
  path.join(nextDir, 'build-manifest.json'),
  path.join(nextDir, 'routes-manifest.json'),
  path.join(nextDir, 'server'),
  path.join(nextDir, 'static'),
];

for (const item of required) {
  if (!fs.existsSync(item)) {
    console.error(`[server] Missing Next build artifact: ${path.relative(root, item)}`);
    console.error('[server] Run `pnpm build` in apps/server before `pnpm start`.');
    process.exit(1);
  }
}

for (const runtimePath of [
  path.join(nextDir, 'server', 'webpack-api-runtime.js'),
  path.join(nextDir, 'server', 'webpack-runtime.js'),
]) {
  if (fs.existsSync(runtimePath)) {
    const runtime = fs.readFileSync(runtimePath, 'utf8');
    const patched = runtime.replace(/\.\/chunks\/vendor-chunks\//gu, './vendor-chunks/');
    if (patched !== runtime) fs.writeFileSync(runtimePath, patched);
  }
}

function staticAssetExists(file) {
  const absolute = path.join(nextDir, file);
  if (fs.existsSync(absolute)) return true;
  const parsed = path.parse(absolute);
  if (!fs.existsSync(parsed.dir)) return false;
  return fs.readdirSync(parsed.dir).some(name => name === parsed.base || (name.startsWith(`${parsed.name}-`) && name.endsWith(parsed.ext)));
}

const manifest = JSON.parse(fs.readFileSync(path.join(nextDir, 'build-manifest.json'), 'utf8'));
const files = new Set();
for (const value of Object.values(manifest.pages || {})) {
  if (Array.isArray(value)) for (const file of value) if (file.startsWith('static/')) files.add(file);
}
for (const file of files) {
  if (!staticAssetExists(file)) {
    console.error(`Missing static chunk referenced by build-manifest: .next/${file}`);
    process.exit(1);
  }
}

const pagesManifestPath = path.join(nextDir, 'server', 'pages-manifest.json');
if (!fs.existsSync(pagesManifestPath)) {
  console.error('[server] Missing Next pages manifest: .next/server/pages-manifest.json');
  console.error('[server] Run `pnpm build` in apps/server before `pnpm start`.');
  process.exit(1);
}
const pagesManifest = JSON.parse(fs.readFileSync(pagesManifestPath, 'utf8'));
const requiredRoutes = ['/', '/overview', '/documents', '/knowledge/files', '/prompt', '/models', '/settings'];
const missingRoutes = requiredRoutes.filter(route => !pagesManifest[route]);
if (missingRoutes.length > 0) {
  console.error(`[server] Invalid Next pages manifest, missing routes: ${missingRoutes.join(', ')}`);
  console.error('[server] The packaged build may have been polluted by a development server. Run `pnpm build` before publishing or reinstall the latest @customize-agent/server.');
  process.exit(1);
}
for (const polluted of [
  path.join(nextDir, 'static', 'development'),
  path.join(nextDir, 'static', 'webpack'),
]) {
  if (fs.existsSync(polluted)) {
    console.error(`[server] Invalid production build artifact: ${path.relative(root, polluted)} should not be packaged.`);
    console.error('[server] Run `pnpm build` to regenerate isolated production artifacts.');
    process.exit(1);
  }
}
for (const [route, file] of Object.entries(pagesManifest)) {
  const pagePath = path.join(nextDir, 'server', file);
  const htmlFallbackPath = pagePath.replace(/\.js$/u, '.html');
  if (!fs.existsSync(pagePath) && !fs.existsSync(htmlFallbackPath)) {
    console.error(`Missing page artifact for ${route}: .next/server/${file}`);
    process.exit(1);
  }
}
console.log(`Next static assets verified: ${files.size} chunks, ${Object.keys(pagesManifest).length} pages`);
