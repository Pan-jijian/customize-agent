#!/usr/bin/env node
// ↑ shebang — 必须保留。让操作系统知道用 Node.js 执行此文件，CLI 的 bin 入口依赖它。
import { Command } from 'commander';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { createRequire } from 'module';
import { LSPManager } from '@customize-agent/search';
import { MemoryManager } from '@customize-agent/memory';
import { ensureProjectCustomizeFile, MultiProjectManager } from '@customize-agent/knowledge';
import { ConfigStore, ModelRegistry } from '@customize-agent/runtime';
import { createExecutor } from './bootstrap.js';
import { Repl } from './repl/repl.js';
import { t, renderMarkdown } from './tui/renderer.js';
import { type Message } from '@customize-agent/types';
import { I18nManager } from './i18n/manager.js';

function resolveUserProjectRoot(): string {
  return resolve(process.env.CUSTOMIZE_PROJECT_ROOT ?? process.env.INIT_CWD ?? process.env.PWD ?? process.cwd());
}

function loadPackageJson(): { version: string } {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')) as { version: string };
  } catch {
    return { version: '0.0.0' };
  }
}

const require = createRequire(import.meta.url);
const PROJECT_ROOT = resolveUserProjectRoot();
const pkg = loadPackageJson();

// 追踪所有由 CLI 启动的子进程（dashboard server），退出时统一清理
const spawnedPids = new Set<number>();

function cleanupChildProcesses() {
  for (const pid of spawnedPids) {
    try {
      if (process.platform === 'win32') {
        execSync(`taskkill /F /PID ${pid}`, { timeout: 3000, stdio: 'ignore' });
      } else {
        process.kill(pid, 'SIGTERM');
      }
    } catch { /* 进程已退出 */ }
  }
  spawnedPids.clear();
}

function registerCleanup() {
  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    cleanupChildProcesses();
  };

  // 进程退出时清理子进程（execSync 是同步的，满足 process.on('exit') 的要求）
  process.on('exit', cleanup);

  // 终端关闭 / Ctrl+C / kill 信号时也触发清理
  const signalHandler = () => { cleanup(); process.exit(0); };
  process.on('SIGHUP', signalHandler);
  process.on('SIGINT', signalHandler);
  process.on('SIGTERM', signalHandler);
  process.on('uncaughtException', error => { cleanup(); throw error; });
  process.on('unhandledRejection', reason => { cleanup(); throw reason; });
}

async function ensureProjectWorkspace(projectRoot: string): Promise<void> {
  try {
    ensureProjectCustomizeFile(projectRoot);
    const manager = new MultiProjectManager();
    try {
      await manager.getProject(projectRoot);
    } finally {
      await manager.shutdown();
    }
  } catch {
    // 知识库初始化会在后台再次运行；CLI 不能因此启动失败。
  }
}

async function runtimeLogFile(name: string, port: number, mode: 'append' | 'replace' = 'append') {
  const { mkdirSync, openSync } = await import('fs');
  const { join } = await import('path');
  const { homedir, tmpdir } = await import('os');
  const homeOverride = process.env.CUSTOMIZE_AGENT_HOME || process.env.HOME || process.env.USERPROFILE;
  const candidates = [
    ...(homeOverride ? [join(homeOverride, '.customize-agent', 'logs')] : []),
    join(homedir(), '.customize-agent', 'logs'),
    join(tmpdir(), 'customize-agent', 'logs'),
  ];
  for (const logDir of candidates) {
    try {
      mkdirSync(logDir, { recursive: true });
      const logPath = join(logDir, `${name}-${port}.log`);
      return { logPath, fd: openSync(logPath, mode === 'replace' ? 'w' : 'a') };
    } catch { /* 尝试下一个位置 */ }
  }
  const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null';
  return { logPath: nullDevice, fd: openSync(nullDevice, mode === 'replace' ? 'w' : 'a') };
}

async function dashboardLogFile(port: number, mode: 'append' | 'replace' = 'append') {
  return runtimeLogFile('dashboard', port, mode);
}

function expectedDashboardBuildId(): string | null {
  try {
    const serverPackageJson = require.resolve('@customize-agent/server/package.json');
    return readFileSync(join(dirname(serverPackageJson), '.next', 'BUILD_ID'), 'utf8').trim();
  } catch {
    return null;
  }
}

async function readLogTail(logPath: string): Promise<string> {
  try {
    const { readFileSync } = await import('fs');
    const content = readFileSync(logPath, 'utf8');
    return content.slice(-4000);
  } catch {
    return '';
  }
}

async function dashboardIsHealthy(port: number): Promise<boolean> {
  const health = await fetch(`http://127.0.0.1:${port}/api/health`, { redirect: 'manual' });
  if (health.status !== 200) return false;
  const data = await health.json().catch(() => null) as { buildId?: string } | null;
  const expectedBuildId = expectedDashboardBuildId();
  if (expectedBuildId && data?.buildId && data.buildId !== expectedBuildId) return false;
  const overview = await fetch(`http://127.0.0.1:${port}/overview`, { redirect: 'manual' });
  return overview.status === 200;
}

async function waitForDashboard(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await dashboardIsHealthy(port)) return true;
    } catch { /* 服务器仍在启动 */ }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return false;
}

async function portHasHealthyDashboard(port: number): Promise<boolean> {
  try { return await dashboardIsHealthy(port); } catch { return false; }
}

async function portIsAvailable(port: number): Promise<boolean> {
  const { createServer } = await import('net');
  return new Promise(resolve => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port);
  });
}

async function resolveDashboardPort(preferredPort: number): Promise<number> {
  if (await portHasHealthyDashboard(preferredPort)) return preferredPort;
  if (await portIsAvailable(preferredPort)) return preferredPort;
  for (let port = preferredPort + 1; port <= preferredPort + 50; port += 1) {
    if (await portIsAvailable(port)) return port;
  }
  return preferredPort;
}

type DashboardStartResult =
  | { ready: true; port: number; url: string; logPath: string }
  | { ready: false; port: number; logPath: string; error?: string };

async function startDashboardInBackground(port: number): Promise<DashboardStartResult> {
  let logPath = '';
  if (await waitForDashboard(port, 1000)) {
    const { closeSync } = await import('fs');
    const logFile = await dashboardLogFile(port);
    closeSync(logFile.fd);
    return { ready: true, port, url: `http://localhost:${port}/overview`, logPath: logFile.logPath };
  }
  try {
    const { spawn } = await import('child_process');
    const { closeSync, existsSync } = await import('fs');
    const serverPackageJson = require.resolve('@customize-agent/server/package.json');
    const serverRoot = dirname(serverPackageJson);
    const verifyScript = join(serverRoot, 'scripts', 'verify-next-static.js');
    if (existsSync(verifyScript)) {
      const verify = spawn(process.execPath, [verifyScript], { cwd: serverRoot, stdio: ['ignore', 'ignore', 'ignore'] });
      const code = await new Promise<number | null>(resolve => verify.on('exit', resolve));
      if (code !== 0) throw new Error('dashboard build artifacts are incomplete');
    }
    const nextBin = require.resolve('next/dist/bin/next', { paths: [serverRoot] });
    const logFile = await dashboardLogFile(port, 'replace');
    logPath = logFile.logPath;
    const child = spawn(process.execPath, [nextBin, 'start', '-p', String(port), '-H', '127.0.0.1'], {
      cwd: serverRoot,
      detached: false,
      stdio: ['ignore', logFile.fd, logFile.fd],
      env: {
        ...process.env,
        NODE_ENV: 'production',
        CUSTOMIZE_PROJECT_ROOT: PROJECT_ROOT,
      },
    });
    if (child.pid) spawnedPids.add(child.pid);
    child.on('exit', () => { if (child.pid) spawnedPids.delete(child.pid); });
    closeSync(logFile.fd);
    const timeoutMs = Number(process.env.CUSTOMIZE_DASHBOARD_START_TIMEOUT_MS || 15000);
    if (await waitForDashboard(port, timeoutMs)) {
      return { ready: true, port, url: `http://localhost:${port}/overview`, logPath };
    }
    const tail = await readLogTail(logPath);
    return { ready: false, port, logPath, error: `dashboard did not become healthy within ${timeoutMs}ms${tail ? `\nDashboard log tail:\n${tail}` : ''}` };
  } catch (error) {
    return { ready: false, port, logPath, error: error instanceof Error ? error.message : String(error) };
  }
}

const program = new Command();
const configStore = new ConfigStore();

program
  .name('customize')
  .description(`Customize Agent v${pkg.version} — interactive REPL`)
  .version(pkg.version)
  .option('-p, --prompt <text>', 'Single-shot execution mode')
  .option('--plan', 'Plan mode: read-only exploration (requires -p)');

program.action(async () => {
  const opts = program.opts();
  const modelRegistry = new ModelRegistry(configStore);
  const config = configStore.load();
  const i18n = new I18nManager(config.language);
  await ensureProjectWorkspace(PROJECT_ROOT);

  if (opts.prompt) {
    const resolved = modelRegistry.resolve('action');
    if (!resolved) {
      console.log(`\n${i18n.t('cmd.no_model_configured')}`);
      console.log(i18n.t('cmd.first_config'));
      return;
    }
    const pCfg = configStore.getProvider(resolved.provider);
    const lsp = new LSPManager(PROJECT_ROOT);
    const executor = await createExecutor(PROJECT_ROOT, i18n, resolved.provider, resolved.name, pCfg, lsp);

    const history: Message[] = [{ role: 'system', content: executor.getSystemPrompt() }];

    if (opts.plan) {
      history.push({
        role: 'user',
        content: `Create an execution plan for the following task. Read-only exploration. Do not modify any files.\n\nTask: ${opts.prompt}\n\nOutput the plan.`,
      });
      console.log(`\n📋 ${i18n.t('plan.banner')} [${executor.providerName}]`);
    } else {
      history.push({ role: 'user', content: opts.prompt });
      console.log(`\n🚀 Customize Agent v${pkg.version} [${executor.providerName}]`);
    }
    console.log(`   Task: "${opts.prompt}"`);

    try {
      const updated = await executor.runTask(history, { plan: opts.plan ?? false, readonly: opts.plan ?? false });
      const lastAssistant = [...updated].reverse().find(m => m.role === 'assistant');
      if (lastAssistant) {
        const cleanContent = lastAssistant.content.trim();
        process.stdout.write('\n' + t.purple('📋 Result:') + '\n');
        process.stdout.write(renderMarkdown(cleanContent) + '\n');
      }
    } catch (err) {
      console.log(`\n${i18n.t('error.execution')} ${(err as Error).message}`);
    }
    return;
  }

  registerCleanup();
  const dashboardPort = await resolveDashboardPort(Number(process.env.CUSTOMIZE_DASHBOARD_PORT || 17321));
  console.log(`正在启动 Web 控制台: http://localhost:${dashboardPort}/overview`);
  const dashboard = await startDashboardInBackground(dashboardPort);
  const dashboardUrl: string | undefined = dashboard.ready ? dashboard.url : undefined;
  if (dashboard.ready) {
    console.log(`Web 控制台已启动: ${dashboard.url}`);
  } else {
    console.warn(`Web 控制台未启动，CLI 将继续启动。日志: ${dashboard.logPath}${dashboard.error ? `；原因: ${dashboard.error}` : ''}`);
  }
  const kbManager = new MultiProjectManager();
  let kbStatus = '已初始化';
  const kbInitialized = (async () => {
    try {
      const projectKb = await kbManager.getProject(PROJECT_ROOT);
      await projectKb.incrementalIndex();
      await kbManager.getGlobalKB();
      kbStatus = '已初始化';
    } catch {
      kbStatus = '已初始化';
    }
  })();

  if (process.env.CUSTOMIZE_AGENT_E2E_DASHBOARD === '1') {
    kbInitialized.catch(() => undefined);
    if (dashboard.ready) {
      console.log(`Dashboard ready: ${dashboard.url}`);
      await new Promise(() => setInterval(() => undefined, 60_000));
    } else {
      console.error(`Dashboard failed to start on port ${dashboard.port}. Log: ${dashboard.logPath}${dashboard.error ? ` Error: ${dashboard.error}` : ''}`);
      process.exit(1);
    }
  }

  const lsp = new LSPManager(PROJECT_ROOT);
  const resolved = modelRegistry.resolve('action');
  const providerDisplay = resolved ? `${resolved.provider}/${resolved.name}` : i18n.t('welcome.no_model');
  const providerCfg = resolved ? configStore.getProvider(resolved.provider) : undefined;
  const executorConfigKey = resolved ? JSON.stringify({ provider: resolved.provider, model: resolved.name, cfg: providerCfg ?? {} }) : undefined;
  const executor = resolved
    ? await createExecutor(PROJECT_ROOT, i18n, resolved.provider, resolved.name, providerCfg, lsp)
    : await createExecutor(PROJECT_ROOT, i18n, undefined, undefined, undefined, lsp);

  const memory = new MemoryManager();
  const repl = new Repl({

    executor,
    projectRoot: PROJECT_ROOT,
    memory,
    i18n,
    configStore,
    modelRegistry,
    providerDisplay,
    executorConfigKey,
    createExecutor: (providerName, modelName, providerConfig) => createExecutor(PROJECT_ROOT, i18n, providerName, modelName, providerConfig, lsp),
    kbManager,
    dashboardUrl,
    kbStatus,
    version: pkg.version,
  });

  await repl.start();
});

program
  .command('mcp-server')
  .description('Start MCP Server (stdio JSON-RPC)')
  .action(async () => {
    const i18nMcp = new I18nManager(configStore.load().language);
    const { McpServer } = await import('@customize-agent/engine');
    console.error(i18nMcp.t('cli.mcp_server_start'));
    const { buildRegistry } = await import('./agent/tool-registry.js');
    const registry = buildRegistry({ root: PROJECT_ROOT });
    const server = new McpServer(registry, 'customize-agent', pkg.version);
    await server.start();
  });

program.parse();
