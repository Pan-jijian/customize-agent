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
    console.error(`Missing Next build asset: ${path.relative(root, item)}`);
    process.exit(1);
  }
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
