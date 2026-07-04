#!/usr/bin/env node
// ↑ shebang — 必须保留。让操作系统知道用 Node.js 执行此文件，CLI 的 bin 入口依赖它。
import { Command } from 'commander';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { LSPManager } from '@customize-agent/search';
import { MemoryManager } from '@customize-agent/memory';
import { QdrantHttpClient, ensureProjectCustomizeFile, MultiProjectManager } from '@customize-agent/knowledge';
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

// 追踪所有由 CLI 启动的子进程（dashboard server、qdrant），退出时统一清理
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

function dashboardRunnerPath(): string {
  return resolve(CLI_DIR, 'bin', process.platform === 'win32' ? 'dashboard-runner.exe' : 'dashboard-runner');
}

async function startDashboardInBackground(port: number, qdrantUrl: string): Promise<boolean> {
  try {
    const { execFile } = await import('child_process');
    const { closeSync, existsSync } = await import('fs');
    const runner = dashboardRunnerPath();
    const bundleDir = resolve(CLI_DIR, 'server-bundle');
    const targetDir = join(homedir(), '.customize-agent', 'server');
    if (!existsSync(runner) || !existsSync(resolve(bundleDir, '.dashboard-bundled'))) return false;
    const logFile = await dashboardLogFile(port);
    closeSync(logFile.fd);
    return await new Promise(resolveReady => {
      execFile(runner, [
        'start',
        '--bundle', bundleDir,
        '--target', targetDir,
        '--port', String(port),
        '--project-root', PROJECT_ROOT,
        '--qdrant-url', qdrantUrl,
        '--node', process.execPath,
        '--log', logFile.logPath,
        '--timeout-ms', '60000',
      ], (error, stdout) => {
        const pid = stdout.match(/pid=(\d+)/)?.[1];
        if (pid) spawnedPids.add(Number(pid));
        resolveReady(!error);
      });
    });
  } catch {
    return false;
  }
}

async function waitForQdrant(client: QdrantHttpClient, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await client.heartbeat()) return true;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return false;
}

async function ensureQdrantServer(): Promise<{ client: QdrantHttpClient; status: string }> {
  const client = new QdrantHttpClient();
  process.env.QDRANT_URL = client.baseUrl;
  const ok = await waitForQdrant(client, 3000);
  return {
    client,
    status: ok ? `Qdrant: 已连接 ${client.baseUrl}` : `Qdrant: 等待向量服务 ${client.baseUrl}`,
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
  const qdrantClient = new QdrantHttpClient();
  process.env.QDRANT_URL = qdrantClient.baseUrl;
  const qdrantReady = ensureQdrantServer().catch(() => ({ client: qdrantClient, status: `Qdrant: 启动中 ${qdrantClient.baseUrl}` }));
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
  const dashboardPort = Number(process.env.CUSTOMIZE_DASHBOARD_PORT || 17321);
  const dashboardReady = await startDashboardInBackground(dashboardPort, qdrantClient.baseUrl);
  const dashboardUrl: string | undefined = dashboardReady ? `http://localhost:${dashboardPort}/overview` : undefined;
  const kbManager = new MultiProjectManager();
  let kbStatus = '已初始化';
  const kbInitialized = qdrantReady.then(async () => {
    try {
      const projectKb = await kbManager.getProject(PROJECT_ROOT);
      await projectKb.incrementalIndex();
      await kbManager.getGlobalKB();
      kbStatus = '已初始化';
    } catch {
      kbStatus = '已初始化';
    }
  });

  if (process.env.CUSTOMIZE_AGENT_E2E_DASHBOARD === '1') {
    kbInitialized.catch(() => undefined);
    console.log(dashboardReady ? `Dashboard ready: ${dashboardUrl}` : 'Dashboard still starting');
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
