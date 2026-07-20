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

const apiRuntime = path.join(nextDir, 'server', 'webpack-api-runtime.js');
if (fs.existsSync(apiRuntime)) {
  const runtime = fs.readFileSync(apiRuntime, 'utf8');
  const patched = runtime.replace(/\.\/chunks\/vendor-chunks\//gu, './vendor-chunks/');
  if (patched !== runtime) fs.writeFileSync(apiRuntime, patched);
}

const manifest = JSON.parse(fs.readFileSync(path.join(nextDir, 'build-manifest.json'), 'utf8'));
const files = new Set();
for (const value of Object.values(manifest.pages || {})) {
  if (Array.isArray(value)) for (const file of value) if (file.startsWith('static/')) files.add(file);
}
for (const file of files) {
  if (!fs.existsSync(path.join(nextDir, file))) {
    console.error(`Missing static chunk referenced by build-manifest: .next/${file}`);
    process.exit(1);
  }
}

console.log(`Next static assets verified: ${files.size} chunks`);
