#!/usr/bin/env node
// ↑ shebang — 必须保留。让操作系统知道用 Node.js 执行此文件，CLI 的 bin 入口依赖它。
import type { ChildProcess } from 'child_process';
import { Command } from 'commander';
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { LSPManager } from '@customize-agent/search';
import { MemoryManager } from '@customize-agent/memory';
import { ensureProjectCustomizeFile, MultiProjectManager } from '@customize-agent/knowledge';
import { ConfigStore, ModelRegistry } from '@customize-agent/runtime';
import { killByPid } from '@customize-agent/tools';
import { createExecutor } from './bootstrap.js';
import { Repl } from './repl/repl.js';
import { t, renderMarkdown } from './tui/renderer.js';
import { type Message } from '@customize-agent/types';
import { I18nManager } from './i18n/manager.js';

function resolveUserProjectRoot(): string {
  return resolve(process.env.CUSTOMIZE_PROJECT_ROOT ?? process.env.INIT_CWD ?? process.env.PWD ?? process.cwd());
}

const CLI_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolveUserProjectRoot();
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));

async function ensureProjectWorkspace(projectRoot: string): Promise<void> {
  ensureProjectCustomizeFile(projectRoot);
  const manager = new MultiProjectManager();
  try {
    await manager.getProject(projectRoot);
  } finally {
    await manager.shutdown();
  }
}

function findDashboardServerDir(existsSync: (path: string) => boolean): string | null {
  const cliDir = CLI_DIR;
  const candidates = [
    // Bundled in npm package: dist/server/
    { dir: resolve(cliDir, 'server'), marker: '.dashboard-bundled' },
    // Monorepo dev: apps/server/
    { dir: resolve(cliDir, '../../../apps/server'), marker: 'package.json' },
    // Monorepo from project root
    { dir: resolve(process.cwd(), 'apps/server'), marker: 'package.json' },
  ];
  return candidates.find(c => existsSync(resolve(c.dir, c.marker)))?.dir ?? null;
}

async function stopDashboardProcess(port: number, pid?: number): Promise<boolean> {
  const targetPid = pid ?? await findListeningPid(port);
  if (!targetPid || targetPid === process.pid) return false;
  await killByPid(targetPid);

  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://localhost:${port}/api/health`);
    } catch {
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  return false;
}

async function findListeningPid(port: number): Promise<number | undefined> {
  const { execFile } = await import('child_process');
  const command = process.platform === 'win32' ? 'powershell.exe' : 'lsof';
  const args = process.platform === 'win32'
    ? ['-NoProfile', '-NonInteractive', '-Command', `(Get-NetTCPConnection -LocalPort ${port} -State Listen | Select-Object -First 1 -ExpandProperty OwningProcess)`]
    : ['-tiTCP:' + port, '-sTCP:LISTEN'];
  return await new Promise(resolve => {
    execFile(command, args, (error, stdout) => {
      if (error) {
        resolve(undefined);
        return;
      }
      const pid = Number(stdout.trim().split('\n')[0]);
      resolve(Number.isFinite(pid) ? pid : undefined);
    });
  });
}

async function dashboardLogFile(port: number) {
  const { mkdirSync, openSync } = await import('fs');
  const { join } = await import('path');
  const { homedir } = await import('os');
  const logDir = join(homedir(), '.customize-agent', 'logs');
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, `dashboard-${port}.log`);
  return { logPath, fd: openSync(logPath, 'a') };
}

async function waitForDashboard(port: number, buildId: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${port}/api/health`);
      if (res.ok) {
        const health = await res.json() as { buildId?: string | null };
        if (health.buildId === buildId) return true;
      }
    } catch { /* wait */ }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  return false;
}

const program = new Command();
const configStore = new ConfigStore();

program
  .name('customize')
  .description(`Customize Agent v${pkg.version} — interactive REPL`)
  .option('-p, --prompt <text>', 'Single-shot execution mode')
  .option('--plan', 'Plan mode: read-only exploration (requires -p)');

program.action(async () => {
  await ensureProjectWorkspace(PROJECT_ROOT);
  const opts = program.opts();
  const modelRegistry = new ModelRegistry(configStore);
  const config = configStore.load();
  const i18n = new I18nManager(config.language);

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
  try {
    const projectKb = await kbManager.getProject(PROJECT_ROOT);
    await projectKb.incrementalIndex();
    await kbManager.getGlobalKB();
  } catch (error) {
    kbStatus = `初始化失败: ${(error as Error).message}`;
  }
  let dashboardUrl: string | undefined;
  const dashboardPort = 17321;
  try {
    const { spawn } = await import('child_process');
    const { existsSync, readFileSync: readRuntimeFileSync } = await import('fs');
    const serverDir = findDashboardServerDir(existsSync);
    if (!serverDir) {
      kbStatus = `${kbStatus}\n   Dashboard: 未找到 Web 服务目录`;
      throw new Error('Dashboard server directory not found');
    }
    const isBundled = existsSync(resolve(serverDir, '.dashboard-bundled'));
    const bundledRoot = isBundled ? resolve(serverDir, 'apps', 'server') : serverDir;
    const nextCli = isBundled ? '' : resolve(serverDir, 'node_modules', 'next', 'dist', 'bin', 'next');
    const buildIdPath = resolve(bundledRoot, '.next', 'BUILD_ID');
    const routesManifestPath = resolve(bundledRoot, '.next', 'routes-manifest.json');
    const localBuildId = existsSync(buildIdPath) ? readRuntimeFileSync(buildIdPath, 'utf-8').trim() : '';
    const hasBuild = Boolean(localBuildId);
    const routesManifest = existsSync(routesManifestPath) ? readRuntimeFileSync(routesManifestPath, 'utf-8') : '';
    const hasConsoleRoutes = ['/overview', '/models', '/settings'].every(route =>
      routesManifest.includes(`"page":"${route}"`) || routesManifest.includes(`"page": "${route}"`),
    );

    if (!hasBuild || !hasConsoleRoutes) {
      kbStatus = `${kbStatus}\n   Dashboard: 未构建，请先运行 pnpm build`;
    } else {
      let restartedStaleDashboard = false;
      let stopFailed = false;
      let lastLogPath = '';
      const candidatePorts = [dashboardPort, dashboardPort + 1, dashboardPort + 2, dashboardPort + 3, dashboardPort + 4];

      for (const port of candidatePorts) {
        try {
          const res = await fetch(`http://localhost:${port}/api/health`);
          if (res.ok) {
            const health = await res.json() as { buildId?: string | null; pid?: number };
            if (health.buildId === localBuildId) {
              dashboardUrl = `http://localhost:${port}`;
              break;
            }
            if (port === dashboardPort) {
              restartedStaleDashboard = await stopDashboardProcess(port, health.pid);
              stopFailed = !restartedStaleDashboard;
              if (!restartedStaleDashboard) continue;
            } else {
              continue;
            }
          }
        } catch { /* port is available */ }

        let proc: ChildProcess | null = null;
        let logFile: Awaited<ReturnType<typeof dashboardLogFile>> | undefined;
        try {
          logFile = await dashboardLogFile(port);
          lastLogPath = logFile.logPath;
          const commonEnv = { ...process.env, PORT: String(port), NODE_ENV: 'production', CUSTOMIZE_PROJECT_ROOT: PROJECT_ROOT };
          if (isBundled) {
            const serverEntry = resolve(serverDir, 'apps', 'server', 'server.js');
            proc = spawn(process.execPath, [serverEntry], {
              cwd: resolve(serverDir, 'apps', 'server'),
              stdio: ['ignore', logFile.fd, logFile.fd],
              env: commonEnv,
              shell: false,
              detached: true,
            });
          } else {
            proc = spawn(process.execPath, [nextCli, 'start', '-p', String(port)], {
              cwd: serverDir,
              stdio: ['ignore', logFile.fd, logFile.fd],
              env: commonEnv,
              shell: false,
              detached: true,
            });
          }
          proc.unref();
          if (logFile) {
            const { closeSync } = await import('fs');
            closeSync(logFile.fd);
          }
        } catch (error) {
          if (logFile) {
            const { closeSync } = await import('fs');
            try { closeSync(logFile.fd); } catch { /* ignore */ }
          }
          kbStatus = `${kbStatus}\n   Dashboard: 启动失败 ${String((error as Error).message || error)}`;
          continue;
        }

        if (await waitForDashboard(port, localBuildId, 30000)) {
          dashboardUrl = `http://localhost:${port}`;
          break;
        }

        proc?.kill();
      }

      if (!dashboardUrl) {
        kbStatus = `${kbStatus}\n   Dashboard: 启动超时${lastLogPath ? `，日志: ${lastLogPath}` : ''}`;
      } else if (restartedStaleDashboard) {
        kbStatus = `${kbStatus}\n   Dashboard: 已自动更新控制台服务`;
      } else if (stopFailed) {
        kbStatus = `${kbStatus}\n   Dashboard: 控制台正在更新，请关闭旧终端后重新打开`;
      }
    }
  } catch (error) {
    if ((error as Error).message !== 'Dashboard server directory not found') {
      kbStatus = `${kbStatus}\n   Dashboard 启动失败: ${(error as Error).message}`;
    }
  }

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
