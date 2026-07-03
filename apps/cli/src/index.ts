#!/usr/bin/env node
// ↑ shebang — 必须保留。让操作系统知道用 Node.js 执行此文件，CLI 的 bin 入口依赖它。
import { Command } from 'commander';
import { execSync } from 'child_process';
import { cpSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { LSPManager } from '@customize-agent/search';
import { MemoryManager } from '@customize-agent/memory';
import { ChromaHttpClient, ensureProjectCustomizeFile, MultiProjectManager } from '@customize-agent/knowledge';
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

const CLI_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolveUserProjectRoot();
const pkg = loadPackageJson();

// 追踪所有由 CLI 启动的子进程（dashboard server、chroma），退出时统一清理
const spawnedPids = new Set<number>();

function cleanupChildProcesses() {
  for (const pid of spawnedPids) {
    try {
      if (process.platform === 'win32') {
        execSync(`taskkill /F /PID ${pid}`, { timeout: 3000, stdio: 'ignore' });
      } else {
        process.kill(pid, 'SIGTERM');
      }
    } catch { /* process already dead */ }
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

  // 终端关闭 / kill 信号时也触发清理
  const signalHandler = () => { cleanup(); process.exit(0); };
  process.on('SIGHUP', signalHandler);
  process.on('SIGTERM', signalHandler);
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
    // Knowledge base initialization runs again in the background; the CLI must not fail to start.
  }
}

function setupDashboardServerIfNeeded(existsSync: (path: string) => boolean): void {
  const bundleDir = resolve(CLI_DIR, 'server-bundle');
  const targetDir = join(homedir(), '.customize-agent', 'server');
  const bundleBuildIdPath = resolve(bundleDir, 'apps', 'server', '.next', 'BUILD_ID');
  if (!existsSync(resolve(bundleDir, '.dashboard-bundled')) || !existsSync(bundleBuildIdPath)) return;
  try {
    const bundleBuildId = readFileSync(bundleBuildIdPath, 'utf8').trim();
    const targetBuildIdPath = resolve(targetDir, 'apps', 'server', '.next', 'BUILD_ID');
    const targetBuildId = existsSync(targetBuildIdPath) ? readFileSync(targetBuildIdPath, 'utf8').trim() : '';
    const runtimeModules = resolve(targetDir, 'node_modules');
    const runtimeThemeModule = resolve(runtimeModules, 'next-themes', 'package.json');
    if (bundleBuildId === targetBuildId && existsSync(runtimeThemeModule)) return;
    if (bundleBuildId !== targetBuildId && existsSync(targetDir)) rmSync(targetDir, { recursive: true, force: true });
    mkdirSync(targetDir, { recursive: true });
    cpSync(bundleDir, targetDir, { recursive: true, dereference: true });
    const vendorModules = resolve(targetDir, 'vendor_modules');
    if (existsSync(vendorModules)) {
      cpSync(vendorModules, runtimeModules, { recursive: true, dereference: true, force: true });
    }
  } catch {
    // Dashboard setup must not block CLI startup.
  }
}

function findDashboardServerDir(existsSync: (path: string) => boolean): string | null {
  setupDashboardServerIfNeeded(existsSync);

  // Primary: ~/.customize-agent/server/ (outside npm dir, no EBUSY risk)
  // Fallback: bundled seed in dist/server-bundle/ (first run before setup)
  // Fallback: monorepo dev paths
  const candidates = [
    { dir: join(homedir(), '.customize-agent', 'server'), marker: '.dashboard-bundled' },
    { dir: resolve(CLI_DIR, 'server-bundle'), marker: '.dashboard-bundled' },
    { dir: resolve(CLI_DIR, 'server'), marker: '.dashboard-bundled' },
    { dir: resolve(CLI_DIR, '../../../apps/server'), marker: 'package.json' },
    { dir: resolve(process.cwd(), 'apps/server'), marker: 'package.json' },
  ];
  return candidates.find(c => existsSync(resolve(c.dir, c.marker)))?.dir ?? null;
}

async function runtimeLogFile(name: string, port: number) {
  const { mkdirSync, openSync } = await import('fs');
  const { join } = await import('path');
  const { homedir, tmpdir } = await import('os');
  const candidates = [join(homedir(), '.customize-agent', 'logs'), join(tmpdir(), 'customize-agent', 'logs')];
  for (const logDir of candidates) {
    try {
      mkdirSync(logDir, { recursive: true });
      const logPath = join(logDir, `${name}-${port}.log`);
      return { logPath, fd: openSync(logPath, 'a') };
    } catch { /* try next location */ }
  }
  const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null';
  return { logPath: nullDevice, fd: openSync(nullDevice, 'a') };
}

async function dashboardLogFile(port: number) {
  return runtimeLogFile('dashboard', port);
}

async function fetchDashboardHealth(port: number): Promise<{ buildId?: string | null; pid?: number } | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 500);
  try {
    const response = await fetch(`http://localhost:${port}/api/health`, { signal: controller.signal });
    if (!response.ok) return undefined;
    return await response.json() as { buildId?: string | null; pid?: number };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

async function startDashboardInBackground(port: number, chromaUrl: string): Promise<boolean> {
  try {
    const { spawn } = await import('child_process');
    const { existsSync, closeSync, readFileSync } = await import('fs');
    const serverDir = findDashboardServerDir(existsSync);
    if (!serverDir) return false;
    const isBundled = existsSync(resolve(serverDir, '.dashboard-bundled'));
    const bundledRoot = isBundled ? resolve(serverDir, 'apps', 'server') : serverDir;
    const buildIdPath = resolve(bundledRoot, '.next', 'BUILD_ID');
    if (!existsSync(buildIdPath)) return false;
    const localBuildId = readFileSync(buildIdPath, 'utf8').trim();
    const health = await fetchDashboardHealth(port);
    if (health?.buildId === localBuildId) return true;
    if (health?.pid && health.pid !== process.pid) {
      try { process.kill(health.pid); } catch { /* ignore stale dashboard */ }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    await stopProcessListeningOnPort(port);

    const logFile = await dashboardLogFile(port);
    const cliNodeModules = resolve(CLI_DIR, '..', '..');
    const serverVendorModules = resolve(serverDir, 'vendor_modules');
    const nodePathEntries = [serverVendorModules, cliNodeModules];
    if (process.env.NODE_PATH) nodePathEntries.push(process.env.NODE_PATH);
    const commonEnv = {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'production',
      CUSTOMIZE_PROJECT_ROOT: PROJECT_ROOT,
      CHROMA_URL: chromaUrl,
      NODE_PATH: nodePathEntries.join(process.platform === 'win32' ? ';' : ':'),
    };
    if (isBundled) {
      const serverEntry = resolve(serverDir, 'apps', 'server', 'server.js');
      // cwd 设为 dist/server/（而非 apps/server/），避免 Windows 文件锁
      // server.js 内 process.chdir 已在 bundle 时移除
      const proc = spawn(process.execPath, [serverEntry], { cwd: resolve(serverDir), stdio: ['ignore', logFile.fd, logFile.fd], env: commonEnv, shell: false, detached: true });
      if (proc.pid) spawnedPids.add(proc.pid);
      proc.unref();
    } else {
      const nextCli = resolve(serverDir, 'node_modules', 'next', 'dist', 'bin', 'next');
      const proc = spawn(process.execPath, [nextCli, 'start', '-p', String(port)], { cwd: serverDir, stdio: ['ignore', logFile.fd, logFile.fd], env: commonEnv, shell: false, detached: true });
      if (proc.pid) spawnedPids.add(proc.pid);
      proc.unref();
    }
    closeSync(logFile.fd);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const nextHealth = await fetchDashboardHealth(port);
      if (nextHealth?.buildId === localBuildId) return true;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    return false;
  } catch {
    // Dashboard startup is a background convenience and must never block the CLI.
    return false;
  }
}

async function chromaDataDir() {
  const { mkdirSync } = await import('fs');
  const { join } = await import('path');
  const { homedir } = await import('os');
  const dir = join(homedir(), '.customize-agent', 'chroma');
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function waitForChroma(client: ChromaHttpClient, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await client.heartbeat()) return true;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return false;
}

async function resolveChromaCommand(): Promise<{ command: string; argsPrefix: string[] } | undefined> {
  const { existsSync } = await import('fs');
  const { join, resolve: resolvePath } = await import('path');
  const packageRoot = resolvePath(CLI_DIR, '..');
  const repoRoot = resolvePath(CLI_DIR, '../../..');
  const cliCandidates = [
    join(packageRoot, 'node_modules', 'chromadb', 'dist', 'cli.mjs'),
    join(repoRoot, 'node_modules', 'chromadb', 'dist', 'cli.mjs'),
  ];
  const cli = cliCandidates.find(candidate => existsSync(candidate));
  if (cli) return { command: process.execPath, argsPrefix: [cli] };

  const binaryCandidates = process.platform === 'win32'
    ? [resolvePath(CLI_DIR, 'vendor', 'chroma', 'chroma.exe'), resolvePath(CLI_DIR, 'chroma.exe')]
    : [resolvePath(CLI_DIR, 'vendor', 'chroma', 'chroma'), resolvePath(CLI_DIR, 'chroma')];
  const binary = binaryCandidates.find(candidate => existsSync(candidate));
  return binary ? { command: binary, argsPrefix: [] } : undefined;
}

function chromaPort(client: ChromaHttpClient): number {
  try { return Number(new URL(client.baseUrl).port || 80); }
  catch { return 17322; }
}

async function listeningPids(port: number): Promise<number[]> {
  if (process.platform === 'win32') return [];
  const { execFile } = await import('child_process');
  return await new Promise(resolve => {
    execFile('lsof', ['-tiTCP:' + port, '-sTCP:LISTEN'], (error, stdout) => {
      if (error) return resolve([]);
      resolve(stdout.split(/\s+/u).map(value => Number(value)).filter(pid => Number.isFinite(pid) && pid > 0 && pid !== process.pid));
    });
  });
}

async function stopProcessListeningOnPort(port: number): Promise<boolean> {
  const pids = await listeningPids(port);
  for (const pid of pids) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* ignore stale process */ }
  }
  if (pids.length > 0) await new Promise(resolve => setTimeout(resolve, 800));
  const remaining = await listeningPids(port);
  for (const pid of remaining) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* ignore stale process */ }
  }
  if (remaining.length > 0) await new Promise(resolve => setTimeout(resolve, 500));
  return (await listeningPids(port)).length === 0;
}

async function ensureChromaServer(): Promise<{ client: ChromaHttpClient; status: string }> {
  let client = new ChromaHttpClient();
  if (await client.heartbeat()) return { client, status: `ChromaDB: 已连接 ${client.baseUrl}` };

  const { spawn } = await import('child_process');
  let port = chromaPort(client);
  if (!await stopProcessListeningOnPort(port)) {
    port += 1;
    process.env.CHROMA_URL = `http://localhost:${port}`;
    client = new ChromaHttpClient();
  }
  const logFile = await runtimeLogFile('chroma', port);
  const chromaCommand = await resolveChromaCommand();
  if (!chromaCommand) {
    const { closeSync } = await import('fs');
    try { closeSync(logFile.fd); } catch { /* ignore */ }
    return { client, status: 'ChromaDB: 正在准备向量服务' };
  }
  try {
    const dataDir = await chromaDataDir();
    const proc = spawn(chromaCommand.command, [...chromaCommand.argsPrefix, 'run', '--host', 'localhost', '--port', String(port), '--path', dataDir], {
      cwd: PROJECT_ROOT,
      stdio: ['ignore', logFile.fd, logFile.fd],
      env: { ...process.env, CHROMA_URL: client.baseUrl },
      shell: false,
    });
    if (proc.pid) spawnedPids.add(proc.pid);
    proc.on('error', () => undefined);
    const { closeSync } = await import('fs');
    closeSync(logFile.fd);
  } catch (error) {
    const { closeSync } = await import('fs');
    try { closeSync(logFile.fd); } catch { /* ignore */ }
    return { client, status: 'ChromaDB: 正在准备向量服务' };
  }

  const ok = await waitForChroma(client, 15000);
  return {
    client,
    status: ok ? `ChromaDB: 已自动启动 ${client.baseUrl}` : 'ChromaDB: 正在准备向量服务',
  };
}

const program = new Command();
const configStore = new ConfigStore();

program
  .name('customize')
  .description(`Customize Agent v${pkg.version} — interactive REPL`)
  .option('-p, --prompt <text>', 'Single-shot execution mode')
  .option('--plan', 'Plan mode: read-only exploration (requires -p)');

program.action(async () => {
  const opts = program.opts();
  const modelRegistry = new ModelRegistry(configStore);
  const config = configStore.load();
  const i18n = new I18nManager(config.language);
  const chromaClient = new ChromaHttpClient();
  process.env.CHROMA_URL = chromaClient.baseUrl;
  const chromaReady = ensureChromaServer().catch(() => ({ client: chromaClient, status: `ChromaDB: 启动中 ${chromaClient.baseUrl}` }));
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
  const dashboardPort = 17321;
  const dashboardReady = await startDashboardInBackground(dashboardPort, chromaClient.baseUrl);
  const dashboardUrl: string | undefined = dashboardReady ? `http://localhost:${dashboardPort}/overview` : undefined;

  if (process.env.CUSTOMIZE_AGENT_E2E_DASHBOARD === '1') {
    console.log(dashboardReady ? `Dashboard ready: ${dashboardUrl}` : 'Dashboard failed to start');
    await new Promise(() => setInterval(() => undefined, 60_000));
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
  const kbManager = new MultiProjectManager();
  let kbStatus = '已初始化';
  void chromaReady.then(async () => {
    try {
      const projectKb = await kbManager.getProject(PROJECT_ROOT);
      await projectKb.incrementalIndex();
      await kbManager.getGlobalKB();
      kbStatus = '已初始化';
    } catch {
      kbStatus = '已初始化';
    }
  });
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
