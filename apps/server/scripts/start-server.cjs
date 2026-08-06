#!/usr/bin/env node
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const serverRoot = path.resolve(__dirname, '..');
const originalCwd = process.cwd();

function readOption(names, fallback) {
  for (let i = 0; i < process.argv.length; i += 1) {
    const arg = process.argv[i];
    const matched = names.find(name => arg === name || arg.startsWith(`${name}=`));
    if (!matched) continue;
    if (arg.includes('=')) return arg.slice(arg.indexOf('=') + 1);
    return process.argv[i + 1] || fallback;
  }
  return fallback;
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`Usage: customize-web [--port 17321] [--host 127.0.0.1] [--project /path/to/project]

Options:
  -p, --port       Web server port, default 17321
  -H, --host       Web server host, default 127.0.0.1
      --project    Project root managed by the dashboard, default current directory

Environment:
  CUSTOMIZE_PROJECT_ROOT  Project root managed by the dashboard
  PORT                    Web server port
  HOST                    Web server host`);
  process.exit(0);
}

const port = readOption(['--port', '-p'], process.env.PORT || process.env.CUSTOMIZE_WEB_PORT || '17321');
const host = readOption(['--host', '-H'], process.env.HOST || process.env.CUSTOMIZE_WEB_HOST || '127.0.0.1');
const projectRoot = path.resolve(readOption(['--project'], process.env.CUSTOMIZE_PROJECT_ROOT || originalCwd));
const packageJson = require(path.join(serverRoot, 'package.json'));
const buildIdPath = path.join(serverRoot, '.next', 'BUILD_ID');

if (!fs.existsSync(buildIdPath)) {
  console.error('[customize-web] Missing production build artifacts. Reinstall @customize-agent/server or run its build step before starting.');
  process.exit(1);
}

const verify = spawnSync(process.execPath, [path.join(serverRoot, 'scripts', 'verify-next-static.js')], {
  cwd: serverRoot,
  stdio: 'inherit',
  env: process.env,
});
if (verify.status !== 0) process.exit(verify.status || 1);

let nextBin;
try {
  nextBin = require.resolve('next/dist/bin/next', { paths: [serverRoot] });
} catch (error) {
  console.error('[customize-web] Unable to resolve Next.js runtime from @customize-agent/server.');
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const buildId = fs.readFileSync(buildIdPath, 'utf8').trim();
console.log(`[customize-web] Version: ${packageJson.version}`);
console.log(`[customize-web] Build ID: ${buildId}`);
console.log(`[customize-web] Package root: ${serverRoot}`);
console.log(`[customize-web] Project root: ${projectRoot}`);
console.log(`[customize-web] Starting: http://${host}:${port}/overview`);

const result = spawnSync(process.execPath, [nextBin, 'start', '-p', String(port), '-H', String(host)], {
  cwd: serverRoot,
  stdio: 'inherit',
  env: {
    ...process.env,
    NODE_ENV: 'production',
    CUSTOMIZE_PROJECT_ROOT: projectRoot,
  },
});

if (result.error) {
  console.error('[customize-web] Failed to start dashboard.');
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 0);
