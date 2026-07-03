const { spawn } = require('child_process');
const { existsSync, readdirSync, readFileSync } = require('fs');
const { join } = require('path');

const cliEntry = process.argv[2];
if (!cliEntry) {
  console.error('Usage: node ci-run-dashboard-e2e.cjs <cli-entry>');
  process.exit(1);
}

const paths = ['/api/health', '/overview', '/api/config/providers', '/api/config/models', '/api/kb/features', '/api/system/stats'];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function printFile(label, file) {
  console.log(`::group::${label}`);
  if (existsSync(file)) console.log(readFileSync(file, 'utf8'));
  else console.log(`${file} not found`);
  console.log('::endgroup::');
}

function printLogs(home) {
  printFile('cli.log', join(process.env.RUNNER_TEMP || process.cwd(), 'cli.log'));
  const logsDir = join(home, '.customize-agent', 'logs');
  console.log('::group::customize-agent logs');
  if (existsSync(logsDir)) {
    for (const name of readdirSync(logsDir)) {
      if (!name.endsWith('.log')) continue;
      const file = join(logsDir, name);
      console.log(`--- ${file} ---`);
      console.log(readFileSync(file, 'utf8'));
    }
  } else {
    console.log(`${logsDir} not found`);
  }
  console.log('::endgroup::');
}

async function fetchTextWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const text = await res.text();
    return { res, text };
  } finally {
    clearTimeout(timeout);
  }
}

async function verifyDashboard() {
  let last = '';
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    try {
      const rows = [];
      for (const path of paths) {
        const { res, text } = await fetchTextWithTimeout('http://localhost:17321' + path, 5000);
        rows.push([path, res.status, text.slice(0, 120).replace(/\n/g, ' ')]);
      }
      for (const row of rows) console.log(row[0], row[1], row[2]);
      if (rows.every(row => row[1] < 500)) return;
      last = JSON.stringify(rows);
    } catch (error) {
      last = error && error.stack ? error.stack : String(error);
      console.log(last);
    }
    await sleep(2000);
  }
  throw new Error(last || 'dashboard verification timed out');
}

(async () => {
  const home = process.env.HOME;
  const cliLog = join(process.env.RUNNER_TEMP || process.cwd(), 'cli.log');
  const proc = spawn(process.execPath, [cliEntry], {
    stdio: ['ignore', require('fs').openSync(cliLog, 'a'), require('fs').openSync(cliLog, 'a')],
    env: { ...process.env, CUSTOMIZE_AGENT_E2E_DASHBOARD: '1' },
    detached: false,
  });

  let exitCode = 1;
  try {
    await verifyDashboard();
    exitCode = 0;
  } catch (error) {
    console.error(error && error.stack ? error.stack : String(error));
    printLogs(home);
  } finally {
    try { proc.kill('SIGTERM'); } catch {}
    await sleep(1000);
    try { proc.kill('SIGKILL'); } catch {}
  }
  process.exit(exitCode);
})();
